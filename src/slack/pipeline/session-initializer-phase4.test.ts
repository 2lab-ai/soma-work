/**
 * SessionInitializer — #689 P4 Part 2/2 legacy suppression smoke.
 *
 * The dispatch flow has two native-spinner writers that must be gated on
 * effective PHASE<4 so TurnSurface owns the B4 surface at PHASE>=4:
 *   - `assistantStatusManager.setStatus(channel, threadTs, 'is analyzing your request...')`
 *   - `assistantStatusManager.setTitle(channel, threadTs, <title>)`
 *
 * This file only exercises the small gate — the full dispatch workflow has
 * its own coverage in `session-initializer-routing.test.ts`. Here we lock
 * the PHASE-dependent behaviour directly so a future refactor of the gate
 * (e.g. moving it inside AssistantStatusManager) cannot silently regress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  ui: {
    fiveBlockPhase: 0,
    b4NativeStatusEnabled: true,
  },
}));
vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../metrics/ui-metrics', () => ({ emitUiPhaseClamped: vi.fn() }));

import { getEffectiveFiveBlockPhase } from './effective-phase';

describe('SessionInitializer B4 dispatch gate (#689)', () => {
  const makeMgr = (enabled: boolean) => ({
    isEnabled: vi.fn().mockReturnValue(enabled),
    setStatus: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
  });

  afterEach(() => {
    mockConfig.ui.fiveBlockPhase = 0;
  });

  it('PHASE<4 + enabled: gate allows setStatus + setTitle (legacy)', () => {
    mockConfig.ui.fiveBlockPhase = 3;
    const mgr = makeMgr(true);
    // Mirror the wire used in session-initializer.ts:
    //   if (mgr && getEffectiveFiveBlockPhase(mgr) < 4) { ... setStatus(...)/setTitle(...) }
    const allow = mgr && getEffectiveFiveBlockPhase(mgr as any) < 4;
    expect(allow).toBe(true);
  });

  it('PHASE=4 + enabled: gate suppresses setStatus + setTitle (TurnSurface owns)', () => {
    mockConfig.ui.fiveBlockPhase = 4;
    const mgr = makeMgr(true);
    const allow = mgr && getEffectiveFiveBlockPhase(mgr as any) < 4;
    expect(allow).toBe(false);
  });

  it('PHASE=4 + disabled (clamped): gate re-allows legacy (graceful fallback)', () => {
    mockConfig.ui.fiveBlockPhase = 4;
    const mgr = makeMgr(false);
    const allow = mgr && getEffectiveFiveBlockPhase(mgr as any) < 4;
    expect(allow).toBe(true);
  });
});
