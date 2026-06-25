/**
 * Goal queue (multi-goal) behavior — autoz feature/goal-queue-restart-resume.
 *
 * Pins the three user requirements:
 *   T2 — typing `goal <text>` while a goal is in flight APPENDS to a queue
 *        instead of replacing; completing the current goal advances to the
 *        next queued goal.
 *   T3 — bare `goal` renders the current goal + the queue + completed history,
 *        each with its time / token spend and completion result.
 *
 * (T1 — restart resume — is covered in slack-handler tests.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../../types';
import { advanceGoalQueue, createActiveSessionGoal, enqueueOrActivateGoal } from '../../session-goal';
import { GoalHandler } from '../goal-handler';
import type { CommandContext, CommandDependencies } from '../types';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U123',
    channel: 'C123',
    threadTs: '171.001',
    text: 'goal',
    say: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    ...overrides,
  };
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U123',
    ownerName: 'Tester',
    userId: 'U123',
    channelId: 'C123',
    threadTs: '171.001',
    isActive: true,
    lastActivity: new Date(),
    state: 'MAIN',
    workflow: 'default',
    systemPrompt: 'cached prompt',
    ...overrides,
  } as ConversationSession;
}

function makeDeps(session?: ConversationSession): CommandDependencies {
  return {
    claudeHandler: {
      getSession: vi.fn().mockReturnValue(session),
      saveSessions: vi.fn(),
    },
    slackApi: {
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'msg_ts' }),
    },
  } as unknown as CommandDependencies;
}

describe('session-goal queue helpers', () => {
  it('enqueueOrActivateGoal activates when no goal is set', () => {
    const session = makeSession();
    const result = enqueueOrActivateGoal(session, 'first goal', 'U1');
    expect(result.activated).toBe(true);
    expect(session.goal?.objective).toBe('first goal');
    expect(session.goal?.status).toBe('active');
    expect(session.goal?.goalId).toBeTruthy();
    expect(session.goalQueue ?? []).toHaveLength(0);
  });

  it('enqueueOrActivateGoal appends to the queue when a goal is already active', () => {
    const session = makeSession({ goal: createActiveSessionGoal('first goal', 'U1') });
    const result = enqueueOrActivateGoal(session, 'second goal', 'U1');
    expect(result.activated).toBe(false);
    expect(result.position).toBe(1);
    // current goal untouched
    expect(session.goal?.objective).toBe('first goal');
    expect(session.goalQueue).toHaveLength(1);
    expect(session.goalQueue?.[0].objective).toBe('second goal');
    expect(session.goalQueue?.[0].status).toBe('queued');
  });

  it('advanceGoalQueue promotes the next queued goal and archives the finished one', () => {
    const active = createActiveSessionGoal('first goal', 'U1');
    active.epoch = 5;
    const session = makeSession({ goal: active });
    // queue while the first goal is still active (real flow)
    enqueueOrActivateGoal(session, 'second goal', 'U1');
    // now the first goal completes
    session.goal!.status = 'complete';

    const next = advanceGoalQueue(session);
    expect(next?.objective).toBe('second goal');
    expect(session.goal?.objective).toBe('second goal');
    expect(session.goal?.status).toBe('active');
    expect(session.goal?.continuationCount).toBe(0);
    // epoch rebased strictly past the finished goal so a stale eval can't apply
    expect((session.goal?.epoch ?? 0) > 5).toBe(true);
    expect(session.goalQueue ?? []).toHaveLength(0);
    expect(session.goalHistory).toHaveLength(1);
    expect(session.goalHistory?.[0].objective).toBe('first goal');
  });

  it('advanceGoalQueue keeps the completed goal visible when the queue is empty', () => {
    const finished = createActiveSessionGoal('only goal', 'U1');
    finished.status = 'complete';
    const session = makeSession({ goal: finished });
    const next = advanceGoalQueue(session);
    expect(next).toBeUndefined();
    expect(session.goalHistory).toHaveLength(1);
  });
});

describe('GoalHandler — queue behavior (T2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('appends to the queue (does NOT replace) when a goal is already active', async () => {
    const session = makeSession({ goal: createActiveSessionGoal('first goal', 'U123') });
    const deps = makeDeps(session);
    const handler = new GoalHandler(deps);

    const result = await handler.execute(makeCtx({ text: 'goal second goal' }));

    // current goal must NOT change, and no continuation is started for the queued one
    expect(session.goal?.objective).toBe('first goal');
    expect(session.goalQueue).toHaveLength(1);
    expect(session.goalQueue?.[0].objective).toBe('second goal');
    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toBeUndefined();
    expect(deps.claudeHandler.saveSessions).toHaveBeenCalled();
  });

  it('starts the goal (activated) when none is in flight', async () => {
    const session = makeSession();
    const deps = makeDeps(session);
    const handler = new GoalHandler(deps);

    const result = await handler.execute(makeCtx({ text: 'goal ship it' }));

    expect(session.goal?.objective).toBe('ship it');
    expect(result.continueWithPrompt).toBeTruthy();
  });

  it('`goal done` advances to the next queued goal and continues it', async () => {
    const session = makeSession({ goal: createActiveSessionGoal('first goal', 'U123') });
    enqueueOrActivateGoal(session, 'second goal', 'U123');
    const deps = makeDeps(session);
    const handler = new GoalHandler(deps);

    const result = await handler.execute(makeCtx({ text: 'goal done' }));

    expect(session.goal?.objective).toBe('second goal');
    expect(session.goal?.status).toBe('active');
    expect(session.goalHistory?.[0].objective).toBe('first goal');
    expect(session.goalHistory?.[0].completedVia).toBe('user');
    // advancing to a queued goal re-enters the loop
    expect(result.continueWithPrompt).toBeTruthy();
  });
});

describe('GoalHandler — status with list + metrics (T3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders the current goal, the queue, and completed history with metrics', async () => {
    const current = createActiveSessionGoal('current goal', 'U123');
    current.activeMsUsed = 65_000; // 1m 5s
    current.tokensInput = 1200;
    current.tokensOutput = 340;
    const done = createActiveSessionGoal('done goal', 'U123');
    done.status = 'complete';
    done.completionReason = 'all acceptance criteria met';
    done.activeMsUsed = 12_000;
    const session = makeSession({ goal: current, goalHistory: [done] });
    enqueueOrActivateGoal(session, 'queued goal', 'U123');
    const deps = makeDeps(session);
    const handler = new GoalHandler(deps);

    await handler.execute(makeCtx({ text: 'goal' }));

    const msg = (deps.slackApi.postSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    // current goal + its metrics
    expect(msg).toContain('current goal');
    expect(msg).toMatch(/1m\s*5s|65s|1:05/); // some human-readable duration
    // queue
    expect(msg).toContain('queued goal');
    // history with completion result
    expect(msg).toContain('done goal');
    expect(msg).toContain('all acceptance criteria met');
  });
});
