import { execFileSync } from 'node:child_process';
import type { TrackedClaudeRootInfo } from '../agent-runtime/claude-child-process-registry';
import { CpuThrottler, createParentReader, createThrottleReader, type ReadThrottle } from './cpu-throttler';
import type { ReadCwds } from './cwd-reader';
import { createNodeCapacityReader, type RunCommand } from './node-capacity';
import type { InspectProcess } from './process-inspector';
import { type ReadCpuSeconds, type RunPs, TreeSampler } from './tree-sampler';
import type {
  NodeCapacity,
  NodeId,
  NodeProcessSnapshot,
  ProcessControlAction,
  ProcessControlResult,
  ProcessInspectResult,
  ProcessRelative,
  ProcessSample,
  ProcessState,
  SessionProcessDetail,
} from './types';

/**
 * The part of the child registry the monitor reads: which Claude Code processes
 * are alive and which session each runs for, and when a turn is aborted.
 */
export interface ClaudeRootSource {
  roots(): TrackedClaudeRootInfo[];
  onAbort(listener: (root: TrackedClaudeRootInfo) => void): () => void;
  /** Synchronous, as the host starts killing its children (drain, crash). */
  onShutdown?(listener: () => void): () => void;
}

/**
 * One node's processes, as the dashboard and a future scheduler use them.
 *
 * Today the only host is the local node. A worker node will implement the same
 * interface over its own transport (it samples itself and reports a
 * {@link NodeProcessSnapshot}); callers look a session's host up by the node it
 * runs on and never touch `ps` or signals themselves.
 */
export interface ProcessHost {
  readonly nodeId: NodeId;
  latest(): NodeProcessSnapshot | null;
  /** A sample no older than `maxAgeMs` (takes one when the latest is older). */
  fresh(maxAgeMs?: number): Promise<NodeProcessSnapshot>;
  control(input: ProcessControlInput): Promise<ProcessControlResult>;
  /** One process of a session's tree in depth (the detail view) — a snapshot, read once. */
  inspect(input: ProcessInspectInput): Promise<ProcessInspectResult>;
}

export interface ProcessInspectInput {
  readonly sessionKey: string;
  readonly pid: number;
  /** The start time the caller saw for this pid: a pid the OS has since reused is refused (`stale`). */
  readonly startToken: string;
}

export interface ProcessControlInput {
  readonly sessionKey: string;
  readonly pid: number;
  /** The start time the caller saw for this pid (from a {@link ProcessSample}). */
  readonly startToken: string;
  readonly action: ProcessControlAction;
}

export interface ProcessMonitorDeps {
  readonly nodeId: NodeId;
  readonly roots: ClaudeRootSource;
  readonly runPs: RunPs;
  readonly runCommand?: RunCommand;
  /** Finer CPU time than ps `time` where the platform has it (Linux `/proc`). */
  readonly readCpuSeconds?: ReadCpuSeconds;
  /** Each process's working directory (Linux `/proc/<pid>/cwd`, macOS `lsof`); none: the column stays empty. */
  readonly readCwds?: ReadCwds;
  /** Reads one process in depth for the detail view; none: `inspect` answers `unsupported`. */
  readonly inspectProcess?: InspectProcess;
  /** The CPU throttler's per-period read (default: one `ps`, Linux `/proc` ticks over it). */
  readonly readThrottle?: ReadThrottle;
  /** The throttler's timers (tests). */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Signal delivery; `process.kill` in production. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly platform?: string;
  readonly now?: () => number;
  readonly readCapacity?: () => Promise<NodeCapacity>;
  /**
   * The live start time of a pid, in the start-token form (`ps lstart`): a string; `null` when the pid is confirmed
   * gone; `undefined` when it could not be read (ps failed or timed out). Asked right before every signal so a pid the
   * OS reused since the last sample is never signalled. Synchronous: it runs on exit paths.
   */
  readonly liveStartToken?: (pid: number) => string | null | undefined;
  /** Several live start times in one read (the CPU cap's release and shutdown); default: one `ps`. */
  readonly liveStartTokens?: (pids: readonly number[]) => Map<number, string | null> | undefined;
  readonly logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

const DEFAULT_INTERVAL_MS = 5_000;

/** Runs ps synchronously; throws like `execFileSync` (with `status`, `stdout`, `stderr`) when it fails. */
export type RunPsSync = (args: string[]) => string;

const runPsSync: RunPsSync = (args) =>
  execFileSync('ps', args, {
    env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
    timeout: 2_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

/**
 * `ps -o lstart= -p <pid>` with the C locale, whitespace collapsed like the sampler's start token. ps exits 1, silent,
 * when the pid does not exist: `null` (gone). Anything else that fails — exit 1 with a diagnostic on stderr (ps could
 * not read the process table), a timeout, no ps — is `undefined`: unknown, so a caller keeps what it tracks and tries
 * again rather than treating the process as gone.
 */
export function psLiveStartToken(pid: number, run: RunPsSync = runPsSync): string | null | undefined {
  try {
    const token = run(['-o', 'lstart=', '-p', String(pid)])
      .trim()
      .split(/\s+/)
      .join(' ');
    return token || null;
  } catch (err) {
    const e = err as { status?: unknown; stdout?: unknown; stderr?: unknown };
    const silent = String(e.stdout ?? '').trim() === '' && String(e.stderr ?? '').trim() === '';
    return e.status === 1 && silent ? null : undefined;
  }
}

/**
 * Live start times of several pids in one `ps -o pid=,lstart= -p …` (the CPU cap's identity check on release and
 * shutdown): pid → its token, `null` for a pid that is gone. `undefined` when ps itself failed (unknown for all).
 */
export function psLiveStartTokens(
  pids: readonly number[],
  run: RunPsSync = runPsSync,
): Map<number, string | null> | undefined {
  const out = new Map<number, string | null>(pids.map((pid) => [pid, null]));
  if (pids.length === 0) return out;
  let text: string;
  try {
    text = run(['-o', 'pid=,lstart=', '-p', pids.join(',')]);
  } catch (err) {
    const e = err as { status?: unknown; stdout?: unknown; stderr?: unknown };
    // ps exits 1, silently, when one of the pids is gone; the others still print.
    if (e.status !== 1 || String(e.stderr ?? '').trim() !== '') return undefined;
    text = String(e.stdout ?? '');
  }
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 6 || !/^\d+$/.test(t[0])) continue;
    const pid = Number(t[0]);
    if (out.has(pid)) out.set(pid, t.slice(1, 6).join(' '));
  }
  return out;
}

/** One process this monitor paused: its start time and the turn whose tree held it. */
interface PausedEntry {
  readonly startToken: string;
  /** The turn (the registry's `turnId` of its Claude Code process); an abort of that turn continues it. Absent: no turn known. */
  readonly turn?: number;
  /** Its turn was aborted but the resume could not be done yet: every sample tries again. */
  resumeWanted?: boolean;
}

type Listener = (snapshot: NodeProcessSnapshot) => void;

/** Samples the local node on a timer and pauses or resumes processes in a session's tree. */
export class LocalProcessMonitor implements ProcessHost {
  readonly nodeId: NodeId;
  private readonly sampler: TreeSampler;
  private readonly readCapacity: () => Promise<NodeCapacity>;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly platform: string;
  private readonly now: () => number;
  private snapshot: NodeProcessSnapshot | null = null;
  private inFlight: Promise<NodeProcessSnapshot> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribeAbort: () => void;
  private readonly unsubscribeShutdown: (() => void) | null;
  private readonly liveStartToken: (pid: number) => string | null | undefined;
  /** Several live start times in one read: abort cleanup and its retries read every identity they need at once. */
  private readonly liveStartTokens: (pids: readonly number[]) => Map<number, string | null> | undefined;
  /**
   * Pause checks in progress: each collects the turns (`turnId`s) of its session aborted while it samples. A pause
   * whose check spans its own turn's abort is refused — that abort's cleanup already ran.
   */
  private readonly pendingPauses = new Set<{ readonly sessionKey: string; readonly abortedTurns: number[] }>();
  /** `pid:start` → the turn (`turnId`) whose tree held it when last seen with one — kept after it is orphaned. */
  private readonly turnOf = new Map<string, number>();
  /** How many times a shutdown pass retries what it could not continue (an unreadable identity, a refused signal). */
  private static readonly SHUTDOWN_TRIES = 3;
  /** The most a shutdown pass spends on identity probes (each can take up to 2 s on a loaded host). */
  private static readonly SHUTDOWN_BUDGET_MS = 5_000;
  /**
   * Turns (`turnId`s) whose abort already ran, with their session: a pause in one is refused, as nothing would continue
   * it. Kept while a live Claude Code process or a remembered process still carries the turn.
   */
  private readonly abortedTurnIds = new Map<number, string>();
  /** Set when the host starts shutting down: no pause is accepted after the final resume pass. */
  private shuttingDown = false;
  private readonly listeners = new Set<Listener>();
  /** session → pid → what was paused, for every process this monitor paused and has not resumed. */
  private readonly paused = new Map<string, Map<number, PausedEntry>>();
  /** The detail read in progress (inspect runs one at a time) and how many wait behind it. */
  private inspecting: Promise<void> = Promise.resolve();
  private inspectWaiting = 0;
  /** At most this many detail reads wait in line. */
  private static readonly INSPECT_QUEUE = 4;
  /** A read that waited longer than this is not started (the page gives up on it after 15 s). */
  private static readonly INSPECT_WAIT_MS = 10_000;
  /** Holds a task's tree to its owner's CPU cap (`cpu-throttler.ts`). */
  private readonly throttler: CpuThrottler;
  /** Each session's CPU cap (percent of one core; `null` = none). Unset: no task is capped. */
  private cpuCapFor: ((sessionKey: string) => number | null) | null = null;

  constructor(private readonly deps: ProcessMonitorDeps) {
    this.nodeId = deps.nodeId;
    this.now = deps.now ?? Date.now;
    this.sampler = new TreeSampler(deps.runPs, this.now, deps.readCpuSeconds, deps.readCwds, deps.logger);
    this.platform = deps.platform ?? process.platform;
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.readCapacity =
      deps.readCapacity ??
      createNodeCapacityReader({ nodeId: deps.nodeId, platform: this.platform, run: deps.runCommand });
    this.liveStartToken = deps.liveStartToken ?? psLiveStartToken;
    const single = deps.liveStartToken;
    this.liveStartTokens =
      deps.liveStartTokens ??
      // A host that brings only the one-pid read (tests) gets it pid by pid; production reads them in one ps.
      (single ? (pids) => liveStartTokensOneByOne(pids, single) : (pids) => psLiveStartTokens(pids));
    this.throttler = new CpuThrottler({
      kill: this.kill,
      read: deps.readThrottle ?? createThrottleReader(deps.runPs, deps.readCpuSeconds),
      readParents: createParentReader(deps.runPs),
      liveStartTokens: this.liveStartTokens,
      now: this.now,
      userPaused: (sessionKey, pid, startToken) => this.paused.get(sessionKey)?.get(pid)?.startToken === startToken,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      logger: deps.logger,
    });
    // Cleanup is live from the start, not from start(): control() works on an unstarted monitor too, and a pause it
    // makes must still be undone by an abort or a shutdown.
    this.unsubscribeAbort = deps.roots.onAbort((root) => this.resumeAfterAbort(root));
    this.unsubscribeShutdown = deps.roots.onShutdown?.(() => this.resumeAllPaused()) ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Idle: nothing tracked, nothing remembered, and the last sample already said so — no ps, no vm_stat.
      if (!this.sampler.hasWork(this.deps.roots.roots()) && this.snapshot && this.snapshot.sessions.length === 0)
        return;
      this.sample().catch((err) => this.deps.logger?.warn('process sample failed', { error: String(err) }));
    }, DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stops the sampling timer. Abort and shutdown cleanup stay live while the monitor exists (see dispose). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Where each session's CPU cap comes from (its owner's setting). `null`: no task is capped — everything held is
   * continued. Applied from the next sample.
   */
  setCpuCaps(capFor: ((sessionKey: string) => number | null) | null): void {
    this.cpuCapFor = capFor;
    if (!capFor) this.throttler.update([], () => null);
  }

  /**
   * Stop the timer and detach from the registry — the monitor is going away (tests). What it paused is continued first:
   * once the abort and shutdown hooks are gone, nothing else would.
   */
  dispose(): void {
    this.resumeAllPaused();
    this.stop();
    this.unsubscribeAbort();
    this.unsubscribeShutdown?.();
  }

  /**
   * Continue every process this monitor paused, in every session (the daemon is going away: a stopped process left
   * behind would hold its memory, ports and locks with nobody to resume it). Synchronous — it runs on exit paths.
   */
  resumeAllPaused(): void {
    this.shuttingDown = true;
    // What the CPU cap holds goes first: it is only ever held for a fraction of a period.
    this.throttler.releaseAll();
    const until = this.now() + LocalProcessMonitor.SHUTDOWN_BUDGET_MS;
    for (let i = 0; i < LocalProcessMonitor.SHUTDOWN_TRIES && this.paused.size > 0 && this.now() < until; i++) {
      for (const [sessionKey, mine] of this.paused) {
        for (const [pid, entry] of mine) {
          if (this.now() >= until) break;
          if (this.continueIfSame(pid, entry.startToken)) mine.delete(pid);
        }
        if (mine.size === 0) this.paused.delete(sessionKey);
      }
    }
    if (this.paused.size > 0) {
      const left = [...this.paused.values()].flatMap((m) => [...m.keys()]);
      this.deps.logger?.warn('shutdown could not continue paused processes; resume them by hand (kill -CONT)', {
        pids: left,
      });
    }
  }

  /**
   * SIGCONT only when the pid still names the process that was paused (its live start time), never a reused pid.
   * True when the entry is settled (continued, confirmed gone, or no longer that process); false when its identity
   * could not be read or the OS refused the signal, so the entry is kept for the next attempt.
   */
  private continueIfSame(pid: number, startToken: string): boolean {
    const live = this.liveStartToken(pid);
    if (live === undefined) return false;
    if (live !== startToken) return true;
    try {
      this.kill(pid, 'SIGCONT');
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ESRCH';
    }
  }

  /** Called after every sample; returns the unsubscribe function. */
  onSample(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  latest(): NodeProcessSnapshot | null {
    return this.snapshot;
  }

  async fresh(maxAgeMs = 1_000): Promise<NodeProcessSnapshot> {
    if (this.snapshot && this.now() - this.snapshot.sampledAt <= maxAgeMs) return this.snapshot;
    return this.sample();
  }

  /** Take one sample now (joins a sample already running). */
  sample(): Promise<NodeProcessSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const roots = this.deps.roots.roots();
        // Both reads settle before the lock is released: a rejected capacity read must not let a second sampler run
        // against the tree sampler's memory while the first is still in it.
        // The span the tree's ps ran in: a `T` it read is the CPU cap's only if a cap hold overlapped it.
        const window = { from: this.now(), to: 0 };
        const [treeRead, nodeRead] = await Promise.allSettled([
          // The window ends when the tree read does, not when a slower capacity read settles.
          this.sampler.sample(roots, this.nodeId).then((tree) => {
            window.to = this.now();
            return tree;
          }),
          this.readCapacity(),
        ]);
        if (treeRead.status === 'rejected') throw treeRead.reason;
        const tree = treeRead.value;
        // The cap is enforced from the tree read alone: a failing capacity read (telemetry) must not stop it.
        const sessions = this.applyCpuCaps(tree.sessions, window, new Map(roots.map((r) => [r.pid, r.turnId])));
        if (nodeRead.status === 'rejected') throw nodeRead.reason;
        const node = nodeRead.value;
        const snapshot: NodeProcessSnapshot = {
          node,
          sampledAt: this.now(),
          sessions,
          unattributed: tree.unattributed,
        };
        this.snapshot = snapshot;
        this.noteTurns(snapshot, new Map(roots.map((r) => [r.pid, r.turnId])));
        this.forgetExitedPauses(snapshot);
        this.retryWantedResumes();
        for (const listener of [...this.listeners]) {
          try {
            listener(snapshot);
          } catch (err) {
            this.deps.logger?.warn('process sample listener failed', { error: String(err) });
          }
        }
        return snapshot;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Pause (SIGSTOP) or resume (SIGCONT) one process in a session's tree. The
   * pid must be in the session's tree in a sample taken now, and must have
   * started when the caller says it did — a pid the OS reused is refused.
   */
  async control(input: ProcessControlInput): Promise<ProcessControlResult> {
    if (this.platform === 'win32') return { ok: false, reason: 'unsupported' };
    if (input.action === 'pause' && this.shuttingDown) return { ok: false, reason: 'not-found' };
    const check = { sessionKey: input.sessionKey, abortedTurns: [] as number[] };
    if (input.action === 'pause') this.pendingPauses.add(check);
    let before: NodeProcessSnapshot;
    try {
      before = await this.fresh(0);
    } finally {
      this.pendingPauses.delete(check);
    }
    // From here to the signal nothing awaits, so no abort or shutdown can land in between.
    const tree = before.sessions.find((s) => s.sessionKey === input.sessionKey);
    const proc = tree?.processes.find((p) => p.pid === input.pid);
    // The host started shutting down, or this process's own turn was aborted (any turn, for a process between
    // turns), while this check sampled: that cleanup already ran, so a pause now would never be undone. An abort of
    // another turn of the session does not block it.
    if (input.action === 'pause' && proc && tree) {
      const since = check.abortedTurns;
      const turn = this.turnOf.get(`${proc.pid}:${proc.startToken}`);
      const turnAborted = turn !== undefined && this.abortedTurnIds.has(turn);
      // A process whose chain breaks at a parent the sample carried without its row has no traceable turn: it may be
      // in a turn of this session whose abort already ran, so it is refused while the session has one.
      const untraced =
        turn === undefined &&
        brokenAtCarriedRow(tree, proc) &&
        [...this.abortedTurnIds.values()].includes(input.sessionKey);
      if (
        this.shuttingDown ||
        turnAborted ||
        untraced ||
        (since.length > 0 && (turn === undefined || since.includes(turn)))
      ) {
        return { ok: false, reason: 'not-found' };
      }
    }
    if (!proc) return { ok: false, reason: 'not-found' };
    if (proc.startToken !== input.startToken) return { ok: false, reason: 'stale' };
    // The sample is a moment old: read the pid's live start time right before the signal (a pid reused since then is
    // refused). Synchronous, so nothing runs between this check and the signal.
    const live = this.liveStartToken(input.pid);
    if (live === undefined) return { ok: false, reason: 'denied' };
    if (live !== input.startToken) return { ok: false, reason: 'stale' };

    try {
      this.kill(input.pid, input.action === 'pause' ? 'SIGSTOP' : 'SIGCONT');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return { ok: false, reason: code === 'ESRCH' ? 'not-found' : 'denied' };
    }

    const mine = this.paused.get(input.sessionKey) ?? new Map<number, PausedEntry>();
    // A person's pause of a process the CPU cap holds: it is theirs now, never continued by the cap.
    if (input.action === 'pause') this.throttler.forget(input.sessionKey, input.pid);
    if (input.action === 'pause') {
      mine.set(input.pid, { startToken: input.startToken, turn: this.turnOf.get(`${input.pid}:${input.startToken}`) });
    } else mine.delete(input.pid);
    if (mine.size > 0) this.paused.set(input.sessionKey, mine);
    else this.paused.delete(input.sessionKey);

    // The signal was delivered: that is the result. The state comes from a fresh sample when one can be taken.
    let state: ProcessState = input.action === 'pause' ? 'stopped' : 'sleeping';
    try {
      const after = await this.sample();
      const now = after.sessions
        .find((s) => s.sessionKey === input.sessionKey)
        ?.processes.find((p) => p.pid === input.pid && p.startToken === input.startToken);
      if (now) state = now.state;
    } catch (err) {
      this.deps.logger?.warn('process sample after control failed', { error: String(err) });
    }
    return { ok: true, pid: input.pid, state };
  }

  /**
   * One process of a session's tree in depth. The pid must be in the session's tree in a sample at most a second old
   * and have started when the caller says; the inspector checks the start time again before and after its reads, so
   * a pid the OS reused is never described as the process the reader clicked.
   */
  async inspect(input: ProcessInspectInput): Promise<ProcessInspectResult> {
    // One detail read at a time on a node: each runs several ps / lsof calls (and reads Linux socket tables), and a
    // burst of clicks must not multiply that. A bounded line: past it, or after waiting longer than a reader waits
    // for the answer, the request is turned away (`busy`) instead of reading for nobody.
    if (this.inspectWaiting >= LocalProcessMonitor.INSPECT_QUEUE) return { ok: false, reason: 'busy' };
    this.inspectWaiting++;
    const queuedAt = this.now();
    const run = this.inspecting.then(() => {
      this.inspectWaiting--;
      if (this.now() - queuedAt > LocalProcessMonitor.INSPECT_WAIT_MS)
        return { ok: false as const, reason: 'busy' as const };
      return this.inspectNow(input);
    });
    this.inspecting = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async inspectNow(input: ProcessInspectInput): Promise<ProcessInspectResult> {
    const inspectProcess = this.deps.inspectProcess;
    if (!inspectProcess) return { ok: false, reason: 'unsupported' };
    const snapshot = await this.fresh(1_000);
    const tree = snapshot.sessions.find((s) => s.sessionKey === input.sessionKey);
    const proc = tree?.processes.find((p) => p.pid === input.pid);
    if (!tree || !proc) return { ok: false, reason: 'not-found' };
    if (proc.startToken !== input.startToken) return { ok: false, reason: 'stale' };
    const read = await inspectProcess(input.pid, input.startToken);
    if (read === 'gone') return { ok: false, reason: 'not-found' };
    if (read === 'stale') return { ok: false, reason: 'stale' };

    const relative = (p: ProcessSample): ProcessRelative => ({
      pid: p.pid,
      startToken: p.startToken,
      name: p.name,
      role: p.role,
      state: p.state,
      cpuPercent: p.cpuPercent,
      rssBytes: p.rssBytes,
    });
    const byPid = new Map(tree.processes.map((p) => [p.pid, p]));
    const ancestors: ProcessRelative[] = [];
    const seen = new Set<number>([proc.pid]);
    for (let up = byPid.get(proc.ppid); up && !seen.has(up.pid); up = byPid.get(up.ppid)) {
      seen.add(up.pid);
      ancestors.unshift(relative(up));
    }
    const children = tree.processes.filter((p) => p.ppid === proc.pid && p.pid !== proc.pid).map(relative);
    // The subtree: tree order puts every descendant right after its process, deeper than it.
    const at = tree.processes.indexOf(proc);
    let end = at + 1;
    while (end < tree.processes.length && tree.processes[end].depth > proc.depth) end++;
    const under = tree.processes.slice(at, end);
    return {
      ok: true,
      detail: {
        ...read,
        sessionKey: input.sessionKey,
        nodeId: this.nodeId,
        name: proc.name,
        command: proc.command,
        role: proc.role,
        depth: proc.depth,
        cpuPercent: proc.cpuPercent,
        sampledAt: snapshot.sampledAt,
        ancestors,
        children,
        subtree: {
          processCount: under.length,
          cpuPercent: Math.round(under.reduce((n, p) => n + p.cpuPercent, 0) * 10) / 10,
          rssBytes: under.reduce((n, p) => n + p.rssBytes, 0),
        },
      },
    };
  }

  /**
   * Hand the sample to the CPU throttler (a session over its owner's cap starts being metered) and say on each session
   * what it is held to. A process the cap holds (or held a moment ago — the sample may predate its continue) reads as
   * running and `throttled`: it is not a pause, it runs part of every period, and its 일시중지 is still the person's
   * own. Any other stop — a person's pause, job control — stays a stop.
   */
  private applyCpuCaps(
    sessions: readonly SessionProcessDetail[],
    window: { from: number; to: number },
    turnIdOf: ReadonlyMap<number, number>,
  ): SessionProcessDetail[] {
    const capFor = this.cpuCapFor;
    // An aborted turn's processes are never metered again — not by a sample that was in flight when it aborted (the
    // abort released them already), nor by later samples while its workers clean up. The session's next turn is.
    if (capFor)
      this.throttler.update(
        sessions.map((s) => this.withoutAbortedTurns(s, turnIdOf)),
        capFor,
      );
    return sessions.map((s) => {
      const cap = capFor ? capFor(s.sessionKey) : null;
      const metered = this.throttler.meteredCap(s.sessionKey) !== null;
      // Every session, capped or not now: a hold the cap just released (a cap removed, an abort) still read `T`.
      const mine = this.paused.get(s.sessionKey);
      let shaped = false;
      const processes = s.processes.map((p) => {
        if (
          p.state !== 'stopped' ||
          mine?.get(p.pid)?.startToken === p.startToken ||
          !this.throttler.holds(s.sessionKey, p.pid, p.startToken, window)
        ) {
          return p;
        }
        shaped = true;
        return { ...p, state: 'running' as const, throttled: true };
      });
      if (cap === null && !metered && !shaped) return s;
      return {
        ...s,
        processes,
        stoppedCount: processes.filter((p) => p.state === 'stopped').length,
        ...(cap !== null ? { cpuCapPercent: cap } : {}),
        ...(cap !== null || metered ? { throttling: metered } : {}),
      };
    });
  }

  /** The session's tree without the processes of a turn that was aborted (its CPU no longer counts toward a cap). */
  private withoutAbortedTurns(s: SessionProcessDetail, turnIdOf: ReadonlyMap<number, number>): SessionProcessDetail {
    if (this.abortedTurnIds.size === 0) return s;
    const turns = turnsIn(s, this.turnOf, turnIdOf, this.carriedParentTurn(s.sessionKey));
    const processes = s.processes.filter((p) => {
      const turn = turns.get(p.pid);
      return turn === undefined || !this.abortedTurnIds.has(turn);
    });
    if (processes.length === s.processes.length) return s;
    const cpuPercent = processes.reduce((n, p) => n + Math.max(0, p.cpuPercent), 0);
    return { ...s, processes, cpuPercent };
  }

  /** An aborted turn must end: continue every process this monitor paused in that session. */
  private resumeAfterAbort(root: TrackedClaudeRootInfo): void {
    if (!root.sessionKey) return;
    // The stop must land: nothing of the session stays held by the CPU cap.
    this.throttler.release(root.sessionKey);
    this.abortedTurnIds.set(root.turnId, root.sessionKey);
    for (const check of this.pendingPauses) {
      if (check.sessionKey === root.sessionKey) check.abortedTurns.push(root.turnId);
    }
    const mine = this.paused.get(root.sessionKey);
    if (!mine) return;
    // Only what was paused under this turn (or between turns): a late abort of an earlier turn — the SDK can fire it
    // after the CLI exited — never continues a pause the owner made in the next one. An entry whose identity could not
    // be read, or that the OS refused to continue, stays tracked (the shutdown pass or the owner's 재개 can reach it).
    // Every identity in one read: this runs inside the SDK's abort callback, and a ps can take 2 s on a loaded host.
    const due = [...mine].filter(([, entry]) => entry.turn === undefined || entry.turn === root.turnId);
    const settled = this.continueSettled(due);
    let left = 0;
    for (const [pid, entry] of due) {
      if (settled.has(pid)) mine.delete(pid);
      else {
        entry.resumeWanted = true;
        left++;
      }
    }
    if (mine.size === 0) this.paused.delete(root.sessionKey);
    if (left > 0) {
      this.deps.logger?.warn('abort cleanup left paused processes; retrying on every sample', {
        sessionKey: root.sessionKey,
        count: left,
      });
    }
    this.deps.logger?.info('resumed paused processes after abort', { sessionKey: root.sessionKey });
  }

  /**
   * Remember each process's turn while it has one, so it keeps it after its parent exits. `turnIdOf` maps the pids of
   * the Claude Code processes in this sample to their `turnId`.
   */
  private noteTurns(snapshot: NodeProcessSnapshot, turnIdOf: ReadonlyMap<number, number>): void {
    const live = new Set<string>();
    for (const s of snapshot.sessions) {
      const turns = turnsIn(s, this.turnOf, turnIdOf, this.carriedParentTurn(s.sessionKey));
      for (const p of s.processes) {
        const key = `${p.pid}:${p.startToken}`;
        live.add(key);
        const turn = turns.get(p.pid);
        if (turn !== undefined) this.turnOf.set(key, turn);
      }
    }
    // A process missing from this sample but still remembered by the sampler (its row was skipped) keeps its turn.
    for (const key of this.turnOf.keys()) {
      if (live.has(key)) continue;
      const colon = key.indexOf(':');
      if (!this.sampler.rememberedAnywhere(Number(key.slice(0, colon)), key.slice(colon + 1))) this.turnOf.delete(key);
    }
    // An aborted turn is forgotten once nothing carries it: no live Claude Code process, no remembered process.
    const carried = new Set<number>([...turnIdOf.values(), ...this.turnOf.values()]);
    for (const id of [...this.abortedTurnIds.keys()]) if (!carried.has(id)) this.abortedTurnIds.delete(id);
  }

  /**
   * The turn of a parent this session's sample carried without its row (ps skipped it): the sampler still remembers
   * its start time, and the turn it was last seen under is kept for it.
   */
  private carriedParentTurn(sessionKey: string): (ppid: number) => number | undefined {
    return (ppid) => {
      const startToken = this.sampler.rememberedStart(sessionKey, ppid);
      return startToken === undefined ? undefined : this.turnOf.get(`${ppid}:${startToken}`);
    };
  }

  /**
   * Continue these paused processes after one batched identity read. The pids it settles: continued, confirmed gone, or
   * no longer that process. An unknown identity (the read failed) or a refused signal leaves an entry unsettled.
   */
  private continueSettled(entries: ReadonlyArray<readonly [number, PausedEntry]>): Set<number> {
    const settled = new Set<number>();
    if (entries.length === 0) return settled;
    const live = this.liveStartTokens(entries.map(([pid]) => pid));
    if (!live) return settled;
    for (const [pid, entry] of entries) {
      const now = live.get(pid);
      if (now === undefined) continue;
      if (now !== entry.startToken) {
        settled.add(pid);
        continue;
      }
      try {
        this.kill(pid, 'SIGCONT');
        settled.add(pid);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') settled.add(pid);
      }
    }
    return settled;
  }

  /** An aborted turn's pause that could not be continued then is tried again on every sample, all in one read. */
  private retryWantedResumes(): void {
    const wanted: Array<[number, PausedEntry]> = [];
    for (const mine of this.paused.values()) for (const e of mine) if (e[1].resumeWanted) wanted.push(e);
    const settled = this.continueSettled(wanted);
    if (settled.size === 0) return;
    for (const [sessionKey, mine] of this.paused) {
      for (const pid of [...mine.keys()]) if (settled.has(pid) && mine.get(pid)?.resumeWanted) mine.delete(pid);
      if (mine.size === 0) this.paused.delete(sessionKey);
    }
  }

  /**
   * Drop a pause whose process is gone. Missing from a sample is not proof (ps may have skipped a row): the live start
   * time decides — gone or another process now: dropped; the same process or unknown: kept, so abort and shutdown
   * cleanup can still continue it.
   */
  private forgetExitedPauses(snapshot: NodeProcessSnapshot): void {
    for (const [sessionKey, mine] of this.paused) {
      const live = snapshot.sessions.find((s) => s.sessionKey === sessionKey);
      for (const [pid, entry] of mine) {
        if (live?.processes.some((p) => p.pid === pid && p.startToken === entry.startToken)) continue;
        const now = this.liveStartToken(pid);
        if (now === null || (now !== undefined && now !== entry.startToken)) mine.delete(pid);
      }
      if (mine.size === 0) this.paused.delete(sessionKey);
    }
  }
}

/**
 * The turn (`turnId`) of every process in a session's sample: up the parent chain, the first ancestor that is a
 * Claude Code process of this sample, or that has a remembered turn (an orphan that outlived its turn passes it to
 * what it starts). Undefined when neither is found. One pid index per session and each process resolved once, so a
 * sample is linear.
 */
function turnsIn(
  tree: SessionProcessDetail,
  remembered: ReadonlyMap<string, number>,
  turnIdOf: ReadonlyMap<number, number>,
  carriedParentTurn: (ppid: number) => number | undefined = () => undefined,
): Map<number, number | undefined> {
  const byPid = new Map(tree.processes.map((p) => [p.pid, p]));
  const turns = new Map<number, number | undefined>();
  for (const start of tree.processes) {
    const chain: number[] = [];
    const onChain = new Set<number>();
    let turn: number | undefined;
    let cur: ProcessSample | undefined = start;
    while (cur && !onChain.has(cur.pid)) {
      if (turns.has(cur.pid)) {
        turn = turns.get(cur.pid);
        break;
      }
      chain.push(cur.pid);
      onChain.add(cur.pid);
      const rootTurn = cur.role === 'root' ? turnIdOf.get(cur.pid) : undefined;
      if (rootTurn !== undefined) {
        turn = rootTurn;
        break;
      }
      const known = remembered.get(`${cur.pid}:${cur.startToken}`);
      if (known !== undefined) {
        turn = known;
        break;
      }
      const up = byPid.get(cur.ppid);
      // The parent is in the session's tree but this sample has no row for it: its turn comes from what was last
      // remembered of it (a skipped middle row must not cut the chain).
      if (!up && cur.role === 'child') {
        turn = carriedParentTurn(cur.ppid);
        break;
      }
      cur = up;
    }
    for (const pid of chain) turns.set(pid, turn);
  }
  return turns;
}

/** Whether a process's parent chain ends at a parent the session's tree has but this sample has no row for. */
function brokenAtCarriedRow(tree: SessionProcessDetail, proc: ProcessSample): boolean {
  const byPid = new Map(tree.processes.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  for (let cur: ProcessSample | undefined = proc; cur && !seen.has(cur.pid); ) {
    seen.add(cur.pid);
    const up = byPid.get(cur.ppid);
    if (!up) return cur.role === 'child';
    cur = up;
  }
  return false;
}

/** Live start times one pid at a time, for a host that brings only the one-pid read: unknown for all if one fails. */
function liveStartTokensOneByOne(
  pids: readonly number[],
  one: (pid: number) => string | null | undefined,
): Map<number, string | null> | undefined {
  const out = new Map<number, string | null>();
  for (const pid of pids) {
    const token = one(pid);
    if (token === undefined) return undefined;
    out.set(pid, token);
  }
  return out;
}
