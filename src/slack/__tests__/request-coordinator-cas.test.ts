import { describe, expect, it } from 'vitest';
import { RequestCoordinator } from '../request-coordinator.js';

// Trace: Ghost Session Fix, Scenario 2 — CAS-style removeController (P1)
// These tests verify that removeController uses CAS (Compare-And-Swap) logic
// to prevent older requests from removing newer request's controllers.

describe('RequestCoordinator — CAS removeController (Ghost Session Fix #99)', () => {
  // Trace: Scenario 2, Section 3b — removeController with matching controller removes it
  it('removeController with matching controller should remove it', () => {
    const coordinator = new RequestCoordinator();
    const controller = new AbortController();
    const sessionKey = 'C1-171.100';

    coordinator.setController(sessionKey, controller);

    // CAS: pass the expected controller — should remove
    coordinator.removeController(sessionKey, controller);

    expect(coordinator.getController(sessionKey)).toBeUndefined();
  });

  // Trace: Scenario 2, Section 3b — removeController with mismatched controller is no-op
  it('removeController with mismatched controller should be a no-op', () => {
    const coordinator = new RequestCoordinator();
    const controllerOld = new AbortController();
    const controllerNew = new AbortController();
    const sessionKey = 'C1-171.100';

    // Simulate: old request registered, then new request overwrites
    coordinator.setController(sessionKey, controllerOld);
    coordinator.setController(sessionKey, controllerNew);

    // Old request's finally block tries to remove with old controller
    coordinator.removeController(sessionKey, controllerOld);

    // New controller should still be there
    expect(coordinator.getController(sessionKey)).toBe(controllerNew);
  });

  // Trace: Scenario 2, Section 3b — removeController without expected param (backward compat)
  it('removeController without expected param should still remove (backward compat)', () => {
    const coordinator = new RequestCoordinator();
    const controller = new AbortController();
    const sessionKey = 'C1-171.100';

    coordinator.setController(sessionKey, controller);
    coordinator.removeController(sessionKey);

    expect(coordinator.getController(sessionKey)).toBeUndefined();
  });
});
