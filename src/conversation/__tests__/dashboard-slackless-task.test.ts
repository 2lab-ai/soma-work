/**
 * Slack-less task (MVP-A0 #596) — the board half of T4: a task created with no
 * Slack channel/thread and no SDK session is on the board after a restart,
 * and its card invents no Slack link and borrows nothing from other tasks.
 * Drives the REAL createTask → restart (fresh registry + load) → board path.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));
// `vi.mock` is hoisted — keep the path computation inside the factory.
vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  DATA_DIR: require('path').join(
    process.env.TMPDIR ?? require('os').tmpdir(),
    'soma-work-dashboard-slackless-task-test',
  ),
}));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
// A tiny in-memory archive: the board lists it, a revive loads from it.
const archiveState = vi.hoisted(() => ({ items: [] as Array<Record<string, any>> }));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({
    listRecent: () => archiveState.items,
    exists: () => false,
    archive: () => {},
    load: (sessionKey: string, archivedAt: number) =>
      archiveState.items.find((a) => a.sessionKey === sessionKey && a.archivedAt === archivedAt) ?? null,
  }),
}));

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-dashboard-slackless-task-test');
const AUTH_HEADER = { Authorization: 'Bearer test-token' };

type Card = {
  key: string;
  title?: string;
  channelId?: string;
  threadTs?: string;
  slackThreadUrl?: string;
  activityState?: string;
  threadSessionCount?: number;
  threadTotalActiveMs?: number;
};
type Board = { working: Card[]; waiting: Card[]; idle: Card[]; closed: Card[] };

describe('dashboard — a Slack-less task is on the board (T4)', () => {
  let stopWebServer: () => Promise<void>;
  let injectWebServer: (opts: Record<string, unknown>) => Promise<{ statusCode: number; body: string }>;
  let setDashboardSessionAccessor: (fn: () => Map<string, unknown>) => void;
  let SessionRegistry: typeof import('../../session-registry').SessionRegistry;

  beforeAll(async () => {
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer as typeof injectWebServer;
    const dashboard = await import('../dashboard');
    setDashboardSessionAccessor = dashboard.setDashboardSessionAccessor as typeof setDashboardSessionAccessor;
    SessionRegistry = (await import('../../session-registry')).SessionRegistry;
    await webServer.startWebServer({ listen: false });
    // The first cold import of the web server transforms the whole dashboard (slow on a busy machine).
  }, 240_000);

  afterAll(async () => {
    await stopWebServer?.();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    archiveState.items = [];
  });

  async function board(): Promise<Board> {
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).board as Board;
  }

  it('create (no Slack, no SDK) → restart → the never-run task has a card, with no Slack link', async () => {
    const writer = new SessionRegistry();
    const task = writer.createTask({
      ownerId: 'U1',
      ownerName: 'Alice',
      workingDirectory: '/work/U1/repo',
      title: 'Slack-less task',
    });

    const reader = new SessionRegistry();
    expect(reader.loadSessions()).toBe(1);
    setDashboardSessionAccessor(() => reader.getAllSessions());
    const b = await board();

    const card = b.idle.find((c) => c.key === `task:${task.taskId}`);
    expect(card).toBeDefined();
    expect(card!.title).toBe('Slack-less task');
    expect(card!.activityState).toBe('idle');
    // No Slack binding is invented on the card.
    expect(card!.slackThreadUrl).toBeUndefined();
    expect(card!.threadTs).toBeUndefined();
    expect(card!.channelId).toBe('');
  });

  it('two Slack-less tasks do not share a thread aggregate — each card counts only itself', async () => {
    const reg = new SessionRegistry();
    const a = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    const b2 = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/b', title: 'B' });
    a.activeAccumulatedMs = 1_000;
    b2.activeAccumulatedMs = 2_000;
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const b = await board();

    const cardA = b.idle.find((c) => c.key === `task:${a.taskId}`);
    const cardB = b.idle.find((c) => c.key === `task:${b2.taskId}`);
    expect(cardA?.threadSessionCount).toBe(1);
    expect(cardA?.threadTotalActiveMs).toBe(1_000);
    expect(cardB?.threadSessionCount).toBe(1);
    expect(cardB?.threadTotalActiveMs).toBe(2_000);
  });

  it('#612 R1 / #598 ④c — routes not yet supported on a task refuse with 409; command goes to the task handler (501 unwired); close is allowed', async () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const key = encodeURIComponent(`task:${task.taskId}`);
    const headers = { ...AUTH_HEADER, 'X-Admin-Mode': 'on', 'content-type': 'application/json' };
    const goal = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${key}/goal`,
      headers,
      payload: JSON.stringify({ action: 'add', objective: 'do it' }),
    });
    expect(goal.statusCode).toBe(409);
    expect(JSON.parse(goal.body).error).toBe('not supported on a dashboard task yet');
    const command = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${key}/command`,
      headers,
      payload: JSON.stringify({ message: 'hello' }),
    });
    // #598 ④c — no longer refused: it goes to the task handler, not wired here.
    expect(command.statusCode).toBe(501);
    // No handler is wired in this test: without the guard these answer 501.
    const model = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${key}/model`,
      headers,
      payload: JSON.stringify({ model: 'opus' }),
    });
    expect(model.statusCode).toBe(409);
    const close = await injectWebServer({ method: 'POST', url: `/api/dashboard/session/${key}/close`, headers });
    expect(close.statusCode).not.toBe(409);
  });

  it('#612 R2 — an archived Slack-less card revives under its task key, still Slack-less, and still refuses a turn', async () => {
    const dashboard = await import('../dashboard');
    const reg = new SessionRegistry();
    const taskId = '11111111-2222-4333-8444-555555555555';
    const archivedAt = Date.now() - 60_000;
    // A task that has run (sessionId set) and was closed: the revive reaches the registry restore.
    archiveState.items = [
      {
        archivedAt,
        archiveReason: 'user_close',
        sessionKey: `task:${taskId}`,
        taskId,
        slackless: true,
        sessionId: 'sdk-1',
        ownerId: 'U1',
        ownerName: 'Alice',
        channelId: '',
        title: 'Archived task',
        lastActivity: new Date(archivedAt).toISOString(),
      },
    ];
    setDashboardSessionAccessor(() => reg.getAllSessions());
    dashboard.setDashboardLifecycleHandler({
      star: (k: string, starred: boolean) => reg.setStarred(k, starred),
      revive: (k: string) => reg.reviveSession(k),
      restore: (archived: any) => reg.restoreArchivedSession(archived, '/work/U1/repo'),
    });
    try {
      const b = await board();
      const card = b.closed.find((c) => c.key.includes(`archived_task:${taskId}_`));
      expect(card).toBeDefined();
      const headers = { ...AUTH_HEADER, 'X-Admin-Mode': 'on', 'content-type': 'application/json' };

      const revive = await injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(card!.key)}/revive`,
        headers,
        payload: '{}',
      });
      expect(revive.statusCode).toBe(200);
      const back = reg.getSessionByKey(`task:${taskId}`);
      expect(back?.slackless).toBe(true);
      expect(back?.channelId).toBe('');

      const goal = await injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(`task:${taskId}`)}/goal`,
        headers,
        payload: JSON.stringify({ action: 'add', objective: 'do it' }),
      });
      expect(goal.statusCode).toBe(409);
    } finally {
      dashboard.setDashboardLifecycleHandler(null);
    }
  });

  it('a never-run Slack session is still off the board (the board filter change is for Slack-less tasks only)', async () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'Alice', 'C1', '500.001'); // no SDK turn yet
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const b = await board();
    const all = [...b.working, ...b.waiting, ...b.idle, ...b.closed];
    expect(all.find((c) => c.key === 'work:C1:500.001')).toBeUndefined();
  });

  it('#598 ④c — a Slack-less task’s command goes to the task handler, whose status and body the route returns', async () => {
    const dashboard = await import('../dashboard');
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    const slack = reg.createSession('U1', 'Alice', 'C1', '500.002');
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const taskHandler = vi.fn(async () => ({ status: 202, body: { ok: true } }));
    const slackHandler = vi.fn(async () => {});
    dashboard.setDashboardTaskCommandHandler(taskHandler);
    dashboard.setDashboardCommandHandler(slackHandler);
    const headers = { ...AUTH_HEADER, 'X-Admin-Mode': 'on', 'content-type': 'application/json' };
    try {
      const accepted = await injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(`task:${task.taskId}`)}/command`,
        headers,
        payload: JSON.stringify({ message: 'raise the timeout' }),
      });
      expect(accepted.statusCode).toBe(202);
      expect(JSON.parse(accepted.body)).toEqual({ ok: true });
      expect(taskHandler).toHaveBeenCalledWith(`task:${task.taskId}`, 'raise the timeout', []);
      expect(slackHandler).not.toHaveBeenCalled();

      taskHandler.mockResolvedValueOnce({ status: 429, body: { error: 'one dashboard task runs at a time' } } as any);
      const capped = await injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(`task:${task.taskId}`)}/command`,
        headers,
        payload: JSON.stringify({ message: 'again' }),
      });
      expect(capped.statusCode).toBe(429);
      expect(JSON.parse(capped.body).error).toMatch(/one dashboard task/);

      // A Slack session's command is unchanged: the Slack handler, never the task handler.
      taskHandler.mockClear();
      void slack;
      const slackCmd = await injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent('work:C1:500.002')}/command`,
        headers,
        payload: JSON.stringify({ message: 'hi' }),
      });
      expect(slackCmd.statusCode).toBe(200);
      expect(slackHandler).toHaveBeenCalledTimes(1);
      expect(taskHandler).not.toHaveBeenCalled();
    } finally {
      dashboard.setDashboardTaskCommandHandler(null);
      dashboard.setDashboardCommandHandler(null as any);
    }
  });

  it('#598 ④c — a Slack-less task’s card carries its last turn outcome (reason and recording failure included)', async () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    task.lastTurnOutcome = {
      turnId: 't-1',
      outcome: 'interrupted',
      category: 'Exception',
      reason: 'process ended before the outcome was recorded',
      recordFailure: 'outcome not saved: ENOSPC',
      at: 1_793_000_000_000,
    };
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const b = await board();
    const card = [...b.working, ...b.waiting, ...b.idle].find((c) => c.key === `task:${task.taskId}`) as any;
    expect(card?.lastTurnOutcome).toEqual({
      outcome: 'interrupted',
      category: 'Exception',
      reason: 'process ended before the outcome was recorded',
      recordFailure: 'outcome not saved: ENOSPC',
      at: 1_793_000_000_000,
    });
  });

  it('#599 ⑤ — a task’s open question carries its askId on the card; a Slack session’s does not', async () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    task.activityState = 'waiting';
    task.actionPanel = {
      waitingForChoice: true,
      pendingQuestion: {
        type: 'user_choice',
        question: 'Which DB?',
        choices: [{ id: 'pg', label: 'PG' }],
        askId: 'ask-9',
      },
    } as any;
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const b = await board();
    const card = [...b.working, ...b.waiting, ...b.idle].find((c) => c.key === `task:${task.taskId}`) as any;
    expect(card?.pendingQuestion?.askId).toBe('ask-9');
  });

  it('#599 ⑤ — a task’s answers go to the task answer handler bound to the askId; without one they are 400', async () => {
    const dashboard = await import('../dashboard');
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const handler = vi.fn(async () => ({ status: 202, body: { ok: true } }));
    const slackChoice = vi.fn(async () => {});
    dashboard.setDashboardTaskAnswerHandler(handler);
    dashboard.setDashboardChoiceAnswerHandler(slackChoice);
    const headers = { ...AUTH_HEADER, 'X-Admin-Mode': 'on', 'content-type': 'application/json' };
    const base = `/api/dashboard/session/${encodeURIComponent(`task:${task.taskId}`)}`;
    try {
      const single = await injectWebServer({
        method: 'POST',
        url: `${base}/answer-choice`,
        headers,
        payload: JSON.stringify({ choiceId: 'pg', label: 'PG', question: 'Which DB?', askId: 'ask-9' }),
      });
      expect(single.statusCode).toBe(202);
      expect(handler).toHaveBeenLastCalledWith(`task:${task.taskId}`, 'ask-9', { kind: 'single', choiceId: 'pg' });
      expect(slackChoice).not.toHaveBeenCalled();

      const noAsk = await injectWebServer({
        method: 'POST',
        url: `${base}/answer-choice`,
        headers,
        payload: JSON.stringify({ choiceId: 'pg', label: 'PG', question: 'Which DB?' }),
      });
      expect(noAsk.statusCode).toBe(400);

      const multi = await injectWebServer({
        method: 'POST',
        url: `${base}/answer-multi-choice`,
        headers,
        payload: JSON.stringify({ selections: { q1: { choiceId: 'node', label: 'Node' } }, askId: 'ask-9' }),
      });
      expect(multi.statusCode).toBe(202);
      expect(handler).toHaveBeenLastCalledWith(`task:${task.taskId}`, 'ask-9', {
        kind: 'multi',
        selections: { q1: { choiceId: 'node', label: 'Node' } },
      });

      const rec = await injectWebServer({
        method: 'POST',
        url: `${base}/submit-recommended`,
        headers,
        payload: JSON.stringify({ askId: 'ask-9' }),
      });
      expect(rec.statusCode).toBe(202);
      expect(handler).toHaveBeenLastCalledWith(`task:${task.taskId}`, 'ask-9', { kind: 'recommended' });

      handler.mockResolvedValueOnce({ status: 409, body: { error: 'the question has changed — reload' } } as any);
      const stale = await injectWebServer({
        method: 'POST',
        url: `${base}/answer-choice`,
        headers,
        payload: JSON.stringify({ choiceId: 'pg', label: 'PG', question: 'Which DB?', askId: 'ask-8' }),
      });
      expect(stale.statusCode).toBe(409);
    } finally {
      dashboard.setDashboardTaskAnswerHandler(null);
      dashboard.setDashboardChoiceAnswerHandler(null as any);
    }
  });
});
