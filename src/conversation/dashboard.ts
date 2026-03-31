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
 *   POST /api/dashboard/session/:key/stop    → Stop a working session
 *   POST /api/dashboard/session/:key/close   → Close/terminate a session
 *   POST /api/dashboard/session/:key/trash   → Trash (hide) a closed session
 *   POST /api/dashboard/session/:key/command → Send command to session
 *   WS   /ws/dashboard                       → Real-time session state updates (WebSocket)
 */

import { FastifyInstance } from 'fastify';
import { Logger } from '../logger';
import { MetricsEventStore } from '../metrics/event-store';
import { MetricsEvent, AggregatedMetrics } from '../metrics/types';
import { getConversation } from './recorder';

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
  tasks?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
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

// ── Task accessor ──────────────────────────────────────────────────

type TaskAccessor = (sessionKey: string) => Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> | undefined;
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

export function setDashboardStopHandler(fn: StopHandler): void { _stopHandlerFn = fn; }
export function setDashboardCloseHandler(fn: CloseHandler): void { _closeHandlerFn = fn; }
export function setDashboardTrashHandler(fn: TrashHandler): void { _trashHandlerFn = fn; }
export function setDashboardCommandHandler(fn: CommandHandler): void { _commandHandlerFn = fn; }

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
    mergeStats: s.mergeStats ? {
      totalLinesAdded: s.mergeStats.totalLinesAdded,
      totalLinesDeleted: s.mergeStats.totalLinesDeleted,
    } : undefined,
    tokenUsage: s.usage ? {
      totalInputTokens: s.usage.totalInputTokens || 0,
      totalOutputTokens: s.usage.totalOutputTokens || 0,
      totalCostUsd: s.usage.totalCostUsd || 0,
      contextUsagePercent: s.usage.contextWindow
        ? ((s.usage.currentInputTokens || 0) / s.usage.contextWindow) * 100
        : 0,
    } : undefined,
    tasks,
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

    // Closed: terminated or SLEEPING state
    if (session.terminated === true || session.state === 'SLEEPING') {
      board.closed.push(kanban);
    } else {
      switch (kanban.activityState) {
        case 'working': board.working.push(kanban); break;
        case 'waiting': board.waiting.push(kanban); break;
        default: board.idle.push(kanban); break;
      }
    }
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
        sessionsCreated: 0, turnsUsed: 0, prsCreated: 0, prsMerged: 0,
        commitsCreated: 0, linesAdded: 0, linesDeleted: 0,
        mergeLinesAdded: 0, mergeLinesDeleted: 0,
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
      case 'turn_used': day.turnsUsed++; break;
      case 'pr_created': day.prsCreated++; break;
      case 'pr_merged': day.prsMerged++; break;
      case 'commit_created': day.commitsCreated++; break;
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
    case 'day': start = now; break;
    case 'week': start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
    case 'month': start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
  }
  const startDate = start.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  return { startDate, endDate: end };
}

// ── WebSocket broadcast ────────────────────────────────────────────

type WsClient = { send: (data: string) => void; close: () => void };
const wsClients = new Set<WsClient>();

/** Broadcast session state update to all connected WebSocket clients */
export function broadcastSessionUpdate(): void {
  if (wsClients.size === 0) return;
  try {
    const board = buildKanbanBoard();
    const payload = JSON.stringify({ type: 'session_update', board });
    for (const client of wsClients) {
      try { client.send(payload); } catch { wsClients.delete(client); }
    }
  } catch (error) {
    logger.error('Failed to broadcast session update', error);
  }
}

/** Broadcast task update to all connected WebSocket clients */
export function broadcastTaskUpdate(sessionKey: string, tasks: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>): void {
  if (wsClients.size === 0) return;
  try {
    const payload = JSON.stringify({ type: 'task_update', sessionKey, tasks });
    for (const client of wsClients) {
      try { client.send(payload); } catch { wsClients.delete(client); }
    }
  } catch (error) {
    logger.error('Failed to broadcast task update', error);
  }
}

/** Broadcast conversation turn update to all connected WebSocket clients */
export function broadcastConversationUpdate(conversationId: string, turn: any): void {
  if (wsClients.size === 0) return;
  try {
    // Strip rawContent from assistant turns to reduce bandwidth
    const sanitizedTurn = turn?.role === 'assistant' && turn?.rawContent
      ? { ...turn, rawContent: undefined }
      : turn;
    const payload = JSON.stringify({ type: 'conversation_update', conversationId, turn: sanitizedTurn });
    for (const client of wsClients) {
      try { client.send(payload); } catch { wsClients.delete(client); }
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
      try { client.send(payload); } catch { wsClients.delete(client); }
    }
  } catch (error) {
    logger.error('Failed to broadcast session action', error);
  }
}

// ── Route registration ─────────────────────────────────────────────

export async function registerDashboardRoutes(
  server: FastifyInstance,
  authMiddleware: (req: any, reply: any) => Promise<void>,
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
    }
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
      const period = (['day', 'week', 'month'].includes(rawPeriod || '') ? rawPeriod : 'day') as 'day' | 'week' | 'month';
      const { startDate, endDate } = getDateRange(period);

      try {
        const events = await store.readRange(startDate, endDate);
        const dayMap = aggregateUserStats(events, userId);
        const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

        const totals = days.reduce((acc, d) => {
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
        }, {
          sessionsCreated: 0, turnsUsed: 0, prsCreated: 0, prsMerged: 0,
          commitsCreated: 0, linesAdded: 0, linesDeleted: 0,
          mergeLinesAdded: 0, mergeLinesDeleted: 0,
          workflowCounts: {} as Record<string, number>,
        });

        reply.send({ userId, period, days, totals } satisfies UserStats);
      } catch (error) {
        logger.error('Error computing dashboard stats', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    }
  );

  // All users list (for dashboard navigation)
  server.get(
    '/api/dashboard/users',
    { preHandler: [authMiddleware] },
    async (_request, reply) => {
      const sessions = getAllSessions();
      const users = new Map<string, string>();
      for (const [, session] of sessions.entries()) {
        if (session.ownerId && session.ownerName) {
          users.set(session.ownerId, session.ownerName);
        }
      }
      reply.send({ users: Array.from(users.entries()).map(([id, name]) => ({ id, name })) });
    }
  );

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
        // Return lightweight turn summaries (no rawContent for assistant turns)
        const turns = record.turns.map(t => ({
          id: t.id,
          role: t.role,
          timestamp: t.timestamp,
          userName: t.userName,
          summaryTitle: t.summaryTitle,
          summaryBody: t.summaryBody,
          rawContent: t.role === 'user' ? t.rawContent : undefined,
        }));
        reply.send({
          id: record.id,
          title: record.title,
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
    }
  );

  // ── Action routes ──

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/stop',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { key } = request.params;
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
    }
  );

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/close',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { key } = request.params;
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
    }
  );

  server.post<{ Params: { key: string } }>(
    '/api/dashboard/session/:key/trash',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { key } = request.params;
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
    }
  );

  server.post<{ Params: { key: string }; Body: { message: string } }>(
    '/api/dashboard/session/:key/command',
    { preHandler: [authMiddleware] },
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
      // Verify requesting user owns this session
      const authUser = (request as any).dashboardUser;
      const sessions = _getSessionsFn?.();
      const targetSession = sessions?.get(key);
      if (authUser && targetSession && targetSession.ownerId !== authUser.userId) {
        reply.status(403).send({ error: 'You can only send commands to your own sessions' });
        return;
      }
      try {
        if (_commandHandlerFn) {
          await _commandHandlerFn(key, message);
        }
        reply.send({ ok: true });
      } catch (error) {
        logger.error('Error sending command to session', error);
        reply.status(500).send({ error: 'Internal Server Error' });
      }
    }
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
    }
  );

  // ── WebSocket ──

  try {
    await server.register(await import('@fastify/websocket'));

    const MAX_WS_CLIENTS = 100;

    server.get('/ws/dashboard', { websocket: true, preHandler: [authMiddleware] }, (socket: any) => {
      // Enforce max client cap to prevent DoS
      if (wsClients.size >= MAX_WS_CLIENTS) {
        logger.warn('WebSocket max clients reached, rejecting', { total: wsClients.size });
        socket.close(1013, 'Max clients reached');
        return;
      }
      const client: WsClient = {
        send: (data: string) => socket.send(data),
        close: () => socket.close(),
      };
      wsClients.add(client);
      logger.debug('WebSocket client connected', { total: wsClients.size });

      // Send initial state
      try {
        const board = buildKanbanBoard();
        socket.send(JSON.stringify({ type: 'session_update', board }));
      } catch { /* ignore */ }

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
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0a0e13;
  --surface: #111720;
  --surface2: #1a2030;
  --surface3: #222b3a;
  --border: #2a3444;
  --border-hover: #3d4f68;
  --text: #e2eaf4;
  --text-muted: #7a8fa8;
  --accent: #4d9de0;
  --accent2: #3b82c4;
  --green: #3ecf8e;
  --green2: #2ba870;
  --yellow: #f6c90e;
  --red: #f05252;
  --purple: #a78bfa;
  --orange: #f97316;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  background-image: radial-gradient(circle at 25% 25%, rgba(77,157,224,0.04) 0%, transparent 50%),
                    radial-gradient(circle at 75% 75%, rgba(167,139,250,0.03) 0%, transparent 50%);
}

.app { display: flex; flex-direction: column; min-height: 100vh; }

/* ── Topbar ── */
.topbar {
  background: linear-gradient(180deg, #151d2b 0%, #111720 100%);
  border-bottom: 1px solid var(--border);
  padding: 0 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 52px;
  position: relative;
}
.topbar::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent) 0%, var(--purple) 50%, var(--green) 100%);
  opacity: 0.6;
}
.topbar h1 { font-size: 1.05em; font-weight: 700; letter-spacing: -0.3px; }
.topbar .nav { display: flex; gap: 8px; margin-left: auto; align-items: center; }
.topbar .nav a,
.topbar .nav select {
  background: var(--surface2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 12px;
  text-decoration: none;
  font-size: 0.82em;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.topbar .nav a:hover,
.topbar .nav select:hover { border-color: var(--accent); background: var(--surface3); }
.ws-badge {
  padding: 3px 10px;
  border-radius: 10px;
  font-size: 0.72em;
  font-weight: 600;
  background: var(--surface3);
  border: 1px solid var(--border);
  transition: background 0.3s;
}

/* ── Main ── */
.main { flex: 1; padding: 20px 24px; }

/* ── Period selector ── */
.period-bar { display: flex; gap: 6px; margin-bottom: 18px; }
.period-btn {
  background: var(--surface2);
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 14px;
  cursor: pointer;
  font-size: 0.82em;
  transition: all 0.15s;
}
.period-btn:hover { border-color: var(--border-hover); color: var(--text); }
.period-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }

/* ── Stats grid ── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(155px, 1fr));
  gap: 10px;
  margin-bottom: 20px;
}
.stat-card {
  background: linear-gradient(135deg, var(--surface) 0%, var(--surface2) 100%);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  transition: border-color 0.15s, transform 0.15s;
}
.stat-card:hover { border-color: var(--border-hover); transform: translateY(-1px); }
.stat-card .label { font-size: 0.72em; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px; }
.stat-card .value { font-size: 1.75em; font-weight: 700; margin-top: 3px; }
.stat-card .delta { font-size: 0.78em; color: var(--green); margin-top: 2px; }
.stat-card .delta.negative { color: var(--red); }

/* ── Kanban ── */
.kanban {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
.kanban-col {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  min-height: 180px;
  display: flex;
  flex-direction: column;
}
.kanban-col-header {
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 7px;
  border-radius: 10px 10px 0 0;
}
.kanban-col-header h3 { font-size: 0.82em; font-weight: 700; flex: 1; }
.kanban-col-header .count {
  background: var(--surface2);
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 0.72em;
  font-weight: 600;
}
.kanban-col .cards {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: 1;
}

/* ── Status dots ── */
.working-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  background: var(--green);
  display: inline-block;
  animation: pulse-dot 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
.waiting-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  background: var(--yellow);
  display: inline-block;
  flex-shrink: 0;
}
.idle-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  background: var(--text-muted);
  display: inline-block;
  flex-shrink: 0;
}
.closed-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  background: var(--red);
  display: inline-block;
  flex-shrink: 0;
  opacity: 0.7;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.75); }
}

/* ── Card auras ── */
.card {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 11px 12px;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  position: relative;
}
.card:hover { transform: translateY(-1px); }

/* Legendary aura (<=10 min) */
.aura-legendary {
  border-color: var(--orange) !important;
  animation: aura-legendary-pulse 2s ease-in-out infinite;
}
@keyframes aura-legendary-pulse {
  0%, 100% {
    box-shadow: 0 0 6px 1px rgba(249,115,22,0.5),
                0 0 14px 3px rgba(249,115,22,0.25),
                inset 0 0 8px rgba(249,115,22,0.1);
    border-color: #f97316;
  }
  50% {
    box-shadow: 0 0 12px 3px rgba(249,115,22,0.8),
                0 0 28px 8px rgba(249,115,22,0.35),
                0 0 50px 12px rgba(249,115,22,0.15),
                inset 0 0 16px rgba(249,115,22,0.15);
    border-color: #fdba74;
  }
}

/* Epic aura (<=30 min) */
.aura-epic {
  border-color: var(--purple) !important;
  box-shadow: 0 0 8px 2px rgba(167,139,250,0.45),
              0 0 20px 4px rgba(167,139,250,0.2);
}
.aura-epic:hover {
  box-shadow: 0 0 12px 3px rgba(167,139,250,0.6),
              0 0 28px 6px rgba(167,139,250,0.3);
}

/* Blue aura (<=60 min) */
.aura-blue {
  border-color: var(--accent) !important;
  box-shadow: 0 0 6px 1px rgba(77,157,224,0.4),
              0 0 16px 3px rgba(77,157,224,0.15);
}

/* Green aura (<=4 hours) */
.aura-green {
  border-color: var(--green) !important;
  box-shadow: 0 0 5px 1px rgba(62,207,142,0.3),
              0 0 12px 2px rgba(62,207,142,0.12);
}

/* White aura (<=8 hours) */
.aura-white {
  border-color: rgba(200,210,220,0.4) !important;
  box-shadow: 0 0 4px 1px rgba(200,210,220,0.2);
}

/* ── Card contents ── */
.card .card-title {
  font-weight: 600;
  font-size: 0.88em;
  margin-bottom: 5px;
  line-height: 1.3;
  display: flex;
  align-items: flex-start;
  gap: 4px;
}
.card .card-title-text { flex: 1; }
.card .conv-link { color: var(--accent); text-decoration: none; font-size: 0.85em; flex-shrink: 0; opacity: 0.8; }
.card .conv-link:hover { opacity: 1; }
.card .card-meta {
  font-size: 0.72em;
  color: var(--text-muted);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.card .card-links { font-size: 0.72em; margin-top: 5px; display: flex; gap: 6px; flex-wrap: wrap; }
.card .card-links a { color: var(--accent); text-decoration: none; }
.card .card-links a:hover { text-decoration: underline; }
.card .card-owner { font-size: 0.68em; color: var(--purple); margin-top: 4px; }
.card .card-merge { font-size: 0.68em; color: var(--green); margin-top: 3px; }
.card .card-tokens { font-size: 0.62em; color: var(--text-muted); margin-top: 3px; }
.card .card-tokens .cost { color: var(--green); }

/* ── Task list on card ── */
.card-tasks { margin-top: 6px; border-top: 1px solid var(--border); padding-top: 5px; }
.card-task {
  font-size: 0.7em;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 0;
  line-height: 1.3;
}
.card-task.completed { color: var(--text-muted); text-decoration: line-through; opacity: 0.6; }
.card-task.in_progress { color: var(--text); }
.card-task .task-icon { flex-shrink: 0; }
.spin { display: inline-block; animation: spin 1.5s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.tasks-more { font-size: 0.65em; color: var(--text-muted); margin-top: 2px; }

/* ── Card action buttons ── */
.card-actions { display: flex; gap: 5px; margin-top: 6px; justify-content: flex-end; }
.btn-action {
  background: var(--surface3);
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--text-muted);
  font-size: 0.68em;
  padding: 2px 7px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-action:hover { border-color: var(--border-hover); color: var(--text); }
.btn-action.btn-stop:hover { border-color: var(--red); color: var(--red); }
.btn-action.btn-close:hover { border-color: var(--yellow); color: var(--yellow); }
.btn-action.btn-trash:hover { border-color: var(--red); color: var(--red); }

/* ── Chart ── */
.chart-row { display: flex; gap: 10px; margin-bottom: 20px; }
.chart-container {
  flex: 1;
  background: linear-gradient(135deg, var(--surface) 0%, var(--surface2) 100%);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
}
.chart-container h4 { font-size: 0.82em; color: var(--text-muted); margin-bottom: 10px; }
.bar-chart { display: flex; align-items: flex-end; gap: 3px; height: 110px; }
.bar { background: var(--accent); border-radius: 2px 2px 0 0; min-width: 6px; flex: 1; transition: height 0.3s; position: relative; }
.bar:hover { background: var(--purple); }
.bar .bar-tooltip {
  display: none;
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 3px 7px;
  border-radius: 4px;
  font-size: 0.68em;
  white-space: nowrap;
  z-index: 10;
}
.bar:hover .bar-tooltip { display: block; }
.bar-labels { display: flex; gap: 3px; margin-top: 3px; }
.bar-labels span { flex: 1; text-align: center; font-size: 0.58em; color: var(--text-muted); }

/* ── Slide panel ── */
.slide-panel {
  position: fixed;
  top: 0; right: -500px;
  width: 500px;
  height: 100vh;
  background: var(--surface);
  border-left: 1px solid var(--border);
  z-index: 100;
  transition: right 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.slide-panel.open { right: 0; }
.slide-panel-overlay {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  background: rgba(0,0,0,0.55);
  z-index: 99;
  display: none;
  backdrop-filter: blur(2px);
}
.slide-panel-overlay.open { display: block; }
.panel-header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 10px;
  background: linear-gradient(180deg, var(--surface2) 0%, var(--surface) 100%);
}
.panel-header h3 {
  flex: 1;
  font-size: 0.92em;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.1em;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.15s;
}
.panel-close:hover { color: var(--text); background: var(--surface3); }
.panel-meta {
  padding: 10px 18px;
  border-bottom: 1px solid var(--border);
  font-size: 0.78em;
  color: var(--text-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.panel-meta .meta-item { display: flex; align-items: center; gap: 3px; }
.panel-meta .meta-label { color: var(--text-muted); }
.panel-meta .meta-value { color: var(--text); font-weight: 500; }
.panel-links {
  padding: 7px 18px;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.panel-links a {
  font-size: 0.78em;
  color: var(--accent);
  text-decoration: none;
  background: var(--surface2);
  padding: 3px 9px;
  border-radius: 4px;
  border: 1px solid var(--border);
  transition: border-color 0.15s;
}
.panel-links a:hover { text-decoration: none; border-color: var(--accent); }
.panel-tokens {
  padding: 8px 18px;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.token-badge {
  font-size: 0.73em;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--surface2);
  border: 1px solid var(--border);
}
.token-badge .tok-label { color: var(--text-muted); }
.token-badge .tok-value { color: var(--accent); font-weight: 600; }
.token-badge .tok-cost { color: var(--green); }
.panel-turns { flex: 1; overflow-y: auto; padding: 10px 18px; scroll-behavior: smooth; }
.turn { margin-bottom: 10px; padding: 9px 11px; border-radius: 6px; }
.turn.user { background: var(--surface2); border-left: 3px solid var(--accent); }
.turn.assistant { background: transparent; border-left: 3px solid var(--purple); }
.turn-header {
  font-size: 0.72em;
  color: var(--text-muted);
  margin-bottom: 3px;
  display: flex;
  justify-content: space-between;
}
.turn-content { font-size: 0.83em; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.turn-summary-title { font-weight: 600; font-size: 0.83em; margin-bottom: 2px; }
.turn-summary-body { font-size: 0.78em; color: var(--text-muted); line-height: 1.45; }

/* ── Command input ── */
.panel-command {
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 8px;
  background: var(--surface2);
}
.panel-command input {
  flex: 1;
  background: var(--surface3);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 0.85em;
  padding: 7px 11px;
  outline: none;
  transition: border-color 0.15s;
}
.panel-command input:focus { border-color: var(--accent); }
.panel-command input::placeholder { color: var(--text-muted); }
.btn-send {
  background: var(--accent);
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 0.82em;
  font-weight: 600;
  padding: 7px 14px;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}
.btn-send:hover { background: var(--accent2); }
.btn-send:disabled { background: var(--surface3); color: var(--text-muted); cursor: default; }

/* ── Closed column extras ── */
.show-older-btn {
  background: var(--surface3);
  border: 1px dashed var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 0.75em;
  padding: 6px 12px;
  cursor: pointer;
  margin: 4px 8px 8px;
  width: calc(100% - 16px);
  transition: all 0.15s;
  text-align: center;
}
.show-older-btn:hover { border-color: var(--border-hover); color: var(--text); }

/* ── Responsive ── */
@media (max-width: 1100px) {
  .kanban { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 680px) {
  .kanban { grid-template-columns: 1fr; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .chart-row { flex-direction: column; }
  .slide-panel { width: 100vw; right: -100vw; }
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
      <a href="/conversations">&#x1F4DD; Conversations</a>
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
      <div class="stat-card"><div class="label">&#xCEE4;&#xBC0B;</div><div class="value" id="stat-commits">-</div></div>
      <div class="stat-card"><div class="label">&#xBA38;&#xC9C0; &#xCF54;&#xB4DC; +/-</div><div class="value" id="stat-merge-lines">-</div></div>
      <div class="stat-card"><div class="label">&#xD1A0;&#xD070; &#xC0AC;&#xC6A9;</div><div class="value" id="stat-tokens">-</div></div>
      <div class="stat-card"><div class="label">&#xBE44;&#xC6A9; (USD)</div><div class="value" id="stat-cost">-</div></div>
      <div class="stat-card" style="grid-column:span 2"><div class="label">&#xC6CC;&#xD06C;&#xD50C;&#xB85C;&#xC6B0;</div><div class="value" id="stat-workflows" style="font-size:0.85em">-</div></div>
    </div>

    <div class="chart-row" id="chart-row"></div>

    <h2 style="font-size:0.95em;margin-bottom:12px;color:var(--text-muted)">&#x1F4CB; &#xC138;&#xC158; &#xBCF4;&#xB4DC;</h2>
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
          <h3>&#xC885;&#xB8CC;</h3>
          <span class="count" id="count-closed">0</span>
        </div>
        <div class="cards" id="cards-closed"></div>
      </div>
    </div>
  </div>

  <!-- Slide Panel for Session Detail -->
  <div class="slide-panel-overlay" id="panel-overlay" onclick="closePanel()"></div>
  <div class="slide-panel" id="slide-panel">
    <div class="panel-header">
      <h3 id="panel-title">Session Detail</h3>
      <button class="panel-close" onclick="closePanel()">&#x2715;</button>
    </div>
    <div class="panel-meta" id="panel-meta"></div>
    <div class="panel-links" id="panel-links"></div>
    <div class="panel-tokens" id="panel-tokens"></div>
    <div class="panel-turns" id="panel-turns">
      <p style="color:var(--text-muted);text-align:center;margin-top:40px">Click a session card to view details</p>
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

// ── Utility ──
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
function escJs(s) {
  return esc(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
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
  for (const col of ['working', 'waiting', 'idle']) {
    const container = document.getElementById('cards-' + col);
    const countEl = document.getElementById('count-' + col);
    const sessions = (board[col] || []);
    countEl.textContent = sessions.length;
    container.innerHTML = sessions.map(function(s) { return renderCard(s, col); }).join('');
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
  const cls = 'card' + (aura ? ' ' + aura : '');

  // Links
  const links = [];
  if (s.issueUrl) {
    links.push('<a href="' + esc(s.issueUrl) + '" target="_blank" onclick="event.stopPropagation()">&#x1F4CB; ' + esc(s.issueLabel || 'Issue') + '</a>');
  }
  if (s.prUrl) {
    links.push('<a href="' + esc(s.prUrl) + '" target="_blank" onclick="event.stopPropagation()">&#x1F500; ' + esc(s.prLabel || 'PR') + (s.prStatus ? ' (' + esc(s.prStatus) + ')' : '') + '</a>');
  }
  const linksHtml = links.length ? '<div class="card-links">' + links.join('') + '</div>' : '';

  // Conversation link
  const convLink = s.conversationId
    ? ' <a class="conv-link" href="/conversations/' + esc(s.conversationId) + '" target="_blank" onclick="event.stopPropagation()" title="View conversation">&#x1F4DD;</a>'
    : '';

  // Merge stats
  const mergeHtml = s.mergeStats
    ? '<div class="card-merge">+' + s.mergeStats.totalLinesAdded + ' / -' + s.mergeStats.totalLinesDeleted + '</div>'
    : '';

  // Token info
  const tokenHtml = s.tokenUsage
    ? '<div class="card-tokens">' + formatTokens(s.tokenUsage.totalInputTokens + s.tokenUsage.totalOutputTokens) + ' tok &middot; <span class="cost">$' + s.tokenUsage.totalCostUsd.toFixed(2) + '</span></div>'
    : '';

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
      return '<div class="card-task ' + cls2 + '"><span class="task-icon">' + icon + '</span>' + esc(t.content.slice(0, 50)) + '</div>';
    }).join('');
    tasksHtml = '<div class="card-tasks">' + taskItems + (extra > 0 ? '<div class="tasks-more">+' + extra + ' more</div>' : '') + '</div>';
  }

  // Action buttons
  let actionBtn = '';
  if (col === 'working') {
    actionBtn = '<button class="btn-action btn-stop" onclick="event.stopPropagation();doAction(\'' + escJs(s.key) + '\',\'stop\')">&#x23F9; Stop</button>';
  } else if (col === 'waiting' || col === 'idle') {
    actionBtn = '<button class="btn-action btn-close" onclick="event.stopPropagation();doAction(\'' + escJs(s.key) + '\',\'close\')">&#x274C; Close</button>';
  } else if (col === 'closed') {
    actionBtn = '<button class="btn-action btn-trash" onclick="event.stopPropagation();doAction(\'' + escJs(s.key) + '\',\'trash\')">&#x1F5D1; Trash</button>';
  }
  const actionsHtml = '<div class="card-actions">' + actionBtn + '</div>';

  const modelShort = esc(s.model).replace(/^claude-/, '').replace(/-\\d{8}$/, '');

  return '<div class="' + cls + '" onclick="openPanel(\'' + escJs(s.key) + '\')">'
    + '<div class="card-title"><span class="card-title-text">' + esc(s.title) + '</span>' + convLink + '</div>'
    + '<div class="card-meta"><span>' + esc(s.workflow) + '</span><span>' + modelShort + '</span><span>' + timeAgo(s.lastActivity) + '</span></div>'
    + linksHtml
    + (s.issueTitle ? '<div style="font-size:0.7em;color:var(--text-muted);margin-top:3px">' + esc(s.issueTitle).slice(0, 60) + '</div>' : '')
    + (s.prTitle ? '<div style="font-size:0.7em;color:var(--text-muted);margin-top:2px">' + esc(s.prTitle).slice(0, 60) + '</div>' : '')
    + '<div class="card-owner">' + esc(s.ownerName) + '</div>'
    + tokenHtml
    + mergeHtml
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

// ── Action handler ──
async function doAction(key, action) {
  try {
    const res = await fetch('/api/dashboard/session/' + encodeURIComponent(key) + '/' + action, { method: 'POST' });
    if (!res.ok) console.error('Action failed', action, key);
    else loadSessions();
  } catch (e) { console.error('Action error', e); }
}

// ── Stats ──
async function loadStats() {
  if (!currentUserId) {
    document.getElementById('stats-grid').style.display = 'none';
    document.getElementById('chart-row').innerHTML = '';
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
    document.getElementById('stat-commits').textContent = data.totals.commitsCreated;
    document.getElementById('stat-merge-lines').textContent = '+' + data.totals.mergeLinesAdded + ' / -' + data.totals.mergeLinesDeleted;
    // Workflow counts
    const wfCounts = data.totals.workflowCounts || {};
    const wfEntries = Object.entries(wfCounts).sort(function(a, b) { return b[1] - a[1]; });
    document.getElementById('stat-workflows').innerHTML = wfEntries.length
      ? wfEntries.map(function(e) { return '<span style="display:inline-block;margin-right:8px;font-size:0.85em">' + esc(e[0]) + ': <b>' + e[1] + '</b></span>'; }).join('')
      : '<span style="color:var(--text-muted)">-</span>';
    updateTokenStats();
    renderCharts(data.days);
  } catch (e) { console.error('Failed to load stats', e); }
}

function renderCharts(days) {
  const container = document.getElementById('chart-row');
  if (!days.length) {
    container.innerHTML = '<p style="color:var(--text-muted)">No data for this period.</p>';
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
      } else if (msg.type === 'task_update') {
        // Update cached session tasks and re-render
        if (_sessionCache[msg.sessionKey]) {
          _sessionCache[msg.sessionKey].tasks = msg.tasks;
        }
        loadSessions();
      } else if (msg.type === 'conversation_update') {
        // If panel is open for this conversation, append the turn
        if (panelOpen && panelConvId === msg.conversationId && msg.turn) {
          appendTurnToPanel(msg.turn);
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
  if (s.conversationId) linkHtml.push('<a href="/conversations/' + esc(s.conversationId) + '" target="_blank">&#x1F4DD; Full Conversation</a>');
  linksEl.innerHTML = linkHtml.join('') || '<span style="font-size:0.78em;color:var(--text-muted)">No links</span>';

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
    tokensEl.innerHTML = '<span style="font-size:0.78em;color:var(--text-muted)">No token data</span>';
  }

  // Conversation turns
  const turnsEl = document.getElementById('panel-turns');
  if (s.conversationId) {
    turnsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px">Loading...</p>';
    fetch('/api/dashboard/session/' + s.conversationId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.turns || data.turns.length === 0) {
          turnsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px">No conversation turns</p>';
          return;
        }
        turnsEl.innerHTML = data.turns.map(renderTurn).join('');
        turnsEl.scrollTop = turnsEl.scrollHeight;
      })
      .catch(function() {
        turnsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px">Failed to load conversation</p>';
      });
  } else {
    turnsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px">No conversation recorded</p>';
  }

  // Command input — show for non-closed sessions
  const cmdEl = document.getElementById('panel-command');
  cmdEl.style.display = (s.terminated || s.sessionState === 'SLEEPING') ? 'none' : '';

  document.getElementById('slide-panel').classList.add('open');
  document.getElementById('panel-overlay').classList.add('open');
  panelOpen = true;
}

function renderTurn(t) {
  const time = new Date(t.timestamp).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (t.role === 'user') {
    return '<div class="turn user"><div class="turn-header"><span>&#x1F464; ' + esc(t.userName || 'User') + '</span><span>' + time + '</span></div>'
      + '<div class="turn-content">' + esc((t.rawContent || '').slice(0, 500)) + ((t.rawContent && t.rawContent.length > 500) ? '...' : '') + '</div></div>';
  } else {
    const title = t.summaryTitle ? '<div class="turn-summary-title">' + esc(t.summaryTitle) + '</div>' : '';
    const body = t.summaryBody
      ? '<div class="turn-summary-body">' + esc(t.summaryBody) + '</div>'
      : '<div class="turn-summary-body" style="color:var(--text-muted);font-style:italic">Generating summary...</div>';
    return '<div class="turn assistant"><div class="turn-header"><span>&#x1F916; Assistant</span><span>' + time + '</span></div>' + title + body + '</div>';
  }
}

function appendTurnToPanel(turn) {
  const turnsEl = document.getElementById('panel-turns');
  const wasAtBottom = turnsEl.scrollHeight - turnsEl.scrollTop <= turnsEl.clientHeight + 40;
  turnsEl.insertAdjacentHTML('beforeend', renderTurn(turn));
  if (wasAtBottom) turnsEl.scrollTop = turnsEl.scrollHeight;
}

function closePanel() {
  document.getElementById('slide-panel').classList.remove('open');
  document.getElementById('panel-overlay').classList.remove('open');
  panelOpen = false;
  panelSessionKey = null;
  panelConvId = null;
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && panelOpen) closePanel();
});

// ── Send command ──
async function sendCommand() {
  const input = document.getElementById('cmd-input');
  const btn = document.getElementById('cmd-send');
  const msg = input.value.trim();
  if (!msg || !panelSessionKey) return;

  btn.disabled = true;
  btn.textContent = 'Sending...';
  input.disabled = true;

  try {
    const res = await fetch('/api/dashboard/session/' + encodeURIComponent(panelSessionKey) + '/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    if (res.ok) {
      input.value = '';
      // Refresh turns after short delay
      setTimeout(function() {
        const s = _sessionCache[panelSessionKey];
        if (s && s.conversationId) {
          fetch('/api/dashboard/session/' + s.conversationId)
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (data.turns) {
                const turnsEl = document.getElementById('panel-turns');
                turnsEl.innerHTML = data.turns.map(renderTurn).join('');
                turnsEl.scrollTop = turnsEl.scrollHeight;
              }
            })
            .catch(function() {});
        }
      }, 800);
    } else {
      console.error('Command failed');
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

// ── Init ──
loadUsers();
loadSessions();
if (currentUserId) loadStats();
else document.getElementById('stats-grid').style.display = 'none';
connectWs();
setInterval(loadSessions, 30000);
</script>
</body>
</html>`;
}
