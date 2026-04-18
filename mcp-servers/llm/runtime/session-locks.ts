/**
 * SessionLocks — per-publicId resume gate.
 *
 * Orthogonal to WriteQueue:
 *   - WriteQueue serializes file writes across all records of a given store.
 *   - SessionLocks rejects concurrent resume calls on the same session.
 *
 * A concurrent resume of the same session would cause the backend to see two
 * in-flight reply requests against the same thread, which most providers either
 * reject or interleave unpredictably. Fail-fast with SESSION_BUSY instead.
 */

import { ErrorCode, LlmChatError } from './errors.js';

export class SessionLocks {
  private readonly inflight = new Set<string>();

  /**
   * Attempt to acquire the lock for `id`. Returns a release function.
   * Throws SESSION_BUSY if another call already holds the lock.
   */
  acquire(id: string): () => void {
    if (this.inflight.has(id)) {
      throw new LlmChatError(ErrorCode.SESSION_BUSY, `Session ${id} is busy`);
    }
    this.inflight.add(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflight.delete(id);
    };
  }

  isHeld(id: string): boolean {
    return this.inflight.has(id);
  }
}
