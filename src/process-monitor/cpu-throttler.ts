import { parseCpuTime, parseParentMap } from './ps-table';
import type { ReadCpuSeconds, RunPs } from './tree-sampler';
import type { SessionProcessDetail } from './types';

/**
 * A task's CPU cap: the sum of its tree's CPU held at or under a percentage of one core (100% = one core), on macOS
 * and Linux alike, with no root and no wrapper around the spawn.
 *
 * Neither OS gives an unprivileged quota a daemon can put on a running process tree: Linux has one (cgroup v2
 * `cpu.max`) only when systemd delegates the cpu controller to the user's slice, and macOS has none. So the cap is a
 * duty cycle, as `cpulimit` does it. Every period (250 ms) the throttler reads the tree — its members from the last
 * monitor sample plus whatever they started since (the parent map is read again each period) — and its cumulative CPU
 * time, works out the share of the period the tree may run so that its rate meets the cap, lets it run that long
 * (SIGCONT) and holds it the rest (SIGSTOP). The share adapts each period (share × cap / measured rate), so a tree
 * under the cap runs free and a tree at 400% under a 100% cap runs about a quarter of each period.
 *
 * What it never does:
 *   - stop the session's Claude Code process itself (its CPU counts; holding it would stall the turn's I/O) or a
 *     zombie;
 *   - continue a process it did not stop: a process a person paused, or one already stopped by someone else, is
 *     left alone, and a process a person pauses while it is held becomes theirs (`forget`);
 *   - signal a pid without reading its start time right before: a stop is sent only to the process the period read
 *     (read again just before the stop), a continue only to the process it stopped — a reused pid is dropped, never
 *     signalled;
 *   - leave anything held: an abort of the session, a cap change and shutdown continue everything it holds. A hold
 *     whose identity cannot be read at that moment is kept and tried again every period (and by shutdown).
 */

/** One period of the duty cycle. */
export const THROTTLE_PERIOD_MS = 250;
/** The smallest share of a period a capped tree runs (so a runaway tree still makes progress, and stops are short). */
const MIN_SHARE = 0.05;
/** A tree that ran free (share 1) this many periods in a row is let go until a sample finds it over its cap again. */
const IDLE_PERIODS = 8;
/** A stop the cap made this recently still explains a `T` in a monitor sample (the sample may predate the continue). */
const RECENT_HOLD_MS = 4 * THROTTLE_PERIOD_MS;
/** How many passes shutdown makes over holds it could not continue yet. */
const SHUTDOWN_PASSES = 3;

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
  /** The whole parent map (pid → ppid), to find what a capped tree started since the last sample. */
  readonly readParents?: () => Promise<Map<number, number>>;
  /**
   * A pid's live start time, synchronously (the monitor's `psLiveStartToken`): a string, `null` when the pid is gone,
   * `undefined` when it could not be read. Used where no period read is at hand — release and shutdown.
   */
  readonly liveStartToken: (pid: number) => string | null | undefined;
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
}

/** What this throttler stopped and has not continued. */
interface Hold {
  readonly sessionKey: string;
  readonly startToken: string;
}

export class CpuThrottler {
  private readonly sessions = new Map<string, Capped>();
  /** pid → the hold: every stop this throttler made and has not continued (or seen gone). */
  private readonly held = new Map<number, Hold>();
  /** `pid:start` → when the cap last stopped it (for reading a monitor sample taken while it was held). */
  private readonly recent = new Map<string, number>();
  private timer: unknown = null;
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
        // Keep what a period discovered since that the sample has not seen yet (it is in the next sample).
        const sampled = new Set(members.map((m) => m.pid));
        cur.members = [...members, ...cur.members.filter((m) => !sampled.has(m.pid) && !m.root)];
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
      });
    }
    for (const key of [...this.sessions.keys()]) if (!seen.has(key)) this.release(key);
    this.schedule(0);
  }

  /**
   * Whether the cap holds this process now, or held it a moment ago — a `T` in a monitor sample for it is the cap's,
   * not a pause.
   */
  holds(sessionKey: string, pid: number, startToken: string): boolean {
    const h = this.held.get(pid);
    if (h && h.sessionKey === sessionKey && h.startToken === startToken) return true;
    const at = this.recent.get(`${pid}:${startToken}`);
    return at !== undefined && this.deps.now() - at <= RECENT_HOLD_MS;
  }

  /** The cap being enforced on a session now (`null`: not metered). */
  meteredCap(sessionKey: string): number | null {
    return this.sessions.get(sessionKey)?.cap ?? null;
  }

  /** A person paused a process: it is theirs now — the throttler neither continues nor stops it again. */
  forget(sessionKey: string, pid: number): void {
    if (this.held.get(pid)?.sessionKey === sessionKey) this.held.delete(pid);
  }

  /** Continue everything held for a session and stop metering it (an abort, a cap change, the tree gone). */
  release(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.continueHolds((h) => h.sessionKey === sessionKey);
    if (this.held.size > 0) this.schedule(THROTTLE_PERIOD_MS);
    else if (this.sessions.size === 0) this.cancelTimer();
  }

  /** Shutdown: continue everything held, in every session; nothing is metered after this. Synchronous. */
  releaseAll(): void {
    this.disposed = true;
    this.cancelTimer();
    this.sessions.clear();
    for (let i = 0; i < SHUTDOWN_PASSES && this.held.size > 0; i++) this.continueHolds(() => true);
    if (this.held.size > 0) {
      this.deps.logger?.warn('cpu cap: could not continue held processes; continue them by hand (kill -CONT)', {
        pids: [...this.held.keys()],
      });
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.disposed || this.timer !== null || (this.sessions.size === 0 && this.held.size === 0)) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  /**
   * Continue the holds `which` picks, each only after its identity is read: from this period's read when there is
   * one, else live. Gone or another process now: dropped, never signalled. Unknown, or a continue the OS refused:
   * kept, and tried again next period.
   */
  private continueHolds(which: (h: Hold) => boolean, read?: Map<number, ThrottleRead>): void {
    for (const [pid, h] of [...this.held]) {
      if (!which(h)) continue;
      if (this.deps.userPaused(h.sessionKey, pid, h.startToken)) {
        this.held.delete(pid);
        continue;
      }
      const live = read ? (read.get(pid)?.startToken ?? null) : this.deps.liveStartToken(pid);
      if (live === undefined) continue;
      if (live !== h.startToken) {
        this.held.delete(pid);
        continue;
      }
      try {
        this.deps.kill(pid, 'SIGCONT');
        this.held.delete(pid);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') this.held.delete(pid);
      }
    }
  }

  /** The members' children that started since the sample (any depth), read from this period's parent map. */
  private discover(s: Capped, parents: Map<number, number>): number[] {
    const childrenOf = new Map<number, number[]>();
    for (const [pid, ppid] of parents) {
      if (pid === ppid) continue;
      const list = childrenOf.get(ppid);
      if (list) list.push(pid);
      else childrenOf.set(ppid, [pid]);
    }
    const known = new Set(s.members.map((m) => m.pid));
    const found: number[] = [];
    const queue = [...known];
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      for (const child of childrenOf.get(pid) ?? []) {
        if (known.has(child)) continue;
        known.add(child);
        found.push(child);
        queue.push(child);
      }
    }
    return found;
  }

  /** One period: read, continue what is held, then hold again after the run share. */
  async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      await this.period();
    } finally {
      this.ticking = false;
      // Every period arms the next one while anything is metered or held — a failed read skips one period, never
      // the loop.
      this.schedule(THROTTLE_PERIOD_MS);
    }
  }

  private async period(): Promise<void> {
    if (this.sessions.size === 0 && this.held.size === 0) return;
    // New descendants since the sample: their start time comes from this period's read.
    const fresh = new Map<string, number[]>();
    if (this.deps.readParents && this.sessions.size > 0) {
      const parents = await this.deps.readParents().catch(() => null);
      if (parents) for (const [key, s] of this.sessions) fresh.set(key, this.discover(s, parents));
    }
    const pids = new Set<number>(this.held.keys());
    for (const [key, s] of this.sessions) {
      for (const m of s.members) pids.add(m.pid);
      for (const pid of fresh.get(key) ?? []) pids.add(pid);
    }
    let read: Map<number, ThrottleRead>;
    try {
      read = await this.deps.read([...pids]);
    } catch (err) {
      // Unknown this period: hold nothing more, and continue what is held only where its identity can be read live.
      this.deps.logger?.warn('cpu throttle read failed', { error: String(err) });
      this.continueHolds(() => true);
      return;
    }
    if (this.disposed) return;
    for (const [key, s] of this.sessions) {
      for (const pid of fresh.get(key) ?? []) {
        const r = read.get(pid);
        if (r) s.members.push({ pid, startToken: r.startToken, root: false });
      }
    }
    // Held processes of sessions no longer metered (released while unknown): continue them now that they read.
    this.continueHolds((h) => !this.sessions.has(h.sessionKey), read);
    const at = this.deps.now();
    for (const [key, s] of [...this.sessions]) {
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
      // Members that are gone, or whose pid now names another process, leave the tree.
      s.members = s.members.filter((m) => read.get(m.pid)?.startToken === m.startToken);
      const elapsed = s.prevAt > 0 ? (at - s.prevAt) / 1000 : 0;
      s.prev = next;
      s.prevAt = at;
      if (elapsed > 0) {
        const rate = (used / elapsed) * 100;
        s.share = rate > 0 ? Math.max(MIN_SHARE, Math.min(1, (s.share * s.cap) / rate)) : 1;
      }
      // The run part of this period: what the cap held (it read stopped just now, which is the cap's stop) continues.
      const heldHere = new Set([...this.held].filter(([, h]) => h.sessionKey === key).map(([pid]) => pid));
      this.continueHolds((h) => h.sessionKey === key, read);
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
        if (r.stat.startsWith('T') && !heldHere.has(m.pid)) return false;
        return !this.deps.userPaused(key, m.pid, m.startToken);
      });
      if (stop.length > 0) {
        this.setTimer(() => void this.hold(key, s, stop), Math.round(s.share * THROTTLE_PERIOD_MS));
      }
    }
  }

  /**
   * The hold part of a period: read the candidates again and stop only those that are still the process the period
   * read, running, and not a person's pause.
   */
  private async hold(key: string, s: Capped, stop: readonly Member[]): Promise<void> {
    // Released or replaced since this period was planned: nothing to hold.
    if (this.disposed || this.sessions.get(key) !== s) return;
    const read = await this.deps.read(stop.map((m) => m.pid)).catch(() => null);
    if (!read || this.disposed || this.sessions.get(key) !== s) return;
    const at = this.deps.now();
    for (const m of stop) {
      const r = read.get(m.pid);
      if (!r || r.startToken !== m.startToken || r.stat.startsWith('T')) continue;
      if (this.deps.userPaused(key, m.pid, m.startToken)) continue;
      try {
        this.deps.kill(m.pid, 'SIGSTOP');
        this.held.set(m.pid, { sessionKey: key, startToken: m.startToken });
        this.recent.set(`${m.pid}:${m.startToken}`, at);
      } catch {
        // Gone or refused: not held.
      }
    }
    for (const [k, t] of this.recent) if (at - t > RECENT_HOLD_MS) this.recent.delete(k);
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

/** The production parent map: `ps -A -o pid=,ppid=`. */
export function createParentReader(runPs: RunPs): () => Promise<Map<number, number>> {
  return async () => parseParentMap(await runPs(['-A', '-o', 'pid=,ppid=']));
}
