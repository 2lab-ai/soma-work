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
    // Once for the periods' scans, once for the stops' (each said once while it lasts).
    expect(warnings.filter((w) => /parent map could not be read;/.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => /could not be read at a stop/.test(w))).toHaveLength(1);
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

describe('CpuThrottler — hardening (#1421)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance in small steps until `done` (at most `ms`). */
  async function until(done: () => boolean, ms = 5_000): Promise<boolean> {
    for (let i = 0; i < ms / 5 && !done(); i++) await vi.advanceTimersByTimeAsync(5);
    return done();
  }

  it('a worker forked after the period read is found at the stop and held too (not only at the next period)', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 2, START, 10);
    t.update([session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    await vi.advanceTimersByTimeAsync(3_000);
    // Right after a period's parent scan, 11 forks a 4-core worker that is gone before the next period reads.
    let forked = false;
    m.afterParents = () => {
      if (forked) return;
      forked = true;
      m.add(30, 4, START, 11);
      setTimeout(() => m.procs.delete(30), 200);
    };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forked).toBe(true);
    expect(m.signals.some(([pid, sig]) => pid === 30 && sig === 'SIGSTOP')).toBe(true);
  });

  /** A throttler over `m` whose reads can drop pid 12 and whose live probe is recorded (and can take time). */
  function probed(m: Machine, onProbe: () => void = () => {}) {
    const events: string[] = [];
    const ctl: { dropTwelve: number; onDrop: (() => void) | null; beforeRead: (() => void) | null } = {
      dropTwelve: 0,
      onDrop: null,
      beforeRead: null,
    };
    const t = new CpuThrottler({
      kill: (pid, sig) => {
        events.push(`${pid}:${sig}`);
        m.kill(pid, sig);
      },
      read: async (pids) => {
        const before = ctl.beforeRead;
        ctl.beforeRead = null;
        before?.();
        const out = await m.read(pids);
        if (ctl.dropTwelve > 0 && pids.includes(12)) {
          ctl.dropTwelve--;
          out.delete(12);
          ctl.onDrop?.();
        }
        return out;
      },
      readParents: m.readParents,
      liveStartTokens: (pids) => {
        events.push('probe');
        onProbe();
        return m.liveStartTokens(pids);
      },
      now: () => Date.now(),
      userPaused: () => false,
    });
    return { t, events, ctl };
  }

  it('a hold the period read missed is read again, asynchronously, with every hold before any continue — no live probe', async () => {
    const m = new Machine();
    const { t, events, ctl } = probed(m);
    m.add(10, 0).add(11, 2).add(12, 2);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child'), proc(12, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await until(() => !!m.procs.get(11)?.stopped && !!m.procs.get(12)?.stopped)).toBe(true);
    events.length = 0;
    ctl.dropTwelve = 1; // the next read misses 12; the re-read answers it
    expect(await until(() => events.includes('11:SIGCONT') && events.includes('12:SIGCONT'))).toBe(true);
    expect(events).not.toContain('probe');
  });

  it('a held pid reused while the hold re-read is out is not continued: the continue goes by the re-read', async () => {
    const m = new Machine();
    const { t, events, ctl } = probed(m);
    m.add(10, 0).add(11, 2).add(12, 2);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child'), proc(12, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await until(() => !!m.procs.get(11)?.stopped && !!m.procs.get(12)?.stopped)).toBe(true);
    events.length = 0;
    // The period read misses 12; 11 changes hands while the re-read of every hold is out (the period read had it).
    let reused = false;
    ctl.dropTwelve = 1;
    ctl.onDrop = () => {
      ctl.onDrop = null;
      ctl.beforeRead = () => {
        reused = true;
        m.reuse(11, true);
      };
    };
    expect(await until(() => events.includes('12:SIGCONT'))).toBe(true);
    expect(reused).toBe(true);
    expect(events).not.toContain('11:SIGCONT');
    expect(events).not.toContain('probe');
  });

  it('several trees: a live probe for one runs before any tree is continued', async () => {
    const m = new Machine();
    const { t, events, ctl } = probed(m);
    m.add(10, 0).add(11, 2).add(20, 0).add(12, 2);
    t.update(
      [
        session(200, [proc(10, 'root'), proc(11, 'child')], 'A'),
        session(200, [proc(20, 'root'), proc(12, 'child')], 'B'),
      ],
      () => 100,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await until(() => !!m.procs.get(11)?.stopped && !!m.procs.get(12)?.stopped)).toBe(true);
    events.length = 0;
    ctl.dropTwelve = 2; // tree B's 12: the period read and its re-read both miss it — probed live
    expect(await until(() => events.includes('probe') && events.includes('11:SIGCONT'))).toBe(true);
    expect(events.indexOf('probe')).toBeLessThan(events.indexOf('11:SIGCONT'));
  });

  it('a pid reused during another tree’s slow live probe is not continued: the probe answers for every hold', async () => {
    const m = new Machine();
    let reusedInProbe = false;
    const { t, events, ctl } = probed(m, () => {
      // The probe blocks for 1.5 s; meanwhile tree A's 11 (read fine before it) exits and its pid is reused.
      vi.setSystemTime(Date.now() + 1_500);
      if (!reusedInProbe) {
        reusedInProbe = true;
        m.reuse(11, true);
      }
    });
    m.add(10, 0).add(11, 2).add(20, 0).add(12, 2);
    t.update(
      [
        session(200, [proc(10, 'root'), proc(11, 'child')], 'A'),
        session(200, [proc(20, 'root'), proc(12, 'child')], 'B'),
      ],
      () => 100,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await until(() => !!m.procs.get(11)?.stopped && !!m.procs.get(12)?.stopped)).toBe(true);
    events.length = 0;
    ctl.dropTwelve = 2; // tree B's 12: the period read and its re-read both miss it — probed live
    expect(await until(() => events.includes('12:SIGCONT'))).toBe(true);
    expect(reusedInProbe).toBe(true);
    expect(events).not.toContain('11:SIGCONT');
  });

  it('a live probe (a pid two reads missed) runs while the tree is still stopped: a slow probe lets nothing run free', async () => {
    const m = new Machine();
    let ranDuringProbe = -1;
    const { t, events, ctl } = probed(m, () => {
      // The probe blocks for 1.5 s; whatever the cap had continued before it runs that long.
      const before = m.cpuOf(11);
      vi.setSystemTime(Date.now() + 1_500);
      ranDuringProbe = m.cpuOf(11) - before;
    });
    m.add(10, 0).add(11, 2).add(12, 2);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child'), proc(12, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await until(() => !!m.procs.get(11)?.stopped && !!m.procs.get(12)?.stopped)).toBe(true);
    events.length = 0;
    ctl.dropTwelve = 2; // the period read and its re-read both miss 12: it is probed live
    expect(await until(() => events.includes('probe'))).toBe(true);
    expect(ranDuringProbe).toBe(0);
    expect(events.indexOf('probe')).toBeLessThan(events.indexOf('11:SIGCONT'));
    // The probe answered for 12: it is continued too, not left stopped.
    expect(await until(() => events.includes('12:SIGCONT'))).toBe(true);
  });

  it('a shell that forks a worker after each continue, gone within the period: the whole tree stays near its cap', async () => {
    const m = new Machine();
    let next = 1000;
    let gone = 0;
    const t = new CpuThrottler({
      kill: (pid, sig) => {
        m.kill(pid, sig);
        // 11 is a shell: right after each continue it forks a 4-core worker that exits 200 ms later (its CPU is kept
        // when it exits).
        if (pid === 11 && sig === 'SIGCONT') {
          setTimeout(() => {
            if (m.procs.get(11)?.stopped) return;
            const worker = next++;
            m.add(worker, 4, START, 11);
            setTimeout(() => {
              gone += m.cpuOf(worker);
              m.procs.delete(worker);
            }, 200);
          }, 10);
        }
      },
      read: m.read,
      readParents: m.readParents,
      liveStartTokens: m.liveStartTokens,
      now: () => Date.now(),
      userPaused: () => false,
    });
    m.add(10, 0).add(11, 2, START, 10);
    t.update([session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    await vi.advanceTimersByTimeAsync(8_000);
    const workers = () => [...m.procs.keys()].filter((p) => p >= 1000).reduce((n, p) => n + m.cpuOf(p), 0);
    const before = m.cpuOf(11) + workers() + gone;
    await vi.advanceTimersByTimeAsync(10_000);
    const rate = ((m.cpuOf(11) + workers() + gone - before) / 10) * 100;
    // Held near its cap — and not starved by the CPU it is charged for its workers.
    expect(rate).toBeGreaterThan(50);
    expect(rate).toBeLessThan(150);
    t.releaseAll();
  });

  it('a stop’s extra scan that fails does not erase the period scan’s bound: a worker the next period finds is charged', async () => {
    const m = new Machine();
    // The read before a stop carries no Claude Code process (10); the scan right after it is the stop's — it fails.
    let stopScanNext = false;
    let discovered = false;
    m.readHook = async (pids) => {
      if (!pids.includes(10)) stopScanNext = true;
      // The period's read of the newly found worker: it exits right after, so this period's charge is all it costs.
      if (pids.includes(30) && !discovered) {
        discovered = true;
        setTimeout(() => m.procs.delete(30), 1);
      }
    };
    const t = new CpuThrottler({
      kill: m.kill,
      read: m.read,
      readParents: async () => {
        if (stopScanNext) {
          stopScanNext = false;
          throw new Error('ps -A timed out');
        }
        return m.readParents();
      },
      liveStartTokens: m.liveStartTokens,
      now: () => Date.now(),
      userPaused: () => false,
    });
    m.add(10, 0).add(11, 2, START, 10);
    t.update([session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    await vi.advanceTimersByTimeAsync(5_000);
    const steady = t.meteredShare('A') ?? 0;
    expect(steady).toBeGreaterThan(0.3);
    // A 4-core worker runs under 11 until a period's scan finds it; it exits right after that period's read.
    m.add(30, 4, START, 11);
    expect(await until(() => discovered)).toBe(true);
    let lowest = 1;
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(5);
      lowest = Math.min(lowest, t.meteredShare('A') ?? 1);
    }
    // Its CPU since the last good period scan is charged: the share drops for it.
    expect(lowest).toBeLessThan(steady / 2);
    t.releaseAll();
  });

  it('a read of the workers found at a stop that keeps failing is said once', async () => {
    const { m, t, warnings } = setup();
    m.add(10, 0).add(11, 2, START, 10);
    // Every scan leaves a new worker under 11 for the next one to find. A stop is: its read (no 10), its scan, then
    // the read of what that scan found (members, 10 included) — that last read fails.
    let next = 2000;
    let stopRead = false;
    let stopScanned = false;
    m.afterParents = () => {
      m.add(next++, 1, START, 11);
      if (stopRead) {
        stopRead = false;
        stopScanned = true;
      }
    };
    m.readHook = async (pids) => {
      if (!pids.includes(10)) {
        stopRead = true;
        return;
      }
      if (stopScanned) {
        stopScanned = false;
        throw new Error('ps timed out');
      }
    };
    t.update([session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warnings.filter((w) => w.includes('workers found at a stop failed'))).toHaveLength(1);
    t.releaseAll();
  });

  it('a nested tree’s process is never taken for a worker at another tree’s stop', async () => {
    const { m, t } = setup();
    // Tree A: 10 → 11 (2 cores). Tree B's Claude Code process 20 runs under A's 11, with its own worker 21.
    m.add(10, 0).add(11, 2, START, 10).add(20, 0, START, 11).add(21, 2, START, 20);
    t.update(
      [
        session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })], 'A'),
        session(200, [proc(20, 'root', { ppid: 11 }), proc(21, 'child', { ppid: 20 })], 'B'),
      ],
      () => 100,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.signals.some(([pid, sig]) => pid === 20 && sig === 'SIGSTOP')).toBe(false);
    t.releaseAll();
  });

  it('a stop read that keeps failing in one tree is said once, whatever another tree’s reads do', async () => {
    const { m, t, warnings } = setup();
    m.add(10, 0).add(11, 2).add(20, 0).add(21, 2);
    // A's read before a stop (its worker, no Claude Code process) fails; B's answers.
    m.readHook = async (pids) => {
      if (pids.includes(11) && !pids.includes(10)) throw new Error('ps timed out');
    };
    t.update(
      [
        session(200, [proc(10, 'root'), proc(11, 'child')], 'A'),
        session(200, [proc(20, 'root'), proc(21, 'child')], 'B'),
      ],
      () => 100,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warnings.filter((w) => w.includes('identity read before a stop failed'))).toHaveLength(1);
    t.releaseAll();
  });

  it('a stop scan that keeps failing is said once', async () => {
    const m = new Machine();
    let stopRead = false;
    m.readHook = async (pids) => {
      if (!pids.includes(10)) stopRead = true;
    };
    const warnings: string[] = [];
    const t = new CpuThrottler({
      kill: m.kill,
      read: m.read,
      readParents: async () => {
        if (stopRead) {
          stopRead = false;
          throw new Error('ps -A timed out');
        }
        return m.readParents();
      },
      liveStartTokens: m.liveStartTokens,
      now: () => Date.now(),
      userPaused: () => false,
      logger: { warn: (msg: string) => warnings.push(msg) },
    });
    m.add(10, 0).add(11, 2, START, 10);
    t.update([session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warnings.filter((w) => w.includes('could not be read at a stop'))).toHaveLength(1);
    t.releaseAll();
  });

  it('a failed re-read of the holds never takes a valid sample from the rate: the worker stays held, nothing collapses', async () => {
    const m = new Machine();
    const ctl = { dropTwelve: 0, failNext: 0 };
    const warnings: string[] = [];
    const t = new CpuThrottler({
      logger: { warn: (msg: string) => warnings.push(msg) },
      kill: m.kill,
      read: async (pids) => {
        if (ctl.failNext > 0 && !pids.includes(10)) {
          ctl.failNext--;
          throw new Error('ps timed out');
        }
        const out = await m.read(pids);
        if (ctl.dropTwelve > 0 && pids.includes(12) && pids.includes(10)) {
          ctl.dropTwelve--;
          out.delete(12);
        }
        return out;
      },
      readParents: m.readParents,
      liveStartTokens: m.liveStartTokens,
      now: () => Date.now(),
      userPaused: () => false,
    });
    m.add(10, 0).add(11, 2, START, 10).add(12, 2, START, 10);
    t.update(
      [session(400, [proc(10, 'root'), proc(11, 'child', { ppid: 10 }), proc(12, 'child', { ppid: 10 })])],
      () => 100,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await until(() => !!m.procs.get(11)?.stopped && !!m.procs.get(12)?.stopped)).toBe(true);
    const steady = t.meteredShare('A') ?? 0;
    // The next period read misses 12, and the re-read of the holds that follows fails.
    ctl.dropTwelve = 1;
    ctl.failNext = 1;
    const cpu = () => m.cpuOf(11) + m.cpuOf(12);
    const before = cpu();
    let lowest = 1;
    for (let i = 0; i < 80; i++) {
      await vi.advanceTimersByTimeAsync(25);
      lowest = Math.min(lowest, t.meteredShare('A') ?? 1);
    }
    // (It dipped to 0.4 × steady when the failed re-read dropped the workers from the rate and they came back as new.)
    expect(lowest).toBeGreaterThan(steady * 0.7);
    // The cap still holds through it, and the failed re-read is said.
    expect(((cpu() - before) / 2) * 100).toBeLessThan(150);
    expect(warnings.filter((w) => w.includes('re-read of held processes failed'))).toHaveLength(1);
    t.releaseAll();
  });

  it('raising the cap of a held tree keeps it metered on the new cap (no free seconds until the next sample)', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await until(() => !!m.procs.get(11)?.stopped)).toBe(true);
    // The next sample reads the tree at about its old cap; the admin raises the cap to 200% while it is held.
    t.update([session(100, [proc(10, 'root'), proc(11, 'child')])], () => 200);
    expect(t.meteredCap('A')).toBe(200);
    // From the update on: no free run (4 cores) while the new plan settles.
    const atUpdate = m.cpuOf(11);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(((m.cpuOf(11) - atUpdate) / 3) * 100).toBeLessThan(260);
    const before = m.cpuOf(11);
    await vi.advanceTimersByTimeAsync(5_000);
    const rate = ((m.cpuOf(11) - before) / 5) * 100;
    expect(rate).toBeGreaterThan(140);
    expect(rate).toBeLessThan(260);
  });

  it('a cap raised while a period reads: the rate that period measured under the old share does not raise the new one again', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 4);
    t.update([session(400, [proc(10, 'root'), proc(11, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await until(() => !!m.procs.get(11)?.stopped)).toBe(true);
    // The next period's read (it carries the Claude Code process) is out when the admin raises the cap to 200%: the
    // share becomes about 0.25 × 2. The window that read closes was spent under 0.25 (about 100%); applied to 0.5 it
    // would raise the share to 1 — a free period.
    let raised = false;
    m.onRead = (pids) => {
      if (raised || !pids.includes(10)) return;
      raised = true;
      t.update([session(100, [proc(10, 'root'), proc(11, 'child')])], () => 200);
    };
    let top = 0;
    for (let i = 0; i < 400; i++) {
      await vi.advanceTimersByTimeAsync(5);
      if (raised) top = Math.max(top, t.meteredShare('A') ?? 1);
    }
    expect(raised).toBe(true);
    expect(top).toBeLessThan(0.8);
  });

  it('a pid an update names a Claude Code process while it is being read is never stopped as a worker', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 2, START, 10);
    const a = () => session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })], 'A');
    t.update([a()], () => 100);
    await vi.advanceTimersByTimeAsync(3_000);
    // Right after a parent scan, 11 starts 40: another session's Claude Code process. While the read that would
    // adopt it as A's worker is out, the monitor's update names it session B's root (B is not over its cap).
    let forked = false;
    let named = false;
    m.afterParents = () => {
      if (forked) return;
      forked = true;
      m.add(40, 1, START, 11);
    };
    m.onRead = (pids) => {
      if (named || !pids.includes(40)) return;
      named = true;
      t.update([a(), session(50, [proc(40, 'root', { ppid: 11 })], 'B')], () => 100);
    };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(named).toBe(true);
    expect(m.signals.some(([pid, sig]) => pid === 40 && sig === 'SIGSTOP')).toBe(false);
  });

  it('a worker the last scan already listed, whose read missed it, is baselined when found later — not charged its lifetime', async () => {
    const m = new Machine();
    // The first read that asks for 30 misses it (a partial ps).
    let missed = false;
    const t = new CpuThrottler({
      kill: m.kill,
      read: async (pids) => {
        const out = await m.read(pids);
        if (!missed && pids.includes(30)) {
          missed = true;
          out.delete(30);
        }
        return out;
      },
      readParents: m.readParents,
      liveStartTokens: m.liveStartTokens,
      now: () => Date.now(),
      userPaused: () => false,
    });
    m.add(10, 0).add(11, 2, START, 10);
    t.update([session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    await vi.advanceTimersByTimeAsync(5_000);
    const steady = t.meteredShare('A') ?? 0;
    // Right after a stop's scan, 30 appears: it has run for a long time (1000 CPU-seconds) and is new to the tree.
    // The period scan lists it, the period's read of it misses it, and the next stop finds and reads it.
    let armed = false;
    let added = false;
    m.onRead = (pids) => {
      if (!added && !pids.includes(10)) armed = true; // the identity read before a stop
    };
    m.afterParents = () => {
      if (!armed || added) return;
      added = true;
      m.add(30, 1, START, 11);
      const p30 = m.procs.get(30);
      if (p30) p30.cpu = 1000;
    };
    let low = steady;
    for (let i = 0; i < 600; i++) {
      await vi.advanceTimersByTimeAsync(5);
      low = Math.min(low, t.meteredShare('A') ?? low);
    }
    expect(missed).toBe(true);
    expect(m.signals.some(([pid, sig]) => pid === 30 && sig === 'SIGSTOP')).toBe(true);
    expect(low).toBeGreaterThan(steady * 0.3);
  });

  it('a stop whose read of a new worker ends after the next period began leaves it to that period, which charges it', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 2, START, 10);
    t.update([session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    await vi.advanceTimersByTimeAsync(5_000);
    const steady = t.meteredShare('A') ?? 0;
    // While a period reads (after its scan), 11 forks 30 (4 cores). The stop finds it; its read of 30 is held until
    // the next period, which scanned already, starts its own read of 30 — then the stop's read ends first.
    let forked = false;
    m.onRead = (pids) => {
      if (forked || !pids.includes(10)) return;
      forked = true;
      m.add(30, 4, START, 11);
    };
    let reads30 = 0;
    let release: () => void = () => {};
    const stopRead = new Promise<void>((r) => {
      release = r;
    });
    m.readHook = async (pids) => {
      if (!pids.includes(30)) return;
      reads30++;
      if (reads30 === 1) await stopRead;
      else if (reads30 === 2) {
        release();
        await new Promise((r) => setTimeout(r, 1));
        // 30 exits right after this read: what it used before it is all the cap can charge.
        setTimeout(() => m.procs.delete(30), 2);
      }
    };
    let low = steady;
    for (let i = 0; i < 400; i++) {
      await vi.advanceTimersByTimeAsync(5);
      low = Math.min(low, t.meteredShare('A') ?? low);
    }
    expect(reads30).toBeGreaterThanOrEqual(2);
    // 30 ran free from its fork to the period's read and then exited: that CPU is charged, so the share dips.
    expect(low).toBeLessThan(steady * 0.6);
  });

  it('a stop whose identity read keeps failing is said once (a cap that stopped biting is not silent)', async () => {
    const { m, t, warnings } = setup();
    m.add(10, 0).add(11, 2).add(12, 2);
    // The period read (it carries the Claude Code process) answers; the read before each stop fails.
    m.readHook = async (pids) => {
      if (!pids.includes(10)) throw new Error('ps timed out');
    };
    t.update([session(400, [proc(10, 'root'), proc(11, 'child'), proc(12, 'child')])], () => 100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warnings.filter((w) => w.includes('identity read before a stop failed'))).toHaveLength(1);
  });

  it('a worker found after a parent-scan outage is baselined, not charged its whole lifetime in one window', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(11, 2, START, 10);
    t.update([session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    await vi.advanceTimersByTimeAsync(5_000);
    const steady = t.meteredShare('A') ?? 0;
    expect(steady).toBeGreaterThan(0.3);
    // The scan fails for 30 s while a worker under 11 runs unseen (it gathers ~30 s of CPU).
    m.parentsFail = true;
    m.add(30, 1, START, 11);
    await vi.advanceTimersByTimeAsync(30_000);
    m.parentsFail = false;
    // The scan reads again and finds it: the share follows the tree's rate, not 30 s of CPU in one period.
    expect(await until(() => t.meteredShare('A') !== steady && m.signals.some(([pid]) => pid === 30))).toBe(true);
    let lowest = 1;
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(25);
      lowest = Math.min(lowest, t.meteredShare('A') ?? 1);
    }
    expect(lowest).toBeGreaterThan(0.1);
  });

  it('two trees with unequal caps are each held to their own', async () => {
    const { m, t } = setup();
    m.add(10, 0).add(20, 0);
    const a = [11, 12, 13, 14];
    const b = [21, 22];
    for (const pid of a) m.add(pid, 1);
    for (const pid of b) m.add(pid, 1);
    t.update(
      [
        session(400, [proc(10, 'root'), ...a.map((pid) => proc(pid, 'child'))], 'A'),
        session(200, [proc(20, 'root'), ...b.map((pid) => proc(pid, 'child'))], 'B'),
      ],
      (key) => (key === 'A' ? 100 : 50),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const sum = (pids: number[]) => pids.reduce((n, p) => n + m.cpuOf(p), 0);
    const [beforeA, beforeB] = [sum(a), sum(b)];
    await vi.advanceTimersByTimeAsync(10_000);
    const rateA = ((sum(a) - beforeA) / 10) * 100;
    const rateB = ((sum(b) - beforeB) / 10) * 100;
    expect(rateA).toBeGreaterThan(70);
    expect(rateA).toBeLessThan(135);
    expect(rateB).toBeGreaterThan(35);
    expect(rateB).toBeLessThan(68);
  });

  it('through the production reader: a held pid reused while the fine counters are read is never continued', async () => {
    // The fine counter (Linux /proc) is read first and the identity (ps) last: a pid that changes hands in between
    // reads with the new process's start time, so the hold on the old one is dropped, not continued.
    const table = new Map<number, { ppid: number; stat: string; start: string; cpu: number }>([
      [10, { ppid: 1, stat: 'S', start: START, cpu: 0 }],
      [11, { ppid: 10, stat: 'R', start: START, cpu: 0 }],
    ]);
    const signals: Array<[number, NodeJS.Signals]> = [];
    let gate: Promise<void> | null = null;
    let open: () => void = () => {};
    const runPs = async (args: readonly string[]) => {
      const pids = String(args[args.indexOf('-p') + 1] ?? '')
        .split(',')
        .map(Number);
      return pids
        .filter((pid) => table.has(pid))
        .map((pid) => {
          const r = table.get(pid) as { ppid: number; stat: string; start: string; cpu: number };
          return `${pid} ${r.ppid} ${r.stat} ${r.start} 0:${r.cpu.toFixed(2).padStart(5, '0')}`;
        })
        .join('\n');
    };
    const readCpuSeconds = async (pids: readonly number[]) => {
      if (gate) await gate;
      return new Map(pids.filter((pid) => table.has(pid)).map((pid) => [pid, table.get(pid)?.cpu ?? 0] as const));
    };
    const t = new CpuThrottler({
      kill: (pid, sig) => {
        signals.push([pid, sig]);
        const r = table.get(pid);
        if (!r) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        r.stat = sig === 'SIGSTOP' ? 'T' : 'R';
      },
      read: createThrottleReader(runPs, readCpuSeconds),
      liveStartTokens: (pids) => new Map(pids.map((pid) => [pid, table.get(pid)?.start ?? null])),
      now: () => Date.now(),
      userPaused: () => false,
    });
    // 11 burns 2 cores: its counter moves with the clock.
    const burn = setInterval(() => {
      const r = table.get(11);
      if (r && r.stat !== 'T' && r.start === START) r.cpu += 0.01;
    }, 5);
    t.update([session(200, [proc(10, 'root'), proc(11, 'child', { ppid: 10 })])], () => 100);
    expect(await until(() => table.get(11)?.stat === 'T')).toBe(true);
    // The next fine read waits; meanwhile 11 exits and its pid goes to another program.
    gate = new Promise((r) => {
      open = r;
    });
    await vi.advanceTimersByTimeAsync(400);
    table.set(11, { ppid: 1, stat: 'S', start: 'Wed Nov 25 08:00:00 2026', cpu: 0 });
    signals.length = 0;
    gate = null;
    open();
    await vi.advanceTimersByTimeAsync(1_000);
    clearInterval(burn);
    expect(signals.filter(([pid]) => pid === 11)).toEqual([]);
    t.releaseAll();
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
