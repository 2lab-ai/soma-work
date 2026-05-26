/**
 * Unit tests for `runWithTimeout` — the generic bounded-operation helper
 * introduced for C-3/C-4/C-6 hang-path fixes in
 * `packages/slack/src/pipeline/stream-executor-cleanup-helpers.ts`.
 *
 * Trace: docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md §C-3/C-4/C-6.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithTimeout } from '../stream-executor-cleanup-helpers';

describe('runWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves with `completed` when work finishes before the timeout', async () => {
    const result = await runWithTimeout(async () => 'ok', 5000, { what: 'fast work' });
    expect(result).toEqual({ kind: 'completed', value: 'ok' });
  });

  it('resolves with `timedOut` when work never resolves', async () => {
    const onTimeout = vi.fn();
    const warn = vi.fn();
    const work = vi.fn(() => new Promise<string>(() => undefined));

    const promise = runWithTimeout(work, 100, { what: 'stuck call', logger: { warn }, onTimeout });

    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;

    expect(result).toEqual({ kind: 'timedOut' });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('stuck call'),
      expect.objectContaining({ timeoutMs: 100 }),
    );
  });

  it('swallows a synchronous throw from work and returns `timedOut`', async () => {
    const warn = vi.fn();
    const result = await runWithTimeout(
      () => {
        throw new Error('sync explosion');
      },
      100,
      { what: 'sync-thrower', logger: { warn } },
    );
    expect(result).toEqual({ kind: 'timedOut' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('threw synchronously'),
      expect.objectContaining({ error: 'sync explosion' }),
    );
  });

  it('attaches no-op catch to late-rejecting work so the rejection is logged, not unhandled', async () => {
    const warn = vi.fn();
    let rejectInner!: (err: Error) => void;
    const innerPromise = new Promise<string>((_, reject) => {
      rejectInner = reject;
    });

    const promise = runWithTimeout(() => innerPromise, 100, { what: 'late-rejecter', logger: { warn } });

    // Timer wins.
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    expect(result).toEqual({ kind: 'timedOut' });

    // Inner rejects AFTER timeout — must be caught by our no-op catch.
    rejectInner(new Error('late explosion'));
    // Allow microtask queue to drain so the catch fires.
    await vi.advanceTimersByTimeAsync(0);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
      expect.objectContaining({ error: 'late explosion' }),
    );
  });

  it('a throwing onTimeout callback does not crash the timeout handler', async () => {
    const warn = vi.fn();
    const onTimeout = vi.fn(() => {
      throw new Error('onTimeout blew up');
    });

    const promise = runWithTimeout(() => new Promise<string>(() => undefined), 100, {
      what: 'noisy onTimeout',
      logger: { warn },
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    expect(result).toEqual({ kind: 'timedOut' });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('onTimeout threw'),
      expect.objectContaining({ error: 'onTimeout blew up' }),
    );
  });
});
