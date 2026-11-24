import { parseCpuTime } from './ps-table';
import type { ReadCpuSeconds, RunPs } from './tree-sampler';
import type { SessionProcessDetail } from './types';

/**
 * A task's CPU cap: the sum of its tree's CPU held at or under a percentage of one core (100% = one core), on macOS
 * and Linux alike, with no root and no wrapper around the spawn.
 *
 * Neither OS gives an unprivileged quota a daemon can put on a running process tree: Linux has one (cgroup v2
 * `cpu.max`) only when systemd delegates the cpu controller to the user's slice, and macOS has none. So the cap is a
 * duty cycle, as `cpulimit` does it. Every period (250 ms) the throttler reads the tree's cumulative CPU time, works out
 * the share of the period the tree may run so that its rate meets the cap, lets it run that long (SIGCONT) and holds it
 * the rest (SIGSTOP). The share adapts each period (share × cap / measured rate), so a tree under the cap runs free and
 * a tree at 400% under a 100% cap runs about a quarter of each period.
 *
 * What it never does:
 *   - stop the session's Claude Code process itself (its CPU counts; holding it would stall the turn's I/O) or a
 *     zombie;
 *   - continue a process it did not stop: a process a person paused, or one already stopped by someone else, is
 *     left alone, and a process a person pauses while it is held becomes theirs (`forget`);
 *   - signal a pid whose start time is not the one the tree sampled (a reused pid);
 *   - leave anything held: an abort of the session, a cap change and shutdown continue everything it holds.
 */

/** One period of the duty cycle. */
export const THROTTLE_PERIOD_MS = 250;
/** The smallest share of a period a capped tree runs (so a runaway tree still makes progress, and stops are short). */
const MIN_SHARE = 0.05;
/** A tree that ran free (share 1) this many periods in a row is let go until a sample finds it over its cap again. */
const IDLE_PERIODS = 8;

/** One process as the throttler reads it each period. */
export interface ThrottleRead {
  readonly cpuSeconds: number;
  readonly startToken: string;
  /** `ps stat` (`T` = stopped). */
  readonly stat: string;
}

/** Reads every pid's cumulative CPU time, start time and state now; a pid that is gone is absent. */
export type ReadThrottle = (pids: readonly number[]) => Promise<Map<number, ThrottleRead>>;

export interface CpuThrottlerDeps {
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly read: ReadThrottle;
  readonly now: () => number;
  /** A person's pause (the monitor's own record): never continued, never stopped again by the throttler. */
  readonly userPaused: (sessionKey: string, pid: number, startToken: string) => boolean;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly logger?: { warn(msg: string, meta?: unknown): void };
}

interface Member {
  readonly pid: number;
  readonly startToken: string;
  /** The Claude Code process (counted, never stopped). */
  readonly root: boolean;
}

interface Capped {
  cap: number;
  members: Member[];
  /** pid → its cumulative CPU at the last read, for members whose start time matched. */
  prev: Map<number, number>;
  prevAt: number;
  /** The share of a period the tree runs. */
  share: number;
  freePeriods: number;
  /** What this throttler stopped and has not continued: pid → start time. */
  held: Map<number, string>;
}

export class CpuThrottler {
  private readonly sessions = new Map<string, Capped>();
  private timer: unknown = null;
  private stopTimer: unknown = null;
  private ticking = false;
  private disposed = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: CpuThrottlerDeps) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * After every monitor sample: each session's cap (`null` = none) and its tree. A session over its cap starts being
   * metered; one whose cap went away, or that left the sample, is let go (everything it holds continued).
   */
  update(sessions: readonly SessionProcessDetail[], capFor: (sessionKey: string) => number | null): void {
    if (this.disposed) return;
    const seen = new Set<string>();
    for (const s of sessions) {
      seen.add(s.sessionKey);
      const cap = capFor(s.sessionKey);
      const members: Member[] = s.processes
        .filter((p) => p.state !== 'zombie')
        .map((p) => ({ pid: p.pid, startToken: p.startToken, root: p.role === 'root' }));
      const cur = this.sessions.get(s.sessionKey);
      if (cap === null || !(cap > 0)) {
        if (cur) this.release(s.sessionKey);
        continue;
      }
      if (cur) {
        cur.cap = cap;
        cur.members = members;
        continue;
      }
      // Metering starts only when the tree is over its cap (a whole 5 s sample of it).
      if (s.cpuPercent <= cap) continue;
      this.sessions.set(s.sessionKey, {
        cap,
        members,
        prev: new Map(),
        prevAt: 0,
        share: Math.max(MIN_SHARE, Math.min(1, cap / Math.max(s.cpuPercent, 1))),
        freePeriods: 0,
        held: new Map(),
      });
    }
    for (const key of [...this.sessions.keys()]) if (!seen.has(key)) this.release(key);
    this.schedule();
  }

  /** Whether the throttler holds this process stopped right now. */
  holds(sessionKey: string, pid: number, startToken: string): boolean {
    return this.sessions.get(sessionKey)?.held.get(pid) === startToken;
  }

  /** The cap being enforced on a session now (`null`: not metered). */
  meteredCap(sessionKey: string): number | null {
    return this.sessions.get(sessionKey)?.cap ?? null;
  }

  /** A person paused a process: it is theirs now — the throttler neither continues nor stops it again. */
  forget(sessionKey: string, pid: number): void {
    this.sessions.get(sessionKey)?.held.delete(pid);
  }

  /** Continue everything held for a session and stop metering it (an abort, a cap change, the tree gone). */
  release(sessionKey: string): void {
    const s = this.sessions.get(sessionKey);
    if (!s) return;
    this.continueHeld(sessionKey, s);
    this.sessions.delete(sessionKey);
    if (this.sessions.size === 0) this.cancelTimers();
  }

  /** Shutdown: continue everything held, in every session; nothing is metered after this. Synchronous. */
  releaseAll(): void {
    this.disposed = true;
    this.cancelTimers();
    for (const key of [...this.sessions.keys()]) this.release(key);
  }

  private cancelTimers(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.stopTimer !== null) this.clearTimer(this.stopTimer);
    this.timer = null;
    this.stopTimer = null;
  }

  private schedule(): void {
    if (this.disposed || this.timer !== null || this.sessions.size === 0) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, 0);
  }

  private continueHeld(sessionKey: string, s: Capped): void {
    for (const [pid, token] of s.held) {
      if (this.deps.userPaused(sessionKey, pid, token)) continue;
      try {
        this.deps.kill(pid, 'SIGCONT');
      } catch {
        // Gone: nothing to continue.
      }
    }
    s.held.clear();
  }

  /** One period: read, continue what is held, then hold again after the run share. */
  async tick(): Promise<void> {
    if (this.ticking || this.disposed || this.sessions.size === 0) return;
    this.ticking = true;
    try {
      const pids = [...new Set([...this.sessions.values()].flatMap((s) => s.members.map((m) => m.pid)))];
      let read: Map<number, ThrottleRead>;
      try {
        read = await this.deps.read(pids);
      } catch (err) {
        // Unknown: hold nothing this period.
        this.deps.logger?.warn('cpu throttle read failed', { error: String(err) });
        for (const [key, s] of this.sessions) this.continueHeld(key, s);
        return;
      }
      if (this.disposed) return;
      const at = this.deps.now();
      const plans: Array<{ key: string; s: Capped; stop: Member[] }> = [];
      for (const [key, s] of this.sessions) {
        // The tree's rate since the last read: members whose start time still matches.
        let used = 0;
        const next = new Map<number, number>();
        for (const m of s.members) {
          const r = read.get(m.pid);
          if (!r || r.startToken !== m.startToken) continue;
          next.set(m.pid, r.cpuSeconds);
          const before = s.prev.get(m.pid);
          if (before !== undefined && r.cpuSeconds >= before) used += r.cpuSeconds - before;
        }
        const elapsed = s.prevAt > 0 ? (at - s.prevAt) / 1000 : 0;
        s.prev = next;
        s.prevAt = at;
        if (elapsed > 0) {
          const rate = (used / elapsed) * 100;
          s.share = rate > 0 ? Math.max(MIN_SHARE, Math.min(1, (s.share * s.cap) / rate)) : 1;
        }
        // Continue what was held (the run part of this period). What this throttler held reads as stopped in this
        // period's read; only a stop it did not make is someone else's.
        const wasHeld = new Map(s.held);
        this.continueHeld(key, s);
        if (s.share >= 1) {
          s.freePeriods++;
          if (s.freePeriods >= IDLE_PERIODS) this.sessions.delete(key);
          continue;
        }
        s.freePeriods = 0;
        // What may be held: not the Claude Code process, a matching start time, not stopped by anyone else, not a
        // person's pause.
        const stop = s.members.filter((m) => {
          if (m.root) return false;
          const r = read.get(m.pid);
          if (!r || r.startToken !== m.startToken) return false;
          if (r.stat.startsWith('T') && wasHeld.get(m.pid) !== m.startToken) return false;
          return !this.deps.userPaused(key, m.pid, m.startToken);
        });
        plans.push({ key, s, stop });
      }
      if (plans.length === 0) {
        if (this.sessions.size > 0) this.timer = this.setTimer(() => this.onPeriod(), THROTTLE_PERIOD_MS);
        return;
      }
      // One shared period: each session runs its own share of it, then is held until the next tick.
      for (const plan of plans) {
        const runMs = Math.round(plan.s.share * THROTTLE_PERIOD_MS);
        this.setTimer(() => this.hold(plan.key, plan.s, plan.stop), runMs);
      }
      this.timer = this.setTimer(() => this.onPeriod(), THROTTLE_PERIOD_MS);
    } finally {
      this.ticking = false;
    }
  }

  private onPeriod(): void {
    this.timer = null;
    void this.tick();
  }

  private hold(key: string, s: Capped, stop: readonly Member[]): void {
    // Released or replaced since this period was planned: nothing to hold.
    if (this.disposed || this.sessions.get(key) !== s) return;
    for (const m of stop) {
      if (this.deps.userPaused(key, m.pid, m.startToken)) continue;
      try {
        this.deps.kill(m.pid, 'SIGSTOP');
        s.held.set(m.pid, m.startToken);
      } catch {
        // Gone or refused: not held.
      }
    }
  }
}

/** `ps -o pid=,stat=,lstart=,time=` rows → pid → its read. Malformed lines are skipped. */
export function parseThrottleRows(out: string): Map<number, ThrottleRead> {
  const rows = new Map<number, ThrottleRead>();
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 8) continue;
    const pid = /^\d+$/.test(t[0]) ? Number(t[0]) : Number.NaN;
    const cpu = parseCpuTime(t[7]);
    if (!Number.isSafeInteger(pid) || cpu === null) continue;
    rows.set(pid, { stat: t[1], startToken: t.slice(2, 7).join(' '), cpuSeconds: cpu });
  }
  return rows;
}

/**
 * The production read: one `ps` for every pid (its state, start time and CPU time — centiseconds on macOS), with Linux
 * `/proc/<pid>/stat` ticks over ps's whole seconds there.
 */
export function createThrottleReader(runPs: RunPs, readCpuSeconds?: ReadCpuSeconds): ReadThrottle {
  return async (pids) => {
    if (pids.length === 0) return new Map();
    const rows = parseThrottleRows(await runPs(['-o', 'pid=,stat=,lstart=,time=', '-p', pids.join(',')]));
    if (!readCpuSeconds) return rows;
    const fine = await readCpuSeconds([...rows.keys()]).catch(() => new Map<number, number>());
    for (const [pid, cpu] of fine) {
      const r = rows.get(pid);
      if (r) rows.set(pid, { ...r, cpuSeconds: cpu });
    }
    return rows;
  };
}
