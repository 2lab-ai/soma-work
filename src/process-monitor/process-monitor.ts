import { execFileSync } from 'node:child_process';
import type { TrackedClaudeRootInfo } from '../agent-runtime/claude-child-process-registry';
import { createNodeCapacityReader, type RunCommand } from './node-capacity';
import { type ReadCpuSeconds, type RunPs, TreeSampler } from './tree-sampler';
import type {
  NodeCapacity,
  NodeId,
  NodeProcessSnapshot,
  ProcessControlAction,
  ProcessControlResult,
  SessionProcessDetail,
  SessionProcessUsage,
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
  /** Signal delivery; `process.kill` in production. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly platform?: string;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly readCapacity?: () => Promise<NodeCapacity>;
  /**
   * The live start time of a pid, in the start-token form (`ps lstart`), or null when it is gone. Asked right before an
   * automatic resume (abort, shutdown) so a paused process that was killed and whose pid the OS reused since the last
   * sample is never signalled. Synchronous: it runs on exit paths.
   */
  readonly liveStartToken?: (pid: number) => string | null;
  readonly logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

const DEFAULT_INTERVAL_MS = 5_000;

/** `ps -o lstart= -p <pid>` with the C locale, whitespace collapsed like the sampler's start token; null when gone. */
function psLiveStartToken(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const token = out.trim().split(/\s+/).join(' ');
    return token || null;
  } catch {
    return null;
  }
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
  private readonly intervalMs: number;
  private snapshot: NodeProcessSnapshot | null = null;
  private inFlight: Promise<NodeProcessSnapshot> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribeAbort: () => void;
  private readonly unsubscribeShutdown: (() => void) | null;
  private readonly liveStartToken: (pid: number) => string | null;
  /** session → how many times its turn was aborted; a pause whose check spans an abort is refused. */
  private readonly abortGen = new Map<string, number>();
  /** Set when the host starts shutting down: no pause is accepted after the final resume pass. */
  private shuttingDown = false;
  private readonly listeners = new Set<Listener>();
  /** session → pid → start token, for every process this monitor paused and has not resumed. */
  private readonly paused = new Map<string, Map<number, string>>();

  constructor(private readonly deps: ProcessMonitorDeps) {
    this.nodeId = deps.nodeId;
    this.now = deps.now ?? Date.now;
    this.sampler = new TreeSampler(deps.runPs, this.now, deps.readCpuSeconds);
    this.platform = deps.platform ?? process.platform;
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
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
    }, this.intervalMs);
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
    for (const [sessionKey, mine] of this.paused) {
      for (const [pid, startToken] of mine) if (this.continueIfSame(pid, startToken)) mine.delete(pid);
      if (mine.size === 0) this.paused.delete(sessionKey);
    }
  }

  /**
   * SIGCONT only when the pid still names the process that was paused (its live start time), never a reused pid.
   * True when the entry is settled (continued, gone, or no longer that process); false when the OS refused the
   * signal, so the entry is kept for the next attempt.
   */
  private continueIfSame(pid: number, startToken: string): boolean {
    if (this.liveStartToken(pid) !== startToken) return true;
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

  usage(sessionKey: string): SessionProcessUsage | undefined {
    const s = this.snapshot?.sessions.find((x) => x.sessionKey === sessionKey);
    if (!s) return undefined;
    const { processes: _processes, ...usage } = s;
    return usage;
  }

  detail(sessionKey: string): SessionProcessDetail | undefined {
    return this.snapshot?.sessions.find((x) => x.sessionKey === sessionKey);
  }

  /** Take one sample now (joins a sample already running). */
  sample(): Promise<NodeProcessSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const roots = this.deps.roots.roots();
        const [tree, node] = await Promise.all([this.sampler.sample(roots, this.nodeId), this.readCapacity()]);
        const snapshot: NodeProcessSnapshot = {
          node,
          sampledAt: this.now(),
          sessions: tree.sessions,
          unattributed: tree.unattributed,
        };
        this.snapshot = snapshot;
        this.forgetExitedPauses(snapshot);
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
    const gen = this.abortGen.get(input.sessionKey) ?? 0;
    const before = await this.fresh(0);
    // The turn was aborted, or the host started shutting down, while this check sampled: that cleanup already ran, so
    // a pause now would never be undone.
    if (input.action === 'pause' && (this.shuttingDown || (this.abortGen.get(input.sessionKey) ?? 0) !== gen)) {
      return { ok: false, reason: 'not-found' };
    }
    const proc = before.sessions
      .find((s) => s.sessionKey === input.sessionKey)
      ?.processes.find((p) => p.pid === input.pid);
    if (!proc) return { ok: false, reason: 'not-found' };
    if (proc.startToken !== input.startToken) return { ok: false, reason: 'stale' };
    // The sample is a moment old: read the pid's live start time right before the signal (a pid reused since then is
    // refused). Synchronous, so nothing runs between this check and the signal.
    if (this.liveStartToken(input.pid) !== input.startToken) return { ok: false, reason: 'stale' };

    try {
      this.kill(input.pid, input.action === 'pause' ? 'SIGSTOP' : 'SIGCONT');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return { ok: false, reason: code === 'ESRCH' ? 'not-found' : 'denied' };
    }

    const mine = this.paused.get(input.sessionKey) ?? new Map<number, string>();
    if (input.action === 'pause') mine.set(input.pid, input.startToken);
    else mine.delete(input.pid);
    if (mine.size > 0) this.paused.set(input.sessionKey, mine);
    else this.paused.delete(input.sessionKey);

    const after = await this.sample();
    const now = after.sessions
      .find((s) => s.sessionKey === input.sessionKey)
      ?.processes.find((p) => p.pid === input.pid && p.startToken === input.startToken);
    return { ok: true, pid: input.pid, state: now?.state ?? (input.action === 'pause' ? 'stopped' : 'sleeping') };
  }

  /** An aborted turn must end: continue every process this monitor paused in that session. */
  private resumeAfterAbort(root: TrackedClaudeRootInfo): void {
    if (!root.sessionKey) return;
    this.abortGen.set(root.sessionKey, (this.abortGen.get(root.sessionKey) ?? 0) + 1);
    const mine = this.paused.get(root.sessionKey);
    if (!mine) return;
    // An entry the OS refused to continue stays tracked (the shutdown pass or the owner's 재개 can still reach it).
    for (const [pid, startToken] of mine) if (this.continueIfSame(pid, startToken)) mine.delete(pid);
    if (mine.size === 0) this.paused.delete(root.sessionKey);
    this.deps.logger?.info('resumed paused processes after abort', { sessionKey: root.sessionKey });
  }

  private forgetExitedPauses(snapshot: NodeProcessSnapshot): void {
    for (const [sessionKey, mine] of this.paused) {
      const live = snapshot.sessions.find((s) => s.sessionKey === sessionKey);
      for (const [pid, startToken] of mine) {
        if (!live?.processes.some((p) => p.pid === pid && p.startToken === startToken)) mine.delete(pid);
      }
      if (mine.size === 0) this.paused.delete(sessionKey);
    }
  }
}
