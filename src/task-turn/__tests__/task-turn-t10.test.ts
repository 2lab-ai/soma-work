/**
 * T10 (#598 ④c): a dashboard instruction on a Slack-less task, end to end
 * through the production pieces — the task turn controller, the real task
 * executor, the real registry, conversation and work-log stores, and one
 * request coordinator — with only the agent stream faked.
 *
 *   accepted (202) → turn runs → outcome committed → zero Slack calls
 *   Stop through the coordinator → `cancelled`
 *   a restart while the turn runs → the reloaded task records the lost turn `interrupted`
 *   D9 → the owner's second task is refused while the first runs
 */
import { describe, expect, it, vi } from 'vitest';
import { createConversationDurable } from '../../conversation/recorder';
import { createSessionWorkLogAppender } from '../../conversation/session-work-log';
import { readWorkLog } from '../../conversation/work-log';
import { mcpCallTracker } from '../../mcp-call-tracker';
import { SessionRegistry } from '../../session-registry';
import { RequestCoordinator } from '../../slack';
import { TodoManager } from '../../todo-manager';
import { createTaskTurnController } from '../task-turn-controller';
import { createTaskTurnExecutor } from '../task-turn-executor';

const OWNER = 'U0T10OWNER';
const DIR = `/tmp/${OWNER}/session_t10`;
const FINAL = 'Raised the timeout to 60s.';

type Stream = () => AsyncGenerator<unknown>;

const answerTurn: Stream = () =>
  (async function* () {
    yield { type: 'assistant_delta', text: FINAL };
    yield { type: 'result', stopReason: 'end_turn', finalText: FINAL };
  })();

function claudeHandlerOver(registry: SessionRegistry, stream: () => Stream) {
  const known: Record<string, unknown> = {
    getSessionRegistry: () => registry,
    getAllSessions: () => registry.getAllSessions(),
    getSessionByKey: (k: string) => registry.getSessionByKey(k),
    setActivityStateByKey: (k: string, s: 'working' | 'waiting' | 'idle') => registry.setActivityStateByKey(k, s),
    clearSessionIdByKey: (k: string) => registry.clearSessionIdByKey(k),
    setSessionLinksByKey: (k: string, l: never) => registry.setSessionLinksByKey(k, l),
    setSessionTitleByKey: (k: string, t: string) => registry.setSessionTitleByKey(k, t),
    addSourceWorkingDirByKey: (k: string, d: string) => registry.addSourceWorkingDirByKey(k, d),
    addMergeStatsByKey: (k: string, n: number, a: number, d: number) => registry.addMergeStatsByKey(k, n, a, d),
    streamAgentEvents: vi.fn(() => stream()()),
  };
  return new Proxy(known, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in target) return target[prop as string];
      return () => {
        throw new Error(`unexpected claudeHandler.${String(prop)} on a task turn`);
      };
    },
  });
}

function setup() {
  const registry = new SessionRegistry();
  const coordinator = new RequestCoordinator();
  let stream: Stream = answerTurn;
  const claudeHandler = claudeHandlerOver(registry, () => stream);
  const executor = createTaskTurnExecutor({
    claudeHandler,
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
    // The production builder (executionContextForTask, #613) checks the directory on disk;
    // this harness gives the context it would build.
    buildExecutionContext: (session) =>
      ({
        origin: 'task',
        userId: session.ownerId,
        isAdmin: false,
        permissionMode: 'auto',
        sessionKey: `task:${session.taskId}`,
        taskId: session.taskId,
        workingDirectory: DIR,
      }) as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const newTask = (title: string) => {
    const task = registry.createTask({ ownerId: OWNER, ownerName: 'T10', workingDirectory: DIR, title });
    return { task, key: `task:${task.taskId}` };
  };
  return {
    registry,
    coordinator,
    claudeHandler: claudeHandler as unknown as { streamAgentEvents: ReturnType<typeof vi.fn> },
    executor,
    controller,
    newTask,
    useStream: (s: Stream) => {
      stream = s;
    },
  };
}

describe('T10 — a dashboard instruction runs a Slack-less task’s turn end to end (#598 ④c)', () => {
  it('accepted once started, runs to the end, commits completed, writes the work log — zero Slack calls', async () => {
    const h = setup();
    const { task, key } = h.newTask('A');
    const r = await h.controller.start({ sessionKey: key, text: 'raise the request timeout' });
    expect(r.status).toBe(202);
    await r.done;

    expect(h.executor.slackCalls).toEqual([]);
    const live = h.registry.getSessionByKey(key)!;
    expect(live.lastTurnOutcome).toMatchObject({ outcome: 'completed', category: 'WorkflowComplete' });
    expect(live.activityState).toBe('idle');
    expect(live.activeTaskTurnId).toBeUndefined();
    expect(h.coordinator.isRequestActive(key)).toBe(false);
    const page = await readWorkLog(task.conversationId!);
    expect(page.entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['instruction', 'final']));
    expect(page.entries.find((e) => e.kind === 'final')?.text).toContain('60s');
  });

  it('Stop through the shared request coordinator cancels the running turn — zero Slack calls', async () => {
    const h = setup();
    const { key } = h.newTask('B');
    h.useStream(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: 'Reading the config…' };
        // The dashboard's Stop: the same call `setDashboardStopHandler` makes.
        h.coordinator.abortSession(key, 'user-stop');
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      })(),
    );
    const r = await h.controller.start({ sessionKey: key, text: 'raise the request timeout' });
    expect(r.status).toBe(202);
    await r.done;

    expect(h.executor.slackCalls).toEqual([]);
    expect(h.registry.getSessionByKey(key)?.lastTurnOutcome?.outcome).toBe('cancelled');
    expect(h.registry.getSessionByKey(key)?.activityState).toBe('idle');
  });

  it('a restart while the turn runs reloads the task with that turn recorded interrupted (never re-run)', async () => {
    const h = setup();
    const { task, key } = h.newTask('C');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.useStream(() =>
      (async function* () {
        yield { type: 'assistant_delta', text: 'working…' };
        await gate;
        yield { type: 'result', stopReason: 'end_turn', finalText: 'done' };
      })(),
    );
    const r = await h.controller.start({ sessionKey: key, text: 'long job' });
    expect(r.status).toBe(202);
    const runningTurn = h.registry.getSessionByKey(key)?.activeTaskTurnId;
    expect(runningTurn).toBeTruthy();

    // The process "dies" here: a new process loads what is on disk.
    const restarted = new SessionRegistry();
    restarted.loadSessions();
    const back = restarted.getSessionByTaskId(task.taskId!)!;
    expect(back.activityState).toBe('idle');
    expect(back.lastTurnOutcome).toMatchObject({
      turnId: runningTurn,
      outcome: 'interrupted',
      reason: 'process ended before the outcome was recorded',
    });

    release();
    await r.done;
  });

  it('D9: while one task of an owner runs, a second task of the same owner is refused (429)', async () => {
    const h = setup();
    const first = h.newTask('D1');
    const second = h.newTask('D2');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.useStream(() =>
      (async function* () {
        await gate;
        yield { type: 'result', stopReason: 'end_turn', finalText: 'ok' };
      })(),
    );
    const r = await h.controller.start({ sessionKey: first.key, text: 'one' });
    expect(r.status).toBe(202);
    expect((await h.controller.start({ sessionKey: second.key, text: 'two' })).status).toBe(429);
    expect((await h.controller.start({ sessionKey: first.key, text: 'again' })).status).toBe(409);
    release();
    await r.done;
    h.useStream(answerTurn);
    const later = await h.controller.start({ sessionKey: second.key, text: 'two' });
    expect(later.status).toBe(202);
    await later.done;
    expect(h.executor.slackCalls).toEqual([]);
  });
});

describe('T11 — a dashboard task’s question answered from the dashboard (#599 ⑤)', () => {
  const QUESTION = {
    type: 'user_choice',
    question: 'Raise it to 60s or 90s?',
    choices: [
      { id: '60', label: '60s' },
      { id: '90', label: '90s' },
    ],
  };
  const askingTurn: Stream = () =>
    (async function* () {
      const text = ['Two options:', '```json', JSON.stringify(QUESTION), '```'].join('\n');
      yield { type: 'assistant_delta', text };
      yield { type: 'result', stopReason: 'end_turn', finalText: text };
    })();

  it('the turn asks and ends waiting; the dashboard answer (bound to askId) runs the next turn with the choice — zero Slack calls', async () => {
    const h = setup();
    const { key } = h.newTask('Q');
    h.useStream(askingTurn);
    const first = await h.controller.start({ sessionKey: key, text: 'raise the timeout' });
    await first.done;
    const asked = h.registry.getSessionByKey(key)!;
    expect(asked.activityState).toBe('waiting');
    const askId = (asked.actionPanel?.pendingQuestion as { askId?: string } | undefined)?.askId;
    expect(askId).toBeTruthy();

    // A stale id is refused and changes nothing.
    const stale = await h.controller.answer({
      actorUserId: OWNER,
      sessionKey: key,
      askId: 'ask-stale',
      answer: { kind: 'single', choiceId: '90' },
    });
    expect(stale.status).toBe(409);
    expect(h.registry.getSessionByKey(key)?.activityState).toBe('waiting');

    h.useStream(answerTurn);
    const answered = await h.controller.answer({
      actorUserId: OWNER,
      sessionKey: key,
      askId: askId!,
      answer: { kind: 'single', choiceId: '90' },
    });
    expect(answered.status).toBe(202);
    await answered.done;

    const prompt = String(h.claudeHandler.streamAgentEvents.mock.calls[1]?.[0] ?? '');
    expect(prompt).toContain('90');
    const done = h.registry.getSessionByKey(key)!;
    expect(done.lastTurnOutcome?.outcome).toBe('completed');
    expect(done.activityState).toBe('idle');
    expect(done.actionPanel?.pendingQuestion).toBeUndefined();
    // The same answer again is refused: the question is gone.
    expect(
      (
        await h.controller.answer({
          actorUserId: OWNER,
          sessionKey: key,
          askId: askId!,
          answer: { kind: 'single', choiceId: '90' },
        })
      ).status,
    ).toBe(409);
    expect(h.executor.slackCalls).toEqual([]);
  });
});
