import { describe, expect, it, vi } from 'vitest';
import type { TrackedClaudeRootInfo } from '../../agent-runtime/claude-child-process-registry';
import { FakePs } from '../__fixtures__/fake-ps';
import { LocalProcessMonitor } from '../process-monitor';
import type { NodeCapacity } from '../types';

const capacity: NodeCapacity = {
  nodeId: 'n1',
  platform: 'darwin',
  cpuCount: 8,
  cpuBusyPercent: 12.5,
  loadAvg1: 1.5,
  totalMemBytes: 16e9,
  availableMemBytes: 9e9,
};

function setup(opts: { platform?: string; kill?: (pid: number, signal: NodeJS.Signals) => void } = {}) {
  const ps = new FakePs()
    .set(100, { ppid: 1, args: 'node soma' })
    .set(200, { ppid: 100, args: '/usr/local/bin/claude' })
    .set(300, { ppid: 200, args: '/bin/bash -c sleep 100' })
    .set(800, { ppid: 1, args: '/usr/bin/not-ours' });
  const roots: TrackedClaudeRootInfo[] = [{ pid: 200, sessionKey: 'A' }];
  const abort = new Set<(r: TrackedClaudeRootInfo) => void>();
  const signals: Array<[number, NodeJS.Signals]> = [];
  const kill =
    opts.kill ??
    ((pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal]);
      const p = ps.procs.get(pid);
      if (!p) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      p.stat = signal === 'SIGSTOP' ? 'T' : 'S';
    });
  let now = 1_000;
  const monitor = new LocalProcessMonitor({
    nodeId: 'n1',
    roots: {
      roots: () => roots,
      onAbort: (l) => {
        abort.add(l);
        return () => abort.delete(l);
      },
    },
    runPs: ps.run,
    kill,
    platform: opts.platform ?? 'darwin',
    now: () => now,
    readCapacity: async () => capacity,
  });
  return {
    ps,
    roots,
    monitor,
    signals,
    fireAbort: (r: TrackedClaudeRootInfo) => {
      for (const l of abort) l(r);
    },
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const start = 'Mon Nov 23 10:00:00 2026';

describe('LocalProcessMonitor', () => {
  it('a sample carries the node capacity and each session’s tree; usage() drops the process list', async () => {
    const { monitor } = setup();
    const snap = await monitor.sample();
    expect(snap.node).toEqual(capacity);
    expect(snap.sessions.map((s) => s.sessionKey)).toEqual(['A']);
    expect(monitor.usage('A')).toMatchObject({ sessionKey: 'A', processCount: 2, rootAlive: true });
    expect(monitor.usage('A')).not.toHaveProperty('processes');
    expect(monitor.usage('B')).toBeUndefined();
  });

  it('pauses with SIGSTOP and resumes with SIGCONT a process of the session’s tree', async () => {
    const { monitor, signals } = setup();
    const paused = await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    expect(paused).toEqual({ ok: true, pid: 300, state: 'stopped' });
    const resumed = await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'resume' });
    expect(resumed).toEqual({ ok: true, pid: 300, state: 'sleeping' });
    expect(signals).toEqual([
      [300, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
  });

  it('refuses a pid outside the session’s tree — another session’s, the daemon, anything else', async () => {
    const { monitor, signals } = setup();
    for (const pid of [800, 100, 1, 999]) {
      expect(await monitor.control({ sessionKey: 'A', pid, startToken: start, action: 'pause' })).toEqual({
        ok: false,
        reason: 'not-found',
      });
    }
    expect(await monitor.control({ sessionKey: 'B', pid: 300, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(signals).toEqual([]);
  });

  it('refuses a pid whose start time differs from what the caller saw (a reused pid)', async () => {
    const { monitor, signals } = setup();
    const out = await monitor.control({
      sessionKey: 'A',
      pid: 300,
      startToken: 'Sun Nov 22 01:00:00 2026',
      action: 'pause',
    });
    expect(out).toEqual({ ok: false, reason: 'stale' });
    expect(signals).toEqual([]);
  });

  it('answers denied when the OS refuses the signal, unsupported on Windows', async () => {
    const denied = setup({
      kill: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    });
    expect(await denied.monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'denied',
    });
    const win = setup({ platform: 'win32' });
    expect(await win.monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('an aborted turn continues every process the monitor paused in that session', async () => {
    const { monitor, signals, fireAbort } = setup();
    monitor.start();
    try {
      await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
      fireAbort({ pid: 200, sessionKey: 'A' });
      expect(signals).toEqual([
        [300, 'SIGSTOP'],
        [300, 'SIGCONT'],
      ]);
      // Once: nothing is left paused.
      fireAbort({ pid: 200, sessionKey: 'A' });
      expect(signals).toHaveLength(2);
    } finally {
      monitor.stop();
    }
  });

  it('fresh() reuses a recent sample and takes a new one when it is older', async () => {
    const { monitor, ps, tick } = setup();
    await monitor.sample();
    const calls = ps.calls.length;
    await monitor.fresh(1_000);
    expect(ps.calls.length).toBe(calls);
    tick(5_000);
    await monitor.fresh(1_000);
    expect(ps.calls.length).toBeGreaterThan(calls);
  });

  it('tells every listener about each sample, and one failing listener does not stop the others', async () => {
    const { monitor } = setup();
    const good = vi.fn();
    monitor.onSample(() => {
      throw new Error('boom');
    });
    monitor.onSample(good);
    await monitor.sample();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('joins a sample already running instead of starting a second ps', async () => {
    const { monitor, ps } = setup();
    await Promise.all([monitor.sample(), monitor.sample()]);
    expect(ps.calls.filter((c) => c[0] === '-A')).toHaveLength(1);
  });
});
