import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan mode, end to end (SSOT 2026-11-02, T1–T4) — through the production
 * pieces: the dashboard routes, the task launcher, the task turn controller,
 * the real task executor, the real registry and the plan decider. Only the
 * agent stream is faked; its "model" submits the plan through the registry's
 * own `submitTaskPlan` (what the `plan` tool calls).
 *
 *   new task, plan on → the first turn's prompt carries the plan-mode notice;
 *     the conversation records only the user's words
 *   → the plan is submitted → the card waits (NEEDS YOU) with the plan's summary;
 *     the plan's HTML is there, high level to detail
 *   → 직접 입력 (an instruction) → the model revises: v2
 *   → 시작 v1 is refused (stale); 시작 v2 → approved, the next turn carries the
 *     plan and no notice; nothing more to decide
 *   another task: 취소 → cancelled, no turn runs
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
    jwtSecret: 'test-jwt-secret-plan',
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

const OWNER = 'U0PLANOWNER';
const RUN = `plan_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const made: string[] = [];
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const PLAN = (summary: string) => ({
  summary,
  intent: '긴 지시가 잘못 읽힌 채 실행되지 않게',
  ssot: ['대시보드 "새 작업"에서 plan 토글 on/off 추가 (디폴트 on)'],
  phases: [
    { title: '서버 게이트', steps: [{ title: '계획 제출 도구', detail: 'plan_submit 하나로', refs: ['T2'] }] },
    { title: '화면', steps: [{ title: '디테일 카드에 계획' }] },
  ],
});

describe('plan mode — new task → plan → direct input → start, and cancel (SSOT 2026-11-02)', () => {
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
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: 'Plan Owner' });
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

  async function wire() {
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
    const { createTaskPlanDecider } = await import('../task-plan-decision');

    const registry = new SessionRegistry();
    const coordinator = new RequestCoordinator();
    const prompts: string[] = [];
    /** What the fake model does on each turn, by turn number (1-based); default: just answer. */
    const script: Array<((taskId: string) => void) | undefined> = [];
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
        streamAgentEvents: vi.fn((prompt: string, session: any) => {
          prompts.push(prompt);
          const act = script[prompts.length - 1];
          return (async function* () {
            act?.(session.taskId);
            yield { type: 'assistant_delta', text: '계획을 제출했습니다.' };
            yield { type: 'result', stopReason: 'end_turn', finalText: '계획을 제출했습니다.' };
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
      buildExecutionContext: executionContextForTask,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    // As src/index.ts wires them.
    dashboard.setDashboardSessionAccessor(() => registry.getAllSessions());
    dashboard.setDashboardTaskLauncher(
      createTaskLauncher({
        controller,
        createTask: (input) => registry.createTask(input),
        createFreshDirectory: (ownerId) => {
          const dir = path.join('/tmp', ownerId, `session_${RUN}_${made.length}`);
          fs.mkdirSync(dir, { recursive: true });
          made.push(dir);
          return dir;
        },
      }),
    );
    dashboard.setDashboardTaskCommandHandler(
      (sessionKey: string, message: string, attachments: unknown[], actor: string) =>
        controller.start({ sessionKey, text: message, attachments, actorUserId: actor }),
    );
    dashboard.setDashboardTaskPlanHandler(
      createTaskPlanDecider({
        getSession: (k) => registry.getSessionByKey(k),
        setTaskPlanGate: (taskId, gate) => registry.setTaskPlanGate(taskId, gate),
        controller,
        logger: { info: vi.fn(), warn: vi.fn() },
      }),
    );
    return { registry, controller, prompts, script, executor };
  }

  const idle = async (registry: any, key: string, _turns: number) =>
    vi.waitFor(
      () => {
        const s = registry.getSessionByKey(key);
        expect(s?.activityState).toBe('idle');
        expect(s?.lastTurnOutcome?.outcome).toBe('completed');
      },
      { timeout: 10_000 },
    );

  it('plans, takes direct input, refuses a stale start, starts the latest plan, then has nothing to decide', async () => {
    const { registry, prompts, script, executor } = await wire();
    const owner = await signIn(OWNER);
    script[0] = (taskId) => registry.submitTaskPlan(taskId, PLAN('계획 v1'));

    // 1. The new-task dialog, "대시보드 작업", plan on.
    const created = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: owner,
      payload: { requestId: `req-${RUN}-a`, destination: 'task', prompt: '대시보드 개선해줘', plan: true },
    });
    expect(created.statusCode).toBe(200);
    const key: string = JSON.parse(created.body).sessionKey;
    await idle(registry, key, 1);

    // The model read the notice before the user's words; the conversation keeps only the words.
    expect(prompts[0]).toContain('<task-plan-mode state="drafting" revision="0">');
    expect(prompts[0].indexOf('<task-plan-mode')).toBeLessThan(prompts[0].indexOf('대시보드 개선해줘'));
    const { getConversation } = await import('../../conversation/recorder');
    const convo = await getConversation(registry.getSessionByKey(key)!.conversationId!);
    const userTurn = convo!.turns.find((t: any) => t.role === 'user')!;
    expect(userTurn.rawContent).toBe('대시보드 개선해줘');
    expect(userTurn.rawContent).not.toContain('task-plan-mode');

    // 2. The card waits for the owner, with the plan's summary.
    const waiting = await card(key);
    expect(waiting?.col).toBe('waiting');
    expect(waiting?.card.taskPlan).toMatchObject({
      state: 'awaiting',
      revision: 1,
      summary: '계획 v1',
      phases: 2,
      steps: 2,
    });

    // The plan's HTML: inline fragment and the full page.
    const wireKey = encodeURIComponent(waiting!.card.key);
    const planRes = await injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/${wireKey}/plan`,
      headers: owner,
    });
    expect(planRes.statusCode).toBe(200);
    const plan = JSON.parse(planRes.body);
    expect(plan).toMatchObject({ state: 'awaiting', revision: 1 });
    expect(plan.html).toContain('data-level="3"');
    expect(plan.html).toContain('계획 제출 도구');
    const page = await injectWebServer({ method: 'GET', url: `/dashboard/plan/${wireKey}`, headers: owner });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(String(page.headers['content-security-policy'])).toContain("script-src 'none'");
    expect(page.body).toContain('작업 계획 v1');

    // 3. 직접 입력 — any instruction while the plan waits: the model revises (v2).
    script[1] = (taskId) => registry.submitTaskPlan(taskId, PLAN('계획 v2'));
    const direct = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${wireKey}/command`,
      headers: owner,
      payload: { message: '화면 단계를 먼저 해줘' },
    });
    expect(direct.statusCode).toBe(202);
    await vi.waitFor(() => expect(registry.getSessionByKey(key)?.taskPlan?.revision).toBe(2), { timeout: 10_000 });
    await idle(registry, key, 2);
    expect(prompts[1]).toMatch(/v1에 대해 직접 입력/);
    expect(prompts[1]).toContain('화면 단계를 먼저 해줘');

    // 4. 시작 on the v1 the owner saw before: stale. 시작 on v2: the work starts with the plan.
    const decide = (decision: string, revision: number) =>
      injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${wireKey}/plan`,
        headers: owner,
        payload: { decision, revision },
      });
    const stale = await decide('start', 1);
    expect(stale.statusCode).toBe(409);
    expect(registry.getSessionByKey(key)?.taskPlan?.state).toBe('awaiting');
    const start = await decide('start', 2);
    expect(start.statusCode).toBe(200);
    expect(JSON.parse(start.body)).toMatchObject({ ok: true, state: 'approved', revision: 2, started: true });
    await vi.waitFor(() => expect(prompts.length).toBe(3), { timeout: 10_000 });
    await idle(registry, key, 3);
    expect(prompts[2]).toContain('[작업 계획 승인 — v2]');
    expect(prompts[2]).toContain('계획 v2');
    expect(prompts[2]).not.toContain('<task-plan-mode');
    expect(registry.getSessionByKey(key)?.taskPlan).toMatchObject({ state: 'approved', decidedBy: OWNER });
    const approved = await card(key);
    expect(approved?.col).toBe('idle');
    expect(approved?.card.taskPlan).toMatchObject({ state: 'approved', revision: 2 });
    // Nothing more to decide.
    expect((await decide('cancel', 2)).statusCode).toBe(409);
    expect(executor.slackCalls).toEqual([]);
  }, 60_000);

  it('취소 cancels a waiting plan; no turn runs; the card says so', async () => {
    const { registry, prompts, script } = await wire();
    const owner = await signIn(OWNER);
    script[0] = (taskId) => registry.submitTaskPlan(taskId, PLAN('계획 v1'));
    const created = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: owner,
      payload: { requestId: `req-${RUN}-b`, destination: 'task', prompt: '에픽 작업', plan: true },
    });
    const key: string = JSON.parse(created.body).sessionKey;
    await idle(registry, key, 1);
    const wireKey = encodeURIComponent((await card(key))!.card.key);
    const cancel = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${wireKey}/plan`,
      headers: owner,
      payload: { decision: 'cancel', revision: 1 },
    });
    expect(cancel.statusCode).toBe(200);
    expect(JSON.parse(cancel.body)).toMatchObject({ ok: true, state: 'cancelled' });
    expect(prompts.length).toBe(1);
    const after = await card(key);
    expect(after?.col).toBe('idle');
    expect(after?.card.taskPlan).toMatchObject({ state: 'cancelled', revision: 1 });
    // A bad body is 400; a task with no plan mode is 409.
    const bad = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${wireKey}/plan`,
      headers: owner,
      payload: { decision: 'go', revision: 1 },
    });
    expect(bad.statusCode).toBe(400);
  }, 60_000);
});
