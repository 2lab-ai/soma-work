import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import type { UserChoices } from '../../types';
import type { SlackApiHelper } from '../slack-api-helper';
import type { ThreadPanel } from '../thread-panel';
import { UserChoiceHandler } from '../user-choice-handler';
import type { ChoiceActionHandler } from './choice-action-handler';
import type { PendingFormStore } from './pending-form-store';
import { type MessageHandler, PendingChoiceFormData, type SayFn } from './types';

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
      const { sessionKey, question } = valueData;
      const triggerId = body.trigger_id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;
      const fallbackThreadTs = body.message?.thread_ts || messageTs;
      const threadTs = this.resolveSessionThreadTs(sessionKey, fallbackThreadTs);

      await client.views.open({
        trigger_id: triggerId,
        view: this.buildCustomInputModal(sessionKey, question, channel, messageTs, threadTs, 'single'),
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
        ),
      });
    } catch (error) {
      this.logger.error('Error opening custom input modal for multi-choice', error);
    }
  }

  async handleCustomInputSubmit(body: any, view: any): Promise<void> {
    try {
      const metadata = JSON.parse(view.private_metadata);
      const { sessionKey, question, channel, messageTs, threadTs, type, formId, questionId } = metadata;
      const userId = body.user.id;
      const inputValue = view.state.values.custom_input_block.custom_input_text.value || '';

      this.logger.info('Custom input submitted', {
        type,
        sessionKey,
        questionId,
        inputLength: inputValue.length,
        userId,
      });

      if (type === 'single') {
        await this.handleSingleCustomInput(sessionKey, question, channel, messageTs, threadTs, userId, inputValue);
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
  ): Promise<void> {
    const completionMessageTs = this.resolveChoiceMessageTs(sessionKey, messageTs);

    // 메시지 업데이트 (모든 동기화 대상에 대해)
    if (channel) {
      const completedText = `✅ *${question}*\n직접 입력: _${inputValue.substring(0, 200)}${inputValue.length > 200 ? '...' : ''}_`;
      const completedBlocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: completedText,
          },
        },
      ];
      const targetTimestamps = this.resolveChoiceSyncMessageTs(sessionKey, messageTs, completionMessageTs);
      for (const targetTs of targetTimestamps) {
        try {
          await this.ctx.slackApi.updateMessage(
            channel,
            targetTs,
            completedText,
            completedBlocks,
            [], // 기존 attachments(버튼) 제거
          );
        } catch (error) {
          this.logger.warn('Failed to update choice message after custom input', { targetTs, error });
        }
      }
    }

    // Claude에 전송
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    if (session) {
      await this.ctx.threadPanel?.clearChoice(sessionKey);
      // TODO: Delete tracked completion messages on custom input submission
      // Trace: docs/turn-summary-lifecycle/trace.md, S8
      // CompletionMessageTracker.deleteAll(sessionKey, ...) should be called here.
      // Wiring requires passing the tracker through FormActionContext,
      // which is a larger change.
      this.ctx.claudeHandler.setActivityStateByKey(sessionKey, 'working');
      const say = this.createSayFn(channel);
      const resolvedThreadTs = this.resolveSessionThreadTs(sessionKey, threadTs);
      await this.ctx.messageHandler(
        { user: userId, channel, thread_ts: resolvedThreadTs, ts: messageTs, text: inputValue },
        say,
      );
    }
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
    const pendingForm = this.formStore.get(formId);
    if (!pendingForm) {
      this.logger.warn('Pending form not found for custom input', { formId });
      return;
    }

    // 선택 저장
    pendingForm.selections[questionId] = {
      choiceId: '직접입력',
      label: inputValue.substring(0, 50) + (inputValue.length > 50 ? '...' : ''),
    };

    const totalQuestions = pendingForm.questions.length;
    const answeredCount = Object.keys(pendingForm.selections).length;

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

    // 모든 질문 완료 시
    if (answeredCount === totalQuestions) {
      const resolvedThreadTs = this.resolveSessionThreadTs(sessionKey, threadTs);
      await this.choiceHandler.completeMultiChoiceForm(pendingForm, userId, channel, resolvedThreadTs, messageTs);
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

  private resolveChoiceMessageTs(sessionKey: string, fallbackMessageTs: string | undefined): string | undefined {
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    return session?.actionPanel?.choiceMessageTs || fallbackMessageTs;
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
