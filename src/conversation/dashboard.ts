/**
 * Dashboard module — personal Kanban board + statistics.
 * Extends the existing Fastify conversation web server.
 *
 * Routes:
 *   GET  /dashboard                          → Dashboard HTML (all users overview)
 *   GET  /dashboard/:userId                  → Dashboard HTML (specific user)
 *   GET  /api/dashboard/sessions             → All active sessions as Kanban data (JSON)
 *   GET  /api/dashboard/stats                → User statistics (JSON)
 *   GET  /api/dashboard/users                → User list (JSON)
 *   GET  /api/dashboard/session/:id          → Session detail turns (JSON)
 *   POST /api/dashboard/session/:id/generate-title → Generate titleSub via codex model
 *   POST /api/dashboard/session/:key/stop    → Stop a working session
 *   POST /api/dashboard/session/:key/close   → Close/terminate a session
 *   POST /api/dashboard/session/:key/trash   → Trash (hide) a closed session
 *   POST /api/dashboard/session/:key/command → Send command to session
 *   POST /api/dashboard/session/:conversationId/resummarize/:turnId → Retry summary generation
 *   WS   /ws/dashboard                       → Real-time session state updates (WebSocket)
 */

import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { displayTitle } from '../format/display-title';
import { Logger } from '../logger';
import { MetricsEventStore } from '../metrics/event-store';
import { ReportAggregator } from '../metrics/report-aggregator';
import { AggregatedMetrics, type MetricsEvent } from '../metrics/types';
import { type ArchivedSession, getArchiveStore } from '../session-archive';
import { getSurfaceLines } from '../slack/surface-config';
import { buildThreadPermalink } from '../turn-notifier';
import { coerceEffort, type EffortLevel, userSettingsStore } from '../user-settings-store';
import { fetchSiblingBoards, type InstanceEnvironment, mergeBoards, shouldAggregate } from './aggregator';
import { readAllInstances } from './instance-registry';
import { getConversation, resummarizeTurn, updateConversationTitleSub } from './recorder';
import { generateTitle } from './title-generator';

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
  /** Token usage */
  tokenUsage?: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    contextUsagePercent: number;
  };
  /** Task list */
  tasks?: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    startedAt?: number;
    completedAt?: number;
  }>;
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
  userId: string;
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

type TaskAccessor = (sessionKey: string) =>
  | Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      startedAt?: number;
      completedAt?: number;
    }>
  | undefined;
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
  links?: { issue?: { url?: string }; pr?: { url?: string } };
  persistedEffort: boolean;
}): Pick<KanbanSession, 'effort' | 'issueShortRef' | 'prShortRef'> {
  const effort =
    src.persistedEffort && src.effort
      ? coerceEffort(src.effort)
      : userSettingsStore.getUserDefaultEffort(src.ownerId || '');
  return {
    effort,
    issueShortRef: extractIssueShortRef(src.links?.issue?.url),
    prShortRef: extractPrShortRef(src.links?.pr?.url),
  };
}

function sessionToKanban(key: string, s: any): KanbanSession {
  const tasks = _getTasksFn ? _getTasksFn(key) : undefined;
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
    tokenUsage: s.usage
      ? {
          totalInputTokens: s.usage.totalInputTokens || 0,
          totalOutputTokens: s.usage.totalOutputTokens || 0,
          totalCostUsd: s.usage.totalCostUsd || 0,
          contextUsagePercent: s.usage.contextWindow
            ? (((s.usage.currentInputTokens || 0) +
                (s.usage.currentCacheReadTokens || 0) +
                (s.usage.currentCacheCreateTokens || 0) +
                (s.usage.currentOutputTokens || 0)) /
                s.usage.contextWindow) *
              100
            : 0,
        }
      : undefined,
    tasks,
    slackThreadUrl:
      s.channelId && s.threadTs ? (buildThreadPermalink(s.channelId, s.threadTs) ?? undefined) : undefined,
    // Dashboard v2.1 — timer + compaction fields
    activeLegStartedAtMs: s.activeLegStartedAtMs,
    activeAccumulatedMs: s.activeAccumulatedMs || 0,
    compactionCount: s.compactionCount || 0,
    threadTotalActiveMs: aggregate.totalActiveMs,
    threadSessionCount: aggregate.sessionCount,
    threadCompactionCount: aggregate.compactionCount,
    ...cardDerivedFields({ effort: s.effort, ownerId: s.ownerId, links: s.links, persistedEffort: true }),
    // #814 Stamp self env (when wired) so the frontend renders the env
    // badge for self cards too — siblings get their env from the
    // aggregator's mergeBoards stamp.
    environment: _selfInstanceEnv ? { ..._selfInstanceEnv } : undefined,
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

// Dashboard archive display window: 48 hours
const DASHBOARD_ARCHIVE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

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
          totalCostUsd: archived.usage.totalCostUsd || 0,
          contextUsagePercent: 0, // No active context for archived sessions
        }
      : undefined,
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
          board.idle.push(kanban);
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

    const archives = getArchiveStore().listRecent(DASHBOARD_ARCHIVE_MAX_AGE_MS);
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

function aggregateUserStats(events: MetricsEvent[], userId: string): Map<string, UserDayStats> {
  const dayMap = new Map<string, UserDayStats>();

  for (const ev of events) {
    if (ev.userId !== userId) continue;

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
  tasks: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm?: string;
    startedAt?: number;
    completedAt?: number;
  }>,
): void {
  if (wsClients.size === 0) return;
  try {
    // #814 External callers (e.g. Slack handler) pass the raw session key.
    // Compose the wire-format key here so the client cache (keyed by
    // composite `${instanceName}::${rawKey}`) finds the card.
    const wireKey = composeSessionKey(sessionKey);
    const payload = JSON.stringify({ type: 'task_update', sessionKey: wireKey, tasks });
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

/** Broadcast conversation turn update — scoped to session owner's WS clients only */
export function broadcastConversationUpdate(conversationId: string, turn: any): void {
  if (wsClients.size === 0) return;
  try {
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

    // Strip rawContent from assistant turns to reduce bandwidth
    const sanitizedTurn = turn?.role === 'assistant' && turn?.rawContent ? { ...turn, rawContent: undefined } : turn;
    const payload = JSON.stringify({ type: 'conversation_update', conversationId, turn: sanitizedTurn });
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
  } catch (error) {
    logger.error('Failed to broadcast conversation update', error);
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

      // #814 — when not the recursion-guarded selfOnly path, ask the
      // aggregator to fan out to sibling instances on the same host.
      // Skip pre-listen / single-instance.
      if (!_selfInstanceEnv) {
        reply.send({ board });
        return;
      }
      if (selfOnly) {
        reply.send({ board });
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
          reply.send({ board });
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
        reply.send({ board: merged });
      } catch (err) {
        // Hard failure of the aggregator must never surface a 500 —
        // fall back to self-only. Log at error (with stack) so a
        // genuine bug in mergeBoards / fetch wiring is visible, not
        // confused with the warn-throttled per-sibling failures.
        logger.error('Aggregator failed; serving self-only board', err);
        reply.send({ board });
      }
    },
  );

  // User stats
  server.get<{ Querystring: { userId: string; period?: string } }>(
    '/api/dashboard/stats',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { userId, period: rawPeriod } = request.query;
      if (!userId) {
        reply.status(400).send({ error: 'userId is required' });
        return;
      }
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

        reply.send({ userId, period, days, totals } satisfies UserStats);
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
      for (const [qId, sel] of Object.entries(selections)) {
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
      const { wireKey: key, originalKey } = resolved;
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
  --text-tertiary: #7c7c85;
  /* Functional color — Bauhaus primary triad + accents */
  --accent: #4d9de0;
  --accent-hover: #3b82c4;
  --green: #3ecf8e;
  --yellow: #f6c90e;
  --red: #ef4444;
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
  /* Agent inbox board — neutral planes: column one step darker than the page */
  --ib-col: #18181b;
  --ib-card: #242428;
  --ib-card-dim: #1f1f23;
  --ib-card-border: #34343a;
  --ib-pill: #2f2f35;
  --ib-text: #f2f2f3;
  --ib-text-2: #b4b4bb;
  --ib-muted: #87878f;
  --ib-seg: #161619;
  --ib-seg-on: #2e2e33;
  --ib-spark: #7b9cf0;
  --ib-shadow: 0 1px 2px rgba(0,0,0,0.35);
  --ib-shadow-raised: 0 14px 32px rgba(0,0,0,0.5), 0 3px 8px rgba(0,0,0,0.35);
  --st-wait: #f5a524;
  --st-run: #6b93f2;
  --st-done: #3fb968;
  --st-fail: #f05252;
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
  --text-tertiary: #85858c;
  --accent: #2b7fd4;
  --accent-hover: #2468b0;
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
  --ib-muted: #6f6f74;
  --ib-seg: #ebebeb;
  --ib-seg-on: #ffffff;
  --ib-spark: #5b7fe0;
  --ib-shadow: 0 1px 2px rgba(0,0,0,0.06);
  --ib-shadow-raised: 0 14px 30px rgba(0,0,0,0.14), 0 3px 8px rgba(0,0,0,0.08);
  --st-wait: #c2780a;
  --st-run: #2f63e0;
  --st-done: #17914a;
  --st-fail: #d43a3a;
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

/* ── TOPBAR — strict horizontal grid ── */
.topbar {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 48px;
  min-width: 0;
}
.topbar h1 {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  flex-shrink: 0;
}
.topbar .nav { display: flex; gap: 6px; margin-left: auto; align-items: center; min-width: 0; }
.topbar .nav a,
.topbar .nav select {
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
}
.topbar .nav select { min-width: 0; inline-size: clamp(72px, 24vw, 140px); }
.topbar .nav a:hover,
.topbar .nav select:hover { border-color: var(--accent); color: var(--text); }

/* ── USER PILL — "Logged in as <name>" + logout, rendered from /auth/me ── */
.topbar .user-pill {
  display: none; /* toggled by JS once /auth/me resolves */
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
  cursor: default;
  white-space: nowrap;
  max-width: 260px;
  min-width: 0;
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
.topbar .user-pill[data-clickable="true"] { cursor: pointer; transition: border-color var(--speed) var(--ease); }
.topbar .user-pill[data-clickable="true"]:hover { border-color: var(--accent); color: var(--text); }

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
}

/* ── MAIN — board-first column, capped at 1280px and centred (.prd/10 §5) ── */
.main { flex: 1; padding: 20px; width: 100%; max-width: 1280px; margin: 0 auto; min-width: 0; }

/* ── PERIOD SELECTOR — segmented control ── */
.period-bar { display: inline-flex; gap: 0; margin-bottom: 16px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.period-btn {
  background: var(--surface);
  color: var(--text-secondary);
  border: none;
  border-right: 1px solid var(--border);
  padding: 8px 16px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: background var(--speed) var(--ease), color var(--speed) var(--ease);
  min-height: 32px;
}
.period-btn:last-child { border-right: none; }
.period-btn:hover { background: var(--surface-raised); color: var(--text); }
.period-btn.active { background: var(--accent); color: var(--bg); font-weight: 700; }

/* ── STATS GRID — 4-column, monospace numbers ── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
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

/* Board = 3 equal columns. No overflow clip on columns: a card flying between
   columns must stay visible over its neighbours. */
.kanban { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; }
.kanban-col { background: var(--ib-col); border-radius: 14px; padding: 2px 4px 4px; min-width: 0; display: flex; flex-direction: column; }
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
.card-face { padding: 12px 14px; cursor: pointer; border-radius: 11px; }
.card-face:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-spark { flex-shrink: 0; display: inline-flex; color: var(--st-color); }
.card .card-title-text { font-size: 15px; font-weight: 600; line-height: 1.3; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

/* Expansion — grid row 0fr → 1fr. min-height/overflow live on the grid item
   so the row can collapse to zero; siblings below move with the animated row. */
.card-expand { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-expand) var(--ease-out); }
.card.is-expanded .card-expand { grid-template-rows: 1fr; }
.card-expand-inner { min-height: 0; overflow: hidden; opacity: 0; transition: opacity var(--dur-expand) var(--ease-out); }
.card.is-expanded .card-expand-inner { opacity: 1; }
.card.no-motion .card-expand, .card.no-motion .card-expand-inner { transition: none; }
.card-body { margin: 0 14px; padding: 12px 0 14px; border-top: 1px solid var(--ib-card-border); font-size: 13px; color: var(--ib-text-2); }
.cb-model { color: var(--ib-muted); font-size: 13px; }

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
     toggled by the tap handler in updateTokenStats(). */
  #stat-tokens-wrap:hover #stat-tokens-tooltip { display: none; }
  #stat-tokens-wrap.tooltip-open #stat-tokens-tooltip { display: block; }
}

/* ── CONTEXT USAGE BAR ── */
.card .context-bar { margin-top: 8px; height: 4px; background: var(--ib-pill); border-radius: 2px; overflow: hidden; }
.card .context-bar-fill { height: 100%; border-radius: 2px; transition: width 0.3s ease; background: var(--st-run); }
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
.card .choice-row-recommended { order: 2; }
.card .btn-choice { font-size: 13px; padding: 5px 12px; min-height: 32px; border-radius: 8px; border: 1px solid var(--ib-card-border); background: var(--ib-card); color: var(--ib-text); text-align: left; }
.card .choice-row-recommended .btn-choice-recommended,
.card .btn-choice-recommended { display: inline-flex; align-items: center; width: auto; background: var(--ib-text); border-color: var(--ib-text); color: var(--ib-card); font-weight: 600; }

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
/* Panel tasks section */
.panel-tasks {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  max-height: 260px;
  overflow-y: auto;
}
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
/* Panel work log (.prd/10 §3.1-7, §3.3) — what the agent did, in order. Own
   scroll box so live appends tail-follow without moving the turn list. */
.panel-worklog { padding: 8px 16px 10px; border-bottom: 1px solid var(--border); }
.panel-worklog-header {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  letter-spacing: 0.04em;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-worklog-header .wl-count { font-weight: 600; color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.worklog-list { max-height: min(48vh, 440px); overflow-y: auto; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; line-height: 1.45; }
.wl-empty { color: var(--text-tertiary); font-size: 12px; padding: 6px 0; }
.wl-entry { color: var(--text); min-width: 0; }
.wl-head { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--text-tertiary); }
.wl-label { font-weight: 700; letter-spacing: 0.04em; }
.wl-head .wl-time { margin-left: auto; }
.wl-time { color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.wl-entry > .wl-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.wl-line { display: flex; align-items: baseline; gap: 8px; }
.wl-line > .wl-text { flex: 1; min-width: 0; }
.wl-narration > .wl-text { color: var(--text-secondary); }
.wl-instruction { background: rgba(77,157,224,0.08); border-left: 2px solid var(--accent); border-radius: 4px; padding: 6px 8px; margin: 4px 0; }
.wl-instruction .wl-label { color: var(--accent); }
.wl-final { border-left: 2px solid var(--green); padding: 4px 8px; margin: 4px 0; }
.wl-final .wl-label { color: var(--green); }
.wl-notice > .wl-text { color: var(--text-tertiary); font-style: italic; }
.wl-error { border-left: 2px solid var(--red); padding: 4px 8px; }
.wl-error .wl-label, .wl-error > .wl-text { color: var(--red); }
.wl-tool, .wl-tool_result {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-family: 'SF Mono','Fira Code',ui-monospace,monospace;
  font-size: 11.5px;
  color: var(--text-secondary);
  min-width: 0;
}
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
/* Unified scroll container: wraps panel-question + panel-tasks + panel-turns
   so large UIAskQ choices or long task lists naturally scroll together with the
   chat content. .panel-command stays pinned below as a non-scrolling sibling. */
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

/* ── CLOSED CARDS — 7-day "Show older" toggle at the foot of DONE ── */
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

/* ── PRESS — buttons and segments give 0.97 feedback (§4-5) ── */
.btn-action:active:not(:disabled), .seg-btn:active, .show-older-btn:active, .btn-choice:active:not(:disabled) { transform: scale(0.97); }

/* ── HOVER — pointer devices only; colour/border, never movement (§4-6) ── */
@media (hover: hover) and (pointer: fine) {
  .card:hover { border-color: var(--ib-muted); }
  .card[data-state="sleeping"]:hover, .card[data-state="archived"]:hover { border-color: var(--ib-card-border); }
  .seg-btn:hover { color: var(--ib-text); }
  .btn-action:hover:not(:disabled) { border-color: var(--ib-muted); }
  .btn-action.btn-primary:hover:not(:disabled) { opacity: 0.88; }
  .btn-action.btn-stop:hover:not(:disabled) { border-color: var(--st-fail); }
  .show-older-btn:hover { border-color: var(--ib-muted); color: var(--ib-text); }
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
}
@media (max-width: 639px) {
  .main { padding: 14px 12px; }
  .inbox-head { margin-bottom: 12px; }
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
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 680px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 12px; }
  .stat-card { padding: 8px 12px; }
  .stat-card .value { font-size: 18px; }
  .stat-card .label { font-size: 10px; }
  .chart-row { flex-direction: column; }
  .slide-panel { width: 100vw; right: -100vw; }
  .topbar { padding: 0 10px; gap: 6px; }
  .topbar h1 { font-size: 12px; }
  .topbar .nav { gap: 4px; }
  .topbar .nav a, .topbar .nav select { font-size: 11px; padding: 4px 8px; }
  .topbar .nav .nav-text { display: none; }
  .topbar .nav .nav-icon { display: inline !important; }
  /* ws-badge → 10px round dot; aria-label preserved for SR */
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
  .topbar .user-pill { max-width: 140px; padding: 4px 8px; }
  .topbar .user-pill-prefix { display: none; }
  .topbar .admin-toggle { padding: 4px 8px; font-size: 11px; }
  #theme-toggle {
    inline-size: 32px;
    block-size: 32px;
    padding: 0;
    flex-shrink: 0;
  }
}
@media (max-width: 480px) {
  .topbar { padding: 0 8px; gap: 4px; }
  .topbar h1 {
    font-size: 11px;
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .topbar .user-pill { max-width: 100px; }
  .topbar .nav select { inline-size: clamp(60px, 22vw, 100px); }
  .topbar .admin-mode-prefix { display: none; }
  .topbar .admin-toggle { font-size: 10px; padding: 4px 6px; }
}
@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  /* §4-8: no movement or scale — the expanded body only cross-fades. These
     selectors are more specific than the * rule above, so they win. */
  .card-expand { transition: none !important; }
  .card-expand-inner { transition: opacity var(--dur-fade) linear !important; }
  .btn-action:active:not(:disabled), .seg-btn:active, .show-older-btn:active, .btn-choice:active:not(:disabled) { transform: none; }
}
/* ── TOUCH — coarse pointer enlargement ── */
@media (pointer: coarse) {
  .btn-action { min-height: 40px; padding: 8px 12px; font-size: 12px; }
  .btn-send { min-height: 44px; padding: 12px 16px; }
  .panel-command input { min-height: 44px; padding: 12px 16px; }
  .panel-close { width: 40px; height: 40px; }
  .topbar .nav a, .topbar .nav select { min-height: 40px; padding: 8px 16px; }
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
  .topbar .nav a, .topbar .nav select { padding: 4px 8px; }
}
@media (max-width: 480px) and (pointer: coarse) {
  .topbar .nav a, .topbar .nav select { padding: 4px 6px; }
}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <h1>&#x26A1; soma-work</h1>
    <span class="ws-badge" id="ws-status" role="status" aria-label="WebSocket: Connecting">Connecting...</span>
    <div class="nav">
      <select id="user-select" onchange="selectUser(this.value)">
        <option value="">All Users</option>
      </select>
      <a href="/conversations">&#x1F4DD; <span class="nav-text">Conversations</span><span class="nav-icon" style="display:none">Conv</span></a>
      <button
        id="admin-mode-toggle"
        type="button"
        class="admin-toggle"
        style="display:none"
        aria-pressed="false"
        title="Toggle admin write mode (#716)"
        onclick="toggleAdminMode()"
      ><span id="admin-mode-label"><span class="admin-mode-prefix">Admin: </span><span class="admin-mode-state">OFF</span></span></button>
      <span
        class="user-pill"
        id="user-pill"
        title="Click to logout"
        data-clickable="false"
        onclick="handleUserPillClick()"
      ><span class="user-pill-prefix">Logged in as </span><b id="user-pill-name">…</b></span>
      <button id="theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme"></button>
    </div>
  </div>

  <div class="main">
    <!-- Agent inbox (.prd/10 §3.1) — the board leads; usage stats follow below it. -->
    <section class="inbox" id="inbox" aria-label="Agent inbox">
      <div class="inbox-head">
        <nav class="crumbs" aria-label="Breadcrumb"><span class="crumb-root">soma-work</span><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-cur" aria-current="page">Agent inbox</span></nav>
        <div class="seg" role="group" aria-label="Board layout">
          <button type="button" class="seg-btn" data-view="board" aria-pressed="true" onclick="setBoardView('board', event)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="2.5" width="4.5" height="11" rx="1.2"/><rect x="9.5" y="2.5" width="4.5" height="7" rx="1.2"/></svg><span>Board</span></button>
          <button type="button" class="seg-btn" data-view="list" aria-pressed="false" onclick="setBoardView('list', event)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg><span>List</span></button>
        </div>
      </div>
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

    <div class="period-bar">
      <button class="period-btn active" data-period="day" onclick="setPeriod('day')">&#xC624;&#xB298;</button>
      <button class="period-btn" data-period="week" onclick="setPeriod('week')">&#xC9C0;&#xB09C; 7&#xC77C;</button>
      <button class="period-btn" data-period="month" onclick="setPeriod('month')">&#xC9C0;&#xB09C; 30&#xC77C;</button>
    </div>

    <div class="stats-grid" id="stats-grid">
      <div class="stat-card"><div class="label">&#xC138;&#xC158;</div><div class="value" id="stat-sessions">-</div></div>
      <div class="stat-card"><div class="label">&#xD134; &#xC0AC;&#xC6A9;</div><div class="value" id="stat-turns">-</div></div>
      <div class="stat-card"><div class="label">PR &#xC0DD;&#xC131;</div><div class="value" id="stat-prs">-</div></div>
      <div class="stat-card"><div class="label">PR &#xBA38;&#xC9C0;</div><div class="value" id="stat-merged">-</div></div>
      <div class="stat-card"><div class="label">&#xBA38;&#xC9C0; &#xCF54;&#xB4DC;</div><div class="value" id="stat-merge-lines">-</div></div>
      <div class="stat-card"><div class="label">&#xD1A0;&#xD070; &#xC0AC;&#xC6A9;</div><div class="value" id="stat-tokens-wrap"><span id="stat-tokens">-</span><span id="stat-tokens-tooltip" role="tooltip"></span></div></div>
      <div class="stat-card"><div class="label">&#xBE44;&#xC6A9; (USD)</div><div class="value" id="stat-cost">-</div></div>
      <div class="stat-card"><div class="label">&#xC6CC;&#xD06C;&#xD50C;&#xB85C;&#xC6B0;</div><div class="value" id="stat-workflows" style="font-size:0.85em">-</div></div>
    </div>
    <div style="display:none" id="stat-commits-hidden"></div>

    <div class="chart-row" id="chart-row"></div>
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
    <div class="panel-meta" id="panel-meta"></div>
    <div class="panel-links" id="panel-links"></div>
    <div class="panel-tokens" id="panel-tokens"></div>
    <!-- Unified scroll area: question + tasks + work log + turns scroll together as one. -->
    <div class="panel-scroll" id="panel-scroll">
      <div class="panel-question" id="panel-question" style="display:none"></div>
      <div class="panel-tasks" id="panel-tasks" style="display:none"></div>
      <div class="panel-worklog" id="panel-worklog" style="display:none">
        <div class="panel-worklog-header"><span>작업 로그</span><span class="wl-count" id="worklog-count"></span></div>
        <div class="worklog-list" id="worklog-list" role="log" aria-live="polite" aria-label="작업 로그"></div>
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
let showOlderClosed = false;
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
        + '<button class="btn-choice btn-choice-recommended" onclick="event.stopPropagation();answerChoice(\\'' + escJs(s.key) + '\\',\\'' + escJs(pnlRecOpt.id) + '\\',\\'' + escJs(recLbl) + '\\',\\'' + escJs(q.question) + '\\',this)">' + esc(pnlRecOpt.id) + '. ' + esc(recLbl) + (pnlRecOpt.description ? ' <span style="color:var(--text-tertiary);font-size:0.9em">&mdash; ' + esc(pnlRecOpt.description) + '</span>' : '') + '</button>'
        + '</div>'
        + (pnlOthers.length > 0 ? '<hr class="choice-divider">' : '');
    }
    var pnlOtherBtns = pnlOthers.map(function(c) {
      var lbl2 = stripRecommendedMarker(c.label);
      return '<button class="btn-choice" onclick="event.stopPropagation();answerChoice(\\'' + escJs(s.key) + '\\',\\'' + escJs(c.id) + '\\',\\'' + escJs(lbl2) + '\\',\\'' + escJs(q.question) + '\\',this)">' + esc(c.id) + '. ' + esc(lbl2) + (c.description ? ' <span style="color:var(--text-tertiary);font-size:0.9em">&mdash; ' + esc(c.description) + '</span>' : '') + '</button>';
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

function renderPanelTasks(tasks) {
  var container = document.getElementById('panel-tasks');
  if (!tasks || tasks.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';

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

  var timeHtml = '';
  if (t.startedAt || t.completedAt) {
    var parts = [];
    if (t.startedAt) parts.push(formatTaskTime(t.startedAt));
    if (t.completedAt) parts.push(formatTaskTime(t.completedAt));
    timeHtml = '<div class="task-time" title="' + parts.join(' → ') + '">' + (timeInfo || parts.join('→')) + '</div>';
  }

  return '<div class="panel-task-item ' + cls + '">'
    + '<span class="task-icon">' + icon + '</span>'
    + '<span class="task-text">' + esc(t.content) + '</span>'
    + timeHtml
    + '</div>';
}
let _csrfToken = '';

/*
 * Populate the "Logged in as <name>" pill in the topbar.
 *
 * Rendered from /auth/me for three session types:
 *   - OAuth JWT (Google/Microsoft/Slack SSO) — shows user.name, pill is
 *     clickable and logs out on click.
 *   - bearer_cookie (admin viewer token) — shows "Admin" with a star marker,
 *     still clickable (logout clears the cookie).
 *   - unauthenticated (/auth/me → 401) — pill stays hidden; auth middleware
 *     is about to redirect us to /login anyway.
 *
 * Kept in sync with server-side setCookieAndRedirect / clearCookieAndRedirect —
 * the click handler calls GET /auth/logout (not a form POST) because the
 * logout endpoint is intentionally CSRF-free; it only clears the cookie.
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
    pill.setAttribute('data-clickable', 'false');
    return;
  }
  nameEl.textContent = label;
  pill.style.display = 'inline-flex';
  pill.classList.toggle('is-admin', isAdmin);
  pill.setAttribute('data-clickable', 'true');

  // #716: admin-mode toggle visibility. Only ADMIN_USERS members see
  // the button; clicking it stores soma_admin_mode in localStorage and
  // _adminFetch attaches X-Admin-Mode: <on|off> to every API call.
  // Bearer-cookie admin (viewer token) is treated as always-admin and
  // also gets the toggle.
  const isAdminCapable = !!(data && (data.isAdmin || (data.user && data.user.name && data.isAdmin)));
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
function handleUserPillClick() {
  const pill = document.getElementById('user-pill');
  if (!pill || pill.getAttribute('data-clickable') !== 'true') return;
  location.href = '/auth/logout';
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
  // Prefer split-span structure (prefix + state) so CSS can hide the
  // "Admin: " prefix at narrow viewports without losing the ON/OFF state.
  // Falls back to flat textContent if the spans haven't been rendered yet
  // (e.g. legacy template / unit test setup).
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

// ── Utility ──
function decodeSlackEntities(s) {
  return (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
// Dashboard v2.1 — \`Nm SSs\` for the 1s live tick. Mirrors src/format/duration.ts.
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
}

function selectUser(userId) {
  currentUserId = userId;
  history.replaceState(null, '', userId ? '/dashboard/' + userId : '/dashboard');
  loadSessions();
  loadStats();
}

// ── Period ──
function setPeriod(period) {
  currentPeriod = period;
  document.querySelectorAll('.period-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.period === period);
  });
  loadStats();
}

// ── Session cache ──
let _sessionCache = {};

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
  var envs = {};
  for (var k in _sessionCache) {
    var c = _sessionCache[k];
    if (c && c.environment && c.environment.instanceName) {
      envs[c.environment.instanceName] = true;
    }
  }
  var sorted = Object.keys(envs).sort();
  var assigned = {};
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
// recent archives; older than 7 days stays behind "Show older"). The server
// buckets (KanbanBoard) are unchanged — only the client folds idle + closed
// into one column.
var BOARD_COLS = ['waiting', 'working', 'done'];
var SPARK_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7 1.5c.5 3.3 2.2 5 5.5 5.5-3.3.5-5 2.2-5.5 5.5C6.5 9.2 4.8 7.5 1.5 7c3.3-.5 5-2.2 5.5-5.5z"/><circle cx="13" cy="12.6" r="1.3"/></svg>';
var WAIT_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.8 15 14H1z"/></svg>';
var TASKS_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.2l1.4 1.4 2.4-2.6M2.5 10.2l1.4 1.4 2.4-2.6M9 4.5h4.5M9 10.5h4.5"/></svg>';
var CTX_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 8V2.4A5.6 5.6 0 0 1 13.6 8z" fill="currentColor" stroke="none"/></svg>';

// Board state that survives re-renders — the DOM is reused, never rebuilt.
var _cardEls = {};          // session key → persistent card shell
var _expanded = new Set();  // keys whose card is open
var _boardRenders = 0;
var _exiting = [];          // cards fading out after leaving the board
var _ioCache = {};          // conversationId → { state, stamp, data, dirty }

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

function renderBoard(board) {
  _sessionCache = {}; // Clear stale cache each render cycle
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
  var closed = board.closed || [];
  var sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  var recent = closed.filter(function(s) { return new Date(s.lastActivity).getTime() >= sevenDaysAgo; });
  var older = closed.filter(function(s) { return new Date(s.lastActivity).getTime() < sevenDaysAgo; });
  function tag(col) { return function(s) { return { s: s, col: col }; }; }
  var done = (board.idle || []).map(tag('idle')).concat(recent.map(tag('closed')));
  if (showOlderClosed) done = done.concat(older.map(tag('closed')));
  reconcileBoard({
    waiting: (board.waiting || []).map(tag('waiting')),
    working: (board.working || []).map(tag('working')),
    done: done,
  }, {
    waiting: (board.waiting || []).length,
    working: (board.working || []).length,
    done: (board.idle || []).length + closed.length,
  });
  renderOlderToggle(older.length);
  _boardRenders++;
  openDeepLinkedSession();
}

// Keyed reconciler (§3.1-6). Each card keeps its DOM node for its whole life:
// it is moved between columns, only the parts whose HTML changed are
// rewritten, and every card whose on-screen position moved is FLIPped from
// where it was (§4-2). A render with unchanged data writes nothing.
function reconcileBoard(plan, counts) {
  var animate = canAnimate();
  clearExitingCards();
  var first = animate ? measureCards() : null;
  var firstCol = {};
  for (var k0 in _cardEls) firstCol[k0] = _cardEls[k0]._colId;
  var wanted = {};
  var changed = false;
  for (var c = 0; c < BOARD_COLS.length; c++) {
    var colId = BOARD_COLS[c];
    var container = document.getElementById('cards-' + colId);
    var items = plan[colId] || [];
    var slot = 0;
    for (var i = 0; i < items.length; i++) {
      var s = items[i].s;
      var key = s.key;
      if (wanted[key]) continue; // a key listed twice renders once
      wanted[key] = true;
      var el = _cardEls[key];
      if (!el) {
        el = createCardShell(key);
        _cardEls[key] = el;
        el._isNew = true;
        changed = true;
      }
      if (patchCard(el, s, items[i].col)) changed = true;
      el._colId = colId;
      applyExpanded(el, _expanded.has(key));
      if (container.children[slot] !== el) {
        container.insertBefore(el, container.children[slot] || null);
        changed = true;
      }
      slot++;
      if (_expanded.has(key)) ensureCardIo(key);
    }
    setTextIfChanged(document.getElementById('count-' + colId), String(counts[colId] || 0));
    var empty = document.getElementById('empty-' + colId);
    if (empty && empty.hidden !== slot > 0) empty.hidden = slot > 0;
  }
  for (var gone in _cardEls) {
    if (wanted[gone]) continue;
    exitCard(_cardEls[gone], first ? first[gone] : null);
    delete _cardEls[gone];
    changed = true;
  }
  if (!changed) return;
  for (var key2 in _cardEls) {
    var card = _cardEls[key2];
    if (card._isNew) {
      card._isNew = false;
      if (animate) enterCard(card);
      continue;
    }
    if (!animate || !first[key2]) continue;
    // Interrupted move: the first rect was read mid-flight (transform included), so
    // cancelling and re-FLIPping restarts from the current on-screen spot.
    var wasFlying = card.classList.contains('is-flying');
    if (card._flip) { card._flip.cancel(); card._flip = null; }
    if (wasFlying) card.classList.remove('is-flying');
    var a = first[key2];
    var b = card.getBoundingClientRect();
    var dx = a.left - b.left;
    var dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    playFlip(card, dx, dy, wasFlying || firstCol[key2] !== card._colId);
  }
}

function measureCards() {
  var rects = {};
  for (var k in _cardEls) {
    var el = _cardEls[k];
    if (el._enter) { el._enter.finish(); el._enter = null; }
    rects[k] = el.getBoundingClientRect();
  }
  return rects;
}

// Move = translate only (widths snap; text never stretches). The card that
// changes column flies raised above its neighbours (shadow + z-index).
function playFlip(el, dx, dy, raise) {
  if (reduceMotion()) {
    // §4-8: no travel — a card that changed column fades in where it landed.
    if (raise) el._enter = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fade, easing: 'linear' });
    return;
  }
  if (raise) el.classList.add('is-flying');
  var anim = el.animate(
    [{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'translate(0, 0)' }],
    { duration: MOTION.move, easing: MOTION.easeInOut }
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

// Exit: opacity only. The card leaves the flow first (absolutely placed where
// it was) so the remaining cards FLIP into the gap while it fades.
function exitCard(el, rect) {
  if (el._flip) { el._flip.cancel(); el._flip = null; }
  var parent = el.parentNode;
  if (!parent) return;
  if (!rect || !canAnimate()) { parent.removeChild(el); return; }
  var pr = parent.getBoundingClientRect();
  el.removeAttribute('data-session-key');
  el.setAttribute('aria-hidden', 'true');
  el.style.position = 'absolute';
  el.style.left = (rect.left - pr.left) + 'px';
  el.style.top = (rect.top - pr.top) + 'px';
  el.style.width = rect.width + 'px';
  el.style.pointerEvents = 'none';
  _exiting.push(el);
  var anim = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.fade, easing: MOTION.easeOut, fill: 'forwards' });
  anim.onfinish = function() { clearExitingCards(el); };
}
function clearExitingCards(only) {
  if (!_exiting.length) return;
  _exiting = _exiting.filter(function(el) {
    if (only && el !== only) return true;
    if (el.parentNode) el.parentNode.removeChild(el);
    return false;
  });
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

// Render one card into its shell. Each part is replaced only when its HTML
// string changed, so untouched cards keep their nodes, an open card keeps its
// state, and a running transition is never cut. Shared by the reconciler and
// the single-card sessionUpdated push.
function patchCard(el, s, col) {
  _sessionCache[s.key] = s;
  var face = renderCardFace(s, col);
  var body = renderCardBody(s, col);
  var state = cardState(s, col);
  var changed = false;
  if (el.getAttribute('data-col') !== col) { el.setAttribute('data-col', col); changed = true; }
  if (el.getAttribute('data-state') !== state) { el.setAttribute('data-state', state); changed = true; }
  if (el._faceHtml !== face) {
    el._faceEl.innerHTML = face;
    el._faceHtml = face;
    updateTimersIn(el._faceEl);
    changed = true;
  }
  if (el._bodyHtml !== body) {
    el._bodyEl.innerHTML = body;
    el._bodyHtml = body;
    updateTimersIn(el._bodyEl);
    changed = true;
  }
  return changed;
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
  if (col === 'working' && current) return current.content;
  if (s.summaryTitle && s.summaryTitle !== headline) return s.summaryTitle;
  var lastTask = lastDone || (tasks.length ? tasks[tasks.length - 1] : null);
  if (lastTask) return lastTask.content;
  if (s.title && s.title !== headline) return s.title;
  return '';
}

// Status at the foot of the card. Board shows the bare timer; List adds the
// "Running · " / "Done in " prefix via CSS — same DOM in both views.
function renderCardStatus(s, col) {
  if (col === 'waiting') {
    return '<span class="st-icon">' + WAIT_SVG + '</span><span class="st-text">Waiting for you</span>';
  }
  if (col === 'closed') {
    return '<span class="st-icon"><span class="st-dot is-hollow"></span></span><span class="st-text">' + (s.terminated ? 'Archived' : 'Sleeping') + '</span>';
  }
  var acc = s.activeAccumulatedMs || 0;
  var leg = col === 'working' ? (s.activeLegStartedAtMs || 0) : 0;
  var timer = '<span class="card-timer-live" data-leg-started="' + leg + '" data-accumulated="' + acc + '" title="Active time"></span>';
  if (col === 'working') {
    return '<span class="st-icon"><span class="spinner"></span></span><span class="st-text"><span class="st-prefix">Running &middot; </span>' + timer + '</span>';
  }
  if (!acc) return '<span class="st-icon"><span class="st-dot"></span></span><span class="st-text">Idle</span>';
  return '<span class="st-icon"><span class="st-dot"></span></span><span class="st-text"><span class="st-prefix">Done in </span>' + timer + '</span>';
}

// Collapsed face (§2.1 reference anatomy): ✦ + headline / 2-line summary /
// status · tasks done/total · context %.
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
    metrics.push('<span class="metric" title="Context window used">' + CTX_SVG + Math.round(Math.min(ctxPct, 100)) + '%</span>');
  }
  return '<div class="card-head"><span class="card-spark">' + SPARK_SVG + '</span>' + titleHtml + '</div>'
    + (summary ? '<div class="card-summary">' + esc(summary) + '</div>' : '')
    + '<div class="card-foot"><span class="card-status">' + renderCardStatus(s, col) + '</span>'
    + (metrics.length ? '<span class="card-metrics">' + metrics.join('') + '</span>' : '')
    + '</div>';
}

// Task timeline (§3.1-4): list order, the in-progress step is the solid dot,
// completed steps show how long they took. Over the dhMax('tasks') budget the
// earliest completed steps fold into "+N completed" first.
function renderTimeline(s) {
  if (!dhShow('tasks') || !s.tasks || s.tasks.length === 0) return '';
  var max = dhMax('tasks', 5);
  var drop = Math.max(0, s.tasks.length - max);
  var folded = 0;
  var shown = [];
  for (var i = 0; i < s.tasks.length; i++) {
    if (drop > 0 && s.tasks[i].status === 'completed') { drop--; folded++; continue; }
    shown.push(s.tasks[i]);
  }
  var tail = 0;
  if (shown.length > max) { tail = shown.length - max; shown = shown.slice(0, max); }
  var items = shown.map(function(t) {
    var cls = t.status === 'in_progress' ? ' is-current' : (t.status === 'completed' ? ' is-done' : ' is-pending');
    var time = '';
    if (t.status === 'completed' && t.startedAt && t.completedAt) {
      time = formatDuration(t.completedAt - t.startedAt);
    } else if (t.status === 'in_progress' && t.startedAt) {
      time = '<span class="task-elapsed" data-since="' + t.startedAt + '"></span>';
    }
    return '<li class="tl-item' + cls + '"><span class="tl-text">' + esc(t.content) + '</span>'
      + (time ? '<span class="tl-time">' + time + '</span>' : '') + '</li>';
  }).join('');
  return '<div class="tl-wrap">'
    + (folded > 0 ? '<div class="tl-more">+' + folded + ' completed</div>' : '')
    + '<ul class="tl">' + items + '</ul>'
    + (tail > 0 ? '<div class="tl-more">+' + tail + ' more</div>' : '')
    + '</div>';
}

// Latest user instruction + model response (§3.1-4), fetched lazily on
// expand from GET /api/dashboard/session/:conversationId?limit=2 and cached
// per conversation (re-fetched when lastActivity moves or a turn lands).
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

function ensureCardIo(key) {
  var s = _sessionCache[key];
  if (!s || !s.conversationId || isSiblingSession(s)) return;
  var cid = s.conversationId;
  var stamp = String(s.lastActivity || '');
  var c = _ioCache[cid];
  if (c && (c.state === 'loading' || c.stamp === stamp)) return;
  var prev = c ? c.data : null;
  _ioCache[cid] = { state: 'loading', stamp: stamp, data: prev, dirty: false };
  fetch('/api/dashboard/session/' + encodeURIComponent(cid) + '?limit=2')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
      var turns = (data && data.turns) || [];
      var ui = -1;
      for (var i = turns.length - 1; i >= 0; i--) { if (turns[i].role === 'user') { ui = i; break; } }
      // Only an assistant turn AFTER the latest instruction answers it.
      var reply = null;
      for (var j = turns.length - 1; j > ui; j--) { if (turns[j].role === 'assistant') { reply = turns[j]; break; } }
      var raw = ui >= 0 ? decodeSlackEntities(turns[ui].rawContent || '') : '';
      var instruction = ui >= 0
        ? { text: raw.slice(0, 500) + (raw.length > 500 ? '…' : ''), who: turns[ui].userName || '' }
        : null;
      if (reply && !reply.summaryTitle && !reply.summaryBody && reply.id) {
        // Summary not generated yet — fall back to the head of the raw response.
        return fetch('/api/conversations/' + encodeURIComponent(cid) + '/turns/' + encodeURIComponent(reply.id) + '/raw')
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(rawData) {
            var text = rawData && typeof rawData.raw === 'string' ? rawData.raw : '';
            return { instruction: instruction, response: text ? { title: '', body: text.slice(0, 600) + (text.length > 600 ? '…' : '') } : null };
          }, function() { return { instruction: instruction, response: null }; });
      }
      return { instruction: instruction, response: reply ? { title: reply.summaryTitle || '', body: reply.summaryBody || '' } : null };
    })
    .then(function(result) { settleCardIo(cid, { state: 'ready', stamp: stamp, data: result }); })
    .catch(function() { settleCardIo(cid, { state: 'error', stamp: stamp, data: prev }); });
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
// A turn landed for this conversation — refetch for any open card.
function invalidateCardIo(cid) {
  var c = cid && _ioCache[cid];
  if (!c) return;
  if (c.state === 'loading') { c.dirty = true; return; }
  c.stamp = null;
  for (var k in _cardEls) {
    var s = _sessionCache[k];
    if (s && s.conversationId === cid && _expanded.has(k)) ensureCardIo(k);
  }
}

// Expanded body: model·effort → meta (env/workflow/owner/last activity) →
// refs → task timeline → instruction/response → pending question → stats →
// buttons. Every field the old card face showed is still gated by dhShow().
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
  const modelShort = esc(s.model).replace(/^claude-/, '').replace(/-\\d{8}$/, '');
  const modelParts = [];
  if (dhShow('model') && modelShort) modelParts.push(modelShort);
  if (s.effort) modelParts.push('<span class="meta-effort" title="Power level">' + esc(s.effort) + '</span>');
  const modelHtml = modelParts.length ? '<div class="cb-model">' + modelParts.join(' &middot; ') + '</div>' : '';

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
    refParts.push('<a href="' + escAttr(s.issueUrl) + '" target="_blank" rel="noopener" title="' + escAttr(issueTip) + '">' + esc(s.issueShortRef) + '</a>');
  }
  if (dhShow('links') && s.prShortRef && s.prUrl) {
    const prTip = s.prTitle || s.prLabel || s.prShortRef;
    refParts.push('<a href="' + escAttr(s.prUrl) + '" target="_blank" rel="noopener" title="' + escAttr(prTip) + '">' + esc(s.prShortRef) + '</a>');
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
  if (s.tokenUsage && dhShow('tokens')) statParts.push('<span class="card-tokens">' + formatTokens(s.tokenUsage.totalInputTokens + s.tokenUsage.totalOutputTokens) + ' tok</span>');
  if (s.tokenUsage && dhShow('cost')) statParts.push('<span class="card-tokens"><span class="cost">$' + s.tokenUsage.totalCostUsd.toFixed(2) + '</span></span>');
  if (dhShow('mergestats') && s.mergeStats) statParts.push('<span class="card-merge">+' + s.mergeStats.totalLinesAdded + ' / -' + s.mergeStats.totalLinesDeleted + '</span>');
  statParts.push('<span class="card-timer-row">'
    + '<span class="card-timer-total" title="Thread total active time">&Sigma; ' + formatNmSSs(s.threadTotalActiveMs || 0) + '</span>'
    + '<span class="card-timer-compactions" title="Compactions">&#x1F5DC;&#xFE0F; ' + (s.compactionCount || 0) + '</span>'
    + '<span class="card-timer-sessions" title="Thread session count"># ' + (s.threadSessionCount || 0) + '</span>'
    + '</span>');
  const ctxPct = s.tokenUsage ? (s.tokenUsage.contextUsagePercent || 0) : 0;
  const ctxCls = ctxPct > 80 ? 'ctx-danger' : ctxPct > 60 ? 'ctx-warn' : '';
  const ctxBar = (dhShow('contextwindow') && ctxPct > 0)
    ? '<div class="context-bar" title="Context ' + Math.round(ctxPct) + '%"><div class="context-bar-fill ' + ctxCls + '" style="width:' + Math.min(ctxPct, 100).toFixed(0) + '%"></div></div>'
    : '';
  const statsHtml = '<div class="card-stats">' + statParts.join('') + '</div>' + ctxBar;

  const ioHtml = isSiblingSession(s) ? '' : renderCardIo(s);
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
          + '<button class="btn-choice btn-choice-recommended"' + readOnlyAttrs + ' onclick="event.stopPropagation();answerChoice(\\'' + escJs(s.key) + '\\',\\'' + escJs(recOpt.id) + '\\',\\'' + escJs(recLabel) + '\\',\\'' + escJs(pq.question) + '\\',this)" title="' + escAttr(recTitle) + '">' + esc(recOpt.id) + '. ' + esc(recLabel) + '</button>'
          + '</div>'
          + (otherOpts.length > 0 ? '<hr class="choice-divider">' : '');
      }
      var otherBtns = otherOpts.map(function(c) {
        var lbl = stripRecommendedMarker(c.label);
        var btnTitle = isOwner ? (c.description || lbl) : READ_ONLY_MSG;
        return '<button class="btn-choice"' + readOnlyAttrs + ' onclick="event.stopPropagation();answerChoice(\\'' + escJs(s.key) + '\\',\\'' + escJs(c.id) + '\\',\\'' + escJs(lbl) + '\\',\\'' + escJs(pq.question) + '\\',this)" title="' + escAttr(btnTitle) + '">' + esc(c.id) + '. ' + esc(lbl) + '</button>';
      }).join('');
      questionHtml = '<div class="card-question">'
        + '<div class="card-question-text">&#x2753; ' + esc(pq.question).slice(0, 80) + '</div>'
        + '<div class="card-question-choices">' + recHtml + otherBtns + '</div>'
        + '</div>';
    } else if (s.pendingQuestion.type === 'user_choices') {
      questionHtml = renderMultiChoiceCard(s);
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
    var label = (col === 'working') ? 'Stop' : (col === 'closed' && s.terminated ? 'Trash' : 'Close');
    actionBtn = '<button class="btn-action btn-stop" disabled' + siblingTitle + '>' + label + ' \u2192 ' + esc(s.environment.instanceName) + '</button>';
  } else if (col === 'working') {
    actionBtn = '<button class="btn-action btn-stop"' + readOnlyAttrs + readOnlyTitle + ' onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'stop\\')">Stop</button>';
  } else if (col === 'waiting' || col === 'idle') {
    actionBtn = '<button class="btn-action btn-close"' + readOnlyAttrs + readOnlyTitle + ' onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'close\\')">Close</button>';
  } else if (col === 'closed') {
    // SLEEPING (live) sessions → Close (terminate); archived sessions → Trash (hide)
    actionBtn = s.terminated
      ? '<button class="btn-action btn-trash"' + readOnlyAttrs + readOnlyTitle + ' onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'trash\\')">Trash</button>'
      : '<button class="btn-action btn-close"' + readOnlyAttrs + readOnlyTitle + ' onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'close\\')">Close</button>';
  }

  // 작업 로그 opens the slide panel scrolled to the work log; Slack jumps to the thread.
  const worklogBtn = s.conversationId
    ? '<button type="button" class="btn-action btn-primary" onclick="event.stopPropagation();openPanel(\\'' + escJs(s.key) + '\\',true)">작업 로그</button>'
    : '';
  const slackBtn = (dhShow('links') && s.slackThreadUrl)
    ? '<a class="btn-action" href="' + escAttr(s.slackThreadUrl) + '" target="_blank" rel="noopener">Slack</a>'
    : '';
  const actionsHtml = '<div class="card-actions">' + actionBtn + slackBtn + worklogBtn + '</div>';

  return '<div class="card-body">'
    + modelHtml
    + metaHtml
    + refsHtml
    + subtitlesHtml
    + renderTimeline(s)
    + ioHtml
    + questionHtml
    + statsHtml
    + actionsHtml
    + '</div>';
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
  if (instant) el.classList.add('no-motion');
  applyExpanded(el, open);
  if (instant) {
    void el.offsetHeight;
    el.classList.remove('no-motion');
  }
  if (open) ensureCardIo(key);
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

function renderOlderToggle(olderCount) {
  var foot = document.getElementById('foot-done');
  if (!foot) return;
  var html = olderCount > 0
    ? '<button type="button" class="show-older-btn" onclick="toggleOlderClosed()">'
      + (showOlderClosed ? '&#x25B2; Hide older (' : '&#x25BC; Show older (') + olderCount + ')</button>'
    : '';
  if ((foot._html || '') === html) return;
  foot._html = html;
  foot.innerHTML = html;
}

function toggleOlderClosed() {
  showOlderClosed = !showOlderClosed;
  loadSessions();
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
  return hits.length === 1 ? hits[0] : null;
}
function openDeepLinkedSession() {
  if (!_deepLinkSession) return;
  var key = resolveDeepLinkKey(_deepLinkSession, Object.keys(_sessionCache), SELF_INSTANCE_NAME);
  if (!key) {
    if (Date.now() > _deepLinkDeadline) _deepLinkSession = null;
    return;
  }
  if (!_cardEls[key]) {
    // Closed more than 7 days ago — reveal the older group and retry on that render.
    if (!showOlderClosed) {
      showOlderClosed = true;
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

async function loadSessions() {
  try {
    const url = '/api/dashboard/sessions' + (currentUserId ? '?userId=' + currentUserId : '');
    const res = await fetch(url);
    const data = await res.json();
    renderBoard(data.board);
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
var _mcState = {};

function renderMultiChoiceCard(s) {
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
    + '<div class="card-question-text">\\uD83D\\uDCCB ' + esc(q.title || q.question || '\\uBCF5\\uC218 \\uC9C8\\uBB38') + '</div>'
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
        html += '<button class="btn-choice' + (isRecBtn ? ' btn-choice-recommended' : '') + '" onclick="event.stopPropagation();selectMc(\\'' + escJs(key) + '\\',' + qi + ',\\'' + escJs(ch.id) + '\\',\\'' + escJs(chLbl) + '\\')">'
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
// state, so the body is empty.
async function submitAllRecommended(key) {
  var heroBtn = document.querySelector('.btn-hero-recommended');
  if (heroBtn) { heroBtn.disabled = true; heroBtn.setAttribute('aria-disabled', 'true'); }
  var url = '/api/dashboard/session/' + encodeURIComponent(key) + '/submit-recommended';
  try {
    var headers = { 'Content-Type': 'application/json' };
    if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
    var res = await fetch(url, { method: 'POST', headers: headers });
    if (res.status === 403) {
      await refreshCsrfToken();
      var retryHeaders = { 'Content-Type': 'application/json' };
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
async function loadStats() {
  if (!currentUserId) {
    // Show aggregate stats from session cache when no specific user is selected
    document.getElementById('stats-grid').style.display = '';
    document.getElementById('chart-row').innerHTML = '';
    updateTokenStats();
    var sessCount = Object.keys(_sessionCache).length;
    var totalMergeAdd = 0, totalMergeDel = 0, prCount = 0, mergedCount = 0;
    var wfMap = {};
    for (var k in _sessionCache) {
      var cs = _sessionCache[k];
      if (cs.mergeStats) { totalMergeAdd += cs.mergeStats.totalLinesAdded || 0; totalMergeDel += cs.mergeStats.totalLinesDeleted || 0; }
      if (cs.prUrl) { prCount++; if (cs.prStatus === 'merged') mergedCount++; }
      if (cs.workflow) { wfMap[cs.workflow] = (wfMap[cs.workflow] || 0) + 1; }
    }
    var sessEl = document.getElementById('stat-sessions');
    sessEl.textContent = sessCount || '0'; sessEl.className = 'value';
    var turnsEl = document.getElementById('stat-turns');
    turnsEl.textContent = '\u2014'; turnsEl.className = 'value no-data';
    document.getElementById('stat-prs').textContent = prCount;
    document.getElementById('stat-prs').classList.remove('no-data');
    document.getElementById('stat-merged').textContent = mergedCount;
    document.getElementById('stat-merged').classList.remove('no-data');
    var commitsEl = document.getElementById('stat-commits') || document.getElementById('stat-commits-hidden');
    if (commitsEl) { commitsEl.textContent = '\u2014'; commitsEl.classList.add('no-data'); }
    document.getElementById('stat-merge-lines').textContent = '+' + totalMergeAdd + ' / -' + totalMergeDel;
    var wfEntries = Object.entries(wfMap).sort(function(a, b) { return b[1] - a[1]; });
    document.getElementById('stat-workflows').innerHTML = wfEntries.length
      ? wfEntries.map(function(e) { return '<span style="display:inline-block;margin-right:8px;font-size:0.85em">' + esc(e[0]) + ': <b>' + e[1] + '</b></span>'; }).join('')
      : '-';
    return;
  }
  document.getElementById('stats-grid').style.display = '';
  try {
    const res = await fetch('/api/dashboard/stats?userId=' + currentUserId + '&period=' + currentPeriod);
    const data = await res.json();
    document.getElementById('stat-sessions').textContent = data.totals.sessionsCreated;
    document.getElementById('stat-turns').textContent = data.totals.turnsUsed;
    document.getElementById('stat-prs').textContent = data.totals.prsCreated;
    document.getElementById('stat-merged').textContent = data.totals.prsMerged;
    var commitsEl2 = document.getElementById('stat-commits') || document.getElementById('stat-commits-hidden');
    if (commitsEl2) commitsEl2.textContent = data.totals.commitsCreated;
    document.getElementById('stat-merge-lines').textContent = '+' + data.totals.mergeLinesAdded + ' / -' + data.totals.mergeLinesDeleted;
    // Workflow counts
    const wfCounts = data.totals.workflowCounts || {};
    const wfEntries = Object.entries(wfCounts).sort(function(a, b) { return b[1] - a[1]; });
    document.getElementById('stat-workflows').innerHTML = wfEntries.length
      ? wfEntries.map(function(e) { return '<span style="display:inline-block;margin-right:8px;font-size:0.85em">' + esc(e[0]) + ': <b>' + e[1] + '</b></span>'; }).join('')
      : '<span style="color:var(--text-secondary)">-</span>';
    updateTokenStats();
    renderCharts(data.days);
  } catch (e) { console.error('Failed to load stats', e); }
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
    // Reconnect: pull the work-log entries broadcast while we were offline.
    if (panelOpen && _wlConvId && _wlLastSeq > 0) fetchWorkLog(_wlConvId, _wlLastSeq);
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
        renderBoard(msg.board);
        // Refresh panel question if panel is open (session may have transitioned)
        if (panelOpen && panelSessionKey && _sessionCache[panelSessionKey]) {
          var panelS = _sessionCache[panelSessionKey];
          renderPanelQuestion(panelS);
          // If session no longer has pending multi-choice, clear mc state
          if (!panelS.pendingQuestion || panelS.pendingQuestion.type !== 'user_choices') {
            if (_mcState[panelSessionKey]) delete _mcState[panelSessionKey];
          }
        }
      } else if (msg.type === 'task_update') {
        // Update cached session tasks and re-render
        if (_sessionCache[msg.sessionKey]) {
          _sessionCache[msg.sessionKey].tasks = msg.tasks;
        }
        loadSessions();
        // Also update panel tasks if panel is open for this session
        if (panelOpen && panelSessionKey === msg.sessionKey) {
          renderPanelTasks(msg.tasks);
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
        if (panelOpen && msg.conversationId && msg.conversationId === _wlConvId) {
          appendWorkLogEntries([msg.entry], false);
        }
        if (msg.entry.kind === 'instruction' || msg.entry.kind === 'final') invalidateCardIo(msg.conversationId);
      }
    } catch (e) { /* ignore */ }
  };
}

// ── Token stats from session cache ──
function updateTokenStats() {
  // #814 — group token usage by environment.instanceName so the topbar
  // tooltip can break down "instance-a: 12K | instance-b: 8K | Total: 20K".
  // Fallback bucket ('') is used for cards whose environment is missing
  // (legacy WS payloads, tests). When all cards share one env we suppress
  // the tooltip entirely — see _envCount() check below.
  var byEnv = {};
  let totalTokens = 0, totalCost = 0;
  for (const key in _sessionCache) {
    const s = _sessionCache[key];
    if (currentUserId && s.ownerId !== currentUserId) continue;
    if (!s.tokenUsage) continue;
    var t = s.tokenUsage.totalInputTokens + s.tokenUsage.totalOutputTokens;
    totalTokens += t;
    totalCost += s.tokenUsage.totalCostUsd;
    var envName = (s.environment && s.environment.instanceName) || '';
    if (!byEnv[envName]) byEnv[envName] = { tokens: 0, cost: 0 };
    byEnv[envName].tokens += t;
    byEnv[envName].cost += s.tokenUsage.totalCostUsd;
  }
  document.getElementById('stat-tokens').textContent = formatTokens(totalTokens);
  document.getElementById('stat-cost').textContent = '$' + totalCost.toFixed(2);

  // Tooltip: only show when there's actually a breakdown (≥2 envs in
  // the cache). For the single-instance / empty-env case we leave the
  // tooltip dark so the topbar stays the same shape it was before #814.
  var tip = document.getElementById('stat-tokens-tooltip');
  var wrap = document.getElementById('stat-tokens-wrap');
  if (!tip || !wrap) return;
  var envNames = Object.keys(byEnv).filter(function(n) { return n.length > 0; });
  if (envNames.length < 2) {
    tip.textContent = '';
    wrap.classList.remove('tooltip-open');
    wrap.removeAttribute('data-has-breakdown');
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
  tip.innerHTML = parts.join(' &middot; ');
  wrap.setAttribute('data-has-breakdown', 'true');
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
// GET /api/dashboard/session/:conversationId/worklog?afterSeq=&limit= → { entries }
// + WS { type: 'work_log', conversationId, entry }. Entries are seq-ordered per
// conversation; _wlLastSeq dedupes the initial fetch against live pushes and is
// the resume point after a reconnect. A missing route (404) reads as "no log".
var _wlConvId = null;
var _wlLastSeq = 0;
var _wlCount = 0;
var _panelFocusWorkLog = false;
var WL_LABELS = { instruction: '지시', narration: '', tool: '', tool_result: '', final: '응답', notice: '알림', error: '오류' };

function resetWorkLog(convId) {
  _wlConvId = convId;
  _wlLastSeq = 0;
  _wlCount = 0;
  var section = document.getElementById('panel-worklog');
  var list = document.getElementById('worklog-list');
  setTextIfChanged(document.getElementById('worklog-count'), '');
  if (section) section.style.display = convId ? '' : 'none';
  if (list) list.innerHTML = convId ? '<div class="wl-empty">불러오는 중…</div>' : '';
}

function fetchWorkLog(convId, afterSeq) {
  var url = '/api/dashboard/session/' + encodeURIComponent(convId) + '/worklog'
    + (afterSeq ? '?afterSeq=' + encodeURIComponent(String(afterSeq)) : '');
  return fetch(url)
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
      if (_wlConvId !== convId) return;
      appendWorkLogEntries((data && data.entries) || [], !afterSeq);
    })
    .catch(function() {
      if (_wlConvId !== convId || afterSeq) return;
      showWorkLogEmpty();
    })
    .then(function() {
      if (_wlConvId === convId && _panelFocusWorkLog) scrollPanelToWorkLog();
    });
}

function showWorkLogEmpty() {
  var list = document.getElementById('worklog-list');
  if (list && !list.querySelector('.wl-entry')) list.innerHTML = '<div class="wl-empty">작업 로그 없음</div>';
}

function appendWorkLogEntries(entries, initial) {
  var list = document.getElementById('worklog-list');
  if (!list) return;
  var atBottom = list.scrollHeight - list.scrollTop <= list.clientHeight + 40;
  var html = '';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || typeof e.seq !== 'number' || e.seq <= _wlLastSeq) continue;
    html += renderWorkLogEntry(e);
    _wlLastSeq = e.seq;
    _wlCount++;
  }
  if (!html) {
    if (initial) showWorkLogEmpty();
    return;
  }
  var placeholder = list.querySelector('.wl-empty');
  if (placeholder) placeholder.remove();
  list.insertAdjacentHTML('beforeend', html);
  setTextIfChanged(document.getElementById('worklog-count'), String(_wlCount));
  if (initial || atBottom) list.scrollTop = list.scrollHeight;
}

function renderWorkLogEntry(e) {
  var kind = Object.prototype.hasOwnProperty.call(WL_LABELS, e.kind) ? e.kind : 'narration';
  var time = e.ts ? new Date(e.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
  var timeHtml = time ? '<span class="wl-time">' + time + '</span>' : '';
  var text = String(e.text || '');
  if (kind === 'tool' || kind === 'tool_result') {
    var fail = kind === 'tool_result' && e.ok === false;
    var mark = kind === 'tool' ? '&#x25B8;' : (fail ? '&#x2717;' : '&#x2713;');
    return '<div class="wl-entry wl-' + kind + (fail ? ' is-fail' : '') + '">'
      + '<span class="wl-mark">' + mark + '</span>'
      + (e.tool ? '<span class="wl-tool-name">' + esc(e.tool) + '</span>' : '')
      + '<span class="wl-text" title="' + escAttr(text) + '">' + esc(text) + '</span>'
      + timeHtml + '</div>';
  }
  if (kind === 'instruction') text = decodeSlackEntities(text);
  var label = WL_LABELS[kind];
  if (!label) {
    // Narration: the text with its time on the right of the same line.
    return '<div class="wl-entry wl-' + kind + ' wl-line"><div class="wl-text">' + esc(text) + '</div>' + timeHtml + '</div>';
  }
  return '<div class="wl-entry wl-' + kind + '">'
    + '<div class="wl-head"><span class="wl-label">' + label + '</span>' + timeHtml + '</div>'
    + '<div class="wl-text">' + esc(text) + '</div>'
    + '</div>';
}

// Bring the work-log section to the top of the panel's scroll area and show
// its newest entries.
function scrollPanelToWorkLog() {
  var scrollEl = document.getElementById('panel-scroll');
  var section = document.getElementById('panel-worklog');
  var list = document.getElementById('worklog-list');
  if (!scrollEl || !section || section.style.display === 'none') return;
  scrollEl.scrollTop += section.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
  if (list) list.scrollTop = list.scrollHeight;
}

// ── Slide Panel ──
// focusWorkLog = opened from a card's 작업 로그 button or a ?session= deep link.
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

  // Reset pagination state before loading this session's turns.
  _panelTurnsHasMore = false;
  _panelTurnsLoading = false;
  _panelTurnsOldestId = null;

  panelSessionKey = sessionKey;
  panelConvId = s.conversationId || null;
  resetWorkLog(panelConvId);

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
    '<span class="meta-item"><span class="meta-label">Model:</span> <span class="meta-value">' + esc(s.model) + '</span></span>',
    '<span class="meta-item"><span class="meta-label">State:</span> <span class="meta-value">' + esc(s.activityState) + '</span></span>',
    '<span class="meta-item"><span class="meta-label">Last:</span> <span class="meta-value">' + timeAgo(s.lastActivity) + '</span></span>',
  ].join('');

  // Links
  const linksEl = document.getElementById('panel-links');
  const linkHtml = [];
  if (s.issueUrl) linkHtml.push('<a href="' + esc(s.issueUrl) + '" target="_blank">&#x1F4CB; ' + esc(s.issueLabel || 'Issue') + (s.issueTitle ? ' &mdash; ' + esc(s.issueTitle).slice(0, 50) : '') + '</a>');
  if (s.prUrl) linkHtml.push('<a href="' + esc(s.prUrl) + '" target="_blank">&#x1F500; ' + esc(s.prLabel || 'PR') + (s.prTitle ? ' &mdash; ' + esc(s.prTitle).slice(0, 50) : '') + '</a>');
  if (s.slackThreadUrl) linkHtml.push('<a href="' + esc(s.slackThreadUrl) + '" target="_blank">&#x1F4AC; Slack Thread</a>');
  if (s.conversationId) linkHtml.push('<a href="/conversations/' + esc(s.conversationId) + '" target="_blank">&#x1F4DD; Full Conversation</a>');
  linksEl.innerHTML = linkHtml.join('') || '<span style="font-size:0.78em;color:var(--text-secondary)">No links</span>';

  // Tokens
  const tokensEl = document.getElementById('panel-tokens');
  if (s.tokenUsage) {
    let tokHtml = [
      '<span class="token-badge"><span class="tok-label">Input:</span> <span class="tok-value">' + formatTokens(s.tokenUsage.totalInputTokens) + '</span></span>',
      '<span class="token-badge"><span class="tok-label">Output:</span> <span class="tok-value">' + formatTokens(s.tokenUsage.totalOutputTokens) + '</span></span>',
      '<span class="token-badge"><span class="tok-label">Cost:</span> <span class="tok-cost">$' + s.tokenUsage.totalCostUsd.toFixed(3) + '</span></span>',
      '<span class="token-badge"><span class="tok-label">Context:</span> <span class="tok-value">' + s.tokenUsage.contextUsagePercent.toFixed(1) + '%</span></span>',
    ].join('');
    if (s.mergeStats) {
      tokHtml += '<span class="token-badge" style="border-color:var(--green)"><span class="tok-label">Merge:</span> <span style="color:var(--green)">+' + s.mergeStats.totalLinesAdded + ' / -' + s.mergeStats.totalLinesDeleted + '</span></span>';
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
    var loadingSessionKey = sessionKey;
    fetch('/api/dashboard/session/' + encodeURIComponent(loadingConvId) + '?limit=30')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        // If the user switched cards while loading, discard this result.
        if (panelSessionKey !== loadingSessionKey) return;

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
        // Jump to bottom on fresh load — or to the work log when that is what
        // the user asked for (작업 로그 button / ?session= deep link).
        var scrollEl = document.getElementById('panel-scroll');
        if (_panelFocusWorkLog) scrollPanelToWorkLog();
        else if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        _panelTurnsLoading = false;
      })
      .catch(function() {
        if (panelSessionKey !== loadingSessionKey) return;
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

  if (panelConvId) fetchWorkLog(panelConvId, 0);
}

// ── Pagination state for panel chat (infinite scroll) ──
var _panelTurnsHasMore = false;
var _panelTurnsLoading = false;
var _panelTurnsOldestId = null;

async function loadMorePanelTurns() {
  if (_panelTurnsLoading || !_panelTurnsHasMore || !panelConvId || !_panelTurnsOldestId) return;
  var turnsEl = document.getElementById('panel-turns');
  var scrollEl = document.getElementById('panel-scroll');
  if (!turnsEl || !scrollEl) return;

  _panelTurnsLoading = true;
  var requestConvId = panelConvId;
  var requestSessionKey = panelSessionKey;
  var requestOldestId = _panelTurnsOldestId;

  // Preserve scroll position relative to the current oldest item.
  var prevScrollHeight = scrollEl.scrollHeight;
  var prevScrollTop = scrollEl.scrollTop;
  // Only compensate when the insertion point sits above the viewport. When the
  // user is reading the work log (above the turns) the older turns land below
  // what they see, and shifting scrollTop would yank the work log away.
  var insertAboveView = turnsEl.getBoundingClientRect().top < scrollEl.getBoundingClientRect().top;

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

    // Discard stale response if card was switched mid-flight.
    // panelSessionKey and panelConvId are always updated/cleared together (openPanel, closePanel),
    // so sessionKey equality implies convId equality — single check is sufficient.
    if (panelSessionKey !== requestSessionKey) {
      if (spinner.parentNode) spinner.remove();
      return;
    }

    if (spinner.parentNode) spinner.remove();

    if (data.turns && data.turns.length > 0) {
      _panelTurnsOldestId = data.turns[0].id;
      _panelTurnsHasMore = !!data.hasMore;
      var cid = data.id;
      var html = data.turns.map(function(t, i, arr) { return renderTurn(t, i, arr, cid); }).join('');
      turnsEl.insertAdjacentHTML('afterbegin', html);
      attachRawToggleHandlers();
      // Restore scroll position so the user stays anchored on the turn they were reading.
      if (insertAboveView) {
        var newScrollHeight = scrollEl.scrollHeight;
        scrollEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
      }
    } else {
      _panelTurnsHasMore = false;
    }
  } catch (err) {
    if (spinner.parentNode) spinner.remove();
    console.error('loadMorePanelTurns failed', err);
  } finally {
    _panelTurnsLoading = false;
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
      body = '<div class="turn-summary-body" style="color:var(--text-tertiary);font-style:italic">Summary failed <button class="btn-action" style="margin-left:8px;font-size:10px;padding:2px 8px" onclick="event.stopPropagation();resummarize(\\'' + esc(convId || panelConvId) + '\\',\\'' + esc(t.id) + '\\',this)">&#x1F504; Retry</button></div>';
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

var _rawLoadedCache = {};
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
    if (res.status === 403) {
      await refreshCsrfToken();
      const retryHeaders = {};
      if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
      res = await fetch(url, { method: 'POST', headers: retryHeaders });
    }
    var data = await res.json();
    if (data.titleSub) {
      textEl.textContent = data.titleSub;
      btn.style.display = 'inline-block';
    } else {
      textEl.textContent = 'Title generation failed';
      btn.style.display = 'inline-block';
    }
  } catch(e) {
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
  _rawLoadedCache = {};
  _panelTurnsHasMore = false;
  _panelTurnsLoading = false;
  _panelTurnsOldestId = null;
  _wlConvId = null;
  _wlLastSeq = 0;
  _panelFocusWorkLog = false;
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && panelOpen) closePanel();
});

// Scroll-up-to-load-more handler (bound once on panel-scroll).
(function initPanelScrollHandler() {
  var scrollEl = document.getElementById('panel-scroll');
  if (!scrollEl) return;
  scrollEl.addEventListener('scroll', function() {
    if (scrollEl.scrollTop < 100 && _panelTurnsHasMore && !_panelTurnsLoading && panelConvId && _panelTurnsOldestId) {
      loadMorePanelTurns();
    }
  }, { passive: true });
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
