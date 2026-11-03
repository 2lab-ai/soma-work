import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SET_GOAL on a dashboard task, end to end (SSOT 2026-11-03, #861) — the scenario
 * that failed in production: the owner asks a dashboard task to set a goal, the
 * goal is set, and the goal loop drives the task on its own until the goal is met.
 *
 * Through the production pieces, wired as src/index.ts wires them: the dashboard
 * routes (new task), the task launcher, the task turn controller, the real task
 * executor (StreamExecutor and its model-command host branch), the real registry,
 * the real work log, GoalLoopController and the task goal loop. Only the agent
 * stream and the completion eval's model answer are faked; the stream's "model"
 * calls `mcp__model-command__run` SET_GOAL exactly as the MCP server answers it.
 *
 *   new task "set goal 해줘: …" → SET_GOAL applied on the host (owner's goal)
 *   → the chain ends → eval: not yet → the loop starts the next turn itself
 *     (a host turn: `[goal-continuation]`, recorded as system)
 *   → that chain ends → eval: done → the goal is complete; nothing reached Slack
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
    jwtSecret: 'test-jwt-secret-goal',
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

const OWNER = 'U0GOALOWNER';
const RUN = `goal_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const made: string[] = [];
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  // The fake owner's root too (fable-zhuge #870 R1 P3) — only when empty: a concurrent run on the same
  // host (the CI runner is this machine) keeps its own folders there (astra-zhuge #870 R2 P2).
  try {
    fs.rmdirSync(path.join('/tmp', OWNER));
  } catch {
    // Not empty, or already gone.
  }
});

const OBJECTIVE = 'de-aislop #830 완료';
const ASK = `set goal 해줘: ${OBJECTIVE}`;

describe('SET_GOAL on a dashboard task — set, continued by the loop, completed (#861)', () => {
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
    // The appender this file installs (as src/index.ts does) must not outlive it in a shared worker.
    const { setStreamExecutorProviders } = await import('@soma/slack/pipeline/stream-executor');
    setStreamExecutorProviders({ appendWorkLog: () => {} });
  });

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../../conversation/oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: 'Goal Owner' });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json' };
  }

  async function wire() {
    const { SessionRegistry } = await import('../../session-registry');
    const { RequestCoordinator } = await import('../../slack');
    const { TodoManager } = await import('../../todo-manager');
    const { mcpCallTracker } = await import('../../mcp-call-tracker');
    const { createConversationDurable } = await import('../../conversation/recorder');
    const { createSessionWorkLogAppender } = await import('../../conversation/session-work-log');
    const { readWorkLog } = await import('../../conversation/work-log');
    const { executionContextForTask } = await import('../../agent-runtime/execution-context');
    const { createTaskTurnExecutor } = await import('../task-turn-executor');
    const { createTaskTurnController } = await import('../task-turn-controller');
    const { createTaskLauncher } = await import('../task-launcher');
    const { createTaskGoalLoop } = await import('../task-goal-loop');
    const { readTurnFinal } = await import('../task-turn-final');
    const { GoalLoopController } = await import('../../slack/goal-loop-controller');

    const registry = new SessionRegistry();
    const coordinator = new RequestCoordinator();
    const prompts: string[] = [];
    const claudeHandler = new Proxy(
      {
        getSessionRegistry: () => registry,
        getAllSessions: () => registry.getAllSessions(),
        getSessionByKey: (k: string) => registry.getSessionByKey(k),
        saveSessions: () => registry.saveSessions(),
        setActivityStateByKey: (k: string, s: 'working' | 'waiting' | 'idle') => registry.setActivityStateByKey(k, s),
        clearSessionIdByKey: (k: string) => registry.clearSessionIdByKey(k),
        setSessionLinksByKey: (k: string, l: never) => registry.setSessionLinksByKey(k, l),
        setSessionTitleByKey: (k: string, t: string) => registry.setSessionTitleByKey(k, t),
        addSourceWorkingDirByKey: (k: string, d: string) => registry.addSourceWorkingDirByKey(k, d),
        addMergeStatsByKey: (k: string, n: number, a: number, d: number) => registry.addMergeStatsByKey(k, n, a, d),
        streamAgentEvents: vi.fn((prompt: string) => {
          prompts.push(prompt);
          const turn = prompts.length;
          return (async function* () {
            if (turn === 1) {
              // The model calls SET_GOAL; the MCP server echoes it (the host is the enforcement point).
              const params = { objective: OBJECTIVE, userRequestEvidence: 'set goal 해줘' };
              yield {
                type: 'tool_call',
                toolCallId: 'mc_1',
                name: 'mcp__model-command__run',
                input: { commandId: 'SET_GOAL', params },
              };
              yield {
                type: 'tool_result',
                toolCallId: 'mc_1',
                name: 'mcp__model-command__run',
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      type: 'model_command_result',
                      commandId: 'SET_GOAL',
                      ok: true,
                      payload: params,
                    }),
                  },
                ],
              };
              yield { type: 'assistant_delta', text: '골을 설정했습니다. 첫 단계를 진행합니다.' };
              yield { type: 'result', stopReason: 'end_turn', finalText: '골을 설정했습니다. 첫 단계를 진행합니다.' };
              return;
            }
            yield { type: 'assistant_delta', text: `단계 ${turn} 완료.` };
            yield { type: 'result', stopReason: 'end_turn', finalText: `단계 ${turn} 완료.` };
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
    const appendSessionWorkLog = createSessionWorkLogAppender({
      getAllSessions: () => registry.getAllSessions(),
      scheduleLiveSessionUpdate: () => {},
      refreshAgentSpend: () => {},
    });
    // As src/index.ts wires it: a conversation-level notice (the goal loop's) goes through the same appender.
    const { setStreamExecutorProviders } = await import('@soma/slack/pipeline/stream-executor');
    setStreamExecutorProviders({
      appendWorkLog: (conversationId, entry) => {
        appendSessionWorkLog(conversationId, entry as never).catch(() => {});
      },
    });
    const executor = createTaskTurnExecutor({
      claudeHandler: claudeHandler as never,
      requestCoordinator: coordinator,
      mcpCallTracker,
      todoManager: new TodoManager(),
      appendSessionWorkLog,
      createConversation: (s) => createConversationDurable('', '', s.ownerId, s.ownerName ?? '', s.title),
    });

    // As src/index.ts wires them: the task goal loop, the controller, then GoalLoopController.
    let settleTaskGoal: ((key: string) => void) | undefined;
    const taskGoalLoop = createTaskGoalLoop({
      getSession: (k) => registry.getSessionByKey(k),
      start: (request) => controller.start(request),
      readLastFinal: async (session) => {
        const turnId = session.lastTurnOutcome?.turnId;
        if (!session.conversationId || !turnId) return undefined;
        return (await readTurnFinal(readWorkLog, session.conversationId, turnId))?.text;
      },
      saveSessions: () => registry.saveSessions(),
      isRunning: (k) => controller.isRunning(k),
      settle: (k) => settleTaskGoal?.(k),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const controller = createTaskTurnController({
      runner: executor,
      getSession: (k) => registry.getSessionByKey(k),
      coordinator,
      buildExecutionContext: executionContextForTask,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onChainEnd: (k, info) => {
        void taskGoalLoop.onChainEnd(k, info);
      },
      onUserInstruction: (k, s) => taskGoalLoop.onUserInstruction(k, s),
    });
    const evals: string[] = [];
    const verdicts = [
      { completed: false, reason: '첫 단계만 끝났습니다', remaining: ['다음 단계'] },
      { completed: true, reason: '모든 단계가 끝났습니다', remaining: [] },
    ];
    const slackNotices: string[] = [];
    const goalLoop = new GoalLoopController({
      registry: {
        getSessionByKey: (k) => registry.getSessionByKey(k),
        getActivityStateByKey: (k) => registry.getActivityStateByKey(k),
        saveSessions: () => registry.saveSessions(),
      },
      requestCoordinator: { isRequestActive: (k) => coordinator.isRequestActive(k) },
      dispatcher: async ({ userPrompt }) => {
        evals.push(userPrompt);
        return JSON.stringify(verdicts[Math.min(evals.length - 1, verdicts.length - 1)]);
      },
      injectContinuation: (event, target) =>
        target.session.slackless === true
          ? taskGoalLoop.injectContinuation(event, target)
          : Promise.reject(new Error('a Slack injection for a task')),
      postNotice: async (_c, _t, text) => {
        slackNotices.push(text);
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fallbackModel: 'claude-sonnet-4-20250514',
    });
    settleTaskGoal = (k) => goalLoop.onTurnSettled(k, { cause: 'turn' });

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
    return { registry, prompts, evals, slackNotices, executor, readWorkLog, controller, goalLoop, coordinator };
  }

  it('the owner asks a dashboard task to set a goal: it is set, the loop runs the next turn, the goal completes', async () => {
    const { registry, prompts, evals, slackNotices, executor, readWorkLog, controller, goalLoop, coordinator } =
      await wire();
    const owner = await signIn(OWNER);

    const created = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: owner,
      payload: { requestId: `req-${RUN}`, destination: 'task', prompt: ASK, plan: false },
    });
    expect(created.statusCode).toBe(200);
    const key: string = JSON.parse(created.body).sessionKey;
    expect(key).toMatch(/^task:/);

    // 1. SET_GOAL applied on the host — the owner's goal (the turn ran as the owner).
    await vi.waitFor(() => expect(registry.getSessionByKey(key)?.goal?.objective).toBe(OBJECTIVE), {
      timeout: 10_000,
    });
    expect(registry.getSessionByKey(key)?.goal?.createdBy).toBe(OWNER);

    // 2. The loop judged "not yet" and started the next turn itself — a host turn.
    await vi.waitFor(() => expect(prompts.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    // The continuation names the goal by reference; the objective itself is the session-goal block.
    expect(prompts[1]).toContain('[goal-continuation]');

    // 3. The second eval said done: the goal is complete (archived to the history), and no third turn ran.
    await vi.waitFor(
      () => {
        const s = registry.getSessionByKey(key)!;
        const done = s.goal?.status === 'complete' || (s.goalHistory ?? []).some((g: any) => g.status === 'complete');
        expect(done).toBe(true);
      },
      { timeout: 10_000 },
    );
    // "No third turn" is the loop at rest, not silence for a while (grok-elon #870 R1): no chain runs, no
    // request holds the task, the loop's queue is drained — checked twice across a settle, so a start or an
    // eval scheduled by the last one has had its chance to show.
    const atRest = async () => {
      await goalLoop.settled(key);
      expect(controller.isRunning(key)).toBe(false);
      expect(coordinator.isRequestActive(key)).toBe(false);
    };
    await vi.waitFor(atRest, { timeout: 10_000 });
    await new Promise((r) => setImmediate(r));
    await vi.waitFor(atRest, { timeout: 10_000 });
    expect(evals).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    // Each eval judged its own turn's answer (astra-zhuge #870 R1): the evidence is that chain's final.
    expect(evals[0]).toContain('골을 설정했습니다');
    expect(evals[1]).toContain('단계 2 완료');
    expect(evals[1]).not.toContain('골을 설정했습니다');

    // The work log says it all — the owner's instruction, the 🎯 notice, the system's goal turn, ✅ done.
    // Read until it is there: a notice's append is fire-and-forget (fable-zhuge #870 R1 P2).
    const conversationId = registry.getSessionByKey(key)!.conversationId!;
    await vi.waitFor(
      async () => {
        const { entries } = await readWorkLog(conversationId, { limit: 200 });
        const instructions = entries.filter((e: any) => e.kind === 'instruction');
        expect(instructions[0]).toMatchObject({ by: 'user' });
        expect(instructions[0].text).toContain('set goal 해줘');
        expect(instructions[1]).toMatchObject({ by: 'system' });
        expect(instructions[1].text).toContain('[goal-continuation]');
        const notices = entries.filter((e: any) => e.kind === 'notice').map((e: any) => e.text);
        expect(notices.some((t: string) => t.includes('🎯') && t.includes(OBJECTIVE))).toBe(true);
        expect(notices.some((t: string) => t.includes('✅ Goal completed'))).toBe(true);
      },
      { timeout: 10_000 },
    );

    // A dashboard task never calls Slack: no thread notice, no Slack API call.
    expect(slackNotices).toEqual([]);
    expect(executor.slackCalls).toEqual([]);
  }, 60_000);
});
