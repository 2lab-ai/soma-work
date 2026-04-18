import type { EndTurnInfo } from '../agent-session/agent-session-types';
import type { ClaudeHandler } from '../claude-handler';
import { config } from '../config';
import { Logger } from '../logger';
import type { TodoManager } from '../todo-manager';
import type { ConversationSession } from '../types';
import type { CompletionMessageTracker } from './completion-message-tracker';
import type { RequestCoordinator } from './request-coordinator';
import type { SlackApiHelper } from './slack-api-helper';
import { ThreadSurface } from './thread-surface';
import { type TurnContext, type TurnEndReason, TurnSurface } from './turn-surface';
import type { SlackMessagePayload } from './user-choice-handler';

interface ThreadPanelDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  requestCoordinator: RequestCoordinator;
  todoManager: TodoManager;
  completionMessageTracker?: CompletionMessageTracker;
}

// Keeps TurnSurface `@internal` while exposing the public type contract.
export type { TurnContext, TurnEndReason } from './turn-surface';

/**
 * ThreadPanel — combined header+panel rendering (legacy) + per-turn B1 stream
 * façade (5-block UI refactor, Issue #525).
 *
 * Legacy (PHASE=0) behavior is preserved: all existing callers see identical
 * behavior because the delegated ThreadSurface path is unchanged.
 *
 * New per-turn API (PHASE>=1):
 *   `beginTurn` / `appendText` / `endTurn` / `failTurn` route to TurnSurface,
 *   which owns `chat.startStream` / `appendStream` / `stopStream`.
 * When PHASE=0 these methods silently no-op so the stream-executor / stream-
 * processor can call them unconditionally and the legacy `context.say` path
 * keeps running.
 *
 * @internal — ThreadSurface/TurnSurface are implementation details;
 *             callers MUST go through ThreadPanel.
 */
export class ThreadPanel {
  private logger = new Logger('ThreadPanel');
  private surface: ThreadSurface;
  private turnSurface: TurnSurface;

  constructor(private deps: ThreadPanelDeps) {
    this.surface = new ThreadSurface(deps);
    this.turnSurface = new TurnSurface({ slackApi: deps.slackApi });
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

  // =========================================================================
  // 5-block per-turn façade (Issue #525, P1)
  //
  // PHASE=0 → no-op (legacy ThreadSurface + context.say continue to own B1).
  // PHASE>=1 → delegate to TurnSurface for chat.startStream / appendStream /
  //            stopStream. Callers (stream-processor, stream-executor) may
  //            invoke these unconditionally; the PHASE guard lives here.
  // =========================================================================

  /**
   * Whether the 5-block per-turn façade is active for this deployment. Used
   * by stream-processor to choose between the legacy `context.say` path and
   * the new `appendText` path without importing `config` itself.
   */
  isTurnSurfaceActive(): boolean {
    return config.ui.fiveBlockPhase >= 1;
  }

  /** Open a per-turn B1 stream. PHASE=0 no-ops. */
  async beginTurn(ctx: TurnContext): Promise<void> {
    if (config.ui.fiveBlockPhase < 1) return;
    await this.turnSurface.begin(ctx);
  }

  /**
   * Append a markdown_text chunk to the active B1 stream.
   *
   * Returns `true` when Slack accepted the chunk, `false` when it did not
   * (PHASE<1, empty text, no open stream, or SDK error). Callers use the
   * `false` return as the "fall back to legacy `context.say`" signal so a
   * transient `startStream` failure under PHASE>=1 doesn't silently eat the
   * assistant reply.
   */
  async appendText(turnId: string, text: string): Promise<boolean> {
    if (config.ui.fiveBlockPhase < 1) return false;
    return this.turnSurface.appendText(turnId, text);
  }

  /** Close the B1 stream for a turn. PHASE=0 no-ops. Idempotent. */
  async endTurn(turnId: string, reason: TurnEndReason): Promise<void> {
    if (config.ui.fiveBlockPhase < 1) return;
    await this.turnSurface.end(turnId, reason);
  }

  /** Defensive close on error — always attempts stopStream. PHASE=0 no-ops. */
  async failTurn(turnId: string, error: Error): Promise<void> {
    if (config.ui.fiveBlockPhase < 1) return;
    await this.turnSurface.fail(turnId, error);
  }

  // ---- internal helpers ----

  private findSessionKey(session: ConversationSession): string | undefined {
    const threadTs = session.threadRootTs || session.threadTs;
    if (!threadTs) return undefined;
    return this.deps.claudeHandler.getSessionKey(session.channelId, threadTs);
  }
}
