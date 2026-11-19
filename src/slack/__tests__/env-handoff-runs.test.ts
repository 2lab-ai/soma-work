/**
 * Environment hand-offs in flight, per requester thread (.prd/37 §5): the requester waits on the host while one runs.
 */
import { describe, expect, it } from 'vitest';
import { EnvHandoffRuns } from '../env-handoff-runs';

describe('EnvHandoffRuns', () => {
  it('a started run is running until it ends; its environment thread is known once opened', () => {
    const runs = new EnvHandoffRuns(() => 5_000);
    const run = runs.start({ channel: 'C1', threadTs: '1.1' }, 'env:acme-dev2');
    expect(runs.isRunning('C1', '1.1')).toBe(true);
    expect(runs.statusFor('C1', '1.1')).toEqual({ owner: 'env:acme-dev2', since: 5_000 });
    run.opened('C1', '9.9');
    expect(runs.statusFor('C1', '1.1')).toEqual({
      owner: 'env:acme-dev2',
      since: 5_000,
      envThread: { channel: 'C1', threadTs: '9.9' },
    });
    run.end();
    run.end();
    expect(runs.isRunning('C1', '1.1')).toBe(false);
    expect(runs.statusFor('C1', '1.1')).toBeUndefined();
  });

  it('two runs of one thread: it waits until both ended', () => {
    const runs = new EnvHandoffRuns(() => 1);
    const a = runs.start({ channel: 'C1', threadTs: '1.1' }, 'env:a');
    const b = runs.start({ channel: 'C1', threadTs: '1.1' }, 'env:b');
    a.end();
    expect(runs.statusFor('C1', '1.1')?.owner).toBe('env:b');
    b.end();
    expect(runs.isRunning('C1', '1.1')).toBe(false);
  });

  it('remembers when the last run of a thread ended (its idle clock starts there)', () => {
    let now = 100;
    const runs = new EnvHandoffRuns(() => now);
    expect(runs.lastEndedAt('C1', '1.1')).toBeUndefined();
    const run = runs.start({ channel: 'C1', threadTs: '1.1' }, 'env:a');
    now = 900;
    run.end();
    expect(runs.lastEndedAt('C1', '1.1')).toBe(900);
  });

  it('no thread, no run', () => {
    expect(new EnvHandoffRuns().isRunning(undefined, undefined)).toBe(false);
  });
});
