/**
 * M2 — a goal auto-continuation injection must never supersede a live turn.
 * `shouldDropGoalContinuation` is the atomic guard session-initializer applies
 * before concurrency control: when the slot is busy, the continuation is
 * dropped instead of aborting the active (user) turn.
 */

import { describe, expect, it } from 'vitest';
import { shouldDropGoalContinuation } from '../session-initializer';

describe('shouldDropGoalContinuation (M2)', () => {
  it('drops a goal continuation when a request is active', () => {
    expect(shouldDropGoalContinuation({ routeContext: { goalContinuation: true } }, true)).toBe(true);
  });

  it('allows a goal continuation when the session is idle', () => {
    expect(shouldDropGoalContinuation({ routeContext: { goalContinuation: true } }, false)).toBe(false);
  });

  it('never drops a real (non-continuation) turn, even when busy', () => {
    expect(shouldDropGoalContinuation({ routeContext: { goalContinuation: false } }, true)).toBe(false);
    expect(shouldDropGoalContinuation({ routeContext: {} }, true)).toBe(false);
    expect(shouldDropGoalContinuation({}, true)).toBe(false);
  });
});
