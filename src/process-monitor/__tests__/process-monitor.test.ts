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

function setup(
  opts: {
    live?: (pid: number, fallback: string | null) => string | null | undefined;
    platform?: string;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    runPs?: (ps: FakePs) => (a: readonly string[]) => Promise<string>;
  } = {},
) {
  const ps = new FakePs()
    .set(100, { ppid: 1, args: 'node soma' })
    .set(200, { ppid: 100, args: '/usr/local/bin/claude' })
    .set(300, { ppid: 200, args: '/bin/bash -c sleep 100' })
    // Session B: its own Claude Code process and child.
    .set(500, { ppid: 100, args: '/usr/local/bin/claude' })
    .set(600, { ppid: 500, args: '/usr/bin/node server.js' })
    .set(800, { ppid: 1, args: '/usr/bin/not-ours' });
  const roots: TrackedClaudeRootInfo[] = [
    { pid: 200, sessionKey: 'A' },
    { pid: 500, sessionKey: 'B' },
  ];
  const abort = new Set<(r: TrackedClaudeRootInfo) => void>();
  const shutdown = new Set<() => void>();
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
      onShutdown: (l) => {
        shutdown.add(l);
        return () => shutdown.delete(l);
      },
    },
    runPs: opts.runPs ? opts.runPs(ps) : ps.run,
    kill,
    liveStartToken: (pid) => {
      const fallback = ps.procs.get(pid)?.start ?? (ps.procs.has(pid) ? 'Mon Nov 23 10:00:00 2026' : null);
      return opts.live ? opts.live(pid, fallback) : fallback;
    },
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
    fireShutdown: () => {
      for (const l of shutdown) l();
    },
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const start = 'Mon Nov 23 10:00:00 2026';

describe('LocalProcessMonitor', () => {
  it('a sample carries the node capacity and each session’s tree', async () => {
    const { monitor } = setup();
    const snap = await monitor.sample();
    expect(snap.node).toEqual(capacity);
    expect(snap.sessions.map((s) => s.sessionKey).sort()).toEqual(['A', 'B']);
    expect(monitor.latest()?.sessions.find((x) => x.sessionKey === 'A')).toMatchObject({
      processCount: 2,
      rootAlive: true,
    });
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

  it('refuses a pid outside the session’s tree — another live session’s, the daemon, anything else', async () => {
    const { monitor, signals } = setup();
    for (const pid of [800, 100, 1, 999, 500, 600]) {
      expect(await monitor.control({ sessionKey: 'A', pid, startToken: start, action: 'pause' })).toEqual({
        ok: false,
        reason: 'not-found',
      });
    }
    for (const pid of [200, 300]) {
      expect(await monitor.control({ sessionKey: 'B', pid, startToken: start, action: 'pause' })).toEqual({
        ok: false,
        reason: 'not-found',
      });
    }
    expect(signals).toEqual([]);
  });

  it('refuses a pause whose check spans an abort of that turn (its cleanup already ran)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    const { monitor, signals, fireAbort } = setup({
      runPs: (ps) => async (a) => {
        if (!held) {
          held = true;
          await gate;
        }
        return ps.run(a);
      },
    });
    const pending = monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    fireAbort({ pid: 200, sessionKey: 'A' });
    release();
    expect(await pending).toEqual({ ok: false, reason: 'not-found' });
    expect(signals).toEqual([]);
  });

  it('cleanup works on a monitor whose timer never started', async () => {
    const { monitor, signals, fireAbort } = setup();
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(signals).toEqual([
      [300, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
  });

  it('never continues a pid the OS reused after the pause (live start time differs)', async () => {
    const { monitor, signals, fireAbort, ps } = setup();
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    // The paused bash is killed from outside; another program gets pid 300 before the next sample.
    ps.set(300, { ppid: 1, start: 'Tue Nov 24 08:00:00 2026', args: '/usr/bin/someone-else' });
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(signals).toEqual([[300, 'SIGSTOP']]);
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

  it('refuses when the process table itself changed: the pid the tab showed now names another program', async () => {
    const { monitor, signals, ps } = setup();
    await monitor.sample();
    // The bash the tab listed exited; an unrelated program under the same parent got pid 300.
    ps.set(300, { ppid: 200, start: 'Tue Nov 24 08:00:00 2026', args: '/usr/bin/someone-else' });
    expect(await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(signals).toEqual([]);
  });

  it('refuses a pause once shutdown cleanup ran, and a pause whose check spans it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    const { monitor, signals, fireShutdown } = setup({
      runPs: (ps) => async (a) => {
        if (!held) {
          held = true;
          await gate;
        }
        return ps.run(a);
      },
    });
    const pending = monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    fireShutdown();
    release();
    expect(await pending).toEqual({ ok: false, reason: 'not-found' });
    expect(await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(signals).toEqual([]);
  });

  it('keeps a pause tracked when the OS refuses its automatic resume, so shutdown tries again', async () => {
    let refuse = false;
    const sent: Array<[number, NodeJS.Signals]> = [];
    const { monitor, fireAbort, fireShutdown } = setup({
      kill: (pid, signal) => {
        if (refuse && signal === 'SIGCONT') throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        sent.push([pid, signal]);
      },
    });
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    refuse = true;
    fireAbort({ pid: 200, sessionKey: 'A' });
    refuse = false;
    fireShutdown();
    expect(sent).toEqual([
      [300, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
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

  it('the daemon shutting down continues every process the monitor paused, in every session', async () => {
    const { monitor, signals, fireShutdown } = setup();
    monitor.start();
    try {
      await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
      await monitor.control({ sessionKey: 'A', pid: 200, startToken: start, action: 'pause' });
      signals.length = 0;
      fireShutdown();
      expect(signals.sort()).toEqual([
        [200, 'SIGCONT'],
        [300, 'SIGCONT'],
      ]);
    } finally {
      monitor.stop();
    }
  });

  it('an identity probe that fails keeps the pause tracked (unknown is not gone); the next pass continues it', async () => {
    let probeFails = false;
    const { monitor, signals, fireAbort, fireShutdown } = setup({
      live: (_pid, fallback) => (probeFails ? undefined : fallback),
    });
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    probeFails = true;
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(signals).toEqual([[300, 'SIGSTOP']]);
    probeFails = false;
    fireShutdown();
    expect(signals).toEqual([
      [300, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
  });

  it('a manual signal whose identity probe fails is refused (denied), never sent blind', async () => {
    const { monitor, signals } = setup({ live: () => undefined });
    expect(await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(signals).toEqual([]);
  });

  it('a late abort of an earlier turn does not continue a pause made under the next turn', async () => {
    const { monitor, signals, fireAbort, ps, roots } = setup();
    // Turn rollover in session A: Claude Code 200 exits, the next turn's 201 starts a child 301.
    ps.remove(300).remove(200).set(201, { ppid: 100, args: '/usr/local/bin/claude' });
    ps.set(301, { ppid: 201, args: '/bin/bash -c make' });
    roots.splice(0, 1, { pid: 201, sessionKey: 'A' });
    await monitor.control({ sessionKey: 'A', pid: 301, startToken: start, action: 'pause' });
    // The SDK's abort of the earlier turn (200) arrives late.
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(signals).toEqual([[301, 'SIGSTOP']]);
    fireAbort({ pid: 201, sessionKey: 'A' });
    expect(signals).toEqual([
      [301, 'SIGSTOP'],
      [301, 'SIGCONT'],
    ]);
  });

  it('an abort’s resume that could not be done is retried on every sample until it lands', async () => {
    let refuse = false;
    const sent: Array<[number, NodeJS.Signals]> = [];
    const { monitor, fireAbort } = setup({
      kill: (pid, signal) => {
        if (refuse && signal === 'SIGCONT') throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        sent.push([pid, signal]);
      },
    });
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    refuse = true;
    fireAbort({ pid: 200, sessionKey: 'A' });
    await monitor.sample();
    expect(sent).toEqual([[300, 'SIGSTOP']]);
    refuse = false;
    await monitor.sample();
    expect(sent).toEqual([
      [300, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
    await monitor.sample();
    expect(sent).toHaveLength(2);
  });

  it('a delivered signal stays a success when the follow-up sample fails', async () => {
    let calls = 0;
    const { monitor, signals } = setup({
      runPs: (ps) => async (a) => {
        calls++;
        if (calls > 2) throw new Error('ps timed out');
        return ps.run(a);
      },
    });
    expect(await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).toEqual({
      ok: true,
      pid: 300,
      state: 'stopped',
    });
    expect(signals).toEqual([[300, 'SIGSTOP']]);
  });

  it('shutdown continues the paused processes of every session', async () => {
    const { monitor, signals, fireShutdown } = setup();
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    await monitor.control({ sessionKey: 'B', pid: 600, startToken: start, action: 'pause' });
    signals.length = 0;
    fireShutdown();
    expect(signals.sort()).toEqual([
      [300, 'SIGCONT'],
      [600, 'SIGCONT'],
    ]);
  });

  it('a sample that fails does not wedge the monitor: the next one runs', async () => {
    let fail = true;
    const { monitor } = setup({
      runPs: (ps) => async (a) => {
        if (fail) {
          fail = false;
          throw new Error('ps timed out');
        }
        return ps.run(a);
      },
    });
    await expect(monitor.sample()).rejects.toThrow('ps timed out');
    const snap = await monitor.sample();
    expect(snap.sessions.map((s) => s.sessionKey).sort()).toEqual(['A', 'B']);
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
