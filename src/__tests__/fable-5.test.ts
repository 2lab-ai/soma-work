/**
 * Locks the Claude Fable 5 (2026-06-09) release wiring. Fable 5's defining
 * trait vs. the opus lineup: it serves a 1M context window on the BARE id —
 * no `[1m]` suffix and no `context-1m-2025-08-07` beta header. These tests pin
 * that native-1M contract plus the pricing/alias/display surfaces so a future
 * refactor can't silently re-route Fable through the opus `[1m]` opt-in path or
 * drop it from the allow-list.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getModelSpec, isNativeOneMModel, resolveContextWindow } from '../metrics/model-registry';
import {
  AVAILABLE_MODELS,
  coerceToAvailableModel,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  UserSettingsStore,
} from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable5-test-'));
  return new UserSettingsStore(dir);
}

describe('fable-5 — release wiring', () => {
  it('lists the bare claude-fable-5 in AVAILABLE_MODELS', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-fable-5');
  });

  it('does NOT list a claude-fable-5[1m] variant (native-1M on the bare id)', () => {
    // A `[1m]` variant would wrongly trigger the opus beta-header path in the
    // Agent SDK. Fable serves 1M without it.
    expect(AVAILABLE_MODELS as readonly string[]).not.toContain('claude-fable-5[1m]');
  });

  it('resolves the `fable` and `fable-5` aliases to claude-fable-5', () => {
    expect(MODEL_ALIASES.fable).toBe('claude-fable-5');
    expect(MODEL_ALIASES['fable-5']).toBe('claude-fable-5');
  });

  it('exposes no `fable[1m]` alias', () => {
    expect(MODEL_ALIASES['fable[1m]']).toBeUndefined();
    expect(MODEL_ALIASES['fable-5[1m]']).toBeUndefined();
  });

  it('does NOT change DEFAULT_MODEL (Fable is opt-in, not the default)', () => {
    // Fable 5 is double opus pricing and becomes credit-gated post-launch, so
    // it must not silently become everyone's default.
    expect(DEFAULT_MODEL).toBe('claude-opus-4-8[1m]');
  });

  it('coerce passes the bare id through and normalises an uppercase typo path', () => {
    expect(coerceToAvailableModel('claude-fable-5')).toBe('claude-fable-5');
    expect(coerceToAvailableModel('  claude-fable-5  ')).toBe('claude-fable-5');
  });

  it('renders a curated display label (not the raw id)', () => {
    const store = makeStore();
    const label = store.getModelDisplayName('claude-fable-5');
    expect(label).toBe('Fable 5 (1M)');
    expect(label).not.toBe('claude-fable-5');
  });
});

describe('fable-5 — native 1M context (the key contract)', () => {
  it('resolveContextWindow returns 1M for the BARE id — no [1m] suffix', () => {
    expect(resolveContextWindow('claude-fable-5')).toBe(1_000_000);
  });

  it('is recognised as a native-1M model', () => {
    expect(isNativeOneMModel('claude-fable-5')).toBe(true);
  });
});

describe('fable-5 — model-registry pricing + context', () => {
  it('returns double-opus pricing, 1M context, 128k max output', () => {
    const spec = getModelSpec('claude-fable-5');
    expect(spec.pricing.inputPerMTok).toBe(10);
    expect(spec.pricing.outputPerMTok).toBe(50);
    expect(spec.pricing.cacheReadPerMTok).toBe(1);
    expect(spec.pricing.cache5minWritePerMTok).toBe(12.5);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(20);
    expect(spec.maxOutput).toBe(128_000);
    expect(spec.contextWindow).toBe(1_000_000);
  });
});
