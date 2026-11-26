import { describe, expect, it } from 'vitest';

// Trace: Ghost Session Fix, Scenario 3 — session.terminated Flag (P2)
// terminateSession sets a terminated flag on the session object before deleting it from the registry, so in-flight
// code still holding the object can self-terminate.

describe('session.terminated Flag (Ghost Session Fix #99)', () => {
  // Trace: Scenario 3, Section 3a — terminateSession sets terminated flag before delete
  it('terminateSession marks the session object terminated, also when called with the legacy key form', async () => {
    const { SessionRegistry } = await import('../../session-registry.js');
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'User', 'C1', '171.100');
    expect(session.terminated).toBeFalsy();

    // The LEGACY key form — pre-deploy Slack buttons carry old keys.
    expect(registry.terminateSession('C1-171.100')).toBe(true);

    // The object in-flight code holds is marked; the registry no longer has it.
    expect(session.terminated).toBe(true);
    expect(registry.getSession('C1', '171.100')).toBeUndefined();
  });
});
