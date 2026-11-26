import type { ClaudeHandler } from '../../claude-handler';
import { getInstructionApprovals } from '../../instruction-approval';
import { Logger } from '../../logger';
import type { UserChoices } from '../../types';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ThreadPanel } from '../thread-panel';
import { UserChoiceHandler } from '../user-choice-handler';
import type { ChoiceActionHandler } from './choice-action-handler';
import { classifyClick, markClickAsStale } from './click-classifier';
import type { PendingFormStore } from './pending-form-store';
import type { MessageHandler, SayFn } from './types';

interface FormActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
  threadPanel?: ThreadPanel;
}

/**
 * 폼/모달 액션 핸들러
 */
export class FormActionHandler {
  private logger = new Logger('FormActionHandler');

  constructor(
    private ctx: FormActionContext,
    private formStore: PendingFormStore,
    private choiceHandler: ChoiceActionHandler,
  ) {}

  async handleCustomInputSingle(body: any, client: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { sessionKey, question, turnId: payloadTurnId } = valueData;
      const triggerId = body.trigger_id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;
      const fallbackThreadTs = body.message?.thread_ts || messageTs;
      const threadTs = this.resolveSessionThreadTs(sessionKey, fallbackThreadTs);

      // #1474 — the question this card asked is already answered (its edit is still on its way): no input to open.
      if (await this.choiceHandler.refuseAnswered(sessionKey, channel, body.user?.id, messageTs)) return;

      await client.views.open({
        trigger_id: triggerId,
        view: this.buildCustomInputModal(
          sessionKey,
          question,
          channel,
          messageTs,
          threadTs,
          'single',
          undefined,
          undefined,
          payloadTurnId,
        ),
      });
    } catch (error) {
      this.logger.error('Error opening custom input modal', error);
    }
  }

  async handleCustomInputMulti(body: any, client: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, sessionKey, questionId, question } = valueData;
      const triggerId = body.trigger_id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;
      const fallbackThreadTs = body.message?.thread_ts || messageTs;
      const threadTs = this.resolveSessionThreadTs(sessionKey, fallbackThreadTs);

      // #1474 — the form is already answered (its edit is still on its way): no input to open.
      if (await this.choiceHandler.refuseAnswered(sessionKey, channel, body.user?.id, formId, messageTs)) return;

      // P3 (PHASE>=3): inherit turnId from the PendingFormStore record so the
      // modal submission path can classify stale vs live clicks.
      const pendingForm = this.formStore.get(formId);

      await client.views.open({
        trigger_id: triggerId,
        view: this.buildCustomInputModal(
          sessionKey,
          question,
          channel,
          messageTs,
          threadTs,
          'multi',
          formId,
          questionId,
          pendingForm?.turnId,
        ),
      });
    } catch (error) {
      this.logger.error('Error opening custom input modal for multi-choice', error);
    }
  }

  async handleCustomInputSubmit(body: any, view: any): Promise<void> {
    try {
      const metadata = JSON.parse(view.private_metadata);
      const { sessionKey, question, channel, messageTs, threadTs, type, formId, questionId, turnId } = metadata;
      const userId = body.user.id;
      const inputValue = view.state.values.custom_input_block.custom_input_text.value || '';

      this.logger.info('Custom input submitted', {
        type,
        sessionKey,
        questionId,
        inputLength: inputValue.length,
        userId,
      });

      // #767 — a typed answer from someone who is not the owner (nor approved) is an instruction:
      // checked before the question is touched. A single question's answer goes to the message
      // gate (it holds it, the question stays open); a form's is refused (the owner submits it).
      const session = sessionKey ? this.ctx.claudeHandler.getSessionByKey(sessionKey) : undefined;
      const approvals = getInstructionApprovals();
      if (approvals && session && userId && !approvals.allows({ sessionKey, session, senderId: userId })) {
        if (type === 'single' && channel) {
          await this.ctx.messageHandler(
            {
              user: userId,
              channel,
              thread_ts: this.resolveSessionThreadTs(sessionKey, threadTs),
              ts: String(Date.now() / 1000),
              text: inputValue,
            },
            this.createSayFn(channel),
          );
          await this.ctx.slackApi
            .postEphemeral(
              channel,
              userId,
              '⏳ 이 작업의 소유자가 승인하면 답이 전달됩니다 — 소유자에게 승인을 요청했습니다.',
            )
            .catch(() => undefined);
        } else if (channel) {
          await this.ctx.slackApi
            .postEphemeral(
              channel,
              userId,
              '🚫 이 질문은 작업 소유자(또는 소유자가 승인한 사람)만 답할 수 있습니다. 답을 스레드에 메시지로 남기면 소유자에게 승인을 요청합니다.',
            )
            .catch(() => undefined);
        }
        return;
      }

      if (type === 'single') {
        await this.handleSingleCustomInput(
          sessionKey,
          question,
          channel,
          messageTs,
          threadTs,
          userId,
          inputValue,
          turnId,
        );
      } else if (type === 'multi') {
        await this.handleMultiCustomInput(
          formId,
          sessionKey,
          questionId,
          question,
          channel,
          messageTs,
          threadTs,
          userId,
          inputValue,
        );
      }
    } catch (error) {
      this.logger.error('Error processing custom input submission', error);
    }
  }

  private async handleSingleCustomInput(
    sessionKey: string,
    question: string,
    channel: string,
    messageTs: string,
    threadTs: string | undefined,
    userId: string,
    inputValue: string,
    payloadTurnId?: string,
  ): Promise<void> {
    const completedText = `✅ *${question}*\n직접 입력: _${inputValue.substring(0, 200)}${inputValue.length > 200 ? '...' : ''}_`;
    const completedBlocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: completedText },
      },
    ];

    // #1474 — a card already answered (a modal opened before, or the edit still on its way): told so, before the
    // classifier would read it stale and mark the answered card invalid.
    if (await this.choiceHandler.refuseAnswered(sessionKey, channel, userId, messageTs)) return;

    // P3 (PHASE>=3) classifier — reuse the same matrix as ChoiceActionHandler.
    const branch = classifyClick(this.ctx.claudeHandler, { sessionKey, payloadTurnId, messageTs });

    if (branch === 'stale') {
      this.logger.info('Custom input (single) click classified as stale — marking and returning', {
        sessionKey,
        payloadTurnId,
      });
      if (channel && messageTs) {
        await markClickAsStale(this.ctx.slackApi, this.logger, channel, messageTs, sessionKey);
      }
      return;
    }

    // #1474 — taken like a button's answer: held, recorded, handed on, then drawn (ChoiceActionHandler).
    await this.choiceHandler.answerWithText({
      sessionKey,
      channel,
      threadTs,
      messageTs,
      userId,
      text: inputValue,
      completedText,
      completedBlocks,
    });
  }

  private async handleMultiCustomInput(
    formId: string,
    sessionKey: string,
    questionId: string,
    question: string,
    channel: string,
    messageTs: string,
    threadTs: string | undefined,
    userId: string,
    inputValue: string,
  ): Promise<void> {
    // #1474 — the form is already answered: told so, instead of a form that silently is not there.
    if (await this.choiceHandler.refuseAnswered(sessionKey, channel, userId, formId, messageTs)) return;

    const pendingForm = this.formStore.get(formId);
    if (!pendingForm) {
      this.logger.warn('Pending form not found for custom input', { formId });
      return;
    }

    // P3 (PHASE>=3) classifier — turnId comes from the pendingForm record
    // (multi button values don't carry turnId).
    const branch = classifyClick(this.ctx.claudeHandler, {
      sessionKey,
      payloadTurnId: pendingForm.turnId,
      formId,
    });
    if (branch === 'stale') {
      this.logger.info('Custom input (multi) click classified as stale — marking and returning', {
        sessionKey,
        formId,
        questionId,
      });
      await markClickAsStale(this.ctx.slackApi, this.logger, channel, messageTs, sessionKey);
      return;
    }

    // 선택 저장
    pendingForm.selections[questionId] = {
      choiceId: '직접입력',
      label: inputValue.substring(0, 50) + (inputValue.length > 50 ? '...' : ''),
    };

    const totalQuestions = pendingForm.questions.length;
    const answeredCount = Object.keys(pendingForm.selections).length;

    // 모든 질문 완료 시 — this typed answer completes the form: it is answered at once (#1474 — recorded and handed on
    // before any Slack write; the form is drawn as answered). The intermediate form redraw below is for a form
    // still waiting on other answers.
    if (answeredCount === totalQuestions) {
      const resolvedThreadTs = this.resolveSessionThreadTs(sessionKey, threadTs);
      await this.choiceHandler.completeMultiChoiceForm(pendingForm, userId, channel, resolvedThreadTs, messageTs);
      return;
    }

    // 폼 UI 업데이트
    const choicesData: UserChoices = {
      type: 'user_choices',
      questions: pendingForm.questions,
    };

    const updatedPayload = UserChoiceHandler.buildMultiChoiceFormBlocks(
      choicesData,
      formId,
      sessionKey,
      pendingForm.selections,
    );

    if (branch === 'p3') {
      // P3: single-ts update on the form's own messageTs. Avoid the ts-union
      // resolver so we don't rewrite thread header / unrelated chunks.
      if (channel && pendingForm.messageTs) {
        try {
          await this.ctx.slackApi.updateMessage(
            channel,
            pendingForm.messageTs,
            '📋 선택이 필요합니다',
            undefined,
            updatedPayload.attachments,
          );
        } catch (error) {
          this.logger.warn('Failed to update multi-choice form after custom input (P3)', {
            formId,
            error,
          });
        }
      }
    } else {
      const targetMessageTs = this.resolveChoiceSyncMessageTs(sessionKey, messageTs, pendingForm.messageTs);
      for (const targetTs of targetMessageTs) {
        try {
          await this.ctx.slackApi.updateMessage(
            channel,
            targetTs,
            '📋 선택이 필요합니다',
            undefined,
            updatedPayload.attachments,
          );
        } catch (error) {
          this.logger.warn('Failed to update multi-choice form after custom input', {
            targetTs,
            error,
          });
        }
      }

      await this.ctx.threadPanel?.attachChoice(sessionKey, updatedPayload, pendingForm.messageTs);
    }
  }

  private buildCustomInputModal(
    sessionKey: string,
    question: string,
    channel: string,
    messageTs: string,
    threadTs: string | undefined,
    type: 'single' | 'multi',
    formId?: string,
    questionId?: string,
    turnId?: string,
  ): any {
    return {
      type: 'modal',
      callback_id: 'custom_input_submit',
      private_metadata: JSON.stringify({
        sessionKey,
        question,
        channel,
        messageTs,
        threadTs,
        type,
        formId,
        questionId,
        ...(turnId ? { turnId } : {}),
      }),
      title: {
        type: 'plain_text',
        text: '직접 입력',
        emoji: true,
      },
      submit: {
        type: 'plain_text',
        text: '제출',
        emoji: true,
      },
      close: {
        type: 'plain_text',
        text: '취소',
        emoji: true,
      },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${question}*`,
          },
        },
        {
          type: 'input',
          block_id: 'custom_input_block',
          element: {
            type: 'plain_text_input',
            action_id: 'custom_input_text',
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: '원하는 내용을 자유롭게 입력하세요...',
            },
          },
          label: {
            type: 'plain_text',
            text: '응답',
            emoji: true,
          },
        },
      ],
    };
  }

  private resolveSessionThreadTs(sessionKey: string, fallbackThreadTs: string | undefined): string | undefined {
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    return session?.threadRootTs || session?.threadTs || fallbackThreadTs;
  }

  private resolveChoiceSyncMessageTs(
    sessionKey: string,
    sourceMessageTs: string | undefined,
    threadMessageTs: string | undefined,
  ): string[] {
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    const targets = new Set<string>();

    if (sourceMessageTs) {
      targets.add(sourceMessageTs);
    }
    if (threadMessageTs) {
      targets.add(threadMessageTs);
    }
    if (session?.actionPanel?.choiceMessageTs) {
      targets.add(session.actionPanel.choiceMessageTs);
    }

    return [...targets];
  }

  private createSayFn(channel: string): SayFn {
    return async (args: any) => {
      const msgArgs = typeof args === 'string' ? { text: args } : args;
      return this.ctx.slackApi.postMessage(channel, msgArgs.text, {
        threadTs: msgArgs.thread_ts,
        blocks: msgArgs.blocks,
        attachments: msgArgs.attachments,
      });
    };
  }
}
