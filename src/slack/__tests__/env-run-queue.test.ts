/**
 * Environment work, one run at a time per environment user (SSOT 2026-11-19): a second hand-off waits in line and
 * starts by itself when the first ends; a turn of that environment user that started elsewhere holds the line too
 * (busy probe); the requester thread can ask where its run stands (`queued` / `running`).
 */
import { describe, expect, it } from 'vitest';
import { ENV_BUSY_MAX_AGE_MS, EnvRunQueue, environmentBusy } from '../env-run-queue';

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

function makeQueue(now = { t: 1_000 }) {
  const timers: Array<() => void> = [];
  const queue = new EnvRunQueue({ now: () => now.t, schedule: (fn) => timers.push(fn), pollMs: 10 });
  return { queue, timers, now };
}

const ticket = (threadTs: string, owner = 'env:acme-dev2') => ({
  owner,
  channel: 'C1',
  threadTs,
  skills: '`full-deploy-dev2`',
});

describe('EnvRunQueue', () => {
  it('starts a run at once when the environment is free', async () => {
    const { queue } = makeQueue();
    const run = deferred();
    let started = 0;
    const { ahead, result } = queue.run(ticket('1.1'), () => {
      started++;
      return run.promise;
    });
    expect(ahead).toBe(0);
    expect(started).toBe(1);
    expect(queue.statusFor('C1', '1.1')).toMatchObject({ state: 'running', owner: 'env:acme-dev2' });
    run.resolve('done');
    await expect(result).resolves.toBe('done');
    expect(queue.statusFor('C1', '1.1')).toBeUndefined();
    expect(queue.isPending('C1', '1.1')).toBe(false);
  });

  it('a second run of the same environment waits, then starts by itself when the first ends', async () => {
    const { queue, now } = makeQueue();
    const first = deferred();
    const second = deferred();
    let secondStarted = false;
    queue.run(ticket('1.1'), () => first.promise);
    now.t = 2_000;
    const b = queue.run(ticket('2.2'), () => {
      secondStarted = true;
      return second.promise;
    });
    expect(b.ahead).toBe(1);
    expect(secondStarted).toBe(false);
    expect(queue.statusFor('C1', '2.2')).toEqual({
      state: 'queued',
      owner: 'env:acme-dev2',
      skills: '`full-deploy-dev2`',
      since: 2_000,
      position: 1,
    });
    expect(queue.isPending('C1', '2.2')).toBe(true);

    now.t = 5_000;
    first.resolve('a');
    await flush();
    expect(secondStarted).toBe(true);
    expect(queue.statusFor('C1', '2.2')).toMatchObject({ state: 'running', since: 5_000 });
    second.resolve('b');
    await expect(b.result).resolves.toBe('b');
  });

  it('keeps arrival order and counts the place in line', async () => {
    const { queue } = makeQueue();
    const first = deferred();
    const order: string[] = [];
    queue.run(ticket('1.1'), () => {
      order.push('1');
      return first.promise;
    });
    const second = deferred();
    queue.run(ticket('2.2'), () => {
      order.push('2');
      return second.promise;
    });
    const c = queue.run(ticket('3.3'), async () => {
      order.push('3');
      return 'c';
    });
    expect(c.ahead).toBe(2);
    expect(queue.statusFor('C1', '3.3')?.position).toBe(2);
    first.resolve('x');
    await flush();
    expect(order).toEqual(['1', '2']);
    expect(queue.statusFor('C1', '3.3')?.position).toBe(1);
    second.resolve('y');
    await expect(c.result).resolves.toBe('c');
    expect(order).toEqual(['1', '2', '3']);
  });

  it('different environments run side by side', () => {
    const { queue } = makeQueue();
    let started = 0;
    queue.run(ticket('1.1', 'env:acme-dev2'), () => {
      started++;
      return new Promise(() => {});
    });
    const other = queue.run(ticket('2.2', 'env:acme-stage0'), () => {
      started++;
      return new Promise(() => {});
    });
    expect(other.ahead).toBe(0);
    expect(started).toBe(2);
  });

  it('a busy environment (a turn started elsewhere) holds the head until the probe says free', async () => {
    const { queue, timers } = makeQueue();
    let busy = true;
    queue.setBusyProbe((owner) => owner === 'env:acme-dev2' && busy);
    let started = false;
    const r = queue.run(ticket('1.1'), async () => {
      started = true;
      return 'ok';
    });
    expect(r.ahead).toBe(1);
    expect(started).toBe(false);
    expect(queue.statusFor('C1', '1.1')).toMatchObject({ state: 'queued', position: 1 });
    expect(timers).toHaveLength(1);
    timers.shift()!();
    expect(started).toBe(false); // still busy: re-armed
    expect(timers).toHaveLength(1);
    busy = false;
    timers.shift()!();
    expect(started).toBe(true);
    await expect(r.result).resolves.toBe('ok');
  });

  it('a probe that throws reads as free — the lane lock still guards', () => {
    const { queue } = makeQueue();
    queue.setBusyProbe(() => {
      throw new Error('registry gone');
    });
    let started = false;
    queue.run(ticket('1.1'), async () => {
      started = true;
    });
    expect(started).toBe(true);
  });

  it('a run that fails or throws frees the line for the next', async () => {
    const { queue } = makeQueue();
    const a = queue.run(ticket('1.1'), () => Promise.reject(new Error('boom')));
    const b = queue.run(ticket('2.2'), () => {
      throw new Error('sync boom');
    });
    let cStarted = false;
    const c = queue.run(ticket('3.3'), async () => {
      cStarted = true;
      return 'c';
    });
    await expect(a.result).rejects.toThrow('boom');
    await expect(b.result).rejects.toThrow('sync boom');
    await expect(c.result).resolves.toBe('c');
    expect(cStarted).toBe(true);
  });

  it('a thread with no run has no status', () => {
    const { queue } = makeQueue();
    expect(queue.statusFor('C1', '9.9')).toBeUndefined();
    expect(queue.statusFor(undefined, undefined)).toBeUndefined();
    expect(queue.isPending('C1', undefined)).toBe(false);
  });

  describe('environmentBusy — the busy probe rule', () => {
    const now = 10 * ENV_BUSY_MAX_AGE_MS;
    const base = { ownerId: 'env:acme-dev2', activityState: 'working', activityStateChangedAt: now - 60_000 };
    it('a working session of that environment user is busy', () => {
      expect(environmentBusy('env:acme-dev2', [base], now)).toBe(true);
    });
    it('idle, waiting, asleep, closed or another owner is not', () => {
      expect(environmentBusy('env:acme-dev2', [{ ...base, activityState: 'idle' }], now)).toBe(false);
      expect(environmentBusy('env:acme-dev2', [{ ...base, activityState: 'waiting' }], now)).toBe(false);
      expect(environmentBusy('env:acme-dev2', [{ ...base, state: 'SLEEPING' }], now)).toBe(false);
      expect(environmentBusy('env:acme-dev2', [{ ...base, terminated: true }], now)).toBe(false);
      expect(environmentBusy('env:acme-dev2', [{ ...base, ownerId: 'env:acme-stage0' }], now)).toBe(false);
    });
    it('a turn older than the cap (a session a crash left working) or with no stamp is not', () => {
      expect(
        environmentBusy('env:acme-dev2', [{ ...base, activityStateChangedAt: now - ENV_BUSY_MAX_AGE_MS - 1 }], now),
      ).toBe(false);
      expect(environmentBusy('env:acme-dev2', [{ ...base, activityStateChangedAt: undefined }], now)).toBe(false);
    });
  });
});
