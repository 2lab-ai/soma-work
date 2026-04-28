import type { App } from '@slack/bolt';
import { isAdminUser } from '../../admin-utils';
import { Logger } from '../../logger';
import { getTokenManager } from '../../token-manager';
import { registerCctActions } from '../cct/actions';
import { defaultTabCache } from '../commands/usage-carousel-cache';
import type { SlackApiHelper } from '../slack-api-helper';
import { buildDefaultTopicRegistry } from '../z/topics';
import { ActionPanelActionHandler } from './action-panel-action-handler';
import { ChannelRouteActionHandler } from './channel-route-action-handler';
import { ChoiceActionHandler } from './choice-action-handler';
import { CompactActionHandler } from './compact-action-handler';
import { FormActionHandler } from './form-action-handler';
import { InstructionConfirmActionHandler } from './instruction-confirm-action-handler';
import { JiraActionHandler } from './jira-action-handler';
import { McpToolPermissionActionHandler } from './mcp-tool-permission-action-handler';
import { PendingFormStore } from './pending-form-store';
import { PendingInstructionConfirmStore } from './pending-instruction-confirm-store';
import { PermissionActionHandler } from './permission-action-handler';
import { PluginUpdateActionHandler } from './plugin-update-action-handler';
import { PRActionHandler } from './pr-action-handler';
import { SessionActionHandler } from './session-action-handler';
import type { ActionHandlerContext, PendingChoiceFormData } from './types';
import { UsageCardActionHandler } from './usage-card-action-handler';
import { UserAcceptanceActionHandler } from './user-acceptance-action-handler';
import { UserSkillDeleteConfirmViewSubmissionHandler } from './user-skill-delete-confirm-view-submission-handler';
import { UserSkillEditViewSubmissionHandler, type ViewAck } from './user-skill-edit-view-submission-handler';
import {
  USER_SKILL_DELETE_MODAL_CALLBACK_ID,
  USER_SKILL_EDIT_MODAL_CALLBACK_ID,
  USER_SKILL_RENAME_MODAL_CALLBACK_ID,
  UserSkillMenuActionHandler,
} from './user-skill-menu-action-handler';
import { UserSkillRenameViewSubmissionHandler } from './user-skill-rename-view-submission-handler';
import { ZSettingsActionHandler, type ZTopicRegistry } from './z-settings-actions';

export { PendingFormStore } from './pending-form-store';
export { PendingInstructionConfirmStore } from './pending-instruction-confirm-store';
// Re-export types for backwards compatibility
export { ActionHandlerContext, MessageEvent, MessageHandler, PendingChoiceFormData, RespondFn, SayFn } from './types';

/**
 * ActionRouter - 모든 액션 핸들러 통합 라우터
 * 기존 ActionHandlers와 동일한 인터페이스 유지
 */
export class ActionHandlers {
  private logger = new Logger('ActionHandlers');
  private formStore: PendingFormStore;
  private pendingInstructionConfirmStore: PendingInstructionConfirmStore;
  private permissionHandler: PermissionActionHandler;
  private sessionHandler: SessionActionHandler;
  private compactHandler: CompactActionHandler;
  private choiceHandler: ChoiceActionHandler;
  private formHandler: FormActionHandler;
  private jiraHandler: JiraActionHandler;
  private prHandler: PRActionHandler;
  private actionPanelHandler: ActionPanelActionHandler;
  private channelRouteHandler: ChannelRouteActionHandler;
  private userAcceptanceHandler: UserAcceptanceActionHandler;
  private userSkillMenuHandler: UserSkillMenuActionHandler;
  private userSkillEditSubmitHandler: UserSkillEditViewSubmissionHandler;
  private userSkillRenameSubmitHandler: UserSkillRenameViewSubmissionHandler;
  private userSkillDeleteSubmitHandler: UserSkillDeleteConfirmViewSubmissionHandler;
  private usageCardHandler: UsageCardActionHandler;
  private mcpToolPermissionHandler: McpToolPermissionActionHandler;
  private pluginUpdateHandler: PluginUpdateActionHandler;
  private instructionConfirmHandler: InstructionConfirmActionHandler;
  private zSettingsHandler: ZSettingsActionHandler;
  private zTopicRegistry: ZTopicRegistry;

  constructor(private ctx: ActionHandlerContext) {
    this.formStore = new PendingFormStore();
    // The stream-executor side of the confirm flow needs the SAME store
    // instance we hand to `InstructionConfirmActionHandler` below. The
    // composition root (`SlackHandler`) is expected to inject its
    // already-constructed store via `ctx.pendingInstructionConfirmStore`;
    // when absent (tests, minimal harnesses), we fall back to a fresh
    // local instance so the handler stays callable even if no writes
    // will ever land.
    this.pendingInstructionConfirmStore = ctx.pendingInstructionConfirmStore ?? new PendingInstructionConfirmStore();

    // Optional-chain the call: test harnesses pass minimal ClaudeHandler mocks
    // that omit getSessionRegistry. In that case `PermissionActionHandler`'s
    // undefined-sessionRegistry fallback honors the Approve intent so the
    // user's click still resolves.
    this.permissionHandler = new PermissionActionHandler(ctx.claudeHandler.getSessionRegistry?.());

    this.sessionHandler = new SessionActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      sessionManager: ctx.sessionManager,
      reactionManager: ctx.reactionManager,
      requestCoordinator: ctx.requestCoordinator,
      threadPanel: ctx.threadPanel,
    });

    this.compactHandler = new CompactActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      messageHandler: ctx.messageHandler,
    });

    this.choiceHandler = new ChoiceActionHandler(
      {
        slackApi: ctx.slackApi,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler,
        threadPanel: ctx.threadPanel,
        completionMessageTracker: ctx.completionMessageTracker,
      },
      this.formStore,
    );

    this.formHandler = new FormActionHandler(
      {
        slackApi: ctx.slackApi,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler,
        threadPanel: ctx.threadPanel,
      },
      this.formStore,
      this.choiceHandler,
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
      requestCoordinator: ctx.requestCoordinator,
      threadPanel: ctx.threadPanel,
    });

    this.channelRouteHandler = new ChannelRouteActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      messageHandler: ctx.messageHandler,
    });

    this.userAcceptanceHandler = new UserAcceptanceActionHandler({
      slackApi: ctx.slackApi,
    });

    // Personal-skill menu (overflow / button) click handler — paired with
    // UserSkillsListHandler (`$user` bare command). Each option/button value
    // carries `{kind, skillName, requesterId}`. Mismatched clickers are
    // rejected ephemerally; `kind=user_skill_invoke` re-injects `$user:{name}`,
    // `kind=user_skill_edit` opens the inline-edit modal (issue #750).
    this.userSkillMenuHandler = new UserSkillMenuActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      messageHandler: ctx.messageHandler,
    });
    this.userSkillEditSubmitHandler = new UserSkillEditViewSubmissionHandler({
      slackApi: ctx.slackApi,
    });
    // Issue #774 — rename / delete view-submission handlers. Both close the
    // modal on success and best-effort update the originating list message
    // in place (so the user sees the new name / removed entry without
    // re-typing `$user`).
    this.userSkillRenameSubmitHandler = new UserSkillRenameViewSubmissionHandler({
      slackApi: ctx.slackApi,
    });
    this.userSkillDeleteSubmitHandler = new UserSkillDeleteConfirmViewSubmissionHandler({
      slackApi: ctx.slackApi,
    });

    // Usage card carousel tab click handler — Trace: docs/usage-card-dark/trace.md, Scenarios 8/9/11
    this.usageCardHandler = new UsageCardActionHandler({
      tabCache: defaultTabCache,
    });

    this.mcpToolPermissionHandler = new McpToolPermissionActionHandler();

    this.pluginUpdateHandler = new PluginUpdateActionHandler({
      mcpManager: ctx.mcpManager,
    });

    // Instruction-confirm y/n handler — uses the same shared store as
    // StreamExecutor so a write deferred by the executor is visible to
    // the click handler (PLAN §7).
    this.instructionConfirmHandler = new InstructionConfirmActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      store: this.pendingInstructionConfirmStore,
    });

    // `/z` Block Kit action/view router — registered alongside the others
    // in `registerHandlers`. The registry is populated up-front so tests and
    // introspection callers can access topic bindings before `registerHandlers`
    // runs.
    this.zTopicRegistry = buildDefaultTopicRegistry();
    this.zSettingsHandler = new ZSettingsActionHandler({
      registry: this.zTopicRegistry,
    });
  }

  /** Topic registry backing the `/z` Block Kit actions. Exposed for tests. */
  getZTopicRegistry(): ZTopicRegistry {
    return this.zTopicRegistry;
  }

  /**
   * The shared store for deferred instruction writes. Exposed so the
   * composition root (`SlackHandler`) can pass the SAME instance to
   * `StreamExecutor` — both halves of the confirm flow must see the
   * same entries (PLAN §7).
   */
  getPendingInstructionConfirmStore(): PendingInstructionConfirmStore {
    return this.pendingInstructionConfirmStore;
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

    app.action('explain_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.permissionHandler.handleExplain(body, respond);
    });

    // Approve current tool AND disable the matched overridable
    // dangerous-command rule(s) for the remainder of this ConversationSession
    // (Slack thread). The button is only rendered for bypass-mode Bash
    // escalations that matched `sessionOverridable=true` rules.
    app.action('approve_disable_rule_session', async ({ ack, body, respond }) => {
      await ack();
      await this.permissionHandler.handleApproveDisableRule(body, respond);
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

    // Compact confirm/cancel (from /compact command) — #617 followup v2
    app.action('compact_confirm', async ({ ack, body, respond }) => {
      await ack();
      await this.compactHandler.handleConfirm(body, respond);
    });

    app.action('compact_cancel', async ({ ack, body, respond }) => {
      await ack();
      await this.compactHandler.handleCancel(body, respond);
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

    // Usage card carousel tab click — Trace: docs/usage-card-dark/trace.md, Scenario 8
    app.action(/^usage_card_tab:/, async ({ ack, body, client, respond }) => {
      await ack();
      await this.usageCardHandler.handleTabClick(body, client, respond);
    });

    // 사용자 선택 액션
    app.action(/^user_choice_/, async ({ ack, body }) => {
      await ack();
      await this.choiceHandler.handleUserChoice(body);
    });

    // Personal-skill menu accessory (paired with `$user` bare command).
    //   - `/^user_skill_menu_/`     → new overflow accessory (single-file
    //     skills, options: 발동 + 편집).
    //   - `/^user_skill_invoke_/`   → BC button accessory (multi-file skills
    //     and any in-flight messages rendered before issue #750 shipped).
    //
    // Both regexes route to the SAME handler (`handleAction`) which dispatches
    // on the `kind` field inside the parsed action value, NOT on the
    // action_id prefix. The BC route can be removed once all in-flight
    // messages have aged out.
    app.action(/^user_skill_menu_/, async ({ ack, body, respond, client }) => {
      await ack();
      await this.userSkillMenuHandler.handleAction(body, respond, client);
    });

    app.action(/^user_skill_invoke_/, async ({ ack, body, respond, client }) => {
      await ack();
      await this.userSkillMenuHandler.handleAction(body, respond, client);
    });

    // Inline-edit modal submission (issue #750). The view-submission handler
    // calls `ack()` itself with `response_action: 'errors' | 'clear'` so the
    // wiring layer must NOT pre-ack — Slack rejects double-acks.
    app.view(USER_SKILL_EDIT_MODAL_CALLBACK_ID, async ({ ack, body, client }) => {
      // Bolt's union ack type can't be narrowed structurally here; `ViewAck`
      // captures the `view_submission` arm so the cast names a real type.
      await this.userSkillEditSubmitHandler.handleSubmit(ack as ViewAck, body, client);
    });

    // Rename modal submission (issue #774). Same no-pre-ack contract as the
    // edit modal — handler emits `response_action: 'errors' | 'clear'`.
    app.view(USER_SKILL_RENAME_MODAL_CALLBACK_ID, async ({ ack, body, client }) => {
      await this.userSkillRenameSubmitHandler.handleSubmit(ack as ViewAck, body, client);
    });

    // Delete confirmation modal submission (issue #774). Submission == confirm.
    app.view(USER_SKILL_DELETE_MODAL_CALLBACK_ID, async ({ ack, body, client }) => {
      await this.userSkillDeleteSubmitHandler.handleSubmit(ack as ViewAck, body, client);
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

    // Hero "Submit All Recommended" — group-only one-click. Regex matches BOTH
    // `submit_all_recommended_<formId>` (active) and
    // `submit_all_recommended_blocked_<formId>` (blocked sentinel); the handler
    // dispatches on the `_blocked_` substring inside the action_id.
    app.action(/^submit_all_recommended_/, async ({ ack, body }) => {
      await ack();
      await this.choiceHandler.handleSubmitAllRecommended(body);
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

    // User acceptance actions (admin Accept/Deny buttons)
    app.action('accept_user', async ({ ack, body, respond }) => {
      await ack();
      await this.userAcceptanceHandler.handleAccept(body, respond);
    });

    app.action('deny_user', async ({ ack, body, respond }) => {
      await ack();
      await this.userAcceptanceHandler.handleDeny(body, respond);
    });

    // MCP tool permission actions (approve/deny grant requests)
    // Trace: docs/mcp-tool-permission/trace.md, S4
    app.action(/^mcp_tool_perm_approve_/, async ({ ack, body, respond }) => {
      await ack();
      await this.mcpToolPermissionHandler.handleApprove(body, respond);
    });

    app.action(/^mcp_tool_perm_deny_/, async ({ ack, body, respond }) => {
      await ack();
      await this.mcpToolPermissionHandler.handleDeny(body, respond);
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

    // Plugin update actions (ignore / force update)
    app.action(/^plugin_update_ignore_/, async ({ ack, body, respond }) => {
      await ack();
      await this.pluginUpdateHandler.handleIgnore(body, respond);
    });

    app.action(/^plugin_update_force_/, async ({ ack, body, respond }) => {
      await ack();
      await this.pluginUpdateHandler.handleForceUpdate(body, respond);
    });

    // Instruction-write confirmation buttons (PLAN §7).
    // action_id format: `instr_confirm_y:<requestId>` / `instr_confirm_n:<requestId>`.
    app.action(/^instr_confirm_y:/, async ({ ack, body, respond }) => {
      await ack();
      await this.instructionConfirmHandler.handleYes(body, respond);
    });

    app.action(/^instr_confirm_n:/, async ({ ack, body, respond }) => {
      await ack();
      await this.instructionConfirmHandler.handleNo(body, respond);
    });

    app.action('managed_message_delete_cancel', async ({ ack, body, respond }) => {
      await ack();
      await this.handleManagedDeleteCancel(body, respond);
    });

    app.action('managed_message_delete_confirm', async ({ ack, body, respond }) => {
      await ack();
      await this.handleManagedDeleteConfirm(body, respond);
    });

    // Admin approval/rejection for DM delete requests from non-admin users
    app.action('dm_delete_approve', async ({ ack, body, respond }) => {
      await ack();
      await this.handleDmDeleteApprove(body, respond);
    });

    app.action('dm_delete_reject', async ({ ack, body, respond }) => {
      await ack();
      await this.handleDmDeleteReject(body, respond);
    });

    // 모달 핸들러
    app.view('custom_input_submit', async ({ ack, body, view }) => {
      await ack();
      await this.formHandler.handleCustomInputSubmit(body, view);
    });

    // `/z` Block Kit settings actions + view_submission (#507, Phase 2).
    // Registers: z_setting_*_set_*, z_setting_*_cancel, z_setting_*_open_modal,
    //            z_help_nav_*, and view z_setting_*_modal_submit.
    this.zSettingsHandler.register(app);

    // CCT slot overhaul (#569, Wave 4) — Add/Remove/Rename modals + rotate +
    // set-active. Distinct action_id namespace from the z_setting_* pipeline
    // (see src/slack/cct/views.ts).
    registerCctActions(app, getTokenManager());
  }

  /** Delegate dashboard choice answer to ChoiceActionHandler */
  async handleDashboardChoiceAnswer(
    sessionKey: string,
    choiceId: string,
    label: string,
    question: string,
    userId: string,
  ): Promise<void> {
    return this.choiceHandler.handleChoiceFromDashboard(sessionKey, choiceId, label, question, userId);
  }

  /** Delegate dashboard multi-choice form submission to ChoiceActionHandler */
  async handleDashboardMultiChoiceAnswer(
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }>,
    userId: string,
  ): Promise<void> {
    return this.choiceHandler.handleMultiChoiceFromDashboard(sessionKey, selections, userId);
  }

  /** Delegate dashboard "Submit All Recommended" hero click to ChoiceActionHandler */
  async handleDashboardSubmitRecommended(sessionKey: string, userId: string): Promise<void> {
    return this.choiceHandler.handleSubmitRecommendedFromDashboard(sessionKey, userId);
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
  async invalidateOldForms(sessionKey: string, newFormId: string, slackApi: SlackApiHelper): Promise<void> {
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
          expiredFormBlock,
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

  /**
   * Admin approves a DM delete request from a non-admin user.
   */
  private async handleDmDeleteApprove(body: any, respond: any): Promise<void> {
    const rawValue = body.actions?.[0]?.value || '{}';
    const value = this.parseManagedDeleteValue(rawValue);
    const actorId = body.user?.id;

    if (!value || !actorId) {
      this.logger.warn('Invalid dm delete approve payload', { rawValue, actorId });
      return;
    }

    if (!isAdminUser(actorId)) {
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

      // Notify the requester
      try {
        const requesterDm = await this.ctx.slackApi.openDmChannel(value.requesterId);
        await this.ctx.slackApi.postMessage(
          requesterDm,
          '✅ 어드민이 삭제 요청을 승인했습니다. 메시지가 삭제되었습니다.',
        );
      } catch {
        // Best-effort notification
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

  /**
   * Admin rejects a DM delete request from a non-admin user.
   */
  private async handleDmDeleteReject(body: any, respond: any): Promise<void> {
    const rawValue = body.actions?.[0]?.value || '{}';
    const value = this.parseManagedDeleteValue(rawValue);
    const actorId = body.user?.id;

    if (!value || !actorId) {
      this.logger.warn('Invalid dm delete reject payload', { rawValue, actorId });
      return;
    }

    if (!isAdminUser(actorId)) {
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

    // Notify the requester
    try {
      const requesterDm = await this.ctx.slackApi.openDmChannel(value.requesterId);
      await this.ctx.slackApi.postMessage(requesterDm, '❌ 어드민이 삭제 요청을 거절했습니다.');
    } catch {
      // Best-effort notification
    }

    this.logger.info('Admin rejected DM delete request', {
      adminId: actorId,
      requesterId: value.requesterId,
      targetChannel: value.targetChannel,
      targetTs: value.targetTs,
    });
  }
}
