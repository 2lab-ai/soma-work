import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeChildProcessRegistry,
  getClaudeChildProcessRegistry,
  type TrackedClaudeProcess,
} from '../claude-child-process-registry';

function fakeProcess(options: { exitOnSigkill?: boolean; pid?: number } = {}): TrackedClaudeProcess & EventEmitter {
  const process = new EventEmitter() as TrackedClaudeProcess & EventEmitter;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  Object.defineProperties(process, {
    pid: { value: options.pid ?? 1234 },
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

  // #1473 round 5 (grok): a turn's query resolving its close does not mean its CLI is gone — the next turn of the
  // session waits for the process itself.
  it('waits for the children of one session to exit, not for the others', async () => {
    const registry = new ClaudeChildProcessRegistry();
    const mine = fakeProcess({ pid: 11 });
    const other = fakeProcess({ pid: 12 });
    registry.track(mine, { sessionKey: 'work:C1:1.1' });
    registry.track(other, { sessionKey: 'work:C1:2.2' });

    let exited: boolean | undefined;
    const waiting = registry.waitForSessionExit('work:C1:1.1', 5_000).then((v) => {
      exited = v;
    });
    other.emit('exit', 0, null);
    await Promise.resolve();
    expect(exited).toBeUndefined();

    mine.emit('exit', 0, null);
    await waiting;
    expect(exited).toBe(true);
    expect(registry.hasLiveChildFor('work:C1:1.1')).toBe(false);
  });

  it('stops waiting for a session’s exit at the bound, or when the waiting turn is stopped', async () => {
    vi.useFakeTimers();
    const registry = new ClaudeChildProcessRegistry();
    registry.track(fakeProcess({ pid: 21 }), { sessionKey: 'work:C1:1.1' });

    const bounded = registry.waitForSessionExit('work:C1:1.1', 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await bounded).toBe(false);

    const stop = new AbortController();
    const stopped = registry.waitForSessionExit('work:C1:1.1', 5_000, stop.signal);
    stop.abort('user-stop');
    expect(await stopped).toBe(false);
  });

  it('signals only the children of the session it names', () => {
    const registry = new ClaudeChildProcessRegistry();
    const mine = fakeProcess({ pid: 31 });
    const other = fakeProcess({ pid: 32 });
    registry.track(mine, { sessionKey: 'work:C1:1.1' });
    registry.track(other, { sessionKey: 'work:C1:2.2' });

    expect(registry.killSession('work:C1:1.1', 'SIGTERM')).toBe(1);
    expect(mine.kill).toHaveBeenCalledWith('SIGTERM');
    expect(other.kill).not.toHaveBeenCalled();
  });

  it('signals only the child spawned for one owner object, not a later one of the same session', () => {
    const registry = new ClaudeChildProcessRegistry();
    const earlierOwner = { sessionKey: 'work:C1:1.1' };
    const laterOwner = { sessionKey: 'work:C1:1.1' };
    const earlier = fakeProcess({ pid: 41 });
    const later = fakeProcess({ pid: 42 });
    registry.track(earlier, earlierOwner);
    registry.track(later, laterOwner);

    expect(registry.killOwned(earlierOwner, 'SIGTERM')).toBe(1);
    expect(earlier.kill).toHaveBeenCalledWith('SIGTERM');
    expect(later.kill).not.toHaveBeenCalled();
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

  it('the grace period starts at the SIGTERM, after a slow shutdown listener', async () => {
    vi.useFakeTimers();
    const registry = new ClaudeChildProcessRegistry();
    const child = fakeProcess();
    (child.kill as ReturnType<typeof vi.fn>).mockImplementation((signal: NodeJS.Signals) => {
      // Claude Code needs 50 ms after SIGTERM to clean up.
      if (signal === 'SIGTERM') setTimeout(() => child.emit('exit', 0, null), 50);
      return true;
    });
    registry.track(child);
    // The monitor's resume pass took 10 s (identity probes on a loaded host).
    registry.onShutdown(() => vi.setSystemTime(Date.now() + 10_000));

    const drain = registry.drain({ graceMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await drain;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
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
    // SIGTERM once, followed by SIGCONT (a paused child must run to take it) — never SIGKILL.
    expect((child.kill as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['SIGTERM', 'SIGCONT']);
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

  it('names the session each live child runs for (the process monitor reads it)', () => {
    const registry = new ClaudeChildProcessRegistry();
    const owned = fakeProcess();
    const helper = fakeProcess({ pid: 4321 });
    registry.track(owned, { sessionKey: 'C1-1700000000.000100' });
    registry.track(helper);

    expect(registry.roots()).toEqual([
      { pid: 1234, sessionKey: 'C1-1700000000.000100', turnId: 1 },
      { pid: 4321, turnId: 2 },
    ]);

    owned.emit('exit', 0, null);
    expect(registry.roots()).toEqual([{ pid: 4321, turnId: 2 }]);
  });

  it('numbers each spawn: a child that gets an exited child’s pid is another turn', () => {
    const registry = new ClaudeChildProcessRegistry();
    const first = fakeProcess();
    registry.track(first, { sessionKey: 'K' });
    first.emit('exit', 0, null);
    const second = fakeProcess(); // the OS gave it the same pid, 1234
    registry.track(second, { sessionKey: 'K' });
    const seen: unknown[] = [];
    registry.onAbort((root) => seen.push(root));
    registry.notifyAborted(first); // a late abort of the first turn
    registry.notifyAborted(second);
    expect(seen).toEqual([
      { pid: 1234, sessionKey: 'K', turnId: 1 },
      { pid: 1234, sessionKey: 'K', turnId: 2 },
    ]);
  });

  it('tells abort listeners which session a child was aborted in, and survives a throwing listener', () => {
    const registry = new ClaudeChildProcessRegistry();
    const child = fakeProcess();
    registry.track(child, { sessionKey: 'K' });
    const seen: unknown[] = [];
    registry.onAbort(() => {
      throw new Error('boom');
    });
    const off = registry.onAbort((root) => seen.push(root));

    registry.notifyAborted(child);
    off();
    registry.notifyAborted(child);

    expect(seen).toEqual([{ pid: 1234, sessionKey: 'K', turnId: 1 }]);
  });

  it('tells shutdown listeners before it kills (drain and crash), so paused processes can be continued first', async () => {
    const registry = new ClaudeChildProcessRegistry();
    const child = fakeProcess();
    registry.track(child);
    const order: string[] = [];
    (child.kill as ReturnType<typeof vi.fn>).mockImplementation((sig: NodeJS.Signals) => {
      order.push(sig);
      if (sig === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
      return true;
    });
    registry.onShutdown(() => order.push('listener'));
    await registry.drain({ graceMs: 100, killWaitMs: 0 });
    expect(order.slice(0, 3)).toEqual(['listener', 'SIGTERM', 'SIGCONT']);

    const crash = new ClaudeChildProcessRegistry();
    const seen: string[] = [];
    crash.onShutdown(() => seen.push('listener'));
    crash.killAllSync('SIGKILL');
    expect(seen).toEqual(['listener']);
  });
});
