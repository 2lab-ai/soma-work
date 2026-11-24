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
  opts: {
    ledger?: UserTaskLedger;
    startThrows?: boolean | ((entry: UserTaskEntry) => boolean);
    stop?: 'stopped' | 'pending' | 'gone';
  } = {},
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
      if (ctx.ahead) notices.push(`ahead:${entry.id}:${ctx.ahead.sessionKey}`);
    },
    started: (entry, how) => {
      notices.push(`started:${entry.id}:${how}`);
    },
    cancelled: (entry, why) => {
      notices.push(why === 'closed' ? `cancelled:${entry.id}:closed` : `cancelled:${entry.id}`);
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
      const fails = typeof opts.startThrows === 'function' ? opts.startThrows(entry) : opts.startThrows;
      if (fails) throw new Error('session gone');
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
    // Each is its own message (its own ts): a copy of the first would be a duplicate instead.
    expect(h.queue.gate(input({ continuation: 'drop', message: { ts: '2.7' } }))).toEqual({ action: 'drop' });
    const host = h.queue.gate(input({ continuation: 'pass', text: 'PR checks finished', message: { ts: '2.8' } }));
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
    const h = harness({ startThrows: (e) => e.sessionKey === 'C1:2.0' });
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0' }));
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.started.map((e) => e.sessionKey)).toEqual(['C1:3.0']);
    expect(h.queue.snapshot().entries.map((e) => [e.sessionKey, e.state])).toEqual([['C1:3.0', 'admitted']]);
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
    // The stop landed and the stopped turn let go of its slot: the stopped thread is told, and the entry that went
    // first takes that slot now, as such.
    h.running.set('U1', []);
    h.queue.stopResolved('C1:1.0', true, true);
    expect(h.notices).toContain('deferred:C1:1.0:for:C1:2.0');
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
    expect(h.notices).toContain('started:t1:bypass');
  });

  it("the entry that went first takes the stopped task's slot even when the person runs others over the limit", () => {
    // An admin lowered the limit while two ran: the slot 먼저 진행 freed is the entry's, whatever else still runs.
    const older: RunningTask = { ...taskA, sessionKey: 'C1:0.5', threadTs: '0.5', startedAt: 100 };
    const h = harness({ stop: 'pending' });
    h.running.set('U1', [older, taskA]);
    h.queue.gate(input());
    expect(h.queue.bypass('t1', 'U1')).toMatchObject({ ok: true, deferred: taskA, pending: true });
    h.running.set('U1', [older]);
    h.queue.stopResolved('C1:1.0', true, true);
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
    expect(h.notices).toContain('started:t1:bypass');
    // The stopped task waits right behind, and carries on once the person is under the limit again.
    expect(h.queue.snapshot().entries.map((e) => [e.sessionKey, e.kind, e.state])).toEqual([
      ['C1:2.0', 'request', 'admitted'],
      ['C1:1.0', 'resume', 'waiting'],
    ]);
  });

  it('a stop that landed on a turn that never let go of its slot starts nothing beside it', () => {
    const h = harness({ stop: 'pending' });
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.bypass('t1', 'U1');
    h.queue.stopResolved('C1:1.0', true, false);
    expect(h.notices).toContain('deferred:C1:1.0:for:C1:2.0');
    expect(h.started).toEqual([]);
    // First in line: the next release once its slot is free starts it.
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
  });

  it('a stop that never lands (the turn ended by itself) does not carry the task on; the entry takes its slot', () => {
    const h = harness({ stop: 'pending' });
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.bypass('t1', 'U1');
    h.running.set('U1', []);
    h.queue.stopResolved('C1:1.0', false, true);
    expect(h.queue.snapshot().entries.map((e) => [e.kind, e.state])).toEqual([['request', 'admitted']]);
    expect(h.notices.some((n) => n.startsWith('deferred:'))).toBe(false);
    expect(h.started.map((e) => e.id)).toEqual(['t1']);
  });

  it('a stop that never lands while the turn still runs (time ran out): no carry-on, the entry waits', () => {
    const h = harness({ stop: 'pending' });
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.bypass('t1', 'U1');
    h.queue.stopResolved('C1:1.0', false, false);
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

// a shared dev host (2026-11-24): a pr-watch CI message for a thread whose session its owner then closed waited in line as a
// person's request and was replayed into the closed thread ten minutes later, after its PR had merged.
describe('host events and closed threads', () => {
  it("hasFreeSlot: a host event of the person's runs only with a free slot and nothing of theirs waiting", () => {
    const h = harness();
    expect(h.queue.hasFreeSlot('U1', 'C1:9.0')).toBe(true);
    h.running.set('U1', [taskA]);
    expect(h.queue.hasFreeSlot('U1', 'C1:9.0')).toBe(false);
    // The running thread's own host event is no second task.
    expect(h.queue.hasFreeSlot('U1', 'C1:1.0')).toBe(true);
    h.limits.set('U1', 2);
    expect(h.queue.hasFreeSlot('U1', 'C1:9.0')).toBe(true);
    // Two run, a request waits; one ends — the waiting request goes first, not the host event.
    h.running.set('U1', [taskA, { ...taskA, sessionKey: 'C1:5.0', threadTs: '5.0' }]);
    expect(h.queue.gate(input()).action).toBe('queued');
    h.running.set('U1', [taskA]);
    expect(h.queue.hasFreeSlot('U1', 'C1:9.0')).toBe(false);
    h.limits.set('U1', UNLIMITED);
    expect(h.queue.hasFreeSlot('U1', 'C1:9.0')).toBe(true);
  });

  it('dropSession: a closed thread leaves the line, and its notice says why', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0', text: 'third' }));
    expect(h.queue.dropSession('C1:2.0')).toBe(1);
    expect(h.queue.snapshot().entries.map((e) => e.sessionKey)).toEqual(['C1:3.0']);
    expect(h.notices).toContain('cancelled:t1:closed');
    expect(h.queue.dropSession('C1:2.0')).toBe(0);
    // What is left moves up.
    expect(h.queue.viewFor('U1').waiting.map((w) => w.position)).toEqual([1]);
  });

  it('the queued notice names the entry right ahead of a second one', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0', text: 'third' }));
    expect(h.notices).toContain('queued:t2:2:C1:1.0');
    expect(h.notices).toContain('ahead:t2:C1:2.0');
    expect(h.notices.some((n) => n.startsWith('ahead:t1:'))).toBe(false);
  });
});

describe('먼저 진행 never stops a guarded task', () => {
  const guarded: RunningTask = {
    ...taskA,
    sessionKey: 'C1:7.0',
    threadTs: '7.0',
    startedAt: 900,
    guard: 'deploy:dev2',
  };

  it('the newest unguarded task is stopped, even when a guarded one started later', () => {
    const h = harness();
    h.running.set('U1', [taskA, guarded]);
    h.limits.set('U1', 2);
    h.queue.gate(input());
    expect(h.queue.bypass('t1', 'U1')).toMatchObject({ ok: true, deferred: taskA });
    expect(h.interrupted.map((t) => t.sessionKey)).toEqual(['C1:1.0']);
  });

  it('every running task guarded: refused, nothing stopped, the entry keeps its place', () => {
    const h = harness();
    h.running.set('U1', [guarded]);
    h.queue.gate(input());
    expect(h.queue.bypass('t1', 'U1')).toEqual({ ok: false, reason: 'protected', guard: 'deploy:dev2' });
    expect(h.interrupted).toEqual([]);
    expect(h.queue.snapshot().entries.map((e) => [e.id, e.state])).toEqual([['t1', 'waiting']]);
  });
});

// Review of #1413 (P1): a host event that saw a free slot must hold it until it reaches the gate — a request arriving
// in between, or a second host event, must not take the same slot.
describe('host turn reservations', () => {
  it('a reservation holds the slot: another request waits, a second reservation is refused', () => {
    const h = harness();
    expect(h.queue.reserveHostTurn('U1', 'C1:9.0')).toBe(true);
    expect(h.queue.hasFreeSlot('U1', 'C1:8.0')).toBe(false);
    expect(h.queue.reserveHostTurn('U1', 'C1:8.0')).toBe(false);
    expect(h.queue.gate(input()).action).toBe('queued');
  });

  it('the reserved event takes its reservation at the gate, once', () => {
    const h = harness();
    h.queue.reserveHostTurn('U1', 'C1:9.0');
    const reserved = { ...input({ sessionKey: 'C1:9.0', threadTs: '9.0' }), hostReserved: true };
    expect(h.queue.gate(reserved)).toEqual({ action: 'run' });
    // Taken: another task now holds the one slot; the same event again has no reservation left to run on.
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(reserved)).toEqual({ action: 'drop' });
    expect(h.queue.snapshot().entries).toEqual([]);
  });

  // #1413 review round 2: a host event whose reservation is gone never becomes a request in the ledger — there a merged
  // PR could no longer take it back.
  it('a marked event without a reservation runs only into a free slot; otherwise it is dropped, never queued', () => {
    const h = harness();
    const marked = { ...input({ sessionKey: 'C1:9.0', threadTs: '9.0' }), hostReserved: true };
    expect(h.queue.gate(marked)).toEqual({ action: 'run' });
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(marked)).toEqual({ action: 'drop' });
    expect(h.queue.snapshot().entries).toEqual([]);
  });

  it('releaseHostTurn gives back a reservation whose event never arrived', () => {
    const h = harness();
    h.queue.reserveHostTurn('U1', 'C1:9.0');
    h.queue.releaseHostTurn('C1:9.0');
    expect(h.queue.hasFreeSlot('U1', 'C1:8.0')).toBe(true);
  });

  it('a reservation for a thread that already holds an admission is one slot, not two', () => {
    const h = harness();
    h.limits.set('U1', 2);
    // Thread 2.0 waits, then is admitted (on its way); pr-watch reserves for the same thread.
    h.running.set('U1', [taskA, { ...taskA, sessionKey: 'C1:5.0', threadTs: '5.0' }]);
    h.queue.gate(input());
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.queue.snapshot().entries.map((e) => e.state)).toEqual(['admitted']);
    expect(h.queue.reserveHostTurn('U1', 'C1:2.0')).toBe(true);
    // One slot held (thread 2.0), one free: a request for another thread runs.
    expect(h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0' })).action).toBe('run');
  });

  it('an unused reservation expires and frees the slot', () => {
    const h = harness();
    h.queue.reserveHostTurn('U1', 'C1:9.0');
    h.clock.now += 3 * 60_000;
    expect(h.queue.hasFreeSlot('U1', 'C1:8.0')).toBe(true);
  });
});

// A shared dev host (2026-11-24): the bot acked one app_mention too late, Slack sent it four more times
// (retry_attempt 1..3, reason timeout), and each copy lined up as a new entry with its own notice — the same request
// five times in line, which would have run five times.
describe('a Slack redelivery is one request', () => {
  const msg = (ts: string) => ({ user: 'U1', channel: 'C1', ts, text: 'review PR #816' });

  it('the same message for the same thread lines up once; the copies are duplicates', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(input({ message: msg('2.5') })).action).toBe('queued');
    expect(h.queue.gate(input({ message: msg('2.5') }))).toMatchObject({ action: 'duplicate' });
    expect(h.queue.gate(input({ message: msg('2.5') }))).toMatchObject({ action: 'duplicate' });
    expect(h.queue.snapshot().entries).toHaveLength(1);
    expect(h.notices.filter((n) => n.startsWith('queued:'))).toHaveLength(1);
    // Another message in that thread is not a copy.
    expect(h.queue.gate(input({ message: msg('2.6') })).action).toBe('queued');
  });

  it('a copy that arrives after the entry started, or after it was cancelled, is still a duplicate', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input({ message: msg('2.5') }));
    h.running.set('U1', []);
    h.queue.release('U1');
    expect(h.queue.takeAdmission('t1', 'C1:2.0')).toBe(true);
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(input({ message: msg('2.5') }))).toMatchObject({ action: 'duplicate' });

    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0', message: msg('3.5') }));
    h.queue.cancel('t2', 'U1');
    expect(h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0', message: msg('3.5') }))).toMatchObject({
      action: 'duplicate',
    });
  });

  // Review of #1414: the memory comes before the capacity checks — a free slot must not rerun what already left.
  it('a late copy is a duplicate even when the person has a free slot again', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input({ message: msg('2.5') }));
    h.running.set('U1', []);
    h.queue.release('U1');
    h.queue.takeAdmission('t1', 'C1:2.0');
    expect(h.queue.gate(input({ message: msg('2.5') }))).toEqual({ action: 'duplicate' });
    h.running.set('U1', [taskA]);
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0', message: msg('3.5') }));
    h.queue.cancel('t2', 'U1');
    h.running.set('U1', []);
    expect(h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0', message: msg('3.5') }))).toEqual({
      action: 'duplicate',
    });
  });

  it('a late copy of a message whose session was closed is a duplicate, free slot or not', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input({ message: msg('2.5') }));
    expect(h.queue.dropSession('C1:2.0')).toBe(1);
    h.running.set('U1', []);
    expect(h.queue.gate(input({ message: msg('2.5') }))).toEqual({ action: 'duplicate' });
  });

  it('host turns without a Slack ts of their own are never taken for copies', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    const first = h.queue.gate(input({ continuation: 'pass', text: 'CI passed', message: { text: 'CI passed' } }));
    const second = h.queue.gate(input({ continuation: 'pass', text: 'review in', message: { text: 'review in' } }));
    expect([first.action, second.action]).toEqual(['queued', 'queued']);
    expect(h.queue.snapshot().entries).toHaveLength(3);
  });

  it('the memory of a message that left the line lasts long enough for Slack to stop retrying, not forever', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input({ message: msg('2.5') }));
    h.queue.cancel('t1', 'U1');
    // Slack's retries come seconds to minutes later: still a duplicate just before the memory ends…
    h.clock.now += 29 * 60_000;
    expect(h.queue.gate(input({ message: msg('2.5') }))).toMatchObject({ action: 'duplicate' });
    // …and a new request once it has.
    h.clock.now += 2 * 60_000;
    expect(h.queue.gate(input({ message: msg('2.5') })).action).toBe('queued');
  });

  it('copies already in a saved line are folded into the first on load', () => {
    const entry = (id: string, ts: string, sessionKey = 'C1:2.0') => ({
      id,
      userId: 'U1',
      kind: 'request' as const,
      sessionKey,
      channel: 'C1',
      threadTs: sessionKey.split(':')[1],
      preview: 'p',
      enqueuedAt: 1,
      state: 'waiting' as const,
      message: { channel: 'C1', ts },
    });
    const h = harness({
      ledger: {
        ...emptyLedger(),
        entries: [entry('a', '2.5'), entry('b', '9.9', 'C1:9.0'), entry('c', '2.5'), entry('d', '2.5')],
      },
    });
    expect(h.queue.snapshot().entries.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

// Z (2026-11-24): raising a person's limit starts what waits at once — even when the first in line cannot start yet
// because its own thread still runs.
describe('a freed slot goes to the first entry that can start', () => {
  it('an entry whose own thread still runs is passed over; the next one takes the slot', () => {
    const h = harness();
    const busyThread: RunningTask = { ...taskA, sessionKey: 'C1:2.0', threadTs: '2.0' };
    h.running.set('U1', [taskA]);
    h.queue.gate(input());
    h.queue.gate(input({ sessionKey: 'C1:3.0', threadTs: '3.0', message: { ts: '3.5' } }));
    // The first entry's thread runs (a turn of it went on); the limit goes to 3.
    h.running.set('U1', [taskA, busyThread]);
    h.limits.set('U1', 3);
    h.queue.release('U1');
    expect(h.started.map((e) => e.sessionKey)).toEqual(['C1:3.0']);
    expect(h.queue.snapshot().entries.map((e) => [e.sessionKey, e.state])).toEqual([
      ['C1:2.0', 'waiting'],
      ['C1:3.0', 'admitted'],
    ]);
  });
});
