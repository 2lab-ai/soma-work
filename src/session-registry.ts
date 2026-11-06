/**
 * SessionRegistry - Manages conversation sessions and persistence
 * Extracted from claude-handler.ts (Phase 5.1)
 */

import { randomUUID } from 'node:crypto';
import { atomicWriteJson, loadJsonWithBackup } from '@soma/common/atomic-write';
import { restoreSafeguardHalt, type SafeguardHalt } from '@soma/common/safeguard';
import {
  type ContextRewindRecord,
  decodeContextAnchor,
  type PendingRewind,
  sanitizeContextRewinds,
  sanitizePendingRewind,
  sanitizeRewindRedo,
} from '@soma/slack/context-anchor';
import { LOG_VERBOSITY_MASK_VERSION, upgradeLegacyVerbosityMask } from '@soma/slack/output-flags';
import { endGoalCapDecision } from '@soma/slack/session-goal';
import { canonicalLinkUrl } from '@soma/slack/session-link-capture';
import {
  sanitizeSdkUsageBaseline,
  sanitizeSessionUsage,
  sanitizeTaskUsage,
  type TaskUsage,
  toPersistedSessionUsage,
} from '@soma/slack/session-usage-math';
import { applyFollowUp, cleanTldrLine, followUpFromTldr } from '@soma/slack/summary-service';
import * as fs from 'fs';
import * as path from 'path';
import { applyInstructionOperations } from 'somalib/model-commands/catalog';
import {
  type HostReceipt,
  type HostWriteReceipt,
  hostReceiptPath,
  readHostReceipt,
  receiptIssuedAt,
  withAck,
} from 'somalib/model-commands/host-receipt';
import { DATA_DIR } from './env-paths';
import { isPlaceholderSessionTitle, sanitizeSessionTitle } from './format/display-title';
import { Logger } from './logger';
import { getMetricsEmitter } from './metrics/event-emitter';
import { repriceBaseline } from './metrics/host-pricing';
import { hostPricing } from './metrics/host-pricing-catalog';
import { resolveContextWindow } from './metrics/model-registry';
import { normalizeTmpPath } from './path-utils';
import {
  loseRunningAgents,
  type StoppedAgentRef,
  sanitizeAgentRegistry,
  stoppedAgentsOf,
} from './session/agent-registry';
import { resolveEffectiveAutoCompact } from './session/autocompact-policy';
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
import {
  applyPlanWrite,
  consumeEpicEvents,
  EPIC_CHILD_MAX,
  EPIC_NODE_ID,
  type EpicAdoptRefusal,
  type EpicAdoptResult,
  exemptEpicTreeTaskIds,
  isEpicDone,
  type PlanWriteInput,
  releaseCutEpicWakes,
  releaseEpicEvents,
  SLACK_WAKE_PREFIX,
  sanitizeEpicEvents,
  sanitizeEpicPlan,
  withEpicEvent,
} from './task-turn/epic-plan';
import {
  applyPlanSubmission,
  checkPlanSubmission,
  sanitizeTaskPlanGate,
  type TaskPlanGate,
} from './task-turn/task-plan';
import type {
  ActionPanelState,
  ActivityState,
  ClosedByParent,
  ConversationSession,
  EpicEvent,
  EpicPlan,
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
  TurnOutcomeRecord,
  WorkflowType,
} from './types';
import { coerceToAvailableModel, type EffortLevel, userSettingsStore } from './user-settings-store';

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
/**
 * Safeguard halts of threads whose session record is gone (closed, archived,
 * deleted). Keyed by session key; a session created again under the key
 * inherits the halt, so ending the session is not a way around the admin
 * retry (trinity design consult). Lifted only by the admin unlock.
 */
const SAFEGUARD_TOMBSTONES_FILE = path.join(DATA_DIR, 'safeguard-halts.json');
/**
 * Where the locks go while {@link SAFEGUARD_TOMBSTONES_FILE} is unreadable
 * (review R6, astra P1): that file is never overwritten then (its raw text is
 * the fail-closed evidence), yet a lock set or lifted meanwhile must survive a
 * restart. `{ halts: {key: halt}, lifted: [key] }`, read on every load and
 * emptied (never unlinked) once the main file is written again.
 */
const SAFEGUARD_TOMBSTONES_SIDECAR = path.join(DATA_DIR, 'safeguard-halts.while-unreadable.json');

/** The text of `file` when it exists and is not valid JSON; '' otherwise. */
function unparseableFileText(file: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
  try {
    JSON.parse(text);
    return '';
  } catch {
    return text;
  }
}

/**
 * Whether unreadable tombstone text names `key` — as a whole token, however
 * deeply it was JSON-escaped (a corrupt sidecar carried inside another one),
 * and never as the prefix of a longer key (`…:171.901` is not `…:171.9012`).
 */
function rawTextNamesKey(raw: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_.:-])${escaped}(?:$|[^A-Za-z0-9_.:-])`).test(raw);
}

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

/** A session's history keeps at most this many links of each kind (세션 링크 자동 기록): the oldest go first. */
export const MAX_NOTED_LINKS = 30;
/** Which noted link becomes the current one: see SessionRegistry.noteSessionLinks. */
export type NoteLinksMode = 'first' | 'always' | 'if-empty' | 'history' | 'update';

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
/** #829 — the card's follow-up comes back only when it is still one (a reason and a time). */
function restoreFollowUp(
  v: unknown,
): { reason: string; at: number; askedAt?: number; questionTurnId?: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { reason, at, askedAt, questionTurnId } = v as {
    reason?: unknown;
    at?: unknown;
    askedAt?: unknown;
    questionTurnId?: unknown;
  };
  if (typeof reason !== 'string' || reason.trim() === '' || typeof at !== 'number' || !Number.isFinite(at)) {
    return undefined;
  }
  // #917 — the question asked for this verdict stays asked across a restart (no second question for it).
  return {
    reason,
    at,
    ...(typeof askedAt === 'number' && Number.isFinite(askedAt) ? { askedAt } : {}),
    ...(typeof questionTurnId === 'string' && questionTurnId ? { questionTurnId } : {}),
  };
}

/** #829 — UPDATE_SESSION `executiveSummary`: at most this many TL;DR lines, each capped like the host's own. */
const CARD_TLDR_MAX_LINES = 5;
const CARD_TLDR_MAX_LINE_CHARS = 140;

/** A stored Executive Summary TL;DR, or undefined when what was stored is not one (T7). */
function restoreExecutiveSummary(
  v: unknown,
): { tldr: string[]; at: number; source?: 'es'; issuedAt?: number } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { tldr, at, source, issuedAt } = v as { tldr?: unknown; at?: unknown; source?: unknown; issuedAt?: unknown };
  if (!Array.isArray(tldr) || typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  const lines = tldr.filter((l): l is string => typeof l === 'string' && l.trim() !== '');
  if (lines.length === 0) return undefined;
  // #829 — the model-run es's mark (its TL;DR and verdict are one pair for that turn).
  // #881 B1 — and when the model issued it (the turn end compares steered sends with it).
  if (source !== 'es') return { tldr: lines, at };
  return typeof issuedAt === 'number' && Number.isFinite(issuedAt)
    ? { tldr: lines, at, source, issuedAt }
    : { tldr: lines, at, source };
}

interface SerializedSession {
  /** SSOT 2026-10-23 — the cron job that created the session, and a placeholder-title mark. */
  cronJob?: SessionCronJob;
  titleProvisional?: boolean;
  /** #810 — the model was told the display language (`<display-lang>`) in this SDK session. */
  displayLangTold?: boolean;
  /** The work queue the session's work belongs to (see ConversationSession.workQueueId). */
  workQueueId?: string;
  /** #767 — people the owner approved for this session (see ConversationSession.approvedInstructors). */
  approvedInstructors?: string[];
  /** SSOT 2026-10-30 — the dashboard star (kept alive) and when it was last removed. */
  starred?: boolean;
  starClearedAt?: number;
  /** #854 — an epic child's last chain outcome; validated on load. */
  lastTurnOutcome?: unknown;
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
  // Anthropic safeguards lock — only an admin lifts it (`@soma/slack/safeguard`).
  safeguardHalt?: SafeguardHalt;
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
  // The Executive Summary's TL;DR on the dashboard card (SSOT 2026-11-02 T7) — kept across a
  // restart like the thread head that shows the same lines.
  executiveSummary?: { tldr: string[]; at: number; source?: 'es'; issuedAt?: number };
  // #829 — the card's follow-up survives a restart too; #917 — with whether its question was asked.
  followUp?: { reason: string; at: number; askedAt?: number; questionTurnId?: string };
  // Bot-initiated thread metadata
  threadModel?: 'user-initiated' | 'bot-initiated';
  threadRootTs?: string;
  // Onboarding flag
  isOnboarding?: boolean;
  /** When the session was created (epoch ms) — the turn-end PR reconcile reads it (#833). */
  startedAt?: number;
  // Source working directories tracked for cleanup
  sourceWorkingDirs?: string[];
  // Mid-thread source thread reference
  sourceThread?: { channel: string; threadTs: string };
  // Session-unique working directory for workspace isolation (#77)
  sessionWorkingDir?: string;
  // Conversation record ID (links session to conversation history)
  conversationId?: string;
  // Task id (#595) — absent in files written before it existed
  taskId?: string;
  /**
   * A record of the dashboard-task stack removed in #855 (a task with no Slack thread): the
   * load archives it (its card stays readable in CLOSED) and never loads it.
   */
  slackless?: boolean;
  /** E4 ① — the epic relation; validated on load (`sanitizeEpicRelation`). */
  kind?: unknown;
  parentTaskId?: unknown;
  planNodeId?: unknown;
  childTaskIds?: unknown;
  plan?: unknown;
  epicEvents?: unknown;
  /** E4 ⑦ — a child closed by its epic's close; validated on load. */
  closedBy?: unknown;
  /** Plan mode — a plan-mode task's gate; validated on load (`sanitizeTaskPlanGate`). */
  taskPlan?: unknown;
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
  goalPaused?: SessionGoal[];
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
  contextAnchor?: string;
  pendingRewind?: PendingRewind;
  contextRewinds?: ContextRewindRecord[];
  rewindRedo?: Array<PendingRewind | null>;
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

/** E4 ① — a plan node id: a short slug, unique within its epic (one rule with the plan's, E4 ②). */
export const PLAN_NODE_ID = EPIC_NODE_ID;

/** E4 ① ② — the epic relation fields as stored on a record (plan and events on an epic only). */
export interface EpicRelation {
  kind?: 'epic';
  parentTaskId?: string;
  planNodeId?: string;
  childTaskIds?: string[];
  plan?: EpicPlan;
  epicEvents?: EpicEvent[];
  closedBy?: ClosedByParent;
}

/**
 * #854 — an epic's child working in a folder its epic placed it in: one below a session folder
 * (`…/session_<…>/<sub>`), not a session folder of its own. The epic's, never the child's to delete.
 */
export function isPlacedChildFolder(parentTaskId: unknown, dir: string): boolean {
  return typeof parentTaskId === 'string' && parentTaskId !== '' && /\/session_[^/]+\/./.test(dir);
}

/**
 * E4 ① — keep only a well-formed epic relation (on any session since #854: an
 * epic and its children are Slack sessions too). A child (`parentTaskId` +
 * `planNodeId`) is never an epic and has no children; a node id without a
 * parent is dropped; `childTaskIds` is kept on an epic only, de-duplicated,
 * non-empty strings. Every field it drops is dropped on its own — a bad `kind`
 * does not cost the record its parent.
 */
export function sanitizeEpicRelation(value: Record<string, unknown>): EpicRelation {
  // An id is a non-blank string other than the record's own (a task is not its own parent or child).
  const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '' && x !== value.taskId;
  // A child: a parent and a well-formed node, nothing else.
  if (nonEmpty(value.parentTaskId) && typeof value.planNodeId === 'string' && PLAN_NODE_ID.test(value.planNodeId)) {
    const closed = value.closedBy as { by?: unknown; at?: unknown; chain?: unknown } | undefined;
    const closedBy: ClosedByParent | undefined =
      closed && closed.by === 'parent' && typeof closed.at === 'number' && Number.isFinite(closed.at)
        ? {
            by: 'parent' as const,
            at: closed.at,
            ...(typeof closed.chain === 'string' && closed.chain !== '' ? { chain: closed.chain } : {}),
          }
        : undefined;
    return { parentTaskId: value.parentTaskId, planNodeId: value.planNodeId, ...(closedBy ? { closedBy } : {}) };
  }
  if (value.kind !== 'epic') return {};
  const children = Array.isArray(value.childTaskIds) ? value.childTaskIds.filter(nonEmpty) : [];
  const childTaskIds = [...new Set(children)];
  const plan = sanitizeEpicPlan(value.plan);
  const epicEvents = sanitizeEpicEvents(value.epicEvents);
  return {
    kind: 'epic',
    ...(childTaskIds.length > 0 ? { childTaskIds } : {}),
    ...(plan ? { plan } : {}),
    ...(epicEvents ? { epicEvents } : {}),
  };
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
  /**
   * #881 D1 — the idle clock restarted after an expiry warning was posted (activity, unstar, /new, a new ⚠️
   * follow-up): edit that message, it names an expiry that no longer holds. Fire-and-forget.
   */
  onWarningCleared?: (session: ConversationSession, warningMessageTs: string) => Promise<void>;
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
  /**
   * #966 — the subagents this restart stopped (the session's registry, read
   * before the load marked them `unknown`), named in the restart resume so the
   * model can `SendMessage` each one. Absent when none.
   */
  stoppedAgents?: StoppedAgentRef[];
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

/** #767 — a saved session approval list: user ids only, deduplicated; anything else reads as none. */
function sanitizeApprovedInstructors(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const ids = [...new Set(v.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64))];
  return ids.length ? ids : undefined;
}

/** E4 ⑤ (D6) — a child's chain end as its epic's event: ids and the outcome enum only, never its text. */
function chainEndEvent(
  child: ConversationSession,
  end: { key: string; outcome: EpicEvent['outcome']; turnId: string; at: number },
): EpicEvent {
  return {
    id: `${child.taskId}:${end.key}`,
    childTaskId: child.taskId as string,
    planNodeId: child.planNodeId as string,
    outcome: end.outcome,
    turnId: end.turnId,
    at: end.at,
    state: 'pending',
  };
}

export class SessionRegistry {
  private sessions: Map<string, ConversationSession> = new Map();
  /**
   * Task id → session (#595). Mirrors `sessions`: every insert and removal
   * goes through `putSession` / `removeSession`, so the two maps never
   * disagree. See `getSessionByTaskId` for the id lifecycle contract.
   */
  private sessionsByTaskId: Map<string, ConversationSession> = new Map();
  /** E4 ① — live child tasks by their epic's task id; rebuilt from the records on load. */
  private childrenByParent: Map<string, Set<ConversationSession>> = new Map();
  private logger = new Logger('SessionRegistry');
  /** See {@link SAFEGUARD_TOMBSTONES_FILE}. */
  private safeguardTombstones = new Map<string, SafeguardHalt>();
  /** The tombstone file could not be read: never overwrite it with a partial set. */
  private safeguardTombstonesUnreadable = false;
  /**
   * The unreadable tombstone file's raw text (live + `.bak`). While set, a key
   * that appears in it reads as halted — fail closed for exactly the threads
   * the file names, not open for all of them.
   */
  private safeguardTombstonesRaw = '';
  /** Keys an admin lifted that the raw evidence names (persisted in the sidecar). */
  private safeguardLiftedWhileUnreadable = new Set<string>();
  /**
   * Raw text of an unreadable SIDECAR (review R7, astra P1): carried into the
   * next sidecar write as `rawEvidence`, so overwriting the corrupt sidecar
   * never drops the locks it named. Part of {@link safeguardTombstonesRaw}.
   */
  private safeguardCarriedRaw = '';
  private expiryCallbacks?: SessionExpiryCallbacks;
  private beforeSessionDelete?: BeforeSessionDeleteCallback;
  private _crashRecoveredSessions: CrashRecoveredSession[] = [];

  /**
   * onIdle callback registry — fired when session transitions to idle.
   * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 5, Section 3b-3c
   */
  private onIdleCallbacks: Map<string, Array<() => void>> = new Map();

  /**
   * Optional single-slot hook fired after `drainOnIdleCallbacks` for a session
   * that just transitioned to idle — synchronously, inside that session's own
   * commit. No production caller holds it: an epic wakes after its chain settles
   * (#854, the Slack epic waker), not from inside a commit (fable #702 R1).
   * Kept out of cron-scheduler state (`registerOnIdle`).
   */
  private onIdleAfterDrainHook?: (sessionKey: string) => void;

  /**
   * Install (or replace) the post-drain idle hook. Idempotent.
   */
  setOnIdleAfterDrainHook(hook: ((sessionKey: string) => void) | undefined): void {
    this.onIdleAfterDrainHook = hook;
  }

  /** E4 ⑥ — told the epic's session key when a child's chain end was just added to it (saved or held). */
  private epicEventListener?: (epicSessionKey: string) => void;

  /** E4 ⑥ — install the listener that wakes an epic after an event (D7). */
  setEpicEventListener(listener: ((epicSessionKey: string) => void) | undefined): void {
    this.epicEventListener = listener;
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
   * E4 ⑦ (D10 a) — a live epic not done yet, or with a child running or
   * waiting, keeps itself and its children from being archived while asleep.
   * After `done` (and once the epic is closed) the tree follows the normal clock.
   */
  private epicTreeExempt(session: ConversationSession): boolean {
    const epic =
      session.kind === 'epic'
        ? session
        : session.parentTaskId
          ? this.sessionsByTaskId.get(session.parentTaskId)
          : undefined;
    if (!epic || epic.kind !== 'epic' || epic.terminated || epic.closing || !epic.taskId) {
      return false;
    }
    if (!isEpicDone(epic.plan)) return true;
    return this.getChildTasks(epic.taskId).some((c) => c.activityState === 'working' || c.activityState === 'waiting');
  }

  /**
   * E4 ⑦ (D10 b) — its epic is closing while this child runs: say so on the
   * child (`closedBy: parent`), saved strictly now, before its chain is
   * stopped. A failed save is put back and rethrown.
   */
  markClosedByParent(sessionKey: string, at: number = Date.now()): void {
    const child = this.getSessionByKey(normalizeSessionKey(sessionKey));
    if (!child || !child.parentTaskId) {
      throw new Error(`markClosedByParent: ${sessionKey} is not a child task`);
    }
    const before = child.closedBy;
    child.closedBy = { by: 'parent', at };
    try {
      this.saveSessionsOrThrow();
    } catch (error) {
      child.closedBy = before;
      throw error;
    }
    try {
      this.onActivityStateChangeCallback?.();
    } catch (err) {
      this.logger.warn('markClosedByParent: broadcast callback raised', {
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  /**
   * E4 ⑦ — the dashboard close of this task starts (`true`) or did not go
   * through (`false`): an in-memory mark, never saved (fable #703 R1).
   */
  markClosing(sessionKey: string, closing: boolean): void {
    const session = this.getSessionByKey(normalizeSessionKey(sessionKey));
    if (!session) return;
    session.closing = closing ? true : undefined;
  }

  /**
   * E4 ⑦ (D10 c) — a child is being closed: a `closed` event on its epic (id
   * `<child>:closed`), saved strictly. It never wakes the epic — delivered from
   * the start, so the cap drops it before a pending chain end. A failed save is
   * put back and rethrown; no live epic, nothing to record.
   */
  recordEpicChildClosed(sessionKey: string, at: number = Date.now()): void {
    const child = this.getSessionByKey(normalizeSessionKey(sessionKey));
    if (!child?.parentTaskId) return;
    const epic = this.epicToReport(child, 'close');
    if (!epic) return;
    const before = epic.epicEvents;
    epic.epicEvents = withEpicEvent(before, {
      id: `${child.taskId}:closed`,
      childTaskId: child.taskId as string,
      planNodeId: child.planNodeId as string,
      outcome: 'closed',
      at,
      state: 'delivered',
    });
    if (epic.epicEvents === before) return;
    try {
      this.saveSessionsOrThrow();
    } catch (error) {
      epic.epicEvents = before;
      throw error;
    }
  }

  /**
   * E4 ⑤ (D6) — the live epic a child reports to. A child whose epic is gone
   * or closing reports to no one: the event is dropped and logged.
   */
  private epicToReport(child: ConversationSession, what: string): ConversationSession | undefined {
    if (!child.parentTaskId || !child.planNodeId || !child.taskId) return undefined;
    const epic = this.sessionsByTaskId.get(child.parentTaskId);
    if (!epic || epic.kind !== 'epic' || epic.terminated || epic.closing) {
      // A closing epic drops its children's events by design (D6 d); a gone one is worth a warning.
      const closing = epic?.closing === true && !epic.terminated;
      this.logger[closing ? 'info' : 'warn'](`Epic event dropped — the epic is ${closing ? 'closing' : 'gone'}`, {
        childTaskId: child.taskId,
        parentTaskId: child.parentTaskId,
        what,
      });
      return undefined;
    }
    return epic;
  }

  /**
   * E4 ⑤ (D6) — a child's chain ended: one event on its epic (id: the child's
   * task id + the chain's end). Not saved here — the caller's save carries it with
   * the child's outcome; returns what to put back if that save fails.
   */
  private addChainEndEvent(
    child: ConversationSession,
    end: { key: string; outcome: EpicEvent['outcome']; turnId: string; at: number },
  ): { epic: ConversationSession; before: EpicEvent[] | undefined } | undefined {
    const epic = this.epicToReport(child, 'chain end');
    if (!epic) return undefined;
    const before = epic.epicEvents;
    // A child its owner is closing owes no wake: its end is recorded, delivered (fable #703 R1).
    const event = chainEndEvent(child, end);
    epic.epicEvents = withEpicEvent(before, child.closing ? { ...event, state: 'delivered' } : event);
    return { epic, before };
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
  /** The safeguard lock on this thread — its live session's, or the tombstone of a removed one. */
  getSafeguardHalt(channelId: string, threadTs?: string): SafeguardHalt | undefined {
    return this.getSafeguardHaltByKey(this.getSessionKey(channelId, threadTs));
  }

  getSafeguardHaltByKey(sessionKey: string): SafeguardHalt | undefined {
    const key = normalizeSessionKey(sessionKey);
    const known = this.sessions.get(key)?.safeguardHalt ?? this.safeguardTombstones.get(key);
    if (known) return known;
    return this.rawEvidenceHalt(key);
  }

  /** Fail closed on a key the unreadable tombstone text names (not lifted since). */
  private rawEvidenceHalt(key: string): SafeguardHalt | undefined {
    if (
      this.safeguardTombstonesRaw &&
      !this.safeguardLiftedWhileUnreadable.has(key) &&
      rawTextNamesKey(this.safeguardTombstonesRaw, key)
    ) {
      return { atMs: 0 };
    }
    return undefined;
  }

  /**
   * Lift the safeguard lock (the admin unlock button — the only caller). The
   * write must reach disk: a lock lifted in memory only would come back after
   * a restart, and one reported lifted but not saved would mislead the admin.
   * Returns false when the thread was not halted.
   */
  liftSafeguardHalt(sessionKey: string): boolean {
    const key = normalizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    const had = this.getSafeguardHaltByKey(key) !== undefined;
    if (!had) return false;
    const before = { session: session?.safeguardHalt, tombstone: this.safeguardTombstones.get(key) };
    if (session) session.safeguardHalt = undefined;
    this.safeguardTombstones.delete(key);
    if (this.safeguardTombstonesRaw) this.safeguardLiftedWhileUnreadable.add(key);
    try {
      this.saveSessionsOrThrow();
    } catch (error) {
      // Not on disk → not lifted: put the lock back so memory matches what the
      // admin is told ("still locked").
      if (session && before.session) session.safeguardHalt = before.session;
      if (before.tombstone) this.safeguardTombstones.set(key, before.tombstone);
      this.safeguardLiftedWhileUnreadable.delete(key);
      // The tombstone files are written before sessions.json: one that already
      // dropped the lock must get it back, or a restart would unlock a thread
      // the admin was told is still locked.
      try {
        this.writeSafeguardTombstones();
      } catch (restoreError) {
        this.logger.error('Safeguard lift rollback: restoring the tombstone files failed', restoreError);
      }
      throw error;
    }
    return true;
  }

  /**
   * Put a safeguards lock on the thread `sessionKey` names (#904) — on its
   * LIVE session (a close/restore puts a new object under the key, so a lock
   * written on an object captured earlier would be lost: review R6, astra P1),
   * or, when no session is live there, as the thread's tombstone, which the
   * next session under the key inherits. An existing lock is kept. The caller
   * saves.
   */
  haltSafeguardByKey(sessionKey: string, halt: SafeguardHalt): 'session' | 'tombstone' | 'already' {
    const key = normalizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (session) {
      if (session.safeguardHalt) return 'already';
      session.safeguardHalt = halt;
      this.safeguardLiftedWhileUnreadable.delete(key);
      return 'session';
    }
    if (this.safeguardTombstones.has(key)) return 'already';
    this.safeguardTombstones.set(key, halt);
    this.safeguardLiftedWhileUnreadable.delete(key);
    return 'tombstone';
  }

  getSessionByKey(sessionKey: string): ConversationSession | undefined {
    return this.sessions.get(normalizeSessionKey(sessionKey));
  }

  /**
   * Get a session by its task id — the address of a task that is not its
   * Slack channel/thread (#595). O(1). `getSession(channel, threadTs)` is
   * unchanged and stays the Slack path; this lookup sits beside it.
   *
   * ID lifecycle contract — three ids, three lifetimes:
   *
   * - `taskId` (this lookup): minted at `createSession`, persisted in
   *   sessions.json and in the archive. It does NOT change on `/new` or
   *   `/renew` (resetSessionContext), CONTINUE_SESSION, invalid-resume
   *   recovery (clearSessionId), error retry, model change, sleep/wake,
   *   restart (loadSessions), bot-thread migration (the new thread's session
   *   takes it over via `adoptTaskId` only after the original is terminated;
   *   a refused termination leaves it on the original) or an archive revive
   *   (restoreArchivedSession). At most one live session holds a task id: a
   *   duplicate met on load or revive gets a fresh id instead. A session
   *   saved before task ids existed gets one on its first load, written back
   *   at once so the next restart keeps it.
   * - `sessionId` (SDK run session): set by the first SDK turn; cleared by
   *   `/new` (resetSessionContext) and invalid-resume recovery
   *   (clearSessionId); the next turn sets a new one. Independent of taskId.
   * - `conversationId` (conversation record: work log, artifacts, user media,
   *   `/api/dashboard/session/:conversationId/*`): created after the session
   *   at Slack session init, where a failure is non-critical — a session can
   *   lack one until a later turn creates it or the startup backfill finds
   *   it. Carried across reset and bot-thread migration. It is NOT the task
   *   id (not guaranteed to exist at creation, written before it is durable,
   *   assigned outside the registry, not unique after the backfill); the
   *   session links the two — `getSessionByTaskId(id)?.conversationId`.
   */
  getSessionByTaskId(taskId: string): ConversationSession | undefined {
    return this.sessionsByTaskId.get(taskId);
  }

  /** Insert under `key`; a different session already there loses its task-id entry. */
  private putSession(key: string, session: ConversationSession): void {
    // A thread whose halted session was removed stays halted: the session
    // that comes back under the key inherits the lock.
    // The tombstone is NOT consumed here: it stays until the admin lifts the
    // lock, so no save ordering can ever leave the lock in neither file.
    // A key only the unreadable file's raw text names is locked too (review R7,
    // astra P1): goal resume and the goal loop read the session's own field.
    const tombstone = this.safeguardTombstones.get(key) ?? this.rawEvidenceHalt(key);
    if (tombstone && !session.safeguardHalt) session.safeguardHalt = tombstone;
    const previous = this.sessions.get(key);
    if (previous && previous !== session) this.unindexTask(previous);
    this.sessions.set(key, session);
    if (session.taskId) this.sessionsByTaskId.set(session.taskId, session);
    // E4 ① — a child is found from its epic (any session since #854).
    if (session.parentTaskId) {
      let siblings = this.childrenByParent.get(session.parentTaskId);
      if (!siblings) {
        siblings = new Set();
        this.childrenByParent.set(session.parentTaskId, siblings);
      }
      siblings.add(session);
    }
  }

  private removeSession(key: string): void {
    const session = this.sessions.get(key);
    if (session?.safeguardHalt) {
      this.safeguardTombstones.set(key, session.safeguardHalt);
      // A real (not raw-evidence) lock outranks an older lift of the same thread.
      if (session.safeguardHalt.atMs !== 0) this.safeguardLiftedWhileUnreadable.delete(key);
    }
    this.sessions.delete(key);
    if (session) this.unindexTask(session);
    // #846 — the model-command receipt goes with the session (a later session under the key writes its own).
    try {
      fs.unlinkSync(hostReceiptPath(DATA_DIR, key));
    } catch {
      // none written, or already gone
    }
  }

  /** Drop the task-id entry only while it still names this session — an inheritor keeps its own. */
  private unindexTask(session: ConversationSession): void {
    if (session.taskId && this.sessionsByTaskId.get(session.taskId) === session) {
      this.sessionsByTaskId.delete(session.taskId);
    }
    if (session.parentTaskId) {
      const siblings = this.childrenByParent.get(session.parentTaskId);
      if (siblings?.delete(session) && siblings.size === 0) this.childrenByParent.delete(session.parentTaskId);
    }
  }

  /** E4 ① — an epic's live child tasks, in no particular order (archived children are not live). */
  getChildTasks(parentTaskId: string): ConversationSession[] {
    return [...(this.childrenByParent.get(parentTaskId) ?? [])];
  }

  /**
   * E4 ② (.prd/19 D2) — replace an epic's plan through `applyPlanWrite` and
   * save it strictly. A refused write (`EpicPlanError`) or a failed save
   * leaves the plan as it was. Returns the plan now saved.
   */
  setEpicPlan(taskId: string, input: PlanWriteInput, by: 'epic' | 'owner'): EpicPlan {
    const epic = this.sessionsByTaskId.get(taskId);
    // A closing epic (flagged while its close is awaited) takes no new plan (grok #697 R1).
    if (!epic || epic.kind !== 'epic' || epic.terminated || epic.closing)
      throw new Error(`setEpicPlan: ${taskId} is not a live epic`);
    const children = this.getChildTasks(taskId).map((c) => ({
      planNodeId: c.planNodeId,
      active: c.activityState === 'working' || c.activityState === 'waiting',
    }));
    const next = applyPlanWrite(epic.plan, input, { now: Date.now(), by, children });
    const previous = epic.plan;
    epic.plan = next;
    try {
      this.saveSessionsOrThrow();
    } catch (error) {
      epic.plan = previous;
      throw error;
    }
    return next;
  }

  /** The registry key a session lives under: its Slack thread's key. */
  private keyOfSession(session: ConversationSession): string | undefined {
    if (!session.channelId) return undefined;
    try {
      return this.getSessionKey(session.channelId, session.threadTs);
    } catch {
      return undefined;
    }
  }

  /** A failed strict save puts every change back (`undo`) and rethrows. */
  private saveOrUndo(undo: () => void): void {
    try {
      this.saveSessionsOrThrow();
    } catch (error) {
      undo();
      throw error;
    }
  }

  /**
   * #854 — the live epic with this task id (any session), or a throw naming `caller`.
   * A closing epic takes nothing new.
   */
  private liveEpicByTaskId(caller: string, taskId: string): ConversationSession {
    const epic = this.sessionsByTaskId.get(taskId);
    if (!epic || epic.kind !== 'epic' || epic.terminated || epic.closing) {
      throw new Error(`${caller}: ${taskId} is not a live epic`);
    }
    return epic;
  }

  /**
   * #854 — a Slack session made from the dashboard with the epic switch becomes an epic:
   * its turns get the epic's tools. Saved strictly (a failed save puts it back and throws).
   * Never a child's (depth 1).
   */
  makeEpic(sessionKey: string): ConversationSession {
    const session = this.sessions.get(normalizeSessionKey(sessionKey));
    if (!session) throw new Error(`makeEpic: no session ${sessionKey}`);
    if (session.parentTaskId || session.terminated) {
      throw new Error(`makeEpic: ${sessionKey} cannot be an epic`);
    }
    if (session.kind === 'epic') return session;
    session.kind = 'epic';
    this.saveOrUndo(() => {
      session.kind = undefined;
    });
    this.logger.info('Session made an epic', { sessionKey, taskId: session.taskId });
    return session;
  }

  /**
   * #854 — a child of a Slack epic is counted before its thread exists: a fresh task id on the
   * epic's `childTaskIds` and on its node's `spawned`, in one strict save (the epic's
   * "at most N children" counts it, and the node can no longer be removed). Returns the id the
   * child's session takes (`bindEpicChild`). Refused (throws, nothing changed): no live epic,
   * no such node.
   */
  reserveEpicChild(epicTaskId: string, planNodeId: string): string {
    const epic = this.liveEpicByTaskId('reserveEpicChild', epicTaskId);
    if (!epic.plan?.nodes.some((n) => n.id === planNodeId)) {
      throw new Error(`reserveEpicChild: the plan has no node ${planNodeId}`);
    }
    // #1020 review (grok P1) — the limit is the registry's too, as for adoptEpicChild: a made and an adopted child
    // count against the same EPIC_CHILD_MAX ids, whoever asks. (One child per node stays the tools' rule: the server's
    // check, the host's in-flight set and this reservation run in one tick, with no await between them.)
    if ((epic.childTaskIds ?? []).length >= EPIC_CHILD_MAX) {
      throw new Error(`reserveEpicChild: an epic has at most ${EPIC_CHILD_MAX} children`);
    }
    const childId = randomUUID();
    const before = { childTaskIds: epic.childTaskIds, plan: epic.plan };
    epic.childTaskIds = [...(epic.childTaskIds ?? []), childId];
    epic.plan = {
      ...epic.plan,
      nodes: epic.plan.nodes.map((n) => (n.id === planNodeId ? { ...n, spawned: [...(n.spawned ?? []), childId] } : n)),
    };
    this.saveOrUndo(() => {
      epic.childTaskIds = before.childTaskIds;
      epic.plan = before.plan;
    });
    return childId;
  }

  /**
   * #854 — take back a reservation no session took (its thread could not be made): the
   * "nothing changed" of a refused spawn. Only while no session holds the id. Best effort:
   * a failed save is logged and the id stays counted (a closed child).
   */
  unreserveEpicChild(epicTaskId: string, childId: string): void {
    const epic = this.sessionsByTaskId.get(epicTaskId);
    if (!epic || epic.kind !== 'epic' || this.sessionsByTaskId.has(childId)) return;
    if (!epic.childTaskIds?.includes(childId)) return;
    const before = { childTaskIds: epic.childTaskIds, plan: epic.plan };
    const left = epic.childTaskIds.filter((id) => id !== childId);
    epic.childTaskIds = left.length ? left : undefined;
    if (epic.plan) {
      epic.plan = {
        ...epic.plan,
        nodes: epic.plan.nodes.map((n) => {
          if (!n.spawned?.includes(childId)) return n;
          const spawned = n.spawned.filter((id) => id !== childId);
          const { spawned: _gone, ...rest } = n;
          return spawned.length ? { ...rest, spawned } : rest;
        }),
      };
    }
    try {
      this.saveOrUndo(() => {
        epic.childTaskIds = before.childTaskIds;
        epic.plan = before.plan;
      });
    } catch (error) {
      this.logger.warn('An epic child reservation could not be taken back — it stays counted', {
        epicTaskId,
        childId,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /**
   * #854 — the new Slack session in a child's own thread takes the id its epic reserved
   * (`reserveEpicChild`) and the relation: its epic and its plan node. Saved strictly; a
   * failed save puts everything back and throws. Refused (throws, nothing changed): the epic
   * did not reserve that id, another session holds it, the session already has a relation,
   * the epic is another owner's.
   */
  bindEpicChild(sessionKey: string, relation: { taskId: string; parentTaskId: string; planNodeId: string }): void {
    const key = normalizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (!session) throw new Error(`bindEpicChild: no session ${sessionKey}`);
    if (session.kind === 'epic' || session.parentTaskId) {
      throw new Error(`bindEpicChild: ${sessionKey} already has its own place`);
    }
    if (!PLAN_NODE_ID.test(relation.planNodeId)) throw new Error('bindEpicChild: a bad plan node id');
    const epic = this.liveEpicByTaskId('bindEpicChild', relation.parentTaskId);
    if (!epic.childTaskIds?.includes(relation.taskId)) {
      throw new Error(`bindEpicChild: ${relation.taskId} is not reserved by its epic`);
    }
    if (epic.ownerId !== session.ownerId) throw new Error("bindEpicChild: a child is owned by its epic's owner");
    const holder = this.sessionsByTaskId.get(relation.taskId);
    if (holder && holder !== session) throw new Error(`bindEpicChild: ${relation.taskId} is held by another session`);
    const previousTaskId = session.taskId;
    this.unindexTask(session);
    session.taskId = relation.taskId;
    session.parentTaskId = relation.parentTaskId;
    session.planNodeId = relation.planNodeId;
    this.putSession(key, session);
    this.saveOrUndo(() => {
      this.unindexTask(session);
      session.taskId = previousTaskId;
      session.parentTaskId = undefined;
      session.planNodeId = undefined;
      this.putSession(key, session);
    });
    this.logger.info('Slack session bound as an epic child', {
      sessionKey: key,
      taskId: relation.taskId,
      parentTaskId: relation.parentTaskId,
      planNodeId: relation.planNodeId,
    });
  }

  /**
   * #1020 — one of its owner's existing sessions becomes an epic's child. It keeps its own task
   * id, thread and folder, and gets its epic and plan node (through `putSession`: the epic's
   * lookup and the board find it; a valid node keeps the relation through load, archive and
   * revive). Its id goes on the epic's `childTaskIds` and on the node's `spawned` (the cap counts
   * it, the node can no longer be removed) — one strict save; a failed save puts everything back
   * (`not-saved`). Nothing is sent to it: it keeps running as it was, and its chain ends report
   * to the epic from now on. Refused, nothing changed: the epic is not live, the task is the epic
   * itself, no such plan node, no such task (or one without a task id), an epic, a closed, closing
   * or trashed task, a task that is already a child, another owner's, a node that has a live child
   * (one per node, as `spawn_child`), or the epic's {@link EPIC_CHILD_MAX} children used up (closed
   * ones count). Not `bindEpicChild`: no reserved id, and the task id never changes.
   */
  adoptEpicChild(epicTaskId: string, childTaskId: string, planNodeId: string): EpicAdoptResult {
    const no = (code: EpicAdoptRefusal, error: string): EpicAdoptResult => ({ ok: false, code, error });
    const epic = this.sessionsByTaskId.get(epicTaskId);
    if (!epic || epic.kind !== 'epic' || epic.terminated || epic.closing) {
      return no('not-an-epic', 'this session is no longer a live epic');
    }
    if (childTaskId === epicTaskId) return no('self', 'an epic cannot adopt itself');
    const plan = epic.plan;
    if (!plan || !PLAN_NODE_ID.test(planNodeId) || !plan.nodes.some((n) => n.id === planNodeId)) {
      return no('no-such-node', `the plan has no node ${planNodeId} — write it with plan_write first`);
    }
    const child = childTaskId ? this.sessionsByTaskId.get(childTaskId) : undefined;
    const key = child ? [...this.sessions].find(([, s]) => s === child)?.[0] : undefined;
    if (!child || !key) return no('no-such-task', `there is no live task ${childTaskId} — look with find_tasks`);
    // Every session the registry holds has a task id (create, load and revive mint one); a record without one stays out.
    if (!child.taskId) return no('no-task-id', `${childTaskId} has no task id — it cannot be a child`);
    if (child.kind === 'epic') return no('is-epic', `${childTaskId} is an epic — an epic is never a child`);
    if (child.terminated || child.closing) return no('task-closed', `${childTaskId} is closed or being closed`);
    if (child.trashed) return no('task-trashed', `${childTaskId} is in the trash`);
    if (child.parentTaskId) {
      return no(
        'already-a-child',
        child.parentTaskId === epicTaskId
          ? `${childTaskId} is already a child of this epic`
          : `${childTaskId} is already a child of another epic`,
      );
    }
    if (child.ownerId !== epic.ownerId) return no('other-owner', `${childTaskId} is not this epic owner's task`);
    const holder = this.getChildTasks(epicTaskId).find(
      (c) => c.planNodeId === planNodeId && c.ownerId === epic.ownerId && !c.terminated,
    );
    if (holder) {
      return no(
        'node-taken',
        `node ${planNodeId} already has a live child (${holder.taskId}) — one child per node; write a node for this task`,
      );
    }
    if ((epic.childTaskIds ?? []).length >= EPIC_CHILD_MAX) {
      return no('too-many-children', `an epic has at most ${EPIC_CHILD_MAX} children (closed ones count)`);
    }
    const before = { childTaskIds: epic.childTaskIds, plan };
    child.parentTaskId = epicTaskId;
    child.planNodeId = planNodeId;
    this.putSession(key, child);
    epic.childTaskIds = [...(epic.childTaskIds ?? []), childTaskId];
    epic.plan = {
      ...plan,
      nodes: plan.nodes.map((n) => (n.id === planNodeId ? { ...n, spawned: [...(n.spawned ?? []), childTaskId] } : n)),
    };
    try {
      this.saveOrUndo(() => {
        this.unindexTask(child);
        child.parentTaskId = undefined;
        child.planNodeId = undefined;
        this.putSession(key, child);
        epic.childTaskIds = before.childTaskIds;
        epic.plan = before.plan;
      });
    } catch (error) {
      this.logger.warn('An epic could not adopt a task — nothing changed', {
        epicTaskId,
        childTaskId,
        error: (error as Error)?.message ?? String(error),
      });
      return no('not-saved', 'the adoption could not be saved — nothing changed; try again');
    }
    this.logger.info('Session adopted as an epic child', {
      sessionKey: key,
      taskId: childTaskId,
      epicTaskId,
      planNodeId,
    });
    // The board bundles the card under its epic now.
    try {
      this.onActivityStateChangeCallback?.();
    } catch (err) {
      this.logger.warn('adoptEpicChild: broadcast callback raised', { error: (err as Error)?.message ?? String(err) });
    }
    return { ok: true };
  }

  /**
   * #854 — a Slack child's chain ended (its run and every queued message after it): its last
   * outcome, and one pending event on its epic (`addChainEndEvent`), in one strict save — a
   * failed save puts both back and throws. The epic's listener then hears the epic's own key.
   * A session that is no child records nothing.
   */
  recordSessionChainEnd(
    sessionKey: string,
    end: { outcome: TurnOutcomeRecord['outcome']; reason?: string; at?: number },
  ): void {
    const session = this.sessions.get(normalizeSessionKey(sessionKey));
    if (!session || !session.parentTaskId || !session.taskId) return;
    const at = end.at ?? Date.now();
    const turnId = `chain:${at}`;
    const category: TurnOutcomeRecord['category'] =
      end.outcome === 'completed'
        ? 'WorkflowComplete'
        : end.outcome === 'waiting'
          ? 'UIUserAskQuestion'
          : end.outcome === 'failed'
            ? 'Exception'
            : 'Stalled';
    const previous = session.lastTurnOutcome;
    session.lastTurnOutcome = {
      turnId,
      outcome: end.outcome,
      category,
      ...(end.reason ? { reason: end.reason } : {}),
      at,
    };
    const epicChange = this.addChainEndEvent(session, { key: turnId, outcome: end.outcome, turnId, at });
    this.saveOrUndo(() => {
      session.lastTurnOutcome = previous;
      if (epicChange) epicChange.epic.epicEvents = epicChange.before;
    });
    const epicKey = epicChange ? this.keyOfSession(epicChange.epic) : undefined;
    if (epicKey) {
      try {
        this.epicEventListener?.(epicKey);
      } catch (err) {
        this.logger.warn('recordSessionChainEnd: epic event listener raised', {
          sessionKey,
          error: (err as Error)?.message ?? String(err),
        });
      }
    }
    try {
      this.onActivityStateChangeCallback?.();
    } catch {
      /* the board catches up on its next push */
    }
  }

  /**
   * #854 — a Slack epic's wake: the events it is started for are delivered to it (`by`, the
   * wake's id), in one strict save before the wake is sent. A failed save throws (nothing sent).
   */
  consumeEpicWake(epicKey: string, ids: readonly string[], by: string): void {
    const epic = this.sessions.get(normalizeSessionKey(epicKey));
    if (!epic || epic.kind !== 'epic') throw new Error(`consumeEpicWake: ${epicKey} is not an epic`);
    const before = epic.epicEvents;
    epic.epicEvents = consumeEpicEvents(before, ids, by);
    if (epic.epicEvents === before) return;
    this.saveOrUndo(() => {
      epic.epicEvents = before;
    });
  }

  /**
   * #854 — the epic's chain ended: the wakes it ran are done (their events stay delivered, no longer
   * tied to a wake). A wake still tied to its events at a restart was cut before its chain ended, and
   * the load delivers them again (`releaseCutEpicWakes`). Best effort: unsettled only means once more.
   */
  settleEpicWakes(epicKey: string, keep?: string): void {
    const epic = this.sessions.get(normalizeSessionKey(epicKey));
    if (!epic || epic.kind !== 'epic') return;
    const before = epic.epicEvents;
    // `keep`: a wake still being sent (not taken yet) is not one this chain ran (review #872 R2 grok).
    const settles = (by: string | undefined) => !!by?.startsWith(SLACK_WAKE_PREFIX) && by !== keep;
    if (!before?.some((e) => settles(e.consumedBy))) return;
    epic.epicEvents = before.map((e) => {
      if (!settles(e.consumedBy)) return e;
      const { consumedBy: _done, ...rest } = e;
      return rest;
    });
    try {
      this.saveOrUndo(() => {
        epic.epicEvents = before;
      });
    } catch (error) {
      this.logger.warn('An epic’s finished wakes could not be marked done — a restart delivers them again', {
        epicKey,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /** #854 — a wake that was not sent: its events are pending again (they wake once more). Best effort. */
  releaseEpicWake(epicKey: string, by: string): void {
    const epic = this.sessions.get(normalizeSessionKey(epicKey));
    if (!epic || epic.kind !== 'epic') return;
    const before = epic.epicEvents;
    epic.epicEvents = releaseEpicEvents(before, by);
    if (epic.epicEvents === before) return;
    try {
      this.saveOrUndo(() => {
        epic.epicEvents = before;
      });
    } catch (error) {
      this.logger.warn('An epic wake that did not happen could not put its events back', {
        epicKey,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /**
   * Plan mode — the plan the model submitted (`plan_submit`), checked
   * (`checkPlanSubmission`) and saved strictly as the next revision awaiting
   * its owner. Any session in plan mode (#853), by its registry key. A refusal (`TaskPlanError`, a session that is not in plan
   * mode) or a failed save leaves the gate as it was. Returns the gate now saved.
   */
  submitSessionPlan(sessionKey: string, input: unknown): TaskPlanGate {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.taskPlan || session.terminated || session.closing) {
      throw new Error(`submitSessionPlan: ${sessionKey} is not a plan-mode session`);
    }
    const next = applyPlanSubmission(session.taskPlan, checkPlanSubmission(input), Date.now());
    this.setSessionPlanGate(sessionKey, next);
    return next;
  }

  /**
   * Plan mode — replace a session's plan gate and save it strictly (a decision,
   * or putting back a start that did not happen). A failed save puts the
   * previous gate back and throws.
   */
  setSessionPlanGate(sessionKey: string, next: TaskPlanGate): void {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.taskPlan) {
      throw new Error(`setSessionPlanGate: ${sessionKey} is not a plan-mode session`);
    }
    const previous = session.taskPlan;
    session.taskPlan = next;
    try {
      this.saveSessionsOrThrow();
    } catch (error) {
      session.taskPlan = previous;
      throw error;
    }
  }

  /**
   * Move a task id onto the live session at `sessionKey` — the same task now
   * lives in that session (bot-thread migration, after the original is gone).
   * Refuses (returns false) while another live session still holds the id, so
   * a migration whose termination was refused never strands the original
   * without its id. The session's own minted id is dropped from the index.
   */
  adoptTaskId(sessionKey: string, taskId: string): boolean {
    const session = this.sessions.get(normalizeSessionKey(sessionKey));
    if (!session || !taskId) return false;
    const holder = this.sessionsByTaskId.get(taskId);
    if (holder && holder !== session) return false;
    if (session.taskId === taskId) return true;
    this.unindexTask(session);
    session.taskId = taskId;
    this.sessionsByTaskId.set(taskId, session);
    this.saveSessions();
    return true;
  }

  /**
   * The task id for a session coming back from disk (load, archive revive):
   * the saved one when it is a non-empty string no other live session holds
   * (`replacing` — the session this one replaces under its key — does not
   * count, so loading the same file twice keeps the ids), otherwise a fresh one.
   */
  private restoredTaskId(saved: unknown, replacing?: ConversationSession): { taskId: string; minted: boolean } {
    if (typeof saved === 'string' && saved !== '') {
      const holder = this.sessionsByTaskId.get(saved);
      if (!holder || holder === replacing) return { taskId: saved, minted: false };
    }
    return { taskId: randomUUID(), minted: true };
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
   * Clear the cached `systemPrompt` of every session `pick` selects — for SSOT
   * that is not per-owner, e.g. a repo's shared project memory (SSOT
   * 2026-10-23 T4). Returns the number of sessions touched.
   */
  invalidateSystemPromptWhere(pick: (session: ConversationSession) => boolean): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.systemPrompt === undefined || !pick(session)) continue;
      session.systemPrompt = undefined;
      count += 1;
    }
    if (count > 0) this.logger.debug('Invalidated systemPrompt for selected sessions', { count });
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
    const session = this.newSession(ownerId, ownerName, channelId, threadTs, model);

    this.putSession(this.getSessionKey(channelId, threadTs), session);

    // Metrics: emit session_created event (fire-and-forget)
    getMetricsEmitter()
      .emitSessionCreated(session)
      .catch((err) => this.logger.debug('metrics emit failed', err));

    return session;
  }

  /** A fresh session object with every default a new session starts with (not yet registered). */
  private newSession(
    ownerId: string,
    ownerName: string,
    channelId: string,
    threadTs: string | undefined,
    model: string | undefined,
  ): ConversationSession & { taskId: string } {
    // Get user's default model if not provided
    const sessionModel = model || userSettingsStore.getUserDefaultModel(ownerId);

    return {
      ownerId,
      ownerName,
      userId: ownerId, // Legacy field
      channelId,
      threadTs,
      taskId: randomUUID(),
      isActive: true,
      lastActivity: new Date(),
      startedAt: Date.now(),
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
    this.releaseExpiryWarning(session);

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
    this.releaseExpiryWarning(session);
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
    // A dashboard task (removed in #855) has no Slack thread to come back into: its archive is read-only.
    if (archived.slackless === true) {
      return { ok: false, code: 'conflict', message: '이 태스크 기록은 되살릴 수 없어요' };
    }
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

    const restoredTask = this.restoredTaskId(archived.taskId);
    const model = archived.model === undefined ? undefined : coerceToAvailableModel(archived.model);
    const doneAt = finiteStamp(archived.doneAt);
    // The restored goal is a new generation: an evaluation, retry or
    // continuation started for the closed session snapshotted (goalId, epoch)
    // of THIS goal — advancing the epoch makes the goal loop's guard discard
    // it instead of acting on the old object. Its lease went with that object.
    const goal = migrateLegacyGoal(archived.goal);
    if (goal) {
      goal.epoch = (goal.epoch ?? 0) + 1;
      goal.pendingEval = undefined;
    }
    const session: ConversationSession = {
      ownerId: archived.ownerId,
      ownerName: archived.ownerName,
      userId: archived.ownerId, // Legacy field
      channelId: archived.channelId,
      threadTs: archived.threadTs,
      ...sanitizeEpicRelation(archived as unknown as Record<string, unknown>),
      taskPlan: sanitizeTaskPlanGate(archived.taskPlan),
      sessionId: archived.sessionId,
      // A revived session's history already has the tag if it had an SDK session (#810).
      displayLangTold: !!archived.sessionId,
      conversationId: archived.conversationId,
      taskId: restoredTask.taskId,
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
      // When the task started, as recorded (#833) — never the revive time, which would hide its earlier PRs.
      startedAt: finiteStamp(archived.startedAt),
      instructions: Array.isArray(archived.instructions)
        ? archived.instructions.map((i) => ({ ...i, status: i.status ?? 'active' }))
        : [],
      mergeStats: archived.mergeStats,
      goal,
      goalHistory: migrateLegacyGoalArray(archived.goalHistory),
      // Paused goals wait for their owner across sleep and archive (SSOT 2026-11-06).
      goalPaused: migrateLegacyGoalArray(archived.goalPaused),
      taskLedger: sanitizeTaskLedger(archived.taskLedger),
      agents: loseRunningAgents(sanitizeAgentRegistry(archived.agents), Date.now()),
      taskUsage: restoreTaskUsage({ taskUsage: archived.taskUsage, sessionId: archived.sessionId }),
      usage: restoreSessionUsage(archived.usage, model),
      cronJob: sanitizeCronJob(archived.cronJob),
      compactionCount: typeof archived.compactionCount === 'number' ? archived.compactionCount : 0,
      activeAccumulatedMs: typeof archived.busyMs === 'number' ? archived.busyMs : 0,
      sessionWorkingDir: cwd,
      // The session's own folder is registered for cleanup like a fresh session's dir; the next turn
      // recreates it. #854 — not a folder an epic placed its child in (inside the epic's own session
      // folder): the epic's to keep, whoever revives the child (review #872 astra R5).
      sourceWorkingDirs: isPlacedChildFolder(archived.parentTaskId, cwd) ? [] : [cwd],
      // Incident ownership comes back with it: the thread stays restricted.
      incidentRequest: archived.incidentRequest,
      incidentAttemptFinishedId: archived.incidentAttemptFinishedId,
      // Handoff enforcement state as it was: the PR-issue precondition keeps
      // applying, and a consumed budget stays consumed. An archive from
      // before the budget was kept gets none (fail closed).
      handoffContext: archived.handoffContext,
      autoHandoffBudget: typeof archived.autoHandoffBudget === 'number' ? archived.autoHandoffBudget : 0,
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
    this.putSession(key, session);
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
    this.releaseExpiryWarning(session);
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
    this.setSessionTitleOn(this.getSession(channelId, threadTs), title);
  }

  private setSessionTitleOn(session: ConversationSession | undefined, title: string): void {
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
    this.updateSessionTitleOn(this.getSession(channelId, threadTs), title);
  }

  /** The same by session key (#615 R1). */
  updateSessionTitleByKey(sessionKey: string, title: string): void {
    this.updateSessionTitleOn(this.getSessionByKey(sessionKey), title);
  }

  private updateSessionTitleOn(session: ConversationSession | undefined, title: string): void {
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
    return this.fillPlaceholderSessionTitleOn(this.getSession(channelId, threadTs), title);
  }

  private fillPlaceholderSessionTitleOn(session: ConversationSession | undefined, title: string): boolean {
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
    this.addMergeStatsOn(this.getSession(channelId, threadTs), prNumber, linesAdded, linesDeleted);
  }

  private addMergeStatsOn(
    session: ConversationSession | undefined,
    prNumber: number,
    linesAdded: number,
    linesDeleted: number,
  ): void {
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
   * Record the links a conversation names (세션 링크 자동 기록, SSOT 2026-11-02): each new one joins its kind's
   * history; which becomes the current link depends on where it came from —
   *   'first'    a user message: the first link of each kind (as the dispatch does with the first message);
   *   'always'   a PR or issue the session just created;
   *   'if-empty' an assistant reply: only when the kind has no current link, so a PR mentioned in passing does not
   *              replace the one the session works on;
   *   'history'  a PR GitHub says the session's branch has, older than the session or on a shared branch (#833): it
   *              joins the history and never becomes current;
   *   'update'   a PR or issue the session just merged or closed (#832): only a link already on the card changes — its
   *              `status` — and nothing is added or made current.
   * Links compare by their canonical URL (`/pull/12/files?x` is `/pull/12`), so a link the dispatch or the model
   * already set is not recorded twice. A known link changes nothing. A recorded link is tagged `auto`; only those are
   * trimmed, to the newest {@link MAX_NOTED_LINKS} of a kind (the current one always stays). The sequence the model's
   * `UPDATE_SESSION` compares against does not move — this bookkeeping must not fail the model's own update.
   * Returns whether anything changed (then the sessions are saved).
   */
  noteSessionLinks(
    channelId: string,
    threadTs: string | undefined,
    links: ReadonlyArray<SessionLink>,
    mode: NoteLinksMode,
  ): boolean {
    return this.noteSessionLinksOn(this.getSession(channelId, threadTs), links, mode);
  }

  /** {@link noteSessionLinks} for a session by its registry key. */
  noteSessionLinksByKey(sessionKey: string, links: ReadonlyArray<SessionLink>, mode: NoteLinksMode): boolean {
    return this.noteSessionLinksOn(this.getSessionByKey(sessionKey), links, mode);
  }

  private noteSessionLinksOn(
    session: ConversationSession | undefined,
    links: ReadonlyArray<SessionLink>,
    mode: NoteLinksMode,
  ): boolean {
    if (!session || !Array.isArray(links) || links.length === 0) return false;
    this.ensureSessionLinkState(session);
    const changed =
      mode === 'update' ? this.updateNotedLinkStates(session, links) : this.noteNewLinks(session, links, mode);
    // #881 C2 — the receipt is the host's state: a link the host noted itself reaches it now, not at the next write.
    if (changed) this.writeModelCommandReceiptFor(this.keyOf(session), session, undefined);
    return changed;
  }

  private noteNewLinks(
    session: ConversationSession,
    links: ReadonlyArray<SessionLink>,
    mode: Exclude<NoteLinksMode, 'update'>,
  ): boolean {
    let changed = false;
    const firstTaken = new Set<SessionResourceType>();
    for (const raw of links) {
      const type = raw?.type as SessionResourceType | undefined;
      if (!raw?.url || !type || !(type in HISTORY_KEY_BY_RESOURCE)) continue;
      const history = session.linkHistory![HISTORY_KEY_BY_RESOURCE[type]]!;
      const activeKey = ACTIVE_KEY_BY_RESOURCE[type];
      const link: SessionLink = { ...this.normalizeSessionLink(raw, type), auto: true };
      const canon = canonicalLinkUrl(link.url);
      const at = history.findIndex((l) => !!l?.url && canonicalLinkUrl(l.url) === canon);
      const current = session.links![activeKey];
      const isCurrent = !!current?.url && canonicalLinkUrl(current.url) === canon;
      const makeCurrent =
        mode === 'always' || (mode === 'first' && !firstTaken.has(type)) || (mode === 'if-empty' && !current?.url);
      if (mode === 'first') firstTaken.add(type);
      if (makeCurrent && !isCurrent) {
        // The history's entry (its URL, a fetched title or state, whether it was set on purpose) stays; it moves to
        // the newest place.
        const entry = at >= 0 ? history[at] : link;
        if (at >= 0) history.splice(at, 1);
        history.push(entry);
        session.links![activeKey] = { ...entry };
        changed = true;
      } else if (at < 0) {
        history.push(link);
        changed = true;
      }
      const keep = session.links![activeKey]?.url;
      let recorded = history.filter((l) => l?.auto === true).length;
      while (recorded > MAX_NOTED_LINKS) {
        const drop = history.findIndex((l) => l?.auto === true && l.url !== keep);
        if (drop < 0) break;
        history.splice(drop, 1);
        recorded--;
      }
    }
    if (changed) this.saveSessions();
    return changed;
  }

  /** {@link noteSessionLinks} 'update': the state of each link already on the card (history and current copy). */
  private updateNotedLinkStates(session: ConversationSession, links: ReadonlyArray<SessionLink>): boolean {
    let changed = false;
    for (const raw of links) {
      const type = raw?.type as SessionResourceType | undefined;
      const status = typeof raw?.status === 'string' ? raw.status.trim() : '';
      if (!raw?.url || !status || !type || !(type in HISTORY_KEY_BY_RESOURCE)) continue;
      // GitHub owner and repo names are case-insensitive: a pasted `2Lab-AI/…` is the PR a merge names in lower case.
      const canon = canonicalLinkUrl(raw.url).toLowerCase();
      const same = (url: string) => canonicalLinkUrl(url).toLowerCase() === canon;
      const history = session.linkHistory![HISTORY_KEY_BY_RESOURCE[type]]!;
      const at = history.findIndex((l) => !!l?.url && same(l.url));
      // Merged is final: a later close or PATCH of a merged PR never takes it back.
      if (at >= 0 && history[at].status === 'merged') continue;
      if (at >= 0 && history[at].status !== status) {
        history[at] = { ...history[at], status };
        changed = true;
      }
      const activeKey = ACTIVE_KEY_BY_RESOURCE[type];
      const current = session.links![activeKey];
      if (current?.url && same(current.url) && current.status !== status && current.status !== 'merged') {
        session.links![activeKey] = { ...current, status };
        changed = true;
      }
    }
    if (changed) this.saveSessions();
    return changed;
  }

  /**
   * Set multiple session links at once
   */
  setSessionLinks(channelId: string, threadTs: string | undefined, links: SessionLinks): void {
    const operations = this.sessionLinkOperations(links);
    if (operations.length === 0) return;
    this.updateSessionResources(channelId, threadTs, { operations });
  }

  private sessionLinkOperations(links: SessionLinks): SessionResourceOperation[] {
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

    return operations;
  }

  /**
   * Refresh session activity by session key.
   */
  /** `editWarning: false` — the caller rewrites the posted warning itself (the idle check's "keep" button). */
  refreshSessionActivityByKey(sessionKey: string, opts: { editWarning?: boolean } = {}): boolean {
    const session = this.getSessionByKey(sessionKey);
    if (!session) return false;
    session.lastActivity = new Date();
    this.releaseExpiryWarning(session, opts);
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
  /**
   * #829 — the model-run es (UPDATE_SESSION `executiveSummary`) puts its TL;DR on the task card. The follow-up
   * is derived from the same lines (their ⚠️ line) exactly as the host-run summary does, so both paths keep
   * the card in NEEDS YOU on the same signal. False when there is no session or no usable line — the card
   * then keeps what it had.
   */
  setExecutiveSummary(
    channelId: string,
    threadTs: string | undefined,
    tldr: readonly string[],
    receiptId?: string,
  ): boolean {
    return this.setExecutiveSummaryOn(this.getSession(channelId, threadTs), tldr, receiptId);
  }

  /**
   * `receiptId` (#881 B1) — the write's id from the model-command server; its time is when the model issued the
   * write (`issuedAt`), which the turn end compares with the steered sends it folded in.
   */
  private setExecutiveSummaryOn(
    session: ConversationSession | undefined,
    tldr: readonly string[],
    receiptId?: string,
  ): boolean {
    if (!session) return false;
    const lines = tldr
      .filter((l): l is string => typeof l === 'string')
      .map(cleanTldrLine)
      .filter((l) => l.length > 0)
      .slice(0, CARD_TLDR_MAX_LINES)
      .map((l) => {
        const chars = Array.from(l);
        return chars.length <= CARD_TLDR_MAX_LINE_CHARS
          ? l
          : `${chars
              .slice(0, CARD_TLDR_MAX_LINE_CHARS - 1)
              .join('')
              .trimEnd()}…`;
      });
    if (lines.length === 0) return false;
    const at = Date.now();
    // `source: 'es'` — checked with tools by the model-run es: the same turn's host summary keeps this card
    // (TL;DR and verdict as one pair); the user's next input drops the TL;DR and with it the mark.
    const issuedAt = receiptIssuedAt(receiptId);
    session.executiveSummary = { tldr: lines, at, source: 'es', ...(issuedAt !== undefined ? { issuedAt } : {}) };
    const staleWarning = applyFollowUp(session, lines, at);
    if (staleWarning) this.notifyWarningCleared(session, staleWarning);
    this.saveSessions();
    return true;
  }

  /** #846 — the receipt file the model-command server reads back on GET_SESSION (`host`), for a Slack session. */
  modelCommandReceiptFile(channelId: string, threadTs?: string): string {
    return hostReceiptPath(DATA_DIR, this.getSessionKey(channelId, threadTs));
  }

  /**
   * #846 — write what the host holds for this session (links, sequence, card TL;DR, NEEDS YOU reason) and, after a
   * model write, how the host handled it. The model-command server answers GET_SESSION with it, so the model reads
   * the host's word instead of its own server's copy.
   */
  writeModelCommandReceipt(channelId: string, threadTs: string | undefined, lastWrite?: HostWriteReceipt): void {
    this.writeModelCommandReceiptFor(
      this.getSessionKey(channelId, threadTs),
      this.getSession(channelId, threadTs),
      lastWrite,
    );
  }

  /**
   * #881 D1 — the idle clock restarts: clear the expiry-warning state and edit the warning already posted (it names
   * the old expiry). Not for sleep — onSleep turns that message into the sleep notice itself.
   */
  private releaseExpiryWarning(session: ConversationSession, opts: { editWarning?: boolean } = {}): void {
    const posted = session.warningMessageTs;
    session.warningMessageTs = undefined;
    session.lastWarningSentAt = undefined;
    if (posted && opts.editWarning !== false) this.notifyWarningCleared(session, posted);
  }

  private notifyWarningCleared(session: ConversationSession, warningMessageTs: string): void {
    const edit = this.expiryCallbacks?.onWarningCleared;
    if (!edit) return;
    try {
      edit(session, warningMessageTs).catch((error) =>
        this.logger.warn('Stale expiry warning not edited', { error: (error as Error)?.message }),
      );
    } catch (error) {
      this.logger.warn('Stale expiry warning not edited', { error: (error as Error)?.message });
    }
  }

  private writeModelCommandReceiptFor(
    key: string,
    session: ConversationSession | undefined,
    lastWrite: HostWriteReceipt | undefined,
  ): void {
    if (!session) return;
    const file = hostReceiptPath(DATA_DIR, key);
    try {
      // The ack ledger survives every rewrite (turn start, another server's write, a late callback): each write keeps
      // its own ack, so no server's check depends on being the last writer.
      const acks = withAck(readHostReceipt(file)?.acks, lastWrite);
      const receipt: HostReceipt = {
        sequence: session.linkSequence ?? 0,
        session: this.buildSessionResourceSnapshot(session),
        ...(session.title ? { title: session.title } : {}),
        ...(session.executiveSummary?.tldr?.length ? { tldr: [...session.executiveSummary.tldr] } : {}),
        ...(session.followUp?.reason ? { followUp: session.followUp.reason } : {}),
        ...(lastWrite ? { lastWrite } : {}),
        ...(acks ? { acks } : {}),
        at: Date.now(),
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteJson(file, receipt);
    } catch (error) {
      // The model then reads no receipt (or an older one) — GET_SESSION says so; the session itself is unaffected.
      this.logger.warn('Model-command host receipt not written', { sessionKey: key, error: (error as Error).message });
    }
  }

  updateSessionResources(
    channelId: string,
    threadTs: string | undefined,
    request: SessionResourceUpdateRequest,
  ): SessionResourceUpdateResult {
    return this.updateSessionResourcesOn(this.getSession(channelId, threadTs), request);
  }

  private updateSessionResourcesOn(
    session: ConversationSession | undefined,
    request: SessionResourceUpdateRequest,
  ): SessionResourceUpdateResult {
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

  /** A session's registry key: its Slack thread's key. */
  private keyOf(session: ConversationSession): string {
    return this.getSessionKey(session.channelId, session.threadTs);
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
          emitter
            .emitGitHubEvent('issue_created', session.ownerId, session.ownerName || 'unknown', this.keyOf(session), {
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
      // #881 D1 — a new turn (a thread reply, or a host turn that already moved lastActivity here) restarts the clock:
      // the posted warning is edited and the next cycle's warnings can be sent again (fable R1 P1 on #887).
      this.releaseExpiryWarning(session);
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
    this.clearSessionIdOn(this.getSession(channelId, threadTs), { channelId, threadTs });
  }

  private clearSessionIdOn(session: ConversationSession | undefined, where: Record<string, unknown>): void {
    if (session) {
      this.logger.info('Clearing sessionId for session', {
        ...where,
        previousSessionId: session.sessionId,
      });
      session.sessionId = undefined;
      // A fresh model context has not been told the display language (#810).
      session.displayLangTold = false;
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
    // A session the work queue held before its first turn has neither, yet
    // `new` must still unbind it so its queued request never runs in the new
    // conversation (#726).
    if (!session || (!session.sessionId && !session.goal && !session.workQueueId)) {
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
    // The next conversation is told the display language on its first prompt (#810).
    session.displayLangTold = false;
    session.title = undefined;
    // The placeholder mark belongs to the cleared title; the cron origin
    // (`cronJob`) is a fact about the thread and stays.
    session.titleProvisional = undefined;
    // The new conversation is dispatched again; its queue (if any) is decided then.
    session.workQueueId = undefined;
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

    // Clear expiry warning state (and edit the posted warning, #881 D1)
    this.releaseExpiryWarning(session);

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
    // would otherwise leak into the new task. Its open questions (cap
    // decision, stall) end with it.
    endGoalCapDecision(session.goal);
    session.goal = undefined;
    // #829 — the follow-up and the card TL;DR were the old conversation's verdict; the new one is decided by
    // its own summary.
    session.followUp = undefined;
    session.executiveSummary = undefined;
    // #881 C2 — and the receipt stops carrying them.
    this.writeModelCommandReceiptFor(this.keyOf(session), session, undefined);

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
    // A fresh conversation has no cut points of its own yet (#743).
    session.contextAnchor = undefined;
    session.pendingRewind = undefined;
    session.contextRewinds = undefined;
    session.rewindRedo = undefined;
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
    return this.addSourceWorkingDirByKey(this.getSessionKey(channel, threadTs), dirPath);
  }

  /** The same by session key. */
  addSourceWorkingDirByKey(sessionKey: string, dirPath: string): boolean {
    const key = normalizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (!session) {
      this.logger.warn('Cannot add source working dir: session not found', { key, dirPath });
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
    const failed = session.sourceWorkingDirs.filter((dir) => {
      // #854 — never a folder another live session works in (an epic's child placed inside its
      // epic's folder outlives the epic's close; review #872 astra R4). Left on disk, not retried.
      const user = this.liveSessionWorkingIn(dir, session);
      if (user) {
        this.logger.info('Source working dir kept — a live session works in it', { dir, sessionKey: user });
        return false;
      }
      return !this.safeRemoveSourceDir(dir);
    });
    session.sourceWorkingDirs = failed;
    if (failed.length > 0) {
      this.logger.warn('Some source working dirs could not be cleaned up', { count: failed.length, dirs: failed });
    }
  }

  /** #854 — the key of a live session (not `except`) whose folder is `dir` or inside it, if any. */
  private liveSessionWorkingIn(dir: string, except: ConversationSession): string | undefined {
    const root = normalizeTmpPath(path.resolve(dir));
    for (const [key, s] of this.sessions) {
      if (s === except || s.terminated || !s.sessionWorkingDir) continue;
      const theirs = normalizeTmpPath(path.resolve(s.sessionWorkingDir));
      if (theirs === root || theirs.startsWith(`${root}${path.sep}`)) return key;
    }
    return undefined;
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
    this.removeSession(sessionKey);
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
      const notices = this.expiryCallbacks;

      // Stage 1: SLEEPING sessions - check if sleep duration exceeded (policy archiveAfterMs)
      if (session.state === 'SLEEPING') {
        const sleepAge = session.sleepStartedAt ? now - session.sleepStartedAt.getTime() : archiveAfterMs + 1; // Force expire if no sleepStartedAt

        // E4 ⑦ (D10 a) — an epic tree not done (or with a child at work) sleeps but is not archived.
        if (sleepAge >= archiveAfterMs && !this.epicTreeExempt(session)) {
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
          if (notices) {
            try {
              await notices.onExpiry(session);
            } catch (error) {
              this.logger.error('Failed to send sleep expiry message', error);
            }
          }
          // Archive session metadata to disk before deletion (#401)
          getArchiveStore().archive(session, key, 'sleep_expired');

          this.cleanupSourceWorkingDirs(session);
          this.clearOnIdleCallbacks(key); // Clean up any pending cron callbacks
          this.removeSession(key);
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

        if (notices) {
          try {
            // `warningMessageTs` is still set here on purpose. onSleep edits that
            // existing "만료 예정" warning into the sleep notice instead of posting
            // a second message; clearing the field first made that branch
            // unreachable and left the stale warning sitting above the new one.
            await notices.onSleep(session);
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
      if (notices) {
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
   * Save all sessions to file for persistence across restarts. A failure is
   * logged, not thrown — a caller that must know uses saveSessionsOrThrow.
   */
  saveSessions(): void {
    try {
      this.writeSessionsFile();
    } catch (error) {
      this.logger.error('Failed to save sessions', error);
    }
  }

  /**
   * The same write, but a failure throws — for a caller that must not confirm
   * a decision whose state did not reach disk (the goal cap decision, a task's
   * creation and its turn's start / outcome — #596, #634).
   */
  saveSessionsOrThrow(): void {
    try {
      this.writeSessionsFile();
    } catch (error) {
      this.logger.error('Failed to save sessions', error);
      throw error;
    }
  }

  /** Write sessions.json now; a failed write throws. */
  private writeSessionsFile(): void {
    {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      // #855 — a dashboard task the load could not archive stays, as it was, for the next load.
      const sessionsArray: SerializedSession[] = [...this.unarchivedDashboardTasks];
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
          session.goalPaused?.length ||
          session.goalHistory?.length ||
          // An incident session is persisted from the moment it is marked,
          // even before the SDK assigns a sessionId — otherwise a crash in
          // that window would bring the thread back unrestricted.
          session.incidentRequest ||
          // A safeguards-halted session is saved from the moment it is halted —
          // a restart must not bring the thread back unlocked.
          session.safeguardHalt ||
          session.autoCompactTokens != null ||
          // The task's spend (and its subagents') must not vanish with a
          // `/new` that cleared the sessionId before the next SDK turn.
          session.taskUsage ||
          session.agents?.agents.length ||
          // A star is a direct instruction to keep the session (SSOT 2026-10-30).
          session.starred ||
          // #767 — the owner's "이 세션에서 항상 승인" is a direct instruction too.
          session.approvedInstructors?.length ||
          // #853 — a plan gate (the plan switch, a plan waiting for its start) is the owner's choice too.
          session.taskPlan ||
          // #854 — an epic and its children: the tree is saved from the moment it exists.
          session.kind === 'epic' ||
          session.parentTaskId
        ) {
          // Rollback compatibility: persist the LEGACY key form. The
          // running (post-4d) loader ignores this field and re-derives the
          // canonical key from channelId/threadTs; a pre-4d binary loads it
          // verbatim and derives legacy keys for lookup — so this exact
          // form is what keeps sessions.json loadable after an emergency
          // rollback. See buildLegacySessionKey.
          let persistedKey: string;
          try {
            persistedKey = buildLegacySessionKey(session.channelId, session.threadTs);
          } catch (keyError) {
            // One record whose key cannot be built is left out — it must not
            // take every other session's save down with it (#612 R2).
            this.logger.warn('Session left out of the save: its key cannot be built', {
              taskId: session.taskId,
              error: (keyError as Error)?.message,
            });
            continue;
          }
          this.ensureSessionLinkState(session);
          sessionsArray.push({
            key: persistedKey,
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
            safeguardHalt: session.safeguardHalt,
            errorRetryCount: session.errorRetryCount,
            lastErrorContext: session.lastErrorContext,
            logVerbosity: session.logVerbosity,
            logVerbosityVersion: session.logVerbosity === undefined ? undefined : LOG_VERBOSITY_MASK_VERSION,
            effort: session.effort,
            thinkingEnabled: session.thinkingEnabled,
            showThinking: session.showThinking,
            actionPanel: session.actionPanel ? { ...session.actionPanel } : undefined,
            executiveSummary: session.executiveSummary
              ? { ...session.executiveSummary, tldr: [...session.executiveSummary.tldr] }
              : undefined,
            followUp: session.followUp ? { ...session.followUp } : undefined,
            threadModel: session.threadModel,
            threadRootTs: session.threadRootTs,
            isOnboarding: session.isOnboarding,
            sourceWorkingDirs: session.sourceWorkingDirs,
            startedAt: session.startedAt,
            sourceThread: session.sourceThread,
            // Session workspace isolation (#77): persist session-unique cwd
            // so Claude SDK can find its conversation files after restart
            sessionWorkingDir: session.sessionWorkingDir,
            // Conversation record ID
            conversationId: session.conversationId,
            taskId: session.taskId,
            kind: session.kind,
            parentTaskId: session.parentTaskId,
            planNodeId: session.planNodeId,
            childTaskIds: session.childTaskIds,
            plan: session.plan,
            epicEvents: session.epicEvents,
            // Plan mode — any session (#853).
            taskPlan: session.taskPlan,
            closedBy: session.closedBy,
            // Merge code change stats
            mergeStats: session.mergeStats,
            // User SSOT instructions (persisted)
            instructions: session.instructions,
            // Host-managed session goal (persisted)
            goal: session.goal,
            // Multi-goal queue + completed history (persisted so the queue
            // survives a restart — T1/T2).
            goalQueue: session.goalQueue,
            goalPaused: session.goalPaused,
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
            // Context rollback (#743) — the cut point and a rollback waiting for the next turn.
            contextAnchor: session.contextAnchor,
            pendingRewind: session.pendingRewind,
            contextRewinds: session.contextRewinds,
            rewindRedo: session.rewindRedo,
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
            // Always a boolean: only a file saved before #810 lacks it (see the load rule).
            displayLangTold: session.displayLangTold === true,
            workQueueId: session.workQueueId,
            approvedInstructors: session.approvedInstructors?.length ? [...session.approvedInstructors] : undefined,
            starred: session.starred === true ? true : undefined,
            starClearedAt: session.starClearedAt,
            lastTurnOutcome: session.lastTurnOutcome,
            incidentAttemptFinishedId: session.incidentAttemptFinishedId,
            // Session-scoped `/autocompact` token override (persisted verbatim).
            autoCompactTokens: session.autoCompactTokens,
          });
        }
      }

      // Write a temp file beside it, then rename over it: a write that fails
      // halfway (a full disk) leaves the saved sessions exactly as they were
      // (#612 R4). Durability on power loss is unchanged — the old direct write
      // had no fsync either. Not the shared helpers: atomic-json's
      // atomicWriteJson reads, validates and backs up the previous file on every
      // call, and atomic-write's atomicWriteFile always fsyncs the file and the
      // directory and key-sorts the whole value — per save, on the event loop,
      // for a file of megabytes saved many times a minute.
      const tempFile = `${SESSIONS_FILE}.${process.pid}.${randomUUID()}.tmp`;
      // The replace keeps the live file's access mode (a first save is
      // owner-only); it is set on the temp file BEFORE the rename, or the
      // umask default would widen a 0600 file (#612 R5).
      let mode = 0o600;
      try {
        mode = fs.statSync(SESSIONS_FILE).mode & 0o777;
      } catch {
        // First save: no file yet.
      }
      try {
        fs.writeFileSync(tempFile, JSON.stringify(sessionsArray, null, 2), { mode });
        fs.chmodSync(tempFile, mode); // writeFileSync's mode is masked by the umask
        // Tombstones first: a crash between the two writes must never leave
        // the lock of a just-removed halted session in neither file.
        this.writeSafeguardTombstones();
        fs.renameSync(tempFile, SESSIONS_FILE);
      } catch (writeError) {
        try {
          fs.rmSync(tempFile, { force: true });
        } catch {
          // Leaving a temp file behind is better than hiding the write error.
        }
        throw writeError;
      }
      this.logger.info(`Saved ${sessionsArray.length} sessions to file`);
    }
  }

  /**
   * #855 — dashboard tasks the load could not archive: written back to sessions.json as they were
   * (never loaded), so the next load archives them instead of losing them.
   */
  private unarchivedDashboardTasks: SerializedSession[] = [];

  /**
   * A save that died between its temp write and its rename leaves
   * `sessions.json.<pid>.<uuid>.tmp` behind (megabytes each). Nothing is
   * saving while the registry loads, so every such file is an orphan (#612 R5).
   */
  private sweepOrphanSaveTempFiles(): void {
    const dir = path.dirname(SESSIONS_FILE);
    const prefix = `${path.basename(SESSIONS_FILE)}.`;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        this.logger.warn('Removed a sessions.json temp file left by an interrupted save', { file: name });
      } catch {
        // Best effort: an orphan only costs disk space.
      }
    }
  }

  /**
   * Archive a serialized session during loadSessions() when it's being discarded (#401).
   * Creates a minimal ConversationSession from serialized data to pass to the archive store.
   * A dashboard task's record (#855) keeps its mark in the archive: the board's closed column
   * shows it, and no revive brings it back. True when the record has an archive that holds it.
   */
  private archiveSerializedOnLoad(
    serialized: SerializedSession,
    lastActivity: Date,
    reason: 'terminated' | 'sleep_expired',
  ): boolean {
    const dashboardTask = serialized.slackless === true;
    const key =
      typeof serialized.key === 'string' && serialized.key !== ''
        ? serialized.key
        : dashboardTask && typeof serialized.taskId === 'string'
          ? `task:${serialized.taskId}`
          : serialized.key;
    // A halted session ended at load (removeSession is not on this path) leaves
    // its thread's tombstone, like any other removal — a restart must not unlock it.
    const halt = restoreSafeguardHalt(serialized.safeguardHalt);
    if (halt && typeof key === 'string' && key) {
      const normalized = normalizeSessionKey(key);
      this.safeguardTombstones.set(normalized, halt);
      // A real lock outranks an older lift of the same thread (like removeSession).
      if (halt.atMs !== 0) this.safeguardLiftedWhileUnreadable.delete(normalized);
    }
    // #846 — an ended session's model-command receipt goes with it (removeSession is not on this path). The receipt
    // is named by the live key the loader derives, not the persisted `key` field (kept in the legacy form); a
    // dashboard task's (#855) by its own key.
    try {
      const liveKey = dashboardTask ? key : this.getSessionKey(serialized.channelId, serialized.threadTs);
      fs.unlinkSync(hostReceiptPath(DATA_DIR, liveKey));
    } catch {
      // none written, already gone, or no derivable key
    }
    try {
      // Skip if already archived (prevents duplicates on repeated restarts). A dashboard task
      // archived once, revived and worked on since, is archived again: this record is its only
      // copy of the work after that archive (#855, review #885 astra).
      if (dashboardTask) {
        const latest = getArchiveStore().latest(key);
        const changedAt = Math.max(lastActivity.getTime() || 0, finiteStamp(serialized.activityStateChangedAt) ?? 0);
        if (latest && latest.archivedAt >= changedAt) return true;
      } else if (getArchiveStore().exists(key)) return true;

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
        ...sanitizeEpicRelation(serialized as unknown as Record<string, unknown>),
        taskPlan: sanitizeTaskPlanGate(serialized.taskPlan),
        lastTurnOutcome: sanitizeTurnOutcome(serialized.lastTurnOutcome),
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
        taskId: typeof serialized.taskId === 'string' ? serialized.taskId : undefined,
        mergeStats: serialized.mergeStats,
        instructions: serialized.instructions,
        goal: migrateLegacyGoal(serialized.goal),
        goalQueue: migrateLegacyGoalArray(serialized.goalQueue),
        goalPaused: migrateLegacyGoalArray(serialized.goalPaused),
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
        // filed the transcript under, incident ownership (fail closed), and
        // the handoff budget (with handoffContext above).
        sessionWorkingDir: serialized.sessionWorkingDir,
        autoHandoffBudget: serialized.autoHandoffBudget,
        incidentRequest:
          typeof serialized.incidentRequest === 'object' && serialized.incidentRequest !== null
            ? serialized.incidentRequest
            : undefined,
        incidentAttemptFinishedId:
          typeof serialized.incidentAttemptFinishedId === 'string' ? serialized.incidentAttemptFinishedId : undefined,
      };
      return getArchiveStore().archive(session, key, reason, dashboardTask ? { slackless: true } : undefined) !== false;
    } catch (err) {
      // #855 — a dashboard task's archive is its only copy once the load drops it: say so.
      this.logger[dashboardTask ? 'warn' : 'debug']('Failed to archive session during load', { key, error: err });
      return false;
    }
  }

  /**
   * Load sessions from file after restart
   */
  /** Persist {@link safeguardTombstones} (removes the file once none is left). */
  private writeSafeguardTombstones(): void {
    const lifted = [...this.safeguardLiftedWhileUnreadable];
    const rawEvidence = this.safeguardCarriedRaw;
    if (this.safeguardTombstonesUnreadable) {
      // The main file stays as found; what changed since goes to the sidecar.
      atomicWriteJson(
        SAFEGUARD_TOMBSTONES_SIDECAR,
        { halts: Object.fromEntries(this.safeguardTombstones), lifted, rawEvidence },
        { backup: true },
      );
      return;
    }
    if (this.safeguardTombstones.size > 0 || fs.existsSync(SAFEGUARD_TOMBSTONES_FILE)) {
      // Never unlinked: an empty set is written as `{}` so the `.bak` (the
      // previous contents) can never be read back as the current set.
      atomicWriteJson(SAFEGUARD_TOMBSTONES_FILE, Object.fromEntries(this.safeguardTombstones), { backup: true });
    }
    // The sidecar's locks are in the main file now: empty its `halts` so a lock
    // lifted since never comes back from it — but keep the carried evidence of
    // a corrupt sidecar and the keys lifted against it.
    if (fs.existsSync(SAFEGUARD_TOMBSTONES_SIDECAR) || rawEvidence || lifted.length > 0) {
      atomicWriteJson(SAFEGUARD_TOMBSTONES_SIDECAR, { halts: {}, lifted, rawEvidence }, { backup: true });
    }
  }

  /**
   * Read {@link SAFEGUARD_TOMBSTONES_FILE}. Loaded BEFORE the sessions, so a
   * restored session under a tombstoned key inherits it (`putSession`). An
   * unreadable file is logged loudly and kept — never read as "no locks".
   */
  private loadSafeguardTombstones(): void {
    this.safeguardTombstones.clear();
    this.safeguardTombstonesUnreadable = false;
    this.safeguardTombstonesRaw = '';
    this.safeguardCarriedRaw = '';
    this.safeguardLiftedWhileUnreadable.clear();
    // A torn LIVE file the loader replaces with its older `.bak` may name a
    // lock the `.bak` does not: its raw text fails closed on the keys it names,
    // and is carried in the sidecar so the next rewrite never drops it.
    const tornMain = unparseableFileText(SAFEGUARD_TOMBSTONES_FILE);
    try {
      // The live file, else its `.bak` (rules/config.md §4) — a torn write
      // never reads as "no locks".
      const raw = loadJsonWithBackup(SAFEGUARD_TOMBSTONES_FILE, (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        return value as Record<string, unknown>;
      });
      for (const [key, value] of Object.entries(raw ?? {})) {
        const halt = restoreSafeguardHalt(value);
        if (halt) this.safeguardTombstones.set(normalizeSessionKey(key), halt);
      }
    } catch (error) {
      this.safeguardTombstonesUnreadable = true;
      for (const file of [SAFEGUARD_TOMBSTONES_FILE, `${SAFEGUARD_TOMBSTONES_FILE}.bak`]) {
        try {
          this.safeguardTombstonesRaw += fs.readFileSync(file, 'utf-8');
        } catch {
          // gone or unreadable — nothing to fail closed on from this copy
        }
      }
      this.logger.error('Safeguard halt tombstones unreadable — removed-session locks are not restored', error);
    }
    this.loadSafeguardTombstoneSidecar();
    this.addCarriedRaw(tornMain);
  }

  /** Add unreadable tombstone text to the carried evidence (once — a restart never doubles it). */
  private addCarriedRaw(text: string): void {
    if (!text || this.safeguardCarriedRaw.includes(text)) return;
    this.safeguardCarriedRaw += text;
    this.safeguardTombstonesRaw += text;
  }

  /** Merge {@link SAFEGUARD_TOMBSTONES_SIDECAR}: its locks join the set, its lifted keys stay lifted. */
  private loadSafeguardTombstoneSidecar(): void {
    if (!fs.existsSync(SAFEGUARD_TOMBSTONES_SIDECAR) && !fs.existsSync(`${SAFEGUARD_TOMBSTONES_SIDECAR}.bak`)) return;
    // Same for a torn live sidecar replaced by its `.bak`: carried forward, so a
    // rewrite never drops it.
    const tornSidecar = unparseableFileText(SAFEGUARD_TOMBSTONES_SIDECAR);
    try {
      const raw = loadJsonWithBackup(SAFEGUARD_TOMBSTONES_SIDECAR, (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        return value as { halts?: unknown; lifted?: unknown; rawEvidence?: unknown };
      });
      if (typeof raw?.rawEvidence === 'string') this.addCarriedRaw(raw.rawEvidence);
      const lifted = Array.isArray(raw?.lifted)
        ? raw.lifted.filter((key): key is string => typeof key === 'string').map((key) => normalizeSessionKey(key))
        : [];
      // A lift recorded here answers the RAW evidence only: it suppresses the
      // fail-closed text match, never a parsed tombstone (a later halt on the
      // same thread is a new lock — review R8, astra/fable P1).
      for (const key of lifted) this.safeguardLiftedWhileUnreadable.add(key);
      const halts = raw?.halts && typeof raw.halts === 'object' ? (raw.halts as Record<string, unknown>) : {};
      for (const [key, value] of Object.entries(halts)) {
        const halt = restoreSafeguardHalt(value);
        if (!halt) continue;
        const normalized = normalizeSessionKey(key);
        this.safeguardTombstones.set(normalized, halt);
        this.safeguardLiftedWhileUnreadable.delete(normalized);
      }
    } catch (error) {
      // Fail closed on whatever keys it names, like the main file — and carry
      // its text into the next sidecar write, so overwriting it never drops
      // them (review R7, astra P1). The main file's state is its own.
      for (const file of [SAFEGUARD_TOMBSTONES_SIDECAR, `${SAFEGUARD_TOMBSTONES_SIDECAR}.bak`]) {
        try {
          this.addCarriedRaw(fs.readFileSync(file, 'utf-8'));
        } catch {
          // gone or unreadable
        }
      }
      this.logger.error('Safeguard halt sidecar unreadable — failing closed on the keys it names', error);
    }
    this.addCarriedRaw(tornSidecar);
  }

  loadSessions(): number {
    this.sweepOrphanSaveTempFiles();
    this.loadSafeguardTombstones();
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
      let mintedTaskIdCount = 0;
      /** #855 — dashboard tasks (Slack-less records) archived by this load. */
      let archivedDashboardTasks = 0;
      this.unarchivedDashboardTasks = [];
      /** E4 ⑦ (D10 a) — epic trees kept from the load-time archive (decided over the whole file). */
      const epicTreeExempt = exemptEpicTreeTaskIds(Array.isArray(sessionsArray) ? sessionsArray : []);
      this._crashRecoveredSessions = [];

      for (const serialized of sessionsArray) {
        const lastActivity = new Date(serialized.lastActivity);
        // #855 — one kind of work session: a dashboard task (a record with no Slack thread) is
        // archived at load — its card stays readable in CLOSED — and never loaded. Its folder is
        // the owner's: nothing on disk is removed.
        if (serialized.slackless === true) {
          if (this.archiveSerializedOnLoad(serialized, lastActivity, 'terminated')) archivedDashboardTasks++;
          // Not archived (the disk said no): the record stays in the file as it was, and the next
          // load tries again — a dashboard task is never dropped without its archive (review #885 astra).
          else this.unarchivedDashboardTasks.push(serialized);
          continue;
        }
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
          // E4 ⑦ (D10 a) — nor on load: an epic tree not done (or with a child at work) stays.
          const treeExempt = typeof serialized.taskId === 'string' && epicTreeExempt.has(serialized.taskId);
          if (sleepAge >= archiveAfterMs && !treeExempt) {
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
          const sessionAge =
            now -
            idleSinceMs({
              lastActivity,
              starClearedAt: serialized.starClearedAt,
              followUp: serialized.followUp,
            });
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
        // #966 — read the agents this restart stopped before the load marks them `unknown` below.
        const restoredAgents = sanitizeAgentRegistry(serialized.agents);
        const stoppedAgents = stoppedAgentsOf(restoredAgents);
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
          safeguardHalt: restoreSafeguardHalt(serialized.safeguardHalt),
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
          executiveSummary: restoreExecutiveSummary(serialized.executiveSummary),
          followUp: restoreFollowUp(serialized.followUp),
          threadModel: serialized.threadModel,
          threadRootTs: serialized.threadRootTs,
          isOnboarding: serialized.isOnboarding,
          sourceThread: serialized.sourceThread,
          startedAt: typeof serialized.startedAt === 'number' ? serialized.startedAt : undefined,
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
          ...sanitizeEpicRelation(serialized as unknown as Record<string, unknown>),
          taskPlan: sanitizeTaskPlanGate(serialized.taskPlan),
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
          // A session saved before the mark existed (#810) was told on its first prompt if it has an SDK session.
          displayLangTold:
            typeof serialized.displayLangTold === 'boolean' ? serialized.displayLangTold : !!serialized.sessionId,
          workQueueId: typeof serialized.workQueueId === 'string' ? serialized.workQueueId : undefined,
          approvedInstructors: sanitizeApprovedInstructors(serialized.approvedInstructors),
          starred: starred ? true : undefined,
          starClearedAt: finiteStamp(serialized.starClearedAt),
          lastTurnOutcome: sanitizeTurnOutcome(serialized.lastTurnOutcome),
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
          goalPaused: migrateLegacyGoalArray(serialized.goalPaused),
          goalHistory: migrateLegacyGoalArray(serialized.goalHistory),
          taskLedger: sanitizeTaskLedger(serialized.taskLedger),
          // Spec 12: nothing that ran before this process is watched any more.
          agents: loseRunningAgents(restoredAgents, Date.now()),
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
          // `autoCompactPending` is reset below and re-armed from this occupancy
          // after the record is built (`restoredOverAutoCompact`).
          usage: restoreSessionUsage(serialized.usage, model),
          // Repriced: llmux models moved from the SDK's default rate to the host table (`metrics/host-pricing.ts`).
          sdkUsageBaseline: repriceBaseline(sanitizeSdkUsageBaseline(serialized.sdkUsageBaseline), hostPricing),
          taskUsage: restoreTaskUsage(serialized),
          // Dashboard v2.1 — restore aggregate snapshot
          compactionCount: typeof serialized.compactionCount === 'number' ? serialized.compactionCount : 0,
          contextAnchor: decodeContextAnchor(serialized.contextAnchor) ? serialized.contextAnchor : undefined,
          pendingRewind: sanitizePendingRewind(serialized.pendingRewind),
          contextRewinds: sanitizeContextRewinds(serialized.contextRewinds),
          rewindRedo: sanitizeRewindRedo(serialized.rewindRedo),
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
        // #854 — a Slack epic's wake the restart cut (consumed, its chain never ended): delivered again.
        if (session.kind === 'epic') session.epicEvents = releaseCutEpicWakes(session.epicEvents);
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
        // The pending flag is not saved, and automatic compaction has one
        // authority — the threshold check. A restored occupancy at or over the
        // threshold re-arms it, so the session's next turn (a goal resume
        // included) compacts first instead of resuming the full transcript
        // (a dev deployment 2026-10-30: three restarts resumed one goal at 528k, 701k
        // and 950k with nothing scheduled; at 975k the API refused it).
        if (restoredOverAutoCompact(session)) {
          session.autoCompactPending = true;
          this.logger.info('Auto-compact re-armed on reload — restored occupancy is over the threshold', {
            key: serialized.key,
            model: session.model,
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
        const restored = this.restoredTaskId(serialized.taskId, this.sessions.get(derivedKey));
        session.taskId = restored.taskId;
        if (restored.minted) mintedTaskIdCount++;
        this.putSession(derivedKey, session);
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
            ...(stoppedAgents.length > 0 ? { stoppedAgents } : {}),
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
            ...(stoppedAgents.length > 0 ? { stoppedAgents } : {}),
          });
        }
      }

      this.logger.info(`Loaded ${loaded} sessions from file (${sessionsArray.length - loaded} expired)`);
      // Persist sessions put to sleep on load now, as the sweep does: otherwise a
      // crash before the next save reloads them awake and restarts their clock.
      if (sleptOnLoadCount > 0) {
        this.logger.info(`Put ${sleptOnLoadCount} stale session(s) to sleep on load`);
      }
      // A task id minted here (a file from before task ids, or a duplicate)
      // is written back now: the next restart must find the same task.
      if (mintedTaskIdCount > 0) {
        this.logger.info(`Assigned task ids to ${mintedTaskIdCount} loaded session(s)`);
      }
      if (archivedDashboardTasks > 0) {
        this.logger.warn(
          `Archived ${archivedDashboardTasks} dashboard task(s) on load — the dashboard-task stack was removed (#855)`,
        );
      }
      if (this.unarchivedDashboardTasks.length > 0) {
        this.logger.error(
          `Could not archive ${this.unarchivedDashboardTasks.length} dashboard task(s) on load — kept in sessions.json for the next load (#855)`,
          { keys: this.unarchivedDashboardTasks.map((r) => r.key) },
        );
      }
      if (sleptOnLoadCount > 0 || mintedTaskIdCount > 0 || archivedDashboardTasks > 0) {
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
 * Whether a loaded session's saved occupancy is at or over its auto-compact
 * threshold. Only a session with an SDK session to resume — a reset one starts
 * empty — and never on a guess: no usage, no reading.
 */
function restoredOverAutoCompact(session: ConversationSession): boolean {
  const u = session.usage;
  if (!session.sessionId || !u) return false;
  const used = u.currentInputTokens + u.currentOutputTokens + u.currentCacheReadTokens + u.currentCacheCreateTokens;
  if (!(used > 0)) return false;
  try {
    return used >= resolveEffectiveAutoCompact(session, session.ownerId, userSettingsStore).tokens;
  } catch {
    return false;
  }
}

/**
 * The saved `session.usage` of a loaded session, sanitized. A window that is
 * not > 0 is re-sized from the session model; with no model the usage is
 * dropped rather than given a guessed window.
 */
const TURN_OUTCOMES = new Set(['completed', 'failed', 'cancelled', 'waiting', 'interrupted']);
const TURN_CATEGORIES = new Set(['UIUserAskQuestion', 'WorkflowComplete', 'Exception', 'Stalled']);

/** #598 ④b — a saved turn outcome is kept only when every field has its shape. */
function sanitizeTurnOutcome(raw: unknown): TurnOutcomeRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.turnId !== 'string' || !r.turnId) return undefined;
  if (typeof r.outcome !== 'string' || !TURN_OUTCOMES.has(r.outcome)) return undefined;
  if (typeof r.category !== 'string' || !TURN_CATEGORIES.has(r.category)) return undefined;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return undefined;
  return {
    turnId: r.turnId,
    outcome: r.outcome as TurnOutcomeRecord['outcome'],
    category: r.category as TurnOutcomeRecord['category'],
    at: r.at,
    ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    ...(r.retryable === true ? { retryable: true } : {}),
    ...(typeof r.recordFailure === 'string' ? { recordFailure: r.recordFailure } : {}),
  };
}

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
