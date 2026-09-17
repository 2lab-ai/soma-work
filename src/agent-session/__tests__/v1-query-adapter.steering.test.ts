/**
 * V1QueryAdapter steering pass-throughs (user-steering WU1).
 *
 * The host drives mid-turn injection through the session adapter, not by
 * reaching into `ClaudeHandler` — the adapter is the seam that already owns
 * `cancel()`/`dispose()`. The port is injected (`TurnSteeringPort`), so the
 * adapter stays free of any SDK/handler import, and every method degrades to a
 * no-answer (`false` / `undefined`) when no port is wired.
 */

import { describe, expect, it, vi } from 'vitest';
import type { StreamExecutorLike } from '../v1-query-adapter.js';
import { V1QueryAdapter } from '../v1-query-adapter.js';

function createExecutor(): StreamExecutorLike {
  return { execute: vi.fn().mockResolvedValue({ success: true, messageCount: 1 }) };
}

function createSteering() {
  return {
    steerTurn: vi.fn().mockReturnValue(true),
    interruptTurn: vi.fn().mockResolvedValue({ stillQueued: ['q-1'], cancelled: [] }),
    cancelSteeredMessage: vi.fn().mockResolvedValue(true),
  };
}

describe('V1QueryAdapter steering pass-throughs (user-steering WU1)', () => {
  it('steer() forwards the session key and input to the port', () => {
    const steering = createSteering();
    const adapter = new V1QueryAdapter({
      streamExecutor: createExecutor(),
      executeParams: { sessionKey: 'C1-171.100', abortController: new AbortController() },
      steering,
    });

    expect(adapter.steer({ uuid: 'u-1', text: 'do X' })).toBe(true);
    expect(steering.steerTurn).toHaveBeenCalledWith('C1-171.100', { uuid: 'u-1', text: 'do X' });
  });

  it('interrupt() returns the SDK receipt and does NOT abort the controller', async () => {
    const steering = createSteering();
    const abortController = new AbortController();
    const adapter = new V1QueryAdapter({
      streamExecutor: createExecutor(),
      executeParams: { sessionKey: 'C1-171.100', abortController },
      steering,
    });

    await expect(adapter.interrupt()).resolves.toEqual({ stillQueued: ['q-1'], cancelled: [] });
    expect(steering.interruptTurn).toHaveBeenCalledWith('C1-171.100');
    expect(abortController.signal.aborted).toBe(false);
  });

  it('cancelSteered() forwards the uuid', async () => {
    const steering = createSteering();
    const adapter = new V1QueryAdapter({
      streamExecutor: createExecutor(),
      executeParams: { sessionKey: 'C1-171.100', abortController: new AbortController() },
      steering,
    });

    await expect(adapter.cancelSteered('u-2')).resolves.toBe(true);
    expect(steering.cancelSteeredMessage).toHaveBeenCalledWith('C1-171.100', 'u-2');
  });

  it('degrades safely when no steering port is wired', async () => {
    const adapter = new V1QueryAdapter({
      streamExecutor: createExecutor(),
      executeParams: { sessionKey: 'C1-171.100', abortController: new AbortController() },
    });

    expect(adapter.steer({ uuid: 'u-1', text: 'do X' })).toBe(false);
    await expect(adapter.interrupt()).resolves.toBeUndefined();
    await expect(adapter.cancelSteered('u-1')).resolves.toBe(false);
  });

  it('cancel()/dispose() keep their abort semantics', () => {
    const abortController = new AbortController();
    const abort = vi.spyOn(abortController, 'abort');
    const adapter = new V1QueryAdapter({
      streamExecutor: createExecutor(),
      executeParams: { sessionKey: 'C1-171.100', abortController },
      steering: createSteering(),
    });

    adapter.cancel();
    expect(abort).toHaveBeenLastCalledWith('user-stop');
    adapter.dispose();
    expect(abort).toHaveBeenLastCalledWith('session-close');
  });
});
