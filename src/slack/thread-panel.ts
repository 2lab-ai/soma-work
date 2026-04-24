import type { EndTurnInfo } from '../agent-session/agent-session-types';
import type { ClaudeHandler } from '../claude-handler';
import { config } from '../config';
import { Logger } from '../logger';
import type { SlackBlockKitChannel } from '../notification-channels/slack-block-kit-channel';
import type { SessionRegistry } from '../session-registry';
import type { Todo, TodoManager } from '../todo-manager';
import type { ConversationSession, UserChoice, UserChoices } from '../types';
import { buildMarkerBlocks, FORM_BUILD_FAILED_TEXT } from './actions/click-classifier';
import type { AssistantStatusManager } from './assistant-status-manager';
import type { CompletionMessageTracker } from './completion-message-tracker';
import type { RequestCoordinator } from './request-coordinator';
import type { SlackApiHelper } from './slack-api-helper';
import { ThreadSurface } from './thread-surface';
import { type TurnAddress, type TurnContext, type TurnEndReason, TurnSurface } from './turn-surface';
import type { SlackMessagePayload } from './user-choice-handler';

interface ThreadPanelDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  requestCoordinator: RequestCoordinator;
  todoManager: TodoManager;
  completionMessageTracker?: CompletionMessageTracker;
  /**
   * P3 (PHASE>=3) dep — SessionRegistry for persistAndBroadcast() after
   * pendingChoice mutations. Optional for backward compatibility with
   * legacy tests that construct ThreadPanel without it; persist calls
   * degrade to no-ops when absent.
   */
  sessionRegistry?: SessionRegistry;
  /**
   * #689 P4 Part 2/2 — threaded into ThreadSurface (chip suppression) and
   * TurnSurface (native spinner writer). Optional so existing tests that
   * construct ThreadPanel without this dep continue to pass.
   */
  assistantStatusManager?: AssistantStatusManager;
  /**
   * P5 B5 sink. MUST be the same instance registered in `TurnNotifier`'s
   * channel list so the exclusion filter and the TurnSurface emit hit the
   * same object. Undefined → capability reports inactive (legacy path).
   */
  slackBlockKitChannel?: SlackBlockKitChannel;
}

// Keeps TurnSurface `@internal` while exposing the public type contract.
export type { TurnAddress, TurnContext, TurnEndReason } from './turn-surface';

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
    this.turnSurface = new TurnSurface({
      slackApi: deps.slackApi,
      assistantStatusManager: deps.assistantStatusManager,
      slackBlockKitChannel: deps.slackBlockKitChannel,
      isCompletionMarkerActive: () => this.isCompletionMarkerActive(),
    });
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

  /**
   * P5 capability SSOT. `true` → TurnSurface writes the B5 marker and
   * stream-executor excludes `slack-block-kit` from TurnNotifier. Requires
   * both the phase flag AND the channel dep — a missing dep at PHASE=5
   * keeps the legacy fan-out instead of silently dropping the marker.
   */
  isCompletionMarkerActive(): boolean {
    return config.ui.fiveBlockPhase >= 5 && this.deps.slackBlockKitChannel !== undefined;
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

  /**
   * Render the TodoWrite plan snapshot as a dedicated B2 plan block message
   * (P2, Issue #577). Writes to `planTs` (separate Slack message from the B1
   * stream and from the legacy combined header). Gated on PHASE>=2; PHASE<2
   * returns `false` so callers keep using the legacy ThreadSurface embed.
   *
   * `ctx` is required when `renderTasks` is invoked before `beginTurn` (e.g.
   * a TodoWrite fires in a turn that hasn't opened a B1 stream yet). If `ctx`
   * is omitted and no TurnState exists, the call is a silent no-op returning
   * `false`.
   *
   * Returns `true` when Slack accepted the (debounced) render, `false` when
   * it did not (PHASE<2, missing ctx + no state, or SDK error). Callers treat
   * `false` as "fall back to legacy `onRenderRequest`".
   */
  async renderTasks(turnId: string, todos: Todo[], ctx?: TurnAddress): Promise<boolean> {
    if (config.ui.fiveBlockPhase < 2) return false;
    return this.turnSurface.renderTasks(turnId, todos, ctx);
  }

  // =========================================================================
  // 5-block per-turn façade — P3 B3 choice (Issue #665)
  //
  // PHASE<3 → returns a sentinel (`{ok:false, reason:'phase-disabled'}` or
  //           `false`) so callers take the legacy `context.say` +
  //           `attachChoice` / `sendCommandChoiceFallback` path.
  // PHASE>=3 → posts the question via TurnSurface, synchronously writes
  //           `session.actionPanel.pendingChoice` + co-fields, and fires
  //           permalink warm-up via `ThreadSurface.setChoiceMeta`.
  //
  // Write-order invariant: after postMessage returns a ts, the session state
  // write (pendingChoice + choiceMessageTs + waitingForChoice) runs
  // SYNCHRONOUSLY before any further await — otherwise a live click during
  // the permalink await hits a stale "no pendingChoice" branch.
  // =========================================================================

  /**
   * P3 (PHASE>=3) — single-choice ask. Posts the question via TurnSurface,
   * synchronously writes session state, then fires permalink warm-up.
   *
   * Returns `{ok:true, primaryTs}` on success.
   * Returns `{ok:false, reason:'phase-disabled'}` if PHASE<3 — caller
   *   falls back to the legacy path.
   * Returns `{ok:false, reason:'post-failed', error}` if the Slack post
   *   itself raised — caller falls back to `sendCommandChoiceFallback`.
   *
   * `session` is mutated in place with the new pending record. Caller is
   * responsible for having cleared any prior pendingChoice BEFORE calling
   * (defensive prelude in stream-executor).
   */
  async askUser(
    turnId: string,
    question: UserChoice,
    builtPayload: { blocks?: any[]; attachments?: any[] },
    text: string,
    address: TurnAddress,
    session: ConversationSession,
    sessionKey: string,
  ): Promise<{ ok: true; primaryTs: string } | { ok: false; reason: 'phase-disabled' | 'post-failed'; error?: Error }> {
    if (config.ui.fiveBlockPhase < 3) return { ok: false, reason: 'phase-disabled' };
    let ts: string;
    try {
      ts = await this.turnSurface.askUser(turnId, builtPayload, text, address);
    } catch (err) {
      return { ok: false, reason: 'post-failed', error: err as Error };
    }
    if (!ts) return { ok: false, reason: 'phase-disabled' };

    // SYNCHRONOUS state write — no await between postMessage and here.
    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }
    session.actionPanel.pendingChoice = {
      turnId,
      kind: 'single',
      choiceTs: ts,
      formIds: [],
      question,
      createdAt: Date.now(),
    };
    session.actionPanel.choiceMessageTs = ts;
    session.actionPanel.waitingForChoice = true;

    // Persist + broadcast immediately so the dashboard sees the new pending
    // question and a concurrent restart can restore state.
    this.deps.sessionRegistry?.persistAndBroadcast(sessionKey);

    // Fire-and-forget permalink warm + render.
    this.surface.setChoiceMeta(sessionKey, ts).catch((err) => {
      this.logger.warn('askUser: setChoiceMeta failed', {
        sessionKey,
        turnId,
        error: (err as Error)?.message ?? String(err),
      });
    });

    return { ok: true, primaryTs: ts };
  }

  /**
   * P3 (PHASE>=3) — multi-choice ask. Caller (stream-executor) provides
   * pre-chunked payloads + pre-allocated formIds (already registered in
   * PendingFormStore with turnId). ThreadPanel posts all chunks, writes
   * state after the FIRST chunk succeeds, and rolls back Slack-side on
   * partial failure.
   */
  async askUserForm(
    turnId: string,
    chunks: Array<{ builtPayload: { blocks?: any[]; attachments?: any[] }; text: string }>,
    formIds: string[],
    originalQuestion: UserChoices,
    address: TurnAddress,
    session: ConversationSession,
    sessionKey: string,
  ): Promise<
    | { ok: true; primaryTs: string; allTs: string[]; formIds: string[] }
    | { ok: false; reason: 'phase-disabled' }
    | { ok: false; reason: 'post-failed'; postedTs: string[]; failedIndex: number; error: Error }
  > {
    if (config.ui.fiveBlockPhase < 3) return { ok: false, reason: 'phase-disabled' };

    const allTs: string[] = [];
    let i = 0;
    try {
      for (i = 0; i < chunks.length; i++) {
        const ts = await this.turnSurface.askUserForm(turnId, chunks[i].builtPayload, chunks[i].text, address);
        allTs.push(ts);
        if (i === 0) {
          // SYNCHRONOUS state write after FIRST successful chunk.
          if (!session.actionPanel) {
            session.actionPanel = {
              channelId: session.channelId,
              userId: session.ownerId,
            };
          }
          session.actionPanel.pendingChoice = {
            turnId,
            kind: 'multi',
            choiceTs: ts,
            formIds: [...formIds],
            question: originalQuestion,
            createdAt: Date.now(),
          };
          session.actionPanel.choiceMessageTs = ts;
          session.actionPanel.waitingForChoice = true;
          this.deps.sessionRegistry?.persistAndBroadcast(sessionKey);
        }
      }
    } catch (err) {
      // Partial failure: rollback Slack-side + defensive state clear.
      // Posted chunks are independent messages — roll back in parallel.
      await Promise.allSettled(
        allTs.map((postedTs) =>
          this.deps.slackApi
            .updateMessage(
              address.channelId,
              postedTs,
              FORM_BUILD_FAILED_TEXT,
              buildMarkerBlocks(FORM_BUILD_FAILED_TEXT),
              [],
            )
            .catch((rollbackErr) => {
              this.logger.warn('askUserForm: rollback updateMessage failed', {
                sessionKey,
                postedTs,
                error: (rollbackErr as Error)?.message ?? String(rollbackErr),
              });
            }),
        ),
      );
      // If state was written after chunk 0, clear it.
      if (session.actionPanel?.pendingChoice?.turnId === turnId) {
        this.clearPendingChoiceState(session, sessionKey);
      }
      return {
        ok: false,
        reason: 'post-failed',
        postedTs: allTs,
        failedIndex: i,
        error: err as Error,
      };
    }

    // All chunks posted: fire-and-forget permalink warm for primary.
    this.surface.setChoiceMeta(sessionKey, allTs[0]).catch((err) => {
      this.logger.warn('askUserForm: setChoiceMeta failed', {
        sessionKey,
        turnId,
        error: (err as Error)?.message ?? String(err),
      });
    });

    return { ok: true, primaryTs: allTs[0], allTs, formIds };
  }

  /**
   * P3 (PHASE>=3) — resolve the current single-choice pending record.
   * Reads choiceTs from session state, updates the message in place,
   * then clears pendingChoice and related fields.
   *
   * Returns true on P3 handled; false when PHASE<3 or no pendingChoice
   * present (caller takes legacy path).
   */
  async resolveChoice(
    session: ConversationSession,
    sessionKey: string,
    channelId: string,
    completedText: string,
    completedBlocks: any[],
  ): Promise<boolean> {
    if (config.ui.fiveBlockPhase < 3) return false;
    const pc = session.actionPanel?.pendingChoice;
    if (!pc || pc.kind !== 'single' || !pc.choiceTs) return false;
    await this.turnSurface.resolveChoice(channelId, pc.choiceTs, completedText, completedBlocks);
    this.clearPendingChoiceState(session, sessionKey);
    return true;
  }

  /**
   * P3 (PHASE>=3) — resolve the current multi-choice pending record.
   * Caller passes the ts list (ThreadPanel does NOT own PendingFormStore).
   */
  async resolveMultiChoice(
    session: ConversationSession,
    sessionKey: string,
    channelId: string,
    tsList: string[],
    completedText: string,
    completedBlocks: any[],
  ): Promise<boolean> {
    if (config.ui.fiveBlockPhase < 3) return false;
    const pc = session.actionPanel?.pendingChoice;
    if (!pc || pc.kind !== 'multi') return false;
    await this.turnSurface.resolveMultiChoice(channelId, tsList, completedText, completedBlocks);
    this.clearPendingChoiceState(session, sessionKey);
    return true;
  }

  // ---- internal helpers ----

  /**
   * P3 pendingChoice lifecycle clear — used by resolveChoice, resolveMultiChoice,
   * and the askUserForm partial-failure defensive path. Ensures the whole P3
   * co-field set clears atomically with a single persistAndBroadcast.
   */
  private clearPendingChoiceState(session: ConversationSession, sessionKey: string): void {
    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }
    session.actionPanel.pendingChoice = undefined;
    session.actionPanel.choiceMessageTs = undefined;
    session.actionPanel.choiceMessageLink = undefined;
    session.actionPanel.waitingForChoice = false;
    session.actionPanel.choiceBlocks = undefined;
    this.deps.sessionRegistry?.persistAndBroadcast(sessionKey);
  }

  private findSessionKey(session: ConversationSession): string | undefined {
    const threadTs = session.threadRootTs || session.threadTs;
    if (!threadTs) return undefined;
    return this.deps.claudeHandler.getSessionKey(session.channelId, threadTs);
  }
}
