/**
 * U8 — the follow-up queue must learn that a session is being stopped BEFORE
 * the turn is aborted, and a failure to record that must block the abort.
 *
 * Why a pre-abort observer instead of post-abort cleanup:
 *   - The queue's freeze is DURABLE state. If the abort lands first and the
 *     freeze write then fails, the queue keeps draining into a session the
 *     user just stopped — the failure is invisible and the damage is done.
 *     Fail-closed: observe first, and if the observer refuses, nothing is
 *     aborted and nothing in the map is touched.
 *   - The observer must also run when there is NO in-flight controller. "Stop"
 *     on an idle session is exactly when the queue most needs to freeze; a
 *     controller-gated hook would silently skip it.
 *
 * Why only the STOP-class reasons (`user-stop` / `session-close` / `shutdown`):
 *   `Send now` (`user-interrupted`) and mid-turn steering (`supersede`) abort a
 *   turn precisely so the NEXT item can run. Freezing the queue there would
 *   strand the remainder of the queue the user is trying to advance.
 */

import { describe, expect, it, vi } from 'vitest';
import { type RequestAbortReason, RequestCoordinator } from '../request-coordinator';

const SESSION = 'C1:thread1';

describe('RequestCoordinator — beforeAbort observer (U8)', () => {
  it('constructs with no arguments (existing callers unchanged)', () => {
    const coordinator = new RequestCoordinator();
    const controller = new AbortController();
    coordinator.setController(SESSION, controller);

    expect(coordinator.abortSession(SESSION)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('user-stop');
  });

  it('observes a stop even when there is NO active controller', () => {
    const beforeAbort = vi.fn();
    const coordinator = new RequestCoordinator({ beforeAbort });

    // Idle session: nothing to abort, but the queue still has to freeze.
    const aborted = coordinator.abortSession(SESSION, 'user-stop');

    expect(aborted).toBe(false);
    expect(beforeAbort).toHaveBeenCalledTimes(1);
    expect(beforeAbort).toHaveBeenCalledWith(SESSION, 'user-stop');
  });

  it('observes before aborting, not after', () => {
    const order: string[] = [];
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => order.push('abort'));
    const coordinator = new RequestCoordinator({
      beforeAbort: () => order.push('observe'),
    });
    coordinator.setController(SESSION, controller);

    coordinator.abortSession(SESSION, 'session-close');

    expect(order).toEqual(['observe', 'abort']);
  });

  it('a refusing observer blocks the abort and leaves the map untouched', () => {
    const failure = new Error('queue freeze write failed');
    const coordinator = new RequestCoordinator({
      beforeAbort: () => {
        throw failure;
      },
    });
    const controller = new AbortController();
    coordinator.setController(SESSION, controller);

    // Loud, not silent: the caller must see that the stop did not take.
    expect(() => coordinator.abortSession(SESSION, 'user-stop')).toThrow(failure);

    expect(controller.signal.aborted).toBe(false);
    expect(coordinator.getController(SESSION)).toBe(controller);
    expect(coordinator.isRequestActive(SESSION)).toBe(true);
    expect(coordinator.getLastActivityAt(SESSION)).toBeDefined();
  });

  it.each<RequestAbortReason>([
    'user-interrupted',
    'supersede',
  ])('does NOT observe a %s abort (the queue must keep going)', (reason) => {
    const beforeAbort = vi.fn();
    const coordinator = new RequestCoordinator({ beforeAbort });
    const controller = new AbortController();
    coordinator.setController(SESSION, controller);

    expect(coordinator.abortSession(SESSION, reason)).toBe(true);

    expect(beforeAbort).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(reason);
  });

  it.each<RequestAbortReason>([
    'stall-timeout',
    'ghost-session',
  ])('does NOT observe a %s abort (not a user stop)', (reason) => {
    const beforeAbort = vi.fn();
    const coordinator = new RequestCoordinator({ beforeAbort });
    coordinator.setController(SESSION, new AbortController());

    coordinator.abortSession(SESSION, reason);

    expect(beforeAbort).not.toHaveBeenCalled();
  });
});

describe('RequestCoordinator — beforeAbort on clearAll (U8)', () => {
  it('observes every tracked session with the shutdown reason', () => {
    const beforeAbort = vi.fn();
    const coordinator = new RequestCoordinator({ beforeAbort });
    const a = new AbortController();
    const b = new AbortController();
    coordinator.setController('C1:t1', a);
    coordinator.setController('C2:t2', b);

    coordinator.clearAll();

    expect(beforeAbort).toHaveBeenCalledTimes(2);
    expect(beforeAbort).toHaveBeenCalledWith('C1:t1', 'shutdown');
    expect(beforeAbort).toHaveBeenCalledWith('C2:t2', 'shutdown');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(coordinator.getActiveCount()).toBe(0);
  });

  it('keeps a refused session tracked and un-aborted while the rest still stop', () => {
    const failure = new Error('queue freeze write failed');
    const coordinator = new RequestCoordinator({
      beforeAbort: (sessionKey) => {
        if (sessionKey === 'C_REFUSED:t') throw failure;
      },
    });
    const refused = new AbortController();
    const ok = new AbortController();
    coordinator.setController('C_REFUSED:t', refused);
    coordinator.setController('C_OK:t', ok);

    // The shutdown still reports the failure — a swallowed freeze failure is
    // the thing this seam exists to prevent.
    expect(() => coordinator.clearAll()).toThrow(failure);

    // Refused session: untouched, still tracked (its queue never froze).
    expect(refused.signal.aborted).toBe(false);
    expect(coordinator.getController('C_REFUSED:t')).toBe(refused);
    // Unrelated session: shutdown proceeded.
    expect(ok.signal.aborted).toBe(true);
    expect(coordinator.getController('C_OK:t')).toBeUndefined();
    expect(coordinator.getActiveCount()).toBe(1);
  });

  it('clearAll with no observer keeps its historical behaviour', () => {
    const coordinator = new RequestCoordinator();
    const a = new AbortController();
    coordinator.setController('C1:t1', a);

    coordinator.clearAll();

    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBe('shutdown');
    expect(coordinator.getActiveCount()).toBe(0);
    expect(coordinator.getLastActivityAt('C1:t1')).toBeUndefined();
  });
});
