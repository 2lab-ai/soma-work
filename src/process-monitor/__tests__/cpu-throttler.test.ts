import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CpuThrottler, createThrottleReader, parseThrottleRows, THROTTLE_PERIOD_MS } from '../cpu-throttler';
import { runReadOnly } from '../index';
import type { ProcessSample, SessionProcessDetail } from '../types';

/**
 * A simulated machine: each process wants `demand` cores and accumulates CPU time only while it is not stopped. The
 * throttler's read and its signals act on it; the clock is vitest's fake one.
 */
class Machine {
  readonly procs = new Map<
    number,
    { demand: number; cpu: number; at: number; stopped: boolean; startToken: string; ppid: number }
  >();
  readonly signals: Array<[number, NodeJS.Signals]> = [];
  /** A continue the OS refuses (EPERM) for these pids. */
  readonly refuse = new Set<number>();
  /** The next continues the OS refuses, whatever the pid, then it accepts them again. */
  refuseContinues = 0;

  add(pid: number, demand: number, startToken = 'Mon Nov 23 10:00:00 2026', ppid = 1): this {
    this.procs.set(pid, { demand, cpu: 0, at: Date.now(), stopped: false, startToken, ppid });
    return this;
  }

  /** The pid exits and the OS hands it to a new process (a new start time), optionally stopped by someone else. */
  reuse(pid: number, stopped = false): void {
    this.procs.set(pid, {
      demand: 0,
      cpu: 0,
      at: Date.now(),
      stopped,
      startToken: 'Wed Nov 25 08:00:00 2026',
      ppid: 1,
    });
  }

  /** One "ps" for several pids; `unknown` makes the whole read fail (as a ps that timed out). */
  unknown = false;
  /** The next live probes that fail (a ps that timed out), then they answer again. */
  unknownProbes = 0;
  readonly liveStartTokens = (pids: readonly number[]): Map<number, string | null> | undefined => {
    if (this.unknownProbes > 0) {
      this.unknownProbes--;
      return undefined;
    }
    return this.unknown ? undefined : new Map(pids.map((pid) => [pid, this.procs.get(pid)?.startToken ?? null]));
  };

  /** Runs right after the parent map is read (a pid can change hands between that map and the next read). */
  afterParents: (() => void) | null = null;
  /** How long the whole-host parent scan takes (a crowded host); `parentsFail` makes it fail. */
  parentsDelayMs = 0;
  parentsFail = false;
  readonly readParents = async () => {
    if (this.parentsDelayMs > 0) await new Promise((r) => setTimeout(r, this.parentsDelayMs));
    if (this.parentsFail) throw new Error('ps -A timed out');
    const map = new Map([...this.procs].map(([pid, p]) => [pid, p.ppid]));
    this.afterParents?.();
    return map;
  };
  /** Runs at the start of every read, with the pids it asks for. */
  onRead: ((pids: readonly number[]) => void) | null = null;
  /** Awaited at the start of every read: a test orders reads against each other with it. */
  readHook: ((pids: readonly number[]) => Promise<void>) | null = null;

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
    if (signal === 'SIGCONT' && (this.refuse.has(pid) || this.refuseContinues > 0)) {
      if (this.refuseContinues > 0) this.refuseContinues--;
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    }
    this.settle(pid);
    if (signal === 'SIGSTOP') p.stopped = true;
    if (signal === 'SIGCONT') p.stopped = false;
  };

  /** How long each read takes (a slow ps on a busy host); it reads the processes when it ends. */
  readDelayMs = 0;
  /** The next read waits for this before it reads (a ps the test holds up). */
  gate: Promise<void> | null = null;
  /** A CPU counter that moves in whole ticks (Linux /proc: 10 ms), as an accounting phase that rounds down. */
  tickSeconds = 0;

  readonly read = async (pids: readonly number[]) => {
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    if (this.readHook) await this.readHook(pids);
    this.onRead?.(pids);
    if (this.readDelayMs > 0) await new Promise((r) => setTimeout(r, this.readDelayMs));
    const out = new Map<number, { cpuSeconds: number; startToken: string; stat: string; ppid: number }>();
    for (const pid of pids) {
      const p = this.procs.get(pid);
      if (!p) continue;
      this.settle(pid);
      const cpu = this.tickSeconds > 0 ? Math.floor(p.cpu / this.tickSeconds) * this.tickSeconds : p.cpu;
      out.set(pid, { cpuSeconds: cpu, startToken: p.startToken, stat: p.stopped ? 'T' : 'R', ppid: p.ppid });
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
  const warnings: string[] = [];
  const t = new CpuThrottler({
    kill: m.kill,
    read: m.read,
    readParents: m.readParents,
    liveStartTokens: m.liveStartTokens,
    now: () => Date.now(),
    userPaused: (_k, pid) => opts.paused?.(pid) ?? false,
    logger: { warn: (msg: string) => warnings.push(msg) },
  });
  return { m, t, warnings };
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

  it('holds a tree to its cap when ps is slow: the period grows so the read before each stop is a small part of it', async () => {
    const { m, t } = setup();
    // 150 ms per read: in a 250 ms period the tree would run through every read before its stop — 60% at least.
    m.readDelayMs = 150;
    m.add(10, 0).add(11, 2).add(12, 2);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child'), proc(12, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.periodMs()).toBeGreaterThan(THROTTLE_PERIOD_MS);
    expect(t.periodMs()).toBeLessThanOrEqual(1_000);
    const before = [11, 12].reduce((n, p) => n + m.cpuOf(p), 0);
    await vi.advanceTimersByTimeAsync(8_000);
    const rate = (([11, 12].reduce((n, p) => n + m.cpuOf(p), 0) - before) / 8) * 100;
    expect(rate).toBeGreaterThan(70);
    expect(rate).toBeLessThan(130);
  });

  it('a stop whose read comes back after the next period continued is not sent (it would hold the tree a period)', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    // The first period read the tree and planned its stop; hold up the read that stop makes first.
    await vi.advanceTimersByTimeAsync(0);
    let open = (): void => {};
    m.gate = new Promise<void>((r) => {
      open = r;
    });
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS - 1);
    expect(m.signals.filter(([, s]) => s === 'SIGSTOP')).toEqual([]);
    // The next period starts, reads and continues (nothing held yet); then the held-up read returns.
    await vi.advanceTimersByTimeAsync(2);
    const n = m.signals.length;
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.signals.slice(n)).toEqual([]);
    expect(m.procs.get(11)?.stopped).toBe(false);
  });

  it('a wide tree under a slow ps is held to its cap: the period grows until the read before a stop fits its share', async () => {
    const { m, t } = setup();
    // 16 workers at a core each (1600%) under 100%: a 6% share. A 150 ms read in a 900 ms period would let it run 17%.
    m.readDelayMs = 150;
    m.add(10, 0);
    const kids = Array.from({ length: 16 }, (_, i) => 20 + i);
    for (const pid of kids) m.add(pid, 1);
    t.update([session(1600, [proc(10, 'root'), ...kids.map((pid) => proc(pid, 'child'))])], () => 100);
    await vi.advanceTimersByTimeAsync(20_000);
    const before = kids.reduce((n, p) => n + m.cpuOf(p), 0);
    await vi.advanceTimersByTimeAsync(20_000);
    const rate = ((kids.reduce((n, p) => n + m.cpuOf(p), 0) - before) / 20) * 100;
    expect(rate).toBeGreaterThan(60);
    expect(rate).toBeLessThan(140);
    expect(t.periodMs()).toBeLessThanOrEqual(4_000);
  });

  it('a tree 64 times its cap is held to it: the share goes down to 1% of a period', async () => {
    const { m, t } = setup();
    m.add(10, 0);
    const kids = Array.from({ length: 32 }, (_, i) => 20 + i);
    for (const pid of kids) m.add(pid, 1);
    t.update([session(3200, [proc(10, 'root'), ...kids.map((pid) => proc(pid, 'child'))])], () => 50);
    await vi.advanceTimersByTimeAsync(10_000);
    const before = kids.reduce((n, p) => n + m.cpuOf(p), 0);
    await vi.advanceTimersByTimeAsync(10_000);
    const rate = ((kids.reduce((n, p) => n + m.cpuOf(p), 0) - before) / 10) * 100;
    expect(rate).toBeGreaterThan(25);
    expect(rate).toBeLessThan(90);
  });

  it('a pid found in the parent map is adopted only if the read of its identity names a parent in the tree', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4).add(20, 1, START, 11);
    // Between the parent map and the read, 20 exits and its pid goes to a process outside the task.
    let once = false;
    m.afterParents = () => {
      if (once) return;
      once = true;
      m.reuse(20);
      const p = m.procs.get(20);
      if (p) p.demand = 1;
    };
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.signals.some(([pid]) => pid === 20)).toBe(false);
    expect(m.signals.some(([pid]) => pid === 11)).toBe(true);
  });

  it('a held pid reused while the period reads new workers is not continued (its identity is read again)', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 100 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(5);
    expect(t.holds('A', 11, START)).toBe(true);
    // A new worker appears; while the period reads it, 11 exits and its pid goes to a process someone else stopped.
    m.add(21, 0, START, 11);
    let reused = false;
    m.onRead = (pids) => {
      if (reused || !pids.includes(21)) return;
      reused = true;
      m.reuse(11, true);
    };
    const n = m.signals.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reused).toBe(true);
    expect(m.signals.slice(n).filter(([pid]) => pid === 11)).toEqual([]);
    expect(m.procs.get(11)?.stopped).toBe(true);
  });

  it('a held process that is gone closes its hold: a later stop of that pid is not read as the cap’s', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 100 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(5);
    m.procs.delete(11);
    await vi.advanceTimersByTimeAsync(1_000);
    const later = Date.now() + 1_000;
    expect(t.holds('A', 11, START, { from: later, to: later + 500 })).toBe(false);
  });

  it('a continue the OS refuses is said once (a held process it cannot release is not silent)', async () => {
    const { m, t, warnings } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 100 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(5);
    m.refuse.add(11);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(warnings.filter((w) => /refused to continue/.test(w))).toHaveLength(1);
    expect(t.holds('A', 11, START)).toBe(true);
  });

  it('a 32-core tree under 50% with slow reads is held to its cap: the period is as long as its 1.6% share needs', async () => {
    const { m, t, warnings } = setup();
    m.readDelayMs = 150;
    m.add(10, 0);
    const kids = Array.from({ length: 32 }, (_, i) => 20 + i);
    for (const pid of kids) m.add(pid, 1);
    t.update([session(3200, [proc(10, 'root'), ...kids.map((pid) => proc(pid, 'child'))])], () => 50);
    await vi.advanceTimersByTimeAsync(120_000);
    const before = kids.reduce((n, p) => n + m.cpuOf(p), 0);
    await vi.advanceTimersByTimeAsync(120_000);
    const rate = ((kids.reduce((n, p) => n + m.cpuOf(p), 0) - before) / 120) * 100;
    expect(rate).toBeGreaterThan(20);
    expect(rate).toBeLessThan(90);
    expect(warnings.filter((w) => /cannot hold/.test(w))).toEqual([]);
  });

  it('a cap the reads are too slow for is said once (a 1 s identity read cannot hold a 1% share in 30 s)', async () => {
    const { m, t, warnings } = setup();
    m.readDelayMs = 1_000;
    m.add(10, 0);
    const kids = Array.from({ length: 64 }, (_, i) => 20 + i);
    for (const pid of kids) m.add(pid, 1);
    t.update([session(6400, [proc(10, 'root'), ...kids.map((pid) => proc(pid, 'child'))])], () => 25);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(warnings.filter((w) => /cannot hold/.test(w))).toHaveLength(1);
    expect(t.periodMs()).toBe(30_000);
  });

  it('a slow whole-host parent scan is part of the period: a 400% tree still runs at about its cap', async () => {
    const { m, t } = setup();
    m.parentsDelayMs = 1_200;
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(30_000);
    const before = m.cpuOf(11);
    await vi.advanceTimersByTimeAsync(60_000);
    const rate = ((m.cpuOf(11) - before) / 60) * 100;
    expect(rate).toBeGreaterThan(70);
    expect(rate).toBeLessThan(135);
  });

  it('a parent scan that fails is said (new workers go unseen until it reads again)', async () => {
    const { m, t, warnings } = setup();
    m.parentsFail = true;
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(warnings.filter((w) => /parent map/.test(w))).toHaveLength(1);
    // It still holds what it knows.
    expect(m.signals.some(([pid, sig]) => pid === 11 && sig === 'SIGSTOP')).toBe(true);
  });

  it('shutdown retries within itself: an unknown identity, then a refused continue, then the process runs', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 100 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(5);
    expect(m.procs.get(11)?.stopped).toBe(true);
    // The first identity probe fails; the next continue is refused; the third pass goes through.
    m.unknownProbes = 1;
    m.refuseContinues = 1;
    t.releaseAll();
    expect(m.procs.get(11)?.stopped).toBe(false);
    const n = m.signals.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.signals.slice(n)).toEqual([]);
  });

  it('a CPU counter in 10 ms ticks: a period that reads no increase keeps the share — a wide tree stays at its cap', async () => {
    const { m, t } = setup();
    m.tickSeconds = 0.01;
    m.readDelayMs = 2;
    m.add(10, 0);
    const kids = Array.from({ length: 32 }, (_, i) => 20 + i);
    for (const pid of kids) m.add(pid, 1);
    t.update([session(3200, [proc(10, 'root'), ...kids.map((pid) => proc(pid, 'child'))])], () => 50);
    await vi.advanceTimersByTimeAsync(60_000);
    const before = kids.reduce((n, p) => n + m.cpuOf(p), 0);
    await vi.advanceTimersByTimeAsync(120_000);
    const rate = ((kids.reduce((n, p) => n + m.cpuOf(p), 0) - before) / 120) * 100;
    expect(rate).toBeGreaterThan(20);
    expect(rate).toBeLessThan(80);
  });

  it('a hold that lands while the period reads new workers is read again too before its continue', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    // Period 1 reads and plans its stop of 11; that stop's read is held up.
    let releaseStopRead: () => void = () => {};
    const stopRead = new Promise<void>((r) => {
      releaseStopRead = r;
    });
    let n = 0;
    m.readHook = async (pids) => {
      n++;
      // The 2nd read is period 1's stop read: it waits until period 2 is reading its new worker.
      if (n === 2) await stopRead;
      // Period 2's discovery read (its new worker 21): the held-up stop lands now, then 11 exits and its pid goes to a
      // process someone else stopped — all while this read is out.
      if (pids.includes(21) && !pids.includes(10)) {
        releaseStopRead();
        for (let i = 0; i < 50 && !t.holds('A', 11, START); i++) await Promise.resolve();
        if (t.holds('A', 11, START)) m.reuse(11, true);
      }
    };
    await vi.advanceTimersByTimeAsync(0);
    // A new worker appears before period 2.
    m.add(21, 0, START, 11);
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS + 50);
    expect(m.procs.get(11)?.startToken).not.toBe(START);
    // The replacement is never continued.
    expect(m.signals.filter(([pid, sig]) => pid === 11 && sig === 'SIGCONT')).toEqual([]);
    expect(m.procs.get(11)?.stopped).toBe(true);
  });

  it('an abort or shutdown while a stop’s identity read is out: nothing is stopped when it returns', async () => {
    for (const how of ['release', 'releaseAll'] as const) {
      const { m, t } = setup();
      m.add(10, 0).add(11, 4);
      t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
      // The first period reads and plans its stop; hold up the stop's read.
      await vi.advanceTimersByTimeAsync(0);
      let open = (): void => {};
      m.gate = new Promise<void>((r) => {
        open = r;
      });
      await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS - 1);
      if (how === 'release') t.release('A');
      else t.releaseAll();
      const n = m.signals.length;
      open();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(m.signals.slice(n).filter(([, sig]) => sig === 'SIGSTOP')).toEqual([]);
      expect(m.procs.get(11)?.stopped).toBe(false);
      expect(t.holds('A', 11, START)).toBe(false);
    }
  });

  it('a cap that changes replans at once: holds are continued and the next period runs on the new cap', async () => {
    const { m, t } = setup();
    m.readDelayMs = 150;
    m.add(10, 0);
    const kids = Array.from({ length: 16 }, (_, i) => 20 + i);
    for (const pid of kids) m.add(pid, 1);
    const tree = session(1600, [proc(10, 'root'), ...kids.map((pid) => proc(pid, 'child'))]);
    t.update([tree], () => 100);
    await vi.advanceTimersByTimeAsync(20_000);
    // A long period is under way; the admin raises the cap over what the tree uses.
    for (let i = 0; i < 400 && !kids.some((pid) => m.procs.get(pid)?.stopped); i++)
      await vi.advanceTimersByTimeAsync(5);
    expect(kids.some((pid) => m.procs.get(pid)?.stopped)).toBe(true);
    t.update([tree], () => 3200);
    expect(kids.some((pid) => m.procs.get(pid)?.stopped)).toBe(false);
    expect(t.meteredCap('A')).toBeNull();
  });

  it('a cap that changes but stays under the tree keeps it metered, on the new cap', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    const tree = session(400, [proc(10, 'root'), proc(11, 'child')]);
    t.update([tree], () => 100);
    await vi.advanceTimersByTimeAsync(10_000);
    t.update([tree], () => 50);
    expect(t.meteredCap('A')).toBe(50);
    await vi.advanceTimersByTimeAsync(10_000);
    const before = m.cpuOf(11);
    await vi.advanceTimersByTimeAsync(10_000);
    const rate = ((m.cpuOf(11) - before) / 10) * 100;
    expect(rate).toBeGreaterThan(30);
    expect(rate).toBeLessThan(70);
  });

  it('periods whose counter has not moved leave the calm streak as it is: a quiet tree is let go', async () => {
    const { m, t } = setup();
    // 2% of a core, read in 10 ms ticks: every other period reads no increase.
    m.tickSeconds = 0.01;
    m.add(10, 0).add(11, 0.02);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    expect(t.meteredCap('A')).toBe(100);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.meteredCap('A')).toBeNull();
  });

  it('a sample still in flight reads an earlier hold of the same process as the cap’s', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 100 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(5);
    const firstHold = Date.now();
    // That hold ends, and a later period holds it again.
    for (let i = 0; i < 100 && t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(5);
    for (let i = 0; i < 100 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(5);
    expect(Date.now()).toBeGreaterThan(firstHold);
    expect(t.holds('A', 11, START, { from: firstHold, to: firstHold + 1 })).toBe(true);
  });

  it('a discovered worker whose parent pid changed hands while the period read is not adopted', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4).add(30, 1, START, 11);
    let done = false;
    m.readHook = async (pids) => {
      // The discovery read (30 and its parent): 11 exits just before it and its pid goes to another program.
      if (done || !pids.includes(30)) return;
      done = true;
      m.reuse(11);
    };
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(true);
    expect(m.signals.some(([pid]) => pid === 30)).toBe(false);
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
      liveStartTokens: m.liveStartTokens,
      now: () => Date.now(),
      userPaused: () => false,
    });
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 40 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(10);
    fail = true;
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS * 2);
    expect(m.procs.get(11)?.stopped).toBe(false);
    // The read recovers: the loop kept running, metering resumes with no new sample.
    fail = false;
    await vi.advanceTimersByTimeAsync(1_500);
    const before = m.cpuOf(11) + m.cpuOf(10);
    await vi.advanceTimersByTimeAsync(4_000);
    const rate = ((m.cpuOf(11) + m.cpuOf(10) - before) / 4) * 100;
    expect(rate).toBeLessThan(140);
    expect(t.meteredCap('A')).toBe(100);
    t.releaseAll();
  });

  it('a held pid reused by another process is never continued — on release, on shutdown, or in a period', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 40 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(10);
    // 11 is killed while held and its pid goes to another program, which someone else stopped.
    m.reuse(11, true);
    const n = m.signals.length;
    t.releaseAll();
    expect(m.signals.slice(n).some(([pid]) => pid === 11)).toBe(false);
    expect(m.procs.get(11)?.stopped).toBe(true);
  });

  it('a continue the OS refuses keeps the hold and is tried again; an unreadable identity on release is retried', async () => {
    const m = new Machine().add(10, 0).add(11, 4);
    const t = new CpuThrottler({
      kill: m.kill,
      read: m.read,
      liveStartTokens: m.liveStartTokens,
      now: () => Date.now(),
      userPaused: () => false,
    });
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 40 && !t.holds('A', 11, START); i++) await vi.advanceTimersByTimeAsync(10);
    m.refuse.add(11);
    t.release('A');
    expect(m.procs.get(11)?.stopped).toBe(true);
    expect(t.holds('A', 11, START)).toBe(true);
    m.refuse.delete(11);
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS * 2);
    expect(m.procs.get(11)?.stopped).toBe(false);
    // Unknown identity at release: kept, continued by the next period's read.
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 80 && !m.procs.get(11)?.stopped; i++) await vi.advanceTimersByTimeAsync(10);
    m.unknown = true;
    t.release('A');
    expect(m.procs.get(11)?.stopped).toBe(true);
    m.unknown = false;
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS * 2);
    expect(m.procs.get(11)?.stopped).toBe(false);
    t.releaseAll();
  });

  it('a pid reused between the hold and the next period is not continued; one reused before its stop is not stopped', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4).add(12, 4);
    t.update([session(800, [proc(10, 'root'), proc(11, 'child'), proc(12, 'child')])], () => 100);
    for (let i = 0; i < 80 && !m.procs.get(11)?.stopped; i++) await vi.advanceTimersByTimeAsync(5);
    // 11 is held; it dies and its pid goes to another program, stopped by someone else, before the next period.
    m.reuse(11, true);
    const n = m.signals.length;
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS);
    expect(m.signals.slice(n).some(([pid, sig]) => pid === 11 && sig === 'SIGCONT')).toBe(false);
    expect(m.procs.get(11)?.stopped).toBe(true);
    // 12: reused after a period planned its stop, before the stop lands — the hold's own read refuses it.
    for (let i = 0; i < 80 && m.procs.get(12)?.stopped; i++) await vi.advanceTimersByTimeAsync(5);
    m.reuse(12);
    (m.procs.get(12) as { demand: number }).demand = 4;
    const k = m.signals.length;
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS * 2);
    expect(m.signals.slice(k).some(([pid, sig]) => pid === 12 && sig === 'SIGSTOP')).toBe(false);
    t.releaseAll();
  });

  it('never adopts the children of a member whose pid now names another program', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4, START, 10);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    await vi.advanceTimersByTimeAsync(500);
    // 11 exits; its pid goes to an unrelated program, which starts a busy child of its own.
    m.reuse(11);
    m.add(99, 4, START, 11);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(m.signals.some(([pid]) => pid === 99)).toBe(false);
    t.releaseAll();
  });

  it('a held pid missing from a period read is checked live, and kept while unknown — never dropped while stopped', async () => {
    const m = new Machine().add(10, 0).add(11, 4);
    let skip = false;
    const t = new CpuThrottler({
      kill: m.kill,
      read: async (pids) => {
        const r = await m.read(pids);
        if (skip) r.delete(11);
        return r;
      },
      liveStartTokens: m.liveStartTokens,
      now: () => Date.now(),
      userPaused: () => false,
    });
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    for (let i = 0; i < 80 && !m.procs.get(11)?.stopped; i++) await vi.advanceTimersByTimeAsync(5);
    skip = true;
    m.unknown = true;
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS * 2);
    expect(m.procs.get(11)?.stopped).toBe(true);
    expect(t.holds('A', 11, START)).toBe(true);
    m.unknown = false;
    await vi.advanceTimersByTimeAsync(THROTTLE_PERIOD_MS * 2);
    expect(m.procs.get(11)?.stopped).toBe(false);
    t.releaseAll();
  });

  it('a stop the OS refuses is said once', async () => {
    const m = new Machine().add(10, 0).add(11, 4);
    const warn = vi.fn();
    const t = new CpuThrottler({
      kill: (pid, sig) => {
        if (sig === 'SIGSTOP') throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        m.kill(pid, sig);
      },
      read: m.read,
      liveStartTokens: m.liveStartTokens,
      now: () => Date.now(),
      userPaused: () => false,
      logger: { warn },
    });
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(warn.mock.calls.filter(([msg]) => /refused to stop/.test(msg))).toHaveLength(1);
    t.releaseAll();
  });

  it('holds what the tree started since the sample: a new worker under a capped tree is metered too', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 0.01, START, 10);
    t.update([session(150, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    // A new worker appears under 11 after the sample: two cores.
    m.add(12, 2, START, 11);
    await vi.advanceTimersByTimeAsync(2_000);
    const before = m.cpuOf(12);
    await vi.advanceTimersByTimeAsync(4_000);
    const rate = ((m.cpuOf(12) - before) / 4) * 100;
    expect(rate).toBeLessThan(130);
    expect(m.signals.some(([pid, sig]) => pid === 12 && sig === 'SIGSTOP')).toBe(true);
    t.releaseAll();
    expect(m.procs.get(12)?.stopped).toBe(false);
  });
});

describe('parseThrottleRows', () => {
  it('reads pid, stat, the 5-token start time and the CPU time; skips what it cannot read', () => {
    const rows = parseThrottleRows(
      '  4242   200 R+   Tue Nov 24 15:50:48 2026     1:02.50\n 17 1 T Mon Nov  3 09:05:01 2026 0:00.01\nbad line\n',
    );
    expect(rows.get(4242)).toEqual({ ppid: 200, stat: 'R+', startToken: 'Tue Nov 24 15:50:48 2026', cpuSeconds: 62.5 });
    expect(rows.get(17)).toEqual({ ppid: 1, stat: 'T', startToken: 'Mon Nov 3 09:05:01 2026', cpuSeconds: 0.01 });
    expect(rows.size).toBe(2);
  });
});

describe('CpuThrottler probe — every tree width, cap and read latency is held near its cap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1–64 one-core workers × caps 25–400% × identity reads 0 or 150 ms × parent scans 0 or 800 ms: within 0.5–1.35× the cap', async () => {
    const off: string[] = [];
    let cases = 0;
    for (const width of [1, 2, 8, 32, 64]) {
      for (const cap of [25, 50, 100, 400]) {
        for (const readDelay of [0, 150]) {
          for (const parentsDelay of [0, 800]) {
            if (cap >= width * 100) continue;
            cases++;
            const { m, t } = setup();
            m.readDelayMs = readDelay;
            m.parentsDelayMs = parentsDelay;
            m.add(10, 0);
            const kids = Array.from({ length: width }, (_, i) => 20 + i);
            for (const pid of kids) m.add(pid, 1);
            t.update([session(width * 100, [proc(10, 'root'), ...kids.map((pid) => proc(pid, 'child'))])], () => cap);
            await vi.advanceTimersByTimeAsync(60_000);
            const before = kids.reduce((n, p) => n + m.cpuOf(p), 0);
            await vi.advanceTimersByTimeAsync(90_000);
            const rate = ((kids.reduce((n, p) => n + m.cpuOf(p), 0) - before) / 90) * 100;
            if (rate > cap * 1.35 || rate < cap * 0.5) {
              off.push(
                `${width} workers, cap ${cap}%, read ${readDelay} ms, scan ${parentsDelay} ms: ${rate.toFixed(0)}%`,
              );
            }
            t.releaseAll();
          }
        }
      }
    }
    expect(off).toEqual([]);
    expect(cases).toBeGreaterThan(60);
    // A few seconds on an idle machine; room for a loaded runner.
  }, 300_000);
});

describe.skipIf(process.platform === 'win32')('createThrottleReader on the real OS', () => {
  it('a pid in the list that is gone does not lose the others (ps exits 1 and still prints them)', async () => {
    // A pid that just exited (and was reaped): in range, no longer a process.
    const gone = spawnSync('/bin/sh', ['-c', 'echo $$']).stdout.toString().trim();
    const read = createThrottleReader((args) => runReadOnly('ps', args));
    const rows = await read([process.pid, Number(gone)]);
    expect(rows.has(Number(gone))).toBe(false);
    expect(rows.get(process.pid)).toMatchObject({ ppid: process.ppid });
  });
});
