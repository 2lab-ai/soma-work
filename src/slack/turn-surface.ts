import { config } from '../config';
import { Logger } from '../logger';
import type { SlackApiHelper } from './slack-api-helper';

/**
 * TurnSurface — single-writer for a per-turn streaming surface (Issue #525).
 *
 * P1 scope (SOMA_UI_5BLOCK_PHASE>=1): owns **B1 stream consolidation** only.
 *
 *   begin()      → chat.startStream (opens B1 stream message)
 *   appendText() → chat.appendStream with a markdown_text chunk
 *   end()/fail() → chat.stopStream (chunks-mode symmetry)
 *
 * All other blocks (B2 plan / B3 choice / B4 status / B5 completion) remain
 * on the legacy ThreadSurface path. The corresponding placeholder methods
 * (`renderTasks`, `askUser`) are phase-guarded no-ops in P1 and will be
 * activated in P2/P3.
 *
 * **Chunks-mode invariant** (verified on live Slack, 2026-04-17):
 *   Once `chat.appendStream` is called with `chunks: [...]`, the stream is
 *   locked into chunks mode. `chat.stopStream` MUST also pass `chunks: [...]`
 *   — a top-level `markdown_text` raises `streaming_mode_mismatch`.
 *
 * **Concurrent turn supersede**:
 *   `begin(newTurnId)` on a sessionKey that already has an in-flight turn
 *   first issues `fail(oldTurnId, Error('superseded'))` so the previous
 *   stream closes cleanly before the new one opens. This protects against
 *   rapid user re-submissions and orphaned stream handles.
 *
 * See: docs/slack-ui-phase1.md, docs/slack-ui-phase0.md §Streaming mode
 * invariant, issue #525 §5.1.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal per-turn context needed to address Slack channels/threads.
 * stream-executor builds this once per `execute()` call.
 */
export interface TurnContext {
  /** Slack channel ID (DM `D...`, channel `C...`, group `G...`). */
  channelId: string;
  /**
   * Thread anchor. For bot-initiated sessions this is the workflow root; for
   * user-initiated, the user's first message in the thread. Omit (undefined)
   * only when legitimately posting into DM root — `chat.startStream` treats
   * missing `thread_ts` as "open a new DM stream", which is the intended
   * fallback for phase-0 harness runs.
   */
  threadTs?: string;
  /** Session key (`${channelId}:${threadRootTs ?? threadTs}`). */
  sessionKey: string;
  /** Unique turn id — stream-executor uses `${sessionKey}:${turnStartTs}`. */
  turnId: string;
}

/** Reason handed to `end()` for observability only — not a business signal. */
export type TurnEndReason = 'completed' | 'waiting-for-choice' | 'max_tokens' | 'aborted' | 'superseded' | 'shutdown';

interface TurnState {
  ctx: TurnContext;
  /** ts returned by `chat.startStream` — identifies the B1 stream message. */
  streamTs?: string;
  startedAt: number;
  /** Monotonic counter of appended chunks (debug/observability). */
  appendedChunks: number;
  /** True once `end()` or `fail()` has been entered for this turn. */
  closing: boolean;
}

export interface TurnSurfaceDeps {
  slackApi: SlackApiHelper;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class TurnSurface {
  private logger = new Logger('TurnSurface');

  /** turnId → state. Cleared by `end()`/`fail()` finally blocks. */
  private turns = new Map<string, TurnState>();

  /** sessionKey → active turnId (for supersede on rapid re-entry). */
  private activeTurn = new Map<string, string>();

  constructor(private deps: TurnSurfaceDeps) {}

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Current rollout phase (0..5). Read each call rather than cached, so
   * a mid-session env flip (test-only) takes effect on the next turn.
   */
  private phase(): number {
    return config.ui.fiveBlockPhase;
  }

  // -------------------------------------------------------------------------
  // Public API (plan v2 §3.2)
  // -------------------------------------------------------------------------

  /**
   * Open a new turn. PHASE>=1 calls `chat.startStream`; PHASE=0 is a no-op
   * (legacy path owns the stream through `context.say`).
   *
   * If a prior turn on the same sessionKey is still in-flight, it is
   * superseded first so the previous stream closes cleanly.
   */
  async begin(ctx: TurnContext): Promise<void> {
    if (this.phase() < 1) return;

    // Duplicate begin() on the same turnId is a contract violation from the
    // caller, but we defend so a stray call can't open a second Slack stream
    // and orphan the first handle.
    if (this.turns.has(ctx.turnId)) {
      this.logger.warn('begin() called twice for same turnId — ignored', { turnId: ctx.turnId });
      return;
    }

    // Supersede prior in-flight turn on the same session. Runs to completion
    // before the new stream opens so the user sees a clean close rather than
    // a dangling "typing" indicator.
    const previousTurnId = this.activeTurn.get(ctx.sessionKey);
    if (previousTurnId && previousTurnId !== ctx.turnId) {
      try {
        await this.fail(previousTurnId, new Error('superseded'));
      } catch (err) {
        this.logger.warn('supersede: fail() on prior turn raised', {
          previousTurnId,
          newTurnId: ctx.turnId,
          error: (err as Error).message,
        });
      }
    }

    // Register state before the Slack call so a concurrent supersede on
    // failure still finds a TurnState to clean up.
    this.turns.set(ctx.turnId, {
      ctx,
      startedAt: Date.now(),
      appendedChunks: 0,
      closing: false,
    });
    this.activeTurn.set(ctx.sessionKey, ctx.turnId);

    try {
      const client = this.deps.slackApi.getClient();
      // SDK typing bug: `ChatStartStreamArguments.thread_ts` is marked
      // required but the API accepts DM-root streams without it. Cast to
      // `any` bridges the gap. See ui-test-handler.ts for the same pattern.
      const startArgs: Record<string, unknown> = { channel: ctx.channelId };
      if (ctx.threadTs) {
        startArgs.thread_ts = ctx.threadTs;
      }
      const result: { ts?: string } = await (client.chat as any).startStream(startArgs);
      const state = this.turns.get(ctx.turnId);
      if (!state) {
        // Concurrent supersede cleaned up this turn while startStream was in
        // flight. Slack now holds an open stream handle we've lost track of —
        // close it immediately to avoid a dangling "typing" indicator and a
        // leaked B1 message on the client side.
        if (result?.ts) {
          this.logger.warn('closing orphaned stream from superseded begin()', {
            turnId: ctx.turnId,
            streamTs: result.ts,
          });
          await this.closeOrphanStream(ctx.channelId, result.ts).catch(() => {
            /* already logged by closeOrphanStream */
          });
        }
        return;
      }
      if (result?.ts) {
        state.streamTs = result.ts;
        this.logger.debug('B1 stream opened', { turnId: ctx.turnId, streamTs: result.ts });
      } else {
        this.logger.warn('chat.startStream returned no ts', { turnId: ctx.turnId });
      }
    } catch (err) {
      // Keep the TurnState so later `end()`/`fail()` calls are idempotent.
      // appendText below will no-op (no streamTs), end() will drop the state.
      this.logger.warn('chat.startStream failed', {
        turnId: ctx.turnId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Append a markdown_text chunk to the B1 stream. PHASE>=1 only.
   *
   * Returns `true` when the chunk was sent to Slack (happy path). Returns
   * `false` when the chunk was NOT delivered — callers use this as the
   * "fall back to legacy `context.say`" signal so a transient `startStream`
   * failure doesn't silently eat the assistant's reply.
   *
   * Drops (returns `false`) when:
   *   - PHASE<1 (caller should have taken the legacy path anyway)
   *   - `text` is empty (Slack rejects empty chunks)
   *   - no open stream for this turnId (e.g. startStream failed or still
   *     in flight; chunk will land on the legacy surface instead)
   *   - the turn is already closing (end()/fail() in flight)
   *   - `chat.appendStream` itself raises (Slack error, network)
   */
  async appendText(turnId: string, text: string): Promise<boolean> {
    if (this.phase() < 1) return false;
    if (!text) return false;

    const state = this.turns.get(turnId);
    if (!state || !state.streamTs || state.closing) {
      this.logger.debug('appendText: no open stream', {
        turnId,
        hasState: !!state,
        hasStreamTs: !!state?.streamTs,
        closing: state?.closing,
      });
      return false;
    }

    try {
      const client = this.deps.slackApi.getClient();
      await client.chat.appendStream({
        channel: state.ctx.channelId,
        ts: state.streamTs,
        chunks: [{ type: 'markdown_text', text }],
      });
      state.appendedChunks += 1;
      return true;
    } catch (err) {
      this.logger.warn('chat.appendStream failed', {
        turnId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * B2 (plan block) entry point — activated in P2.
   *
   * In P1 (PHASE<2) this is a no-op: the legacy ThreadSurface keeps rendering
   * the task list embedded in the header/panel message. Callers who target
   * B2 must therefore gate their call behind `config.ui.fiveBlockPhase >= 2`.
   */
  async renderTasks(turnId: string, _todos: unknown[]): Promise<void> {
    if (this.phase() < 2) return;
    // P2 scope: implement via TaskListBlockBuilder → chat.update on the plan
    // message ts tracked in TurnState. Intentionally not implemented in P1
    // to keep the diff contained to B1 behavior.
    this.logger.debug('renderTasks invoked before P2 wiring', { turnId });
  }

  /**
   * B3 (choice block) entry point — activated in P3.
   *
   * In P1 (PHASE<3) this returns immediately; the legacy user-choice-handler
   * flow continues to own B3. Returning an empty string is a deliberate
   * sentinel — P3 will return a selection id.
   */
  async askUser(turnId: string, _payload: unknown): Promise<string> {
    if (this.phase() < 3) return '';
    this.logger.debug('askUser invoked before P3 wiring', { turnId });
    return '';
  }

  /**
   * Close the B1 stream for this turn (PHASE>=1). Idempotent: safe to call
   * multiple times, and safe to call on a turn that never successfully
   * opened a stream.
   */
  async end(turnId: string, reason: TurnEndReason): Promise<void> {
    if (this.phase() < 1) return;

    const state = this.turns.get(turnId);
    // Idempotent: already closing (another end()/fail() in flight) or already
    // closed (state cleaned up) → no-op. Check-and-set is synchronous so
    // concurrent callers cannot both pass this gate.
    if (!state || state.closing) return;

    // Mark closing so a concurrent appendText() call during shutdown is
    // dropped rather than racing with stopStream, and so a concurrent
    // end()/fail() call bounces off the idempotency check above.
    state.closing = true;

    try {
      if (state.streamTs) {
        await this.closeStream(state, 'end', reason);
      }
    } finally {
      this.cleanupTurn(turnId, state);
    }
  }

  /**
   * Defensive close on error. Always runs stopStream (if a stream exists)
   * and always clears turn state, even if Slack rejects the close call.
   *
   * In P1 this does NOT post a B5 completion marker — the legacy
   * TurnNotifier path owns failure notifications through PHASE=4.
   */
  async fail(turnId: string, error: Error): Promise<void> {
    if (this.phase() < 1) return;

    const state = this.turns.get(turnId);
    // Idempotent: already closing (another end()/fail() in flight) or already
    // closed (state cleaned up) → no-op. See end() for the same rationale.
    if (!state || state.closing) return;

    state.closing = true;
    this.logger.debug('turn fail()', { turnId, error: error.message });

    try {
      if (state.streamTs) {
        await this.closeStream(state, 'fail', 'aborted');
      }
    } finally {
      this.cleanupTurn(turnId, state);
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Close a stream whose TurnState was already cleaned up (supersede race).
   * Called from `begin()` when `startStream` resolved after the supersede
   * fail() had already removed the state. `chunks: []` preserves chunks-mode
   * symmetry; no appendStream was ever called for this ts, so it's actually
   * the degenerate "open then immediately close" case.
   */
  private async closeOrphanStream(channelId: string, streamTs: string): Promise<void> {
    try {
      const client = this.deps.slackApi.getClient();
      await (client.chat as any).stopStream({
        channel: channelId,
        ts: streamTs,
        chunks: [],
      });
    } catch (err) {
      this.logger.warn('orphan stopStream failed', {
        streamTs,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Call `chat.stopStream` honoring the chunks-mode invariant.
   * `origin`/`reason` exist only for structured logging on failure.
   */
  private async closeStream(state: TurnState, origin: 'end' | 'fail', reason: TurnEndReason): Promise<void> {
    try {
      const client = this.deps.slackApi.getClient();
      await (client.chat as any).stopStream({
        channel: state.ctx.channelId,
        ts: state.streamTs,
        // Chunks-mode symmetry: an empty chunks array satisfies the close
        // contract without inserting a trailing marker, which would be a
        // B5-responsibility leak (P5 scope).
        chunks: [],
      });
      this.logger.debug('B1 stream closed', {
        turnId: state.ctx.turnId,
        streamTs: state.streamTs,
        origin,
        reason,
        appendedChunks: state.appendedChunks,
        elapsedMs: Date.now() - state.startedAt,
      });
    } catch (err) {
      this.logger.warn('chat.stopStream failed', {
        turnId: state.ctx.turnId,
        origin,
        reason,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Remove the turn from both maps. Guards against the race where a
   * supersede-triggered fail() runs concurrently with the primary end().
   */
  private cleanupTurn(turnId: string, state: TurnState): void {
    this.turns.delete(turnId);
    if (this.activeTurn.get(state.ctx.sessionKey) === turnId) {
      this.activeTurn.delete(state.ctx.sessionKey);
    }
  }

  // -------------------------------------------------------------------------
  // Test-only helpers (not part of the public contract)
  // -------------------------------------------------------------------------

  /** @internal — visibility for unit tests; do not call from production code. */
  _hasActiveTurn(sessionKey: string): boolean {
    return this.activeTurn.has(sessionKey);
  }

  /** @internal — visibility for unit tests; do not call from production code. */
  _getActiveTurnId(sessionKey: string): string | undefined {
    return this.activeTurn.get(sessionKey);
  }

  /** @internal — visibility for unit tests; do not call from production code. */
  _getTurnStateSnapshot(
    turnId: string,
  ): { streamTs: string | undefined; appendedChunks: number; closing: boolean } | undefined {
    const state = this.turns.get(turnId);
    if (!state) return undefined;
    return {
      streamTs: state.streamTs,
      appendedChunks: state.appendedChunks,
      closing: state.closing,
    };
  }
}
