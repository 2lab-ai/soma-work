import { Logger } from '@soma/common/logger';
import { ActionPanelBuilder, type ActivityState, type PRStatusInfo, type WorkflowType } from './action-panel-builder';
import type { AssistantStatusManager } from './assistant-status-manager';
import type { CompletionMessageTracker } from './completion-message-tracker';
import { ContextWindowManager, type SessionUsage } from './context-window-manager';
import type { FollowupQueueView } from './followup-queue-blocks';
import type { RequestCoordinator } from './request-coordinator';
import type { SlackApiHelper, ThreadPostEvent } from './slack-api-helper';
import {
  type BeginPostOutcome,
  type DeliveryIntentRecord,
  type SurfaceAddress,
  threadPanelSurfaceKey,
} from './surface-outbox-store';
import type { SessionTheme, Todo, TodoStatusReader } from './task-list-block-builder';
import { type SessionLinkHistory, type SessionLinks, ThreadHeaderBuilder } from './thread-header-builder';
import type { SlackMessagePayload } from './user-choice-handler';

export interface EndTurnInfo {
  reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';
  timestamp: number;
  lastToolUse?: string;
}

export interface ActionPanelState {
  channelId?: string;
  userId?: string;
  messageTs?: string;
  agentPhase?: string;
  activeTool?: string;
  waitingForChoice?: boolean;
  /**
   * Lifecycle/heartbeat stamp — written on EVERY setStatus call. It proves the
   * surface was touched, NOT that the work moved, so U9 never renders it as a
   * progress time.
   */
  statusUpdatedAt?: number;
  /**
   * U9 — when the work last ACTUALLY moved. Written only when a caller passes
   * it explicitly, i.e. when something witnessed a real progress event
   * (StreamProcessor / follow-up worker). Absent → the header says
   * `실제 활동 기록 없음`; it is never back-filled with `Date.now()` (A19).
   */
  lastProgressAt?: number;
  /** U9 — last proof of life (heartbeat/stream signal). Liveness, not progress. */
  lastSignalAt?: number;
  choiceBlocks?: any[];
  choiceMessageTs?: string;
  choiceMessageLink?: string;
  latestResponseLink?: string;
  turnSummary?: string;
  pendingChoice?: {
    turnId: string;
    kind: 'single' | 'multi';
    choiceTs?: string;
    formIds: string[];
    question: unknown;
    createdAt: number;
  };
  renderKey?: string;
  lastRenderedAt?: number;
  prStatus?: Partial<PRStatusInfo>;
  summaryBlocks?: any[];
}

export interface ConversationSession {
  sessionId?: string;
  channelId: string;
  threadTs?: string;
  threadRootTs?: string;
  threadModel?: 'user-initiated' | 'bot-initiated';
  ownerId?: string;
  ownerName?: string;
  userId?: string;
  summaryTitle?: string;
  title?: string;
  workflow?: WorkflowType;
  model?: string;
  links?: SessionLinks;
  linkHistory?: SessionLinkHistory;
  usage?: SessionUsage;
  isActive?: boolean;
  terminated?: boolean;
  activityState?: ActivityState;
  actionPanel?: ActionPanelState;
  logVerbosity?: number;
  taskListStartedAt?: number;
  taskListCompletedAt?: number;
}

export interface ThreadSurfaceClaudeHandler {
  getSessionByKey(sessionKey: string): ConversationSession | undefined;
}

export interface ThreadSurfaceTodoManager extends TodoStatusReader {
  getTodos(sessionId: string): Todo[];
}

export interface GitHubPRDetails {
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  draft: boolean;
  head: string;
  base: string;
}

export type GitHubPRReviewStatus = 'approved' | 'changes_requested' | 'pending' | undefined;

export interface ThreadSurfaceProviders {
  getSessionTheme?: (userId: string | undefined) => SessionTheme;
  fetchGitHubPRDetails?: (link: any) => Promise<GitHubPRDetails | undefined>;
  fetchGitHubPRReviewStatus?: (link: any) => Promise<GitHubPRReviewStatus>;
  isPRMergeable?: (details: GitHubPRDetails) => boolean;
}

let threadSurfaceProviders: Required<ThreadSurfaceProviders> = {
  getSessionTheme: () => 'default',
  fetchGitHubPRDetails: async () => undefined,
  fetchGitHubPRReviewStatus: async () => undefined,
  isPRMergeable: () => false,
};

export function setThreadSurfaceProviders(providers: ThreadSurfaceProviders): void {
  threadSurfaceProviders = {
    ...threadSurfaceProviders,
    ...providers,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadSurfaceDeps {
  slackApi: SlackApiHelper;
  claudeHandler: ThreadSurfaceClaudeHandler;
  requestCoordinator: RequestCoordinator;
  todoManager: ThreadSurfaceTodoManager;
  completionMessageTracker?: CompletionMessageTracker;
  /**
   * #689 P4 Part 2/2 — optional so existing tests can construct
   * `ThreadSurface` without this dep. When absent, the chip is NEVER
   * suppressed (legacy behaviour).
   */
  assistantStatusManager?: AssistantStatusManager;
  /**
   * U3/U9 — read-only window onto the follow-up queue for `sessionKey`
   * (`.prd/slack-agent-ui/loop.md:47`). Injected, never a singleton
   * (`ssot.md` §3.5): the queue service is owned by the host and handed in at
   * `ThreadPanel` construction.
   *
   * MUST be synchronous, cheap and side-effect free — it is called on the
   * render path (once per render). The surface treats the result as immutable
   * and stores NO copy of it: the queue stays the single source of truth, and
   * the only queue-derived state the surface owns is the current page number.
   *
   * Return `undefined` when this session has no queue. An empty, unfrozen
   * queue renders nothing.
   */
  getFollowupView?: (sessionKey: string) => FollowupQueueView | undefined;
  /**
   * U3/U9 degraded read. When the queue snapshot could not be loaded, return a
   * short human reason; the surface then renders a visible `Queue` +
   * unavailable line instead of a silently empty queue (`rules/config.md:11`
   * "조용한 빈 큐 금지"). Combined with a present `getFollowupView`, the reason
   * is shown as a degradation note under the rendered queue.
   */
  getFollowupError?: (sessionKey: string) => string | undefined;
  /**
   * A24b — durable delivery-intent port for the combined panel. Structurally
   * satisfied by `SurfaceOutboxStore` (already `load()`ed by the host; this
   * surface never loads it, because a load failure must fail closed at the
   * owner, not be papered over mid-render).
   *
   * Absent → legacy behaviour: post straight to Slack and keep the `ts` in
   * memory only. Present → the intent is committed to disk BEFORE the post, so
   * a crash in the ack window leaves `pending` ("unknown"), never "not posted".
   */
  surfaceOutbox?: ThreadSurfaceOutbox;
  /**
   * Optional session persistence sink, mirrored from `ThreadPanelDeps` so
   * `ThreadPanel` wires it through by passing its own deps object. Called only
   * AFTER a delivery `ts` is confirmed, so the broadcast can never advertise a
   * message id the surface cannot prove.
   */
  sessionRegistry?: { persistAndBroadcast(sessionKey: string): void };
}

/**
 * The slice of `SurfaceOutboxStore` the render path uses. Declared structurally
 * so the real store satisfies it with no adapter, and so tests can supply a
 * delegating double for a failure this surface must survive.
 */
export interface ThreadSurfaceOutbox {
  get(surfaceKey: string): DeliveryIntentRecord | undefined;
  beginPost(address: SurfaceAddress): BeginPostOutcome;
  markSent(surfaceKey: string, intentId: string, messageTs: string): DeliveryIntentRecord;
  markRejected(surfaceKey: string, intentId: string, code: string): DeliveryIntentRecord;
  markDeleted(surfaceKey: string, intentId: string, observedMessageTs: string): DeliveryIntentRecord;
  readonly recoveryWarning?: string;
}

/**
 * Optional per-write guard shared by the surface's write entry points.
 *
 * `expectedTurnEpoch` is the caller's copy of the SESSION turn-generation
 * counter owned by the follow-up queue (`ssot.md` §3.3, A12/A28). When
 * supplied, the write is applied ONLY if it still matches the queue's current
 * `turnEpoch`; a late write from a turn that has already been superseded is
 * dropped instead of overwriting the new turn's surface.
 *
 * Omitting the field preserves the legacy behaviour exactly — every existing
 * caller is unaffected, including hosts that wire no queue at all.
 *
 * When the field IS supplied and the queue's current `turnEpoch` cannot be read
 * (no view, unreadable store, view without the counter), the write is REJECTED
 * (fail-closed). The claim "I belong to generation N" is unverifiable, and
 * honouring an unverifiable claim is what lets a superseded turn repaint the
 * live turn's surface — the precise failure A28 exists to stop. In production
 * the two always travel together: the only producer of `expectedTurnEpoch` is a
 * dispatch whose `FollowupQueue.beginTurn` created the session snapshot the
 * epoch is read back from (`followup-dispatcher.ts` → `queue.beginTurn`), so an
 * unreadable epoch means the store is degraded, not that the host is young.
 */
export interface ThreadSurfaceWriteOptions {
  expectedTurnEpoch?: number;
}

interface PRCacheEntry {
  prStatus: PRStatusInfo;
  prUrl: string;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum interval between consecutive Slack chat.update calls (ms).
 * Dashboard v2.1 chunk I — widened from 500ms to 3000ms with leading edge
 * so turn-timer-driven renders don't hammer chat.update. Override via env
 * for tests or tuning.
 */
const RENDER_DEBOUNCE_MS = Number(process.env.SLACK_RENDER_DEBOUNCE_MS) || 3000;

/** PR status cache TTL (ms). */
const PR_CACHE_TTL_MS = 60_000;

/**
 * How long a burst of thread posts is collected before the panel re-anchors to
 * the tail. A streamed answer arrives as several messages within a second, and
 * one delete+post per message would be both wasteful and visibly flickery.
 */
const REANCHOR_DEBOUNCE_MS = Number(process.env.SLACK_PANEL_REANCHOR_DEBOUNCE_MS) || 700;

/**
 * Floor on the interval between two re-anchors of the same session. A re-anchor
 * costs a `chat.delete` + a `chat.postMessage`, and a busy thread would
 * otherwise spend its whole rate-limit budget moving one card around. A
 * re-anchor that arrives inside the window is not dropped, it is deferred to
 * the end of it — the panel still ends up last, just not immediately.
 */
const REANCHOR_MIN_INTERVAL_MS = Number(process.env.SLACK_PANEL_REANCHOR_MIN_INTERVAL_MS) || 3000;

/**
 * Slack's hard per-message block cap
 * (docs.slack.dev/reference/block-kit/blocks — 50 blocks for `chat.update`).
 * The combined surface must fit header + status + Queue + controls inside it.
 */
const MAX_MESSAGE_BLOCKS = 50;

/**
 * Queue page size INSIDE the combined message. The standalone queue surface
 * defaults to 10 (`followup-queue-blocks.ts:73`); here the header, the status
 * panel and the action rows share the same 50-block budget, so the embed is
 * capped tighter. Pagination keeps every backlog item reachable.
 */
const FOLLOWUP_EMBED_PAGE_SIZE = 5;

/**
 * A24b — Slack `data.error` codes that PROVE no message was created, and are
 * therefore the only ones allowed to release a delivery intent for a retry.
 *
 * Deliberately a tiny allow-list of explicit API codes. Anything absent —
 * `ratelimited`, a 5xx, a socket timeout, an unrecognised string — leaves the
 * intent `pending`, i.e. "unknown outcome", because the alternative failure
 * mode is a duplicate card that nothing can clean up. Transport-level fields
 * (`err.code` = ETIMEDOUT/ECONNRESET) are never consulted: they describe the
 * connection, not what Slack did with the request.
 *
 * `queue_overflow` is the one non-Slack code here and it is the strongest
 * evidence of the set: the api helper drops the request from its OWN rate-limit
 * queue before `execute()` runs (`slack-api-helper.ts:361-372`), so no HTTP
 * request was ever made.
 */
const DEFINITIVE_POST_REJECTIONS: ReadonlySet<string> = new Set([
  'channel_not_found',
  'not_in_channel',
  'invalid_auth',
  'invalid_blocks',
  'invalid_arguments',
  'queue_overflow',
]);

/**
 * What the render path resolved about the follow-up queue. `view` absent +
 * `error` present = degraded read; both absent = the caller returns `null`
 * (no queue configured for this session).
 */
interface ResolvedFollowup {
  view?: FollowupQueueView;
  error?: string;
}

// ---------------------------------------------------------------------------
// Per-session render state (debounce, coalescing, PR cache)
// ---------------------------------------------------------------------------

interface SessionRenderState {
  pendingTimer: ReturnType<typeof setTimeout> | null;
  inflightPromise: Promise<void> | null;
  pendingSession: ConversationSession | null;
  pendingForce: boolean;
  pendingOverrides: { closed?: boolean } | null;
  prCache: PRCacheEntry | null;
  // Dashboard v2.1 chunk I — leading+trailing debounce bookkeeping.
  lastEditMs: number;
  /**
   * U3/U9 — the ONLY queue-derived state the surface owns: which page of the
   * follow-up queue this session is currently looking at (1-based). Items,
   * states, freeze and epoch are never copied here; they are read from the
   * injected queue view on every render.
   */
  followupPage: number;
  /**
   * A24b — whether the "delivery held, not retrying" warning reaction has
   * already been placed for this session. The condition is sticky by nature
   * (a pending intent stays pending until something resolves it), so the
   * reaction is placed at most once instead of on every render.
   */
  outboxWarned: boolean;
  /**
   * Whether the "turn epoch unverifiable" rejection has already been reported
   * for this session. A degraded queue store rejects EVERY epoch-stamped write
   * of the turn, so this is warned once per session and debug-logged after.
   */
  epochUnverifiableWarned: boolean;
  /**
   * Where the panel was last rendered. Written on every render, and the ONLY
   * thing the thread-post listener matches on — a `ts` is meaningful only
   * together with its channel and thread.
   */
  address: { channelId: string; threadTs?: string } | null;
  /**
   * The session this surface last rendered, so the listener can act even when
   * the deps carry no `getSessionByKey` (legacy harnesses).
   */
  lastSession: ConversationSession | null;
  /** Newest FOREIGN thread post seen since the last re-anchor. */
  newestThreadPostTs: string | null;
  /** Pending re-anchor. Present ⇒ the burst is already accounted for. */
  reanchorTimer: ReturnType<typeof setTimeout> | null;
  /** When the last re-anchor was attempted (rate-limit floor). */
  lastReanchorAt: number;
  /**
   * True while THIS surface is posting its own panel. Its own message reaches
   * the listener like any other thread post, and re-anchoring on it would make
   * the panel delete and repost itself forever.
   */
  selfPosting: boolean;
}

// ---------------------------------------------------------------------------
// ThreadSurface
// ---------------------------------------------------------------------------

/**
 * **Single-writer** surface for the combined thread header + action panel.
 *
 * Owns exactly one Slack message per session and is the *only* code path
 * that calls `chat.update` on that message.
 *
 * Debounce/coalescing state is tracked **per sessionKey** so that concurrent
 * sessions never interfere with each other's render pipeline.
 *
 * Layout (blocks):
 *   Header section  — owner, title, workflow, links
 *   Status section  — badge, agent chip, PR chip, context %
 *   Metrics context — time, tools, link, verbosity
 *   Choice slot     — (optional, when waiting for user input)
 *   Action buttons  — workflow actions + close
 */
export class ThreadSurface {
  private logger = new Logger('ThreadSurface');

  // Per-session render state keyed by sessionKey
  private sessions = new Map<string, SessionRenderState>();

  /** Undo the thread-post subscription. No-op when none could be made. */
  private readonly unsubscribeThreadPosts: () => void;

  constructor(private deps: ThreadSurfaceDeps) {
    this.unsubscribeThreadPosts = this.subscribeThreadPosts();
  }

  private getState(sessionKey: string): SessionRenderState {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = {
        pendingTimer: null,
        inflightPromise: null,
        pendingSession: null,
        pendingForce: false,
        pendingOverrides: null,
        prCache: null,
        lastEditMs: 0,
        followupPage: 1,
        outboxWarned: false,
        epochUnverifiableWarned: false,
        address: null,
        lastSession: null,
        newestThreadPostTs: null,
        reanchorTimer: null,
        lastReanchorAt: 0,
        selfPosting: false,
      };
      this.sessions.set(sessionKey, state);
    }
    return state;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Ensure the surface message exists for the given session.
   * - bot-initiated: uses threadRootTs (already posted by session-initializer)
   * - user-initiated: creates a new message in the thread if needed
   */
  async initialize(session: ConversationSession, sessionKey: string): Promise<void> {
    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }

    if (session.threadModel === 'bot-initiated' && session.threadRootTs) {
      // For bot-initiated: the root message IS the surface
      if (!session.actionPanel.messageTs) {
        session.actionPanel.messageTs = session.threadRootTs;
      }
      // Defense-in-depth: protect thread root from accidental deletion
      this.deps.completionMessageTracker?.protect(sessionKey, session.threadRootTs);
    }

    // Render initial state (force to ensure message is created)
    await this.renderViaFlush(session, sessionKey, true);

    // Populate PR cache after initial render (non-blocking)
    if (session.links?.pr) {
      this.refreshPRStatus(session, sessionKey)
        .then(() => this.requestRender(session, sessionKey))
        .catch(() => {});
    }
  }

  /**
   * Request a (debounced) re-render of the surface.
   * Multiple rapid calls coalesce into a single chat.update.
   * Fire-and-forget — does not wait for the render to complete.
   */
  requestRender(session: ConversationSession, sessionKey: string, force = false): void {
    this.scheduleRender(session, sessionKey, force);
  }

  /**
   * Update session status and request render.
   * Replaces ThreadPanel.setStatus().
   *
   * `options.expectedTurnEpoch` (A28) — when supplied and stale, the call is a
   * no-op: neither the session state nor the Slack message is touched, so a
   * dying turn cannot repaint the new turn's status line.
   *
   * `patch.lastProgressAt` / `patch.lastSignalAt` (U9) are OPTIONAL and
   * sticky: they are written only when present. This method is called on every
   * lifecycle transition, so treating its invocation as progress would make
   * `마지막 활동` a lie about a heartbeat. Only a caller that witnessed real
   * work supplies the timestamp.
   */
  async setStatus(
    session: ConversationSession,
    sessionKey: string,
    patch: {
      agentPhase?: string;
      activeTool?: string;
      waitingForChoice?: boolean;
      lastProgressAt?: number;
      lastSignalAt?: number;
    },
    options?: ThreadSurfaceWriteOptions,
  ): Promise<void> {
    // Epoch check BEFORE any mutation — a rejected late write must leave the
    // live turn's state exactly as it found it.
    if (this.isStaleWrite(sessionKey, options)) return;

    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }

    session.actionPanel.agentPhase = patch.agentPhase;
    session.actionPanel.activeTool = patch.activeTool;
    if (typeof patch.waitingForChoice === 'boolean') {
      session.actionPanel.waitingForChoice = patch.waitingForChoice;
    }
    // Heartbeat: this call happened. NOT a claim that the work moved.
    session.actionPanel.statusUpdatedAt = Date.now();
    // U9 — real progress / liveness are written ONLY when the caller supplies
    // them, and are never cleared by a later generic lifecycle call.
    if (patch.lastProgressAt !== undefined) {
      session.actionPanel.lastProgressAt = patch.lastProgressAt;
    }
    if (patch.lastSignalAt !== undefined) {
      session.actionPanel.lastSignalAt = patch.lastSignalAt;
    }

    try {
      await this.renderViaFlush(session, sessionKey, false);
    } catch (error) {
      this.logger.debug('Failed to update surface status', {
        sessionKey,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Finalize agent phase based on endTurn info (Issue #42 S4).
   * Called after stream completes, replaces ad-hoc phase logic in StreamExecutor.
   *
   * `options.expectedTurnEpoch` (A28) matters MOST here: this is the last write
   * a finishing turn makes, and it lands after teardown — precisely the window
   * in which a `Send now` has already promoted a queued item and started a new
   * turn. Ungated, the dying turn's "사용자 액션 대기" would overwrite the new
   * turn's live status. The gate is forwarded to {@link setStatus}, which drops
   * the whole call (state + Slack) when the epoch no longer matches.
   */
  async finalizeOnEndTurn(
    session: ConversationSession,
    sessionKey: string,
    endTurnInfo: EndTurnInfo,
    hasPendingChoice: boolean,
    options?: ThreadSurfaceWriteOptions,
  ): Promise<void> {
    let agentPhase: string;
    if (hasPendingChoice) {
      agentPhase = '입력 대기';
    } else if (endTurnInfo.reason === 'max_tokens') {
      agentPhase = '토큰 한도 도달';
    } else {
      agentPhase = '사용자 액션 대기';
    }

    await this.setStatus(
      session,
      sessionKey,
      {
        agentPhase,
        activeTool: undefined,
        waitingForChoice: hasPendingChoice,
      },
      options,
    );
  }

  /**
   * Attach user choice blocks and force-render.
   */
  async attachChoice(sessionKey: string, payload: SlackMessagePayload, sourceMessageTs?: string): Promise<void> {
    const session = this.deps.claudeHandler.getSessionByKey(sessionKey);
    if (!session) return;

    const choiceBlocks = this.extractChoiceBlocks(payload);
    if (choiceBlocks.length === 0) return;

    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }

    session.actionPanel.choiceBlocks = choiceBlocks;
    session.actionPanel.waitingForChoice = true;
    session.actionPanel.choiceMessageLink = undefined;
    if (sourceMessageTs) {
      session.actionPanel.choiceMessageTs = sourceMessageTs;
    }

    // Resolve permalink for the choice message (non-blocking for render)
    if (sourceMessageTs) {
      this.resolveChoicePermalink(session, sourceMessageTs).catch(() => {});
    }

    await this.renderViaFlush(session, sessionKey, true);
  }

  /**
   * P3 (PHASE>=3) — lightweight metadata update for a posted B3 choice
   * message. Writes `choiceMessageTs`, `waitingForChoice=true`, and resolves
   * `choiceMessageLink` via permalink lookup. Does NOT write `choiceBlocks`
   * (the B3 single-writer owns the buttons in its own message).
   *
   * Equivalent to attachChoice() minus the choiceBlocks write. Used by
   * ThreadPanel.askUser / askUserForm P3 path AFTER session state has been
   * written synchronously — this method is fire-and-forget for the
   * permalink warm-up.
   *
   * Safe to call with five-block phase < 3: it degrades to a
   * no-op (legacy code should use attachChoice instead).
   */
  async setChoiceMeta(sessionKey: string, ts: string): Promise<void> {
    const session = this.deps.claudeHandler.getSessionByKey(sessionKey);
    if (!session) return;
    if (!session.actionPanel) {
      session.actionPanel = {
        channelId: session.channelId,
        userId: session.ownerId,
      };
    }
    session.actionPanel.choiceMessageTs = ts;
    session.actionPanel.waitingForChoice = true;

    // Trigger render with current state (best-effort).
    try {
      await this.renderViaFlush(session, sessionKey, true);
    } catch (err) {
      this.logger.warn('setChoiceMeta: render failed', {
        sessionKey,
        error: (err as Error)?.message ?? String(err),
      });
    }

    // Permalink lookup (fire-and-forget, same pattern as attachChoice).
    this.resolveChoicePermalink(session, ts).catch((err) => {
      this.logger.warn('setChoiceMeta: permalink resolve failed', {
        sessionKey,
        ts,
        error: (err as Error)?.message ?? String(err),
      });
    });
  }

  /**
   * Clear pending choice and force-render.
   */
  async clearChoice(sessionKey: string): Promise<void> {
    const session = this.deps.claudeHandler.getSessionByKey(sessionKey);
    if (!session?.actionPanel) return;

    session.actionPanel.choiceBlocks = undefined;
    session.actionPanel.waitingForChoice = false;
    session.actionPanel.choiceMessageTs = undefined;
    session.actionPanel.choiceMessageLink = undefined;
    // P3: also clear the authoritative pending record (if present).
    session.actionPanel.pendingChoice = undefined;

    await this.renderViaFlush(session, sessionKey, true);
  }

  /**
   * Generic re-render (e.g. after usage update).
   *
   * `options.expectedTurnEpoch` (A28) — same gate as {@link setStatus}.
   */
  async updatePanel(
    session: ConversationSession,
    sessionKey: string,
    options?: ThreadSurfaceWriteOptions,
  ): Promise<void> {
    if (this.isStaleWrite(sessionKey, options)) return;

    if (!session.actionPanel) {
      await this.initialize(session, sessionKey);
      return;
    }
    // Refresh PR cache if stale (non-blocking for render)
    if (session.links?.pr) {
      const state = this.getState(sessionKey);
      if (!state.prCache || Date.now() - state.prCache.fetchedAt >= PR_CACHE_TTL_MS) {
        this.refreshPRStatus(session, sessionKey).catch(() => {});
      }
    }
    await this.renderViaFlush(session, sessionKey, false);
  }

  /**
   * U3/U9 — re-render because the follow-up queue changed (enqueue, state
   * transition, freeze, drain). Forced: a queue change must always land, even
   * when the rest of the surface is byte-identical.
   *
   * `page` is optional; when given it becomes the session's current page
   * (validated + clamped like {@link setFollowupPage}).
   */
  async updateFollowup(session: ConversationSession, sessionKey: string, page?: number): Promise<void> {
    if (page !== undefined) {
      this.getState(sessionKey).followupPage = this.clampFollowupPage(sessionKey, page);
    }
    if (!session.actionPanel) {
      await this.initialize(session, sessionKey);
      return;
    }
    await this.renderViaFlush(session, sessionKey, true);
  }

  /**
   * U3/U9 — move the embedded queue to `page` (1-based) and re-render.
   *
   * Input is validated and clamped, never trusted: a non-integer, a 0/negative
   * page or a page past the end collapses to the nearest real page rather than
   * rendering an empty queue. Returns the page actually applied.
   *
   * The session is looked up through the injected claude handler, so a Slack
   * pagination click (which carries only `sessionKey` + `page`) renders the
   * LATEST known session rather than a snapshot captured at button-mint time.
   * No session known → the page is still recorded for the next render.
   */
  async setFollowupPage(sessionKey: string, page: number): Promise<number> {
    const applied = this.clampFollowupPage(sessionKey, page);
    this.getState(sessionKey).followupPage = applied;

    const session = this.getLiveSession(sessionKey);
    if (session?.actionPanel) {
      await this.renderViaFlush(session, sessionKey, true);
    }
    return applied;
  }

  /**
   * Render the final "closed" state.
   * Routes through flushRender to respect single-in-flight guarantee.
   */
  async close(session: ConversationSession, sessionKey: string): Promise<void> {
    if (session.actionPanel) {
      await this.renderViaFlush(session, sessionKey, true, { closed: true });
    }
    // Clean up per-session state to prevent memory leak
    this.cleanup(sessionKey);
  }

  /**
   * Refresh the PR status cache (call from outside render path).
   */
  async refreshPRStatus(session: ConversationSession, sessionKey: string): Promise<void> {
    const state = this.getState(sessionKey);
    const entry = await this.fetchPRStatusEntry(session, state);
    if (entry) {
      state.prCache = entry;
    }
  }

  // =========================================================================
  // Debounce & Coalescing
  // =========================================================================

  private scheduleRender(session: ConversationSession, sessionKey: string, force: boolean): void {
    const rs = this.getState(sessionKey);

    // Always keep latest state for this session
    rs.pendingSession = session;
    rs.pendingForce = rs.pendingForce || force;

    if (force) {
      // Force: cancel pending timer and execute immediately
      if (rs.pendingTimer) {
        clearTimeout(rs.pendingTimer);
        rs.pendingTimer = null;
      }
      rs.lastEditMs = Date.now();
      this.flushRender(sessionKey);
      return;
    }

    // Dashboard v2.1 chunk I — leading edge: if no render has happened in the
    // debounce window AND nothing is currently in flight, fire immediately so
    // the first edit after idle time is snappy.
    const now = Date.now();
    const sinceLast = now - rs.lastEditMs;
    if (sinceLast >= RENDER_DEBOUNCE_MS && !rs.inflightPromise && !rs.pendingTimer) {
      rs.lastEditMs = now;
      this.flushRender(sessionKey);
      return;
    }

    // Trailing edge: coalesce subsequent edits into a single render after the
    // window. Reset the timer on each call so the trailing render reflects the
    // latest state.
    if (rs.pendingTimer) {
      clearTimeout(rs.pendingTimer);
    }
    rs.pendingTimer = setTimeout(() => {
      rs.pendingTimer = null;
      rs.lastEditMs = Date.now();
      this.flushRender(sessionKey);
    }, RENDER_DEBOUNCE_MS);
  }

  private flushRender(sessionKey: string): void {
    const rs = this.getState(sessionKey);
    const session = rs.pendingSession;
    const force = rs.pendingForce;
    const overrides = rs.pendingOverrides;
    rs.pendingSession = null;
    rs.pendingForce = false;
    rs.pendingOverrides = null;

    if (!session) return;

    if (rs.inflightPromise) {
      // Another render in flight for this session — re-queue so latest state wins
      rs.pendingSession = session;
      rs.pendingForce = force;
      rs.pendingOverrides = overrides;
      return;
    }

    rs.inflightPromise = this.doRender(session, sessionKey, force, overrides ?? undefined)
      .catch((err) => this.logger.debug('Surface render error', { sessionKey, error: (err as Error).message }))
      .finally(() => {
        rs.inflightPromise = null;
        // If state accumulated while we were rendering, flush again
        if (rs.pendingSession) {
          this.flushRender(sessionKey);
        }
      });
  }

  /**
   * Route a render through flushRender and wait for completion.
   * All public methods that need immediate, guaranteed rendering use this.
   * This ensures the single-in-flight guarantee is always respected.
   */
  private async renderViaFlush(
    session: ConversationSession,
    sessionKey: string,
    force: boolean,
    overrides?: { closed?: boolean },
  ): Promise<void> {
    const rs = this.getState(sessionKey);

    // Wait for any in-flight render to complete first
    if (rs.inflightPromise) {
      await rs.inflightPromise;
    }

    // Set pending state and overrides
    rs.pendingSession = session;
    rs.pendingForce = force;
    if (overrides) {
      rs.pendingOverrides = overrides;
    }

    // Cancel any pending debounce timer
    if (rs.pendingTimer) {
      clearTimeout(rs.pendingTimer);
      rs.pendingTimer = null;
    }

    // Flush synchronously (starts the promise)
    this.flushRender(sessionKey);

    // Wait for the render we just started
    if (rs.inflightPromise) {
      await rs.inflightPromise;
    }
  }

  /**
   * Clean up per-session render state to prevent memory leak.
   */
  private cleanup(sessionKey: string): void {
    const rs = this.sessions.get(sessionKey);
    if (rs) {
      if (rs.pendingTimer) {
        clearTimeout(rs.pendingTimer);
      }
      if (rs.reanchorTimer) {
        clearTimeout(rs.reanchorTimer);
      }
      rs.pendingSession = null;
      rs.lastSession = null;
      rs.prCache = null;
    }
    this.sessions.delete(sessionKey);
    this.deps.completionMessageTracker?.clearProtection(sessionKey);
  }

  /**
   * Drop the thread-post subscription and every pending timer. For a host that
   * tears a `ThreadPanel` down while the process keeps running; a surface that
   * lives for the process lifetime never needs it.
   */
  dispose(): void {
    this.unsubscribeThreadPosts();
    for (const sessionKey of [...this.sessions.keys()]) {
      this.cleanup(sessionKey);
    }
  }

  // =========================================================================
  // Tail anchoring — the panel must be the LAST message in its thread
  // =========================================================================

  /**
   * Listen for messages posted into the threads this surface renders into.
   *
   * Optional by construction: `ThreadSurfaceDeps.slackApi` is satisfied by
   * plenty of hand-rolled doubles that expose only what they need, and a
   * surface that cannot subscribe simply never re-anchors — it renders exactly
   * as it did before.
   */
  private subscribeThreadPosts(): () => void {
    const slackApi = this.deps.slackApi as Partial<SlackApiHelper> | undefined;
    if (typeof slackApi?.addThreadPostListener !== 'function') {
      return () => {};
    }
    return slackApi.addThreadPostListener((event) => this.handleThreadPost(event));
  }

  /**
   * A message landed in a thread. Decide whether it pushed a panel up.
   *
   * Cheap and synchronous on purpose — it runs inside every bot post. The
   * matching is on the panel's LAST RENDERED ADDRESS rather than on a parsed
   * session key, so no assumption is made about how session keys are formed.
   */
  private handleThreadPost(event: ThreadPostEvent): void {
    for (const [sessionKey, rs] of this.sessions) {
      if (!rs.address || rs.address.channelId !== event.channel) continue;
      if ((rs.address.threadTs ?? '') !== event.threadTs) continue;
      // Our own card, reported by the very post that created it.
      if (rs.selfPosting) continue;

      const panelTs = this.panelMessageTs(sessionKey, rs);
      if (!panelTs || panelTs === event.ts) continue;
      if (!ThreadSurface.isNewerTs(event.ts, panelTs)) continue;

      rs.newestThreadPostTs = event.ts;
      this.scheduleReanchor(sessionKey);
    }
  }

  /** The ts of the card this session's panel currently occupies, if any. */
  private panelMessageTs(sessionKey: string, rs: SessionRenderState): string | undefined {
    const session = this.getLiveSession(sessionKey) ?? rs.lastSession ?? undefined;
    return session?.actionPanel?.messageTs;
  }

  /**
   * Arm the (single) pending re-anchor for this session.
   *
   * The timer is NOT reset by later posts: a trailing-edge debounce on a thread
   * that keeps talking would postpone the re-anchor indefinitely, which is the
   * exact symptom being fixed. First post in a quiet period starts the clock,
   * everything inside the window rides along.
   */
  private scheduleReanchor(sessionKey: string): void {
    const rs = this.getState(sessionKey);
    if (rs.reanchorTimer) return;

    const sinceLast = Date.now() - rs.lastReanchorAt;
    const wait = Math.max(REANCHOR_DEBOUNCE_MS, REANCHOR_MIN_INTERVAL_MS - sinceLast);
    rs.reanchorTimer = setTimeout(() => {
      rs.reanchorTimer = null;
      void this.reanchorToTail(sessionKey).catch((error) =>
        this.logger.debug('Panel re-anchor failed', { sessionKey, error: (error as Error)?.message ?? error }),
      );
    }, wait);
  }

  /**
   * Move the panel to the bottom of its thread: delete the card, then post it
   * again through the ordinary delivery path.
   *
   * Slack has no "move message", so re-anchoring is destructive by necessity
   * and every refusal below is about not destroying the wrong thing:
   *
   *   - the panel IS the thread root (bot-initiated sessions) → deleting it
   *     deletes the conversation. No layout preference justifies that;
   *   - the session is closed → the closed card is history, not a control;
   *   - the delete failed → the old card may still be live, and two panels
   *     break the single-writer invariant permanently. A stale position is
   *     recoverable; a duplicate is not;
   *   - the outbox would not authorise the replacement post
   *     ({@link outboxAuthorisesRepost}) → deleting first would leave the
   *     session with no card and no permission to make one.
   *
   * The repost is NOT a special path: `messageTs` is cleared and the normal
   * render runs, so the A24 outbox sequence (`beginPost` → post → `markSent`)
   * and the 50-block budget apply unchanged. A crash between the delete and the
   * post therefore leaves a released record — the next render posts exactly one
   * replacement — which is the same window `recordDeletedPanel` already covers
   * for a card deleted by a human.
   */
  private async reanchorToTail(sessionKey: string): Promise<void> {
    const rs = this.getState(sessionKey);
    const target = rs.newestThreadPostTs;
    rs.newestThreadPostTs = null;
    if (!target) return;

    const session = this.getLiveSession(sessionKey) ?? rs.lastSession ?? undefined;
    const panelState = session?.actionPanel;
    if (!session || !panelState) return;

    const oldTs = panelState.messageTs;
    // Nothing anchored yet: the next render posts at the tail by itself.
    if (!oldTs) return;
    // Already below the newest message we know of.
    if (!ThreadSurface.isNewerTs(target, oldTs)) return;
    if (oldTs === (session.threadRootTs || session.threadTs)) return;
    if (!session.isActive || session.terminated === true) return;

    const channelId = panelState.channelId || session.channelId;
    if (!channelId) return;
    if (!this.outboxAuthorisesRepost(sessionKey, oldTs)) return;

    rs.lastReanchorAt = Date.now();
    try {
      await this.deps.slackApi.deleteMessage(channelId, oldTs);
    } catch (error) {
      this.logger.warn('Panel re-anchor aborted — the old card could not be deleted', {
        sessionKey,
        oldTs,
        error: (error as Error)?.message ?? String(error),
      });
      return;
    }

    // The deletion is ours, but the record cannot tell whose it was: same
    // transition, same CAS (a record that is not `sent` on this exact ts is
    // left alone and the delivery rules below decide what happens).
    this.recordDeletedPanel(sessionKey, oldTs);
    panelState.messageTs = undefined;
    panelState.renderKey = undefined;

    await this.renderViaFlush(session, sessionKey, true);
  }

  /**
   * May the panel at `oldTs` be destroyed and reposted through the outbox?
   *
   * Only when the durable record says `sent` on THIS exact ts. Any other state
   * is a record that will not authorise the replacement: `beginPost` hands a
   * `pending` record back as-is (it means "unknown outcome"), and the delete has
   * no transition to release it — `markDeleted` demands a `sent` record on the
   * observed ts. Re-anchoring on top of that leaves the session with no card and
   * no permission to post one, i.e. a permanently invisible panel. A stale
   * position is recoverable; a held surface is not.
   *
   * Always `true` when no outbox is wired (legacy hosts): the post path there
   * needs no authorisation, and a missing card self-heals on the next render.
   */
  private outboxAuthorisesRepost(sessionKey: string, oldTs: string): boolean {
    const outbox = this.deps.surfaceOutbox;
    if (!outbox) return true;

    let record: DeliveryIntentRecord | undefined;
    try {
      record = outbox.get(threadPanelSurfaceKey(sessionKey));
    } catch (error) {
      this.logger.debug('Panel re-anchor skipped — the outbox could not be read', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
      return false;
    }

    if (record?.state === 'sent' && record.messageTs === oldTs) return true;

    this.logger.debug('Panel re-anchor skipped — the delivery record would not authorise the repost', {
      sessionKey,
      oldTs,
      state: record?.state ?? 'absent',
      recordTs: record?.messageTs,
    });
    return false;
  }

  /**
   * Is `candidate` a later Slack ts than `reference`?
   *
   * `false` for anything unparseable: re-anchoring deletes a message, and an
   * unordered pair is not evidence that the panel was pushed up.
   */
  private static isNewerTs(candidate: string, reference: string): boolean {
    const a = Number.parseFloat(candidate);
    const b = Number.parseFloat(reference);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return a > b;
  }

  // =========================================================================
  // Core Render
  // =========================================================================

  private async doRender(
    session: ConversationSession,
    sessionKey: string,
    force: boolean,
    overrides?: { closed?: boolean },
  ): Promise<void> {
    let current = session;
    let panelState = current.actionPanel || {};
    const channelId = panelState.channelId || current.channelId;

    if (!channelId) {
      this.logger.debug('Skipping surface render (no channel)', { sessionKey });
      return;
    }

    // Where this panel lives, for the thread-post listener. Recorded before the
    // message exists: the first post is itself a thread post, and the listener
    // needs the address to recognise it as ours.
    const renderState = this.getState(sessionKey);
    renderState.address = { channelId, threadTs: current.threadRootTs || current.threadTs };
    renderState.lastSession = current;

    // Ensure choice permalink is resolved before building blocks
    if (panelState.waitingForChoice && !panelState.choiceMessageLink && panelState.choiceMessageTs) {
      await this.ensureChoiceMessageLink(panelState as NonNullable<ConversationSession['actionPanel']>, channelId);
      // A28 — the session may have advanced while we awaited the permalink.
      // Re-acquire the live record so this render paints the CURRENT state
      // instead of writing back the state we captured before the await.
      const latest = this.getLiveSession(sessionKey);
      if (latest) {
        current = latest;
        panelState = current.actionPanel || panelState;
      }
    }

    // Build combined blocks
    const blocks = this.buildCombinedBlocks(current, sessionKey, overrides);
    const text = this.buildFallbackText(current, overrides);
    const renderKey = JSON.stringify(blocks);

    // Skip if nothing changed (unless forced)
    if (!force && panelState.renderKey === renderKey) {
      return;
    }

    let rendered = false;

    // Try to update existing message
    if (panelState.messageTs) {
      try {
        await this.deps.slackApi.updateMessage(channelId, panelState.messageTs, text, blocks, undefined, {
          unfurlLinks: false,
          unfurlMedia: false,
        });
        rendered = true;
      } catch (error: any) {
        // Two different questions, two different tests. The loose one decides
        // whether to drop the in-memory ts (legacy behaviour, unchanged); only
        // the STRICT one — an explicit `data.error` code from the API — is
        // allowed to rewrite the durable record, because that record is the
        // thing standing between a 404 and a duplicate card.
        const isDefinitelyGone = ThreadSurface.isMessageNotFound(error);
        const isMessageNotFound = isDefinitelyGone || error?.message?.includes('message_not_found');
        this.logger.warn('Failed to update surface message', {
          sessionKey,
          isMessageNotFound,
          error: error?.message || error,
        });
        // A transient failure (network, rate-limit, timeout) says NOTHING about
        // whether the message still exists — only `message_not_found` does.
        // Dropping messageTs here posts a SECOND surface message into the
        // thread and permanently splits the single-writer invariant, so we keep
        // the reference and retry the *update* on the next render. This holds
        // for every thread model: the previous bot-initiated-only guard let the
        // duplicate through on user-initiated threads.
        if (!isMessageNotFound) {
          return;
        }
        // 404 only: the message is really gone — clear the stale reference and
        // fall through to create a new one.
        const deadTs = panelState.messageTs;
        panelState.messageTs = undefined;
        if (isDefinitelyGone && deadTs) {
          this.recordDeletedPanel(sessionKey, deadTs);
        }
      }
    }

    // Create new message if needed (any model — including bot-initiated after message_not_found)
    if (!panelState.messageTs) {
      const threadTs = current.threadRootTs || current.threadTs;
      if (!this.deps.surfaceOutbox) {
        // Legacy path — unchanged for hosts that have not wired the outbox.
        try {
          const result = await this.postOwnPanel(sessionKey, channelId, text, blocks, threadTs);
          panelState.messageTs = result?.ts;
          rendered = true;
        } catch (error) {
          this.logger.warn('Failed to post surface message', { sessionKey, error });
        }
      } else {
        const delivered = await this.deliverViaOutbox(
          this.deps.surfaceOutbox,
          { sessionKey, channelId, threadTs },
          text,
          blocks,
        );
        if (!delivered) return;
        if (delivered.adopt === 'update') {
          // A prior generation already posted this card: update it in place.
          panelState.messageTs = delivered.messageTs;
          try {
            await this.deps.slackApi.updateMessage(channelId, delivered.messageTs, text, blocks, undefined, {
              unfurlLinks: false,
              unfurlMedia: false,
            });
            rendered = true;
          } catch (error) {
            this.logger.warn('Failed to update adopted surface message', { sessionKey, error });
            return;
          }
        } else {
          panelState.messageTs = delivered.messageTs;
          rendered = true;
        }
      }
    }

    if (!rendered) return;

    // Update bookkeeping
    panelState.renderKey = renderKey;
    panelState.lastRenderedAt = Date.now();
    panelState.channelId = channelId;
    panelState.userId = panelState.userId || current.ownerId;
    current.actionPanel = panelState;

    // A24b — publish only once the ts is confirmed and in session memory, so a
    // broadcast never advertises a message id the durable record disagrees with.
    if (this.deps.surfaceOutbox && this.deps.sessionRegistry) {
      try {
        this.deps.sessionRegistry.persistAndBroadcast(sessionKey);
      } catch (error) {
        this.logger.warn('Failed to persist session after surface delivery', { sessionKey, error });
      }
    }
  }

  // =========================================================================
  // A24b — durable delivery
  // =========================================================================

  /**
   * Post the panel under a durable delivery intent.
   *
   * Ordering is the whole point: the intent is committed to disk BEFORE the
   * Slack call, and the ack is committed BEFORE the `ts` is published to
   * session memory. Every abrupt stop therefore lands on a record that means
   * "unknown", and an unknown outcome never authorises a second post.
   *
   * Returns `null` when the caller must not render — the surface is held, and
   * the reason has been warned about. `adopt:'update'` means a previous
   * generation already delivered the card and the caller should edit it.
   */
  private async deliverViaOutbox(
    outbox: ThreadSurfaceOutbox,
    address: SurfaceAddress,
    text: string,
    blocks: any[],
  ): Promise<{ messageTs: string; adopt: 'post' | 'update' } | null> {
    const { sessionKey, channelId, threadTs } = address;

    let outcome: BeginPostOutcome;
    try {
      // MUST complete before any network call: a crash between here and the
      // post has to leave a durable `pending` record behind.
      outcome = outbox.beginPost(address);
    } catch (error) {
      // Store unusable (never loaded, or the commit failed). Fail closed.
      this.logger.warn('Surface delivery blocked: outbox unavailable', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
      await this.warnHeldDelivery(address);
      return null;
    }

    if (outcome.status === 'blocked' || outcome.status === 'pending') {
      this.logger.warn('Surface delivery held', {
        sessionKey,
        status: outcome.status,
        reason: outcome.status === 'blocked' ? outcome.reason : `intent ${outcome.record.intentId} unresolved`,
      });
      await this.warnHeldDelivery(address);
      return null;
    }

    if (outcome.status === 'sent') {
      const record = outcome.record;
      // A `ts` is only meaningful together with its channel/thread. If the
      // stored address is not the one being rendered, the surface moved (or the
      // caller is wrong) and this store cannot say which — updating anyway
      // would 404 or edit an unrelated message, so hold instead.
      if (record.channelId !== channelId || record.threadTs !== threadTs) {
        this.logger.warn('Surface delivery held: stored address differs', {
          sessionKey,
          stored: { channelId: record.channelId, threadTs: record.threadTs },
          current: { channelId, threadTs },
        });
        await this.warnHeldDelivery(address);
        return null;
      }
      if (!record.messageTs) {
        this.logger.warn('Surface delivery held: sent record carries no ts', { sessionKey });
        await this.warnHeldDelivery(address);
        return null;
      }
      return { messageTs: record.messageTs, adopt: 'update' };
    }

    // status === 'begin' — this call owns the one permitted post.
    const record = outcome.record;
    let ts: string | undefined;
    try {
      const result = await this.postOwnPanel(sessionKey, channelId, text, blocks, threadTs);
      ts = result?.ts;
    } catch (error) {
      const code = ThreadSurface.definitiveRejectionCode(error);
      if (code) {
        // Proof that no message exists → release the surface for a fresh intent.
        try {
          outbox.markRejected(record.surfaceKey, record.intentId, code);
        } catch (markError) {
          this.logger.warn('Failed to record surface delivery rejection', { sessionKey, error: markError });
        }
        this.logger.warn('Surface delivery rejected', { sessionKey, code });
        return null;
      }
      // Ambiguous: the card may exist. Leave the intent pending forever rather
      // than risk a duplicate; a human resolves it.
      this.logger.warn('Surface delivery outcome unknown — intent left pending', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
      return null;
    }

    if (typeof ts !== 'string' || ts.length === 0) {
      // Slack returned without an id we can address: same ambiguity as a throw.
      this.logger.warn('Surface delivery returned no ts — intent left pending', { sessionKey });
      return null;
    }

    try {
      // Ack BEFORE the ts is published to memory/session state.
      outbox.markSent(record.surfaceKey, record.intentId, ts);
    } catch (error) {
      // The card IS posted but we could not record it. Publishing the ts now
      // would leave memory claiming a delivery the durable record calls
      // pending; on the next restart that disagreement is unresolvable. Hold.
      this.logger.warn('Surface delivery ack failed to persist — intent left pending', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
      return null;
    }

    return { messageTs: ts, adopt: 'post' };
  }

  /**
   * Post the panel, flagged as OUR OWN thread message.
   *
   * The flag is set before the call and cleared after it, because the
   * notification fires inside `postMessage` — strictly before the returned `ts`
   * can be written to `panelState`, so a ts comparison alone would not yet
   * recognise the card as ours and the panel would re-anchor onto itself.
   */
  private async postOwnPanel(
    sessionKey: string,
    channelId: string,
    text: string,
    blocks: any[],
    threadTs: string | undefined,
  ): Promise<{ ts?: string } | undefined> {
    const rs = this.getState(sessionKey);
    rs.selfPosting = true;
    try {
      return await this.deps.slackApi.postMessage(channelId, text, {
        blocks,
        threadTs,
        unfurlLinks: false,
        unfurlMedia: false,
      });
    } finally {
      rs.selfPosting = false;
    }
  }

  /**
   * A24c — tell the outbox that the card it calls delivered is GONE, so the
   * fall-through post can mint a fresh intent instead of being handed the dead
   * `ts` straight back (which is a loop on a message that no longer exists).
   *
   * Narrow by construction: it acts only on a `sent` record for THIS surface
   * whose `messageTs` is the one that just 404'd. No outbox, no record, a
   * pending/rejected record, or a different ts — all left untouched, because the
   * 404 is then evidence about a message this record does not describe, and
   * clearing it would throw away the address of a card still in the thread.
   *
   * Best-effort on failure: if the transition cannot be persisted the record
   * stays `sent`, `beginPost` re-serves the dead ts, and the render ends by
   * holding the panel — never by posting a card nothing durable accounts for.
   */
  private recordDeletedPanel(sessionKey: string, deadTs: string): void {
    const outbox = this.deps.surfaceOutbox;
    if (!outbox) return;

    const surfaceKey = threadPanelSurfaceKey(sessionKey);
    let record: DeliveryIntentRecord | undefined;
    try {
      record = outbox.get(surfaceKey);
    } catch (error) {
      this.logger.warn('Could not read the outbox after a vanished surface message', {
        sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
      return;
    }

    if (record?.state !== 'sent' || record.messageTs !== deadTs) return;

    try {
      outbox.markDeleted(surfaceKey, record.intentId, deadTs);
      this.logger.warn('Surface message was deleted — intent released for a fresh post', { sessionKey, deadTs });
    } catch (error) {
      this.logger.warn('Failed to record the vanished surface message — intent left sent', {
        sessionKey,
        deadTs,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /**
   * Tell the thread, once, that the panel is held. A reaction on the thread
   * root is used rather than a message: the held state exists precisely because
   * we must not create messages we cannot account for.
   */
  private async warnHeldDelivery(address: SurfaceAddress): Promise<void> {
    const state = this.getState(address.sessionKey);
    if (state.outboxWarned) return;
    const anchor = address.threadTs;
    if (!anchor) return;
    state.outboxWarned = true;
    try {
      await this.deps.slackApi.addReaction(address.channelId, anchor, 'warning');
    } catch (error) {
      this.logger.debug('Failed to add held-delivery reaction', { sessionKey: address.sessionKey, error });
    }
  }

  /**
   * The Slack error code when it PROVES nothing was created, else `undefined`.
   * Reads `data.error` only — never `err.code`, never substring matching on a
   * message — because only an explicit API code is evidence about Slack's side.
   */
  private static definitiveRejectionCode(error: unknown): string | undefined {
    const code = (error as { data?: { error?: unknown } } | undefined)?.data?.error;
    if (typeof code !== 'string') return undefined;
    return DEFINITIVE_POST_REJECTIONS.has(code) ? code : undefined;
  }

  /**
   * Slack said, explicitly, that the message does not exist. Same evidence rule
   * as {@link definitiveRejectionCode}: `data.error` and an exact match only —
   * never `err.code` (that describes the socket) and never a substring of a
   * message (any error text mentioning the code would qualify). This is the
   * gate on rewriting the durable record, so a loose test here is how a live
   * card loses its address.
   */
  private static isMessageNotFound(error: unknown): boolean {
    return (error as { data?: { error?: unknown } } | undefined)?.data?.error === 'message_not_found';
  }

  // =========================================================================
  // Block Assembly
  // =========================================================================

  /**
   * Build the combined header + panel blocks.
   *
   * Layout:
   *   header · status/metrics · divider · action rows · summary
   *
   * The follow-up Queue used to sit between the status block and the action
   * rows. It does NOT any more (A39): a queued message is posted as its own
   * message in the thread, right where the user typed it, with its `Send now` /
   * `Cancel` controls on it (`followup-queue-blocks.ts` `buildFollowupItemMessage`).
   * The panel keeps everything else it ever had, and it keeps READING the queue
   * — {@link isStaleWrite} needs the turn epoch — it just renders none of it.
   */
  private buildCombinedBlocks(
    session: ConversationSession,
    sessionKey: string,
    overrides?: { closed?: boolean },
  ): any[] {
    const isClosed = overrides?.closed || !session.isActive || session.terminated === true;
    const hasActiveRequest = this.deps.requestCoordinator.isRequestActive(sessionKey);
    const panelState = session.actionPanel || {};
    const choiceMessageLink = panelState.choiceMessageLink;

    // Read PR status from per-session cache (never fetch in render path)
    const prStatusInfo = this.getState(sessionKey).prCache;

    if (isClosed) {
      return this.buildClosedBlocks(session, sessionKey);
    }

    const blocks: any[] = [];

    // ── 1. Header section ──
    blocks.push(...this.buildHeaderBlocks(session));

    // ── 2. Status + fields section (from ActionPanelBuilder) ──
    const panelPayload = ActionPanelBuilder.build({
      sessionKey,
      workflow: session.workflow,
      disabled: this.computeDisabled(session, hasActiveRequest),
      choiceBlocks: panelState.choiceBlocks,
      waitingForChoice: panelState.waitingForChoice,
      choiceMessageLink,
      latestResponseLink: panelState.latestResponseLink,
      turnSummary: panelState.turnSummary,
      activityState: session.activityState,
      contextRemainingPercent: this.getContextRemainingPercent(session),
      hasActiveRequest,
      statusUpdatedAt: panelState.statusUpdatedAt,
      // U9 — step + real progress + liveness, each from its own source.
      agentPhase: panelState.agentPhase,
      activeTool: panelState.activeTool,
      lastProgressAt: panelState.lastProgressAt,
      lastSignalAt: panelState.lastSignalAt,
      logVerbosity: session.logVerbosity,
      prStatus: prStatusInfo?.prStatus,
      prUrl: prStatusInfo?.prUrl,
    });

    // ActionPanelBuilder.build() returns full blocks: status/metrics first and
    // the action rows (plus their divider) last. The split is kept so the two
    // halves stay in that order; nothing is inserted between them any more.
    const panelBlocks = panelPayload.blocks;
    const splitAt = ThreadSurface.actionRowsIndex(panelBlocks);
    blocks.push(...panelBlocks.slice(0, splitAt));
    const actionRows = panelBlocks.slice(splitAt);

    // ── 3. Action rows ──
    blocks.push(...actionRows);

    // ── 4. Summary section ──
    const summaryBlocks =
      session.actionPanel?.summaryBlocks && Array.isArray(session.actionPanel.summaryBlocks)
        ? session.actionPanel.summaryBlocks
        : [];

    // Append executive summary blocks if present, but only as far as the
    // 50-block budget allows. The summary is the optional part of the surface;
    // the header, the Queue and the controls are not, so overflow trims HERE
    // and never silently drops a button.
    // Trace: docs/archive/features/turn-summary-lifecycle/trace.md, S3
    if (summaryBlocks.length > 0) {
      blocks.push(...summaryBlocks.slice(0, Math.max(0, MAX_MESSAGE_BLOCKS - blocks.length)));
    }

    return blocks;
  }

  /**
   * Index of the trailing action rows inside an ActionPanelBuilder payload —
   * i.e. where the Queue is inserted. Walks back over the contiguous run of
   * `actions` blocks and includes the divider that introduces them, so the
   * Queue lands above the separator rather than between it and the buttons.
   * A payload with no trailing actions (the closed panel) returns its length,
   * which appends the Queue at the end.
   */
  private static actionRowsIndex(blocks: any[]): number {
    let index = blocks.length;
    while (index > 0 && blocks[index - 1]?.type === 'actions') index--;
    if (index > 0 && index < blocks.length && blocks[index - 1]?.type === 'divider') index--;
    return index;
  }

  /**
   * Header blocks: title + context row.
   */
  private buildHeaderBlocks(session: ConversationSession): any[] {
    const theme = threadSurfaceProviders.getSessionTheme(session.ownerId);
    const payload = ThreadHeaderBuilder.fromSession(session, { theme });
    return payload.blocks || [];
  }

  /**
   * Closed state: header + closed panel.
   *
   * No Queue here either (A39). Closing a session freezes and cancels queue
   * items (`ssot.md` §3.5 / A18); what the user sees of that outcome is the
   * per-item messages in the thread — a cancelled item's message is deleted
   * (A41), which is the same fact stated where the item was posted.
   */
  private buildClosedBlocks(session: ConversationSession, sessionKey: string): any[] {
    const prStatusInfo = this.getState(sessionKey).prCache;
    const blocks: any[] = [];

    // Header with closed flag
    const theme = threadSurfaceProviders.getSessionTheme(session.ownerId);
    const headerPayload = ThreadHeaderBuilder.fromSession(session, { closed: true, theme });
    blocks.push(...(headerPayload.blocks || []));

    // Closed panel
    const panelPayload = ActionPanelBuilder.build({
      sessionKey,
      workflow: session.workflow,
      closed: true,
      turnSummary: session.actionPanel?.turnSummary,
      contextRemainingPercent: this.getContextRemainingPercent(session),
      latestResponseLink: session.actionPanel?.latestResponseLink,
      prStatus: prStatusInfo?.prStatus,
      prUrl: prStatusInfo?.prUrl,
    });
    blocks.push(...panelPayload.blocks);

    return blocks;
  }

  /**
   * Accessible fallback for clients that cannot render blocks (A22/A23).
   *
   * Owner and title only. The queue counts/states breakdown that used to be
   * appended here is gone with the Queue section itself (A39): a panel that
   * renders no queue must not describe one in its fallback text either, and the
   * per-item messages carry their own (escaped) fallback.
   */
  private buildFallbackText(session: ConversationSession, overrides?: { closed?: boolean }): string {
    const title = session.title || 'Session';
    const owner = session.ownerName || session.ownerId || '';
    const isClosed = overrides?.closed || !session.isActive || session.terminated === true;
    const closed = isClosed ? ' [종료됨]' : '';
    return `${owner} — ${title}${closed}`;
  }

  // =========================================================================
  // Follow-up queue (U3/U9)
  // =========================================================================

  /**
   * Read the injected queue view for this session, tolerating a provider that
   * throws: a broken queue store must degrade the Queue section, not take the
   * whole surface render down with it.
   *
   * RAW read: applies no display filtering, so callers that need a CONTROL
   * fact (the turn epoch, the page count) see the queue even when it has
   * nothing to draw. Returns `null` only when no provider is wired at all.
   */
  private readFollowup(sessionKey: string): ResolvedFollowup | null {
    const { getFollowupView, getFollowupError } = this.deps;
    if (!getFollowupView && !getFollowupError) return null;

    let view: FollowupQueueView | undefined;
    let error: string | undefined;

    try {
      view = getFollowupView?.(sessionKey);
    } catch (err) {
      error = (err as Error)?.message ?? String(err);
      this.logger.warn('Follow-up queue view read failed', { sessionKey, error });
    }

    if (!error) {
      try {
        error = getFollowupError?.(sessionKey);
      } catch (err) {
        error = (err as Error)?.message ?? String(err);
      }
    }

    if (!view && !error) return null;
    return { view, error };
  }

  /**
   * Clamp a requested page into `[1, pageCount]` using the queue's own item
   * count. Non-integers and non-finite input collapse to page 1. The renderer
   * clamps again against the budget-derived page size, so this never renders
   * an empty page even if the two disagree.
   */
  private clampFollowupPage(sessionKey: string, requested: number): number {
    if (!Number.isFinite(requested)) return 1;
    const page = Math.max(1, Math.floor(requested));
    const view = this.readFollowup(sessionKey)?.view;
    if (!view) return page;
    const pageCount = Math.max(1, Math.ceil(view.items.length / FOLLOWUP_EMBED_PAGE_SIZE));
    return Math.min(page, pageCount);
  }

  /**
   * A28 write gate — `true` when the caller's turn epoch no longer matches the
   * queue's, or cannot be verified at all (see {@link ThreadSurfaceWriteOptions}).
   *
   * An UNVERIFIABLE epoch is treated as stale, not as a pass. A write that
   * carries `expectedTurnEpoch` is asserting "I belong to generation N"; if the
   * store is degraded and the live generation is unreadable, honouring that
   * assertion lets a superseded turn repaint the live turn's surface exactly
   * when the queue is least trustworthy. Writes that carry NO epoch
   * (`expectedTurnEpoch === undefined`) assert nothing and are unaffected —
   * that is the legacy/no-queue path, and it keeps the surface rendering when
   * no queue is wired at all.
   */
  private isStaleWrite(sessionKey: string, options?: ThreadSurfaceWriteOptions): boolean {
    const expected = options?.expectedTurnEpoch;
    if (expected === undefined) return false;

    // RAW read on purpose — an empty queue still has a live turn epoch.
    // An ABSENT counter is unverifiable, NOT "epoch 0" (coercing it would make
    // every `expected > 0` look like a genuine generation mismatch and log as
    // one). A genuine 0 still compares.
    const current = this.readFollowup(sessionKey)?.view?.turnEpoch;
    if (current === undefined) {
      this.warnEpochUnverifiableOnce(sessionKey, expected);
      return true;
    }
    if (current === expected) return false;

    this.logger.debug('Rejected stale surface write', { sessionKey, expected, current });
    return true;
  }

  /**
   * One warn per session for an unverifiable turn epoch. A degraded store
   * rejects EVERY write of the turn, so a warn per write is a log flood that
   * buries the one line an operator needs.
   */
  private warnEpochUnverifiableOnce(sessionKey: string, expected: number): void {
    const state = this.getState(sessionKey);
    if (state.epochUnverifiableWarned) {
      this.logger.debug('Rejected surface write — turn epoch still unverifiable', { sessionKey, expected });
      return;
    }
    state.epochUnverifiableWarned = true;
    this.logger.warn('Rejected surface write — turn epoch unverifiable (queue view unreadable)', {
      sessionKey,
      expected,
    });
  }

  /**
   * The session as the handler knows it RIGHT NOW. Used after awaits and by
   * click handlers that only carry a sessionKey. Tolerates deps built without
   * `getSessionByKey` (legacy test harnesses).
   */
  private getLiveSession(sessionKey: string): ConversationSession | undefined {
    const handler = this.deps.claudeHandler;
    if (typeof handler?.getSessionByKey !== 'function') return undefined;
    try {
      return handler.getSessionByKey(sessionKey);
    } catch {
      return undefined;
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private computeDisabled(session: ConversationSession, hasActiveRequest: boolean): boolean {
    const isBusy = session.activityState === 'working' || session.activityState === 'waiting';
    const waitingForChoice = session.actionPanel?.waitingForChoice;
    return Boolean(isBusy || waitingForChoice || hasActiveRequest);
  }

  private getContextRemainingPercent(session: ConversationSession): number | undefined {
    const usage = session.usage;
    if (!usage || usage.contextWindow <= 0) return undefined;
    return Number(ContextWindowManager.computeRemainingPercent(usage).toFixed(1));
  }

  private extractChoiceBlocks(payload: SlackMessagePayload): any[] {
    if (payload.attachments?.[0]?.blocks) {
      return payload.attachments[0].blocks as any[];
    }
    if (payload.blocks) return payload.blocks;
    return [];
  }

  /**
   * Resolve a Slack permalink for the choice message and cache it.
   * Called after attachChoice — non-blocking for the render path.
   */
  private async resolveChoicePermalink(session: ConversationSession, choiceMessageTs: string): Promise<void> {
    const channelId = session.actionPanel?.channelId || session.channelId;
    if (!channelId || !choiceMessageTs) return;

    try {
      const permalink = await this.deps.slackApi.getPermalink(channelId, choiceMessageTs);
      if (permalink && session.actionPanel) {
        session.actionPanel.choiceMessageLink = permalink;
      }
    } catch (error) {
      this.logger.debug('Failed to resolve choice permalink', { error });
    }
  }

  /**
   * Ensure choice message link is populated before render.
   * Lazy resolution: only fetches if not already cached.
   */
  private async ensureChoiceMessageLink(
    panelState: NonNullable<ConversationSession['actionPanel']>,
    channelId: string,
  ): Promise<string | undefined> {
    if (!panelState.waitingForChoice) return undefined;
    if (panelState.choiceMessageLink) return panelState.choiceMessageLink;
    if (!panelState.choiceMessageTs) return undefined;

    const permalink = await this.deps.slackApi.getPermalink(channelId, panelState.choiceMessageTs);
    if (permalink) {
      panelState.choiceMessageLink = permalink;
      return permalink;
    }
    return undefined;
  }

  // =========================================================================
  // PR Status (out-of-render-path)
  // =========================================================================

  private async fetchPRStatusEntry(
    session: ConversationSession,
    state: SessionRenderState,
  ): Promise<PRCacheEntry | null> {
    const prLink = session.links?.pr;
    if (!prLink || prLink.provider !== 'github') return null;

    // Use cache if fresh
    if (state.prCache && Date.now() - state.prCache.fetchedAt < PR_CACHE_TTL_MS) {
      return state.prCache;
    }

    try {
      const [details, reviewStatus] = await Promise.all([
        threadSurfaceProviders.fetchGitHubPRDetails(prLink),
        threadSurfaceProviders.fetchGitHubPRReviewStatus(prLink),
      ]);
      if (!details) return null;

      const prStatus: PRStatusInfo = {
        state: details.merged ? 'merged' : details.state,
        mergeable: threadSurfaceProviders.isPRMergeable(details),
        draft: details.draft,
        merged: details.merged,
        approved: reviewStatus === 'approved',
        head: details.head,
        base: details.base,
      };

      // Also cache in session for action handlers
      if (session.actionPanel) {
        session.actionPanel.prStatus = {
          state: prStatus.state,
          mergeable: prStatus.mergeable,
          draft: prStatus.draft,
          merged: prStatus.merged,
          approved: prStatus.approved,
          head: prStatus.head,
          base: prStatus.base,
        };
      }

      return { prStatus, prUrl: prLink.url, fetchedAt: Date.now() };
    } catch (error) {
      this.logger.debug('Failed to fetch PR status', { error });
      return null;
    }
  }

  /**
   * Ensure PR cache is populated, then request render.
   * Call this after link changes or on action button click.
   */
  async refreshAndRender(session: ConversationSession, sessionKey: string): Promise<void> {
    await this.refreshPRStatus(session, sessionKey);
    this.requestRender(session, sessionKey, true);
  }
}
