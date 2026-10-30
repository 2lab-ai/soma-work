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
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [], exists: () => false, archive: () => {} }),
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

  it('#612 R1 — routes that run or steer a turn refuse a Slack-less task with 409; close is still allowed', async () => {
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
    const command = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${key}/command`,
      headers,
      payload: JSON.stringify({ message: 'hello' }),
    });
    expect(command.statusCode).toBe(409);
    const close = await injectWebServer({ method: 'POST', url: `/api/dashboard/session/${key}/close`, headers });
    expect(close.statusCode).not.toBe(409);
  });

  it('a never-run Slack session is still off the board (the board filter change is for Slack-less tasks only)', async () => {
    const reg = new SessionRegistry();
    reg.createSession('U1', 'Alice', 'C1', '500.001'); // no SDK turn yet
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const b = await board();
    const all = [...b.working, ...b.waiting, ...b.idle, ...b.closed];
    expect(all.find((c) => c.key === 'work:C1:500.001')).toBeUndefined();
  });
});
