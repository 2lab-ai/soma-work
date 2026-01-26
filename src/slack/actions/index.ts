import { App } from '@slack/bolt';
import { PermissionActionHandler } from './permission-action-handler';
import { SessionActionHandler } from './session-action-handler';
import { ChoiceActionHandler } from './choice-action-handler';
import { FormActionHandler } from './form-action-handler';
import { PendingFormStore } from './pending-form-store';
import { ActionHandlerContext, PendingChoiceFormData } from './types';

// Re-export types for backwards compatibility
export { ActionHandlerContext, MessageEvent, MessageHandler, SayFn, RespondFn, PendingChoiceFormData } from './types';
export { PendingFormStore } from './pending-form-store';

/**
 * ActionRouter - 모든 액션 핸들러 통합 라우터
 * 기존 ActionHandlers와 동일한 인터페이스 유지
 */
export class ActionHandlers {
  private formStore: PendingFormStore;
  private permissionHandler: PermissionActionHandler;
  private sessionHandler: SessionActionHandler;
  private choiceHandler: ChoiceActionHandler;
  private formHandler: FormActionHandler;

  constructor(private ctx: ActionHandlerContext) {
    this.formStore = new PendingFormStore();

    this.permissionHandler = new PermissionActionHandler();

    this.sessionHandler = new SessionActionHandler({
      slackApi: ctx.slackApi,
      claudeHandler: ctx.claudeHandler,
      sessionManager: ctx.sessionManager,
    });

    this.choiceHandler = new ChoiceActionHandler(
      {
        slackApi: ctx.slackApi,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler,
      },
      this.formStore
    );

    this.formHandler = new FormActionHandler(
      {
        slackApi: ctx.slackApi,
        claudeHandler: ctx.claudeHandler,
        messageHandler: ctx.messageHandler,
      },
      this.formStore,
      this.choiceHandler
    );
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
}
