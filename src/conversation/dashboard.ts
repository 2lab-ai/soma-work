/**
 * Dashboard module — personal Kanban board + statistics.
 * Extends the existing Fastify conversation web server.
 *
 * Routes:
 *   GET /dashboard              → Dashboard HTML (all users overview)
 *   GET /dashboard/:userId      → Dashboard HTML (specific user)
 *   GET /api/dashboard/sessions → All active sessions as Kanban data (JSON)
 *   GET /api/dashboard/stats    → User statistics (JSON)
 *   WS  /ws/dashboard           → Real-time session state updates (WebSocket)
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
}

export interface KanbanBoard {
  working: KanbanSession[];
  waiting: KanbanSession[];
  idle: KanbanSession[];
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

// ── Kanban transformation ──────────────────────────────────────────

function sessionToKanban(key: string, s: any): KanbanSession {
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
  };
}

function buildKanbanBoard(userId?: string): KanbanBoard {
  const sessions = getAllSessions();
  const board: KanbanBoard = { working: [], waiting: [], idle: [] };

  for (const [key, session] of sessions.entries()) {
    if (!session.sessionId) continue;
    if (userId && session.ownerId !== userId) continue;

    const kanban = sessionToKanban(key, session);
    switch (kanban.activityState) {
      case 'working': board.working.push(kanban); break;
      case 'waiting': board.waiting.push(kanban); break;
      default: board.idle.push(kanban); break;
    }
  }

  // Sort each column by lastActivity desc
  const byActivity = (a: KanbanSession, b: KanbanSession) =>
    new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  board.working.sort(byActivity);
  board.waiting.sort(byActivity);
  board.idle.sort(byActivity);

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
      });
    }
    const day = dayMap.get(dateStr)!;

    switch (ev.eventType) {
      case 'session_created': day.sessionsCreated++; break;
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

        const totals = days.reduce((acc, d) => ({
          sessionsCreated: acc.sessionsCreated + d.sessionsCreated,
          turnsUsed: acc.turnsUsed + d.turnsUsed,
          prsCreated: acc.prsCreated + d.prsCreated,
          prsMerged: acc.prsMerged + d.prsMerged,
          commitsCreated: acc.commitsCreated + d.commitsCreated,
          linesAdded: acc.linesAdded + d.linesAdded,
          linesDeleted: acc.linesDeleted + d.linesDeleted,
          mergeLinesAdded: acc.mergeLinesAdded + d.mergeLinesAdded,
          mergeLinesDeleted: acc.mergeLinesDeleted + d.mergeLinesDeleted,
        }), {
          sessionsCreated: 0, turnsUsed: 0, prsCreated: 0, prsMerged: 0,
          commitsCreated: 0, linesAdded: 0, linesDeleted: 0,
          mergeLinesAdded: 0, mergeLinesDeleted: 0,
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

    server.get('/ws/dashboard', { websocket: true }, (socket: any) => {
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
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>soma-work Dashboard</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
  --border: #30363d; --text: #e6edf3; --text-muted: #8b949e;
  --accent: #58a6ff; --green: #3fb950; --yellow: #d29922; --red: #f85149;
  --purple: #bc8cff;
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }
.app { display: flex; flex-direction: column; min-height: 100vh; }
.topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 16px; }
.topbar h1 { font-size: 1.1em; font-weight: 600; }
.topbar .nav { display: flex; gap: 8px; margin-left: auto; }
.topbar .nav a, .topbar .nav select { background: var(--surface2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 12px; text-decoration: none; font-size: 0.85em; cursor: pointer; }
.topbar .nav a:hover, .topbar .nav select:hover { border-color: var(--accent); }
.topbar .badge { background: var(--green); color: #000; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; font-weight: 600; }
.main { flex: 1; padding: 24px; }

/* Period selector */
.period-bar { display: flex; gap: 8px; margin-bottom: 20px; }
.period-btn { background: var(--surface2); color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; padding: 6px 16px; cursor: pointer; font-size: 0.85em; }
.period-btn.active { background: var(--accent); color: #000; border-color: var(--accent); }

/* Stats grid */
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
.stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.stat-card .label { font-size: 0.75em; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
.stat-card .value { font-size: 1.8em; font-weight: 700; margin-top: 4px; }
.stat-card .delta { font-size: 0.8em; color: var(--green); margin-top: 2px; }
.stat-card .delta.negative { color: var(--red); }

/* Kanban */
.kanban { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.kanban-col { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; min-height: 200px; }
.kanban-col-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.kanban-col-header h3 { font-size: 0.85em; font-weight: 600; }
.kanban-col-header .count { background: var(--surface2); padding: 2px 8px; border-radius: 10px; font-size: 0.75em; }
.kanban-col .cards { padding: 8px; display: flex; flex-direction: column; gap: 8px; }

.card { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; cursor: pointer; transition: border-color 0.2s; }
.card:hover { border-color: var(--accent); }
.card .card-title { font-weight: 600; font-size: 0.9em; margin-bottom: 4px; }
.card .card-meta { font-size: 0.75em; color: var(--text-muted); display: flex; gap: 8px; flex-wrap: wrap; }
.card .card-links { font-size: 0.75em; margin-top: 6px; display: flex; gap: 8px; }
.card .card-links a { color: var(--accent); text-decoration: none; }
.card .card-links a:hover { text-decoration: underline; }
.card .card-owner { font-size: 0.7em; color: var(--purple); margin-top: 4px; }
.card .card-merge { font-size: 0.7em; color: var(--green); margin-top: 4px; }

.working-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block; animation: pulse 1.5s infinite; }
.waiting-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--yellow); display: inline-block; }
.idle-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); display: inline-block; }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

/* Chart */
.chart-row { display: flex; gap: 12px; margin-bottom: 24px; }
.chart-container { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.chart-container h4 { font-size: 0.85em; color: var(--text-muted); margin-bottom: 12px; }
.bar-chart { display: flex; align-items: flex-end; gap: 4px; height: 120px; }
.bar { background: var(--accent); border-radius: 2px 2px 0 0; min-width: 8px; flex: 1; transition: height 0.3s; position: relative; }
.bar:hover { background: var(--purple); }
.bar .bar-tooltip { display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--surface); border: 1px solid var(--border); padding: 4px 8px; border-radius: 4px; font-size: 0.7em; white-space: nowrap; }
.bar:hover .bar-tooltip { display: block; }
.bar-labels { display: flex; gap: 4px; margin-top: 4px; }
.bar-labels span { flex: 1; text-align: center; font-size: 0.6em; color: var(--text-muted); }

/* Slide panel */
.slide-panel { position: fixed; top: 0; right: -480px; width: 480px; height: 100vh; background: var(--surface); border-left: 1px solid var(--border); z-index: 100; transition: right 0.3s ease; display: flex; flex-direction: column; overflow: hidden; }
.slide-panel.open { right: 0; }
.slide-panel-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 99; display: none; }
.slide-panel-overlay.open { display: block; }
.panel-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
.panel-header h3 { flex: 1; font-size: 0.95em; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-close { background: none; border: none; color: var(--text-muted); font-size: 1.2em; cursor: pointer; padding: 4px 8px; }
.panel-close:hover { color: var(--text); }
.panel-meta { padding: 12px 20px; border-bottom: 1px solid var(--border); font-size: 0.8em; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 12px; }
.panel-meta .meta-item { display: flex; align-items: center; gap: 4px; }
.panel-meta .meta-label { color: var(--text-muted); }
.panel-meta .meta-value { color: var(--text); font-weight: 500; }
.panel-links { padding: 8px 20px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; flex-wrap: wrap; }
.panel-links a { font-size: 0.8em; color: var(--accent); text-decoration: none; background: var(--surface2); padding: 4px 10px; border-radius: 4px; }
.panel-links a:hover { text-decoration: underline; }
.panel-tokens { padding: 10px 20px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; }
.token-badge { font-size: 0.75em; padding: 3px 8px; border-radius: 4px; background: var(--surface2); border: 1px solid var(--border); }
.token-badge .tok-label { color: var(--text-muted); }
.token-badge .tok-value { color: var(--accent); font-weight: 600; }
.token-badge .tok-cost { color: var(--green); }
.panel-turns { flex: 1; overflow-y: auto; padding: 12px 20px; }
.turn { margin-bottom: 12px; padding: 10px; border-radius: 6px; }
.turn.user { background: var(--surface2); border-left: 3px solid var(--accent); }
.turn.assistant { background: transparent; border-left: 3px solid var(--purple); }
.turn-header { font-size: 0.75em; color: var(--text-muted); margin-bottom: 4px; display: flex; justify-content: space-between; }
.turn-content { font-size: 0.85em; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.turn-summary-title { font-weight: 600; font-size: 0.85em; margin-bottom: 2px; }
.turn-summary-body { font-size: 0.8em; color: var(--text-muted); line-height: 1.4; }

.card .card-tokens { font-size: 0.65em; color: var(--text-muted); margin-top: 3px; }
.card .card-tokens .cost { color: var(--green); }

/* Responsive */
@media (max-width: 768px) {
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
    <h1>⚡ soma-work</h1>
    <span class="badge" id="ws-status">Connecting...</span>
    <div class="nav">
      <select id="user-select" onchange="selectUser(this.value)">
        <option value="">All Users</option>
      </select>
      <a href="/conversations">📝 Conversations</a>
    </div>
  </div>

  <div class="main">
    <div class="period-bar">
      <button class="period-btn active" data-period="day" onclick="setPeriod('day')">오늘</button>
      <button class="period-btn" data-period="week" onclick="setPeriod('week')">지난 7일</button>
      <button class="period-btn" data-period="month" onclick="setPeriod('month')">지난 30일</button>
    </div>

    <div class="stats-grid" id="stats-grid">
      <div class="stat-card"><div class="label">세션</div><div class="value" id="stat-sessions">-</div></div>
      <div class="stat-card"><div class="label">턴 사용</div><div class="value" id="stat-turns">-</div></div>
      <div class="stat-card"><div class="label">PR 생성</div><div class="value" id="stat-prs">-</div></div>
      <div class="stat-card"><div class="label">PR 머지</div><div class="value" id="stat-merged">-</div></div>
      <div class="stat-card"><div class="label">커밋</div><div class="value" id="stat-commits">-</div></div>
      <div class="stat-card"><div class="label">머지 코드 +/-</div><div class="value" id="stat-merge-lines">-</div></div>
      <div class="stat-card"><div class="label">토큰 사용</div><div class="value" id="stat-tokens">-</div></div>
      <div class="stat-card"><div class="label">비용 (USD)</div><div class="value" id="stat-cost">-</div></div>
    </div>

    <div class="chart-row" id="chart-row"></div>

    <h2 style="font-size:1em; margin-bottom:12px;">📋 세션 보드</h2>
    <div class="kanban" id="kanban">
      <div class="kanban-col" id="col-working">
        <div class="kanban-col-header"><span class="working-dot"></span><h3>Working</h3><span class="count" id="count-working">0</span></div>
        <div class="cards" id="cards-working"></div>
      </div>
      <div class="kanban-col" id="col-waiting">
        <div class="kanban-col-header"><span class="waiting-dot"></span><h3>Waiting</h3><span class="count" id="count-waiting">0</span></div>
        <div class="cards" id="cards-waiting"></div>
      </div>
      <div class="kanban-col" id="col-idle">
        <div class="kanban-col-header"><span class="idle-dot"></span><h3>Completed / Idle</h3><span class="count" id="count-idle">0</span></div>
        <div class="cards" id="cards-idle"></div>
      </div>
    </div>
  </div>

  <!-- Slide Panel for Session Detail -->
  <div class="slide-panel-overlay" id="panel-overlay" onclick="closePanel()"></div>
  <div class="slide-panel" id="slide-panel">
    <div class="panel-header">
      <h3 id="panel-title">Session Detail</h3>
      <button class="panel-close" onclick="closePanel()">✕</button>
    </div>
    <div class="panel-meta" id="panel-meta"></div>
    <div class="panel-links" id="panel-links"></div>
    <div class="panel-tokens" id="panel-tokens"></div>
    <div class="panel-turns" id="panel-turns">
      <p style="color:var(--text-muted);text-align:center;margin-top:40px">Click a session card to view details</p>
    </div>
  </div>
</div>

<script>
const INIT_USER = ${userId ? JSON.stringify(userId) : 'null'};
let currentUserId = INIT_USER || '';
let currentPeriod = 'day';
let ws = null;

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
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === period));
  loadStats();
}

// ── Sessions (Kanban) ──
function renderBoard(board) {
  for (const col of ['working', 'waiting', 'idle']) {
    const container = document.getElementById('cards-' + col);
    const countEl = document.getElementById('count-' + col);
    const sessions = board[col] || [];
    countEl.textContent = sessions.length;
    container.innerHTML = sessions.map(s => renderCard(s)).join('');
  }
}

// Store session data for panel access
const _sessionCache = {};

function renderCard(s) {
  _sessionCache[s.key] = s;
  const links = [];
  if (s.issueUrl) links.push('<a href="' + esc(s.issueUrl) + '" target="_blank" onclick="event.stopPropagation()">📋 ' + esc(s.issueLabel || 'Issue') + '</a>');
  if (s.prUrl) links.push('<a href="' + esc(s.prUrl) + '" target="_blank" onclick="event.stopPropagation()">🔀 ' + esc(s.prLabel || 'PR') + (s.prStatus ? ' (' + esc(s.prStatus) + ')' : '') + '</a>');
  const mergeInfo = s.mergeStats ? '<div class="card-merge">+' + s.mergeStats.totalLinesAdded + ' / -' + s.mergeStats.totalLinesDeleted + '</div>' : '';
  const tokenInfo = s.tokenUsage ? '<div class="card-tokens">' + formatTokens(s.tokenUsage.totalInputTokens + s.tokenUsage.totalOutputTokens) + ' tok · <span class="cost">$' + s.tokenUsage.totalCostUsd.toFixed(2) + '</span></div>' : '';
  const convLink = s.conversationId ? ' <a href="/conversations/' + esc(s.conversationId) + '" target="_blank" onclick="event.stopPropagation()">📝</a>' : '';
  return '<div class="card" onclick="openPanel(\\'' + esc(s.key) + '\\')">' +
    '<div class="card-title">' + esc(s.title) + convLink + '</div>' +
    '<div class="card-meta"><span>' + esc(s.workflow) + '</span><span>' + esc(s.model).replace(/^claude-/, '').replace(/-\\d{8}$/, '') + '</span><span>' + timeAgo(s.lastActivity) + '</span></div>' +
    (links.length ? '<div class="card-links">' + links.join('') + '</div>' : '') +
    (s.issueTitle ? '<div style="font-size:0.75em;color:var(--text-muted);margin-top:4px">' + esc(s.issueTitle).slice(0,60) + '</div>' : '') +
    (s.prTitle ? '<div style="font-size:0.75em;color:var(--text-muted);margin-top:2px">' + esc(s.prTitle).slice(0,60) + '</div>' : '') +
    '<div class="card-owner">' + esc(s.ownerName) + '</div>' +
    tokenInfo +
    mergeInfo +
    '</div>';
}

async function loadSessions() {
  try {
    const url = '/api/dashboard/sessions' + (currentUserId ? '?userId=' + currentUserId : '');
    const res = await fetch(url);
    const data = await res.json();
    renderBoard(data.board);
  } catch (e) { console.error('Failed to load sessions', e); }
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

    // Compute token totals from active sessions for this user
    updateTokenStats();

    // Render charts
    renderCharts(data.days);
  } catch (e) { console.error('Failed to load stats', e); }
}

function renderCharts(days) {
  const container = document.getElementById('chart-row');
  if (!days.length) { container.innerHTML = '<p style="color:var(--text-muted)">No data for this period.</p>'; return; }

  container.innerHTML = renderBarChart('세션', days, d => d.sessionsCreated, 'var(--accent)')
    + renderBarChart('코드 변경 (머지)', days, d => d.mergeLinesAdded + d.mergeLinesDeleted, 'var(--green)');
}

function renderBarChart(title, days, valueFn, color) {
  const values = days.map(valueFn);
  const max = Math.max(...values, 1);
  const bars = days.map((d, i) => {
    const h = Math.max(2, (values[i] / max) * 100);
    const label = d.date.slice(5); // MM-DD
    return '<div class="bar" style="height:' + h + '%;background:' + color + '"><div class="bar-tooltip">' + label + ': ' + values[i] + '</div></div>';
  }).join('');
  const labels = days.map(d => '<span>' + d.date.slice(8) + '</span>').join('');
  return '<div class="chart-container"><h4>' + title + '</h4><div class="bar-chart">' + bars + '</div><div class="bar-labels">' + labels + '</div></div>';
}

// ── WebSocket ──
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws/dashboard');
  const statusEl = document.getElementById('ws-status');

  ws.onopen = () => { statusEl.textContent = 'Live'; statusEl.style.background = 'var(--green)'; };
  ws.onclose = () => {
    statusEl.textContent = 'Reconnecting...'; statusEl.style.background = 'var(--yellow)';
    setTimeout(connectWs, 3000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'session_update') {
        // Filter by current user if set
        if (currentUserId) {
          msg.board.working = msg.board.working.filter(s => s.ownerId === currentUserId);
          msg.board.waiting = msg.board.waiting.filter(s => s.ownerId === currentUserId);
          msg.board.idle = msg.board.idle.filter(s => s.ownerId === currentUserId);
        }
        renderBoard(msg.board);
      }
    } catch { /* ignore */ }
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

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ── Slide Panel ──
let panelOpen = false;
function openPanel(sessionKey) {
  const s = _sessionCache[sessionKey];
  if (!s) return;

  // Header
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
  if (s.issueUrl) linkHtml.push('<a href="' + esc(s.issueUrl) + '" target="_blank">📋 ' + esc(s.issueLabel || 'Issue') + (s.issueTitle ? ' — ' + esc(s.issueTitle).slice(0,50) : '') + '</a>');
  if (s.prUrl) linkHtml.push('<a href="' + esc(s.prUrl) + '" target="_blank">🔀 ' + esc(s.prLabel || 'PR') + (s.prTitle ? ' — ' + esc(s.prTitle).slice(0,50) : '') + '</a>');
  if (s.conversationId) linkHtml.push('<a href="/conversations/' + esc(s.conversationId) + '" target="_blank">📝 Full Conversation</a>');
  linksEl.innerHTML = linkHtml.join('') || '<span style="font-size:0.8em;color:var(--text-muted)">No links</span>';

  // Tokens
  const tokensEl = document.getElementById('panel-tokens');
  if (s.tokenUsage) {
    tokensEl.innerHTML = [
      '<span class="token-badge"><span class="tok-label">Input:</span> <span class="tok-value">' + formatTokens(s.tokenUsage.totalInputTokens) + '</span></span>',
      '<span class="token-badge"><span class="tok-label">Output:</span> <span class="tok-value">' + formatTokens(s.tokenUsage.totalOutputTokens) + '</span></span>',
      '<span class="token-badge"><span class="tok-label">Cost:</span> <span class="tok-cost">$' + s.tokenUsage.totalCostUsd.toFixed(3) + '</span></span>',
      '<span class="token-badge"><span class="tok-label">Context:</span> <span class="tok-value">' + s.tokenUsage.contextUsagePercent.toFixed(1) + '%</span></span>',
    ].join('');
    if (s.mergeStats) {
      tokensEl.innerHTML += '<span class="token-badge" style="border-color:var(--green)"><span class="tok-label">Merge:</span> <span style="color:var(--green)">+' + s.mergeStats.totalLinesAdded + ' / -' + s.mergeStats.totalLinesDeleted + '</span></span>';
    }
  } else {
    tokensEl.innerHTML = '<span style="font-size:0.8em;color:var(--text-muted)">No token data</span>';
  }

  // Load conversation turns
  const turnsEl = document.getElementById('panel-turns');
  if (s.conversationId) {
    turnsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px">Loading...</p>';
    fetch('/api/dashboard/session/' + s.conversationId)
      .then(r => r.json())
      .then(data => {
        if (!data.turns || data.turns.length === 0) {
          turnsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px">No conversation turns</p>';
          return;
        }
        turnsEl.innerHTML = data.turns.map(t => {
          const time = new Date(t.timestamp).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' });
          if (t.role === 'user') {
            return '<div class="turn user"><div class="turn-header"><span>👤 ' + esc(t.userName || 'User') + '</span><span>' + time + '</span></div><div class="turn-content">' + esc((t.rawContent || '').slice(0, 500)) + (t.rawContent && t.rawContent.length > 500 ? '...' : '') + '</div></div>';
          } else {
            const title = t.summaryTitle ? '<div class="turn-summary-title">' + esc(t.summaryTitle) + '</div>' : '';
            const body = t.summaryBody ? '<div class="turn-summary-body">' + esc(t.summaryBody) + '</div>' : '<div class="turn-summary-body" style="color:var(--text-muted);font-style:italic">Generating summary...</div>';
            return '<div class="turn assistant"><div class="turn-header"><span>🤖 Assistant</span><span>' + time + '</span></div>' + title + body + '</div>';
          }
        }).join('');
      })
      .catch(() => {
        turnsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px">Failed to load conversation</p>';
      });
  } else {
    turnsEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;margin-top:40px">No conversation recorded</p>';
  }

  // Open panel
  document.getElementById('slide-panel').classList.add('open');
  document.getElementById('panel-overlay').classList.add('open');
  panelOpen = true;
}

function closePanel() {
  document.getElementById('slide-panel').classList.remove('open');
  document.getElementById('panel-overlay').classList.remove('open');
  panelOpen = false;
}

// Escape key closes panel
document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && panelOpen) closePanel(); });

// ── Helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms/60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms/3600000) + 'h ago';
  return Math.floor(ms/86400000) + 'd ago';
}

// ── Init ──
loadUsers();
loadSessions();
if (currentUserId) loadStats();
else document.getElementById('stats-grid').style.display = 'none';
connectWs();
setInterval(loadSessions, 30000); // Fallback polling
</script>
</body>
</html>`;
}
