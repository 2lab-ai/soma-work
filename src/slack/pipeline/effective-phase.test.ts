/**
 * Tests for getEffectiveFiveBlockPhase (#689 P4 Part 2).
 *
 * The clamp helper returns `config.ui.fiveBlockPhase` unchanged except
 * when raw>=4 and the AssistantStatusManager is disabled, in which case
 * it clamps to 3 and emits the once-flag metric exactly once per process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  ui: {
    fiveBlockPhase: 0,
    b4NativeStatusEnabled: true,
  },
}));
const emitSpy = vi.hoisted(() => vi.fn());

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../metrics/ui-metrics', () => ({ emitUiPhaseClamped: emitSpy }));

import { __resetClampEmitted, getEffectiveFiveBlockPhase } from './effective-phase';

const makeMgr = (enabled: boolean) => ({ isEnabled: vi.fn().mockReturnValue(enabled) }) as any;

describe('getEffectiveFiveBlockPhase (#689)', () => {
  beforeEach(() => {
    __resetClampEmitted();
    emitSpy.mockClear();
    mockConfig.ui.fiveBlockPhase = 0;
  });

  afterEach(() => {
    __resetClampEmitted();
  });

  it('returns raw when raw < 4 (no clamp)', () => {
    for (const raw of [0, 1, 2, 3]) {
      mockConfig.ui.fiveBlockPhase = raw;
      expect(getEffectiveFiveBlockPhase(makeMgr(false))).toBe(raw);
    }
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('returns raw when raw >= 4 and manager is enabled', () => {
    mockConfig.ui.fiveBlockPhase = 4;
    expect(getEffectiveFiveBlockPhase(makeMgr(true))).toBe(4);
    mockConfig.ui.fiveBlockPhase = 5;
    expect(getEffectiveFiveBlockPhase(makeMgr(true))).toBe(5);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('clamps to 3 when raw >= 4 and manager is disabled, emits metric once', () => {
    mockConfig.ui.fiveBlockPhase = 4;
    expect(getEffectiveFiveBlockPhase(makeMgr(false))).toBe(3);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith({ from: 4, to: 3, reason: 'assistant-status-disabled' });
  });

  it('subsequent clamp calls return 3 but do not re-emit (once-flag)', () => {
    mockConfig.ui.fiveBlockPhase = 4;
    const mgr = makeMgr(false);
    getEffectiveFiveBlockPhase(mgr);
    getEffectiveFiveBlockPhase(mgr);
    getEffectiveFiveBlockPhase(mgr);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('__resetClampEmitted allows re-emission on the next clamp (test isolation)', () => {
    mockConfig.ui.fiveBlockPhase = 4;
    const mgr = makeMgr(false);
    getEffectiveFiveBlockPhase(mgr);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    __resetClampEmitted();
    getEffectiveFiveBlockPhase(mgr);
    expect(emitSpy).toHaveBeenCalledTimes(2);
  });
});
