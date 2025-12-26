import { SlackApiHelper } from '../slack-api-helper';
import { UserChoiceHandler } from '../user-choice-handler';
import { ClaudeHandler } from '../../claude-handler';
import { UserChoices } from '../../types';
import { Logger } from '../../logger';
import { PendingFormStore } from './pending-form-store';
import { ChoiceActionHandler } from './choice-action-handler';
import { MessageHandler, SayFn, PendingChoiceFormData } from './types';

interface FormActionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
}

/**
 * 폼/모달 액션 핸들러
 */
export class FormActionHandler {
  private logger = new Logger('FormActionHandler');

  constructor(
    private ctx: FormActionContext,
    private formStore: PendingFormStore,
    private choiceHandler: ChoiceActionHandler
  ) {}

  async handleCustomInputSingle(body: any, client: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { sessionKey, question } = valueData;
      const triggerId = body.trigger_id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;
      const threadTs = body.message?.thread_ts || messageTs;

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
      const threadTs = body.message?.thread_ts || messageTs;

      await client.views.open({
        trigger_id: triggerId,
        view: this.buildCustomInputModal(sessionKey, question, channel, messageTs, threadTs, 'multi', formId, questionId),
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

      this.logger.info('Custom input submitted', { type, sessionKey, questionId, inputLength: inputValue.length, userId });

      if (type === 'single') {
        await this.handleSingleCustomInput(sessionKey, question, channel, messageTs, threadTs, userId, inputValue);
      } else if (type === 'multi') {
        await this.handleMultiCustomInput(formId, sessionKey, questionId, question, channel, messageTs, threadTs, userId, inputValue);
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
    threadTs: string,
    userId: string,
    inputValue: string
  ): Promise<void> {
    // 메시지 업데이트
    if (messageTs && channel) {
      try {
        await this.ctx.slackApi.updateMessage(
          channel,
          messageTs,
          `✅ *${question}*\n직접 입력: _${inputValue.substring(0, 200)}${inputValue.length > 200 ? '...' : ''}_`,
          [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `✅ *${question}*\n직접 입력: _${inputValue.substring(0, 200)}${inputValue.length > 200 ? '...' : ''}_`,
              },
            },
          ]
        );
      } catch (error) {
        this.logger.warn('Failed to update choice message after custom input', error);
      }
    }

    // Claude에 전송
    const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);
    if (session) {
      const say = this.createSayFn(channel);
      await this.ctx.messageHandler(
        { user: userId, channel, thread_ts: threadTs, ts: messageTs, text: inputValue },
        say
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
    threadTs: string,
    userId: string,
    inputValue: string
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
      pendingForm.selections
    );

    try {
      await this.ctx.slackApi.updateMessage(channel, messageTs, '📋 선택이 필요합니다', undefined, updatedPayload.attachments);
    } catch (error) {
      this.logger.warn('Failed to update multi-choice form after custom input', error);
    }

    // 모든 질문 완료 시
    if (answeredCount === totalQuestions) {
      await this.choiceHandler.completeMultiChoiceForm(pendingForm, userId, channel, threadTs, messageTs);
    }
  }

  private buildCustomInputModal(
    sessionKey: string,
    question: string,
    channel: string,
    messageTs: string,
    threadTs: string,
    type: 'single' | 'multi',
    formId?: string,
    questionId?: string
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
