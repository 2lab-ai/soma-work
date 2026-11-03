/**
 * A dashboard task's turn the restart cut is resumed after boot (2026-11-03).
 *
 * The incident: a plan-mode task ("de-aislop") was working when the dev host
 * restarted (02:00Z). Its turn was reconciled `interrupted` on load and nothing
 * ran it again — a Slack thread in the same restart was resumed
 * (`notifyCrashRecovery`), the task was not even on the list.
 *
 *   R1 the reload lists the cut task (with its cut turn); an epic is not listed (its waker owns it)
 *   R2 end to end, production pieces: the resumer starts the task's next turn as its owner —
 *      the conversation records the short line, the model reads the restart guidance first
 *   R3 the owner's slot is busy (429): retried, and started once it frees
 *   R4 skipped: someone went on since (a newer turn), an active goal (the goal loop resumes it), closed
 */
import { describe, expect, it, vi } from 'vitest';
import { createConversationDurable } from '../../conversation/recorder';
import { createSessionWorkLogAppender } from '../../conversation/session-work-log';
import { readWorkLog } from '../../conversation/work-log';
import { mcpCallTracker } from '../../mcp-call-tracker';
import { SessionRegistry } from '../../session-registry';
import { RequestCoordinator } from '../../slack';
import { TodoManager } from '../../todo-manager';
import type { ConversationSession } from '../../types';
import { TASK_GOAL_START_MAX_RETRIES } from '../task-goal-loop';
import {
  createRestartNoticeStart,
  createTaskRestartResumer,
  cutTurnAuthor,
  type RestartCutTaskRef,
  restartResumeSkip,
  TASK_RESTART_NOTICE,
  TASK_RESTART_TEXT,
  taskTurnStartedAt,
} from '../task-restart-resume';
import { createTaskTurnController, type TaskCommandRequest, type TaskCommandResponse } from '../task-turn-controller';
import { createTaskTurnExecutor } from '../task-turn-executor';

const OWNER = 'U0RESUMEOWNER';
const DIR = `/tmp/${OWNER}/session_resume`;

type Stream = () => AsyncGenerator<unknown>;

const finishTurn: Stream = () =>
  (async function* () {
    yield { type: 'assistant_delta', text: 'continued' };
    yield { type: 'result', stopReason: 'end_turn', finalText: 'continued' };
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

/** The production controller and executor over one registry — a "process". */
function processOver(registry: SessionRegistry) {
  const coordinator = new RequestCoordinator();
  let stream: Stream = finishTurn;
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
    buildExecutionContext: (session, actor) =>
      ({
        origin: 'task',
        userId: actor ?? session.ownerId,
        isAdmin: false,
        permissionMode: 'auto',
        sessionKey: `task:${session.taskId}`,
        taskId: session.taskId,
        workingDirectory: DIR,
      }) as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return {
    registry,
    controller,
    claudeHandler: claudeHandler as unknown as { streamAgentEvents: ReturnType<typeof vi.fn> },
    useStream: (s: Stream) => {
      stream = s;
    },
  };
}

/** A turn that runs until released — the restart lands while it runs. */
function heldStream() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream: Stream = () =>
    (async function* () {
      yield { type: 'assistant_delta', text: 'working…' };
      await gate;
      yield { type: 'result', stopReason: 'end_turn', finalText: 'done' };
    })();
  return { stream, release };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('R1 — the reload lists the task the restart cut', () => {
  it('a working task is listed with its cut turn; an epic is not (its waker owns it)', async () => {
    const before = processOver(new SessionRegistry());
    const task = before.registry.createTask({ ownerId: OWNER, ownerName: 'R', workingDirectory: DIR, title: 'cut' });
    const epic = before.registry.createTask({
      ownerId: `${OWNER}E`,
      ownerName: 'R',
      workingDirectory: DIR,
      title: 'epic',
      kind: 'epic',
    } as never);
    const held = heldStream();
    before.useStream(held.stream);
    const key = `task:${task.taskId}`;
    const r = await before.controller.start({ actorUserId: OWNER, sessionKey: key, text: 'long job' });
    expect(r.status).toBe(202);
    const r2 = await before.controller.start({
      actorUserId: `${OWNER}E`,
      sessionKey: `task:${epic.taskId}`,
      text: 'go',
    });
    expect(r2.status).toBe(202);
    const cutTurn = before.registry.getSessionByKey(key)?.activeTaskTurnId;

    // The process dies here: a new one loads what is on disk.
    const restarted = new SessionRegistry();
    restarted.loadSessions();
    const listed = restarted.getRestartCutTasks();
    expect(listed).toContainEqual({ sessionKey: key, ownerId: OWNER, actorId: OWNER, turnId: cutTurn });
    expect(listed.map((t) => t.sessionKey)).not.toContain(`task:${epic.taskId}`);
    expect(restarted.getSessionByKey(key)?.lastTurnOutcome).toMatchObject({ turnId: cutTurn, outcome: 'interrupted' });

    held.release();
    await r.done;
    await r2.done;
  });
});

describe('R8 — a cut turn an approved writer started resumes as them, not as the owner (trinity R4, astra P1)', () => {
  it('the turn’s initiator is saved with its start, listed on reload, and the resume runs as them', async () => {
    const before = processOver(new SessionRegistry());
    const task = before.registry.createTask({ ownerId: OWNER, ownerName: 'R', workingDirectory: DIR, title: 'shared' });
    const key = `task:${task.taskId}`;
    const held = heldStream();
    before.useStream(held.stream);
    const writer = 'U0APPROVEDWRITER';
    expect((await before.controller.start({ actorUserId: writer, sessionKey: key, text: 'their step' })).status).toBe(
      202,
    );

    const restarted = new SessionRegistry();
    restarted.loadSessions();
    const listed = restarted.getRestartCutTasks().find((t) => t.sessionKey === key);
    expect(listed).toMatchObject({ ownerId: OWNER, actorId: writer });
    const start = vi.fn(async () => ({ status: 202, body: {} }));
    await createTaskRestartResumer({
      controller: { start },
      getSession: (k) => restarted.getSessionByKey(k),
      logger: { info: vi.fn(), warn: vi.fn() },
      schedule: () => {},
    }).resume([listed!]);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: writer }));

    held.release();
  });
});

describe('R9 — a record saved before the initiator was kept: the cut turn’s author, never the owner by default (trinity R4, astra P1)', () => {
  const session = { slackless: true, activityState: 'idle', lastTurnOutcome: { turnId: 't1', outcome: 'interrupted' } };
  const legacy: RestartCutTaskRef = { sessionKey: 'task:a', ownerId: OWNER, turnId: 't1' };
  const resumer = (author: string | undefined, start = vi.fn(async () => ({ status: 202, body: {} }))) => ({
    start,
    resumer: createTaskRestartResumer({
      controller: { start },
      getSession: () => session as unknown as ConversationSession,
      logger: { info: vi.fn(), warn: vi.fn() },
      schedule: () => {},
      readCutTurnAuthor: async () => author,
    }),
  });

  it('resumes as the author of the cut turn’s instruction (its conversation)', async () => {
    const h = resumer('U0APPROVEDWRITER');
    expect((await h.resumer.resume([legacy])).get('task:a')).toEqual({ status: 'started' });
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'U0APPROVEDWRITER' }));
  });

  it('no author on record: not resumed — the owner decides', async () => {
    const h = resumer(undefined);
    expect((await h.resumer.resume([legacy])).get('task:a')).toMatchObject({ status: 'skipped' });
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe('R10 — the author is the cut turn’s, never an earlier input (trinity R4, astra P1)', () => {
  const cut = 'task:11111111-2222-4333-8444-555555555555:1793691894606:d8316ab4-aace-43e4-839e-c56585058e50';
  it('reads the start time the turn id carries', () => {
    expect(taskTurnStartedAt(cut)).toBe(1793691894606);
    expect(taskTurnStartedAt('nonsense')).toBeUndefined();
  });
  it('the last user turn recorded at or after the cut turn started — its author', () => {
    const turns = [
      { role: 'user', timestamp: 1793691000000, userId: 'UADMIN' },
      { role: 'assistant', timestamp: 1793691000500 },
      { role: 'user', timestamp: 1793691894700, userId: 'U0APPROVEDWRITER' },
      { role: 'assistant', timestamp: 1793691895000 },
    ];
    expect(cutTurnAuthor(turns, cut)).toBe('U0APPROVEDWRITER');
  });
  it('the cut turn’s input never reached the disk: the earlier input is no proof — none', () => {
    const turns = [
      { role: 'user', timestamp: 1793691000000, userId: 'UADMIN' },
      { role: 'assistant', timestamp: 1793691000500 },
    ];
    expect(cutTurnAuthor(turns, cut)).toBeUndefined();
  });
  it('the read awaited and the plan was cancelled meanwhile: not resumed', async () => {
    const live: Record<string, unknown> = {
      slackless: true,
      activityState: 'idle',
      lastTurnOutcome: { turnId: 't1', outcome: 'interrupted' },
    };
    const start = vi.fn(async () => ({ status: 202, body: {} }));
    const out = await createTaskRestartResumer({
      controller: { start },
      getSession: () => live as unknown as ConversationSession,
      logger: { info: vi.fn(), warn: vi.fn() },
      schedule: () => {},
      readCutTurnAuthor: async () => {
        live.taskPlan = { state: 'cancelled', revision: 1 };
        return OWNER;
      },
    }).resume([{ sessionKey: 'task:a', ownerId: OWNER, turnId: 't1' }]);
    expect(out.get('task:a')).toMatchObject({ status: 'skipped' });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('R2 — the resumer starts the cut task’s next turn (end to end)', () => {
  it('as its owner; the conversation records the short line, the model reads the restart guidance first', async () => {
    const before = processOver(new SessionRegistry());
    const task = before.registry.createTask({
      ownerId: OWNER,
      ownerName: 'R',
      workingDirectory: DIR,
      title: 'plan job',
    });
    const key = `task:${task.taskId}`;
    const held = heldStream();
    before.useStream(held.stream);
    const r = await before.controller.start({ actorUserId: OWNER, sessionKey: key, text: 'step 3 of the plan' });
    expect(r.status).toBe(202);

    const restarted = new SessionRegistry();
    restarted.loadSessions();
    const after = processOver(restarted);
    const resumer = createTaskRestartResumer({
      controller: after.controller,
      getSession: (k) => restarted.getSessionByKey(k),
      logger: { info: vi.fn(), warn: vi.fn() },
      schedule: () => {},
    });
    const outcomes = await resumer.resume(restarted.getRestartCutTasks());
    expect(outcomes.get(key)).toEqual({ status: 'started' });

    await until(() => restarted.getSessionByKey(key)?.lastTurnOutcome?.outcome === 'completed');
    const prompt = String(after.claudeHandler.streamAgentEvents.mock.calls[0]?.[0] ?? '');
    expect(prompt.indexOf('<task-restart-resume>')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('<task-restart-resume>')).toBeLessThan(prompt.indexOf(TASK_RESTART_TEXT));
    const page = await readWorkLog(restarted.getSessionByKey(key)!.conversationId!);
    const instructions = page.entries.filter((e) => e.kind === 'instruction').map((e) => JSON.stringify(e));
    expect(instructions.some((e) => e.includes(TASK_RESTART_TEXT))).toBe(true);
    expect(instructions.some((e) => e.includes('<task-restart-resume>'))).toBe(false);

    held.release();
    await r.done;
  });
});

describe('R3 — the owner’s slot is busy: retried', () => {
  it('429 → scheduled again → started once the slot frees', async () => {
    const session = {
      slackless: true,
      activityState: 'idle',
      lastTurnOutcome: { turnId: 't1', outcome: 'interrupted' },
    } as unknown as ConversationSession;
    const replies = [
      { status: 429, body: { error: 'one dashboard task runs at a time — wait for it to finish' } },
      { status: 202, body: { ok: true } },
    ];
    const start = vi.fn(async () => replies.shift()!);
    const scheduled: Array<() => void> = [];
    const resumer = createTaskRestartResumer({
      controller: { start },
      getSession: () => session,
      logger: { info: vi.fn(), warn: vi.fn() },
      schedule: (fn) => scheduled.push(fn),
    });
    const task: RestartCutTaskRef = { sessionKey: 'task:a', ownerId: OWNER, actorId: OWNER, turnId: 't1' };
    expect((await resumer.resume([task])).get('task:a')).toEqual({ status: 'waiting' });
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await until(() => start.mock.calls.length === 2);
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionKey: 'task:a',
        actorUserId: OWNER,
        initiator: 'host',
        text: TASK_RESTART_TEXT,
        promptNotice: TASK_RESTART_NOTICE,
      }),
    );
  });

  it('another refusal (409, 503) is not retried', async () => {
    const session = {
      slackless: true,
      activityState: 'idle',
      lastTurnOutcome: { turnId: 't1', outcome: 'interrupted' },
    } as unknown as ConversationSession;
    const scheduled: Array<() => void> = [];
    const resumer = createTaskRestartResumer({
      controller: { start: vi.fn(async () => ({ status: 409, body: { error: 'the task is being closed' } })) },
      getSession: () => session,
      logger: { info: vi.fn(), warn: vi.fn() },
      schedule: (fn) => scheduled.push(fn),
    });
    const out = await resumer.resume([{ sessionKey: 'task:a', ownerId: OWNER, actorId: OWNER, turnId: 't1' }]);
    expect(out.get('task:a')).toMatchObject({ status: 'refused', code: 409 });
    expect(scheduled).toHaveLength(0);
  });
});

describe('R4 — skipped when resuming it would be wrong', () => {
  const cut: RestartCutTaskRef = { sessionKey: 'task:a', ownerId: OWNER, actorId: OWNER, turnId: 't1' };
  const base = { slackless: true, activityState: 'idle', lastTurnOutcome: { turnId: 't1', outcome: 'interrupted' } };
  it.each([
    ['gone', undefined, /gone/],
    [
      'a newer turn ran (someone went on)',
      { ...base, lastTurnOutcome: { turnId: 't2', outcome: 'completed' } },
      /went on/,
    ],
    ['an active goal (the goal loop resumes it)', { ...base, goal: { status: 'active' } }, /goal/],
    ['closed', { ...base, terminated: true }, /closed/],
    ['a submitted plan (the owner decides)', { ...base, taskPlan: { state: 'awaiting', revision: 1 } }, /awaiting/],
    ['a cancelled plan', { ...base, taskPlan: { state: 'cancelled', revision: 1 } }, /cancelled/],
    ['busy', { ...base, activityState: 'working' }, /not idle/],
  ])('%s', (_name, session, reason) => {
    expect(restartResumeSkip(session as unknown as ConversationSession, cut)).toMatch(reason);
  });
  it('the cut task itself is resumed', () => {
    expect(restartResumeSkip(base as unknown as ConversationSession, cut)).toBeNull();
  });
  it('an active goal is resumed here when the goal resume did not run at boot (trinity R4, fable P2)', () => {
    const withGoal = { ...base, goal: { status: 'active' } } as unknown as ConversationSession;
    expect(restartResumeSkip(withGoal, cut, { goalsResumed: false })).toBeNull();
    expect(restartResumeSkip(withGoal, cut, { goalsResumed: true })).toMatch(/goal/);
  });
});

describe('R7 — the wait for a busy slot is bounded like the goal loop’s (trinity R4, fable P2)', () => {
  it('gives up after TASK_GOAL_START_MAX_RETRIES tries — no cut task starts by surprise hours later', async () => {
    const start = vi.fn(async () => ({ status: 429, body: { error: 'one dashboard task runs at a time' } }));
    const scheduled: Array<() => void> = [];
    const session = {
      slackless: true,
      activityState: 'idle',
      lastTurnOutcome: { turnId: 't1', outcome: 'interrupted' },
    };
    const resumer = createTaskRestartResumer({
      controller: { start },
      getSession: () => session as unknown as ConversationSession,
      logger: { info: vi.fn(), warn: vi.fn() },
      schedule: (fn) => scheduled.push(fn),
    });
    await resumer.resume([{ sessionKey: 'task:a', ownerId: OWNER, actorId: OWNER, turnId: 't1' }]);
    while (scheduled.length) {
      scheduled.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(start).toHaveBeenCalledTimes(TASK_GOAL_START_MAX_RETRIES);
  });
});

describe('R5 — one task never runs two chains at once (trinity R1, grok P1 regression)', () => {
  it('two starts in the same tick (the resumer and a goal continuation): one runs, the other is refused', async () => {
    const p = processOver(new SessionRegistry());
    const task = p.registry.createTask({ ownerId: OWNER, ownerName: 'R', workingDirectory: DIR, title: 'race' });
    const key = `task:${task.taskId}`;
    const held = heldStream();
    p.useStream(held.stream);
    const [a, b] = await Promise.all([
      p.controller.start({ actorUserId: OWNER, sessionKey: key, text: TASK_RESTART_TEXT, initiator: 'host' }),
      p.controller.start({ actorUserId: OWNER, sessionKey: key, text: '[goal-continuation] go', initiator: 'host' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await until(() => p.claudeHandler.streamAgentEvents.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(p.claudeHandler.streamAgentEvents).toHaveBeenCalledTimes(1);
    held.release();
    await (a.status === 202 ? a.done : b.done);
  });
});

describe('R6 — the first goal continuation of a cut task carries the restart guidance (D10 on the goal path)', () => {
  const KEY = 'task:cut';
  const session = (turnId: string) => ({ lastTurnOutcome: { turnId, outcome: 'interrupted' } }) as never;
  const goalTurn = {
    sessionKey: KEY,
    text: '[goal-continuation] go',
    actorUserId: OWNER,
    initiator: 'host' as const,
    goalContinuation: true,
  };

  it('kept while the start is refused (429) and handed out with the turn that is taken — once (trinity R4, grok P1)', async () => {
    const replies = [
      { status: 429, body: { error: 'one dashboard task runs at a time' } },
      { status: 202, body: {} },
      { status: 202, body: {} },
    ];
    const start = vi.fn(async (_r: TaskCommandRequest) => replies.shift()!);
    const cut = new Map([[KEY, 't-cut']]);
    const startGoalTurn = createRestartNoticeStart({ start, getSession: () => session('t-cut'), cut });
    await startGoalTurn(goalTurn);
    await startGoalTurn(goalTurn);
    await startGoalTurn(goalTurn);
    expect(start.mock.calls.map((c) => c[0].promptNotice)).toEqual([
      TASK_RESTART_NOTICE,
      TASK_RESTART_NOTICE,
      undefined,
    ]);
    expect(cut.has(KEY)).toBe(false);
  });

  it('not for a turn that is no goal continuation, nor once a turn ran since the cut', async () => {
    const start = vi.fn(async (_r: TaskCommandRequest): Promise<TaskCommandResponse> => ({ status: 202, body: {} }));
    const cut = new Map([[KEY, 't-cut']]);
    const startGoalTurn = createRestartNoticeStart({ start, getSession: () => session('t-later'), cut });
    await startGoalTurn({ ...goalTurn, goalContinuation: undefined });
    expect(cut.has(KEY)).toBe(true);
    await startGoalTurn(goalTurn);
    expect(start.mock.calls.every((c) => c[0].promptNotice === undefined)).toBe(true);
    expect(cut.has(KEY)).toBe(false);
  });
});
