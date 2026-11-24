import { execFileSync } from 'node:child_process';
import type { TrackedClaudeRootInfo } from '../agent-runtime/claude-child-process-registry';
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
   * Turns (`turnId`s) whose abort already ran: a pause in one is refused, as nothing would continue it. Kept while a
   * live Claude Code process or a remembered process still carries the turn.
   */
  private readonly abortedTurnIds = new Set<number>();
  /** Set when the host starts shutting down: no pause is accepted after the final resume pass. */
  private shuttingDown = false;
  private readonly listeners = new Set<Listener>();
  /** session → pid → what was paused, for every process this monitor paused and has not resumed. */
  private readonly paused = new Map<string, Map<number, PausedEntry>>();
  /** The detail read in progress (inspect runs one at a time). */
  private inspecting: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ProcessMonitorDeps) {
    this.nodeId = deps.nodeId;
    this.now = deps.now ?? Date.now;
    this.sampler = new TreeSampler(deps.runPs, this.now, deps.readCpuSeconds, deps.readCwds);
    this.platform = deps.platform ?? process.platform;
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.readCapacity =
      deps.readCapacity ??
      createNodeCapacityReader({ nodeId: deps.nodeId, platform: this.platform, run: deps.runCommand });
    this.liveStartToken = deps.liveStartToken ?? psLiveStartToken;
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

  /** Stop the timer and detach from the registry — the monitor is going away (tests). */
  dispose(): void {
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
        const [treeRead, nodeRead] = await Promise.allSettled([
          this.sampler.sample(roots, this.nodeId),
          this.readCapacity(),
        ]);
        if (treeRead.status === 'rejected') throw treeRead.reason;
        if (nodeRead.status === 'rejected') throw nodeRead.reason;
        const tree = treeRead.value;
        const node = nodeRead.value;
        const snapshot: NodeProcessSnapshot = {
          node,
          sampledAt: this.now(),
          sessions: tree.sessions,
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
    if (input.action === 'pause' && proc) {
      const since = check.abortedTurns;
      const turn = this.turnOf.get(`${proc.pid}:${proc.startToken}`);
      const turnAborted = turn !== undefined && this.abortedTurnIds.has(turn);
      if (this.shuttingDown || turnAborted || (since.length > 0 && (turn === undefined || since.includes(turn)))) {
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
    // burst of clicks must not multiply that.
    const run = this.inspecting.then(() => this.inspectNow(input));
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

  /** An aborted turn must end: continue every process this monitor paused in that session. */
  private resumeAfterAbort(root: TrackedClaudeRootInfo): void {
    if (!root.sessionKey) return;
    this.abortedTurnIds.add(root.turnId);
    for (const check of this.pendingPauses) {
      if (check.sessionKey === root.sessionKey) check.abortedTurns.push(root.turnId);
    }
    const mine = this.paused.get(root.sessionKey);
    if (!mine) return;
    // Only what was paused under this turn (or between turns): a late abort of an earlier turn — the SDK can fire it
    // after the CLI exited — never continues a pause the owner made in the next one. An entry whose identity could not
    // be read, or that the OS refused to continue, stays tracked (the shutdown pass or the owner's 재개 can reach it).
    let left = 0;
    for (const [pid, entry] of mine) {
      if (entry.turn !== undefined && entry.turn !== root.turnId) continue;
      if (this.continueIfSame(pid, entry.startToken)) mine.delete(pid);
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
      const turns = turnsIn(s, this.turnOf, turnIdOf);
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
    for (const id of this.abortedTurnIds) if (!carried.has(id)) this.abortedTurnIds.delete(id);
  }

  /** An aborted turn's pause that could not be continued then is tried again on every sample. */
  private retryWantedResumes(): void {
    for (const [sessionKey, mine] of this.paused) {
      for (const [pid, entry] of mine) {
        if (entry.resumeWanted && this.continueIfSame(pid, entry.startToken)) mine.delete(pid);
      }
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
      cur = byPid.get(cur.ppid);
    }
    for (const pid of chain) turns.set(pid, turn);
  }
  return turns;
}
