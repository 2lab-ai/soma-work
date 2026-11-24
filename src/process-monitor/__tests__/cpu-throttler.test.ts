import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CpuThrottler, parseThrottleRows, THROTTLE_PERIOD_MS } from '../cpu-throttler';
import type { ProcessSample, SessionProcessDetail } from '../types';

/**
 * A simulated machine: each process wants `demand` cores and accumulates CPU time only while it is not stopped. The
 * throttler's read and its signals act on it; the clock is vitest's fake one.
 */
class Machine {
  readonly procs = new Map<
    number,
    { demand: number; cpu: number; at: number; stopped: boolean; startToken: string; foreignStop?: boolean }
  >();
  readonly signals: Array<[number, NodeJS.Signals]> = [];

  add(pid: number, demand: number, startToken = 'Mon Nov 23 10:00:00 2026'): this {
    this.procs.set(pid, { demand, cpu: 0, at: Date.now(), stopped: false, startToken });
    return this;
  }

  private settle(pid: number): void {
    const p = this.procs.get(pid);
    if (!p) return;
    const now = Date.now();
    if (!p.stopped) p.cpu += ((now - p.at) / 1000) * p.demand;
    p.at = now;
  }

  readonly kill = (pid: number, signal: NodeJS.Signals): void => {
    this.signals.push([pid, signal]);
    const p = this.procs.get(pid);
    if (!p) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    this.settle(pid);
    if (signal === 'SIGSTOP') p.stopped = true;
    if (signal === 'SIGCONT') p.stopped = false;
  };

  readonly read = async (pids: readonly number[]) => {
    const out = new Map<number, { cpuSeconds: number; startToken: string; stat: string }>();
    for (const pid of pids) {
      const p = this.procs.get(pid);
      if (!p) continue;
      this.settle(pid);
      out.set(pid, { cpuSeconds: p.cpu, startToken: p.startToken, stat: p.stopped ? 'T' : 'R' });
    }
    return out;
  };

  cpuOf(pid: number): number {
    this.settle(pid);
    return this.procs.get(pid)?.cpu ?? 0;
  }
}

const START = 'Mon Nov 23 10:00:00 2026';
const proc = (pid: number, role: ProcessSample['role'], extra: Partial<ProcessSample> = {}): ProcessSample => ({
  pid,
  ppid: 1,
  startToken: START,
  depth: role === 'root' ? 0 : 1,
  role,
  state: 'running',
  cpuPercent: 0,
  rssBytes: 1,
  name: 'p',
  command: '',
  cwd: '',
  ...extra,
});
const session = (cpuPercent: number, processes: ProcessSample[], key = 'A'): SessionProcessDetail => ({
  sessionKey: key,
  nodeId: 'n1',
  rootAlive: true,
  processCount: processes.length,
  stoppedCount: 0,
  cpuPercent,
  rssBytes: 1,
  sampledAt: Date.now(),
  processes,
});

function setup(opts: { paused?: (pid: number) => boolean } = {}) {
  const m = new Machine();
  const t = new CpuThrottler({
    kill: m.kill,
    read: m.read,
    now: () => Date.now(),
    userPaused: (_k, pid) => opts.paused?.(pid) ?? false,
  });
  return { m, t };
}

describe('CpuThrottler — a task tree held to its cap by a duty cycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves a tree under its cap alone — no signal at all', async () => {
    const { m, t } = setup();
    m.add(10, 0.1).add(11, 0.4);
    t.update([session(50, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.signals).toEqual([]);
    expect(t.meteredCap('A')).toBeNull();
  });

  it('holds a 400% tree to about 100%: children are stopped part of every period, the Claude Code process never', async () => {
    const { m, t } = setup();
    m.add(10, 0.05).add(11, 2).add(12, 2);
    t.update([session(405, [proc(10, 'root'), proc(11, 'child'), proc(12, 'child')])], () => 100);
    expect(t.meteredCap('A')).toBe(100);
    // Let the share settle, then measure 4 s.
    await vi.advanceTimersByTimeAsync(2_000);
    const before = [10, 11, 12].reduce((n, p) => n + m.cpuOf(p), 0);
    await vi.advanceTimersByTimeAsync(4_000);
    const rate = (([10, 11, 12].reduce((n, p) => n + m.cpuOf(p), 0) - before) / 4) * 100;
    expect(rate).toBeGreaterThan(75);
    expect(rate).toBeLessThan(130);
    expect(m.signals.some(([pid]) => pid === 10)).toBe(false);
    expect(m.signals.filter(([pid, s]) => pid === 11 && s === 'SIGSTOP').length).toBeGreaterThan(10);
  });

  it('never stops or continues a process a person paused', async () => {
    const { m, t } = setup({ paused: (pid) => pid === 12 });
    m.add(10, 0).add(11, 3).add(12, 3);
    t.update([session(600, [proc(10, 'root'), proc(11, 'child'), proc(12, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.signals.some(([pid]) => pid === 12)).toBe(false);
    expect(m.signals.some(([pid]) => pid === 11)).toBe(true);
  });

  it('a process a person pauses while it is held becomes theirs: never continued (forget)', async () => {
    let paused = false;
    const { m, t } = setup({ paused: (pid) => paused && pid === 11 });
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    // Run until 11 is held.
    for (let i = 0; i < 40 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(10);
    expect(t.holds('A', 11, START)).toBe(true);
    paused = true;
    t.forget('A', 11);
    const n = m.signals.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.signals.slice(n).some(([pid]) => pid === 11)).toBe(false);
    expect(m.procs.get(11)?.stopped).toBe(true);
  });

  it('release (an abort) and releaseAll (shutdown) continue everything held; nothing is signalled after shutdown', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4).add(20, 0).add(21, 4);
    t.update(
      [
        session(400, [proc(10, 'root'), proc(11, 'child')], 'A'),
        session(400, [proc(20, 'root'), proc(21, 'child')], 'B'),
      ],
      () => 100,
    );
    for (let i = 0; i < 40 && !(t.holds('A', 11, START) && t.holds('B', 21, START)); i++) {
      await vi.advanceTimersByTimeAsync(10);
    }
    t.release('A');
    expect(m.procs.get(11)?.stopped).toBe(false);
    expect(t.meteredCap('A')).toBeNull();
    for (let i = 0; i < 40 && !t.holds('B', 21, START); i++) await vi.advanceTimersByTimeAsync(10);
    t.releaseAll();
    expect(m.procs.get(21)?.stopped).toBe(false);
    const n = m.signals.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.signals.length).toBe(n);
  });

  it('a cap that goes away (admin, unlimited) or a session that leaves the sample continues what it held', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    const tree = [session(400, [proc(10, 'root'), proc(11, 'child')])];
    t.update(tree, () => 100);
    for (let i = 0; i < 40 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(10);
    t.update(tree, () => null);
    expect(m.procs.get(11)?.stopped).toBe(false);
    expect(t.meteredCap('A')).toBeNull();
    t.update(tree, () => 100);
    for (let i = 0; i < 40 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(10);
    t.update([], () => 100);
    expect(m.procs.get(11)?.stopped).toBe(false);
  });

  it('a tree that calms down runs free and is let go after a few free periods', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(1_000);
    (m.procs.get(11) as { demand: number }).demand = 0.2;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.meteredCap('A')).toBeNull();
    expect(m.procs.get(11)?.stopped).toBe(false);
    const n = m.signals.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.signals.length).toBe(n);
  });

  it('never signals a reused pid (start time differs) or a process someone else stopped', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4, 'Tue Nov 24 09:00:00 2026').add(12, 4);
    (m.procs.get(12) as { stopped: boolean }).stopped = true; // stopped by someone else (job control)
    t.update([session(800, [proc(10, 'root'), proc(11, 'child'), proc(12, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.signals.some(([pid]) => pid === 11 || pid === 12)).toBe(false);
    expect(m.procs.get(12)?.stopped).toBe(true);
  });

  it('a read that fails holds nothing that period', async () => {
    const m = new Machine().add(10, 0).add(11, 4);
    let fail = false;
    const t = new CpuThrottler({
      kill: m.kill,
      read: async (pids) => {
        if (fail) throw new Error('ps timed out');
        return m.read(pids);
      },
      now: () => Date.now(),
      userPaused: () => false,
    });
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 40 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(10);
    fail = true;
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS * 2);
    expect(m.procs.get(11)?.stopped).toBe(false);
    t.releaseAll();
  });
});

describe('parseThrottleRows', () => {
  it('reads pid, stat, the 5-token start time and the CPU time; skips what it cannot read', () => {
    const rows = parseThrottleRows(
      '  4242 R+   Tue Nov 24 15:50:48 2026     1:02.50\n 17 T Mon Nov  3 09:05:01 2026 0:00.01\nbad line\n',
    );
    expect(rows.get(4242)).toEqual({ stat: 'R+', startToken: 'Tue Nov 24 15:50:48 2026', cpuSeconds: 62.5 });
    expect(rows.get(17)).toEqual({ stat: 'T', startToken: 'Mon Nov 3 09:05:01 2026', cpuSeconds: 0.01 });
    expect(rows.size).toBe(2);
  });
});
