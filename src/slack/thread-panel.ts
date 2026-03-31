import type { EndTurnInfo } from '../agent-session/agent-session-types';
import type { ClaudeHandler } from '../claude-handler';
import { Logger } from '../logger';
import type { TodoManager } from '../todo-manager';
import type { ConversationSession } from '../types';
import type { CompletionMessageTracker } from './completion-message-tracker';
import type { RequestCoordinator } from './request-coordinator';
import type { SlackApiHelper } from './slack-api-helper';
import { ThreadSurface } from './thread-surface';
import type { SlackMessagePayload } from './user-choice-handler';

interface ThreadPanelDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  requestCoordinator: RequestCoordinator;
  todoManager: TodoManager;
  completionMessageTracker?: CompletionMessageTracker;
}

/**
 * ThreadPanel — now delegates to ThreadSurface for combined header+panel rendering.
 *
 * Maintains the same public API so all existing callers continue to work unchanged.
 * ThreadSurface is the single-writer implementation with debounce and coalescing.
 */
export class ThreadPanel {
  private logger = new Logger('ThreadPanel');
  private surface: ThreadSurface;

  constructor(private deps: ThreadPanelDeps) {
    this.surface = new ThreadSurface(deps);
  }

  async create(session: ConversationSession, sessionKey: string): Promise<void> {
    await this.surface.initialize(session, sessionKey);
  }

  async setStatus(
    session: ConversationSession,
    sessionKey: string,
    patch: {
      agentPhase?: string;
      activeTool?: string;
      waitingForChoice?: boolean;
    },
  ): Promise<void> {
    await this.surface.setStatus(session, sessionKey, patch);
  }

  async updateHeader(session: ConversationSession): Promise<void> {
    // With combined rendering, header is part of the surface.
    // No-op: header updates happen through requestRender.
    // If called directly (e.g. link change), trigger a re-render.
    const sessionKey = this.findSessionKey(session);
    if (sessionKey) {
      await this.surface.refreshAndRender(session, sessionKey);
    }
  }

  async attachChoice(sessionKey: string, payload: SlackMessagePayload, sourceMessageTs?: string): Promise<void> {
    await this.surface.attachChoice(sessionKey, payload, sourceMessageTs);
  }

  async clearChoice(sessionKey: string): Promise<void> {
    await this.surface.clearChoice(sessionKey);
  }

  async updatePanel(session: ConversationSession, sessionKey: string): Promise<void> {
    await this.surface.updatePanel(session, sessionKey);
  }

  async close(session: ConversationSession, sessionKey: string): Promise<void> {
    await this.surface.close(session, sessionKey);
  }

  /** TurnRunner용 — endTurn 기반 최종 상태 설정 (Issue #87) */
  async finalizeOnEndTurn(
    session: ConversationSession,
    sessionKey: string,
    endTurnInfo: EndTurnInfo,
    hasPendingChoice: boolean,
  ): Promise<void> {
    await this.surface.finalizeOnEndTurn(session, sessionKey, endTurnInfo, hasPendingChoice);
  }

  // ---- internal helpers ----

  private findSessionKey(session: ConversationSession): string | undefined {
    const threadTs = session.threadRootTs || session.threadTs;
    if (!threadTs) return undefined;
    return this.deps.claudeHandler.getSessionKey(session.channelId, threadTs);
  }
}
