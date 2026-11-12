/**
 * Read a frame stream as fast as it produces; hand the frames on in order.
 *
 * WHY: the consumer of a turn's stream renders each frame before it asks for
 * the next one — Slack round-trips, every one behind a rate limit all sessions
 * share. Under load it runs many seconds behind the CLI (measured 2026-11-12:
 * 12–14 s). Two facts must not wait for the rendering:
 *   - "the model has read this message" — a steered row kept saying it was
 *     waiting while the model was already answering it, and a `Send now`
 *     pressed in that gap killed the turn that was running that very message;
 *   - "the CLI has already ended this turn" — a message pushed after that is
 *     taken by the CLI as a turn of its own, which the host then cuts when it
 *     gets to the result it had not processed yet.
 * `onArrival` is told of each frame the moment the source yields it. The
 * consumer still gets every frame, in the same order, when it asks.
 *
 * Reading ahead holds back nothing the source was not already holding: the SDK
 * transport reads the CLI's output whether or not anyone iterates.
 *
 * - Nothing is read before the consumer's first `next()`.
 * - A failure of the source surfaces after the frames that came before it —
 *   the order a plain `for await` gives.
 * - When the consumer is done — the end, a failure, or stopping early
 *   (`break`, `return`, a throw) — the source's `return()` is called and
 *   awaited, as a plain `for await` does on an early stop. A read is usually
 *   outstanding then: the source must answer `return()` all the same.
 * - `onArrival` is synchronous, and a throw from it is dropped: it is an
 *   observer, never part of the stream.
 *
 * Neutral zone: no SDK import.
 */
export function pumpFrames<T>(source: AsyncIterable<T>, onArrival: (frame: T) => void): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => pump(source, onArrival),
  };
}

type Slot<T> = { kind: 'frame'; frame: T } | { kind: 'end' } | { kind: 'error'; error: unknown };

async function* pump<T>(source: AsyncIterable<T>, onArrival: (frame: T) => void): AsyncGenerator<T, void, unknown> {
  const reader = source[Symbol.asyncIterator]();
  const buffered: Slot<T>[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  const put = (slot: Slot<T>) => {
    buffered.push(slot);
    const w = wake;
    wake = undefined;
    w?.();
  };

  // The read-ahead: runs for the life of the stream, never rejects.
  void (async () => {
    try {
      for (;;) {
        const next = await reader.next();
        if (stopped) return;
        if (next.done) {
          put({ kind: 'end' });
          return;
        }
        try {
          onArrival(next.value);
        } catch {
          // An observer's fault is not the stream's.
        }
        put({ kind: 'frame', frame: next.value });
      }
    } catch (error) {
      if (!stopped) put({ kind: 'error', error });
    }
  })();

  try {
    for (;;) {
      const slot = buffered.shift();
      if (!slot) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      if (slot.kind === 'end') return;
      if (slot.kind === 'error') throw slot.error;
      yield slot.frame;
    }
  } finally {
    // The consumer is done (the end, a failure, or it stopped early): the
    // source is told, and whatever the read-ahead still gets is dropped.
    stopped = true;
    buffered.length = 0;
    try {
      // Awaited, as `for await` awaits it: the source's teardown is part of the
      // consumer's. The read-ahead is usually parked in a read at this point,
      // so the source's `return()` must answer while one is outstanding (a
      // bare async generator does not — it queues the return behind the read).
      await reader.return?.();
    } catch {
      // A source that cannot be told it is over is over all the same.
    }
  }
}
