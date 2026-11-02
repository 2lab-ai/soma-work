import { beforeEach, describe, expect, it } from 'vitest';
import { parseWorkQueuesConfig, type WorkQueueDef } from '../config';
import { type SessionProbe, WorkQueueManager } from '../manager';

const MIN = 60_000;

function setup(queues?: WorkQueueDef[]) {
  let now = 1_000_000;
  const probes = new Map<string, SessionProbe>();
  const defs = queues ?? parseWorkQueuesConfig(undefined).queues;
  const manager = new WorkQueueManager({
    getQueues: () => defs,
    now: () => now,
    probe: (key) => probes.get(key) ?? { exists: false, active: false },
    graceMs: 60_000,
  });
  return {
    manager,
    queue: defs[0],
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    setProbe: (key: string, probe: SessionProbe) => probes.set(key, probe),
  };
}

const A = { sessionKey: 'C1:100', userId: 'UA', channel: 'C1', threadTs: '100' };
const B = { sessionKey: 'C1:200', userId: 'UB', channel: 'C1', threadTs: '200' };
const C = { sessionKey: 'C2:300', userId: 'UC', channel: 'C2', threadTs: '300' };

describe('WorkQueueManager — slots (T1: one dev2 deploy at a time across all users)', () => {
  it('lets the first deploy in and turns the second one away', () => {
    const { manager, queue } = setup();
    expect(manager.tryAcquire(queue, A)).toEqual({ ok: true });
    const second = manager.tryAcquire(queue, B);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.holders.map((h) => h.sessionKey)).toEqual(['C1:100']);
  });

  it('lets the holder session through again (its own next turn is not a second deploy)', () => {
    const { manager, queue } = setup();
    manager.tryAcquire(queue, A);
    expect(manager.tryAcquire(queue, A)).toEqual({ ok: true });
    expect(manager.holders(queue.id)).toHaveLength(1);
  });

  it('allows as many sessions as the queue concurrency', () => {
    const [two] = parseWorkQueuesConfig([{ id: 'q2', workflow: 'deploy', targets: ['dev9'], concurrency: 2 }]).queues;
    const { manager } = setup([two]);
    expect(manager.tryAcquire(two, A).ok).toBe(true);
    expect(manager.tryAcquire(two, B).ok).toBe(true);
    expect(manager.tryAcquire(two, C).ok).toBe(false);
  });
});

describe('WorkQueueManager — waiters (T4/T5)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
    t.manager.tryAcquire(t.queue, A);
    t.setProbe(A.sessionKey, { exists: true, active: true, activity: 'working' });
  });

  it('records a blocked request as asking, with a 10-minute answer deadline', () => {
    const w = t.manager.addWaiter(t.queue, { ...B, text: 'Projalpha: develop -> deploy/dev2', ranBefore: false });
    expect(w.state).toBe('asking');
    expect(w.askDeadline).toBe(t.now() + 10 * MIN);
    expect(t.manager.waiterForSession(B.sessionKey)?.id).toBe(w.id);
  });

  it('cancels an unanswered request after 10 minutes — and not before', () => {
    const w = t.manager.addWaiter(t.queue, { ...B, text: 'x', ranBefore: false });
    t.advance(10 * MIN - 1);
    expect(t.manager.tick()).toEqual([]);
    t.advance(1);
    const events = t.manager.tick();
    expect(events).toEqual([expect.objectContaining({ type: 'cancelled', reason: 'ask-timeout' })]);
    expect(events[0].type === 'cancelled' && events[0].waiter.id).toBe(w.id);
    expect(t.manager.getWaiter(w.id)).toBeUndefined();
    expect(t.manager.tick()).toEqual([]);
  });

  it('"deploy after the current one" queues the request; the 10-minute answer deadline no longer applies', () => {
    const w = t.manager.addWaiter(t.queue, { ...B, text: 'x', ranBefore: false });
    const r = t.manager.chooseWait(w.id);
    expect(r).toMatchObject({ outcome: 'queued', position: 1 });
    t.advance(30 * MIN);
    expect(t.manager.tick()).toEqual([]);
    expect(t.manager.getWaiter(w.id)?.state).toBe('waiting');
  });

  it('starts at once when "deploy after" is chosen and the slot is already free', () => {
    const w = t.manager.addWaiter(t.queue, { ...B, text: 'x', ranBefore: false });
    t.manager.releaseSession(A.sessionKey, 'ended');
    const r = t.manager.chooseWait(w.id);
    expect(r.outcome).toBe('started');
    expect(r.events).toEqual([expect.objectContaining({ type: 'start' })]);
    expect(t.manager.holders(t.queue.id).map((h) => h.sessionKey)).toEqual([B.sessionKey]);
  });

  it('cancel is one-way: a second cancel or a late click finds nothing', () => {
    const w = t.manager.addWaiter(t.queue, { ...B, text: 'x', ranBefore: false });
    expect(t.manager.cancel(w.id, 'user')).toHaveLength(1);
    expect(t.manager.cancel(w.id, 'user')).toEqual([]);
    expect(t.manager.chooseWait(w.id).outcome).toBe('gone');
  });

  it('hands the freed slot to the oldest queued request, never to one still asking', () => {
    const asking = t.manager.addWaiter(t.queue, { ...C, text: 'c', ranBefore: false });
    t.advance(1000);
    const queued = t.manager.addWaiter(t.queue, { ...B, text: 'Projalpha: develop -> deploy/dev2', ranBefore: false });
    t.manager.chooseWait(queued.id);
    const events = t.manager.releaseSession(A.sessionKey, 'ended');
    expect(events.map((e) => e.type)).toEqual(['released', 'start']);
    const start = events[1];
    expect(start.type === 'start' && start.waiter.text).toBe('Projalpha: develop -> deploy/dev2');
    expect(t.manager.holders(t.queue.id).map((h) => h.sessionKey)).toEqual([B.sessionKey]);
    expect(t.manager.getWaiter(asking.id)?.state).toBe('asking');
  });
});

describe('WorkQueueManager — release (the slot frees when the deploy is over)', () => {
  it('releases at once when the holder session is gone', () => {
    const t = setup();
    t.manager.tryAcquire(t.queue, A);
    expect(t.manager.tick()).toEqual([expect.objectContaining({ type: 'released', reason: 'session-gone' })]);
    expect(t.manager.holders(t.queue.id)).toEqual([]);
  });

  it('keeps the slot while the turn runs, and while it waits on its own question for less than holderIdle', () => {
    const t = setup();
    t.manager.tryAcquire(t.queue, A);
    t.setProbe(A.sessionKey, { exists: true, active: true, activity: 'working' });
    t.advance(5 * MIN);
    expect(t.manager.tick()).toEqual([]);
    t.setProbe(A.sessionKey, { exists: true, active: false, activity: 'waiting', activityChangedAt: t.now() });
    t.advance(9 * MIN);
    expect(t.manager.tick()).toEqual([]);
  });

  it('gives the slot back when the holder has waited on its own question longer than holderIdle', () => {
    const t = setup();
    t.manager.tryAcquire(t.queue, A);
    t.setProbe(A.sessionKey, { exists: true, active: false, activity: 'waiting', activityChangedAt: t.now() });
    // The sweep runs every few seconds; the last tick inside the window marks it alive.
    t.advance(9.5 * MIN);
    expect(t.manager.tick()).toEqual([]);
    t.advance(0.5 * MIN);
    expect(t.manager.tick()).toEqual([]);
    t.advance(0.5 * MIN);
    expect(t.manager.tick()).toEqual([expect.objectContaining({ type: 'released', reason: 'unresponsive' })]);
  });

  it('releases an idle holder only after the grace (a missed idle hook or a restart)', () => {
    const t = setup();
    t.manager.tryAcquire(t.queue, A);
    t.setProbe(A.sessionKey, { exists: true, active: false, activity: 'idle' });
    t.advance(59_999);
    expect(t.manager.tick()).toEqual([]);
    t.advance(1);
    expect(t.manager.tick()).toEqual([expect.objectContaining({ type: 'released', reason: 'ended' })]);
  });

  it('forgetSession releases the holder and cancels its requests, once', () => {
    const t = setup();
    t.manager.tryAcquire(t.queue, A);
    t.manager.addWaiter(t.queue, { ...B, text: 'x', ranBefore: false });
    expect(t.manager.forgetSession(B.sessionKey)).toEqual([
      expect.objectContaining({ type: 'cancelled', reason: 'session-gone' }),
    ]);
    expect(t.manager.forgetSession(A.sessionKey).map((e) => e.type)).toEqual(['released']);
    expect(t.manager.forgetSession(A.sessionKey)).toEqual([]);
  });
});
