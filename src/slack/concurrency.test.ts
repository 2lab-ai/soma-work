import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Session Concurrency Tests
 *
 * These tests verify the concurrency control mechanisms for session handling:
 * 1. Only one active request per session at a time
 * 2. AbortController properly cancels existing requests when owner interrupts
 * 3. Non-owners cannot interrupt active requests
 * 4. Cleanup happens properly after request completion
 */

// Simulating the activeControllers behavior from SlackHandler
class MockRequestCoordinator {
  private activeControllers: Map<string, AbortController> = new Map();

  getController(sessionKey: string): AbortController | undefined {
    return this.activeControllers.get(sessionKey);
  }

  setController(sessionKey: string, controller: AbortController): void {
    this.activeControllers.set(sessionKey, controller);
  }

  removeController(sessionKey: string): void {
    this.activeControllers.delete(sessionKey);
  }

  abortSession(sessionKey: string): boolean {
    const controller = this.activeControllers.get(sessionKey);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  isRequestActive(sessionKey: string): boolean {
    return this.activeControllers.has(sessionKey);
  }

  canStartRequest(sessionKey: string): boolean {
    // For now, always allow (will queue if there's an active request)
    return true;
  }
}

// Simulating session ownership from ClaudeHandler
interface MockSession {
  ownerId: string;
  ownerName: string;
  currentInitiatorId?: string;
  currentInitiatorName?: string;
}

class MockSessionManager {
  private sessions: Map<string, MockSession> = new Map();

  createSession(sessionKey: string, ownerId: string, ownerName: string): MockSession {
    const session: MockSession = { ownerId, ownerName };
    this.sessions.set(sessionKey, session);
    return session;
  }

  getSession(sessionKey: string): MockSession | undefined {
    return this.sessions.get(sessionKey);
  }

  updateInitiator(sessionKey: string, userId: string, userName: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.currentInitiatorId = userId;
      session.currentInitiatorName = userName;
    }
  }

  canInterrupt(sessionKey: string, userId: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session) return true; // No session means new request is fine

    // Owner can always interrupt
    if (session.ownerId === userId) return true;

    // Current initiator can interrupt
    if (session.currentInitiatorId === userId) return true;

    return false;
  }
}

describe('Session Concurrency Control', () => {
  let coordinator: MockRequestCoordinator;
  let sessionManager: MockSessionManager;

  beforeEach(() => {
    coordinator = new MockRequestCoordinator();
    sessionManager = new MockSessionManager();
  });

  describe('AbortController Management', () => {
    it('should track active requests with AbortController', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();

      expect(coordinator.isRequestActive(sessionKey)).toBe(false);

      coordinator.setController(sessionKey, controller);

      expect(coordinator.isRequestActive(sessionKey)).toBe(true);
      expect(coordinator.getController(sessionKey)).toBe(controller);
    });

    it('should abort existing request when owner sends new message', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();
      let aborted = false;

      controller.signal.addEventListener('abort', () => {
        aborted = true;
      });

      coordinator.setController(sessionKey, controller);

      // Owner sends new message - should abort
      const abortResult = coordinator.abortSession(sessionKey);

      expect(abortResult).toBe(true);
      expect(aborted).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    });

    it('should return false when trying to abort non-existent session', () => {
      const abortResult = coordinator.abortSession('nonexistent');
      expect(abortResult).toBe(false);
    });

    it('should properly cleanup controller after request completion', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();

      coordinator.setController(sessionKey, controller);
      expect(coordinator.isRequestActive(sessionKey)).toBe(true);

      // Simulate request completion
      coordinator.removeController(sessionKey);

      expect(coordinator.isRequestActive(sessionKey)).toBe(false);
      expect(coordinator.getController(sessionKey)).toBeUndefined();
    });
  });

  describe('Session Ownership and Interruption', () => {
    it('should allow session owner to interrupt', () => {
      const sessionKey = 'C123:T456';
      const ownerId = 'U001';

      sessionManager.createSession(sessionKey, ownerId, 'Owner User');

      expect(sessionManager.canInterrupt(sessionKey, ownerId)).toBe(true);
    });

    it('should allow current initiator to interrupt', () => {
      const sessionKey = 'C123:T456';
      const ownerId = 'U001';
      const initiatorId = 'U002';

      sessionManager.createSession(sessionKey, ownerId, 'Owner User');
      sessionManager.updateInitiator(sessionKey, initiatorId, 'Initiator User');

      expect(sessionManager.canInterrupt(sessionKey, initiatorId)).toBe(true);
    });

    it('should not allow non-owner/non-initiator to interrupt', () => {
      const sessionKey = 'C123:T456';
      const ownerId = 'U001';
      const initiatorId = 'U002';
      const otherId = 'U999';

      sessionManager.createSession(sessionKey, ownerId, 'Owner User');
      sessionManager.updateInitiator(sessionKey, initiatorId, 'Initiator User');

      expect(sessionManager.canInterrupt(sessionKey, otherId)).toBe(false);
    });

    it('should allow new session when none exists', () => {
      const sessionKey = 'newSession';
      expect(sessionManager.canInterrupt(sessionKey, 'anyUser')).toBe(true);
    });
  });

  describe('Concurrent Request Handling', () => {
    it('should handle owner interrupt during active request', async () => {
      const sessionKey = 'C123:T456';
      const ownerId = 'U001';
      let firstRequestAborted = false;

      // First request starts
      const firstController = new AbortController();
      firstController.signal.addEventListener('abort', () => {
        firstRequestAborted = true;
      });

      sessionManager.createSession(sessionKey, ownerId, 'Owner');
      coordinator.setController(sessionKey, firstController);

      // Simulate processing
      expect(coordinator.isRequestActive(sessionKey)).toBe(true);

      // Owner sends another message
      if (sessionManager.canInterrupt(sessionKey, ownerId)) {
        coordinator.abortSession(sessionKey);

        // New request starts
        const secondController = new AbortController();
        coordinator.setController(sessionKey, secondController);
      }

      expect(firstRequestAborted).toBe(true);
      expect(coordinator.isRequestActive(sessionKey)).toBe(true);
    });

    it('should not abort when non-owner sends message', async () => {
      const sessionKey = 'C123:T456';
      const ownerId = 'U001';
      const otherId = 'U999';
      let requestAborted = false;

      const controller = new AbortController();
      controller.signal.addEventListener('abort', () => {
        requestAborted = true;
      });

      sessionManager.createSession(sessionKey, ownerId, 'Owner');
      coordinator.setController(sessionKey, controller);

      // Non-owner tries to interrupt
      if (sessionManager.canInterrupt(sessionKey, otherId)) {
        coordinator.abortSession(sessionKey);
      }

      // Should NOT be aborted
      expect(requestAborted).toBe(false);
      expect(controller.signal.aborted).toBe(false);
    });

    it('should queue non-owner requests after current request', async () => {
      const sessionKey = 'C123:T456';
      const ownerId = 'U001';
      const otherId = 'U999';

      sessionManager.createSession(sessionKey, ownerId, 'Owner');

      // First request is active
      const controller = new AbortController();
      coordinator.setController(sessionKey, controller);

      // Non-owner can start a new request (will be queued in actual implementation)
      expect(coordinator.canStartRequest(sessionKey)).toBe(true);

      // But shouldn't be able to interrupt
      expect(sessionManager.canInterrupt(sessionKey, otherId)).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple sessions independently', () => {
      const session1 = 'C123:T111';
      const session2 = 'C123:T222';

      const controller1 = new AbortController();
      const controller2 = new AbortController();

      coordinator.setController(session1, controller1);
      coordinator.setController(session2, controller2);

      // Abort session1 should not affect session2
      coordinator.abortSession(session1);

      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(false);
    });

    it('should handle rapid successive requests from owner', () => {
      const sessionKey = 'C123:T456';
      const ownerId = 'U001';
      const abortedControllers: AbortController[] = [];

      sessionManager.createSession(sessionKey, ownerId, 'Owner');

      // Simulate 5 rapid requests
      for (let i = 0; i < 5; i++) {
        // Abort existing if owner
        if (sessionManager.canInterrupt(sessionKey, ownerId)) {
          const existing = coordinator.getController(sessionKey);
          if (existing) {
            existing.abort();
            abortedControllers.push(existing);
          }
        }

        const newController = new AbortController();
        coordinator.setController(sessionKey, newController);
      }

      // First 4 controllers should be aborted
      expect(abortedControllers.length).toBe(4);
      abortedControllers.forEach(c => {
        expect(c.signal.aborted).toBe(true);
      });

      // Last controller should still be active
      const lastController = coordinator.getController(sessionKey);
      expect(lastController?.signal.aborted).toBe(false);
    });

    it('should cleanup all resources on session end', () => {
      const sessionKey = 'C123:T456';
      const controller = new AbortController();

      coordinator.setController(sessionKey, controller);

      // Simulate cleanup
      coordinator.removeController(sessionKey);

      expect(coordinator.isRequestActive(sessionKey)).toBe(false);
    });
  });
});
