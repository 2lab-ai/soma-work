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
  readonly logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

const DEFAULT_INTERVAL_MS = 5_000;

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
  private unsubscribeAbort: (() => void) | null = null;
  private unsubscribeShutdown: (() => void) | null = null;
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
  }

  start(): void {
    if (this.timer) return;
    this.unsubscribeAbort = this.deps.roots.onAbort((root) => this.resumeAfterAbort(root));
    this.unsubscribeShutdown = this.deps.roots.onShutdown?.(() => this.resumeAllPaused()) ?? null;
    this.timer = setInterval(() => {
      // Idle: nothing tracked, nothing remembered, and the last sample already said so — no ps, no vm_stat.
      if (!this.sampler.hasWork(this.deps.roots.roots()) && this.snapshot && this.snapshot.sessions.length === 0)
        return;
      this.sample().catch((err) => this.deps.logger?.warn('process sample failed', { error: String(err) }));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeAbort?.();
    this.unsubscribeAbort = null;
    this.unsubscribeShutdown?.();
    this.unsubscribeShutdown = null;
  }

  /**
   * Continue every process this monitor paused, in every session (the daemon is going away: a stopped process left
   * behind would hold its memory, ports and locks with nobody to resume it). Synchronous — it runs on exit paths.
   */
  resumeAllPaused(): void {
    for (const [sessionKey, mine] of this.paused) {
      for (const [pid, startToken] of mine) {
        if (this.sampler.rememberedStart(sessionKey, pid) !== startToken) continue;
        try {
          this.kill(pid, 'SIGCONT');
        } catch {
          // Gone already.
        }
      }
    }
    this.paused.clear();
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
    const before = await this.fresh(0);
    const proc = before.sessions
      .find((s) => s.sessionKey === input.sessionKey)
      ?.processes.find((p) => p.pid === input.pid);
    if (!proc) return { ok: false, reason: 'not-found' };
    if (proc.startToken !== input.startToken) return { ok: false, reason: 'stale' };

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
    const mine = this.paused.get(root.sessionKey);
    if (!mine) return;
    for (const [pid, startToken] of mine) {
      // Only a process still remembered with the same start time: never signal a reused pid.
      if (this.sampler.rememberedStart(root.sessionKey, pid) !== startToken) continue;
      try {
        this.kill(pid, 'SIGCONT');
      } catch {
        // Gone already.
      }
    }
    this.paused.delete(root.sessionKey);
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
