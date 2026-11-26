import { describe, expect, it, vi } from 'vitest';
import { runAhead } from '../run-ahead';

/**
 * #1473 — the turn's control loop runs at the CLI's pace; only the drawing waits for Slack.
 */

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('runAhead — the loop does not wait for its reader', () => {
  it('runs the loop ahead of a reader that is still drawing the first value', async () => {
    const handled: number[] = [];
    async function* loop() {
      for (const n of [1, 2, 3]) {
        handled.push(n); // what the control loop decides on each frame
        yield n;
      }
    }
    const it = runAhead(loop());

    expect(await it.next()).toEqual({ done: false, value: 1 });
    // The reader is still drawing 1 (it has not asked again): the loop has handled every frame anyway.
    await tick();
    expect(handled).toEqual([1, 2, 3]);

    expect(await it.next()).toEqual({ done: false, value: 2 });
    expect(await it.next()).toEqual({ done: false, value: 3 });
    expect(await it.next()).toEqual({ done: true, value: undefined });
  });

  it('two next() calls in a row each get their own value, in order (round 1, astra)', async () => {
    const gate = deferred();
    async function* loop() {
      await gate.promise;
      yield 1;
      yield 2;
    }
    const reader = runAhead(loop());
    const a = reader.next();
    const b = reader.next();
    gate.resolve();
    expect(await a).toEqual({ done: false, value: 1 });
    expect(await b).toEqual({ done: false, value: 2 });
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });

  it('pulls nothing before the first next()', async () => {
    const started = vi.fn();
    async function* loop() {
      started();
      yield 1;
    }
    runAhead(loop());
    await tick();
    expect(started).not.toHaveBeenCalled();
  });

  it('a failure of the loop reaches the reader after the values before it', async () => {
    async function* loop() {
      yield 1;
      yield 2;
      throw new Error('boom');
    }
    const it = runAhead(loop());
    expect((await it.next()).value).toBe(1);
    await tick();
    expect((await it.next()).value).toBe(2);
    await expect(it.next()).rejects.toThrow('boom');
    expect(await it.next()).toEqual({ done: true, value: undefined });
  });

  it('tells when the loop yielded and when the reader took it — the time the drawing kept it waiting', async () => {
    const events: string[] = [];
    async function* loop() {
      yield 'a';
      yield 'b';
    }
    const it = runAhead(loop(), {
      onYield: (v) => events.push(`yield:${v}`),
      onTake: (v) => events.push(`take:${v}`),
    });
    await it.next();
    await tick();
    events.push('reader draws a');
    await it.next();
    expect(events).toEqual(['yield:a', 'take:a', 'yield:b', 'reader draws a', 'take:b']);
  });

  it('an observer that throws changes nothing', async () => {
    async function* loop() {
      yield 1;
    }
    const it = runAhead(loop(), {
      onYield: () => {
        throw new Error('observer');
      },
      onTake: () => {
        throw new Error('observer');
      },
    });
    expect(await it.next()).toEqual({ done: false, value: 1 });
  });
});

describe('runAhead — a reader that stops does not wait for the next frame', () => {
  it('ends what the loop waits on, and the loop cleans up now', async () => {
    const frame = deferred<number | undefined>();
    const cleanup = vi.fn();
    async function* loop() {
      try {
        yield 1;
        // The CLI is silent: the loop waits on its next frame.
        const next = await frame.promise;
        if (next !== undefined) yield next;
      } finally {
        cleanup();
      }
    }
    const onAbandon = vi.fn(() => frame.resolve(undefined)); // closing the query ends the read
    const it = runAhead(loop(), { onAbandon });
    expect((await it.next()).value).toBe(1);
    await tick();

    await it.return(undefined);

    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('a next() waiting when the reader stops answers done at once', async () => {
    const frame = deferred<number>();
    async function* loop() {
      yield await frame.promise;
    }
    const it = runAhead(loop(), { onAbandon: () => frame.resolve(0) });
    const waiting = it.next();
    await tick();
    const stopping = it.return(undefined);
    expect(await waiting).toEqual({ done: true, value: undefined });
    await stopping;
  });

  it('what the loop yields after the reader stopped is dropped', async () => {
    const gate = deferred();
    async function* loop() {
      yield 1;
      await gate.promise;
      yield 2;
    }
    const it = runAhead(loop(), { onAbandon: () => gate.resolve() });
    expect((await it.next()).value).toBe(1);
    await it.return(undefined);
    expect(await it.next()).toEqual({ done: true, value: undefined });
  });

  it('a loop that ended by itself is not told again', async () => {
    async function* loop() {
      yield 1;
    }
    const onAbandon = vi.fn();
    const it = runAhead(loop(), { onAbandon });
    await it.next();
    await tick();
    await it.return(undefined);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('a loop never started ends without being told to abandon anything', async () => {
    const onAbandon = vi.fn();
    async function* loop() {
      yield 1;
    }
    const it = runAhead(loop(), { onAbandon });
    expect(await it.return(undefined)).toEqual({ done: true, value: undefined });
    expect(onAbandon).not.toHaveBeenCalled();
  });
});
