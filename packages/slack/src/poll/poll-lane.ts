/**
 * Per-key in-process serial lane.
 *
 * Every mutation of a poll (vote, close, cancel, scheduler close, delivery
 * retry) runs through `run(pollId, fn)`. Tasks for the same key execute
 * strictly in call order, including their awaited Slack calls, so a stale
 * open-card render can never land after the result card.
 *
 * Callers must invoke `run` synchronously at entry (before their first
 * `await`) — the lane slot is claimed at call time, not when the task starts.
 * A failing task rejects its own promise and never blocks its successors.
 * The slot is dropped once the tail settles, so idle keys hold no memory.
 */
export class PollLane {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(
      () => fn(),
      () => fn(),
    );
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Number of keys with in-flight work (test/diagnostic). */
  size(): number {
    return this.tails.size;
  }
}
