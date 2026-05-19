/**
 * runWithWatchdog — the sole cancellation mechanism for runtime calls.
 *
 * Races three promises:
 *   1. the runtime's waitForResult
 *   2. a timeout (default 300s)
 *   3. an optional AbortSignal
 *
 * Either the timeout or the abort path kills the child (SIGTERM, 5s grace, SIGKILL)
 * before rejecting. The finally block clears the timer and explicitly removes the
 * abort listener so a reused AbortSignal does not accumulate listeners across calls.
 *
 * `killChild` is injected so tests can observe the kill sequence without spawning
 * real processes. In production the runtime passes a closure over its child ref.
 */

import { ErrorCode, LlmChatError } from './errors.js';

export interface WatchdogOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Signal sender; runtime captures its spawned child by closure.
   * Watchdog calls this with SIGTERM first, then with SIGKILL after `killGraceMs`
   * if the promise has not settled.
   */
  killChild: (sig: 'SIGTERM' | 'SIGKILL') => void;
  /** Grace between SIGTERM and SIGKILL. Default 5000ms. */
  killGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

export async function runWithWatchdog<T>(
  waitForResult: Promise<T>,
  opts: WatchdogOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  let timer: NodeJS.Timeout | undefined;
  let killFollowup: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  const scheduleKill = (): void => {
    try { opts.killChild('SIGTERM'); } catch { /* ignore */ }
    killFollowup = setTimeout(() => {
      try { opts.killChild('SIGKILL'); } catch { /* ignore */ }
    }, graceMs);
    killFollowup.unref?.();
  };

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      scheduleKill();
      reject(new LlmChatError(ErrorCode.BACKEND_TIMEOUT, `Exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  const abort: Promise<never> = opts.signal
    ? new Promise<never>((_, reject) => {
        // If the signal is already aborted, reject immediately + kill.
        if (opts.signal!.aborted) {
          scheduleKill();
          reject(new LlmChatError(ErrorCode.ABORTED, 'Request aborted'));
          return;
        }
        abortListener = () => {
          scheduleKill();
          reject(new LlmChatError(ErrorCode.ABORTED, 'Request aborted'));
        };
        opts.signal!.addEventListener('abort', abortListener, { once: true });
      })
    : new Promise<never>(() => {
        /* never resolves */
      });

  try {
    return await Promise.race([waitForResult, timeout, abort]);
  } finally {
    if (timer) clearTimeout(timer);
    // NOTE: killFollowup is intentionally NOT cleared here. If scheduleKill was
    // triggered (timeout/abort), we want the SIGKILL followup to fire after the
    // grace period even though Promise.race has already settled — the child may
    // still be alive after SIGTERM. If the child is already dead, SIGKILL to a
    // gone PID is caught by the killChild closure's try/catch. Leaving
    // killFollowup to resolve on its own (unref'd) is the correct behavior.
    if (abortListener && opts.signal) {
      opts.signal.removeEventListener('abort', abortListener);
    }
  }
}
