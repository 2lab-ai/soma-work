import { App } from '@slack/bolt';
import { PermissionActionHandler } from './permission-action-handler';
import { SessionActionHandler } from './session-action-handler';
import { ChoiceActionHandler } from './choice-action-handler';
import { FormActionHandler } from './form-action-handler';
import { JiraActionHandler } from './jira-action-handler';
import { PRActionHandler } from './pr-action-handler';
import { ActionPanelActionHandler } from './action-panel-action-handler';
import { ChannelRouteActionHandler } from './channel-route-action-handler';
import { PendingFormStore } from './pending-form-store';
import { ActionHandlerContext, PendingChoiceFormData } from './types';
import { SlackApiHelper } from '../slack-api-helper';
import { Logger } from '../../logger';

// Re-export types for backwards compatibility
export { ActionHandlerContext, MessageEvent, MessageHandler, SayFn, RespondFn, PendingChoiceFormData } from './types';
export { PendingFormStore } from './pending-form-store';

/**
 * ActionRouter - 모든 액션 핸들러 통합 라우터
 * 기존 ActionHandlers와 동일한 인터페이스 유지
 */
export class ActionHandlers {
  private logger = new Logger('ActionHandlers');
  private formStore: PendingFormStore;
  private permissionHandler: PermissionActionHandler;
  private sessionHandler: SessionActionHandler;
  private choiceHandler: ChoiceActionHandler;
  private formHandler: FormActionHandler;
  private jiraHandler: JiraActionHandler;
  private prHandler: PRActionHandler;
  private actionPanelHandler: ActionPanelActionHandler;
  private channelRouteHandler: ChannelRouteActionHandler;

  constructor(private ctx: ActionHandlerContext) {
    this.formStore = new PendingFormStore();

    this.permissionHandler = new PermissionActionHandler();

    this.sessionHandler = new SessionActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      sessionManager: ctx.sessionManager,
      reactionManager: ctx.reactionManager,
    });

    this.choiceHandler = new ChoiceActionHandler(
      {
        slackApi: ctx.slackApi,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler,
        actionPanelManager: ctx.actionPanelManager,
      },
      this.formStore
    );

    this.formHandler = new FormActionHandler(
      {
        slackApi: ctx.slackApi,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler,
        actionPanelManager: ctx.actionPanelManager,
      },
      this.formStore,
      this.choiceHandler
    );

    this.jiraHandler = new JiraActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      messageHandler: ctx.messageHandler,
    });

    this.prHandler = new PRActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      messageHandler: ctx.messageHandler,
    });

    this.actionPanelHandler = new ActionPanelActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      messageHandler: ctx.messageHandler,
    });

    this.channelRouteHandler = new ChannelRouteActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      messageHandler: ctx.messageHandler,
    });
  }

  /**
   * 앱에 모든 액션 핸들러 등록
   */
  registerHandlers(app: App): void {
    // 권한 액션
    app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.permissionHandler.handleApprove(body, respond);
    });

    app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.permissionHandler.handleDeny(body, respond);
    });

    // 세션 액션
    app.action('terminate_session', async ({ ack, body, respond }) => {
      await ack();
      await this.sessionHandler.handleTerminateSession(body, respond);
    });

    app.action('refresh_sessions', async ({ ack, body, respond }) => {
      await ack();
      await this.sessionHandler.handleRefreshSessions(body, respond);
    });

    // Close session confirm/cancel (from /close command)
    app.action('close_session_confirm', async ({ ack, body, respond }) => {
      await ack();
      await this.sessionHandler.handleCloseConfirm(body, respond);
    });

    app.action('close_session_cancel', async ({ ack, body, respond }) => {
      await ack();
      await this.sessionHandler.handleCloseCancel(body, respond);
    });

    // Idle session close/keep (from 12h idle check)
    app.action('idle_close_session', async ({ ack, body, respond }) => {
      await ack();
      await this.sessionHandler.handleIdleClose(body, respond);
    });

    app.action('idle_keep_session', async ({ ack, body, respond }) => {
      await ack();
      await this.sessionHandler.handleIdleKeep(body, respond);
    });

    // 사용자 선택 액션
    app.action(/^user_choice_/, async ({ ack, body }) => {
      await ack();
      await this.choiceHandler.handleUserChoice(body);
    });

    app.action(/^multi_choice_/, async ({ ack, body }) => {
      await ack();
      await this.choiceHandler.handleMultiChoice(body);
    });

    // Edit choice (reselect a previously answered question)
    app.action(/^edit_choice_/, async ({ ack, body }) => {
      await ack();
      await this.choiceHandler.handleEditChoice(body);
    });

    // Form submit (final submission of all selections)
    app.action(/^submit_form_/, async ({ ack, body }) => {
      await ack();
      await this.choiceHandler.handleFormSubmit(body);
    });

    // Form reset (clear all selections)
    app.action(/^reset_form_/, async ({ ack, body }) => {
      await ack();
      await this.choiceHandler.handleFormReset(body);
    });

    app.action('custom_input_single', async ({ ack, body, client }) => {
      await ack();
      await this.formHandler.handleCustomInputSingle(body, client);
    });

    app.action(/^custom_input_multi_/, async ({ ack, body, client }) => {
      await ack();
      await this.formHandler.handleCustomInputMulti(body, client);
    });

    // Jira transition actions (regex: jira_transition_{transitionId}_{sessionKeyPrefix})
    app.action(/^jira_transition_/, async ({ ack, body, respond }) => {
      await ack();
      await this.jiraHandler.handleTransition(body, respond);
    });

    // PR merge action (regex: merge_pr_{sessionKeyPrefix})
    app.action(/^merge_pr_/, async ({ ack, body, respond }) => {
      await ack();
      await this.prHandler.handleMerge(body, respond);
    });

    // Action panel buttons
    app.action(/^panel_/, async ({ ack, body, respond }) => {
      await ack();
      await this.actionPanelHandler.handleAction(body, respond);
    });

    // Channel routing actions (move to correct channel / stop)
    app.action('channel_route_move', async ({ ack, body, respond }) => {
      await ack();
      await this.channelRouteHandler.handleMove(body, respond);
    });

    app.action('channel_route_stop', async ({ ack, body, respond }) => {
      await ack();
      await this.channelRouteHandler.handleStop(body, respond);
    });

    app.action('channel_route_stay', async ({ ack, body, respond }) => {
      await ack();
      await this.channelRouteHandler.handleStay(body, respond);
    });

    app.action('managed_message_delete_cancel', async ({ ack, body, respond }) => {
      await ack();
      await this.handleManagedDeleteCancel(body, respond);
    });

    app.action('managed_message_delete_confirm', async ({ ack, body, respond }) => {
      await ack();
      await this.handleManagedDeleteConfirm(body, respond);
    });

    // 모달 핸들러
    app.view('custom_input_submit', async ({ ack, body, view }) => {
      await ack();
      await this.formHandler.handleCustomInputSubmit(body, view);
    });
  }

  // 폼 상태 관리 메서드 (기존 API 호환)
  getPendingForm(formId: string): PendingChoiceFormData | undefined {
    return this.formStore.get(formId);
  }

  setPendingForm(formId: string, data: PendingChoiceFormData): void {
    this.formStore.set(formId, data);
  }

  deletePendingForm(formId: string): void {
    this.formStore.delete(formId);
  }

  /**
   * Invalidate old forms when a new form is created for the same session
   * Updates old form messages to show they're expired and removes them from store
   */
  async invalidateOldForms(
    sessionKey: string,
    newFormId: string,
    slackApi: SlackApiHelper
  ): Promise<void> {
    const oldForms = this.formStore.getFormsBySession(sessionKey);
    const expiredFormBlock = [{ type: 'section', text: { type: 'mrkdwn', text: '⏱️ _만료됨_' } }];

    for (const [formId, form] of oldForms) {
      // Skip the new form and forms without message timestamp
      if (formId === newFormId || !form.messageTs) continue;

      try {
        await slackApi.updateMessage(
          form.channel,
          form.messageTs,
          '⏱️ _이 폼은 새로운 폼으로 대체되었습니다._',
          expiredFormBlock
        );
        this.logger.debug('Invalidated old form', { formId, sessionKey });
      } catch (error) {
        this.logger.warn('Failed to update expired form message', { formId, error });
      }

      this.formStore.delete(formId);
    }
  }

  /**
   * Load pending forms from file after restart
   */
  loadPendingForms(): number {
    return this.formStore.loadForms();
  }

  /**
   * Save pending forms to file before shutdown
   */
  savePendingForms(): void {
    this.formStore.saveForms();
  }

  private parseManagedDeleteValue(rawValue: string): {
    requesterId: string;
    targetChannel: string;
    targetTs: string;
  } | null {
    try {
      const value = JSON.parse(rawValue || '{}');
      if (
        typeof value.requesterId !== 'string' ||
        typeof value.targetChannel !== 'string' ||
        typeof value.targetTs !== 'string'
      ) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  private async handleManagedDeleteCancel(body: any, respond: any): Promise<void> {
    const rawValue = body.actions?.[0]?.value || '{}';
    const value = this.parseManagedDeleteValue(rawValue);
    const actorId = body.user?.id;

    if (!value || !actorId) {
      this.logger.warn('Invalid managed delete cancel payload', { rawValue, actorId });
      return;
    }

    if (actorId !== value.requesterId) {
      await respond({
        text: '⚠️ 요청한 사용자만 이 버튼을 사용할 수 있습니다.',
        response_type: 'ephemeral',
        replace_original: false,
      });
      return;
    }

    await respond({
      text: '삭제를 취소했습니다.',
      replace_original: true,
    });
  }

  private async handleManagedDeleteConfirm(body: any, respond: any): Promise<void> {
    const rawValue = body.actions?.[0]?.value || '{}';
    const value = this.parseManagedDeleteValue(rawValue);
    const actorId = body.user?.id;

    if (!value || !actorId) {
      this.logger.warn('Invalid managed delete confirm payload', { rawValue, actorId });
      return;
    }

    if (actorId !== value.requesterId) {
      await respond({
        text: '⚠️ 요청한 사용자만 이 버튼을 사용할 수 있습니다.',
        response_type: 'ephemeral',
        replace_original: false,
      });
      return;
    }

    try {
      await this.ctx.slackApi.deleteMessage(value.targetChannel, value.targetTs);
      await respond({
        text: '🗑️ 메시지를 삭제했습니다.',
        replace_original: true,
      });
    } catch (error) {
      this.logger.warn('Failed to delete managed message', {
        targetChannel: value.targetChannel,
        targetTs: value.targetTs,
        error,
      });
      await respond({
        text: '⚠️ 메시지 삭제에 실패했습니다.',
        replace_original: true,
      });
    }
  }
}
