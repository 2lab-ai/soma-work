import { parseCpuTime, parseParentMap } from './ps-table';
import type { ReadCpuSeconds, RunPs } from './tree-sampler';
import type { SessionProcessDetail } from './types';

/**
 * A task's CPU cap: the sum of its tree's CPU held at or under a percentage of one core (100% = one core), on macOS
 * and Linux alike, with no root and no wrapper around the spawn.
 *
 * Neither OS gives an unprivileged quota a daemon can put on a running process tree: Linux has one (cgroup v2
 * `cpu.max`) only when systemd delegates the cpu controller to the user's slice, and macOS has none. So the cap is a
 * duty cycle, as `cpulimit` does it. Every period (250 ms; longer when `ps` is slow, see `periodMs`) the throttler
 * reads the tree — its members from the last monitor sample plus whatever they started since (the parent map is read
 * each period, and again at each stop) — and its cumulative CPU time, works out the share of the period the tree may
 * run so that its rate meets the cap, lets it run that long (SIGCONT) and holds it the rest (SIGSTOP). The share
 * adapts each period (share × cap / measured rate), so a tree under the cap runs free and a tree at 400% under a 100%
 * cap runs about a quarter of each period.
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

/** One period of the duty cycle: the shortest, on a host where `ps` answers fast. */
export const THROTTLE_PERIOD_MS = 250;
/**
 * The longest period. A period must hold its reads in the right parts: the run part the identity read before the
 * stop (the tree runs through it — a 150 ms read in a 250 ms period lets a tree run 60% of it whatever its cap), the
 * stopped part the period's own reads (the parent scan included). A 32-core tree under 50% (a 1.6% share) with
 * 150 ms reads needs a 14 s period; past this one the cap cannot be met and says so.
 */
const MAX_PERIOD_MS = 30_000;
/** A period is at least this many identity reads long; its run part holds `READ_MARGIN` of them. */
const READS_PER_PERIOD = 6;
const READ_MARGIN = 1.5;
/**
 * The smallest share of a period a capped tree runs (so a runaway tree still makes progress): a tree up to 500 times
 * its cap is held to it — 128 cores under the smallest cap a person can be given (25%); a wider one runs at 0.2% of
 * its own rate. A small share asks for a long period (its run part holds the stop's identity read).
 */
const MIN_SHARE = 0.002;
/**
 * A tree that stayed under half its cap this many periods in a row is let go until a sample finds it over its cap
 * again (well under, not merely at it: a tree held to its cap reads at its cap).
 */
const IDLE_PERIODS = 8;
/**
 * A window this long with no CPU increase reads as idle. Shorter ones keep their baseline: a counter that moves in
 * whole ticks (Linux /proc: 10 ms) reads a short run as none, and resetting the share on it lets a wide tree run free.
 */
const QUIET_WINDOW_S = 2;
/** The most hold intervals kept per process (a sample in flight may have read an earlier one). */
const MAX_INTERVALS = 32;
/** How long a hold's interval is kept for reading a monitor sample taken during it. */
const INTERVAL_KEEP_MS = 30_000;
/** Shutdown's passes over holds it could not continue yet, within this budget. */
const SHUTDOWN_PASSES = 3;
const SHUTDOWN_BUDGET_MS = 5_000;

/** Remember a member that left (bounded: the oldest is forgotten first). */
function rememberLeft(s: { left: Map<string, number> }, id: string, cpu: number): void {
  s.left.delete(id);
  s.left.set(id, cpu);
  if (s.left.size > MAX_LEFT) {
    const oldest = s.left.keys().next().value;
    if (oldest !== undefined) s.left.delete(oldest);
  }
}

/** One process as the throttler reads it each period. */
export interface ThrottleRead {
  readonly cpuSeconds: number;
  readonly startToken: string;
  /** Its parent, read with its identity: a worker is adopted only under a parent in the tree. */
  readonly ppid: number;
  /** `ps stat` (`T` = stopped). */
  readonly stat: string;
}

/** Reads every pid's cumulative CPU time, start time and state now; a pid that is gone is absent. */
export type ReadThrottle = (pids: readonly number[]) => Promise<Map<number, ThrottleRead>>;

/**
 * Live start times of several pids at once, synchronously (one `ps`): pid → its start token, or `null` for a pid that
 * is gone. `undefined` when the read itself failed (unknown for all).
 */
export type LiveStartTokens = (pids: readonly number[]) => Map<number, string | null> | undefined;

export interface CpuThrottlerDeps {
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly read: ReadThrottle;
  /** The whole parent map (pid → ppid), to find what a capped tree started since the last sample. */
  readonly readParents?: () => Promise<Map<number, number>>;
  /** Used where no period read answers for a pid — release, shutdown, a row missing from a read. */
  readonly liveStartTokens: LiveStartTokens;
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
  /** Periods in a row the tree ran well under its cap. */
  calmPeriods: number;
  /**
   * CPU seconds owed to the next period's rate: what workers found at a stop had used since the period's parent scan
   * (they started after it). Their counters are baselined at that stop.
   */
  charge: number;
  /**
   * Members that left because a read did not answer for them (`pid:start` → their last counter). One found again is
   * charged only what it used since then, never its whole lifetime.
   */
  left: Map<string, number>;
  /** Said once while it lasts, per tree: its stop read, its stop scan, the read of the workers a stop found. */
  saidStopReadFailed?: boolean;
  saidStopScanFailed?: boolean;
  saidNewWorkerReadFailed?: boolean;
}

/** How many members that left are remembered per tree. */
const MAX_LEFT = 256;

/** What this throttler stopped and has not continued. */
interface Hold {
  readonly sessionKey: string;
  readonly startToken: string;
}

/** Add members, one per pid (a sample and a period can both bring the same process). */
function withMembers(into: Member[], more: readonly Member[]): Member[] {
  const byPid = new Map(into.map((m) => [m.pid, m]));
  for (const m of more) if (!byPid.has(m.pid)) byPid.set(m.pid, m);
  return [...byPid.values()];
}

export class CpuThrottler {
  private readonly sessions = new Map<string, Capped>();
  /** pid → the hold: every stop this throttler made and has not continued (or seen gone). */
  private readonly held = new Map<number, Hold>();
  /** `pid:start` → when the cap stopped it and continued it (`to` null while held): which `T` in a sample is the cap's. */
  private readonly intervals = new Map<string, Array<{ from: number; to: number | null }>>();
  /** Stops the OS refused, said once each. */
  private readonly refused = new Set<string>();
  /** Continues the OS refused, said once each (the hold is kept and tried again every period). */
  private readonly refusedContinue = new Set<string>();
  private timer: unknown = null;
  private ticking = false;
  /** Counts periods. */
  private periodSeq = 0;
  /**
   * The last period that continued what was held. A stop planned in an earlier period is not sent after it: it would
   * outlast that continue and hold the tree a whole period. (One that lands during the next period's reads is fine —
   * that period continues it.)
   */
  private continuedSeq = 0;
  /** How long one read takes, smoothed (ms); sets the period's length. */
  private readMs = 0;
  /** How long a period's reads take together — the parent scan, the tree, new workers — smoothed (ms). */
  private phaseMs = 0;
  /** Said once while it lasts: a period the cap needs is longer than `MAX_PERIOD_MS`; a parent scan failing. */
  private saidTooSlow = false;
  private saidNoParents = false;
  /**
   * The period whose own parent scan succeeded last. A worker a period finds started since the previous period's scan
   * only if that one succeeded (`scanOkSeq === seq - 1`); after a failed scan it may be old, so it is baselined, not
   * charged its lifetime. A stop of the period may charge the workers it finds when this period's scan succeeded. Only
   * period scans set it: a stop's extra scan failing says nothing about the bound the period's own scan gave.
   */
  private scanOkSeq = 0;
  /** A stop's parent scan in flight: stops of several trees close together share it instead of each scanning the host. */
  private stopScan: Promise<Map<number, number>> | null = null;
  /** When the next period starts, from the end of this one: its reads land the continue one period after this one's. */
  private nextDelay = THROTTLE_PERIOD_MS;
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
    let replanned = false;
    for (const s of sessions) {
      seen.add(s.sessionKey);
      const cap = capFor(s.sessionKey);
      const members: Member[] = withMembers(
        [],
        s.processes
          .filter((p) => p.state !== 'zombie')
          .map((p) => ({ pid: p.pid, startToken: p.startToken, root: p.role === 'root' })),
      );
      const cur = this.sessions.get(s.sessionKey);
      if (cap === null || !(cap > 0)) {
        if (cur) this.release(s.sessionKey);
        continue;
      }
      if (cur && cur.cap !== cap) {
        // A new cap replans at once: what the old one holds is continued (a long period could keep it stopped for
        // seconds). A tree held to its old cap reads at that cap in the sample, so the sample cannot say whether it is
        // over the new one: its free rate is about old cap ÷ share, and the new share follows from it. Over the new
        // cap it stays metered (a replaced plan's pending stop is dropped: it belongs to the old object); under it,
        // it is let go.
        replanned = true;
        this.continueHolds((h) => h.sessionKey === s.sessionKey);
        const share = cur.share * (cap / cur.cap);
        if (share >= 1 && s.cpuPercent <= cap) {
          this.sessions.delete(s.sessionKey);
          continue;
        }
        this.sessions.set(s.sessionKey, {
          ...cur,
          cap,
          members: withMembers(
            members,
            cur.members.filter((m) => !m.root),
          ),
          share: Math.max(MIN_SHARE, Math.min(1, share)),
          calmPeriods: 0,
        });
        continue;
      } else if (cur) {
        // Keep what a period discovered that the sample has not seen yet (it is in the next sample).
        cur.members = withMembers(
          members,
          cur.members.filter((m) => !m.root),
        );
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
        calmPeriods: 0,
        charge: 0,
        left: new Map(),
      });
    }
    for (const key of [...this.sessions.keys()]) if (!seen.has(key)) this.release(key);
    // A replanned tree does not wait out the period under way.
    if (replanned) this.cancelTimer();
    this.schedule(0);
  }

  /**
   * Whether a `T` that a monitor sample read for this process is the cap's: it is held now, or one of its holds
   * overlapped the sample's ps run (`window`). A stop made by anyone else after the cap continued it stays a stop.
   */
  holds(sessionKey: string, pid: number, startToken: string, window?: { from: number; to: number }): boolean {
    const h = this.held.get(pid);
    const mine = h !== undefined && h.sessionKey === sessionKey && h.startToken === startToken;
    if (!window) return mine;
    // For a sample: the hold must overlap the ps run that read the `T` — one that began after it read a stop of
    // someone else's.
    if (h && !mine) return false;
    // Any of its recent holds: a sample still in flight may have read an earlier one.
    const ivs = this.intervals.get(`${pid}:${startToken}`) ?? [];
    return ivs.some((iv) => iv.from <= window.to && (iv.to === null || iv.to >= window.from));
  }

  /** A hold began: its interval opens (the last `MAX_INTERVALS` of a process are kept). */
  private openInterval(id: string, at: number): void {
    const list = this.intervals.get(id) ?? [];
    list.push({ from: at, to: null });
    if (list.length > MAX_INTERVALS) list.splice(0, list.length - MAX_INTERVALS);
    this.intervals.set(id, list);
  }

  /** A hold ended (continued, or gone): its open interval closes. */
  private closeInterval(id: string, at: number): void {
    const open = this.intervals.get(id)?.find((iv) => iv.to === null);
    if (open) open.to = at;
  }

  /** The cap being enforced on a session now (`null`: not metered). */
  meteredCap(sessionKey: string): number | null {
    return this.sessions.get(sessionKey)?.cap ?? null;
  }

  /** The share of each period a metered session's tree runs now (`null`: not metered). */
  meteredShare(sessionKey: string): number | null {
    return this.sessions.get(sessionKey)?.share ?? null;
  }

  /** A person paused a process: it is theirs now — the throttler neither continues nor stops it again. */
  forget(sessionKey: string, pid: number): void {
    const h = this.held.get(pid);
    if (h?.sessionKey !== sessionKey) return;
    this.held.delete(pid);
    this.intervals.delete(`${pid}:${h.startToken}`);
  }

  /** Continue everything held for a session and stop metering it (an abort, a cap change, the tree gone). */
  release(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    this.continueHolds((h) => h.sessionKey === sessionKey);
    if (this.held.size > 0) this.schedule(THROTTLE_PERIOD_MS);
    else if (this.sessions.size === 0) this.cancelTimer();
  }

  /** Shutdown: continue everything held, in every session, within a budget; nothing is metered after this. */
  releaseAll(): void {
    this.disposed = true;
    this.cancelTimer();
    this.sessions.clear();
    const until = this.deps.now() + SHUTDOWN_BUDGET_MS;
    for (let i = 0; i < SHUTDOWN_PASSES && this.held.size > 0 && this.deps.now() < until; i++) {
      this.continueHolds(() => true);
    }
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
   * Continue the holds `which` picks, each only after its identity is read: from this period's read for a pid it
   * answers for, else the period's live probe (`probed`) or, without one, one live `ps` for all the rest. Gone or
   * another process now: dropped, never signalled. Unknown,
   * or a continue the OS refused: kept, and tried again next period.
   */
  private continueHolds(
    which: (h: Hold) => boolean,
    read?: Map<number, ThrottleRead>,
    probed?: Map<number, string | null>,
  ): void {
    const at = this.deps.now();
    /** A hold that ends without a continue (gone, reused, a person's pause): its interval closes now. */
    const drop = (pid: number, h: Hold): void => {
      this.held.delete(pid);
      this.closeInterval(`${pid}:${h.startToken}`, at);
    };
    const picked = [...this.held].filter(([pid, h]) => {
      if (!which(h)) return false;
      if (this.deps.userPaused(h.sessionKey, pid, h.startToken)) {
        drop(pid, h);
        return false;
      }
      return true;
    });
    if (picked.length === 0) return;
    // A live probe for the holds no read answered runs before any continue: it is synchronous, so while it runs no
    // stop timer can fire — a tree continued before it would run uncapped for as long. A period probes every tree's
    // missing holds at once, before its first continue, and hands the answers in (`probed`); other callers probe here.
    const unanswered = probed ? [] : picked.filter(([pid]) => !read?.has(pid)).map(([pid]) => pid);
    const live = probed ?? (unanswered.length > 0 ? this.deps.liveStartTokens(unanswered) : undefined);
    for (const [pid, h] of picked) {
      // Unknown (no read or probe answered for it): kept, tried again next period.
      const token = read?.has(pid) ? read.get(pid)?.startToken : live?.has(pid) ? live.get(pid) : undefined;
      if (token === undefined) continue;
      if (token !== h.startToken) {
        drop(pid, h);
        continue;
      }
      const id = `${pid}:${h.startToken}`;
      try {
        this.deps.kill(pid, 'SIGCONT');
        this.held.delete(pid);
        this.closeInterval(id, at);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') drop(pid, h);
        else if (!this.refusedContinue.has(id)) {
          this.refusedContinue.add(id);
          this.deps.logger?.warn('cpu cap: the OS refused to continue a held process; it is tried again every period', {
            sessionKey: h.sessionKey,
            pid,
            error: String(err),
          });
        }
      }
    }
  }

  /** Children (any depth) of the members this period verified, that are not members yet. */
  private discover(
    verified: readonly Member[],
    known: ReadonlySet<number>,
    childrenOf: ReadonlyMap<number, readonly number[]>,
  ): number[] {
    const seen = new Set(known);
    const found: number[] = [];
    const queue = verified.map((m) => m.pid);
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      for (const child of childrenOf.get(pid) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
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
    this.nextDelay = THROTTLE_PERIOD_MS;
    try {
      await this.period();
    } finally {
      this.ticking = false;
      // Every period arms the next one while anything is metered or held — a failed read skips one period, never
      // the loop.
      this.schedule(this.nextDelay);
    }
  }

  /**
   * The period's length now: `THROTTLE_PERIOD_MS`; longer while `ps` is slow, and while a share is so small that its
   * run part would not hold the read before the stop (at most `MAX_PERIOD_MS`).
   */
  periodMs(): number {
    return Math.min(MAX_PERIOD_MS, this.neededPeriodMs());
  }

  /**
   * The period the cap needs: its run part holds the identity read before the stop (for the smallest share), its
   * stopped part holds the period's reads (for the largest share under 1).
   */
  private neededPeriodMs(): number {
    let least = 1;
    let most = 0;
    for (const s of this.sessions.values()) {
      if (s.share >= 1) continue;
      least = Math.min(least, s.share);
      most = Math.max(most, s.share);
    }
    const forRun = least < 1 ? (READ_MARGIN * this.readMs) / least : 0;
    const forStop = most > 0 ? this.phaseMs / Math.max(0.1, 1 - most) : 0;
    return Math.max(
      THROTTLE_PERIOD_MS,
      Math.round(READS_PER_PERIOD * this.readMs),
      Math.round(forRun),
      Math.round(forStop),
    );
  }

  /** `deps.read`, timed: how long reads take sets the period's length. */
  private async timedRead(pids: readonly number[]): Promise<Map<number, ThrottleRead>> {
    const start = this.deps.now();
    const out = await this.deps.read(pids);
    const ms = Math.max(0, this.deps.now() - start);
    this.readMs = this.readMs === 0 ? ms : 0.7 * this.readMs + 0.3 * ms;
    return out;
  }

  private async period(): Promise<void> {
    if (this.sessions.size === 0 && this.held.size === 0) return;
    const seq = ++this.periodSeq;
    const started = this.deps.now();
    let parents: Map<number, number> | null = null;
    // What this scan finds started since the last one only if that one read the whole map.
    const prevScanOk = this.scanOkSeq === seq - 1;
    if (this.deps.readParents && this.sessions.size > 0) {
      try {
        parents = await this.deps.readParents();
        this.saidNoParents = false;
        this.scanOkSeq = seq;
      } catch (err) {
        // New workers go unseen until a scan reads again; what is known is still held.
        if (!this.saidNoParents) {
          this.saidNoParents = true;
          this.deps.logger?.warn(
            'cpu cap: the parent map could not be read; new workers are not metered until it can',
            {
              error: String(err),
            },
          );
        }
      }
    }
    const pids = new Set<number>(this.held.keys());
    for (const s of this.sessions.values()) for (const m of s.members) pids.add(m.pid);
    let read: Map<number, ThrottleRead>;
    try {
      read = await this.timedRead([...pids]);
    } catch (err) {
      // Unknown this period: hold nothing more; what is held is continued where one live ps can tell who it is.
      this.deps.logger?.warn('cpu throttle read failed', { error: String(err) });
      this.continuedSeq = seq;
      this.continueHolds(() => true);
      return;
    }
    if (this.disposed) return;
    // What a continue trusts (each hold's identity), kept apart from what the rate and the members are read from: a
    // re-read for the continues that fails must not take a valid sample away from the accounting.
    const verify = new Map(read);
    // New descendants, found only under members this read verified (a member pid reused by another program must not
    // lend its children), then read themselves.
    const discovered = new Map<string, number[]>();
    if (parents) {
      // The whole host's parent map, indexed once per period for every metered tree.
      const childrenOf = new Map<number, number[]>();
      for (const [pid, ppid] of parents) {
        if (pid === ppid) continue;
        const list = childrenOf.get(ppid);
        if (list) list.push(pid);
        else childrenOf.set(ppid, [pid]);
      }
      const all = new Set<number>(pids);
      for (const [key, s] of this.sessions) {
        const verified = s.members.filter((m) => read.get(m.pid)?.startToken === m.startToken);
        const found = this.discover(verified, all, childrenOf);
        for (const pid of found) all.add(pid);
        if (found.length > 0) discovered.set(key, found);
      }
      const extra = [...discovered.values()].flat();
      if (extra.length > 0) {
        // This read awaits: what is held is read again with it, so a held pid reused meanwhile is not continued. If
        // it fails, their identities are unknown here and the continue reads them live.
        // Their parents are read again with them too: a parent pid reused since the period read lends no children.
        const heldPids = [...this.held.keys()];
        const parentPids = extra.map((pid) => parents.get(pid)).filter((pid): pid is number => pid !== undefined);
        const more = await this.timedRead([...new Set([...extra, ...heldPids, ...parentPids])]).catch(() => null);
        // Every hold now — those that landed while this read was out too — is answered by this read or read live.
        for (const pid of this.held.keys()) if (!more?.has(pid)) verify.delete(pid);
        if (more) {
          for (const [pid, r] of more) {
            read.set(pid, r);
            verify.set(pid, r);
          }
        }
      }
      if (this.disposed) return;
    }
    // A hold the read did not answer would be probed live, synchronously, at its continue: the event loop stops for
    // that probe, and an identity read before it ages by as long. Read every hold again first — one async read, which
    // blocks nothing — and continue all of them on it; only a pid missing from this read too is probed live.
    if ([...this.held.keys()].some((pid) => !verify.has(pid))) {
      const again = await this.timedRead([...this.held.keys()]).catch(() => null);
      for (const pid of this.held.keys()) {
        const r = again?.get(pid);
        if (r) verify.set(pid, r);
        else verify.delete(pid);
      }
      if (this.disposed) return;
    }
    // A pid even that read could not answer is probed live — every tree's at once, before the first continue: the
    // probe is synchronous, and a tree continued before another tree's probe would run uncapped through it.
    const missing = [...this.held.keys()].filter((pid) => !verify.has(pid));
    const probed: Map<number, string | null> =
      missing.length > 0 ? (this.deps.liveStartTokens(missing) ?? new Map()) : new Map();
    // Held processes of sessions no longer metered (released while unknown): continue them now that they read.
    this.continueHolds((h) => !this.sessions.has(h.sessionKey), verify, probed);
    // From here to the end of the sessions loop nothing awaits: a planned stop lands before this or after all of it.
    this.continuedSeq = seq;
    const at = this.deps.now();
    // The next period's reads end, and its continue lands, one period after this continue.
    const phase = Math.max(0, at - started);
    this.phaseMs = this.phaseMs === 0 ? phase : 0.7 * this.phaseMs + 0.3 * phase;
    const needed = this.neededPeriodMs();
    if (needed > MAX_PERIOD_MS && !this.saidTooSlow) {
      this.saidTooSlow = true;
      this.deps.logger?.warn('cpu cap: reads are too slow for this share; it cannot hold the tree to its cap', {
        readMs: Math.round(this.readMs),
        phaseMs: Math.round(this.phaseMs),
        periodMs: needed,
      });
    } else if (needed <= MAX_PERIOD_MS) this.saidTooSlow = false;
    const period = Math.min(MAX_PERIOD_MS, needed);
    this.nextDelay = Math.max(0, period - phase);
    for (const [key, s] of [...this.sessions]) {
      const fresh = new Set<number>();
      const added: Member[] = [];
      // A worker is adopted only if the read of its identity names a parent in the tree (parents first, as found): a
      // pid that changed hands since the parent map is someone else's process.
      const owners = new Set(s.members.filter((m) => read.get(m.pid)?.startToken === m.startToken).map((m) => m.pid));
      for (const pid of discovered.get(key) ?? []) {
        const r = read.get(pid);
        if (!r || !owners.has(r.ppid)) continue;
        owners.add(pid);
        added.push({ pid, startToken: r.startToken, root: false });
        fresh.add(pid);
      }
      // The sample may have replaced the members while this period awaited: one entry per pid.
      s.members = withMembers(s.members, added);
      // The tree's rate since the last read: members whose start time still matches. A worker found this period
      // started since the last one (the previous parent map did not have it): all its CPU time is this window's.
      // After a failed scan a worker found now may be old: its counter is baselined, not charged in this window.
      let used = s.charge;
      s.charge = 0;
      const next = new Map<number, number>();
      for (const m of s.members) {
        const r = read.get(m.pid);
        if (!r || r.startToken !== m.startToken) continue;
        next.set(m.pid, r.cpuSeconds);
        const before = s.prev.get(m.pid);
        const id = `${m.pid}:${m.startToken}`;
        const lastSeen = fresh.has(m.pid) ? s.left.get(id) : undefined;
        if (before !== undefined) used += Math.max(0, r.cpuSeconds - before);
        else if (lastSeen !== undefined) used += Math.max(0, r.cpuSeconds - lastSeen);
        else if (fresh.has(m.pid) && s.prevAt > 0 && prevScanOk) used += r.cpuSeconds;
        if (lastSeen !== undefined) s.left.delete(id);
      }
      // Members that are gone, or whose pid now names another process, leave the tree. One a read merely missed is
      // remembered with its last counter, so finding it again charges only what it used meanwhile.
      s.members = s.members.filter((m) => {
        if (read.get(m.pid)?.startToken === m.startToken) return true;
        const last = s.prev.get(m.pid);
        if (last !== undefined && !read.has(m.pid)) rememberLeft(s, `${m.pid}:${m.startToken}`, last);
        return false;
      });
      const elapsed = s.prevAt > 0 ? (at - s.prevAt) / 1000 : 0;
      let rate = Number.NaN;
      if (s.prevAt === 0 || used > 0 || elapsed >= QUIET_WINDOW_S) {
        s.prev = next;
        s.prevAt = at;
        if (elapsed > 0 && used > 0) {
          rate = (used / elapsed) * 100;
          s.share = Math.max(MIN_SHARE, Math.min(1, (s.share * s.cap) / rate));
        } else if (elapsed > 0) {
          // Idle for a whole quiet window: let it run more, a step at a time.
          rate = 0;
          s.share = Math.min(1, s.share * 2);
        }
      } else {
        // No increase over a short window: a counter that moves in whole ticks (Linux /proc: 10 ms) cannot tell a
        // short run from none. Keep the baseline and the share until the counter moves or the window is long.
        for (const [pid, cpu] of next) if (!s.prev.has(pid)) s.prev.set(pid, cpu);
      }
      // The run part of this period: what the cap held (it read stopped just now, which is the cap's stop) continues.
      const heldHere = new Set([...this.held].filter(([, h]) => h.sessionKey === key).map(([pid]) => pid));
      this.continueHolds((h) => h.sessionKey === key, verify, probed);
      // Let go only a tree well under its cap for a while (one held to its cap reads at its cap).
      // A period with no measured rate (a counter that has not moved yet) leaves the streak as it is.
      if (!Number.isNaN(rate)) {
        if (rate < s.cap / 2) s.calmPeriods++;
        else s.calmPeriods = 0;
      }
      if (s.calmPeriods >= IDLE_PERIODS) {
        this.sessions.delete(key);
        continue;
      }
      if (s.share >= 1) continue;
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
        // The stop follows a read of who each one is: start that read early so the stop lands at the share's end.
        const runMs = Math.max(0, Math.round(s.share * period - this.readMs));
        this.setTimer(() => void this.hold(key, s, stop, seq), runMs);
      }
    }
    for (const [k, list] of this.intervals) {
      const kept = list.filter((iv) => iv.to === null || at - iv.to <= INTERVAL_KEEP_MS);
      if (kept.length === 0) this.intervals.delete(k);
      else if (kept.length !== list.length) this.intervals.set(k, kept);
    }
  }

  /**
   * The hold part of a period: read the candidates again and stop only those that are still the process the period
   * read, running, and not a person's pause.
   */
  private async hold(key: string, s: Capped, stop: readonly Member[], seq: number): Promise<void> {
    // Released or replaced since this period was planned, or a later period already continued: nothing to hold.
    if (this.disposed || this.sessions.get(key) !== s || this.continuedSeq !== seq) return;
    const read = await this.timedRead(stop.map((m) => m.pid)).catch((err) => {
      if (!s.saidStopReadFailed) {
        s.saidStopReadFailed = true;
        this.deps.logger?.warn(
          'cpu cap: the identity read before a stop failed; the tree runs uncapped until it reads again',
          { sessionKey: key, error: String(err) },
        );
      }
      return null;
    });
    if (read) s.saidStopReadFailed = false;
    if (!read || this.disposed || this.sessions.get(key) !== s || this.continuedSeq !== seq) return;
    this.stopEach(key, stop, read);
    await this.holdNewWorkers(key, s, seq);
  }

  /**
   * At the stop: workers the tree started since this period's parent scan (a shell that forks after each continue)
   * would otherwise run free until the next scan, and one that exits before it would never be seen. The map is read
   * again, what is new under a member this read verifies is held too, and the CPU it used so far is owed to the next
   * period's rate (when the period's own scan read the whole map — else it may be older, and is only baselined).
   */
  private async holdNewWorkers(key: string, s: Capped, seq: number): Promise<void> {
    if (!this.deps.readParents) return;
    // A newer period owns discovery and accounting once it has started: a stop of an older one that finishes late
    // must not baseline a worker that period is about to find (it would never be charged).
    const current = () => !this.disposed && this.sessions.get(key) === s && this.periodSeq === seq;
    // Stale already: no whole-host scan for it.
    if (!current()) return;
    let parents: Map<number, number>;
    try {
      // Stops of several trees close together share one scan of the host. One already out may predate this stop:
      // a worker forked between its start and this stop is missed here, and the next period's scan finds it.
      if (!this.stopScan) {
        const scan = this.deps.readParents();
        this.stopScan = scan;
        void scan.then(
          () => {
            if (this.stopScan === scan) this.stopScan = null;
          },
          () => {
            if (this.stopScan === scan) this.stopScan = null;
          },
        );
      }
      parents = await this.stopScan;
      s.saidStopScanFailed = false;
    } catch (err) {
      if (!s.saidStopScanFailed) {
        s.saidStopScanFailed = true;
        this.deps.logger?.warn(
          'cpu cap: the parent map could not be read at a stop; workers started since the period scan run free until it can',
          { sessionKey: key, error: String(err) },
        );
      }
      return;
    }
    if (!current()) return;
    const childrenOf = new Map<number, number[]>();
    for (const [pid, ppid] of parents) {
      if (pid === ppid) continue;
      const list = childrenOf.get(ppid);
      if (list) list.push(pid);
      else childrenOf.set(ppid, [pid]);
    }
    // Every metered tree's members are known (as in a period's discovery): a nested tree's process is never taken
    // for this one's worker.
    const known = new Set<number>(this.held.keys());
    for (const t of this.sessions.values()) for (const m of t.members) known.add(m.pid);
    const found = this.discover(s.members, known, childrenOf);
    if (found.length === 0) return;
    // The members are read with them: a worker is adopted only under a parent whose identity this read confirms (every
    // found pid's parent is a member or another found pid).
    const read = await this.timedRead([...new Set([...found, ...s.members.map((m) => m.pid)])]).catch((err) => {
      if (!s.saidNewWorkerReadFailed) {
        s.saidNewWorkerReadFailed = true;
        this.deps.logger?.warn(
          'cpu cap: the read of workers found at a stop failed; they run free until a read finds them',
          {
            sessionKey: key,
            error: String(err),
          },
        );
      }
      return null;
    });
    if (read) s.saidNewWorkerReadFailed = false;
    if (!read || !current()) return;
    const owners = new Set(s.members.filter((m) => read.get(m.pid)?.startToken === m.startToken).map((m) => m.pid));
    const added: Member[] = [];
    for (const pid of found) {
      const r = read.get(pid);
      if (!r || !owners.has(r.ppid)) continue;
      owners.add(pid);
      added.push({ pid, startToken: r.startToken, root: false });
      // A member a read missed, found again: only what it used since its last counter. A new worker: all of it, when
      // the period's own scan bounds its start.
      const id = `${pid}:${r.startToken}`;
      const lastSeen = s.left.get(id);
      if (lastSeen !== undefined) {
        s.charge += Math.max(0, r.cpuSeconds - lastSeen);
        s.left.delete(id);
      } else if (this.scanOkSeq === seq) s.charge += r.cpuSeconds;
      s.prev.set(pid, r.cpuSeconds);
    }
    if (added.length === 0) return;
    s.members = withMembers(s.members, added);
    this.stopEach(key, added, read);
  }

  /** Stop each candidate that is still the process `read` names, running, and not a person's pause. */
  private stopEach(key: string, stop: readonly Member[], read: Map<number, ThrottleRead>): void {
    const at = this.deps.now();
    for (const m of stop) {
      const r = read.get(m.pid);
      if (!r || r.startToken !== m.startToken || r.stat.startsWith('T')) continue;
      if (this.deps.userPaused(key, m.pid, m.startToken)) continue;
      const id = `${m.pid}:${m.startToken}`;
      try {
        this.deps.kill(m.pid, 'SIGSTOP');
        this.held.set(m.pid, { sessionKey: key, startToken: m.startToken });
        this.openInterval(id, at);
      } catch (err) {
        // Gone: nothing to hold. Refused: the cap cannot hold this one — said once, so a cap that does not bite is
        // not silent.
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH' && !this.refused.has(id)) {
          this.refused.add(id);
          this.deps.logger?.warn('cpu cap: the OS refused to stop a process; it runs uncapped', {
            sessionKey: key,
            pid: m.pid,
            error: String(err),
          });
        }
      }
    }
  }
}

/** `ps -o pid=,ppid=,stat=,lstart=,time=` rows → pid → its read. Malformed lines are skipped. */
export function parseThrottleRows(out: string): Map<number, ThrottleRead> {
  const rows = new Map<number, ThrottleRead>();
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 9) continue;
    const pid = /^\d+$/.test(t[0]) ? Number(t[0]) : Number.NaN;
    const ppid = /^\d+$/.test(t[1]) ? Number(t[1]) : Number.NaN;
    const cpu = parseCpuTime(t[8]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || cpu === null) continue;
    rows.set(pid, { ppid, stat: t[2], startToken: t.slice(3, 8).join(' '), cpuSeconds: cpu });
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
    // The fine CPU counters first, the identity last: what a signal trusts is the latest read before it. (A pid gone
    // from the `-p` list makes ps exit 1; `runPs` still answers the others' rows.)
    const fine = readCpuSeconds
      ? await readCpuSeconds(pids).catch(() => new Map<number, number>())
      : new Map<number, number>();
    const rows = parseThrottleRows(await runPs(['-o', 'pid=,ppid=,stat=,lstart=,time=', '-p', pids.join(',')]));
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
