/**
 * WriteQueue — single-slot serialized task queue with close-barrier.
 *
 * Tasks run strictly FIFO; each awaits the previous one settling (resolve OR reject).
 * `drain()` flips a closed flag and returns once the current tail settles. After
 * `drain()`, every subsequent `run()` rejects synchronously with ABORTED — this
 * prevents late finalizers (e.g. a child-exit handler) from writing to a store
 * that is shutting down.
 */

import { ErrorCode, LlmChatError } from './errors.js';

export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new LlmChatError(ErrorCode.ABORTED, 'WriteQueue closed (shutdown in progress)'),
      );
    }
    // Chain regardless of prior rejection so a failing task doesn't halt the queue.
    const next = this.tail.then(
      () => task(),
      () => task(),
    );
    // Track settlement (success OR rejection) so drain() waits for ordering, not for value.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Close-barrier. Idempotent. Resolves once the current tail has settled;
   * after the first call, every run() rejects synchronously with ABORTED.
   */
  async drain(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
