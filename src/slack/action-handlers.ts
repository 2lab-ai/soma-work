import { App } from '@slack/bolt';
import { SlackApiHelper } from './slack-api-helper';
import { SessionUiManager } from './session-manager';
import { UserChoiceHandler } from './user-choice-handler';
import { ClaudeHandler } from '../claude-handler';
import { sharedStore, PermissionResponse } from '../shared-store';
import { UserChoices, UserChoiceQuestion } from '../types';
import { Logger } from '../logger';

export interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
}

export type MessageHandler = (event: MessageEvent, say: SayFn) => Promise<void>;
export type SayFn = (args: any) => Promise<any>;
export type RespondFn = (args: any) => Promise<any>;

interface PendingChoiceFormData {
  formId: string;
  sessionKey: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  questions: UserChoiceQuestion[];
  selections: Record<string, { choiceId: string; label: string }>;
  createdAt: number;
}

export interface ActionHandlerContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  sessionManager: SessionUiManager;
  messageHandler: MessageHandler;
}

/**
 * Slack 버튼/모달 인터랙션 핸들러
 */
export class ActionHandlers {
  private logger = new Logger('ActionHandlers');
  private pendingChoiceForms: Map<string, PendingChoiceFormData> = new Map();

  constructor(private ctx: ActionHandlerContext) {}

  /**
   * 앱에 모든 액션 핸들러 등록
   */
  registerHandlers(app: App): void {
    // 권한 액션
    app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.handleApprove(body, respond);
    });

    app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.handleDeny(body, respond);
    });

    // 세션 액션
    app.action('terminate_session', async ({ ack, body, respond }) => {
      await ack();
      await this.handleTerminateSession(body, respond);
    });

    // 사용자 선택 액션
    app.action(/^user_choice_/, async ({ ack, body }) => {
      await ack();
      await this.handleUserChoice(body);
    });

    app.action(/^multi_choice_/, async ({ ack, body }) => {
      await ack();
      await this.handleMultiChoice(body);
    });

    app.action('custom_input_single', async ({ ack, body, client }) => {
      await ack();
      await this.handleCustomInputSingle(body, client);
    });

    app.action(/^custom_input_multi_/, async ({ ack, body, client }) => {
      await ack();
      await this.handleCustomInputMulti(body, client);
    });

    // 모달 핸들러
    app.view('custom_input_submit', async ({ ack, body, view }) => {
      await ack();
      await this.handleCustomInputSubmit(body, view);
    });
  }

  /**
   * 도구 승인 처리
   */
  private async handleApprove(body: any, respond: RespondFn): Promise<void> {
    try {
      const approvalId = body.actions[0].value;
      const user = body.user?.id;

      this.logger.info('Tool approval granted', { approvalId, user });

      const response: PermissionResponse = {
        behavior: 'allow',
        message: 'Approved by user',
      };
      await sharedStore.storePermissionResponse(approvalId, response);

      await respond({
        response_type: 'ephemeral',
        text: '✅ Tool execution approved. Claude will now proceed with the operation.',
        replace_original: false,
      });
    } catch (error) {
      this.logger.error('Error processing tool approval', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing approval. The request may have already been handled.',
        replace_original: false,
      });
    }
  }

  /**
   * 도구 거부 처리
   */
  private async handleDeny(body: any, respond: RespondFn): Promise<void> {
    try {
      const approvalId = body.actions[0].value;
      const user = body.user?.id;

      this.logger.info('Tool approval denied', { approvalId, user });

      const response: PermissionResponse = {
        behavior: 'deny',
        message: 'Denied by user',
      };
      await sharedStore.storePermissionResponse(approvalId, response);

      await respond({
        response_type: 'ephemeral',
        text: '❌ Tool execution denied. Claude will not proceed with this operation.',
        replace_original: false,
      });
    } catch (error) {
      this.logger.error('Error processing tool denial', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing denial. The request may have already been handled.',
        replace_original: false,
      });
    }
  }

  /**
   * 세션 종료 처리
   */
  private async handleTerminateSession(body: any, respond: RespondFn): Promise<void> {
    try {
      const sessionKey = body.actions[0].value;
      const userId = body.user?.id;
      const channel = body.channel?.id;

      this.logger.info('Session termination requested', { sessionKey, userId });

      const session = this.ctx.claudeHandler.getSessionByKey(sessionKey);

      if (!session) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션을 찾을 수 없습니다. 이미 종료되었을 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      if (session.ownerId !== userId) {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 이 세션을 종료할 권한이 없습니다. 세션 소유자만 종료할 수 있습니다.',
          replace_original: false,
        });
        return;
      }

      const channelName = await this.ctx.slackApi.getChannelName(session.channelId);
      const success = this.ctx.claudeHandler.terminateSession(sessionKey);

      if (success) {
        const { text: newText, blocks: newBlocks } = await this.ctx.sessionManager.formatUserSessionsBlocks(userId);
        await respond({
          text: newText,
          blocks: newBlocks,
          replace_original: true,
        });

        await this.ctx.slackApi.postEphemeral(
          channel,
          userId,
          `✅ 세션이 종료되었습니다: *${session.title || channelName}*`
        );

        if (session.threadTs) {
          try {
            await this.ctx.slackApi.postMessage(
              session.channelId,
              `🔒 *세션이 종료되었습니다*\n\n<@${userId}>에 의해 세션이 종료되었습니다. 새로운 대화를 시작하려면 다시 메시지를 보내주세요.`,
              { threadTs: session.threadTs }
            );
          } catch (error) {
            this.logger.warn('Failed to notify original thread about session termination', error);
          }
        }
      } else {
        await respond({
          response_type: 'ephemeral',
          text: '❌ 세션 종료에 실패했습니다.',
          replace_original: false,
        });
      }
    } catch (error) {
      this.logger.error('Error processing session termination', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ 세션 종료 중 오류가 발생했습니다.',
        replace_original: false,
      });
    }
  }

  /**
   * 단일 선택 처리
   */
  private async handleUserChoice(body: any): Promise<void> {
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

  /**
   * 다중 선택 처리
   */
  private async handleMultiChoice(body: any): Promise<void> {
    try {
      const action = body.actions[0];
      const valueData = JSON.parse(action.value);
      const { formId, sessionKey, questionId, choiceId, label } = valueData;
      const userId = body.user?.id;
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;
      const threadTs = body.message?.thread_ts || messageTs;

      this.logger.info('Multi-choice selection', { formId, questionId, choiceId, label, userId });

      const pendingForm = this.pendingChoiceForms.get(formId);
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
        this.logger.warn('Failed to update multi-choice form', error);
      }

      // 모든 질문 완료 시
      if (answeredCount === totalQuestions) {
        await this.completeMultiChoiceForm(pendingForm, userId, channel, threadTs, messageTs);
      }
    } catch (error) {
      this.logger.error('Error processing multi-choice selection', error);
    }
  }

  /**
   * 단일 선택 직접 입력 모달 열기
   */
  private async handleCustomInputSingle(body: any, client: any): Promise<void> {
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

  /**
   * 다중 선택 직접 입력 모달 열기
   */
  private async handleCustomInputMulti(body: any, client: any): Promise<void> {
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

  /**
   * 직접 입력 모달 제출 처리
   */
  private async handleCustomInputSubmit(body: any, view: any): Promise<void> {
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

  /**
   * 단일 선택 직접 입력 처리
   */
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

  /**
   * 다중 선택 직접 입력 처리
   */
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
    const pendingForm = this.pendingChoiceForms.get(formId);
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
      await this.completeMultiChoiceForm(pendingForm, userId, channel, threadTs, messageTs);
    }
  }

  /**
   * 다중 선택 폼 완료 처리
   */
  private async completeMultiChoiceForm(
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

    this.pendingChoiceForms.delete(pendingForm.formId);

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

  /**
   * 직접 입력 모달 생성
   */
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

  /**
   * say 함수 생성 헬퍼
   */
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

  // 폼 상태 관리 메서드
  getPendingForm(formId: string): PendingChoiceFormData | undefined {
    return this.pendingChoiceForms.get(formId);
  }

  setPendingForm(formId: string, data: PendingChoiceFormData): void {
    this.pendingChoiceForms.set(formId, data);
  }

  deletePendingForm(formId: string): void {
    this.pendingChoiceForms.delete(formId);
  }
}
