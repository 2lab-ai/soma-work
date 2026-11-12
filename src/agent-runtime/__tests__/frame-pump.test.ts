/**
 * `pumpFrames` — read a frame stream as fast as it produces, hand the frames on in order.
 *
 * The turn's consumer renders each frame before it asks for the next (Slack round-trips behind a shared rate
 * limit), so under load it runs many seconds behind the CLI (measured 2026-11-12: 12–14 s). Facts that must not wait
 * for the rendering — "the model has read this message", "the CLI has already ended this turn" — are told at
 * ARRIVAL; everything else keeps its order and its timing.
 */
import { describe, expect, it, vi } from 'vitest';
import { pumpFrames } from '../frame-pump';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function* source(frames: unknown[], opts: { failWith?: Error; onReturn?: () => void } = {}) {
  try {
    for (const frame of frames) yield frame;
    if (opts.failWith) throw opts.failWith;
  } finally {
    opts.onReturn?.();
  }
}

describe('pumpFrames', () => {
  it('hands the frames on in the order they came', async () => {
    const seen: unknown[] = [];
    for await (const frame of pumpFrames(source([1, 2, 3]), () => {})) seen.push(frame);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('tells of every frame when it ARRIVES — a consumer that has not asked yet does not hold it back', async () => {
    const arrived: unknown[] = [];
    const pumped = pumpFrames(source(['a', 'b', 'c']), (frame) => arrived.push(frame));
    const reader = pumped[Symbol.asyncIterator]();

    expect((await reader.next()).value).toBe('a');
    await tick(); // the consumer is busy rendering 'a'

    expect(arrived).toEqual(['a', 'b', 'c']);
    expect((await reader.next()).value).toBe('b');
    expect((await reader.next()).value).toBe('c');
    expect((await reader.next()).done).toBe(true);
  });

  it('reads nothing before the consumer starts', async () => {
    const arrived: unknown[] = [];
    pumpFrames(source(['a']), (frame) => arrived.push(frame));
    await tick();
    expect(arrived).toEqual([]);
  });

  it('a failure of the stream surfaces after the frames that came before it', async () => {
    const seen: unknown[] = [];
    const boom = new Error('cli died');
    await expect(
      (async () => {
        for await (const frame of pumpFrames(source([1, 2], { failWith: boom }), () => {})) {
          seen.push(frame);
          await tick();
        }
      })(),
    ).rejects.toBe(boom);
    expect(seen).toEqual([1, 2]);
  });

  it('a consumer that stops early ends the source and waits for it, though a read is outstanding', async () => {
    // The shape of the SDK's query: a read that stays parked while the CLI
    // works, and a `return()` that ends it (the CLI is closed) and answers.
    let endRead: (result: IteratorResult<number>) => void = () => {};
    let torndown = false;
    let reads = 0;
    const cli: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve({ done: false, value: 1 });
          return new Promise<IteratorResult<number>>((resolve) => {
            endRead = resolve;
          });
        },
        return: async () => {
          await tick(); // the CLI takes a moment to exit
          torndown = true;
          endRead({ done: true, value: undefined });
          return { done: true, value: undefined };
        },
      }),
    };
    for await (const frame of pumpFrames(cli, () => {})) {
      expect(frame).toBe(1);
      expect(reads).toBe(2); // the next read is already out
      break;
    }
    // Leaving the loop waited for the source's teardown.
    expect(torndown).toBe(true);
  });

  it('ends a source that finished on its own, too', async () => {
    const onReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
    const frames = [1, 2];
    const finished: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          frames.length > 0 ? { done: false, value: frames.shift() as number } : { done: true, value: undefined },
        return: onReturn,
      }),
    };
    const seen: number[] = [];
    for await (const frame of pumpFrames(finished, () => {})) seen.push(frame);
    expect(seen).toEqual([1, 2]);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('a listener that throws loses no frame', async () => {
    const seen: unknown[] = [];
    const pumped = pumpFrames(source([1, 2]), () => {
      throw new Error('listener bug');
    });
    for await (const frame of pumped) seen.push(frame);
    expect(seen).toEqual([1, 2]);
  });
});
