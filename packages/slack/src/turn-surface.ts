import { Logger } from '@soma/common/logger';
import type { AssistantStatusManager } from './assistant-status-manager';
import { runWithTimeout } from './pipeline/stream-executor-cleanup-helpers';
import type { SlackApiHelper } from './slack-api-helper';
import { TaskListBlockBuilder, type TaskUpdateChunk, type Todo } from './task-list-block-builder';
import { buildFeedbackContextActions } from './turn-feedback-block-builder';
import type { TurnCompletionEvent } from './turn-notifier';
import { TurnRenderDebouncer } from './turn-render-debouncer';

/**
 * TurnSurface — single-writer for a per-turn streaming surface (Issue #525).
 *
 * Owns the per-turn Slack stream and auxiliary turn-surface blocks.
 *
 *   begin()      → chat.startStream (opens B1 stream message, plan display)
 *   appendText() → chat.appendStream with a markdown_text chunk
 *   renderTasks()→ chat.appendStream with plan_update/task_update chunks
 *   end()/fail() → chat.stopStream (chunks-mode symmetry)
 *
 * **Unified progress surface (U10a)**:
 *   The stream is opened with `task_display_mode: 'plan'`, so the task list
 *   renders INSIDE the B1 message as native chunks. The separate B2 plan
 *   message (`chat.postMessage` + `chat.update`) survives only as a fallback
 *   for turns with no stream (ad-hoc renderTasks before begin()) or when
 *   Slack explicitly rejects the chunk payload. All writes against `streamTs`
 *   are serialized per turn so text, tasks and the close cannot reorder.
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
   * newer turn on the same (channel, threadTs). begin() allocates an epoch
   * for legacy callers that omit it, and scopes the initial setter too.
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
export type TurnEndReason = 'completed' | 'aborted' | 'user-interrupted';

/**
 * A11 — the literal marker appended to a turn's own stream when the user
 * explicitly interrupts it. Deliberately a bare token with no error
 * decoration: an interruption is a user decision, not a failure, and
 * dressing it as an error trains users to read normal stops as breakage.
 */
const USER_INTERRUPTED_MARKER = 'user-interrupted';

/**
 * A11 — physical marker writes allowed per turn: the first attempt plus the
 * single retry the contract owes a lost write. Two is the whole budget because
 * the only window that matters closes with `stopStream`; more attempts would
 * buy nothing but duplicate markers on a stream the user already stopped.
 */
const MAX_USER_INTERRUPTED_ATTEMPTS = 2;

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

/** Outcome of the 3s completion-snapshot race (see `resolveCompletionSnapshot`). */
interface CompletionSnapshot {
  /** The enriched event, or undefined when the race timed out / the builder threw. */
  evt: TurnCompletionEvent | undefined;
  /** True when a warn was already logged for this snapshot (no double-logging). */
  warnEmitted: boolean;
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
  /**
   * U10a — set once Slack has EXPLICITLY rejected a native task/plan chunk
   * payload on this stream (`invalid_blocks`, unknown chunk type, …). From
   * then on `renderTasksNow` takes the legacy B2 plan-message path for the
   * rest of the turn. Deliberately sticky: re-probing a surface Slack already
   * refused would burn a Slack call per render and re-lose the same tasks.
   *
   * NOT set for ambiguous transport failures (no Slack error code) — those
   * may have been applied server-side, so falling back would risk showing the
   * same task list twice.
   */
  nativeTasksUnsupported: boolean;
  /**
   * U10a — serialized payload of the last native task chunk batch accepted by
   * Slack. Identical snapshots are skipped so a repeated TodoWrite tick
   * doesn't spend a Slack write (and, on the plan surface, cannot produce a
   * second visible task list).
   */
  lastTaskChunkSignature?: string;
  /**
   * U10a — per-turn serialization chain for every write against `streamTs`
   * (text append, task chunks, stopStream). Slack applies stream writes in
   * arrival order, so a task chunk racing a text append could otherwise land
   * after the stream was already stopped. Scoped to the turn on purpose —
   * a global mutex would serialize unrelated sessions behind one slow
   * channel.
   *
   * Invariant: this Promise NEVER rejects (each link swallows), so chaining
   * onto it can't produce an unhandled rejection.
   */
  writeChain: Promise<void>;
  /**
   * A11 — the LAST user-interruption marker write on this turn, kept as the
   * in-flight promise rather than a boolean. The two entry points (a forwarded
   * ThreadPanel click and `end(turnId, 'user-interrupted')`) routinely overlap,
   * and a boolean fence only tells a late caller "someone started a write" —
   * not whether it landed. The late caller would then walk on to `stopStream`
   * while the first write was still open, and a failure there left the
   * transcript with ZERO markers on a stream that is already closed.
   *
   * Resolves `true` when that attempt delivered the marker, `false` when it was
   * lost. NEVER rejects (the writer swallows), so joining it is safe.
   *
   * Invariant: the slot is claimed by CAS — a caller that wakes on a `false`
   * resolve only creates the retry if the slot STILL holds the promise it
   * awaited, otherwise it joins the retry someone else already published. With
   * {@link userInterruptedAttempts} capping the turn at
   * {@link MAX_USER_INTERRUPTED_ATTEMPTS} physical writes, callers cannot
   * compound: N waiters on one failed write produce ONE retry, not N.
   */
  userInterruptedWrite?: Promise<boolean>;
  /**
   * A11 — physical marker writes already spent on this turn (append or plain
   * post, landed or lost). Per TURN, not per call: the retry budget exists so
   * a burst of interrupt clicks on a flaky Slack cannot turn into a burst of
   * markers, and a per-call budget is exactly what lets N callers each spend
   * "their one retry".
   */
  userInterruptedAttempts: number;
}

/**
 * Slack *platform* error codes (`response.error`) that still mean "we could
 * not tell whether the write landed" — overload/throttle rather than "we
 * looked at your payload and refused it". Only a refusal may trigger the B2
 * plan fallback: re-rendering a possibly-applied write on a *different*
 * surface is how users end up with two copies of the same task list.
 */
const AMBIGUOUS_SLACK_PLATFORM_CODES = new Set([
  'ratelimited',
  'rate_limited',
  'service_unavailable',
  'internal_error',
  'fatal_error',
  'request_timeout',
]);

/**
 * Extract the Slack **platform** error code — `err.data.error`, the field a
 * 200-OK Slack response body sets when the API inspected the request and
 * rejected it (`WebAPIPlatformError` in `@slack/web-api`).
 *
 * Deliberately does NOT fall back to `err.code`: the SDK stamps `code` on
 * pure transport failures too (`slack_webapi_request_error`,
 * `slack_webapi_http_error`, `slack_webapi_rate_limited_error`), and those
 * carry no `data` at all. Reading `code` as a rejection would classify a
 * socket hang-up — where the write may already have been applied — as "Slack
 * refused it" and post a duplicate task surface. `describeSlackError` keeps
 * the wider `code` view; it is for LOGS, not for control flow.
 */
function slackPlatformErrorCode(error: unknown): string | undefined {
  const code = (error as { data?: { error?: unknown } })?.data?.error;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * How many recently-closed turnIds to remember so a late `renderTasks` for an
 * already-finished turn cannot resurrect it as a fresh ad-hoc surface. Bounded
 * FIFO — this is a guard, not a ledger.
 */
const CLOSED_TURN_MEMORY = 128;

/**
 * Extract Slack error code (`streaming_mode_mismatch`, `channel_not_found`,
 * rate-limit, etc.) plus the message from whatever shape the SDK threw. The
 * rollout plan wants these distinguishable in logs — a bare `catch {}` erases
 * the very signal operators need.
 */
function describeSlackError(error: unknown): {
  code?: string;
  message: string;
} {
  const err = error as {
    data?: { error?: string };
    code?: string;
    message?: string;
  };
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
  /**
   * P5 B5 marker sink. Undefined → emit path no-ops (tests / PHASE<5).
   *
   * A32 — `buildCompletionBlocks` / `protectMessageTs` are OPTIONAL so older
   * test doubles (bare `{ send }`) keep the legacy detached-card behaviour. A
   * channel that exposes `buildCompletionBlocks` opts the turn into the
   * consolidated close: the result blocks are appended to the streamed answer
   * by `chat.stopStream` and no second message is posted.
   */
  slackBlockKitChannel?: {
    send(event: TurnCompletionEvent): Promise<void>;
    buildCompletionBlocks?(event: TurnCompletionEvent): {
      blocks: any[];
      fallbackText: string;
      withFeedback: boolean;
    };
    protectMessageTs?(event: TurnCompletionEvent, messageTs: string): void;
  };
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

  /**
   * Bounded FIFO of turnIds that already ran end()/fail(). A late
   * `renderTasks` for one of these must NOT spin up a fresh ad-hoc surface —
   * that would post an orphan task list nobody ever finalizes.
   */
  private closedTurns = new Set<string>();

  constructor(private deps: TurnSurfaceDeps) {}

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Fresh TurnState with every field initialised (one place, two callers). */
  private newTurnState(ctx: TurnContext): TurnState {
    return {
      ctx,
      startedAt: Date.now(),
      appendedChunks: 0,
      closing: false,
      formTsList: [],
      nativeTasksUnsupported: false,
      writeChain: Promise.resolve(),
      userInterruptedAttempts: 0,
    };
  }

  /**
   * Serialize one write against this turn's `streamTs`. Slack applies stream
   * writes in arrival order, so text appends, native task chunks and the
   * final `stopStream` must not be allowed to reorder — a task chunk landing
   * after the stop is rejected outright, and a text chunk overtaking a task
   * chunk renders the progress list out of order.
   *
   * Per-turn (not global): unrelated sessions stay parallel.
   */
  private enqueueStreamWrite<T>(state: TurnState, write: () => Promise<T>): Promise<T> {
    const next = state.writeChain.then(() => write());
    // Keep the chain non-rejecting: the caller owns this call's error, and a
    // rejected chain link would break every subsequent write on the turn.
    state.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Tell the helper that this turn put a message into the thread, so the
   * combined panel can re-anchor below it.
   *
   * Every write in this file goes out through the RAW client, so `SlackApiHelper`
   * never sees it and this is the only place that can announce it. Call it after
   * a successful `chat.postMessage` (`kind: 'post'`) or stream open
   * (`kind: 'stream'`) — never after an update, which moves nothing.
   *
   * Guarded on the method's presence: `TurnSurfaceDeps.slackApi` is satisfied
   * by doubles that expose `getClient()` alone, and a missing hook must degrade
   * to "no tail anchoring", never to a crashed turn.
   */
  private notifyThreadPost(address: TurnAddress, ts: string, kind: 'post' | 'stream', turnId?: string): void {
    if (!address.threadTs) return;
    const slackApi = this.deps.slackApi as Partial<SlackApiHelper> | undefined;
    if (typeof slackApi?.notifyThreadPost !== 'function') return;
    try {
      slackApi.notifyThreadPost({ channel: address.channelId, threadTs: address.threadTs, ts, kind });
    } catch (err) {
      this.logger.debug('thread-post notification failed', {
        turnId,
        error: (err as Error).message,
      });
    }
  }

  /** Record a finished turnId (bounded FIFO — see {@link closedTurns}). */
  private rememberClosedTurn(turnId: string): void {
    this.closedTurns.add(turnId);
    while (this.closedTurns.size > CLOSED_TURN_MEMORY) {
      const oldest = this.closedTurns.values().next().value;
      if (oldest === undefined) break;
      this.closedTurns.delete(oldest);
    }
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
    // Duplicate begin() on the same turnId is a contract violation from the
    // caller, but we defend so a stray call can't open a second Slack stream
    // and orphan the first handle.
    if (this.turns.has(ctx.turnId)) {
      this.logger.warn('begin() called twice for same turnId — ignored', {
        turnId: ctx.turnId,
      });
      return;
    }

    const previousTurnId = this.activeTurn.get(ctx.sessionKey);
    const mgr = this.deps.assistantStatusManager;
    if (mgr && ctx.threadTs && ctx.statusEpoch === undefined) {
      ctx = { ...ctx, statusEpoch: mgr.bumpEpoch(ctx.channelId, ctx.threadTs) };
    }

    // Register before any wait so end(), supersede, and duplicate begin() can
    // find this turn even while the previous turn's cleanup is still pending.
    const state: TurnState = this.newTurnState(ctx);
    this.turns.set(ctx.turnId, state);
    this.activeTurn.set(ctx.sessionKey, ctx.turnId);
    // A turnId is unique per turn, but drop any closed-turn tombstone
    // defensively so a re-used id can still render tasks.
    this.closedTurns.delete(ctx.turnId);

    // Close the previous stream before opening this one.
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

    // Cleanup may have outlived this turn. Never start a finished or superseded
    // turn, nor mistake a replacement state for this begin()'s registration.
    if (this.turns.get(ctx.turnId) !== state || state.closing || this.activeTurn.get(ctx.sessionKey) !== ctx.turnId) {
      return;
    }

    // Start native status before stream startup, without letting a hung status
    // API delay B1. The epoch also rejects late work after this turn closes.
    if (mgr && ctx.threadTs) {
      try {
        void mgr
          .setStatus(ctx.channelId, ctx.threadTs, 'is thinking...', {
            expectedEpoch: ctx.statusEpoch,
          })
          .catch((err) => {
            this.logger.warn('B4 native spinner setStatus failed in begin()', {
              turnId: ctx.turnId,
              error: (err as Error).message,
            });
          });
      } catch (err) {
        this.logger.warn('B4 native spinner setStatus failed in begin()', {
          turnId: ctx.turnId,
          error: (err as Error).message,
        });
      }
    }

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
      //
      // U10a: `task_display_mode: 'plan'` opts this stream into Slack's
      // native plan rendering, so `task_update` / `plan_update` chunks appear
      // as a task list INSIDE this message. Slack's default is `'timeline'`;
      // without this field the same chunks render as a running timeline and
      // the plan card never appears. Set unconditionally — it is inert for
      // streams that never send task chunks, and no extra OAuth scope beyond
      // `chat:write` is required.
      const startArgs: Record<string, unknown> = { channel: ctx.channelId, task_display_mode: 'plan' };
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
        // A B1 stream is a real message in the thread, posted through the raw
        // client, so `SlackApiHelper` never sees it and cannot announce it. The
        // thread panel has to know: this message sits BELOW it until the panel
        // re-anchors. (`stopStream`, including the A32 consolidated close with
        // blocks, is deliberately NOT announced — it appends to THIS message,
        // which is already in its final position, so nothing moved.)
        this.notifyThreadPost(ctx, result.ts, 'stream', ctx.turnId);
        // Opening a Slack stream can reset the agent lifecycle to active.
        // Restore only this live turn; the epoch rejects a late closed owner.
        if (mgr && ctx.threadTs && !state.closing && this.activeTurn.get(ctx.sessionKey) === ctx.turnId) {
          void mgr
            .setStatus(ctx.channelId, ctx.threadTs, 'is thinking...', { expectedEpoch: ctx.statusEpoch })
            .catch((err) => {
              this.logger.warn('Native lifecycle refresh after stream startup failed', {
                turnId: ctx.turnId,
                error: (err as Error).message,
              });
            });
        }
        this.logger.debug('B1 stream opened', {
          turnId: ctx.turnId,
          streamTs: result.ts,
        });
      } else {
        this.logger.warn('chat.startStream returned no ts', {
          turnId: ctx.turnId,
        });
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
      const streamTs = state.streamTs;
      // Serialized with native task chunks + stopStream so the visible order
      // matches the emit order (U10a).
      await this.enqueueStreamWrite(state, () =>
        client.chat.appendStream({
          channel: state.ctx.channelId,
          ts: streamTs,
          chunks: [{ type: 'markdown_text', text }],
        }),
      );
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
   * A11 — stamp an explicit user-interruption marker on THIS turn's surface.
   *
   * Contract:
   *   - writes to the turn's OWN stream (`turnId` lookup, never the
   *     session's current turn). A marker for an old turn must never be
   *     appended to the stream of the turn that replaced it.
   *   - sticky + idempotent: repeated calls, and a later
   *     `end(turnId, 'user-interrupted')`, produce exactly one marker.
   *   - no error decoration — the literal token only.
   *   - when the turn has no stream (startStream failed, or the state was
   *     created ad hoc), falls back to a plain `chat.postMessage` in that
   *     same turn's channel/thread so the interruption is still visible where
   *     it happened.
   *
   * Returns `true` when a marker was delivered, `false` when nothing was
   * written (unknown/already-closed turn, already marked, or Slack failed).
   */
  async markUserInterrupted(turnId: string): Promise<boolean> {
    const state = this.turns.get(turnId);
    if (!state) {
      // The turn is gone: its stream handle is closed and we deliberately do
      // NOT redirect the marker onto whatever turn is active now.
      this.logger.debug('markUserInterrupted: unknown or already-closed turn — no marker written', { turnId });
      return false;
    }
    return this.writeUserInterruptedMarker(turnId, state);
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
      if (this.closedTurns.has(turnId)) {
        // U10a — a task update that arrives after its turn closed must die
        // here. Recreating an ad-hoc state would post a NEW task surface for
        // a turn whose stream is already stopped (and, worse, one that no
        // end()/fail() will ever finalize). It must also never be redirected
        // onto the session's newer turn — that would rewrite the live answer.
        this.logger.debug('renderTasks after turn close — dropped', { turnId });
        return false;
      }
      if (!ctx) {
        // Ad-hoc renderTasks call with no prior begin() and no context — we
        // cannot address a Slack channel, so fall through to the legacy path.
        this.logger.warn('renderTasks called without ctx and no existing turn', { turnId });
        return false;
      }
      state = this.newTurnState({ ...ctx, turnId });
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
  private async renderTasksNow(
    turnId: string,
    todos: Todo[],
    final = false,
    allowNewPlanMessage = true,
  ): Promise<void> {
    const state = this.turns.get(turnId);
    if (!state) return;

    // U10a native-first: when this turn owns an open stream, the task list
    // belongs INSIDE it as `plan_update` / `task_update` chunks. Only an
    // explicit Slack rejection (or a turn with no stream at all, e.g. the
    // ad-hoc renderTasks-before-begin path) falls through to the separate B2
    // plan message below.
    if (state.streamTs && !state.nativeTasksUnsupported) {
      const handled = await this.sendTaskChunks(turnId, state, todos, final);
      if (handled) return;
    }

    const { text, blocks } = TaskListBlockBuilder.buildPlanTasks(todos, {
      final,
    });
    if (blocks.length === 0) return;

    const client = this.deps.slackApi.getClient();

    if (!state.planTs) {
      if (!allowNewPlanMessage) {
        // Close-path finalize only. The turn is ending, so a brand-new plan
        // message here would be a *second* task surface posted after the
        // answer — appearing for the first time at the moment the turn dies,
        // duplicating whatever the native chunks already rendered. Leave the
        // native task list as it stands (possibly with a live-looking row)
        // and say so in the log; a stale row is recoverable, a phantom
        // "here is your plan" card posted at close is not, and inventing a
        // completed-looking one would be a false completion.
        this.logger.warn('final task demotion could not be delivered — no new plan message posted at close', {
          turnId,
          streamTs: state.streamTs,
          nativeTasksUnsupported: state.nativeTasksUnsupported,
        });
        return;
      }
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
          this.notifyThreadPost(state.ctx, result.ts, 'post', turnId);
          this.logger.debug('B2 plan message posted', {
            turnId,
            planTs: result.ts,
          });
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
          const fallbackArgs: Record<string, unknown> = {
            channel: state.ctx.channelId,
            text,
          };
          if (state.ctx.threadTs) fallbackArgs.thread_ts = state.ctx.threadTs;
          const fb: { ts?: string } = await (client.chat as any).postMessage(fallbackArgs);
          if (fb?.ts) {
            state.planTs = fb.ts;
            this.notifyThreadPost(state.ctx, fb.ts, 'post', turnId);
          }
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
      this.logger.debug('B2 plan message updated', {
        turnId,
        planTs: state.planTs,
      });
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
        await (client.chat as any).update({
          channel: state.ctx.channelId,
          ts: state.planTs,
          text,
        });
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
    this.notifyThreadPost(address, result.ts, 'post', turnId);
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
    this.notifyThreadPost(address, result.ts, 'post', turnId);
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
          this.logger.debug('B3 multi-choice chunk resolved', {
            channelId,
            ts,
          });
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
    const clearingStatus = this.clearNativeStatus(state);

    // Turn-end surface guarantee §C-2: track whether the snapshot landed
    // so we can return it to the caller after `finally` runs cleanup.
    // Declared in the outer scope (not inside finally) so a `return`
    // statement at the end can read it without nesting return-in-finally
    // (which would swallow any throw from the try block).
    let snapshotResolved = true;

    // B5 capability gate (read once — the closure is caller-owned and the
    // consolidated close below must agree with the `finally` emit path).
    const capActive =
      typeof this.deps.isCompletionMarkerActive === 'function' ? this.deps.isCompletionMarkerActive() : false;
    const channel = this.deps.slackBlockKitChannel;
    const b5Expected = reason === 'completed' && capActive && !!state.ctx.buildCompletionEvent && !!channel;

    // A32 — consolidate the completion card onto the streamed answer. Only
    // when the channel exposes the pure block builder (older doubles / PHASE<5
    // paths fall through to the legacy detached send below), and only with a
    // live stream to append to.
    const consolidate = b5Expected && typeof channel?.buildCompletionBlocks === 'function' && !!state.streamTs;

    // The snapshot MUST be resolved BEFORE `stopStream` on the consolidated
    // path: Slack appends the blocks as part of the close, so there is no
    // second chance to attach them afterwards. Same 3s budget as the legacy
    // `finally` emit — the wait simply moves ahead of the close.
    let snapshot: CompletionSnapshot | undefined;

    // True once the completion card has landed (appended to the stream), so
    // the `finally` block must NOT post a second, detached one.
    let completionEmitted = false;

    try {
      // Inner try/finally: everything that must happen while the stream is
      // still OPEN runs here, and the close runs in the `finally` so a throw
      // in the pre-close work can never leave the stream hanging.
      try {
        // Drain any pending B2 render so the final plan state lands on Slack
        // before we drop the TurnState. Debouncer's internal catch handles fn
        // errors — no need to wrap here.
        await this.renderDebouncer.flush(turnId);

        // Demote any lingering in-progress task to `pending` BEFORE we drop the
        // TurnState (and, for the native surface, before `stopStream`). Slack
        // renders an in-progress task with a loading indicator; without this
        // step, an LLM that ends a turn without marking its todo as completed
        // leaves a persistent "still working" spinner (the user-reported hang
        // state) on a message that outlives the turn.
        await this.finalizeTasksIfNeeded(turnId, state);

        // A11 — explicit "the user stopped me" marker on THIS turn's own stream,
        // written after the task finalize and before the stream is stopped. Only
        // for the explicit interruption reason: generic aborts and supersede
        // must not stamp the transcript (see markUserInterrupted).
        //
        // Awaited, not fire-and-forget: a concurrent click may already own the
        // write, and this is the LAST point at which a lost marker can be retried
        // — once `stopStream` runs the stream is closed for good.
        if (reason === 'user-interrupted') {
          await this.writeUserInterruptedMarker(turnId, state);
        }

        if (consolidate) snapshot = await this.resolveCompletionSnapshot(turnId, state);
      } finally {
        if (state.streamTs) {
          if (consolidate && snapshot?.evt !== undefined) {
            completionEmitted = await this.closeStreamWithCompletion(state, reason, snapshot.evt);
          } else {
            await this.closeStream(state, 'end', reason);
          }
        }
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
      try {
        await clearingStatus;

        // B5 completion marker — success path only. The accessor returns a
        // Promise (`snapshotPromise` owned by stream-executor), so we MUST
        // await it or we'd silently drop B5. A 3s timeout caps the wait so a
        // stuck enrichment can never hang `end()` indefinitely; the snapshot
        // Promise itself is resolved with `undefined` on stream-executor's
        // `.catch` rail, and the explicit timeout is a defence-in-depth net.
        //
        // After the bounded native-status wait; the Slack clear may still be
        // pending. The `send(evt)` call is detached (void + `.catch`) so Slack
        // RTT doesn't extend `end()`'s hot path — only the snapshot wait is
        // synchronous with close.
        //
        // Turn-end surface guarantee §C-2: the outer `snapshotResolved` flag
        // (declared before the try block) stays `true` when `reason !==
        // 'completed'` OR B5 is inactive — no snapshot is expected so the
        // caller MUST NOT post a fallback. When B5 IS expected but the race
        // hits the timeout (or the builder throws), the block below flips
        // it to `false` and lets StreamExecutor decide whether to fall back
        // through `turnNotifier.notify`.
        if (b5Expected && channel && !completionEmitted) {
          // A32 — the consolidated path already raced the snapshot BEFORE the
          // close; re-racing it here would double the wait (and, on a builder
          // that only resolves once, lose the event).
          const { evt, warnEmitted } = snapshot ?? (await this.resolveCompletionSnapshot(turnId, state));

          // Codex review [6c]: explicit `!== undefined` so a future
          // falsy-but-valid event shape doesn't get collapsed into the
          // "snapshot unavailable" branch.
          if (evt !== undefined) {
            // send() fire-and-forget with structured-error logging. Operators
            // triaging B5 drops need the Slack error code (`rate_limited`,
            // `channel_not_found`, `streaming_mode_mismatch`, etc.) plus the
            // channel/thread IDs — bare `err.message` alone collapses distinct
            // failure modes into the same log line.
            void channel.send(evt).catch((err) => {
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
      } finally {
        this.cleanupTurn(turnId, state);
      }
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
    const clearingStatus = this.clearNativeStatus(state);

    try {
      try {
        await this.renderDebouncer.flush(turnId);
        this.logger.debug('turn fail()', { turnId, error: error.message });
        // Same finalize step as end() — kills the persistent in-progress
        // spinner on whichever task surface the turn used. Critical for
        // supersede: when a new turn replaces an in-flight one, the prior turn's
        // plan must stop looking like it's still working before the user's eyes.
        // NOTE: no interruption marker here — fail()/supersede is not a user
        // interruption (A11); only `end(turnId, 'user-interrupted')` stamps one.
        await this.finalizeTasksIfNeeded(turnId, state);
      } finally {
        if (state.streamTs) await this.closeStream(state, 'fail', 'aborted');
      }
    } finally {
      try {
        await clearingStatus;
      } finally {
        this.cleanupTurn(turnId, state);
      }
    }
  }

  /** Invalidate synchronously; absorb rejection immediately while stream cleanup proceeds. */
  private async clearNativeStatus(state: TurnState): Promise<void> {
    try {
      const mgr = this.deps.assistantStatusManager;
      const { channelId, threadTs, statusEpoch } = state.ctx;
      if (mgr && threadTs) {
        // Only bound this waiter: the queued clear and manager writer lane must
        // survive a timeout so a late initial set is still followed by clear.
        await runWithTimeout(() => mgr.clearStatus(channelId, threadTs, { expectedEpoch: statusEpoch }), 5_000, {
          what: `B4 native spinner clear for ${state.ctx.turnId}`,
          logger: this.logger,
        });
      }
    } catch (err) {
      this.logger.warn('B4 native spinner clear threw — cleanup continues', {
        turnId: state.ctx.turnId,
        error: (err as Error)?.message ?? String(err),
      });
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
    blocks?: any[],
  ): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const client = this.deps.slackApi.getClient();
      await (client.chat as any).stopStream({
        channel: channelId,
        ts: streamTs,
        chunks: [],
        // A32 — `chat.stopStream.blocks` are APPENDED to the end of the
        // streamed message (SDK: ChatStopStreamArguments), so the answer the
        // user already read is never rewritten or deleted.
        ...(blocks ? { blocks } : {}),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * A32 — close the stream with the completion card appended in the same call.
   *
   * Returns true when the card landed (so `end()` must NOT post a second,
   * detached one). On a Slack *refusal* of the appended blocks
   * (`invalid_blocks` / `streaming_mode_mismatch`) the stream is still closed
   * plainly and `false` is returned so the legacy detached card is posted —
   * the terminal card is never lost to a block-shape regression. Ambiguous
   * transport failures return true: the close may have been applied
   * server-side, and posting a duplicate card is the worse outcome. That rail
   * protects the stream ts as well, because "may have been applied" includes
   * "the answer message now carries the card" and an unprotected ts is a
   * deletion candidate for the completion tracker.
   */
  private async closeStreamWithCompletion(
    state: TurnState,
    reason: TurnEndReason,
    evt: TurnCompletionEvent,
  ): Promise<boolean> {
    const streamTs = state.streamTs;
    const channel = this.deps.slackBlockKitChannel;
    if (!streamTs || !channel?.buildCompletionBlocks) return false;

    let blocks: any[];
    try {
      const built = channel.buildCompletionBlocks(evt);
      blocks = built.withFeedback
        ? [
            ...built.blocks,
            // No dismiss affordance: the host message IS the user's answer
            // ("답변 보존 방식"), and the marker block_id tells the click
            // handler to ack ephemerally instead of `chat.update`-ing it.
            buildFeedbackContextActions(evt.turnId ?? state.ctx.turnId, evt.userId, {
              includeDismiss: false,
              streamHosted: true,
            }),
          ]
        : built.blocks;
    } catch (err) {
      this.logger.warn('A32 buildCompletionBlocks threw — falling back to the detached card', {
        turnId: state.ctx.turnId,
        error: (err as Error)?.message ?? String(err),
      });
      await this.closeStream(state, 'end', reason);
      return false;
    }

    const result = await this.enqueueStreamWrite(state, () =>
      this.stopStreamRaw(state.ctx.channelId, streamTs, blocks),
    );

    if (result.ok) {
      // The stream message now carries the completion card — it must never be
      // swept by the completion-message deletion pass.
      channel.protectMessageTs?.(evt, streamTs);
      this.logger.debug('A32 stream closed with consolidated completion blocks', {
        turnId: state.ctx.turnId,
        streamTs,
        reason,
        blocks: blocks.length,
        appendedChunks: state.appendedChunks,
        elapsedMs: Date.now() - state.startedAt,
      });
      return true;
    }

    const code = slackPlatformErrorCode(result.error);
    const refused = code === 'invalid_blocks' || code === 'streaming_mode_mismatch';
    this.logger.warn('A32 consolidated stopStream failed', {
      turnId: state.ctx.turnId,
      channelId: state.ctx.channelId,
      streamTs,
      reason,
      refused,
      error: describeSlackError(result.error),
    });

    if (!refused) {
      // Ambiguous (rate limit / transport): the close may have landed. Do not
      // retry the close and do not post a duplicate card.
      //
      // Protect the ts on this rail too. We are returning `true` — "the card
      // is on the streamed message, suppress the detached one" — so if the
      // close DID apply server-side, leaving the ts unprotected hands the
      // user's answer to the completion tracker's deleteAll sweep ("답변
      // 보존"). Protecting a ts whose close never applied costs nothing: the
      // tracker only ever skips deleting it.
      channel.protectMessageTs?.(evt, streamTs);
      return true;
    }

    // Refused: close the stream without the blocks, then let the caller post
    // the legacy detached completion card.
    await this.closeStream(state, 'end', reason);
    return false;
  }

  /**
   * Race the caller's completion snapshot against a 3s budget.
   *
   * The accessor returns a Promise (`snapshotPromise` owned by
   * stream-executor), so we MUST await it or we'd silently drop B5 (#720). The
   * timeout caps the wait so a stuck enrichment can never hang `end()`; the
   * snapshot Promise itself resolves `undefined` on stream-executor's `.catch`
   * rail, and the explicit timeout is a defence-in-depth net.
   */
  private async resolveCompletionSnapshot(turnId: string, state: TurnState): Promise<CompletionSnapshot> {
    const build = state.ctx.buildCompletionEvent;
    if (!build) return { evt: undefined, warnEmitted: false };

    let evt: TurnCompletionEvent | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // True once a B5-specific warn has fired so the caller's fallback branch
    // doesn't emit a second warn for the same event (avoids double-logging
    // the sync-throw path).
    let warnEmitted = false;
    const TIMEOUT_MS = 3000;
    try {
      const builderPromise = Promise.resolve(build());
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

    return { evt, warnEmitted };
  }

  /**
   * A11 — single writer for the user-interruption marker. See
   * {@link markUserInterrupted} for the contract; this private form is also
   * called from `end()` when the reason is `'user-interrupted'`, which is why
   * the fence has to be the WRITE ITSELF (the two entry points routinely race:
   * ThreadPanel forwards the click while the executor tears the turn down).
   *
   * Every caller joins {@link TurnState.userInterruptedWrite} — the same
   * promise — instead of reading a boolean:
   *   - it resolved `true` → the marker is on the transcript; report "not
   *     written by this call" (`false`) and let the caller move on.
   *   - it resolved `false` → the predecessor LOST the marker, so ONE caller
   *     makes the one retry the contract owes. For `end('user-interrupted')`
   *     that retry runs before `stopStream`, which is the only window where a
   *     marker can still land.
   *
   * A boolean fence could not express the middle state ("a write is open, but
   * we don't know yet"): the loser reported success, closed the stream, and a
   * failure on the winner left ZERO markers with nowhere left to write.
   *
   * "ONE caller" is enforced by CAS, not by counting calls. A `false` resolve
   * wakes EVERY parked caller at once, so two clicks plus the teardown would
   * each create "their" retry and overwrite the slot behind each other — three
   * physical markers on one interruption. After the await we therefore re-read
   * the slot: if it no longer holds the promise we awaited, someone already
   * published the retry and we join THAT instead. The per-turn attempt counter
   * ({@link MAX_USER_INTERRUPTED_ATTEMPTS}) is the second half of the fence —
   * it bounds the turn, not the call, so callers cannot compound.
   */
  private async writeUserInterruptedMarker(turnId: string, state: TurnState): Promise<boolean> {
    // Loop rather than recurse: each pass either joins the write currently in
    // the slot or claims the slot for the single retry.
    for (;;) {
      const pending = state.userInterruptedWrite;
      if (pending) {
        if (await pending) {
          this.logger.debug('user-interrupted marker already written — skipped', { turnId });
          return false;
        }
        // Lost marker. Only the caller that still sees the failed promise in
        // the slot owns the retry; anyone else re-joins whatever replaced it.
        if (state.userInterruptedWrite !== pending) continue;
      }

      if (state.userInterruptedAttempts >= MAX_USER_INTERRUPTED_ATTEMPTS) {
        // Budget spent on this turn. Report the loss rather than appending a
        // third marker to a stream that is about to close anyway.
        this.logger.warn('user-interrupted marker retry budget spent — marker lost', {
          turnId,
          attempts: state.userInterruptedAttempts,
        });
        return false;
      }

      // Claim + publish synchronously (no await between the CAS check above
      // and these two lines), so a concurrent waiter can never observe the
      // stale slot and start a second attempt.
      state.userInterruptedAttempts += 1;
      const attempt = this.attemptUserInterruptedMarker(turnId, state);
      state.userInterruptedWrite = attempt;
      return attempt;
    }
  }

  /**
   * One physical marker write — stream append when the turn has a stream, plain
   * post in the turn's OWN channel/thread otherwise. Never throws: the result
   * is the boolean that {@link writeUserInterruptedMarker} publishes as the
   * shared in-flight promise, and a rejection there would surface as an
   * unhandled rejection in every joining caller.
   */
  private async attemptUserInterruptedMarker(turnId: string, state: TurnState): Promise<boolean> {
    const client = this.deps.slackApi.getClient();
    const streamTs = state.streamTs;

    if (streamTs) {
      try {
        // Queued on the turn's write chain: lands after the last text/task
        // chunk and before `stopStream`, never after the stream is closed.
        await this.enqueueStreamWrite(state, () =>
          client.chat.appendStream({
            channel: state.ctx.channelId,
            ts: streamTs,
            chunks: [{ type: 'markdown_text', text: USER_INTERRUPTED_MARKER }],
          }),
        );
        state.appendedChunks += 1;
        this.logger.debug('user-interrupted marker appended to own stream', { turnId, streamTs });
        return true;
      } catch (err) {
        // Nothing was written. Resolving `false` is what lets the next caller
        // (usually the imminent `end('user-interrupted')`) retry instead of
        // trusting a fence that no longer corresponds to a marker.
        this.logger.warn('user-interrupted marker append failed', {
          turnId,
          streamTs,
          retryable: true,
          error: describeSlackError(err),
        });
        return false;
      }
    }

    // No stream for this turn — post a plain message into the turn's OWN
    // channel/thread rather than silently dropping the signal.
    try {
      const postArgs: Record<string, unknown> = {
        channel: state.ctx.channelId,
        text: USER_INTERRUPTED_MARKER,
      };
      if (state.ctx.threadTs) postArgs.thread_ts = state.ctx.threadTs;
      const posted: { ts?: string } = await (client.chat as any).postMessage(postArgs);
      if (posted?.ts) this.notifyThreadPost(state.ctx, posted.ts, 'post', turnId);
      this.logger.debug('user-interrupted marker posted as plain text (no stream)', { turnId });
      return true;
    } catch (err) {
      // Same policy as the stream path — a dropped post is a retryable loss,
      // not a marker that was already written.
      this.logger.warn('user-interrupted marker plain-text fallback failed', {
        turnId,
        retryable: true,
        error: describeSlackError(err),
      });
      return false;
    }
  }

  /**
   * U10a — push the task snapshot onto this turn's own stream as native
   * `plan_update` + `task_update` chunks (`chat.appendStream`, chunks mode).
   *
   * Returns `true` when the render is considered handled and the caller must
   * NOT post a B2 plan message; `false` only when Slack explicitly refused
   * the chunk payload, which permanently flips this turn to the legacy plan
   * surface (`state.nativeTasksUnsupported`).
   *
   * Failure policy — the two error classes are deliberately NOT symmetric:
   *   - explicit Slack rejection (a Slack error code that isn't transport
   *     noise): the write definitely did not land, so re-rendering the same
   *     tasks as a B2 message cannot duplicate anything. Fall back, keep the
   *     tasks visible, and warn. The text stream is untouched.
   *   - ambiguous failure (raw network throw, rate limit, 5xx): Slack may
   *     have applied the chunks. Posting a B2 message now would show the
   *     same task list twice, so we log and return handled. The next render
   *     re-sends the same chunk ids, which Slack merges in place.
   */
  private async sendTaskChunks(turnId: string, state: TurnState, todos: Todo[], final: boolean): Promise<boolean> {
    const streamTs = state.streamTs;
    if (!streamTs) return false;

    const { title, tasks } = TaskListBlockBuilder.buildTaskChunks(todos, final);
    if (tasks.length === 0) return true;

    // `plan_update` first so the plan title is set before its rows arrive.
    const chunks: ({ type: 'plan_update'; title: string } | TaskUpdateChunk)[] = [
      { type: 'plan_update', title },
      ...tasks,
    ];

    // Identical snapshot → skip the write entirely. The debouncer already
    // coalesces bursts; this covers the repeat-TodoWrite case where the
    // snapshot is unchanged across debounce windows.
    const signature = JSON.stringify(chunks);
    if (signature === state.lastTaskChunkSignature) {
      this.logger.debug('native task chunks unchanged — write skipped', { turnId });
      return true;
    }

    try {
      const client = this.deps.slackApi.getClient();
      await this.enqueueStreamWrite(state, () =>
        (client.chat as any).appendStream({
          channel: state.ctx.channelId,
          ts: streamTs,
          chunks,
        }),
      );
      state.lastTaskChunkSignature = signature;
      state.appendedChunks += 1;
      this.logger.debug('native task chunks appended', { turnId, streamTs, taskCount: tasks.length, final });
      return true;
    } catch (err) {
      const described = describeSlackError(err);
      // Classify from the platform body ONLY (see slackPlatformErrorCode):
      // an SDK transport error has `code` but no `data.error`, and must stay
      // ambiguous or we duplicate the task list on every network blip.
      const platformCode = slackPlatformErrorCode(err);
      const explicitRejection = !!platformCode && !AMBIGUOUS_SLACK_PLATFORM_CODES.has(platformCode);
      if (explicitRejection) {
        state.nativeTasksUnsupported = true;
        this.logger.warn('native task chunks rejected — falling back to B2 plan message for this turn', {
          turnId,
          streamTs,
          error: described,
        });
        return false;
      }
      // Ambiguous: do NOT post a second surface for a write that may have
      // landed. `lastTaskChunkSignature` is intentionally left unchanged so
      // the next render retries the same chunk ids on the same stream.
      this.logger.warn('native task chunk append failed (ambiguous) — no fallback post, will retry next render', {
        turnId,
        streamTs,
        error: described,
      });
      return true;
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
   * Demote any lingering `in_progress` task to `pending` on whichever task
   * surface this turn actually used — the native in-stream chunks (U10a) or
   * the legacy B2 plan message. Called from `end()`/`fail()` AFTER the
   * debouncer flush (so `latestTodos` is authoritative) but BEFORE
   * `closeStream` / cleanup (so the demotion cannot land after the stream is
   * stopped, and so a throw cannot skip it).
   *
   * Short-circuits when there's nothing to fix:
   *   - no writable task surface → nothing to update. For the plan path that
   *     means no `planTs`; for the native path it means an open stream still
   *     in native mode. The delegated call additionally passes
   *     `allowNewPlanMessage: false`, so even a *failing* native write on
   *     this path can never create a brand-new plan message at close time.
   *   - no `latestTodos` → state never captured a snapshot
   *   - no `in_progress` todos → live render already showed a terminal
   *     state; an extra Slack call would just burn rate budget without
   *     changing the visible message
   *
   * The actual write is delegated to `renderTasksNow(..., true)` so payload
   * building and error logging stay in one place. `renderTasksNow` swallows
   * Slack errors at `warn`, matching the existing fail-open contract for the
   * close path.
   */
  private async finalizeTasksIfNeeded(turnId: string, state: TurnState): Promise<void> {
    const nativeSurfaceOpen = !!state.streamTs && !state.nativeTasksUnsupported;
    if (!nativeSurfaceOpen && !state.planTs) return;
    if (!state.latestTodos || state.latestTodos.length === 0) return;
    // `in_progress` is the only status Slack renders with a spinner — pending,
    // blocked (rendered as pending), completed and error are all static. So
    // we only pay a chat.update when there's actually a stuck spinner to kill.
    if (!state.latestTodos.some((t) => t.status === 'in_progress')) return;

    // `allowNewPlanMessage: false` — if the native final append is refused
    // here, we must NOT invent a plan message on the way out (see the guard
    // in renderTasksNow). Updating an EXISTING planTs is still fine.
    await this.renderTasksNow(turnId, state.latestTodos, true, false);
  }

  /**
   * Close a known-turn stream with full structured logging. Callers must
   * only invoke when `state.streamTs` is set (see `end()`/`fail()` guards).
   * `origin`/`reason` exist only for observability.
   */
  private async closeStream(state: TurnState, origin: 'end' | 'fail', reason: TurnEndReason): Promise<void> {
    if (!state.streamTs) return;
    const streamTs = state.streamTs;
    // Queued behind every pending text/task write on this turn so the stop
    // can never overtake a chunk that is still in flight (U10a).
    const result = await this.enqueueStreamWrite(state, () => this.stopStreamRaw(state.ctx.channelId, streamTs));
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
    // Tombstone so a late renderTasks can't resurrect this turn as a fresh
    // ad-hoc surface (U10a).
    this.rememberClosedTurn(turnId);
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
