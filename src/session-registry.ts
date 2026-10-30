/**
 * SessionRegistry - Manages conversation sessions and persistence
 * Extracted from claude-handler.ts (Phase 5.1)
 */

import { LOG_VERBOSITY_MASK_VERSION, upgradeLegacyVerbosityMask } from '@soma/slack/output-flags';
import {
  sanitizeSdkUsageBaseline,
  sanitizeSessionUsage,
  sanitizeTaskUsage,
  type TaskUsage,
  toPersistedSessionUsage,
} from '@soma/slack/session-usage-math';
import * as fs from 'fs';
import * as path from 'path';
import { applyInstructionOperations } from 'somalib/model-commands/catalog';
import { DATA_DIR } from './env-paths';
import { isPlaceholderSessionTitle, sanitizeSessionTitle } from './format/display-title';
import { Logger } from './logger';
import { getMetricsEmitter } from './metrics/event-emitter';
import { repriceBaseline } from './metrics/host-pricing';
import { hostPricing } from './metrics/host-pricing-catalog';
import { resolveContextWindow } from './metrics/model-registry';
import { normalizeTmpPath } from './path-utils';
import { loseRunningAgents, sanitizeAgentRegistry } from './session/agent-registry';
import { sanitizeCronJob } from './session/cron-job';
import { closeTaskList, sanitizeTaskLedger } from './session/task-ledger';
import { type ArchivedSession, getArchiveStore, type SessionLifecycleOutcome } from './session-archive';
import { buildLegacySessionKey, buildWorkSessionKey, normalizeSessionKey } from './session-identity';
import { getSessionLifecyclePolicy, idleSinceMs, isSessionLifecyclePolicyDegraded } from './session-lifecycle-policy';
import { DEFAULT_AUTO_HANDOFF_BUDGET } from './slack/handoff-budget';
import {
  creditActiveGoalMs,
  migrateLegacyGoal,
  migrateLegacyGoalArray,
  stampActiveLegGoalOwner,
} from './slack/session-goal-lifecycle';
import type {
  ActionPanelState,
  ActivityState,
  ConversationSession,
  HandoffContext,
  SessionCronJob,
  SessionGoal,
  SessionIncidentRequest,
  SessionInstruction,
  SessionLink,
  SessionLinkHistory,
  SessionLinks,
  SessionResourceOperation,
  SessionResourceSnapshot,
  SessionResourceType,
  SessionResourceUpdateRequest,
  SessionResourceUpdateResult,
  SessionState,
  WorkflowType,
} from './types';
import { coerceToAvailableModel, type EffortLevel, userSettingsStore } from './user-settings-store';

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Dashboard improvements (v2.1): max duration of a single active-leg before we
// assume the process missed an endTurn (crash / OS sleep) and cap the accumulator.
// 30min default. idle은 대부분 이내 재개, OS sleep/crash는 이보다 길다고 가정.
export const MAX_LEG_MS = Number(process.env.MAX_LEG_MS) || 30 * 60 * 1000;

// Active → Sleep (idle) and Sleep → archive durations come from the admin-set
// lifecycle policy (session-lifecycle-policy.ts; defaults 24h / 7d), read at use
// time so a dashboard change applies on the next sweep.

// Session expiry warning intervals in milliseconds (from session expiry time)
// Sorted descending: most urgent first
const WARNING_INTERVALS = [
  12 * 60 * 60 * 1000, // 12 hours remaining - idle check (ask if session is done)
  10 * 60 * 1000, // 10 minutes remaining - final warning
];

const HISTORY_KEY_BY_RESOURCE: Record<SessionResourceType, keyof SessionLinkHistory> = {
  issue: 'issues',
  pr: 'prs',
  doc: 'docs',
};

const ACTIVE_KEY_BY_RESOURCE: Record<SessionResourceType, keyof SessionLinks> = {
  issue: 'issue',
  pr: 'pr',
  doc: 'doc',
};

/**
 * Serialized session for file persistence
 */
interface SerializedSession {
  /** SSOT 2026-10-23 — the cron job that created the session, and a placeholder-title mark. */
  cronJob?: SessionCronJob;
  titleProvisional?: boolean;
  /** SSOT 2026-10-30 — the dashboard star (kept alive) and when it was last removed. */
  starred?: boolean;
  starClearedAt?: number;
  /**
   * Incident ownership survives restarts: dropping it would silently promote a
   * restricted session back to an ordinary one.
   */
  incidentRequest?: SessionIncidentRequest;
  /**
   * Host-written completion marker for the owning attempt — the only evidence
   * that admits a retry, so it must survive a restart with the request.
   */
  incidentAttemptFinishedId?: string;
  key: string;
  ownerId: string;
  ownerName?: string;
  userId: string; // Legacy field
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: string; // ISO date string
  workingDirectory?: string;
  title?: string;
  model?: string;
  // Auto fallback compact (prompt-too-long emergency recovery): persisted so a
  // restart that lands between "switched to the 1M compact model" and "compact
  // boundary restored the original model" can restore the original model on
  // load instead of stranding the session on the 1M compact model.
  fallbackCompactActive?: boolean;
  fallbackCompactOriginalModel?: string | null;
  // Session state machine fields
  state?: SessionState;
  workflow?: WorkflowType;
  // Session links
  links?: SessionLinks;
  linkHistory?: SessionLinkHistory;
  linkSequence?: number;
  /** Monotonic generation token for link-derived title refresh (#762). */
  linkRefreshGeneration?: number;
  // Sleep mode
  sleepStartedAt?: string; // ISO date string
  // Activity state
  activityState?: ActivityState;
  // Restart-notification symmetry marker — see ConversationSession docs.
  shutdownNotificationSent?: boolean;
  shutdownNotifiedAt?: number;
  wasWorkingAtShutdown?: boolean;
  // Error auto-retry (#351): due time, owning run, budget and error context of
  // a pending retry, so a restart can re-arm it. The timer handle is runtime-only.
  pendingRetryAt?: number;
  pendingRetrySessionId?: string;
  pendingRetryDetail?: { attempt?: number; maxAttempts?: number; reason?: string };
  errorRetryCount?: number;
  lastErrorContext?: string;
  // Log verbosity bitmask
  logVerbosity?: number;
  /**
   * Encoding version of `logVerbosity` (LOG_VERBOSITY_MASK_VERSION), written
   * with every stored mask. Absent = saved before the NARRATION flag, the
   * only case loadSessions upgrades.
   */
  logVerbosityVersion?: number;
  // Effort level for Claude thinking
  effort?: EffortLevel;
  // Extended thinking (adaptive reasoning) toggle
  thinkingEnabled?: boolean;
  // Thinking summary display toggle
  showThinking?: boolean;
  // Action panel state
  actionPanel?: ActionPanelState;
  // Bot-initiated thread metadata
  threadModel?: 'user-initiated' | 'bot-initiated';
  threadRootTs?: string;
  // Onboarding flag
  isOnboarding?: boolean;
  // Source working directories tracked for cleanup
  sourceWorkingDirs?: string[];
  // Mid-thread source thread reference
  sourceThread?: { channel: string; threadTs: string };
  // Session-unique working directory for workspace isolation (#77)
  sessionWorkingDir?: string;
  // Conversation record ID (links session to conversation history)
  conversationId?: string;
  // Merge code change stats
  mergeStats?: {
    totalLinesAdded: number;
    totalLinesDeleted: number;
    mergedPRs: Array<{
      prNumber: number;
      linesAdded: number;
      linesDeleted: number;
      mergedAt: number;
    }>;
  };
  // User SSOT instructions (persisted)
  instructions?: SessionInstruction[];
  // Host-managed session goal (persisted)
  goal?: SessionGoal;
  // Multi-goal queue + completed history (persisted — T1/T2).
  goalQueue?: SessionGoal[];
  goalHistory?: SessionGoal[];
  // SSOT 2026-10-22 T7/T8 — task ledger (ids, times, tool calls); sanitized on load.
  taskLedger?: unknown;
  // Spec 12 — the session's subagents (registry); sanitized on load.
  agents?: unknown;
  // When the activity state last changed — the DONE column's completion time for an idle card.
  activityStateChangedAt?: number;
  /**
   * Cached summary of completed instructions. Persisted so that
   * restart after a long session doesn't force a fresh summary re-build
   * on the very next turn (keeps prompt cache warm). See
   * `src/conversation/instructions-summarizer.ts`.
   */
  instructionsCompletedSummary?: { summary: string; upstreamHash: string };
  /**
   * The context fill, its window and the session totals (`ConversationSession.usage`),
   * without the runtime-only fold — see `toPersistedSessionUsage`; sanitized on load.
   */
  usage?: unknown;
  /** Last SDK running total per model — see `ConversationSession.sdkUsageBaseline`. */
  sdkUsageBaseline?: unknown;
  /** SSOT 2026-10-26 T3 — what the whole task spent; sanitized on load. */
  taskUsage?: unknown;
  // Dashboard v2.1 — thread-aggregate snapshot fields (live aggregate derived from memory).
  compactionCount?: number;
  activeLegStartedAtMs?: number;
  activeLegGoalId?: string;
  activeAccumulatedMs?: number;
  summaryTitle?: string;
  summaryTitleTurnId?: string;
  summaryTitleLastUpdatedAtMs?: number;
  /**
   * Typed handoff metadata parsed from a `<z-handoff>` sentinel (issue #695).
   * Persisted verbatim so downstream guards (#696/#697/#698) can consume the
   * structured state after restart or mid-session.
   */
  handoffContext?: HandoffContext;
  /**
   * Host-enforced auto-handoff budget (issue #697). See `ConversationSession`
   * for full contract. Persisted as primitive number; `undefined` on load
   * from pre-#697 disk state is handled defensively by `checkAndConsumeBudget`.
   */
  autoHandoffBudget?: number;
  /**
   * Session-scoped `/autocompact` token override. Persisted VERBATIM: the
   * safe-max clamp is a read-time decision of `resolveEffectiveAutoCompact`,
   * so a threshold that is temporarily too large for the current model still
   * round-trips unchanged.
   */
  autoCompactTokens?: number | null;
}

/**
 * Callbacks for session expiry events
 */
export interface SessionExpiryCallbacks {
  onWarning: (
    session: ConversationSession,
    timeRemaining: number,
    warningMessageTs?: string,
  ) => Promise<string | undefined>;
  onSleep: (session: ConversationSession) => Promise<void>;
  onExpiry: (session: ConversationSession) => Promise<void>;
}

/**
 * Why a session is about to be deleted from the registry.
 * `terminated` = explicit `terminateSession()`; `sleep-expired` = the sleeping
 * session outlived the policy archiveAfterMs during `cleanupInactiveSessions()`.
 */
export type SessionDeletionReason = 'terminated' | 'sleep-expired';

/**
 * Observer invoked immediately BEFORE a session is destroyed (archive +
 * source-dir cleanup + Map delete), while the session object is still
 * reachable and still registered.
 *
 * Contract:
 * - Synchronous. The host does its durable work here (e.g. persisting the
 *   cancellation of that session's queued follow-ups); anything it wants to
 *   render afterwards it must detach itself.
 * - Throwing is fail-closed: the registry keeps the session instead of
 *   deleting it, so host state keyed by this session is never orphaned.
 */
export type BeforeSessionDeleteCallback = (
  sessionKey: string,
  session: ConversationSession,
  reason: SessionDeletionReason,
) => void;

/**
 * Thrown by `terminateSession` when the deletion observer refused (threw): the
 * session is still live and registered.
 *
 * Refusal is a throw rather than a `false` return because callers routinely
 * ignore the boolean (e.g. `slack/actions/channel-route-action-handler.ts`
 * terminates and then routes on regardless), which would leave a live session
 * behind a UI that claims it was closed. `false` keeps its one existing
 * meaning: no session by that key.
 */
export class SessionDeleteRefusedError extends Error {
  public readonly sessionKey: string;
  public readonly reason: SessionDeletionReason;
  public readonly cause: unknown;

  constructor(sessionKey: string, reason: SessionDeletionReason, cause: unknown) {
    super(`Session deletion refused by beforeSessionDelete observer (${reason}): ${sessionKey}`);
    this.name = 'SessionDeleteRefusedError';
    this.sessionKey = sessionKey;
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * SessionRegistry manages all conversation sessions
 * - Session CRUD operations
 * - Session persistence (save/load)
 * - Session expiry and cleanup
 */
export interface CrashRecoveredSession {
  channelId: string;
  threadTs?: string;
  ownerId: string;
  ownerName?: string;
  activityState: string;
  sessionKey: string;
  /** Session title at the time of crash — gives the model context about what was happening */
  title?: string;
  /** Workflow type (default, jira-create-pr, pr-review, etc.) */
  workflow?: string;
  /**
   * Authoritative auto-resume decision for the recovery batch. Set by
   * `loadSessions()` from the `wasWorkingAtShutdown` marker when graceful
   * shutdown happened, or derived from `activityState === 'working'` when
   * falling back to the crash-recovery heuristic. `notifyCrashRecovery`
   * uses this flag (rather than the raw `activityState`) so a stale-but-
   * persisted `idle` doesn't suppress auto-resume for a session that was
   * actually mid-work.
   */
  shouldAutoResume: boolean;
}

/**
 * A persisted `pendingRetryDetail` back as the session carries it — finite
 * counts and a string reason only; anything else is dropped (disk JSON is
 * untrusted shape).
 */
function restorePendingRetryDetail(raw: unknown): ConversationSession['pendingRetryDetail'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    attempt: count(r.attempt),
    maxAttempts: count(r.maxAttempts),
    reason: typeof r.reason === 'string' ? r.reason : undefined,
  };
}

/** A saved epoch-ms stamp, or undefined when it is not a finite number. */
function finiteStamp(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export class SessionRegistry {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('SessionRegistry');
  private expiryCallbacks?: SessionExpiryCallbacks;
  private beforeSessionDelete?: BeforeSessionDeleteCallback;
  private _crashRecoveredSessions: CrashRecoveredSession[] = [];

  /**
   * onIdle callback registry — fired when session transitions to idle.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 5, Section 3b-3c
   */
  private onIdleCallbacks: Map<string, Array<() => void>> = new Map();

  /**
   * Optional hook fired after `drainOnIdleCallbacks` resolves for a
   * session that just transitioned to idle. Used by the ralph-loop
   * (auto-continuation) driver to decide whether to inject the next
   * synthetic continuation turn. Mirrors codex `goals.rs:1270`
   * (`maybe_continue_goal_if_idle_runtime`) — a thin host hook that the
   * goal subsystem owns, deliberately kept out of cron-scheduler state.
   *
   * Wired up in `src/index.ts` next to the existing cron-scheduler
   * setup so messageInjector / dependencies are colocated.
   */
  private onIdleAfterDrainHook?: (sessionKey: string) => void;

  /**
   * Install (or replace) the post-drain idle hook. Idempotent.
   */
  setOnIdleAfterDrainHook(hook: ((sessionKey: string) => void) | undefined): void {
    this.onIdleAfterDrainHook = hook;
  }

  /**
   * Fire-and-forget hook invoked when a session goes to sleep or expires, used
   * to consolidate that owner's hierarchical memory ("dreaming"). Keyed by
   * ownerId so a per-user LLM pass runs at most at the 24h sleep cadence, not
   * per turn. Must never throw.
   */
  private onSessionConsolidateHook?: (ownerId: string) => void;

  setOnSessionConsolidateHook(hook: ((ownerId: string) => void) | undefined): void {
    this.onSessionConsolidateHook = hook;
  }

  private fireSessionConsolidate(ownerId: string | undefined): void {
    if (!ownerId || !this.onSessionConsolidateHook) return;
    try {
      this.onSessionConsolidateHook(ownerId);
    } catch (error) {
      this.logger.warn('onSessionConsolidateHook failed', {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Callback fired whenever any session's activity state changes.
   * Used by the dashboard WebSocket to push real-time updates.
   */
  private onActivityStateChangeCallback?: () => void;

  /**
   * Set callbacks for session expiry events
   */
  setExpiryCallbacks(callbacks: SessionExpiryCallbacks): void {
    this.expiryCallbacks = callbacks;
  }

  /**
   * Register the deletion-lifecycle observer. Deliberately a slot of its own:
   * `setExpiryCallbacks` is a single slot already owned by the EventRouter, and
   * this seam fires on the `terminateSession` path too, which has no expiry
   * callback at all.
   */
  setBeforeSessionDelete(callback: BeforeSessionDeleteCallback): void {
    this.beforeSessionDelete = callback;
  }

  /**
   * Run the deletion observer. Throws `SessionDeleteRefusedError` when the
   * observer refused (threw), in which case the caller MUST leave the session
   * untouched — the host's durable state for this session could not be settled,
   * and deleting anyway would orphan it. The session stays deletable by the
   * next attempt/sweep.
   */
  private fireBeforeSessionDelete(
    sessionKey: string,
    session: ConversationSession,
    reason: SessionDeletionReason,
  ): void {
    if (!this.beforeSessionDelete) return;
    try {
      this.beforeSessionDelete(sessionKey, session, reason);
    } catch (error) {
      this.logger.error('beforeSessionDelete hook refused deletion — session retained (fail-closed)', {
        sessionKey,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new SessionDeleteRefusedError(sessionKey, reason, error);
    }
  }

  /**
   * Register callback for activity state changes (e.g., dashboard WebSocket broadcast)
   */
  setActivityStateChangeCallback(callback: () => void): void {
    this.onActivityStateChangeCallback = callback;
  }

  /**
   * Fire the activity-state/session-update callback without changing session state.
   * Used by turn-timer / compaction-counter paths so dashboard reflects changes.
   */
  broadcastSessionUpdate(): void {
    try {
      this.onActivityStateChangeCallback?.();
    } catch (err) {
      this.logger.debug('broadcastSessionUpdate failed', { error: err });
    }
  }

  /**
   * Persist all sessions to disk AND push a dashboard update.
   *
   * Use this after mutating session state that the dashboard consumes
   * (pendingQuestion, pendingChoice, waitingForChoice, etc.) OUTSIDE of an
   * activity-state transition. `setActivityState` only persists on transition
   * to 'idle' and broadcasts only on state change, so holding state in 'waiting'
   * while mutating pending fields would otherwise leave disk and dashboard stale.
   *
   * Cost: one disk write + one websocket push per call. Keep call sites bounded
   * to real state transitions (set/clear of pendingChoice/pendingQuestion) —
   * not every render.
   *
   * `sessionKey` parameter is currently advisory (for logging / future
   * targeted broadcasts). The underlying broadcast API is global today.
   */
  public persistAndBroadcast(sessionKey: string): void {
    this.saveSessions();
    try {
      this.onActivityStateChangeCallback?.();
    } catch (err) {
      this.logger.warn('persistAndBroadcast: broadcast callback raised', {
        sessionKey,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  /**
   * Get session key - based on channel and thread only (shared session).
   * Canonical format is the shared soma-lib identity model
   * (`work:<channel>:<thread>`) — see src/session-identity.ts.
   */
  getSessionKey(channelId: string, threadTs?: string): string {
    return buildWorkSessionKey(channelId, threadTs);
  }

  /**
   * Get a session by channel and thread
   */
  getSession(channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(channelId, threadTs));
  }

  /**
   * Get a session by its key directly. Accepts legacy `<channel>-<thread>`
   * keys (e.g. from Slack action payloads posted before the Step 4d key
   * format switch) via normalization.
   */
  getSessionByKey(sessionKey: string): ConversationSession | undefined {
    return this.sessions.get(normalizeSessionKey(sessionKey));
  }

  /**
   * Find a session that was created from a mid-thread mention in the given thread.
   * Reverse lookup: original thread → bot-initiated session.
   */
  findSessionBySourceThread(channel: string, threadTs: string): ConversationSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sourceThread?.channel === channel && session.sourceThread?.threadTs === threadTs) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Map<string, ConversationSession> {
    return this.sessions;
  }

  /**
   * Clear the cached `systemPrompt` for every session owned by `userId` so
   * the next turn rebuilds against fresh SSOT (memory, persona, settings).
   * Centralised here to keep external mutators out of `getAllSessions()`
   * iteration; returns the number of sessions touched for tests/logs.
   */
  invalidateSystemPromptForUser(userId: string): number {
    if (!userId) return 0;
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.ownerId !== userId) continue;
      if (session.systemPrompt === undefined) continue;
      session.systemPrompt = undefined;
      count += 1;
    }
    if (count > 0) {
      this.logger.debug('Invalidated systemPrompt for user sessions', { userId, count });
    }
    return count;
  }

  /**
   * Dashboard v2.1 — Turn timer hooks (called from stream-executor).
   * Kept on the registry so tests can exercise the timer + persistence path
   * without booting the full Slack pipeline.
   */
  beginTurn(session: ConversationSession, now: number = Date.now()): void {
    // Fold any stale leg first (MAX_LEG_MS cap covers crash / missed endTurn).
    // Credit the PREVIOUS leg to its recorded owner (`activeLegGoalId` still
    // holds the prior leg's owner here) BEFORE re-stamping the owner below.
    if (session.activeLegStartedAtMs) {
      const elapsed = Math.min(now - session.activeLegStartedAtMs, MAX_LEG_MS);
      session.activeAccumulatedMs = (session.activeAccumulatedMs || 0) + Math.max(0, elapsed);
      creditActiveGoalMs(session, Math.max(0, elapsed));
    }
    session.activeLegStartedAtMs = now;
    // Capture the goal (id + intent epoch) that owns THIS leg — see
    // `stampActiveLegGoalOwner` for why the owner is pinned per leg.
    stampActiveLegGoalOwner(session);
  }

  endTurn(session: ConversationSession, now: number = Date.now()): void {
    if (session.activeLegStartedAtMs) {
      const elapsed = Math.min(now - session.activeLegStartedAtMs, MAX_LEG_MS);
      session.activeAccumulatedMs = (session.activeAccumulatedMs || 0) + Math.max(0, elapsed);
      creditActiveGoalMs(session, Math.max(0, elapsed));
    }
    session.activeLegStartedAtMs = undefined;
  }

  /**
   * Live thread-level aggregate derived from in-memory sessions sharing a threadKey.
   * Returns derived totals — never a persisted top-level store.
   */
  getThreadAggregate(
    channelId: string,
    threadTs: string | undefined,
    now: number = Date.now(),
  ): { totalActiveMs: number; sessionCount: number; compactionCount: number } {
    // Match on session FIELDS, not a constructed key — the shared identity
    // builder throws on separator characters, and aggregation must stay
    // total even over hostile/corrupt in-memory data.
    let totalActiveMs = 0;
    let sessionCount = 0;
    let compactionCount = 0;
    for (const s of this.sessions.values()) {
      if (s.channelId !== channelId || (s.threadTs || undefined) !== (threadTs || undefined)) continue;
      sessionCount += 1;
      compactionCount += s.compactionCount || 0;
      let acc = s.activeAccumulatedMs || 0;
      if (s.activeLegStartedAtMs) {
        acc += Math.min(now - s.activeLegStartedAtMs, MAX_LEG_MS);
      }
      totalActiveMs += acc;
    }
    return { totalActiveMs, sessionCount, compactionCount };
  }

  /**
   * Create a new session
   */
  createSession(
    ownerId: string,
    ownerName: string,
    channelId: string,
    threadTs?: string,
    model?: string,
  ): ConversationSession {
    // Get user's default model if not provided
    const sessionModel = model || userSettingsStore.getUserDefaultModel(ownerId);

    const session: ConversationSession = {
      ownerId,
      ownerName,
      userId: ownerId, // Legacy field
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
      model: sessionModel,
      logVerbosity: userSettingsStore.getUserLogVerbosityFlags(ownerId),
      effort: userSettingsStore.getUserDefaultEffort(ownerId),
      state: 'INITIALIZING', // Start in INITIALIZING state
      activityState: 'idle',
      // Host-enforced auto-handoff budget (#697). Fresh sessions start with
      // DEFAULT_AUTO_HANDOFF_BUDGET=1; consumed in slack-handler.onResetSession.
      autoHandoffBudget: DEFAULT_AUTO_HANDOFF_BUDGET,
      // Compaction Tracking (#617): explicit zero-state for epoch-based dedupe.
      compactEpoch: 0,
      compactPostedByEpoch: {},
      compactionRehydratedByEpoch: {},
      preCompactUsagePct: null,
      lastKnownUsagePct: null,
      // #617 followup: SDK-authoritative compact_metadata snapshot.
      compactPreTokens: null,
      compactPostTokens: null,
      compactTrigger: null,
      compactDurationMs: null,
      compactStartingMessageTs: null,
      compactStartedAtMs: null,
      autoCompactPending: false,
      pendingUserText: null,
      pendingEventContext: null,
    };

    this.sessions.set(this.getSessionKey(channelId, threadTs), session);

    // Metrics: emit session_created event (fire-and-forget)
    getMetricsEmitter()
      .emitSessionCreated(session)
      .catch((err) => this.logger.debug('metrics emit failed', err));

    return session;
  }

  /**
   * Transition session from INITIALIZING to MAIN state
   * Sets the workflow type determined by dispatch
   * @returns true if transition succeeded, false if session not found or already transitioned
   */
  transitionToMain(channelId: string, threadTs: string | undefined, workflow: WorkflowType, title?: string): boolean {
    const session = this.getSession(channelId, threadTs);
    if (!session) {
      this.logger.debug('transitionToMain: session not found', { channelId, threadTs });
      return false;
    }

    if (session.state !== 'INITIALIZING') {
      // This is expected in race conditions where another dispatch completed first
      // Use debug level to avoid noisy logs
      this.logger.debug('Session already transitioned (idempotent)', {
        channelId,
        threadTs,
        currentState: session.state,
        currentWorkflow: session.workflow,
        attemptedWorkflow: workflow,
      });
      return false;
    }

    session.state = 'MAIN';
    session.workflow = workflow;
    if (title && !session.title) {
      session.title = title;
    }
    this.logger.info('Session transitioned to MAIN', {
      channelId,
      threadTs,
      workflow,
    });
    this.saveSessions();
    return true;
  }

  /**
   * Check if session needs dispatch (is in INITIALIZING state)
   */
  needsDispatch(channelId: string, threadTs?: string): boolean {
    const session = this.getSession(channelId, threadTs);
    return session?.state === 'INITIALIZING';
  }

  /**
   * Check if session is sleeping
   */
  isSleeping(channelId: string, threadTs?: string): boolean {
    const session = this.getSession(channelId, threadTs);
    return session?.state === 'SLEEPING';
  }

  /**
   * Wake session from SLEEPING back to MAIN state
   * Called when user sends a message to a sleeping session
   */
  wakeFromSleep(channelId: string, threadTs?: string): boolean {
    const session = this.getSession(channelId, threadTs);
    if (!session || session.state !== 'SLEEPING') return false;

    session.state = 'MAIN';
    session.sleepStartedAt = undefined;
    session.lastActivity = new Date();
    // Clear warning state
    session.warningMessageTs = undefined;
    session.lastWarningSentAt = undefined;

    this.logger.info('Session woken from sleep', {
      channelId,
      threadTs,
      sessionId: session.sessionId,
      owner: session.ownerName,
    });
    this.saveSessions();
    return true;
  }

  // ── Dashboard star + revive (SSOT 2026-10-30) ──────────────────────

  /**
   * Star or unstar a live session. A starred session is pinned on top of the
   * board and kept alive: the sweep and the restart loader never sleep or
   * archive it (T3). Starring a sleeping session wakes it (T5). Unstarring
   * starts a fresh grace period (`starClearedAt`, see idleSinceMs) so it does
   * not sleep on the very next sweep. Either way the expiry-warning state is
   * cleared — it belonged to a countdown that no longer applies.
   *
   * A session object already marked terminated (mid-expiry or mid-close, the
   * Map entry not yet gone) refuses: the star would vanish with it.
   */
  setStarred(sessionKey: string, starred: boolean): SessionLifecycleOutcome {
    const key = normalizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (!session) return { ok: false, code: 'not_found', message: '세션을 찾을 수 없어요' };
    if (session.terminated) return { ok: false, code: 'terminated', message: '종료 중인 세션이에요' };
    // Trashed = hidden from the board; a star pins it on top. The two exclude each other.
    if (starred && session.trashed) {
      return { ok: false, code: 'conflict', message: '휴지통에 있는 세션에는 별을 달 수 없어요' };
    }

    const revived = starred && session.state === 'SLEEPING';
    if (revived) this.wakeSession(session);
    if (starred) {
      session.starred = true;
    } else if (session.starred) {
      session.starred = undefined;
      session.starClearedAt = Date.now();
    }
    session.warningMessageTs = undefined;
    session.lastWarningSentAt = undefined;
    this.logger.info(starred ? 'Session starred' : 'Session unstarred', {
      sessionKey: key,
      sessionId: session.sessionId,
      revived,
    });
    this.saveSessions();
    return { ok: true, sessionKey: key, starred: session.starred === true, revived };
  }

  /**
   * Revive a live session from the dashboard (T4.1): a sleeping one wakes, so
   * its next message resumes the same SDK session; an awake one is left as it
   * is (`revived: false`).
   */
  reviveSession(sessionKey: string): SessionLifecycleOutcome {
    const key = normalizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (!session) return { ok: false, code: 'not_found', message: '세션을 찾을 수 없어요' };
    if (session.terminated) return { ok: false, code: 'terminated', message: '종료 중인 세션이에요' };
    const revived = session.state === 'SLEEPING';
    if (revived) {
      this.wakeSession(session);
      this.logger.info('Session revived from the dashboard', { sessionKey: key, sessionId: session.sessionId });
      this.saveSessions();
    }
    return { ok: true, sessionKey: key, starred: session.starred === true, revived };
  }

  /**
   * Bring an archived session back into the registry so the conversation
   * continues (T4.2): the same SDK session (`resume`), the cwd its transcript
   * is filed under (`cwd`, proven by resolveArchivedResume), the same
   * conversation record, and what the card showed (links, goal, tasks,
   * agents, totals). The work directory's files are not restored — the
   * directory is recreated empty by the next turn.
   *
   * The thread may already hold a session (a Slack message after the archive
   * started one, a double click): the same conversation → its key is answered
   * (woken if asleep); another conversation → conflict; another owner →
   * forbidden; a terminated object → terminated. Nothing live is replaced.
   * The lookup and the insert run with no await between them.
   */
  restoreArchivedSession(archived: ArchivedSession, cwd: string): SessionLifecycleOutcome {
    const key = this.getSessionKey(archived.channelId, archived.threadTs);
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.terminated) return { ok: false, code: 'terminated', message: '종료 중인 세션이에요' };
      if (existing.ownerId !== archived.ownerId) {
        return { ok: false, code: 'forbidden', message: '이 스레드에는 다른 사람의 세션이 살아 있어요' };
      }
      const same =
        (!!archived.sessionId && existing.sessionId === archived.sessionId) ||
        (!!archived.conversationId && existing.conversationId === archived.conversationId);
      if (!same) {
        return { ok: false, code: 'conflict', message: '이 스레드에는 이미 다른 대화가 진행 중이에요' };
      }
      return this.reviveSession(key);
    }

    const model = archived.model === undefined ? undefined : coerceToAvailableModel(archived.model);
    const doneAt = finiteStamp(archived.doneAt);
    const session: ConversationSession = {
      ownerId: archived.ownerId,
      ownerName: archived.ownerName,
      userId: archived.ownerId, // Legacy field
      channelId: archived.channelId,
      threadTs: archived.threadTs,
      sessionId: archived.sessionId,
      conversationId: archived.conversationId,
      isActive: true,
      // The revive is the user's own action: the idle clock starts now.
      lastActivity: new Date(),
      title: archived.title,
      summaryTitle: archived.summaryTitle,
      model,
      logVerbosity: userSettingsStore.getUserLogVerbosityFlags(archived.ownerId),
      effort: userSettingsStore.getUserDefaultEffort(archived.ownerId),
      state: 'MAIN',
      workflow: archived.workflow || 'default',
      activityState: 'idle',
      // Its work finished when the archive says it did (spec 13 §3.7).
      activityStateChangedAt: doneAt,
      links: archived.links,
      linkHistory: archived.linkHistory,
      instructions: Array.isArray(archived.instructions)
        ? archived.instructions.map((i) => ({ ...i, status: i.status ?? 'active' }))
        : [],
      mergeStats: archived.mergeStats,
      goal: migrateLegacyGoal(archived.goal),
      goalHistory: migrateLegacyGoalArray(archived.goalHistory),
      taskLedger: sanitizeTaskLedger(archived.taskLedger),
      agents: loseRunningAgents(sanitizeAgentRegistry(archived.agents), Date.now()),
      taskUsage: restoreTaskUsage({ taskUsage: archived.taskUsage, sessionId: archived.sessionId }),
      usage: restoreSessionUsage(archived.usage, model),
      cronJob: sanitizeCronJob(archived.cronJob),
      compactionCount: typeof archived.compactionCount === 'number' ? archived.compactionCount : 0,
      activeAccumulatedMs: typeof archived.busyMs === 'number' ? archived.busyMs : 0,
      sessionWorkingDir: cwd,
      // Registered for cleanup like a fresh session's dir; the next turn recreates it.
      sourceWorkingDirs: [cwd],
      // Incident ownership comes back with it: the thread stays restricted.
      incidentRequest: archived.incidentRequest,
      incidentAttemptFinishedId: archived.incidentAttemptFinishedId,
      autoHandoffBudget: DEFAULT_AUTO_HANDOFF_BUDGET,
      compactEpoch: 0,
      compactPostedByEpoch: {},
      compactionRehydratedByEpoch: {},
      preCompactUsagePct: null,
      lastKnownUsagePct: null,
      compactPreTokens: null,
      compactPostTokens: null,
      compactTrigger: null,
      compactDurationMs: null,
      compactStartingMessageTs: null,
      compactStartedAtMs: null,
      autoCompactPending: false,
      pendingUserText: null,
      pendingEventContext: null,
    };
    this.sessions.set(key, session);
    this.logger.info('Archived session restored from the dashboard', {
      sessionKey: key,
      sessionId: session.sessionId,
      archivedAt: archived.archivedAt,
      archiveReason: archived.archiveReason,
    });
    this.saveSessions();
    return { ok: true, sessionKey: key, starred: false, revived: true };
  }

  /** SLEEPING → MAIN, the way a Slack message wakes it (wakeFromSleep). */
  private wakeSession(session: ConversationSession): void {
    session.state = 'MAIN';
    session.sleepStartedAt = undefined;
    session.lastActivity = new Date();
    session.warningMessageTs = undefined;
    session.lastWarningSentAt = undefined;
  }

  /**
   * Set activity state for a session (working/waiting/idle)
   * Only persists on transition to idle (to avoid excessive disk writes during active work)
   */
  setActivityState(channelId: string, threadTs: string | undefined, state: ActivityState): void {
    const session = this.getSession(channelId, threadTs);
    if (!session) return;
    if (session.activityState === state) return; // No-op for duplicate transitions

    session.activityState = state;
    session.activityStateChangedAt = Date.now();

    this.logger.debug('Activity state changed', {
      channelId,
      threadTs,
      state,
    });

    // Notify dashboard WebSocket clients
    try {
      this.onActivityStateChangeCallback?.();
    } catch {
      /* fire-and-forget */
    }

    // Only persist on idle transition to minimize disk I/O
    if (state === 'idle') {
      this.saveSessions();
      // Drain onIdle callbacks (e.g., pending cron jobs)
      // Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 5, Section 3b
      const sessionKey = this.getSessionKey(channelId, threadTs);
      this.drainOnIdleCallbacks(sessionKey);
      // Goal ralph-loop hook fires after cron drain so cron jobs win when
      // both are queued for the same idle window. Mirrors codex
      // `goals.rs:1270` (`maybe_continue_goal_if_idle_runtime`).
      this.fireOnIdleAfterDrainHook(sessionKey);
    }
  }

  /**
   * Set activity state by session key
   */
  setActivityStateByKey(sessionKey: string, state: ActivityState): void {
    sessionKey = normalizeSessionKey(sessionKey);
    const session = this.getSessionByKey(sessionKey);
    if (!session) return;
    if (session.activityState === state) return;

    session.activityState = state;
    session.activityStateChangedAt = Date.now();
    this.logger.debug('Activity state changed', { sessionKey, state });

    // Notify dashboard WebSocket clients (was missing — caused stale dashboard state)
    try {
      this.onActivityStateChangeCallback?.();
    } catch (err) {
      this.logger.debug('Activity state change callback failed', { sessionKey, state, error: err });
    }

    if (state === 'idle') {
      this.saveSessions();
      // Drain onIdle callbacks (e.g., pending cron jobs)
      this.drainOnIdleCallbacks(sessionKey);
      // Goal ralph-loop hook (see setActivityState).
      this.fireOnIdleAfterDrainHook(sessionKey);
    }
  }

  /**
   * Fire the optional post-drain idle hook. Fire-and-forget; errors
   * are swallowed so the goal driver can never destabilize the
   * activity-state machine.
   */
  private fireOnIdleAfterDrainHook(sessionKey: string): void {
    const hook = this.onIdleAfterDrainHook;
    if (!hook) return;
    try {
      hook(sessionKey);
    } catch (error: any) {
      this.logger.warn('onIdleAfterDrainHook failed', { sessionKey, error: error?.message });
    }
  }

  /**
   * Get activity state by session key
   */
  getActivityStateByKey(sessionKey: string): ActivityState | undefined {
    const session = this.getSessionByKey(sessionKey);
    return session?.activityState;
  }

  /**
   * Register a callback to be fired when a session transitions to idle.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 5, Section 3c
   */
  registerOnIdle(sessionKey: string, callback: () => void): void {
    sessionKey = normalizeSessionKey(sessionKey);
    const existing = this.onIdleCallbacks.get(sessionKey) || [];
    existing.push(callback);
    this.onIdleCallbacks.set(sessionKey, existing);
    this.logger.debug('Registered onIdle callback', { sessionKey, total: existing.length });
  }

  /**
   * Drain and execute all onIdle callbacks for a session.
   * Fire-and-forget: each callback wrapped in try/catch.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 5, Section 3b
   */
  private drainOnIdleCallbacks(sessionKey: string): void {
    const callbacks = this.onIdleCallbacks.get(sessionKey);
    if (!callbacks || callbacks.length === 0) return;

    this.logger.debug('Draining onIdle callbacks', { sessionKey, count: callbacks.length });
    this.onIdleCallbacks.delete(sessionKey);

    for (const cb of callbacks) {
      try {
        cb();
      } catch (error: any) {
        this.logger.warn('onIdle callback failed', { sessionKey, error: error?.message });
      }
    }
  }

  /**
   * Clear onIdle callbacks for a session (e.g., on session removal).
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 5, Section 5
   */
  clearOnIdleCallbacks(sessionKey: string): void {
    this.onIdleCallbacks.delete(normalizeSessionKey(sessionKey));
  }

  /**
   * Set session title (typically auto-generated from first Q&A).
   * Only sets if title is not already present.
   */
  setSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    const session = this.getSession(channelId, threadTs);
    const clean = sanitizeSessionTitle(title);
    // A provisional title (a cron job name, SSOT 2026-10-23 T2) is a
    // placeholder — the first real title replaces it.
    if (session && clean && (!session.title || session.titleProvisional)) {
      session.title = clean;
      session.titleProvisional = undefined;
      this.saveSessions();
    }
  }

  /**
   * Update session title unconditionally (e.g. when issue is linked or PR is merged).
   * Unlike setSessionTitle, this overwrites existing title. A candidate that
   * sanitizes to nothing leaves the current title in place.
   */
  updateSessionTitle(channelId: string, threadTs: string | undefined, title: string): void {
    const session = this.getSession(channelId, threadTs);
    const clean = sanitizeSessionTitle(title);
    if (session && clean) {
      session.title = clean;
      session.titleProvisional = undefined;
      this.saveSessions();
    }
  }

  /**
   * Fill-only title write for intent titles (UPDATE_SESSION `titleFillOnly`).
   * Overwrites only a host-written stand-in title ("New Session" and friends)
   * or a provisional title (a cron job name), checked here at apply time — so a deliberate title set between the model
   * reading the notice and this write is never clobbered. Returns whether the
   * title was written.
   */
  fillPlaceholderSessionTitle(channelId: string, threadTs: string | undefined, title: string): boolean {
    const session = this.getSession(channelId, threadTs);
    const clean = sanitizeSessionTitle(title);
    if (!session || !clean) return false;
    // Host stand-in ("New Session" and friends) or a provisional cron job name.
    if (!isPlaceholderSessionTitle(session.title) && !session.titleProvisional) return false;
    session.title = clean;
    session.titleProvisional = undefined;
    this.saveSessions();
    return true;
  }

  /**
   * Record merge code change stats (lines added/deleted) for a merged PR in this session.
   */
  addMergeStats(
    channelId: string,
    threadTs: string | undefined,
    prNumber: number,
    linesAdded: number,
    linesDeleted: number,
  ): void {
    const session = this.getSession(channelId, threadTs);
    if (!session) return;

    if (!session.mergeStats) {
      session.mergeStats = { totalLinesAdded: 0, totalLinesDeleted: 0, mergedPRs: [] };
    }

    session.mergeStats.totalLinesAdded += linesAdded;
    session.mergeStats.totalLinesDeleted += linesDeleted;
    session.mergeStats.mergedPRs.push({
      prNumber,
      linesAdded,
      linesDeleted,
      mergedAt: Date.now(),
    });
    this.saveSessions();
  }

  /**
   * Set a link on a session (issue, pr, or doc)
   */
  setSessionLink(channelId: string, threadTs: string | undefined, link: SessionLink): void {
    this.updateSessionResources(channelId, threadTs, {
      operations: [
        {
          action: 'add',
          resourceType: link.type,
          link,
        },
      ],
    });
  }

  /**
   * Set multiple session links at once
   */
  setSessionLinks(channelId: string, threadTs: string | undefined, links: SessionLinks): void {
    const operations: SessionResourceOperation[] = [];

    if (links.issue) {
      operations.push({
        action: 'add',
        resourceType: 'issue',
        link: links.issue,
      });
    }
    if (links.pr) {
      operations.push({
        action: 'add',
        resourceType: 'pr',
        link: links.pr,
      });
    }
    if (links.doc) {
      operations.push({
        action: 'add',
        resourceType: 'doc',
        link: links.doc,
      });
    }

    if (operations.length === 0) {
      return;
    }

    this.updateSessionResources(channelId, threadTs, { operations });
  }

  /**
   * Refresh session activity by session key.
   */
  refreshSessionActivityByKey(sessionKey: string): boolean {
    const session = this.getSessionByKey(sessionKey);
    if (!session) return false;
    session.lastActivity = new Date();
    session.lastWarningSentAt = undefined;
    session.warningMessageTs = undefined;
    this.saveSessions();
    return true;
  }

  /**
   * Get current session resource snapshot used by model-command tool.
   */
  getSessionResourceSnapshot(channelId: string, threadTs?: string): SessionResourceSnapshot {
    const session = this.getSession(channelId, threadTs);
    return this.buildSessionResourceSnapshot(session);
  }

  /**
   * Update session resources (issues/prs/docs + active links) with optimistic locking.
   */
  updateSessionResources(
    channelId: string,
    threadTs: string | undefined,
    request: SessionResourceUpdateRequest,
  ): SessionResourceUpdateResult {
    const session = this.getSession(channelId, threadTs);
    if (!session) {
      return {
        ok: false,
        reason: 'SESSION_NOT_FOUND',
        error: 'Session not found',
        snapshot: this.buildSessionResourceSnapshot(undefined),
      };
    }

    this.ensureSessionLinkState(session);

    const currentSequence = session.linkSequence ?? 0;
    if (typeof request.expectedSequence === 'number' && request.expectedSequence !== currentSequence) {
      return {
        ok: false,
        reason: 'SEQUENCE_MISMATCH',
        error: 'Session sequence mismatch',
        sequenceMismatch: {
          expected: request.expectedSequence,
          actual: currentSequence,
        },
        snapshot: this.buildSessionResourceSnapshot(session),
      };
    }

    const applyResult = this.applySessionResourceOperations(session, request.operations ?? []);
    if (!applyResult.ok) {
      return {
        ok: false,
        reason: 'INVALID_OPERATION',
        error: applyResult.error,
        snapshot: this.buildSessionResourceSnapshot(session),
      };
    }

    // Apply instruction operations (shared helper)
    if (!session.instructions) {
      session.instructions = [];
    }
    const instructionChanged = applyInstructionOperations(session.instructions, request.instructionOperations);

    if (applyResult.changed || instructionChanged) {
      session.linkSequence = (session.linkSequence ?? 0) + 1;
      this.saveSessions();
    }

    if (instructionChanged) {
      // PLAN §2 & §5 — SSOT change invalidates the cached systemPrompt and
      // may stale the completed-summary. Clearing the snapshot forces the
      // next buildSystemPrompt() to rebuild; the summary regen is fire-and-
      // forget so it never blocks the write path.
      session.systemPrompt = undefined;
      this.scheduleInstructionsSummaryRegen(session);
    }

    return {
      ok: true,
      snapshot: this.buildSessionResourceSnapshot(session),
    };
  }

  /**
   * Fire-and-forget: regenerate the completed-instructions summary if the
   * cached hash no longer matches the current completed subset. Kept as a
   * private method (rather than a free function call at the import-site)
   * so tests can stub it out cheaply.
   *
   * NOTE: imports the summariser lazily to avoid pulling
   * `@anthropic-ai/claude-agent-sdk` into the session-registry import
   * chain — tests that only touch registry state (migration, reset, etc)
   * shouldn't need the SDK.
   */
  private scheduleInstructionsSummaryRegen(session: ConversationSession): void {
    // Lazy import + eager promise swallow — this is intentionally a noop
    // when the summariser fails (no credentials, network, etc).
    import('./conversation/instructions-summarizer')
      .then(({ regenerateInstructionsSummaryIfStale }) => regenerateInstructionsSummaryIfStale(session))
      .catch((err) => this.logger.debug('Summary regen dispatch failed', { err }));
  }

  private buildSessionResourceSnapshot(session: ConversationSession | undefined): SessionResourceSnapshot {
    if (!session) {
      return {
        issues: [],
        prs: [],
        docs: [],
        active: {},
        instructions: [],
        sequence: 0,
      };
    }

    this.ensureSessionLinkState(session);
    const history = session.linkHistory!;
    return {
      issues: history.issues.map((link) => ({ ...link })),
      prs: history.prs.map((link) => ({ ...link })),
      docs: history.docs.map((link) => ({ ...link })),
      active: {
        issue: session.links?.issue ? { ...session.links.issue } : undefined,
        pr: session.links?.pr ? { ...session.links.pr } : undefined,
        doc: session.links?.doc ? { ...session.links.doc } : undefined,
      },
      instructions: (session.instructions || []).map((i) => ({ ...i })),
      sequence: session.linkSequence ?? 0,
    };
  }

  private ensureSessionLinkState(session: ConversationSession): void {
    if (!session.links) {
      session.links = {};
    }

    if (!session.linkHistory) {
      session.linkHistory = {
        issues: [],
        prs: [],
        docs: [],
      };
    }

    for (const resourceType of Object.keys(HISTORY_KEY_BY_RESOURCE) as SessionResourceType[]) {
      const historyKey = HISTORY_KEY_BY_RESOURCE[resourceType];
      const activeKey = ACTIVE_KEY_BY_RESOURCE[resourceType];

      const deduped = new Map<string, SessionLink>();
      for (const link of session.linkHistory[historyKey]) {
        if (!link?.url) continue;
        deduped.set(link.url, this.normalizeSessionLink(link, resourceType));
      }

      const activeLink = session.links[activeKey];
      if (activeLink?.url) {
        deduped.set(activeLink.url, this.normalizeSessionLink(activeLink, resourceType));
      }

      const normalizedHistory = Array.from(deduped.values());
      session.linkHistory[historyKey] = normalizedHistory;

      if (activeLink?.url) {
        const foundActive = normalizedHistory.find((link) => link.url === activeLink.url);
        session.links[activeKey] = foundActive ? { ...foundActive } : undefined;
      }
    }

    if (!Number.isInteger(session.linkSequence)) {
      session.linkSequence = 0;
    }

    if (!Number.isInteger(session.linkRefreshGeneration)) {
      // Backfill on legacy sessions / pre-#762 disk state — start at 0 so the
      // first fire-and-forget refresh sees a stable baseline.
      session.linkRefreshGeneration = 0;
    }
  }

  private applySessionResourceOperations(
    session: ConversationSession,
    operations: SessionResourceOperation[],
  ): { ok: true; changed: boolean } | { ok: false; changed: boolean; error: string } {
    this.ensureSessionLinkState(session);

    let changed = false;

    for (const operation of operations) {
      const historyKey = HISTORY_KEY_BY_RESOURCE[operation.resourceType];
      const activeKey = ACTIVE_KEY_BY_RESOURCE[operation.resourceType];
      const history = session.linkHistory![historyKey];

      if (operation.action === 'add') {
        if (!operation.link?.url) {
          return {
            ok: false,
            changed,
            error: `add operation requires link url (${operation.resourceType})`,
          };
        }

        const normalized = this.normalizeSessionLink(operation.link, operation.resourceType);
        const existingIndex = history.findIndex((link) => link.url === normalized.url);
        if (existingIndex >= 0) {
          history.splice(existingIndex, 1);
        }
        history.push(normalized);
        session.links![activeKey] = { ...normalized };
        changed = true;

        // Metrics: emit GitHub events on resource link changes (fire-and-forget)
        // NOTE: pr_created / pr_merged are emitted exclusively from tool-result-interceptor.ts
        //       (single source of truth via stdout parsing). Only issue_created is emitted here.
        if (existingIndex < 0 && operation.resourceType === 'issue') {
          const emitter = getMetricsEmitter();
          const sessionKey = this.getSessionKey(session.channelId, session.threadTs);
          emitter
            .emitGitHubEvent('issue_created', session.ownerId, session.ownerName || 'unknown', sessionKey, {
              url: normalized.url,
            })
            .catch((err) => this.logger.debug('metrics emit failed', err));
        }

        continue;
      }

      if (operation.action === 'remove') {
        const existingIndex = history.findIndex((link) => link.url === operation.url);
        if (existingIndex >= 0) {
          history.splice(existingIndex, 1);
          changed = true;
        }

        if (session.links![activeKey]?.url === operation.url) {
          session.links![activeKey] = history.length > 0 ? { ...history[history.length - 1] } : undefined;
          changed = true;
        }
        continue;
      }

      if (!operation.url) {
        if (session.links![activeKey]) {
          session.links![activeKey] = undefined;
          changed = true;
        }
        continue;
      }

      const found = history.find((link) => link.url === operation.url);
      if (!found) {
        return {
          ok: false,
          changed,
          error: `set_active target not found in ${operation.resourceType} history: ${operation.url}`,
        };
      }

      if (session.links![activeKey]?.url !== found.url) {
        session.links![activeKey] = { ...found };
        changed = true;
      }
    }

    return { ok: true, changed };
  }

  private normalizeSessionLink(link: SessionLink, type: SessionResourceType): SessionLink {
    return {
      ...link,
      type,
      provider: link.provider || 'unknown',
    };
  }

  /**
   * Update the current initiator of a session
   */
  updateInitiator(channelId: string, threadTs: string | undefined, initiatorId: string, initiatorName: string): void {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      session.currentInitiatorId = initiatorId;
      session.currentInitiatorName = initiatorName;
      session.lastActivity = new Date();
    }
  }

  /**
   * Check if a user can interrupt the current response
   * Only owner or current initiator can interrupt
   */
  canInterrupt(channelId: string, threadTs: string | undefined, userId: string): boolean {
    const session = this.getSession(channelId, threadTs);
    if (!session) return true;
    return session.ownerId === userId || session.currentInitiatorId === userId;
  }

  // ---------------------------------------------------------------------------
  // Session-scoped dangerous-rule overrides
  //
  // When a user clicks "Approve & disable rule for this session" in the Slack
  // permission prompt, the rule id(s) are added to `session.disabledDangerousRules`
  // so subsequent auto-mode Bash commands matching only those rules no longer
  // escalate. In-memory only — a process restart clears the set intentionally.
  // The rule catalog is soma-lib's `DANGEROUS_RULES`, re-exported by
  // `somalib/permission/dangerous-rules.ts`.
  // ---------------------------------------------------------------------------

  /**
   * Mark dangerous rules as disabled for the given session key, atomically
   * with a single session lookup and a single summary log line. Creates the
   * backing Set on first use. No-op if the session is unknown — the caller is
   * expected to have already checked; we log at debug instead of throwing
   * because racing with session cleanup is expected.
   */
  disableDangerousRules(sessionKey: string, ruleIds: ReadonlyArray<string>): void {
    if (ruleIds.length === 0) return;
    const session = this.sessions.get(normalizeSessionKey(sessionKey));
    if (!session) {
      this.logger.debug('disableDangerousRules: session not found', { sessionKey, ruleIds });
      return;
    }
    if (!session.disabledDangerousRules) {
      session.disabledDangerousRules = new Set<string>();
    }
    for (const ruleId of ruleIds) {
      session.disabledDangerousRules.add(ruleId);
    }
    this.logger.info('Dangerous rules disabled for session', {
      sessionKey,
      ruleIds,
      activeDisabled: Array.from(session.disabledDangerousRules),
    });
  }

  /**
   * True if `ruleId` has been disabled for the session. Returns false for
   * unknown sessions so bypass-mode behaviour defaults to the safe side
   * (still escalates).
   */
  isDangerousRuleDisabled(sessionKey: string, ruleId: string): boolean {
    const session = this.sessions.get(normalizeSessionKey(sessionKey));
    return session?.disabledDangerousRules?.has(ruleId) ?? false;
  }

  /**
   * List the currently-disabled rule ids for a session. Returns an empty
   * array if the session is unknown or no rules have been disabled.
   */
  listDisabledDangerousRules(sessionKey: string): string[] {
    const session = this.sessions.get(normalizeSessionKey(sessionKey));
    return session?.disabledDangerousRules ? Array.from(session.disabledDangerousRules) : [];
  }

  /**
   * Clear session ID (e.g., after abort or error)
   * This forces a new Claude session on the next request
   */
  clearSessionId(channelId: string, threadTs: string | undefined): void {
    const session = this.getSession(channelId, threadTs);
    if (session) {
      this.logger.info('Clearing sessionId for session', {
        channelId,
        threadTs,
        previousSessionId: session.sessionId,
      });
      session.sessionId = undefined;
      // Clear error retry state so fresh session doesn't inherit exhausted budgets
      session.errorRetryCount = 0;
      session.fileAccessRetryCount = 0;
      session.lastErrorContext = undefined;
      // Cancel any pending file-access retry timer (Issue #215)
      if (session.pendingRetryTimer) {
        clearTimeout(session.pendingRetryTimer);
        session.pendingRetryTimer = undefined;
      }
      // ...and its persisted marker, so a restart cannot re-arm it (#351)
      session.pendingRetryAt = undefined;
      session.pendingRetrySessionId = undefined;
      session.pendingRetryDetail = undefined;
      // Drop any armed SKILL.md edit-roundtrip marker — the user is starting
      // a fresh logical session, an inbound `SKILL.md` upload should NOT
      // silently apply to a skill the user clicked 편집 on in the previous
      // logical session.
      session.pendingSkillUpload = undefined;
      // #617 followup v2: cancel any orphan compact-starting ticker — safe
      // hygiene even though the ticker has its own 10-min safety ceiling.
      if (session.compactTickInterval) {
        clearInterval(session.compactTickInterval);
        session.compactTickInterval = undefined;
      }
      session.compactStartingMessageTs = null;
      session.compactStartedAtMs = null;
      // Persist to disk so restart doesn't resurrect stale state (Issue #214)
      this.saveSessions();
    }
  }

  /**
   * Reset session context (conversation history) while preserving session metadata
   * Use this for /new and /renew commands - clears sessionId but keeps owner, workingDirectory, model, etc.
   * Also resets state to INITIALIZING to trigger re-dispatch on next message.
   * @returns true if session had active conversation and was reset, false if no session or already reset
   */
  resetSessionContext(channelId: string, threadTs: string | undefined): boolean {
    const session = this.getSession(channelId, threadTs);
    // Only return true if there was actually something to reset. A logical
    // session also needs reset when a persisted goal exists without a
    // sessionId yet — otherwise `goal set <objective>` followed by `/new`
    // would leak the previous goal into the fresh conversation. Mirrors the
    // saveSessions() guard which now persists `sessionId || handoffContext
    // || goal` (#959).
    if (!session || (!session.sessionId && !session.goal)) {
      return false;
    }

    this.logger.info('Resetting session context', {
      channelId,
      threadTs,
      previousSessionId: session.sessionId,
      previousWorkflow: session.workflow,
      preservedOwner: session.ownerId,
      preservedWorkingDirectory: session.workingDirectory,
    });

    // Clear conversation-related fields
    session.sessionId = undefined;
    session.title = undefined;
    // The placeholder mark belongs to the cleared title; the cron origin
    // (`cronJob`) is a fact about the thread and stays.
    session.titleProvisional = undefined;
    session.lastActivity = new Date();
    // The old task list stays as history; none of it is in progress any more,
    // so the new conversation's work is not attributed to it (dashboard T7/T10).
    session.taskLedger = closeTaskList(session.taskLedger, Date.now());
    // Spec 12: the old conversation's subagents are history; none is watched now.
    session.agents = loseRunningAgents(session.agents, Date.now());

    // Reset state to INITIALIZING to trigger re-dispatch on next message
    session.state = 'INITIALIZING';
    session.workflow = undefined;

    // NOTE: `session.incidentRequest` is deliberately NOT cleared here. A
    // reset makes a fresh logical conversation, not a fresh privilege level —
    // if `/new` dropped the marker, the cheapest way to turn a restricted
    // incident session into an unrestricted coding session would be to reset it.

    // Clear stale handoff metadata. The AD-12 filter (#695) persists sessions
    // that still have handoffContext; leaving it here after a reset would keep
    // a stale metadata blob on disk forever when the reset is not immediately
    // followed by a new forced-handoff runDispatch. A real handoff entry
    // overwrites this field before the first post-reset save.
    session.handoffContext = undefined;

    // Reset auto-handoff budget to fresh 1 (issue #697, epic #694).
    // After resetSessionContext, the same sessionKey becomes a new logical
    // session; it gets independent budget per spec §Scope "체인 계승이
    // 아닌 독립 예산".
    session.autoHandoffBudget = DEFAULT_AUTO_HANDOFF_BUDGET;

    // Clear current initiator (fresh start means no active initiator)
    session.currentInitiatorId = undefined;
    session.currentInitiatorName = undefined;

    // Clear expiry warning state
    session.warningMessageTs = undefined;
    session.lastWarningSentAt = undefined;

    // Clear usage data to reset context percentage
    session.usage = undefined;

    // Clear in-memory debugging fields (system prompt snapshot, user instruction SSOT)
    session.systemPrompt = undefined;
    session.initialInstruction = undefined;
    session.followUpInstructions = undefined;
    // Clear any pending rejection flag — runtime-only, must not leak across
    // /new or CONTINUE_SESSION resetSession boundaries (otherwise the next
    // turn would inject a stale rejection notice).
    session.pendingInstructionRejection = undefined;
    // A reset re-dispatches with a fresh stand-in title, so the title notice
    // budget starts over for the new context.
    session.titleNoticeCount = undefined;
    // NOTE: `session.instructions` and `session.instructionsCompletedSummary`
    // are intentionally preserved — the user-SSOT semantics require them to
    // survive `/new` and CONTINUE_SESSION resets (they represent durable
    // intent, not per-turn conversation state). The systemPrompt clear above
    // forces the next turn to rebuild the prompt with the preserved SSOT.
    // Goals are intentionally cleared: `/new` / `/renew` starts a fresh
    // logical conversation in the same Slack thread, and stale goal steering
    // would otherwise leak into the new task.
    session.goal = undefined;

    // Reset activity state
    session.activityState = 'idle';

    // Clear error retry state (including file-access-specific counters)
    session.errorRetryCount = 0;
    session.fileAccessRetryCount = 0;
    session.lastErrorContext = undefined;
    // Cancel any pending file-access retry timer (Issue #215)
    if (session.pendingRetryTimer) {
      clearTimeout(session.pendingRetryTimer);
      session.pendingRetryTimer = undefined;
    }
    // ...and its persisted marker, so a restart cannot re-arm it (#351)
    session.pendingRetryAt = undefined;
    session.pendingRetrySessionId = undefined;
    session.pendingRetryDetail = undefined;
    // Drop any armed SKILL.md edit-roundtrip marker — `/new` / `/renew` starts
    // a fresh logical session and an inbound `SKILL.md` upload should not
    // resurrect an edit click from the previous one.
    session.pendingSkillUpload = undefined;
    // #617 followup v2: cancel any orphan compact-starting ticker so /new
    // /renew doesn't leak an interval into the fresh logical session.
    if (session.compactTickInterval) {
      clearInterval(session.compactTickInterval);
      session.compactTickInterval = undefined;
    }
    session.compactStartingMessageTs = null;
    session.compactStartedAtMs = null;

    // Dashboard v2.1 — /new (and /renew) starts a fresh logical session.
    // Orphan-sweep any open leg into the accumulator, then reset the
    // session-level counters/timers so the new logical session starts clean.
    // Thread aggregate is derived from the (in-memory) session history, so
    // the prior session's totals remain visible at the thread level until
    // the process restarts.
    if (session.activeLegStartedAtMs) {
      const elapsed = Math.min(Date.now() - session.activeLegStartedAtMs, MAX_LEG_MS);
      session.activeAccumulatedMs = (session.activeAccumulatedMs || 0) + Math.max(0, elapsed);
      session.activeLegStartedAtMs = undefined;
    }
    session.activeAccumulatedMs = 0;
    session.activeLegStartedAtMs = undefined;
    session.compactionCount = 0;
    session.summaryTitle = undefined;
    session.summaryTitleTurnId = undefined;
    session.summaryTitleLastUpdatedAtMs = undefined;

    // Bump link-derived title generation token (#762) — any in-flight
    // fire-and-forget refresh job from before this reset will see the new
    // value when it tries to write back, and abort instead of clobbering the
    // freshly-cleared title with a stale one.
    session.linkRefreshGeneration = (session.linkRefreshGeneration ?? 0) + 1;

    this.saveSessions();
    this.broadcastSessionUpdate();
    return true;
  }

  /**
   * Validate that a directory path is a safe /tmp/ path suitable for tracking.
   * Checks: absolute path under /tmp/ or /private/tmp/, no traversal, minimum depth.
   */
  private isValidSourceWorkingDirPath(dirPath: string): boolean {
    if (typeof dirPath !== 'string') return false;
    const isTmpPath = dirPath.startsWith('/tmp/') || dirPath.startsWith('/private/tmp/');
    if (!isTmpPath || dirPath.includes('..')) return false;
    const segments = dirPath.replace(/\/+$/, '').split('/').filter(Boolean);
    // /private/tmp/X has 3 segments but is same depth as /tmp/X (2 segments)
    // Require at least one dir below the tmp root to prevent top-level deletion
    const minDepth = dirPath.startsWith('/private/tmp/') ? 4 : 3;
    return segments.length >= minDepth;
  }

  /**
   * Safely remove a single directory after re-validating its path.
   * Non-blocking: logs errors but never throws. Returns true if removed.
   */
  private safeRemoveSourceDir(dir: string): boolean {
    if (!this.isValidSourceWorkingDirPath(dir)) {
      this.logger.warn('Skipping cleanup of suspicious dir path', { dir });
      return false;
    }
    try {
      if (!fs.existsSync(dir)) return true; // Already gone — treat as success
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) {
        this.logger.warn('Skipping cleanup: path is now a symlink', { dir });
        return false;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      this.logger.info('Cleaned up source working dir', { dir });
      return true;
    } catch (error) {
      this.logger.error('Failed to cleanup source working dir (non-blocking)', { dir, error });
      return false;
    }
  }

  /**
   * Add a source working directory to the session for lifecycle tracking.
   * The directory must already exist on disk.
   */
  addSourceWorkingDir(channel: string, threadTs: string | undefined, dirPath: string): boolean {
    const key = this.getSessionKey(channel, threadTs);
    const session = this.sessions.get(key);
    if (!session) {
      this.logger.warn('Cannot add source working dir: session not found', { channel, threadTs, key, dirPath });
      return false;
    }

    if (!this.isValidSourceWorkingDirPath(dirPath)) {
      this.logger.warn('Rejected invalid source working dir path', { dirPath });
      return false;
    }

    if (!fs.existsSync(dirPath)) {
      this.logger.warn('Source working dir does not exist, not registering', { dirPath });
      return false;
    }

    // Resolve symlinks, then normalize /private/tmp → /tmp for consistency.
    // macOS resolves /tmp → /private/tmp via realpathSync; we normalize back.
    let resolvedPath: string;
    try {
      resolvedPath = normalizeTmpPath(fs.realpathSync(dirPath));
    } catch (error) {
      this.logger.warn('Failed to resolve real path for source working dir', { dirPath, error });
      return false;
    }
    if (!this.isValidSourceWorkingDirPath(resolvedPath)) {
      this.logger.warn('Resolved path escapes /tmp/', { dirPath, resolvedPath });
      return false;
    }

    session.sourceWorkingDirs ??= [];
    const MAX_SOURCE_WORKING_DIRS = 50;
    if (session.sourceWorkingDirs.length >= MAX_SOURCE_WORKING_DIRS) {
      this.logger.warn('sourceWorkingDirs limit reached, rejecting new dir', {
        key,
        dirPath: resolvedPath,
        count: session.sourceWorkingDirs.length,
      });
      return false;
    }
    if (!session.sourceWorkingDirs.includes(resolvedPath)) {
      session.sourceWorkingDirs.push(resolvedPath);
      this.logger.info('Source working dir added to session', { key, dirPath: resolvedPath });
      this.saveSessions();
    }
    return true;
  }

  /**
   * Remove and delete all source working directories for a session.
   * Updates the session's sourceWorkingDirs to only contain dirs that failed removal.
   * Non-blocking: logs errors but never throws.
   */
  private cleanupSourceWorkingDirs(session: ConversationSession): void {
    if (!session.sourceWorkingDirs?.length) return;
    const failed = session.sourceWorkingDirs.filter((dir) => !this.safeRemoveSourceDir(dir));
    session.sourceWorkingDirs = failed;
    if (failed.length > 0) {
      this.logger.warn('Some source working dirs could not be cleaned up', { count: failed.length, dirs: failed });
    }
  }

  /**
   * Terminate a session by its key
   */
  terminateSession(sessionKey: string): boolean {
    sessionKey = normalizeSessionKey(sessionKey);
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return false;
    }

    // Deletion-lifecycle seam: the host settles its per-session durable state
    // before ANY destructive step (incl. the terminated flag). Fail-closed — a
    // refusal throws `SessionDeleteRefusedError` and leaves the session exactly
    // as it was. It is NOT reported as `false`: callers treat false as "already
    // gone" and route on, which would strand a still-live session.
    this.fireBeforeSessionDelete(sessionKey, session, 'terminated');

    // Ghost Session Fix #99: set terminated flag BEFORE deleting from Map.
    // In-flight code holding a reference to this session object will see the flag
    // and self-terminate, even though the Map entry is gone.
    session.terminated = true;

    // Metrics: emit session_closed event before deletion (fire-and-forget)
    getMetricsEmitter()
      .emitSessionClosed(session, sessionKey)
      .catch((err) => this.logger.debug('metrics emit failed', err));

    // Archive session metadata to disk before deletion (#401)
    getArchiveStore().archive(session, sessionKey, 'terminated');

    this.cleanupSourceWorkingDirs(session);
    this.clearOnIdleCallbacks(sessionKey); // Clean up any pending cron callbacks
    this.sessions.delete(sessionKey);
    this.logger.info('Session terminated', { sessionKey, ownerId: session.ownerId });

    this.saveSessions();
    return true;
  }

  /** Mark a session as trashed (hidden from dashboard but kept in conversation list) */
  trashSession(sessionKey: string): boolean {
    sessionKey = normalizeSessionKey(sessionKey);
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    session.trashed = true;
    this.logger.info('Session trashed', { sessionKey, ownerId: session.ownerId });
    this.saveSessions();
    return true;
  }

  /**
   * Clean up inactive sessions based on max age
   * 3-stage lifecycle: Active → Sleep (policy sleepAfterMs, 24h default) →
   * Delete (policy archiveAfterMs asleep, 7d default). `maxAge` overrides the
   * idle limit (tests, explicit callers).
   */
  async cleanupInactiveSessions(maxAge?: number): Promise<void> {
    if (isSessionLifecyclePolicyDegraded()) {
      // The saved policy is unreadable; its defaults may be far shorter than what
      // an admin chose. Sleeping or ending sessions on them could not be undone.
      this.logger.warn('Session lifecycle policy unreadable — sleep/archive sweep skipped until an admin saves one');
      return;
    }
    const now = Date.now();
    const policy = getSessionLifecyclePolicy();
    const sleepAfterMs = maxAge ?? policy.sleepAfterMs;
    const archiveAfterMs = policy.archiveAfterMs;
    let cleaned = 0;
    let slept = 0;

    for (const [key, session] of this.sessions.entries()) {
      // A starred session is kept alive (SSOT 2026-10-30 T3): never put to
      // sleep, never archived, and never warned that it is about to be.
      if (session.starred === true) continue;

      // Stage 1: SLEEPING sessions - check if sleep duration exceeded (policy archiveAfterMs)
      if (session.state === 'SLEEPING') {
        const sleepAge = session.sleepStartedAt ? now - session.sleepStartedAt.getTime() : archiveAfterMs + 1; // Force expire if no sleepStartedAt

        if (sleepAge >= archiveAfterMs) {
          // Same seam as terminateSession, before notification and deletion.
          // A refusal is per-session here: the sweep keeps that session and
          // moves on, so one host failure cannot stall everyone else's expiry.
          try {
            this.fireBeforeSessionDelete(key, session, 'sleep-expired');
          } catch (error) {
            this.logger.warn('Sleep-expiry deletion refused — session kept for the next sweep', {
              sessionKey: key,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          // As in terminateSession: in-flight callbacks holding this object
          // fence on the flag, and onExpiry below awaits before the delete.
          session.terminated = true;
          if (this.expiryCallbacks) {
            try {
              await this.expiryCallbacks.onExpiry(session);
            } catch (error) {
              this.logger.error('Failed to send sleep expiry message', error);
            }
          }
          // Archive session metadata to disk before deletion (#401)
          getArchiveStore().archive(session, key, 'sleep_expired');

          this.cleanupSourceWorkingDirs(session);
          this.clearOnIdleCallbacks(key); // Clean up any pending cron callbacks
          this.sessions.delete(key);
          cleaned++;
        }
        // Sleeping sessions don't get warnings
        continue;
      }

      // A turn in progress is not idle: lastActivity only moves on user input, so
      // a long autonomous turn would otherwise be put to sleep (and its work dirs
      // removed) mid-run once a short policy is set.
      if (session.activityState === 'working') continue;

      // Stage 2: Active sessions - check if idle past the policy limit → transition to Sleep.
      // The idle clock starts at the later of the last input and an unstar (idleSinceMs).
      const sessionAge = now - idleSinceMs(session);
      const timeUntilExpiry = sleepAfterMs - sessionAge;

      if (timeUntilExpiry <= 0) {
        // Transition to sleep instead of deleting
        session.state = 'SLEEPING';
        session.sleepStartedAt = new Date();
        this.cleanupSourceWorkingDirs(session);
        slept++;

        // Metrics: this sweep is the only live sleep path (fire-and-forget).
        getMetricsEmitter()
          .emitSessionSlept(session)
          .catch((err) => this.logger.debug('metrics emit failed', err));

        if (this.expiryCallbacks) {
          try {
            // `warningMessageTs` is still set here on purpose. onSleep edits that
            // existing "만료 예정" warning into the sleep notice instead of posting
            // a second message; clearing the field first made that branch
            // unreachable and left the stale warning sitting above the new one.
            await this.expiryCallbacks.onSleep(session);
          } catch (error) {
            this.logger.error('Failed to send session sleep message', error);
          }
        }
        // Cleared only after onSleep has had its chance to use it — a ts from this
        // cycle must not be carried into the next warning cycle.
        session.warningMessageTs = undefined;
        session.lastWarningSentAt = undefined;
        // Auto-update memory on session end: consolidate this owner's episodic
        // observations into durable L1 memory ("dreaming"). Fire-and-forget.
        this.fireSessionConsolidate(session.ownerId);
        continue;
      }

      // Stage 3: Active sessions with time remaining - check for warnings
      if (this.expiryCallbacks) {
        await this.checkAndSendWarning(key, session, timeUntilExpiry, sleepAfterMs);
      }
    }

    if (cleaned > 0 || slept > 0) {
      this.logger.info(`Session cleanup: ${slept} put to sleep, ${cleaned} expired`);
    }

    if (cleaned > 0 || slept > 0) {
      this.saveSessions();
    }
  }

  /**
   * Check and send expiry warning if needed
   */
  private async checkAndSendWarning(
    sessionKey: string,
    session: ConversationSession,
    timeUntilExpiry: number,
    sleepAfterMs: number,
  ): Promise<void> {
    for (const warningInterval of WARNING_INTERVALS) {
      // A warning not shorter than the idle limit itself would fire on the first
      // sweep after any activity (e.g. the 12h check under a 2h policy) — skip it.
      if (warningInterval >= sleepAfterMs) continue;
      if (timeUntilExpiry <= warningInterval) {
        const lastWarningSent = session.lastWarningSentAt || Infinity;

        // Only send if this is a new/more urgent warning
        if (warningInterval < lastWarningSent) {
          try {
            const newMessageTs = await this.expiryCallbacks!.onWarning(
              session,
              timeUntilExpiry,
              session.warningMessageTs,
            );

            // Update session with warning info
            session.lastWarningSentAt = warningInterval;
            if (newMessageTs) {
              session.warningMessageTs = newMessageTs;
            }

            this.logger.debug('Sent session expiry warning', {
              sessionKey,
              timeRemaining: timeUntilExpiry,
              warningInterval,
            });
          } catch (error) {
            this.logger.error('Failed to send session warning', error);
          }
          break; // Sent warning — stop checking less urgent intervals
        }
        // Not sent (already sent this level) — continue to check more urgent intervals
      }
    }
  }

  /**
   * Sessions that were actively processing when the process crashed.
   * Populated during loadSessions(), cleared after notification.
   */
  getCrashRecoveredSessions(): CrashRecoveredSession[] {
    return this._crashRecoveredSessions;
  }

  clearCrashRecoveredSessions(): void {
    this._crashRecoveredSessions = [];
  }

  /**
   * Save all sessions to file for persistence across restarts
   */
  saveSessions(): void {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const sessionsArray: SerializedSession[] = [];
      for (const session of this.sessions.values()) {
        // Save sessions that have conversation history (sessionId) OR a pending
        // handoff context (AD-12, issue #695). The handoffContext branch covers
        // the narrow window between `resetSessionContext()` (which clears
        // sessionId) and the first model turn after a forced handoff entrypoint,
        // where the typed metadata must survive a crash/restart so downstream
        // guards (#696/#697/#698) can consume it.
        // The `autoCompactTokens` branch is the same shape of exception as
        // `goal`: the user set it EXPLICITLY, possibly before the first SDK
        // turn produced a sessionId, so dropping it here would silently
        // discard a direct instruction.
        if (
          session.sessionId ||
          session.handoffContext ||
          session.goal ||
          session.goalQueue?.length ||
          session.goalHistory?.length ||
          // An incident session is persisted from the moment it is marked,
          // even before the SDK assigns a sessionId — otherwise a crash in
          // that window would bring the thread back unrestricted.
          session.incidentRequest ||
          session.autoCompactTokens != null ||
          // The task's spend (and its subagents') must not vanish with a
          // `/new` that cleared the sessionId before the next SDK turn.
          session.taskUsage ||
          session.agents?.agents.length ||
          // A star is a direct instruction to keep the session (SSOT 2026-10-30).
          session.starred
        ) {
          this.ensureSessionLinkState(session);
          sessionsArray.push({
            // Rollback compatibility: persist the LEGACY key form. The
            // running (post-4d) loader ignores this field and re-derives the
            // canonical key from channelId/threadTs; a pre-4d binary loads it
            // verbatim and derives legacy keys for lookup — so this exact
            // form is what keeps sessions.json loadable after an emergency
            // rollback. See buildLegacySessionKey.
            key: buildLegacySessionKey(session.channelId, session.threadTs),
            ownerId: session.ownerId,
            ownerName: session.ownerName,
            userId: session.userId, // Legacy field
            channelId: session.channelId,
            threadTs: session.threadTs,
            sessionId: session.sessionId,
            isActive: session.isActive,
            lastActivity: session.lastActivity.toISOString(),
            workingDirectory: session.workingDirectory,
            title: session.title,
            model: session.model,
            // Auto fallback compact: persist the in-flight fallback marker so
            // loadSessions can restore the original model after a restart.
            fallbackCompactActive: session.fallbackCompactActive,
            fallbackCompactOriginalModel: session.fallbackCompactOriginalModel,
            state: session.state,
            workflow: session.workflow,
            links: session.links,
            linkHistory: session.linkHistory,
            linkSequence: session.linkSequence,
            // Persist link-derived title generation token (#762) — must be
            // monotonic across restart so post-restart fire-and-forget jobs
            // continue to see a stable version baseline.
            linkRefreshGeneration: session.linkRefreshGeneration,
            sleepStartedAt: session.sleepStartedAt?.toISOString(),
            activityState: session.activityState,
            // Restart-notification symmetry markers: only meaningful between a
            // graceful shutdown and the next loadSessions+notifyCrashRecovery,
            // but cheap to persist always so we don't lose them on the
            // intermediate save that happens immediately after notifyShutdown.
            shutdownNotificationSent: session.shutdownNotificationSent,
            shutdownNotifiedAt: session.shutdownNotifiedAt,
            wasWorkingAtShutdown: session.wasWorkingAtShutdown,
            // Pending error auto-retry (#351): the timer dies with the process,
            // so its due time, budget and context are what startup re-arms from.
            pendingRetryAt: session.pendingRetryAt,
            pendingRetrySessionId: session.pendingRetrySessionId,
            pendingRetryDetail: session.pendingRetryDetail,
            errorRetryCount: session.errorRetryCount,
            lastErrorContext: session.lastErrorContext,
            logVerbosity: session.logVerbosity,
            logVerbosityVersion: session.logVerbosity === undefined ? undefined : LOG_VERBOSITY_MASK_VERSION,
            effort: session.effort,
            thinkingEnabled: session.thinkingEnabled,
            showThinking: session.showThinking,
            actionPanel: session.actionPanel ? { ...session.actionPanel } : undefined,
            threadModel: session.threadModel,
            threadRootTs: session.threadRootTs,
            isOnboarding: session.isOnboarding,
            sourceWorkingDirs: session.sourceWorkingDirs,
            sourceThread: session.sourceThread,
            // Session workspace isolation (#77): persist session-unique cwd
            // so Claude SDK can find its conversation files after restart
            sessionWorkingDir: session.sessionWorkingDir,
            // Conversation record ID
            conversationId: session.conversationId,
            // Merge code change stats
            mergeStats: session.mergeStats,
            // User SSOT instructions (persisted)
            instructions: session.instructions,
            // Host-managed session goal (persisted)
            goal: session.goal,
            // Multi-goal queue + completed history (persisted so the queue
            // survives a restart — T1/T2).
            goalQueue: session.goalQueue,
            goalHistory: session.goalHistory,
            taskLedger: session.taskLedger,
            agents: session.agents,
            activityStateChangedAt: session.activityStateChangedAt,
            // Cached completed-summary (persisted so the next turn after restart
            // doesn't pay a cold summary rebuild). Safe to omit — the block
            // builder falls back to a placeholder and the async regen kicks in.
            instructionsCompletedSummary: session.instructionsCompletedSummary,
            // Context fill + window + totals — without it every restart blanked the
            // context gauge and hid a full context from the compact threshold
            // until the next turn ended. The runtime-only fold is left out.
            usage: session.usage ? toPersistedSessionUsage(session.usage, session.sessionId) : undefined,
            // Last SDK running total — without it a restart would re-count it into the goal's spend
            sdkUsageBaseline: session.sdkUsageBaseline,
            taskUsage: session.taskUsage,
            // Dashboard v2.1 — derive-first aggregate snapshot (persisted per session)
            compactionCount: session.compactionCount,
            activeLegStartedAtMs: session.activeLegStartedAtMs,
            activeLegGoalId: session.activeLegGoalId,
            activeAccumulatedMs: session.activeAccumulatedMs,
            summaryTitle: session.summaryTitle,
            summaryTitleTurnId: session.summaryTitleTurnId,
            summaryTitleLastUpdatedAtMs: session.summaryTitleLastUpdatedAtMs,
            // Typed handoff metadata (issue #695)
            handoffContext: session.handoffContext,
            // Host-enforced auto-handoff budget (issue #697)
            autoHandoffBudget: session.autoHandoffBudget,
            // Verified Eagle incident request that owns this session, plus the
            // host completion marker that decides whether a retry is admissible
            incidentRequest: session.incidentRequest,
            cronJob: session.cronJob,
            titleProvisional: session.titleProvisional || undefined,
            starred: session.starred === true ? true : undefined,
            starClearedAt: session.starClearedAt,
            incidentAttemptFinishedId: session.incidentAttemptFinishedId,
            // Session-scoped `/autocompact` token override (persisted verbatim).
            autoCompactTokens: session.autoCompactTokens,
          });
        }
      }

      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsArray, null, 2));
      this.logger.info(`Saved ${sessionsArray.length} sessions to file`);
    } catch (error) {
      this.logger.error('Failed to save sessions', error);
    }
  }

  /**
   * Archive a serialized session during loadSessions() when it's being discarded (#401).
   * Creates a minimal ConversationSession from serialized data to pass to the archive store.
   */
  private archiveSerializedOnLoad(
    serialized: SerializedSession,
    lastActivity: Date,
    reason: 'terminated' | 'sleep_expired',
  ): void {
    try {
      // Skip if already archived (prevents duplicates on repeated restarts)
      if (getArchiveStore().exists(serialized.key)) return;

      // Coerce serialized model string against AVAILABLE_MODELS. Known-legacy
      // ids pass through unchanged; unknown or case-drifted values normalize
      // to DEFAULT_MODEL. Preserves undefined when the session was saved
      // without a model (unchanged behavior from verbatim passthrough).
      const model = serialized.model === undefined ? undefined : coerceToAvailableModel(serialized.model);
      const session: ConversationSession = {
        ownerId: serialized.ownerId || serialized.userId,
        ownerName: serialized.ownerName,
        userId: serialized.userId,
        channelId: serialized.channelId,
        threadTs: serialized.threadTs,
        sessionId: serialized.sessionId,
        isActive: false,
        lastActivity,
        title: serialized.title,
        model,
        state: serialized.state || 'MAIN',
        workflow: serialized.workflow || 'default',
        links: serialized.links,
        linkHistory: serialized.linkHistory,
        conversationId: serialized.conversationId,
        mergeStats: serialized.mergeStats,
        instructions: serialized.instructions,
        goal: migrateLegacyGoal(serialized.goal),
        goalQueue: migrateLegacyGoalArray(serialized.goalQueue),
        goalHistory: migrateLegacyGoalArray(serialized.goalHistory),
        taskLedger: sanitizeTaskLedger(serialized.taskLedger),
        // Spec 12: nothing that ran before this process is watched any more.
        agents: loseRunningAgents(sanitizeAgentRegistry(serialized.agents), Date.now()),
        // SSOT 2026-10-26 T3 — the closed card keeps the task's total (partial
        // when the session spent before the total existed).
        taskUsage: restoreTaskUsage(serialized),
        usage: restoreSessionUsage(serialized.usage, model),
        // A cron run archived while the process was down stays filed under its job.
        cronJob: sanitizeCronJob(serialized.cronJob),
        activityState: serialized.activityState || 'idle',
        // When its work finished — the archive keeps it (spec 13 §3.7).
        activityStateChangedAt: finiteStamp(serialized.activityStateChangedAt),
        // Preserve handoff metadata for diagnostic parity when archiving.
        handoffContext: serialized.handoffContext,
        // What a later revive needs (SSOT 2026-10-30 T4.2): the cwd the SDK
        // filed the transcript under, and incident ownership (fail closed).
        sessionWorkingDir: serialized.sessionWorkingDir,
        incidentRequest:
          typeof serialized.incidentRequest === 'object' && serialized.incidentRequest !== null
            ? serialized.incidentRequest
            : undefined,
        incidentAttemptFinishedId:
          typeof serialized.incidentAttemptFinishedId === 'string' ? serialized.incidentAttemptFinishedId : undefined,
      };
      getArchiveStore().archive(session, serialized.key, reason);
    } catch (err) {
      this.logger.debug('Failed to archive session during load', { key: serialized.key, error: err });
    }
  }

  /**
   * Load sessions from file after restart
   */
  loadSessions(): number {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) {
        this.logger.debug('No sessions file found');
        return 0;
      }

      const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const sessionsArray: SerializedSession[] = JSON.parse(data);

      let loaded = 0;
      const now = Date.now();
      const { sleepAfterMs: maxAge, archiveAfterMs } = getSessionLifecyclePolicy();
      // Unreadable saved policy: load every session as it was (see cleanupInactiveSessions).
      const applyLifecycle = !isSessionLifecyclePolicyDegraded();
      let sleptOnLoadCount = 0;
      this._crashRecoveredSessions = [];

      for (const serialized of sessionsArray) {
        const lastActivity = new Date(serialized.lastActivity);
        let sleepStartedAt = serialized.sleepStartedAt ? new Date(serialized.sleepStartedAt) : undefined;
        // Set when an active session went idle past the policy limit while the
        // process was down: it loads asleep, as the sweep would leave it.
        let sleptOnLoad = false;
        // A starred session is kept alive across restarts too (SSOT 2026-10-30 T3).
        const starred = serialized.starred === true;

        // For SLEEPING sessions: check against the policy sleep time
        if (starred) {
          // never slept or archived on load
        } else if (applyLifecycle && serialized.state === 'SLEEPING') {
          const sleepAge = sleepStartedAt ? now - sleepStartedAt.getTime() : archiveAfterMs + 1;
          if (sleepAge >= archiveAfterMs) {
            // Archive expired session before discarding (#401)
            this.archiveSerializedOnLoad(serialized, lastActivity, 'sleep_expired');
            serialized.sourceWorkingDirs?.forEach((dir) => this.safeRemoveSourceDir(dir));
            continue;
          }
        } else if (applyLifecycle) {
          // Active session idle past the policy limit while the process was down:
          // the same step the sweep takes when it notices — asleep from now, ended
          // only after archiveAfter more. Never ended outright on load, so a
          // restart cannot shorten the sleep a running process would have given.
          const sessionAge = now - idleSinceMs({ lastActivity, starClearedAt: serialized.starClearedAt });
          // A session with an active goal is resumed after restart (resumeActiveGoals),
          // which runs turns without waking a sleeper — leave it awake for that.
          const hasActiveGoal = serialized.goal?.status === 'active';
          if (sessionAge >= maxAge && !hasActiveGoal) {
            sleptOnLoad = true;
            sleptOnLoadCount++;
            sleepStartedAt = new Date(now);
          }
        }

        // Pending error auto-retry (#351), re-armed by resumePendingErrorRetries.
        // A session that loads asleep is never auto-resumed, so its marker is
        // dropped rather than re-armed.
        const restoredRetryAt =
          !sleptOnLoad &&
          serialized.state !== 'SLEEPING' &&
          typeof serialized.pendingRetryAt === 'number' &&
          Number.isFinite(serialized.pendingRetryAt)
            ? serialized.pendingRetryAt
            : undefined;

        const resolvedOwnerId = serialized.ownerId || serialized.userId;
        // Coerce serialized model string against AVAILABLE_MODELS. Known-legacy
        // ids pass through unchanged; unknown or case-drifted values normalize
        // to DEFAULT_MODEL. Preserves undefined when the session was saved
        // without a model (unchanged behavior from verbatim passthrough).
        const model = serialized.model === undefined ? undefined : coerceToAvailableModel(serialized.model);
        const session: ConversationSession = {
          ownerId: resolvedOwnerId, // Fallback for legacy sessions
          ownerName: serialized.ownerName,
          userId: serialized.userId, // Legacy field
          channelId: serialized.channelId,
          threadTs: serialized.threadTs,
          sessionId: serialized.sessionId,
          isActive: serialized.isActive,
          lastActivity,
          workingDirectory: serialized.workingDirectory,
          title: serialized.title,
          model,
          state: sleptOnLoad ? 'SLEEPING' : serialized.state || 'MAIN', // Default to MAIN for legacy sessions
          workflow: serialized.workflow || 'default', // Default to 'default' for legacy sessions
          links: serialized.links,
          linkHistory: serialized.linkHistory,
          linkSequence: serialized.linkSequence,
          linkRefreshGeneration: serialized.linkRefreshGeneration,
          sleepStartedAt,
          // Preserve saved state for correct dashboard display; crash recovery handles auto-resume.
          // A session put to sleep on load is idle by definition.
          activityState: sleptOnLoad ? 'idle' : serialized.activityState || 'idle',
          // Restore restart-notification markers so we can still drive the
          // symmetric restart message (and the correct auto-resume decision)
          // even if a save happened after notifyShutdown but before exit.
          shutdownNotificationSent: serialized.shutdownNotificationSent,
          shutdownNotifiedAt: serialized.shutdownNotifiedAt,
          wasWorkingAtShutdown: serialized.wasWorkingAtShutdown,
          pendingRetryAt: restoredRetryAt,
          pendingRetrySessionId:
            restoredRetryAt !== undefined && typeof serialized.pendingRetrySessionId === 'string'
              ? serialized.pendingRetrySessionId
              : undefined,
          pendingRetryDetail:
            restoredRetryAt !== undefined ? restorePendingRetryDetail(serialized.pendingRetryDetail) : undefined,
          errorRetryCount:
            typeof serialized.errorRetryCount === 'number' && Number.isFinite(serialized.errorRetryCount)
              ? serialized.errorRetryCount
              : undefined,
          lastErrorContext: typeof serialized.lastErrorContext === 'string' ? serialized.lastErrorContext : undefined,
          // A mask stored before the NARRATION flag (no version marker) maps
          // to its current preset (spec 10 §3.2) — otherwise the thread
          // silently loses narration. A versioned mask is used as stored.
          logVerbosity:
            serialized.logVerbosityVersion === undefined
              ? upgradeLegacyVerbosityMask(serialized.logVerbosity)
              : serialized.logVerbosity,
          // Backfill effort on legacy sessions so resume uses DEFAULT_EFFORT
          // rather than the SDK default.
          effort: serialized.effort ?? userSettingsStore.getUserDefaultEffort(resolvedOwnerId),
          thinkingEnabled: serialized.thinkingEnabled,
          showThinking: serialized.showThinking,
          // Clear stale messageTs/renderKey on restore — the Slack message may have been
          // deleted while the service was down, causing endless `message_not_found` errors
          // when ThreadSurface tries to chat.update a ghost message.
          actionPanel: serialized.actionPanel
            ? {
                ...serialized.actionPanel,
                messageTs: undefined,
                renderKey: undefined,
                lastRenderedAt: undefined,
              }
            : undefined,
          threadModel: serialized.threadModel,
          threadRootTs: serialized.threadRootTs,
          isOnboarding: serialized.isOnboarding,
          sourceThread: serialized.sourceThread,
          sourceWorkingDirs: (serialized.sourceWorkingDirs || []).filter((d: unknown) => {
            if (typeof d !== 'string') {
              this.logger.warn('Dropped non-string sourceWorkingDir during deserialization', {
                dir: d,
                key: serialized.key,
              });
              return false;
            }
            const valid = this.isValidSourceWorkingDirPath(d);
            if (!valid)
              this.logger.warn('Dropped invalid sourceWorkingDir during deserialization', {
                dir: d,
                key: serialized.key,
              });
            return valid;
          }),
          // Session workspace isolation (#77): restore session-unique cwd
          // so Claude SDK resumes in the same project dir where conversations are stored
          sessionWorkingDir:
            serialized.sessionWorkingDir && this.isValidSourceWorkingDirPath(serialized.sessionWorkingDir)
              ? serialized.sessionWorkingDir
              : undefined,
          // Conversation record ID
          conversationId: serialized.conversationId,
          // Incident ownership is restored verbatim and never repaired: any
          // present value keeps the session restricted (fail closed).
          incidentRequest:
            typeof serialized.incidentRequest === 'object' && serialized.incidentRequest !== null
              ? serialized.incidentRequest
              : undefined,
          // Restored only as a string; anything else reads as "not finished",
          // which denies the retry rather than admitting one on bad state.
          incidentAttemptFinishedId:
            typeof serialized.incidentAttemptFinishedId === 'string' ? serialized.incidentAttemptFinishedId : undefined,
          cronJob: sanitizeCronJob(serialized.cronJob),
          titleProvisional: serialized.titleProvisional === true ? true : undefined,
          starred: starred ? true : undefined,
          starClearedAt: finiteStamp(serialized.starClearedAt),
          // Merge code change stats
          mergeStats: serialized.mergeStats,
          // User SSOT instructions (restored from disk).
          // Legacy migration: entries saved before the lifecycle-status
          // extension lack `status`. Seed them to 'active' so the block
          // builder can group them without special-casing `undefined`.
          instructions: Array.isArray(serialized.instructions)
            ? serialized.instructions.map((i) => ({
                ...i,
                status: i.status ?? 'active',
              }))
            : [],
          // Host-managed session goal (restored from disk).
          // Migrate legacy goals so ralph-loop guards see the new fields.
          goal: migrateLegacyGoal(serialized.goal),
          // Multi-goal queue + completed history (restored — T1/T2).
          goalQueue: migrateLegacyGoalArray(serialized.goalQueue),
          goalHistory: migrateLegacyGoalArray(serialized.goalHistory),
          taskLedger: sanitizeTaskLedger(serialized.taskLedger),
          // Spec 12: nothing that ran before this process is watched any more.
          agents: loseRunningAgents(sanitizeAgentRegistry(serialized.agents), Date.now()),
          // A session put to sleep on load that was not idle has no known finish:
          // its saved stamp is when it started working or waiting, and the
          // dashboard reads an idle stamp as the finish (spec 13 §3.7).
          activityStateChangedAt:
            sleptOnLoad && (serialized.activityState || 'idle') !== 'idle'
              ? undefined
              : finiteStamp(serialized.activityStateChangedAt),
          // Cached completed-summary (may be stale — block builder validates via hash).
          instructionsCompletedSummary: serialized.instructionsCompletedSummary,
          // The context fill, its window and the session totals, as saved (sanitized).
          // Nothing re-arms auto-compact here: `autoCompactPending` is reset
          // below and the threshold is only checked at a turn's end.
          usage: restoreSessionUsage(serialized.usage, model),
          // Repriced: llmux models moved from the SDK's default rate to the host table (`metrics/host-pricing.ts`).
          sdkUsageBaseline: repriceBaseline(sanitizeSdkUsageBaseline(serialized.sdkUsageBaseline), hostPricing),
          taskUsage: restoreTaskUsage(serialized),
          // Dashboard v2.1 — restore aggregate snapshot
          compactionCount: typeof serialized.compactionCount === 'number' ? serialized.compactionCount : 0,
          activeLegStartedAtMs: serialized.activeLegStartedAtMs,
          activeLegGoalId: serialized.activeLegGoalId,
          activeAccumulatedMs: typeof serialized.activeAccumulatedMs === 'number' ? serialized.activeAccumulatedMs : 0,
          summaryTitle: serialized.summaryTitle,
          summaryTitleTurnId: serialized.summaryTitleTurnId,
          summaryTitleLastUpdatedAtMs: serialized.summaryTitleLastUpdatedAtMs,
          // Typed handoff metadata (issue #695) — present only for sessions
          // that entered via forceWorkflow z-plan-to-work / z-epic-update.
          handoffContext: serialized.handoffContext,
          // Host-enforced auto-handoff budget (issue #697). `?? 1` defensive
          // backfill is deferred to `checkAndConsumeBudget` so pre-#697 disk
          // state loads as `undefined` and is handled by the guard.
          autoHandoffBudget: serialized.autoHandoffBudget,
          // Session-scoped `/autocompact` override — restored verbatim. Unlike
          // the pending/compaction state below this is USER intent, not
          // in-flight machinery, so it survives the restart.
          autoCompactTokens: serialized.autoCompactTokens ?? null,
          // Compaction Tracking (#617): runtime-only dedupe state — always reset on reload.
          // Pending state (autoCompactPending / pendingUserText / pendingEventContext) is
          // intentionally NOT rehydrated because the original event context cannot be
          // reconstructed across a restart, and the user can simply retype the message.
          compactEpoch: 0,
          compactPostedByEpoch: {},
          compactionRehydratedByEpoch: {},
          preCompactUsagePct: null,
          lastKnownUsagePct: null,
          // #617 followup: SDK-authoritative compact_metadata snapshot.
          compactPreTokens: null,
          compactPostTokens: null,
          compactTrigger: null,
          compactDurationMs: null,
          autoCompactPending: false,
          pendingUserText: null,
          pendingEventContext: null,
          // Deferred post-compact dispatch queue + /compact-turn marker are
          // runtime-only (same rationale as pendingUserText above).
          compactPendingDispatches: null,
          compactTurnActive: false,
        };
        // Auto fallback compact: a restart that lands mid-fallback (model
        // switched to the 1M compact model, boundary restore not yet fired)
        // aborts the emergency compact. Restore the original model so the
        // session does not silently stay on the 1M compact model; the stashed
        // pending text is dropped (same convention as pendingUserText above —
        // the user can simply retype).
        if (serialized.fallbackCompactActive && serialized.fallbackCompactOriginalModel) {
          session.model = coerceToAvailableModel(serialized.fallbackCompactOriginalModel);
          this.logger.info('Auto fallback compact: restored original model on session reload', {
            key: serialized.key,
            restoredModel: session.model,
          });
        }
        // Orphan sweep: if process crashed while a turn was active, fold the elapsed
        // leg (capped by MAX_LEG_MS) into the accumulator and clear the marker so
        // the next beginTurn starts a fresh leg.
        if (session.activeLegStartedAtMs) {
          const elapsed = Math.min(Date.now() - session.activeLegStartedAtMs, MAX_LEG_MS);
          session.activeAccumulatedMs = (session.activeAccumulatedMs || 0) + Math.max(0, elapsed);
          creditActiveGoalMs(session, Math.max(0, elapsed));
          session.activeLegStartedAtMs = undefined;
        }
        this.ensureSessionLinkState(session);
        // Step 4d key migration: the map key is DERIVED from the persisted
        // channel/thread fields, never trusted from `serialized.key` — a
        // sessions.json written before the shared-identity format switch
        // migrates automatically (and idempotently) on this load.
        //
        // Per-record containment: the shared identity builder throws on
        // empty/separator-bearing segments, so one corrupt record must
        // quarantine itself instead of aborting every record after it
        // (the enclosing catch spans the whole loop).
        let derivedKey: string;
        try {
          derivedKey = this.getSessionKey(serialized.channelId, serialized.threadTs);
        } catch (keyError) {
          this.logger.warn('Skipped session with underivable key on load', {
            key: serialized.key,
            channelId: serialized.channelId,
            threadTs: serialized.threadTs,
            error: (keyError as Error)?.message,
          });
          continue;
        }
        this.sessions.set(derivedKey, session);
        loaded++;

        // Decide whether to enqueue this session for restart/crash recovery.
        //
        // Priority 1 — graceful-shutdown marker (`shutdownNotificationSent`).
        //   notifyShutdown stamped this on every session that was successfully
        //   told the service was going down. We MUST send a matching restart
        //   notification to the same set — that's the user-visible symmetry
        //   contract. The auto-resume decision uses `wasWorkingAtShutdown`,
        //   which is authoritative (captured from in-memory state at shutdown,
        //   independent of whatever stale `activityState` is on disk).
        //
        // Priority 2 — uncaughtException / hard-crash fallback.
        //   No marker means the process died without running notifyShutdown
        //   (uncaughtException path saves but doesn't notify). Fall back to
        //   the persisted `activityState`: if non-idle, the session was
        //   actively processing and the user is still waiting for output.
        // A session that went to sleep while the process was down is not resumed:
        // it still gets the restart notice it was promised (symmetry), never an auto-resume.
        if (serialized.shutdownNotificationSent) {
          this._crashRecoveredSessions.push({
            channelId: serialized.channelId,
            threadTs: serialized.threadTs,
            ownerId: serialized.ownerId || serialized.userId,
            ownerName: serialized.ownerName,
            activityState: serialized.activityState || 'idle',
            sessionKey: derivedKey,
            title: serialized.title,
            workflow: serialized.workflow,
            shouldAutoResume: !sleptOnLoad && serialized.wasWorkingAtShutdown === true,
          });
        } else if (!sleptOnLoad && serialized.activityState && serialized.activityState !== 'idle') {
          this._crashRecoveredSessions.push({
            channelId: serialized.channelId,
            threadTs: serialized.threadTs,
            ownerId: serialized.ownerId || serialized.userId,
            ownerName: serialized.ownerName,
            activityState: serialized.activityState,
            sessionKey: derivedKey,
            title: serialized.title,
            workflow: serialized.workflow,
            shouldAutoResume: serialized.activityState === 'working',
          });
        }
      }

      this.logger.info(`Loaded ${loaded} sessions from file (${sessionsArray.length - loaded} expired)`);
      // Persist sessions put to sleep on load now, as the sweep does: otherwise a
      // crash before the next save reloads them awake and restarts their clock.
      if (sleptOnLoadCount > 0) {
        this.logger.info(`Put ${sleptOnLoadCount} stale session(s) to sleep on load`);
        this.saveSessions();
      }

      return loaded;
    } catch (error) {
      this.logger.error('Failed to load sessions', error);
      return 0;
    }
  }

  /**
   * Backfill conversationId for restored sessions that lost it.
   * Builds an index from conversation storage files, then matches by channelId:threadTs
   * and sourceThread (for bot-migrated sessions). Call once at startup after loadSessions().
   */
  async backfillConversationIds(): Promise<number> {
    const { ConversationStorage } = await import('./conversation/storage');
    const storage = new ConversationStorage();
    const threadIndex = await storage.buildThreadIndex();
    let count = 0;
    for (const [, session] of this.sessions) {
      if (session.conversationId) continue;
      // Try 1: exact channelId:threadTs match
      if (session.channelId && session.threadTs) {
        const exactKey = `${session.channelId}:${session.threadTs}`;
        const convId = threadIndex.get(exactKey);
        if (convId) {
          session.conversationId = convId;
          count++;
          continue;
        }
      }
      // Try 2: sourceThread match (bot-migrated sessions)
      if (session.sourceThread) {
        const sourceKey = `${session.sourceThread.channel}:${session.sourceThread.threadTs}`;
        const sourceConvId = threadIndex.get(sourceKey);
        if (sourceConvId) {
          session.conversationId = sourceConvId;
          count++;
        }
      }
    }
    if (count > 0) {
      this.saveSessions();
      this.logger.info(`Backfilled ${count} session conversationIds`);
    }
    return count;
  }
}

/**
 * The saved `session.usage` of a loaded session, sanitized. A window that is
 * not > 0 is re-sized from the session model; with no model the usage is
 * dropped rather than given a guessed window.
 */
function restoreSessionUsage(raw: unknown, model: string | undefined): ConversationSession['usage'] {
  return sanitizeSessionUsage(raw, model ? resolveContextWindow(model) : undefined);
}

/**
 * SSOT 2026-10-26 T3 — the task total of a loaded session. A session saved
 * before the total existed that had already spent (its SDK running total is
 * not empty) starts a partial total: it counts from now, and the card says so
 * instead of passing it off as the whole task.
 */
function restoreTaskUsage(serialized: {
  taskUsage?: unknown;
  sdkUsageBaseline?: unknown;
  sessionId?: string;
}): TaskUsage | undefined {
  const kept = sanitizeTaskUsage(serialized.taskUsage);
  if (kept) return kept;
  const models = sanitizeSdkUsageBaseline(serialized.sdkUsageBaseline)?.models ?? {};
  const spent = Object.values(models).some(
    (m) => m.inputTokens + m.outputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens > 0 || m.costUsd > 0,
  );
  // A session with an SDK session has run a turn — one saved before running
  // totals were kept at all has no baseline to show it.
  if (!spent && !serialized.sessionId) return undefined;
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    partialSince: Date.now(),
  };
}
