import { spawn } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

const DEFAULT_DRAIN_GRACE_MS = 5_000;
const DEFAULT_KILL_WAIT_MS = 1_000;

export type TrackedClaudeProcess = SpawnedProcess & { readonly pid?: number };

/** Who a Claude Code child runs for. Absent for one-shot helpers (title, dispatch, voice). */
export interface ClaudeProcessOwner {
  /** The work session (dashboard task card) the child runs a turn for. */
  readonly sessionKey: string;
}

/** A live tracked child as the process monitor sees it. */
export interface TrackedClaudeRootInfo {
  readonly pid: number;
  readonly sessionKey?: string;
  /**
   * This spawn's own number, unique in this daemon: the turn's identity. A pid is not one — the OS can give an exited
   * child's pid to the next one, and a late abort of the first must not reach what the second paused.
   */
  readonly turnId: number;
}

export interface DrainOptions {
  readonly graceMs?: number;
  readonly killWaitMs?: number;
}

/**
 * Owns every Claude Code child spawned through the Agent SDK adapter.
 *
 * The SDK's own shutdown escalation uses timers. Those timers cannot run after
 * `process.exit()`, so soma keeps a host-visible registry and drains it before
 * exiting. Children remove themselves on exit or spawn error.
 */
export class ClaudeChildProcessRegistry {
  private readonly children = new Set<TrackedClaudeProcess>();
  private readonly owners = new WeakMap<TrackedClaudeProcess, ClaudeProcessOwner>();
  private readonly turnIds = new WeakMap<TrackedClaudeProcess, number>();
  private nextTurnId = 0;
  private readonly abortListeners = new Set<(root: TrackedClaudeRootInfo) => void>();
  private readonly shutdownListeners = new Set<() => void>();
  private shutdownSignal: NodeJS.Signals | null = null;
  private changeWaiters = new Set<() => void>();
  private drainPromise: Promise<void> | null = null;
  private killFailures = new Set<number | undefined>();

  get size(): number {
    return this.children.size;
  }

  track(child: TrackedClaudeProcess, owner?: ClaudeProcessOwner): TrackedClaudeProcess {
    this.children.add(child);
    if (owner) this.owners.set(child, owner);
    if (!this.turnIds.has(child)) this.turnIds.set(child, ++this.nextTurnId);

    const remove = () => {
      child.off('exit', onExit);
      child.off('error', onError);
      this.children.delete(child);
      this.killFailures.delete(child.pid);
      this.notifyChange();
    };
    const onExit = () => remove();
    const onError = () => {
      // AbortSignal-backed ChildProcess emits AbortError before a stubborn
      // child necessarily exits. Keep spawned children registered so shutdown
      // can still escalate them to SIGKILL. A child with no pid never spawned.
      if (child.pid === undefined) remove();
    };
    child.once('exit', onExit);
    child.once('error', onError);

    if (this.shutdownSignal) {
      this.kill(child, this.shutdownSignal);
    }
    this.notifyChange();
    return child;
  }

  /** Live children that have a pid, with the session each runs for. */
  roots(): TrackedClaudeRootInfo[] {
    const out: TrackedClaudeRootInfo[] = [];
    for (const child of this.children) {
      if (child.pid === undefined || child.exitCode !== null) continue;
      out.push(this.infoOf(child, child.pid));
    }
    return out;
  }

  private infoOf(child: TrackedClaudeProcess, pid: number): TrackedClaudeRootInfo {
    const owner = this.owners.get(child);
    const turnId = this.turnIds.get(child) ?? 0;
    return owner ? { pid, sessionKey: owner.sessionKey, turnId } : { pid, turnId };
  }

  /**
   * Called when a child's turn is aborted (stop button, steering abort). The
   * process monitor resumes what it paused in that session, so an abort ends
   * a paused tree instead of leaving it stopped forever.
   */
  onAbort(listener: (root: TrackedClaudeRootInfo) => void): () => void {
    this.abortListeners.add(listener);
    return () => this.abortListeners.delete(listener);
  }

  /**
   * Called synchronously when the host starts shutting its children down (drain, crash kill). The process monitor
   * continues every process it paused, so nothing is left stopped after the daemon is gone.
   */
  onShutdown(listener: () => void): () => void {
    this.shutdownListeners.add(listener);
    return () => this.shutdownListeners.delete(listener);
  }

  private notifyShutdown(): void {
    for (const listener of [...this.shutdownListeners]) {
      try {
        listener();
      } catch {
        // One listener's failure must not keep the others (or the kill) from running.
      }
    }
  }

  /** @internal the spawner reports an aborted child here. */
  notifyAborted(child: TrackedClaudeProcess): void {
    if (child.pid === undefined) return;
    const info = this.infoOf(child, child.pid);
    for (const listener of [...this.abortListeners]) {
      try {
        listener(info);
      } catch {
        // A listener's failure must not keep the abort from reaching the others.
      }
    }
  }

  async drain(options: DrainOptions = {}): Promise<void> {
    if (this.drainPromise) return this.drainPromise;

    const graceMs = options.graceMs ?? DEFAULT_DRAIN_GRACE_MS;
    const killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;
    this.assertDuration('graceMs', graceMs);
    this.assertDuration('killWaitMs', killWaitMs);

    this.drainPromise = this.drainOnce(graceMs, killWaitMs);
    return this.drainPromise;
  }

  private async drainOnce(graceMs: number, killWaitMs: number): Promise<void> {
    if (this.shutdownSignal !== 'SIGKILL') this.shutdownSignal = 'SIGTERM';
    this.notifyShutdown();
    // The grace period starts at the SIGTERM, after the shutdown listeners (the monitor's resume pass can take a while
    // on a loaded host): the children get all of it.
    const deadline = Date.now() + graceMs;
    this.killLiveChildren(this.shutdownSignal);

    while (this.hasLiveChildren() && this.shutdownSignal !== 'SIGKILL') {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await this.waitForChange(remainingMs);
    }

    this.shutdownSignal = 'SIGKILL';
    this.killLiveChildren('SIGKILL');
    if (this.hasLiveChildren() && killWaitMs > 0) {
      await this.waitForChange(killWaitMs);
    }

    if (this.hasLiveChildren() || this.killFailures.size > 0) {
      const pids = [...this.children]
        .filter((child) => child.exitCode === null)
        .map((child) => child.pid ?? 'unknown')
        .join(', ');
      throw new Error(`Claude child cleanup failed; survivors: ${pids || 'signal delivery failure'}`);
    }
  }

  /** #1473 — is a child still running a turn for `sessionKey`? */
  hasLiveChildFor(sessionKey: string): boolean {
    for (const child of this.children) {
      if (child.exitCode === null && this.owners.get(child)?.sessionKey === sessionKey) return true;
    }
    return false;
  }

  /**
   * #1473 — wait until no child runs a turn for `sessionKey` (the session's previous CLI has exited), `timeoutMs`
   * passes, or `signal` aborts. True when none is left.
   */
  async waitForSessionExit(sessionKey: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.hasLiveChildFor(sessionKey)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || signal?.aborted) return false;
      let onAbort: (() => void) | undefined;
      await Promise.race([
        this.waitForChange(remainingMs),
        new Promise<void>((resolve) => {
          onAbort = resolve;
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
    return true;
  }

  /** #1473 — signal every child still running a turn for `sessionKey` (a stopped turn whose CLI did not close). */
  killSession(sessionKey: string, signal: NodeJS.Signals): number {
    let signalled = 0;
    for (const child of this.children) {
      if (child.exitCode !== null || this.owners.get(child)?.sessionKey !== sessionKey) continue;
      this.kill(child, signal);
      signalled += 1;
    }
    return signalled;
  }

  /**
   * #1473 — signal the child spawned for `owner` (one query's own owner object: the turn that started it, not every
   * turn of its session).
   */
  killOwned(owner: ClaudeProcessOwner, signal: NodeJS.Signals): number {
    let signalled = 0;
    for (const child of this.children) {
      if (child.exitCode !== null || this.owners.get(child) !== owner) continue;
      this.kill(child, signal);
      signalled += 1;
    }
    return signalled;
  }

  killAllSync(signal: NodeJS.Signals): void {
    this.notifyShutdown();
    for (const child of this.children) {
      if (child.exitCode === null) {
        this.kill(child, signal);
      }
    }
  }

  /** Test isolation only. */
  resetForTests(): void {
    this.children.clear();
    this.shutdownSignal = null;
    this.drainPromise = null;
    this.killFailures.clear();
    this.notifyChange();
  }

  private hasLiveChildren(): boolean {
    for (const child of this.children) {
      if (child.exitCode === null) return true;
    }
    return false;
  }

  private killLiveChildren(signal: NodeJS.Signals): void {
    for (const child of this.children) {
      if (child.exitCode === null) this.kill(child, signal);
    }
  }

  private waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        this.changeWaiters.delete(done);
        resolve();
      };
      this.changeWaiters.add(done);
      timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      // Close the exit-between-check-and-listener race: if the last child
      // disappeared before this waiter was registered, settle immediately.
      if (!this.hasLiveChildren()) done();
    });
  }

  private notifyChange(): void {
    for (const resolve of [...this.changeWaiters]) resolve();
  }

  private assertDuration(name: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a finite non-negative number`);
    }
  }

  private kill(child: TrackedClaudeProcess, signal: NodeJS.Signals): void {
    try {
      if (!child.kill(signal) && child.exitCode === null) {
        this.killFailures.add(child.pid);
      }
    } catch {
      if (child.exitCode === null) this.killFailures.add(child.pid);
    }
    // A child the owner paused (SIGSTOP, the dashboard's 프로세스 tab) holds any other signal pending until it runs
    // again: continue it so SIGTERM lands now instead of waiting out the grace for SIGKILL. Through the handle, so a
    // child that already exited (and whose pid the OS may have reused) is never signalled.
    if (signal !== 'SIGKILL' && child.exitCode === null) continueChild(child);
  }
}

const registry = new ClaudeChildProcessRegistry();

/** SIGCONT through the child's own handle — never a bare pid, which the OS may have handed to another program. */
function continueChild(child: TrackedClaudeProcess): void {
  if (process.platform === 'win32' || child.exitCode !== null || child.signalCode) return;
  try {
    child.kill('SIGCONT');
  } catch {
    // Already gone: nothing to continue.
  }
}

export function getClaudeChildProcessRegistry(): ClaudeChildProcessRegistry {
  return registry;
}

/**
 * Build the SDK spawn hook while preserving its local-process contract.
 * stderr is always drained so a noisy child can never block on a full pipe.
 */
export function createTrackedClaudeProcessSpawner(
  onStderr?: (data: string) => void,
  owner?: ClaudeProcessOwner,
): (options: SpawnOptions) => SpawnedProcess {
  return ({ command, args, cwd, env, signal }) => {
    const child = spawn(command, args, {
      cwd,
      env,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stderr?.on('data', (chunk) => {
      onStderr?.(chunk.toString());
    });

    // Node sends the kill signal on abort first (its listener was added by spawn). A child the owner paused
    // (SIGSTOP) holds that signal pending until it runs again, so continue it, and let the monitor continue
    // the paused processes under it.
    // The listener stays after the child exits: the SDK can abort after the CLI has already gone (close() with a
    // grace), and the processes paused under it must still be continued. continueChild skips an exited child.
    signal?.addEventListener(
      'abort',
      () => {
        continueChild(child);
        registry.notifyAborted(child);
      },
      { once: true },
    );

    return registry.track(child, owner);
  };
}
