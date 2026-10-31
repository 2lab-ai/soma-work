import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T13 (#600 ⑥, A0): the dashboard alone — no Slack — runs a task from start to
 * result, and its state survives a restart. Through the production pieces: the
 * dashboard routes (new task, stop, board), the task launcher, the task turn
 * controller, the real task executor, the real registry and stores, and one
 * request coordinator. Only the agent stream is faked.
 *
 *   new task (destination: task) → a Slack-less task in a fresh folder, started
 *   → its card is on the board, working
 *   → Stop on the dashboard → the turn ends `cancelled` — zero Slack calls
 *   → restart (a fresh registry loads the saved file) → the card still says so
 */

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
    jwtSecret: 'test-jwt-secret-t13',
    jwtExpiresIn: 604800,
  },
};
vi.mock('../../config', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return { ...actual, config: { ...actual.config, ...mockConfig } };
});
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [], exists: () => false, archive: () => {}, load: () => null }),
}));

const OWNER = 'U0T13OWNER';
const RUN = `t13_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const made: string[] = [];
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

describe('T13 — a dashboard task from the new-task dialog to its result, across a restart (#600 ⑥)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../../conversation/web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../../conversation/dashboard');
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    await stopWebServer?.();
  });

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../../conversation/oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: 'T13 Owner' });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json' };
  }

  async function card(key: string) {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: { Authorization: 'Bearer test-token' },
    });
    const b = JSON.parse(res.body).board;
    for (const col of ['working', 'waiting', 'idle', 'closed']) {
      const hit = (b[col] || []).find((c: any) => c.key === key);
      if (hit) return { col, card: hit };
    }
    return null;
  }

  it('creates, runs and stops a task from the dashboard alone; the result is still there after a restart', async () => {
    const { SessionRegistry } = await import('../../session-registry');
    const { RequestCoordinator } = await import('../../slack');
    const { TodoManager } = await import('../../todo-manager');
    const { mcpCallTracker } = await import('../../mcp-call-tracker');
    const { createConversationDurable } = await import('../../conversation/recorder');
    const { createSessionWorkLogAppender } = await import('../../conversation/session-work-log');
    const { executionContextForTask } = await import('../../agent-runtime/execution-context');
    const { createTaskTurnExecutor } = await import('../task-turn-executor');
    const { createTaskTurnController } = await import('../task-turn-controller');
    const { createTaskLauncher } = await import('../task-launcher');

    const registry = new SessionRegistry();
    const coordinator = new RequestCoordinator();
    let releaseStop!: () => void;
    const stopped = new Promise<void>((r) => {
      releaseStop = r;
    });
    let prompts: string[] = [];
    const claudeHandler = new Proxy(
      {
        getSessionRegistry: () => registry,
        getAllSessions: () => registry.getAllSessions(),
        getSessionByKey: (k: string) => registry.getSessionByKey(k),
        setActivityStateByKey: (k: string, s: 'working' | 'waiting' | 'idle') => registry.setActivityStateByKey(k, s),
        clearSessionIdByKey: (k: string) => registry.clearSessionIdByKey(k),
        setSessionLinksByKey: (k: string, l: never) => registry.setSessionLinksByKey(k, l),
        setSessionTitleByKey: (k: string, t: string) => registry.setSessionTitleByKey(k, t),
        addSourceWorkingDirByKey: (k: string, d: string) => registry.addSourceWorkingDirByKey(k, d),
        addMergeStatsByKey: (k: string, n: number, a: number, d: number) => registry.addMergeStatsByKey(k, n, a, d),
        streamAgentEvents: vi.fn((prompt: string) => {
          prompts = [...prompts, prompt];
          return (async function* () {
            yield { type: 'assistant_delta', text: 'Reading the test…' };
            await stopped; // the dashboard's Stop lands meanwhile
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          })();
        }),
      } as Record<string, unknown>,
      {
        get(target, prop) {
          if (typeof prop === 'symbol' || prop in target) return target[prop as string];
          return () => {
            throw new Error(`unexpected claudeHandler.${String(prop)} on a task turn`);
          };
        },
      },
    );
    const executor = createTaskTurnExecutor({
      claudeHandler: claudeHandler as never,
      requestCoordinator: coordinator,
      mcpCallTracker,
      todoManager: new TodoManager(),
      appendSessionWorkLog: createSessionWorkLogAppender({
        getAllSessions: () => registry.getAllSessions(),
        scheduleLiveSessionUpdate: () => {},
        refreshAgentSpend: () => {},
      }),
      createConversation: (s) => createConversationDurable('', '', s.ownerId, s.ownerName ?? '', s.title),
    });
    const controller = createTaskTurnController({
      runner: executor,
      getSession: (k) => registry.getSessionByKey(k),
      coordinator,
      buildExecutionContext: executionContextForTask, // the production builder: the folder is real
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    // As src/index.ts wires them.
    dashboard.setDashboardSessionAccessor(() => registry.getAllSessions());
    dashboard.setDashboardTaskLauncher(
      createTaskLauncher({
        controller,
        createTask: (input) => registry.createTask(input),
        createFreshDirectory: (ownerId) => {
          const dir = path.join('/tmp', ownerId, `session_${RUN}`);
          fs.mkdirSync(dir, { recursive: true });
          made.push(dir);
          return dir;
        },
      }),
    );
    dashboard.setDashboardStopHandler(async (k: string) => {
      coordinator.abortSession(k, 'user-stop');
    });

    // 1. The new-task dialog, "대시보드 작업".
    const owner = await signIn(OWNER);
    const created = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: owner,
      payload: { requestId: `req-${RUN}`, destination: 'task', prompt: 'Fix the flaky test\nthen explain' },
    });
    expect(created.statusCode).toBe(200);
    const launched = JSON.parse(created.body);
    expect(launched).toMatchObject({ ok: true, status: 'running' });
    const key: string = launched.sessionKey;
    expect(key).toMatch(/^task:/);

    // 2. Its card: Slack-less, titled from the instruction, working; the turn got the instruction.
    const running = await card(key);
    expect(running?.col).toBe('working');
    expect(running?.card).toMatchObject({ slackless: true, title: 'Fix the flaky test' });
    expect(running?.card.slackThreadUrl).toBeUndefined();
    await vi.waitFor(() => expect(prompts.join('\n')).toContain('Fix the flaky test'));

    // 3. Stop on the dashboard.
    // A body-less POST, as the page's doAction sends it (no JSON Content-Type).
    const { 'content-type': _ct, ...noBody } = owner;
    const stop = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/stop`,
      headers: noBody,
    });
    expect(stop.statusCode).toBe(200);
    releaseStop();
    await vi.waitFor(() => expect(registry.getSessionByKey(key)?.lastTurnOutcome?.outcome).toBe('cancelled'), {
      timeout: 10_000,
    });
    const ended = await card(key);
    expect(ended?.col).toBe('idle');
    expect(ended?.card.lastTurnOutcome).toMatchObject({ outcome: 'cancelled' });
    expect(executor.slackCalls).toEqual([]);

    // 4. Restart: a fresh registry loads the saved file; the board shows the same task and result.
    const reloaded = new SessionRegistry();
    reloaded.loadSessions();
    dashboard.setDashboardSessionAccessor(() => reloaded.getAllSessions());
    const after = await card(key);
    expect(after?.col).toBe('idle');
    expect(after?.card).toMatchObject({ slackless: true, title: 'Fix the flaky test' });
    expect(after?.card.lastTurnOutcome).toMatchObject({ outcome: 'cancelled' });
  }, 60_000);
});
