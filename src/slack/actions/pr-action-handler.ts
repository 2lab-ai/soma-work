import { Logger } from '../../logger';
import { runSessionInjectionAction, type SessionActionContext } from './session-action-injector';
import type { RespondFn } from './types';

type PRActionContext = SessionActionContext;

/**
 * PR merge action handler.
 * Delegates merge execution to the session AI via message injection.
 */
export class PRActionHandler {
  private logger = new Logger('PRActionHandler');

  constructor(private ctx: PRActionContext) {}

  async handleMerge(body: any, respond: RespondFn): Promise<void> {
    await runSessionInjectionAction(
      this.ctx,
      this.logger,
      body,
      respond,
      '❌ PR 머지 처리 중 오류가 발생했습니다.',
      (valueData, userId) => {
        const { sessionKey, prUrl, prLabel, headBranch, baseBranch } = valueData;
        return {
          sessionKey,
          logLabel: 'PR merge requested',
          logData: { sessionKey, prUrl, prLabel, userId },
          ackText: `🔀 ${prLabel} 머지 요청을 전달합니다...`,
          injectedText: `PR을 머지해주세요.\nURL: ${prUrl}\nSource: ${headBranch} → Target: ${baseBranch}\nsquash merge로 진행하고, 머지 후 소스 브랜치를 삭제해주세요.`,
        };
      },
    );
  }
}
