import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #865 — the goal commands of a dashboard task, end to end: the live test on dev
 * (de-aislop, 2026-11-03) replayed through the production pieces, wired as
 * src/index.ts wires them — the dashboard routes (new task, command, goal list),
 * the task launcher, the task turn controller with its goal commands, the real
 * task executor (StreamExecutor and its SET_GOAL host branch), the real registry
 * and work log. Only the agent stream is faked; its "model" calls SET_GOAL the
 * way the MCP server answers it.
 *
 *   new task "set goal 해줘: …"          → SET_GOAL applied (the goal)
 *   the owner asks again, the model calls SET_GOAL again → not queued twice
 *   `goal pause` (command route)         → paused at once, no model turn
 *   goal list add (goal route)           → queued behind it (the route took the task)
 *   `goal clear` (command route)         → goal + queue gone, no model turn
 *   nothing reached Slack
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

const OWNER = 'U0GOALCMDOWNER';
const RUN = `goalcmd_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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

describe('goal commands on a dashboard task — the de-aislop live test, replayed (#865)', () => {
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
    const { createTaskGoalCommands } = await import('../task-goal-commands');

    const registry = new SessionRegistry();
    const coordinator = new RequestCoordinator();
    const prompts: string[] = [];
    const setGoal = (id: string) => {
      const params = { objective: OBJECTIVE, userRequestEvidence: 'set goal 해줘' };
      return [
        {
          type: 'tool_call',
          toolCallId: id,
          name: 'mcp__model-command__run',
          input: { commandId: 'SET_GOAL', params },
        },
        {
          type: 'tool_result',
          toolCallId: id,
          name: 'mcp__model-command__run',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ type: 'model_command_result', commandId: 'SET_GOAL', ok: true, payload: params }),
            },
          ],
        },
      ];
    };
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
            // Every turn the model reads the owner's ask and calls SET_GOAL — as it did live.
            for (const event of setGoal(`mc_${turn}`)) yield event;
            yield { type: 'assistant_delta', text: `턴 ${turn}` };
            yield { type: 'result', stopReason: 'end_turn', finalText: `턴 ${turn}` };
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

    // As src/index.ts wires them: the controller with its goal commands, the commands with the controller.
    let goalCommands: ReturnType<typeof createTaskGoalCommands> | undefined;
    const kicks: string[] = [];
    const controller = createTaskTurnController({
      runner: executor,
      getSession: (k) => registry.getSessionByKey(k),
      coordinator,
      buildExecutionContext: executionContextForTask,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      goalCommands: {
        matches: (text) => goalCommands?.matches(text) ?? false,
        run: (request, session) => (goalCommands as NonNullable<typeof goalCommands>).run(request, session),
        opensGoal: (text) => goalCommands?.opensGoal(text) ?? false,
        openingDropped: (k, s, id, why) => goalCommands?.openingDropped(k, s, id, why),
      },
    });
    const settings = { max: new Map<string, number>(), auto: new Map<string, boolean>() };
    goalCommands = createTaskGoalCommands({
      getSession: (k) => registry.getSessionByKey(k),
      saveSessions: () => registry.saveSessions(),
      broadcast: () => {},
      kickLoop: (k) => kicks.push(k),
      startOpening: (k, prompt, actorUserId, carry) =>
        controller.start({
          sessionKey: k,
          text: prompt,
          actorUserId,
          queueWhileRunning: true,
          goalOpeningId: carry.goalId,
        }),
      settings: {
        getUserGoalMaxContinuations: (u) => settings.max.get(u),
        setUserGoalMaxContinuations: (u, v) => settings.max.set(u, v),
        toggleUserAutoGoalEnabled: (u) => {
          settings.auto.set(u, !settings.auto.get(u));
          return settings.auto.get(u) === true;
        },
        setUserAutoGoalEnabled: (u, on) => settings.auto.set(u, on),
      },
    });

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
      (sessionKey: string, message: string, attachments: unknown[], actorUserId: string) =>
        controller.start({ sessionKey, text: message, attachments, actorUserId, queueWhileRunning: true }),
    );
    dashboard.setDashboardGoalHandler((sessionKey: string, action: never, actorUserId?: string) =>
      (goalCommands as NonNullable<typeof goalCommands>).hostAction(sessionKey, action, actorUserId ?? OWNER),
    );
    return { registry, prompts, executor, readWorkLog, controller, coordinator };
  }

  it('set, set again, pause, add, clear — the goal state follows the commands; the model sees none of them', async () => {
    const { registry, prompts, executor, readWorkLog, controller, coordinator } = await wire();
    const owner = await signIn(OWNER);
    const idle = (key: string) => async () => {
      expect(controller.isRunning(key)).toBe(false);
      expect(coordinator.isRequestActive(key)).toBe(false);
    };

    // 1. The owner asks a new task to set the goal: SET_GOAL applied on the host.
    const created = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: owner,
      payload: { requestId: `req-${RUN}`, destination: 'task', prompt: ASK, plan: false },
    });
    expect(created.statusCode).toBe(200);
    const key: string = JSON.parse(created.body).sessionKey;
    const url = (route: string) => `/api/dashboard/session/${encodeURIComponent(key)}/${route}`;
    await vi.waitFor(() => expect(registry.getSessionByKey(key)?.goal?.objective).toBe(OBJECTIVE), { timeout: 10_000 });
    await vi.waitFor(idle(key), { timeout: 10_000 });

    // 2. The owner asks again; the model calls SET_GOAL again — the same goal is not queued behind itself.
    const again = await injectWebServer({
      method: 'POST',
      url: url('command'),
      headers: owner,
      payload: { message: ASK },
    });
    expect(again.statusCode).toBe(202);
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 });
    await vi.waitFor(idle(key), { timeout: 10_000 });
    expect(registry.getSessionByKey(key)?.goalQueue ?? []).toHaveLength(0);

    // 3. `goal pause` — the host's command: paused at once, no model turn.
    const pause = await injectWebServer({
      method: 'POST',
      url: url('command'),
      headers: owner,
      payload: { message: 'goal pause' },
    });
    expect(pause.statusCode).toBe(200);
    expect(JSON.parse(pause.body)).toMatchObject({ ok: true, goalCommand: true });
    expect(registry.getSessionByKey(key)?.goal?.status).toBe('paused');

    // 4. The goal list takes the task now (it answered 409): an add queues behind the paused goal.
    const add = await injectWebServer({
      method: 'POST',
      url: url('goal'),
      headers: owner,
      payload: { action: 'add', objective: 'the real goal' },
    });
    expect(add.statusCode).toBe(200);
    expect(JSON.parse(add.body).result).toMatchObject({ outcome: 'queued', position: 1 });

    // 5. `goal clear` — the goal and its queue are gone; still no model turn.
    const clear = await injectWebServer({
      method: 'POST',
      url: url('command'),
      headers: owner,
      payload: { message: 'goal clear' },
    });
    expect(clear.statusCode).toBe(200);
    expect(JSON.parse(clear.body).message).toBe('🧹 Goal cleared (also cleared 1 queued goal).');
    const s = registry.getSessionByKey(key)!;
    expect(s.goal).toBeUndefined();
    expect(s.goalQueue).toEqual([]);
    expect(prompts).toHaveLength(2);

    // The work log has the story: 🎯 set, "already set" for the repeat, ⏸️ paused, 📋 added, 🧹 cleared.
    await vi.waitFor(
      async () => {
        const { entries } = await readWorkLog(s.conversationId!, { limit: 200 });
        const notices = entries.filter((e: any) => e.kind === 'notice').map((e: any) => e.text);
        expect(notices.some((t: string) => t.includes('🎯') && t.includes(OBJECTIVE))).toBe(true);
        expect(notices.some((t: string) => t.includes('Goal already set — not added again'))).toBe(true);
        expect(notices.some((t: string) => t.startsWith('⏸️ Goal paused'))).toBe(true);
        expect(notices.some((t: string) => t.startsWith('📋 Goal added via dashboard'))).toBe(true);
        expect(notices.some((t: string) => t.startsWith('🧹 Goal cleared'))).toBe(true);
        // The goal commands never became instructions to the model.
        const instructions = entries.filter((e: any) => e.kind === 'instruction').map((e: any) => e.text);
        expect(instructions.some((t: string) => /^goal (pause|clear)/.test(t))).toBe(false);
      },
      { timeout: 10_000 },
    );
    expect(executor.slackCalls).toEqual([]);
  }, 60_000);
});
