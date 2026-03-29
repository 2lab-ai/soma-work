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

/* Responsive */
@media (max-width: 768px) {
  .kanban { grid-template-columns: 1fr; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .chart-row { flex-direction: column; }
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

function renderCard(s) {
  const links = [];
  if (s.issueUrl) links.push('<a href="' + esc(s.issueUrl) + '" target="_blank">📋 ' + esc(s.issueLabel || 'Issue') + '</a>');
  if (s.prUrl) links.push('<a href="' + esc(s.prUrl) + '" target="_blank">🔀 ' + esc(s.prLabel || 'PR') + (s.prStatus ? ' (' + esc(s.prStatus) + ')' : '') + '</a>');
  const mergeInfo = s.mergeStats ? '<div class="card-merge">+' + s.mergeStats.totalLinesAdded + ' / -' + s.mergeStats.totalLinesDeleted + '</div>' : '';
  const convLink = s.conversationId ? ' <a href="/conversations/' + esc(s.conversationId) + '" target="_blank">📝</a>' : '';
  return '<div class="card">' +
    '<div class="card-title">' + esc(s.title) + convLink + '</div>' +
    '<div class="card-meta"><span>' + esc(s.workflow) + '</span><span>' + esc(s.model).replace(/^claude-/, '').replace(/-\\d{8}$/, '') + '</span><span>' + timeAgo(s.lastActivity) + '</span></div>' +
    (links.length ? '<div class="card-links">' + links.join('') + '</div>' : '') +
    (s.issueTitle ? '<div style="font-size:0.75em;color:var(--text-muted);margin-top:4px">' + esc(s.issueTitle).slice(0,60) + '</div>' : '') +
    (s.prTitle ? '<div style="font-size:0.75em;color:var(--text-muted);margin-top:2px">' + esc(s.prTitle).slice(0,60) + '</div>' : '') +
    '<div class="card-owner">' + esc(s.ownerName) + '</div>' +
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
