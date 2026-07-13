import { spawn } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

const DEFAULT_DRAIN_GRACE_MS = 5_000;
const DEFAULT_KILL_WAIT_MS = 1_000;

export type TrackedClaudeProcess = SpawnedProcess & { readonly pid?: number };

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
  private shutdownSignal: NodeJS.Signals | null = null;
  private changeWaiters = new Set<() => void>();
  private drainPromise: Promise<void> | null = null;
  private killFailures = new Set<number | undefined>();

  get size(): number {
    return this.children.size;
  }

  track(child: TrackedClaudeProcess): TrackedClaudeProcess {
    this.children.add(child);

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
    const deadline = Date.now() + graceMs;
    if (this.shutdownSignal !== 'SIGKILL') this.shutdownSignal = 'SIGTERM';
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

  killAllSync(signal: NodeJS.Signals): void {
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
  }
}

const registry = new ClaudeChildProcessRegistry();

export function getClaudeChildProcessRegistry(): ClaudeChildProcessRegistry {
  return registry;
}

/**
 * Build the SDK spawn hook while preserving its local-process contract.
 * stderr is always drained so a noisy child can never block on a full pipe.
 */
export function createTrackedClaudeProcessSpawner(
  onStderr?: (data: string) => void,
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

    return registry.track(child);
  };
}
