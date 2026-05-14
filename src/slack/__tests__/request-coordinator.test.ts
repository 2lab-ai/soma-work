import { beforeEach, describe, expect, it } from 'vitest';
import { RequestCoordinator } from '../request-coordinator';

describe('RequestCoordinator', () => {
  let coordinator: RequestCoordinator;

  beforeEach(() => {
    coordinator = new RequestCoordinator();
  });

  describe('controller management', () => {
    it('should store and retrieve controller', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();

      coordinator.setController(sessionKey, controller);

      expect(coordinator.getController(sessionKey)).toBe(controller);
    });

    it('should return undefined for non-existent session', () => {
      expect(coordinator.getController('nonexistent')).toBeUndefined();
    });

    it('should remove controller', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();

      coordinator.setController(sessionKey, controller);
      coordinator.removeController(sessionKey);

      expect(coordinator.getController(sessionKey)).toBeUndefined();
    });

    it('should replace existing controller', () => {
      const sessionKey = 'C123:T456';
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      coordinator.setController(sessionKey, controller1);
      coordinator.setController(sessionKey, controller2);

      expect(coordinator.getController(sessionKey)).toBe(controller2);
    });
  });

  describe('session abort', () => {
    it('should abort active session and return true', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();
      let aborted = false;

      controller.signal.addEventListener('abort', () => {
        aborted = true;
      });

      coordinator.setController(sessionKey, controller);
      const result = coordinator.abortSession(sessionKey);

      expect(result).toBe(true);
      expect(aborted).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    });

    it('should return false for non-existent session', () => {
      const result = coordinator.abortSession('nonexistent');
      expect(result).toBe(false);
    });

    // Bug: aborting an active session must propagate the *reason* through
    // controller.signal.reason so downstream consumers (handleError) can
    // tell a supersede-by-new-message apart from an explicit user-stop.
    // Before this fix the call site always invoked controller.abort()
    // with no argument, so handleError could never differentiate the two
    // and silently suppressed the "🔴 오류 발생" turn-completion card on a
    // stalled-turn supersede — leaving the user wondering whether the
    // turn was done or still hanging.
    it('forwards the supersede reason via controller.signal.reason', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();
      coordinator.setController(sessionKey, controller);

      const result = coordinator.abortSession(sessionKey, 'supersede');

      expect(result).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('supersede');
    });

    it('forwards the user-stop reason via controller.signal.reason', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();
      coordinator.setController(sessionKey, controller);

      const result = coordinator.abortSession(sessionKey, 'user-stop');

      expect(result).toBe(true);
      expect(controller.signal.reason).toBe('user-stop');
    });

    it('defaults to user-stop when no reason is given', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();
      coordinator.setController(sessionKey, controller);

      coordinator.abortSession(sessionKey);

      expect(controller.signal.reason).toBe('user-stop');
    });
  });

  describe('request status', () => {
    it('should correctly report active request status', () => {
      const sessionKey = 'C123:T456';

      expect(coordinator.isRequestActive(sessionKey)).toBe(false);

      coordinator.setController(sessionKey, new AbortController());

      expect(coordinator.isRequestActive(sessionKey)).toBe(true);

      coordinator.removeController(sessionKey);

      expect(coordinator.isRequestActive(sessionKey)).toBe(false);
    });

    it('should always allow new requests', () => {
      const sessionKey = 'C123:T456';
      coordinator.setController(sessionKey, new AbortController());

      // Even with active request, can start new one (queuing behavior)
      expect(coordinator.canStartRequest(sessionKey)).toBe(true);
    });
  });

  describe('active count', () => {
    it('should track active request count', () => {
      expect(coordinator.getActiveCount()).toBe(0);

      coordinator.setController('session1', new AbortController());
      expect(coordinator.getActiveCount()).toBe(1);

      coordinator.setController('session2', new AbortController());
      expect(coordinator.getActiveCount()).toBe(2);

      coordinator.removeController('session1');
      expect(coordinator.getActiveCount()).toBe(1);
    });
  });

  describe('activity tracking', () => {
    it('records last activity timestamp when a controller is set', () => {
      const sessionKey = 'C123:T456';
      const before = Date.now();
      coordinator.setController(sessionKey, new AbortController());
      const after = Date.now();
      const lastAt = coordinator.getLastActivityAt(sessionKey);
      expect(lastAt).toBeDefined();
      expect(lastAt!).toBeGreaterThanOrEqual(before);
      expect(lastAt!).toBeLessThanOrEqual(after);
    });

    it('updates last activity timestamp via touchSession', async () => {
      const sessionKey = 'C123:T456';
      coordinator.setController(sessionKey, new AbortController());
      const initial = coordinator.getLastActivityAt(sessionKey);
      expect(initial).toBeDefined();
      // Wait long enough that Date.now() advances reliably across hosts.
      await new Promise((r) => setTimeout(r, 5));
      coordinator.touchSession(sessionKey);
      const updated = coordinator.getLastActivityAt(sessionKey);
      expect(updated).toBeDefined();
      expect(updated!).toBeGreaterThan(initial!);
    });

    it('touchSession is a no-op for sessions without an active controller', () => {
      coordinator.touchSession('nonexistent');
      expect(coordinator.getLastActivityAt('nonexistent')).toBeUndefined();
    });

    it('clears activity timestamp when controller is removed', () => {
      const sessionKey = 'C123:T456';
      coordinator.setController(sessionKey, new AbortController());
      expect(coordinator.getLastActivityAt(sessionKey)).toBeDefined();
      coordinator.removeController(sessionKey);
      expect(coordinator.getLastActivityAt(sessionKey)).toBeUndefined();
    });
  });

  describe('clearAll', () => {
    it('should abort and clear all controllers', () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      coordinator.setController('session1', controller1);
      coordinator.setController('session2', controller2);

      coordinator.clearAll();

      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(true);
      expect(coordinator.getActiveCount()).toBe(0);
    });
  });
});
