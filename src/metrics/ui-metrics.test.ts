/**
 * Tests for the UI metric emitter (#689 P4 Part 2).
 *
 * `emitUiPhaseClamped` is Logger-backed (warn-level). Tests verify the
 * warn channel receives the well-known event name + structured payload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../logger', () => ({
  Logger: class {
    warn = warnSpy;
    info = vi.fn();
    debug = vi.fn();
    error = vi.fn();
  },
}));

import { emitUiPhaseClamped } from './ui-metrics';

describe('emitUiPhaseClamped (#689)', () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  it('emits a warn entry with well-known event name and payload', () => {
    emitUiPhaseClamped({ from: 4, to: 3, reason: 'assistant-status-disabled' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, payload] = warnSpy.mock.calls[0];
    expect(msg).toBe('soma_ui_5block_phase_clamped');
    expect(payload).toEqual({ from: 4, to: 3, reason: 'assistant-status-disabled' });
  });

  it('multiple calls each emit (dedup lives upstream in effective-phase once-flag)', () => {
    emitUiPhaseClamped({ from: 4, to: 3, reason: 'assistant-status-disabled' });
    emitUiPhaseClamped({ from: 5, to: 3, reason: 'custom' });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
