/**
 * #865 — the goal commands of a dashboard task (task-goal-commands.ts): the
 * same parser and goal semantics as a Slack thread's `goal …`, its notices in
 * the task's work log, and a goal that starts runs its opening turn through
 * the task controller — undone when that start is refused.
 *
 * The first case is the state the live test on dev left on de-aislop
 * (2026-11-03): goal `12345` stopped on a repeated failure, the same goal
 * queued behind it, and no way to clear either.
 */
import { setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';
import type { WorkLogInput } from '@soma/slack/work-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostGoalActionError } from '../../slack/goal-host-actions';
import type { ConversationSession, SessionGoal } from '../../types';
import { createTaskGoalCommands, type TaskGoalCommandDeps } from '../task-goal-commands';
import type { TaskCommandResponse } from '../task-turn-controller';

const KEY = 'task:11111111-2222-4333-8444-555555555555';

function goal(over: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'g1',
    objective: '12345',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'UOWNER',
    continuationCount: 1,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 3,
    ...over,
  };
}

function taskSession(over: Partial<ConversationSession> = {}): ConversationSession {
  return {
    slackless: true,
    channelId: '',
    ownerId: 'UOWNER',
    conversationId: 'conv-task',
    ...over,
  } as unknown as ConversationSession;
}

const recorded: Array<[string, WorkLogInput]> = [];
const notices = () => recorded.filter(([id]) => id === 'conv-task').map(([, e]) => e.text);

function harness(session: ConversationSession, opening: TaskCommandResponse = { status: 202, body: { ok: true } }) {
  const openings: Array<{ prompt: string; actor: string }> = [];
  const owedAtStart: Array<boolean | undefined> = [];
  const settings = {
    max: undefined as number | undefined,
    auto: false,
  };
  const deps: TaskGoalCommandDeps = {
    getSession: (k) => (k === KEY ? session : undefined),
    saveSessions: vi.fn(),
    broadcast: vi.fn(),
    kickLoop: vi.fn(),
    // As the controller does: an opening that starts clears its goal's owed first turn.
    startOpening: vi.fn(async (_key, prompt, actor, carry) => {
      openings.push({ prompt, actor });
      owedAtStart.push(session.goal?.goalId === carry.goalId ? session.goal?.openingPending : undefined);
      const queued = (opening.body as { queued?: unknown }).queued === true;
      const live = session.goal;
      if (live && opening.status === 202 && !queued && live.goalId === carry.goalId) live.openingPending = undefined;
      return opening;
    }),
    settings: {
      getUserGoalMaxContinuations: () => settings.max,
      setUserGoalMaxContinuations: (_u, v) => {
        settings.max = v;
      },
      toggleUserAutoGoalEnabled: () => {
        settings.auto = !settings.auto;
        return settings.auto;
      },
      setUserAutoGoalEnabled: (_u, on) => {
        settings.auto = on;
      },
    },
  };
  const commands = createTaskGoalCommands(deps);
  const run = (text: string, actorUserId = 'UOWNER') => commands.run({ sessionKey: KEY, text, actorUserId }, session);
  return { commands, run, deps, openings, settings, owedAtStart };
}

const message = (res: TaskCommandResponse) => String((res.body as { message?: unknown }).message ?? '');

describe('task goal commands (#865)', () => {
  beforeEach(() => {
    recorded.length = 0;
    setStreamExecutorProviders({ appendWorkLog: (id, entry) => recorded.push([id, entry]) });
  });
  afterEach(() => {
    setStreamExecutorProviders({ appendWorkLog: () => {} });
  });

  it('matches the Slack goal command forms, nothing else', () => {
    const { commands } = harness(taskSession());
    for (const text of ['goal', 'goal clear', '/goal pause', 'goal ship it', 'set goal max 5', 'GOAL done']) {
      expect(commands.matches(text)).toBe(true);
    }
    for (const text of ['goals are nice', 'set goal: ship it', 'please goal clear', 'goalie']) {
      expect(commands.matches(text)).toBe(false);
    }
  });

  it('`goal clear` on de-aislop’s stuck state: the goal, its duplicate and the history go; the work log says so', async () => {
    const stuck = goal({ stall: { at: 1 } as unknown as SessionGoal['stall'] });
    const session = taskSession({
      goal: stuck,
      goalQueue: [goal({ goalId: 'g2', status: 'queued', continuationCount: 0 })],
      goalHistory: [goal({ goalId: 'g0', status: 'complete' })],
      goalLastTurnText: 'last turn',
    });
    const h = harness(session);
    const res = await h.run('goal clear');
    expect(res.status).toBe(200);
    expect(message(res)).toBe('🧹 Goal cleared (also cleared 1 queued goal).');
    expect(session.goal).toBeUndefined();
    expect(session.goalQueue).toEqual([]);
    expect(session.goalHistory).toEqual([]);
    expect(session.goalLastTurnText).toBeUndefined();
    expect(h.deps.saveSessions).toHaveBeenCalled();
    expect(h.deps.broadcast).toHaveBeenCalled();
    expect(h.openings).toEqual([]);
    expect(notices()).toEqual(['🧹 Goal cleared (also cleared 1 queued goal).']);
  });

  it('`goal pause`: paused, its epoch moved (an in-flight eval is discarded), saved', async () => {
    const g = goal();
    const session = taskSession({ goal: g });
    const h = harness(session);
    const res = await h.run('goal pause');
    expect(res.status).toBe(200);
    expect(g.status).toBe('paused');
    expect(g.epoch).toBe(4);
    expect(notices()[0]).toMatch(/^⏸️ Goal paused/);
  });

  it('`goal resume` of a goal stopped on a repeated failure: it runs again — budget back, loop kicked', async () => {
    const g = goal({ continuationCount: 4, stall: { at: 1 } as unknown as SessionGoal['stall'] });
    const session = taskSession({ goal: g });
    const h = harness(session);
    const res = await h.run('goal resume');
    expect(res.status).toBe(200);
    expect(g.status).toBe('active');
    expect(g.stall).toBeUndefined();
    expect(g.continuationCount).toBe(0);
    expect(h.deps.kickLoop).toHaveBeenCalledWith(KEY);
    expect(message(res)).toMatch(/loop runs again/);
  });

  it('`goal <objective>` with no goal: set, and its opening turn runs the objective as the sender', async () => {
    const session = taskSession();
    const h = harness(session);
    const res = await h.run('goal ship the release notes', 'UINSTRUCTOR');
    expect(res.status).toBe(202);
    expect(session.goal).toMatchObject({
      objective: 'ship the release notes',
      status: 'active',
      createdBy: 'UINSTRUCTOR',
    });
    expect(h.openings).toEqual([{ prompt: 'ship the release notes', actor: 'UINSTRUCTOR' }]);
    // Its first turn was owed when the opening started (the loop leaves it alone until then).
    expect(h.owedAtStart).toEqual([true]);
    expect(session.goal?.openingPending).toBeUndefined();
    expect(message(res)).toMatch(/^🎯 Goal set: `ship the release notes`\nIts first turn is running\./);
    expect(notices()).toHaveLength(1);
  });

  it('an opening that waits behind the running turn says so', async () => {
    const h = harness(taskSession(), { status: 202, body: { ok: true, queued: true, itemId: 'tq-1' } });
    const res = await h.run('goal ship it');
    expect(res.status).toBe(202);
    expect((res.body as { queued?: unknown }).queued).toBe(true);
    expect(message(res)).toMatch(/starts as soon as the current turn ends/);
    expect(h.owedAtStart).toEqual([true]);
  });

  it('an opening the task refuses: the goal is not left set — state put back, the refusal is the answer', async () => {
    const before = goal({ status: 'complete', goalId: 'g0' });
    const session = taskSession({ goal: before, goalHistory: [before] });
    const h = harness(session, { status: 429, body: { error: 'one dashboard task runs at a time' } });
    const res = await h.run('goal ship it');
    expect(res.status).toBe(429);
    expect(String((res.body as { error?: unknown }).error)).toMatch(/^Goal was not set — .*one dashboard task/);
    expect(session.goal).toBe(before);
    expect(session.goal?.status).toBe('complete');
    expect(notices()[0]).toMatch(/^⚠️ Goal was not set/);
  });

  it('`goal <objective>` while a goal is in flight: queued behind it, no turn', async () => {
    const g = goal({ objective: 'first' });
    const session = taskSession({ goal: g });
    const h = harness(session);
    const res = await h.run('goal set second');
    expect(res.status).toBe(200);
    expect(session.goalQueue?.map((q) => q.objective)).toEqual(['second']);
    expect(g.epoch).toBe(3); // the running goal's eval stays valid
    expect(h.openings).toEqual([]);
  });

  it('`goal done` with a queue: complete, the next goal starts with its author', async () => {
    const g = goal({ objective: 'first' });
    const next = goal({ goalId: 'g2', objective: 'second', status: 'queued', createdBy: 'UOTHER' });
    const session = taskSession({ goal: g, goalQueue: [next] });
    const h = harness(session);
    const res = await h.run('goal done');
    expect(res.status).toBe(202);
    expect(g.status).toBe('complete');
    expect(g.completedVia).toBe('user');
    expect(session.goal).toBe(next);
    expect(next.status).toBe('active');
    expect(h.openings).toEqual([{ prompt: 'second', actor: 'UOTHER' }]);
  });

  it('`goal` shows the list and records nothing', async () => {
    const session = taskSession({
      goal: goal({ stall: { at: 1 } as unknown as SessionGoal['stall'] }),
      goalQueue: [goal({ goalId: 'g2', status: 'queued' })],
    });
    const h = harness(session);
    const res = await h.run('goal');
    expect(res.status).toBe(200);
    expect(message(res)).toContain('🎯 Current goal (active): `12345` · 1/10 auto-continuations');
    expect(message(res)).toContain('`goal resume` runs it again');
    expect(message(res)).toContain('📋 1 queued:\n1. `12345`');
    expect(notices()).toEqual([]);
  });

  it('`goal 12345` is the cap override, as in Slack (clamped to 1000) — never an objective', async () => {
    const session = taskSession();
    const h = harness(session);
    const res = await h.run('goal 12345');
    expect(res.status).toBe(200);
    expect(session.goal).toBeUndefined();
    expect(h.settings.max).toBe(1000);
    expect(h.openings).toEqual([]);
  });

  it('`goal max 20`: the sender’s default and the current goal', async () => {
    const g = goal();
    const h = harness(taskSession({ goal: g }));
    const res = await h.run('goal max 20');
    expect(res.status).toBe(200);
    expect(h.settings.max).toBe(20);
    expect(g.maxContinuations).toBe(20);
  });

  it('a bad objective is refused before anything changes', async () => {
    const session = taskSession();
    const h = harness(session);
    const res = await h.run(`goal ${'x'.repeat(5000)}`);
    expect(res.status).toBe(400);
    expect(session.goal).toBeUndefined();
    expect(h.openings).toEqual([]);
  });
});

describe('task goal list — the dashboard’s add / delete (#865)', () => {
  beforeEach(() => {
    recorded.length = 0;
    setStreamExecutorProviders({ appendWorkLog: (id, entry) => recorded.push([id, entry]) });
  });
  afterEach(() => {
    setStreamExecutorProviders({ appendWorkLog: () => {} });
  });

  it('delete the queued duplicate: gone, nothing promoted, nothing started', async () => {
    const session = taskSession({ goal: goal(), goalQueue: [goal({ goalId: 'g2', status: 'queued' })] });
    const h = harness(session);
    const result = await h.commands.hostAction(KEY, { action: 'delete', goalId: 'g2', expect: 'queued' }, 'UOWNER');
    expect(result).toEqual({ outcome: 'deleted', goalId: 'g2' });
    expect(session.goalQueue).toEqual([]);
    expect(session.goal?.goalId).toBe('g1');
    expect(h.openings).toEqual([]);
  });

  it('delete the current goal with one queued: the next is promoted and its opening runs', async () => {
    const next = goal({ goalId: 'g2', objective: 'the real goal', status: 'queued' });
    const session = taskSession({ goal: goal(), goalQueue: [next] });
    const h = harness(session);
    const result = await h.commands.hostAction(KEY, { action: 'delete', goalId: 'g1', expect: 'current' }, 'UOWNER');
    expect(result).toEqual({
      outcome: 'deleted',
      goalId: 'g1',
      promoted: { goalId: 'g2', objective: 'the real goal' },
    });
    expect(session.goal).toBe(next);
    expect(h.openings).toEqual([{ prompt: 'the real goal', actor: 'UOWNER' }]);
  });

  it('delete the current goal when its promotion cannot start: nothing is deleted (409/503 to the board)', async () => {
    const current = goal();
    const next = goal({ goalId: 'g2', objective: 'the real goal', status: 'queued' });
    const session = taskSession({ goal: current, goalQueue: [next] });
    const h = harness(session, { status: 429, body: { error: 'one dashboard task runs at a time' } });
    await expect(
      h.commands.hostAction(KEY, { action: 'delete', goalId: 'g1', expect: 'current' }, 'UOWNER'),
    ).rejects.toBeInstanceOf(HostGoalActionError);
    expect(session.goal).toBe(current);
    expect(session.goalQueue).toEqual([next]);
  });

  it('a stale delete (the goal moved) is refused with 409', async () => {
    const h = harness(taskSession({ goal: goal() }));
    await expect(
      h.commands.hostAction(KEY, { action: 'delete', goalId: 'gX', expect: 'current' }, 'UOWNER'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('add with no goal: started through the opening', async () => {
    const session = taskSession();
    const h = harness(session);
    const result = await h.commands.hostAction(KEY, { action: 'add', objective: 'ship it' }, 'UOWNER');
    expect(result).toMatchObject({ outcome: 'started', opening: 'started' });
    expect(h.openings).toEqual([{ prompt: 'ship it', actor: 'UOWNER' }]);
  });
});

describe('a goal’s opening across a restart (#865, astra-zhuge #876 R1 P2)', () => {
  it('the load keeps its goal id: a command-shaped objective stays an opening after a restart', async () => {
    const { sanitizeTaskFollowups } = await import('../task-followups');
    const saved = [
      {
        id: 'tq-1',
        text: 'goal clear',
        authorId: 'UOWNER',
        enqueuedAt: 1,
        epoch: 0,
        state: 'queued',
        goalOpeningId: 'g1',
      },
      {
        id: 'tq-2',
        text: 'goal clear',
        authorId: 'UOWNER',
        enqueuedAt: 2,
        epoch: 0,
        state: 'queued',
        goalOpeningId: 7,
      },
    ];
    const loaded = sanitizeTaskFollowups(JSON.parse(JSON.stringify(saved)));
    expect(loaded?.[0]).toMatchObject({ id: 'tq-1', goalOpeningId: 'g1', state: 'paused' });
    // Only a goal id marks an opening — anything else is an ordinary word.
    expect(loaded?.[1]).not.toHaveProperty('goalOpeningId');
  });
});

describe('a goal’s opening that will not run (astra-zhuge #876 R1 P1, R2)', () => {
  beforeEach(() => {
    recorded.length = 0;
    setStreamExecutorProviders({ appendWorkLog: (id, entry) => recorded.push([id, entry]) });
  });
  afterEach(() => {
    setStreamExecutorProviders({ appendWorkLog: () => {} });
  });

  it('cancelled while owed: its goal pauses; `goal resume` starts it from its first turn', async () => {
    const g = goal({ objective: 'ship it', continuationCount: 0, openingPending: true });
    const session = taskSession({ goal: g });
    const h = harness(session);
    h.commands.openingDropped(KEY, session, 'g1', 'cancelled');
    expect(g.status).toBe('paused');
    expect(g.openingPending).toBe(true);
    expect(g.epoch).toBe(4);
    expect(notices()[0]).toMatch(/^⏸️ Goal paused — its first turn was cancelled/);
    const res = await h.run('goal resume');
    expect(res.status).toBe(202);
    expect(g.status).toBe('active');
    expect(g.openingPending).toBeUndefined();
    expect(h.openings).toEqual([{ prompt: 'ship it', actor: 'UOWNER' }]);
  });

  it('cancelled after its goal already opened (not owed): nothing changes', () => {
    const g = goal();
    const session = taskSession({ goal: g });
    const h = harness(session);
    h.commands.openingDropped(KEY, session, 'g1', 'cancelled');
    expect(g.status).toBe('active');
    expect(h.deps.saveSessions).not.toHaveBeenCalled();
  });

  it('stale owes nothing — whatever the goal is now, the drop is the whole story', () => {
    for (const g of [goal({ goalId: 'g2' }), goal({ status: 'paused', openingPending: true }), undefined]) {
      const session = taskSession(g ? { goal: g } : {});
      const before = g ? { ...g } : undefined;
      const h = harness(session);
      h.commands.openingDropped(KEY, session, 'g1', 'stale');
      if (g) expect({ ...g }).toEqual(before);
      expect(h.deps.saveSessions).not.toHaveBeenCalled();
    }
    expect(notices()).toEqual([]);
  });

  it('after a restart the goal is active with its first turn owed: `goal resume` starts it', async () => {
    const g = goal({ objective: 'ship it', continuationCount: 0, openingPending: true });
    const session = taskSession({ goal: g });
    const h = harness(session);
    const res = await h.run('goal resume');
    expect(res.status).toBe(202);
    expect(h.openings).toEqual([{ prompt: 'ship it', actor: 'UOWNER' }]);
  });
});

describe('#876 R2 — repeats, settings and wrong words', () => {
  beforeEach(() => {
    recorded.length = 0;
    setStreamExecutorProviders({ appendWorkLog: (id, entry) => recorded.push([id, entry]) });
  });
  afterEach(() => {
    setStreamExecutorProviders({ appendWorkLog: () => {} });
  });

  it('the same `goal X` twice: set once, the repeat is answered — never queued behind itself (fable P3)', async () => {
    const session = taskSession();
    const h = harness(session);
    await h.run('goal ship it');
    const again = await h.run('goal  ship   it ');
    expect(again.status).toBe(200);
    expect(message(again)).toMatch(/^🎯 Goal already set — not added again/);
    expect(session.goalQueue ?? []).toEqual([]);
    expect(h.openings).toHaveLength(1);
  });

  it('a repeat of a paused goal says how to run it', async () => {
    const session = taskSession({ goal: goal({ objective: 'ship it', status: 'paused' }) });
    const res = await harness(session).run('goal ship it');
    expect(message(res)).toMatch(/paused — `goal resume` runs it/);
  });

  it('the goal list refuses a repeat with 409', async () => {
    const session = taskSession({
      goal: goal({ objective: 'first' }),
      goalQueue: [goal({ goalId: 'g2', objective: 'second', status: 'queued' })],
    });
    await expect(
      harness(session).commands.hostAction(KEY, { action: 'add', objective: 'second' }, 'UOWNER'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(session.goalQueue).toHaveLength(1);
  });

  it('`goal auto` and `goal max` with no goal change only the sender’s settings: answered, not in the task’s work log (grok P2)', async () => {
    const h = harness(taskSession());
    expect((await h.run('goal auto on')).status).toBe(200);
    expect((await h.run('goal max 20')).status).toBe(200);
    expect(h.settings).toMatchObject({ auto: true, max: 20 });
    expect(notices()).toEqual([]);
  });

  it('wrong words are refused with the usage (nothing applied)', async () => {
    const res = await harness(taskSession()).run('goal max x');
    expect(res.status).toBe(400);
    expect(String((res.body as { error?: unknown }).error)).toMatch(/^Goal command usage/);
  });

  it('opensGoal: only `goal <objective>` opens a goal', () => {
    const { commands } = harness(taskSession());
    expect(commands.opensGoal('goal ship it')).toBe(true);
    expect(commands.opensGoal('goal set ship it')).toBe(true);
    for (const t of ['goal', 'goal clear', 'goal pause', 'goal max 5', 'goal auto', 'ship it']) {
      expect(commands.opensGoal(t)).toBe(false);
    }
  });
});
