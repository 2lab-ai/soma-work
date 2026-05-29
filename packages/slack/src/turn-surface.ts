import { Logger } from '@soma/common/logger';
import type { AssistantStatusManager } from './assistant-status-manager';
import type { SlackApiHelper } from './slack-api-helper';
import { TaskListBlockBuilder, type Todo } from './task-list-block-builder';
import type { TurnCompletionEvent } from './turn-notifier';
import { TurnRenderDebouncer } from './turn-render-debouncer';

/**
 * TurnSurface — single-writer for a per-turn streaming surface (Issue #525).
 *
 * Owns the per-turn Slack stream and auxiliary turn-surface blocks.
 *
 *   begin()      → chat.startStream (opens B1 stream message)
 *   appendText() → chat.appendStream with a markdown_text chunk
 *   end()/fail() → chat.stopStream (chunks-mode symmetry)
 *
 * **Chunks-mode invariant**:
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
 * See: docs/archive/features/slack-ui/phase1.md, docs/archive/features/slack-ui/phase0.md §Streaming mode
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
  readonly channelId: string;
  /**
   * Thread anchor. For bot-initiated sessions this is the workflow root; for
   * user-initiated, the user's first message in the thread. Omit (undefined)
   * only when legitimately posting into DM root — `chat.startStream` treats
   * missing `thread_ts` as "open a new DM stream", which is the intended
   * fallback for phase-0 harness runs.
   */
  readonly threadTs?: string;
  /** Session key (`${channelId}:${threadRootTs ?? threadTs}`). */
  readonly sessionKey: string;
  /** Unique turn id — stream-executor uses `${sessionKey}:${turnStartTs}`. */
  readonly turnId: string;
  /**
   * Recipient user id for `chat.startStream`. Slack rejects channel/thread
   * streaming with `missing_recipient_team_id` when this is absent (the API
   * requires both `recipient_user_id` AND `recipient_team_id` for
   * non-assistant-thread streams). Source: the originating message event
   * (`event.user`). Optional only so unit tests / pre-P1 paths can omit it
   * — production turns built by stream-executor MUST set it.
   */
  readonly recipientUserId?: string;
  /**
   * Recipient team id for `chat.startStream`. Same contract as
   * `recipientUserId` — both must be present together; an assistant-thread
   * stream is the only Slack scenario where they're optional, and we don't
   * use that path. Source: the originating message event (`event.team`).
   */
  readonly recipientTeamId?: string;
  /**
   * Issue #688 — per-turn AssistantStatusManager epoch captured by the
   * caller via `bumpEpoch(channel, threadTs)`. When present, TurnSurface's
   * end()/fail() pass it as `expectedEpoch` to `clearStatus` so a stale
   * close from a superseded turn cannot wipe the spinner set by the
   * newer turn on the same (channel, threadTs). Optional so existing
   * callers/tests that don't drive native status writes are unchanged.
   */
  readonly statusEpoch?: number;
  /**
   * P5 snapshot accessor for the B5 `WorkflowComplete` marker.
   *
   * Returns the **same Promise** on every invocation — a `snapshotPromise`
   * built once by `stream-executor` alongside the matching `resolveSnapshot`.
   * The success path resolves with the enriched `TurnCompletionEvent`; the
   * `.catch` rail (and every non-complete path) resolves with `undefined`
   * so `end()` posts nothing.
   *
   * MUST be awaited — a sync read races `stopStream` vs enrichment HTTP and
   * silently drops B5 (issue #720). See `docs/archive/features/slack-ui/phase5.md` §"Race
   * fix (#720)" for the full rationale.
   */
  readonly buildCompletionEvent?: () => Promise<TurnCompletionEvent | undefined>;
}

/**
 * Address-only slice of `TurnContext` (no turnId). Used by callers that drive
 * a render BEFORE a turn exists (e.g. `renderTasks` without a prior `begin`).
 */
export type TurnAddress = Omit<TurnContext, 'turnId'>;

/**
 * Reason handed to `end()` for observability only — not a business signal.
 * P1 wires exactly two values from stream-executor: `'completed'` (success path,
 * finally block) and `'aborted'` (catch path, non-error abort). Supersede goes
 * through `fail()` with `new Error('superseded')` rather than `end()`, so
 * 'superseded' is an Error message — not a TurnEndReason value. Later phases
 * will widen this union if they wire additional reasons.
 */
export type TurnEndReason = 'completed' | 'aborted';

/**
 * Result of {@link TurnSurface.end}.
 *
 * Turn-end surface guarantee §C-2: when `reason === 'completed'` and the
 * B5 capability is active, `end()` awaits the snapshot Promise inside a
 * 3s race. If the snapshot fails to resolve in time, the B5 emit is
 * skipped — but the caller (`StreamExecutor`) needs to know so it can
 * post a fallback `turnNotifier.notify()` with the originally-computed
 * category. Without this signal the turn ends with NO terminal card on
 * any channel.
 *
 * For non-completed reasons (`'aborted'`) or when B5 capability is
 * inactive, this returns `{ snapshotResolved: true }` — there is no
 * expected snapshot, so the caller should NOT post a fallback. Trace:
 * `docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md` §C-2.
 */
export interface TurnEndResult {
  /** True when no B5 fallback is needed (snapshot landed, or B5 wasn't expected). */
  snapshotResolved: boolean;
}

interface TurnState {
  ctx: TurnContext;
  /** ts returned by `chat.startStream` — identifies the B1 stream message. */
  streamTs?: string;
  /**
   * ts returned by the first `chat.postMessage` in `renderTasks` — identifies
   * the B2 plan message. Once set, subsequent renderTasks calls use
   * `chat.update` against this ts instead of posting a new message.
   *
   * Intentionally NOT cleared on end/fail/supersede: the plan message is
   * persistent Slack history, so closing a turn must leave the final
   * rendered plan visible to the user. Ad-hoc state entries (created by
   * renderTasks without a prior begin()) also use this field.
   */
  planTs?: string;
  /**
   * Latest todos snapshot handed to `renderTasks` for this turn. Used by
   * `end()`/`fail()` to issue one last `chat.update` against `planTs` with
   * `{ final: true }` — demoting any lingering `in_progress` task_cards to
   * `pending` so the Slack-native loading indicator stops spinning after
   * the turn has actually ended. Without this snapshot, an LLM that finishes
   * a turn while leaving a todo in `in_progress` produces a persistent "hang
   * state" — the planTs message looks like the bot is still working forever.
   */
  latestTodos?: Todo[];
  /**
   * P3 single-choice ts. Set by askUser() on successful post. NON-AUTHORITATIVE
   * (the source of truth is session.actionPanel.pendingChoice.choiceTs, written
   * by ThreadPanel). Here purely for per-turn debug/observability.
   */
  choiceTs?: string;
  /**
   * P3 multi-choice form ts list. Populated by askUserForm() per chunk.
   * Same observability-only semantics as choiceTs.
   */
  formTsList: string[];
  startedAt: number;
  /** Monotonic counter of appended chunks (debug/observability). */
  appendedChunks: number;
  /** True once `end()` or `fail()` has been entered for this turn. */
  closing: boolean;
}

/**
 * Extract Slack error code (`streaming_mode_mismatch`, `channel_not_found`,
 * rate-limit, etc.) plus the message from whatever shape the SDK threw. The
 * rollout plan wants these distinguishable in logs — a bare `catch {}` erases
 * the very signal operators need.
 */
function describeSlackError(error: unknown): { code?: string; message: string } {
  const err = error as { data?: { error?: string }; code?: string; message?: string };
  const code = err?.data?.error ?? err?.code;
  const message = err?.message ?? String(error);
  return code ? { code, message } : { message };
}

export interface TurnSurfaceDeps {
  slackApi: SlackApiHelper;
  /**
   * #689 P4 Part 2/2 — TurnSurface is the sole native-status writer at
   * effective PHASE>=4. Optional so existing tests that construct
   * `TurnSurface` without this dep keep working (legacy behaviour: no
   * spinner writes even if PHASE=4 — ThreadSurface chip owns the UX).
   */
  assistantStatusManager?: AssistantStatusManager;
  /** P5 B5 marker sink. Undefined → emit path no-ops (tests / PHASE<5). */
  slackBlockKitChannel?: { send(event: TurnCompletionEvent): Promise<void> };
  /**
   * P5 capability gate. Passed as a closure (not a ThreadPanel ref) to break
   * the circular import ThreadPanel → TurnSurface → ThreadPanel.
   */
  isCompletionMarkerActive?: () => boolean;
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

  /** 500ms trailing-edge debouncer per turnId (coalesces rapid renderTasks). */
  private renderDebouncer = new TurnRenderDebouncer<string>(500);

  constructor(private deps: TurnSurfaceDeps) {}

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

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
      formTsList: [],
    });
    this.activeTurn.set(ctx.sessionKey, ctx.turnId);

    try {
      const client = this.deps.slackApi.getClient();
      // SDK typing bug: `ChatStartStreamArguments.thread_ts` is marked
      // required but the API accepts DM-root streams without it. Cast to
      // `any` bridges the gap. See ui-test-handler.ts for the same pattern.
      //
      // `recipient_user_id` + `recipient_team_id` are REQUIRED for channel
      // and thread streaming (only assistant-thread streams may omit them,
      // and we don't take that path). Without both, Slack returns
      // `missing_recipient_team_id` and the stream is silently lost. We
      // only attach them when BOTH are present — passing one alone is
      // worse than passing neither (the API treats partial fields as a
      // shape mismatch rather than falling back to assistant-thread mode).
      const startArgs: Record<string, unknown> = { channel: ctx.channelId };
      if (ctx.threadTs) {
        startArgs.thread_ts = ctx.threadTs;
      }
      if (ctx.recipientUserId && ctx.recipientTeamId) {
        startArgs.recipient_user_id = ctx.recipientUserId;
        startArgs.recipient_team_id = ctx.recipientTeamId;
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

    // #689 P4 Part 2/2 — B4 native spinner start. Only fires at effective
    // PHASE>=4 (raw>=4 AND assistantStatusManager.isEnabled()). Runtime
    // scope failure flips `enabled=false` → effective clamp to 3 on the
    // next turn, falling back to ThreadSurface chip.
    const mgr = this.deps.assistantStatusManager;
    if (mgr && ctx.threadTs) {
      // Fail-open matching `chat.startStream` above: the B1 stream + turn
      // lifecycle must survive a sidebar-spinner throw. The manager handles
      // expected permanent/transient codes internally, so this try/catch
      // only shields against unexpected throws.
      try {
        await mgr.setStatus(ctx.channelId, ctx.threadTs, 'is thinking...');
      } catch (err) {
        this.logger.warn('B4 native spinner setStatus failed in begin()', {
          turnId: ctx.turnId,
          error: (err as Error).message,
        });
      }
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
    // Reject whitespace-only chunks (matches `handleTextMessage`'s own
    // `!text.trim()` guard at stream-processor.ts) so stray newlines /
    // indentation fragments don't get billed as chunks or rendered as
    // empty blobs in the B1 stream.
    if (!text || !text.trim()) return false;

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
   * B2 plan block entry point — schedules a trailing-edge (500ms) rerender
   * of the task list on the plan message owned by this turn. Each call
   * replaces the pending snapshot, so rapid TodoWrite ticks collapse into a
   * single Slack update.
   *
   * Flow:
   *   1. First call on a turn → `chat.postMessage` stores `planTs` on state.
   *   2. Subsequent calls → `chat.update` against `planTs`.
   *   3. `ctx` is only consulted when no existing turn state is found (ad-hoc
   *      path, e.g. renderTasks called before begin()). It seeds a state
   *      entry with streamTs=undefined so end/fail skip `stopStream`, and is
   *      NOT registered in `activeTurn` (never supersedes another turn).
   *
   * Returns `true` when the render was scheduled (caller's "we owned the
   * render" signal). Returns `false` when we fell through to the legacy path
   * — PHASE<2, empty todos, or missing context.
   */
  async renderTasks(turnId: string, todos: Todo[], ctx?: TurnAddress): Promise<boolean> {
    if (!todos || todos.length === 0) return false;

    let state = this.turns.get(turnId);
    if (!state) {
      if (!ctx) {
        // Ad-hoc renderTasks call with no prior begin() and no context — we
        // cannot address a Slack channel, so fall through to the legacy path.
        this.logger.warn('renderTasks called without ctx and no existing turn', { turnId });
        return false;
      }
      state = {
        ctx: { ...ctx, turnId },
        startedAt: Date.now(),
        appendedChunks: 0,
        closing: false,
        formTsList: [],
      };
      this.turns.set(turnId, state);
    }

    if (state.closing) {
      // Turn already shutting down — drop the render rather than flushing
      // onto a just-cleaned-up state.
      return false;
    }

    // Capture the freshest todos snapshot synchronously, BEFORE scheduling
    // the debouncer. end()/fail() rely on `state.latestTodos` to issue a
    // terminal `{ final: true }` render — if a turn ends mid-debounce
    // (rapid TodoWrite → end), the latest snapshot must still be available
    // for finalization even if the debouncer's render never fires.
    state.latestTodos = todos;

    // Schedule a trailing render. Each call replaces the closure so the
    // LATEST todos snapshot wins (matches TodoWrite's full-snapshot contract).
    this.renderDebouncer.schedule(turnId, async () => {
      await this.renderTasksNow(turnId, todos);
    });
    return true;
  }

  /**
   * Fire the actual `chat.postMessage` (first call) or `chat.update`
   * (subsequent) against the plan message ts. Called by the debouncer's
   * tail trigger.
   *
   * Deliberately does NOT short-circuit on `state.closing`: end() / fail()
   * flush the debouncer while `closing=true` so the final plan state lands
   * on Slack before cleanup. The cleanupTurn() handler cancels the
   * debouncer, so any later trigger that fires after cleanup finds
   * `state === undefined` below and skips on its own.
   *
   * `final` is the end-of-turn finalize signal — when true, the builder
   * demotes any `in_progress` task_cards to `pending` so the persistent
   * `planTs` message stops showing a Slack-native loading indicator.
   */
  private async renderTasksNow(turnId: string, todos: Todo[], final = false): Promise<void> {
    const state = this.turns.get(turnId);
    if (!state) return;
    const { text, blocks } = TaskListBlockBuilder.buildPlanTasks(todos, { final });
    if (blocks.length === 0) return;

    const client = this.deps.slackApi.getClient();

    if (!state.planTs) {
      try {
        const postArgs: Record<string, unknown> = {
          channel: state.ctx.channelId,
          text,
          blocks,
        };
        if (state.ctx.threadTs) postArgs.thread_ts = state.ctx.threadTs;
        const result: { ts?: string } = await (client.chat as any).postMessage(postArgs);
        if (result?.ts) {
          state.planTs = result.ts;
          this.logger.debug('B2 plan message posted', { turnId, planTs: result.ts });
        } else {
          this.logger.warn('chat.postMessage returned no ts', { turnId });
        }
      } catch (err) {
        this.logger.warn('chat.postMessage for plan block failed', {
          turnId,
          error: (err as Error).message,
        });
        // #1005 — guaranteed plain-text fallback. When Slack rejects the Block
        // Kit payload (e.g. `invalid_blocks`), still deliver the plan as plain
        // text instead of silently dropping the card (~525 lost plan cards /
        // rotation in dev). Mirrors StreamProcessor's sayWithBlockKit fallback
        // for the streaming surface.
        try {
          const fallbackArgs: Record<string, unknown> = { channel: state.ctx.channelId, text };
          if (state.ctx.threadTs) fallbackArgs.thread_ts = state.ctx.threadTs;
          const fb: { ts?: string } = await (client.chat as any).postMessage(fallbackArgs);
          if (fb?.ts) state.planTs = fb.ts;
        } catch (fallbackErr) {
          this.logger.warn('chat.postMessage plan-block plain-text fallback also failed', {
            turnId,
            error: (fallbackErr as Error).message,
          });
        }
      }
      return;
    }

    try {
      await (client.chat as any).update({
        channel: state.ctx.channelId,
        ts: state.planTs,
        text,
        blocks,
      });
      this.logger.debug('B2 plan message updated', { turnId, planTs: state.planTs });
    } catch (err) {
      this.logger.warn('chat.update for plan block failed', {
        turnId,
        planTs: state.planTs,
        error: (err as Error).message,
      });
      // #1005 — plain-text fallback (see the postMessage path above): on a
      // Block Kit rejection, update the existing message with text only so the
      // plan content is not lost.
      try {
        await (client.chat as any).update({ channel: state.ctx.channelId, ts: state.planTs, text });
      } catch (fallbackErr) {
        this.logger.warn('chat.update plan-block plain-text fallback also failed', {
          turnId,
          planTs: state.planTs,
          error: (fallbackErr as Error).message,
        });
      }
    }
  }

  /**
   * B3 (single choice) post — PHASE>=3. Posts a pre-built single-choice
   * payload as a fresh `chat.postMessage`. Returns the message ts so the
   * caller (ThreadPanel) can synchronously write it into session state.
   *
   * TurnSurface stays writer-only: it does NOT touch session state,
   * pending-choice records, or permalinks. Those are ThreadPanel's job.
   *
   * PHASE<3: returns empty string (sentinel, caller falls back to legacy).
   * Failure: throws (caller's try/catch handles rollback).
   *
   * `address` is required because the turn may have already ended by post
   * time; `turnId` is observability-only (looked up in `this.turns` to
   * stamp `state.choiceTs` on success; missing turnState is tolerated).
   */
  async askUser(
    turnId: string,
    builtPayload: { blocks?: any[]; attachments?: any[] },
    text: string,
    address: TurnAddress,
  ): Promise<string> {
    const client = this.deps.slackApi.getClient();
    const postArgs: Record<string, unknown> = {
      channel: address.channelId,
      text,
      ...builtPayload,
    };
    if (address.threadTs) postArgs.thread_ts = address.threadTs;
    const result: { ts?: string } = await (client.chat as any).postMessage(postArgs);
    if (!result?.ts) {
      throw new Error('chat.postMessage returned no ts');
    }
    const state = this.turns.get(turnId);
    if (state) state.choiceTs = result.ts;
    this.logger.debug('B3 single-choice message posted', {
      turnId,
      choiceTs: result.ts,
    });
    return result.ts;
  }

  /**
   * B3 (multi-choice chunk) post — PHASE>=3. Posts ONE chunk of a multi-
   * choice form. Caller (ThreadPanel) loops this per chunk.
   *
   * Returns the chunk's message ts. Throws on failure — caller rolls back
   * posted chunks.
   */
  async askUserForm(
    turnId: string,
    builtPayload: { blocks?: any[]; attachments?: any[] },
    text: string,
    address: TurnAddress,
  ): Promise<string> {
    const client = this.deps.slackApi.getClient();
    const postArgs: Record<string, unknown> = {
      channel: address.channelId,
      text,
      ...builtPayload,
    };
    if (address.threadTs) postArgs.thread_ts = address.threadTs;
    const result: { ts?: string } = await (client.chat as any).postMessage(postArgs);
    if (!result?.ts) {
      throw new Error('chat.postMessage returned no ts');
    }
    const state = this.turns.get(turnId);
    if (state) state.formTsList.push(result.ts);
    this.logger.debug('B3 multi-choice chunk posted', {
      turnId,
      formTs: result.ts,
      chunkCount: state?.formTsList.length,
    });
    return result.ts;
  }

  /**
   * B3 in-place resolve — PHASE>=3. Updates the single choice message with
   * the "✅ 선택: …" completed blocks. Idempotent — swallow
   * `message_not_found` (user or cleanup may have deleted the message).
   */
  async resolveChoice(
    channelId: string,
    choiceTs: string,
    completedText: string,
    completedBlocks: any[],
  ): Promise<void> {
    try {
      await this.deps.slackApi.updateMessage(channelId, choiceTs, completedText, completedBlocks, []);
      this.logger.debug('B3 single-choice resolved', { channelId, choiceTs });
    } catch (err) {
      const described = describeSlackError(err);
      if (described.code === 'message_not_found') {
        this.logger.debug('B3 resolveChoice: message already gone (idempotent)', {
          channelId,
          choiceTs,
        });
        return;
      }
      this.logger.warn('B3 resolveChoice: updateMessage failed', {
        channelId,
        choiceTs,
        error: described,
      });
      throw err;
    }
  }

  /**
   * B3 multi-choice in-place resolve — iterates per-chunk ts update.
   * Best-effort per chunk: a single chunk failure logs but does not abort
   * the remaining updates (user already saw the click feedback; best to
   * finish as many chunks as possible).
   */
  async resolveMultiChoice(
    channelId: string,
    tsList: string[],
    completedText: string,
    completedBlocks: any[],
  ): Promise<void> {
    // Chunks are independent Slack messages — update in parallel so the user
    // sees all resolves at roughly the same wall clock. Individual failures
    // are logged but don't fail siblings.
    await Promise.allSettled(
      tsList.map(async (ts) => {
        try {
          await this.deps.slackApi.updateMessage(channelId, ts, completedText, completedBlocks, []);
          this.logger.debug('B3 multi-choice chunk resolved', { channelId, ts });
        } catch (err) {
          const described = describeSlackError(err);
          if (described.code === 'message_not_found') return;
          this.logger.warn('B3 resolveMultiChoice: updateMessage failed', {
            channelId,
            ts,
            error: described,
          });
        }
      }),
    );
  }

  /**
   * Close the B1 stream for this turn (PHASE>=1). Idempotent: safe to call
   * multiple times, and safe to call on a turn that never successfully
   * opened a stream.
   */
  async end(turnId: string, reason: TurnEndReason): Promise<TurnEndResult> {
    const state = this.turns.get(turnId);
    // Idempotent: already closing (another end()/fail() in flight) or already
    // closed (state cleaned up) → no-op. Check-and-set is synchronous so
    // concurrent callers cannot both pass this gate.
    if (!state || state.closing) return { snapshotResolved: true };

    // Mark closing synchronously FIRST so a concurrent appendText() call
    // during the debouncer flush / stopStream await is dropped rather than
    // racing. Any scheduled B2 render still runs during flush — renderTasksNow
    // deliberately does not short-circuit on `closing` so the final plan
    // state can be landed on Slack before cleanup.
    state.closing = true;

    // Drain any pending B2 render so the final plan state lands on Slack
    // before we drop the TurnState. Debouncer's internal catch handles fn
    // errors — no need to wrap here.
    await this.renderDebouncer.flush(turnId);

    // Demote any lingering `in_progress` task_cards to `pending` BEFORE we
    // drop the TurnState. Slack natively renders `task_card.status='in_progress'`
    // with a loading indicator; without this step, an LLM that ends a turn
    // without marking its todo as completed leaves a persistent "still
    // working" spinner on the planTs message (the user-reported hang state).
    await this.finalizePlanIfNeeded(turnId, state);

    // Turn-end surface guarantee §C-2: track whether the snapshot landed
    // so we can return it to the caller after `finally` runs cleanup.
    // Declared in the outer scope (not inside finally) so a `return`
    // statement at the end can read it without nesting return-in-finally
    // (which would swallow any throw from the try block).
    let snapshotResolved = true;

    try {
      if (state.streamTs) {
        await this.closeStream(state, 'end', reason);
      }
    } catch (closeErr) {
      // Codex review [2b]: pre-fix this throw skipped the `return { snapshotResolved }`
      // at the bottom of `end()` — the caller's outer try/catch then collapsed
      // the missed return into a `{ snapshotResolved: true }` default,
      // silently suppressing the §C-2 fallback notify. Log and continue
      // so the finally B5 logic + `return` still run; the caller can
      // observe `snapshotResolved` correctly even if `closeStream` failed.
      this.logger.warn('TurnSurface.end: closeStream threw — continuing to B5 + cleanup', {
        turnId,
        error: (closeErr as Error)?.message ?? String(closeErr),
      });
    } finally {
      // #689 P4 Part 2/2 — B4 native spinner clear. Wrapped: although
      // `clearStatus` swallows its own Slack errors, but the epoch/
      // `clearInterval` path can still throw. A throw here
      // must NEVER skip `cleanupTurn` — orphaning `this.turns` would make
      // the next turn hit the `begin()` called-twice guard and drop silently.
      // #688 — pass `statusEpoch` so a stale close from a superseded turn
      // cannot wipe a spinner set by the newer turn on the same thread.
      try {
        const mgr = this.deps.assistantStatusManager;
        if (mgr && state.ctx.threadTs) {
          const opts = state.ctx.statusEpoch !== undefined ? { expectedEpoch: state.ctx.statusEpoch } : undefined;
          await mgr.clearStatus(state.ctx.channelId, state.ctx.threadTs, opts);
        }
      } catch (err) {
        this.logger.warn('B4 native spinner clear in end() threw — cleanup continues', {
          turnId,
          error: (err as Error)?.message ?? String(err),
        });
      }

      // B5 completion marker — success path only. The accessor returns a
      // Promise (`snapshotPromise` owned by stream-executor), so we MUST
      // await it or we'd silently drop B5. A 3s timeout caps the wait so a
      // stuck enrichment can never hang `end()` indefinitely; the snapshot
      // Promise itself is resolved with `undefined` on stream-executor's
      // `.catch` rail, and the explicit timeout is a defence-in-depth net.
      //
      // Ordering: after B4 clearStatus (which was already awaited above).
      // The `send(evt)` call is detached (void + `.catch`) so Slack RTT
      // doesn't extend `end()`'s hot path — only the snapshot wait is
      // synchronous with close.
      const capActive =
        typeof this.deps.isCompletionMarkerActive === 'function' ? this.deps.isCompletionMarkerActive() : false;

      // Turn-end surface guarantee §C-2: the outer `snapshotResolved` flag
      // (declared before the try block) stays `true` when `reason !==
      // 'completed'` OR B5 is inactive — no snapshot is expected so the
      // caller MUST NOT post a fallback. When B5 IS expected but the race
      // hits the timeout (or the builder throws), the block below flips
      // it to `false` and lets StreamExecutor decide whether to fall back
      // through `turnNotifier.notify`.
      if (reason === 'completed' && capActive && state.ctx.buildCompletionEvent && this.deps.slackBlockKitChannel) {
        let evt: TurnCompletionEvent | undefined;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        // True once a B5-specific warn has fired so the `else` fallback
        // below doesn't emit a second warn for the same event (avoids
        // double-logging the sync-throw path).
        let warnEmitted = false;
        const TIMEOUT_MS = 3000;
        try {
          const builderPromise = Promise.resolve(state.ctx.buildCompletionEvent());
          const timeoutPromise = new Promise<undefined>((resolve) => {
            timeoutId = setTimeout(() => resolve(undefined), TIMEOUT_MS);
          });
          // Log-and-swallow a late rejection from the builder (codex P2 —
          // late-rejection hygiene): Promise.race settles on whichever side
          // lands first; the loser's eventual rejection would surface as an
          // unhandled rejection if we didn't attach a catch. We log a
          // breadcrumb rather than silently swallowing — if enrichment is
          // chronically failing but mostly winning the race, operators still
          // see the signal instead of the B5 silently posting fine today
          // until the timing shifts tomorrow.
          builderPromise.catch((err) => {
            this.logger.warn('B5 builder late-rejection after race settled', {
              turnId,
              error: (err as Error)?.message ?? String(err),
            });
          });
          evt = await Promise.race<TurnCompletionEvent | undefined>([builderPromise, timeoutPromise]);
        } catch (err) {
          this.logger.warn('B5 buildCompletionEvent threw synchronously', {
            turnId,
            error: (err as Error)?.message ?? String(err),
          });
          evt = undefined;
          warnEmitted = true;
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }

        // Codex review [6c]: explicit `!== undefined` so a future
        // falsy-but-valid event shape doesn't get collapsed into the
        // "snapshot unavailable" branch.
        if (evt !== undefined) {
          // send() fire-and-forget with structured-error logging. Operators
          // triaging B5 drops need the Slack error code (`rate_limited`,
          // `channel_not_found`, `streaming_mode_mismatch`, etc.) plus the
          // channel/thread IDs — bare `err.message` alone collapses distinct
          // failure modes into the same log line.
          void this.deps.slackBlockKitChannel.send(evt).catch((err) => {
            this.logger.warn('B5 send failed', {
              turnId,
              channelId: state.ctx.channelId,
              threadTs: state.ctx.threadTs,
              error: describeSlackError(err),
            });
          });
        } else {
          // §C-2: the snapshot did not land. Mark unresolved so the caller
          // can post a fallback `turnNotifier.notify()` — without this
          // signal the turn would end with NO terminal card on any channel.
          snapshotResolved = false;

          if (!warnEmitted) {
            // Distinguish timeout / undefined-snapshot from the explicit
            // `reason !== 'completed'` skip — operators need this signal to
            // diagnose enrichment regressions (issue #720's symptom was
            // silent B5 drop with no log breadcrumb). Skipped when the
            // sync-throw catch already logged, so one event → one warn.
            this.logger.warn('B5 snapshot unavailable — completion marker not emitted', {
              turnId,
            });
          }
        }
      }

      this.cleanupTurn(turnId, state);
    }

    return { snapshotResolved };
  }

  /**
   * Defensive close on error. Always runs stopStream (if a stream exists)
   * and always clears turn state, even if Slack rejects the close call.
   *
   * In P1 this does NOT post a B5 completion marker — the legacy
   * TurnNotifier path owns failure notifications through PHASE=4.
   */
  async fail(turnId: string, error: Error): Promise<void> {
    const state = this.turns.get(turnId);
    // Idempotent: already closing (another end()/fail() in flight) or already
    // closed (state cleaned up) → no-op. See end() for the same rationale.
    if (!state || state.closing) return;

    // Set closing FIRST (same race-avoidance as end()), THEN drain the B2
    // debouncer so the final plan state lands on Slack before we drop the
    // TurnState. Supersede (begin()→fail(A)) drives this path most often.
    state.closing = true;
    await this.renderDebouncer.flush(turnId);

    this.logger.debug('turn fail()', { turnId, error: error.message });

    // Same finalize step as end() — kills the persistent `in_progress`
    // spinner on the planTs message. Critical for supersede: when a new
    // turn replaces an in-flight one, the prior turn's plan must stop
    // looking like it's still working before the user's eyes.
    await this.finalizePlanIfNeeded(turnId, state);

    try {
      if (state.streamTs) {
        await this.closeStream(state, 'fail', 'aborted');
      }
    } finally {
      // #689 P4 Part 2/2 + #688 — same B4 clear + epoch guard as end().
      // Wrapped for the same reason: a throw must never skip `cleanupTurn`.
      try {
        const mgr = this.deps.assistantStatusManager;
        if (mgr && state.ctx.threadTs) {
          const opts = state.ctx.statusEpoch !== undefined ? { expectedEpoch: state.ctx.statusEpoch } : undefined;
          await mgr.clearStatus(state.ctx.channelId, state.ctx.threadTs, opts);
        }
      } catch (err) {
        this.logger.warn('B4 native spinner clear in fail() threw — cleanup continues', {
          turnId,
          error: (err as Error)?.message ?? String(err),
        });
      }
      this.cleanupTurn(turnId, state);
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Raw `chat.stopStream` with chunks-mode symmetry. Returns a discriminated
   * result so callers can log the Slack error code (`streaming_mode_mismatch`,
   * `channel_not_found`, rate limits, etc.) — operators need this to diagnose
   * stream-close failures that the rollout plan (docs/archive/features/slack-ui/phase1.md
   * §Monitoring) explicitly expects to track.
   *
   * Chunks-mode symmetry: an empty chunks array closes without inserting a
   * trailing marker, which would be a B5-responsibility leak (P5 scope).
   * The `as any` bridges the same SDK typing gap documented on startStream
   * in `begin()` above.
   */
  private async stopStreamRaw(
    channelId: string,
    streamTs: string,
  ): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const client = this.deps.slackApi.getClient();
      await (client.chat as any).stopStream({
        channel: channelId,
        ts: streamTs,
        chunks: [],
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * Close a stream whose TurnState was already cleaned up (supersede race).
   * Called from `begin()` when `startStream` resolved after the supersede
   * fail() had already removed the state — open-then-immediately-close.
   */
  private async closeOrphanStream(channelId: string, streamTs: string): Promise<void> {
    const result = await this.stopStreamRaw(channelId, streamTs);
    if (!result.ok) {
      this.logger.warn('orphan stopStream failed', {
        streamTs,
        error: describeSlackError(result.error),
      });
    }
  }

  /**
   * Demote any lingering `in_progress` task_cards on the B2 plan message to
   * `pending`. Called from `end()`/`fail()` AFTER the debouncer flush (so
   * `latestTodos` is authoritative) but BEFORE `closeStream` / cleanup (so a
   * throw cannot skip the demotion).
   *
   * Short-circuits when there's nothing to fix:
   *   - no `planTs` → no message to update (also ensures the delegated
   *     `renderTasksNow` stays on the `chat.update` branch and never falls
   *     back to a stray `chat.postMessage` from this close-path call site)
   *   - no `latestTodos` → state never captured a snapshot
   *   - no `in_progress` todos → live render already showed a terminal
   *     state; an extra Slack call would just burn rate budget without
   *     changing the visible message
   *
   * The actual `chat.update` is delegated to `renderTasksNow(..., true)` so
   * blocks/text/error-logging stay in one place. `renderTasksNow` swallows
   * Slack errors at `warn`, matching the existing fail-open contract for
   * the close path.
   */
  private async finalizePlanIfNeeded(turnId: string, state: TurnState): Promise<void> {
    if (!state.planTs || !state.latestTodos || state.latestTodos.length === 0) return;
    // `in_progress` is the only status Slack renders with a spinner — pending,
    // blocked (rendered as pending), completed and error are all static. So
    // we only pay a chat.update when there's actually a stuck spinner to kill.
    if (!state.latestTodos.some((t) => t.status === 'in_progress')) return;

    await this.renderTasksNow(turnId, state.latestTodos, true);
  }

  /**
   * Close a known-turn stream with full structured logging. Callers must
   * only invoke when `state.streamTs` is set (see `end()`/`fail()` guards).
   * `origin`/`reason` exist only for observability.
   */
  private async closeStream(state: TurnState, origin: 'end' | 'fail', reason: TurnEndReason): Promise<void> {
    if (!state.streamTs) return;
    const result = await this.stopStreamRaw(state.ctx.channelId, state.streamTs);
    if (result.ok) {
      this.logger.debug('B1 stream closed', {
        turnId: state.ctx.turnId,
        streamTs: state.streamTs,
        origin,
        reason,
        appendedChunks: state.appendedChunks,
        elapsedMs: Date.now() - state.startedAt,
      });
    } else {
      // State is cleared after we return (see end()/fail() finally blocks).
      // That trades retryability for memory-leak prevention — but the trade
      // means an operator can ONLY chase the leaked stream via these fields.
      // Keep channel + streamTs + Slack error code in the warn payload so
      // `streaming_mode_mismatch` (rollout monitor §3) stays diagnosable.
      this.logger.warn('chat.stopStream failed', {
        turnId: state.ctx.turnId,
        channelId: state.ctx.channelId,
        streamTs: state.streamTs,
        origin,
        reason,
        error: describeSlackError(result.error),
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
    // Drop any future-scheduled renders for this turn; the plan message in
    // Slack (planTs) is deliberately left intact — history preserves the
    // final state even after the turn closes.
    this.renderDebouncer.cancel(turnId);
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

  /** @internal — visibility for unit tests; do not call from production code. */
  _getChoiceTs(turnId: string): string | undefined {
    return this.turns.get(turnId)?.choiceTs;
  }

  /** @internal — visibility for unit tests; do not call from production code. */
  _getFormTsList(turnId: string): string[] {
    return this.turns.get(turnId)?.formTsList ?? [];
  }
}
