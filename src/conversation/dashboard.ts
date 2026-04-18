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
import { Logger } from '../logger';
import { MetricsEventStore } from '../metrics/event-store';
import { ReportAggregator } from '../metrics/report-aggregator';
import { AggregatedMetrics, type MetricsEvent } from '../metrics/types';
import { type ArchivedSession, getArchiveStore } from '../session-archive';
import { buildThreadPermalink } from '../turn-notifier';
import { getConversation, resummarizeTurn, updateConversationTitleSub } from './recorder';
import { generateTitle } from './title-generator';

const logger = new Logger('Dashboard');

// ── Types ──────────────────────────────────────────────────────────

export interface KanbanSession {
  key: string;
  title: string;
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

/** Verify the authenticated user owns the target session. Returns null if OK, or a 403 reply if not. */
function requireSessionOwner(request: any, reply: any, sessionKey: string): boolean {
  const authContext = request.authContext;
  // Admin bypasses ownership check
  if (authContext?.isAdmin) return true;

  const sessions = _getSessionsFn?.();
  const targetSession = sessions?.get(sessionKey);
  if (authContext?.userId && targetSession && targetSession.ownerId !== authContext.userId) {
    reply.status(403).send({ error: 'You can only modify your own sessions' });
    return false;
  }
  return true;
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

// ── Kanban transformation ──────────────────────────────────────────

function sessionToKanban(key: string, s: any): KanbanSession {
  const tasks = _getTasksFn ? _getTasksFn(key) : undefined;
  return {
    key,
    title: s.title || 'Untitled',
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
export function archivedToKanban(archived: ArchivedSession): KanbanSession {
  return {
    key: `archived_${archived.sessionKey}_${archived.archivedAt}`,
    title: archived.title || 'Untitled',
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
    const payload = JSON.stringify({ type: 'task_update', sessionKey, tasks });
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

/** Broadcast session action feedback to all connected WebSocket clients */
export function broadcastSessionAction(sessionKey: string, action: 'stop' | 'close' | 'trash'): void {
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
  server.get<{ Querystring: { userId?: string } }>(
    '/api/dashboard/sessions',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.query.userId || undefined;
      const board = buildKanbanBoard(userId);
      reply.send({ board });
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
      // RBAC: OAuth users can only view their own stats
      const authContext = (request as any).authContext;
      if (authContext && !authContext.isAdmin && authContext.userId && authContext.userId !== userId) {
        reply.status(403).send({ error: 'You can only view your own stats' });
        return;
      }
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
  server.get<{ Params: { conversationId: string } }>(
    '/api/dashboard/session/:conversationId',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const record = await getConversation(request.params.conversationId);
        if (!record) {
          reply.status(404).send({ error: 'Conversation not found' });
          return;
        }
        // RBAC: OAuth users can only view their own session details
        const authContext = (request as any).authContext;
        if (authContext && !authContext.isAdmin && authContext.userId && record.ownerId !== authContext.userId) {
          reply.status(403).send({ error: 'You can only view your own sessions' });
          return;
        }
        // Return lightweight turn summaries (no rawContent for assistant turns)
        const turns = record.turns.map((t) => ({
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
        });
      } catch (error) {
        logger.error('Error fetching session detail', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    },
  );

  // Resummarize a specific assistant turn
  server.post<{ Params: { conversationId: string; turnId: string } }>(
    '/api/dashboard/session/:conversationId/resummarize/:turnId',
    { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] },
    async (request, reply) => {
      try {
        // RBAC: check conversation ownership
        const authContext = (request as any).authContext;
        if (authContext && !authContext.isAdmin) {
          const record = await getConversation(request.params.conversationId);
          if (!record) {
            reply.status(404).send({ error: 'Turn not found or not an assistant turn' });
            return;
          }
          if (authContext.userId && record.ownerId !== authContext.userId) {
            reply.status(403).send({ error: 'You can only modify your own conversations' });
            return;
          }
        }
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
        // RBAC: check conversation ownership
        const authContext = (request as any).authContext;
        if (authContext && !authContext.isAdmin && authContext.userId && record.ownerId !== authContext.userId) {
          reply.status(403).send({ error: 'You can only modify your own conversations' });
          return;
        }

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
      if (!requireSessionOwner(request, reply, key)) return;
      try {
        if (_stopHandlerFn) {
          await _stopHandlerFn(key);
        }
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
      if (!requireSessionOwner(request, reply, key)) return;
      try {
        if (_closeHandlerFn) {
          await _closeHandlerFn(key);
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
      if (!requireSessionOwner(request, reply, key)) return;
      try {
        if (_trashHandlerFn) {
          await _trashHandlerFn(key);
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
      if (!requireSessionOwner(request, reply, key)) return;
      try {
        if (_commandHandlerFn) {
          await _commandHandlerFn(key, message);
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
      if (!requireSessionOwner(request, reply, key)) return;
      try {
        if (_choiceAnswerHandlerFn) {
          await _choiceAnswerHandlerFn(key, choiceId, label, question);
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
      if (!requireSessionOwner(request, reply, key)) return;
      try {
        if (_multiChoiceAnswerHandlerFn) {
          await _multiChoiceAnswerHandlerFn(key, selections);
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
}
.topbar h1 {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  flex-shrink: 0;
}
.topbar .nav { display: flex; gap: 6px; margin-left: auto; align-items: center; }
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
.topbar .nav a:hover,
.topbar .nav select:hover { border-color: var(--accent); color: var(--text); }
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
  gap: 8px;
  margin-bottom: 4px;
  font-weight: 600;
  flex-wrap: wrap;
}
.card .card-meta span { white-space: nowrap; }
.card .card-links { font-size: 12px; margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
.card .card-links a { color: var(--accent); text-decoration: none; font-weight: 600; }
.card .card-links a:hover { text-decoration: underline; }
.card .card-owner { font-size: 12px; color: var(--purple); margin-top: 2px; font-weight: 600; }
.card .card-merge { font-size: 12px; color: var(--green); margin-top: 2px; font-weight: 600; font-variant-numeric: tabular-nums; }
.card .card-tokens { font-size: 12px; color: var(--text-tertiary); margin-top: 2px; font-variant-numeric: tabular-nums; }
.card .card-tokens .cost { color: var(--green); font-weight: 700; }

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
.card-tasks { margin-top: 6px; border-top: 1px solid var(--border); padding-top: 4px; }
.card-task { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; padding: 2px 0; line-height: 1.3; }
.card-task.completed { color: var(--text-tertiary); text-decoration: line-through; opacity: 0.5; }
.card-task.in_progress { color: var(--text); font-weight: 600; }
.card-task .task-icon { flex-shrink: 0; }
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
  text-transform: uppercase;
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
.panel-task-item.completed .task-text { color: var(--text-tertiary); text-decoration: line-through; opacity: 0.6; }
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
.panel-turns { flex: 1; overflow-y: auto; padding: 10px 16px; scroll-behavior: smooth; }
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
  display: flex;
  gap: 8px;
  background: var(--surface);
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
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <h1>&#x26A1; soma-work</h1>
    <span class="ws-badge" id="ws-status">Connecting...</span>
    <div class="nav">
      <select id="user-select" onchange="selectUser(this.value)">
        <option value="">All Users</option>
      </select>
      <a href="/conversations">&#x1F4DD; <span class="nav-text">Conversations</span><span class="nav-icon" style="display:none">Conv</span></a>
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
      <div class="stat-card"><div class="label">&#xD1A0;&#xD070; &#xC0AC;&#xC6A9;</div><div class="value" id="stat-tokens">-</div></div>
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
    <div class="panel-question" id="panel-question" style="display:none"></div>
    <div class="panel-tasks" id="panel-tasks" style="display:none"></div>
    <div class="panel-turns" id="panel-turns">
      <p style="color:var(--text-secondary);text-align:center;margin-top:40px">Click a session card to view details</p>
    </div>
    <div class="panel-command" id="panel-command" style="display:none">
      <input type="text" id="cmd-input" placeholder="Send message to session..." onkeydown="if(event.key==='Enter')sendCommand()">
      <button class="btn-send" id="cmd-send" onclick="sendCommand()">Send</button>
    </div>
  </div>
</div>

<script>
const INIT_USER = ${initUser};
let currentUserId = INIT_USER || '';
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
  else { icon = '&#x25FB;'; cls = 'pending'; }

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

// Fetch CSRF token (reusable — called on load and after JWT rotation invalidates token)
async function refreshCsrfToken() {
  try {
    const res = await fetch('/auth/me');
    if (res.ok) { const data = await res.json(); _csrfToken = data.csrfToken || ''; }
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

// ── Kanban rendering ──
function renderBoard(board) {
  _sessionCache = {}; // Clear stale cache each render cycle
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

  // Links
  const links = [];
  if (s.issueUrl) {
    links.push('<a href="' + esc(s.issueUrl) + '" target="_blank" onclick="event.stopPropagation()">&#x1F4CB; ' + esc(s.issueLabel || 'Issue') + '</a>');
  }
  if (s.prUrl) {
    var prBadge = s.prStatus ? '<span class="pr-badge pr-' + esc(s.prStatus) + '">' + esc(s.prStatus) + '</span>' : '';
    links.push('<a href="' + esc(s.prUrl) + '" target="_blank" onclick="event.stopPropagation()">&#x1F500; ' + esc(s.prLabel || 'PR') + prBadge + '</a>');
  }
  const linksHtml = links.length ? '<div class="card-links">' + links.join('') + '</div>' : '';

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

  // Tasks
  let tasksHtml = '';
  if (s.tasks && s.tasks.length > 0) {
    const shown = s.tasks.slice(0, 5);
    const extra = s.tasks.length - shown.length;
    const taskItems = shown.map(function(t) {
      let icon, cls2;
      if (t.status === 'completed') { icon = '&#x2705;'; cls2 = 'completed'; }
      else if (t.status === 'in_progress') { icon = '<span class="spin">&#x1F504;</span>'; cls2 = 'in_progress'; }
      else { icon = '&#x25FB;'; cls2 = 'pending'; }
      var durStr = '';
      if (t.status === 'completed' && t.startedAt && t.completedAt) {
        durStr = ' <span style="font-size:10px;color:var(--text-tertiary);margin-left:auto;flex-shrink:0">' + formatDuration(t.completedAt - t.startedAt) + '</span>';
      } else if (t.status === 'in_progress' && t.startedAt) {
        durStr = ' <span style="font-size:10px;color:var(--accent);margin-left:auto;flex-shrink:0">' + formatDuration(Date.now() - t.startedAt) + '...</span>';
      }
      return '<div class="card-task ' + cls2 + '"><span class="task-icon">' + icon + '</span>' + esc(t.content.slice(0, 50)) + durStr + '</div>';
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
        recHtml = '<div class="choice-row-recommended">'
          + '<button class="btn-choice btn-choice-recommended" onclick="event.stopPropagation();answerChoice(\\'' + escJs(s.key) + '\\',\\'' + escJs(recOpt.id) + '\\',\\'' + escJs(recLabel) + '\\',\\'' + escJs(pq.question) + '\\',this)" title="' + escAttr(recOpt.description || recLabel) + '">' + esc(recOpt.id) + '. ' + esc(recLabel) + '</button>'
          + '</div>'
          + (otherOpts.length > 0 ? '<hr class="choice-divider">' : '');
      }
      var otherBtns = otherOpts.map(function(c) {
        var lbl = stripRecommendedMarker(c.label);
        return '<button class="btn-choice" onclick="event.stopPropagation();answerChoice(\\'' + escJs(s.key) + '\\',\\'' + escJs(c.id) + '\\',\\'' + escJs(lbl) + '\\',\\'' + escJs(pq.question) + '\\',this)" title="' + escAttr(c.description || lbl) + '">' + esc(c.id) + '. ' + esc(lbl) + '</button>';
      }).join('');
      questionHtml = '<div class="card-question">'
        + '<div class="card-question-text">&#x2753; ' + esc(pq.question).slice(0, 80) + '</div>'
        + '<div class="card-question-choices">' + recHtml + otherBtns + '</div>'
        + '</div>';
    } else if (s.pendingQuestion.type === 'user_choices') {
      questionHtml = renderMultiChoiceCard(s);
    }
  }

  // Action buttons
  let actionBtn = '';
  if (col === 'working') {
    actionBtn = '<button class="btn-action btn-stop" onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'stop\\')">&#x23F9; Stop</button>';
  } else if (col === 'waiting' || col === 'idle') {
    actionBtn = '<button class="btn-action btn-close" onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'close\\')">&#x274C; Close</button>';
  } else if (col === 'closed') {
    // SLEEPING (live) sessions → Close (terminate); archived sessions → Trash (hide)
    actionBtn = s.terminated
      ? '<button class="btn-action btn-trash" onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'trash\\')">&#x1F5D1; Trash</button>'
      : '<button class="btn-action btn-close" onclick="event.stopPropagation();doAction(\\'' + escJs(s.key) + '\\',\\'close\\')">&#x274C; Close</button>';
  }
  const actionsHtml = '<div class="card-actions">' + actionBtn + '</div>';

  const modelShort = esc(s.model).replace(/^claude-/, '').replace(/-\\d{8}$/, '');

  return '<div class="' + cls + '" draggable="true" data-session-key="' + escJs(s.key) + '" data-source-col="' + col + '" onclick="openPanel(\\'' + escJs(s.key) + '\\')">'
    + '<div class="card-title"><span class="card-title-text">' + esc(s.title) + '</span>' + slackLink + convLink + '</div>'
    + '<div class="card-meta"><span>' + esc(s.workflow) + '</span><span>' + modelShort + '</span><span>' + timeAgo(s.lastActivity) + '</span></div>'
    + linksHtml
    + (s.issueTitle ? '<div style="font-size:0.7em;color:var(--text-secondary);margin-top:3px">' + esc(s.issueTitle).slice(0, 60) + '</div>' : '')
    + (s.prTitle ? '<div style="font-size:0.7em;color:var(--text-secondary);margin-top:2px">' + esc(s.prTitle).slice(0, 60) + '</div>' : '')
    + '<div class="card-owner">' + esc(s.ownerName) + '</div>'
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
    }
    // On success, the WebSocket session_update will re-render the board
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
    statusEl.style.background = 'rgba(62,207,142,0.2)';
    statusEl.style.borderColor = 'var(--green)';
    statusEl.style.color = 'var(--green)';
  };
  ws.onclose = function() {
    statusEl.textContent = 'Reconnecting...';
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
      }
    } catch (e) { /* ignore */ }
  };
}

// ── Token stats from session cache ──
function updateTokenStats() {
  let totalTokens = 0, totalCost = 0;
  for (const key in _sessionCache) {
    const s = _sessionCache[key];
    if (currentUserId && s.ownerId !== currentUserId) continue;
    if (s.tokenUsage) {
      totalTokens += s.tokenUsage.totalInputTokens + s.tokenUsage.totalOutputTokens;
      totalCost += s.tokenUsage.totalCostUsd;
    }
  }
  document.getElementById('stat-tokens').textContent = formatTokens(totalTokens);
  document.getElementById('stat-cost').textContent = '$' + totalCost.toFixed(2);
}

// ── Slide Panel ──
function openPanel(sessionKey) {
  const s = _sessionCache[sessionKey];
  if (!s) return;

  panelSessionKey = sessionKey;
  panelConvId = s.conversationId || null;

  document.getElementById('panel-title').textContent = s.title || 'Untitled';

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

  // Conversation turns
  const turnsEl = document.getElementById('panel-turns');
  if (s.conversationId) {
    turnsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;margin-top:40px">Loading...</p>';
    fetch('/api/dashboard/session/' + s.conversationId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        // Handle titleSub
        var tSubText = document.getElementById('panel-title-sub-text');
        var tSubBtn = document.getElementById('panel-title-sub-regen');
        if (data.titleSub) {
          tSubText.textContent = data.titleSub;
          tSubBtn.style.display = 'inline-block';
        } else if (s.conversationId) {
          generateTitleSub(s.conversationId);
        }

        if (!data.turns || data.turns.length === 0) {
          turnsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;margin-top:40px">No conversation turns</p>';
          return;
        }
        var cid = data.id;
        turnsEl.innerHTML = data.turns.map(function(t, i, arr) { return renderTurn(t, i, arr, cid); }).join('');
        turnsEl.scrollTop = turnsEl.scrollHeight;
        attachRawToggleHandlers();
      })
      .catch(function() {
        turnsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;margin-top:40px">Failed to load conversation</p>';
      });
  } else {
    turnsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;margin-top:40px">No conversation recorded</p>';
  }

  // Command input — show for non-closed sessions
  const cmdEl = document.getElementById('panel-command');
  cmdEl.style.display = (s.terminated || s.sessionState === 'SLEEPING') ? 'none' : '';

  document.getElementById('slide-panel').classList.add('open');
  document.getElementById('panel-overlay').classList.add('open');
  panelOpen = true;
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
  const wasAtBottom = turnsEl.scrollHeight - turnsEl.scrollTop <= turnsEl.clientHeight + 40;
  turnsEl.insertAdjacentHTML('beforeend', renderTurn(turn));
  if (wasAtBottom) turnsEl.scrollTop = turnsEl.scrollHeight;
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
    var res = await fetch('/api/dashboard/session/' + encodeURIComponent(convId) + '/generate-title', { method: 'POST' });
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
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && panelOpen) closePanel();
});

// ── Send command (optimistic UI) ──
let _lastSentContent = '';
let _lastSentTime = 0;

async function sendCommand() {
  const input = document.getElementById('cmd-input');
  const btn = document.getElementById('cmd-send');
  const msg = input.value.trim();
  if (!msg || !panelSessionKey) return;

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
    const cmdUrl = '/api/dashboard/session/' + encodeURIComponent(panelSessionKey) + '/command';
    const cmdBody = JSON.stringify({ message: msg });
    let res = await fetch(cmdUrl, { method: 'POST', headers: cmdHeaders, body: cmdBody });
    if (res.status === 403) {
      await refreshCsrfToken();
      const retryHeaders = { 'Content-Type': 'application/json' };
      if (_csrfToken) retryHeaders['X-CSRF-Token'] = _csrfToken;
      res = await fetch(cmdUrl, { method: 'POST', headers: retryHeaders, body: cmdBody });
    }
    if (!res.ok) {
      // Mark optimistic turn as failed
      var lastTurn = document.querySelector('.turn.user:last-child');
      if (lastTurn) {
        lastTurn.style.borderColor = '#e74c3c';
        lastTurn.style.opacity = '0.7';
        lastTurn.insertAdjacentHTML('beforeend', '<div style="color:#e74c3c;font-size:0.75em;margin-top:4px">Failed to send. <a href="#" onclick="event.preventDefault();sendRetry(\\'' + escJs(msg) + '\\')">Retry</a></div>');
      }
    }
  } catch (e) {
    console.error('Command error', e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
    input.disabled = false;
    input.focus();
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
