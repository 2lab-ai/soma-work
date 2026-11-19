/**
 * The host side of the work queue (.prd/36 A3 A5–A8, .prd/37 §4): it wakes the thread whose turn came (once), gives
 * back a turn its thread stopped working on, drops waiting entries whose thread is gone, and tells the board, the goal
 * loop, the follow-up question and the hand-off where a thread stands.
 */
import { endEntry, enterQueue, type WorkQueueHolder } from 'somalib/work-queue/ledger';
import { MemoryWorkQueueStore } from 'somalib/work-queue/memory-store';
import { beforeEach, describe, expect, it } from 'vitest';
import { type HolderProbe, WORK_QUEUE_ASKING_GRACE_MS, WORK_QUEUE_IDLE_GRACE_MS, WorkQueueHost } from '../host';

const QUEUES = [{ id: 'qa:dev2', lane: 'qa', env: 'dev2' }];
const A: WorkQueueHolder = { user: 'U1', channel: 'C1', threadTs: '1.1' };
const B: WorkQueueHolder = { user: 'U2', channel: 'C1', threadTs: '2.2' };
const C: WorkQueueHolder = { user: 'U3', channel: 'C1', threadTs: '3.3' };

// The host's rules run on the in-process store (same contract as the SQLite one), so they are checked on every runtime.
let store: MemoryWorkQueueStore;

beforeEach(() => {
  store = new MemoryWorkQueueStore();
});

type Outcome = 'injected' | 'expired' | 'gone';

function harness() {
  const clock = { now: 1_000_000 };
  const probes = new Map<string, HolderProbe>();
  const delivered: Array<{
    holder: WorkQueueHolder;
    text: string;
    done: (o: Outcome) => void;
    current: () => boolean;
  }> = [];
  const posted: Array<{ holder: WorkQueueHolder; text: string }> = [];
  const host = new WorkQueueHost({
    store,
    probe: (h) => probes.get(h.threadTs) ?? { exists: false },
    deliver: (holder, text, done, current) => {
      delivered.push({ holder, text, done, current });
    },
    post: async (holder, text) => {
      posted.push({ holder, text });
    },
    now: () => clock.now,
  });
  const enter = (holder: WorkQueueHolder, keys: string[]) =>
    store.mutate((l) => enterQueue(l, { queue: 'qa:dev2', keys, holder }, QUEUES, clock.now));
  const done = (holder: WorkQueueHolder, id: string) =>
    store.mutate((l) => endEntry(l, { id, end: 'done', actor: holder }, clock.now));
  probes.set('1.1', { exists: true, activity: 'working', activityChangedAt: clock.now });
  probes.set('2.2', { exists: true, activity: 'idle', activityChangedAt: clock.now });
  probes.set('3.3', { exists: true, activity: 'idle', activityChangedAt: clock.now });
  return { host, clock, probes, delivered, posted, enter, done };
}

describe('WorkQueueHost — reading a thread', () => {
  it('A3 — a waiting thread reads as queued with its place; it waits on the host', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    expect(h.host.statusFor('C1', '2.2')).toMatchObject({
      queue: 'qa:dev2',
      entry: 'wq-2',
      state: 'queued',
      position: 1,
      keys: ['ABC-2'],
    });
    expect(h.host.awaitsHost('C1', '2.2')).toBe(true);
    expect(h.host.statusFor('C1', '1.1')).toMatchObject({ state: 'running', position: 0 });
    expect(h.host.awaitsHost('C1', '1.1')).toBe(false);
    expect(h.host.statusFor('C1', '9.9')).toBeUndefined();
  });

  it('reads the change another process made without a tick', () => {
    const h = harness();
    expect(h.host.awaitsHost('C1', '2.2')).toBe(false);
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    expect(h.host.awaitsHost('C1', '2.2')).toBe(true);
  });
});

describe('WorkQueueHost — waking', () => {
  it('A5 — wakes the thread whose turn came, once, and stamps it when the wake went in', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.done(A, 'wq-1');
    h.host.tick();
    h.host.tick();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].holder).toEqual(B);
    expect(h.delivered[0].text).toMatch(/qa:dev2/);
    expect(h.delivered[0].text).toMatch(/wq-2/);
    expect(h.delivered[0].text).toMatch(/ABC-2/);
    expect(h.delivered[0].text).toMatch(/queue_done/);
    expect(h.delivered[0].text).toMatch(/host/i);
    h.delivered[0].done('injected');
    expect(store.read().entries[0].notifiedAt).toBe(h.clock.now);
    h.host.tick();
    expect(h.delivered).toHaveLength(1);
  });

  it('an entry that ran from the moment it entered is not woken (its own answer told it)', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.host.tick();
    expect(h.delivered).toHaveLength(0);
  });

  it('a thread that cannot be woken (gone, asleep) gives its turn to the next', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.enter(C, ['ABC-3']);
    h.done(A, 'wq-1');
    h.host.tick();
    h.delivered[0].done('gone');
    expect(store.read().entries.map((e) => [e.id, e.state])).toEqual([['wq-3', 'running']]);
    expect(store.read().ended.slice(-1)[0]).toMatchObject({ id: 'wq-2', end: 'released', reason: 'holder-gone' });
    h.host.tick();
    expect(h.delivered.map((d) => d.holder.threadTs)).toEqual(['2.2', '3.3']);
  });

  it('A8 — after a restart, a granted entry nobody woke is woken by the new host', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.done(A, 'wq-1');
    h.host.tick();
    // The process died before the wake went in: a new host over the same file.
    const again = new WorkQueueHost({
      store,
      probe: (x) => h.probes.get(x.threadTs) ?? { exists: false },
      deliver: (holder, text, done, current) => h.delivered.push({ holder, text, done, current }),
      post: async () => undefined,
      now: () => h.clock.now,
    });
    again.tick();
    expect(h.delivered.map((d) => d.holder.threadTs)).toEqual(['2.2', '2.2']);
  });
});

describe('WorkQueueHost — giving back a turn nobody works on', () => {
  it('A6 — a running entry whose thread stopped working is released after the idle grace, with a notice', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.probes.set('1.1', { exists: true, activity: 'idle', activityChangedAt: h.clock.now });
    h.clock.now += WORK_QUEUE_IDLE_GRACE_MS - 1;
    h.host.sweep();
    expect(store.read().entries[0].id).toBe('wq-1');
    h.clock.now += 2;
    h.host.sweep();
    expect(store.read().entries.map((e) => [e.id, e.state])).toEqual([['wq-2', 'running']]);
    expect(store.read().ended.slice(-1)[0]).toMatchObject({ id: 'wq-1', reason: 'holder-idle' });
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].holder).toEqual(A);
    expect(h.posted[0].text).toMatch(/qa:dev2/);
  });

  it('a working thread, a thread with a hand-off running, or one just woken keeps its turn', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.clock.now += 10 * WORK_QUEUE_ASKING_GRACE_MS;
    h.probes.set('1.1', { exists: true, activity: 'working', activityChangedAt: h.clock.now - 1_000 });
    h.host.sweep();
    h.probes.set('1.1', { exists: true, activity: 'idle', activityChangedAt: 0, handoffActive: true });
    h.host.sweep();
    expect(store.read().entries).toHaveLength(1);
  });

  it('idle time counts from the wake, not from before it', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.probes.set('2.2', { exists: true, activity: 'idle', activityChangedAt: 0 });
    h.done(A, 'wq-1');
    h.host.tick();
    h.clock.now += 1_000;
    h.delivered[0].done('injected');
    h.clock.now += WORK_QUEUE_IDLE_GRACE_MS - 10;
    h.host.sweep();
    expect(store.read().entries[0]).toMatchObject({ id: 'wq-2', state: 'running' });
  });

  it('a thread waiting on a person keeps its turn for the asking grace, then gives it back', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.probes.set('1.1', { exists: true, activity: 'waiting', activityChangedAt: h.clock.now });
    h.clock.now += WORK_QUEUE_ASKING_GRACE_MS - 1;
    h.host.sweep();
    expect(store.read().entries).toHaveLength(1);
    h.clock.now += 2;
    h.host.sweep();
    expect(store.read().ended.slice(-1)[0]).toMatchObject({ id: 'wq-1', reason: 'holder-asking' });
  });

  it('A7 — a waiting entry whose thread is gone leaves the line without a notice', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.probes.delete('2.2');
    h.host.sweep();
    expect(store.read().entries.map((e) => e.id)).toEqual(['wq-1']);
    expect(store.read().ended.slice(-1)[0]).toMatchObject({ id: 'wq-2', reason: 'holder-gone' });
    expect(h.posted).toHaveLength(0);
  });

  it('a granted entry whose idle thread has not taken its wake keeps its turn for the idle grace, then gives it back', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.done(A, 'wq-1');
    h.host.tick();
    h.clock.now += WORK_QUEUE_IDLE_GRACE_MS - 10;
    h.host.sweep();
    expect(store.read().entries[0]).toMatchObject({ id: 'wq-2', state: 'running' });
    h.clock.now += 20;
    h.host.sweep();
    expect(store.read().ended.slice(-1)[0]).toMatchObject({ id: 'wq-2', reason: 'holder-idle' });
    expect(h.delivered[0].current()).toBe(false);
  });
});

describe('WorkQueueHost.whenFree', () => {
  it('settles at once for a thread with no entry, and when its last entry ends', async () => {
    const h = harness();
    await h.host.whenFree('C1', '9.9');
    h.enter(A, ['ABC-1']);
    h.probes.set('1.1', { exists: true, activity: 'idle', activityChangedAt: h.clock.now });
    let freed = false;
    const p = h.host.whenFree('C1', '1.1').then(() => {
      freed = true;
    });
    h.host.tick();
    await Promise.resolve();
    expect(freed).toBe(false);
    h.done(A, 'wq-1');
    h.host.tick();
    await p;
    expect(freed).toBe(true);
  });
});

describe('WorkQueueHost — review round 1', () => {
  it('a host that just started gives every idle holder the full grace (a restart is not idle time)', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    // Long before this host started, A's thread went idle (its turn was cut by the shutdown).
    h.probes.set('1.1', {
      exists: true,
      activity: 'idle',
      activityChangedAt: h.clock.now - 3 * WORK_QUEUE_IDLE_GRACE_MS,
    });
    h.clock.now += 3 * WORK_QUEUE_IDLE_GRACE_MS;
    const restarted = new WorkQueueHost({
      store,
      probe: (x) => h.probes.get(x.threadTs) ?? { exists: false },
      deliver: () => undefined,
      post: async () => undefined,
      now: () => h.clock.now,
    });
    restarted.sweep();
    expect(store.read().entries[0]).toMatchObject({ id: 'wq-1', state: 'running' });
    h.clock.now += WORK_QUEUE_IDLE_GRACE_MS;
    restarted.sweep();
    expect(store.read().ended.slice(-1)[0]).toMatchObject({ id: 'wq-1', reason: 'holder-idle' });
  });

  it('a granted entry whose thread waits on a person is given back after the asking grace, with a notice', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.enter(C, ['ABC-3']);
    h.probes.set('2.2', { exists: true, activity: 'waiting', activityChangedAt: h.clock.now });
    h.done(A, 'wq-1');
    h.host.tick();
    expect(h.delivered).toHaveLength(1);
    h.clock.now += WORK_QUEUE_ASKING_GRACE_MS + 1;
    h.host.sweep();
    expect(store.read().ended.slice(-1)[0]).toMatchObject({ id: 'wq-2', reason: 'holder-asking' });
    expect(h.posted.map((p) => p.holder.threadTs)).toEqual(['2.2']);
    // The wake still waiting for that thread is no longer current: the delivery drops it.
    expect(h.delivered[0].current()).toBe(false);
    // And the next thread is woken.
    expect(h.delivered.map((d) => d.holder.threadTs)).toEqual(['2.2', '3.3']);
  });

  it('a granted entry whose thread works on something else keeps its turn until it can be woken', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.probes.set('2.2', { exists: true, activity: 'working', activityChangedAt: h.clock.now });
    h.done(A, 'wq-1');
    h.host.tick();
    h.clock.now += 10 * WORK_QUEUE_ASKING_GRACE_MS;
    h.host.sweep();
    expect(store.read().entries[0]).toMatchObject({ id: 'wq-2', state: 'running' });
    expect(h.delivered[0].current()).toBe(true);
  });

  it('a wake that expired gives the turn back with a notice', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.done(A, 'wq-1');
    h.host.tick();
    h.delivered[0].done('expired');
    expect(store.read().ended.slice(-1)[0]).toMatchObject({ id: 'wq-2', reason: 'wake-expired' });
    expect(h.posted.map((p) => p.holder.threadTs)).toEqual(['2.2']);
  });

  it('whenFree also waits for the thread to stop working (a woken turn that called queue_done is still writing)', async () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    let freed = false;
    const p = h.host.whenFree('C1', '1.1').then(() => {
      freed = true;
    });
    h.done(A, 'wq-1');
    h.host.tick();
    await Promise.resolve();
    expect(freed).toBe(false); // '1.1' still works
    h.probes.set('1.1', { exists: true, activity: 'idle', activityChangedAt: h.clock.now });
    h.host.tick();
    await p;
    expect(freed).toBe(true);
  });

  it('a sweep re-reads the file even when its stamp looks unchanged', () => {
    const h = harness();
    h.enter(A, ['ABC-1']);
    h.enter(B, ['ABC-2']);
    h.probes.delete('2.2');
    const stamp = store.stamp.bind(store);
    store.stamp = () => 'frozen';
    h.host.tick();
    h.host.sweep();
    store.stamp = stamp;
    expect(store.read().entries.map((e) => e.id)).toEqual(['wq-1']);
  });
});
