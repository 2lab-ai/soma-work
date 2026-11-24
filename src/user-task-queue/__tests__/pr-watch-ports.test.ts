import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettledDelivery } from '../../session-pr-watch';
import { setActiveUserTaskQueue } from '../active';
import { prWatchDeliveryPorts } from '../pr-watch-ports';
import { type RunningTask, UserTaskQueue } from '../user-task-queue';

// A shared dev host (2026-11-24): a pr-watch "CI failed" message for another thread of a person at their limit lined
// up as their request; its owner closed that session and its PR merged, and the queue still replayed it ten minutes
// later. pr-watch now holds it in its own delivery — where a merged PR or a closed session drops it — until the owner
// has a free slot, and reserves that slot as it sends (#1413 review).
describe('pr-watch delivery and the per-user task queue', () => {
  const other: RunningTask = { sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0', title: 'running task' };
  let running: RunningTask[];
  let queue: UserTaskQueue;
  let sessions: Map<string, any>;
  let injected: any[];

  beforeEach(() => {
    vi.useFakeTimers();
    running = [other];
    queue = new UserTaskQueue({
      store: { load: () => undefined, save: () => undefined },
      limitFor: () => 1,
      runningTasks: () => running,
      start: () => undefined,
      interrupt: () => 'stopped',
    });
    setActiveUserTaskQueue({ queue, limits: {} as any, release: () => undefined });
    sessions = new Map([
      ['C1:5.0', { channelId: 'C1', threadTs: '5.0', ownerId: 'U1', activityState: 'idle' }],
      ['C1:6.0', { channelId: 'C1', threadTs: '6.0', ownerId: 'U1', activityState: 'idle' }],
    ]);
    injected = [];
  });
  afterEach(() => {
    setActiveUserTaskQueue(undefined);
    vi.useRealTimers();
  });

  const delivery = () =>
    createSettledDelivery({
      ...prWatchDeliveryPorts({
        getSession: (key) => sessions.get(key),
        isHostTurnFree: () => true,
        inject: async (event) => {
          injected.push(event);
        },
      }),
      retryMs: 100,
    });

  it('holds the message while its owner is at the limit, then sends it once, marked, when a slot frees', async () => {
    const d = delivery();
    const done = vi.fn();
    await d.deliver('C1:5.0', '[pr-watch] CI failed on PR #1', done);
    vi.advanceTimersByTime(300);
    expect(injected).toEqual([]);
    running = [];
    vi.advanceTimersByTime(100);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ channel: 'C1', thread_ts: '5.0', routeContext: { userTaskReady: true } });
    expect(done).toHaveBeenCalledWith('injected');
    // The slot is reserved for it on its way: a request now, or a second pr-watch message, waits.
    expect(queue.hasFreeSlot('U1', 'C1:6.0')).toBe(false);
    d.stop();
  });

  it('two sessions of one owner: only one message goes into the one free slot', async () => {
    running = [];
    const d = delivery();
    await d.deliver('C1:5.0', 'a');
    await d.deliver('C1:6.0', 'b');
    vi.advanceTimersByTime(300);
    expect(injected.map((e) => e.thread_ts)).toEqual(['5.0']);
    d.stop();
  });

  it('a session closed while its message waited: dropped, never sent', async () => {
    const d = delivery();
    const done = vi.fn();
    await d.deliver('C1:5.0', 'ci failed', done);
    sessions.get('C1:5.0').terminated = true;
    running = [];
    vi.advanceTimersByTime(300);
    expect(injected).toEqual([]);
    expect(done).toHaveBeenCalledWith('gone');
    d.stop();
  });

  it('a PR that merged while its message waited: dropped, never sent', async () => {
    const d = delivery();
    let current = true;
    const done = vi.fn();
    await d.deliver('C1:5.0', 'ci failed', done, () => current);
    current = false;
    running = [];
    vi.advanceTimersByTime(300);
    expect(injected).toEqual([]);
    expect(done).toHaveBeenCalledWith('gone');
    d.stop();
  });

  it('a send that fails gives its reservation back', async () => {
    running = [];
    const d = createSettledDelivery({
      ...prWatchDeliveryPorts({
        getSession: (key) => sessions.get(key),
        isHostTurnFree: () => true,
        inject: async () => {
          throw new Error('slack down');
        },
      }),
      retryMs: 100,
    });
    await d.deliver('C1:5.0', 'ci failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.hasFreeSlot('U1', 'C1:6.0')).toBe(true);
    d.stop();
  });

  it('no queue wired: the owner is never held', async () => {
    setActiveUserTaskQueue(undefined);
    const d = delivery();
    await d.deliver('C1:5.0', 'ci failed');
    vi.advanceTimersByTime(100);
    expect(injected).toHaveLength(1);
    d.stop();
  });
});
