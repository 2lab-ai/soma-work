/**
 * Run a turn's control loop at the pace of the CLI, not at the pace of whoever reads it (#1473).
 *
 * WHY: the turn's control loop (`ClaudeHandler.streamSdkQuery`) decides everything that moves a turn along — a
 * `result` is handled (pushes refused while it was in flight are taken again, and the refused one is offered
 * again), a held turn's keepalive and grace decisions, the steer settlement, the input's close — and then yields
 * the frame to the renderer. The renderer asks for the next frame only after Slack drew this one, through one
 * serial lane every session shares. On a busy host that lane ran about an hour behind (#1470): the loop handled each
 * `result` an hour late, and a message pushed meanwhile stayed refused the whole time.
 *
 * `runAhead` pulls the loop as fast as it runs. What the loop yields waits, in order, for the renderer. The frames
 * were already read ahead of the loop (`pumpFrames`); now the loop runs ahead too, and only the drawing waits.
 *
 * - Nothing is pulled before the reader's first `next()`.
 * - Values reach the reader in the order the loop yielded them; a failure of the loop surfaces after the values
 *   before it — the order a plain `for await` gives.
 * - A reader that stops early (`return()`) does not wait for a read the loop has outstanding: the waiting `next()`
 *   answers `done` at once, `onAbandon` is told (it ends what the loop waits on — the query — so the loop reaches
 *   its own end and its cleanup runs now, not when the next frame happens to arrive), and the loop's own
 *   `return()` is awaited. A loop that ended by itself is not told again.
 * - `onYield` hears each value the moment the loop yields it, `onTake` the moment the reader takes it: the
 *   difference is how long the renderer kept it waiting. Both are observers: synchronous, and a throw is dropped.
 *
 * Neutral zone: no SDK import.
 */

type Slot<T> = { kind: 'value'; value: T } | { kind: 'end' } | { kind: 'error'; error: unknown };

export interface RunAheadOptions<T> {
  /** The loop yielded `value` (it now waits for the reader). */
  onYield?: (value: T) => void;
  /** The reader took `value`. */
  onTake?: (value: T) => void;
  /**
   * The reader stopped while the loop still runs. End what the loop waits on, so it reaches its end now. Called
   * once, before the loop's `return()` is awaited; a throw (or a rejection) is dropped.
   */
  onAbandon?: () => unknown;
}

export function runAhead<T>(
  loop: AsyncGenerator<T, void, unknown>,
  options: RunAheadOptions<T> = {},
): AsyncGenerator<T, void, unknown> {
  const buffered: Slot<T>[] = [];
  /** Readers waiting for a value, in the order they asked (two `next()` calls in a row each get their own). */
  const waiters: Array<(slot: Slot<T> | undefined) => void> = [];
  let started = false;
  /** The reader is done: what the loop still yields is dropped. */
  let stopped = false;
  /** The loop ended or failed by itself: there is nothing left to tell it. */
  let loopOver = false;

  const observe = (hook: ((value: T) => void) | undefined, value: T) => {
    if (!hook) return;
    try {
      hook(value);
    } catch {
      // An observer's fault is not the turn's.
    }
  };
  const put = (slot: Slot<T>) => {
    if (stopped) return;
    const w = waiters.shift();
    if (w) {
      w(slot);
      return;
    }
    buffered.push(slot);
  };

  const pull = async () => {
    try {
      for (;;) {
        const next = await loop.next();
        if (next.done) {
          loopOver = true;
          put({ kind: 'end' });
          return;
        }
        if (stopped) return;
        observe(options.onYield, next.value);
        put({ kind: 'value', value: next.value });
      }
    } catch (error) {
      loopOver = true;
      put({ kind: 'error', error });
    }
  };

  /** The loop is over for every reader: any other waiting `next()` answers `done`. */
  const finish = () => {
    stopped = true;
    for (const w of waiters.splice(0)) w(undefined);
  };
  const deliver = (slot: Slot<T> | undefined): IteratorResult<T, void> => {
    if (!slot || slot.kind === 'end') {
      finish();
      return { done: true, value: undefined };
    }
    if (slot.kind === 'error') {
      finish();
      throw slot.error;
    }
    observe(options.onTake, slot.value);
    return { done: false, value: slot.value };
  };

  const iterator = {
    async next(): Promise<IteratorResult<T, void>> {
      if (!started) {
        started = true;
        void pull();
      }
      const slot = buffered.shift();
      if (slot) return deliver(slot);
      if (stopped) return { done: true, value: undefined };
      return deliver(
        await new Promise<Slot<T> | undefined>((resolve) => {
          waiters.push(resolve);
        }),
      );
    },
    async return(): Promise<IteratorResult<T, void>> {
      const wasStopped = stopped;
      stopped = true;
      buffered.length = 0;
      for (const w of waiters.splice(0)) w(undefined);
      if (wasStopped || loopOver) return { done: true, value: undefined };
      if (!started) {
        // Never pulled: the loop has not started, and ending it runs nothing but its own `finally`.
        await loop.return(undefined);
        return { done: true, value: undefined };
      }
      try {
        await options.onAbandon?.();
      } catch {
        // The loop's own return below still runs.
      }
      // Not caught: a teardown that failed is no clean exit — as with `for await`.
      await loop.return(undefined);
      return { done: true, value: undefined };
    },
    async throw(error: unknown): Promise<IteratorResult<T, void>> {
      await iterator.return(undefined);
      throw error;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  } as AsyncGenerator<T, void, unknown>;
  // `await using` (where the runtime has it): disposing is stopping.
  const asyncDispose = (Symbol as { asyncDispose?: symbol }).asyncDispose;
  if (asyncDispose) {
    (iterator as unknown as Record<symbol, () => Promise<void>>)[asyncDispose] = async () => {
      await iterator.return(undefined);
    };
  }
  return iterator;
}
