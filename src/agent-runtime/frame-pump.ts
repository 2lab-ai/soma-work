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
 * - A consumer that stops early (`break`, `return`, a throw) ends the source:
 *   its `return()` is called and awaited, and a teardown that fails is the
 *   consumer's to hear — all as a plain `for await` does. A read is usually
 *   outstanding then: the source must answer `return()` all the same. A
 *   source that ended or failed by itself is not told again.
 * - `onArrival` is synchronous, and a throw from it is dropped: it is an
 *   observer, never part of the stream.
 *
 * Neutral zone: no SDK import.
 */
type Slot<T> = { kind: 'frame'; frame: T } | { kind: 'end' } | { kind: 'error'; error: unknown };

export async function* pumpFrames<T>(
  source: AsyncIterable<T>,
  onArrival: (frame: T) => void,
): AsyncGenerator<T, void, unknown> {
  const reader = source[Symbol.asyncIterator]();
  const buffered: Slot<T>[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  /** The source ended or failed by itself: there is nothing left to tell it. */
  let sourceOver = false;
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
      if (slot.kind === 'end') {
        sourceOver = true;
        return;
      }
      if (slot.kind === 'error') {
        sourceOver = true;
        throw slot.error;
      }
      yield slot.frame;
    }
  } finally {
    // The consumer is done: whatever the read-ahead still gets is dropped.
    stopped = true;
    buffered.length = 0;
    // It stopped early: the source is told, and its teardown awaited — part of
    // the consumer's own, as with `for await`. Not caught: a teardown that
    // failed is no clean exit. (The read-ahead is usually parked in a read
    // here, so the source's `return()` must answer while one is outstanding —
    // a bare async generator does not: it queues the return behind the read.)
    if (!sourceOver) await reader.return?.();
  }
}
