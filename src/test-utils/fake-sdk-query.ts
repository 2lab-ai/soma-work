/**
 * Dress a scripted frame generator as the SDK's `Query`.
 *
 * One difference from a bare async generator matters to the host: the query's
 * `return()` runs the SDK's cleanup first — the CLI is closed, which ends the
 * read the stream is parked in — so it answers while a read is outstanding. A
 * bare generator queues `return()` behind that read: forever, when the script
 * is waiting on the test. The host reads the frames ahead of its consumer
 * (`pumpFrames`), so at the end of a turn a read is nearly always outstanding.
 *
 * The script is still told (`return()` on it, not awaited): one suspended at a
 * `yield` runs its `finally` at once, as before.
 */
export function asSdkQuery<T, C extends object>(
  frames: AsyncGenerator<T, void, unknown>,
  controls: C,
): AsyncGenerator<T, void, unknown> & C {
  const end = frames.return.bind(frames);
  return Object.assign(frames, controls, {
    return: (value?: unknown) => {
      void end(value as undefined).catch(() => undefined);
      return Promise.resolve({ done: true as const, value: undefined });
    },
  }) as AsyncGenerator<T, void, unknown> & C;
}
