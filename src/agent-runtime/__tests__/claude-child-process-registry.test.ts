import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeChildProcessRegistry,
  getClaudeChildProcessRegistry,
  type TrackedClaudeProcess,
} from '../claude-child-process-registry';

function fakeProcess(options: { exitOnSigkill?: boolean } = {}): TrackedClaudeProcess & EventEmitter {
  const process = new EventEmitter() as TrackedClaudeProcess & EventEmitter;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  Object.defineProperties(process, {
    pid: { value: 1234 },
    killed: { value: false, writable: true },
    exitCode: { value: null, writable: true },
  });
  process.kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal === 'SIGKILL' && options.exitOnSigkill !== false) {
      Object.defineProperty(process, 'exitCode', { value: 137, writable: true });
      queueMicrotask(() => process.emit('exit', null, 'SIGKILL'));
    }
    return true;
  });
  return process;
}

afterEach(() => {
  vi.useRealTimers();
  getClaudeChildProcessRegistry().resetForTests();
});

describe('ClaudeChildProcessRegistry', () => {
  it('tracks a spawned child and removes it on exit', () => {
    const registry = new ClaudeChildProcessRegistry();
    const child = fakeProcess();

    registry.track(child);
    expect(registry.size).toBe(1);

    child.emit('exit', 0, null);
    expect(registry.size).toBe(0);
  });

  it('escalates a graceful drain from SIGTERM to SIGKILL for survivors', async () => {
    vi.useFakeTimers();
    const registry = new ClaudeChildProcessRegistry();
    const child = fakeProcess();
    registry.track(child);

    const drain = registry.drain({ graceMs: 100 });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(100);
    await drain;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not SIGKILL a child that exits during the grace period', async () => {
    vi.useFakeTimers();
    const registry = new ClaudeChildProcessRegistry();
    const child = fakeProcess();
    registry.track(child);

    const drain = registry.drain({ graceMs: 100 });
    child.emit('exit', 0, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(100);
    await drain;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('retains a spawned child after AbortError so drain can escalate it', async () => {
    vi.useFakeTimers();
    const registry = new ClaudeChildProcessRegistry();
    const child = fakeProcess();
    registry.track(child);

    child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(registry.size).toBe(1);

    const drain = registry.drain({ graceMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await drain;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('immediately terminates a child tracked after drain has started', async () => {
    vi.useFakeTimers();
    const registry = new ClaudeChildProcessRegistry();
    const first = fakeProcess();
    registry.track(first);

    const drain = registry.drain({ graceMs: 100 });
    const late = fakeProcess();
    registry.track(late);
    expect(late.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(100);
    await drain;
    expect(late.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps shutdown monotonic across repeated drains', async () => {
    vi.useFakeTimers();
    const registry = new ClaudeChildProcessRegistry();
    const first = fakeProcess();
    registry.track(first);

    const initialDrain = registry.drain({ graceMs: 100, killWaitMs: 0 });
    await vi.advanceTimersByTimeAsync(100);
    await initialDrain;
    await registry.drain({ graceMs: 100, killWaitMs: 0 });

    const late = fakeProcess();
    registry.track(late);
    expect(late.kill).toHaveBeenCalledWith('SIGKILL');
    expect(late.kill).not.toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects when a child survives SIGKILL', async () => {
    vi.useFakeTimers();
    const registry = new ClaudeChildProcessRegistry();
    const child = fakeProcess({ exitOnSigkill: false });
    registry.track(child);

    const drain = registry.drain({ graceMs: 100, killWaitMs: 50 });
    const assertion = expect(drain).rejects.toThrow('Claude child cleanup failed');
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });

  it('rejects an invalid grace period', async () => {
    const registry = new ClaudeChildProcessRegistry();
    await expect(registry.drain({ graceMs: Number.NaN })).rejects.toThrow('graceMs');
  });

  it('does not retain a signal delivery failure after the child exits', async () => {
    vi.useFakeTimers();
    const registry = new ClaudeChildProcessRegistry();
    const child = fakeProcess();
    child.kill = vi.fn(() => false);
    registry.track(child);

    const drain = registry.drain({ graceMs: 100, killWaitMs: 0 });
    child.emit('exit', 0, 'SIGTERM');

    await expect(drain).resolves.toBeUndefined();
  });

  it('synchronously SIGKILLs every live child on crash', () => {
    const registry = new ClaudeChildProcessRegistry();
    const first = fakeProcess();
    const second = fakeProcess();
    registry.track(first);
    registry.track(second);

    registry.killAllSync('SIGKILL');

    expect(first.kill).toHaveBeenCalledWith('SIGKILL');
    expect(second.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
