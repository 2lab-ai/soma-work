/**
 * SSOT 2026-10-22 T4/T5 — a dashboard model switch: the auto-compact
 * threshold follows the new model, and a switch that has to wait for a
 * compact on the current model is applied at that compact's boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  applyModelSwitch,
  applyPendingModelSwitch,
  PENDING_MODEL_SWITCH_TTL_MS,
  settlePendingModelSwitch,
} from '../model-switch';

const windows: Record<string, number> = { 'grok-4.6': 500_000, 'claude-opus-5-5[1m]': 1_000_000 };
const cw = (m?: string) => windows[m ?? ''] ?? 200_000;

describe('applyModelSwitch', () => {
  it('sets the model, drops a session auto-compact override so the model’s own threshold applies, re-anchors the window', () => {
    const s: Record<string, any> = {
      model: 'claude-opus-5-5[1m]',
      autoCompactTokens: 900_000,
      usage: { contextWindow: 1_000_000 },
      pendingModelSwitch: { model: 'x', nickname: 'x', requestedAt: 1 },
    };
    applyModelSwitch(s, 'grok-4.6', cw);
    expect(s).toMatchObject({ model: 'grok-4.6', usage: { contextWindow: 500_000 } });
    expect(s.autoCompactTokens).toBeUndefined();
    expect(s.pendingModelSwitch).toBeUndefined();
  });

  it('a session without usage yet just switches', () => {
    const s: Record<string, any> = { model: 'a' };
    applyModelSwitch(s, 'grok-4.6', cw);
    expect(s.model).toBe('grok-4.6');
  });
});

describe('a switch waiting for its compact', () => {
  const pending = () => ({ model: 'grok-4.6', nickname: 'grok[1m]', requestedAt: 1 });

  it('is applied at the compact boundary', () => {
    const s: Record<string, any> = {
      model: 'claude-opus-5-5[1m]',
      pendingModelSwitch: pending(),
      usage: { contextWindow: 1_000_000 },
    };
    expect(applyPendingModelSwitch(s, cw, 2)).toMatchObject({ nickname: 'grok[1m]' });
    expect(s.model).toBe('grok-4.6');
    expect(s.usage.contextWindow).toBe(500_000);
  });

  it('waits while an emergency fallback compact still runs on its temporary model', () => {
    const s: Record<string, any> = { model: 'opus[1m]', fallbackCompactActive: true, pendingModelSwitch: pending() };
    expect(applyPendingModelSwitch(s, cw)).toBeUndefined();
    expect(s.model).toBe('opus[1m]');
  });

  it('a switch that waited too long is dropped at the next boundary, not applied to an unrelated compact (review P1)', () => {
    const s: Record<string, any> = {
      model: 'claude-opus-5-5[1m]',
      pendingModelSwitch: { model: 'grok-4.6', nickname: 'grok[1m]', requestedAt: 1_000 },
    };
    expect(applyPendingModelSwitch(s, cw, 1_000 + PENDING_MODEL_SWITCH_TTL_MS + 1)).toBeUndefined();
    expect(s.model).toBe('claude-opus-5-5[1m]');
    expect(s.pendingModelSwitch).toBeUndefined();
  });

  it('nothing pending, nothing applied', () => {
    expect(applyPendingModelSwitch({ model: 'a' }, cw)).toBeUndefined();
  });

  it('when the compact turn ends: applied if it compacted (boundary missed), cancelled otherwise', () => {
    const compacted: Record<string, any> = { model: 'a', compactionOccurred: true, pendingModelSwitch: pending() };
    expect(settlePendingModelSwitch(compacted, cw, 2)).toBe('applied');
    expect(compacted.model).toBe('grok-4.6');
    const failed: Record<string, any> = { model: 'a', pendingModelSwitch: pending() };
    expect(settlePendingModelSwitch(failed, cw)).toBe('cancelled');
    expect(failed.model).toBe('a');
    expect(failed.pendingModelSwitch).toBeUndefined();
    expect(settlePendingModelSwitch({ model: 'a' }, cw)).toBe('none');
  });
});
