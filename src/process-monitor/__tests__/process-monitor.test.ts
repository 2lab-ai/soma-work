import { describe, expect, it, vi } from 'vitest';
import type { TrackedClaudeRootInfo } from '../../agent-runtime/claude-child-process-registry';
import { FakePs } from '../__fixtures__/fake-ps';
import { LocalProcessMonitor, psLiveStartToken } from '../process-monitor';
import type { NodeCapacity } from '../types';

type RootFixture = Omit<TrackedClaudeRootInfo, 'turnId'> & { turnId?: number };
const withTurn = (r: RootFixture): TrackedClaudeRootInfo => ({ ...r, turnId: r.turnId ?? r.pid });

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
    readCapacity?: () => Promise<NodeCapacity>;
    logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
    inspectProcess?: import('../process-inspector').InspectProcess;
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
  // A root's turnId is its pid unless a test gives one (the registry numbers each spawn).
  const roots: RootFixture[] = [
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
      roots: () => roots.map(withTurn),
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
    readCapacity: opts.readCapacity ?? (async () => capacity),
    logger: opts.logger,
    inspectProcess: opts.inspectProcess,
  });
  return {
    ps,
    roots,
    monitor,
    signals,
    fireAbort: (r: RootFixture) => {
      for (const l of abort) l(withTurn(r));
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

/** What an inspector answers for a pid (the OS side of a detail snapshot); the tree side comes from the monitor. */
const inspection = (pid: number, startToken: string) => ({
  pid,
  ppid: 0,
  pgid: null,
  startToken,
  startedAt: null,
  elapsedSeconds: 5,
  exe: '/bin/bash',
  commandLine: '/bin/bash -c sleep 100',
  argvExact: false,
  cwd: '/work',
  user: 'z',
  uid: 501,
  stat: 'S',
  state: 'sleeping' as const,
  nice: 0,
  priority: 20,
  cpuSeconds: 1,
  psCpuPercent: 0,
  memPercent: 0.1,
  rssBytes: 1,
  vszBytes: 2,
  peakRssBytes: null,
  threads: 1,
  contextSwitches: null,
  io: null,
  fdCount: 3,
  fdByType: {},
  files: [],
  filesTruncated: false,
  fdScanPartial: false,
  sockets: [],
  socketsTruncated: false,
  takenAt: 1,
  unreadable: [],
});

describe('LocalProcessMonitor.inspect — one process in depth, a snapshot', () => {
  it('answers the inspector’s read plus where the process sits: its parent chain, children and subtree totals', async () => {
    const inspectProcess = vi.fn(async (pid: number, token: string) => inspection(pid, token));
    const { monitor, ps } = setup({ inspectProcess });
    ps.set(310, { ppid: 300, args: '/bin/sleep 100', rssKb: 2_000 });
    const got = await monitor.inspect({ sessionKey: 'A', pid: 300, startToken: start });
    expect(inspectProcess).toHaveBeenCalledWith(300, start);
    if (!got.ok) throw new Error(`expected ok, got ${got.reason}`);
    expect(got.detail).toMatchObject({
      sessionKey: 'A',
      nodeId: 'n1',
      pid: 300,
      name: 'bash',
      role: 'child',
      depth: 1,
      exe: '/bin/bash',
      cwd: '/work',
      ancestors: [{ pid: 200, name: 'claude', role: 'root' }],
      children: [{ pid: 310, name: 'sleep' }],
      subtree: { processCount: 2 },
    });
    expect(got.detail.subtree.rssBytes).toBe((1000 + 2000) * 1024);
  });

  it('refuses a pid outside the session’s tree, a stale start time, and answers unsupported with no inspector', async () => {
    const inspectProcess = vi.fn(async (pid: number, token: string) => inspection(pid, token));
    const { monitor } = setup({ inspectProcess });
    // 600 is session B's; 800 is nobody's.
    expect(await monitor.inspect({ sessionKey: 'A', pid: 600, startToken: start })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await monitor.inspect({ sessionKey: 'A', pid: 800, startToken: start })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await monitor.inspect({ sessionKey: 'Z', pid: 300, startToken: start })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await monitor.inspect({ sessionKey: 'A', pid: 300, startToken: 'Sun Nov 22 10:00:00 2026' })).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(inspectProcess).not.toHaveBeenCalled();
    const bare = setup();
    expect(await bare.monitor.inspect({ sessionKey: 'A', pid: 300, startToken: start })).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('the inspector’s own identity checks decide: gone → not-found, reused mid-read → stale', async () => {
    const inspectProcess = vi.fn<import('../process-inspector').InspectProcess>();
    const { monitor } = setup({ inspectProcess });
    inspectProcess.mockResolvedValueOnce('gone');
    expect(await monitor.inspect({ sessionKey: 'A', pid: 300, startToken: start })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    inspectProcess.mockResolvedValueOnce('stale');
    expect(await monitor.inspect({ sessionKey: 'A', pid: 300, startToken: start })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });
});

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

  it('an abort of another turn during the check does not block a pause; its own turn’s abort does', async () => {
    const make = () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let held = false;
      return {
        release: () => release(),
        runPs: (ps: FakePs) => async (a: readonly string[]) => {
          if (!held) {
            held = true;
            await gate;
          }
          return ps.run(a);
        },
      };
    };
    const g1 = make();
    const one = setup({ runPs: g1.runPs });
    const p1 = one.monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    one.fireAbort({ pid: 199, sessionKey: 'A' }); // an earlier turn of A
    g1.release();
    expect(await p1).toMatchObject({ ok: true });

    const g2 = make();
    const two = setup({ runPs: g2.runPs });
    const p2 = two.monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    two.fireAbort({ pid: 200, sessionKey: 'A' }); // 300's own turn
    g2.release();
    expect(await p2).toEqual({ ok: false, reason: 'not-found' });
  });

  it('an orphan keeps the turn it was seen under: that turn’s abort continues it, a later turn’s does not', async () => {
    const { monitor, signals, fireAbort, ps, roots } = setup();
    await monitor.sample(); // 300 seen under turn 200
    // Turn 200 ends; bash 300 is re-parented by the OS; the next turn 201 starts.
    ps.remove(200).reparent(300, 1).set(201, { ppid: 100, args: '/usr/local/bin/claude' });
    roots.splice(0, 1, { pid: 201, sessionKey: 'A' });
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    fireAbort({ pid: 201, sessionKey: 'A' });
    expect(signals).toEqual([[300, 'SIGSTOP']]);
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(signals).toEqual([
      [300, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
  });

  it('the abort fence holds however many aborts the session had before (round 6: a capped history went blind)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let hold = false;
    const { monitor, signals, fireAbort } = setup({
      runPs: (ps) => async (a) => {
        if (hold) {
          hold = false;
          await gate;
        }
        return ps.run(a);
      },
    });
    for (let i = 0; i < 100; i++) fireAbort({ pid: 1_000 + i, sessionKey: 'A' }); // earlier turns of A
    hold = true;
    const pending = monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    fireAbort({ pid: 200, sessionKey: 'A' }); // 300's own turn, while the check samples
    release();
    expect(await pending).toEqual({ ok: false, reason: 'not-found' });
    expect(signals).toEqual([]);
  });

  it('a child born under an orphan inherits the orphan’s turn: a later turn’s abort leaves its pause alone', async () => {
    const { monitor, signals, fireAbort, ps, roots, tick } = setup();
    await monitor.sample(); // 300 seen under turn 200
    // Turn 200 ends; bash 300 is re-parented and then starts 310; the next turn 201 starts.
    ps.remove(200)
      .reparent(300, 1)
      .set(310, { ppid: 300, args: '/bin/sleep 100' })
      .set(201, { ppid: 100, args: '/usr/local/bin/claude' });
    roots.splice(0, 1, { pid: 201, sessionKey: 'A' });
    tick(1);
    expect(await monitor.control({ sessionKey: 'A', pid: 310, startToken: start, action: 'pause' })).toMatchObject({
      ok: true,
    });
    fireAbort({ pid: 201, sessionKey: 'A' });
    expect(signals).toEqual([[310, 'SIGSTOP']]);
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(signals).toEqual([
      [310, 'SIGSTOP'],
      [310, 'SIGCONT'],
    ]);
  });

  it('a turn is its spawn, not its pid: a late abort of a turn whose pid the next one reused continues only its own', async () => {
    const { monitor, signals, fireAbort, ps, roots, tick } = setup();
    roots[0] = { pid: 200, sessionKey: 'A', turnId: 1 };
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    // Turn 1's Claude Code exits (300 is re-parented); the OS gives pid 200 to turn 2's, which starts 310.
    ps.reparent(300, 1)
      .set(200, { ppid: 100, start: 'Tue Nov 24 09:00:00 2026', args: '/usr/local/bin/claude' })
      .set(310, { ppid: 200, args: '/bin/sleep 100' });
    roots[0] = { pid: 200, sessionKey: 'A', turnId: 2 };
    for (let i = 0; i < 2; i++) {
      tick(1);
      await monitor.sample();
    }
    expect(await monitor.control({ sessionKey: 'A', pid: 310, startToken: start, action: 'pause' })).toMatchObject({
      ok: true,
    });
    fireAbort({ pid: 200, sessionKey: 'A', turnId: 1 }); // turn 1's abort, late
    expect(signals).toEqual([
      [300, 'SIGSTOP'],
      [310, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
  });

  it('a pause missing from one sample is kept while its process lives: the abort still continues it', async () => {
    let hide = false;
    const { monitor, signals, fireAbort, tick } = setup({
      // ps leaves 300's row out of the detail call (a skipped or unreadable row), though the process is alive.
      runPs: (ps) => async (a) => {
        const out = await ps.run(a);
        if (!hide || a[0] === '-A') return out;
        return out
          .split('\n')
          .filter((line) => line.trim().split(/\s+/)[0] !== '300')
          .join('\n');
      },
    });
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    hide = true;
    tick(1);
    const snap = await monitor.sample();
    expect(snap.sessions.find((s) => s.sessionKey === 'A')?.processes.map((p) => p.pid)).not.toContain(300);
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(signals).toEqual([
      [300, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
  });

  it('a pause whose process is confirmed gone is dropped (nothing to continue later)', async () => {
    const { monitor, signals, fireShutdown, ps, tick } = setup();
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    ps.remove(300);
    tick(1);
    await monitor.sample();
    fireShutdown();
    expect(signals).toEqual([[300, 'SIGSTOP']]);
  });

  it('a failed capacity read keeps the sampling lock until the tree read settles: no second sampler runs', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let failCapacity = true;
    const { monitor, ps } = setup({
      runPs: (fake) => async (a) => {
        const out = fake.run(a); // recorded in fake.calls now
        if (failCapacity) await gate;
        return out;
      },
      readCapacity: async () => {
        if (failCapacity) throw new Error('vm_stat failed');
        return capacity;
      },
    });
    const first = monitor.sample();
    first.catch(() => {});
    await new Promise((r) => setTimeout(r, 0)); // the capacity read has rejected; the tree read still waits
    const second = monitor.sample();
    second.catch(() => {});
    expect(ps.calls.filter((c) => c[0] === '-A')).toHaveLength(1);
    release();
    await expect(first).rejects.toThrow('vm_stat failed');
    await expect(second).rejects.toThrow('vm_stat failed');
    failCapacity = false;
    const next = await monitor.sample();
    expect(next.sessions.map((x) => x.sessionKey).sort()).toEqual(['A', 'B']);
  });

  it('refuses a pause in a turn whose abort already ran (nothing would continue it); another turn still pauses', async () => {
    const { monitor, signals, fireAbort, ps, roots } = setup();
    ps.set(210, { ppid: 100, args: '/usr/local/bin/claude' }).set(310, { ppid: 210, args: '/bin/bash -c b' });
    roots.push({ pid: 210, sessionKey: 'A' });
    fireAbort({ pid: 200, sessionKey: 'A' }); // turn 200 is stopping; its Claude Code has not exited yet
    expect(await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await monitor.control({ sessionKey: 'A', pid: 310, startToken: start, action: 'pause' })).toMatchObject({
      ok: true,
    });
    expect(signals).toEqual([[310, 'SIGSTOP']]);
  });

  it('an orphan keeps its turn across a sample that missed its row', async () => {
    let hide = false;
    const { monitor, signals, fireAbort, ps, roots, tick } = setup({
      runPs: (fake) => async (a) => {
        const out = await fake.run(a);
        if (!hide || a[0] === '-A') return out;
        return out
          .split('\n')
          .filter((line) => line.trim().split(/\s+/)[0] !== '300')
          .join('\n');
      },
    });
    await monitor.sample(); // 300 under turn 200
    ps.remove(200).reparent(300, 1).set(201, { ppid: 100, args: '/usr/local/bin/claude' });
    roots.splice(0, 1, { pid: 201, sessionKey: 'A' });
    hide = true;
    tick(1);
    await monitor.sample(); // 300's row is missing
    hide = false;
    tick(1);
    expect(await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).toMatchObject({
      ok: true,
    });
    fireAbort({ pid: 201, sessionKey: 'A' }); // the next turn's abort: not 300's
    expect(signals).toEqual([[300, 'SIGSTOP']]);
    fireAbort({ pid: 200, sessionKey: 'A' }); // its own turn's
    expect(signals).toEqual([
      [300, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
  });

  it('shutdown spends a bounded time on identity probes, then reports what is left', async () => {
    let probes = 0;
    let probing = false;
    const warn = vi.fn();
    const { monitor, ps, roots, fireShutdown, tick } = setup({
      live: (_pid, fallback) => {
        if (!probing) return fallback;
        probes++;
        tick(2_000); // each probe times out after 2 s
        return undefined;
      },
      logger: { info: () => {}, warn },
    });
    ps.set(310, { ppid: 200, args: '/bin/sleep 1' }).set(320, { ppid: 200, args: '/bin/sleep 2' });
    roots.length = 1;
    for (const pid of [300, 310, 320]) {
      await monitor.control({ sessionKey: 'A', pid, startToken: start, action: 'pause' });
      tick(1);
    }
    probing = true;
    fireShutdown();
    expect(probes).toBe(3); // 5 s budget: probes at 0, 2 and 4 s — not 3 tries × 3 processes
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shutdown could not continue'), {
      pids: [300, 310, 320],
    });
  });

  it('the timer skips an idle node and starts sampling when a turn appears', async () => {
    vi.useFakeTimers();
    try {
      const { monitor, ps, roots } = setup();
      const saved = roots.splice(0);
      monitor.start();
      await vi.advanceTimersByTimeAsync(5_000); // first tick: one empty sample (no ps: nothing tracked)
      await vi.advanceTimersByTimeAsync(5_000); // idle: skipped
      expect(ps.calls).toEqual([]);
      expect(monitor.latest()?.sessions).toEqual([]);
      roots.push(...saved);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ps.calls.some((c) => c[0] === '-A')).toBe(true);
      expect(
        monitor
          .latest()
          ?.sessions.map((x) => x.sessionKey)
          .sort(),
      ).toEqual(['A', 'B']);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('two live turns in one session: each abort continues only its own tree’s pauses', async () => {
    const { monitor, signals, fireAbort, ps, roots } = setup();
    ps.set(210, { ppid: 100, args: '/usr/local/bin/claude' }).set(310, { ppid: 210, args: '/bin/bash -c b' });
    roots.push({ pid: 210, sessionKey: 'A' });
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    await monitor.control({ sessionKey: 'A', pid: 310, startToken: start, action: 'pause' });
    signals.length = 0;
    fireAbort({ pid: 210, sessionKey: 'A' });
    expect(signals).toEqual([[310, 'SIGCONT']]);
  });

  it('shutdown retries what it could not continue, a few times, before giving up', async () => {
    let failing = 0;
    const { monitor, signals, fireShutdown } = setup({
      live: (_pid, fallback) => (failing-- > 0 ? undefined : fallback),
    });
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    signals.length = 0;
    failing = 2; // the first two identity reads fail; the third works
    fireShutdown();
    expect(signals).toEqual([[300, 'SIGCONT']]);
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

describe('psLiveStartToken — gone only when ps says so silently', () => {
  const fail = (status: number, stdout: string, stderr: string) => () => {
    throw Object.assign(new Error('ps failed'), { status, stdout, stderr });
  };

  it('reads the start time; a silent exit 1 is gone; a diagnostic, another status or a timeout is unknown', () => {
    expect(psLiveStartToken(42, () => 'Mon Nov 23  10:00:00 2026\n')).toBe('Mon Nov 23 10:00:00 2026');
    expect(psLiveStartToken(42, fail(1, '', ''))).toBeNull();
    expect(psLiveStartToken(42, fail(1, '', 'ps: sysctl: Cannot allocate memory\n'))).toBeUndefined();
    expect(psLiveStartToken(42, fail(2, '', ''))).toBeUndefined();
    expect(psLiveStartToken(42, fail(1, 'garbage', ''))).toBeUndefined();
    expect(
      psLiveStartToken(42, () => {
        throw Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' });
      }),
    ).toBeUndefined();
  });

  it('against the real ps: this process has a start time; an exited pid is gone; a pid ps rejects is unknown', async () => {
    expect(psLiveStartToken(process.pid)).toMatch(/\d{4}$/);
    const { spawn } = await import('node:child_process');
    const child = spawn('/usr/bin/true');
    await new Promise((r) => child.on('exit', r));
    expect(psLiveStartToken(child.pid as number)).toBeNull();
    // macOS: "ps: process id too large" on stderr with exit 1 — a diagnostic, not a missing process.
    if (process.platform === 'darwin') expect(psLiveStartToken(2147483646)).toBeUndefined();
  });
});
