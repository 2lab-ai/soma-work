import { SlackApiHelper } from '../slack-api-helper';
import { UserChoiceHandler } from '../user-choice-handler';
import { ClaudeHandler } from '../../claude-handler';
import { UserChoices } from '../../types';
import { Logger } from '../../logger';
import { PendingFormStore } from './pending-form-store';
import { MessageHandler, SayFn, PendingChoiceFormData } from './types';

interface ChoiceActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
}

/**
 * 사용자 선택 액션 핸들러
 */
export class ChoiceActionHandler {
  private logger = new Logger('ChoiceActionHandler');

  constructor(
    private ctx: ChoiceActionContext,
    private formStore: PendingFormStore
  ) {}

  async handleUserChoice(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { sessionKey, choiceId, label, question } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;
      const threadTs = body.message?.thread_ts || messageTs;

      this.logger.info('User choice selected', { sessionKey, choiceId, label, userId });

      // 선택 메시지 업데이트
      if (messageTs && channel) {
        try {
          await this.ctx.slackApi.updateMessage(
            channel,
            messageTs,
            `✅ *${question}*\n선택: *${choiceId}. ${label}*`,
            [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `✅ *${question}*\n선택: *${choiceId}. ${label}*`,
                },
              },
            ]
          );
        } catch (error) {
          this.logger.warn('Failed to update choice message', error);
        }
      }

      // 세션 확인 및 메시지 처리
      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
      if (session) {
        const say = this.createSayFn(channel);
        await this.ctx.messageHandler(
          { user: userId, channel, thread_ts: threadTs, ts: messageTs, text: choiceId },
          say
        );
      } else {
        this.logger.warn('Session not found for user choice', { sessionKey });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 세션을 찾을 수 없습니다. 대화가 만료되었을 수 있습니다.'
        );
      }
    } catch (error) {
      this.logger.error('Error processing user choice', error);
    }
  }

  async handleMultiChoice(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, sessionKey, questionId, choiceId, label } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;

      this.logger.info('Multi-choice selection', { formId, questionId, choiceId, label, userId });

      const pendingForm = this.formStore.get(formId);
      if (!pendingForm) {
        this.logger.warn('Pending form not found', { formId });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.'
        );
        return;
      }

      // 선택 저장
      pendingForm.selections[questionId] = { choiceId, label };

      // 폼 UI 업데이트 (자동 제출 없음 - Submit 버튼으로 제출)
      await this.updateFormUI(pendingForm, channel, messageTs);
    } catch (error) {
      this.logger.error('Error processing multi-choice selection', error);
    }
  }

  /**
   * Handle edit choice - clear selection for a question and show options again
   */
  async handleEditChoice(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, questionId } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;

      this.logger.info('Edit choice requested', { formId, questionId, userId });

      const pendingForm = this.formStore.get(formId);
      if (!pendingForm) {
        this.logger.warn('Pending form not found for edit', { formId });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.'
        );
        return;
      }

      // 선택 취소
      delete pendingForm.selections[questionId];

      // UI 업데이트
      await this.updateFormUI(pendingForm, channel, messageTs);
    } catch (error) {
      this.logger.error('Error processing edit choice', error);
    }
  }

  /**
   * Handle form submit - send all selections to Claude
   */
  async handleFormSubmit(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, sessionKey } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;
      const threadTs = body.message?.thread_ts || messageTs;

      this.logger.info('Form submit requested', { formId, userId });

      const pendingForm = this.formStore.get(formId);
      if (!pendingForm) {
        this.logger.warn('Pending form not found for submit', { formId });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.'
        );
        return;
      }

      // 모든 질문이 선택되었는지 확인
      const totalQuestions = pendingForm.questions.length;
      const answeredCount = Object.keys(pendingForm.selections).length;

      if (answeredCount !== totalQuestions) {
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          `❌ 아직 ${totalQuestions - answeredCount}개의 질문에 답변하지 않았습니다.`
        );
        return;
      }

      // 제출 처리
      await this.completeMultiChoiceForm(pendingForm, userId, channel, threadTs, messageTs);
    } catch (error) {
      this.logger.error('Error processing form submit', error);
    }
  }

  /**
   * Handle form reset - clear all selections
   */
  async handleFormReset(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;

      this.logger.info('Form reset requested', { formId, userId });

      const pendingForm = this.formStore.get(formId);
      if (!pendingForm) {
        this.logger.warn('Pending form not found for reset', { formId });
        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          '❌ 폼을 찾을 수 없습니다. 시간이 만료되었을 수 있습니다.'
        );
        return;
      }

      // 모든 선택 초기화
      pendingForm.selections = {};

      // UI 업데이트
      await this.updateFormUI(pendingForm, channel, messageTs);

      await this.ctx.slackApi.postEphemeral(
        channel,
        userId,
        '🗑️ 모든 선택이 초기화되었습니다.'
      );
    } catch (error) {
      this.logger.error('Error processing form reset', error);
    }
  }

  /**
   * Update form UI with current selections
   */
  private async updateFormUI(
    pendingForm: PendingChoiceFormData,
    channel: string,
    messageTs: string
  ): Promise<void> {
    const choicesData: UserChoices = {
      type: 'user_choices',
      questions: pendingForm.questions,
    };

    const updatedPayload = UserChoiceHandler.buildMultiChoiceFormBlocks(
      choicesData,
      pendingForm.formId,
      pendingForm.sessionKey,
      pendingForm.selections
    );

    try {
      await this.ctx.slackApi.updateMessage(channel, messageTs, '📋 선택이 필요합니다', undefined, updatedPayload.attachments);
    } catch (error) {
      this.logger.warn('Failed to update form UI', error);
    }
  }

  async completeMultiChoiceForm(
    pendingForm: PendingChoiceFormData,
    userId: string,
    channel: string,
    threadTs: string,
    messageTs: string
  ): Promise<void> {
    this.logger.info('All multi-choice selections complete', { formId: pendingForm.formId, selections: pendingForm.selections });

    const responses = pendingForm.questions.map((q) => {
      const sel = pendingForm.selections[q.id];
      if (sel.choiceId === '직접입력') {
        return `${q.question}: (직접입력) ${sel.label}`;
      }
      return `${q.question}: ${sel.choiceId}. ${sel.label}`;
    });
    const combinedMessage = responses.join('\n');

    this.formStore.delete(pendingForm.formId);

    // 완료 UI 업데이트
    try {
      const completedBlocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *모든 선택 완료*\n\n${responses.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
          },
        },
      ];

      await this.ctx.slackApi.updateMessage(channel, messageTs, '✅ 모든 선택 완료', completedBlocks);
    } catch (error) {
      this.logger.warn('Failed to update completed form', error);
    }

    // Claude에 전송
    const session = this.ctx.claudeHandler.getSessionByKey(pendingForm.sessionKey);
    if (session) {
      const say = this.createSayFn(channel);
      await this.ctx.messageHandler(
        { user: userId, channel, thread_ts: threadTs, ts: messageTs, text: combinedMessage },
        say
      );
    } else {
      this.logger.warn('Session not found for multi-choice completion', { sessionKey: pendingForm.sessionKey });
      await this.ctx.slackApi.postEphemeral(
        channel,
        userId,
        '❌ 세션을 찾을 수 없습니다. 대화가 만료되었을 수 있습니다.'
      );
    }
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
