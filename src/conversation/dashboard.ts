/**
 * Dashboard module — personal Kanban board + statistics.
 * Extends the existing Fastify conversation web server.
 *
 * Routes:
 *   GET  /dashboard                          → Dashboard HTML (all users overview)
 *   GET  /dashboard/:userId                  → Dashboard HTML (specific user)
 *   GET  /api/dashboard/sessions             → All active sessions as Kanban data (JSON)
 *   GET  /api/dashboard/stats                → Period statistics, one user or all users (JSON)
 *   GET  /api/dashboard/usage                → Period token usage + cost, one user or all users (JSON)
 *   GET  /api/dashboard/users                → User list (JSON)
 *   GET  /api/dashboard/lifecycle            → Session lifecycle policy (JSON; also in the sessions response)
 *   PUT  /api/dashboard/lifecycle            → Update it (admin: viewer token, or ADMIN_USERS + X-Admin-Mode: on);
 *                                              409 + counts when it would sleep/end sessions, unless ?confirm=1
 *   GET  /api/dashboard/session/:id          → Session detail turns (JSON)
 *   GET  /api/dashboard/session/:id/worklog  → Work log entries (JSON, registered in work-log-routes.ts)
 *   POST /api/dashboard/session/:id/generate-title → Generate titleSub via codex model
 *   POST /api/dashboard/session/:key/stop    → Stop a working session
 *   POST /api/dashboard/session/:key/close   → Close/terminate a session
 *   POST /api/dashboard/session/:key/trash   → Trash (hide) a closed session
 *   POST /api/dashboard/session/:key/command → Send command to session
 *   POST /api/dashboard/session/:key/goal    → Add a goal / delete the current or a queued goal
 *   POST /api/dashboard/session/:key/model   → Switch to a representative model (compacts first when needed)
 *   POST /api/dashboard/session/:conversationId/resummarize/:turnId → Retry summary generation
 *   WS   /ws/dashboard                       → Real-time session state updates (WebSocket),
 *                                              incl. `work_log` entries (owner/admin scoped)
 */

import { sumLiveUsage } from '@soma/slack/live-usage';
import { livePendingModelSwitch } from '@soma/slack/model-switch';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { displayTitle } from '../format/display-title';
import { Logger } from '../logger';
import { MetricsEventStore } from '../metrics/event-store';
import { calculateTokenCost } from '../metrics/model-registry';
import { ReportAggregator } from '../metrics/report-aggregator';
import type { MetricsEvent } from '../metrics/types';
import { clampEffortToModel } from '../model-catalog';
import { resolveEffectiveAutoCompact } from '../session/autocompact-policy';
import { EffortSwitchError, type EffortSwitchResult } from '../session/effort-switch';
import { productionModelCatalogDeps } from '../session/model-catalog-deps';
import {
  listRepresentativeModels,
  ModelSwitchError,
  type ModelSwitchResult,
  usedContextTokens,
} from '../session/model-switch';
import { ledgerTasks, sanitizeTaskLedger } from '../session/task-ledger';
import { type ArchivedSession, getArchiveStore } from '../session-archive';
import {
  countLifecycleTransitions,
  getSessionLifecyclePolicy,
  isSessionLifecyclePolicyDegraded,
  previewSessionLifecyclePolicy,
  SessionLifecyclePolicyError,
  updateSessionLifecyclePolicy,
} from '../session-lifecycle-policy';
import { GOAL_EVAL_DISPATCH_MAX_RETRIES } from '../slack/goal-completion-evaluator';
import { type HostGoalAction, HostGoalActionError, type HostGoalActionResult } from '../slack/goal-host-actions';
import { getSurfaceLines } from '../slack/surface-config';
import { buildThreadPermalink } from '../turn-notifier';
import { coerceEffort, EFFORT_LEVELS, type EffortLevel, userSettingsStore } from '../user-settings-store';
import { fetchSiblingBoards, type InstanceEnvironment, mergeBoards, shouldAggregate } from './aggregator';
import { readAllInstances } from './instance-registry';
import { getConversation, resummarizeTurn, updateConversationTitleSub } from './recorder';
import { generateTitle } from './title-generator';
import type { WorkLogEntry } from './work-log';

const logger = new Logger('Dashboard');

// ── Types ──────────────────────────────────────────────────────────

export interface KanbanSession {
  key: string;
  title: string;
  /**
   * Latest assistant-turn summaryTitle for this session, when one has been
   * generated. Clients prefer this over {@link title} for card display so
   * refreshed pages match the live `summaryTitleChanged` WS patch. Absent
   * when no assistant turn has produced a summaryTitle yet.
   */
  summaryTitle?: string;
  /**
   * Server-resolved card / panel headline (#762). Computed by `displayTitle()`
   * over the full priority chain (`summaryTitle → issueTitle → prTitle →
   * title → 'Untitled'`). Clients render this verbatim instead of repeating
   * the priority logic, so card and panel surfaces stay in lock-step.
   */
  displayHeadline: string;
  ownerName: string;
  ownerId: string;
  workflow: string;
  model: string;
  channelId: string;
  threadTs?: string;
  activityState: 'working' | 'waiting' | 'idle';
  sessionState: string; // MAIN | SLEEPING
  terminated?: boolean;
  trashed?: boolean;
  conversationId?: string;
  lastActivity: string; // ISO
  /** Links */
  issueUrl?: string;
  issueLabel?: string;
  issueTitle?: string;
  prUrl?: string;
  prLabel?: string;
  prTitle?: string;
  prStatus?: string;
  /** Merge stats */
  mergeStats?: {
    totalLinesAdded: number;
    totalLinesDeleted: number;
  };
  /**
   * Token usage — session totals of every token kind and the API-equivalent
   * cost. While a turn runs, the calls it has made so far are folded in
   * (SSOT 2026-10-22 T1/T2), so the numbers grow during the turn.
   */
  tokenUsage?: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreateTokens: number;
    totalCostUsd: number;
    contextUsagePercent: number;
  };
  /**
   * SSOT 2026-10-22 T11 — when the work finished (epoch ms): an idle / sleeping
   * card when it last went idle (else its last activity), an archived card at
   * its last activity. Absent while the session works or waits.
   */
  doneAt?: number;
  /**
   * SSOT 2026-10-22 T4/T5 — tokens the context holds now, the threshold it
   * auto-compacts at (follows the model), and the representative model a
   * switch waits to apply once the running compact seals.
   */
  contextTokens?: number;
  autoCompactTokens?: number;
  pendingModel?: string;
  /**
   * Task list — the model's latest TodoWrite list, from the session's task
   * ledger (SSOT 2026-10-22 T7/T8): each task has its own id (`T<n>`), its
   * elapsed time and the tool calls made while it ran.
   */
  tasks?: DashboardTask[];
  /** Tasks a later list no longer holds (completed earlier), newest first. */
  earlierTasks?: DashboardTask[];
  /** Slack thread permalink */
  slackThreadUrl?: string;
  /** Dashboard v2.1 — live turn timer + counters (per session) */
  activeLegStartedAtMs?: number;
  activeAccumulatedMs?: number;
  compactionCount?: number;
  /** Dashboard v2.1 — thread aggregate (derived, not persisted) */
  threadTotalActiveMs?: number;
  threadSessionCount?: number;
  threadCompactionCount?: number;
  /** Per-session effort level, normalised via coerceEffort. */
  effort?: EffortLevel;
  /** The level the session's model actually runs, when it caps `effort` (SSOT 2026-10-23 T1). */
  effortEffective?: string;
  /** Jira short key like "PROJ-123" derived from issueUrl */
  issueShortRef?: string;
  /** GitHub PR short ref like "PR-123" derived from prUrl */
  prShortRef?: string;
  /**
   * #814 — environment metadata identifying which soma-work instance owns
   * this card. Self cards get the local instance's env; sibling cards
   * get their owner's env after the aggregator stamps them on the merge
   * path. The frontend renders an env badge from this and groups token
   * stats by `instanceName`. Always present once `setSelfInstanceEnv()`
   * has been called from `startWebServer` — defensive `?` because tests
   * exercise paths that don't initialize the env (and the badge is
   * suppressed when missing).
   */
  environment?: {
    instanceName: string;
    port: number;
    host: string;
  };
  /**
   * The session's goal list (SSOT 2026-10-21 T2): the current goal with its
   * state, and the goals queued behind it in start order. Absent when the
   * session has never had a goal.
   */
  goal?: KanbanGoal;
  /**
   * Set when the session is idle only because the system will start it again
   * by itself (see {@link KanbanAutoResume}). Such a card is unfinished work:
   * the board puts it in `working`, not `idle`. Absent otherwise.
   */
  autoResume?: KanbanAutoResume;
  /** Pending user choice question (present when activityState === 'waiting' and a question was asked) */
  pendingQuestion?: {
    type: 'user_choice' | 'user_choices';
    question: string;
    choices?: Array<{ id: string; label: string; description?: string }>;
    /** ID of the recommended choice (single-choice) */
    recommendedChoiceId?: string;
    /** Multi-choice fields */
    questions?: Array<{
      id: string;
      question: string;
      choices: Array<{ id: string; label: string; description?: string }>;
      context?: string;
      recommendedChoiceId?: string;
    }>;
    questionCount?: number;
    title?: string;
    description?: string;
  };
}

/** One task as the dashboard shows it (a `TaskRecord` of `session/task-ledger.ts`). */
export interface DashboardTask {
  id: string;
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  startedAt?: number;
  completedAt?: number;
  toolCalls: number;
}

export interface KanbanGoal {
  current?: {
    goalId: string;
    objective: string;
    /** `active` drives the loop; `paused` keeps the objective but stops injecting it; `complete` is the last finished goal. */
    status: 'active' | 'paused' | 'complete';
    /** Auto-continuation turns since the last real user message, and the cap. */
    continuationCount: number;
    maxContinuations: number;
    /** The last completion-eval verdict that said "not yet" — what is still missing. */
    lastEvalReason?: string;
  };
  queue: Array<{ goalId: string; objective: string }>;
  completedCount: number;
  /** SSOT 2026-10-22 T6 — completed goals with their details, newest first. */
  history: KanbanGoalHistoryItem[];
}

/** One completed goal as the card lists it (SSOT 2026-10-22 T6). */
export interface KanbanGoalHistoryItem {
  goalId: string;
  objective: string;
  createdAt?: number;
  completedAt?: number;
  /** `user` (goal done) or `eval-model` (the completion evaluator). */
  completedVia?: string;
  /** The evaluator's verdict, or `user`. Capped. */
  completionReason?: string;
  /** Active turn time spent on the goal (ms). */
  activeMsUsed?: number;
  /** Every token kind spent on the goal. */
  tokens?: number;
  costUsd?: number;
  /** Auto-continuation turns it took. */
  continuationCount?: number;
}

/**
 * Why an idle session is not done: something the system armed will start it
 * again without the user.
 *
 * - `error-retry` — the last turn failed with a recoverable error (429 pool
 *   rate limit, transient API error) and is re-run at `at`.
 * - `goal-eval-retry` — the goal's completion check failed the same way and
 *   is re-run at `at`; the next turn follows if the goal is not met.
 * - `goal-eval` — the goal's completion check is running now.
 */
export interface KanbanAutoResume {
  kind: 'error-retry' | 'goal-eval-retry' | 'goal-eval';
  /** Epoch ms the resume fires. Absent for `goal-eval` (already running). */
  at?: number;
  /** Which retry this is, and the budget — "attempt 1/3". */
  attempt?: number;
  maxAttempts?: number;
  /** First line of the error that caused the retry. */
  reason?: string;
}

export interface KanbanBoard {
  working: KanbanSession[];
  waiting: KanbanSession[];
  idle: KanbanSession[];
  closed: KanbanSession[];
}

export interface UserDayStats {
  date: string;
  sessionsCreated: number;
  turnsUsed: number;
  prsCreated: number;
  prsMerged: number;
  commitsCreated: number;
  linesAdded: number;
  linesDeleted: number;
  mergeLinesAdded: number;
  mergeLinesDeleted: number;
  workflowCounts: Record<string, number>;
}

export interface UserStats {
  /** null = every user (no userId asked). */
  userId: string | null;
  period: 'day' | 'week' | 'month';
  days: UserDayStats[];
  totals: {
    sessionsCreated: number;
    turnsUsed: number;
    prsCreated: number;
    prsMerged: number;
    commitsCreated: number;
    linesAdded: number;
    linesDeleted: number;
    mergeLinesAdded: number;
    mergeLinesDeleted: number;
    workflowCounts: Record<string, number>;
  };
}

// ── Self-instance environment (#814) ───────────────────────────────

/**
 * The local instance's environment metadata, set once by `web-server.ts`
 * after `activePort` is finalized. Used to stamp self-owned cards with
 * `environment` and to compose `${instanceName}::${originalKey}` keys
 * so the client cache and the cross-instance aggregator can distinguish
 * cards from sibling instances.
 *
 * Null until set — code paths that build cards before
 * `setSelfInstanceEnv` runs (e.g. tests that exercise the dashboard
 * without booting the server) emit raw keys and no environment, which
 * keeps backward compat with the existing dashboard.test.ts snapshots
 * that assert `key === 'C1:t1'` directly.
 */
let _selfInstanceEnv: InstanceEnvironment | null = null;

/** Wire the local instance's env. Called by `startWebServer`. */
export function setSelfInstanceEnv(env: InstanceEnvironment): void {
  _selfInstanceEnv = env;
}

/** Test helper — clear the self env between cases. */
export function __resetSelfInstanceEnvForTests(): void {
  _selfInstanceEnv = null;
  _aggregatorCacheClear();
}

// #814 — Per-process TTL cache for sibling fan-out. Collapses concurrent
// /api/dashboard/sessions polls (multiple browser tabs) into one fan-out;
// 1500 ms < 30 s poll cadence so a sibling that just came up surfaces on
// the next tick.
const AGGREGATOR_CACHE_TTL_MS = 1_500;
type SiblingBoards = Awaited<ReturnType<typeof fetchSiblingBoards>>;
let _aggregatorCache: { value: SiblingBoards; stamp: number } | null = null;
function _aggregatorCacheGet(): SiblingBoards | null {
  if (_aggregatorCache === null) return null;
  if (Date.now() - _aggregatorCache.stamp > AGGREGATOR_CACHE_TTL_MS) return null;
  return _aggregatorCache.value;
}
function _aggregatorCacheSet(siblings: SiblingBoards): void {
  _aggregatorCache = { value: siblings, stamp: Date.now() };
}
function _aggregatorCacheClear(): void {
  _aggregatorCache = null;
}

/**
 * Build the wire-format key for a session. When the local env is wired
 * (production), keys are `${instanceName}::${originalKey}` — collision-
 * proof against sibling instances. When it's not wired (legacy tests),
 * we return the original key untouched.
 */
function composeSessionKey(originalKey: string): string {
  if (!_selfInstanceEnv) return originalKey;
  if (originalKey.startsWith(`${_selfInstanceEnv.instanceName}::`)) return originalKey;
  return `${_selfInstanceEnv.instanceName}::${originalKey}`;
}

/**
 * Inverse of {@link composeSessionKey}: strip the `${selfInstance}::`
 * prefix from an action endpoint's `:key` param.
 *
 * Three outcomes (#814 silent-failure-hunter audit):
 *   - **No env wired** (legacy / single-instance): return `wireKey` unchanged.
 *   - **No `::` separator**: return `wireKey` unchanged (legacy clients
 *     that haven't seen a composite key yet, e.g. immediately after upgrade).
 *   - **`foreign-instance::raw`**: return `null` — the action targets a
 *     sibling instance that this server does not own. Callers must surface a
 *     409 with a redirect hint, not silently pass through and 403/no-op.
 *   - **`self::raw`**: strip and return `raw`.
 */
function stripSelfInstancePrefix(wireKey: string): string | null {
  if (!_selfInstanceEnv) return wireKey;
  // Only treat as composite when `::` is present — bare keys remain
  // backward-compatible for clients that pre-date the composite wire format.
  const sepIdx = wireKey.indexOf('::');
  if (sepIdx < 0) return wireKey;
  const prefix = wireKey.slice(0, sepIdx);
  // The session storage layer uses `archived_<channel>:<thread>_<ts>` as a
  // key shape — the prefix in that case is the literal string `archived_…`,
  // not an instance name. We only treat the prefix as an instance routing
  // hint when it matches the self instance; everything else is left alone.
  if (prefix === _selfInstanceEnv.instanceName) {
    return wireKey.slice(sepIdx + 2);
  }
  // Anything else with `::` is a foreign instance — refuse.
  return null;
}

/**
 * Helper for action endpoints — wrap `stripSelfInstancePrefix` and emit a
 * uniform 409 reply when the wire key targets a sibling instance, so the
 * caller's frontend can show "open this card on $sibling".
 *
 * Returns the resolved local key, or null if the request was rejected
 * (in which case the reply has already been sent).
 */
function resolveSelfActionKey(wireKey: string, reply: any): string | null {
  const local = stripSelfInstancePrefix(wireKey);
  if (local === null) {
    reply.status(409).send({
      error:
        'Cross-instance action not supported — this session belongs to another soma-work instance. Open that instance directly to act on it.',
      wireKey,
    });
    return null;
  }
  return local;
}

/**
 * Resolve the wire-format `:key` route param to a local session key AND
 * gate on `requireSessionOwner` in one call. Centralizes the
 * (cross-instance reject → owner gate) preamble that every action
 * endpoint shares. Returns null if either check failed (the reply has
 * already been sent).
 */
function resolveSelfActionKeyAndOwner(request: any, reply: any): { wireKey: string; originalKey: string } | null {
  const wireKey: string = request.params?.key ?? '';
  const originalKey = resolveSelfActionKey(wireKey, reply);
  if (originalKey === null) return null;
  if (!requireSessionOwner(request, reply, originalKey)) return null;
  return { wireKey, originalKey };
}

// ── Session data accessor ──────────────────────────────────────────

type SessionAccessor = () => Map<string, any>;
let _getSessionsFn: SessionAccessor | null = null;

/** Register session accessor (called once at startup) */
export function setDashboardSessionAccessor(fn: SessionAccessor): void {
  _getSessionsFn = fn;
}

function getAllSessions(): Map<string, any> {
  if (!_getSessionsFn) return new Map();
  return _getSessionsFn();
}

/** The lifecycle policy as the page sees it; `degraded` only when the saved policy is unreadable. */
function lifecycleView(): ReturnType<typeof getSessionLifecyclePolicy> & { degraded?: true } {
  const policy = getSessionLifecyclePolicy();
  return isSessionLifecyclePolicyDegraded() ? { ...policy, degraded: true } : policy;
}

/**
 * #716 write-access predicate. Returns true when the authenticated
 * caller may mutate a resource owned by `ownerId`:
 *   - bearer admin (viewer token / API client)
 *   - oauth user, owns the resource
 *   - oauth user in ADMIN_USERS AND `X-Admin-Mode: on` header set
 *
 * The header alone proves nothing — `authContext.isAdmin` is rebuilt
 * per-request from the verified JWT, so a non-admin shipping `on` is
 * still rejected.
 */
function _hasWriteAccess(request: any, ownerId: string | undefined): boolean {
  const authContext = request.authContext;
  if (authContext?.mode === 'bearer_header' || authContext?.mode === 'bearer_cookie') return true;
  if (authContext?.userId && ownerId && authContext.userId === ownerId) return true;
  const adminModeHeader = request.headers?.['x-admin-mode'];
  const adminModeOn = Array.isArray(adminModeHeader) ? adminModeHeader[0] === 'on' : adminModeHeader === 'on';
  if (authContext?.isAdmin && adminModeOn) return true;
  return false;
}

/**
 * Write-gate for kanban session actions (stop / close / trash / command /
 * answer-* / submit-recommended). Reads remain world-readable per #716.
 */
function requireSessionOwner(request: any, reply: any, sessionKey: string): boolean {
  const sessions = _getSessionsFn?.();
  const targetSession = sessions?.get(sessionKey);
  if (_hasWriteAccess(request, targetSession?.ownerId)) return true;
  reply.status(403).send({
    error: 'Forbidden — write requires session ownership, or admin user with X-Admin-Mode: on header (#716)',
  });
  return false;
}

/**
 * Same #716 write-access policy applied to a conversation record (used
 * by `resummarize` and `generate-title` which key off the conversation,
 * not the live session). Oracle re-review (#717 P2) caught that those
 * two write routes still used the older `authContext.isAdmin` shortcut
 * and skipped the X-Admin-Mode gate.
 */
function requireConversationWriteAccess(request: any, reply: any, ownerId: string | undefined): boolean {
  if (_hasWriteAccess(request, ownerId)) return true;
  reply.status(403).send({
    error: 'Forbidden — write requires conversation ownership, or admin user with X-Admin-Mode: on header (#716)',
  });
  return false;
}

// ── Task accessor ──────────────────────────────────────────────────

type TaskAccessor = (sessionKey: string) => { current: DashboardTask[]; earlier: DashboardTask[] } | undefined;
let _getTasksFn: TaskAccessor | null = null;

/** Register task accessor (called once at startup) */
export function setDashboardTaskAccessor(fn: TaskAccessor): void {
  _getTasksFn = fn;
}

// ── Action callbacks ───────────────────────────────────────────────

type StopHandler = (sessionKey: string) => Promise<void>;
type CloseHandler = (sessionKey: string) => Promise<void>;
type TrashHandler = (sessionKey: string) => Promise<void>;
type CommandHandler = (sessionKey: string, message: string) => Promise<void>;

let _stopHandlerFn: StopHandler | null = null;
let _closeHandlerFn: CloseHandler | null = null;
let _trashHandlerFn: TrashHandler | null = null;
let _commandHandlerFn: CommandHandler | null = null;

export function setDashboardStopHandler(fn: StopHandler): void {
  _stopHandlerFn = fn;
}
export function setDashboardCloseHandler(fn: CloseHandler): void {
  _closeHandlerFn = fn;
}
export function setDashboardTrashHandler(fn: TrashHandler): void {
  _trashHandlerFn = fn;
}
export function setDashboardCommandHandler(fn: CommandHandler): void {
  _commandHandlerFn = fn;
}

/**
 * Goal list actions from the work item (SSOT 2026-10-21 T3). The handler is
 * `SlackHandler.handleHostGoalAction`; it throws `HostGoalActionError` for
 * every refusal, whose `statusCode` the route answers with.
 */
type GoalActionHandler = (
  sessionKey: string,
  action: HostGoalAction,
  actorUserId?: string,
) => Promise<HostGoalActionResult>;
let _goalActionHandlerFn: GoalActionHandler | null = null;

export function setDashboardGoalHandler(fn: GoalActionHandler): void {
  _goalActionHandlerFn = fn;
}

/**
 * SSOT 2026-10-22 T4/T5 — switch a session to a representative model
 * (`session/model-switch.ts` `switchSessionModel`). Throws `ModelSwitchError`
 * for every refusal, whose `statusCode` the route answers with.
 */
type ModelSwitchHandler = (sessionKey: string, nickname: string) => Promise<ModelSwitchResult>;
let _modelSwitchHandlerFn: ModelSwitchHandler | null = null;

export function setDashboardModelHandler(fn: ModelSwitchHandler): void {
  _modelSwitchHandlerFn = fn;
}

/**
 * SSOT 2026-10-23 T1 — change one session's reasoning effort
 * (`session/effort-switch.ts` `switchSessionEffort`, the `%effort` scope).
 * Throws `EffortSwitchError` for every refusal, whose `statusCode` the route
 * answers with.
 */
type EffortSwitchHandler = (sessionKey: string, effort: string) => EffortSwitchResult | Promise<EffortSwitchResult>;
let _effortSwitchHandlerFn: EffortSwitchHandler | null = null;

export function setDashboardEffortHandler(fn: EffortSwitchHandler): void {
  _effortSwitchHandlerFn = fn;
}

type ChoiceAnswerHandler = (sessionKey: string, choiceId: string, label: string, question: string) => Promise<void>;
let _choiceAnswerHandlerFn: ChoiceAnswerHandler | null = null;

export function setDashboardChoiceAnswerHandler(fn: ChoiceAnswerHandler): void {
  _choiceAnswerHandlerFn = fn;
}

type MultiChoiceAnswerHandler = (
  sessionKey: string,
  selections: Record<string, { choiceId: string; label: string }>,
) => Promise<void>;
let _multiChoiceAnswerHandlerFn: MultiChoiceAnswerHandler | null = null;

export function setDashboardMultiChoiceAnswerHandler(fn: MultiChoiceAnswerHandler): void {
  _multiChoiceAnswerHandlerFn = fn;
}

// Hero "Submit All Recommended" handler (group-only). The dashboard does not
// pass selections — the implementation derives them from session.pendingQuestion
// recommendations. Returns rejected promise on validation failure for
// status-code mapping in the route handler.
type SubmitRecommendedHandler = (sessionKey: string) => Promise<void>;
let _submitRecommendedHandlerFn: SubmitRecommendedHandler | null = null;

export function setDashboardSubmitRecommendedHandler(fn: SubmitRecommendedHandler): void {
  _submitRecommendedHandlerFn = fn;
}

// ── Kanban transformation ──────────────────────────────────────────

// Dashboard v2.1 — max active-leg duration cap (mirrors session-registry).
// Duplicated here (not imported) so dashboard.ts stays independent of
// session-registry in the mcp-servers split.
const DASHBOARD_MAX_LEG_MS = Number(process.env.MAX_LEG_MS) || 30 * 60 * 1000;

function computeThreadAggregate(
  channelId: string,
  threadTs: string | undefined,
  allSessions: Map<string, any>,
  now: number,
): { totalActiveMs: number; sessionCount: number; compactionCount: number } {
  // Match on session FIELDS, not a constructed key: aggregation must never
  // throw on hostile/corrupt in-memory data (the shared identity builder
  // rejects separator characters), and the fields are the ground truth the
  // map key is derived from anyway.
  let totalActiveMs = 0;
  let sessionCount = 0;
  let compactionCount = 0;
  for (const s of allSessions.values()) {
    if (s.channelId !== channelId || (s.threadTs || undefined) !== (threadTs || undefined)) continue;
    sessionCount += 1;
    compactionCount += s.compactionCount || 0;
    let acc = s.activeAccumulatedMs || 0;
    if (s.activeLegStartedAtMs) {
      acc += Math.min(now - s.activeLegStartedAtMs, DASHBOARD_MAX_LEG_MS);
    }
    totalActiveMs += acc;
  }
  return { totalActiveMs, sessionCount, compactionCount };
}

/**
 * Extract Jira-style short key from a "/browse/KEY-123" issue URL.
 * URL-only (no label fallback) to avoid false positives like "HTTP-200".
 * Key must be 2+ uppercase letters followed by "-<digits>" (Jira project-key convention).
 */
export function extractIssueShortRef(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/browse\/([A-Z]{2,}-\d+)/);
  return m ? m[1] : undefined;
}

/**
 * Extract "PR-<number>" from a GitHub PR URL. URL-only.
 * Trailing boundary: "/", "?", "#", or end of string (so .../pull/123#comment-... also matches).
 */
export function extractPrShortRef(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return m ? `PR-${m[1]}` : undefined;
}

/**
 * Card-derived UI fields shared between live (sessionToKanban) and archived
 * (archivedToKanban) kanban builders. Archived sessions don't persist effort,
 * so their branch always falls back to the owner's default; live sessions
 * use the persisted value when present.
 */
function cardDerivedFields(src: {
  effort?: unknown;
  ownerId?: string;
  model?: string;
  links?: { issue?: { url?: string }; pr?: { url?: string } };
  persistedEffort: boolean;
}): Pick<KanbanSession, 'effort' | 'effortEffective' | 'issueShortRef' | 'prShortRef'> {
  const effort =
    src.persistedEffort && src.effort
      ? coerceEffort(src.effort)
      : userSettingsStore.getUserDefaultEffort(src.ownerId || '');
  // SSOT 2026-10-23 T1 — the level the model really runs (build-stream-options
  // clamps the same way); present only when the model caps the chosen level.
  const clamped = src.model ? clampEffortToModel(src.model, effort) : effort;
  return {
    effort,
    ...(clamped !== effort ? { effortEffective: clamped } : {}),
    issueShortRef: extractIssueShortRef(src.links?.issue?.url),
    prShortRef: extractPrShortRef(src.links?.pr?.url),
  };
}

const KANBAN_GOAL_STATUSES = new Set(['active', 'paused', 'complete']);

function positiveCount(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The armed automatic resume of a live session, if any (see
 * {@link KanbanAutoResume}). Reads the persisted markers the resume machinery
 * itself trusts: an error auto-retry counts only while its marker belongs to
 * the current run (`pendingRetrySessionId === sessionId`) and the session is
 * not asleep — the same rule `resumePendingErrorRetries` uses to re-arm it
 * after a restart (#351); `goal.evalBackoffUntil` is re-armed by the
 * post-restart goal resume (`resumeActiveGoals` → backoff gate). The soonest
 * action wins: a turn retry before a goal re-check.
 */
export function deriveAutoResume(s: any, now: number): KanbanAutoResume | undefined {
  const retryAt = Number(s?.pendingRetryAt);
  if (
    Number.isFinite(retryAt) &&
    retryAt > now &&
    s.state !== 'SLEEPING' &&
    s.pendingRetrySessionId !== undefined &&
    s.pendingRetrySessionId === s.sessionId
  ) {
    const detail = s.pendingRetryDetail ?? {};
    return {
      kind: 'error-retry',
      at: retryAt,
      attempt: positiveCount(detail.attempt),
      maxAttempts: positiveCount(detail.maxAttempts),
      reason: typeof detail.reason === 'string' && detail.reason ? detail.reason : undefined,
    };
  }
  const goal = s?.goal;
  if (!goal || goal.status !== 'active') return undefined;
  const backoffUntil = Number(goal.evalBackoffUntil);
  if (Number.isFinite(backoffUntil) && backoffUntil > now) {
    return {
      kind: 'goal-eval-retry',
      at: backoffUntil,
      attempt: positiveCount(goal.evalDispatchRetryCount),
      maxAttempts: GOAL_EVAL_DISPATCH_MAX_RETRIES,
      reason: typeof goal.evalRetryReason === 'string' && goal.evalRetryReason ? goal.evalRetryReason : undefined,
    };
  }
  if (goal.pendingEval) return { kind: 'goal-eval' };
  return undefined;
}

/**
 * The task list as the dashboard shows it: at most ONE task in progress.
 *
 * TodoWrite is a model-written snapshot and the model does mark several
 * tasks `in_progress` at once (parallel background work) — shown verbatim,
 * the timeline and panel spun two or three "current" tasks side by side. The
 * one current task is the first `in_progress` in list order (the task the
 * card's task row already names — `cardCurrentTask`); any later `in_progress`
 * reads as `pending`. A session with no work in flight (`hasCurrent` false —
 * see {@link sessionHasCurrentTask}) has no current task at all: every
 * `in_progress` reads as `pending`, the rule the Slack plan block applies when
 * a turn ends (`task-list-block-builder` finalize demotion). Display-only: the
 * stored snapshot (and its timestamps) is untouched, so the choice is stable
 * across updates.
 */
export function normalizeTaskProgress<T extends { status: string }>(
  tasks: readonly T[] | undefined,
  hasCurrent: boolean,
): T[] | undefined {
  if (!tasks) return undefined;
  let currentTaken = !hasCurrent;
  return tasks.map((t) => {
    if (t.status !== 'in_progress') return t;
    if (!currentTaken) {
      currentTaken = true;
      return t;
    }
    return { ...t, status: 'pending' };
  });
}

/**
 * Does this live session have work in flight, so one task may read as
 * current? A running turn, a question waiting on the user (the card's task row
 * names what it was doing), or an armed automatic resume (the task it will
 * pick up again). An idle session in DONE has none.
 */
export function sessionHasCurrentTask(s: any, autoResume: KanbanAutoResume | undefined): boolean {
  const state = s?.activityState;
  return state === 'working' || state === 'waiting' || autoResume !== undefined;
}

/** The goal list of a live session, shaped for the card (`KanbanSession.goal`). */
function goalToKanban(s: any): KanbanGoal | undefined {
  const goal = s.goal;
  const queue: any[] = Array.isArray(s.goalQueue) ? s.goalQueue : [];
  const history: any[] = Array.isArray(s.goalHistory) ? s.goalHistory : [];
  if (!goal && queue.length === 0 && history.length === 0) return undefined;
  return {
    current:
      goal && typeof goal.goalId === 'string' && KANBAN_GOAL_STATUSES.has(goal.status)
        ? {
            goalId: goal.goalId,
            objective: String(goal.objective ?? ''),
            status: goal.status,
            continuationCount: Number(goal.continuationCount) || 0,
            maxContinuations: Number(goal.maxContinuations) || 0,
            ...(typeof goal.lastEvalReason === 'string' && goal.lastEvalReason
              ? { lastEvalReason: goal.lastEvalReason }
              : {}),
          }
        : undefined,
    queue: queue
      .filter((g) => g && typeof g.goalId === 'string')
      .map((g) => ({ goalId: g.goalId, objective: String(g.objective ?? '') })),
    completedCount: history.length,
    history: history
      // A finished goal stays current when its queue is empty and is ALSO in the
      // history; the current block shows only objective + state, so the list
      // keeps it — the count and the list always agree.
      .filter((g) => g && typeof g.goalId === 'string')
      .map(goalHistoryItem)
      .reverse(),
  };
}

const GOAL_REASON_MAX = 1000;
function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/** A completed goal's details for the card (T6) — known fields only, numbers as numbers. */
function goalHistoryItem(g: any): KanbanGoalHistoryItem {
  const tokenParts = [g.tokensInput, g.tokensOutput, g.tokensCacheRead, g.tokensCacheCreate].map(finiteNumber);
  const item: KanbanGoalHistoryItem = { goalId: g.goalId, objective: String(g.objective ?? '') };
  const createdAt = finiteNumber(g.createdAt);
  if (createdAt !== undefined) item.createdAt = createdAt;
  const completedAt = finiteNumber(g.completedAt);
  if (completedAt !== undefined) item.completedAt = completedAt;
  if (typeof g.completedVia === 'string') item.completedVia = g.completedVia;
  if (typeof g.completionReason === 'string' && g.completionReason) {
    item.completionReason = g.completionReason.slice(0, GOAL_REASON_MAX);
  }
  const activeMsUsed = finiteNumber(g.activeMsUsed);
  if (activeMsUsed !== undefined) item.activeMsUsed = activeMsUsed;
  if (tokenParts.some((n) => n !== undefined)) item.tokens = tokenParts.reduce<number>((a, n) => a + (n ?? 0), 0);
  const costUsd = finiteNumber(g.costUsd);
  if (costUsd !== undefined) item.costUsd = costUsd;
  const continuationCount = finiteNumber(g.continuationCount);
  if (continuationCount !== undefined) item.continuationCount = continuationCount;
  return item;
}

/**
 * Session token totals for the card (T1/T2): the committed `usage.total*` plus
 * the calls of the turn still running (`liveUsage`), those priced at the
 * session model like the rest of the session's cost.
 */
function tokenUsageOf(s: any): KanbanSession['tokenUsage'] {
  const live = sumLiveUsage(s.liveUsage);
  const liveTokens = live.inputTokens + live.outputTokens + live.cacheReadTokens + live.cacheCreateTokens;
  if (!s.usage && liveTokens === 0) return undefined;
  const u = s.usage || {};
  const liveCost =
    liveTokens > 0
      ? calculateTokenCost(s.model, live.inputTokens, live.outputTokens, live.cacheReadTokens, live.cacheCreateTokens)
      : 0;
  return {
    totalInputTokens: (u.totalInputTokens || 0) + live.inputTokens,
    totalOutputTokens: (u.totalOutputTokens || 0) + live.outputTokens,
    totalCacheReadTokens: (u.totalCacheReadTokens || 0) + live.cacheReadTokens,
    totalCacheCreateTokens: (u.totalCacheCreateTokens || 0) + live.cacheCreateTokens,
    totalCostUsd: (u.totalCostUsd || 0) + liveCost,
    contextUsagePercent: u.contextWindow
      ? (((u.currentInputTokens || 0) +
          (u.currentCacheReadTokens || 0) +
          (u.currentCacheCreateTokens || 0) +
          (u.currentOutputTokens || 0)) /
          u.contextWindow) *
        100
      : 0,
  };
}

/** T4/T5 — context fill, the auto-compact threshold of the current model, a waiting switch. */
function modelFields(s: any): Pick<KanbanSession, 'contextTokens' | 'autoCompactTokens' | 'pendingModel'> {
  const out: Pick<KanbanSession, 'contextTokens' | 'autoCompactTokens' | 'pendingModel'> = {};
  if (s.usage) out.contextTokens = usedContextTokens(s);
  try {
    if (s.model) out.autoCompactTokens = resolveEffectiveAutoCompact(s, s.ownerId || '', userSettingsStore).tokens;
  } catch (error) {
    logger.debug('auto-compact threshold unavailable for the card', { error: (error as Error)?.message });
  }
  // Past its TTL the switch no longer counts: the picker unlocks.
  const pending = livePendingModelSwitch(s);
  if (pending && typeof pending.nickname === 'string') out.pendingModel = pending.nickname;
  return out;
}

/** T11 — when a live session's work finished; undefined while it works or waits. */
function liveDoneAt(s: any): number | undefined {
  const state = s.activityState || 'idle';
  if (state !== 'idle') return undefined;
  const changed = finiteNumber(s.activityStateChangedAt);
  if (changed) return changed;
  const last = s.lastActivity instanceof Date ? s.lastActivity.getTime() : Date.parse(String(s.lastActivity));
  return Number.isFinite(last) ? last : undefined;
}

function sessionToKanban(key: string, s: any): KanbanSession {
  const autoResume = deriveAutoResume(s, Date.now());
  const taskView = _getTasksFn ? _getTasksFn(key) : undefined;
  const aggregate = computeThreadAggregate(s.channelId, s.threadTs, getAllSessions(), Date.now());
  const headline = displayTitle(s);
  return {
    // #814 Wire-format key includes the local instance prefix so sibling
    // instances can never collide on the client cache.
    key: composeSessionKey(key),
    title: headline,
    displayHeadline: headline,
    // Emit summaryTitle so initial board renders (and full-page refresh) match
    // the live broadcastSummaryTitleChanged WS patch. Session registry stores
    // this on the session record itself — see session-registry.ts applyTitle.
    summaryTitle: typeof s.summaryTitle === 'string' && s.summaryTitle.length > 0 ? s.summaryTitle : undefined,
    ownerName: s.ownerName || s.ownerId || 'unknown',
    ownerId: s.ownerId || '',
    workflow: s.workflow || 'default',
    model: s.model || 'unknown',
    channelId: s.channelId,
    threadTs: s.threadTs,
    activityState: s.activityState || 'idle',
    sessionState: s.state || 'MAIN',
    terminated: s.terminated === true,
    trashed: s.trashed === true,
    conversationId: s.conversationId,
    lastActivity: s.lastActivity instanceof Date ? s.lastActivity.toISOString() : String(s.lastActivity),
    issueUrl: s.links?.issue?.url,
    issueLabel: s.links?.issue?.label,
    issueTitle: s.links?.issue?.title,
    prUrl: s.links?.pr?.url,
    prLabel: s.links?.pr?.label,
    prTitle: s.links?.pr?.title,
    prStatus: s.links?.pr?.status,
    mergeStats: s.mergeStats
      ? {
          totalLinesAdded: s.mergeStats.totalLinesAdded,
          totalLinesDeleted: s.mergeStats.totalLinesDeleted,
        }
      : undefined,
    tokenUsage: tokenUsageOf(s),
    doneAt: liveDoneAt(s),
    ...modelFields(s),
    tasks: normalizeTaskProgress(taskView?.current, sessionHasCurrentTask(s, autoResume)),
    earlierTasks: taskView?.earlier.length ? taskView.earlier : undefined,
    slackThreadUrl:
      s.channelId && s.threadTs ? (buildThreadPermalink(s.channelId, s.threadTs) ?? undefined) : undefined,
    // Dashboard v2.1 — timer + compaction fields
    activeLegStartedAtMs: s.activeLegStartedAtMs,
    activeAccumulatedMs: s.activeAccumulatedMs || 0,
    compactionCount: s.compactionCount || 0,
    threadTotalActiveMs: aggregate.totalActiveMs,
    threadSessionCount: aggregate.sessionCount,
    threadCompactionCount: aggregate.compactionCount,
    ...cardDerivedFields({
      effort: s.effort,
      ownerId: s.ownerId,
      model: s.model,
      links: s.links,
      persistedEffort: true,
    }),
    // #814 Stamp self env (when wired) so the frontend renders the env
    // badge for self cards too — siblings get their env from the
    // aggregator's mergeBoards stamp.
    environment: _selfInstanceEnv ? { ..._selfInstanceEnv } : undefined,
    goal: goalToKanban(s),
    ...(autoResume ? { autoResume } : {}),
    pendingQuestion: s.actionPanel?.pendingQuestion
      ? s.actionPanel.pendingQuestion.type === 'user_choice'
        ? {
            type: 'user_choice' as const,
            question: s.actionPanel.pendingQuestion.question,
            choices: s.actionPanel.pendingQuestion.choices?.map((c: any) => ({
              id: c.id,
              label: c.label,
              description: c.description,
            })),
            ...(s.actionPanel.pendingQuestion.recommendedChoiceId
              ? { recommendedChoiceId: s.actionPanel.pendingQuestion.recommendedChoiceId }
              : {}),
          }
        : s.actionPanel.pendingQuestion.type === 'user_choices'
          ? {
              type: 'user_choices' as const,
              question: s.actionPanel.pendingQuestion.title || '복수 질문',
              questionCount: s.actionPanel.pendingQuestion.questions?.length || 0,
              title: s.actionPanel.pendingQuestion.title,
              description: s.actionPanel.pendingQuestion.description,
              questions: s.actionPanel.pendingQuestion.questions?.map((q: any) => ({
                id: q.id,
                question: q.question,
                choices: (q.choices || []).map((c: any) => ({
                  id: c.id,
                  label: c.label,
                  description: c.description,
                })),
                context: q.context,
                ...(q.recommendedChoiceId ? { recommendedChoiceId: q.recommendedChoiceId } : {}),
              })),
            }
          : undefined // Unknown question type — skip
      : undefined,
  };
}

/** The task ledger an archive kept (T7/T8), as the card carries it. */
function archivedTasks(archived: ArchivedSession): Pick<KanbanSession, 'tasks' | 'earlierTasks'> {
  const ledger = sanitizeTaskLedger(archived.taskLedger);
  if (!ledger) return {};
  const view = ledgerTasks(ledger);
  // An archived session runs nothing: no task reads as current.
  return {
    tasks: normalizeTaskProgress(view.current, false),
    earlierTasks: view.earlier.length ? view.earlier : undefined,
  };
}

/**
 * Convert an ArchivedSession to KanbanSession for the closed column.
 * Trace: Scenario 3, Section 3a transformation
 */
function archivedToKanban(archived: ArchivedSession): KanbanSession {
  const headline = displayTitle(archived);
  return {
    // #814 Same composite-key scheme as live cards. The original archive
    // key already contains underscores and timestamps; the instance
    // prefix simply nests on top via `::`.
    key: composeSessionKey(`archived_${archived.sessionKey}_${archived.archivedAt}`),
    title: headline,
    displayHeadline: headline,
    summaryTitle:
      typeof archived.summaryTitle === 'string' && archived.summaryTitle.length > 0 ? archived.summaryTitle : undefined,
    ownerName: archived.ownerName || archived.ownerId || 'unknown',
    ownerId: archived.ownerId || '',
    workflow: archived.workflow || 'default',
    model: archived.model || 'unknown',
    channelId: archived.channelId,
    threadTs: archived.threadTs,
    activityState: 'idle', // Archived sessions are not active
    sessionState: archived.archiveReason === 'sleep_expired' ? 'SLEEPING' : 'TERMINATED',
    terminated: true,
    conversationId: archived.conversationId,
    lastActivity: archived.lastActivity,
    issueUrl: archived.links?.issue?.url,
    issueLabel: archived.links?.issue?.label,
    issueTitle: archived.links?.issue?.title,
    prUrl: archived.links?.pr?.url,
    prLabel: archived.links?.pr?.label,
    prTitle: archived.links?.pr?.title,
    prStatus: archived.links?.pr?.status,
    mergeStats: archived.mergeStats
      ? {
          totalLinesAdded: archived.mergeStats.totalLinesAdded,
          totalLinesDeleted: archived.mergeStats.totalLinesDeleted,
        }
      : undefined,
    tokenUsage: archived.usage
      ? {
          totalInputTokens: archived.usage.totalInputTokens || 0,
          totalOutputTokens: archived.usage.totalOutputTokens || 0,
          totalCacheReadTokens: archived.usage.totalCacheReadTokens || 0,
          totalCacheCreateTokens: archived.usage.totalCacheCreateTokens || 0,
          totalCostUsd: archived.usage.totalCostUsd || 0,
          contextUsagePercent: 0, // No active context for archived sessions
        }
      : undefined,
    doneAt: Number.isFinite(Date.parse(archived.lastActivity)) ? Date.parse(archived.lastActivity) : undefined,
    ...archivedTasks(archived),
    goal: goalToKanban(archived),
    slackThreadUrl:
      archived.channelId && archived.threadTs
        ? (buildThreadPermalink(archived.channelId, archived.threadTs) ?? undefined)
        : undefined,
    // Dashboard v2.1 — derive from archive snapshot fields.
    activeLegStartedAtMs: undefined, // archived sessions never have an open leg
    activeAccumulatedMs: archived.busyMs || 0,
    compactionCount: archived.compactionCount || 0,
    threadTotalActiveMs: archived.busyMs || 0,
    threadSessionCount: 1,
    threadCompactionCount: archived.compactionCount || 0,
    ...cardDerivedFields({ ownerId: archived.ownerId, links: archived.links, persistedEffort: false }),
    environment: _selfInstanceEnv ? { ..._selfInstanceEnv } : undefined,
  };
}

function buildKanbanBoard(userId?: string): KanbanBoard {
  const sessions = getAllSessions();
  const board: KanbanBoard = { working: [], waiting: [], idle: [], closed: [] };

  for (const [key, session] of sessions.entries()) {
    if (!session.sessionId) continue;
    if (userId && session.ownerId !== userId) continue;
    if (session.trashed === true) continue;

    const kanban = sessionToKanban(key, session);

    // Closed: SLEEPING state (terminated sessions are handled via archive below)
    if (session.state === 'SLEEPING') {
      board.closed.push(kanban);
    } else {
      switch (kanban.activityState) {
        case 'working':
          board.working.push(kanban);
          break;
        case 'waiting':
          board.waiting.push(kanban);
          break;
        default:
          // Idle but with an armed automatic resume (turn retry, goal
          // re-check) is unfinished work — RUNNING, not DONE.
          if (kanban.autoResume) board.working.push(kanban);
          else board.idle.push(kanban);
          break;
      }
    }
  }

  // Add recently archived sessions to closed column (#401)
  // Dedup: skip archives that overlap with a live session (same thread or same conversationId).
  // This prevents ghost cards when:
  //   - A bot-initiated thread terminates the source session (conversationId match)
  //   - A user sends a message to a terminated thread, creating a new session (thread key match)
  try {
    const liveThreadKeys = new Set<string>();
    const liveConversationIds = new Set<string>();
    for (const [, s] of sessions.entries()) {
      if (!s.sessionId) continue;
      if (s.trashed === true) continue;
      if (s.channelId && s.threadTs) liveThreadKeys.add(`${s.channelId}:${s.threadTs}`);
      if (s.conversationId) liveConversationIds.add(s.conversationId);
    }

    // How long archives stay listed is the admin-set lifecycle policy (48h default).
    const archives = getArchiveStore().listRecent(getSessionLifecyclePolicy().boardArchiveWindowMs);
    // Fix #438: Sort archives newest-first so the most recent interaction in a
    // thread/conversation wins during dedup (older terminated duplicates are dropped)
    const sortedArchives = [...archives].sort((a, b) => b.archivedAt - a.archivedAt);
    const seenArchiveConversationIds = new Set<string>();
    const seenArchiveThreadKeys = new Set<string>();
    for (const archived of sortedArchives) {
      // Fix #438: Skip archives without sessionId — these sessions were terminated
      // before any Claude interaction (e.g., bot-thread migration source sessions)
      if (!archived.sessionId) continue;
      if (userId && archived.ownerId !== userId) continue;
      // Skip if a live session exists in the same thread
      if (archived.channelId && archived.threadTs && liveThreadKeys.has(`${archived.channelId}:${archived.threadTs}`)) {
        logger.debug('Skipping archive (thread overlap with live session)', { archivedKey: archived.sessionKey });
        continue;
      }
      // Skip if a live session shares the same conversationId (bot-initiated migration)
      if (archived.conversationId && liveConversationIds.has(archived.conversationId)) {
        logger.debug('Skipping archive (conversationId overlap with live session)', {
          archivedKey: archived.sessionKey,
          conversationId: archived.conversationId,
        });
        continue;
      }
      // Fix #438: Archive-to-archive dedup — skip if we've already seen a newer archive
      // with the same conversationId or thread key
      if (archived.conversationId && seenArchiveConversationIds.has(archived.conversationId)) {
        continue;
      }
      const archiveThreadKey =
        archived.channelId && archived.threadTs ? `${archived.channelId}:${archived.threadTs}` : null;
      if (archiveThreadKey && seenArchiveThreadKeys.has(archiveThreadKey)) {
        continue;
      }
      // Track this archive for future dedup
      if (archived.conversationId) seenArchiveConversationIds.add(archived.conversationId);
      if (archiveThreadKey) seenArchiveThreadKeys.add(archiveThreadKey);
      board.closed.push(archivedToKanban(archived));
    }
  } catch (err) {
    logger.warn('Failed to load archived sessions for dashboard — closed column may be incomplete', err);
  }

  // Sort each column by lastActivity desc
  const byActivity = (a: KanbanSession, b: KanbanSession) =>
    new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  board.working.sort(byActivity);
  board.waiting.sort(byActivity);
  board.idle.sort(byActivity);
  board.closed.sort(byActivity);

  return board;
}

// ── Stats aggregation ──────────────────────────────────────────────

/** Per-day stats for one user, or for every user when `userId` is absent. */
function aggregateUserStats(events: MetricsEvent[], userId?: string): Map<string, UserDayStats> {
  const dayMap = new Map<string, UserDayStats>();

  for (const ev of events) {
    if (userId && ev.userId !== userId) continue;

    const dateStr = new Date(ev.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, {
        date: dateStr,
        sessionsCreated: 0,
        turnsUsed: 0,
        prsCreated: 0,
        prsMerged: 0,
        commitsCreated: 0,
        linesAdded: 0,
        linesDeleted: 0,
        mergeLinesAdded: 0,
        mergeLinesDeleted: 0,
        workflowCounts: {},
      });
    }
    const day = dayMap.get(dateStr)!;

    switch (ev.eventType) {
      case 'session_created': {
        day.sessionsCreated++;
        const wf = (ev.metadata?.workflow as string) || 'default';
        day.workflowCounts[wf] = (day.workflowCounts[wf] || 0) + 1;
        break;
      }
      case 'turn_used':
        day.turnsUsed++;
        break;
      case 'pr_created':
        day.prsCreated++;
        break;
      case 'pr_merged':
        day.prsMerged++;
        break;
      case 'commit_created':
        day.commitsCreated++;
        break;
      case 'code_lines_added':
        day.linesAdded += (ev.metadata?.linesAdded as number) || 0;
        day.linesDeleted += (ev.metadata?.linesDeleted as number) || 0;
        break;
      case 'merge_lines_added':
        day.mergeLinesAdded += (ev.metadata?.linesAdded as number) || 0;
        day.mergeLinesDeleted += (ev.metadata?.linesDeleted as number) || 0;
        break;
    }
  }

  return dayMap;
}

function getDateRange(period: 'day' | 'week' | 'month'): { startDate: string; endDate: string } {
  const now = new Date();
  const end = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

  let start: Date;
  switch (period) {
    case 'day':
      start = now;
      break;
    case 'week':
      start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      start = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
      break;
  }
  const startDate = start.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  return { startDate, endDate: end };
}

/**
 * Get date range starting from a specific date string (YYYY-MM-DD).
 */
function getDateRangeFrom(date: string, period: 'day' | 'week' | 'month'): { startDate: string; endDate: string } {
  const base = new Date(date + 'T00:00:00Z');
  switch (period) {
    case 'day':
      return { startDate: date, endDate: date };
    case 'week': {
      const end = new Date(base.getTime() + 6 * 24 * 60 * 60 * 1000);
      return { startDate: date, endDate: end.toISOString().slice(0, 10) };
    }
    case 'month': {
      const end = new Date(base.getTime() + 29 * 24 * 60 * 60 * 1000);
      return { startDate: date, endDate: end.toISOString().slice(0, 10) };
    }
  }
}

// ── WebSocket broadcast ────────────────────────────────────────────

type WsClient = { send: (data: string) => void; close: () => void; userId?: string; isAdmin?: boolean };
const wsClients = new Set<WsClient>();

/** Broadcast session state update to all connected WebSocket clients */
export function broadcastSessionUpdate(): void {
  if (wsClients.size === 0) return;
  try {
    const board = buildKanbanBoard();
    const payload = JSON.stringify({ type: 'session_update', board });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast session update', error);
  }
}

/** Broadcast task update to all connected WebSocket clients */
export function broadcastTaskUpdate(
  sessionKey: string,
  tasks: DashboardTask[],
  earlierTasks: DashboardTask[] = [],
): void {
  if (wsClients.size === 0) return;
  try {
    // #814 External callers (e.g. Slack handler) pass the raw session key.
    // Compose the wire-format key here so the client cache (keyed by
    // composite `${instanceName}::${rawKey}`) finds the card.
    const wireKey = composeSessionKey(sessionKey);
    // Same one-current-task view as the board payload (sessionToKanban).
    const live = _getSessionsFn?.().get(sessionKey);
    const payload = JSON.stringify({
      type: 'task_update',
      sessionKey: wireKey,
      tasks: normalizeTaskProgress(tasks, sessionHasCurrentTask(live, deriveAutoResume(live, Date.now()))),
      earlierTasks,
    });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast task update', error);
  }
}

/**
 * Send a payload to the conversation's audience: the owning session's owner
 * plus admin clients. Shared by `conversation_update` and `work_log` so both
 * events have the same scope by construction.
 */
function sendToConversationAudience(conversationId: string, payload: string): void {
  // Resolve session owner for scoping — iterate because sessions are keyed by
  // sessionKey (channelId:threadTs), not conversationId (UUID)
  let ownerId: string | undefined;
  const sessions = _getSessionsFn?.();
  if (sessions) {
    for (const [, s] of sessions) {
      if (s.conversationId === conversationId) {
        ownerId = s.ownerId;
        break;
      }
    }
  }

  if (!ownerId) {
    // No active session — broadcast only to admin clients so archived session
    // updates (e.g., resummarize) still reach the admin dashboard without
    // leaking to non-owner clients.
    logger.debug('No active session for broadcast, sending to admin clients only', { conversationId });
  }

  for (const client of wsClients) {
    if (!ownerId) {
      // When owner is unknown, only admin clients receive the update
      if (!client.isAdmin) continue;
    } else if (!client.isAdmin && client.userId && client.userId !== ownerId) {
      continue;
    }
    try {
      client.send(payload);
    } catch {
      wsClients.delete(client);
    }
  }
}

/** Broadcast conversation turn update — scoped to session owner's WS clients only */
export function broadcastConversationUpdate(conversationId: string, turn: any): void {
  if (wsClients.size === 0) return;
  try {
    // Strip rawContent from assistant turns to reduce bandwidth
    const sanitizedTurn = turn?.role === 'assistant' && turn?.rawContent ? { ...turn, rawContent: undefined } : turn;
    const payload = JSON.stringify({ type: 'conversation_update', conversationId, turn: sanitizedTurn });
    sendToConversationAudience(conversationId, payload);
  } catch (error) {
    logger.error('Failed to broadcast conversation update', error);
  }
}

/** Broadcast a work-log entry (spec §3.3) — same owner/admin scope as `conversation_update`. */
export function broadcastWorkLog(conversationId: string, entry: WorkLogEntry): void {
  if (wsClients.size === 0) return;
  try {
    sendToConversationAudience(conversationId, JSON.stringify({ type: 'work_log', conversationId, entry }));
  } catch (error) {
    logger.error('Failed to broadcast work log entry', error);
  }
}

/**
 * Dashboard v2.1 — targeted summaryTitle update. Sent in lieu of a full
 * session_update to avoid re-sending the whole board for a title change.
 *
 * Carries the resolved `displayHeadline` (#762) so clients render server-truth
 * directly instead of re-implementing the priority chain. No-op when the
 * session is gone — same defensive shape as `broadcastSingleSessionUpdate`,
 * so a missing session surfaces as a server-side log line rather than a
 * silently-degraded payload.
 */
export function broadcastSummaryTitleChanged(sessionKey: string, summaryTitle: string): void {
  if (wsClients.size === 0) return;
  try {
    const session = _getSessionsFn?.().get(sessionKey);
    if (!session) {
      logger.warn('broadcastSummaryTitleChanged: session not found', { sessionKey });
      return;
    }
    // #814 — clients key their cache by composite. See broadcastTaskUpdate.
    const wireKey = composeSessionKey(sessionKey);
    const payload = JSON.stringify({
      type: 'summaryTitleChanged',
      sessionKey: wireKey,
      summaryTitle,
      displayHeadline: displayTitle(session),
    });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast summaryTitleChanged', error);
  }
}

/**
 * Push a single-session kanban payload (#762) — used by the link-derived title
 * pipeline so a card that just got its first real title doesn't have to wait
 * for the next periodic full-board broadcast. Sends the same `KanbanSession`
 * shape that `sessionToKanban` produces, so the client just feeds it back
 * through `renderCard()`.
 *
 * No-op when the session can't be found (terminated/unknown key) — that path
 * would otherwise emit a malformed event the client would silently ignore.
 */
export function broadcastSingleSessionUpdate(sessionKey: string): void {
  if (wsClients.size === 0) return;
  try {
    const session = _getSessionsFn?.().get(sessionKey);
    if (!session || !session.sessionId) return;
    const kanban = sessionToKanban(sessionKey, session);
    const payload = JSON.stringify({ type: 'sessionUpdated', session: kanban });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast single session update', error);
  }
}

/**
 * At most one push per key per `intervalMs`: the first call sends at once, the
 * calls inside the window collapse into one trailing send at its end — so the
 * last value always arrives (SSOT 2026-10-22 T1/T2 live usage).
 */
export function createLiveUpdateThrottle(send: (key: string) => void, intervalMs: number): (key: string) => void {
  const state = new Map<string, { last: number; timer?: ReturnType<typeof setTimeout> }>();
  return (key: string) => {
    const now = Date.now();
    const st = state.get(key) ?? { last: Number.NEGATIVE_INFINITY };
    state.set(key, st);
    if (st.timer) return;
    const wait = st.last + intervalMs - now;
    if (wait <= 0) {
      st.last = now;
      send(key);
      return;
    }
    st.timer = setTimeout(() => {
      st.timer = undefined;
      st.last = Date.now();
      send(key);
    }, wait);
    st.timer.unref?.();
  };
}

/** Push a running card whose live usage grew — once a second at most per session. */
export const scheduleLiveSessionUpdate = createLiveUpdateThrottle((key) => broadcastSingleSessionUpdate(key), 1000);

/** Broadcast session action feedback to all connected WebSocket clients */
function broadcastSessionAction(sessionKey: string, action: 'stop' | 'close' | 'trash'): void {
  if (wsClients.size === 0) return;
  try {
    const payload = JSON.stringify({ type: 'session_action', sessionKey, action });
    for (const client of wsClients) {
      try {
        client.send(payload);
      } catch {
        wsClients.delete(client);
      }
    }
  } catch (error) {
    logger.error('Failed to broadcast session action', error);
  }
}

// ── Route registration ─────────────────────────────────────────────

export async function registerDashboardRoutes(
  server: FastifyInstance,
  authMiddleware: (req: any, reply: any) => Promise<void>,
  csrfMiddleware?: (req: any, reply: any) => Promise<void>,
): Promise<void> {
  const store = new MetricsEventStore();

  // ── JSON API ──

  // Kanban sessions
  server.get<{ Querystring: { userId?: string; selfOnly?: string } }>(
    '/api/dashboard/sessions',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.query.userId || undefined;
      const selfOnly = request.query.selfOnly === 'true';
      const board = buildKanbanBoard(userId);
      // The admin Lifecycle dialog reads the policy from the board poll.
      const lifecycle = lifecycleView();

      // #814 — when not the recursion-guarded selfOnly path, ask the
      // aggregator to fan out to sibling instances on the same host.
      // Skip pre-listen / single-instance.
      if (!_selfInstanceEnv) {
        reply.send({ board, lifecycle });
        return;
      }
      if (selfOnly) {
        reply.send({ board, lifecycle });
        return;
      }

      try {
        // Pre-discover once and reuse the same records inside
        // `fetchSiblingBoards` (via `discoverFn`) so the gate doesn't
        // cost a second readdir+readFile sweep.
        const all = await readAllInstances();
        const selfPort = _selfInstanceEnv.port;
        const siblingCount = all.filter((r) => r.port !== selfPort && r.pid !== process.pid).length;
        if (
          !shouldAggregate({
            selfOnly,
            viewerToken: config.conversation.viewerToken,
            siblingCount,
          })
        ) {
          reply.send({ board, lifecycle });
          return;
        }
        // Per-poll TTL cache — multiple browser tabs polling /sessions
        // every 30 s shouldn't independently fan out N×HTTP each time.
        // 1.5 s collapses a burst of concurrent polls without going
        // stale enough to mask a sibling that just came up.
        const cached = _aggregatorCacheGet();
        let siblings;
        if (cached) {
          siblings = cached;
        } else {
          siblings = await fetchSiblingBoards({
            selfPort,
            selfPid: process.pid,
            viewerToken: config.conversation.viewerToken,
            discoverFn: async () => all,
          });
          _aggregatorCacheSet(siblings);
        }
        const merged = mergeBoards({
          selfBoard: board,
          selfEnv: _selfInstanceEnv,
          siblings,
        });
        reply.send({ board: merged, lifecycle });
      } catch (err) {
        // Hard failure of the aggregator must never surface a 500 —
        // fall back to self-only. Log at error (with stack) so a
        // genuine bug in mergeBoards / fetch wiring is visible, not
        // confused with the warn-throttled per-sibling failures.
        logger.error('Aggregator failed; serving self-only board', err);
        reply.send({ board, lifecycle });
      }
    },
  );

  // Session lifecycle policy (sleep / archive / board windows). Readable by any
  // signed-in user; only an admin may change it — the viewer-token bearer, or an
  // ADMIN_USERS member with X-Admin-Mode: on (same gate as cross-owner writes, #716).
  server.get('/api/dashboard/lifecycle', { preHandler: [authMiddleware] }, async (_request, reply) => {
    reply.send({ lifecycle: lifecycleView() });
  });

  // Shortening a duration sleeps or ends sessions on the next sweep, and ending
  // removes their work dirs — so a change that would move any live session is
  // answered 409 with the counts until the caller repeats it with ?confirm=1.
  server.put<{ Body: unknown; Querystring: { confirm?: string } }>(
    '/api/dashboard/lifecycle',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      if (!_hasWriteAccess(request, undefined)) {
        reply
          .status(403)
          .send({ error: 'Forbidden — changing the lifecycle policy requires an admin with Admin mode on' });
        return;
      }
      try {
        const before = getSessionLifecyclePolicy();
        const next = previewSessionLifecyclePolicy(request.body);
        // While degraded the sweep has been paused, so nothing has moved under
        // `before`: count every session the resumed sweep would move.
        const from = isSessionLifecyclePolicyDegraded()
          ? { ...before, sleepAfterMs: Number.POSITIVE_INFINITY, archiveAfterMs: Number.POSITIVE_INFINITY }
          : before;
        const impact = countLifecycleTransitions(getAllSessions().values(), from, next, Date.now());
        if ((impact.willSleep > 0 || impact.willArchive > 0) && request.query.confirm !== '1') {
          reply.status(409).send({ needsConfirm: true, ...impact });
          return;
        }
        const lifecycle = updateSessionLifecyclePolicy(request.body);
        const auth = (request as any).authContext;
        logger.warn('Session lifecycle policy changed', {
          actor: auth?.userId || auth?.mode || 'unknown',
          before,
          after: lifecycle,
          ...impact,
        });
        broadcastSessionUpdate();
        reply.send({ lifecycle: lifecycleView() });
      } catch (error) {
        if (error instanceof SessionLifecyclePolicyError) {
          reply.status(400).send({ error: error.message, field: error.field });
          return;
        }
        logger.error('Failed to save the session lifecycle policy', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Stats for one user, or for every user when userId is absent (the All Users view).
  server.get<{ Querystring: { userId?: string; period?: string } }>(
    '/api/dashboard/stats',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { period: rawPeriod } = request.query;
      const userId = request.query.userId || undefined;
      // #716: stats are world-readable for any authenticated user. The
      // session/conversation contents are also world-readable; write
      // operations (close/command/resummarize) remain gated by
      // requireSessionOwner.
      const period = (['day', 'week', 'month'].includes(rawPeriod || '') ? rawPeriod : 'day') as
        | 'day'
        | 'week'
        | 'month';
      const { startDate, endDate } = getDateRange(period);

      try {
        const events = await store.readRange(startDate, endDate);
        const dayMap = aggregateUserStats(events, userId);
        const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

        const totals = days.reduce(
          (acc, d) => {
            const wfCounts = { ...acc.workflowCounts };
            for (const [wf, cnt] of Object.entries(d.workflowCounts)) {
              wfCounts[wf] = (wfCounts[wf] || 0) + cnt;
            }
            return {
              sessionsCreated: acc.sessionsCreated + d.sessionsCreated,
              turnsUsed: acc.turnsUsed + d.turnsUsed,
              prsCreated: acc.prsCreated + d.prsCreated,
              prsMerged: acc.prsMerged + d.prsMerged,
              commitsCreated: acc.commitsCreated + d.commitsCreated,
              linesAdded: acc.linesAdded + d.linesAdded,
              linesDeleted: acc.linesDeleted + d.linesDeleted,
              mergeLinesAdded: acc.mergeLinesAdded + d.mergeLinesAdded,
              mergeLinesDeleted: acc.mergeLinesDeleted + d.mergeLinesDeleted,
              workflowCounts: wfCounts,
            };
          },
          {
            sessionsCreated: 0,
            turnsUsed: 0,
            prsCreated: 0,
            prsMerged: 0,
            commitsCreated: 0,
            linesAdded: 0,
            linesDeleted: 0,
            mergeLinesAdded: 0,
            mergeLinesDeleted: 0,
            workflowCounts: {} as Record<string, number>,
          },
        );

        reply.send({ userId: userId ?? null, period, days, totals } satisfies UserStats);
      } catch (error) {
        logger.error('Error computing dashboard stats', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Token usage statistics
  server.get<{ Querystring: { period?: string; userId?: string; date?: string } }>(
    '/api/dashboard/usage',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { period: rawPeriod, userId, date } = request.query;
      const period = (['day', 'week', 'month'].includes(rawPeriod || '') ? rawPeriod : 'day') as
        | 'day'
        | 'week'
        | 'month';

      // Validate date format and semantic validity if provided
      // Roundtrip check: JS normalizes "2026-04-31" → "2026-05-01", so we reject when the parsed date
      // does not match the original string (catches impossible calendar dates).
      if (date) {
        const parsed = new Date(date + 'T00:00:00Z');
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          Number.isNaN(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== date
        ) {
          reply.status(400).send({ error: 'Invalid date. Use YYYY-MM-DD.' });
          return;
        }
      }

      const { startDate, endDate } = date ? getDateRangeFrom(date, period) : getDateRange(period);

      try {
        const aggregator = new ReportAggregator(store);
        const report = await aggregator.aggregateTokenUsage(startDate, endDate, userId || undefined);
        reply.send(report);
      } catch (error) {
        logger.error('Error computing token usage stats', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // All users list (for dashboard navigation)
  server.get('/api/dashboard/users', { preHandler: [authMiddleware] }, async (_request, reply) => {
    const sessions = getAllSessions();
    const users = new Map<string, string>();
    for (const [, session] of sessions.entries()) {
      if (session.ownerId && session.ownerName) {
        users.set(session.ownerId, session.ownerName);
      }
    }
    reply.send({ users: Array.from(users.entries()).map(([id, name]) => ({ id, name })) });
  });

  // Session detail (conversation turns for slide panel)
  // Supports pagination via ?limit=N&before=<turnId>. Default limit=30, max=200.
  // - No `before`: returns the latest N turns (chronological order preserved).
  // - With `before`: returns up to N turns strictly BEFORE the turn with that id.
  // Response includes `hasMore: true` when older turns exist beyond the returned window.
  server.get<{
    Params: { conversationId: string };
    Querystring: { limit?: string; before?: string };
  }>('/api/dashboard/session/:conversationId', { preHandler: [authMiddleware] }, async (request, reply) => {
    try {
      const record = await getConversation(request.params.conversationId);
      if (!record) {
        reply.status(404).send({ error: 'Conversation not found' });
        return;
      }
      // #716: session details world-readable for any authenticated user.
      // Writes (resummarize/title/close/command/answer-choice/...) still
      // run requireSessionOwner so cross-user reads do not imply
      // cross-user writes.

      const DEFAULT_LIMIT = 30;
      const MAX_LIMIT = 200;
      const limitRaw = request.query.limit ? Number.parseInt(request.query.limit, 10) : DEFAULT_LIMIT;
      const limit = Number.isNaN(limitRaw) ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, limitRaw));
      const before = request.query.before;

      // Compute the window on the source array BEFORE allocating projected copies —
      // on a 10k-turn conversation this avoids allocating 10k throwaway objects per request.
      const source = record.turns;
      let startIdx: number;
      let endIdx: number;
      let hasMore: boolean;
      if (before) {
        const beforeIdx = source.findIndex((t) => t.id === before);
        if (beforeIdx < 0) {
          // Unknown cursor → return empty, no more
          startIdx = 0;
          endIdx = 0;
          hasMore = false;
        } else {
          startIdx = Math.max(0, beforeIdx - limit);
          endIdx = beforeIdx;
          hasMore = startIdx > 0;
        }
      } else {
        startIdx = Math.max(0, source.length - limit);
        endIdx = source.length;
        hasMore = startIdx > 0;
      }

      // Lightweight turn summaries (no rawContent for assistant turns).
      const turns = source.slice(startIdx, endIdx).map((t) => ({
        id: t.id,
        role: t.role,
        timestamp: t.timestamp,
        userName: t.userName,
        summaryTitle: t.summaryTitle,
        summaryBody: t.summaryBody,
        summarized: t.summarized,
        rawContent: t.role === 'user' ? t.rawContent : undefined,
      }));

      reply.send({
        id: record.id,
        title: record.title,
        titleSub: record.titleSub,
        ownerName: record.ownerName,
        workflow: record.workflow,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        turnCount: record.turns.length,
        turns,
        hasMore,
      });
    } catch (error) {
      logger.error('Error fetching session detail', error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  // Resummarize a specific assistant turn
  server.post<{ Params: { conversationId: string; turnId: string } }>(
    '/api/dashboard/session/:conversationId/resummarize/:turnId',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      try {
        // #716 / Oracle re-review P2: enforce the same write-access
        // policy as kanban actions — bearer admin, owner, or
        // OAuth admin with X-Admin-Mode: on header. The previous
        // shortcut (isAdmin alone) skipped the safe-mode header.
        const record = await getConversation(request.params.conversationId);
        if (!record) {
          reply.status(404).send({ error: 'Turn not found or not an assistant turn' });
          return;
        }
        if (!requireConversationWriteAccess(request, reply, record.ownerId)) return;
        const ok = await resummarizeTurn(request.params.conversationId, request.params.turnId);
        if (!ok) {
          reply.status(404).send({ error: 'Turn not found or not an assistant turn' });
          return;
        }
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error resummarizing turn', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Generate titleSub for a conversation
  server.post<{ Params: { conversationId: string } }>(
    '/api/dashboard/session/:conversationId/generate-title',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      try {
        const record = await getConversation(request.params.conversationId);
        if (!record) {
          reply.status(404).send({ error: 'Not found' });
          return;
        }
        // #716 / Oracle re-review P2: same write-access policy as
        // resummarize and kanban actions.
        if (!requireConversationWriteAccess(request, reply, record.ownerId)) return;

        // Build conversation content from first few turns
        const contentParts = record.turns
          .slice(0, 6)
          .map((t) => `[${t.role}]: ${t.rawContent?.substring(0, 500) || t.summaryTitle || ''}`);
        const content = contentParts.join('\n\n');

        const titleSub = await generateTitle(content);
        if (titleSub) {
          await updateConversationTitleSub(record.id, titleSub);
          reply.send({ ok: true, titleSub });
        } else {
          reply.status(500).send({ error: 'Title generation failed' });
        }
      } catch (error) {
        logger.error('Error generating title', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Action routes ──

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/stop',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { wireKey: key, originalKey } = resolved;
      try {
        if (_stopHandlerFn) {
          await _stopHandlerFn(originalKey);
        }
        // Broadcast uses wire-format so the client cache lookup matches.
        broadcastSessionAction(key, 'stop');
        broadcastSessionUpdate();
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error stopping session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/close',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { wireKey: key, originalKey } = resolved;
      try {
        if (_closeHandlerFn) {
          await _closeHandlerFn(originalKey);
        }
        broadcastSessionAction(key, 'close');
        broadcastSessionUpdate();
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error closing session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/trash',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { wireKey: key, originalKey } = resolved;
      try {
        if (_trashHandlerFn) {
          await _trashHandlerFn(originalKey);
        }
        broadcastSessionAction(key, 'trash');
        broadcastSessionUpdate();
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error trashing session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  server.post<{ Params: { key: string }; Body: { message: string } }>(
    '/api/dashboard/session/:key/command',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { message } = request.body || {};
      if (!message || typeof message !== 'string') {
        reply.status(400).send({ error: 'message is required and must be a string' });
        return;
      }
      if (message.length > 4000) {
        reply.status(400).send({ error: 'message exceeds max length (4000 chars)' });
        return;
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      try {
        if (_commandHandlerFn) {
          await _commandHandlerFn(originalKey, message);
        }
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error sending command to session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Goal list (work item) ──

  server.post<{
    Params: { key: string };
    Body: { action?: unknown; objective?: unknown; goalId?: unknown; expect?: unknown };
  }>(
    '/api/dashboard/session/:key/goal',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const body = request.body || {};
      let action: HostGoalAction;
      if (body.action === 'add') {
        if (typeof body.objective !== 'string' || !body.objective.trim()) {
          reply.status(400).send({ error: 'objective is required and must be a non-empty string' });
          return;
        }
        if (body.objective.length > 4000) {
          reply.status(400).send({ error: 'objective exceeds max length (4000 chars)' });
          return;
        }
        action = { action: 'add', objective: body.objective };
      } else if (body.action === 'delete') {
        if (typeof body.goalId !== 'string' || !body.goalId || body.goalId.length > 200) {
          reply.status(400).send({ error: 'goalId is required and must be a string' });
          return;
        }
        if (body.expect !== 'current' && body.expect !== 'queued') {
          reply.status(400).send({ error: "expect must be 'current' or 'queued'" });
          return;
        }
        action = { action: 'delete', goalId: body.goalId, expect: body.expect };
      } else {
        reply.status(400).send({ error: "action must be 'add' or 'delete'" });
        return;
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      if (!_goalActionHandlerFn) {
        reply.status(501).send({ error: 'Goal action handler not configured' });
        return;
      }
      try {
        // The acting dashboard user (owner, or an admin in admin mode); a bearer
        // client has none and the handler falls back to the session owner.
        const actorUserId = (request as { authContext?: { userId?: string } }).authContext?.userId;
        const result = await _goalActionHandlerFn(originalKey, action, actorUserId);
        broadcastSessionUpdate();
        reply.send({ ok: true, result });
      } catch (error) {
        if (error instanceof HostGoalActionError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        logger.error('Error applying goal action from dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Model switch (SSOT 2026-10-22 T4/T5) ──

  server.post<{ Params: { key: string }; Body: { model?: unknown } }>(
    '/api/dashboard/session/:key/model',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const nickname = (request.body || {}).model;
      if (typeof nickname !== 'string' || !nickname || nickname.length > 64) {
        reply.status(400).send({ error: 'model is required and must be a representative model nickname' });
        return;
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      if (!_modelSwitchHandlerFn) {
        reply.status(501).send({ error: 'Model switch handler not configured' });
        return;
      }
      try {
        const result = await _modelSwitchHandlerFn(resolved.originalKey, nickname);
        broadcastSessionUpdate();
        reply.send({ ok: true, result });
      } catch (error) {
        if (error instanceof ModelSwitchError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        logger.error('Error switching model from dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Effort switch (SSOT 2026-10-23 T1) ──

  server.post<{ Params: { key: string }; Body: { effort?: unknown } }>(
    '/api/dashboard/session/:key/effort',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const effort = (request.body || {}).effort;
      if (typeof effort !== 'string' || !effort || effort.length > 32) {
        reply.status(400).send({ error: `effort is required: one of ${EFFORT_LEVELS.join(', ')}` });
        return;
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      if (!_effortSwitchHandlerFn) {
        reply.status(501).send({ error: 'Effort switch handler not configured' });
        return;
      }
      try {
        const result = await _effortSwitchHandlerFn(resolved.originalKey, effort);
        reply.send({ ok: true, result });
      } catch (error) {
        if (error instanceof EffortSwitchError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        logger.error('Error switching effort from dashboard', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // ── Answer choice from dashboard ──

  server.post<{ Params: { key: string }; Body: { choiceId: string; label: string; question: string } }>(
    '/api/dashboard/session/:key/answer-choice',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { choiceId, label, question } = request.body || {};
      if (
        !choiceId ||
        typeof choiceId !== 'string' ||
        !label ||
        typeof label !== 'string' ||
        !question ||
        typeof question !== 'string'
      ) {
        reply.status(400).send({ error: 'choiceId, label, and question are required and must be strings' });
        return;
      }
      if (choiceId.length > 100 || label.length > 500 || question.length > 2000) {
        reply.status(400).send({ error: 'Field length exceeded' });
        return;
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      try {
        if (_choiceAnswerHandlerFn) {
          await _choiceAnswerHandlerFn(originalKey, choiceId, label, question);
        } else {
          reply.status(501).send({ error: 'Choice answer handler not configured' });
          return;
        }
        reply.send({ ok: true });
      } catch (error) {
        const errMsg = (error as Error).message || '';
        if (errMsg === 'Session not found') {
          reply.status(404).send({ error: 'Session not found' });
        } else if (errMsg === 'Session is not waiting for a choice') {
          reply.status(409).send({ error: 'Session is not waiting for a choice' });
        } else if (errMsg === 'Invalid choice ID') {
          reply.status(422).send({ error: 'Invalid choice ID' });
        } else {
          logger.error('Error answering choice from dashboard', error);
          reply.status(500).send({ error: 'Internal Server Error' });
        }
      }
    },
  );

  // ── Answer multi-choice from dashboard ──

  server.post<{
    Params: { key: string };
    Body: { selections: Record<string, { choiceId: string; label: string }> };
  }>(
    '/api/dashboard/session/:key/answer-multi-choice',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const { selections } = request.body || {};
      if (
        !selections ||
        typeof selections !== 'object' ||
        Array.isArray(selections) ||
        Object.keys(selections).length === 0
      ) {
        reply.status(400).send({ error: 'selections is required and must be a non-empty object' });
        return;
      }
      // Reject payloads with too many selections (max 50 questions per form)
      const selKeys = Object.keys(selections);
      if (selKeys.length > 50) {
        reply.status(400).send({ error: 'Too many selections' });
        return;
      }
      // Validate each selection entry
      for (const sel of Object.values(selections)) {
        if (
          !sel ||
          typeof sel !== 'object' ||
          !sel.choiceId ||
          typeof sel.choiceId !== 'string' ||
          !sel.label ||
          typeof sel.label !== 'string'
        ) {
          reply.status(400).send({ error: 'Invalid selection entry' });
          return;
        }
        if (sel.choiceId.length > 200 || sel.label.length > 1000) {
          reply.status(400).send({ error: 'Selection field length exceeded' });
          return;
        }
      }
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      try {
        if (_multiChoiceAnswerHandlerFn) {
          await _multiChoiceAnswerHandlerFn(originalKey, selections);
        } else {
          reply.status(501).send({ error: 'Multi-choice answer handler not configured' });
          return;
        }
        reply.send({ ok: true });
      } catch (error) {
        const errMsg = (error as Error).message || '';
        if (errMsg === 'Session not found') {
          reply.status(404).send({ error: 'Session not found' });
        } else if (errMsg === 'Session is not waiting for a choice') {
          reply.status(409).send({ error: 'Session is not waiting for choices' });
        } else if (errMsg === 'Session has no pending multi-choice question') {
          reply.status(409).send({ error: 'Session has no pending multi-choice question' });
        } else if (errMsg.startsWith('Missing answer for question')) {
          reply.status(400).send({ error: errMsg });
        } else if (errMsg === 'Invalid choice ID') {
          reply.status(422).send({ error: 'Invalid choice ID' });
        } else {
          logger.error('Error answering multi-choice from dashboard', error);
          reply.status(500).send({ error: 'Internal Server Error' });
        }
      }
    },
  );

  // ── Submit-all-recommended from dashboard (hero one-click) ──

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/submit-recommended',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      const resolved = resolveSelfActionKeyAndOwner(request, reply);
      if (!resolved) return;
      const { originalKey } = resolved;
      try {
        if (!_submitRecommendedHandlerFn) {
          reply.status(501).send({ error: 'Submit-recommended handler not configured' });
          return;
        }
        await _submitRecommendedHandlerFn(originalKey);
        reply.send({ ok: true });
      } catch (error) {
        const errMsg = (error as Error).message || '';
        if (errMsg === 'Session not found') {
          reply.status(404).send({ error: 'Session not found' });
        } else if (
          errMsg === 'Session is not waiting for a choice' ||
          errMsg === 'Session has no pending multi-choice question' ||
          errMsg === 'Submission in progress' ||
          errMsg === 'Recommendations incomplete'
        ) {
          reply.status(409).send({ error: errMsg });
        } else if (errMsg === 'No recommendation available') {
          reply.status(422).send({ error: errMsg });
        } else {
          logger.error('Error submitting recommended from dashboard', error);
          reply.status(500).send({ error: 'Internal Server Error' });
        }
      }
    },
  );

  // ── HTML Dashboard ──

  server.get('/dashboard', { preHandler: [authMiddleware] }, async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(renderDashboardPage());
  });

  server.get<{ Params: { userId: string } }>(
    '/dashboard/:userId',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      reply.type('text/html; charset=utf-8').send(renderDashboardPage(request.params.userId));
    },
  );

  // ── WebSocket ──

  try {
    await server.register(await import('@fastify/websocket'));

    const MAX_WS_CLIENTS = 100;

    server.get('/ws/dashboard', { websocket: true, preHandler: [authMiddleware] }, (socket: any, request: any) => {
      // Enforce max client cap to prevent DoS
      if (wsClients.size >= MAX_WS_CLIENTS) {
        logger.warn('WebSocket max clients reached, rejecting', { total: wsClients.size });
        socket.close(1013, 'Max clients reached');
        return;
      }
      const authContext = request?.authContext;
      const client: WsClient = {
        send: (data: string) => socket.send(data),
        close: () => socket.close(),
        userId: authContext?.userId,
        isAdmin: authContext?.isAdmin,
      };
      wsClients.add(client);
      logger.debug('WebSocket client connected', { total: wsClients.size });

      // Send initial state
      try {
        const board = buildKanbanBoard();
        socket.send(JSON.stringify({ type: 'session_update', board }));
      } catch {
        /* ignore */
      }

      socket.on('close', () => {
        wsClients.delete(client);
        logger.debug('WebSocket client disconnected', { total: wsClients.size });
      });
    });
  } catch (error) {
    logger.warn('WebSocket support unavailable (install @fastify/websocket for real-time updates)', error);
  }

  logger.info('Dashboard routes registered');
}

// ── Dashboard HTML ─────────────────────────────────────────────────

function renderDashboardPage(userId?: string): string {
  const initUser = userId ? JSON.stringify(userId) : 'null';
  // #814 — inject the local instance's name so the frontend can identify
  // sibling cards (`environment.instanceName !== SELF_INSTANCE_NAME`) and
  // hide actions that would silently 4xx if dispatched to the wrong port.
  const initSelfInstance = _selfInstanceEnv ? JSON.stringify(_selfInstanceEnv.instanceName) : 'null';
  // ui.dashboardheader — normalized card-header composition (config.json#ui
  // via @soma/slack/surface-config; docs/ui-surfaces.md). `<` is escaped so
  // an operator-supplied label cannot break out of the <script> block.
  const initDashboardHeaderConfig = JSON.stringify(getSurfaceLines('dashboardheader', 'default')).replace(
    /</g,
    '\\u003c',
  );
  // SSOT 2026-10-22 T4 — the representative models a card can switch to, with
  // their window and auto-compact threshold (escaped like the header config).
  let representativeModels: unknown[] = [];
  try {
    representativeModels = listRepresentativeModels(productionModelCatalogDeps());
  } catch (error) {
    logger.warn('Representative models unavailable for the dashboard', error);
  }
  const initRepresentativeModels = JSON.stringify(representativeModels).replace(/</g, '\\u003c');
  const initEffortLevels = JSON.stringify(EFFORT_LEVELS);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>soma-work Dashboard</title>
<script data-fouc>
// FOUC prevention — apply theme before CSS paints
(function(){var t=localStorage.getItem('soma-theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();
</script>
<style>
/* ═══ BAUHAUS DESIGN SYSTEM v2 ═══ Geometric clarity. Structured planes. Disciplined typography. */
*,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  /* Surface hierarchy — 3 deliberate planes (neutral grays, Agent inbox .prd/10) */
  --bg: #1c1c1f;
  --surface: #232327;
  --surface-raised: #2a2a2f;
  --border: #34343a;
  --border-focus: #4d9de0;
  /* Typography */
  --text: #ededf0;
  --text-secondary: #a8a8b0;
  --text-tertiary: #93939b;
  /* Functional color — Bauhaus primary triad + accents */
  --accent: #4d9de0;
  --accent-hover: #3b82c4;
  --green: #3ecf8e;
  --yellow: #f6c90e;
  --red: #f26b6b;
  --purple: #a78bfa;
  --orange: #f97316;
  /* Geometry */
  --radius: 2px;
  /* Motion */
  --ease: cubic-bezier(0.2,0.8,0.2,1);
  --speed: 140ms;
  /* Motion contract (.prd/10 §4 — zworkflow motion-design standard, verbatim) */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --dur-press: 160ms;
  --dur-expand: 240ms;
  --dur-move: 320ms;
  --dur-fade: 180ms;
  /* Agent inbox board — neutral planes: column one step darker than the page.
     Text tokens (--ib-muted, --ib-text-2, --text-tertiary) clear 4.5:1 on every
     surface they sit on (page, column, card, dimmed card, segment track). */
  --ib-col: #18181b;
  --ib-card: #242428;
  --ib-card-dim: #1f1f23;
  --ib-card-border: #34343a;
  --ib-pill: #2f2f35;
  --ib-text: #f2f2f3;
  --ib-text-2: #b4b4bb;
  --ib-muted: #93939b;
  --ib-seg: #161619;
  --ib-seg-on: #2e2e33;
  --ib-spark: #7b9cf0;
  --ib-shadow: 0 1px 2px rgba(0,0,0,0.35);
  --ib-shadow-raised: 0 14px 32px rgba(0,0,0,0.5), 0 3px 8px rgba(0,0,0,0.35);
  --st-wait: #f5a524;
  --st-run: #6b93f2;
  --st-done: #3fb968;
  --st-fail: #f26b6b;
  /* Owner badges (All Users, .prd/10 §3.1-3) — 8 hues, ordered so neighbouring
     slots are far apart: blue · amber · green · rose · teal · orange · violet · olive.
     Each text colour clears 4.5:1 on its own fill. */
  --ob-0-bg: #233b57; --ob-0-fg: #aacef8;
  --ob-1-bg: #574723; --ob-1-fg: #f8e1aa;
  --ob-2-bg: #235735; --ob-2-fg: #aaf8c4;
  --ob-3-bg: #572330; --ob-3-fg: #f8aabe;
  --ob-4-bg: #235755; --ob-4-fg: #aaf8f6;
  --ob-5-bg: #573323; --ob-5-fg: #f8c1aa;
  --ob-6-bg: #3b2357; --ob-6-fg: #ceaaf8;
  --ob-7-bg: #475723; --ob-7-fg: #e1f8aa;
}

/* ── LIGHT THEME — override surface & text planes ── */
[data-theme="light"] {
  --bg: #f7f7f7;
  --surface: #ffffff;
  --surface-raised: #f1f1f1;
  --border: #e4e4e4;
  --border-focus: #4d9de0;
  --text: #18181a;
  --text-secondary: #57575d;
  --text-tertiary: #68686f;
  --accent: #1f6dc2;
  --accent-hover: #1a5ca6;
  /* Functional colors — WCAG AA ≥4.5:1 on all light surfaces */
  --green: #14783b;
  --yellow: #a16207;
  --red: #b91c1c;
  --purple: #7c3aed;
  --orange: #c2410c;
  /* Agent inbox board */
  --ib-col: #efefef;
  --ib-card: #ffffff;
  --ib-card-dim: #f8f8f8;
  --ib-card-border: #e3e3e3;
  --ib-pill: #e2e2e2;
  --ib-text: #161616;
  --ib-text-2: #555558;
  --ib-muted: #65656b;
  --ib-seg: #ebebeb;
  --ib-seg-on: #ffffff;
  --ib-spark: #5b7fe0;
  --ib-shadow: 0 1px 2px rgba(0,0,0,0.06);
  --ib-shadow-raised: 0 14px 30px rgba(0,0,0,0.14), 0 3px 8px rgba(0,0,0,0.08);
  --st-wait: #c2780a;
  --st-run: #2f63e0;
  --st-done: #137a3e;
  --st-fail: #d43a3a;
  --ob-0-bg: #d9e9fc; --ob-0-fg: #0e3562;
  --ob-1-bg: #fcf2d9; --ob-1-fg: #62490e;
  --ob-2-bg: #d9fce5; --ob-2-fg: #0e622a;
  --ob-3-bg: #fcd9e2; --ob-3-fg: #620e23;
  --ob-4-bg: #d9fcfb; --ob-4-fg: #0e625f;
  --ob-5-bg: #fce4d9; --ob-5-fg: #62270e;
  --ob-6-bg: #e9d9fc; --ob-6-fg: #350e62;
  --ob-7-bg: #f2fcd9; --ob-7-fg: #49620e;
}
[data-theme="light"] ::selection { background: var(--accent); color: #fff; }
[data-theme="light"] ::-webkit-scrollbar-thumb { background: #c8cdd5; border-color: var(--bg); }
[data-theme="light"] .panel-overlay { background: rgba(0,0,0,0.25); }

html,body {
  min-height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size: 14px;
  line-height: 1.4;
  letter-spacing: 0.01em;
  -webkit-font-smoothing: antialiased;
}

::selection { background: var(--accent); color: var(--bg); }
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--border); border: 2px solid var(--bg); border-radius: var(--radius); }

/* ── FOCUS — visible outline for keyboard nav ── */
:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }

.app { display: flex; flex-direction: column; min-height: 100vh; }

/* ── TOPBAR — strict horizontal grid ──
   One row from 1024px; below that the nav (user select · Conversations · admin
   toggle) takes its own row under brand · status · account (BOARD RESPONSIVE).
   No control ever wraps or cuts its label: everything is nowrap and flex: none.
   Only user names are ever shortened, always with a visible ellipsis and the
   full name in title: the pill's name when its row is full, and the selected
   user's name when it is wider than its cap — 180px on the one-row bar (≥1024,
   even when the row has room), the whole nav row below 1024px. */
.topbar {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  min-width: 0;
}
.topbar h1 {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  flex: none;
}
/* One row (≥1024): the nav never shrinks below its controls (so none of them
   paints past it into the account group); the selected name is capped instead
   (.user-select max-inline-size), and the account group is what gives way — the
   pill's name ends in an ellipsis. The cap keeps "Logged in as <realistic name>"
   whole at 1024px even with "Reconnecting..." and touch padding. */
.topbar .nav { display: flex; gap: 6px; margin-left: auto; align-items: center; flex: none; }
.topbar .topbar-account { display: flex; gap: 6px; align-items: center; min-width: 0; flex: 0 1 auto; }
/* SSOT 2026-10-23 T6 — the owner's default model / effort, one click from the top. */
/* Above the full-screen panel overlay (99) and the panel (100): the chips stay
   clickable while a session panel is open — that is when "열린 세션에도 적용" exists. */
.topbar .topbar-defaults { position: relative; z-index: 101; display: flex; gap: 6px; align-items: center; flex: none; }
.topbar .topbar-defaults[hidden] { display: none; }
.topbar .td-chip { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 12px; color: var(--text-secondary); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; min-height: 30px; cursor: pointer; white-space: nowrap; transition: border-color var(--dur-press) var(--ease-out), transform var(--dur-press) var(--ease-out); }
.topbar .td-chip b { color: var(--text); font-weight: 700; }
.topbar .td-chip[aria-expanded="true"] { border-color: var(--accent); }
.topbar .td-chip:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.topbar .td-chip:active:not(:focus-visible) { transform: scale(0.97); }
@media (hover: hover) and (pointer: fine) { .topbar .td-chip:hover { border-color: var(--accent); color: var(--text); } }
.topbar .td-caret { font-size: 10px; color: var(--text-tertiary); }
.td-menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 120; min-width: 260px; max-width: min(360px, 92vw); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 14px 32px rgba(0,0,0,0.35); padding: 6px; }
.td-menu[hidden] { display: none; }
.td-menu .tdm-head { font-size: 11px; font-weight: 700; color: var(--text-tertiary); padding: 6px 8px 4px; }
.td-menu .tdm-item { display: flex; width: 100%; align-items: baseline; justify-content: space-between; gap: 8px; text-align: left; font: inherit; font-size: 13px; color: var(--text); background: none; border: 0; border-radius: 6px; padding: 8px; min-height: 36px; cursor: pointer; }
.td-menu .tdm-item[aria-checked="true"] { background: var(--surface-raised); font-weight: 700; }
.td-menu .tdm-item[aria-checked="true"]::after { content: '✓'; color: var(--accent); }
.td-menu .tdm-item:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
@media (hover: hover) and (pointer: fine) { .td-menu .tdm-item:hover { background: var(--surface-raised); } }
.td-menu .tdm-sub { font-size: 11px; color: var(--text-tertiary); font-weight: 400; }
.td-menu .tdm-scope { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--text-secondary); padding: 8px; border-top: 1px solid var(--border); margin-top: 4px; }
.td-menu .tdm-scope input { margin-top: 2px; }
.topbar .td-status { font-size: 12px; color: var(--text-secondary); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar .td-status.is-error { color: var(--red); }
.topbar .nav a,
.topbar .nav .user-select {
  background: var(--surface-raised);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 12px;
  text-decoration: none;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color var(--speed) var(--ease), color var(--speed) var(--ease);
  min-height: 32px;
  white-space: nowrap;
  flex: none;
}
.topbar .nav a { display: inline-flex; align-items: center; gap: 4px; }
/* User select: a visible label sized to the selected option, with the native
   <select> laid transparently over it (it still takes every click, tap and key).
   A native select cannot show an ellipsis in WebKit — it hard-cuts the text —
   so the label carries the ellipsis and the select carries the full name in title. */
.topbar .nav .user-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: space-between; /* chevron at the right edge when the select fills the row */
  gap: 8px;
  flex: 0 1 auto;
  min-width: 0;
  max-inline-size: 180px;
  /* WebKit counts the ellipsized label's full text in this box's scrollable
     overflow and passes it up to the page (25px of sideways scroll at 320px
     with a long name selected); nothing in here is meant to extend past it. */
  overflow: hidden;
}
/* Decorations never take a tap: the chevron's transform makes it a stacking
   context painted above the select, so without pointer-events: none a tap on
   it would land on the wrapper and the picker would not open. */
.topbar .user-select-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
.topbar .user-select::after {
  content: '';
  pointer-events: none;
  flex: none;
  inline-size: 6px;
  block-size: 6px;
  margin: -3px 2px 0;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
}
.topbar .user-select select {
  position: absolute;
  z-index: 1;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  opacity: 0;
  cursor: pointer;
  appearance: none;
  border: 0;
  font: inherit;
}
.topbar .user-select:has(select:focus-visible) { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.topbar .nav a:hover,
.topbar .nav .user-select:hover { border-color: var(--accent); color: var(--text); }

/* ── USER PILL — "Logged in as <name>", links to the /login account page, rendered from /auth/me ── */
.topbar .user-pill {
  display: none; /* toggled by JS once /auth/me resolves */
  text-decoration: none;
  align-items: center;
  gap: 6px;
  background: var(--surface-raised);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  min-height: 32px;
  cursor: pointer;
  transition: border-color var(--speed) var(--ease);
  white-space: nowrap;
  max-width: 260px;
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}
.topbar .user-pill b {
  color: var(--text);
  font-weight: 700;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
}
.topbar .user-pill.is-admin b::before { content: '★ '; color: var(--accent); }
.topbar .user-pill:hover { border-color: var(--accent); color: var(--text); }
.topbar .user-pill:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }

/* ── ADMIN MODE TOGGLE — visible only for ADMIN_USERS (#716) ── */
.topbar .admin-toggle {
  background: var(--surface-raised);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
  min-height: 32px;
  white-space: nowrap;
  flex: none;
  align-items: center;
  transition: border-color var(--speed) var(--ease), color var(--speed) var(--ease), background var(--speed) var(--ease);
}
.topbar .admin-toggle:hover { border-color: var(--accent); color: var(--text); }
.topbar .admin-toggle[aria-pressed="true"] {
  background: rgba(248, 81, 73, 0.18);
  border-color: var(--red, #f85149);
  color: var(--red, #f85149);
}
.topbar .admin-toggle[aria-pressed="true"]:hover { background: rgba(248, 81, 73, 0.28); }
#theme-toggle {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  min-height: 32px;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  transition: border-color var(--speed) var(--ease), transform 0.2s var(--ease);
}
#theme-toggle::before { content: '\\1F319'; }
[data-theme="light"] #theme-toggle::before { content: '\\2600\\FE0F'; }
#theme-toggle:hover { border-color: var(--accent); transform: scale(1.1); }
.ws-badge {
  padding: 4px 12px;
  border-radius: var(--radius);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  white-space: nowrap;
  flex: none;
}

/* ── MAIN — stats strip, then the board; capped at 1280px and centred (.prd/10 §3.1-2, §5) ── */
.main { flex: 1; padding: 20px; width: 100%; max-width: 1280px; margin: 0 auto; min-width: 0; }

/* ── PERIOD SELECTOR — segmented control ── */
.period-bar { display: inline-flex; gap: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.period-btn {
  background: var(--surface);
  color: var(--text-secondary);
  border: none;
  border-right: 1px solid var(--border);
  padding: 8px 16px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background var(--speed) var(--ease), color var(--speed) var(--ease);
  min-height: 32px;
}
.period-btn:last-child { border-right: none; }
.period-btn:hover { background: var(--surface-raised); color: var(--text); }
.period-btn.active { background: var(--accent); color: var(--bg); font-weight: 700; }

/* ── STATS STRIP — leads the page, above the board (.prd/10 §3.1-2) ──
   One row from 640px: period · 세션 · 토큰 · 비용 · 자세히. Below 640px the
   period control and 자세히 share the first row and the numbers take the
   second. 자세히 opens the other cards and the charts under the strip. */
.stats { margin-bottom: 18px; }
.stats-strip {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas: "period nums more";
  align-items: center;
  gap: 10px 16px;
}
.stats-strip .period-bar { grid-area: period; }
.strip-nums { grid-area: nums; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; min-width: 0; }
.strip-num { display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.strip-num .label { font-size: 12px; font-weight: 600; color: var(--text-tertiary); }
.strip-num .value { font-size: 15px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.strip-num .no-data { color: var(--text-tertiary); }
.stats-more {
  grid-area: more;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 12px;
  min-height: 32px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--speed) var(--ease), color var(--speed) var(--ease);
}
.stats-more svg { width: 12px; height: 12px; flex-shrink: 0; transition: transform var(--dur-expand) var(--ease-out); }
.stats-more[aria-expanded="true"] { color: var(--text); }
.stats-more[aria-expanded="true"] svg { transform: rotate(180deg); }
.stats-detail { margin-top: 12px; }

/* ── STATS GRID — the cards behind 자세히: 5 columns, 2 below 1100px ── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
  transition: border-color var(--speed) var(--ease);
}
.stat-card:hover { border-color: var(--accent); }
.stat-card .label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}
.stat-card .value {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
/* Dim placeholder values */
.stat-card .value.no-data { color: var(--text-tertiary); opacity: 0.3; font-size: 18px; }
.stat-card .delta { font-size: 12px; color: var(--green); margin-top: 2px; font-weight: 600; }
.stat-card .delta.negative { color: var(--red); }

/* ═══ AGENT INBOX BOARD (.prd/10 §3.1) ═══
   NEEDS YOU (waiting) · RUNNING (working) · DONE (idle, then closed).
   Card shells persist across renders (keyed reconciler in the client JS), so
   every transition below animates a live node — nothing is rebuilt per poll. */
.inbox { margin-bottom: 28px; }
.inbox-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 16px; min-width: 0; }
.crumbs { display: flex; align-items: baseline; gap: 10px; font-size: 17px; line-height: 1.3; min-width: 0; white-space: nowrap; overflow: hidden; }
.crumbs .crumb-root, .crumbs .crumb-sep { color: var(--ib-muted); }
.crumbs .crumb-cur { color: var(--ib-text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--ib-seg); border-radius: 10px; flex-shrink: 0; }
.seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--ib-muted);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
  min-height: 32px;
  transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease, transform var(--dur-press) var(--ease-out);
}
.seg-btn svg { width: 15px; height: 15px; flex-shrink: 0; }
.seg-btn[aria-pressed="true"] { background: var(--ib-seg-on); color: var(--ib-text); box-shadow: var(--ib-shadow); }
/* Board header tools: Show archives, then Board | List. Below 640px the tools
   take their own row under the breadcrumb. */
.inbox-tools { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
.archives-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: var(--ib-seg);
  color: var(--ib-muted);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 10px;
  min-height: 38px;
  white-space: nowrap;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease, transform var(--dur-press) var(--ease-out);
}
.archives-btn[hidden] { display: none; }
.archives-btn svg { width: 15px; height: 15px; flex-shrink: 0; }
.archives-btn[aria-pressed="true"] { background: var(--ib-seg-on); color: var(--ib-text); box-shadow: var(--ib-shadow); }
/* Session lifecycle dialog (admin) */
.lifecycle-dialog { margin: auto; border: 1px solid var(--border, rgba(127,127,127,0.3)); border-radius: 14px; padding: 18px 20px; background: var(--bg-card, var(--ib-col)); color: var(--ib-text); max-width: 420px; width: calc(100% - 32px); }
.lifecycle-dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
.lifecycle-dialog h3 { margin: 0 0 4px; font-size: 15px; }
.lifecycle-dialog .lc-note { margin: 0 0 12px; font-size: 12px; color: var(--ib-muted); }
.lifecycle-dialog label { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 8px; font-size: 13px; margin-bottom: 10px; }
.lifecycle-dialog label input { grid-column: 1 / -1; font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border, rgba(127,127,127,0.35)); background: var(--ib-seg); color: var(--ib-text); }
.lifecycle-dialog .lc-unit { color: var(--ib-muted); font-size: 12px; }
.lifecycle-dialog .lc-status { min-height: 1.2em; margin: 4px 0 8px; font-size: 12px; color: var(--ib-muted); }
.lifecycle-dialog .lc-status.is-error { color: #f85149; }
.lifecycle-dialog .lc-actions { display: flex; justify-content: flex-end; gap: 8px; }
.lifecycle-dialog .lc-save { background: var(--ib-seg-on); color: var(--ib-text); box-shadow: var(--ib-shadow); }

/* Board = 3 equal columns. No overflow clip on columns: a card flying between
   columns must stay visible over its neighbours. */
.kanban { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; }
.kanban-col { position: relative; background: var(--ib-col); border-radius: 14px; padding: 2px 4px 4px; min-width: 0; display: flex; flex-direction: column; }
.kanban-col-header { display: flex; align-items: center; gap: 8px; padding: 10px 8px 8px 10px; min-height: 40px; }
.col-spark { color: var(--ib-spark); display: inline-flex; flex-shrink: 0; }
.col-spark svg, .card-spark svg { width: 14px; height: 14px; }
.kanban-col-header h3 { flex: 1; text-align: center; font-size: 12px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ib-muted); white-space: nowrap; }
.kanban-col-header .count { background: var(--ib-pill); color: var(--ib-text-2); border-radius: 6px; padding: 1px 7px; font-size: 12px; font-weight: 500; min-width: 22px; text-align: center; font-variant-numeric: tabular-nums; }
.kanban-col .cards { position: relative; display: flex; flex-direction: column; gap: 8px; }
.col-empty { text-align: center; color: var(--ib-muted); font-size: 13px; padding: 14px 8px 18px; }
.col-foot:empty { display: none; }

/* List = the same columns stacked as full-width sections (same DOM, §4-4). */
.kanban[data-view="list"] { grid-template-columns: minmax(0, 1fr); }
.kanban[data-view="list"] .kanban-col-header h3 { flex: 0 0 auto; text-align: left; }
.kanban[data-view="list"] .card-summary { -webkit-line-clamp: 1; }
.kanban[data-view="list"] .st-prefix { display: inline; }
.kanban[data-view="list"] .col-empty { padding: 10px 8px 16px; }

/* ── CARD — collapsed face + in-place expansion ── */
.card {
  position: relative;
  background: var(--ib-card);
  border: 1px solid var(--ib-card-border);
  border-radius: 12px;
  box-shadow: var(--ib-shadow);
  color: var(--ib-text);
  transition: border-color 150ms ease, box-shadow 150ms ease;
  --st-color: var(--ib-muted);
}
.card[data-state="waiting"] { --st-color: var(--st-wait); }
.card[data-state="working"] { --st-color: var(--st-run); }
.card[data-state="idle"] { --st-color: var(--st-done); }
/* Closed cards are dimmed with colour, not opacity — opacity would fight the
   enter/exit fades and make each card its own stacking context. */
.card[data-state="sleeping"], .card[data-state="archived"] { background: var(--ib-card-dim); box-shadow: none; }
.card[data-state="sleeping"] .card-title-text, .card[data-state="archived"] .card-title-text { color: var(--ib-text-2); font-weight: 500; }
.card[data-state="sleeping"] .card-summary, .card[data-state="archived"] .card-summary { color: var(--ib-muted); }
.card.is-flying { z-index: 5; box-shadow: var(--ib-shadow-raised); }
.card.is-exiting { position: absolute; z-index: 1; pointer-events: none; }
.card-face { padding: 12px 14px; cursor: pointer; border-radius: 11px; }
.card-face:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-spark { flex-shrink: 0; display: inline-flex; color: var(--st-color); }
.card .card-title-text { flex: 1 1 auto; font-size: 15px; font-weight: 600; line-height: 1.3; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Owner badge (All Users, §3.1-3): right end of the head. It keeps its width up
   to its cap, so the title truncates first; a longer name ends in an ellipsis
   (full name in title). The colour slot comes from ownerBadgeHue(ownerId). */
.owner-badge {
  flex: 0 0 auto;
  margin-left: auto;
  max-inline-size: min(45%, 168px);
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: var(--ob-bg);
  color: var(--ob-fg);
}
.owner-badge[data-hue="0"] { --ob-bg: var(--ob-0-bg); --ob-fg: var(--ob-0-fg); }
.owner-badge[data-hue="1"] { --ob-bg: var(--ob-1-bg); --ob-fg: var(--ob-1-fg); }
.owner-badge[data-hue="2"] { --ob-bg: var(--ob-2-bg); --ob-fg: var(--ob-2-fg); }
.owner-badge[data-hue="3"] { --ob-bg: var(--ob-3-bg); --ob-fg: var(--ob-3-fg); }
.owner-badge[data-hue="4"] { --ob-bg: var(--ob-4-bg); --ob-fg: var(--ob-4-fg); }
.owner-badge[data-hue="5"] { --ob-bg: var(--ob-5-bg); --ob-fg: var(--ob-5-fg); }
.owner-badge[data-hue="6"] { --ob-bg: var(--ob-6-bg); --ob-fg: var(--ob-6-fg); }
.owner-badge[data-hue="7"] { --ob-bg: var(--ob-7-bg); --ob-fg: var(--ob-7-fg); }
.card-summary {
  margin-top: 6px;
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--ib-text-2);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.card-foot { margin-top: 10px; display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--ib-text-2); min-width: 0; }
.card-status { display: inline-flex; align-items: center; gap: 7px; min-width: 0; flex: 1 1 auto; white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
.card-status .st-text { overflow: hidden; text-overflow: ellipsis; }
.card-status .st-icon { flex-shrink: 0; display: inline-flex; align-items: center; color: var(--st-color); }
.card-status .st-icon svg { width: 12px; height: 12px; }
.st-prefix { display: none; }
.st-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--st-color); display: inline-block; }
.st-dot.is-hollow { background: transparent; box-shadow: inset 0 0 0 1.5px var(--st-color); }
.spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--ib-pill); border-top-color: var(--st-run); border-right-color: var(--st-run); display: inline-block; animation: spin 0.9s linear infinite; }
.card-metrics { display: inline-flex; align-items: center; color: var(--ib-muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.card-metrics .metric { display: inline-flex; align-items: center; gap: 5px; padding: 0 9px; }
.card-metrics .metric + .metric { border-left: 1px solid var(--ib-card-border); }
.card-metrics .metric:last-child { padding-right: 0; }
.card-metrics svg { width: 13px; height: 13px; }
/* SSOT 2026-10-22 T3 — the task in progress on the collapsed face. */
.card-task { margin-top: 8px; display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; color: var(--ib-text); background: var(--ib-pill); border-radius: 8px; padding: 5px 9px; }
.card-task .ct-id { flex-shrink: 0; color: var(--ib-muted); font-variant-numeric: tabular-nums; font-size: 12px; }
.card-task .ct-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-task .ct-time { flex-shrink: 0; color: var(--ib-text-2); font-variant-numeric: tabular-nums; }
/* SSOT 2026-10-22 T1/T2 — total tokens · cost, counted up live (startCountUp). */
.card-usage { margin-top: 8px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 13px; color: var(--ib-text-2); font-variant-numeric: tabular-nums; }
.card-usage .cnt { color: var(--ib-text); font-weight: 600; }
.card-usage .cu-unit { margin-left: 3px; color: var(--ib-muted); }
.card-usage .cu-sep { color: var(--ib-muted); }
/* Armed automatic resume (turn retry / goal re-check): the clock in the status
   line and the open card's resume row take the "waiting" hue, not the run hue. */
.st-icon.is-resume, .card-resume svg { color: var(--st-wait); }
.card-resume { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; background: var(--ib-pill); font-size: 12.5px; line-height: 1.45; color: var(--ib-text-2); }
.card-resume svg { width: 13px; height: 13px; flex-shrink: 0; margin-top: 2px; }
.card-resume .cr-when { font-weight: 600; color: var(--ib-text); }
.card-resume .cr-reason { overflow-wrap: anywhere; }

/* Expansion — grid row 0fr → 1fr. min-height/overflow live on the grid item
   so the row can collapse to zero; siblings below move with the animated row. */
.card-expand { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-expand) var(--ease-out); }
.card.is-expanded .card-expand { grid-template-rows: 1fr; }
.card-expand-inner { min-height: 0; overflow: hidden; opacity: 0; transition: opacity var(--dur-expand) var(--ease-out); }
.card.is-expanded .card-expand-inner { opacity: 1; }
.card.no-motion .card-expand, .card.no-motion .card-expand-inner { transition: none; }
.card-body { margin: 0 14px; padding: 12px 0 14px; border-top: 1px solid var(--ib-card-border); font-size: 13px; color: var(--ib-text-2); }
.cb-model { color: var(--ib-muted); font-size: 13px; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; }
.cb-model-select { font: inherit; font-size: 13px; color: var(--ib-text); background: var(--ib-seg); border: 1px solid var(--ib-card-border); border-radius: 8px; padding: 4px 8px; min-height: 30px; max-width: 100%; cursor: pointer; }
.cb-model-select:disabled { opacity: 0.6; cursor: progress; }
.cb-ac { font-variant-numeric: tabular-nums; }
.cb-model-note { margin-top: 4px; font-size: 12px; color: var(--ib-text-2); overflow-wrap: anywhere; }
.cb-model-note.is-error { color: var(--st-fail); }
.panel-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 8px 16px; border-bottom: 1px solid var(--border); font-size: 13px; }
.panel-controls:empty { display: none; }
.panel-controls .pc-scope { font-size: 12px; font-weight: 700; color: var(--text-tertiary); }
.panel-controls .cb-model-select { color: var(--text); background: var(--surface-raised); border-color: var(--border); }
.panel-controls .cb-model-note { flex-basis: 100%; margin-top: 0; }

/* ── EXPANDED META — moved from the old card face, same dhShow() gates ── */
.card .card-meta {
  font-size: 12px;
  color: var(--ib-muted);
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
  align-items: center;
}
.card .card-meta span { white-space: nowrap; }
.card .card-meta span + span::before { content: "·"; color: var(--ib-muted); opacity: 0.6; margin-right: 6px; }
.card .card-meta .meta-owner { color: var(--ib-text-2); }
.card .card-subtitle { font-size: 12px; color: var(--ib-text-2); margin-top: 3px; overflow-wrap: anywhere; }
.card .card-merge { color: var(--st-done); font-weight: 600; font-variant-numeric: tabular-nums; }
.card .card-tokens .cost { color: var(--st-done); font-weight: 600; }
.card .card-stats { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--ib-muted); font-variant-numeric: tabular-nums; }
.card .card-stats > span { white-space: nowrap; }

/* ── TIMER STATS — Σ thread total · compactions · sessions ── */
.card .card-timer-row { display: inline-flex; gap: 10px; flex-wrap: wrap; }
.card .card-timer-row > span { white-space: nowrap; }

/* ── SHORT REFS ROW — PROJ-123 · PR-123 ── */
.card .card-refs {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 12px;
  color: var(--ib-muted);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-top: 6px;
  flex-wrap: wrap;
}
.card .card-refs a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}
.card .card-refs a:focus-visible { text-decoration: underline; }
.card .card-refs .ref-sep { color: var(--ib-muted); opacity: 0.6; }

/* ── ENV BADGE — multi-instance origin tag (#814) ── */
.card .card-meta .env-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 0.78em;
  font-weight: 600;
  color: #fff;
  letter-spacing: 0.02em;
  vertical-align: baseline;
  /* color is set inline via getEnvBadgeColor() because we hash the
     instanceName at render time; the CSS just owns layout. */
}
/* Topbar tooltip — env-grouped token breakdown (#814) */
#stat-tokens-wrap {
  position: relative;
  display: inline-block;
}
#stat-tokens-tooltip {
  display: none;
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 4px;
  background: var(--surface, #222);
  color: var(--text, #eee);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 0.78em;
  font-weight: 400;
  white-space: nowrap;
  z-index: 50;
  pointer-events: none;
}
#stat-tokens-wrap.tooltip-open #stat-tokens-tooltip,
#stat-tokens-wrap:hover #stat-tokens-tooltip { display: block; }
@media (hover: none) {
  /* On touch devices :hover is sticky after a tap and never closes —
     gate visibility entirely on the explicit tooltip-open class
     toggled by the tap handler in updateTokenBreakdown(). */
  #stat-tokens-wrap:hover #stat-tokens-tooltip { display: none; }
  #stat-tokens-wrap.tooltip-open #stat-tokens-tooltip { display: block; }
}

/* ── CONTEXT USAGE BAR ── */
.card .context-bar { margin-top: 8px; height: 4px; background: var(--ib-pill); border-radius: 2px; overflow: hidden; }
.card .context-bar-fill { width: 100%; height: 100%; border-radius: 2px; transform-origin: left center; transition: transform 0.3s var(--ease-out); background: var(--st-run); }
.card .context-bar-fill.ctx-warn { background: var(--st-wait); }
.card .context-bar-fill.ctx-danger { background: var(--st-fail); }

/* ── TASK TIMELINE — dot + step + time; only the current step's dot is solid ── */
.tl-wrap { margin-top: 10px; }
.tl { list-style: none; margin: 0; padding: 0; }
.tl-item { position: relative; display: flex; gap: 10px; padding: 0 0 8px 16px; line-height: 1.4; color: var(--ib-text-2); }
.tl-item::before { content: ''; position: absolute; left: 2px; top: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--ib-muted); opacity: 0.55; }
.tl-item::after { content: ''; position: absolute; left: 4.5px; top: 15px; bottom: 1px; width: 1px; background: var(--ib-card-border); }
.tl-item:last-child { padding-bottom: 0; }
.tl-item:last-child::after { display: none; }
.tl-item.is-current { color: var(--ib-text); }
.tl-item.is-current::before { background: var(--ib-text); opacity: 1; }
.tl-item.is-pending { color: var(--ib-muted); }
.tl-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.tl-time { flex-shrink: 0; color: var(--ib-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.tl-more { font-size: 12px; color: var(--ib-muted); padding: 0 0 6px 16px; }
.tl-id { flex-shrink: 0; color: var(--ib-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.tl-tools { white-space: nowrap; }
.tl-earlier-title { margin: 8px 0 4px; font-size: 11.5px; color: var(--ib-muted); }
.tl-earlier .tl-item { color: var(--ib-muted); }
.tl-toggle { margin-top: 6px; font: inherit; font-size: 12px; color: var(--ib-text-2); background: none; border: 1px solid var(--ib-card-border); border-radius: 6px; padding: 3px 10px; min-height: 28px; cursor: pointer; }
.spin { display: inline-block; animation: spin 1.5s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* ── INSTRUCTION / RESPONSE — latest pair, lazy-loaded on expand ── */
.card-io { margin-top: 12px; display: grid; gap: 6px; }
.io-row { border-radius: 8px; padding: 8px 10px; background: var(--ib-col); min-width: 0; }
.io-label { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--ib-muted); margin-bottom: 3px; display: flex; gap: 6px; align-items: baseline; }
.io-label .io-who { font-weight: 500; letter-spacing: 0; }
.io-text { font-size: 13px; line-height: 1.45; color: var(--ib-text); white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
.io-text .io-title { font-weight: 600; }
.io-text.is-muted, .io-muted { color: var(--ib-muted); }

/* ── ACTION BUTTONS — secondary outline + one solid primary (reference "Approve") ── */
.card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; justify-content: flex-end; }
.btn-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--ib-card);
  border: 1px solid var(--ib-card-border);
  border-radius: 8px;
  color: var(--ib-text);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 5px 12px;
  cursor: pointer;
  min-height: 32px;
  text-decoration: none;
  white-space: nowrap;
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out);
}
.btn-action:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-action.btn-primary { background: var(--ib-text); border-color: var(--ib-text); color: var(--ib-card); }
.btn-action.btn-stop { color: var(--st-fail); }
.btn-action.btn-trash { color: var(--ib-muted); }

/* ── GOAL LIST (work item, SSOT 2026-10-21 T2/T3) ── */
.card-goal {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ib-card-border);
  border-radius: 8px;
  background: var(--ib-card-dim);
  font-size: 12.5px;
}
.card-goal .cg-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.card-goal .cg-label { font-weight: 600; color: var(--ib-text); }
.card-goal .cg-status {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid currentColor;
  line-height: 1.5;
}
.card-goal .cg-status.cg-active { color: var(--st-run); }
.card-goal .cg-status.cg-paused { color: var(--st-wait); }
.card-goal .cg-status.cg-complete { color: var(--st-done); }
.card-goal .cg-progress { margin-left: auto; color: var(--ib-muted); font-variant-numeric: tabular-nums; }
.card-goal .cg-objective {
  color: var(--ib-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-goal .cg-gap { margin-top: 3px; color: var(--ib-muted); overflow-wrap: anywhere; }
.card-goal .cg-empty { color: var(--ib-muted); }
.card-goal .cg-row { display: flex; align-items: flex-start; gap: 6px; }
.card-goal .cg-row > :first-child { flex: 1; min-width: 0; }
.card-goal .cg-queue-title { margin-top: 8px; color: var(--ib-muted); font-size: 11.5px; }
.card-goal .cg-queue { list-style: decimal; margin: 2px 0 0 18px; }
.card-goal .cg-queue li { padding: 2px 0; }
.card-goal .cg-q-text { overflow-wrap: anywhere; color: var(--ib-text); }
.card-goal .cg-history-toggle { margin-left: auto; font: inherit; font-size: 11.5px; color: var(--ib-text-2); background: none; border: 1px solid var(--ib-card-border); border-radius: 6px; padding: 2px 8px; min-height: 26px; cursor: pointer; white-space: nowrap; }
.card-goal .cg-progress + .cg-history-toggle { margin-left: 8px; }
.card-goal .cg-history { list-style: none; margin: 4px 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.card-goal .cg-h-item { border-left: 2px solid var(--st-done); padding: 2px 0 2px 8px; }
.card-goal .cg-h-obj { color: var(--ib-text); overflow-wrap: anywhere; }
.card-goal .cg-h-meta { margin-top: 2px; color: var(--ib-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.card-goal .cg-h-reason { margin-top: 2px; color: var(--ib-text-2); font-size: 11.5px; overflow-wrap: anywhere; }
.card-goal .cg-btn {
  flex: none;
  font: inherit;
  font-size: 11.5px;
  padding: 2px 8px;
  border: 1px solid var(--ib-card-border);
  border-radius: 6px;
  background: var(--ib-card);
  color: var(--ib-text);
  cursor: pointer;
}
.card-goal .cg-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.card-goal .cg-btn.cg-danger { color: var(--st-fail); }
.card-goal .cg-add { display: flex; gap: 6px; margin-top: 8px; }
.card-goal .cg-add-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 12.5px;
  padding: 4px 8px;
  border: 1px solid var(--ib-card-border);
  border-radius: 6px;
  background: var(--ib-card);
  color: var(--ib-text);
}
.card-goal .cg-add-input:focus { outline: none; border-color: var(--border-focus); }
.card-goal .cg-error { margin-top: 6px; color: var(--st-fail); overflow-wrap: anywhere; }

/* ── PENDING QUESTION (dashboard choice buttons) ── */
.card-question {
  margin-top: 8px;
  padding: 8px;
  background: rgba(246,201,14,0.06);
  border: 1px solid rgba(246,201,14,0.2);
  border-radius: 6px;
}
.card-question-text {
  font-size: 0.78em;
  color: var(--yellow);
  font-weight: 600;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.card-question-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.btn-choice {
  font-size: 0.72em;
  padding: 4px 10px;
  border: 1px solid rgba(77,157,224,0.4);
  border-radius: 4px;
  background: rgba(77,157,224,0.08);
  color: var(--accent);
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out);
  font-family: inherit;
  line-height: 1.3;
}
.btn-choice:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-choice-recommended {
  /* WCAG AA: #2d8644 vs white = 4.56:1 (meets 4.5:1 for normal text) */
  background: #2d8644;
  color: white;
  border: 2px solid #256f38;
  font-weight: 600;
}
.btn-choice-recommended::before { content: "\\2B50 "; }
.choice-row-recommended .btn-choice-recommended {
  width: 100%;
  display: block;
  text-align: center;
}
/* Hero "Submit All Recommended" — group-only, top of multi-choice panel */
.btn-hero-recommended {
  display: block;
  width: 100%;
  padding: 12px;
  font-size: 1.05em;
  background: #2d8644;
  color: white;
  border: 2px solid #256f38;
  border-radius: 6px;
  font-weight: 600;
  margin-bottom: 12px;
  cursor: pointer;
}
.btn-hero-recommended:hover:not(:disabled) {
  background: #256f38;
  border-color: #1f5c2e;
}
.btn-hero-recommended:disabled,
.btn-hero-recommended[aria-disabled="true"] {
  opacity: 0.7;
  cursor: not-allowed;
}
.choice-divider {
  border: none;
  border-top: 1px solid var(--border, #e0e0e0);
  margin: 6px 0;
}
.card-question-multi {
  font-size: 0.72em;
  color: var(--text-secondary);
  margin-top: 4px;
}
.card-question-multi a {
  color: var(--accent);
  text-decoration: none;
}
.card-question-multi a:hover { text-decoration: underline; }
/* Pending question inside an open card — the card's own button language
   (reference "Reject | Approve"): outline choices, the recommended one solid
   and last on the right. Markup and handlers are the shared ones above. */
.card .card-question { margin-top: 12px; padding: 10px 12px; background: var(--ib-col); border: 0; border-radius: 8px; }
.card .card-question-text { font-size: 13px; color: var(--ib-text); margin-bottom: 8px; }
.card .card-question-multi { font-size: 12px; color: var(--ib-muted); }
.card .card-question-choices { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.card .choice-divider { display: none; }
.card .choice-row-recommended { order: 2; max-width: 100%; min-width: 0; }
.card .btn-choice { font-size: 13px; padding: 5px 12px; min-height: 32px; border-radius: 8px; border: 1px solid var(--ib-card-border); background: var(--ib-card); color: var(--ib-text); text-align: left; max-width: 100%; min-width: 0; overflow-wrap: anywhere; }
.card .btn-choice-recommended::before { content: none; }
.card .choice-row-recommended .btn-choice-recommended,
.card .btn-choice-recommended { display: inline-block; width: auto; background: var(--ib-text); border-color: var(--ib-text); color: var(--ib-card); font-weight: 600; }

/* ── PANEL PENDING QUESTION ── */
.panel-question {
  padding: 12px 16px;
  background: rgba(246,201,14,0.06);
  border-bottom: 1px solid rgba(246,201,14,0.15);
}
.panel-question-text {
  font-size: 0.88em;
  color: var(--yellow);
  font-weight: 600;
  margin-bottom: 8px;
}
.panel-question-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.panel-question .btn-choice {
  font-size: 0.82em;
  padding: 6px 14px;
}

/* ── MULTI-CHOICE FORM (dashboard) ── */
.mc-form {
  padding: 12px;
}
.mc-header {
  margin-bottom: 10px;
}
.mc-header h4 {
  font-size: 13px;
  font-weight: 700;
  color: var(--yellow);
  margin-bottom: 4px;
}
.mc-header p {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}
.mc-progress {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 11px;
  color: var(--text-tertiary);
  font-weight: 600;
}
.mc-progress-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border);
  transition: background var(--speed) var(--ease), box-shadow var(--speed) var(--ease);
}
.mc-progress-dot.filled {
  background: var(--green);
}
.mc-progress-dot.active {
  background: var(--yellow);
  box-shadow: 0 0 0 2px rgba(246,201,14,0.3);
}
.mc-progress-text {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}
.mc-questions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mc-question {
  background: rgba(246,201,14,0.04);
  border: 1px solid rgba(246,201,14,0.15);
  border-radius: 6px;
  padding: 10px;
  transition: border-color var(--speed) var(--ease), background var(--speed) var(--ease);
}
.mc-question.selected {
  background: rgba(62,207,142,0.04);
  border-color: rgba(62,207,142,0.25);
}
.mc-question.active {
  border-color: rgba(246,201,14,0.4);
  background: rgba(246,201,14,0.08);
}
.mc-q-header {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
  line-height: 1.4;
}
.mc-q-header .mc-q-num {
  color: var(--yellow);
  margin-right: 4px;
  font-variant-numeric: tabular-nums;
}
.mc-q-context {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 8px;
  padding: 6px 8px;
  background: rgba(255,255,255,0.02);
  border-radius: 4px;
  border-left: 2px solid var(--border);
}
.mc-q-context code {
  background: rgba(255,255,255,0.06);
  padding: 1px 4px;
  border-radius: 2px;
  font-family: 'SF Mono','Fira Code',monospace;
  font-size: 0.92em;
}
.mc-q-context strong { color: var(--text); }
.mc-q-context em { font-style: italic; color: var(--text-secondary); }
.mc-q-context a { color: var(--accent); text-decoration: none; }
.mc-q-context a:hover { text-decoration: underline; }
.mc-q-choices {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mc-q-choices .btn-choice {
  text-align: left;
  width: 100%;
  display: block;
}
.mc-q-selected {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--green);
  font-weight: 600;
}
.mc-q-selected .mc-sel-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mc-q-edit-btn {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid rgba(246,201,14,0.3);
  border-radius: 4px;
  background: transparent;
  color: var(--yellow);
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
  flex-shrink: 0;
}
.mc-q-edit-btn:hover {
  border-color: var(--yellow);
  background: rgba(246,201,14,0.08);
}
.mc-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  justify-content: flex-end;
}
.mc-btn-submit {
  font-size: 12px;
  font-weight: 700;
  padding: 8px 20px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--bg);
  cursor: pointer;
  transition: background var(--speed) var(--ease);
  font-family: inherit;
  min-height: 34px;
}
.mc-btn-submit:hover { background: var(--accent-hover); }
.mc-btn-submit:disabled { background: var(--surface-raised); color: var(--text-tertiary); cursor: default; }
.mc-btn-reset {
  font-size: 12px;
  font-weight: 600;
  padding: 8px 14px;
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--speed) var(--ease);
  font-family: inherit;
  min-height: 34px;
}
.mc-btn-reset:hover { border-color: var(--red); color: var(--red); background: rgba(239,68,68,0.08); }
.mc-custom-input {
  width: 100%;
  margin-top: 4px;
  display: flex;
  gap: 4px;
}
.mc-custom-input input {
  flex: 1;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 12px;
  padding: 4px 8px;
  outline: none;
  font-family: inherit;
  min-height: 28px;
  transition: border-color var(--speed) var(--ease);
}
.mc-custom-input input:focus { border-color: var(--accent); }
.mc-custom-input input::placeholder { color: var(--text-tertiary); }
.mc-custom-input button {
  font-size: 11px;
  padding: 4px 10px;
  border: 1px solid rgba(77,157,224,0.4);
  border-radius: 4px;
  background: rgba(77,157,224,0.08);
  color: var(--accent);
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
  flex-shrink: 0;
  min-height: 28px;
}
.mc-custom-input button:hover {
  border-color: var(--accent);
  background: rgba(77,157,224,0.18);
  color: var(--text);
}

/* ── CHARTS — flat, geometric ── */
.chart-row { display: flex; gap: 10px; margin-bottom: 16px; }
.chart-container {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
}
.chart-container h4 { font-size: 12px; font-weight: 700; color: var(--text-tertiary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
.bar-chart { display: flex; align-items: flex-end; gap: 2px; height: 80px; }
.bar { background: var(--accent); border-radius: 1px 1px 0 0; min-width: 4px; flex: 1; transition: height 0.3s; position: relative; }
.bar:hover { background: var(--purple); }
.bar .bar-tooltip {
  display: none;
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 4px 8px;
  border-radius: var(--radius);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  z-index: 10;
}
.bar:hover .bar-tooltip { display: block; }
.bar-labels { display: flex; gap: 2px; margin-top: 4px; }
.bar-labels span { flex: 1; text-align: center; font-size: 10px; color: var(--text-tertiary); font-weight: 600; }

/* ── SLIDE PANEL — flat, structured, resizable ── */
.slide-panel {
  position: fixed;
  top: 0; right: -440px;
  width: 440px;
  height: 100vh;
  background: var(--surface);
  border-left: 1px solid var(--border);
  z-index: 100;
  transition: right 0.2s var(--ease);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.slide-panel.open { right: 0; }
.slide-panel.resizing { transition: none; user-select: none; }
/* Resize handle — left edge */
.panel-resize-handle {
  position: absolute;
  top: 0; left: -4px;
  width: 8px; height: 100%;
  cursor: col-resize;
  z-index: 101;
  background: transparent;
  transition: background 0.15s ease;
}
.panel-resize-handle:hover,
.panel-resize-handle.active {
  background: var(--accent);
  opacity: 0.4;
}
/* Panel tasks (.prd/10 §3.1-6) — pinned between the token badges and the
   scroll area: always shown (an empty line when there are none yet), with its
   own scroll so a long list never pushes the work log and turns away. */
.panel-tasks {
  flex: none;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  max-height: min(30vh, 240px);
  overflow-y: auto;
}
.panel-tasks-empty { font-size: 12px; color: var(--text-tertiary); padding: 2px 0 4px; }
.panel-tasks-header {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-tasks-header .tasks-progress {
  font-weight: 600;
  color: var(--accent);
  font-size: 11px;
  text-transform: none;
  letter-spacing: 0;
}
.panel-task-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 3px 0;
  font-size: 12px;
  line-height: 1.4;
}
.panel-task-item .task-icon { flex-shrink: 0; font-size: 12px; }
.panel-task-item .task-text { flex: 1; min-width: 0; }
.panel-task-item .task-id { flex-shrink: 0; color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.panel-task-item.completed .task-text { color: var(--text-tertiary); opacity: 0.6; }
.panel-task-item.in_progress .task-text { color: var(--text); font-weight: 600; }
.panel-task-item.pending .task-text { color: var(--text-secondary); }
.panel-task-item .task-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  min-width: 50px;
}
.panel-tasks-toggle {
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
  padding: 4px 0;
  user-select: none;
  border: none;
  background: none;
  font-weight: 600;
}
.panel-tasks-toggle:hover { text-decoration: underline; }
/* Panel work log (.prd/10 §3.1-6, §3.3) — what the agent did, in order. The
   header is a disclosure button (collapsed unless the panel was opened from
   작업 로그); the count keeps counting while it is closed. Own scroll box so
   live appends tail-follow without moving the turn list. */
.panel-worklog { padding: 4px 16px 6px; border-bottom: 1px solid var(--border); }
.panel-worklog-header {
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 4px 0;
  background: none;
  border: 0;
  text-align: left;
  cursor: pointer;
}
.panel-worklog-header .wl-count { font-weight: 600; color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.panel-worklog-header .wl-chevron { width: 12px; height: 12px; margin-left: auto; flex-shrink: 0; transition: transform var(--dur-expand) var(--ease-out); }
.panel-worklog-header[aria-expanded="true"] .wl-chevron { transform: rotate(180deg); }
.worklog-list { max-height: min(48vh, 440px); overflow-y: auto; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; line-height: 1.45; margin: 2px 0 4px; }
.worklog-list[hidden] { display: none; }
.wl-empty { color: var(--text-tertiary); font-size: 12px; padding: 6px 0; }
.wl-entry { color: var(--text); min-width: 0; }
/* SSOT 2026-10-22 T10 — entries folded under the task they were made in. */
.wl-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.wl-group-head { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 6px; border-radius: 6px; background: var(--surface-raised); cursor: pointer; font-weight: 600; }
.wl-group-head:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.wl-group-head .wl-g-chev { flex-shrink: 0; display: inline-block; color: var(--text-tertiary); transition: transform var(--dur-press) var(--ease-out); }
.wl-group-head[aria-expanded="true"] .wl-g-chev { transform: rotate(90deg); }
.wl-group-head .wl-g-id { flex-shrink: 0; color: var(--text-tertiary); font-variant-numeric: tabular-nums; font-weight: 500; }
.wl-group-head .wl-g-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-group-head .wl-g-count { flex-shrink: 0; background: var(--surface); border-radius: 6px; padding: 0 6px; font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.wl-group-head .wl-g-meta { flex-shrink: 0; font-size: 11px; font-weight: 500; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.wl-group-body { display: flex; flex-direction: column; gap: 4px; padding-left: 12px; border-left: 2px solid var(--border); margin-left: 6px; }
.wl-group-body[hidden] { display: none; }
.wl-head { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--text-tertiary); }
.wl-label { font-weight: 700; letter-spacing: 0.04em; }
.wl-head .wl-time { margin-left: auto; }
.wl-time { color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
/* Each entry = a row (role=button: click, Enter or Space opens its raw output
   below it) + its detail block. */
.wl-row { border-radius: 4px; cursor: pointer; min-width: 0; }
.wl-row:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.wl-row[aria-expanded="true"] { background: var(--surface-raised); }
.wl-row > .wl-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.wl-line { display: flex; align-items: baseline; gap: 8px; }
.wl-line > .wl-text { flex: 1; min-width: 0; }
.wl-narration .wl-text { color: var(--text-secondary); }
.wl-detail { margin: 4px 0 6px; min-width: 0; font-family: Inter,ui-sans-serif,system-ui,sans-serif; }
.wl-detail-bar { display: flex; justify-content: flex-end; gap: 6px; margin-bottom: 4px; }
.wl-detail-btn { font: inherit; font-size: 11px; font-weight: 600; color: var(--text-secondary); background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 3px 10px; min-height: 26px; cursor: pointer; }
.wl-detail-msg { font-size: 12px; color: var(--text-tertiary); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wl-detail-note { font-size: 11px; color: var(--yellow); margin-bottom: 4px; }
.wl-raw {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-family: 'SF Mono','Fira Code',ui-monospace,monospace;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: min(36vh, 320px);
  overflow: auto;
}
.wl-instruction { background: rgba(77,157,224,0.08); border-left: 2px solid var(--accent); border-radius: 4px; padding: 6px 8px; margin: 4px 0; }
.wl-instruction .wl-label { color: var(--accent); }
.wl-final { border-left: 2px solid var(--green); padding: 4px 8px; margin: 4px 0; }
.wl-final .wl-label { color: var(--green); }
.wl-notice .wl-row > .wl-text { color: var(--text-tertiary); font-style: italic; }
.wl-error { border-left: 2px solid var(--red); padding: 4px 8px; }
.wl-error .wl-label, .wl-error .wl-row > .wl-text { color: var(--red); }
.wl-tool, .wl-tool_result {
  font-family: 'SF Mono','Fira Code',ui-monospace,monospace;
  font-size: 11.5px;
  color: var(--text-secondary);
  min-width: 0;
}
.wl-tool > .wl-row, .wl-tool_result > .wl-row { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.wl-tool .wl-text, .wl-tool_result .wl-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-tool-name { color: var(--text); font-weight: 600; flex-shrink: 0; }
.wl-mark { flex-shrink: 0; width: 1em; text-align: center; color: var(--text-tertiary); }
.wl-tool_result .wl-mark { color: var(--green); }
.wl-tool_result.is-fail .wl-mark, .wl-tool_result.is-fail .wl-tool-name { color: var(--red); }
.slide-panel-overlay {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  background: rgba(0,0,0,0.5);
  z-index: 99;
  display: none;
}
.slide-panel-overlay.open { display: block; }
.panel-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-header h3 {
  flex: 1;
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel-close {
  width: 32px; height: 32px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--speed) var(--ease);
}
.panel-close:hover { color: var(--text); border-color: var(--accent); }
.panel-meta {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}
.panel-meta .meta-item { display: inline-flex; align-items: baseline; gap: 4px; }
.panel-meta .meta-label { color: var(--text-tertiary); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.panel-meta .meta-value { color: var(--text); font-weight: 600; }
.panel-links {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.panel-links a {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
  background: var(--surface-raised);
  padding: 4px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  transition: border-color var(--speed) var(--ease);
  min-height: 28px;
  display: inline-flex;
  align-items: center;
}
.panel-links a:hover { border-color: var(--accent); }
.panel-tokens {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.token-badge {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--radius);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.token-badge .tok-label { color: var(--text-tertiary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.token-badge .tok-value { color: var(--accent); font-variant-numeric: tabular-nums; }
.token-badge .tok-cost { color: var(--green); }
/* Scroll container: wraps panel-question + panel-worklog + panel-turns so
   large UIAskQ choices scroll together with the chat content. Tasks sit pinned
   above it and .panel-command stays pinned below, both non-scrolling siblings. */
.panel-scroll { flex: 1; overflow-y: auto; scroll-behavior: smooth; min-height: 0; }
.panel-turns { padding: 10px 16px; }
.panel-turns-loading { text-align: center; font-size: 11px; color: var(--text-tertiary); padding: 8px 0; font-style: italic; }
/* Slack-style turns */
.turn { margin-bottom: 8px; padding: 8px 10px; border-radius: var(--radius); display: flex; gap: 10px; align-items: flex-start; }
.turn.user { background: var(--surface-raised); border-left: 3px solid var(--accent); }
.turn.assistant { background: transparent; border-left: 3px solid var(--purple); }
.turn-avatar { width: 32px; height: 32px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; flex-shrink: 0; }
.user-avatar { background: var(--accent); color: #fff; }
.bot-avatar { background: var(--purple); font-size: 16px; }
.turn-body { flex: 1; min-width: 0; }
.turn-header { font-size: 12px; color: var(--text-tertiary); margin-bottom: 4px; display: flex; gap: 8px; align-items: baseline; }
.turn-name { font-weight: 700; color: var(--text-primary); font-size: 13px; text-transform: none; letter-spacing: 0; }
.turn-time { font-size: 11px; color: var(--text-tertiary); }
.turn-content { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.turn-summary-title { font-weight: 700; font-size: 13px; margin-bottom: 2px; }
.turn-summary-body { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
.turn-raw-details { margin-top: 6px; }
.turn-raw-details summary.turn-expand-btn { cursor: pointer; color: var(--accent); font-size: 11px; padding: 2px 0; user-select: none; list-style: none; }
.turn-raw-details summary.turn-expand-btn::-webkit-details-marker { display: none; }
.turn-raw-details summary.turn-expand-btn::before { content: '\\25B6 '; font-size: 9px; }
.turn-raw-details[open] summary.turn-expand-btn::before { content: '\\25BC '; }
.turn-raw-details summary.turn-expand-btn:hover { text-decoration: underline; }
.turn-raw-content { margin-top: 6px; background: var(--surface); padding: 10px; border-radius: 6px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; border: 1px solid var(--border); }
.turn-raw-loading { color: var(--text-tertiary); font-style: italic; font-size: 11px; }
/* Slack link on cards */
.slack-link { color: var(--accent); text-decoration: none; font-size: 0.85em; margin-left: 4px; opacity: 0.7; }
.slack-link:hover { text-decoration: underline; opacity: 1; }
/* PR status badges */
.card .card-links .pr-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 700; margin-left: 3px; text-transform: uppercase; letter-spacing: 0.03em; }
.card .card-links .pr-open { background: rgba(96,165,250,0.15); color: var(--accent); }
.card .card-links .pr-merged { background: rgba(167,139,250,0.15); color: var(--purple); }

/* ── COMMAND INPUT — flat ── */
.panel-command {
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}
.panel-command-row {
  display: flex;
  gap: 8px;
}
.cmd-hint {
  font-size: 11px;
  color: var(--text-tertiary);
  padding: 0 0 6px 0;
  text-align: center;
  font-style: italic;
}
.panel-command input {
  flex: 1;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-size: 13px;
  padding: 8px 12px;
  outline: none;
  min-height: 36px;
  transition: border-color var(--speed) var(--ease);
}
.panel-command input:focus { border-color: var(--accent); }
.panel-command input::placeholder { color: var(--text-tertiary); }
.panel-command input:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-send {
  background: var(--accent);
  border: none;
  border-radius: var(--radius);
  color: var(--bg);
  font-size: 12px;
  font-weight: 700;
  padding: 8px 14px;
  cursor: pointer;
  min-height: 36px;
  transition: background var(--speed) var(--ease);
  flex-shrink: 0;
}
.btn-send:hover { background: var(--accent-hover); }
.btn-send:disabled { background: var(--surface-raised); color: var(--text-tertiary); cursor: default; }

/* ── DONE by finish day (SSOT 2026-10-22 T11/T12) ── */
#cards-done { gap: 4px; }
.done-group { display: flex; flex-direction: column; gap: 8px; }
.done-group.is-stale { display: none; }
.done-group-head { display: flex; align-items: center; gap: 8px; width: 100%; font: inherit; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: var(--ib-text-2); background: none; border: 0; border-radius: 8px; padding: 6px 8px; min-height: 32px; cursor: pointer; text-align: left; }
.done-group-head:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.done-group-head .dg-chev { width: 12px; height: 12px; flex-shrink: 0; color: var(--ib-muted); transition: transform var(--dur-press) var(--ease-out); }
.done-group-head[aria-expanded="true"] .dg-chev { transform: rotate(90deg); }
.done-group-head .dg-label { flex: 1 1 auto; }
.done-group-head .count { background: var(--ib-pill); color: var(--ib-text-2); border-radius: 6px; padding: 1px 7px; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.done-group-cards[hidden] { display: none; }
/* ── CLOSED CARDS — legacy foot of DONE (now always empty) ── */
.show-older-btn {
  background: transparent;
  border: 1px dashed var(--ib-card-border);
  border-radius: 10px;
  color: var(--ib-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;
  cursor: pointer;
  margin: 8px 0 2px;
  width: 100%;
  transition: border-color 150ms ease, color 150ms ease, transform var(--dur-press) var(--ease-out);
  text-align: center;
  min-height: 32px;
}

/* ── PRESS — buttons and segments give 0.97 feedback (§4-5), pointer presses only:
   a keyboard-focused control matches :focus-visible, so Space/Enter never scale it (§4-9). ── */
.btn-action:active:not(:disabled):not(:focus-visible), .seg-btn:active:not(:focus-visible), .archives-btn:active:not(:focus-visible), .show-older-btn:active:not(:focus-visible), .btn-choice:active:not(:disabled):not(:focus-visible) { transform: scale(0.97); }

/* ── HOVER — pointer devices only; colour/border, never movement (§4-6) ── */
@media (hover: hover) and (pointer: fine) {
  .card:hover { border-color: var(--ib-muted); }
  .card[data-state="sleeping"]:hover, .card[data-state="archived"]:hover { border-color: var(--ib-card-border); }
  .seg-btn:hover { color: var(--ib-text); }
  .archives-btn:hover { color: var(--ib-text); }
  .wl-row:hover { background: var(--surface-raised); }
  .wl-detail-btn:hover { color: var(--text); border-color: var(--text-tertiary); }
  .panel-worklog-header:hover { color: var(--text); }
  .btn-action:hover:not(:disabled) { border-color: var(--ib-muted); }
  .btn-action.btn-primary:hover:not(:disabled) { opacity: 0.88; }
  .btn-action.btn-stop:hover:not(:disabled) { border-color: var(--st-fail); }
  .show-older-btn:hover { border-color: var(--ib-muted); color: var(--ib-text); }
  .stats-more:hover { background: var(--surface-raised); color: var(--text); }
  .card .card-refs a:hover { text-decoration: underline; }
  .btn-choice:hover:not(:disabled) { border-color: var(--accent); background: rgba(77,157,224,0.18); color: var(--text); }
  .btn-choice-recommended:hover:not(:disabled) { background: #256f38; color: white; border-color: #256f38; }
  .card .btn-choice:hover:not(:disabled) { border-color: var(--ib-muted); background: var(--ib-card); color: var(--ib-text); }
  .card .btn-choice-recommended:hover:not(:disabled) { background: var(--ib-text); border-color: var(--ib-text); color: var(--ib-card); opacity: 0.88; }
}

/* ── BOARD RESPONSIVE (.prd/10 §5) ──
   ≥1024 three columns · 640–1023 the columns scroll sideways inside the board
   (page itself never scrolls horizontally) · <640 List by default, 44px taps. */
@media (max-width: 1023px) {
  .kanban[data-view="board"] {
    grid-template-columns: repeat(3, minmax(300px, 1fr));
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
    padding-bottom: 8px;
  }
  .kanban[data-view="board"] > .kanban-col { scroll-snap-align: start; }
  /* Top bar: brand · status · account on the first row, the nav on its own row below, full labels. */
  .topbar { flex-wrap: wrap; padding: 8px 20px; row-gap: 8px; }
  /* Basis 0: the account group never pushes itself onto a row of its own — a
     long name ends in an ellipsis inside the pill instead. */
  .topbar .topbar-account { flex: 1 1 0; justify-content: flex-end; }
  .topbar .nav { order: 1; flex: 1 0 100%; margin-left: 0; flex-wrap: wrap; min-width: 0; }
  /* The nav row is full width: a selected name can use all of it (the other
     controls move to the next line first); only a name wider than the row ends
     in an ellipsis. */
  .topbar .nav .user-select { max-inline-size: 100%; }
}
@media (max-width: 639px) {
  .topbar .td-prefix, .topbar .td-status { display: none; }
  .main { padding: 14px 12px; }
  .panel-tasks { max-height: min(22vh, 160px); }
  /* Stats strip: period control + 자세히 on the first row, the numbers on the
     second. The period tabs share the row's width and keep 44px height with
     narrower sides, so the row fits 320px with the coarse-pointer padding. */
  .stats-strip { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "period more" "nums nums"; gap: 8px 12px; }
  .stats-strip .period-btn { flex: 1 1 auto; padding-left: 12px; padding-right: 12px; }
  /* Top bar: the status badge becomes a 10px dot (aria-label preserved for SR),
     the "Logged in as" prefix goes, and the user select fills the nav row (which
     wraps rather than overflow on very small screens). Labels stay whole. */
  .topbar { padding: 6px 12px; gap: 6px 8px; }
  .topbar h1 { font-size: 12px; }
  .topbar .ws-badge {
    display: inline-block;
    inline-size: 10px;
    block-size: 10px;
    padding: 0;
    border-radius: 50%;
    text-indent: 100%;
    white-space: nowrap;
    overflow: hidden;
    flex-shrink: 0;
    min-width: 0;
  }
  .topbar .nav .user-select { flex: 1 1 auto; }
  .topbar .user-pill { padding: 4px 10px; }
  .topbar .user-pill-prefix { display: none; }
  .topbar .admin-toggle { padding: 4px 10px; }
  #theme-toggle { inline-size: 32px; block-size: 32px; padding: 0; flex-shrink: 0; }
  .inbox-head { margin-bottom: 12px; flex-wrap: wrap; row-gap: 8px; }
  /* The tools take the row under the breadcrumb; on the narrowest screens
     (320px) Show archives sits above Board | List instead of overflowing. */
  .inbox-tools { flex: 1 1 auto; min-width: 0; flex-wrap: wrap; justify-content: flex-end; row-gap: 8px; }
  .crumbs { font-size: 15px; gap: 7px; }
  .kanban[data-view="board"] { grid-template-columns: repeat(3, minmax(min(300px, 84vw), 1fr)); }
  /* Selectors carry an extra class so they beat the later @media (pointer: coarse) 40px rules. */
  .seg .seg-btn { min-height: 44px; padding: 6px 14px; }
  .card .btn-action, .col-foot .show-older-btn, .card .btn-choice { min-height: 44px; }
  .card .btn-action { padding: 8px 14px; }
  .card-face { padding: 14px; }
  .card-metrics .metric { padding: 0 7px; }
}

/* ── RESPONSIVE — Bauhaus grid adapts ── */
@media (max-width: 1100px) {
  .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  /* Workflows — the widest value — takes the last row on its own. */
  .stats-grid .stat-card:last-child { grid-column: 1 / -1; }
}
@media (max-width: 680px) {
  .stats-grid { gap: 6px; margin-bottom: 12px; }
  .stat-card { padding: 8px 12px; }
  .stat-card .value { font-size: 18px; }
  .stat-card .label { font-size: 10px; }
  .chart-row { flex-direction: column; }
  .slide-panel { width: 100vw; right: -100vw; }
}
@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  /* §4-8: no movement or scale — the expanded body only cross-fades. These
     selectors are more specific than the * rule above, so they win. */
  .card-expand { transition: none !important; }
  .card-expand-inner { transition: opacity var(--dur-fade) linear !important; }
  .btn-action:active:not(:disabled):not(:focus-visible), .seg-btn:active:not(:focus-visible), .archives-btn:active:not(:focus-visible), .show-older-btn:active:not(:focus-visible), .btn-choice:active:not(:disabled):not(:focus-visible) { transform: none; }
  /* Static working indicator: a full ring with a centre dot instead of a spin. */
  .spinner, .spin { animation: none !important; }
  .wl-group-head .wl-g-chev, .done-group-head .dg-chev { transition: none; }
  .spinner { border-color: var(--st-run); background: radial-gradient(circle, var(--st-run) 0 2px, transparent 2.5px); }
}
/* ── TOUCH — coarse pointer enlargement ── */
@media (pointer: coarse) {
  .btn-action { min-height: 40px; padding: 8px 12px; font-size: 12px; }
  .btn-send { min-height: 44px; padding: 12px 16px; }
  .panel-command input { min-height: 44px; padding: 12px 16px; }
  .panel-close { width: 40px; height: 40px; }
  .topbar .nav a, .topbar .nav .user-select { min-height: 40px; padding: 8px 16px; }
  .period-btn { min-height: 40px; padding: 12px 20px; }
  .show-older-btn { min-height: 40px; padding: 8px 16px; }
}
/* ── #800: TOUCH x NARROW — restore tight padding so the coarse-pointer
   tap-target (16px horizontal) does not push the topbar past mobile
   widths. min-height stays at 40px for touch-target accessibility
   (WCAG 2.5.5); only the inline padding shrinks. These blocks must
   stay AFTER @media (pointer: coarse) in source order so the more
   specific (combined) query wins the cascade. ── */
@media (max-width: 680px) and (pointer: coarse) {
  .topbar .nav a, .topbar .nav .user-select { padding: 4px 8px; }
}
@media (max-width: 480px) and (pointer: coarse) {
  .topbar .nav a, .topbar .nav .user-select { padding: 4px 6px; }
}
/* ── 44px TARGETS — every remaining control on narrow (<640px) or touch screens.
   Heights only, so the #800 topbar width fit is untouched; the theme toggle keeps
   its 32px square (pinned by #800) and gets a 44px-wide hit slop instead. ── */
@media (max-width: 639px), (pointer: coarse) {
  .topbar .nav a, .topbar .nav .user-select, .topbar .user-pill, .topbar .admin-toggle { min-height: 44px; }
  #theme-toggle { min-block-size: 44px; position: relative; }
  #theme-toggle::after { content: ''; position: absolute; inset: 0 -6px; }
  .period-btn { min-height: 44px; }
  .stats-more { min-height: 44px; }
  .seg .seg-btn, .card .btn-action, .card .btn-choice, .col-foot .show-older-btn { min-height: 44px; }
  .inbox-head .archives-btn { min-height: 44px; }
  .card .card-refs a { display: inline-flex; align-items: center; min-height: 44px; }
  .panel-close { width: 44px; height: 44px; }
  #panel-title-sub-regen { min-width: 44px; min-height: 44px; }
  .panel-links a, .panel-tasks-toggle, .turn .btn-action { min-height: 44px; }
  .panel-worklog-header, .wl-detail-btn { min-height: 44px; }
  .worklog-list .wl-row { min-height: 44px; display: flex; flex-direction: column; justify-content: center; }
  .wl-tool > .wl-row, .wl-tool_result > .wl-row, .worklog-list .wl-row.wl-line { flex-direction: row; align-items: center; }
  .turn-raw-details summary.turn-expand-btn { min-height: 44px; display: flex; align-items: center; }
  .panel-question .btn-choice, .mc-q-choices .btn-choice, .mc-q-edit-btn, .mc-btn-submit, .mc-btn-reset { min-height: 44px; }
  .mc-custom-input input, .mc-custom-input button, .btn-send, .panel-command input { min-height: 44px; }
}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <h1>&#x26A1; soma-work</h1>
    <span class="ws-badge" id="ws-status" role="status" aria-label="WebSocket: Connecting">Connecting...</span>
    <div class="topbar-defaults" id="topbar-defaults" hidden>
      <button type="button" class="td-chip" id="td-model" aria-haspopup="menu" aria-expanded="false" aria-controls="td-menu" title="새 세션의 기본 모델 — 클릭해서 변경" onclick="openDefaultsMenu('model', this)"><span class="td-prefix">모델 </span><b id="td-model-value">…</b><span class="td-caret" aria-hidden="true">&#x25BE;</span></button>
      <button type="button" class="td-chip" id="td-effort" aria-haspopup="menu" aria-expanded="false" aria-controls="td-menu" title="새 세션의 기본 effort — 클릭해서 변경" onclick="openDefaultsMenu('effort', this)"><span class="td-prefix">Effort </span><b id="td-effort-value">…</b><span class="td-caret" aria-hidden="true">&#x25BE;</span></button>
      <div class="td-menu" id="td-menu" role="menu" hidden></div>
      <span class="td-status" id="td-status" role="status" aria-live="polite"></span>
    </div>
    <div class="nav">
      <span class="user-select"><span class="user-select-label" id="user-select-label" aria-hidden="true">All Users</span><select id="user-select" title="All Users" onchange="selectUser(this.value)">
        <option value="">All Users</option>
      </select></span>
      <a href="/conversations"><span aria-hidden="true">&#x1F4DD;</span>Conversations</a>
      <a href="/dashboard/settings" id="settings-link" title="개인 설정 — Slack 명령으로 바꾸던 설정을 여기서 확인하고 바꿉니다"><span aria-hidden="true">&#x2699;&#xFE0F;</span>설정</a>
      <button
        id="admin-mode-toggle"
        type="button"
        class="admin-toggle"
        style="display:none"
        aria-pressed="false"
        title="Toggle admin write mode (#716)"
        onclick="toggleAdminMode()"
      ><span id="admin-mode-label"><span class="admin-mode-prefix">Admin: </span><span class="admin-mode-state">OFF</span></span></button>
    </div>
    <div class="topbar-account">
      <a
        class="user-pill"
        id="user-pill"
        href="/login"
        title="Account — switch account or sign out"
      ><span class="user-pill-prefix">Logged in as </span><b id="user-pill-name">…</b></a>
      <button id="theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme"></button>
    </div>
  </div>

  <div class="main">
    <!-- Stats strip (.prd/10 §3.1-2) leads; the agent inbox board follows it.
         Collapsed by default: period · 세션 · 토큰 · 비용 + 자세히, which opens the
         other cards and the charts below the strip (kept in localStorage). -->
    <section class="stats" id="stats" aria-label="Usage stats">
      <div class="stats-strip">
        <div class="period-bar" role="group" aria-label="&#xAE30;&#xAC04;">
          <button type="button" class="period-btn active" data-period="day" aria-pressed="true" onclick="setPeriod('day')">&#xC624;&#xB298;</button>
          <button type="button" class="period-btn" data-period="week" aria-pressed="false" onclick="setPeriod('week')">&#xC9C0;&#xB09C; 7&#xC77C;</button>
          <button type="button" class="period-btn" data-period="month" aria-pressed="false" onclick="setPeriod('month')">&#xC9C0;&#xB09C; 30&#xC77C;</button>
        </div>
        <div class="strip-nums">
          <div class="strip-num"><span class="label">&#xC138;&#xC158;</span><span class="value" id="stat-sessions">-</span></div>
          <div class="strip-num"><span class="label">&#xD1A0;&#xD070;</span><span class="value" id="stat-tokens-wrap"><span id="stat-tokens">-</span><span id="stat-tokens-tooltip" role="tooltip"></span></span></div>
          <div class="strip-num"><span class="label">&#xBE44;&#xC6A9;</span><span class="value" id="stat-cost">-</span></div>
        </div>
        <button type="button" class="stats-more" id="stats-more" aria-expanded="false" aria-controls="stats-detail" onclick="toggleStatsDetail()"><span>&#xC790;&#xC138;&#xD788;</span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
      </div>
      <div class="stats-detail" id="stats-detail" hidden>
        <div class="stats-grid" id="stats-grid">
          <div class="stat-card"><div class="label">&#xD134; &#xC0AC;&#xC6A9;</div><div class="value" id="stat-turns">-</div></div>
          <div class="stat-card"><div class="label">PR &#xC0DD;&#xC131;</div><div class="value" id="stat-prs">-</div></div>
          <div class="stat-card"><div class="label">PR &#xBA38;&#xC9C0;</div><div class="value" id="stat-merged">-</div></div>
          <div class="stat-card"><div class="label">&#xBA38;&#xC9C0; &#xCF54;&#xB4DC;</div><div class="value" id="stat-merge-lines">-</div></div>
          <div class="stat-card"><div class="label">&#xC6CC;&#xD06C;&#xD50C;&#xB85C;&#xC6B0;</div><div class="value" id="stat-workflows" style="font-size:0.85em">-</div></div>
        </div>
        <div style="display:none" id="stat-commits-hidden"></div>
        <div class="chart-row" id="chart-row"></div>
      </div>
    </section>

    <!-- Agent inbox (.prd/10 §3.1) — the board, right under the stats strip. -->
    <section class="inbox" id="inbox" aria-label="Agent inbox">
      <div class="inbox-head">
        <nav class="crumbs" aria-label="Breadcrumb"><span class="crumb-root">soma-work</span><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-cur" aria-current="page">Agent inbox</span></nav>
        <div class="inbox-tools">
          <button type="button" class="archives-btn" id="archives-toggle" aria-pressed="false" hidden onclick="toggleArchives()"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="3" rx="0.8"/><path d="M3 6v6.2c0 .5.4.8.8.8h8.4c.4 0 .8-.3.8-.8V6M6.5 8.6h3"/></svg><span id="archives-label">Archives</span></button>
          <button type="button" class="archives-btn" id="sleeping-toggle" aria-pressed="true" hidden onclick="toggleSleeping()"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/></svg><span id="sleeping-label">Sleeping</span></button>
          <button type="button" class="archives-btn" id="lifecycle-btn" style="display:none" title="Session lifecycle (admin)" onclick="openLifecycleDialog()"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/></svg><span>Lifecycle</span></button>
          <div class="seg" role="group" aria-label="Board layout">
            <button type="button" class="seg-btn" data-view="board" aria-pressed="true" onclick="setBoardView('board', event)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="2.5" width="4.5" height="11" rx="1.2"/><rect x="9.5" y="2.5" width="4.5" height="7" rx="1.2"/></svg><span>Board</span></button>
            <button type="button" class="seg-btn" data-view="list" aria-pressed="false" onclick="setBoardView('list', event)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg><span>List</span></button>
          </div>
        </div>
      </div>
      <dialog id="lifecycle-dialog" class="lifecycle-dialog" aria-labelledby="lifecycle-title">
        <form method="dialog" onsubmit="saveLifecycle(event)" oninput="armLifecycleSave(null)">
          <h3 id="lifecycle-title">Session lifecycle</h3>
          <p class="lc-note"><span id="lifecycle-scope">이 인스턴스</span>에만 적용되고, 다음 정리 주기(최대 5분)부터 반영됩니다. 값을 줄이면 그 기준을 넘긴 세션이 바로 Sleeping이 되거나 종료됩니다 — 저장 전에 몇 개인지 알려 줍니다. Sleeping 전환이 12시간 이하이면 12시간 전 확인 알림은 보내지 않습니다.</p>
          <label>마지막 활동 후 Sleeping 전환 <span class="lc-unit">시간</span><input id="lc-sleepAfterHours" type="number" min="1" max="720" step="any" required></label>
          <label>Sleeping 후 Archive(종료) 전환 <span class="lc-unit">일</span><input id="lc-archiveAfterDays" type="number" min="0.05" max="365" step="any" required></label>
          <label>보드에 Archive 표시 기간 <span class="lc-unit">시간</span><input id="lc-boardArchiveWindowHours" type="number" min="0" max="8760" step="any" required></label>
          <p class="lc-status" id="lifecycle-status" role="status" aria-live="polite"></p>
          <div class="lc-actions">
            <button type="button" class="archives-btn" onclick="closeLifecycleDialog()">취소</button>
            <button type="submit" class="archives-btn lc-save" id="lifecycle-save">저장</button>
          </div>
        </form>
      </dialog>
      <div class="kanban" id="kanban" data-view="board">
        <div class="kanban-col" id="col-waiting" data-col="waiting">
          <div class="kanban-col-header"><span class="col-spark" aria-hidden="true"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7 1.5c.5 3.3 2.2 5 5.5 5.5-3.3.5-5 2.2-5.5 5.5C6.5 9.2 4.8 7.5 1.5 7c3.3-.5 5-2.2 5.5-5.5z"/><circle cx="13" cy="12.6" r="1.3"/></svg></span><h3>NEEDS YOU</h3><span class="count" id="count-waiting">0</span></div>
          <div class="cards" id="cards-waiting"></div>
          <div class="col-empty" id="empty-waiting">Nothing here</div>
        </div>
        <div class="kanban-col" id="col-working" data-col="working">
          <div class="kanban-col-header"><span class="col-spark" aria-hidden="true"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7 1.5c.5 3.3 2.2 5 5.5 5.5-3.3.5-5 2.2-5.5 5.5C6.5 9.2 4.8 7.5 1.5 7c3.3-.5 5-2.2 5.5-5.5z"/><circle cx="13" cy="12.6" r="1.3"/></svg></span><h3>RUNNING</h3><span class="count" id="count-working">0</span></div>
          <div class="cards" id="cards-working"></div>
          <div class="col-empty" id="empty-working">Nothing here</div>
        </div>
        <div class="kanban-col" id="col-done" data-col="done">
          <div class="kanban-col-header"><span class="col-spark" aria-hidden="true"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7 1.5c.5 3.3 2.2 5 5.5 5.5-3.3.5-5 2.2-5.5 5.5C6.5 9.2 4.8 7.5 1.5 7c3.3-.5 5-2.2 5.5-5.5z"/><circle cx="13" cy="12.6" r="1.3"/></svg></span><h3>DONE</h3><span class="count" id="count-done">0</span></div>
          <div class="cards" id="cards-done"></div>
          <div class="col-empty" id="empty-done">Nothing here</div>
          <div class="col-foot" id="foot-done"></div>
        </div>
      </div>
    </section>
  </div>

  <!-- Slide Panel for Session Detail -->
  <div class="slide-panel-overlay" id="panel-overlay" onclick="closePanel()"></div>
  <div class="slide-panel" id="slide-panel">
    <div class="panel-resize-handle" id="panel-resize-handle"></div>
    <div class="panel-header">
      <div style="flex:1;min-width:0">
        <h3 id="panel-title">Session Detail</h3>
        <div id="panel-title-sub" style="font-size:11px;color:var(--text-secondary);margin-top:2px;display:flex;align-items:center;gap:6px">
          <span id="panel-title-sub-text"></span>
          <button id="panel-title-sub-regen" class="btn-action" style="font-size:10px;padding:1px 6px;display:none" onclick="event.stopPropagation();generateTitleSub(panelConvId)">&#x1F504;</button>
        </div>
      </div>
      <button class="panel-close" onclick="closePanel()">&#x2715;</button>
    </div>
    <div class="panel-controls" id="panel-controls" aria-label="이 세션의 모델과 effort"></div>
    <div class="panel-meta" id="panel-meta"></div>
    <div class="panel-links" id="panel-links"></div>
    <div class="panel-tokens" id="panel-tokens"></div>
    <!-- Tasks are pinned (.prd/10 §3.1-6): always shown, never scrolled away. -->
    <div class="panel-tasks" id="panel-tasks"></div>
    <!-- Scroll area: question + work log (collapsed unless opened from 작업 로그) + turns. -->
    <div class="panel-scroll" id="panel-scroll">
      <div class="panel-question" id="panel-question" style="display:none"></div>
      <div class="panel-worklog" id="panel-worklog" style="display:none">
        <button type="button" class="panel-worklog-header" id="worklog-toggle" aria-expanded="false" aria-controls="worklog-list" onclick="toggleWorkLogSection()"><span>작업 로그</span><span class="wl-count" id="worklog-count"></span><svg class="wl-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
        <div class="worklog-list" id="worklog-list" role="log" aria-live="polite" aria-label="작업 로그" hidden></div>
      </div>
      <div class="panel-turns" id="panel-turns">
        <p style="color:var(--text-secondary);text-align:center;margin-top:40px">Click a session card to view details</p>
      </div>
    </div>
    <!-- Command row is always visible; disabled + hint for terminated sessions. -->
    <div class="panel-command" id="panel-command">
      <div class="cmd-hint" id="cmd-hint" style="display:none">&#xC774; &#xC138;&#xC158;&#xC740; &#xC885;&#xB8CC;&#xB418;&#xC5C8;&#xC2B5;&#xB2C8;&#xB2E4; &mdash; &#xBA54;&#xC2DC;&#xC9C0;&#xB97C; &#xBCF4;&#xB0BC; &#xC218; &#xC5C6;&#xC2B5;&#xB2C8;&#xB2E4;</div>
      <div class="panel-command-row">
        <input type="text" id="cmd-input" placeholder="Send message to session..." onkeydown="if(event.key==='Enter')sendCommand()">
        <button class="btn-send" id="cmd-send" onclick="sendCommand()">Send</button>
      </div>
    </div>
  </div>
</div>

<script>
const INIT_USER = ${initUser};
// #814 — name of the dashboard's *home* instance (the one that served this
// HTML). Used by renderCard() to detect sibling cards and suppress action
// buttons that would post to the wrong instance. null when single-instance
// (no env wired) or pre-listen tests; the suppression check tolerates null.
const SELF_INSTANCE_NAME = ${initSelfInstance};
// ui.dashboardheader (config.json#ui) — resolved card-header line composition.
// renderCard() consults this to decide which sub-blocks to emit and with
// what limits. Fields absent from the lines are hidden (isFieldVisible
// semantics on the server side).
const DASHBOARD_HEADER_CONFIG = ${initDashboardHeaderConfig};
// SSOT 2026-10-22 T4: [{ nickname, model, label, contextWindow, autoCompactTokens }]
const REPRESENTATIVE_MODELS = ${initRepresentativeModels};
const EFFORT_LEVELS = ${initEffortLevels};
// field → first config entry map (show/max/truncate lookups in renderCard).
const _dhFieldMap = {};
for (const _dhLine of DASHBOARD_HEADER_CONFIG) {
  for (const _dhField of (_dhLine.fields || [])) {
    if (!(_dhField.field in _dhFieldMap)) _dhFieldMap[_dhField.field] = _dhField;
  }
}
function dhShow(field) {
  const f = _dhFieldMap[field];
  return !!f && f.show !== false;
}
function dhMax(field, fallback) {
  const f = _dhFieldMap[field];
  return (f && typeof f.max === 'number') ? f.max : fallback;
}
function dhTruncate(field) {
  const f = _dhFieldMap[field];
  return (f && typeof f.truncate === 'number') ? f.truncate : null;
}
let currentUserId = INIT_USER || '';
// Displayed + placeholder copy when a non-owner views a session. Kept here so
// wording edits only touch one place instead of four button sites + panel.
const READ_ONLY_MSG = 'Read-only — not your session';
let currentPeriod = 'day';
let ws = null;
let panelOpen = false;
let panelSessionKey = null;
let panelConvId = null;
let _panelTasksExpanded = false;

// ── Theme toggle — sun/moon ──
function getPreferredTheme() {
  var saved = localStorage.getItem('soma-theme');
  if (saved) return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  var btn = document.getElementById('theme-toggle');
  if (btn) btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
}
function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  var osTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  if (next === osTheme) {
    localStorage.removeItem('soma-theme');
  } else {
    localStorage.setItem('soma-theme', next);
  }
  applyTheme(next);
}
// Sync icon on load
applyTheme(getPreferredTheme());
// Listen for OS theme changes (if user hasn't manually chosen)
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function(e) {
  if (!localStorage.getItem('soma-theme')) {
    applyTheme(e.matches ? 'light' : 'dark');
  }
});

// ── Panel resize — drag left edge to change width ──
(function initPanelResize() {
  var panel = document.getElementById('slide-panel');
  var handle = document.getElementById('panel-resize-handle');
  var STORAGE_KEY = 'soma-panel-width';
  var MIN_W = 320, MAX_W_PCT = 0.8;

  // Restore saved width
  var saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    var w = parseInt(saved, 10);
    if (w >= MIN_W && w <= window.innerWidth * MAX_W_PCT) {
      panel.style.width = w + 'px';
      panel.style.right = '-' + w + 'px';
    }
  }

  var dragging = false;
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    dragging = true;
    panel.classList.add('resizing');
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    var maxW = window.innerWidth * MAX_W_PCT;
    var newW = window.innerWidth - e.clientX;
    if (newW < MIN_W) newW = MIN_W;
    if (newW > maxW) newW = maxW;
    panel.style.width = newW + 'px';
    if (panel.classList.contains('open')) {
      panel.style.right = '0';
    } else {
      panel.style.right = '-' + newW + 'px';
    }
  });
  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('resizing');
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    var w = parseInt(panel.style.width, 10);
    if (w >= MIN_W) localStorage.setItem(STORAGE_KEY, String(w));
  });

  // Patch openPanel/closePanel to use current width
  var origRightHidden = panel.style.right;
  var _origOpen = panel.classList.contains('open');
  // Override slide-panel right offset on open
  var observer = new MutationObserver(function() {
    if (panel.classList.contains('open')) {
      panel.style.right = '0';
    } else if (!dragging) {
      panel.style.right = '-' + (panel.style.width || '440px');
    }
  });
  observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
})();

// ── Panel tasks rendering ──
function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  var sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ' + (sec % 60) + 's';
  var hr = Math.floor(min / 60);
  return hr + 'h ' + (min % 60) + 'm';
}

function formatTaskTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function renderPanelQuestion(s) {
  var container = document.getElementById('panel-question');
  if (!container) return;
  if (!s || !s.pendingQuestion || s.activityState !== 'waiting') {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = '';
  var q = s.pendingQuestion;

  if (q.type === 'user_choice' && q.choices) {
    var pnlRecId = resolveRecommendedId(q.recommendedChoiceId, q.choices);
    var pnlRecOpt = pnlRecId ? q.choices.find(function(c) { return c.id === pnlRecId; }) : null;
    var pnlOthers = q.choices.filter(function(c) { return !pnlRecOpt || c.id !== pnlRecOpt.id; });
    var pnlRecHtml = '';
    if (pnlRecOpt) {
      var recLbl = stripRecommendedMarker(pnlRecOpt.label);
      pnlRecHtml = '<div class="choice-row-recommended">'
        + '<button class="btn-choice btn-choice-recommended"' + choiceDataAttrs(s.key, pnlRecOpt.id, recLbl, q.question) + '>' + esc(pnlRecOpt.id) + '. ' + esc(recLbl) + (pnlRecOpt.description ? ' <span style="color:var(--text-tertiary);font-size:0.9em">&mdash; ' + esc(pnlRecOpt.description) + '</span>' : '') + '</button>'
        + '</div>'
        + (pnlOthers.length > 0 ? '<hr class="choice-divider">' : '');
    }
    var pnlOtherBtns = pnlOthers.map(function(c) {
      var lbl2 = stripRecommendedMarker(c.label);
      return '<button class="btn-choice"' + choiceDataAttrs(s.key, c.id, lbl2, q.question) + '>' + esc(c.id) + '. ' + esc(lbl2) + (c.description ? ' <span style="color:var(--text-tertiary);font-size:0.9em">&mdash; ' + esc(c.description) + '</span>' : '') + '</button>';
    }).join('');
    container.innerHTML = '<div class="panel-question-text">&#x2753; ' + esc(q.question) + '</div>'
      + '<div class="panel-question-choices">' + pnlRecHtml + pnlOtherBtns + '</div>';
  } else if (q.type === 'user_choices' && q.questions) {
    renderMultiChoicePanel(s);
    return;
  } else {
    container.style.display = 'none';
  }
}

// Pinned Tasks block (.prd/10 §3.1-6): always rendered — with no tasks yet it
// says so instead of disappearing.
function renderPanelTasks(tasks) {
  var container = document.getElementById('panel-tasks');
  if (!container) return;
  container.style.display = '';
  if (!tasks || tasks.length === 0) {
    container.innerHTML = '<div class="panel-tasks-header"><span>Tasks</span></div><div class="panel-tasks-empty">아직 작업 목록이 없습니다</div>';
    return;
  }

  // Sort: in_progress → pending → completed
  var inProgress = tasks.filter(function(t) { return t.status === 'in_progress'; });
  var pending = tasks.filter(function(t) { return t.status === 'pending'; });
  var completed = tasks.filter(function(t) { return t.status === 'completed'; });

  var total = tasks.length;
  var doneCount = completed.length;
  var pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  var html = '<div class="panel-tasks-header">'
    + '<span>Tasks</span>'
    + '<span class="tasks-progress">' + doneCount + '/' + total + ' (' + pct + '%)</span>'
    + '</div>';

  // Active + pending — always shown
  var active = inProgress.concat(pending);
  for (var i = 0; i < active.length; i++) {
    html += renderPanelTaskItem(active[i]);
  }

  // Completed — show first 3, rest behind toggle
  var COMPLETED_LIMIT = 3;
  var visibleCompleted = _panelTasksExpanded ? completed : completed.slice(0, COMPLETED_LIMIT);
  var hiddenCount = completed.length - COMPLETED_LIMIT;

  for (var j = 0; j < visibleCompleted.length; j++) {
    html += renderPanelTaskItem(visibleCompleted[j]);
  }

  if (hiddenCount > 0) {
    if (_panelTasksExpanded) {
      html += '<button class="panel-tasks-toggle" onclick="_panelTasksExpanded=false;renderPanelTasks(_sessionCache[panelSessionKey]&&_sessionCache[panelSessionKey].tasks)">&#x25B2; Hide completed</button>';
    } else {
      html += '<button class="panel-tasks-toggle" onclick="_panelTasksExpanded=true;renderPanelTasks(_sessionCache[panelSessionKey]&&_sessionCache[panelSessionKey].tasks)">&#x25BC; Show ' + hiddenCount + ' more completed</button>';
    }
  }

  container.innerHTML = html;
}

function renderPanelTaskItem(t) {
  var icon, cls;
  if (t.status === 'completed') { icon = '&#x2705;'; cls = 'completed'; }
  else if (t.status === 'in_progress') { icon = '<span class="spin">&#x1F504;</span>'; cls = 'in_progress'; }
  else { icon = '&#x25CB;'; cls = 'pending'; }

  var timeInfo = '';
  if (t.status === 'completed' && t.startedAt && t.completedAt) {
    var dur = t.completedAt - t.startedAt;
    timeInfo = formatDuration(dur);
  } else if (t.status === 'in_progress' && t.startedAt) {
    var elapsed = Date.now() - t.startedAt;
    timeInfo = formatDuration(elapsed) + '...';
  }
  // SSOT 2026-10-22 T7: tool calls made while the task ran.
  if (t.status !== 'pending' && t.toolCalls !== undefined) {
    timeInfo = (timeInfo ? timeInfo + ' · ' : '') + '툴 ' + toNum(t.toolCalls) + '회';
  }

  var timeHtml = '';
  if (t.startedAt || t.completedAt) {
    var parts = [];
    if (t.startedAt) parts.push(formatTaskTime(t.startedAt));
    if (t.completedAt) parts.push(formatTaskTime(t.completedAt));
    timeHtml = '<div class="task-time" title="' + parts.join(' → ') + '">' + (timeInfo || parts.join('→')) + '</div>';
  }

  if (!timeHtml && timeInfo) timeHtml = '<div class="task-time">' + timeInfo + '</div>';
  return '<div class="panel-task-item ' + cls + '">'
    + '<span class="task-icon">' + icon + '</span>'
    + (t.id ? '<span class="task-id">#' + esc(t.id) + '</span>' : '')
    + '<span class="task-text">' + esc(t.content) + '</span>'
    + timeHtml
    + '</div>';
}
let _csrfToken = '';

/*
 * Populate the "Logged in as <name>" pill in the topbar.
 *
 * Rendered from /auth/me for three session types:
 *   - OAuth JWT (Google/Microsoft/Slack SSO) — shows user.name.
 *   - bearer_cookie (admin viewer token) — shows "Admin" with a star marker.
 *   - unauthenticated (/auth/me → 401) — pill stays hidden; auth middleware
 *     is about to redirect us to /login anyway.
 *
 * The pill is a link to /login, which for a signed-in browser is the account
 * page: who you are signed in as, continue, use a different account, or sign
 * out (GET /auth/logout).
 */
function _applyUserPill(data) {
  const pill = document.getElementById('user-pill');
  const nameEl = document.getElementById('user-pill-name');
  if (!pill || !nameEl) return;
  let label = '';
  let isAdmin = false;
  if (data && data.user && data.user.name) {
    label = data.user.name;
  } else if (data && data.isAdmin) {
    label = 'Admin';
    isAdmin = true;
  }
  if (!label) {
    pill.style.display = 'none';
    return;
  }
  nameEl.textContent = label;
  nameEl.title = label; // the name may end in an ellipsis
  pill.style.display = 'inline-flex';
  pill.classList.toggle('is-admin', isAdmin);

  // #716: admin-mode toggle visibility. Only ADMIN_USERS members see
  // the button; clicking it stores soma_admin_mode in localStorage and
  // _adminFetch attaches X-Admin-Mode: <on|off> to every API call.
  // Bearer-cookie admin (viewer token) is treated as always-admin and
  // also gets the toggle.
  const isAdminCapable = !!(data && (data.isAdmin || (data.user && data.user.name && data.isAdmin)));
  const lifecycleBtn = document.getElementById('lifecycle-btn');
  if (lifecycleBtn) lifecycleBtn.style.display = isAdminCapable ? 'inline-flex' : 'none';
  const toggle = document.getElementById('admin-mode-toggle');
  if (toggle) {
    if (isAdminCapable) {
      toggle.style.display = 'inline-flex';
      _renderAdminModeButton();
    } else {
      toggle.style.display = 'none';
      // Non-admin must NEVER ship X-Admin-Mode: on. Force-clear stored mode.
      try { localStorage.removeItem('soma_admin_mode'); } catch(_e) {}
    }
  }
}

// Admin mode (#716)
//
// Client-side safe-mode flag. The button only appears for users in
// ADMIN_USERS (server reports isAdmin:true on /auth/me). When ON,
// the dashboard sends X-Admin-Mode: on with every state-mutating
// request, which the server cross-checks against isAdminUser(sub)
// before allowing a write to a session the user does not own.
//
// Toggling OFF does NOT remove ADMIN_USERS membership; it just makes
// the session behave like a normal user (own-session writes only).
// This protects against accidental cross-user clicks during routine
// browsing.
function _isAdminModeOn() {
  try { return localStorage.getItem('soma_admin_mode') === 'on'; } catch(_e) { return false; }
}
function _setAdminMode(on) {
  try { localStorage.setItem('soma_admin_mode', on ? 'on' : 'off'); } catch(_e) {}
}
function _renderAdminModeButton() {
  const btn = document.getElementById('admin-mode-toggle');
  const lbl = document.getElementById('admin-mode-label');
  if (!btn || !lbl) return;
  const on = _isAdminModeOn();
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  // Prefer split-span structure (prefix + state): only the ON/OFF state is
  // rewritten, the "Admin: " prefix stays as rendered. Falls back to flat
  // textContent if the spans haven't been rendered yet (e.g. legacy
  // template / unit test setup).
  const stateEl = lbl.querySelector('.admin-mode-state');
  if (stateEl) stateEl.textContent = on ? 'ON' : 'OFF';
  else lbl.textContent = on ? 'Admin: ON' : 'Admin: OFF';
}
function toggleAdminMode() {
  _setAdminMode(!_isAdminModeOn());
  _renderAdminModeButton();
}

// #716: monkey-patch fetch ONCE at boot so every state-mutating request
// (POST/PUT/PATCH/DELETE) carries X-Admin-Mode: <on|off> from
// localStorage. The server cross-checks against ADMIN_USERS membership
// on the verified JWT; non-admins shipping "on" are rejected
// regardless. We do not touch GET requests because reads are
// world-readable for any authenticated user under the new policy.
(function _installAdminModeFetch() {
  if (typeof window === 'undefined' || !window.fetch) return;
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    try {
      const method = (init && init.method ? String(init.method) : (input && input.method) || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const mode = _isAdminModeOn() ? 'on' : 'off';
        const headers = new Headers((init && init.headers) || (input && input.headers) || {});
        // Don't clobber an explicit caller-set value.
        if (!headers.has('X-Admin-Mode')) headers.set('X-Admin-Mode', mode);
        const next = Object.assign({}, init || {}, { headers });
        return origFetch(input, next);
      }
    } catch (_e) {
      // fall through to origFetch on any unexpected shape
    }
    return origFetch(input, init);
  };
})();

// Fetch CSRF token (reusable — called on load and after JWT rotation invalidates token)
async function refreshCsrfToken() {
  try {
    const res = await fetch('/auth/me');
    if (res.ok) {
      const data = await res.json();
      _csrfToken = data.csrfToken || '';
      _applyUserPill(data);
    }
  } catch {}
}
refreshCsrfToken();

// ── Top bar: the owner's default model / effort (SSOT 2026-10-23 T6) ──
// One click opens a menu; picking saves the default at once (PATCH
// /api/settings/:key — the same path as Slack "model set" / "effort"). When the
// owner has a session panel open, "이 세션에도 적용" (on by default) also
// switches that session, like Slack's bare "effort <level>" applies to the
// current thread. Hidden when there is no signed-in Slack user (viewer token).
var _myDefaults = null; // { model: settingRow, effort: settingRow }
var _tdMenuKind = null;
async function loadMyDefaults() {
  var box = document.getElementById('topbar-defaults');
  if (!box) return;
  try {
    var res = await fetch('/api/settings');
    if (!res.ok) { box.hidden = true; return; }
    var data = await res.json();
    // Without admin acceptance the server refuses every settings write.
    if (data && data.accepted === false) { box.hidden = true; return; }
    var rows = (data && data.settings) || [];
    var model = null, effort = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === 'defaultModel') model = rows[i];
      if (rows[i].key === 'defaultEffort') effort = rows[i];
    }
    if (!model || !effort) { box.hidden = true; return; }
    _myDefaults = { model: model, effort: effort };
    renderDefaultsChips();
    box.hidden = false;
  } catch (_e) { box.hidden = true; }
}
function optionLabel(row, value) {
  var opts = (row && row.options) || [];
  for (var i = 0; i < opts.length; i++) if (opts[i].value === value) return opts[i].label;
  return String(value || '');
}
function renderDefaultsChips() {
  if (!_myDefaults) return;
  var m = document.getElementById('td-model-value');
  var e = document.getElementById('td-effort-value');
  if (m) m.textContent = optionLabel(_myDefaults.model, _myDefaults.model.value);
  if (e) e.textContent = optionLabel(_myDefaults.effort, _myDefaults.effort.value);
}
// The session model switch takes representative nicknames only.
function sessionAcceptsModel(value) {
  var models = REPRESENTATIVE_MODELS || [];
  for (var i = 0; i < models.length; i++) if (models[i].nickname === value) return true;
  return false;
}
// The open session the owner may switch together with the default, or null.
function defaultsScopeSession() {
  if (!panelOpen || !panelSessionKey) return null;
  var s = _sessionCache[panelSessionKey];
  if (!s || !s.ownerId || s.ownerId !== currentUserId || s.terminated || isSiblingSession(s)) return null;
  return s;
}
function renderDefaultsMenu(kind) {
  var row = _myDefaults && (kind === 'model' ? _myDefaults.model : _myDefaults.effort);
  if (!row) return '';
  var html = '<div class="tdm-head">' + (kind === 'model' ? '새 세션 기본 모델' : '새 세션 기본 effort') + '</div>';
  var opts = row.options || [];
  for (var i = 0; i < opts.length; i++) {
    var o = opts[i];
    var on = o.value === row.value;
    html += '<button type="button" role="menuitemradio" class="tdm-item" aria-checked="' + (on ? 'true' : 'false') + '"'
      + ' data-td-kind="' + escAttr(kind) + '" data-td-value="' + escAttr(o.value) + '" onclick="pickDefaultFrom(this)">'
      + '<span>' + esc(o.label) + (o.description && kind === 'model' ? ' <span class="tdm-sub">' + esc(o.description) + '</span>' : '') + '</span></button>';
  }
  var s = defaultsScopeSession();
  if (s) {
    html += '<label class="tdm-scope"><input type="checkbox" id="tdm-also-session" checked>'
      + '<span>열린 세션에도 적용 &mdash; ' + esc(s.displayHeadline || s.title || s.key) + '</span></label>';
  }
  return html;
}
function openDefaultsMenu(kind, btn) {
  var menu = document.getElementById('td-menu');
  if (!menu || !_myDefaults) return;
  if (!menu.hidden && _tdMenuKind === kind) { closeDefaultsMenu(); return; }
  _tdMenuKind = kind;
  menu.innerHTML = renderDefaultsMenu(kind);
  menu.style.left = btn ? btn.offsetLeft + 'px' : '0';
  menu.hidden = false;
  var chips = document.querySelectorAll('.td-chip');
  for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-expanded', chips[i] === btn ? 'true' : 'false');
  var first = menu.querySelector('.tdm-item[aria-checked="true"]') || menu.querySelector('.tdm-item');
  if (first) first.focus();
}
function closeDefaultsMenu() {
  var menu = document.getElementById('td-menu');
  if (menu) menu.hidden = true;
  _tdMenuKind = null;
  var chips = document.querySelectorAll('.td-chip');
  for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', function(ev) {
  var box = document.getElementById('topbar-defaults');
  if (_tdMenuKind && box && !box.contains(ev.target)) closeDefaultsMenu();
});
document.addEventListener('keydown', function(ev) {
  if (ev.key === 'Escape' && _tdMenuKind) {
    var chip = document.getElementById(_tdMenuKind === 'model' ? 'td-model' : 'td-effort');
    closeDefaultsMenu();
    if (chip) chip.focus();
  }
});
// Settings changed in Slack show up when the tab comes back.
document.addEventListener('visibilitychange', function() { if (!document.hidden) loadMyDefaults(); });
async function patchSetting(key, value) {
  var url = '/api/settings/' + encodeURIComponent(key);
  var body = JSON.stringify({ value: value });
  var headers = { 'Content-Type': 'application/json' };
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  var res = await fetch(url, { method: 'PATCH', headers: headers, body: body });
  if (res.status === 403) {
    await refreshCsrfToken();
    var retryHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
    res = await fetch(url, { method: 'PATCH', headers: retryHeaders, body: body });
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  return { ok: res.ok, setting: data && data.setting, error: (data && data.error) || ('HTTP ' + res.status) };
}
function setDefaultsStatus(text, isError) {
  var el = document.getElementById('td-status');
  if (!el) return;
  el.textContent = text || '';
  el.title = text || '';
  el.classList.toggle('is-error', !!isError);
}
// Option values travel in attribute-escaped data-* (never inside inline JS).
function pickDefaultFrom(el) {
  return pickDefault(el.getAttribute('data-td-kind'), el.getAttribute('data-td-value'));
}
async function pickDefault(kind, value) {
  var also = document.getElementById('tdm-also-session');
  var session = also && also.checked ? defaultsScopeSession() : null;
  var skipSession = !!session && kind === 'model' && !sessionAcceptsModel(value);
  if (skipSession) session = null;
  closeDefaultsMenu();
  var key = kind === 'model' ? 'defaultModel' : 'defaultEffort';
  setDefaultsStatus('저장 중…', false);
  var r;
  try { r = await patchSetting(key, value); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  if (!r.ok) { setDefaultsStatus('저장하지 못했습니다: ' + r.error, true); return; }
  _myDefaults[kind] = r.setting;
  renderDefaultsChips();
  var msg = '기본 ' + (kind === 'model' ? '모델' : 'effort') + ' → ' + optionLabel(r.setting, r.setting.value) + ' (새 세션부터)';
  if (skipSession) msg += ' · 이 모델은 세션 전환 목록에 없어 열린 세션은 그대로';
  if (session) {
    var sr;
    try {
      sr = kind === 'model' ? await postModelSwitch(session.key, value) : await postEffortSwitch(session.key, value);
    } catch (e) { sr = { ok: false, error: String(e && e.message || e) }; }
    _modelNotes[session.key] = kind === 'model' ? modelSwitchNote(sr) : effortSwitchNote(sr);
    msg += sr.ok ? ' · 열린 세션에도 적용' : ' · 열린 세션은 바꾸지 못함: ' + sr.error;
    refreshCard(session.key);
    loadSessions();
  }
  setDefaultsStatus(msg, false);
}
loadMyDefaults();

// ── Utility ──
function decodeSlackEntities(s) {
  return (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// Pure (no DOM) so the escaping can be exercised outside a browser. Same &, <, >
// output the textContent→innerHTML round-trip gave, plus " so a value can never
// close the attribute it is placed in. ' stays literal: escJs() relies on that.
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Pending-question choice buttons carry their values as attribute-escaped data
// attributes (read back through dataset by one delegated click handler), so a
// model-written question or label with quotes, backslashes, < or newlines can
// neither break nor extend the markup the way an inline JS string could.
function choiceDataAttrs(key, id, label, question) {
  return ' data-choice-key="' + escAttr(key) + '" data-choice-id="' + escAttr(id)
    + '" data-choice-label="' + escAttr(label) + '" data-choice-question="' + escAttr(question) + '"';
}
document.addEventListener('click', function(e) {
  var btn = e.target && e.target.closest ? e.target.closest('button[data-choice-id]') : null;
  if (!btn || btn.disabled) return;
  var d = btn.dataset;
  if (d.mcIndex !== undefined) selectMc(d.choiceKey, Number(d.mcIndex), d.choiceId, d.choiceLabel);
  else answerChoice(d.choiceKey, d.choiceId, d.choiceLabel, d.choiceQuestion, btn);
});
// Only http(s) URLs become links; anything else (javascript:, data:) is inert.
function safeHref(u) {
  return /^https?:\\/\\//i.test(String(u || '')) ? escAttr(u) : '#';
}
function escJs(s) {
  return esc(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}
// Strip trailing "(Recommended · N/M)" or "(Recommended)" from a label for display.
function stripRecommendedMarker(label) {
  return (label || '').replace(/\\s*\\(Recommended(?:\\s*·[^)]*)?\\)\\s*$/i, '').trim();
}
// Resolve recommended choiceId: explicit first, else legacy label scan.
// Matches trailing "(Recommended)" / "(Recommended · N/M)" only — mirrors
// LEGACY_RECOMMENDED_SUFFIX_RE in somalib/model-commands/validator.ts. Kept
// duplicated because dashboard CSS/JS is a server-rendered string bundle, not
// an import graph.
function resolveRecommendedId(explicitId, options) {
  if (explicitId && (options || []).some(function(o) { return o.id === explicitId; })) return explicitId;
  var legacy = (options || []).find(function(o) { return /\\(Recommended(?:\\s*·\\s*\\d+\\/\\d+)?\\)\\s*$/i.test(o.label || ''); });
  return legacy ? legacy.id : null;
}
async function resummarize(convId, turnId, btn) {
  btn.disabled = true;
  btn.textContent = 'Retrying...';
  try {
    const res = await fetch('/api/dashboard/session/' + encodeURIComponent(convId) + '/resummarize/' + encodeURIComponent(turnId), { method: 'POST' });
    if (!res.ok) throw new Error('Failed');
    btn.textContent = 'Queued \u2713';
  } catch(e) {
    btn.disabled = false;
    btn.textContent = '\uD83D\uDD04 Retry';
  }
}
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
  return Math.floor(ms / 86400000) + 'd ago';
}
// A finite number or 0 — numeric fields pass through this before they reach markup.
function toNum(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}
// Compact token count: 999 · 1.5K · 2.5M · 3.1B · 4.2T. The unit is chosen
// after rounding (never "1000.0K"); a negative or non-number is 0, and anything
// that would round to 1000.0T or more (from 999.95T) is capped at 999.9T+ so an
// absurd value cannot print an exponent.
function formatTokens(n) {
  n = Math.max(0, toNum(n));
  if (n < 999.5) return String(Math.round(n));
  var units = ['K', 'M', 'B', 'T'];
  for (var i = 0; i < units.length; i++) {
    n /= 1000;
    if (n < 999.95) return n.toFixed(1) + units[i];
  }
  return '999.9T+';
}
// ── Live usage on the collapsed face (SSOT 2026-10-22 T1/T2) ──
// The session total of every token its API calls processed — input, output,
// cache read and cache write — the same tokens its API-equivalent cost is
// computed from. The server folds the running turn's usage in, so the numbers
// grow during a turn, not only when it ends.
function cardTotalTokens(u) {
  if (!u) return 0;
  return toNum(u.totalInputTokens) + toNum(u.totalOutputTokens) + toNum(u.totalCacheReadTokens) + toNum(u.totalCacheCreateTokens);
}
// Full digits for tokens (a count-up should visibly count), dollars for cost.
function formatCount(kind, v) {
  v = Math.max(0, toNum(v));
  if (kind === 'cost') return '$' + v.toFixed(2);
  return Math.round(v).toLocaleString('en-US');
}
// Count-up (§4 motion tokens: ease-out). Each card number remembers what it
// shows across face re-renders ("<card key>|<kind>"); a higher value counts up
// from there, a new value mid-count continues from the number on screen. The
// first paint, a lower value, background tabs and reduced motion set the value
// at once.
var COUNT_UP_MS = 900;
var _counters = Object.create(null); // "<card key>|<kind>" → { shown, raf, el }
function countUpValue(from, to, p) {
  var e = 1 - Math.pow(1 - p, 3);
  return p >= 1 ? to : from + (to - from) * e;
}
function startCountUp(el, id) {
  var kind = el.getAttribute('data-cnt');
  var to = toNum(el.getAttribute('data-to'));
  var c = _counters[id];
  if (!c) { _counters[id] = { shown: to, raf: 0, el: el }; return; }
  c.el = el;
  if (c.raf) { cancelAnimationFrame(c.raf); c.raf = 0; }
  var from = c.shown;
  if (from === to || to < from || !canAnimate() || reduceMotion()) {
    c.shown = to;
    el.textContent = formatCount(kind, to);
    return;
  }
  el.textContent = formatCount(kind, from);
  var t0 = performance.now();
  function step(now) {
    var p = Math.min(1, (now - t0) / COUNT_UP_MS);
    c.shown = countUpValue(from, to, p);
    c.el.textContent = formatCount(kind, c.shown);
    c.raf = p < 1 ? requestAnimationFrame(step) : 0;
  }
  c.raf = requestAnimationFrame(step);
}
function animateCountersIn(root, key) {
  var els = root.querySelectorAll('.cnt');
  for (var i = 0; i < els.length; i++) startCountUp(els[i], key + '|' + els[i].getAttribute('data-cnt'));
}
function dropCounters(key) {
  ['tok', 'cost'].forEach(function(kind) {
    var c = _counters[key + '|' + kind];
    if (c && c.raf) cancelAnimationFrame(c.raf);
    delete _counters[key + '|' + kind];
  });
}
// Dashboard v2.1 — \`Nm SSs\` for the 1s live tick. Mirrors packages/common/src/format/duration.ts.
function formatNmSSs(ms) {
  if (!ms || ms < 0 || isNaN(ms)) return '0m 00s';
  var totalSec = Math.floor(ms / 1000);
  var m = Math.floor(totalSec / 60);
  var s = totalSec % 60;
  return m + 'm ' + (s < 10 ? '0' + s : s) + 's';
}
// 1-Hz tick: fill every time-dependent text from its data-* attrs.
// Runs unconditionally of WS state — WS feeds new data-* values, tick reads them.
// Card HTML never embeds Date.now(): the reconciler compares rendered strings,
// so a clock in the markup would make every poll look like a change.
//   .card-timer-live  data-leg-started / data-accumulated (renderCardStatus)
//   .rel-time         data-ts  → "6m ago"
//   .task-elapsed     data-since → running task duration
function updateTimersIn(root) {
  var now = Date.now();
  var els = root.querySelectorAll('.card-timer-live');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var started = Number(el.dataset.legStarted) || 0;
    var accumulated = Number(el.dataset.accumulated) || 0;
    var elapsed = (started ? now - started : 0) + accumulated;
    var t = formatNmSSs(elapsed);
    if (el.textContent !== t) el.textContent = t;
  }
  var rel = root.querySelectorAll('.rel-time');
  for (var j = 0; j < rel.length; j++) {
    var r = timeAgo(Number(rel[j].dataset.ts) || 0);
    if (rel[j].textContent !== r) rel[j].textContent = r;
  }
  var run = root.querySelectorAll('.task-elapsed');
  for (var k = 0; k < run.length; k++) {
    var d = formatDuration(now - (Number(run[k].dataset.since) || now)) || '0s';
    if (run[k].textContent !== d) run[k].textContent = d;
  }
}
function updateTimers() { updateTimersIn(document); }
var _timerTick = setInterval(updateTimers, 1000);

// ── User list ──
async function loadUsers() {
  try {
    const res = await fetch('/api/dashboard/users');
    const data = await res.json();
    const select = document.getElementById('user-select');
    for (const u of data.users) {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name;
      if (u.id === currentUserId) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (e) { console.error('Failed to load users', e); }
  syncUserSelectLabel();
}

// The visible label over the transparent user <select> shows the selected
// option; the select's title keeps the full name when the label is ellipsized.
function syncUserSelectLabel() {
  const select = document.getElementById('user-select');
  const label = document.getElementById('user-select-label');
  if (!select || !label) return;
  const opt = select.options[select.selectedIndex];
  const text = opt ? opt.textContent : '';
  if (label.textContent !== text) label.textContent = text;
  select.title = text;
}

function selectUser(userId) {
  syncUserSelectLabel();
  currentUserId = userId;
  history.replaceState(null, '', userId ? '/dashboard/' + userId : '/dashboard');
  loadSessions();
  loadStats();
}

// ── Period ──
function setPeriod(period) {
  currentPeriod = period;
  document.querySelectorAll('.period-btn').forEach(function(b) {
    var on = b.dataset.period === period;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  loadStats();
}

// ── Stats strip 자세히 (.prd/10 §3.1-2) — the other cards + charts, collapsed
// unless the user opened them (localStorage['soma-stats-detail'] = 'open'). ──
var STATS_DETAIL_KEY = 'soma-stats-detail';
function setStatsDetail(open) {
  var btn = document.getElementById('stats-more');
  var detail = document.getElementById('stats-detail');
  if (!btn || !detail) return;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  detail.hidden = !open;
}
function toggleStatsDetail() {
  var open = document.getElementById('stats-more').getAttribute('aria-expanded') !== 'true';
  setStatsDetail(open);
  try { localStorage.setItem(STATS_DETAIL_KEY, open ? 'open' : 'closed'); } catch (_e) {}
}
(function initStatsDetail() {
  var saved = null;
  try { saved = localStorage.getItem(STATS_DETAIL_KEY); } catch (_e) {}
  setStatsDetail(saved === 'open');
})();

// ── Session cache ──
// Keyed by session key — prototype-free so any key string is just a key.
let _sessionCache = Object.create(null);

// ── Env badge helpers (#814) ──
// 4-color palette — kept in CSS-friendly order so the contrast against
// dark/light themes is decent for any of the four. Index = hash of
// instanceName mod 4. Two unrelated names hashing to the same slot is
// noise we can live with on a 4-instance host (operators rarely run more
// than 2-3 instances per box).
var ENV_BADGE_PALETTE = ['#5DADE2', '#48C9B0', '#F4D03F', '#EC7063'];

// _envIndex caches a deterministic palette-slot per instanceName so two
// envs sharing a hash bucket fall back to a "first-come, first-coloured"
// scheme based on the sorted set of envs in the current cache. Recomputed
// any time the cache changes (cleared in renderBoard).
var _envIndex = null;

function _hashStr(s) {
  // djb2 — small, deterministic, sufficient for a 4-bucket palette.
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function _buildEnvIndex() {
  var envs = Object.create(null);
  for (var k in _sessionCache) {
    var c = _sessionCache[k];
    if (c && c.environment && c.environment.instanceName) {
      envs[c.environment.instanceName] = true;
    }
  }
  var sorted = Object.keys(envs).sort();
  var assigned = Object.create(null);
  // First pass — try the hash bucket. If taken, mark conflict.
  var occupied = {};
  for (var i = 0; i < sorted.length; i++) {
    var name = sorted[i];
    var slot = _hashStr(name) % ENV_BADGE_PALETTE.length;
    if (!occupied[slot]) {
      assigned[name] = slot;
      occupied[slot] = name;
    } else {
      assigned[name] = -1; // mark for fallback pass
    }
  }
  // Second pass — fallback: walk sorted-order names that hashed into a
  // taken slot and assign the next free slot in palette order. This
  // keeps the assignment stable across renders so a card doesn't change
  // colour when an unrelated card is added.
  var nextSlot = 0;
  for (var j = 0; j < sorted.length; j++) {
    var name2 = sorted[j];
    if (assigned[name2] !== -1) continue;
    while (occupied[nextSlot] && nextSlot < ENV_BADGE_PALETTE.length) nextSlot++;
    if (nextSlot < ENV_BADGE_PALETTE.length) {
      assigned[name2] = nextSlot;
      occupied[nextSlot] = name2;
      nextSlot++;
    } else {
      // More envs than palette slots — wrap. Operators on a 5+ instance
      // host accept that two badges may collide on colour.
      assigned[name2] = _hashStr(name2) % ENV_BADGE_PALETTE.length;
    }
  }
  return assigned;
}

function getEnvBadgeColor(instanceName) {
  if (!_envIndex) _envIndex = _buildEnvIndex();
  var slot = _envIndex[instanceName];
  if (typeof slot !== 'number' || slot < 0) {
    slot = _hashStr(instanceName || '') % ENV_BADGE_PALETTE.length;
  }
  return ENV_BADGE_PALETTE[slot];
}

function _envCount() {
  if (!_envIndex) _envIndex = _buildEnvIndex();
  return Object.keys(_envIndex).length;
}

// ── Agent inbox board (.prd/10 §3.1, §4) ──
// NEEDS YOU = waiting · RUNNING = working · DONE = idle, then closed (SLEEPING +
// archives; archives behind the Archives toggle, sleeping cards behind the
// Sleeping toggle), filed under the day the work finished (T11/T12). The server
// buckets (KanbanBoard) are unchanged — only the client folds idle + closed
// into one column.
var BOARD_COLS = ['waiting', 'working', 'done'];
var SPARK_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7 1.5c.5 3.3 2.2 5 5.5 5.5-3.3.5-5 2.2-5.5 5.5C6.5 9.2 4.8 7.5 1.5 7c3.3-.5 5-2.2 5.5-5.5z"/><circle cx="13" cy="12.6" r="1.3"/></svg>';
var WAIT_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.8 15 14H1z"/></svg>';
var TASKS_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.2l1.4 1.4 2.4-2.6M2.5 10.2l1.4 1.4 2.4-2.6M9 4.5h4.5M9 10.5h4.5"/></svg>';
var CTX_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 8V2.4A5.6 5.6 0 0 1 13.6 8z" fill="currentColor" stroke="none"/></svg>';
var RESUME_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.3 1.5"/></svg>';

// Board state that survives re-renders — the DOM is reused, never rebuilt.
// Every dictionary keyed by a session key or conversation id is prototype-free,
// so a key such as "__proto__" or "constructor" is just a key.
var _cardEls = Object.create(null);  // session key → persistent card shell
var _expanded = new Set();           // keys whose card is open
var _boardRenders = 0;
var _ioCache = Object.create(null);  // conversationId → { state, stamp, data, dirty, fails, retryAt }

// Motion tokens come from the CSS custom properties so CSS transitions and
// WAAPI share one source of truth (§4 table).
var MOTION = (function readMotionTokens() {
  var cs = getComputedStyle(document.documentElement);
  function ms(name, fallback) { var v = parseFloat(cs.getPropertyValue(name)); return isNaN(v) ? fallback : v; }
  function str(name, fallback) { var v = cs.getPropertyValue(name).trim(); return v || fallback; }
  return {
    move: ms('--dur-move', 320),
    fade: ms('--dur-fade', 180),
    easeOut: str('--ease-out', 'cubic-bezier(0.23, 1, 0.32, 1)'),
    easeInOut: str('--ease-in-out', 'cubic-bezier(0.77, 0, 0.175, 1)'),
  };
})();
var _reducedMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
function reduceMotion() { return _reducedMotionMq.matches; }
// The first paint and background tabs never animate.
function canAnimate() {
  return _boardRenders > 0 && !document.hidden && typeof Element.prototype.animate === 'function';
}
function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
function isSiblingSession(s) {
  return !!(SELF_INSTANCE_NAME && s.environment && s.environment.instanceName && s.environment.instanceName !== SELF_INSTANCE_NAME);
}

// Pure: the cards DONE holds for this render — idle cards, then closed cards.
// An archived (terminated) closed card is left out unless archives are shown;
// a sleeping one (closed, not terminated) unless sleeping cards are shown
// (showSleeping, on unless false). The one key a deep link revealed (revealKey)
// is always in. archivedCount / sleepingCount = those cards in the board data.
// The cards are then grouped by the day they finished (planDoneGroups).
function planDoneColumn(idle, closed, o) {
  var shown = [], archivedCount = 0, sleepingCount = 0;
  for (var i = 0; i < closed.length; i++) {
    var s = closed[i];
    var archived = s.terminated === true;
    var revealed = !!o.revealKey && s.key === o.revealKey;
    if (archived) archivedCount++;
    else sleepingCount++;
    if (archived && !o.showArchives && !revealed) continue;
    if (!archived && o.showSleeping === false && !revealed) continue;
    shown.push(s);
  }
  var done = idle.map(function(s) { return { s: s, col: 'idle' }; })
    .concat(shown.map(function(s) { return { s: s, col: 'closed' }; }));
  return { done: done, archivedCount: archivedCount, sleepingCount: sleepingCount };
}

// ── DONE by finish day (SSOT 2026-10-22 T11/T12) ──
// Each DONE card sits under the day its work finished (s.doneAt — the server's
// finish time; else its last activity), in the viewer's calendar: Today, 어제,
// then every earlier day, newest first, the cards in a day newest first. Today
// and 어제 start open; earlier days start closed and open on a click. The
// reader's choice per day lasts for the page (_doneGroupOpen).
var _doneGroupOpen = Object.create(null); // day key → open (reader's choice)
var DAY_MS = 24 * 60 * 60 * 1000;
function doneTimeOf(s) {
  var t = toNum(s && s.doneAt);
  if (t > 0) return t;
  var last = Date.parse(s && s.lastActivity);
  return isFinite(last) ? last : 0;
}
function dayKeyOf(ms) {
  var d = new Date(ms);
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}
function doneDayLabel(key, now) {
  if (key === dayKeyOf(now)) return 'Today';
  var y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKeyOf(y.getTime())) return '어제';
  var parts = key.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var opts = { month: 'long', day: 'numeric', weekday: 'short' };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('ko-KR', opts);
}
// Pure: [{ key, label, open, items }] — opened = the reader's choices.
function planDoneGroups(done, now, opened) {
  var byKey = Object.create(null);
  var keys = [];
  for (var i = 0; i < done.length; i++) {
    var t = doneTimeOf(done[i].s);
    var k = dayKeyOf(t);
    if (!byKey[k]) { byKey[k] = []; keys.push(k); }
    byKey[k].push({ item: done[i], t: t });
  }
  keys.sort(function(a, b) { return a < b ? 1 : a > b ? -1 : 0; });
  var today = dayKeyOf(now);
  var y = new Date(now);
  y.setDate(y.getDate() - 1);
  var yesterday = dayKeyOf(y.getTime());
  return keys.map(function(k) {
    var list = byKey[k].slice().sort(function(a, b) { return b.t - a.t; });
    var open = opened && Object.prototype.hasOwnProperty.call(opened, k) ? !!opened[k] : (k === today || k === yesterday);
    return { key: k, label: doneDayLabel(k, now), open: open, items: list.map(function(x) { return x.item; }) };
  });
}
function toggleDoneGroup(key) {
  var g = (_lastDoneGroups || []).filter(function(x) { return x.key === key; })[0];
  _doneGroupOpen[key] = !(g && g.open);
  if (_lastBoardData) renderBoard(_lastBoardData);
}
var _lastDoneGroups = null;
var _lastBoardData = null;
// A targeted card push (sessionUpdated) lands in the last board too, so a
// re-render from it (a DONE day toggle) never rolls the card back.
function patchLastBoard(s) {
  if (!_lastBoardData || !s || !s.key) return;
  ['working', 'waiting', 'idle', 'closed'].forEach(function(col) {
    var arr = _lastBoardData[col] || [];
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].key === s.key) arr[i] = s;
  });
}

function renderBoard(board) {
  _sessionCache = Object.create(null); // Clear stale cache each render cycle
  // Populate cache from the entire board first so the env-palette pass
  // (which reads every card's environment) and the per-card renders share
  // one walk over the data.
  for (var col0 of ['working', 'waiting', 'idle', 'closed']) {
    var arr = board[col0] || [];
    for (var i0 = 0; i0 < arr.length; i0++) {
      _sessionCache[arr[i0].key] = arr[i0];
    }
  }
  _envIndex = _buildEnvIndex();
  // Owner hues for every card in the board data (hidden archives too, so the
  // Show archives toggle never recolours anyone).
  var owners = [];
  for (var ok in _sessionCache) owners.push(_sessionCache[ok].ownerId || _sessionCache[ok].ownerName || '');
  _ownerIndex = assignOwnerHues(owners);
  function tag(col) { return function(s) { return { s: s, col: col }; }; }
  _lastBoardData = board;
  var plan = planDoneColumn(board.idle || [], board.closed || [], {
    showArchives: showArchives,
    showSleeping: showSleeping,
    revealKey: _revealedKey,
  });
  var doneGroups = planDoneGroups(plan.done, Date.now(), _doneGroupOpen);
  _lastDoneGroups = doneGroups;
  reconcileBoard({
    waiting: (board.waiting || []).map(tag('waiting')),
    working: (board.working || []).map(tag('working')),
    doneGroups: doneGroups,
  }, {
    waiting: (board.waiting || []).length,
    working: (board.working || []).length,
    // The DONE badge counts every card under its day groups, open or closed
    // (hidden archives / sleeping cards are not in it).
    done: plan.done.length,
  });
  renderArchivesToggle(plan.archivedCount);
  renderSleepingToggle(plan.sleepingCount);
  // The #814 tokens tooltip describes this board (user switch, WS push).
  updateTokenBreakdown();
  _boardRenders++;
  openDeepLinkedSession();
}

// Keyed reconciler (§3.1-6). Each card keeps its DOM node for its whole life:
// it is moved between columns, only the parts whose HTML changed are
// rewritten, and every card whose on-screen position moved is FLIPped from
// where it was (§4-2).
// Pass 1 plans against the stored HTML and node order without writing. If
// nothing differs it stops there — a same-data render writes nothing and
// leaves a running entrance or exit alone.
function reconcileBoard(plan, counts) {
  var wanted = Object.create(null);
  var slots = [];
  var changed = false;
  // NEEDS YOU and RUNNING: one card container each. DONE: one per finish day
  // (T11), whose cards are in the DOM only while the day is open (T12).
  ['waiting', 'working'].forEach(function(colId) {
    slots.push({ colId: colId, container: document.getElementById('cards-' + colId), items: plan[colId] || [] });
  });
  var doneRoot = document.getElementById('cards-done');
  var groups = plan.doneGroups || [];
  var sig = doneGroupsSig(groups);
  if (doneRoot && doneRoot._sig !== sig) changed = true;
  for (var gi = 0; gi < groups.length; gi++) {
    slots.push({
      colId: 'done',
      day: groups[gi].key,
      container: doneRoot ? doneGroupCards(doneRoot, groups[gi].key) : null,
      items: groups[gi].open ? groups[gi].items : [],
    });
  }
  for (var c = 0; c < slots.length; c++) {
    var slot = slots[c];
    var rows = [];
    for (var i = 0; i < slot.items.length; i++) {
      var s = slot.items[i].s;
      if (wanted[s.key]) continue; // a key listed twice renders once
      wanted[s.key] = true;
      var parts = cardParts(s, slot.items[i].col);
      var el = _cardEls[s.key];
      if (!el || !slot.container || slot.container.children[rows.length] !== el || cardPartsDiffer(el, parts)) changed = true;
      rows.push({ key: s.key, parts: parts });
    }
    if (!slot.container || slot.container.children.length !== rows.length) changed = true;
    slot.rows = rows;
  }
  // Counts and empty hints are compared before they are written.
  for (var b = 0; b < BOARD_COLS.length; b++) {
    var colId = BOARD_COLS[b];
    setTextIfChanged(document.getElementById('count-' + colId), String(counts[colId] || 0));
    var has = colId === 'done' ? groups.length > 0 : (plan[colId] || []).length > 0;
    var empty = document.getElementById('empty-' + colId);
    if (empty && empty.hidden !== has) empty.hidden = has;
  }
  for (var g in _cardEls) {
    if (!wanted[g]) { changed = true; break; }
  }
  if (changed) applyBoardPlan(slots, wanted, doneRoot, groups, sig);
  // Open cards keep their 지시/응답 current (no DOM write unless a fetch settles).
  _expanded.forEach(function(key) { if (_cardEls[key]) ensureCardIo(key, false); });
}

// What the DONE day sections look like (label, count, open) — a change re-plans.
function doneGroupsSig(groups) {
  return groups.map(function(g) { return g.key + '|' + g.label + '|' + g.items.length + '|' + (g.open ? 1 : 0); }).join(';');
}
function doneGroupSection(doneRoot, key) {
  var kids = doneRoot.children;
  for (var i = 0; i < kids.length; i++) if (kids[i].getAttribute('data-day') === key && !kids[i]._stale) return kids[i];
  return null;
}
function doneGroupCards(doneRoot, key) {
  var sec = doneGroupSection(doneRoot, key);
  return sec ? sec._cardsEl : null;
}
function renderDoneGroupHead(g) {
  return '<svg class="dg-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>'
    + '<span class="dg-label">' + esc(g.label) + '</span><span class="count">' + g.items.length + '</span>';
}
// Make #cards-done hold one section per day, in order, with current heads.
// A day that is gone leaves once its cards have faded out.
function syncDoneGroups(doneRoot, groups, sig) {
  var keep = Object.create(null);
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    keep[g.key] = true;
    var sec = doneGroupSection(doneRoot, g.key);
    if (!sec) {
      sec = document.createElement('section');
      sec.className = 'done-group';
      sec.setAttribute('data-day', g.key);
      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'done-group-head';
      head.addEventListener('click', function(ev) {
        var day = ev.currentTarget.parentNode.getAttribute('data-day');
        toggleDoneGroup(day);
      });
      var cards = document.createElement('div');
      cards.className = 'cards done-group-cards';
      sec.appendChild(head);
      sec.appendChild(cards);
      sec._headEl = head;
      sec._cardsEl = cards;
      sec._headHtml = null;
    }
    var html = renderDoneGroupHead(g);
    if (sec._headHtml !== html) { sec._headEl.innerHTML = html; sec._headHtml = html; }
    var exp = g.open ? 'true' : 'false';
    if (sec._headEl.getAttribute('aria-expanded') !== exp) sec._headEl.setAttribute('aria-expanded', exp);
    if (sec._cardsEl.hidden === g.open) sec._cardsEl.hidden = !g.open;
    if (doneRoot.children[i] !== sec) doneRoot.insertBefore(sec, doneRoot.children[i] || null);
  }
  var kids = Array.prototype.slice.call(doneRoot.children);
  for (var j = 0; j < kids.length; j++) {
    var old = kids[j];
    if (keep[old.getAttribute('data-day')] && !old._stale) continue;
    if (old._stale) continue;
    old._stale = true;
    old.classList.add('is-stale');
    setTimeout(function(node) { return function() { if (node.parentNode) node.parentNode.removeChild(node); }; }(old), MOTION.fade + 40);
  }
  doneRoot._sig = sig;
}

function applyBoardPlan(slots, wanted, doneRoot, groups, sig) {
  var animate = canAnimate();
  var first = animate ? measureCards() : null;
  var firstCol = Object.create(null);
  for (var k0 in _cardEls) firstCol[k0] = _cardEls[k0]._colId;
  if (doneRoot) syncDoneGroups(doneRoot, groups || [], sig);
  for (var c = 0; c < slots.length; c++) {
    var slot = slots[c];
    var container = slot.container || (slot.day && doneRoot ? doneGroupCards(doneRoot, slot.day) : null);
    if (!container) continue;
    for (var r = 0; r < slot.rows.length; r++) {
      var row = slot.rows[r];
      var el = _cardEls[row.key];
      if (!el) {
        el = createCardShell(row.key);
        _cardEls[row.key] = el;
        el._isNew = true;
      }
      applyCardParts(el, row.parts);
      el._colId = slot.colId;
      applyExpanded(el, _expanded.has(row.key));
      if (container.children[r] !== el) container.insertBefore(el, container.children[r] || null);
    }
  }
  for (var gone in _cardEls) {
    if (wanted[gone]) continue;
    var goneCid = _cardEls[gone]._cid;
    exitCard(_cardEls[gone], first ? first[gone] : null);
    delete _cardEls[gone];
    dropCounters(gone);
    releaseCardIoTimer(goneCid);
  }
  for (var key in _cardEls) {
    var card = _cardEls[key];
    if (card._isNew) {
      card._isNew = false;
      if (animate) enterCard(card);
      continue;
    }
    if (!animate || !first[key]) continue;
    // Interrupted move: the first box was read mid-flight (translate included),
    // so cancelling and re-FLIPping restarts from where the card is drawn.
    var wasFlying = card.classList.contains('is-flying');
    if (card._flip) { card._flip.cancel(); card._flip = null; }
    if (wasFlying) card.classList.remove('is-flying');
    var a = first[key];
    var b = boxOf(card);
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    playFlip(card, dx, dy, wasFlying || firstCol[key] !== card._colId);
  }
}

// Top-left of the card's full-size box as drawn. Taken from the rect centre and
// the untransformed size, so a card mid-entrance (scale 0.97) measures where its
// box really is — no entrance has to be cut short to measure it — while a FLIP
// translate in flight is included.
function boxOf(el) {
  var r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - el.offsetWidth / 2, y: r.top + r.height / 2 - el.offsetHeight / 2 };
}
function measureCards() {
  var boxes = Object.create(null);
  for (var k in _cardEls) boxes[k] = boxOf(_cardEls[k]);
  return boxes;
}

// Move = translate only (widths snap; text never stretches). The card that
// changes column flies raised above its neighbours (shadow + z-index). The
// translate is added on top of whatever runs already, so a card still in its
// entrance keeps scaling while it moves.
function playFlip(el, dx, dy, raise) {
  if (reduceMotion()) {
    // §4-8: no travel — a card that changed column fades in where it landed.
    if (raise) el._enter = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fade, easing: 'linear' });
    return;
  }
  if (raise) el.classList.add('is-flying');
  var anim = el.animate(
    [{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'translate(0, 0)' }],
    { duration: MOTION.move, easing: MOTION.easeInOut, composite: 'add' }
  );
  el._flip = anim;
  anim.onfinish = function() {
    if (el._flip !== anim) return;
    el._flip = null;
    el.classList.remove('is-flying');
  };
}

// Enter: opacity 0 + scale(0.97) → 1 (never from scale(0)).
function enterCard(el) {
  var frames = reduceMotion()
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'scale(1)' }];
  var anim = el.animate(frames, { duration: MOTION.fade, easing: MOTION.easeOut });
  el._enter = anim;
  anim.onfinish = function() { if (el._enter === anim) el._enter = null; };
}

// Exit: opacity only. The card leaves the column's card list (re-parented to
// the column, absolutely placed where it was drawn) so the remaining cards
// FLIP into the gap and later renders never see it; it removes itself when
// its fade finishes.
function exitCard(el, box) {
  if (el._flip) { el._flip.cancel(); el._flip = null; }
  var list = el.parentNode;
  var host = list && list.parentNode;
  if (!list) return;
  if (!box || !host || !canAnimate()) { list.removeChild(el); return; }
  var hr = host.getBoundingClientRect();
  var width = el.offsetWidth;
  el.removeAttribute('data-session-key');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('inert', '');
  el.classList.add('is-exiting');
  el.style.left = (box.x - hr.left) + 'px';
  el.style.top = (box.y - hr.top) + 'px';
  el.style.width = width + 'px';
  host.appendChild(el);
  var anim = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.fade, easing: MOTION.easeOut, fill: 'forwards' });
  el._exit = anim;
  anim.onfinish = anim.oncancel = function() { if (el.parentNode) el.parentNode.removeChild(el); };
}

// Persistent shell: .card > .card-face (collapsed view, the toggle target)
// + .card-expand (grid row 0fr↔1fr) > .card-expand-inner (expanded body).
function createCardShell(key) {
  var el = document.createElement('div');
  el.className = 'card';
  el.setAttribute('data-session-key', key);
  var face = document.createElement('div');
  face.className = 'card-face';
  face.setAttribute('role', 'button');
  face.setAttribute('tabindex', '0');
  face.setAttribute('aria-expanded', 'false');
  var expand = document.createElement('div');
  expand.className = 'card-expand';
  expand.setAttribute('inert', '');
  var inner = document.createElement('div');
  inner.className = 'card-expand-inner';
  expand.appendChild(inner);
  el.appendChild(face);
  el.appendChild(expand);
  el._faceEl = face;
  el._expandEl = expand;
  el._bodyEl = inner;
  el._faceHtml = null;
  el._bodyHtml = null;
  return el;
}

function applyExpanded(el, open) {
  if (el.classList.contains('is-expanded') === open) return;
  el.classList.toggle('is-expanded', open);
  el._faceEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) el._expandEl.removeAttribute('inert');
  else el._expandEl.setAttribute('inert', '');
}

// One card's rendered parts. The HTML strings depend only on the data (clocks
// are filled by the 1 Hz tick), so equal data gives equal strings.
function cardParts(s, col) {
  return { col: col, state: cardState(s, col), face: renderCardFace(s, col), body: renderCardBody(s, col), cid: s.conversationId || null };
}
function cardPartsDiffer(el, p) {
  return el.getAttribute('data-col') !== p.col || el.getAttribute('data-state') !== p.state
    || el._faceHtml !== p.face || el._bodyHtml !== p.body;
}
// Each part is replaced only when its HTML string changed, so untouched cards
// keep their nodes, an open card keeps its state, and a running transition is
// never cut.
function applyCardParts(el, p) {
  el._cid = p.cid; // bookkeeping only (timer release), not a DOM write
  var changed = false;
  if (el.getAttribute('data-col') !== p.col) { el.setAttribute('data-col', p.col); changed = true; }
  if (el.getAttribute('data-state') !== p.state) { el.setAttribute('data-state', p.state); changed = true; }
  if (el._faceHtml !== p.face) {
    el._faceEl.innerHTML = p.face;
    el._faceHtml = p.face;
    updateTimersIn(el._faceEl);
    animateCountersIn(el._faceEl, el.getAttribute('data-session-key'));
    changed = true;
  }
  if (el._bodyHtml !== p.body && !isEditingGoal(el._bodyEl) && !isPickingModel(el._bodyEl)) {
    var goalDraft = captureGoalDraft(el._bodyEl);
    el._bodyEl.innerHTML = p.body;
    el._bodyHtml = p.body;
    restoreGoalDraft(el._bodyEl, goalDraft);
    updateTimersIn(el._bodyEl);
    changed = true;
  }
  return changed;
}
// Single-card path (sessionUpdated push, title patch, 지시/응답 arrival) —
// the same compare-then-write as the reconciler.
function patchCard(el, s, col) {
  _sessionCache[s.key] = s;
  return applyCardParts(el, cardParts(s, col));
}
function refreshCard(key) {
  var el = _cardEls[key];
  var s = _sessionCache[key];
  if (el && s) patchCard(el, s, el.getAttribute('data-col') || 'idle');
}

function cardState(s, col) {
  if (col === 'closed') return s.terminated ? 'archived' : 'sleeping';
  return col;
}

// Second line of the collapsed card (§3.1-3): what the session needs or is doing.
function cardSummary(s, col, headline) {
  var tasks = s.tasks || [];
  var current = null;
  var lastDone = null;
  for (var i = 0; i < tasks.length; i++) {
    if (!current && tasks[i].status === 'in_progress') current = tasks[i];
    if (tasks[i].status === 'completed') lastDone = tasks[i];
  }
  var q = s.pendingQuestion;
  if (col === 'waiting' && q && (q.question || q.title)) return q.question || q.title;
  // Waiting out a retry: the error behind it is what this card is "doing".
  var resume = pendingAutoResume(s, col);
  if (resume && resume.reason) return '오류: ' + resume.reason;
  // The task row (renderCardTaskRow) names the running task — the summary
  // only does when that row is hidden.
  if (col === 'working' && current && !dhShow('tasks')) return current.content;
  if (s.summaryTitle && s.summaryTitle !== headline) return s.summaryTitle;
  var lastTask = lastDone || (tasks.length ? tasks[tasks.length - 1] : null);
  if (lastTask) return lastTask.content;
  if (s.title && s.title !== headline) return s.title;
  return '';
}

// The armed automatic resume (server KanbanAutoResume) of a RUNNING card that
// is not running a turn right now — idle until a retry timer or a goal
// re-check starts it again. null when the card is running or has none.
function pendingAutoResume(s, col) {
  if (col !== 'working' || s.activityState === 'working' || !s.autoResume) return null;
  return s.autoResume;
}

// One line for an armed resume: what starts the session again, when, which
// attempt. Absolute clock time (no countdown), so equal data renders equal HTML.
function autoResumeLabel(r) {
  if (!r) return '';
  if (r.kind === 'goal-eval') return 'Goal 완료 판정 중';
  var at = Number(r.at) || 0;
  var what = r.kind === 'goal-eval-retry' ? 'Goal 판정 재시도' : '자동 재개';
  var text = (at ? formatTaskTime(at) + ' ' : '') + what;
  var attempt = Number(r.attempt) || 0;
  var max = Number(r.maxAttempts) || 0;
  if (attempt && max) text += ' · 시도 ' + attempt + '/' + max;
  return text;
}

// Status at the foot of the card. Board shows the bare timer; List adds the
// "Running · " / "Done in " prefix via CSS — same DOM in both views.
function renderCardStatus(s, col) {
  var resume = pendingAutoResume(s, col);
  if (resume) {
    return '<span class="st-icon is-resume">' + RESUME_SVG + '</span><span class="st-text" title="' + escAttr(resume.reason || '') + '">' + esc(autoResumeLabel(resume)) + '</span>';
  }
  if (col === 'waiting') {
    return '<span class="st-icon">' + WAIT_SVG + '</span><span class="st-text">Waiting for you</span>';
  }
  if (col === 'closed') {
    return '<span class="st-icon"><span class="st-dot is-hollow"></span></span><span class="st-text">' + (s.terminated ? 'Archived' : 'Sleeping') + '</span>';
  }
  var acc = Number(s.activeAccumulatedMs) || 0;
  var leg = col === 'working' ? (Number(s.activeLegStartedAtMs) || 0) : 0;
  var timer = '<span class="card-timer-live" data-leg-started="' + leg + '" data-accumulated="' + acc + '" title="Active time"></span>';
  if (col === 'working') {
    return '<span class="st-icon"><span class="spinner"></span></span><span class="st-text"><span class="st-prefix">Running &middot; </span>' + timer + '</span>';
  }
  if (!acc) return '<span class="st-icon"><span class="st-dot"></span></span><span class="st-text">Idle</span>';
  return '<span class="st-icon"><span class="st-dot"></span></span><span class="st-text"><span class="st-prefix">Done in </span>' + timer + '</span>';
}

// Owner badge (§3.1-3): in the All Users view every card head names its owner,
// right-aligned, in one of the 8 hues of --ob-N-*. Like the env badges
// (_buildEnvIndex), the owners on the board are assigned together: in sorted
// order each takes its hash slot (djb2 % 8) when free, the rest probe forward to
// the next free slot. Up to 8 owners never share a colour, and the result
// depends only on the set of owners — one person keeps one colour on every card
// and render while that set stands. An owner not on the board yet gets its
// hash slot.
var OWNER_BADGE_HUES = 8;
var _ownerIndex = null; // ownerId → hue slot for the board on screen (renderBoard)
function assignOwnerHues(ids) {
  var seen = Object.create(null);
  var sorted = [];
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i] || '');
    if (id && !seen[id]) { seen[id] = true; sorted.push(id); }
  }
  sorted.sort();
  var out = Object.create(null);
  var taken = [];
  var pending = [];
  for (var j = 0; j < sorted.length; j++) {
    var slot = _hashStr(sorted[j]) % OWNER_BADGE_HUES;
    if (!taken[slot]) { taken[slot] = true; out[sorted[j]] = slot; }
    else pending.push(sorted[j]);
  }
  for (var k = 0; k < pending.length; k++) {
    var start = _hashStr(pending[k]) % OWNER_BADGE_HUES;
    out[pending[k]] = start; // more owners than hues: share the hash slot
    for (var step = 1; step < OWNER_BADGE_HUES; step++) {
      var probe = (start + step) % OWNER_BADGE_HUES;
      if (!taken[probe]) { taken[probe] = true; out[pending[k]] = probe; break; }
    }
  }
  return out;
}
function ownerBadgeHue(ownerId) {
  var id = String(ownerId || '');
  var slot = _ownerIndex ? _ownerIndex[id] : undefined;
  return typeof slot === 'number' ? slot : _hashStr(id) % OWNER_BADGE_HUES;
}
function renderOwnerBadge(s) {
  if (currentUserId) return '';
  var name = s.ownerName || s.ownerId;
  if (!name) return '';
  return '<span class="owner-badge" data-hue="' + ownerBadgeHue(s.ownerId || name) + '" title="' + escAttr(name) + '">' + esc(name) + '</span>';
}

// The task in progress (SSOT 2026-10-22 T3): first in_progress task in list order.
function cardCurrentTask(s) {
  var tasks = (s && s.tasks) || [];
  for (var i = 0; i < tasks.length; i++) if (tasks[i] && tasks[i].status === 'in_progress') return tasks[i];
  return null;
}
// Collapsed face row (T3): "#T2 Write the parser · 3m 12s" — while the session
// runs or waits on the user. The time is filled by the 1 Hz tick.
function renderCardTaskRow(s, col) {
  if (!dhShow('tasks') || (col !== 'working' && col !== 'waiting')) return '';
  var t = cardCurrentTask(s);
  if (!t) return '';
  var started = Number(t.startedAt) || 0;
  return '<div class="card-task" title="' + escAttr(t.activeForm || t.content || '') + '">'
    + (t.id ? '<span class="ct-id">#' + esc(t.id) + '</span>' : '')
    + '<span class="ct-name">' + esc(t.content || '') + '</span>'
    + (started ? '<span class="ct-time task-elapsed" data-since="' + started + '"></span>' : '')
    + '</div>';
}
// Collapsed face row (T1/T2): total tokens · API-equivalent cost, each a
// count-up target (startCountUp). Gated by the 'tokens' / 'cost' header fields.
function renderCardUsage(s) {
  var u = s.tokenUsage;
  if (!u) return '';
  var parts = [];
  if (dhShow('tokens')) {
    var tok = cardTotalTokens(u);
    var tip = '입력 ' + formatTokens(u.totalInputTokens) + ' · 출력 ' + formatTokens(u.totalOutputTokens)
      + ' · 캐시 읽기 ' + formatTokens(u.totalCacheReadTokens) + ' · 캐시 쓰기 ' + formatTokens(u.totalCacheCreateTokens);
    parts.push('<span class="cu-item" title="' + escAttr('총 토큰 — ' + tip) + '"><span class="cnt" data-cnt="tok" data-to="' + tok + '">' + formatCount('tok', tok) + '</span><span class="cu-unit">tok</span></span>');
  }
  if (dhShow('cost')) {
    var cost = toNum(u.totalCostUsd);
    parts.push('<span class="cu-item" title="API 환산 비용"><span class="cnt" data-cnt="cost" data-to="' + cost + '">' + formatCount('cost', cost) + '</span></span>');
  }
  return parts.length ? '<div class="card-usage">' + parts.join('<span class="cu-sep" aria-hidden="true">&middot;</span>') + '</div>' : '';
}

// Collapsed face (§2.1 reference anatomy): ✦ + headline [+ owner badge] /
// 2-line summary / status · tasks done/total · context %.
function renderCardFace(s, col) {
  // Server-resolved headline (#762) — displayHeadline reflects the full
  // priority chain (summaryTitle then issueTitle then prTitle then title then
  // 'Untitled'). The local fallback covers the WS patch path where
  // summaryTitleChanged / sessionUpdated may have rewritten only a subset.
  var headline = s.displayHeadline || s.summaryTitle || s.title;
  var titleTrunc = dhTruncate('title');
  var titleHtml = dhShow('title')
    ? '<span class="card-title-text">' + esc(titleTrunc ? String(headline || '').slice(0, titleTrunc) : headline) + '</span>'
    : '';
  var summary = cardSummary(s, col, headline);
  var metrics = [];
  if (dhShow('tasks') && s.tasks && s.tasks.length > 0) {
    var doneCount = s.tasks.filter(function(t) { return t.status === 'completed'; }).length;
    metrics.push('<span class="metric" title="Tasks done / total">' + TASKS_SVG + doneCount + '/' + s.tasks.length + '</span>');
  }
  var ctxPct = s.tokenUsage ? (s.tokenUsage.contextUsagePercent || 0) : 0;
  if (dhShow('contextwindow') && ctxPct > 0) {
    metrics.push('<span class="metric" title="Context window used">' + CTX_SVG + Math.round(Math.min(Number(ctxPct) || 0, 100)) + '%</span>');
  }
  return '<div class="card-head"><span class="card-spark">' + SPARK_SVG + '</span>' + titleHtml + renderOwnerBadge(s) + '</div>'
    + (summary ? '<div class="card-summary">' + esc(summary) + '</div>' : '')
    + renderCardTaskRow(s, col)
    + renderCardUsage(s)
    + '<div class="card-foot"><span class="card-status">' + renderCardStatus(s, col) + '</span>'
    + (metrics.length ? '<span class="card-metrics">' + metrics.join('') + '</span>' : '')
    + '</div>';
}

// Task timeline (§3.1-4): list order, the in-progress step is the solid dot.
// Every task shows its id (SSOT 2026-10-22 T8); a completed task its elapsed
// time and the tool calls made while it ran, the running one its live time and
// calls so far (T7). Over the dhMax('tasks') budget the earliest completed
// steps fold away first; "전체 task 보기" opens every task of the list plus the
// tasks of earlier lists (s.earlierTasks), per card.
var _tasksOpen = Object.create(null); // card key → every task shown
function renderTaskMeta(t) {
  // Task timestamps come from the ledger: numbers only.
  var started = Number(t.startedAt) || 0;
  var completed = Number(t.completedAt) || 0;
  var parts = [];
  if (t.status === 'completed' && started && completed) parts.push(formatDuration(completed - started) || '0s');
  else if (t.status === 'in_progress' && started) parts.push('<span class="task-elapsed" data-since="' + started + '"></span>');
  if (t.status !== 'pending') parts.push('<span class="tl-tools" title="툴 호출 수">툴 ' + toNum(t.toolCalls) + '회</span>');
  return parts.join(' &middot; ');
}
function renderTimelineItem(t) {
  var cls = t.status === 'in_progress' ? ' is-current' : (t.status === 'completed' ? ' is-done' : ' is-pending');
  var meta = renderTaskMeta(t);
  return '<li class="tl-item' + cls + '">'
    + (t.id ? '<span class="tl-id">#' + esc(t.id) + '</span>' : '')
    + '<span class="tl-text">' + esc(t.content) + '</span>'
    + (meta ? '<span class="tl-time">' + meta + '</span>' : '') + '</li>';
}
function renderTimeline(s) {
  if (!dhShow('tasks')) return '';
  var tasks = s.tasks || [];
  var earlier = s.earlierTasks || [];
  if (tasks.length === 0 && earlier.length === 0) return '';
  var open = !!_tasksOpen[s.key];
  var max = dhMax('tasks', 5);
  var folded = 0;
  var tail = 0;
  var shown = [];
  if (open) {
    shown = tasks.slice();
  } else {
    var drop = Math.max(0, tasks.length - max);
    for (var i = 0; i < tasks.length; i++) {
      if (drop > 0 && tasks[i].status === 'completed') { drop--; folded++; continue; }
      shown.push(tasks[i]);
    }
    if (shown.length > max) { tail = shown.length - max; shown = shown.slice(0, max); }
  }
  var hidden = folded + tail + earlier.length;
  var html = '<div class="tl-wrap">';
  if (folded > 0) html += '<div class="tl-more">+' + folded + ' completed</div>';
  if (shown.length) html += '<ul class="tl">' + shown.map(renderTimelineItem).join('') + '</ul>';
  if (tail > 0) html += '<div class="tl-more">+' + tail + ' more</div>';
  if (open && earlier.length) {
    html += '<div class="tl-earlier-title">이전 task ' + earlier.length + '개</div>'
      + '<ul class="tl tl-earlier">' + earlier.map(renderTimelineItem).join('') + '</ul>';
  }
  if (open || hidden > 0) {
    html += '<button type="button" class="tl-toggle" aria-expanded="' + (open ? 'true' : 'false') + '"'
      + ' onclick="event.stopPropagation();toggleCardTasks(\\'' + escJs(s.key) + '\\')">'
      + (open ? '접기' : '전체 task 보기 (' + hidden + ')') + '</button>';
  }
  return html + '</div>';
}
function toggleCardTasks(key) {
  if (_tasksOpen[key]) delete _tasksOpen[key];
  else _tasksOpen[key] = true;
  refreshCard(key);
}

// Latest user instruction + model response (§3.1-4), fetched lazily on
// expand from GET /api/dashboard/session/:conversationId?limit=2 and cached
// per conversation. Only a complete fetch for the session's current
// lastActivity counts as fresh. A failure — or a partial result (the
// instruction loaded, the raw response did not) — keeps what it has and is
// retried on a backoff (1, 2, 4 … 30 s).
// Two clocks, deliberately separate:
//   - the retry DEADLINE and backoff STEP belong to the conversation: they keep
//     growing through an outage no matter how often lastActivity changes;
//   - the retry BUDGET (IO_AUTO_RETRIES automatic attempts) belongs to one
//     lastActivity stamp: newer content earns a fresh budget, never an earlier
//     deadline.
// While in error, only the deadline timer (or an explicit reopen) sends a
// request; board renders and landed turns can at most arm that timer.
var IO_RETRY_MAX_MS = 30000;
var IO_AUTO_RETRIES = 6;
function ioBackoffMs(step) {
  return Math.min(IO_RETRY_MAX_MS, 1000 * Math.pow(2, Math.max(0, step - 1)));
}
// Pure: may this call send a request now? fromTimer = the deadline timer fired.
//   loading → no · ok → only for a newer stamp · error → reopen (force), or the
//   deadline timer once the deadline passed and this stamp still has budget
//   (a newer stamp always does).
function ioNeedsFetch(c, stamp, force, now, fromTimer) {
  if (!c) return true;
  if (c.state === 'loading') return false;
  if (c.state === 'ok') return c.stamp !== stamp;
  if (force) return true;
  if (!fromTimer || now < (c.retryAt || 0)) return false;
  return ioHasBudget(c, stamp);
}
// Pure: an errored entry still wants an automatic retry for this stamp.
function ioHasBudget(c, stamp) {
  return c.stamp !== stamp || (c.fails || 0) <= IO_AUTO_RETRIES;
}

// At most one pending retry timer per conversation: cid → { handle, at }.
// The earliest deadline wins — a pending timer is kept only if it fires at or
// before the new deadline, otherwise it is replaced. A success, or the last
// open card of the conversation going away, clears it.
var _ioTimers = Object.create(null);
function scheduleCardIoRetry(cid, at) {
  var cur = _ioTimers[cid];
  if (cur && cur.at <= at) return;
  if (cur) clearTimeout(cur.handle);
  var entry = { handle: null, at: at };
  entry.handle = setTimeout(function() {
    if (_ioTimers[cid] === entry) delete _ioTimers[cid];
    retryCardIo(cid);
  }, Math.max(0, at - Date.now()));
  _ioTimers[cid] = entry;
}
function cancelCardIoRetry(cid) {
  var cur = cid ? _ioTimers[cid] : null;
  if (!cur) return;
  clearTimeout(cur.handle);
  delete _ioTimers[cid];
}
// The open card on the board that consumes this conversation's retry, or null.
// A timer is armed only while one exists (retryCardIo fires into it).
function cardIoConsumer(cid) {
  for (var k in _cardEls) {
    var s = _sessionCache[k];
    if (s && s.conversationId === cid && _expanded.has(k)) return k;
  }
  return null;
}
// A card closed or left the board: drop its conversation's timer unless
// another open card still shows that conversation.
function releaseCardIoTimer(cid) {
  if (!cid || cardIoConsumer(cid)) return;
  cancelCardIoRetry(cid);
}

// force = the card was just (re)opened (explicit user action).
// fromTimer = the conversation's retry deadline fired.
function ensureCardIo(key, force, fromTimer) {
  var s = _sessionCache[key];
  if (!s || !s.conversationId || isSiblingSession(s)) return;
  var cid = s.conversationId;
  var stamp = String(s.lastActivity || '');
  var c = _ioCache[cid];
  if (!ioNeedsFetch(c, stamp, force, Date.now(), fromTimer)) {
    // In error, a render or a landed turn only arms the deadline timer.
    if (c && c.state === 'error' && ioHasBudget(c, stamp)) scheduleCardIoRetry(cid, c.retryAt || 0);
    return;
  }
  var prev = c ? c.data : null;
  // Budget per stamp; deadline and step per conversation (they survive stamps).
  var fails = c && c.state === 'error' && c.stamp === stamp ? (c.fails || 0) : 0;
  var step = c ? (c.step || 0) : 0;
  _ioCache[cid] = { state: 'loading', stamp: stamp, data: prev, dirty: false, fails: fails, step: step, retryAt: c ? (c.retryAt || 0) : 0 };
  function failed(data) {
    var n = fails + 1;
    var nextStep = step + 1;
    var at = Date.now() + ioBackoffMs(nextStep);
    settleCardIo(cid, { state: 'error', stamp: stamp, data: data, fails: n, step: nextStep, retryAt: at });
    // The card may have closed or left the board while the request was in flight.
    if (n <= IO_AUTO_RETRIES && cardIoConsumer(cid)) scheduleCardIoRetry(cid, at);
  }
  fetchCardIo(cid).then(function(result) {
    if (result && result.partial) failed(result); // keep the instruction, retry the response
    else {
      cancelCardIoRetry(cid); // a later backoff timer must not outlive the recovery
      settleCardIo(cid, { state: 'ok', stamp: stamp, data: result, fails: 0, step: 0, retryAt: 0 });
    }
  }, function() { failed(prev); });
}
function renderCardIo(s) {
  if (!s.conversationId) return '';
  var c = _ioCache[s.conversationId];
  if (!c || !c.data) {
    var note = c && c.state === 'error' ? '지시/응답을 불러오지 못했습니다' : '지시/응답 불러오는 중…';
    return '<div class="card-io"><div class="io-row"><div class="io-text is-muted">' + note + '</div></div></div>';
  }
  var d = c.data;
  var who = d.instruction && d.instruction.who ? '<span class="io-who">' + esc(d.instruction.who) + '</span>' : '';
  var inHtml = d.instruction && d.instruction.text
    ? '<div class="io-text">' + esc(d.instruction.text) + '</div>'
    : '<div class="io-text is-muted">기록된 지시 없음</div>';
  var outHtml;
  if (d.response && (d.response.title || d.response.body)) {
    outHtml = '<div class="io-text">'
      + (d.response.title ? '<span class="io-title">' + esc(d.response.title) + '</span>' + (d.response.body ? '\\n' : '') : '')
      + esc(d.response.body || '') + '</div>';
  } else if (d.partial) {
    outHtml = '<div class="io-text is-muted">응답을 불러오지 못했습니다</div>';
  } else if (s.activityState === 'working') {
    outHtml = '<div class="io-text is-muted">응답 작성 중…</div>';
  } else {
    outHtml = '<div class="io-text is-muted">응답 없음</div>';
  }
  return '<div class="card-io">'
    + '<div class="io-row io-in"><div class="io-label">지시' + who + '</div>' + inHtml + '</div>'
    + '<div class="io-row io-out"><div class="io-label">응답</div>' + outHtml + '</div>'
    + '</div>';
}

// The latest instruction and the reply that answers it (only an assistant
// turn AFTER the latest user turn counts). Rejects on any HTTP failure.
function fetchCardIo(cid) {
  return fetch('/api/dashboard/session/' + encodeURIComponent(cid) + '?limit=2')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
      var turns = (data && data.turns) || [];
      var ui = -1;
      for (var i = turns.length - 1; i >= 0; i--) { if (turns[i].role === 'user') { ui = i; break; } }
      var reply = null;
      for (var j = turns.length - 1; j > ui; j--) { if (turns[j].role === 'assistant') { reply = turns[j]; break; } }
      var raw = ui >= 0 ? decodeSlackEntities(turns[ui].rawContent || '') : '';
      var instruction = ui >= 0
        ? { text: raw.slice(0, 500) + (raw.length > 500 ? '…' : ''), who: turns[ui].userName || '' }
        : null;
      if (reply && !reply.summaryTitle && !reply.summaryBody && reply.id) {
        // Summary not generated yet — fall back to the head of the raw response.
        // If that fails the result is partial: the instruction is kept, and the
        // caller retries for the response.
        return fetch('/api/conversations/' + encodeURIComponent(cid) + '/turns/' + encodeURIComponent(reply.id) + '/raw')
          .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function(rawData) {
            var text = rawData && typeof rawData.raw === 'string' ? rawData.raw : '';
            return { instruction: instruction, response: text ? { title: '', body: text.slice(0, 600) + (text.length > 600 ? '…' : '') } : null };
          }, function() { return { instruction: instruction, response: null, partial: true }; });
      }
      return { instruction: instruction, response: reply ? { title: reply.summaryTitle || '', body: reply.summaryBody || '' } : null };
    });
}

// Deadline timer fired: retry for the first card of that conversation still open.
function retryCardIo(cid) {
  var k = cardIoConsumer(cid);
  if (k) ensureCardIo(k, false, true);
}
function settleCardIo(cid, entry) {
  var wasDirty = !!(_ioCache[cid] && _ioCache[cid].dirty);
  _ioCache[cid] = entry;
  for (var k in _cardEls) {
    var s = _sessionCache[k];
    if (s && s.conversationId === cid) refreshCard(k);
  }
  if (wasDirty) invalidateCardIo(cid);
}
// A turn landed for this conversation — new content: refetch for any open card
// (in error: a fresh budget, still paced by the conversation's deadline).
function invalidateCardIo(cid) {
  var c = cid && _ioCache[cid];
  if (!c) return;
  if (c.state === 'loading') { c.dirty = true; return; }
  c.stamp = null;
  for (var k in _cardEls) {
    var s = _sessionCache[k];
    if (s && s.conversationId === cid && _expanded.has(k)) ensureCardIo(k, false);
  }
}

// Expanded body: model·effort → meta (env/workflow/owner/last activity) →
// refs → task timeline → instruction/response → pending question → stats →
// buttons. Every field the old card face showed is still gated by dhShow().
// The open card's resume row: when / which attempt, and the full error line
// the collapsed face clamps to two lines.
function renderCardResume(s, col) {
  var r = pendingAutoResume(s, col);
  if (!r) return '';
  return '<div class="card-resume">' + RESUME_SVG + '<div>'
    + '<div class="cr-when">' + esc(autoResumeLabel(r)) + '</div>'
    + (r.reason ? '<div class="cr-reason">' + esc(r.reason) + '</div>' : '')
    + '</div></div>';
}

function renderCardBody(s, col) {
  // Owner gating — server-side requireSessionOwner is the authoritative guard;
  // this is UX only. Fail closed: if ownerId is missing (legacy record) the
  // viewer is not treated as owner so the server-side reject is expected.
  const isOwner = !!s.ownerId && s.ownerId === currentUserId;
  // readOnlyAttrs carries only the disabled attribute — each button owns its
  // own title= so there is no duplicate-attribute clash when the button already
  // needs a descriptive tooltip (e.g. pending-question choices).
  const readOnlyAttrs = isOwner ? '' : ' disabled';

  // Model · effort — the first line of the open card (reference: "Opus 5.5").
  // SSOT 2026-10-22 T4/T5: the owner switches it here, among the
  // representative models; the auto-compact threshold follows.
  const modelShort = esc(s.model).replace(/^claude-/, '').replace(/-\\d{8}$/, '');
  const modelParts = [];
  const canSwitchModel = isOwner && col !== 'closed' && !s.terminated && !isSiblingSession(s);
  if (dhShow('model') && (modelShort || canSwitchModel)) modelParts.push(renderModelPicker(s, canSwitchModel, modelShort));
  if (s.effort || canSwitchModel) modelParts.push(renderEffortPicker(s, canSwitchModel));
  if (dhShow('model') && toNum(s.autoCompactTokens) > 0) {
    modelParts.push('<span class="cb-ac" title="이 모델의 auto-compact 기준">autocompact ' + formatTokens(s.autoCompactTokens) + '</span>');
  }
  const modelNote = renderModelNote(s);
  const modelHtml = modelParts.length || modelNote
    ? '<div class="cb-model">' + modelParts.join(' &middot; ') + '</div>' + modelNote
    : '';

  // #814 env badge — only shown when multiple distinct envs are present in
  // the current cache. Single-env (sibling 0 + INSTANCE_NAME unset) suppresses
  // the badge to keep the card chrome quiet for single-instance deploys.
  var envHtml = '';
  if (s.environment && s.environment.instanceName && _envCount() > 1) {
    var instName = s.environment.instanceName;
    var envColor = getEnvBadgeColor(instName);
    var envHostPort = (s.environment.host || '') + ':' + (s.environment.port || '');
    envHtml = '<span class="env-badge" style="background:' + envColor + '" title="' + escAttr(instName + ' (' + envHostPort + ')') + '">' + esc(instName) + '</span>';
  }
  // Meta row — every registered ui.dashboardheader field is gated via dhShow
  // ("fields absent from config lines are hidden" contract): workflow /
  // owner / status (= last-activity indicator, filled by the 1 Hz tick).
  const metaWorkflowHtml = dhShow('workflow') ? '<span>' + esc(s.workflow) + '</span>' : '';
  const metaOwnerHtml = dhShow('owner') ? '<span class="meta-owner">' + esc(s.ownerName) + '</span>' : '';
  const metaStatusHtml = dhShow('status') ? '<span class="rel-time" data-ts="' + (new Date(s.lastActivity).getTime() || 0) + '"></span>' : '';
  const metaInner = envHtml + metaWorkflowHtml + metaOwnerHtml + metaStatusHtml;
  const metaHtml = metaInner ? '<div class="card-meta">' + metaInner + '</div>' : '';

  // Short refs (PROJ-123 · PR-123 · conversation). Gated by ui.dashboardheader 'links'.
  const refParts = [];
  if (dhShow('links') && s.issueShortRef && s.issueUrl) {
    const issueTip = s.issueTitle || s.issueLabel || s.issueShortRef;
    refParts.push('<a href="' + safeHref(s.issueUrl) + '" target="_blank" rel="noopener" title="' + escAttr(issueTip) + '">' + esc(s.issueShortRef) + '</a>');
  }
  if (dhShow('links') && s.prShortRef && s.prUrl) {
    const prTip = s.prTitle || s.prLabel || s.prShortRef;
    refParts.push('<a href="' + safeHref(s.prUrl) + '" target="_blank" rel="noopener" title="' + escAttr(prTip) + '">' + esc(s.prShortRef) + '</a>');
  }
  if (dhShow('links') && s.conversationId) {
    refParts.push('<a href="/conversations/' + escAttr(s.conversationId) + '" target="_blank" rel="noopener" title="View conversation">&#x1F4DD; 대화 기록</a>');
  }
  const refsHtml = refParts.length
    ? '<div class="card-refs">' + refParts.join('<span class="ref-sep">&middot;</span>') + '</div>'
    : '';
  const subtitlesHtml = (s.issueTitle ? '<div class="card-subtitle">' + esc(String(s.issueTitle).slice(0, 80)) + '</div>' : '')
    + (s.prTitle ? '<div class="card-subtitle">' + esc(String(s.prTitle).slice(0, 80)) + '</div>' : '');

  // Usage line — 'tokens' / 'cost' / 'mergestats' / 'contextwindow' gated
  // independently; thread timers (Σ · compactions · sessions) always shown.
  const statParts = [];
  // Numbers are coerced before they reach markup (defence in depth — a
  // non-number field must render as text, never as markup).
  const num = toNum;
  // Every token kind, like the collapsed face (T1); the tooltip splits it.
  if (s.tokenUsage && dhShow('tokens')) statParts.push('<span class="card-tokens" title="' + escAttr('입력 ' + formatTokens(s.tokenUsage.totalInputTokens) + ' · 출력 ' + formatTokens(s.tokenUsage.totalOutputTokens) + ' · 캐시 ' + formatTokens(num(s.tokenUsage.totalCacheReadTokens) + num(s.tokenUsage.totalCacheCreateTokens))) + '">' + formatTokens(cardTotalTokens(s.tokenUsage)) + ' tok</span>');
  if (s.tokenUsage && dhShow('cost')) statParts.push('<span class="card-tokens"><span class="cost">$' + num(s.tokenUsage.totalCostUsd).toFixed(2) + '</span></span>');
  if (dhShow('mergestats') && s.mergeStats) statParts.push('<span class="card-merge">+' + num(s.mergeStats.totalLinesAdded) + ' / -' + num(s.mergeStats.totalLinesDeleted) + '</span>');
  statParts.push('<span class="card-timer-row">'
    + '<span class="card-timer-total" title="Thread total active time">&Sigma; ' + formatNmSSs(num(s.threadTotalActiveMs)) + '</span>'
    + '<span class="card-timer-compactions" title="Compactions">&#x1F5DC;&#xFE0F; ' + num(s.compactionCount) + '</span>'
    + '<span class="card-timer-sessions" title="Thread session count"># ' + num(s.threadSessionCount) + '</span>'
    + '</span>');
  const ctxPct = s.tokenUsage ? num(s.tokenUsage.contextUsagePercent) : 0;
  const ctxCls = ctxPct > 80 ? 'ctx-danger' : ctxPct > 60 ? 'ctx-warn' : '';
  const ctxBar = (dhShow('contextwindow') && ctxPct > 0)
    ? '<div class="context-bar" title="Context ' + Math.round(ctxPct) + '%"><div class="context-bar-fill ' + ctxCls + '" style="transform:scaleX(' + (Math.min(ctxPct, 100) / 100).toFixed(2) + ')"></div></div>'
    : '';
  const statsHtml = '<div class="card-stats">' + statParts.join('') + '</div>' + ctxBar;

  const ioHtml = isSiblingSession(s) ? '' : renderCardIo(s);
  // The collapsed face already shows the pending question as its summary; the
  // open card then keeps only the choices, not the same sentence twice.
  const faceSummary = cardSummary(s, col, s.displayHeadline || s.summaryTitle || s.title);
  // Pending question (choice buttons for waiting sessions)
  let questionHtml = '';
  if (s.pendingQuestion && col === 'waiting') {
    if (s.pendingQuestion.type === 'user_choice' && s.pendingQuestion.choices) {
      var pq = s.pendingQuestion;
      var recId = resolveRecommendedId(pq.recommendedChoiceId, pq.choices);
      var recOpt = recId ? pq.choices.find(function(c) { return c.id === recId; }) : null;
      var otherOpts = pq.choices.filter(function(c) { return !recOpt || c.id !== recOpt.id; });
      var recHtml = '';
      if (recOpt) {
        var recLabel = stripRecommendedMarker(recOpt.label);
        var recTitle = isOwner ? (recOpt.description || recLabel) : READ_ONLY_MSG;
        recHtml = '<div class="choice-row-recommended">'
          + '<button class="btn-choice btn-choice-recommended"' + readOnlyAttrs + choiceDataAttrs(s.key, recOpt.id, recLabel, pq.question) + ' title="' + escAttr(recTitle) + '">' + esc(recOpt.id) + '. ' + esc(recLabel) + '</button>'
          + '</div>'
          + (otherOpts.length > 0 ? '<hr class="choice-divider">' : '');
      }
      var otherBtns = otherOpts.map(function(c) {
        var lbl = stripRecommendedMarker(c.label);
        var btnTitle = isOwner ? (c.description || lbl) : READ_ONLY_MSG;
        return '<button class="btn-choice"' + readOnlyAttrs + choiceDataAttrs(s.key, c.id, lbl, pq.question) + ' title="' + escAttr(btnTitle) + '">' + esc(c.id) + '. ' + esc(lbl) + '</button>';
      }).join('');
      questionHtml = '<div class="card-question">'
        + (pq.question === faceSummary ? '' : '<div class="card-question-text">&#x2753; ' + esc(String(pq.question || '').slice(0, 80)) + '</div>')
        + '<div class="card-question-choices">' + recHtml + otherBtns + '</div>'
        + '</div>';
    } else if (s.pendingQuestion.type === 'user_choices') {
      questionHtml = renderMultiChoiceCard(s, faceSummary);
    }
  }

  // Action buttons — disabled for non-owners (server RBAC still rejects, but UI
  // shouldn't invite the click in the first place).
  // #814 — sibling cards (env.instanceName !== self) get a "open on sibling"
  // hint instead of action buttons. Posting Stop/Close/Trash to the local
  // instance for a sibling-owned key would fail server-side
  // (stripSelfInstancePrefix rejects foreign prefixes); rendering a clearly-
  // disabled button with a redirect title is honest UX.
  const isSibling = !!(SELF_INSTANCE_NAME && s.environment && s.environment.instanceName && s.environment.instanceName !== SELF_INSTANCE_NAME);
  const siblingTitle = isSibling
    ? ' title="' + escAttr('Open ' + s.environment.instanceName + ' (' + (s.environment.host || '') + ':' + (s.environment.port || '') + ') to act on this session') + '"'
    : '';
  const readOnlyTitle = isOwner ? '' : ' title="' + escAttr(READ_ONLY_MSG) + '"';
  let actionBtn = '';
  if (isSibling) {
    // Sibling card — emit a disabled placeholder so the layout is consistent
    // with same-instance cards but the click is impossible.
    var label = (col === 'working' && !pendingAutoResume(s, col)) ? 'Stop' : (col === 'closed' && s.terminated ? 'Trash' : 'Close');
    actionBtn = '<button class="btn-action btn-stop" disabled' + siblingTitle + '>' + label + ' \u2192 ' + esc(s.environment.instanceName) + '</button>';
  } else if (col === 'working' && !pendingAutoResume(s, col)) {
    actionBtn = '<button class="btn-action btn-stop"' + readOnlyAttrs + readOnlyTitle + ' onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'stop\\')">Stop</button>';
  } else if (col === 'waiting' || col === 'idle' || col === 'working') {
    // A RUNNING card waiting out a retry has no turn to stop — Close it
    // instead (terminating the session also drops the armed retry).

    actionBtn = '<button class="btn-action btn-close"' + readOnlyAttrs + readOnlyTitle + ' onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'close\\')">Close</button>';
  } else if (col === 'closed') {
    // SLEEPING (live) sessions → Close (terminate); archived sessions → Trash (hide)
    actionBtn = s.terminated
      ? '<button class="btn-action btn-trash"' + readOnlyAttrs + readOnlyTitle + ' onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'trash\\')">Trash</button>'
      : '<button class="btn-action btn-close"' + readOnlyAttrs + readOnlyTitle + ' onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'close\\')">Close</button>';
  }

  // 작업 로그 opens the slide panel (details + message box) scrolled to the work
  // log — for every card; without a conversation the log reads "작업 로그 없음".
  const worklogBtn = '<button type="button" class="btn-action btn-primary" onclick="event.stopPropagation();openPanel(\\'' + escJs(s.key) + '\\',true)">작업 로그</button>';
  const slackBtn = (dhShow('links') && s.slackThreadUrl)
    ? '<a class="btn-action" href="' + safeHref(s.slackThreadUrl) + '" target="_blank" rel="noopener">Slack</a>'
    : '';
  const actionsHtml = '<div class="card-actions">' + actionBtn + slackBtn + worklogBtn + '</div>';

  return '<div class="card-body">'
    + modelHtml
    + metaHtml
    + refsHtml
    + subtitlesHtml
    + renderCardResume(s, col)
    + renderCardGoal(s, col, isOwner && !isSibling)
    + renderTimeline(s)
    + ioHtml
    + questionHtml
    + statsHtml
    + actionsHtml
    + '</div>';
}

// ── Model switch on the open card (SSOT 2026-10-22 T4/T5) ──
// A <select> of the representative models (REPRESENTATIVE_MODELS). An option
// whose auto-compact threshold is below what the context holds now says the
// switch compacts first: the server compacts on the current model and switches
// at the compact's boundary (the card shows the waiting switch meanwhile).
var _modelNotes = Object.create(null); // card key → { text, error }
function renderModelPicker(s, canSwitch, modelShort) {
  var models = REPRESENTATIVE_MODELS || [];
  var current = null;
  for (var i = 0; i < models.length; i++) if (models[i].model === s.model) current = models[i];
  if (!canSwitch || !models.length) return '<span class="cb-model-name">' + modelShort + '</span>';
  var used = toNum(s.contextTokens);
  var opts = '';
  if (!current) opts += '<option value="" selected disabled>' + (modelShort || '모델 선택') + '</option>';
  for (var j = 0; j < models.length; j++) {
    var m = models[j];
    var label = m.nickname + ' · autocompact ' + formatTokens(m.autoCompactTokens)
      + (m !== current && used > toNum(m.autoCompactTokens) ? ' · compact 후 전환' : '');
    opts += '<option value="' + escAttr(m.nickname) + '"' + (m === current ? ' selected' : '') + '>' + esc(label) + '</option>';
  }
  return '<select class="cb-model-select" aria-label="모델 변경"' + (s.pendingModel ? ' disabled' : '')
    + ' onclick="event.stopPropagation()" onchange="changeModel(\\'' + escJs(s.key) + '\\',this)">' + opts + '</select>';
}
function renderModelNote(s) {
  if (s.pendingModel) {
    return '<div class="cb-model-note" role="status">compact 후 ' + esc(s.pendingModel) + '(으)로 전환합니다…</div>';
  }
  var n = _modelNotes[s.key];
  if (!n) return '';
  return '<div class="cb-model-note' + (n.error ? ' is-error' : '') + '"' + (n.error ? ' role="alert"' : ' role="status"') + '>' + esc(n.text) + '</div>';
}
async function postModelSwitch(key, nickname) {
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/model';
  var body = JSON.stringify({ model: nickname });
  var headers = { 'Content-Type': 'application/json' };
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  var res = await fetch(url, { method: 'POST', headers: headers, body: body });
  if (res.status === 403) {
    await refreshCsrfToken();
    var retryHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
    res = await fetch(url, { method: 'POST', headers: retryHeaders, body: body });
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  return { ok: res.ok, result: data && data.result, error: (data && data.error) || ('HTTP ' + res.status) };
}
// What the card says after a switch request.
function modelSwitchNote(r) {
  if (!r.ok) return { text: r.error, error: true };
  var res = r.result || {};
  if (res.status === 'compacting') return { text: '컨텍스트가 ' + res.nickname + '의 autocompact ' + formatTokens(res.autoCompactTokens) + '보다 커서 지금 모델로 compact한 뒤 전환합니다', error: false };
  if (res.status === 'unchanged') return { text: '이미 ' + res.nickname + '입니다', error: false };
  return { text: res.nickname + '(으)로 전환 · autocompact ' + formatTokens(res.autoCompactTokens), error: false };
}
async function changeModel(key, select) {
  var nickname = select && select.value;
  if (!nickname) return;
  if (select) select.disabled = true;
  var r;
  try { r = await postModelSwitch(key, nickname); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  _modelNotes[key] = modelSwitchNote(r);
  if (select) { select.disabled = false; select.blur(); }
  refreshCard(key);
  loadSessions();
}

// ── Effort on the card and at the top of the session panel (SSOT 2026-10-23 T1) ──
// The owner picks one of the five levels; the session runs it from the next
// turn (the %effort scope — the owner's default stays). When the session's
// model caps the level, the note says what actually runs.
var EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
function effortLabel(level) {
  return EFFORT_LABELS[level] || String(level || '');
}
function renderEffortPicker(s, canSwitch) {
  var levels = EFFORT_LEVELS || [];
  var capped = s.effortEffective && s.effortEffective !== s.effort
    ? ' title="이 모델은 ' + escAttr(effortLabel(s.effortEffective)) + '까지 실행합니다"' : ' title="Reasoning effort"';
  if (!canSwitch || !levels.length) {
    return '<span class="meta-effort"' + capped + '>' + esc(effortLabel(s.effort))
      + (s.effortEffective && s.effortEffective !== s.effort ? ' &rarr; ' + esc(effortLabel(s.effortEffective)) : '') + '</span>';
  }
  var opts = '';
  for (var i = 0; i < levels.length; i++) {
    opts += '<option value="' + escAttr(levels[i]) + '"' + (levels[i] === s.effort ? ' selected' : '') + '>'
      + esc('Effort · ' + effortLabel(levels[i])) + '</option>';
  }
  return '<select class="cb-model-select cb-effort-select" aria-label="Effort 변경"' + capped
    + ' onclick="event.stopPropagation()" onchange="changeEffort(\\'' + escJs(s.key) + '\\',this)">' + opts + '</select>';
}
async function postEffortSwitch(key, effort) {
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/effort';
  var body = JSON.stringify({ effort: effort });
  var headers = { 'Content-Type': 'application/json' };
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  var res = await fetch(url, { method: 'POST', headers: headers, body: body });
  if (res.status === 403) {
    await refreshCsrfToken();
    var retryHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
    res = await fetch(url, { method: 'POST', headers: retryHeaders, body: body });
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  return { ok: res.ok, result: data && data.result, error: (data && data.error) || ('HTTP ' + res.status) };
}
// What the card says after an effort change.
function effortSwitchNote(r) {
  if (!r.ok) return { text: r.error, error: true };
  var res = r.result || {};
  if (res.status === 'unchanged') return { text: '이미 effort ' + effortLabel(res.effort) + '입니다', error: false };
  var capped = res.effective && res.effective !== res.effort ? ' (이 모델은 ' + effortLabel(res.effective) + '까지 실행)' : '';
  return { text: 'effort ' + effortLabel(res.effort) + ' · 다음 턴부터 적용' + capped, error: false };
}
async function changeEffort(key, select) {
  var effort = select && select.value;
  if (!effort) return;
  if (select) select.disabled = true;
  var r;
  try { r = await postEffortSwitch(key, effort); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  _modelNotes[key] = effortSwitchNote(r);
  if (select) { select.disabled = false; select.blur(); }
  refreshCard(key);
  loadSessions();
}
// The top of the session panel: this session's model and effort, one click each.
function renderPanelControls(s) {
  var el = document.getElementById('panel-controls');
  if (!el || !s) return;
  var a = document.activeElement;
  if (a && el.contains(a) && a.tagName === 'SELECT') return; // an open picker survives live updates
  var isOwner = !!s.ownerId && s.ownerId === currentUserId;
  var canSwitch = isOwner && !s.terminated && s.sessionState !== 'SLEEPING' && !isSiblingSession(s);
  var modelShort = esc(s.model || '').replace(/^claude-/, '').replace(/-\\d{8}$/, '');
  el.innerHTML = '<span class="pc-scope">이 세션</span>'
    + renderModelPicker(s, canSwitch, modelShort)
    + renderEffortPicker(s, canSwitch)
    + renderModelNote(s);
}

// ── Goal list on the work item (SSOT 2026-10-21 T2/T3) ──
// The card shows the current goal, its state and the goals queued behind it,
// and lets the owner add a goal, delete the current goal (the next queued one
// starts — never \`goal clear\`, which also drops the queue) or delete a queued
// goal. Every write names WHERE the goal was seen (current / queued), so a goal
// that moved in the meantime is refused (409) instead of deleting the wrong one.
var GOAL_STATUS_LABELS = { active: '진행 중', paused: '일시정지', complete: '완료' };
var GOAL_VIA_LABELS = { user: '직접 완료', 'eval-model': '평가 모델 완료' };
// SSOT 2026-10-22 T6 — completed goals open from the goal head, per card.
var _goalHistoryOpen = Object.create(null); // card key → completed goals shown
function formatGoalTime(ms) {
  var n = Number(ms) || 0;
  if (!n) return '';
  return new Date(n).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
// One completed goal: objective, then when it closed · time spent · tokens ·
// cost · continuation turns · how it closed, then the evaluator's reason.
function renderGoalHistory(history) {
  var items = (history || []).map(function(h) {
    var meta = [];
    var at = formatGoalTime(h.completedAt);
    if (at) meta.push('완료 ' + at);
    if (toNum(h.activeMsUsed) > 0) meta.push('소요 ' + formatDuration(toNum(h.activeMsUsed)));
    if (h.tokens !== undefined) meta.push(formatTokens(h.tokens) + ' tok');
    if (h.costUsd !== undefined) meta.push('$' + toNum(h.costUsd).toFixed(2));
    if (toNum(h.continuationCount) > 0) meta.push('이어하기 ' + toNum(h.continuationCount) + '회');
    if (h.completedVia) meta.push(esc(Object.prototype.hasOwnProperty.call(GOAL_VIA_LABELS, h.completedVia) ? GOAL_VIA_LABELS[h.completedVia] : h.completedVia));
    var reason = h.completionReason && h.completionReason !== 'user' ? h.completionReason : '';
    return '<li class="cg-h-item">'
      + '<div class="cg-h-obj">' + esc(h.objective) + '</div>'
      + (meta.length ? '<div class="cg-h-meta">' + meta.join(' &middot; ') + '</div>' : '')
      + (reason ? '<div class="cg-h-reason">' + esc(reason) + '</div>' : '')
      + '</li>';
  }).join('');
  return '<ol class="cg-history">' + items + '</ol>';
}
function toggleGoalHistory(key) {
  if (_goalHistoryOpen[key]) delete _goalHistoryOpen[key];
  else _goalHistoryOpen[key] = true;
  refreshCard(key);
}
var _goalErrors = Object.create(null); // card key -> last refused goal action (shown until the next success)

function renderCardGoal(s, col, canEdit) {
  var g = s.goal || null;
  var live = col !== 'closed' && !s.terminated;
  // Read-only viewers and closed sessions only see a goal list that exists.
  if (!g && !(canEdit && live)) return '';
  var editable = canEdit && live;
  var dis = editable ? '' : ' disabled';
  var key = escJs(s.key);
  var queue = (g && g.queue) || [];
  var cur = g && g.current;
  var html = '<div class="card-goal">';
  html += '<div class="cg-head"><span class="cg-label">&#x1F3AF; Goal</span>';
  if (cur) {
    html += '<span class="cg-status cg-' + escAttr(cur.status) + '">' + esc(GOAL_STATUS_LABELS[cur.status] || cur.status) + '</span>';
    if (cur.status === 'active' && toNum(cur.maxContinuations) > 0) {
      html += '<span class="cg-progress" title="자동 이어하기 횟수 / 상한">' + toNum(cur.continuationCount) + '/' + toNum(cur.maxContinuations) + '</span>';
    }
  }
  // T6: the completed goals open from the head (any viewer, any column).
  var doneCount = g ? toNum(g.completedCount) : 0;
  var historyOpen = doneCount > 0 && !!_goalHistoryOpen[s.key];
  if (doneCount > 0) {
    html += '<button type="button" class="cg-history-toggle" aria-expanded="' + (historyOpen ? 'true' : 'false') + '"'
      + ' onclick="event.stopPropagation();toggleGoalHistory(\\'' + key + '\\')">완료된 goal ' + doneCount + '개 '
      + (historyOpen ? '&#x25B2;' : '&#x25BC;') + '</button>';
  }
  html += '</div>';
  if (cur) {
    var dropLabel = queue.length ? '현재 goal 삭제 · 다음 시작' : '현재 goal 삭제';
    html += '<div class="cg-row"><div class="cg-objective" title="' + escAttr(cur.objective) + '">' + esc(cur.objective) + '</div>'
      + '<button type="button" class="cg-btn cg-danger"' + dis
      + ' onclick="event.stopPropagation();goalAction(\\'' + key + '\\',{action:\\'delete\\',goalId:\\'' + escJs(cur.goalId) + '\\',expect:\\'current\\'},this)">'
      + dropLabel + '</button></div>';
    if (cur.status === 'active' && cur.lastEvalReason) {
      html += '<div class="cg-gap">남은 것: ' + esc(String(cur.lastEvalReason).slice(0, 300)) + '</div>';
    }
  } else {
    html += '<div class="cg-empty">현재 goal 없음</div>';
  }
  if (queue.length) {
    html += '<div class="cg-queue-title">대기 중인 goal ' + queue.length + '개</div><ol class="cg-queue">';
    for (var i = 0; i < queue.length; i++) {
      var q = queue[i];
      html += '<li><div class="cg-row"><span class="cg-q-text">' + esc(q.objective) + '</span>'
        + '<button type="button" class="cg-btn cg-danger" title="대기 goal 삭제" aria-label="대기 goal 삭제"' + dis
        + ' onclick="event.stopPropagation();goalAction(\\'' + key + '\\',{action:\\'delete\\',goalId:\\'' + escJs(q.goalId) + '\\',expect:\\'queued\\'},this)">삭제</button></div></li>';
    }
    html += '</ol>';
  }
  // The completed goals open under the current goal and its queue (T6).
  if (historyOpen) html += '<div class="cg-queue-title">완료된 goal</div>' + renderGoalHistory(g.history);
  if (editable) {
    html += '<form class="cg-add" onsubmit="event.preventDefault();event.stopPropagation();addGoalFromCard(\\'' + key + '\\',this)">'
      + '<input class="cg-add-input" name="objective" maxlength="4000" autocomplete="off" aria-label="goal 추가"'
      + ' placeholder="' + (cur && cur.status !== 'complete' ? 'goal 추가 (현재 goal 다음에 시작)' : 'goal 추가 (바로 시작)') + '"'
      + ' onblur="goalInputBlur(\\'' + key + '\\')">'
      + '<button type="submit" class="cg-btn">추가</button></form>';
  }
  if (_goalErrors[s.key]) html += '<div class="cg-error" role="alert">' + esc(_goalErrors[s.key]) + '</div>';
  return html + '</div>';
}

// The goal input survives the card's live re-render: while it has focus the
// body is not replaced at all (typing and IME composition stay intact), and an
// unfocused draft is carried into the new body.
function isEditingGoal(root) {
  var a = document.activeElement;
  return !!(a && a.classList && a.classList.contains('cg-add-input') && root.contains(a));
}
// An open model <select> survives live re-renders the same way (T4).
function isPickingModel(root) {
  var a = document.activeElement;
  return !!(a && a.classList && a.classList.contains('cb-model-select') && root.contains(a));
}
function captureGoalDraft(root) {
  var input = root.querySelector('.cg-add-input');
  return input && input.value ? input.value : '';
}
function restoreGoalDraft(root, value) {
  if (!value) return;
  var input = root.querySelector('.cg-add-input');
  if (input && !input.value) input.value = value;
}
function goalInputBlur(key) {
  // Let a click on 추가 land before the deferred re-render replaces the form.
  setTimeout(function() {
    var el = _cardEls[key];
    if (el && !isEditingGoal(el._bodyEl)) refreshCard(key);
  }, 200);
}

async function postGoalAction(key, payload) {
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/goal';
  var body = JSON.stringify(payload);
  var headers = { 'Content-Type': 'application/json' };
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  var res = await fetch(url, { method: 'POST', headers: headers, body: body });
  if (res.status === 403) {
    await refreshCsrfToken();
    var retryHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
    res = await fetch(url, { method: 'POST', headers: retryHeaders, body: body });
  }
  var data = null;
  try { data = await res.json(); } catch (_e) {}
  return { ok: res.ok, error: (data && data.error) || ('HTTP ' + res.status) };
}
function setGoalError(key, message) {
  if (message) _goalErrors[key] = message;
  else delete _goalErrors[key];
  refreshCard(key);
}
async function goalAction(key, payload, btn) {
  if (btn) btn.disabled = true;
  var r;
  try { r = await postGoalAction(key, payload); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  setGoalError(key, r.ok ? '' : r.error);
  if (!r.ok && btn) btn.disabled = false;
  loadSessions();
}
// One add in flight per card. The input is NOT disabled while it is sent:
// keeping its focus is what keeps a live re-render from replacing the form
// (and resurrecting the sent text as a fresh, submittable draft).
var _goalAdding = Object.create(null);
async function addGoalFromCard(key, form) {
  if (_goalAdding[key]) return;
  var input = form.querySelector('.cg-add-input');
  var objective = input ? input.value.trim() : '';
  if (!objective) return;
  _goalAdding[key] = true;
  var btn = form.querySelector('button');
  if (btn) btn.disabled = true;
  var r;
  try { r = await postGoalAction(key, { action: 'add', objective: objective }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  delete _goalAdding[key];
  // The form on screen may have been re-rendered meanwhile — act on the live one.
  var el = _cardEls[key];
  var live = (el && el._bodyEl.querySelector('.cg-add-input')) || input;
  var liveBtn = live.form ? live.form.querySelector('button') : btn;
  if (liveBtn) liveBtn.disabled = false;
  if (btn && btn !== liveBtn) btn.disabled = false;
  if (r.ok) {
    if (live.value.trim() === objective) live.value = '';
    live.blur();
  }
  setGoalError(key, r.ok ? '' : r.error);
  loadSessions();
}

// Card click = expand / collapse in place (§3.1-4). Keyboard toggles skip the
// transition (§4-9). Cards below ride the animated grid row, so they slide
// with the expansion instead of needing a separate FLIP pass.
function toggleCard(key, instant) {
  var el = _cardEls[key];
  if (!el) return;
  var open = !_expanded.has(key);
  if (open) _expanded.add(key);
  else _expanded.delete(key);
  if (!open) releaseCardIoTimer(el._cid);
  if (instant) el.classList.add('no-motion');
  applyExpanded(el, open);
  if (instant) {
    void el.offsetHeight;
    el.classList.remove('no-motion');
  }
  if (open) ensureCardIo(key, true);
}

// Board ↔ List (§3.1-2, §4-4): CSS re-lays out the very same nodes and each
// card / column header FLIPs from its old slot (translate only). The choice is
// remembered only when the user makes it; keyboard activation does not animate.
function setBoardView(view, ev) {
  if (view !== 'board' && view !== 'list') return;
  if (ev) {
    try { localStorage.setItem('soma-board-view', view); } catch (_e) {}
  }
  var segs = document.querySelectorAll('.seg-btn');
  for (var i = 0; i < segs.length; i++) {
    var pressed = segs[i].getAttribute('data-view') === view ? 'true' : 'false';
    if (segs[i].getAttribute('aria-pressed') !== pressed) segs[i].setAttribute('aria-pressed', pressed);
  }
  var kb = document.getElementById('kanban');
  if (kb.getAttribute('data-view') === view) return;
  var movers = (ev && ev.detail > 0 && canAnimate()) ? collectViewMovers() : null;
  var before = movers ? movers.map(function(m) { return m.getBoundingClientRect(); }) : null;
  kb.setAttribute('data-view', view);
  if (!movers) return;
  if (reduceMotion()) {
    kb.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fade, easing: 'linear' });
    return;
  }
  for (var j = 0; j < movers.length; j++) {
    var el = movers[j];
    if (el._flip) { el._flip.cancel(); el._flip = null; }
    var b = el.getBoundingClientRect();
    var dx = before[j].left - b.left;
    var dy = before[j].top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    playFlip(el, dx, dy, false);
  }
}
function collectViewMovers() {
  var out = [];
  var heads = document.querySelectorAll('#kanban .kanban-col-header');
  for (var i = 0; i < heads.length; i++) out.push(heads[i]);
  for (var k in _cardEls) out.push(_cardEls[k]);
  return out;
}

// ── Show archives (.prd/10 §3.1-1) — archived (terminated) cards are hidden
// unless the user turned them on (localStorage['soma-show-archives'] = 'on').
// The button sits in the board header and only appears while the board holds
// at least one archive. ──
var SHOW_ARCHIVES_KEY = 'soma-show-archives';
function readShowArchives() {
  try { return localStorage.getItem(SHOW_ARCHIVES_KEY) === 'on'; } catch (_e) { return false; }
}
var showArchives = readShowArchives();
// A deep link to a hidden archive shows that one card for this page load
// without touching the stored choice; the user's own toggle ends it.
var _revealedKey = null;
function toggleArchives() {
  showArchives = !showArchives;
  _revealedKey = null;
  try { localStorage.setItem(SHOW_ARCHIVES_KEY, showArchives ? 'on' : 'off'); } catch (_e) {}
  loadSessions();
}
// A toggle button: the label stays "Archives (N)" (N = archives on the board)
// and aria-pressed carries on / off — pressed it wears the selected-segment look.
function renderArchivesToggle(archivedCount) {
  var btn = document.getElementById('archives-toggle');
  var label = document.getElementById('archives-label');
  if (!btn || !label) return;
  var hide = archivedCount === 0;
  if (btn.hidden !== hide) btn.hidden = hide;
  var pressed = showArchives ? 'true' : 'false';
  if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
  setTextIfChanged(label, 'Archives (' + archivedCount + ')');
}

// ── Sleeping — the same on / off toggle for sleeping (closed, not archived)
// cards. Shown by default, as before this toggle existed; the choice persists
// in localStorage['soma-show-sleeping'] ('on' / 'off'). ──
var SHOW_SLEEPING_KEY = 'soma-show-sleeping';
function readShowSleeping() {
  try { return localStorage.getItem(SHOW_SLEEPING_KEY) !== 'off'; } catch (_e) { return true; }
}
var showSleeping = readShowSleeping();
function toggleSleeping() {
  showSleeping = !showSleeping;
  _revealedKey = null;
  try { localStorage.setItem(SHOW_SLEEPING_KEY, showSleeping ? 'on' : 'off'); } catch (_e) {}
  loadSessions();
}
function renderSleepingToggle(sleepingCount) {
  var btn = document.getElementById('sleeping-toggle');
  var label = document.getElementById('sleeping-label');
  if (!btn || !label) return;
  var hide = sleepingCount === 0;
  if (btn.hidden !== hide) btn.hidden = hide;
  var pressed = showSleeping ? 'true' : 'false';
  if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
  setTextIfChanged(label, 'Sleeping (' + sleepingCount + ')');
}

// ── Session lifecycle policy (sleep / archive / board windows). The board
// response carries it; admins edit it in the Lifecycle dialog (PUT
// /api/dashboard/lifecycle, which the server only accepts from an admin with
// Admin mode on). Sleep and the board archive window are edited in hours, the
// archive time in days. ──
var _lifecycle = null;
// The request body the Save button is armed to force (?confirm=1), or null.
var _lifecycleArmed = null;
function armLifecycleSave(body) {
  _lifecycleArmed = body;
  var btn = document.getElementById('lifecycle-save');
  if (btn) btn.textContent = body ? '그래도 저장' : '저장';
}
// [form field, policy field, ms per form unit]
var LIFECYCLE_FIELDS = [['sleepAfterHours', 'sleepAfterMs', 3600000], ['archiveAfterDays', 'archiveAfterMs', 86400000], ['boardArchiveWindowHours', 'boardArchiveWindowMs', 3600000]];
// Pure: policy (ms) → form values.
function lifecycleToForm(p) {
  var out = {};
  for (var i = 0; i < LIFECYCLE_FIELDS.length; i++) {
    var f = LIFECYCLE_FIELDS[i];
    out[f[0]] = Math.round((p[f[1]] / f[2]) * 100) / 100;
  }
  return out;
}
// Pure: form values → { ok, patch } in ms (whole minutes), or { ok: false, field }
// naming the first field that is not a non-negative number. Bounds are the
// server's job; it answers 400 with the field.
function lifecycleFromForm(form) {
  var patch = {};
  for (var i = 0; i < LIFECYCLE_FIELDS.length; i++) {
    var f = LIFECYCLE_FIELDS[i];
    var raw = form[f[0]];
    var n = typeof raw === 'number' ? raw : (String(raw == null ? '' : raw).trim() === '' ? NaN : Number(raw));
    if (!isFinite(n) || n < 0) return { ok: false, field: f[0] };
    patch[f[1]] = Math.round((n * f[2]) / 60000) * 60000;
  }
  return { ok: true, patch: patch };
}
function openLifecycleDialog() {
  var dlg = document.getElementById('lifecycle-dialog');
  if (!dlg || !_lifecycle) return;
  var form = lifecycleToForm(_lifecycle);
  for (var k in form) {
    var input = document.getElementById('lc-' + k);
    if (input) input.value = String(form[k]);
  }
  armLifecycleSave(null);
  setTextIfChanged(document.getElementById('lifecycle-scope'), SELF_INSTANCE_NAME ? '이 인스턴스(' + SELF_INSTANCE_NAME + ')' : '이 인스턴스');
  setLifecycleStatus(_lifecycle.degraded ? '저장된 정책 파일을 읽을 수 없어 Sleeping/종료 전환을 멈춘 상태입니다. 저장하면 다시 시작합니다.' : '', !!_lifecycle.degraded);
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}
function closeLifecycleDialog() {
  var dlg = document.getElementById('lifecycle-dialog');
  if (!dlg) return;
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}
function setLifecycleStatus(text, isError) {
  var el = document.getElementById('lifecycle-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', !!isError);
}
var LIFECYCLE_LABELS = {
  sleepAfterHours: 'Sleeping 전환', archiveAfterDays: 'Archive 전환', boardArchiveWindowHours: 'Archive 표시 기간',
  sleepAfterMs: 'Sleeping 전환', archiveAfterMs: 'Archive 전환', boardArchiveWindowMs: 'Archive 표시 기간',
};
async function saveLifecycle(ev) {
  if (ev) ev.preventDefault();
  var form = {};
  for (var i = 0; i < LIFECYCLE_FIELDS.length; i++) {
    var input = document.getElementById('lc-' + LIFECYCLE_FIELDS[i][0]);
    form[LIFECYCLE_FIELDS[i][0]] = input ? input.value : '';
  }
  var parsed = lifecycleFromForm(form);
  if (!parsed.ok) { setLifecycleStatus(LIFECYCLE_LABELS[parsed.field] + ': 0 이상의 숫자를 입력하세요.', true); return; }
  // Send only what the admin changed: the dialog shows rounded values, and
  // re-saving an untouched field must not rewrite it.
  var shown = lifecycleToForm(_lifecycle || {});
  for (var j = 0; j < LIFECYCLE_FIELDS.length; j++) {
    if (Number(form[LIFECYCLE_FIELDS[j][0]]) === shown[LIFECYCLE_FIELDS[j][0]]) delete parsed.patch[LIFECYCLE_FIELDS[j][1]];
  }
  if (Object.keys(parsed.patch).length === 0) { closeLifecycleDialog(); return; }
  // The server answers 409 with counts when the change would sleep or end live
  // sessions. The dialog shows them and arms the Save button; saving the same
  // values again sends ?confirm=1. Any edit disarms it.
  var body = JSON.stringify(parsed.patch);
  var force = _lifecycleArmed === body;
  setLifecycleStatus('저장 중…', false);
  try {
    var send = function() {
      var headers = { 'Content-Type': 'application/json' };
      if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
      var url = '/api/dashboard/lifecycle' + (force ? '?confirm=1' : '');
      return fetch(url, { method: 'PUT', headers: headers, body: body });
    };
    var res = await send();
    if (res.status === 403 && !_isAdminModeOn()) {
      setLifecycleStatus('Admin 모드를 ON으로 바꾼 뒤 저장하세요.', true);
      return;
    }
    if (res.status === 403) { await refreshCsrfToken(); res = await send(); }
    var data = await res.json().catch(function() { return {}; });
    if (res.status === 409 && data && data.needsConfirm) {
      armLifecycleSave(body);
      setLifecycleStatus('이 값으로 저장하면 다음 정리 주기에 ' + (data.willSleep || 0) + '개 세션이 Sleeping으로, '
        + (data.willArchive || 0) + '개 세션이 종료(Archive)됩니다. 종료는 되돌릴 수 없습니다. 그래도 저장하려면 한 번 더 누르세요.', true);
      return;
    }
    armLifecycleSave(null);
    if (!res.ok) {
      var why = data && data.field ? LIFECYCLE_LABELS[data.field] + ' 값이 허용 범위를 벗어났습니다.' : (data && data.error) || ('저장 실패 (' + res.status + ')');
      setLifecycleStatus(why, true);
      return;
    }
    _lifecycle = data.lifecycle;
    closeLifecycleDialog();
    loadSessions();
  } catch (e) {
    setLifecycleStatus('저장 실패: 네트워크 오류', true);
  }
}

// Deep link (§3.1-8): /dashboard/<ownerId>?session=<sessionKey> opens that card
// and the panel at its work log once the board has data. Slack links carry the
// registry key WITHOUT the #814 instance prefix ("work:C123:1700000000.000100"),
// while board cards are keyed "<instanceName>::work:C123:…" (composeSessionKey).
// Until a card matches (board still loading, sibling instance), retry on each
// board render for ~10 s, then give up silently.
var DEEP_LINK_WINDOW_MS = 10000;
var _deepLinkSession = (function() {
  try { return new URLSearchParams(location.search).get('session'); } catch (_e) { return null; }
})();
var _deepLinkDeadline = Date.now() + DEEP_LINK_WINDOW_MS;
// Pure: which board key does a ?session= value point at? Exact key first, then
// this instance's prefixed key, then the one card whose key ends in "::<ref>".
// Ambiguous suffix matches (same thread on two siblings) resolve to nothing.
function resolveDeepLinkKey(ref, keys, selfInstance) {
  if (!ref) return null;
  if (keys.indexOf(ref) >= 0) return ref;
  if (selfInstance && keys.indexOf(selfInstance + '::' + ref) >= 0) return selfInstance + '::' + ref;
  var suffix = '::' + ref;
  var hits = keys.filter(function(k) { return k.length > suffix.length && k.slice(-suffix.length) === suffix; });
  if (hits.length) return hits.length === 1 ? hits[0] : null;
  // No live card: the thread's latest archive. archivedToKanban keys it
  // "[<instance>::]archived_<registry key>_<archivedAt ms>".
  var mark = 'archived_' + ref + '_';
  var best = null;
  var bestAt = -1;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var at = k.indexOf(mark);
    if (at < 0 || (at > 0 && k.slice(at - 2, at) !== '::')) continue;
    var tail = k.slice(at + mark.length);
    if (!/^[0-9]+$/.test(tail)) continue;
    if (Number(tail) > bestAt) { bestAt = Number(tail); best = k; }
  }
  return best;
}
function openDeepLinkedSession() {
  if (!_deepLinkSession) return;
  // The window bounds the whole attempt: a card that first shows up on a
  // later poll (30 s) must not pop the panel open long after page load.
  if (Date.now() > _deepLinkDeadline) { _deepLinkSession = null; return; }
  var key = resolveDeepLinkKey(_deepLinkSession, Object.keys(_sessionCache), SELF_INSTANCE_NAME);
  if (!key) return;
  if (!_cardEls[key]) {
    // A card hidden by the Archives / Sleeping toggle (any age): show just this
    // card for this page load — the stored choice stays as it is — and retry on
    // that render.
    var linked = _sessionCache[key];
    var hiddenByToggle = linked && (linked.terminated === true ? !showArchives : !showSleeping);
    if (hiddenByToggle && _revealedKey !== key) {
      _revealedKey = key;
      loadSessions();
      return;
    }
    // In a closed DONE day (T12) — open that day and retry on that render.
    var day = linked ? dayKeyOf(doneTimeOf(linked)) : null;
    if (day && _doneGroupOpen[day] !== true) {
      _doneGroupOpen[day] = true;
      loadSessions();
    } else {
      _deepLinkSession = null;
    }
    return;
  }
  _deepLinkSession = null;
  if (!_expanded.has(key)) toggleCard(key, true);
  _cardEls[key].scrollIntoView({ block: 'center' });
  openPanel(key, true);
}

// The poll returns this instance's board merged with sibling instances' (#814);
// a WS session_update carries only this instance's. Keep the last polled board
// so a push re-attaches the sibling cards instead of animating them out.
var _lastPolledBoard = null;
function mergeSiblingCards(board) {
  if (!_lastPolledBoard) return board;
  var out = {};
  ['working', 'waiting', 'idle', 'closed'].forEach(function(col) {
    var mine = board[col] || [];
    var have = new Set(mine.map(function(s) { return s.key; }));
    var sibs = (_lastPolledBoard[col] || []).filter(function(s) { return isSiblingSession(s) && !have.has(s.key); });
    // Same shape as the server merge: this instance's cards, then siblings'.
    out[col] = mine.concat(sibs);
  });
  return out;
}

async function loadSessions() {
  try {
    const url = '/api/dashboard/sessions' + (currentUserId ? '?userId=' + currentUserId : '');
    const res = await fetch(url);
    const data = await res.json();
    _lastPolledBoard = data.board;
    if (data.lifecycle) _lifecycle = data.lifecycle;
    renderBoard(data.board);
    if (panelOpen && panelSessionKey && _sessionCache[panelSessionKey]) renderPanelControls(_sessionCache[panelSessionKey]);
  } catch (e) { console.error('Failed to load sessions', e); }
}

// ── Action handler (with CSRF retry on 403 after JWT rotation) ──
async function doAction(key, action) {
  try {
    const headers = {};
    if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
    const url = '/api/dashboard/session/' + encodeURIComponent(key) + '/' + action;
    let res = await fetch(url, { method: 'POST', headers });
    if (res.status === 403) {
      await refreshCsrfToken();
      const retryHeaders = {};
      if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
      res = await fetch(url, { method: 'POST', headers: retryHeaders });
    }
    if (!res.ok) console.error('Action failed', action, key);
    else loadSessions();
  } catch (e) { console.error('Action error', e); }
}

// ── Answer choice from dashboard ──
async function answerChoice(key, choiceId, label, question, btnEl) {
  try {
    // Disable all choice buttons in the same card or panel to prevent double-click
    var card = btnEl.closest('.card') || btnEl.closest('.panel-question-choices') || btnEl.closest('#panel-question');
    if (card) {
      card.querySelectorAll('.btn-choice').forEach(function(b) { b.disabled = true; });
    }
    btnEl.textContent = '...';

    const choiceHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) choiceHeaders['X-CSRF-Token'] = _csrfToken;
    const choiceUrl = '/api/dashboard/session/' + encodeURIComponent(key) + '/answer-choice';
    const choiceBody = JSON.stringify({ choiceId: choiceId, label: label, question: question });
    let res = await fetch(choiceUrl, { method: 'POST', headers: choiceHeaders, body: choiceBody });
    if (res.status === 403) {
      await refreshCsrfToken();
      const retryHeaders = { 'Content-Type': 'application/json' };
      if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
      res = await fetch(choiceUrl, { method: 'POST', headers: retryHeaders, body: choiceBody });
    }
    if (!res.ok) {
      var errData = {};
      try { errData = await res.json(); } catch(_) {}
      var errMsg = errData.error || 'Failed (status ' + res.status + ')';
      console.error('Answer choice failed', key, choiceId, errMsg);
      // Show error briefly, then re-enable buttons for retry
      btnEl.textContent = errMsg;
      btnEl.style.color = 'var(--red)';
      setTimeout(function() {
        if (card) {
          card.querySelectorAll('.btn-choice').forEach(function(b) { b.disabled = false; });
        }
        btnEl.textContent = choiceId + '. ' + label;
        btnEl.style.color = '';
      }, 2500);
    } else {
      // On success, the WebSocket session_update SHOULD re-render the board and
      // replace these buttons. But if the WS message is delayed/dropped, the
      // user is stuck with permanently disabled buttons. Fallback: re-enable
      // after 5s if the card is still in the DOM (i.e. not re-rendered).
      setTimeout(function() {
        if (card && card.isConnected) {
          card.querySelectorAll('.btn-choice').forEach(function(b) {
            if (b.disabled) b.disabled = false;
          });
          if (btnEl.isConnected && btnEl.textContent === '...') {
            btnEl.textContent = choiceId + '. ' + label;
          }
        }
      }, 5000);
    }
  } catch (e) {
    console.error('Answer choice error', e);
    // Re-enable buttons on network error so user can retry
    var errCard = btnEl.closest('.card') || btnEl.closest('.panel-question-choices') || btnEl.closest('#panel-question');
    if (errCard) {
      errCard.querySelectorAll('.btn-choice').forEach(function(b) { b.disabled = false; });
    }
    btnEl.textContent = choiceId + '. ' + label;
  }
}

// ── Multi-choice form state ──
var _mcState = Object.create(null);

// faceSummary: the collapsed card's summary line — when it already reads the
// form's title, the open card does not repeat it.
function renderMultiChoiceCard(s, faceSummary) {
  var q = s.pendingQuestion;
  if (!q || !q.questions) {
    console.warn('renderMultiChoiceCard: missing questions data for session', s.key);
    return '<div class="card-question"><div class="card-question-text" style="color:var(--text-secondary)">\\u26A0\\uFE0F Multi-choice data unavailable</div></div>';
  }
  var total = q.questions.length;
  var st = _mcState[s.key] || { selections: {}, activeQ: 0 };
  var answered = 0;
  for (var i = 0; i < q.questions.length; i++) {
    if (st.selections[q.questions[i].id]) answered++;
  }
  var progressText = answered + '/' + total + ' \\uC644\\uB8CC';
  return '<div class="card-question">'
    + ((q.title || q.question) && (q.title || q.question) === faceSummary ? '' : '<div class="card-question-text">\\uD83D\\uDCCB ' + esc(q.title || q.question || '\\uBCF5\\uC218 \\uC9C8\\uBB38') + '</div>')
    + '<div class="card-question-multi">' + total + '\\uAC1C \\uC9C8\\uBB38 \\u00B7 ' + progressText + '</div>'
    + '<div style="margin-top:6px"><button class="btn-choice" onclick="event.stopPropagation();openPanel(\\'' + escJs(s.key) + '\\')" style="width:100%;text-align:center;font-weight:700">\\uB2F5\\uBCC0\\uD558\\uAE30</button></div>'
    + '</div>';
}

function renderMultiChoicePanel(s) {
  var container = document.getElementById('panel-question');
  if (!container) return;
  var q = s.pendingQuestion;
  if (!q || !q.questions) {
    console.warn('renderMultiChoicePanel: missing questions data for session', s.key);
    container.style.display = '';
    container.innerHTML = '<div class="mc-form"><p style="color:var(--red);padding:12px">\\u26A0\\uFE0F Multi-choice questions could not be loaded. Try refreshing.</p></div>';
    return;
  }

  container.style.display = '';
  var key = s.key;
  if (!_mcState[key]) { _mcState[key] = { selections: {}, activeQ: 0 }; }
  var st = _mcState[key];
  var total = q.questions.length;
  var answered = 0;
  for (var i = 0; i < total; i++) {
    if (st.selections[q.questions[i].id]) answered++;
  }

  var html = '<div class="mc-form">';

  // Header
  html += '<div class="mc-header">';
  html += '<h4>' + esc(q.title || q.question || '\\uBCF5\\uC218 \\uC9C8\\uBB38') + '</h4>';
  if (q.description) {
    html += '<p>' + renderMdBasic(q.description) + '</p>';
  }
  html += '</div>';

  // Hero "Submit All Recommended" — group-only one-click. N=count of questions
  // with a resolvable recommendation (excluding 직접입력 sentinel); M=total.
  // States: N==M primary | 0<N<M blocked sentinel | N==0 omitted.
  var heroM = total;
  var heroN = 0;
  for (var hi = 0; hi < total; hi++) {
    var hq = q.questions[hi];
    var rid = resolveRecommendedId(hq.recommendedChoiceId, hq.choices);
    if (rid && rid !== '\\uC9C1\\uC811\\uC785\\uB825') heroN++;
  }
  if (heroN > 0) {
    if (heroN === heroM) {
      html += '<button class="btn-hero-recommended" onclick="event.stopPropagation();submitAllRecommended(\\'' + escJs(key) + '\\')">'
        + '\\u2B50 \\uCD94\\uCC9C\\uB300\\uB85C \\uBAA8\\uB450 \\uC120\\uD0DD</button>';
    } else {
      html += '<button class="btn-hero-recommended" disabled aria-disabled="true" aria-label="\\uCD94\\uCC9C\\uC774 ' + heroN + '/' + heroM + '\\uAC1C\\uB9CC \\uC788\\uC5B4 \\uC77C\\uAD04 \\uCC98\\uB9AC \\uBD88\\uAC00">'
        + '\\uD83D\\uDD12 \\uCD94\\uCC9C \\uBD80\\uC871 (' + heroN + '/' + heroM + ')</button>';
    }
  }

  // Progress dots
  html += '<div class="mc-progress">';
  for (var d = 0; d < total; d++) {
    var dotCls = 'mc-progress-dot';
    if (st.selections[q.questions[d].id]) dotCls += ' filled';
    else if (d === st.activeQ) dotCls += ' active';
    html += '<span class="' + dotCls + '"></span>';
  }
  html += '<span class="mc-progress-text">' + answered + '/' + total + ' \\uC644\\uB8CC</span>';
  html += '</div>';

  // Questions
  html += '<div class="mc-questions">';
  for (var qi = 0; qi < total; qi++) {
    var qItem = q.questions[qi];
    var sel = st.selections[qItem.id];
    var qCls = 'mc-question';
    if (sel) qCls += ' selected';
    if (qi === st.activeQ && !sel) qCls += ' active';

    html += '<div class="' + qCls + '">';
    html += '<div class="mc-q-header"><span class="mc-q-num">Q' + (qi + 1) + '.</span> ' + esc(qItem.question) + '</div>';

    // Context (rich text)
    if (qItem.context) {
      html += '<div class="mc-q-context">' + renderMdBasic(qItem.context) + '</div>';
    }

    if (sel) {
      // Show selected answer with edit button
      html += '<div class="mc-q-selected">'
        + '<span>\\u2705</span>'
        + '<span class="mc-sel-label">' + esc(sel.label) + '</span>'
        + '<button class="mc-q-edit-btn" onclick="event.stopPropagation();editMc(\\'' + escJs(key) + '\\',' + qi + ')">\\uD83D\\uDD04 \\uBCC0\\uACBD</button>'
        + '</div>';
    } else {
      // Show choice buttons, recommended first
      html += '<div class="mc-q-choices">';
      var mcRecId = resolveRecommendedId(qItem.recommendedChoiceId, qItem.choices);
      var orderedChoices = [];
      if (mcRecId) {
        var mcRec = qItem.choices.find(function(c) { return c.id === mcRecId; });
        if (mcRec) orderedChoices.push(mcRec);
        for (var oi = 0; oi < qItem.choices.length; oi++) {
          if (qItem.choices[oi].id !== mcRecId) orderedChoices.push(qItem.choices[oi]);
        }
      } else {
        orderedChoices = qItem.choices.slice();
      }
      for (var ci = 0; ci < orderedChoices.length; ci++) {
        var ch = orderedChoices[ci];
        var chLbl = stripRecommendedMarker(ch.label);
        var desc = ch.description ? ' <span style="color:var(--text-tertiary);font-size:0.9em">&mdash; ' + esc(ch.description) + '</span>' : '';
        var isRecBtn = mcRecId && ch.id === mcRecId;
        html += '<button class="btn-choice' + (isRecBtn ? ' btn-choice-recommended' : '') + '"' + choiceDataAttrs(key, ch.id, chLbl, '') + ' data-mc-index="' + qi + '">'
          + esc(ch.id) + '. ' + esc(chLbl) + desc + '</button>';
      }
      html += '</div>';
      // Custom input
      html += '<div class="mc-custom-input">'
        + '<input type="text" id="mc-custom-' + qi + '" placeholder="\\uC9C1\\uC811\\uC785\\uB825..." onclick="event.stopPropagation()" onkeydown="if(event.key===\\'Enter\\'){event.stopPropagation();submitMcCustom(\\'' + escJs(key) + '\\',' + qi + ')}">'
        + '<button onclick="event.stopPropagation();submitMcCustom(\\'' + escJs(key) + '\\',' + qi + ')">\\uC785\\uB825</button>'
        + '</div>';
    }

    html += '</div>';
  }
  html += '</div>';

  // Action buttons
  var allAnswered = answered === total;
  html += '<div class="mc-actions">';
  html += '<button class="mc-btn-reset" onclick="event.stopPropagation();resetMultiChoice(\\'' + escJs(key) + '\\')">\\uCD08\\uAE30\\uD654</button>';
  html += '<button class="mc-btn-submit" onclick="event.stopPropagation();submitMultiChoice(\\'' + escJs(key) + '\\')"' + (allAnswered ? '' : ' disabled') + '>\\uC81C\\uCD9C\\uD558\\uAE30 (' + answered + '/' + total + ')</button>';
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;
}

function renderMdBasic(text) {
  if (!text) return '';
  // Escape HTML first
  var s = esc(text);
  // Bold: **text**
  s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  // Italic: *text*
  s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  // Inline code: \`code\`
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Links: [text](url) — only allow http(s) protocol; escAttr on URL to prevent attribute injection
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g, function(_, text, url) {
    return '<a href="' + escAttr(url) + '" target="_blank" rel="noopener">' + text + '</a>';
  });
  // Newlines
  s = s.replace(/\\n/g, '<br>');
  return s;
}

function selectMc(key, qIdx, choiceId, label) {
  if (!_mcState[key]) _mcState[key] = { selections: {}, activeQ: 0 };
  var s = _sessionCache[key];
  if (!s || !s.pendingQuestion || !s.pendingQuestion.questions) { console.warn('selectMc: stale session data', key); return; }
  var qItem = s.pendingQuestion.questions[qIdx];
  if (!qItem) { console.warn('selectMc: invalid question index', qIdx); return; }

  _mcState[key].selections[qItem.id] = { choiceId: choiceId, label: label };

  // Auto-advance to next unanswered question
  var total = s.pendingQuestion.questions.length;
  var nextQ = -1;
  for (var i = 1; i <= total; i++) {
    var idx = (qIdx + i) % total;
    var qId = s.pendingQuestion.questions[idx].id;
    if (!_mcState[key].selections[qId]) { nextQ = idx; break; }
  }
  if (nextQ >= 0) {
    _mcState[key].activeQ = nextQ;
  }

  renderMultiChoicePanel(s);
}

function editMc(key, qIdx) {
  if (!_mcState[key]) return;
  var s = _sessionCache[key];
  if (!s || !s.pendingQuestion || !s.pendingQuestion.questions) return;
  var qItem = s.pendingQuestion.questions[qIdx];
  if (!qItem) return;
  delete _mcState[key].selections[qItem.id];
  _mcState[key].activeQ = qIdx;
  renderMultiChoicePanel(s);
}

function submitMcCustom(key, qIdx) {
  var input = document.getElementById('mc-custom-' + qIdx);
  if (!input) return;
  var val = input.value.trim();
  if (!val) { input.style.borderColor = 'var(--red)'; return; }
  if (!_mcState[key]) _mcState[key] = { selections: {}, activeQ: 0 };
  var s = _sessionCache[key];
  if (!s || !s.pendingQuestion || !s.pendingQuestion.questions) { console.warn('submitMcCustom: stale session data', key); return; }
  var qItem = s.pendingQuestion.questions[qIdx];
  if (!qItem) { console.warn('submitMcCustom: invalid question index', qIdx); return; }

  _mcState[key].selections[qItem.id] = { choiceId: '\\uC9C1\\uC811\\uC785\\uB825', label: val };

  // Auto-advance
  var total = s.pendingQuestion.questions.length;
  var nextQ = -1;
  for (var i = 1; i <= total; i++) {
    var idx = (qIdx + i) % total;
    var qId = s.pendingQuestion.questions[idx].id;
    if (!_mcState[key].selections[qId]) { nextQ = idx; break; }
  }
  if (nextQ >= 0) _mcState[key].activeQ = nextQ;

  renderMultiChoicePanel(s);
}

async function submitMultiChoice(key) {
  var s = _sessionCache[key];
  if (!s || !s.pendingQuestion || !s.pendingQuestion.questions) {
    console.warn('submitMultiChoice: session data unavailable', key);
    alert('\\uC138\\uC158 \\uB370\\uC774\\uD130\\uB97C \\uBD88\\uB7EC\\uC62C \\uC218 \\uC5C6\\uC2B5\\uB2C8\\uB2E4. \\uD398\\uC774\\uC9C0\\uB97C \\uC0C8\\uB85C\\uACE0\\uCE68\\uD574\\uC8FC\\uC138\\uC694.');
    return;
  }
  var st = _mcState[key];
  if (!st) {
    console.warn('submitMultiChoice: no selections state', key);
    alert('\\uC120\\uD0DD \\uC0C1\\uD0DC\\uAC00 \\uC5C6\\uC2B5\\uB2C8\\uB2E4. \\uB2E4\\uC2DC \\uC120\\uD0DD\\uD574\\uC8FC\\uC138\\uC694.');
    return;
  }

  // Validate all answered
  var total = s.pendingQuestion.questions.length;
  var answered = 0;
  for (var i = 0; i < total; i++) {
    if (st.selections[s.pendingQuestion.questions[i].id]) answered++;
  }
  if (answered < total) {
    alert('\\uBAA8\\uB4E0 \\uC9C8\\uBB38\\uC5D0 \\uB2F5\\uBCC0\\uD574\\uC8FC\\uC138\\uC694. (' + answered + '/' + total + ')');
    return;
  }

  // Disable ALL interactive elements in the multi-choice form to prevent further clicks
  var btns = document.querySelectorAll('.mc-btn-submit');
  btns.forEach(function(b) { b.disabled = true; b.textContent = '\\uC81C\\uCD9C \\uC911...'; });
  var mcForm = document.querySelector('.mc-form');
  if (mcForm) {
    mcForm.querySelectorAll('.btn-choice').forEach(function(b) { b.disabled = true; });
    mcForm.querySelectorAll('input').forEach(function(inp) { inp.disabled = true; });
    mcForm.querySelectorAll('button').forEach(function(b) { b.disabled = true; });
  }

  try {
    var mcHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) mcHeaders['X-CSRF-Token'] = _csrfToken;
    var mcUrl = '/api/dashboard/session/' + encodeURIComponent(key) + '/answer-multi-choice';
    var mcBody = JSON.stringify({ selections: st.selections });
    var res = await fetch(mcUrl, { method: 'POST', headers: mcHeaders, body: mcBody });
    if (res.status === 403) {
      await refreshCsrfToken();
      var mcRetryHeaders = { 'Content-Type': 'application/json' };
      if (_csrfToken) mcRetryHeaders['X-CSRF-Token'] = _csrfToken;
      res = await fetch(mcUrl, { method: 'POST', headers: mcRetryHeaders, body: mcBody });
    }
    if (!res.ok) {
      var errData = {};
      try { errData = await res.json(); } catch(_) {}
      var errMsg = errData.error || 'Failed (status ' + res.status + ')';
      alert('\\uC81C\\uCD9C \\uC2E4\\uD328: ' + errMsg);
      btns.forEach(function(b) { b.disabled = false; b.textContent = '\\uC81C\\uCD9C\\uD558\\uAE30 (' + total + '/' + total + ')'; });
      if (mcForm) {
        mcForm.querySelectorAll('.btn-choice').forEach(function(b) { b.disabled = false; });
        mcForm.querySelectorAll('input').forEach(function(inp) { inp.disabled = false; });
        mcForm.querySelectorAll('button').forEach(function(b) { b.disabled = false; });
      }
    } else {
      // Success — clear state; WebSocket will re-render
      delete _mcState[key];
    }
  } catch (e) {
    console.error('submitMultiChoice error', e);
    alert('\\uB124\\uD2B8\\uC6CC\\uD06C \\uC624\\uB958: ' + e.message);
    btns.forEach(function(b) { b.disabled = false; b.textContent = '\\uC81C\\uCD9C\\uD558\\uAE30 (' + total + '/' + total + ')'; });
    if (mcForm) {
      mcForm.querySelectorAll('.btn-choice').forEach(function(b) { b.disabled = false; });
      mcForm.querySelectorAll('input').forEach(function(inp) { inp.disabled = false; });
      mcForm.querySelectorAll('button').forEach(function(b) { b.disabled = false; });
    }
  }
}

function resetMultiChoice(key) {
  _mcState[key] = { selections: {}, activeQ: 0 };
  var s = _sessionCache[key];
  if (s) renderMultiChoicePanel(s);
}

// Hero "Submit All Recommended" — group-only one-click. Mirrors the CSRF retry
// pattern used by submitMultiChoice. Server derives selections from session
// state, so the request has no body — and therefore no Content-Type, like
// doAction: Fastify refuses a JSON Content-Type with an empty body (400).
async function submitAllRecommended(key) {
  var heroBtn = document.querySelector('.btn-hero-recommended');
  if (heroBtn) { heroBtn.disabled = true; heroBtn.setAttribute('aria-disabled', 'true'); }
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/submit-recommended';
  try {
    var headers = {};
    if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
    var res = await fetch(url, { method: 'POST', headers: headers });
    if (res.status === 403) {
      await refreshCsrfToken();
      var retryHeaders = {};
      if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
      res = await fetch(url, { method: 'POST', headers: retryHeaders });
    }
    if (!res.ok) {
      var errData = {};
      try { errData = await res.json(); } catch(_) {}
      var errMsg = errData.error || ('Failed (status ' + res.status + ')');
      alert('\\u274C ' + errMsg);
      if (heroBtn) { heroBtn.disabled = false; heroBtn.removeAttribute('aria-disabled'); }
    } else {
      // Success — clear local state; WebSocket will re-render.
      delete _mcState[key];
    }
  } catch (e) {
    console.error('submitAllRecommended error', e);
    alert('\\u274C ' + e.message);
    if (heroBtn) { heroBtn.disabled = false; heroBtn.removeAttribute('aria-disabled'); }
  }
}

// ── Stats ──
// Every number follows the selected period, for the selected user or — with
// no user (All Users) — for everyone: /api/dashboard/stats gives sessions,
// turns, PRs, merge lines, workflows and the charts; /api/dashboard/usage gives
// tokens (input + output) and cost. Each load takes a generation and paints
// only while it is still the latest, so an answer for a period or user that
// was since replaced is dropped (fast clicks end on the last selection).
var _statsGen = 0;
async function loadStats() {
  var gen = ++_statsGen;
  var q = 'period=' + encodeURIComponent(currentPeriod) + (currentUserId ? '&userId=' + encodeURIComponent(currentUserId) : '');
  updateTokenBreakdown();
  await Promise.all([
    statsJson('/api/dashboard/stats?' + q).then(
      function(data) { if (gen === _statsGen) paintStats(data); },
      function(e) { if (gen === _statsGen) { console.error('Failed to load stats', e); paintStats(null); } }
    ),
    statsJson('/api/dashboard/usage?' + q).then(
      function(report) { if (gen === _statsGen) paintUsage(report); },
      function(e) { if (gen === _statsGen) { console.error('Failed to load usage', e); paintUsage(null); } }
    ),
  ]);
}

function statsJson(url) {
  return fetch(url).then(function(res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

// A failed load shows a dash rather than the previous period's number.
function setStat(id, text) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('no-data', text === '\\u2014');
}

function paintStats(data) {
  var t = data && data.totals;
  var dash = '\\u2014';
  setStat('stat-sessions', t ? String(toNum(t.sessionsCreated)) : dash);
  setStat('stat-turns', t ? String(toNum(t.turnsUsed)) : dash);
  setStat('stat-prs', t ? String(toNum(t.prsCreated)) : dash);
  setStat('stat-merged', t ? String(toNum(t.prsMerged)) : dash);
  setStat('stat-commits-hidden', t ? String(toNum(t.commitsCreated)) : dash);
  setStat('stat-merge-lines', t ? '+' + toNum(t.mergeLinesAdded) + ' / -' + toNum(t.mergeLinesDeleted) : dash);
  var wfEntries = Object.entries((t && t.workflowCounts) || {}).sort(function(a, b) { return toNum(b[1]) - toNum(a[1]); });
  document.getElementById('stat-workflows').innerHTML = wfEntries.length
    ? wfEntries.map(function(e) { return '<span style="display:inline-block;margin-right:8px;font-size:0.85em">' + esc(e[0]) + ': <b>' + toNum(e[1]) + '</b></span>'; }).join('')
    : '<span style="color:var(--text-secondary)">-</span>';
  if (data) renderCharts(Array.isArray(data.days) ? data.days : []);
  else document.getElementById('chart-row').innerHTML = '';
}

function paintUsage(report) {
  var t = report && report.totals;
  setStat('stat-tokens', t ? formatTokens(toNum(t.totalInputTokens) + toNum(t.totalOutputTokens)) : '\\u2014');
  setStat('stat-cost', t ? '$' + toNum(t.totalCostUsd).toFixed(2) : '\\u2014');
}

function renderCharts(days) {
  const container = document.getElementById('chart-row');
  if (!days.length) {
    container.innerHTML = '<p style="color:var(--text-secondary)">No data for this period.</p>';
    return;
  }
  container.innerHTML = renderBarChart('&#xC138;&#xC158;', days, function(d) { return d.sessionsCreated; }, 'var(--accent)')
    + renderBarChart('&#xCF54;&#xB4DC; &#xBCC0;&#xACBD; (&#xBA38;&#xC9C0;)', days, function(d) { return d.mergeLinesAdded + d.mergeLinesDeleted; }, 'var(--green)');
}

function renderBarChart(title, days, valueFn, color) {
  const values = days.map(valueFn);
  const max = Math.max.apply(null, values.concat([1]));
  const bars = days.map(function(d, i) {
    const h = Math.max(2, (values[i] / max) * 100);
    const label = d.date.slice(5);
    return '<div class="bar" style="height:' + h + '%;background:' + color + '"><div class="bar-tooltip">' + label + ': ' + values[i] + '</div></div>';
  }).join('');
  const labels = days.map(function(d) { return '<span>' + d.date.slice(8) + '</span>'; }).join('');
  return '<div class="chart-container"><h4>' + title + '</h4><div class="bar-chart">' + bars + '</div><div class="bar-labels">' + labels + '</div></div>';
}

// ── WebSocket ──
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws/dashboard');
  const statusEl = document.getElementById('ws-status');

  ws.onopen = function() {
    statusEl.textContent = 'Live';
    statusEl.title = 'WebSocket: Live';
    statusEl.setAttribute('aria-label', 'WebSocket: Live');
    statusEl.style.background = 'rgba(62,207,142,0.2)';
    statusEl.style.borderColor = 'var(--green)';
    statusEl.style.color = 'var(--green)';
    // Reconnect: recover the work-log entries broadcast while we were offline
    // (from the HTTP cursor; afterSeq=0 when the log was still empty).
    if (panelOpen && _wl) recoverWorkLog();
  };
  ws.onclose = function() {
    statusEl.textContent = 'Reconnecting...';
    statusEl.title = 'WebSocket: Reconnecting';
    statusEl.setAttribute('aria-label', 'WebSocket: Reconnecting');
    statusEl.style.background = '';
    statusEl.style.borderColor = '';
    statusEl.style.color = 'var(--yellow)';
    setTimeout(connectWs, 3000);
  };
  ws.onerror = function() { ws.close(); };
  ws.onmessage = function(ev) {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'session_update') {
        if (currentUserId) {
          msg.board.working = (msg.board.working || []).filter(function(s) { return s.ownerId === currentUserId; });
          msg.board.waiting = (msg.board.waiting || []).filter(function(s) { return s.ownerId === currentUserId; });
          msg.board.idle = (msg.board.idle || []).filter(function(s) { return s.ownerId === currentUserId; });
          msg.board.closed = (msg.board.closed || []).filter(function(s) { return s.ownerId === currentUserId; });
        }
        renderBoard(mergeSiblingCards(msg.board));
        // Refresh panel question if panel is open (session may have transitioned)
        if (panelOpen && panelSessionKey && _sessionCache[panelSessionKey]) {
          var panelS = _sessionCache[panelSessionKey];
          renderPanelQuestion(panelS);
          renderPanelControls(panelS);
          // The board carries the server's one-current-task view; a turn that
          // just ended must stop spinning its task in the open panel too.
          renderPanelTasks(panelS.tasks);
          // If session no longer has pending multi-choice, clear mc state
          if (!panelS.pendingQuestion || panelS.pendingQuestion.type !== 'user_choices') {
            if (_mcState[panelSessionKey]) delete _mcState[panelSessionKey];
          }
        }
      } else if (msg.type === 'task_update') {
        // Update cached session tasks and re-render
        if (_sessionCache[msg.sessionKey]) {
          _sessionCache[msg.sessionKey].tasks = msg.tasks;
          _sessionCache[msg.sessionKey].earlierTasks = msg.earlierTasks && msg.earlierTasks.length ? msg.earlierTasks : undefined;
        }
        loadSessions();
        // Also update panel tasks if panel is open for this session
        if (panelOpen && panelSessionKey === msg.sessionKey) {
          renderPanelTasks(msg.tasks);
          wlRefreshGroupHeads();
        }
      } else if (msg.type === 'conversation_update') {
        // A turn landed — an open card's 지시/응답 pair may be stale now.
        invalidateCardIo(msg.conversationId);
        // If panel is open for this conversation, append or update the turn
        if (panelOpen && panelConvId === msg.conversationId && msg.turn) {
          // Dedupe: skip user turns that match our optimistic send (content + within 10s)
          if (msg.turn.role === 'user' && _lastSentContent && (Date.now() - _lastSentTime) < 10000
              && (msg.turn.rawContent || '').trim() === _lastSentContent.trim()) {
            _lastSentContent = '';
            _lastSentTime = 0;
            // Remove pending style from optimistic turn if present
            var pending = document.querySelector('.turn.user[style*="opacity"]');
            if (pending) pending.style.opacity = '';
          } else {
            // Check if this turn already exists (e.g., summary update for existing assistant turn).
            // If so, replace in-place instead of appending a duplicate.
            var existingTurn = msg.turn.id ? document.querySelector('[data-turn-id="' + CSS.escape(msg.turn.id) + '"]') : null;
            if (existingTurn) {
              updateTurnInPanel(existingTurn, msg.turn);
            } else {
              appendTurnToPanel(msg.turn);
            }
          }
        }
      } else if (msg.type === 'session_action') {
        // Immediate visual feedback already handled by loadSessions() in doAction
      } else if (msg.type === 'summaryTitleChanged') {
        // Dashboard v2.1 + #762 — targeted title patch. Server resolves the
        // displayHeadline through the full priority chain and sends both
        // values: summaryTitle is what gets cached, displayHeadline is what
        // the UI actually paints. Falls back to summaryTitle for backward
        // compat with payloads pre-#762.
        var cached = _sessionCache[msg.sessionKey];
        if (cached) {
          cached.summaryTitle = msg.summaryTitle;
          if (msg.displayHeadline) cached.displayHeadline = msg.displayHeadline;
        }
        var headline = msg.displayHeadline || msg.summaryTitle;
        // Re-render through the card patch path so the summary line (which
        // avoids repeating the headline) stays consistent with the title.
        refreshCard(msg.sessionKey);
        if (panelOpen && panelSessionKey === msg.sessionKey) {
          var pt = document.getElementById('panel-title');
          if (pt) pt.textContent = headline;
        }
      } else if (msg.type === 'sessionUpdated' && msg.session && msg.session.key) {
        // #762 — single-session card refresh from broadcastSingleSessionUpdate.
        // Patch just this card through the same keyed path as the board
        // reconciler so the link-derived title flow (which fires before the
        // next full board push) lands immediately without rebuilding the node
        // (an open card stays open). The column comes from the card's data-col.
        var updatedKey = msg.session.key;
        _sessionCache[updatedKey] = msg.session;
        patchLastBoard(msg.session);
        var existingCard = _cardEls[updatedKey];
        if (existingCard) {
          patchCard(existingCard, msg.session, existingCard.getAttribute('data-col') || 'idle');
        }
        if (panelOpen && panelSessionKey === updatedKey) {
          var pt2 = document.getElementById('panel-title');
          if (pt2) pt2.textContent = msg.session.displayHeadline || msg.session.summaryTitle || msg.session.title || 'Untitled';
        }
      } else if (msg.type === 'work_log' && msg.entry) {
        // .prd/10 §3.3 — live work-log entry. Append when its conversation is
        // open in the panel (seq-deduped against the initial fetch).
        if (panelOpen) pushLiveWorkLog(msg.conversationId, msg.entry);
        if (msg.entry.kind === 'instruction' || msg.entry.kind === 'final') invalidateCardIo(msg.conversationId);
      }
    } catch (e) { /* ignore */ }
  };
}

// ── Token breakdown by instance, from the session cache (#814) ──
function updateTokenBreakdown() {
  // #814 — group the board's session token usage by environment.instanceName
  // so the tokens tooltip can break down "instance-a: 12K | instance-b: 8K |
  // Total: 20K". The number itself is the period total from /api/dashboard/usage
  // (loadStats); this breakdown covers the sessions on the board, and says so.
  // Fallback bucket ('') is used for cards whose environment is missing
  // (legacy WS payloads, tests). When all cards share one env we suppress
  // the tooltip entirely — see _envCount() check below.
  var byEnv = Object.create(null);
  let totalTokens = 0;
  for (const key in _sessionCache) {
    const s = _sessionCache[key];
    if (currentUserId && s.ownerId !== currentUserId) continue;
    if (!s.tokenUsage) continue;
    var t = toNum(s.tokenUsage.totalInputTokens) + toNum(s.tokenUsage.totalOutputTokens);
    totalTokens += t;
    var envName = (s.environment && s.environment.instanceName) || '';
    if (!byEnv[envName]) byEnv[envName] = { tokens: 0 };
    byEnv[envName].tokens += t;
  }

  // Tooltip: only show when there's actually a breakdown (≥2 envs in
  // the cache). For the single-instance / empty-env case we leave the
  // tooltip dark so the topbar stays the same shape it was before #814.
  // Runs on every board render (renderBoard) and stats load — it writes only
  // what changed.
  var tip = document.getElementById('stat-tokens-tooltip');
  var wrap = document.getElementById('stat-tokens-wrap');
  if (!tip || !wrap) return;
  var envNames = Object.keys(byEnv).filter(function(n) { return n.length > 0; });
  if (envNames.length < 2) {
    if (tip._html !== '') { tip.textContent = ''; tip._html = ''; }
    if (wrap.classList.contains('tooltip-open')) wrap.classList.remove('tooltip-open');
    if (wrap.hasAttribute('data-has-breakdown')) wrap.removeAttribute('data-has-breakdown');
    return;
  }
  // Stable order: sort so the same env always renders in the same position.
  envNames.sort();
  var parts = [];
  for (var i = 0; i < envNames.length; i++) {
    var n = envNames[i];
    parts.push(esc(n) + ': ' + formatTokens(byEnv[n].tokens));
  }
  parts.push('Total: ' + formatTokens(totalTokens));
  var html = '보드 세션 기준 &middot; ' + parts.join(' &middot; ');
  if (tip._html !== html) { tip.innerHTML = html; tip._html = html; }
  if (!wrap.hasAttribute('data-has-breakdown')) wrap.setAttribute('data-has-breakdown', 'true');
  // Mobile (no-hover) tap-toggle wiring — attach once.
  if (!wrap.hasAttribute('data-tap-bound')) {
    wrap.setAttribute('data-tap-bound', 'true');
    wrap.addEventListener('click', function() {
      // Only toggle on touch-likely devices; on hover-capable devices the
      // CSS :hover rule already handles it and a click adds noise.
      if (window.matchMedia('(hover: none)').matches) {
        wrap.classList.toggle('tooltip-open');
      }
    });
  }
}

// ── Panel work log (.prd/10 §3.1-7, §3.3) ──
// GET /api/dashboard/session/:conversationId/worklog → { entries, hasMore }:
// without afterSeq the LATEST page, with afterSeq=N (integer ≥ 0) the FIRST
// page after N — so afterSeq=0 is the oldest page and the initial load must
// omit it. Live entries arrive as WS { type: 'work_log', conversationId,
// entry } once the line is on disk. 403 = not the session owner (no retry),
// 404 = no log for this conversation.
// Entries merge by seq identity into one seq-ordered list, so a live entry that
// lands before the HTTP page never hides the older batch.
// Seqs only increase, but they are NOT contiguous: the store reserves them in
// blocks, so after a crash the next seq can jump (57 → 1001) and that hole is
// permanent. The cursor is therefore server-confirmed, not "no holes": every
// entry that exists up to the cursor is held. A page requested after seq c
// returns every existing entry > c (first page), so it confirms up to its last
// seq — and, when hasMore is false, up to every seq we held when the request
// went out (a live entry is on disk before it is broadcast). Live entries that
// directly follow the cursor advance it too. A live entry beyond cursor + 1 is
// a gap → backfill from the cursor; once the backfill is done the gap is closed
// even if nothing came back (the hole is permanent). A reconnect pages forward
// the same way (afterSeq=0 when the log was empty) while hasMore === true.
// A safety bound against a server that never stops saying hasMore — not a
// size limit: 2000 pages of 500 is a million entries (SSOT 2026-10-22 T9).
var WL_BACKFILL_MAX_PAGES = 2000;
var WL_LABELS = { instruction: '지시', narration: '', tool: '', tool_result: '', final: '응답', notice: '알림', error: '오류' };
var WL_EMPTY_MSG = '작업 로그 없음';
var WL_FORBIDDEN_MSG = '작업 로그는 세션 소유자만 볼 수 있어요';
var WL_RAW_MISSING_MSG = '원본 출력이 저장되어 있지 않습니다';
var WL_RAW_ERROR_MSG = '원본 출력을 불러오지 못했어요';
var WL_RAW_DAMAGED_MSG = '로그가 손상되어 원본을 읽을 수 없습니다';
var _wl = null;  // work-log state of the conversation open in the panel
var _panelFocusWorkLog = false;

// ── Pure core (no DOM): state, merge, paging ──
function wlNewState(convId) {
  return {
    convId: convId, entries: [], seen: new Set(), cursor: 0, maxSeq: 0,
    loaded: false, latestOk: false, denied: false, closed: false,
    latest: null, recovering: null, againReconnect: false, againGap: false, painted: false,
  };
}
// afterSeq: null/undefined = latest window (no parameter); otherwise always a
// non-negative integer — the API answers 400 to anything else.
function wlUrl(convId, afterSeq) {
  var base = '/api/dashboard/session/' + encodeURIComponent(convId) + '/worklog';
  if (afterSeq === null || afterSeq === undefined) return base;
  var n = Math.max(0, Math.floor(Number(afterSeq) || 0));
  return base + '?afterSeq=' + n;
}
function wlValidSeq(seq) {
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0;
}
// Adds entries not seen before (by seq) and keeps state.entries sorted by seq.
// Returns the added entries in ascending seq order, each with its index in the
// merged list — inserting them in that order at that index reproduces the list.
function wlMerge(state, entries) {
  var fresh = [];
  var list = entries || [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || !wlValidSeq(e.seq) || state.seen.has(e.seq)) continue;
    state.seen.add(e.seq);
    if (e.seq > state.maxSeq) state.maxSeq = e.seq;
    fresh.push(e);
  }
  if (!fresh.length) return [];
  fresh.sort(function(a, b) { return a.seq - b.seq; });
  var old = state.entries;
  var merged = [];
  var added = [];
  var oi = 0;
  var fi = 0;
  while (oi < old.length || fi < fresh.length) {
    if (fi >= fresh.length || (oi < old.length && old[oi].seq < fresh[fi].seq)) {
      merged.push(old[oi++]);
    } else {
      added.push({ entry: fresh[fi], index: merged.length });
      merged.push(fresh[fi++]);
    }
  }
  state.entries = merged;
  return added;
}
function wlPageMaxSeq(entries) {
  var top = 0;
  var list = entries || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && wlValidSeq(list[i].seq) && list[i].seq > top) top = list[i].seq;
  }
  return top;
}
// Advance the cursor over every directly-following seq we hold.
function wlAdvance(state) {
  while (state.seen.has(state.cursor + 1)) state.cursor++;
}
// The server answered: every entry that exists up to seq upTo is now held.
function wlConfirm(state, upTo) {
  if (upTo > state.cursor) state.cursor = upTo;
  wlAdvance(state);
}
// 403 from any path (first load, latest retry, backfill page): stop for good
// and tell the UI once through state.onDenied (set by the DOM side).
function wlDeny(state) {
  if (state.denied) return;
  state.denied = true;
  if (state.onDenied && !state.closed) state.onDenied(state);
}
// A held entry beyond the contiguous cursor means something in between is missing.
function wlHasGap(state) {
  return state.loaded && !state.denied && !state.closed && state.maxSeq > state.cursor;
}
function wlStatusOf(err) {
  var status = err && err.status;
  if (status === 403) return 'denied';
  if (status === 404) return 'missing';
  return 'error';
}
// Initial load: the latest page (no afterSeq). Resolves 'ok' | 'denied' |
// 'missing' | 'error' | 'closed'. Early live entries beyond the page are a gap.
function wlLoadLatest(state, fetchJson, onAdded) {
  // The latest window holds the newest entries at request time — including
  // any live entry we already held — so it confirms up to both.
  var sentMax = state.maxSeq;
  state.latest = fetchJson(wlUrl(state.convId, null)).then(function(data) {
    if (state.closed) return 'closed';
    var page = (data && data.entries) || [];
    var added = wlMerge(state, page);
    state.loaded = true;
    state.latestOk = true;
    // Entries older than this window exist: wlLoadOlder brings them in (T9).
    state.olderPending = !!(data && data.hasMore === true);
    wlConfirm(state, Math.max(wlPageMaxSeq(page), sentMax));
    if (added.length) onAdded(state, added);
    if (wlHasGap(state)) wlRecover(state, fetchJson, onAdded, 'gap');
    return 'ok';
  }, function(err) {
    if (state.closed) return 'closed';
    state.loaded = true;
    var status = wlStatusOf(err);
    if (status === 'denied') wlDeny(state);
    return status;
  });
  return state.latest;
}
// A live entry: merge it; one that skips past the cursor triggers a backfill.
function wlOnLive(state, entry, fetchJson, onAdded) {
  if (state.closed || state.denied) return [];
  var added = wlMerge(state, [entry]);
  if (!added.length) return added;
  if (state.loaded) wlAdvance(state);
  onAdded(state, added);
  if (wlHasGap(state)) wlRecover(state, fetchJson, onAdded, 'gap');
  return added;
}
// Recovery (reconnect or gap): after the initial load settles, page forward
// from the contiguous cursor while hasMore === true. Stops on a page that does
// not advance the cursor, after WL_BACKFILL_MAX_PAGES pages, on 403, or when
// the panel moved on. If the latest page itself never loaded, retry that instead.
// reason: 'reconnect' (default — the socket was down, anything may be missing)
// or 'gap' (a live entry skipped seqs). While a run is in flight, requests are
// coalesced: a reconnect always re-runs afterwards; a gap re-runs only if the
// in-flight run's confirmation did not already cover it.
function wlRecover(state, fetchJson, onAdded, reason) {
  if (state.closed || state.denied) return Promise.resolve(null);
  if (state.recovering) {
    if (reason === 'gap') state.againGap = true;
    else state.againReconnect = true;
    return state.recovering;
  }
  var pages = 0;
  function step() {
    if (state.closed || state.denied) return null;
    if (state.loaded && !state.latestOk) return wlLoadLatest(state, fetchJson, onAdded);
    var from = state.cursor;
    var sentMax = state.maxSeq; // every seq we hold now is on disk now
    pages++;
    return fetchJson(wlUrl(state.convId, from)).then(function(data) {
      if (state.closed) return null;
      var page = (data && data.entries) || [];
      var added = wlMerge(state, page);
      var more = !!(data && data.hasMore === true);
      // A full page confirms only up to its last seq; the last page confirms up
      // to everything that existed when it was requested — so a permanent hole
      // closes here instead of re-triggering a backfill on every live entry.
      wlConfirm(state, more ? wlPageMaxSeq(page) : Math.max(wlPageMaxSeq(page), sentMax));
      if (added.length) onAdded(state, added);
      if (more && state.cursor > from && pages < WL_BACKFILL_MAX_PAGES) return step();
      return null;
    }, function(err) {
      if (wlStatusOf(err) === 'denied') wlDeny(state);
      return null;
    });
  }
  var run = (state.latest || Promise.resolve()).then(step).then(null, function() { return null; }).then(function() {
    state.recovering = null;
    var reconnect = state.againReconnect;
    var gap = state.againGap && wlHasGap(state);
    state.againReconnect = false;
    state.againGap = false;
    if (state.closed) return null;
    if (reconnect) return wlRecover(state, fetchJson, onAdded);
    if (gap) return wlRecover(state, fetchJson, onAdded, 'gap');
    return null;
  });
  state.recovering = run;
  return run;
}

// Every entry, not just the latest window (SSOT 2026-10-22 T9): when the
// latest page said older entries exist, page forward from the start of the log
// (afterSeq=0, 500 per page) up to the oldest entry held, merging each page.
// Older entries sit below the cursor, so the live / gap bookkeeping is
// untouched. Stops on the last page, at the held entries, when the panel moved
// on, on 403, or after WL_BACKFILL_MAX_PAGES pages. The pages are painted ONCE,
// after the last one — a full re-render per page would be quadratic in the
// log's size.
function wlLoadOlder(state, fetchJson, onAdded) {
  if (state.closed || state.denied || !state.olderPending) return Promise.resolve(null);
  // The range to fill is fixed by the first attempt (below the latest window)
  // and progress is kept, so a retry after a failed page resumes where it
  // stopped instead of mistaking the pages it already holds for the boundary.
  if (state.olderStopAt === undefined) state.olderStopAt = state.entries.length ? state.entries[0].seq : Infinity;
  var stopAt = state.olderStopAt;
  var from = state.olderFrom || 0;
  var pages = 0;
  var gathered = [];
  // ok = the range up to the held entries is complete; a failed page keeps
  // olderPending so the next recovery (reconnect) tries again.
  function finish(ok) {
    if (ok) state.olderPending = false;
    if (gathered.length && !state.closed && !state.denied) onAdded(state, gathered);
    return null;
  }
  function step() {
    if (state.closed || state.denied) return null;
    pages++;
    return fetchJson(wlUrl(state.convId, from)).then(function(data) {
      if (state.closed) return null;
      var page = (data && data.entries) || [];
      var older = page.filter(function(e) { return e && wlValidSeq(e.seq) && e.seq < stopAt; });
      gathered = gathered.concat(wlMerge(state, older));
      var top = wlPageMaxSeq(page);
      var more = !!(data && data.hasMore === true);
      if (more && top > from && top < stopAt && pages < WL_BACKFILL_MAX_PAGES) {
        from = top;
        state.olderFrom = top;
        return step();
      }
      return finish(true);
    }, function(err) {
      if (wlStatusOf(err) === 'denied') wlDeny(state);
      return finish(false);
    });
  }
  return step();
}

// Raw output of one entry (§3.1-6). An entry with rawBytes has its full output
// stored: GET …/worklog/:seq/raw → { seq, raw, rawBytes, rawTruncated }, asked
// once per (panel state, seq) — the promise is kept on the state, and a new
// state (resetWorkLog) starts without it. 404 (not stored), 403 (owner only)
// and the server's 503 { error: 'unavailable' } (the log is damaged; the answer
// stays the same until it is repaired) settle for good. Everything else — a
// network failure, a 500 / 502, a 503 without that code (a proxy during a
// restart) — is not kept and offers 다시 시도.
function wlRawUrl(convId, seq) {
  return wlUrl(convId, null) + '/' + Math.max(0, Math.floor(Number(seq) || 0)) + '/raw';
}
function wlRawLoad(state, seq, fetchJson) {
  var cache = state.raw || (state.raw = Object.create(null));
  if (cache[seq]) return cache[seq];
  var p = fetchJson(wlRawUrl(state.convId, seq)).then(function(d) {
    return {
      status: 'ok',
      raw: d && typeof d.raw === 'string' ? d.raw : '',
      bytes: toNum(d && d.rawBytes),
      truncated: !!(d && d.rawTruncated === true),
    };
  }, function(err) {
    var status = err && err.status;
    if (status === 404) return { status: 'missing' };
    if (status === 403) return { status: 'denied' };
    if (status === 503 && err.code === 'unavailable') return { status: 'damaged' };
    if (cache[seq] === p) delete cache[seq];
    return { status: 'error' };
  });
  cache[seq] = p;
  return p;
}
function formatBytes(n) {
  n = Math.max(0, toNum(n));
  if (n < 1024) return Math.round(n) + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MiB';
  return (n / 1073741824).toFixed(1) + ' GiB';
}
// The detail block under an open entry: the full output in a <pre> (with a
// copy button), or the line for a load in flight / not stored / owner-only /
// a damaged log / any other failure (the only one with 다시 시도).
function renderWorkLogDetail(r) {
  if (r.status === 'loading') return '<div class="wl-detail-msg is-loading">원본 출력 불러오는 중…</div>';
  if (r.status === 'missing') return '<div class="wl-detail-msg">' + esc(WL_RAW_MISSING_MSG) + '</div>';
  if (r.status === 'denied') return '<div class="wl-detail-msg">' + esc(WL_FORBIDDEN_MSG) + '</div>';
  if (r.status === 'damaged') return '<div class="wl-detail-msg">' + esc(WL_RAW_DAMAGED_MSG) + '</div>';
  if (r.status === 'error') {
    return '<div class="wl-detail-msg">' + esc(WL_RAW_ERROR_MSG)
      + '<button type="button" class="wl-detail-btn" data-wl-act="retry">다시 시도</button></div>';
  }
  var note = r.truncated
    ? '<div class="wl-detail-note">저장된 앞 256 KiB만 표시 — 원본 ' + formatBytes(r.bytes) + '</div>'
    : '';
  return note
    + '<div class="wl-detail-bar"><button type="button" class="wl-detail-btn" data-wl-act="copy">복사</button></div>'
    + '<pre class="wl-raw">' + esc(r.raw) + '</pre>';
}

// ── DOM side ──
// A failed answer rejects with err.status and err.code — the error string of a
// JSON error body ({ error: 'unavailable' }), or null for anything else (an
// HTML page from a proxy, no body).
function wlFetchJson(url) {
  return fetch(url).then(function(r) {
    if (r.ok) return r.json();
    return Promise.resolve().then(function() { return r.json(); }).then(function(b) {
      return b && typeof b.error === 'string' ? b.error : null;
    }, function() { return null; }).then(function(code) {
      var err = new Error('HTTP ' + r.status);
      err.status = r.status;
      err.code = code;
      throw err;
    });
  });
}

// visible: the panel is open (a session without a conversation still shows
// the section, reading "작업 로그 없음").
function resetWorkLog(convId, visible) {
  if (_wl) _wl.closed = true; // late responses for the previous conversation are dropped
  _wl = convId ? wlNewState(convId) : null;
  if (_wl) _wl.onDenied = showWorkLogDenied;
  var section = document.getElementById('panel-worklog');
  var list = document.getElementById('worklog-list');
  setTextIfChanged(document.getElementById('worklog-count'), '');
  if (section) section.style.display = visible ? '' : 'none';
  if (list) list.innerHTML = !visible ? '' : '<div class="wl-empty">' + (convId ? '불러오는 중…' : WL_EMPTY_MSG) + '</div>';
}

function loadWorkLog() {
  var st = _wl;
  if (!st) return;
  wlLoadLatest(st, wlFetchJson, paintWorkLog).then(function(result) {
    if (st.closed) return;
    // 'denied' was already shown by showWorkLogDenied (state.onDenied).
    if (result !== 'denied' && !st.entries.length) showWorkLogEmpty(WL_EMPTY_MSG);
    // T9: the whole log, not just its latest 500 entries.
    if (result === 'ok') wlLoadOlder(st, wlFetchJson, paintWorkLog);
    // No re-landing here: the log is collapsed, so its arrival moves nothing,
    // and a reader who already scrolled is left where they are.
  });
}
function recoverWorkLog() {
  if (_wl) wlRecover(_wl, wlFetchJson, paintWorkLog);
  // An older page that failed earlier is asked for again (T9).
  if (_wl && _wl.olderPending && _wl.loaded) wlLoadOlder(_wl, wlFetchJson, paintWorkLog);
}
function pushLiveWorkLog(convId, entry) {
  if (!_wl || _wl.convId !== convId) return;
  wlOnLive(_wl, entry, wlFetchJson, paintWorkLog);
}

// Work-log section open / closed (§3.1-6). Every panel opening starts closed
// (openPanel); 작업 로그 and ?session= only change where the panel lands.
// Opening only shows what loadWorkLog already fetched — it never asks again.
function setWorkLogOpen(open) {
  var toggle = document.getElementById('worklog-toggle');
  var list = document.getElementById('worklog-list');
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!list) return;
  list.hidden = !open;
  if (open) list.scrollTop = list.scrollHeight;
}
function toggleWorkLogSection() {
  var toggle = document.getElementById('worklog-toggle');
  setWorkLogOpen(!(toggle && toggle.getAttribute('aria-expanded') === 'true'));
}

// One entry's detail (§3.1-6): a click on its row opens the full output under
// it, a second click closes it. state.open = the seqs open now.
function wlDetailOpen(state) {
  return !!(state && state.open && state.open.size);
}
function wlEntryEl(seq) {
  var list = document.getElementById('worklog-list');
  return list ? list.querySelector('.wl-entry[data-seq="' + Math.floor(Number(seq) || 0) + '"]') : null;
}
function wlEntryBySeq(state, seq) {
  var list = (state && state.entries) || [];
  for (var i = 0; i < list.length; i++) if (list[i].seq === seq) return list[i];
  return null;
}
// What the row stands for, in full — for an entry without stored raw output.
function wlFullText(e) {
  var text = String(e.text || '');
  return e.kind === 'instruction' ? decodeSlackEntities(text) : text;
}
// Paints only while that entry is still open in the conversation still shown —
// a late answer for a closed row or a previous conversation is dropped.
function paintWorkLogDetail(state, seq, result) {
  if (state !== _wl || state.closed || !state.open || !state.open.has(seq)) return;
  var el = wlEntryEl(seq);
  var detail = el && el.querySelector('.wl-detail');
  if (detail) detail.innerHTML = renderWorkLogDetail(result);
}
function loadWorkLogDetail(state, seq) {
  var entry = wlEntryBySeq(state, seq);
  if (!entry) return;
  if (!(toNum(entry.rawBytes) > 0)) {
    paintWorkLogDetail(state, seq, { status: 'ok', raw: wlFullText(entry), bytes: 0, truncated: false });
    return;
  }
  paintWorkLogDetail(state, seq, { status: 'loading' });
  wlRawLoad(state, seq, wlFetchJson).then(function(result) {
    paintWorkLogDetail(state, seq, result);
  });
}
function toggleWorkLogEntry(seq) {
  var st = _wl;
  if (!st || st.closed) return;
  var el = wlEntryEl(seq);
  var row = el && el.querySelector('.wl-row');
  var detail = el && el.querySelector('.wl-detail');
  if (!row || !detail) return;
  var open = st.open || (st.open = new Set());
  if (open.has(seq)) {
    open.delete(seq);
    row.setAttribute('aria-expanded', 'false');
    detail.hidden = true;
    detail.innerHTML = '';
    return;
  }
  open.add(seq);
  row.setAttribute('aria-expanded', 'true');
  detail.hidden = false;
  loadWorkLogDetail(st, seq);
}
function retryWorkLogDetail(seq) {
  if (_wl && _wl.open && _wl.open.has(seq)) loadWorkLogDetail(_wl, seq);
}
// Copies the text the <pre> shows. Without clipboard access (plain http, a
// denied permission) the text is selected instead, so the user can copy it.
function copyWorkLogDetail(seq, btn) {
  var el = wlEntryEl(seq);
  var pre = el && el.querySelector('.wl-raw');
  if (!pre) return;
  function say(label) {
    if (!btn) return;
    btn.textContent = label;
    setTimeout(function() { btn.textContent = '복사'; }, 1500);
  }
  function selectIt() {
    try {
      var range = document.createRange();
      range.selectNodeContents(pre);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_e) {}
    say('선택됨');
  }
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) { selectIt(); return; }
    navigator.clipboard.writeText(pre.textContent || '').then(function() { say('복사됨'); }, selectIt);
  } catch (_e) { selectIt(); }
}

// ── Work log under its tasks (SSOT 2026-10-22 T10) ──
// An entry made while a task was in progress carries that task (taskId /
// taskTitle). The list shows such entries folded under one header per task —
// at the place of the task's first entry, titled by its latest — and every
// other entry (instructions, final answers, anything outside a task) in line.
// A header is a row button: it opens / closes its entries. A task's group
// starts open when it is the newest group the list has seen, closed otherwise;
// the reader's choice then stays (state.groupOpen).
function wlGroupOf(e) {
  return e && typeof e.taskId === 'string' && e.taskId ? e.taskId : '';
}
// Pure: the list as rows, in seq order of first appearance.
function wlBuildRows(entries) {
  var rows = [];
  var groups = Object.create(null);
  var list = entries || [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var g = wlGroupOf(e);
    if (!g) { rows.push({ entry: e }); continue; }
    var grp = groups[g];
    if (!grp) {
      grp = groups[g] = { taskId: g, title: '', entries: [] };
      rows.push({ group: grp });
    }
    grp.entries.push(e);
    if (e.taskTitle) grp.title = String(e.taskTitle);
  }
  return rows;
}
// The task behind a group, from the open session's task ledger (status, time, tool calls).
function wlTaskInfo(taskId) {
  var s = panelSessionKey ? _sessionCache[panelSessionKey] : null;
  var all = ((s && s.tasks) || []).concat((s && s.earlierTasks) || []);
  for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === taskId) return all[i];
  return null;
}
function renderWorkLogGroupHead(grp, open, task) {
  var meta = task ? renderTaskMeta(task) : '';
  var title = (task && task.content) || grp.title || '';
  return '<div class="wl-group-head" role="button" tabindex="-1" aria-expanded="' + (open ? 'true' : 'false') + '">'
    + '<span class="wl-g-chev" aria-hidden="true">&#x25B8;</span>'
    + '<span class="wl-g-id">#' + esc(grp.taskId) + '</span>'
    + '<span class="wl-g-title">' + esc(title) + '</span>'
    + '<span class="wl-g-count">' + grp.entries.length + '</span>'
    + (meta ? '<span class="wl-g-meta">' + meta + '</span>' : '')
    + '</div>';
}
// A closed group holds no entry nodes: its entries are rendered when it opens
// (wlFillGroupBody), so a long log's DOM stays the size of what is open.
function renderWorkLogGroup(grp, open, task) {
  return '<div class="wl-group" data-task-id="' + escAttr(grp.taskId) + '">'
    + renderWorkLogGroupHead(grp, open, task)
    + (open
      ? '<div class="wl-group-body" data-filled="1">' + grp.entries.map(renderWorkLogEntry).join('') + '</div>'
      : '<div class="wl-group-body" hidden></div>')
    + '</div>';
}
// Render a group's entries into its (empty) body; open details come back open.
function wlFillGroupBody(state, grpEl, taskId) {
  var body = grpEl.querySelector('.wl-group-body');
  if (!body || body.getAttribute('data-filled') === '1') return;
  var entries = state.entries.filter(function(x) { return wlGroupOf(x) === taskId; });
  body.innerHTML = entries.map(renderWorkLogEntry).join('');
  body.setAttribute('data-filled', '1');
  for (var i = 0; i < entries.length; i++) {
    var seq = entries[i].seq;
    if (!state.open || !state.open.has(seq)) continue;
    var el = wlEntryEl(seq);
    var row = el && el.querySelector('.wl-row');
    var detail = el && el.querySelector('.wl-detail');
    if (!row || !detail) continue;
    row.setAttribute('aria-expanded', 'true');
    detail.hidden = false;
    loadWorkLogDetail(state, seq);
  }
  updateTimersIn(body);
}
// Open state of a group: the reader's choice, else open when it is the newest group.
function wlGroupOpen(state, taskId, newest) {
  var map = state.groupOpen || (state.groupOpen = Object.create(null));
  if (!(taskId in map)) map[taskId] = !!newest;
  return map[taskId];
}
function wlGroupEl(list, taskId) {
  var groups = list.querySelectorAll('.wl-group');
  for (var i = 0; i < groups.length; i++) if (groups[i].getAttribute('data-task-id') === taskId) return groups[i];
  return null;
}
// The whole list from state.entries; open details are re-opened (raw output is cached on the state).
function wlRenderList(state, list) {
  var rows = wlBuildRows(state.entries);
  var newest = null;
  for (var i = rows.length - 1; i >= 0; i--) if (rows[i].group) { newest = rows[i].group; break; }
  list.innerHTML = rows.map(function(r) {
    if (r.entry) return renderWorkLogEntry(r.entry);
    return renderWorkLogGroup(r.group, wlGroupOpen(state, r.group.taskId, r.group === newest), wlTaskInfo(r.group.taskId));
  }).join('');
  if (state.open) state.open.forEach(function(seq) {
    var el = wlEntryEl(seq);
    var row = el && el.querySelector('.wl-row');
    var detail = el && el.querySelector('.wl-detail');
    if (!row || !detail) return;
    row.setAttribute('aria-expanded', 'true');
    detail.hidden = false;
    loadWorkLogDetail(state, seq);
  });
}
// Live entries at the end of the log: append in place (a task's entry into its
// group, a new task as a new — open — group at the end).
function wlAppendTail(state, list, added) {
  var tmp = document.createElement('div');
  for (var i = 0; i < added.length; i++) {
    var e = added[i].entry;
    var g = wlGroupOf(e);
    if (!g) {
      tmp.innerHTML = renderWorkLogEntry(e);
      if (tmp.firstElementChild) list.appendChild(tmp.firstElementChild);
      continue;
    }
    var grpEl = wlGroupEl(list, g);
    if (!grpEl) {
      var grp = { taskId: g, title: e.taskTitle ? String(e.taskTitle) : '', entries: [e] };
      tmp.innerHTML = renderWorkLogGroup(grp, wlGroupOpen(state, g, true), wlTaskInfo(g));
      if (tmp.firstElementChild) list.appendChild(tmp.firstElementChild);
      continue;
    }
    var body = grpEl.querySelector('.wl-group-body');
    // A closed group renders its entries when it opens; only its head changes now.
    if (body && body.getAttribute('data-filled') === '1') {
      tmp.innerHTML = renderWorkLogEntry(e);
      if (tmp.firstElementChild) body.appendChild(tmp.firstElementChild);
    }
    wlRefreshGroupHead(state, grpEl, g);
  }
}
function wlRefreshGroupHead(state, grpEl, taskId) {
  var head = grpEl.querySelector('.wl-group-head');
  if (!head) return;
  var entries = state.entries.filter(function(x) { return wlGroupOf(x) === taskId; });
  var title = '';
  for (var i = 0; i < entries.length; i++) if (entries[i].taskTitle) title = String(entries[i].taskTitle);
  var tmp = document.createElement('div');
  tmp.innerHTML = renderWorkLogGroupHead({ taskId: taskId, title: title, entries: entries }, head.getAttribute('aria-expanded') === 'true', wlTaskInfo(taskId));
  var fresh = tmp.firstElementChild;
  if (!fresh) return;
  if (head.getAttribute('tabindex') === '0') fresh.setAttribute('tabindex', '0');
  grpEl.replaceChild(fresh, head);
  updateTimersIn(fresh);
}
// Task status / time / tool calls changed (task_update): refresh every group head.
function wlRefreshGroupHeads() {
  var list = document.getElementById('worklog-list');
  if (!list || !_wl) return;
  var groups = list.querySelectorAll('.wl-group');
  for (var i = 0; i < groups.length; i++) wlRefreshGroupHead(_wl, groups[i], groups[i].getAttribute('data-task-id'));
}
function toggleWorkLogGroup(taskId) {
  var st = _wl;
  var list = document.getElementById('worklog-list');
  if (!st || st.closed || !list) return;
  var grpEl = wlGroupEl(list, taskId);
  if (!grpEl) return;
  var head = grpEl.querySelector('.wl-group-head');
  var body = grpEl.querySelector('.wl-group-body');
  var open = !(head && head.getAttribute('aria-expanded') === 'true');
  (st.groupOpen || (st.groupOpen = Object.create(null)))[taskId] = open;
  if (open) wlFillGroupBody(st, grpEl, taskId);
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (body) body.hidden = !open;
}

// Paint merged entries: live entries at the end are appended in place; any
// other batch (the older pages, a backfill) re-renders the list from
// state.entries, which keeps seq order and the task groups exact.
function paintWorkLog(state, added) {
  if (state !== _wl || !added.length) return;
  var list = document.getElementById('worklog-list');
  if (!list) return;
  var atBottom = list.scrollHeight - list.scrollTop <= list.clientHeight + 40;
  var placeholder = list.querySelector('.wl-empty');
  if (placeholder) placeholder.remove();
  var n = state.entries.length;
  var tail = state.painted;
  for (var i = 0; tail && i < added.length; i++) if (added[i].index !== n - added.length + i) tail = false;
  var keepTop = !tail && state.painted ? list.scrollHeight - list.scrollTop : null;
  if (tail) wlAppendTail(state, list, added);
  else wlRenderList(state, list);
  updateTimersIn(list);
  setTextIfChanged(document.getElementById('worklog-count'), String(n));
  wlEnsureTabStop(list);
  // Tail-follow, unless the reader has an entry's detail open; older entries
  // arriving above keep the reader's place.
  if (!state.painted || (atBottom && !wlDetailOpen(state))) list.scrollTop = list.scrollHeight;
  else if (keepTop !== null) list.scrollTop = list.scrollHeight - keepTop;
  state.painted = true;
}

// Owner-only log (403 on any path) — only for the conversation still open.
function showWorkLogDenied(state) {
  if (state !== _wl || state.closed) return;
  // Live entries painted before the 403 go too: the log is owner-only.
  state.entries = [];
  var list = document.getElementById('worklog-list');
  setTextIfChanged(document.getElementById('worklog-count'), '');
  if (list) list.innerHTML = '<div class="wl-empty">' + esc(WL_FORBIDDEN_MSG) + '</div>';
}
function showWorkLogEmpty(message) {
  var list = document.getElementById('worklog-list');
  if (list && !list.querySelector('.wl-entry')) list.innerHTML = '<div class="wl-empty">' + esc(message || WL_EMPTY_MSG) + '</div>';
}

function renderWorkLogEntry(e) {
  var kind = Object.prototype.hasOwnProperty.call(WL_LABELS, e.kind) ? e.kind : 'narration';
  var time = typeof e.ts === 'number' && isFinite(e.ts)
    ? new Date(e.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : '';
  var timeHtml = time ? '<span class="wl-time">' + time + '</span>' : '';
  var seq = Math.floor(Number(e.seq) || 0);
  var seqAttr = ' data-seq="' + seq + '"';
  // One root per entry: the row (role=button, out of the tab order — the list
  // keeps one roving stop) and its detail block (§3.1-6).
  function rowOpen(extra) {
    return '<div class="wl-row' + (extra || '') + '" role="button" tabindex="-1" aria-expanded="false" aria-controls="wl-detail-' + seq + '">';
  }
  // aria-live="off": the list is role=log (polite), and an opened raw output
  // of up to 256 KiB must not be read out in full.
  var detailHtml = '<div class="wl-detail" id="wl-detail-' + seq + '" aria-live="off" hidden></div>';
  var text = String(e.text || '');
  if (kind === 'tool' || kind === 'tool_result') {
    var fail = kind === 'tool_result' && e.ok === false;
    var mark = kind === 'tool' ? '&#x25B8;' : (fail ? '&#x2717;' : '&#x2713;');
    // The emitter's text starts with the tool name ("Read {...}", "Glob ok");
    // the name already has its own span, so the text shows only what follows.
    var shown = text;
    var tool = e.tool ? String(e.tool) : '';
    if (tool && text === tool) shown = '';
    else if (tool && text.indexOf(tool + ' ') === 0) shown = text.slice(tool.length + 1);
    return '<div class="wl-entry wl-' + kind + (fail ? ' is-fail' : '') + '"' + seqAttr + '>' + rowOpen()
      + '<span class="wl-mark">' + mark + '</span>'
      + (tool ? '<span class="wl-tool-name">' + esc(tool) + '</span>' : '')
      + '<span class="wl-text" title="' + escAttr(text) + '">' + esc(shown) + '</span>'
      + timeHtml + '</div>' + detailHtml + '</div>';
  }
  if (kind === 'instruction') text = decodeSlackEntities(text);
  var label = WL_LABELS[kind];
  if (!label) {
    // Narration: the text with its time on the right of the same line.
    return '<div class="wl-entry wl-' + kind + '"' + seqAttr + '>' + rowOpen(' wl-line') + '<div class="wl-text">' + esc(text) + '</div>' + timeHtml + '</div>' + detailHtml + '</div>';
  }
  return '<div class="wl-entry wl-' + kind + '"' + seqAttr + '>' + rowOpen()
    + '<div class="wl-head"><span class="wl-label">' + label + '</span>' + timeHtml + '</div>'
    + '<div class="wl-text">' + esc(text) + '</div>'
    + '</div>' + detailHtml + '</div>';
}

// Roving tabindex (§3.1-6): the list is one tab stop. The first paint puts it
// on the newest row (where the tail-followed list is looking); focusing a row
// (click, arrows) moves it there. ArrowUp / ArrowDown step, Home / End jump.
function wlRovingIndex(key, i, n) {
  if (n <= 0) return -1;
  if (key === 'ArrowDown') return Math.min(n - 1, i + 1);
  if (key === 'ArrowUp') return Math.max(0, i - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return -1;
}
// The rows the arrows move between: entry rows and task-group heads that are
// on screen (a closed group's entries are not).
function wlNavRows(list) {
  var all = list.querySelectorAll('.wl-group-head, .wl-row');
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var body = all[i].closest ? all[i].closest('.wl-group-body') : null;
    if (body && body.hidden) continue;
    out.push(all[i]);
  }
  return out;
}
function wlEnsureTabStop(list) {
  if (!list || !list.querySelector || list.querySelector('.wl-row[tabindex="0"], .wl-group-head[tabindex="0"]')) return;
  var rows = wlNavRows(list);
  if (rows.length) rows[rows.length - 1].setAttribute('tabindex', '0');
}
function wlSetTabStop(list, row) {
  var old = list.querySelectorAll('.wl-row[tabindex="0"], .wl-group-head[tabindex="0"]');
  for (var i = 0; i < old.length; i++) if (old[i] !== row) old[i].setAttribute('tabindex', '-1');
  if (row.getAttribute('tabindex') !== '0') row.setAttribute('tabindex', '0');
}

// Rows open / close their detail on click, Enter or Space; clicks inside an
// open detail (the <pre>, 복사, 다시 시도) never toggle it.
(function initWorkLogInteractions() {
  var list = document.getElementById('worklog-list');
  if (!list) return;
  function seqOf(node) {
    var entry = node && node.closest('.wl-entry');
    return entry ? Math.floor(Number(entry.getAttribute('data-seq')) || 0) : 0;
  }
  list.addEventListener('click', function(e) {
    var btn = e.target.closest('.wl-detail-btn');
    if (btn && list.contains(btn)) {
      var act = btn.getAttribute('data-wl-act');
      if (act === 'retry') retryWorkLogDetail(seqOf(btn));
      else if (act === 'copy') copyWorkLogDetail(seqOf(btn), btn);
      return;
    }
    if (e.target.closest('.wl-detail')) return;
    var head = e.target.closest('.wl-group-head');
    if (head && list.contains(head)) {
      var grp = head.closest('.wl-group');
      if (grp) toggleWorkLogGroup(grp.getAttribute('data-task-id'));
      return;
    }
    var row = e.target.closest('.wl-row');
    if (!row || !list.contains(row)) return;
    // Finishing a text selection inside the row is not a toggle.
    if (window.getSelection && String(window.getSelection())) return;
    toggleWorkLogEntry(seqOf(row));
  });
  list.addEventListener('keydown', function(e) {
    var row = e.target;
    var isHead = !!(row.classList && row.classList.contains('wl-group-head'));
    if (!row.classList || (!isHead && !row.classList.contains('wl-row'))) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isHead) {
        var grp = row.closest('.wl-group');
        if (grp) toggleWorkLogGroup(grp.getAttribute('data-task-id'));
      } else {
        toggleWorkLogEntry(seqOf(row));
      }
      return;
    }
    var rows = wlNavRows(list);
    var j = wlRovingIndex(e.key, rows.indexOf(row), rows.length);
    if (j < 0) return;
    e.preventDefault();
    rows[j].focus(); // focusin moves the tab stop
  });
  list.addEventListener('focusin', function(e) {
    var row = e.target;
    if (row && row.classList && (row.classList.contains('wl-row') || row.classList.contains('wl-group-head'))) wlSetTabStop(list, row);
  });
})();

// Where an opening from 작업 로그 / ?session= lands (§3.1-6): the top of the
// scroll area when the collapsed work-log header fits there (a short pending
// question above it stays in view), else the header itself.
function workLogLandingTop(sectionTop, headerHeight, viewHeight) {
  return sectionTop + headerHeight <= viewHeight ? 0 : sectionTop;
}
// Bring the collapsed work-log header into view, one click from its entries.
function scrollPanelToWorkLog() {
  var scrollEl = document.getElementById('panel-scroll');
  var section = document.getElementById('panel-worklog');
  var toggle = document.getElementById('worklog-toggle');
  if (!scrollEl || !section || section.style.display === 'none') return;
  var sectionTop = scrollEl.scrollTop + section.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
  var headerHeight = toggle ? toggle.getBoundingClientRect().height : 0;
  scrollEl.scrollTo({ top: workLogLandingTop(sectionTop, headerHeight, scrollEl.clientHeight), behavior: 'instant' });
}

// ── Slide Panel ──
// focusWorkLog = opened from a card's 작업 로그 button or a ?session= deep link:
// the work log stays collapsed like every opening, but the panel lands with its
// header in view instead of on the newest turns.
function openPanel(sessionKey, focusWorkLog) {
  const s = _sessionCache[sessionKey];
  if (!s) return;
  _panelFocusWorkLog = !!focusWorkLog;

  // Unconditional UI reset on card switch — an in-flight send from a previous
  // card must never leak "Sending..." / disabled state into this card. The
  // in-flight request still completes in the background; only the UI is reset.
  (function resetCmdUi() {
    var cmdInputEl = document.getElementById('cmd-input');
    var cmdBtnEl = document.getElementById('cmd-send');
    if (cmdInputEl) { cmdInputEl.value = ''; cmdInputEl.disabled = false; }
    if (cmdBtnEl) { cmdBtnEl.disabled = false; cmdBtnEl.textContent = 'Send'; }
  })();

  // Reset pagination state before loading this session's turns. A new panel
  // generation makes every request of the previous one stale — including a
  // close + reopen of the same session, which session-key equality misses.
  _panelGen++;
  _panelTurnsHasMore = false;
  _panelTurnsLoading = false;
  _panelTurnsOldestId = null;

  panelSessionKey = sessionKey;
  panelConvId = s.conversationId || null;
  resetWorkLog(panelConvId, true);
  setWorkLogOpen(false); // every opening starts collapsed (§3.1-6)
  _panelOlderArmed = false; // a landing never loads older turns by itself
  _panelStickBottom = false;

  // #762 — single source of truth for headline. displayHeadline carries the
  // server-resolved priority chain; older WS messages without it still get a
  // sensible fallback.
  document.getElementById('panel-title').textContent = s.displayHeadline || s.summaryTitle || s.title || 'Untitled';

  // TitleSub
  var titleSubTextEl = document.getElementById('panel-title-sub-text');
  var titleSubBtn = document.getElementById('panel-title-sub-regen');
  titleSubTextEl.textContent = '';
  titleSubBtn.style.display = 'none';

  // Meta
  const metaEl = document.getElementById('panel-meta');
  metaEl.innerHTML = [
    '<span class="meta-item"><span class="meta-label">Owner:</span> <span class="meta-value">' + esc(s.ownerName) + '</span></span>',
    '<span class="meta-item"><span class="meta-label">Workflow:</span> <span class="meta-value">' + esc(s.workflow) + '</span></span>',
    '<span class="meta-item"><span class="meta-label">State:</span> <span class="meta-value">' + esc(s.activityState) + '</span></span>',
    '<span class="meta-item"><span class="meta-label">Last:</span> <span class="meta-value">' + timeAgo(s.lastActivity) + '</span></span>',
  ].join('');

  renderPanelControls(s);

  // Links
  const linksEl = document.getElementById('panel-links');
  const linkHtml = [];
  if (s.issueUrl) linkHtml.push('<a href="' + safeHref(s.issueUrl) + '" target="_blank" rel="noopener">&#x1F4CB; ' + esc(s.issueLabel || 'Issue') + (s.issueTitle ? ' &mdash; ' + esc(String(s.issueTitle).slice(0, 50)) : '') + '</a>');
  if (s.prUrl) linkHtml.push('<a href="' + safeHref(s.prUrl) + '" target="_blank" rel="noopener">&#x1F500; ' + esc(s.prLabel || 'PR') + (s.prTitle ? ' &mdash; ' + esc(String(s.prTitle).slice(0, 50)) : '') + '</a>');
  if (s.slackThreadUrl) linkHtml.push('<a href="' + safeHref(s.slackThreadUrl) + '" target="_blank" rel="noopener">&#x1F4AC; Slack Thread</a>');
  if (s.conversationId) linkHtml.push('<a href="/conversations/' + esc(s.conversationId) + '" target="_blank">&#x1F4DD; Full Conversation</a>');
  linksEl.innerHTML = linkHtml.join('') || '<span style="font-size:0.78em;color:var(--text-secondary)">No links</span>';

  // Tokens
  const tokensEl = document.getElementById('panel-tokens');
  if (s.tokenUsage) {
    let tokHtml = [
      '<span class="token-badge"><span class="tok-label">Input:</span> <span class="tok-value">' + formatTokens(s.tokenUsage.totalInputTokens) + '</span></span>',
      '<span class="token-badge"><span class="tok-label">Output:</span> <span class="tok-value">' + formatTokens(s.tokenUsage.totalOutputTokens) + '</span></span>',
      '<span class="token-badge"><span class="tok-label">Cost:</span> <span class="tok-cost">$' + toNum(s.tokenUsage.totalCostUsd).toFixed(3) + '</span></span>',
      '<span class="token-badge"><span class="tok-label">Context:</span> <span class="tok-value">' + toNum(s.tokenUsage.contextUsagePercent).toFixed(1) + '%</span></span>',
    ].join('');
    if (s.mergeStats) {
      tokHtml += '<span class="token-badge" style="border-color:var(--green)"><span class="tok-label">Merge:</span> <span style="color:var(--green)">+' + toNum(s.mergeStats.totalLinesAdded) + ' / -' + toNum(s.mergeStats.totalLinesDeleted) + '</span></span>';
    }
    tokensEl.innerHTML = tokHtml;
  } else {
    tokensEl.innerHTML = '<span style="font-size:0.78em;color:var(--text-secondary)">No token data</span>';
  }

  // Pending question in panel
  renderPanelQuestion(s);

  // Tasks (panel card view)
  _panelTasksExpanded = false;
  renderPanelTasks(s.tasks);

  // Conversation turns — paginated (infinite scroll: latest 30, load older on scroll-up)
  const turnsEl = document.getElementById('panel-turns');
  if (s.conversationId) {
    turnsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;margin-top:40px">Loading...</p>';
    _panelTurnsLoading = true;
    var loadingConvId = s.conversationId;
    var loadingGen = _panelGen;
    fetch('/api/dashboard/session/' + encodeURIComponent(loadingConvId) + '?limit=30')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        // If the panel was switched, closed or reopened while loading, discard this result.
        if (loadingGen !== _panelGen) return;

        // Handle titleSub
        var tSubText = document.getElementById('panel-title-sub-text');
        var tSubBtn = document.getElementById('panel-title-sub-regen');
        if (data.titleSub) {
          tSubText.textContent = data.titleSub;
          tSubBtn.style.display = 'inline-block';
        } else if (loadingConvId) {
          generateTitleSub(loadingConvId);
        }

        if (!data.turns || data.turns.length === 0) {
          turnsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;margin-top:40px">No conversation turns</p>';
          _panelTurnsLoading = false;
          return;
        }
        var cid = data.id;
        _panelTurnsHasMore = !!data.hasMore;
        _panelTurnsOldestId = data.turns[0] && data.turns[0].id;
        turnsEl.innerHTML = data.turns.map(function(t, i, arr) { return renderTurn(t, i, arr, cid); }).join('');
        attachRawToggleHandlers();
        // Jump to bottom on fresh load — or to the collapsed work-log header when
        // that is what the user asked for (작업 로그 button / ?session= deep link).
        var scrollEl = document.getElementById('panel-scroll');
        // Instant: under scroll-behavior: smooth the glide down from 0 passed
        // through scrollTop < 100 and set off the load-older-turns handler.
        if (_panelFocusWorkLog) scrollPanelToWorkLog();
        else if (scrollEl) {
          scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'instant' });
          // Stay on the newest turns while the panel settles (the subtitle
          // arriving later makes the scroll area shorter) until the reader scrolls.
          _panelStickBottom = true;
        }
        _panelTurnsLoading = false;
      })
      .catch(function() {
        if (loadingGen !== _panelGen) return;
        turnsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;margin-top:40px">Failed to load conversation</p>';
        _panelTurnsLoading = false;
      });
  } else {
    turnsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;margin-top:40px">No conversation recorded</p>';
  }

  // Command input — always visible; disabled + hint for terminated / sleeping
  // sessions, or when viewer is not the session owner (#708 read-only mode).
  // Non-owner takes precedence over isClosed so the message is informative.
  const cmdEl = document.getElementById('panel-command');
  cmdEl.style.display = '';
  const cmdInput = document.getElementById('cmd-input');
  const cmdBtn = document.getElementById('cmd-send');
  const cmdHint = document.getElementById('cmd-hint');
  const isClosed = s.terminated || s.sessionState === 'SLEEPING';
  // Fail closed — mirror renderCard so a missing ownerId never unlocks the
  // panel input for a non-authenticated viewer.
  const isOwnerPanel = !!s.ownerId && s.ownerId === currentUserId;
  if (!isOwnerPanel) {
    if (cmdInput) { cmdInput.disabled = true; cmdInput.placeholder = READ_ONLY_MSG; }
    if (cmdBtn) { cmdBtn.disabled = true; }
    if (cmdHint) { cmdHint.style.display = 'none'; }
  } else if (isClosed) {
    if (cmdInput) { cmdInput.disabled = true; cmdInput.placeholder = '\uC774 \uC138\uC158\uC740 \uC885\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4'; }
    if (cmdBtn) { cmdBtn.disabled = true; }
    if (cmdHint) { cmdHint.style.display = ''; }
  } else {
    if (cmdInput) { cmdInput.disabled = false; cmdInput.placeholder = 'Send message to session...'; }
    if (cmdBtn) { cmdBtn.disabled = false; }
    if (cmdHint) { cmdHint.style.display = 'none'; }
  }

  document.getElementById('slide-panel').classList.add('open');
  document.getElementById('panel-overlay').classList.add('open');
  panelOpen = true;

  if (panelConvId) loadWorkLog();
}

// ── Pagination state for panel chat (infinite scroll) ──
var _panelTurnsHasMore = false;
var _panelTurnsLoading = false;
var _panelTurnsOldestId = null;
var _panelGen = 0; // bumped by openPanel / closePanel — the identity of one panel opening

function panelScrollAnchor(scrollEl) {
  var viewTop = scrollEl.getBoundingClientRect().top;
  var nodes = scrollEl.querySelectorAll('#panel-question, #panel-worklog, #panel-turns > .turn');
  for (var i = 0; i < nodes.length; i++) {
    var r = nodes[i].getBoundingClientRect();
    if (r.height > 0 && r.bottom > viewTop) return { el: nodes[i], top: r.top };
  }
  return null;
}

async function loadMorePanelTurns() {
  if (_panelTurnsLoading || !_panelTurnsHasMore || !panelConvId || !_panelTurnsOldestId) return;
  var turnsEl = document.getElementById('panel-turns');
  var scrollEl = document.getElementById('panel-scroll');
  if (!turnsEl || !scrollEl) return;

  _panelTurnsLoading = true;
  var requestConvId = panelConvId;
  var requestGen = _panelGen; // this panel opening; any switch/close/reopen makes it stale
  var requestOldestId = _panelTurnsOldestId;

  // Loading spinner at top of turns list.
  var spinner = document.createElement('div');
  spinner.className = 'panel-turns-loading';
  spinner.textContent = '\uC774\uC804 \uBA54\uC2DC\uC9C0 \uB85C\uB529...';
  turnsEl.insertBefore(spinner, turnsEl.firstChild);

  try {
    var url = '/api/dashboard/session/' + encodeURIComponent(requestConvId)
      + '?limit=30&before=' + encodeURIComponent(requestOldestId);
    var r = await fetch(url);
    var data = await r.json();

    // Discard a stale response: the panel was switched, closed or reopened
    // (same session included) while this request was in flight.
    if (requestGen !== _panelGen) {
      if (spinner.parentNode) spinner.remove();
      return;
    }

    // Keep the reading position: capture the first element the reader can see
    // (question / tasks / work log / a turn) NOW — after the response, so a
    // scroll made while the request was pending is respected — and after the
    // spinner goes and the older turns land, scroll by however far it moved.
    var anchor = panelScrollAnchor(scrollEl);
    if (spinner.parentNode) spinner.remove();

    if (data.turns && data.turns.length > 0) {
      _panelTurnsOldestId = data.turns[0].id;
      _panelTurnsHasMore = !!data.hasMore;
      var cid = data.id;
      var html = data.turns.map(function(t, i, arr) { return renderTurn(t, i, arr, cid); }).join('');
      turnsEl.insertAdjacentHTML('afterbegin', html);
      attachRawToggleHandlers();
      // Restore scroll position so the user stays anchored on what they were reading.
      // behavior 'instant': .panel-scroll is scroll-behavior: smooth, which would
      // otherwise show the jump and then glide back.
      if (anchor && anchor.el.isConnected) {
        var drift = anchor.el.getBoundingClientRect().top - anchor.top;
        if (drift) scrollEl.scrollTo({ top: scrollEl.scrollTop + drift, behavior: 'instant' });
      }
    } else {
      _panelTurnsHasMore = false;
      if (anchor && anchor.el.isConnected) {
        var drift0 = anchor.el.getBoundingClientRect().top - anchor.top;
        if (drift0) scrollEl.scrollTo({ top: scrollEl.scrollTop + drift0, behavior: 'instant' });
      }
    }
  } catch (err) {
    if (requestGen !== _panelGen) {
      // A stale failure must not move the panel that replaced it.
      if (spinner.parentNode) spinner.remove();
      return;
    }
    var errAnchor = panelScrollAnchor(scrollEl);
    if (spinner.parentNode) spinner.remove();
    if (errAnchor && errAnchor.el.isConnected) {
      var drift1 = errAnchor.el.getBoundingClientRect().top - errAnchor.top;
      if (drift1) scrollEl.scrollTo({ top: scrollEl.scrollTop + drift1, behavior: 'instant' });
    }
    console.error('loadMorePanelTurns failed', err);
  } finally {
    // Only the current generation owns the in-flight flag; a stale request
    // settling must not clear the flag of the load that replaced it.
    if (requestGen === _panelGen) _panelTurnsLoading = false;
  }
}

function renderTurn(t, _idx, _arr, convId) {
  const time = new Date(t.timestamp).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const initial = (t.userName || 'U').charAt(0).toUpperCase();
  var turnIdAttr = t.id ? ' data-turn-id="' + esc(t.id) + '"' : '';
  if (t.role === 'user') {
    return '<div class="turn user"' + turnIdAttr + '>'
      + '<div class="turn-avatar user-avatar">' + initial + '</div>'
      + '<div class="turn-body">'
      + '<div class="turn-header"><span class="turn-name">' + esc(t.userName || 'User') + '</span><span class="turn-time">' + time + '</span></div>'
      + '<div class="turn-content">' + esc(decodeSlackEntities((t.rawContent || '').slice(0, 500))) + ((t.rawContent && t.rawContent.length > 500) ? '...' : '') + '</div>'
      + '</div></div>';
  } else {
    const title = t.summaryTitle ? '<div class="turn-summary-title">' + esc(t.summaryTitle) + '</div>' : '';
    var body;
    if (t.summaryBody) {
      body = '<div class="turn-summary-body">' + esc(t.summaryBody) + '</div>';
    } else if (t.summarized) {
      body = '<div class="turn-summary-body" style="color:var(--text-tertiary);font-style:italic">Summary failed <button class="btn-action" style="margin-left:8px;font-size:10px;padding:2px 8px" onclick="event.stopPropagation();resummarize(\\'' + escJs(convId || panelConvId) + '\\',\\'' + escJs(t.id) + '\\',this)">&#x1F504; Retry</button></div>';
    } else {
      body = '<div class="turn-summary-body" style="color:var(--text-secondary);font-style:italic">Generating summary...</div>';
    }
    var rawToggle = '';
    var cid = convId || panelConvId;
    if (t.id && cid) {
      rawToggle = '<details class="turn-raw-details" data-conv="' + esc(cid) + '" data-turn="' + esc(t.id) + '">'
        + '<summary class="turn-expand-btn">Show raw response</summary>'
        + '<div class="turn-raw-content"><span class="turn-raw-loading">Loading...</span></div>'
        + '</details>';
    }
    return '<div class="turn assistant"' + turnIdAttr + '>'
      + '<div class="turn-avatar bot-avatar">&#x1F916;</div>'
      + '<div class="turn-body">'
      + '<div class="turn-header"><span class="turn-name">Assistant</span><span class="turn-time">' + time + '</span></div>'
      + title + body + rawToggle
      + '</div></div>';
  }
}

function appendTurnToPanel(turn) {
  const turnsEl = document.getElementById('panel-turns');
  // Scroll container is now .panel-scroll (parent of .panel-turns). Bottom-stick
  // logic must read from the scroll parent, not from panel-turns itself.
  const scrollEl = document.getElementById('panel-scroll') || turnsEl;
  const wasAtBottom = scrollEl.scrollHeight - scrollEl.scrollTop <= scrollEl.clientHeight + 40;
  turnsEl.insertAdjacentHTML('beforeend', renderTurn(turn));
  if (wasAtBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
  attachRawToggleHandlers();
}

/** Replace an existing turn element in-place (e.g., when summary arrives for an assistant turn). */
function updateTurnInPanel(existingEl, turn) {
  var tmp = document.createElement('div');
  tmp.innerHTML = renderTurn(turn);
  var newEl = tmp.firstElementChild;
  if (newEl) {
    existingEl.replaceWith(newEl);
    attachRawToggleHandlers();
  } else {
    console.warn('updateTurnInPanel: no element for turn', turn.id);
  }
}

var _rawLoadedCache = Object.create(null);
function attachRawToggleHandlers() {
  document.querySelectorAll('.turn-raw-details').forEach(function(details) {
    if (details._rawBound) return;
    details._rawBound = true;
    details.addEventListener('toggle', function() {
      if (!this.open) return;
      var convId = this.dataset.conv;
      var turnId = this.dataset.turn;
      var contentDiv = this.querySelector('.turn-raw-content');
      if (_rawLoadedCache[turnId]) {
        contentDiv.textContent = _rawLoadedCache[turnId];
        return;
      }
      fetch('/api/conversations/' + convId + '/turns/' + turnId + '/raw')
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
          _rawLoadedCache[turnId] = data.raw;
          contentDiv.textContent = data.raw;
        })
        .catch(function(err) {
          contentDiv.textContent = 'Error loading: ' + err.message;
        });
    });
  });
}

async function generateTitleSub(convId) {
  // The panel opening this request belongs to: once another panel opens (or
  // this one closes) the subtitle element shows someone else, so drop the result.
  var gen = _panelGen;
  var textEl = document.getElementById('panel-title-sub-text');
  var btn = document.getElementById('panel-title-sub-regen');
  textEl.textContent = 'Generating title...';
  btn.style.display = 'none';
  try {
    // #771 — CSRF-protected POST. Mirror doAction / answerChoice pattern:
    // attach X-CSRF-Token, and on 403 (JWT rotation invalidated the token)
    // refresh and retry once. The route applies csrfMiddleware so the prior
    // header-less fetch was an immediate 403.
    const url = '/api/dashboard/session/' + encodeURIComponent(convId) + '/generate-title';
    const headers = {};
    if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
    var res = await fetch(url, { method: 'POST', headers });
    if (gen !== _panelGen) return;
    if (res.status === 403) {
      await refreshCsrfToken();
      if (gen !== _panelGen) return;
      const retryHeaders = {};
      if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
      res = await fetch(url, { method: 'POST', headers: retryHeaders });
      if (gen !== _panelGen) return;
    }
    var data = await res.json();
    if (gen !== _panelGen) return;
    if (data.titleSub) {
      textEl.textContent = data.titleSub;
      btn.style.display = 'inline-block';
    } else {
      textEl.textContent = 'Title generation failed';
      btn.style.display = 'inline-block';
    }
  } catch(e) {
    if (gen !== _panelGen) return;
    textEl.textContent = 'Error';
    btn.style.display = 'inline-block';
  }
}

function closePanel() {
  document.getElementById('slide-panel').classList.remove('open');
  document.getElementById('panel-overlay').classList.remove('open');
  panelOpen = false;
  panelSessionKey = null;
  panelConvId = null;
  _rawLoadedCache = Object.create(null);
  _panelGen++;
  _panelTurnsHasMore = false;
  _panelTurnsLoading = false;
  _panelTurnsOldestId = null;
  resetWorkLog(null, false);
  _panelFocusWorkLog = false;
  _panelStickBottom = false;
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && panelOpen) closePanel();
});

// Scroll-up-to-load-more handler (bound once on panel-scroll).
// Older turns load when the first turn comes within 100px of the top of the
// scroll area (or sits below it, under the question / work log). One load per
// approach: entering the zone loads once and disarms; leaving it re-arms. An
// opening starts disarmed, so landing at the top (작업 로그 / ?session=) loads
// nothing by itself, and an insert that keeps the reader in place (the new
// first turn still in the zone) cannot cascade into the next page.
var _panelOlderArmed = false;
var _panelStickBottom = false; // a default landing keeps the newest turns in view until the reader acts
function olderTurnsZone(firstTurnTop, areaTop) {
  return firstTurnTop >= areaTop - 100;
}
function panelOlderStep(armed, inZone, canLoad) {
  if (!inZone) return { load: false, armed: true };
  if (armed && canLoad) return { load: true, armed: false };
  return { load: false, armed: armed };
}
(function initPanelScrollHandler() {
  var scrollEl = document.getElementById('panel-scroll');
  var turnsEl = document.getElementById('panel-turns');
  if (!scrollEl || !turnsEl) return;
  var lastTop = 0;
  scrollEl.addEventListener('scroll', function() {
    // Only the reader moving up ends the stick; the area shrinking under a
    // resting scrollTop (a late subtitle) does not.
    var top = scrollEl.scrollTop;
    if (top < lastTop && scrollEl.scrollHeight - scrollEl.clientHeight - top > 4) _panelStickBottom = false;
    lastTop = top;
    var first = turnsEl.querySelector('.turn');
    if (!first) return;
    var inZone = olderTurnsZone(first.getBoundingClientRect().top, scrollEl.getBoundingClientRect().top);
    var canLoad = _panelTurnsHasMore && !_panelTurnsLoading && !!panelConvId && !!_panelTurnsOldestId;
    var step = panelOlderStep(_panelOlderArmed, inZone, canLoad);
    _panelOlderArmed = step.armed;
    if (step.load) loadMorePanelTurns();
  }, { passive: true });
  // Any input inside the panel (expanding the work log, reading, typing) means
  // the reader took over: stop holding the newest turns.
  var panel = document.getElementById('slide-panel');
  if (panel) {
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function(type) {
      panel.addEventListener(type, function() { _panelStickBottom = false; }, { passive: true, capture: true });
    });
  }
  // The area shrinking (a subtitle arriving) or the turns growing after the
  // landing (late fonts, images) both leave the default landing short of the end.
  if (typeof ResizeObserver === 'function') {
    var stick = new ResizeObserver(function() {
      if (_panelStickBottom) scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'instant' });
    });
    stick.observe(scrollEl);
    stick.observe(turnsEl);
  }
})();

// ── Send command (optimistic UI) ──
let _lastSentContent = '';
let _lastSentTime = 0;

async function sendCommand() {
  const input = document.getElementById('cmd-input');
  const btn = document.getElementById('cmd-send');
  const msg = input.value.trim();
  if (!msg || !panelSessionKey) return;
  // Guard: do not send while the input is disabled (e.g., terminated session).
  if (input.disabled) return;

  // Capture the session this send belongs to. We must never mutate shared UI
  // (cmd-input/cmd-send) after the user has already switched to a different card,
  // otherwise the new card inherits stale "Sending..." / disabled state.
  const sendingSessionKey = panelSessionKey;

  // Optimistic: immediately show user turn in panel
  _lastSentContent = msg;
  _lastSentTime = Date.now();
  const optimisticTurn = {
    id: 'optimistic-' + Date.now(),
    role: 'user',
    timestamp: Date.now(),
    userName: 'You',
    rawContent: msg,
    _optimistic: true,
  };
  appendTurnToPanel(optimisticTurn);

  btn.disabled = true;
  btn.textContent = 'Sending...';
  input.disabled = true;
  input.value = '';

  try {
    const cmdHeaders = { 'Content-Type': 'application/json' };
    if (_csrfToken) cmdHeaders['X-CSRF-Token'] = _csrfToken;
    const cmdUrl = '/api/dashboard/session/' + encodeURIComponent(sendingSessionKey) + '/command';
    const cmdBody = JSON.stringify({ message: msg });
    let res = await fetch(cmdUrl, { method: 'POST', headers: cmdHeaders, body: cmdBody });
    if (res.status === 403) {
      await refreshCsrfToken();
      const retryHeaders = { 'Content-Type': 'application/json' };
      if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
      res = await fetch(cmdUrl, { method: 'POST', headers: retryHeaders, body: cmdBody });
    }
    if (!res.ok) {
      // Only mark the optimistic turn as failed if the user is still on the same
      // card; otherwise the "last user turn" in the DOM belongs to a different session.
      if (panelSessionKey === sendingSessionKey) {
        var lastTurn = document.querySelector('.turn.user:last-child');
        if (lastTurn) {
          lastTurn.style.borderColor = '#e74c3c';
          lastTurn.style.opacity = '0.7';
          lastTurn.insertAdjacentHTML('beforeend', '<div style="color:#e74c3c;font-size:0.75em;margin-top:4px">Failed to send. <a href="#" onclick="event.preventDefault();sendRetry(\\'' + escJs(msg) + '\\')">Retry</a></div>');
        }
      }
    }
  } catch (e) {
    console.error('Command error', e);
  } finally {
    // Only reset the input/button if we are still on the originating card.
    // openPanel already resets UI on card switch, so skipping here prevents
    // the late-completing fetch from clobbering the new card's clean state.
    if (panelSessionKey === sendingSessionKey) {
      btn.disabled = false;
      btn.textContent = 'Send';
      input.disabled = false;
      input.focus();
    }
  }
}

function sendRetry(msg) {
  document.getElementById('cmd-input').value = msg;
  sendCommand();
}

// ── Board interactions — card face click / Enter / Space expands in place.
// Delegated from #kanban so the reconciler never re-binds per card. (Drag and
// drop and its confirm dialogs were removed: .prd/10 §3.1-5 — the same Stop / Close / Trash
// actions live on the open card.)
(function initBoardInteractions() {
  var kb = document.getElementById('kanban');
  kb.addEventListener('click', function(e) {
    var face = e.target.closest('.card-face');
    if (!face || !kb.contains(face)) return;
    var key = face.parentNode.getAttribute('data-session-key');
    if (!key) return;
    // Finishing a text selection inside the face is not a toggle.
    if (window.getSelection && String(window.getSelection())) return;
    toggleCard(key, e.detail === 0);
  });
  kb.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var face = e.target;
    if (!face.classList || !face.classList.contains('card-face')) return;
    e.preventDefault();
    var key = face.parentNode.getAttribute('data-session-key');
    if (key) toggleCard(key, true);
  });
  // View: the saved choice, else List on narrow screens (§3.1-2).
  var saved = null;
  try { saved = localStorage.getItem('soma-board-view'); } catch (_e) {}
  setBoardView(saved === 'board' || saved === 'list' ? saved : (window.innerWidth < 640 ? 'list' : 'board'));
})();

// ── Init ──
loadUsers();
loadSessions().then(function() { loadStats(); });
connectWs();
setInterval(loadSessions, 30000);
</script>
</body>
</html>`;
}
