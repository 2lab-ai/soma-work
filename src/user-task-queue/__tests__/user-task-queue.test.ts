/**
 * The per-user task queue: a person may run `limit` tasks (threads) at once — 1 unless an admin set otherwise, no
 * limit for an admin. A new task over the limit waits in the person's queue and starts on its own when a running one
 * ends; the person may let it go first instead, which stops the running task and puts it right behind.
 */
import { describe, expect, it } from 'vitest';
import type { UserTaskEntry, UserTaskLedger } from '../ledger';
import { emptyLedger } from '../ledger';
import {
  type GateInput,
  type RunningTask,
  UNLIMITED,
  UserTaskQueue,
  type UserTaskQueueDeps,
  type UserTaskQueueNotifier,
} from '../user-task-queue';

interface Harness {
  queue: UserTaskQueue;
  running: Map<string, RunningTask[]>;
  limits: Map<string, number>;
  started: UserTaskEntry[];
  interrupted: RunningTask[];
  notices: string[];
  saved: UserTaskLedger[];
  clock: { now: number };
}

function harness(
  opts: { ledger?: UserTaskLedger; startThrows?: boolean; stop?: 'stopped' | 'pending' | 'gone' } = {},
): Harness {
  const running = new Map<string, RunningTask[]>();
  const limits = new Map<string, number>();
  const started: UserTaskEntry[] = [];
  const interrupted: RunningTask[] = [];
  const notices: string[] = [];
  const saved: UserTaskLedger[] = [];
  const clock = { now: 1_000 };
  let seq = 0;
  const notify: UserTaskQueueNotifier = {
    queued: (entry, ctx) => {
      notices.push(`queued:${entry.id}:${ctx.position}:${ctx.running.map((r) => r.sessionKey).join(',')}`);
    },
    started: (entry, how) => {
      notices.push(`started:${entry.id}:${how}`);
    },
    cancelled: (entry) => {
      notices.push(`cancelled:${entry.id}`);
    },
    deferred: (victim, first) => {
      notices.push(`deferred:${victim.sessionKey}:for:${first.sessionKey}`);
    },
  };
  const deps: UserTaskQueueDeps = {
    store: { load: () => opts.ledger, save: (l) => saved.push(structuredClone(l)) },
    limitFor: (user) => limits.get(user) ?? 1,
    runningTasks: (user) => running.get(user) ?? [],
    start: (entry) => {
      if (opts.startThrows) throw new Error('session gone');
      started.push(entry);
    },
    interrupt: (task) => {
      interrupted.push(task);
      return opts.stop ?? 'stopped';
    },
    notify,
    now: () => clock.now,
    newId: () => `t${++seq}`,
  };
  return { queue: new UserTaskQueue(deps), running, limits, started, interrupted, notices, saved, clock };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    userId: 'U1',
    sessionKey: 'C1:2.0',
    channel: 'C1',
    threadTs: '2.0',
    text: 'second task please',
    message: { user: 'U1', channel: 'C1', ts: '2.0', text: 'second task please' },
    continuation: 'none',
    admitted: false,
    ...over,
  };
}

const taskA: RunningTask = {
  sessionKey: 'C1:1.0',
  channel: 'C1',
  threadTs: '1.0',
  title: 'first task',
  startedAt: 500,
};

describe('UserTaskQueue.gate', () => {
  it('runs a task when the person has nothing running', () => {
    const h = harness();
    expect(h.queue.gate(input())).toEqual({ action: 'run' });
    expect(h.queue.snapshot().entries).toEqual([]);
  });

  it('queues a second task while one runs, says which runs and where it stands', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    const result = h.queue.gate(input());
    expect(result.action).toBe('queued');
    if (result.action !== 'queued') return;
    expect(result.position).toBe(1);
    expect(result.limit).toBe(1);
    expect(result.running).toEqual([taskA]);
    expect(result.entry).toMatchObject({
      userId: 'U1',
      kind: 'request',
      sessionKey: 'C1:2.0',
      state: 'waiting',
      preview: 'second task please',
    });
    expect(h.notices).toEqual(['queued:t1:1:C1:1.0']);
    expect(h.saved[h.saved.length - 1]?.entries).toHaveLength(1);
  });

  it('an admin (unlimited) is never queued', () => {
    const h = harness();
    h.limits.set('U1', UNLIMITED);
    h.running.set('U1', [taskA, { ...taskA, sessionKey: 'C1:1.5' }]);
    expect(h.queue.gate(input())).toEqual({ action: 'run' });
  });

  it('a limit of 2 lets a second task run and queues the third', () => {
    const h = harness();
    h.limits.set('U1', 2);
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(input())).toEqual({ action: 'run' });
    h.running.set('U1', [taskA, { ...taskA, sessionKey: 'C1:2.0' }]);
    expect(h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0' })).action).toBe('queued');
  });

  it('the thread itself does not count against its own message', () => {
    const h = harness();
    h.running.set('U1', [{ ...taskA, sessionKey: 'C1:2.0' }]);
    expect(h.queue.gate(input())).toEqual({ action: 'run' });
  });

  it('a new task never jumps ahead of one already waiting', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.running.set('U1', []);
    const third = h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0' }));
    expect(third.action).toBe('queued');
    if (third.action === 'queued') expect(third.position).toBe(2);
  });

  it('a host continuation of a running task passes (it is not a new task)', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(input({ continuation: 'pass' }))).toEqual({ action: 'run' });
    expect(h.queue.gate(input({ continuation: 'drop' }))).toEqual({ action: 'run' });
  });

  it('a thread with a waiting entry holds everything sent to it: a goal continuation is dropped, the rest waits', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    expect(h.queue.gate(input({ continuation: 'drop' }))).toEqual({ action: 'drop' });
    const host = h.queue.gate(input({ continuation: 'pass', text: 'PR checks finished' }));
    expect(host.action).toBe('queued');
    if (host.action === 'queued') expect(host.position).toBe(2);
  });

  it('a scheduled job whose fire already waits does not line up a second fire', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    const cron = { user: 'U1', channel: 'C1', ts: '5.0', text: 'daily', cron: { jobId: 'job-1', jobName: 'daily' } };
    expect(h.queue.gate(input({ sessionKey: 'C1:5.0', threadTs: '5.0', message: cron })).action).toBe('queued');
    expect(h.queue.gate(input({ sessionKey: 'C1:6.0', threadTs: '6.0', message: { ...cron, ts: '6.0' } }))).toEqual({
      action: 'drop',
    });
    const other = { ...cron, ts: '7.0', cron: { jobId: 'job-2', jobName: 'weekly' } };
    expect(h.queue.gate(input({ sessionKey: 'C1:7.0', threadTs: '7.0', message: other })).action).toBe('queued');
  });

  it('an admitted replay runs even over the limit', () => {
    const h = harness();
    h.running.set('U1', [taskA, { ...taskA, sessionKey: 'C1:1.5' }]);
    expect(h.queue.gate(input({ admitted: true }))).toEqual({ action: 'run' });
  });

  it('keeps a short preview of the request', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    const long = `${'가'.repeat(300)}\n\nmore`;
    const result = h.queue.gate(input({ text: long }));
    if (result.action !== 'queued') throw new Error('expected queued');
    expect(result.entry.preview.length).toBeLessThanOrEqual(120);
    expect(result.entry.preview.endsWith('…')).toBe(true);
  });
});

describe('UserTaskQueue.release', () => {
  it('starts the first waiting task when the running one ended, and marks it admitted until it arrives', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.release('U1');
    expect(h.started).toEqual([]);
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
    expect(h.queue.snapshot().entries[0]).toMatchObject({ id: 't1', state: 'admitted' });
    expect(h.notices).toContain('started:t1:turn');
    // An admitted entry still holds the slot: a second release starts nothing more.
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0' }));
    h.queue.release('U1');
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
  });

  it('the replay carrying the admission takes it once; a made-up id takes nothing', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.queue.takeAdmission('t1', 'C1:9.9')).toBe(false);
    expect(h.queue.takeAdmission('nope', 'C1:2.0')).toBe(false);
    expect(h.queue.takeAdmission('t1', 'C1:2.0')).toBe(true);
    expect(h.queue.takeAdmission('t1', 'C1:2.0')).toBe(false);
    expect(h.queue.snapshot().entries).toEqual([]);
  });

  it('a waiting entry is not admitted by a replay id', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    expect(h.queue.takeAdmission('t1', 'C1:2.0')).toBe(false);
  });

  it('an admission that never arrived expires and frees the slot', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0' }));
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
    h.clock.now += 10 * 60_000;
    h.queue.release('U1');
    expect(h.started.map((e) => e.id)).toEqual(['t1', 't2']);
  });

  it('a start that fails drops the entry and moves on to the next', () => {
    const h = harness({ startThrows: true });
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.queue.snapshot().entries).toEqual([]);
  });

  it('release with no user looks at everyone who waits', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.running.set('U2', [{ ...taskA, sessionKey: 'C2:1.0' }]);
    h.queue.gate(input());
    h.queue.gate(input({ userId: 'U2', sessionKey: 'C2:2.0', channel: 'C2' }));
    h.running.clear();
    h.queue.release();
    expect(h.started.map((e) => e.userId).sort()).toEqual(['U1', 'U2']);
  });

  it('after a restart an admission that was on its way waits again', () => {
    const entry: UserTaskEntry = {
      id: 'old',
      userId: 'U1',
      kind: 'request',
      sessionKey: 'C1:2.0',
      channel: 'C1',
      threadTs: '2.0',
      preview: 'x',
      enqueuedAt: 1,
      state: 'admitted',
      admittedAt: 2,
    };
    const h = harness({ ledger: { ...emptyLedger(), entries: [entry] } });
    expect(h.queue.snapshot().entries[0].state).toBe('waiting');
  });
});

describe('UserTaskQueue.bypass (먼저 진행)', () => {
  it('stops the running task, starts this one now, and puts the stopped one first in line', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0' }));
    const result = h.queue.bypass('t1', 'U1');
    expect(result).toMatchObject({ ok: true, deferred: taskA });
    expect(h.interrupted).toEqual([taskA]);
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
    const entries = h.queue.snapshot().entries;
    expect(entries.map((e) => [e.sessionKey, e.kind, e.state])).toEqual([
      ['C1:2.0', 'request', 'admitted'],
      ['C1:1.0', 'resume', 'waiting'],
      ['C1:3.0', 'request', 'waiting'],
    ]);
    expect(h.notices).toContain('deferred:C1:1.0:for:C1:2.0');
    expect(h.notices).toContain('started:t1:bypass');
  });

  it('with a free slot it just goes first (nothing is stopped)', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0' }));
    h.running.set('U1', []);
    // The slot is free but the first entry has not been released yet: going first starts this one.
    expect(h.queue.bypass('t2', 'U1')).toMatchObject({ ok: true });
    expect(h.interrupted).toEqual([]);
    expect(h.started.map((e) => e.id)).toEqual(['t2']);
  });

  it('defers the task that started last when more than one runs', () => {
    const h = harness();
    h.limits.set('U1', 2);
    const older = { ...taskA, sessionKey: 'C1:0.5', startedAt: 100 };
    h.running.set('U1', [older, taskA]);
    h.queue.gate(input());
    expect(h.queue.bypass('t1', 'U1')).toMatchObject({ ok: true, deferred: taskA });
  });

  it('only the person (or an admin) may let their task go first', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    expect(h.queue.bypass('t1', 'U2')).toEqual({ ok: false, reason: 'forbidden' });
    expect(h.queue.bypass('t1', 'U2', { admin: true })).toMatchObject({ ok: true });
  });

  it('a stopped task resumes when the one that went first ends', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.bypass('t1', 'U1');
    expect(h.queue.takeAdmission('t1', 'C1:2.0')).toBe(true);
    h.running.set('U1', [{ ...taskA, sessionKey: 'C1:2.0' }]);
    h.queue.release('U1');
    expect(h.started.map((e) => e.kind)).toEqual(['request']);
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.started.map((e) => [e.kind, e.sessionKey])).toEqual([
      ['request', 'C1:2.0'],
      ['resume', 'C1:1.0'],
    ]);
  });

  it('a turn still starting: the entry goes first and waits for the stop; nothing runs beside it', () => {
    const h = harness({ stop: 'pending' });
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    expect(h.queue.bypass('t1', 'U1')).toMatchObject({ ok: true, deferred: taskA, pending: true });
    expect(h.started).toEqual([]);
    expect(h.queue.snapshot().entries.map((e) => [e.sessionKey, e.kind, e.state])).toEqual([
      ['C1:2.0', 'request', 'waiting'],
      ['C1:1.0', 'resume', 'waiting'],
    ]);
    // The stop landed: the stopped thread is told; once its slot frees, the entry that went first starts as such.
    h.queue.stopResolved('C1:1.0', true);
    expect(h.notices).toContain('deferred:C1:1.0:for:C1:2.0');
    expect(h.started).toEqual([]);
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
    expect(h.notices).toContain('started:t1:bypass');
  });

  it('a stop that never lands (the turn ended by itself, or time ran out) does not carry the task on', () => {
    const h = harness({ stop: 'pending' });
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.bypass('t1', 'U1');
    h.queue.stopResolved('C1:1.0', false);
    expect(h.queue.snapshot().entries.map((e) => e.kind)).toEqual(['request']);
    expect(h.notices.some((n) => n.startsWith('deferred:'))).toBe(false);
    // Still at the limit: it waits for the running task to end.
    expect(h.started).toEqual([]);
  });

  it('a task that already ended is not stopped: the entry starts now', () => {
    const h = harness({ stop: 'gone' });
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    expect(h.queue.bypass('t1', 'U1')).toEqual({ ok: true });
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
    expect(h.queue.snapshot().entries.some((e) => e.kind === 'resume')).toBe(false);
  });

  it('refuses an entry that is not waiting', () => {
    const h = harness();
    expect(h.queue.bypass('missing', 'U1')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('UserTaskQueue.cancel and reads', () => {
  it('cancel takes the entry out of line and says so', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    expect(h.queue.cancel('t1', 'U2')).toEqual({ ok: false, reason: 'forbidden' });
    expect(h.queue.cancel('t1', 'U1')).toEqual({ ok: true });
    expect(h.queue.snapshot().entries).toEqual([]);
    expect(h.notices).toContain('cancelled:t1');
  });

  it('view: what runs, what waits and in which order, for one person', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0', text: 'third' }));
    const view = h.queue.viewFor('U1');
    expect(view.limit).toBe(1);
    expect(view.running).toEqual([taskA]);
    expect(view.waiting.map((w) => [w.id, w.position, w.preview])).toEqual([
      ['t1', 1, 'second task please'],
      ['t2', 2, 'third'],
    ]);
    expect(h.queue.waitingEntryFor('C1:3.0')?.id).toBe('t2');
    expect(h.queue.waitingEntryFor('C1:1.0')).toBeUndefined();
    expect(h.queue.usersWaiting()).toEqual(['U1']);
  });

  it('setNotice remembers where the Slack notice is', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.setNotice('t1', { channel: 'C1', ts: '2.1' });
    expect(h.queue.snapshot().entries[0].notice).toEqual({ channel: 'C1', ts: '2.1' });
  });
});
