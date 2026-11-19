/**
 * "This thread waits on the host" (.prd/36 D8, .prd/37 §6): its entry waits in a queue, or an environment hand-off
 * it asked for runs — mirrored from that environment thread's own queue entry when it has one.
 */
import { describe, expect, it } from 'vitest';
import { EnvHandoffRuns } from '../../slack/env-handoff-runs';
import type { WorkQueueThreadStatus } from '../host';
import { hostWaitFor, waitsOnHost } from '../host-wait';

function fakeHost(byThread: Record<string, WorkQueueThreadStatus>) {
  return {
    statusFor: (channel?: string, threadTs?: string) =>
      channel && threadTs ? byThread[`${channel}/${threadTs}`] : undefined,
  };
}

const queued: WorkQueueThreadStatus = {
  queue: 'qa:dev2',
  entry: 'wq-2',
  state: 'queued',
  position: 1,
  keys: ['ABC-2'],
  since: 10,
};
const running: WorkQueueThreadStatus = {
  queue: 'qa:dev2',
  entry: 'wq-1',
  state: 'running',
  position: 0,
  keys: ['ABC-1'],
  since: 20,
};

describe('hostWaitFor', () => {
  it('a waiting entry reads queued, with its queue and place', () => {
    const deps = { host: fakeHost({ 'C1/1.1': queued }), handoffs: new EnvHandoffRuns() };
    expect(hostWaitFor('C1', '1.1', deps)).toEqual({ kind: 'queued', queue: 'qa:dev2', position: 1, since: 10 });
    expect(waitsOnHost('C1', '1.1', deps)).toBe(true);
  });

  it('a running entry reads running but is not a wait (the thread is the one to act)', () => {
    const deps = { host: fakeHost({ 'C1/1.1': running }), handoffs: new EnvHandoffRuns() };
    expect(hostWaitFor('C1', '1.1', deps)).toEqual({ kind: 'running', queue: 'qa:dev2', since: 20 });
    expect(waitsOnHost('C1', '1.1', deps)).toBe(false);
  });

  it('a hand-off reads env, or queued when its environment thread waits in a queue', () => {
    const handoffs = new EnvHandoffRuns(() => 30);
    const run = handoffs.start({ channel: 'C1', threadTs: '1.1' }, 'env:acme-dev2');
    const deps = { host: fakeHost({ 'C1/9.9': queued }), handoffs };
    expect(hostWaitFor('C1', '1.1', deps)).toEqual({ kind: 'env', owner: 'env:acme-dev2', since: 30 });
    run.opened('C1', '9.9');
    expect(hostWaitFor('C1', '1.1', deps)).toEqual({ kind: 'queued', queue: 'qa:dev2', position: 1, since: 10 });
    expect(waitsOnHost('C1', '1.1', deps)).toBe(true);
  });

  it('nothing → undefined; no host wired reads only hand-offs', () => {
    expect(hostWaitFor('C1', '1.1', { host: undefined, handoffs: new EnvHandoffRuns() })).toBeUndefined();
    expect(waitsOnHost(undefined, undefined, { host: undefined, handoffs: new EnvHandoffRuns() })).toBe(false);
  });
});
