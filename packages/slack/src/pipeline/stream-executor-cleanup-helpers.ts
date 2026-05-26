/**
 * Turn-end surface guarantee §C-5 — bounded cleanup helpers.
 *
 * `cleanupTempFiles` (and any other terminal-rail cleanup awaited by
 * `StreamExecutor`) used to await synchronously without a timeout. A
 * misbehaving file handler that hung indefinitely would block the
 * `finally` block from reaching `threadPanel.endTurn()` and emitting
 * the B5 terminal card — leaving the thread without any 🟢/🟠/🔴 marker.
 *
 * `cleanupWithTimeout` wraps the cleanup callable in a `Promise.race`
 * against a finite timer. When the timer wins, the cleanup is left to
 * run in the background (the caller's `finally` block still reaches
 * the terminal-card emit path). Errors from cleanup are swallowed and
 * logged through the provided logger — the terminal card always wins.
 *
 * Trace: `docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md` §C-5.
 */

interface CleanupLogger {
  warn: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Default cleanup window. Mirrors `TurnSurface.end`'s 3-second snapshot
 * race — keeps the entire terminal-rail bounded under ~3s on the slowest
 * sane operator timing while still allowing healthy cleanups (~tens of
 * ms) to finish synchronously.
 */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 3000;

/**
 * Run `cleanup()` with a finite timeout.
 *
 * Resolves when either (a) the inner cleanup resolves, or (b) the
 * timeout elapses. The inner Promise keeps running in the background on
 * timeout — we attach a `.catch` so a late rejection doesn't surface as
 * an `unhandledRejection` warning, but the caller's `finally` block has
 * already moved on by then.
 *
 * Synchronous throws from `cleanup` are caught and converted into a
 * resolved race winner so the caller doesn't need to wrap every call
 * site. Async rejections from `cleanup` are logged and swallowed.
 *
 * The function ALWAYS resolves — never rejects — so the caller can
 * safely `await` it without a try/catch and rely on `finally` semantics.
 */
export async function cleanupWithTimeout(
  cleanup: () => Promise<void>,
  timeoutMs: number = DEFAULT_CLEANUP_TIMEOUT_MS,
  logger?: CleanupLogger,
): Promise<void> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timerId = setTimeout(() => {
      logger?.warn('cleanup-with-timeout: cleanup did not finish in time', {
        timeoutMs,
      });
      resolve();
    }, timeoutMs);
  });

  // `cleanup()` may throw synchronously before returning a Promise. Wrap
  // in Promise.resolve(...).then(...) so the caller sees a uniform
  // never-rejecting race.
  let cleanupPromise: Promise<void>;
  try {
    cleanupPromise = Promise.resolve(cleanup());
  } catch (err) {
    logger?.warn('cleanup-with-timeout: cleanup threw synchronously', {
      error: (err as { message?: string })?.message ?? String(err),
    });
    if (timerId) clearTimeout(timerId);
    return;
  }

  // Attach a no-op catch so a late rejection (after the timer won) does
  // NOT surface as an `unhandledRejection`. Operators still see the
  // failure via the logger.warn below.
  cleanupPromise.catch((err) => {
    logger?.warn('cleanup-with-timeout: cleanup rejected', {
      error: (err as { message?: string })?.message ?? String(err),
    });
  });

  await Promise.race([cleanupPromise, timeoutPromise]);

  // Clear the timer if cleanup won. Idempotent if the timer already fired.
  if (timerId) clearTimeout(timerId);
}
