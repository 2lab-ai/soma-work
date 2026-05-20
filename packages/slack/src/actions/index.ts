import type { App } from '@slack/bolt';
import { Logger } from '@soma/common/logger';
import { type PendingChoiceFormData, PendingFormStore } from './pending-form-store';
import { PendingInstructionConfirmStore } from './pending-instruction-confirm-store';

export type { PendingChoiceFormData } from './pending-form-store';
export { PendingFormStore } from './pending-form-store';
export { PendingInstructionConfirmStore } from './pending-instruction-confirm-store';

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
export type ViewAck = (response?: any) => Promise<void>;

export interface SlackApiForActions {
  updateMessage(channel: string, ts: string, text: string, blocks?: any[]): Promise<unknown>;
  deleteMessage(channel: string, ts: string): Promise<unknown>;
  openDmChannel?(userId: string): Promise<string>;
  postMessage?(channel: string, text: string, options?: any): Promise<unknown>;
  [key: string]: any;
}

export interface ActionHandlerContext {
  slackApi: SlackApiForActions;
  claudeHandler: any;
  sessionManager: any;
  messageHandler: MessageHandler;
  reactionManager?: any;
  threadPanel?: any;
  requestCoordinator?: any;
  completionMessageTracker?: any;
  mcpManager?: any;
  pendingInstructionConfirmStore?: PendingInstructionConfirmStore;
}

export interface ActionHandlersStores {
  formStore: PendingFormStore;
  pendingInstructionConfirmStore: PendingInstructionConfirmStore;
}

export interface ZTopicRegistryLike {
  topics(): string[];
}

export interface ActionHandlerDelegates {
  permissionHandler: {
    handleApprove(body: any, respond: RespondFn): Promise<void>;
    handleDeny(body: any, respond: RespondFn): Promise<void>;
    handleExplain(body: any, respond: RespondFn): Promise<void>;
    handleApproveDisableRule(body: any, respond: RespondFn): Promise<void>;
  };
  sessionHandler: {
    handleTerminateSession(body: any, respond: RespondFn): Promise<void>;
    handleRefreshSessions(body: any, respond: RespondFn): Promise<void>;
    handleCloseConfirm(body: any, respond: RespondFn): Promise<void>;
    handleCloseCancel(body: any, respond: RespondFn): Promise<void>;
    handleIdleClose(body: any, respond: RespondFn): Promise<void>;
    handleIdleKeep(body: any, respond: RespondFn): Promise<void>;
  };
  compactHandler: {
    handleConfirm(body: any, respond: RespondFn): Promise<void>;
    handleCancel(body: any, respond: RespondFn): Promise<void>;
  };
  choiceHandler: {
    handleUserChoice(body: any): Promise<void>;
    handleMultiChoice(body: any): Promise<void>;
    handleEditChoice(body: any): Promise<void>;
    handleFormSubmit(body: any): Promise<void>;
    handleFormReset(body: any): Promise<void>;
    handleSubmitAllRecommended(body: any): Promise<void>;
    handleChoiceFromDashboard(
      sessionKey: string,
      choiceId: string,
      label: string,
      question: string,
      userId: string,
    ): Promise<void>;
    handleMultiChoiceFromDashboard(
      sessionKey: string,
      selections: Record<string, { choiceId: string; label: string }>,
      userId: string,
    ): Promise<void>;
    handleSubmitRecommendedFromDashboard(sessionKey: string, userId: string): Promise<void>;
  };
  formHandler: {
    handleCustomInputSingle(body: any, client: any): Promise<void>;
    handleCustomInputMulti(body: any, client: any): Promise<void>;
    handleCustomInputSubmit(body: any, view: any): Promise<void>;
  };
  jiraHandler: { handleTransition(body: any, respond: RespondFn): Promise<void> };
  prHandler: { handleMerge(body: any, respond: RespondFn): Promise<void> };
  actionPanelHandler: { handleAction(body: any, respond: RespondFn): Promise<void> };
  channelRouteHandler: {
    handleMove(body: any, respond: RespondFn): Promise<void>;
    handleStop(body: any, respond: RespondFn): Promise<void>;
    handleStay(body: any, respond: RespondFn): Promise<void>;
  };
  userAcceptanceHandler: {
    handleAccept(body: any, respond: RespondFn): Promise<void>;
    handleDeny(body: any, respond: RespondFn): Promise<void>;
  };
  userSkillMenuHandler: { handleAction(body: any, respond: RespondFn, client: any): Promise<void> };
  userSkillEditSubmitHandler: { handleSubmit(ack: ViewAck, body: any, client: any): Promise<void> };
  userSkillRenameSubmitHandler: { handleSubmit(ack: ViewAck, body: any, client: any): Promise<void> };
  userSkillDeleteSubmitHandler: { handleSubmit(ack: ViewAck, body: any, client: any): Promise<void> };
  usageCardHandler: { handleTabClick(body: any, client: any, respond: RespondFn): Promise<void> };
  mcpToolPermissionHandler: {
    handleApprove(body: any, respond: RespondFn): Promise<void>;
    handleDeny(body: any, respond: RespondFn): Promise<void>;
  };
  pluginUpdateHandler: {
    handleIgnore(body: any, respond: RespondFn): Promise<void>;
    handleForceUpdate(body: any, respond: RespondFn): Promise<void>;
  };
  instructionConfirmHandler: {
    handleYes(body: any, respond: RespondFn): Promise<void>;
    handleNo(body: any, respond: RespondFn): Promise<void>;
  };
  zSettingsHandler: { register(app: App): void };
  zTopicRegistry: ZTopicRegistryLike;
  registerCctActions(app: App): void;
}

export interface ActionHandlersProviders {
  createDelegates?: (ctx: ActionHandlerContext, stores: ActionHandlersStores) => ActionHandlerDelegates;
  isAdminUser?: (userId: string) => boolean;
}

const providers: Required<ActionHandlersProviders> = {
  createDelegates: () => {
    throw new Error('ActionHandlers delegate provider is not configured.');
  },
  isAdminUser: () => false,
};

export function setActionHandlersProviders(next: ActionHandlersProviders): void {
  if (next.createDelegates) providers.createDelegates = next.createDelegates;
  if (next.isAdminUser) providers.isAdminUser = next.isAdminUser;
}

const USER_SKILL_EDIT_MODAL_CALLBACK_ID = 'user_skill_edit_modal_submit';
const USER_SKILL_RENAME_MODAL_CALLBACK_ID = 'user_skill_rename_modal_submit';
const USER_SKILL_DELETE_MODAL_CALLBACK_ID = 'user_skill_delete_modal_submit';

/**
 * Slack action/view registration surface. Concrete handlers are supplied by
 * the composition root so package code owns routing without importing app-only
 * services.
 */
export class ActionHandlers {
  private logger = new Logger('ActionHandlers');
  private formStore: PendingFormStore;
  private pendingInstructionConfirmStore: PendingInstructionConfirmStore;
  private delegates: ActionHandlerDelegates;

  constructor(private ctx: ActionHandlerContext) {
    this.formStore = new PendingFormStore();
    this.pendingInstructionConfirmStore = ctx.pendingInstructionConfirmStore ?? new PendingInstructionConfirmStore();
    this.delegates = providers.createDelegates(ctx, {
      formStore: this.formStore,
      pendingInstructionConfirmStore: this.pendingInstructionConfirmStore,
    });
  }

  getZTopicRegistry(): ZTopicRegistryLike {
    return this.delegates.zTopicRegistry;
  }

  getPendingInstructionConfirmStore(): PendingInstructionConfirmStore {
    return this.pendingInstructionConfirmStore;
  }

  registerHandlers(app: App): void {
    app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.permissionHandler.handleApprove(body, respond as RespondFn);
    });

    app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.permissionHandler.handleDeny(body, respond as RespondFn);
    });

    app.action('explain_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.permissionHandler.handleExplain(body, respond as RespondFn);
    });

    app.action('approve_disable_rule_session', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.permissionHandler.handleApproveDisableRule(body, respond as RespondFn);
    });

    app.action('terminate_session', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.sessionHandler.handleTerminateSession(body, respond as RespondFn);
    });

    app.action('refresh_sessions', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.sessionHandler.handleRefreshSessions(body, respond as RespondFn);
    });

    app.action('close_session_confirm', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.sessionHandler.handleCloseConfirm(body, respond as RespondFn);
    });

    app.action('close_session_cancel', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.sessionHandler.handleCloseCancel(body, respond as RespondFn);
    });

    app.action('compact_confirm', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.compactHandler.handleConfirm(body, respond as RespondFn);
    });

    app.action('compact_cancel', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.compactHandler.handleCancel(body, respond as RespondFn);
    });

    app.action('idle_close_session', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.sessionHandler.handleIdleClose(body, respond as RespondFn);
    });

    app.action('idle_keep_session', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.sessionHandler.handleIdleKeep(body, respond as RespondFn);
    });

    app.action(/^usage_card_tab:/, async ({ ack, body, client, respond }) => {
      await ack();
      await this.delegates.usageCardHandler.handleTabClick(body, client, respond as RespondFn);
    });

    app.action(/^user_choice_/, async ({ ack, body }) => {
      await ack();
      await this.delegates.choiceHandler.handleUserChoice(body);
    });

    app.action(/^user_skill_menu_/, async ({ ack, body, respond, client }) => {
      await ack();
      await this.delegates.userSkillMenuHandler.handleAction(body, respond as RespondFn, client);
    });

    app.action(/^user_skill_invoke_/, async ({ ack, body, respond, client }) => {
      await ack();
      await this.delegates.userSkillMenuHandler.handleAction(body, respond as RespondFn, client);
    });

    app.view(USER_SKILL_EDIT_MODAL_CALLBACK_ID, async ({ ack, body, client }) => {
      await this.delegates.userSkillEditSubmitHandler.handleSubmit(ack as ViewAck, body, client);
    });

    app.view(USER_SKILL_RENAME_MODAL_CALLBACK_ID, async ({ ack, body, client }) => {
      await this.delegates.userSkillRenameSubmitHandler.handleSubmit(ack as ViewAck, body, client);
    });

    app.view(USER_SKILL_DELETE_MODAL_CALLBACK_ID, async ({ ack, body, client }) => {
      await this.delegates.userSkillDeleteSubmitHandler.handleSubmit(ack as ViewAck, body, client);
    });

    app.action(/^multi_choice_/, async ({ ack, body }) => {
      await ack();
      await this.delegates.choiceHandler.handleMultiChoice(body);
    });

    app.action(/^edit_choice_/, async ({ ack, body }) => {
      await ack();
      await this.delegates.choiceHandler.handleEditChoice(body);
    });

    app.action(/^submit_form_/, async ({ ack, body }) => {
      await ack();
      await this.delegates.choiceHandler.handleFormSubmit(body);
    });

    app.action(/^reset_form_/, async ({ ack, body }) => {
      await ack();
      await this.delegates.choiceHandler.handleFormReset(body);
    });

    app.action(/^submit_all_recommended_/, async ({ ack, body }) => {
      await ack();
      await this.delegates.choiceHandler.handleSubmitAllRecommended(body);
    });

    app.action('custom_input_single', async ({ ack, body, client }) => {
      await ack();
      await this.delegates.formHandler.handleCustomInputSingle(body, client);
    });

    app.action(/^custom_input_multi_/, async ({ ack, body, client }) => {
      await ack();
      await this.delegates.formHandler.handleCustomInputMulti(body, client);
    });

    app.action(/^jira_transition_/, async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.jiraHandler.handleTransition(body, respond as RespondFn);
    });

    app.action(/^merge_pr_/, async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.prHandler.handleMerge(body, respond as RespondFn);
    });

    app.action(/^panel_/, async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.actionPanelHandler.handleAction(body, respond as RespondFn);
    });

    app.action('accept_user', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.userAcceptanceHandler.handleAccept(body, respond as RespondFn);
    });

    app.action('deny_user', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.userAcceptanceHandler.handleDeny(body, respond as RespondFn);
    });

    app.action(/^mcp_tool_perm_approve_/, async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.mcpToolPermissionHandler.handleApprove(body, respond as RespondFn);
    });

    app.action(/^mcp_tool_perm_deny_/, async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.mcpToolPermissionHandler.handleDeny(body, respond as RespondFn);
    });

    app.action('channel_route_move', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.channelRouteHandler.handleMove(body, respond as RespondFn);
    });

    app.action('channel_route_stop', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.channelRouteHandler.handleStop(body, respond as RespondFn);
    });

    app.action('channel_route_stay', async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.channelRouteHandler.handleStay(body, respond as RespondFn);
    });

    app.action(/^plugin_update_ignore_/, async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.pluginUpdateHandler.handleIgnore(body, respond as RespondFn);
    });

    app.action(/^plugin_update_force_/, async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.pluginUpdateHandler.handleForceUpdate(body, respond as RespondFn);
    });

    app.action(/^instr_confirm_y:/, async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.instructionConfirmHandler.handleYes(body, respond as RespondFn);
    });

    app.action(/^instr_confirm_n:/, async ({ ack, body, respond }) => {
      await ack();
      await this.delegates.instructionConfirmHandler.handleNo(body, respond as RespondFn);
    });

    app.action('managed_message_delete_cancel', async ({ ack, body, respond }) => {
      await ack();
      await this.handleManagedDeleteCancel(body, respond as RespondFn);
    });

    app.action('managed_message_delete_confirm', async ({ ack, body, respond }) => {
      await ack();
      await this.handleManagedDeleteConfirm(body, respond as RespondFn);
    });

    app.action('dm_delete_approve', async ({ ack, body, respond }) => {
      await ack();
      await this.handleDmDeleteApprove(body, respond as RespondFn);
    });

    app.action('dm_delete_reject', async ({ ack, body, respond }) => {
      await ack();
      await this.handleDmDeleteReject(body, respond as RespondFn);
    });

    app.view('custom_input_submit', async ({ ack, body, view }) => {
      await ack();
      await this.delegates.formHandler.handleCustomInputSubmit(body, view);
    });

    this.delegates.zSettingsHandler.register(app);
    this.delegates.registerCctActions(app);
  }

  async handleDashboardChoiceAnswer(
    sessionKey: string,
    choiceId: string,
    label: string,
    question: string,
    userId: string,
  ): Promise<void> {
    return this.delegates.choiceHandler.handleChoiceFromDashboard(sessionKey, choiceId, label, question, userId);
  }

  async handleDashboardMultiChoiceAnswer(
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }>,
    userId: string,
  ): Promise<void> {
    return this.delegates.choiceHandler.handleMultiChoiceFromDashboard(sessionKey, selections, userId);
  }

  async handleDashboardSubmitRecommended(sessionKey: string, userId: string): Promise<void> {
    return this.delegates.choiceHandler.handleSubmitRecommendedFromDashboard(sessionKey, userId);
  }

  getPendingForm(formId: string): PendingChoiceFormData | undefined {
    return this.formStore.get(formId);
  }

  setPendingForm(formId: string, data: PendingChoiceFormData): void {
    this.formStore.set(formId, data);
  }

  deletePendingForm(formId: string): void {
    this.formStore.delete(formId);
  }

  async invalidateOldForms(sessionKey: string, newFormId: string, slackApi: SlackApiForActions): Promise<void> {
    const oldForms = this.formStore.getFormsBySession(sessionKey);
    const expiredFormBlock = [{ type: 'section', text: { type: 'mrkdwn', text: '⏱️ _만료됨_' } }];

    for (const [formId, form] of oldForms) {
      if (formId === newFormId || !form.messageTs) continue;

      try {
        await slackApi.updateMessage(
          form.channel,
          form.messageTs,
          '⏱️ _이 폼은 새로운 폼으로 대체되었습니다._',
          expiredFormBlock,
        );
        this.logger.debug('Invalidated old form', { formId, sessionKey });
      } catch (error) {
        this.logger.warn('Failed to update expired form message', { formId, error });
      }

      this.formStore.delete(formId);
    }
  }

  loadPendingForms(): number {
    return this.formStore.loadForms();
  }

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

  private async handleManagedDeleteCancel(body: any, respond: RespondFn): Promise<void> {
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

  private async handleManagedDeleteConfirm(body: any, respond: RespondFn): Promise<void> {
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

  private async handleDmDeleteApprove(body: any, respond: RespondFn): Promise<void> {
    const rawValue = body.actions?.[0]?.value || '{}';
    const value = this.parseManagedDeleteValue(rawValue);
    const actorId = body.user?.id;

    if (!value || !actorId) {
      this.logger.warn('Invalid dm delete approve payload', { rawValue, actorId });
      return;
    }

    if (!providers.isAdminUser(actorId)) {
      await respond({
        text: '⚠️ 어드민만 삭제를 승인할 수 있습니다.',
        response_type: 'ephemeral',
        replace_original: false,
      });
      return;
    }

    try {
      await this.ctx.slackApi.deleteMessage(value.targetChannel, value.targetTs);
      await respond({
        text: `✅ <@${actorId}>님이 삭제를 승인했습니다. 메시지가 삭제되었습니다.`,
        replace_original: true,
      });

      try {
        const requesterDm = await this.ctx.slackApi.openDmChannel?.(value.requesterId);
        if (requesterDm) {
          await this.ctx.slackApi.postMessage?.(
            requesterDm,
            '✅ 어드민이 삭제 요청을 승인했습니다. 메시지가 삭제되었습니다.',
          );
        }
      } catch {
        // Best-effort notification only.
      }

      this.logger.info('Admin approved DM delete request', {
        adminId: actorId,
        requesterId: value.requesterId,
        targetChannel: value.targetChannel,
        targetTs: value.targetTs,
      });
    } catch (error) {
      this.logger.warn('Failed to delete message after admin approval', {
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

  private async handleDmDeleteReject(body: any, respond: RespondFn): Promise<void> {
    const rawValue = body.actions?.[0]?.value || '{}';
    const value = this.parseManagedDeleteValue(rawValue);
    const actorId = body.user?.id;

    if (!value || !actorId) {
      this.logger.warn('Invalid dm delete reject payload', { rawValue, actorId });
      return;
    }

    if (!providers.isAdminUser(actorId)) {
      await respond({
        text: '⚠️ 어드민만 이 버튼을 사용할 수 있습니다.',
        response_type: 'ephemeral',
        replace_original: false,
      });
      return;
    }

    await respond({
      text: `❌ <@${actorId}>님이 삭제 요청을 거절했습니다.`,
      replace_original: true,
    });

    try {
      const requesterDm = await this.ctx.slackApi.openDmChannel?.(value.requesterId);
      if (requesterDm) {
        await this.ctx.slackApi.postMessage?.(requesterDm, '❌ 어드민이 삭제 요청을 거절했습니다.');
      }
    } catch {
      // Best-effort notification only.
    }

    this.logger.info('Admin rejected DM delete request', {
      adminId: actorId,
      requesterId: value.requesterId,
      targetChannel: value.targetChannel,
      targetTs: value.targetTs,
    });
  }
}
