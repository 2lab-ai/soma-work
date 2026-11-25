import { describe, expect, it, vi } from 'vitest';
import type { TrackedClaudeRootInfo } from '../../agent-runtime/claude-child-process-registry';
import { FakePs } from '../__fixtures__/fake-ps';
import { LocalProcessMonitor, psLiveStartToken, psLiveStartTokens } from '../process-monitor';
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
    readThrottle?: import('../cpu-throttler').ReadThrottle;
    /** Called on every batched identity read (the default answers from the fake table through `live`). */
    onBatchRead?: (pids: readonly number[]) => void;
    /** Called on every one-pid identity read. */
    onSingleRead?: (pid: number) => void;
    /** The host brings only the one-pid identity read (no batched one). */
    noBatch?: boolean;
    /** While true, every batched identity read fails (a ps that timed out); one-pid reads still answer. */
    batchFails?: () => boolean;
    /** While true, every one-pid identity read fails; batched reads still answer. */
    singleFails?: () => boolean;
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
  // The CPU throttler's timers: run by hand (runTimers), never on their own.
  const timers: Array<() => void> = [];
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
      opts.onSingleRead?.(pid);
      if (opts.singleFails?.()) return undefined;
      const fallback = ps.procs.get(pid)?.start ?? (ps.procs.has(pid) ? 'Mon Nov 23 10:00:00 2026' : null);
      return opts.live ? opts.live(pid, fallback) : fallback;
    },
    liveStartTokens: opts.noBatch
      ? undefined
      : (pids) => {
          opts.onBatchRead?.(pids);
          if (opts.batchFails?.()) return undefined;
          const out = new Map<number, string | null>();
          for (const pid of pids) {
            const fallback = ps.procs.get(pid)?.start ?? (ps.procs.has(pid) ? 'Mon Nov 23 10:00:00 2026' : null);
            const v = opts.live ? opts.live(pid, fallback) : fallback;
            if (v === undefined) return undefined;
            out.set(pid, v);
          }
          return out;
        },
    platform: opts.platform ?? 'darwin',
    now: () => now,
    readCapacity: opts.readCapacity ?? (async () => capacity),
    logger: opts.logger,
    inspectProcess: opts.inspectProcess,
    // The period read, from the fake process table (a test may bring its own).
    readThrottle:
      opts.readThrottle ??
      (async (pids) =>
        new Map(
          pids
            .filter((pid) => ps.procs.has(pid))
            .map((pid) => {
              const p = ps.procs.get(pid) as { ppid: number; stat?: string; start?: string; cpu?: number };
              return [
                pid,
                {
                  ppid: p.ppid,
                  stat: p.stat ?? 'S',
                  startToken: p.start ?? 'Mon Nov 23 10:00:00 2026',
                  cpuSeconds: p.cpu ?? 0,
                },
              ];
            }),
        )),
    // The throttler's periods do not run on their own here; a test drives what it needs.
    setTimer: (fn: () => void) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: (h: unknown) => {
      const i = timers.indexOf(h as () => void);
      if (i >= 0) timers.splice(i, 1);
    },
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
    /** Run the oldest armed throttler timer only (a period's hold lands before the next period continues it). */
    runOne: async () => {
      timers.shift()?.();
      for (let i = 0; i < 20; i++) await Promise.resolve();
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

  it('the line of detail reads is bounded, turns away a read that waited too long, and survives a failing read', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const inspectProcess = vi.fn(async (pid: number, token: string) => {
      calls++;
      if (calls === 1) {
        await gate;
        throw new Error('lsof hung up');
      }
      return inspection(pid, token);
    });
    const { monitor, tick } = setup({ inspectProcess });
    const ask = () => monitor.inspect({ sessionKey: 'A', pid: 300, startToken: start });
    const first = ask();
    await new Promise((r) => setTimeout(r, 5));
    const waiting = [ask(), ask(), ask()];
    // The line holds four (the running one does not count once started); a fifth is turned away at once.
    const extra = [ask(), ask()];
    expect(await extra[1]).toEqual({ ok: false, reason: 'busy' });
    release();
    await expect(first).rejects.toThrow(/lsof/);
    // After the failure the line goes on.
    expect((await waiting[0]).ok).toBe(true);
    await Promise.all([...waiting, extra[0]]);
    // A read that waited longer than a reader waits is not started.
    let hold: () => void = () => {};
    const slow = new Promise<void>((r) => {
      hold = r;
    });
    inspectProcess.mockImplementationOnce(async (pid: number, token: string) => {
      await slow;
      return inspection(pid, token);
    });
    const busy = ask();
    await new Promise((r) => setTimeout(r, 5));
    const late = ask();
    tick(11_000);
    const started = inspectProcess.mock.calls.length;
    hold();
    expect((await busy).ok).toBe(true);
    expect(await late).toEqual({ ok: false, reason: 'busy' });
    // Turned away before it ran: the inspector (ps, lsof, socket tables) is never called for it.
    expect(inspectProcess.mock.calls.length).toBe(started);
  });

  it('detail reads run one at a time on a node (a burst of clicks does not multiply ps / lsof)', async () => {
    let running = 0;
    let most = 0;
    const inspectProcess = vi.fn(async (pid: number, token: string) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return inspection(pid, token);
    });
    const { monitor } = setup({ inspectProcess });
    const all = await Promise.all(
      [1, 2, 3].map(() => monitor.inspect({ sessionKey: 'A', pid: 300, startToken: start })),
    );
    expect(all.every((r) => r.ok)).toBe(true);
    expect(most).toBe(1);
    expect(inspectProcess).toHaveBeenCalledTimes(3);
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

describe('LocalProcessMonitor — the CPU cap on each task', () => {
  it('a task over its cap is metered: what the cap holds reads running + throttled, any other stop stays a stop', async () => {
    const { monitor, ps, runOne, signals } = setup();
    // Session A: 300 burns 4 cores (ps's own %cpu on a first sample); 310 was stopped by someone else (job control).
    ps.set(300, { ppid: 200, args: '/bin/bash -c make', psCpu: 400 });
    ps.set(310, { ppid: 200, args: '/bin/bash -c vim', stat: 'T' });
    monitor.setCpuCaps((key) => (key === 'A' ? 100 : null));
    const first = await monitor.sample();
    const a = first.sessions.find((x) => x.sessionKey === 'A');
    expect(a).toMatchObject({ cpuCapPercent: 100, throttling: true });
    // B has no cap (an admin's task): no cap fields at all.
    const b = first.sessions.find((x) => x.sessionKey === 'B');
    expect(b).not.toHaveProperty('cpuCapPercent');
    expect(b).not.toHaveProperty('throttling');
    // A period runs (it arms its hold, then the next period), then its hold lands: 300 is held (a real SIGSTOP); 310,
    // stopped by someone else, is never signalled.
    await runOne();
    await runOne();
    expect(signals).toContainEqual([300, 'SIGSTOP']);
    expect(signals.some(([pid]) => pid === 310)).toBe(false);
    const held = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'A');
    // ps says T for both: the cap's hold reads running and throttled; the foreign stop stays a stop.
    expect(held?.processes.find((p) => p.pid === 300)).toMatchObject({ state: 'running', throttled: true });
    expect(held?.processes.find((p) => p.pid === 310)).toMatchObject({ state: 'stopped' });
    expect(held?.processes.find((p) => p.pid === 310)).not.toHaveProperty('throttled');
    expect(held?.stoppedCount).toBe(1);
    monitor.dispose();
    expect(ps.procs.get(300)?.stat).not.toBe('T');
  });

  it('the sample in which a cap is removed still reads the cap’s last hold as throttled, not paused', async () => {
    const { monitor, ps, runOne } = setup();
    ps.set(300, { ppid: 200, args: '/bin/bash -c make', psCpu: 400 });
    let cap: number | null = 100;
    monitor.setCpuCaps(() => cap);
    await monitor.sample();
    await runOne();
    await runOne();
    expect(ps.procs.get(300)?.stat).toBe('T');
    // An admin sets the owner to 무제한: the next sample reads 300 stopped, then the update releases it.
    cap = null;
    const a = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'A');
    expect(a?.processes.find((p) => p.pid === 300)).toMatchObject({ state: 'running', throttled: true });
    expect(a?.stoppedCount).toBe(0);
    expect(a).not.toHaveProperty('cpuCapPercent');
    expect(ps.procs.get(300)?.stat).not.toBe('T');
  });

  it('a sample in flight when the turn aborts does not meter that turn again; the next turn is capped', async () => {
    let gate: () => void = () => {};
    let gated = false;
    const { monitor, ps, roots, fireAbort, runOne, signals } = setup({
      readCapacity: () =>
        gated
          ? new Promise((r) => {
              gate = () => r(capacity);
            })
          : Promise.resolve(capacity),
    });
    ps.set(300, { ppid: 200, args: '/bin/bash -c make', psCpu: 400 });
    monitor.setCpuCaps(() => 100);
    // The tree is read over its cap; the capacity read is still pending when the person stops the task.
    gated = true;
    const inFlight = monitor.sample();
    await new Promise((r) => setTimeout(r, 5));
    fireAbort(roots[0]);
    gate();
    const a = (await inFlight).sessions.find((x) => x.sessionKey === 'A');
    expect(a).toMatchObject({ cpuCapPercent: 100, throttling: false });
    await runOne();
    await runOne();
    expect(signals.some(([pid, sig]) => pid === 300 && sig === 'SIGSTOP')).toBe(false);
    // Later samples of that turn's tree (its workers still cleaning up) are not metered either.
    gated = false;
    expect((await monitor.sample()).sessions.find((x) => x.sessionKey === 'A')?.throttling).toBe(false);
    // The session's next turn — a new Claude Code process with its own worker — is capped again.
    ps.procs.delete(300);
    ps.procs.delete(200);
    ps.set(210, { ppid: 100, args: '/usr/local/bin/claude' });
    ps.set(310, { ppid: 210, args: '/bin/bash -c make', psCpu: 400 });
    roots[0] = { pid: 210, sessionKey: 'A' };
    const next = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'A');
    expect(next).toMatchObject({ cpuCapPercent: 100, throttling: true });
    monitor.dispose();
  });

  it('a stop someone else makes after the cap’s hold ended reads stopped, not throttled', async () => {
    const { monitor, ps, runOne, tick } = setup();
    ps.set(300, { ppid: 200, args: '/bin/bash -c make', psCpu: 400 });
    let cap: number | null = 100;
    monitor.setCpuCaps(() => cap);
    await monitor.sample();
    await runOne();
    await runOne();
    expect(ps.procs.get(300)?.stat).toBe('T');
    // The cap goes away: its hold is continued and ends.
    cap = null;
    await monitor.sample();
    expect(ps.procs.get(300)?.stat).not.toBe('T');
    // Later, job control stops the same process: a sample after the hold's end reads a real stop.
    tick(10_000);
    const p = ps.procs.get(300);
    if (p) p.stat = 'T';
    const a = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'A');
    expect(a?.processes.find((x) => x.pid === 300)).toMatchObject({ state: 'stopped' });
    expect(a?.processes.find((x) => x.pid === 300)).not.toHaveProperty('throttled');
    expect(a?.stoppedCount).toBe(1);
  });

  it('the cap is enforced from the tree read even when the node-capacity read fails', async () => {
    const { monitor, ps, runOne, signals } = setup({
      readCapacity: () => Promise.reject(new Error('vm_stat failed')),
    });
    ps.set(300, { ppid: 200, args: '/bin/bash -c make', psCpu: 400 });
    monitor.setCpuCaps(() => 100);
    await expect(monitor.sample()).rejects.toThrow(/vm_stat/);
    await runOne();
    await runOne();
    expect(signals).toContainEqual([300, 'SIGSTOP']);
    monitor.dispose();
    expect(ps.procs.get(300)?.stat).not.toBe('T');
  });

  it('a person who pauses a process the cap holds owns it: the cap never continues it, nor reads it as throttled', async () => {
    const { monitor, ps, runOne, signals } = setup();
    ps.set(300, { ppid: 200, args: '/bin/bash -c make', psCpu: 400 });
    let cap: number | null = 100;
    monitor.setCpuCaps(() => cap);
    await monitor.sample();
    await runOne();
    await runOne();
    expect(signals).toContainEqual([300, 'SIGSTOP']);
    expect(ps.procs.get(300)?.stat).toBe('T');
    // The owner presses 일시중지 on it while the cap holds it.
    expect((await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).ok).toBe(true);
    const n = signals.length;
    // More periods, then the cap goes away: nothing continues the person's pause.
    for (let i = 0; i < 6; i++) await runOne();
    cap = null;
    const a = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'A');
    for (let i = 0; i < 4; i++) await runOne();
    expect(signals.slice(n).filter(([pid, sig]) => pid === 300 && sig === 'SIGCONT')).toEqual([]);
    expect(ps.procs.get(300)?.stat).toBe('T');
    expect(a?.processes.find((x) => x.pid === 300)).toMatchObject({ state: 'stopped' });
    expect(a?.processes.find((x) => x.pid === 300)).not.toHaveProperty('throttled');
  });

  it('a stop someone else made, read by the tree’s ps, stays a stop even if the cap holds it while capacity is read', async () => {
    let gate: () => void = () => {};
    let gated = false;
    const { monitor, ps, runOne, tick } = setup({
      readCapacity: () =>
        gated
          ? new Promise((r) => {
              gate = () => r(capacity);
            })
          : Promise.resolve(capacity),
    });
    ps.set(300, { ppid: 200, args: '/bin/bash -c make', psCpu: 400 });
    monitor.setCpuCaps(() => 100);
    await monitor.sample();
    // Job control stops 300; the tree's ps reads that T; the capacity read is slow.
    const p = ps.procs.get(300);
    if (p) p.stat = 'T';
    gated = true;
    const sampling = monitor.sample();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // After the tree read, job control continues it and the cap's period stops it — still before capacity answers.
    if (p) p.stat = 'S';
    tick(100);
    await runOne();
    await runOne();
    expect(ps.procs.get(300)?.stat).toBe('T');
    gate();
    const a = (await sampling).sessions.find((x) => x.sessionKey === 'A');
    // The T the ps read was someone else's: the cap's hold began after that read ended.
    expect(a?.processes.find((x) => x.pid === 300)).toMatchObject({ state: 'stopped' });
    expect(a?.processes.find((x) => x.pid === 300)).not.toHaveProperty('throttled');
    monitor.dispose();
  });

  it('a person’s pause in a metered task still reads stopped and counts as paused', async () => {
    const { monitor, ps } = setup();
    ps.set(300, { ppid: 200, args: '/bin/bash -c make', psCpu: 400 });
    monitor.setCpuCaps(() => 100);
    await monitor.sample();
    expect((await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).ok).toBe(true);
    const a = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'A');
    expect(a?.processes.find((p) => p.pid === 300)).toMatchObject({ state: 'stopped' });
    expect(a?.processes.find((p) => p.pid === 300)).not.toHaveProperty('throttled');
    expect(a?.stoppedCount).toBe(1);
  });

  it('caps unwired (setCpuCaps(null)) leave every task as sampled', async () => {
    const { monitor, ps } = setup();
    ps.set(300, { ppid: 200, args: '/bin/bash -c make', psCpu: 400, stat: 'T' });
    monitor.setCpuCaps(null);
    const a = (await monitor.sample()).sessions.find((x) => x.sessionKey === 'A');
    expect(a).not.toHaveProperty('cpuCapPercent');
    expect(a?.processes.find((p) => p.pid === 300)?.state).toBe('stopped');
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

  it('a process that exits between the identity check and the signal answers not-found (ESRCH), not denied', async () => {
    const gone = setup({
      kill: () => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      },
    });
    expect(await gone.monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await gone.monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'resume' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
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

describe('LocalProcessMonitor — hardening (#1407)', () => {
  it('dispose continues what the monitor paused before it detaches (nothing is left stopped with nobody to resume it)', async () => {
    const { monitor, signals, fireAbort } = setup();
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    monitor.dispose();
    expect(signals).toEqual([
      [300, 'SIGSTOP'],
      [300, 'SIGCONT'],
    ]);
    // Detached: a later abort reaches nothing.
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(signals).toHaveLength(2);
  });

  it('abort cleanup reads every paused identity in one batched read, and so does the retry on the next sample', async () => {
    let probing = false;
    let singles = 0;
    let batchFails = false;
    const batches: number[][] = [];
    const { monitor, ps, roots, signals, fireAbort, tick } = setup({
      live: (_pid, fallback) => (probing && batchFails ? undefined : fallback),
      onSingleRead: () => {
        if (probing) singles++;
      },
      onBatchRead: (pids) => {
        if (probing) batches.push([...pids].sort());
      },
    });
    ps.set(310, { ppid: 200, args: '/bin/sleep 1' }).set(320, { ppid: 200, args: '/bin/sleep 2' });
    roots.length = 1;
    for (const pid of [300, 310, 320]) {
      await monitor.control({ sessionKey: 'A', pid, startToken: start, action: 'pause' });
      tick(1);
    }
    signals.length = 0;
    probing = true;
    // The read fails at the abort: one batched try (each ps can take 2 s on a loaded host — never one per process).
    batchFails = true;
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(batches).toEqual([[300, 310, 320]]);
    expect(signals).toEqual([]);
    // The next sample retries them, again in one read.
    batchFails = false;
    tick(1);
    await monitor.sample();
    expect(batches).toEqual([
      [300, 310, 320],
      [300, 310, 320],
    ]);
    expect(signals.sort()).toEqual([
      [300, 'SIGCONT'],
      [310, 'SIGCONT'],
      [320, 'SIGCONT'],
    ]);
    expect(singles).toBe(0);
  });

  it('a turn is traced through a carried parent whose row a sample skipped: its aborted turn refuses the pause', async () => {
    let hidden = new Set<number>();
    const { monitor, ps, signals, fireAbort, tick } = setup({
      runPs: (fake) => async (a) => {
        const out = await fake.run(a);
        if (a[0] === '-A') return out;
        return out
          .split('\n')
          .filter((line) => !hidden.has(Number(line.trim().split(/\s+/)[0])))
          .join('\n');
      },
    });
    await monitor.sample(); // 300 is seen under turn 200
    fireAbort({ pid: 200, sessionKey: 'A' }); // turn 200 is stopping; its Claude Code has not exited yet
    // 300 starts 330; the next samples skip 300's row (the parent map still has it).
    ps.set(330, { ppid: 300, args: '/bin/sleep 9' });
    hidden = new Set([300]);
    tick(1);
    await monitor.sample();
    tick(1);
    expect(await monitor.control({ sessionKey: 'A', pid: 330, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(signals).toEqual([]);
  });

  it('a pause whose turn cannot be traced (a never-read parent row) is refused while the session has an aborted turn', async () => {
    const hidden = new Set<number>([340]);
    const { monitor, ps, signals, fireAbort, tick } = setup({
      runPs: (fake) => async (a) => {
        const out = await fake.run(a);
        if (a[0] === '-A') return out;
        return out
          .split('\n')
          .filter((line) => !hidden.has(Number(line.trim().split(/\s+/)[0])))
          .join('\n');
      },
    });
    // 340's row is never read, so nothing knows its turn; 350 under it cannot be traced.
    ps.set(340, { ppid: 200, args: '/bin/bash' }).set(350, { ppid: 340, args: '/bin/sleep 9' });
    await monitor.sample();
    // No aborted turn in session A: an untraced process may still be paused (any abort of A continues it).
    expect(await monitor.control({ sessionKey: 'A', pid: 350, startToken: start, action: 'pause' })).toMatchObject({
      ok: true,
    });
    await monitor.control({ sessionKey: 'A', pid: 350, startToken: start, action: 'resume' });
    signals.length = 0;
    fireAbort({ pid: 200, sessionKey: 'A' });
    tick(1);
    expect(await monitor.control({ sessionKey: 'A', pid: 350, startToken: start, action: 'pause' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(signals).toEqual([]);
  });

  /** A runPs that drops the detail rows of the pids in `hidden` (the parent map keeps them). */
  const skipping = (hidden: () => Set<number>) => (fake: FakePs) => async (a: readonly string[]) => {
    const out = await fake.run(a);
    if (a[0] === '-A') return out;
    return out
      .split('\n')
      .filter((line) => !hidden().has(Number(line.trim().split(/\s+/)[0])))
      .join('\n');
  };

  it('tracing a carried parent is what passes the pause: its live turn wins over another turn’s abort', async () => {
    let hidden = new Set<number>();
    const { monitor, ps, roots, signals, fireAbort, tick } = setup({ runPs: skipping(() => hidden) });
    // Session A has two live turns: 200 and 210. 315 runs under 210.
    ps.set(210, { ppid: 100, args: '/usr/local/bin/claude' }).set(315, { ppid: 210, args: '/bin/bash' });
    roots.push({ pid: 210, sessionKey: 'A' });
    await monitor.sample(); // 315 is seen under turn 210
    fireAbort({ pid: 200, sessionKey: 'A' }); // turn 200 is stopping; 210 is not
    ps.set(335, { ppid: 315, args: '/bin/sleep 9' });
    hidden = new Set([315]);
    tick(1);
    await monitor.sample();
    tick(1);
    // 335 traces to 210 through its carried parent: the pause is allowed despite the session's aborted turn 200.
    expect(await monitor.control({ sessionKey: 'A', pid: 335, startToken: start, action: 'pause' })).toMatchObject({
      ok: true,
    });
    expect(signals).toEqual([[335, 'SIGSTOP']]);
  });

  it('an untraced pause is refused for the session whose turn was aborted only, not another session', async () => {
    const hidden = new Set<number>([540]);
    const { monitor, ps, fireAbort, tick } = setup({ runPs: skipping(() => hidden) });
    // Session B: 550 under 540, whose row is never read.
    ps.set(540, { ppid: 500, args: '/bin/bash' }).set(550, { ppid: 540, args: '/bin/sleep 9' });
    await monitor.sample();
    fireAbort({ pid: 200, sessionKey: 'A' });
    tick(1);
    expect(await monitor.control({ sessionKey: 'B', pid: 550, startToken: start, action: 'pause' })).toMatchObject({
      ok: true,
    });
  });

  it('a carried parent whose pid now has another parent was reused: its old turn is not lent, and nothing sticks', async () => {
    let hidden = new Set<number>();
    const { monitor, ps, roots, fireAbort, tick } = setup({ runPs: skipping(() => hidden) });
    ps.set(210, { ppid: 100, args: '/usr/local/bin/claude' });
    roots.push({ pid: 210, sessionKey: 'A' });
    await monitor.sample(); // 300 is seen under turn 200
    fireAbort({ pid: 200, sessionKey: 'A' });
    // 300 exits; its pid goes to a shell under turn 210, whose first row is skipped; that shell starts 345.
    ps.set(300, { ppid: 210, args: '/bin/bash', start: 'Tue Nov 24 11:00:00 2026' });
    ps.set(345, { ppid: 300, args: '/bin/sleep 9' });
    hidden = new Set([300]);
    tick(1);
    await monitor.sample();
    // Once the shell's row is read, 345 traces to 210 — not to the aborted turn 200 a stale trace would have kept.
    hidden = new Set();
    tick(1);
    await monitor.sample();
    tick(1);
    expect(await monitor.control({ sessionKey: 'A', pid: 345, startToken: start, action: 'pause' })).toMatchObject({
      ok: true,
    });
  });

  it('the retry settles each paused identity, not each pid: a stale entry for a reused pid leaves the live one', async () => {
    let batchFails = false;
    // The next one-pid reads, in order: true fails it (the samples' check of a missing pause), false answers.
    let singlePlan: boolean[] = [];
    let refuseContinue = false;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const env = setup({
      batchFails: () => batchFails,
      singleFails: () => singlePlan.shift() ?? false,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        const p = env.ps.procs.get(pid);
        if (!p) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        if (signal === 'SIGCONT' && refuseContinue) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        p.stat = signal === 'SIGSTOP' ? 'T' : 'S';
      },
    });
    const { monitor, ps, fireAbort, tick } = env;
    // A pauses 300; its abort cannot read the identity, so the resume waits for a retry.
    await monitor.control({ sessionKey: 'A', pid: 300, startToken: start, action: 'pause' });
    batchFails = true;
    fireAbort({ pid: 200, sessionKey: 'A' });
    // 300 exits and its pid goes to a process in session B, which B pauses (the sample's check of A's missing entry
    // cannot read it, so A's stale entry stays); B's abort cannot read the identity either.
    const later = 'Tue Nov 24 11:00:00 2026';
    ps.set(300, { ppid: 500, args: '/bin/sleep 9', start: later });
    tick(1);
    // The check before the pause fails, the pause's own identity read answers, the check after it fails.
    singlePlan = [true, false, true];
    expect(await monitor.control({ sessionKey: 'B', pid: 300, startToken: later, action: 'pause' })).toMatchObject({
      ok: true,
    });
    fireAbort({ pid: 500, sessionKey: 'B' });
    // Both wait for a retry. The batched read answers: A's entry is another process now (settled); B's continue is
    // refused, so B's stays wanted.
    batchFails = false;
    singlePlan = [true];
    refuseContinue = true;
    tick(1);
    await monitor.sample();
    // The next retry continues B's.
    refuseContinue = false;
    signals.length = 0;
    tick(1);
    await monitor.sample();
    expect(signals).toContainEqual([300, 'SIGCONT']);
  });

  it('a host with only the one-pid read: a failing identity leaves the others continued', async () => {
    const { monitor, ps, roots, signals, fireAbort, tick } = setup({
      noBatch: true,
      live: (pid, fallback) => (pid === 310 && probing ? undefined : fallback),
    });
    var probing = false;
    ps.set(310, { ppid: 200, args: '/bin/sleep 1' }).set(320, { ppid: 200, args: '/bin/sleep 2' });
    roots.length = 1;
    for (const pid of [300, 310, 320]) {
      await monitor.control({ sessionKey: 'A', pid, startToken: start, action: 'pause' });
      tick(1);
    }
    signals.length = 0;
    probing = true;
    fireAbort({ pid: 200, sessionKey: 'A' });
    expect(signals.sort()).toEqual([
      [300, 'SIGCONT'],
      [320, 'SIGCONT'],
    ]);
  });

  it('a sample with a failed detail batch still succeeds, and says so once in the log', async () => {
    const warn = vi.fn();
    const { monitor, ps } = setup({
      logger: { info: () => {}, warn },
      runPs: (fake) => async (a) => {
        // Every detail batch fails but the one that holds the Claude Code process (200).
        if (
          a[0] !== '-A' &&
          !String(a[a.indexOf('-p') + 1] ?? '')
            .split(',')
            .includes('200')
        ) {
          throw Object.assign(new Error('ps: argument list too long'), { status: 1 });
        }
        return fake.run(a);
      },
    });
    // 300 starts enough workers that the detail read takes three batches (200 pids each); two of them fail.
    for (let pid = 9000; pid < 9450; pid++) ps.set(pid, { ppid: 300, args: '/bin/true' });
    const snap = await monitor.sample();
    expect(snap.sessions.find((s) => s.sessionKey === 'A')?.processes.length).toBeGreaterThan(0);
    const said = warn.mock.calls.filter(([msg]) => String(msg).includes('a detail batch failed'));
    expect(said).toHaveLength(1);
    expect(said[0][1]).toMatchObject({ error: expect.stringContaining('argument list too long') });
    expect((said[0][1] as { pids: number }).pids).toBeGreaterThanOrEqual(250);
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

describe('psLiveStartTokens — one batched identity read', () => {
  const row = (pid: number, start: string) => `${pid} ${start}`;
  it('a pid ps does not print is gone (null); a read that failed is unknown for all (undefined)', () => {
    const out = psLiveStartTokens([10, 11], () => `${row(10, 'Mon Nov 23 10:00:00 2026')}\n`);
    expect(out).toEqual(
      new Map<number, string | null>([
        [10, 'Mon Nov 23 10:00:00 2026'],
        [11, null],
      ]),
    );
    // ps exits 1, silently, when a pid is gone: the others it printed still count.
    const partial = psLiveStartTokens([10, 11], () => {
      throw Object.assign(new Error('exit 1'), {
        status: 1,
        stdout: `${row(11, 'Tue Nov 24 09:00:00 2026')}\n`,
        stderr: '',
      });
    });
    expect(partial?.get(10)).toBeNull();
    expect(partial?.get(11)).toBe('Tue Nov 24 09:00:00 2026');
    // Anything else — a message on stderr, a timeout, no ps — is unknown: nothing may be dropped or signalled.
    expect(
      psLiveStartTokens([10], () => {
        throw Object.assign(new Error('exit 1'), { status: 1, stdout: '', stderr: 'ps: illegal option' });
      }),
    ).toBeUndefined();
    expect(
      psLiveStartTokens([10], () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      }),
    ).toBeUndefined();
    expect(psLiveStartTokens([], () => '')).toEqual(new Map());
  });
});
