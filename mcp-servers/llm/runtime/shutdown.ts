/**
 * ShutdownCoordinator — graceful-drain lifecycle for the llm MCP server.
 *
 * Sequence:
 *   1. Flip `accepting=false` (new tool calls throw ABORTED).
 *   2. Wait up to `drainTimeoutMs` (default 30s) for inflight handlers to settle.
 *   3. Terminate any remaining registered children (SIGTERM → poll → SIGKILL).
 *   4. Drain both WriteQueues (close-barrier: post-drain run() throws ABORTED,
 *      so any late child-exit finalizer cannot slip a partial write in).
 *   5. Unlink pidfile (owner-checked) — VERY LAST.
 *   6. Call runtime.shutdown() on each backend (stop MCP child stdin/stdout).
 *   7. process.exit().
 *
 * The pidfile is retained until step-5 so a replacement server cannot acquire
 * the lock during shutdown — no split-brain.
 */

import type { LlmRuntime, Backend } from './types.js';
import type { FileSessionStore } from './session-store.js';
import type { ChildRegistry } from './child-registry.js';
import type { PidfileHandle } from './pidfile.js';
import { ErrorCode, LlmChatError } from './errors.js';
import { StderrLogger } from '../../_shared/stderr-logger.js';

const logger = new StderrLogger('Shutdown');

export type ShutdownTrigger = NodeJS.Signals | 'programmatic';

export interface ShutdownDeps {
  pidfile: PidfileHandle;
  sessionStore: FileSessionStore;
  childRegistry: ChildRegistry;
  runtimes: Record<Backend, LlmRuntime>;
  /** Default 30_000. */
  drainTimeoutMs?: number;
}

export class ShutdownCoordinator {
  private _accepting = true;
  /**
   * In-flight graceful() promise. Memoized so a second signal (or BaseMcpServer's
   * own SIGINT/SIGTERM handler falling through to shutdown()) awaits the same
   * drain sequence instead of returning immediately and letting the caller
   * race process.exit() with the still-running drain.
   */
  private gracefulPromise: Promise<void> | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly deps: ShutdownDeps;
  private readonly drainTimeoutMs: number;

  constructor(deps: ShutdownDeps) {
    this.deps = deps;
    this.drainTimeoutMs = deps.drainTimeoutMs ?? 30_000;
  }

  get accepting(): boolean {
    return this._accepting;
  }

  /**
   * Track a tool-call handler promise so shutdown can wait for it.
   * Throws ABORTED synchronously if called after shutdown began.
   */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    if (!this._accepting) {
      throw new LlmChatError(ErrorCode.ABORTED, 'Server shutting down');
    }
    const p = fn();
    this.inflight.add(p);
    try {
      return await p;
    } finally {
      this.inflight.delete(p);
    }
  }

  /**
   * Run the shutdown sequence. Idempotent; repeated calls share the first
   * invocation's promise so every caller awaits the same drain completion.
   *
   * Intentionally NOT `async` — an async wrapper would create a new promise
   * per call, breaking reference-identity memoization. We return the stored
   * promise directly.
   */
  graceful(signal: ShutdownTrigger): Promise<void> {
    if (this.gracefulPromise) return this.gracefulPromise;
    this._accepting = false;
    this.gracefulPromise = this.runGraceful(signal);
    return this.gracefulPromise;
  }

  private async runGraceful(signal: ShutdownTrigger): Promise<void> {
    logger.info('llm.shutdown.begin', { signal });

    // 2. drain inflight handlers (bounded)
    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      const timeout = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250);
        t.unref?.();
      });
      await Promise.race([Promise.allSettled([...this.inflight]), timeout]);
    }
    if (this.inflight.size > 0) {
      logger.warn('llm.shutdown.inflight-timeout', { remaining: this.inflight.size });
    }

    // 3. terminate any remaining live children
    try {
      await this.deps.childRegistry.shutdownAll();
    } catch (err) {
      logger.error('llm.shutdown.child-termination-failed', { err: String(err) });
    }

    // 4. drain both WriteQueues (close-barrier)
    try {
      await this.deps.sessionStore.writeQueue.drain();
    } catch { /* already drained */ }
    try {
      await this.deps.childRegistry.writeQueue.drain();
    } catch { /* already drained */ }

    // 5. release pidfile (owner-checked)
    try {
      this.deps.pidfile.release();
    } catch { /* best-effort */ }

    // 6. shut down MCP client processes
    await Promise.all(
      Object.values(this.deps.runtimes).map(async (rt) => {
        try { await rt.shutdown(); } catch { /* ignore */ }
      }),
    );

    logger.info('llm.shutdown.complete');
  }

  /**
   * Install a single best-effort `exit`-event pidfile-release handler. Signal
   * handling (SIGINT/SIGTERM) is owned by BaseMcpServer.run(), which calls the
   * LlmMCPServer subclass's `shutdown()` override — that in turn awaits
   * `graceful()`. Installing SIGINT/SIGTERM here too would race BaseMcpServer's
   * handler: the second `graceful()` would return the memoized promise, but a
   * second `process.exit(0)` triggered on the base path could still undercut
   * the drain. Keeping one owner per signal eliminates the ambiguity.
   */
  installSignalHandlers(): void {
    // Best-effort sync unlink on plain exit() calls (crash after graceful already unlinked is a no-op).
    process.on('exit', () => {
      try { this.deps.pidfile.release(); } catch { /* ignore */ }
    });
  }
}
