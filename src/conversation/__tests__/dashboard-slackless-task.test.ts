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
vi.mock('../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));
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
// E4 ⑧ — a task's pending permission prompts, by task key (none unless a test sets one).
const taskPrompts = vi.hoisted(() => new Map<string, Array<Record<string, any>>>());
vi.mock('../permission-prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permission-prompts')>()),
  pendingTaskPermissionsFor: (taskKey: string, turnId: string | undefined) =>
    turnId ? (taskPrompts.get(taskKey) ?? []) : [],
}));
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
    if (fs.existsSync(TEST_DATA_DIR))
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR))
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    archiveState.items = [];
    taskPrompts.clear();
  });

  /** A signed-in dashboard user: the session cookie and its CSRF token. */
  async function signIn(slackUserId: string): Promise<Record<string, string>> {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = (await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` })) as any;
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json' };
  }

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
      headers: await signIn('U1'),
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

  it('E2 ⑨ — a close the registry refuses (the task still owes its thread) answers 409 with the reason, not 500', async () => {
    const dashboard = await import('../dashboard');
    const { SessionDeleteRefusedError } = await import('../../session-registry');
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const key = encodeURIComponent(`task:${task.taskId}`);
    // No body: drop the JSON content type, or the server refuses the empty body (400).
    const { 'content-type': _json, ...headers } = await signIn('U1');
    dashboard.setDashboardCloseHandler(async (sessionKey: string) => {
      throw new SessionDeleteRefusedError(sessionKey, 'terminated', new Error('task notice ledger unreadable'));
    });
    try {
      const refused = await injectWebServer({ method: 'POST', url: `/api/dashboard/session/${key}/close`, headers });
      expect(refused.statusCode).toBe(409);
      expect(JSON.parse(refused.body).error).toBe(dashboard.CLOSE_REFUSED_TEXT);
      // Any other failure is still a 500.
      dashboard.setDashboardCloseHandler(async () => {
        throw new Error('boom');
      });
      const failed = await injectWebServer({ method: 'POST', url: `/api/dashboard/session/${key}/close`, headers });
      expect(failed.statusCode).toBe(500);
    } finally {
      dashboard.setDashboardCloseHandler(undefined as any);
    }
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
    const owner = await signIn('U1');
    try {
      const accepted = await injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(`task:${task.taskId}`)}/command`,
        headers: owner,
        payload: JSON.stringify({ message: 'raise the timeout' }),
      });
      expect(accepted.statusCode).toBe(202);
      expect(JSON.parse(accepted.body)).toEqual({ ok: true });
      expect(taskHandler).toHaveBeenCalledWith(`task:${task.taskId}`, 'raise the timeout', [], 'U1');
      expect(slackHandler).not.toHaveBeenCalled();

      taskHandler.mockResolvedValueOnce({ status: 429, body: { error: 'one dashboard task runs at a time' } } as any);
      const capped = await injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(`task:${task.taskId}`)}/command`,
        headers: owner,
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

  it('E4 ① — an epic card says it is an epic; a child card names its epic and node; a plain task card has neither', async () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({
      ownerId: 'U1',
      ownerName: 'Alice',
      workingDirectory: '/work/U1/e',
      title: 'E',
      kind: 'epic',
    });
    const child = reg.createTask({
      ownerId: 'U1',
      ownerName: 'Alice',
      workingDirectory: '/work/U1/c',
      title: 'C',
      parentTaskId: epic.taskId,
      planNodeId: 'node-a',
    });
    const plain = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/p', title: 'P' });
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const b = await board();
    const all = [...b.working, ...b.waiting, ...b.idle] as any[];
    const cardOf = (id?: string) => all.find((c) => c.key === `task:${id}`);
    expect(cardOf(epic.taskId)).toMatchObject({ kind: 'epic' });
    expect(cardOf(epic.taskId).parentTaskId).toBeUndefined();
    // E4 ⑧ — the child's card is in its epic's bundle, not a column.
    expect(cardOf(child.taskId)).toBeUndefined();
    const childCard = cardOf(epic.taskId).epic.children.find((c: any) => c.key === `task:${child.taskId}`);
    expect(childCard).toMatchObject({ parentTaskId: epic.taskId, planNodeId: 'node-a' });
    expect(childCard.kind).toBeUndefined();
    expect(cardOf(plain.taskId).kind).toBeUndefined();
    expect(cardOf(plain.taskId).parentTaskId).toBeUndefined();
    expect(cardOf(plain.taskId).epic).toBeUndefined();
    // E4 ⑦ — a child its epic's close cancelled says so; none, no field.
    expect(childCard.closedBy).toBeUndefined();
    child.closedBy = { by: 'parent', at: 7 };
    const again = [...(await board()).idle] as any[];
    const after = again
      .find((c) => c.key === `task:${epic.taskId}`)
      .epic.children.find((c: any) => c.key === `task:${child.taskId}`);
    expect(after.closedBy).toEqual({ by: 'parent', at: 7 });
  });

  it('E4 ⑧ — an epic’s bundle: its state moves its column, its progress and plan tree, its children out of the columns', async () => {
    const reg = new SessionRegistry();
    const epic = reg.createTask({
      ownerId: 'U1',
      ownerName: 'Alice',
      workingDirectory: '/work/U1/e',
      title: 'E',
      kind: 'epic',
    });
    reg.setEpicPlan(
      epic.taskId!,
      {
        nodes: [
          { id: 'login', title: 'Fix login', kind: 'issue' },
          { id: 'docs', title: 'Docs', kind: 'issue', accepted: true },
        ],
      },
      'epic',
    );
    const c1 = reg.createTask({
      ownerId: 'U1',
      ownerName: 'Alice',
      workingDirectory: '/work/U1/c1',
      title: 'C1',
      parentTaskId: epic.taskId,
      planNodeId: 'login',
    });
    const c2 = reg.createTask({
      ownerId: 'U1',
      ownerName: 'Alice',
      workingDirectory: '/work/U1/c2',
      title: 'C2',
      parentTaskId: epic.taskId,
      planNodeId: 'docs',
    });
    c1.activityState = 'working';
    setDashboardSessionAccessor(() => reg.getAllSessions());

    let b = await board();
    const keys = (col: any[]) => col.map((c) => c.key);
    // The epic itself is idle, but a child works: its card is RUNNING.
    expect(keys(b.working)).toEqual([`task:${epic.taskId}`]);
    for (const col of [b.working, b.waiting, b.idle, b.closed]) {
      expect(keys(col)).not.toContain(`task:${c1.taskId}`);
      expect(keys(col)).not.toContain(`task:${c2.taskId}`);
    }
    const e = (b.working[0] as any).epic;
    expect(e.state).toBe('running');
    expect(e.progress).toEqual({ accepted: 1, total: 2, byStatus: { running: 1, none: 1 } });
    expect(e.nodes.map((n: any) => [n.id, n.status, n.accepted, n.childTaskIds])).toEqual([
      ['login', 'running', false, [c1.taskId]],
      ['docs', 'none', true, [c2.taskId]],
    ]);
    expect(e.children.map((c: any) => c.key).sort()).toEqual([`task:${c1.taskId}`, `task:${c2.taskId}`].sort());

    // A child waits on its owner: the epic's card is in WAITING.
    c1.activityState = 'idle';
    c2.activityState = 'waiting';
    b = await board();
    expect(keys(b.waiting)).toEqual([`task:${epic.taskId}`]);
    expect((b.waiting[0] as any).epic.state).toBe('needs-input');

    // Nothing at work: the epic's own column (idle).
    c2.activityState = 'idle';
    b = await board();
    expect(keys(b.idle)).toContain(`task:${epic.taskId}`);
    expect((b.idle.find((c) => c.key === `task:${epic.taskId}`) as any).epic.state).toBe('idle');

    // An epic not on the board (trashed): its children keep their own columns.
    epic.trashed = true;
    b = await board();
    expect(keys(b.idle)).toEqual(expect.arrayContaining([`task:${c1.taskId}`, `task:${c2.taskId}`]));
  });

  function epicTree() {
    const reg = new SessionRegistry();
    const base = { ownerId: 'U1', ownerName: 'Alice' };
    const epic = reg.createTask({ ...base, workingDirectory: '/work/U1/e', title: 'E', kind: 'epic' });
    reg.setEpicPlan(epic.taskId!, { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] }, 'epic');
    const child = reg.createTask({
      ...base,
      workingDirectory: '/work/U1/c',
      title: 'C',
      parentTaskId: epic.taskId,
      planNodeId: 'login',
    });
    return { reg, epic, child };
  }
  const columns = (b: Board) => [...b.working, ...b.waiting, ...b.idle, ...b.closed] as any[];

  it('E4 ⑧ R1 — a child of another owner under this epic’s id is not in its bundle: it keeps its own column (grok P1)', async () => {
    const { reg, epic, child } = epicTree();
    // A corrupt record: createTask refuses this, a hand-edited sessions.json does not.
    child.ownerId = 'U2';
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const b = await board();
    const epicCard = columns(b).find((c) => c.key === `task:${epic.taskId}`);
    expect(epicCard.epic.children).toEqual([]);
    expect(epicCard.epic.nodes[0].childTaskIds).toEqual([]);
    expect(columns(b).map((c) => c.key)).toContain(`task:${child.taskId}`);
  });

  it('E4 ⑧ R1 — a child stored before its epic is still bundled, once', async () => {
    const { reg, epic, child } = epicTree();
    const all = reg.getAllSessions();
    const childFirst = new Map([...all].sort(([a]) => (a === `task:${child.taskId}` ? -1 : 1)));
    expect([...childFirst.keys()][0]).toBe(`task:${child.taskId}`);
    setDashboardSessionAccessor(() => childFirst);
    const b = await board();
    expect(columns(b).map((c) => c.key)).not.toContain(`task:${child.taskId}`);
    const epicCard = columns(b).find((c) => c.key === `task:${epic.taskId}`);
    expect(epicCard.epic.children.map((c: any) => c.key)).toEqual([`task:${child.taskId}`]);
  });

  it('E4 ⑧ R1 — a running child blocked on a permission prompt puts its epic in WAITING (grok P2)', async () => {
    const { reg, epic, child } = epicTree();
    child.activityState = 'working';
    child.activeTaskTurnId = 'turn-1';
    setDashboardSessionAccessor(() => reg.getAllSessions());
    let b = await board();
    expect(b.working.map((c) => c.key)).toEqual([`task:${epic.taskId}`]);
    taskPrompts.set(`task:${child.taskId}`, [{ approvalId: 'ap-1', toolName: 'Bash', createdAt: 1 }]);
    b = await board();
    expect(b.waiting.map((c) => c.key)).toEqual([`task:${epic.taskId}`]);
    expect((b.waiting[0] as any).epic.state).toBe('needs-input');
    expect((b.waiting[0] as any).epic.children[0].activityState).toBe('waiting');
  });

  it('E4 ⑧ R1 — an idle child with an armed resume keeps its epic in RUNNING; a trashed child is in no bundle and no column', async () => {
    const { reg, epic, child } = epicTree();
    child.goal = { status: 'active', pendingEval: {} } as any;
    setDashboardSessionAccessor(() => reg.getAllSessions());
    let b = await board();
    expect(b.working.map((c) => c.key)).toEqual([`task:${epic.taskId}`]);
    expect((b.working[0] as any).epic.state).toBe('running');

    child.goal = undefined;
    child.trashed = true;
    b = await board();
    const epicCard = columns(b).find((c) => c.key === `task:${epic.taskId}`);
    expect(epicCard.epic.children).toEqual([]);
    expect(columns(b).map((c) => c.key)).not.toContain(`task:${child.taskId}`);
  });

  it('E4 ⑧ R1 — the single-session push carries the bundle; a child’s push is its epic’s card (fable P2-1)', async () => {
    const { reg, epic, child } = epicTree();
    child.activityState = 'working';
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const webServer = await import('../web-server');
    const dashboard = await import('../dashboard');
    const messages: any[] = [];
    const ws = await (webServer as any).injectWebServerWS(
      '/ws/dashboard',
      { headers: { authorization: 'Bearer test-token' } },
      (sock: any) => sock.on('message', (data: any) => messages.push(JSON.parse(data.toString()))),
    );
    try {
      const pushed = () => messages.filter((m) => m.type === 'sessionUpdated').map((m) => m.session);
      dashboard.broadcastSingleSessionUpdate(`task:${epic.taskId}`);
      await vi.waitFor(() => expect(pushed()).toHaveLength(1));
      expect(pushed()[0].key).toBe(`task:${epic.taskId}`);
      expect(pushed()[0].epic.state).toBe('running');
      expect(pushed()[0].epic.children.map((c: any) => c.key)).toEqual([`task:${child.taskId}`]);

      dashboard.broadcastSingleSessionUpdate(`task:${child.taskId}`);
      await vi.waitFor(() => expect(pushed()).toHaveLength(2));
      expect(pushed()[1].key).toBe(`task:${epic.taskId}`);
      expect(pushed()[1].epic.children.map((c: any) => c.key)).toEqual([`task:${child.taskId}`]);

      // An orphan child (its epic trashed) pushes its own card.
      epic.trashed = true;
      dashboard.broadcastSingleSessionUpdate(`task:${child.taskId}`);
      await vi.waitFor(() => expect(pushed()).toHaveLength(3));
      expect(pushed()[2].key).toBe(`task:${child.taskId}`);
    } finally {
      ws.terminate();
    }
  });

  it('E4 ⑧ R1 — a closed child’s archive card stays in CLOSED, tagged with its epic and node; a closed epic says epic (fable P2-2)', async () => {
    const reg = new SessionRegistry();
    const at = Date.now() - 60_000;
    const archived = (taskId: string, extra: Record<string, unknown>) => ({
      archivedAt: at,
      archiveReason: 'user_close',
      sessionKey: `task:${taskId}`,
      taskId,
      slackless: true,
      sessionId: 'sdk-1',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: '',
      title: taskId,
      lastActivity: new Date(at).toISOString(),
      ...extra,
    });
    archiveState.items = [
      archived('11111111-2222-4333-8444-555555555555', { parentTaskId: 'e-1', planNodeId: 'login' }),
      archived('21111111-2222-4333-8444-555555555555', { kind: 'epic' }),
    ];
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const b = await board();
    const [c, e] = archiveState.items.map((a) => (b.closed as any[]).find((x) => x.key.includes(a.taskId)));
    expect(c).toMatchObject({ parentTaskId: 'e-1', planNodeId: 'login' });
    expect(c.kind).toBeUndefined();
    expect(e).toMatchObject({ kind: 'epic' });
    expect(e.parentTaskId).toBeUndefined();
  });

  it('E2 ⑤ — a task’s card carries the thread notices that could not be posted; none, no field', async () => {
    const dashboard = await import('../dashboard');
    const reg = new SessionRegistry();
    const failing = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    const fine = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/b', title: 'B' });
    dashboard.setTaskNoticeFailureProvider((key) =>
      key === `task:${failing.taskId}` ? [{ kind: 'result', error: 'channel_not_found' }] : [],
    );
    try {
      setDashboardSessionAccessor(() => reg.getAllSessions());
      const b = await board();
      const cards = [...b.working, ...b.waiting, ...b.idle] as any[];
      expect(cards.find((c) => c.key === `task:${failing.taskId}`)?.noticeFailures).toEqual([
        { kind: 'result', error: 'channel_not_found' },
      ]);
      expect(cards.find((c) => c.key === `task:${fine.taskId}`)).not.toHaveProperty('noticeFailures');
    } finally {
      dashboard.setTaskNoticeFailureProvider(null);
    }
  });

  // #600 ⑥ — the client gates task-only UI on a field, not on the key's shape.
  it('#600 ⑥ — a task’s card says it is Slack-less; a Slack session’s card does not', async () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    const slack = reg.createSession('U1', 'Alice', 'C1', '500.009');
    slack.sessionId = 'sdk-9';
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const b = await board();
    const all = [...b.working, ...b.waiting, ...b.idle] as any[];
    expect(all.find((c) => c.key === `task:${task.taskId}`)?.slackless).toBe(true);
    expect(all.find((c) => c.key === 'work:C1:500.009')?.slackless).toBeUndefined();
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
    const headers = await signIn('U1');
    const base = `/api/dashboard/session/${encodeURIComponent(`task:${task.taskId}`)}`;
    try {
      const single = await injectWebServer({
        method: 'POST',
        url: `${base}/answer-choice`,
        headers,
        payload: JSON.stringify({ choiceId: 'pg', label: 'PG', question: 'Which DB?', askId: 'ask-9' }),
      });
      expect(single.statusCode).toBe(202);
      expect(handler).toHaveBeenLastCalledWith(
        `task:${task.taskId}`,
        'ask-9',
        { kind: 'single', choiceId: 'pg' },
        'U1',
      );
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
      expect(handler).toHaveBeenLastCalledWith(
        `task:${task.taskId}`,
        'ask-9',
        { kind: 'multi', selections: { q1: { choiceId: 'node', label: 'Node' } } },
        'U1',
      );

      const rec = await injectWebServer({
        method: 'POST',
        url: `${base}/submit-recommended`,
        headers,
        payload: JSON.stringify({ askId: 'ask-9' }),
      });
      expect(rec.statusCode).toBe(202);
      expect(handler).toHaveBeenLastCalledWith(`task:${task.taskId}`, 'ask-9', { kind: 'recommended' }, 'U1');

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

  // #637 R1 (astra P1) — a task's instruction and answers run under its owner's
  // identity (executionContextForTask), so only the signed-in owner may send
  // them: not the bearer token, not an admin in admin mode, not another user.
  // Stop / close / trash keep the #716 write policy (they cannot run anything).
  it('#637 R1 — only the signed-in owner instructs or answers a task; bearer, admin mode and others get 403', async () => {
    const dashboard = await import('../dashboard');
    const reg = new SessionRegistry();
    const task = reg.createTask({ ownerId: 'U1', ownerName: 'Alice', workingDirectory: '/work/U1/a', title: 'A' });
    const slack = reg.createSession('U1', 'Alice', 'C1', '500.003');
    setDashboardSessionAccessor(() => reg.getAllSessions());
    const taskCommand = vi.fn(async () => ({ status: 202, body: { ok: true } }));
    const taskAnswer = vi.fn(async () => ({ status: 202, body: { ok: true } }));
    const slackCommand = vi.fn(async () => {});
    dashboard.setDashboardTaskCommandHandler(taskCommand);
    dashboard.setDashboardTaskAnswerHandler(taskAnswer);
    dashboard.setDashboardCommandHandler(slackCommand);
    const base = `/api/dashboard/session/${encodeURIComponent(`task:${task.taskId}`)}`;
    const calls: Array<[string, unknown]> = [
      ['command', { message: 'go' }],
      ['answer-choice', { choiceId: 'pg', label: 'PG', question: 'Which DB?', askId: 'ask-1' }],
      ['answer-multi-choice', { selections: { q1: { choiceId: 'node', label: 'Node' } }, askId: 'ask-1' }],
      ['submit-recommended', { askId: 'ask-1' }],
    ];
    const bearer = { ...AUTH_HEADER, 'content-type': 'application/json' };
    const bearerAdmin = { ...bearer, 'X-Admin-Mode': 'on' };
    const admin = { ...(await signIn('U_ADMIN')), 'X-Admin-Mode': 'on' };
    const other = await signIn('U2');
    try {
      for (const [route, body] of calls) {
        for (const headers of [bearer, bearerAdmin, admin, other]) {
          const res = await injectWebServer({
            method: 'POST',
            url: `${base}/${route}`,
            headers,
            payload: JSON.stringify(body),
          });
          expect({ route, status: res.statusCode }).toEqual({ route, status: 403 });
        }
      }
      expect(taskCommand).not.toHaveBeenCalled();
      expect(taskAnswer).not.toHaveBeenCalled();
      // The owner passes.
      const owner = await signIn('U1');
      for (const [route, body] of calls) {
        const res = await injectWebServer({
          method: 'POST',
          url: `${base}/${route}`,
          headers: owner,
          payload: JSON.stringify(body),
        });
        expect({ route, status: res.statusCode }).toEqual({ route, status: 202 });
      }
      // Stopping a task stays open to an admin in admin mode (it cannot run anything).
      const stop = await injectWebServer({ method: 'POST', url: `${base}/stop`, headers: admin });
      expect(stop.statusCode).not.toBe(403);
      // A Slack session keeps the #716 policy: an admin in admin mode may still send a command.
      void slack;
      const slackCmd = await injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent('work:C1:500.003')}/command`,
        headers: admin,
        payload: JSON.stringify({ message: 'hi' }),
      });
      expect(slackCmd.statusCode).toBe(200);
    } finally {
      dashboard.setDashboardTaskCommandHandler(null);
      dashboard.setDashboardTaskAnswerHandler(null);
      dashboard.setDashboardCommandHandler(null as any);
    }
  });
});
