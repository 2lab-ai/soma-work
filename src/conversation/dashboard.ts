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
  /** Jira short key like "PTN-123" derived from issueUrl */
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

// #814 — Per-process TTL cache for sibling fan-out results. Multiple browser
// tabs polling /api/dashboard/sessions every 30 s would otherwise each
// trigger their own N×HTTP fan-out. 1500 ms is the longest cache that still
// feels "live" against a 30 s poll cadence; shorter than the aggregator's
// own 1500 ms per-sibling timeout so a stuck sibling can't pin a stale
// answer here.
const AGGREGATOR_CACHE_TTL_MS = 1_500;
let _aggregatorCacheValue: Awaited<ReturnType<typeof fetchSiblingBoards>> | null = null;
let _aggregatorCacheStamp = 0;
function _aggregatorCacheGet(): Awaited<ReturnType<typeof fetchSiblingBoards>> | null {
  if (_aggregatorCacheValue === null) return null;
  if (Date.now() - _aggregatorCacheStamp > AGGREGATOR_CACHE_TTL_MS) return null;
  return _aggregatorCacheValue;
}
function _aggregatorCacheSet(siblings: Awaited<ReturnType<typeof fetchSiblingBoards>>): void {
  _aggregatorCacheValue = siblings;
  _aggregatorCacheStamp = Date.now();
}
function _aggregatorCacheClear(): void {
  _aggregatorCacheValue = null;
  _aggregatorCacheStamp = 0;
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
  const threadKey = `${channelId}-${threadTs || 'direct'}`;
  let totalActiveMs = 0;
  let sessionCount = 0;
  let compactionCount = 0;
  for (const [k, s] of allSessions.entries()) {
    if (k !== threadKey) continue;
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
        // Pre-discover so `shouldAggregate` actually gates the fan-out
        // (PR #815 review caught the original where the gate ran AFTER
        // the fetch, making it dead code). `readAllInstances` is a
        // single readdir + N tiny readFiles — cheap enough to run on
        // every poll without caching.
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
        // 1.5 s is short enough to feel "live" and long enough to
        // collapse a burst of concurrent polls.
        const cached = _aggregatorCacheGet();
        let siblings;
        if (cached) {
          siblings = cached;
        } else {
          siblings = await fetchSiblingBoards({
            selfPort,
            selfPid: process.pid,
            viewerToken: config.conversation.viewerToken,
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
      const { key } = request.params;
      // #814 wire-format key carries the `${instanceName}::` prefix; strip
      // it before resolving against the local session map.
      const originalKey = resolveSelfActionKey(key, reply);
      if (originalKey === null) return;
      if (!requireSessionOwner(request, reply, originalKey)) return;
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
      const { key } = request.params;
      const originalKey = resolveSelfActionKey(key, reply);
      if (originalKey === null) return;
      if (!requireSessionOwner(request, reply, originalKey)) return;
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
      const { key } = request.params;
      const originalKey = resolveSelfActionKey(key, reply);
      if (originalKey === null) return;
      if (!requireSessionOwner(request, reply, originalKey)) return;
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
      const { key } = request.params;
      const { message } = request.body || {};
      if (!message || typeof message !== 'string') {
        reply.status(400).send({ error: 'message is required and must be a string' });
        return;
      }
      if (message.length > 4000) {
        reply.status(400).send({ error: 'message exceeds max length (4000 chars)' });
        return;
      }
      const originalKey = resolveSelfActionKey(key, reply);
      if (originalKey === null) return;
      if (!requireSessionOwner(request, reply, originalKey)) return;
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
      const { key } = request.params;
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
      const originalKey = resolveSelfActionKey(key, reply);
      if (originalKey === null) return;
      if (!requireSessionOwner(request, reply, originalKey)) return;
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
      const { key } = request.params;
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
      const originalKey = resolveSelfActionKey(key, reply);
      if (originalKey === null) return;
      if (!requireSessionOwner(request, reply, originalKey)) return;
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
      const { key } = request.params;
      const originalKey = resolveSelfActionKey(key, reply);
      if (originalKey === null) return;
      if (!requireSessionOwner(request, reply, originalKey)) return;
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
  /* Surface hierarchy — 3 deliberate planes */
  --bg: #0b0e14;
  --surface: #12171f;
  --surface-raised: #1a2130;
  --border: #2a3548;
  --border-focus: #4d9de0;
  /* Typography */
  --text: #e8edf5;
  --text-secondary: #94a3b8;
  --text-tertiary: #6b7d95;
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
}

/* ── LIGHT THEME — override surface & text planes ── */
[data-theme="light"] {
  --bg: #f8f9fb;
  --surface: #ffffff;
  --surface-raised: #f0f2f5;
  --border: #e2e5ea;
  --border-focus: #4d9de0;
  --text: #1a1d23;
  --text-secondary: #5a6577;
  --text-tertiary: #8b95a5;
  --accent: #2b7fd4;
  --accent-hover: #2468b0;
  /* Functional colors — WCAG AA ≥4.5:1 on all light surfaces */
  --green: #14783b;
  --yellow: #a16207;
  --red: #b91c1c;
  --purple: #7c3aed;
  --orange: #c2410c;
}
[data-theme="light"] ::selection { background: var(--accent); color: #fff; }
[data-theme="light"] ::-webkit-scrollbar-thumb { background: #c8cdd5; border-color: var(--bg); }
[data-theme="light"] .card { box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
[data-theme="light"] .card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
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

/* ── MAIN ── */
.main { flex: 1; padding: 20px; }

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

/* ── KANBAN — strict 4-column grid ── */
.kanban {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  align-items: start;
}
.kanban-col {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-height: 120px;
  display: flex;
  flex-direction: column;
}
.kanban-col-header {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.kanban-col-header h3 {
  font-size: 12px;
  font-weight: 700;
  flex: 1;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.kanban-col-header .count {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: var(--radius);
  font-size: 12px;
  font-weight: 700;
  min-width: 24px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.kanban-col .cards {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

/* ── STATUS INDICATORS — geometric square + text label ── */
.working-dot,.waiting-dot,.idle-dot,.closed-dot {
  width: 8px; height: 8px;
  border-radius: 1px;
  display: inline-block;
  flex-shrink: 0;
}
.working-dot { background: var(--green); animation: pulse-dot 1.4s ease-in-out infinite; }
.waiting-dot { background: var(--yellow); }
.idle-dot { background: var(--text-tertiary); }
.closed-dot { background: var(--red); opacity: 0.6; }

@keyframes pulse-dot {
  0%,100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* ── CARD — Bauhaus: flat, geometric, structured layout ── */
.card {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-left: 3px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  cursor: pointer;
  position: relative;
  transition: border-color var(--speed) var(--ease), box-shadow var(--speed) var(--ease);
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.card:hover { border-top-color: var(--accent); border-right-color: var(--accent); border-bottom-color: var(--accent); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }

/* ── AURA SYSTEM — pure geometric: left-edge color band only ── */
.aura-legendary { border-left: 4px solid var(--orange) !important; background: linear-gradient(90deg, rgba(249,115,22,0.06) 0%, transparent 40%); }
.aura-epic { border-left: 4px solid var(--purple) !important; background: linear-gradient(90deg, rgba(167,139,250,0.05) 0%, transparent 40%); }
.aura-blue { border-left: 4px solid var(--accent) !important; }
.aura-green { border-left: 4px solid var(--green) !important; }
.aura-white { border-left: 4px solid rgba(200,210,220,0.4) !important; }

/* ── CARD CONTENT — structured label:value grid ── */
.card .card-title { font-weight: 700; font-size: 13.5px; margin-bottom: 5px; line-height: 1.3; display: flex; align-items: flex-start; gap: 6px; }
.card .card-title-text { flex: 1; }
.card .conv-link { color: var(--accent); text-decoration: none; font-size: 12px; flex-shrink: 0; opacity: 0.7; }
.card .conv-link:hover { opacity: 1; }
.card .card-meta {
  font-size: 11px;
  color: var(--text-tertiary);
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
  font-weight: 600;
  flex-wrap: wrap;
  align-items: center;
}
.card .card-meta span { white-space: nowrap; }
.card .card-meta span + span::before { content: "·"; color: var(--text-tertiary); opacity: 0.5; margin-right: 6px; }
.card .card-meta .meta-owner { color: var(--purple); }
.card .card-links { font-size: 12px; margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
.card .card-links a { color: var(--accent); text-decoration: none; font-weight: 600; }
.card .card-links a:hover { text-decoration: underline; }
.card .card-merge { font-size: 12px; color: var(--green); margin-top: 2px; font-weight: 600; font-variant-numeric: tabular-nums; }
.card .card-tokens { font-size: 12px; color: var(--text-tertiary); margin-top: 2px; font-variant-numeric: tabular-nums; }
.card .card-tokens .cost { color: var(--green); font-weight: 700; }

/* ── TIMER + COUNTER ROW — icon · value · separator ── */
.card .card-timer-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.card .card-timer-row > span { white-space: nowrap; }
.card .card-timer-row .card-timer-total { color: var(--text-tertiary); }
.card .card-timer-row .card-timer-compactions,
.card .card-timer-row .card-timer-sessions { color: var(--text-tertiary); }

/* ── HERO TIMER — big live timer above card title ── */
.card .card-timer-hero {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  margin-bottom: 6px;
}
.card .card-timer-hero .hero-icon { font-size: 18px; }
.card .card-timer-hero .card-timer-live { color: var(--text); }

/* ── SHORT REFS ROW — PTN-123 · PR-123 ── */
.card .card-refs {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 11px;
  color: var(--text-tertiary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.card .card-refs a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 700;
}
.card .card-refs a:hover { text-decoration: underline; }
.card .card-refs .ref-sep { color: var(--text-tertiary); opacity: 0.6; }

/* ── META EFFORT — power level token in meta row ── */
.card .card-meta .meta-effort {
  color: var(--accent);
  font-weight: 700;
  text-transform: lowercase;
}

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
.card .context-bar { margin-top: 4px; margin-bottom: 2px; height: 4px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden; }
.card .context-bar-fill { height: 100%; border-radius: 2px; transition: width 0.3s ease; background: var(--accent); }
.card .context-bar-fill.ctx-warn { background: var(--yellow); }
.card .context-bar-fill.ctx-danger { background: var(--red); }

/* ── WORKING PULSE INDICATOR ── */
@keyframes working-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(249,115,22,0.3); }
  50% { box-shadow: 0 0 0 3px rgba(249,115,22,0.08); }
}
.card.card-working { animation: working-pulse 2.5s ease-in-out infinite; }

/* ── EMPTY COLUMN HINT ── */
.kanban-col .empty-hint { text-align: center; padding: 24px 12px; font-size: 12px; color: var(--text-tertiary); opacity: 0.5; font-style: italic; }

/* ── TASK LIST — compact rows ── */
/* min-width: 0 on the flex row lets the content child shrink; otherwise the
   content intrinsic width pushes the right-aligned duration out of view. */
.card-tasks { margin-top: 6px; border-top: 1px solid var(--border); padding-top: 4px; }
.card-task { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; padding: 2px 0; line-height: 1.3; min-width: 0; }
.card-task.completed { color: var(--text-tertiary); opacity: 0.55; }
.card-task.in_progress { color: var(--text); font-weight: 600; }
.card-task .task-icon { flex-shrink: 0; }
.card-task .task-content { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spin { display: inline-block; animation: spin 1.5s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.tasks-more { font-size: 12px; color: var(--text-tertiary); margin-top: 2px; font-weight: 600; }

/* ── ACTION BUTTONS — geometric, adequate hit area ── */
.card-actions { display: flex; gap: 4px; margin-top: 6px; justify-content: flex-end; }
.btn-action {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  cursor: pointer;
  min-height: 26px;
  transition: all var(--speed) var(--ease);
  letter-spacing: 0.02em;
}
.btn-action:hover { border-color: var(--accent); color: var(--text); background: rgba(96,165,250,0.08); }
.btn-action.btn-stop { border-color: rgba(239,68,68,0.3); color: var(--text-secondary); }
.btn-action.btn-stop:hover { border-color: var(--red); color: var(--red); background: rgba(239,68,68,0.08); }
.btn-action.btn-close { border-color: rgba(250,204,21,0.3); color: var(--text-secondary); }
.btn-action.btn-close:hover { border-color: var(--yellow); color: var(--yellow); background: rgba(250,204,21,0.08); }
.btn-action.btn-trash { border-color: rgba(239,68,68,0.2); color: var(--text-tertiary); }
.btn-action.btn-trash:hover { border-color: var(--red); color: var(--red); background: rgba(239,68,68,0.08); }

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
  transition: all 0.15s;
  font-family: inherit;
  line-height: 1.3;
}
.btn-choice:hover {
  border-color: var(--accent);
  background: rgba(77,157,224,0.18);
  color: var(--text);
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
.btn-choice-recommended:hover {
  background: #256f38;
  color: white;
  border-color: #256f38;
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

/* ── DRAG & DROP ── */
.card[draggable="true"] { cursor: grab; }
.card[draggable="true"]:active { cursor: grabbing; }
.card.dragging { opacity: 0.4; }
.kanban-col.drag-over .cards { outline: 2px dashed var(--accent); outline-offset: -2px; border-radius: var(--radius); min-height: 60px; }
.kanban-col#col-closed.drag-over .cards { outline-color: var(--yellow); }
.kanban-col .drop-hint { display: none; text-align: center; padding: 8px; font-size: 12px; color: var(--text-tertiary); font-style: italic; }
.kanban-col.drag-over .drop-hint { display: block; }

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

/* ── CLOSED COLUMN ── */
.show-older-btn {
  background: var(--surface-raised);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  cursor: pointer;
  margin: 4px 8px 8px;
  width: calc(100% - 16px);
  transition: all var(--speed) var(--ease);
  text-align: center;
  min-height: 30px;
}
.show-older-btn:hover { border-color: var(--accent); color: var(--text); }

/* ── RESPONSIVE — Bauhaus grid adapts ── */
@media (max-width: 1100px) {
  .kanban { grid-template-columns: repeat(2, 1fr); }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 680px) {
  .kanban { grid-template-columns: 1fr; }
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
  .card { padding: 12px 16px; }
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

    <div style="border-top:1px solid var(--border);margin:16px 0 12px;opacity:0.5"></div>
    <h2 style="font-size:0.95em;margin-bottom:12px;color:var(--text-secondary)">&#x1F4CB; &#xC138;&#xC158; &#xBCF4;&#xB4DC;</h2>
    <div class="kanban" id="kanban">
      <div class="kanban-col" id="col-working">
        <div class="kanban-col-header">
          <span class="working-dot"></span>
          <h3>&#xC9C4;&#xD589;</h3>
          <span class="count" id="count-working">0</span>
        </div>
        <div class="cards" id="cards-working"></div>
      </div>
      <div class="kanban-col" id="col-waiting">
        <div class="kanban-col-header">
          <span class="waiting-dot"></span>
          <h3>&#xC720;&#xC800;&#xC785;&#xB825;</h3>
          <span class="count" id="count-waiting">0</span>
        </div>
        <div class="cards" id="cards-waiting"></div>
      </div>
      <div class="kanban-col" id="col-idle">
        <div class="kanban-col-header">
          <span class="idle-dot"></span>
          <h3>&#xB300;&#xAE30;</h3>
          <span class="count" id="count-idle">0</span>
        </div>
        <div class="cards" id="cards-idle"></div>
      </div>
      <div class="kanban-col" id="col-closed">
        <div class="kanban-col-header">
          <span class="closed-dot"></span>
          <h3>&#xB3D9;&#xBA74;</h3>
          <span class="count" id="count-closed">0</span>
        </div>
        <div class="cards" id="cards-closed"></div>
      </div>
    </div>
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
    <!-- Unified scroll area: question + tasks + turns scroll together as one. -->
    <div class="panel-scroll" id="panel-scroll">
      <div class="panel-question" id="panel-question" style="display:none"></div>
      <div class="panel-tasks" id="panel-tasks" style="display:none"></div>
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
// 1-Hz tick: update every .card-timer-live element from its data-* attrs.
// Runs unconditionally of WS state — WS feeds new data-* values, tick reads them.
// The producer of .card-timer-live is the heroTimerHtml builder in renderCard()
// (server side). Keep the class name + data-leg-started / data-accumulated attr
// contract in sync with that emitter.
function updateTimers() {
  var now = Date.now();
  var els = document.querySelectorAll('.card-timer-live');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var started = Number(el.dataset.legStarted) || 0;
    var accumulated = Number(el.dataset.accumulated) || 0;
    var elapsed = (started ? now - started : 0) + accumulated;
    el.textContent = formatNmSSs(elapsed);
  }
}
setInterval(updateTimers, 1000);

// ── Card Aura ──
function getAuraClass(isoStr) {
  const ms = Date.now() - new Date(isoStr).getTime();
  const min = ms / 60000;
  if (min <= 10) return 'aura-legendary';
  if (min <= 30) return 'aura-epic';
  if (min <= 60) return 'aura-blue';
  if (min <= 240) return 'aura-green';
  if (min <= 480) return 'aura-white';
  return '';
}

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

// ── Kanban rendering ──
function renderBoard(board) {
  _sessionCache = {}; // Clear stale cache each render cycle
  _envIndex = null;   // Recompute env palette assignment from the new cache
  // Pre-populate cache from full board so renderCard's env lookup sees the
  // sibling cards too (renderCard runs per column and the pal-index pass
  // reads the whole cache).
  for (var col0 of ['working', 'waiting', 'idle', 'closed']) {
    var arr = board[col0] || [];
    for (var i0 = 0; i0 < arr.length; i0++) {
      _sessionCache[arr[i0].key] = arr[i0];
    }
  }
  _envIndex = _buildEnvIndex();
  var emptyHints = { working: 'No active sessions', waiting: 'No sessions awaiting input', idle: 'No idle sessions' };
  for (const col of ['working', 'waiting', 'idle']) {
    const container = document.getElementById('cards-' + col);
    const countEl = document.getElementById('count-' + col);
    const sessions = (board[col] || []);
    countEl.textContent = sessions.length;
    container.innerHTML = sessions.length > 0
      ? sessions.map(function(s) { return renderCard(s, col); }).join('')
      : '<div class="empty-hint">' + emptyHints[col] + '</div>';
  }
  // Closed column with 7-day filter
  renderClosedColumn(board.closed || []);
}

function renderClosedColumn(sessions) {
  const container = document.getElementById('cards-closed');
  const countEl = document.getElementById('count-closed');
  countEl.textContent = sessions.length;

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = sessions.filter(function(s) { return new Date(s.lastActivity).getTime() >= sevenDaysAgo; });
  const older = sessions.filter(function(s) { return new Date(s.lastActivity).getTime() < sevenDaysAgo; });

  let html = recent.map(function(s) { return renderCard(s, 'closed'); }).join('');
  if (showOlderClosed) {
    html += older.map(function(s) { return renderCard(s, 'closed'); }).join('');
  }
  if (older.length > 0) {
    const label = showOlderClosed
      ? '&#x25B2; Hide older (' + older.length + ')'
      : '&#x25BC; Show older (' + older.length + ')';
    html += '<button class="show-older-btn" onclick="toggleOlderClosed()">' + label + '</button>';
  }
  container.innerHTML = html;
}

function toggleOlderClosed() {
  showOlderClosed = !showOlderClosed;
  loadSessions();
}

function renderCard(s, col) {
  _sessionCache[s.key] = s;
  const aura = getAuraClass(s.lastActivity);
  const workingCls = (col === 'working') ? ' card-working' : '';
  const cls = 'card' + (aura ? ' ' + aura : '') + workingCls;

  // Owner gating — server-side requireSessionOwner is the authoritative guard;
  // this is UX only. Fail closed: if ownerId is missing (legacy record) the
  // viewer is not treated as owner so the server-side reject is expected.
  const isOwner = !!s.ownerId && s.ownerId === currentUserId;
  // readOnlyAttrs carries only the disabled attribute — each button owns its
  // own title= so there is no duplicate-attribute clash when the button already
  // needs a descriptive tooltip (e.g. pending-question choices).
  const readOnlyAttrs = isOwner ? '' : ' disabled';

  // Conversation link
  const convLink = s.conversationId
    ? ' <a class="conv-link" href="/conversations/' + esc(s.conversationId) + '" target="_blank" onclick="event.stopPropagation()" title="View conversation">&#x1F4DD;</a>'
    : '';

  // Slack thread link
  const slackLink = s.slackThreadUrl
    ? ' <a class="slack-link" href="' + esc(s.slackThreadUrl) + '" target="_blank" onclick="event.stopPropagation()" title="Open in Slack">&#x1F4AC;</a>'
    : '';

  // Merge stats
  const mergeHtml = s.mergeStats
    ? '<div class="card-merge">+' + s.mergeStats.totalLinesAdded + ' / -' + s.mergeStats.totalLinesDeleted + '</div>'
    : '';

  // Token info + context bar
  let tokenHtml = '';
  if (s.tokenUsage) {
    const ctxPct = s.tokenUsage.contextUsagePercent || 0;
    const ctxCls = ctxPct > 80 ? 'ctx-danger' : ctxPct > 60 ? 'ctx-warn' : '';
    tokenHtml = '<div class="card-tokens">' + formatTokens(s.tokenUsage.totalInputTokens + s.tokenUsage.totalOutputTokens) + ' tok &middot; <span class="cost">$' + s.tokenUsage.totalCostUsd.toFixed(2) + '</span></div>'
      + (ctxPct > 0 ? '<div class="context-bar"><div class="context-bar-fill ' + ctxCls + '" style="width:' + Math.min(ctxPct, 100).toFixed(0) + '%"></div></div>' : '');
  }

  // Tasks — sort in_progress → pending → completed; completed items sink below the 5-item slice.
  let tasksHtml = '';
  if (s.tasks && s.tasks.length > 0) {
    function taskRank(status) {
      if (status === 'in_progress') return 0;
      if (status === 'completed') return 2;
      return 1; // pending (and any unknown status)
    }
    const sortedTasks = s.tasks.slice().sort(function(a, b) {
      return taskRank(a.status) - taskRank(b.status);
    });
    const shown = sortedTasks.slice(0, 5);
    const extra = sortedTasks.length - shown.length;
    const taskItems = shown.map(function(t) {
      let icon, cls2;
      if (t.status === 'completed') { icon = '&#x2705;'; cls2 = 'completed'; }
      else if (t.status === 'in_progress') { icon = '<span class="spin">&#x1F504;</span>'; cls2 = 'in_progress'; }
      else { icon = '&#x25CB;'; cls2 = 'pending'; }
      var durStr = '';
      if (t.status === 'completed' && t.startedAt && t.completedAt) {
        durStr = ' <span style="font-size:10px;color:var(--text-tertiary);margin-left:auto;flex-shrink:0">' + formatDuration(t.completedAt - t.startedAt) + '</span>';
      } else if (t.status === 'in_progress' && t.startedAt) {
        durStr = ' <span style="font-size:10px;color:var(--accent);margin-left:auto;flex-shrink:0">' + formatDuration(Date.now() - t.startedAt) + '...</span>';
      }
      return '<div class="card-task ' + cls2 + '"><span class="task-icon">' + icon + '</span><span class="task-content">' + esc(t.content.slice(0, 50)) + '</span>' + durStr + '</div>';
    }).join('');
    tasksHtml = '<div class="card-tasks">' + taskItems + (extra > 0 ? '<div class="tasks-more">+' + extra + ' more</div>' : '') + '</div>';
  }

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
  const actionsHtml = '<div class="card-actions">' + actionBtn + '</div>';

  const modelShort = esc(s.model).replace(/^claude-/, '').replace(/-\\d{8}$/, '');

  const legStarted = s.activeLegStartedAtMs || 0;
  const accumulated = s.activeAccumulatedMs || 0;
  const compactions = s.compactionCount || 0;
  const threadTotal = s.threadTotalActiveMs || 0;
  const threadSessions = s.threadSessionCount || 0;

  // data-leg-started / data-accumulated live on the .card-timer-live span itself
  // — the 1-Hz updater at updateTimers() (see ~line 2880) reads them via
  // querySelectorAll('.card-timer-live'). We always emit the live span, even in
  // the zero state, so polling picks it up the instant the leg starts.
  //
  // The hero value is "current turn" = current leg elapsed (active accumulator
  // plus any open-leg delta). Thread totals (Σ) live on the row below.
  const heroTimerHtml =
    '<div class="card-timer-hero" title="현재 턴 경과 시간 (Current turn)">'
    + '<span class="hero-icon">&#x23F1;&#xFE0F;</span>'
    + '<span class="card-timer-live" data-leg-started="' + legStarted + '" data-accumulated="' + accumulated + '" title="현재 턴 경과 시간 (Current turn)">' + formatNmSSs(accumulated + (legStarted ? Date.now() - legStarted : 0)) + '</span>'
    + '</div>';

  // Stats row: thread total (Σ) · compactions · session count. No live span here —
  // the live leg moved to the hero above.
  const timerRowHtml =
    '<div class="card-timer-row">'
    + '<span class="card-timer-total" title="Thread total active time">&Sigma; ' + formatNmSSs(threadTotal) + '</span>'
    + '<span class="card-timer-compactions" title="Compactions">&#x1F5DC;&#xFE0F; ' + compactions + '</span>'
    + '<span class="card-timer-sessions" title="Thread session count"># ' + threadSessions + '</span>'
    + '</div>';

  // Short refs (PTN-123 · PR-123). escAttr for href/title because they're attribute values.
  const refParts = [];
  if (s.issueShortRef && s.issueUrl) {
    const issueTip = s.issueTitle || s.issueLabel || s.issueShortRef;
    refParts.push('<a href="' + escAttr(s.issueUrl) + '" target="_blank" onclick="event.stopPropagation()" title="' + escAttr(issueTip) + '">' + esc(s.issueShortRef) + '</a>');
  }
  if (s.prShortRef && s.prUrl) {
    const prTip = s.prTitle || s.prLabel || s.prShortRef;
    refParts.push('<a href="' + escAttr(s.prUrl) + '" target="_blank" onclick="event.stopPropagation()" title="' + escAttr(prTip) + '">' + esc(s.prShortRef) + '</a>');
  }
  const refsHtml = refParts.length
    ? '<div class="card-refs">' + refParts.join('<span class="ref-sep">&middot;</span>') + '</div>'
    : '';

  const effortHtml = s.effort
    ? '<span class="meta-effort" title="Power level">' + esc(s.effort) + '</span>'
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
  const metaHtml = '<div class="card-meta">'
    + envHtml
    + '<span>' + esc(s.workflow) + '</span>'
    + '<span>' + modelShort + '</span>'
    + effortHtml
    + '<span class="meta-owner">' + esc(s.ownerName) + '</span>'
    + '<span>' + timeAgo(s.lastActivity) + '</span>'
    + '</div>';

  // Server-resolved headline (#762) — displayHeadline reflects the full
  // priority chain (summaryTitle then issueTitle then prTitle then title then
  // 'Untitled'). The local fallback covers the WS patch path where
  // summaryTitleChanged / sessionUpdated may have rewritten only a subset.
  const displayHeadline = s.displayHeadline || s.summaryTitle || s.title;

  // Card order: hero → stats → title → refs → meta → issue/pr subtitles → tokens → merge → question → tasks → actions.
  // linksHtml removed (2026-04 #708): refs + issue/pr subtitles already surface
  // the same hrefs; the iconized line was redundant and bloated the card.
  return '<div class="' + cls + '" draggable="true" data-session-key="' + escJs(s.key) + '" data-source-col="' + col + '" onclick="openPanel(\\'' + escJs(s.key) + '\\')">'
    + heroTimerHtml
    + timerRowHtml
    + '<div class="card-title"><span class="card-title-text">' + esc(displayHeadline) + '</span>' + slackLink + convLink + '</div>'
    + refsHtml
    + metaHtml
    + (s.issueTitle ? '<div style="font-size:0.7em;color:var(--text-secondary);margin-top:3px">' + esc(s.issueTitle).slice(0, 60) + '</div>' : '')
    + (s.prTitle ? '<div style="font-size:0.7em;color:var(--text-secondary);margin-top:2px">' + esc(s.prTitle).slice(0, 60) + '</div>' : '')
    + tokenHtml
    + mergeHtml
    + questionHtml
    + tasksHtml
    + actionsHtml
    + '</div>';
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
        var cardTitleEls = document.querySelectorAll('[data-session-key="' + CSS.escape(msg.sessionKey) + '"] .card-title-text');
        for (var i = 0; i < cardTitleEls.length; i++) {
          cardTitleEls[i].textContent = headline;
        }
        if (panelOpen && panelSessionKey === msg.sessionKey) {
          var pt = document.getElementById('panel-title');
          if (pt) pt.textContent = headline;
        }
      } else if (msg.type === 'sessionUpdated' && msg.session && msg.session.key) {
        // #762 — single-session card refresh from broadcastSingleSessionUpdate.
        // Replace just this card's outerHTML so the link-derived title flow
        // (which fires before the next full board push) lands immediately.
        // Preserves the column the card already lives in by reading the
        // existing element's data-source-col attribute.
        var updatedKey = msg.session.key;
        _sessionCache[updatedKey] = msg.session;
        var existingCard = document.querySelector('[data-session-key="' + CSS.escape(updatedKey) + '"]');
        if (existingCard) {
          var col = existingCard.getAttribute('data-source-col') || 'idle';
          var newHtml = renderCard(msg.session, col);
          var wrapper = document.createElement('div');
          wrapper.innerHTML = newHtml;
          var newCard = wrapper.firstElementChild;
          if (newCard) existingCard.replaceWith(newCard);
        }
        if (panelOpen && panelSessionKey === updatedKey) {
          var pt2 = document.getElementById('panel-title');
          if (pt2) pt2.textContent = msg.session.displayHeadline || msg.session.summaryTitle || msg.session.title || 'Untitled';
        }
      }
    } catch (e) { /* ignore */ }
  };
}

// ── Token stats from session cache ──
function updateTokenStats() {
  // #814 — group token usage by environment.instanceName so the topbar
  // tooltip can break down "oudwood-dev: 12K | mac-mini-dev: 8K | Total: 20K".
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

// ── Slide Panel ──
function openPanel(sessionKey) {
  const s = _sessionCache[sessionKey];
  if (!s) return;

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
        // Jump to bottom on fresh load.
        var scrollEl = document.getElementById('panel-scroll');
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
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
      var newScrollHeight = scrollEl.scrollHeight;
      scrollEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
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

// ── Drag & Drop (event delegation on kanban board) ──
var dragState = { key: null, sourceCol: null, title: '' };

document.addEventListener('dragstart', function(e) {
  var card = e.target.closest('.card[draggable="true"]');
  if (!card) return;
  dragState.key = card.dataset.sessionKey;
  dragState.sourceCol = card.dataset.sourceCol;
  var s = _sessionCache[dragState.key];
  dragState.title = s ? s.title : '';
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragState.key);
});

document.addEventListener('dragend', function(e) {
  var card = e.target.closest('.card');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.kanban-col').forEach(function(col) { col.classList.remove('drag-over'); });
  dragState = { key: null, sourceCol: null, title: '' };
});

document.addEventListener('dragover', function(e) {
  var col = e.target.closest('.kanban-col');
  if (!col || !dragState.key) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.kanban-col').forEach(function(c) { c.classList.remove('drag-over'); });
  col.classList.add('drag-over');
});

document.addEventListener('dragleave', function(e) {
  var col = e.target.closest('.kanban-col');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
});

document.addEventListener('drop', function(e) {
  e.preventDefault();
  var col = e.target.closest('.kanban-col');
  if (!col || !dragState.key) return;
  document.querySelectorAll('.kanban-col').forEach(function(c) { c.classList.remove('drag-over'); });

  var targetCol = col.id.replace('col-', '');
  var sourceCol = dragState.sourceCol;
  var key = dragState.key;
  var title = dragState.title || key;

  // T6: Drag to closed column = Close
  if (targetCol === 'closed' && sourceCol !== 'closed') {
    if (confirm('Close session "' + title + '"?')) {
      doAction(key, 'close');
    }
  }
  // T7: Drag working card out = Stop (interrupt)
  else if (sourceCol === 'working' && targetCol !== 'working') {
    if (confirm('Stop (interrupt) session "' + title + '"?')) {
      doAction(key, 'stop');
    }
  }

  dragState = { key: null, sourceCol: null, title: '' };
});

// ── Init ──
loadUsers();
loadSessions().then(function() { loadStats(); });
connectWs();
setInterval(loadSessions, 30000);
</script>
</body>
</html>`;
}
