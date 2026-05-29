/**
 * Locks the `opus[1m] → DEFAULT_MODEL` contract so a new opus generation
 * (4.9 …) ships by flipping AVAILABLE_MODELS + the two "latest opus" alias
 * rows — DEFAULT_MODEL inherits the pointer. Also pins the model-registry
 * spec for the 4.8 row and confirms the effort surface didn't shift at the
 * API boundary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getModelSpec,
  resolveContextWindow,
} from '../metrics/model-registry';
import {
  AVAILABLE_MODELS,
  coerceToAvailableModel,
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  MODEL_ALIASES,
  UserSettingsStore,
} from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus48-test-'));
  return new UserSettingsStore(dir);
}

describe('opus-4.8 — release wiring', () => {
  it('lists both 4.8 variants in AVAILABLE_MODELS', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-opus-4-8');
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-opus-4-8[1m]');
  });

  it('DEFAULT_MODEL tracks the resolved opus[1m] alias', () => {
    // Single-line-edit contract: bumping MODEL_ALIASES['opus[1m]'] in a future
    // PR rolls DEFAULT_MODEL forward without any other edit.
    expect(DEFAULT_MODEL).toBe(MODEL_ALIASES['opus[1m]']);
    expect(DEFAULT_MODEL).toBe('claude-opus-4-8[1m]');
  });

  it('coerce normalises uppercase [1M] typo on the 4.8 variant', () => {
    // The other 4.8 round-trips are covered by the AVAILABLE_MODELS sweep
    // in user-settings-store.test.ts; this guards the suffix-case normaliser
    // specifically against the new variant.
    expect(coerceToAvailableModel('claude-opus-4-8[1M]')).toBe('claude-opus-4-8[1m]');
  });

  it('renders curated display labels for both 4.8 variants', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('claude-opus-4-8')).toBe('Opus 4.8');
    expect(store.getModelDisplayName('claude-opus-4-8[1m]')).toBe('Opus 4.8 (1M)');
  });
});

describe('opus-4.8 — model-registry pricing + context', () => {
  it('returns opus-tier pricing for claude-opus-4-8', () => {
    const spec = getModelSpec('claude-opus-4-8');
    expect(spec.pricing.inputPerMTok).toBe(5);
    expect(spec.pricing.outputPerMTok).toBe(25);
    expect(spec.pricing.cacheReadPerMTok).toBe(0.5);
    expect(spec.pricing.cache5minWritePerMTok).toBe(6.25);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(10);
    expect(spec.maxOutput).toBe(128_000);
    expect(spec.contextWindow).toBe(1_000_000);
  });

  it('[1m] suffix opts into 1M; bare id falls back to 200k (suffix-is-SSOT)', () => {
    expect(resolveContextWindow('claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(resolveContextWindow('claude-opus-4-8')).toBe(200_000);
  });
});

describe('opus-4.8 — effort surface unchanged at the API level', () => {
  it('EFFORT_LEVELS remains the canonical 5-level set', () => {
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
