import { Logger } from '../../logger';
import { runSessionInjectionAction, type SessionActionContext } from './session-action-injector';
import type { RespondFn } from './types';

type JiraActionContext = SessionActionContext;

/**
 * Jira issue transition action handler.
 * Delegates transition execution to the session AI via message injection.
 */
export class JiraActionHandler {
  private logger = new Logger('JiraActionHandler');

  constructor(private ctx: JiraActionContext) {}

  async handleTransition(body: any, respond: RespondFn): Promise<void> {
    await runSessionInjectionAction(
      this.ctx,
      this.logger,
      body,
      respond,
      '❌ Jira 상태 전환 처리 중 오류가 발생했습니다.',
      (valueData, userId) => {
        const { sessionKey, issueKey, transitionId, transitionName } = valueData;
        return {
          sessionKey,
          logLabel: 'Jira transition requested',
          logData: { sessionKey, issueKey, transitionId, transitionName, userId },
          ackText: `🔄 Jira 이슈 ${issueKey} 상태를 "${transitionName}"으로 변경 요청을 전달합니다...`,
          injectedText: `Jira 이슈 ${issueKey} 상태를 "${transitionName}"(으)로 변경해주세요.`,
        };
      },
    );
  }
}
