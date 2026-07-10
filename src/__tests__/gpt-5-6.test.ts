/**
 * Locks the gpt-5.6 family (2026-07-10) release wiring. Per the openai/codex
 * model catalog (models-manager/models.json) there is NO bare `gpt-5.6`
 * model — the family is three real tier ids, all sharing a 372,000-token
 * context window (catalog value, probe-consistent: 369,755-token input
 * accepted, ~380k rejected on 2026-07-10):
 *   - `gpt-5.6-sol`   — flagship, the DEFAULT_MODEL (catalog default effort
 *     low; efforts low..xhigh + max/ultra);
 *   - `gpt-5.6-terra` — mid tier, half of sol's price (default effort
 *     medium; efforts low..xhigh + max/ultra);
 *   - `gpt-5.6-luna`  — budget tier (default effort medium; the
 *     ChatGPT-account codex backend returned "Model not found" on 2026-07-10
 *     probes — catalog-listed, likely rollout-gated; llmux forwards it).
 * The pinned Agent SDK does not know these ids (workaround env injected in
 * build-stream-options.ts); the harness auto-compacts at a FIXED 340k tokens
 * instead of the per-user percent threshold.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GPT_5_6_AUTO_COMPACT_TOKENS,
  GPT_5_6_CONTEXT_WINDOW,
  GPT_5_6_SDK_BLOCKING_LIMIT,
  getModelSpec,
  isGpt55Model,
  isGpt56Model,
  isNativeOneMModel,
  resolveAutoCompactTokens,
  resolveContextWindow,
} from '../metrics/model-registry';
import {
  AVAILABLE_MODELS,
  coerceToAvailableModel,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  UserSettingsStore,
} from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt56-test-'));
  return new UserSettingsStore(dir);
}

describe('gpt-5.6 family — release wiring', () => {
  it('lists the three REAL tier ids; the bare gpt-5.6 id is not a model', () => {
    const models = AVAILABLE_MODELS as readonly string[];
    expect(models).toContain('gpt-5.6-sol');
    expect(models).toContain('gpt-5.6-terra');
    expect(models).toContain('gpt-5.6-luna');
    expect(models).not.toContain('gpt-5.6');
  });

  it('gpt-5.6-sol IS the DEFAULT_MODEL (2026-07-10 operator decision)', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
  });

  it('resolves the gpt/tier aliases; legacy bare gpt-5.6 spelling maps to sol', () => {
    expect(MODEL_ALIASES.gpt).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES.sol).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES.terra).toBe('gpt-5.6-terra');
    expect(MODEL_ALIASES.luna).toBe('gpt-5.6-luna');
    expect(MODEL_ALIASES['gpt-5.6']).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES['gpt5.6']).toBe('gpt-5.6-sol');
    // The version-pinned gpt-5.5 alias must NOT be silently upgraded.
    expect(MODEL_ALIASES['gpt5.5']).toBe('gpt-5.5');
  });

  it('resolveModelInput accepts canonical ids and aliases', () => {
    const store = makeStore();
    expect(store.resolveModelInput('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(store.resolveModelInput('gpt')).toBe('gpt-5.6-sol');
    expect(store.resolveModelInput('  GPT-5.6 ')).toBe('gpt-5.6-sol');
    expect(store.resolveModelInput('terra')).toBe('gpt-5.6-terra');
    expect(store.resolveModelInput('luna')).toBe('gpt-5.6-luna');
  });

  it('coerce passes tier ids through and falls back to sol for unknown/legacy ids', () => {
    expect(coerceToAvailableModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(coerceToAvailableModel('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(coerceToAvailableModel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    // Legacy persisted `gpt-5.6` (the short-lived bare id) is not in the
    // allow-list — coerce lands on DEFAULT_MODEL, which is the same model.
    expect(coerceToAvailableModel('gpt-5.6')).toBe('gpt-5.6-sol');
    expect(coerceToAvailableModel('some-nonsense-model')).toBe('gpt-5.6-sol');
    expect(coerceToAvailableModel(undefined)).toBe('gpt-5.6-sol');
  });

  it('renders curated display labels per tier', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('gpt-5.6-sol')).toBe('GPT-5.6 Sol (372k)');
    expect(store.getModelDisplayName('gpt-5.6-terra')).toBe('GPT-5.6 Terra (372k)');
    expect(store.getModelDisplayName('gpt-5.6-luna')).toBe('GPT-5.6 Luna (372k)');
  });
});

describe('gpt-5.6 family — 372k window / 340k auto-compact (the key contract)', () => {
  it('resolveContextWindow returns the 372k catalog window for every tier', () => {
    expect(GPT_5_6_CONTEXT_WINDOW).toBe(372_000);
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6']) {
      expect(resolveContextWindow(m)).toBe(372_000);
    }
  });

  it('does not disturb the gpt-5.5 window (275k) or claude windows', () => {
    expect(resolveContextWindow('gpt-5.5')).toBe(275_000);
    expect(resolveContextWindow('claude-fable-5')).toBe(1_000_000);
    expect(resolveContextWindow('claude-opus-4-8[1m]')).toBe(1_000_000);
  });

  it('resolveAutoCompactTokens returns the fixed 340k trigger for every tier', () => {
    expect(GPT_5_6_AUTO_COMPACT_TOKENS).toBe(340_000);
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(resolveAutoCompactTokens(m)).toBe(340_000);
    }
    // gpt-5.5 keeps its own trigger; claude models stay percent-based.
    expect(resolveAutoCompactTokens('gpt-5.5')).toBe(250_000);
    expect(resolveAutoCompactTokens('claude-fable-5')).toBeUndefined();
    expect(resolveAutoCompactTokens(undefined)).toBeUndefined();
  });

  it('SDK blocking-limit override is the SDK formula on the true window (372k − 20k − 3k)', () => {
    expect(GPT_5_6_SDK_BLOCKING_LIMIT).toBe(349_000);
    // Must sit ABOVE the 340k compact trigger — otherwise the SDK would
    // hard-block input before the harness ever schedules /compact.
    expect(GPT_5_6_SDK_BLOCKING_LIMIT).toBeGreaterThan(GPT_5_6_AUTO_COMPACT_TOKENS);
  });

  it('every tier matches isGpt56Model and NOT isGpt55Model / native-1M', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(isGpt56Model(m)).toBe(true);
      expect(isGpt55Model(m)).toBe(false);
      expect(isNativeOneMModel(m)).toBe(false);
    }
    expect(isGpt56Model('gpt-5.5')).toBe(false);
  });
});

describe('gpt-5.6 family — model-registry pricing (2026-07-09 launch rates)', () => {
  it('sol: $5 in / $30 out / $0.5 cache-read, no cache-write charge', () => {
    const spec = getModelSpec('gpt-5.6-sol');
    expect(spec.pricing.inputPerMTok).toBe(5);
    expect(spec.pricing.outputPerMTok).toBe(30);
    expect(spec.pricing.cacheReadPerMTok).toBe(0.5);
    expect(spec.pricing.cache5minWritePerMTok).toBe(0);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(0);
    expect(spec.contextWindow).toBe(372_000);
    expect(spec.maxOutput).toBe(128_000);
  });

  it('terra: $2.50 in / $15 out / $0.25 cache-read', () => {
    const spec = getModelSpec('gpt-5.6-terra');
    expect(spec.pricing.inputPerMTok).toBe(2.5);
    expect(spec.pricing.outputPerMTok).toBe(15);
    expect(spec.pricing.cacheReadPerMTok).toBe(0.25);
    expect(spec.contextWindow).toBe(372_000);
  });

  it('luna: $1 in / $6 out / $0.1 cache-read', () => {
    const spec = getModelSpec('gpt-5.6-luna');
    expect(spec.pricing.inputPerMTok).toBe(1);
    expect(spec.pricing.outputPerMTok).toBe(6);
    expect(spec.pricing.cacheReadPerMTok).toBe(0.1);
    expect(spec.contextWindow).toBe(372_000);
  });

  it('tier entries do not shadow each other (substring matching is first-wins)', () => {
    // Legacy bare-id transcripts resolve to sol rates via the family pattern.
    expect(getModelSpec('gpt-5.6').pricing.inputPerMTok).toBe(5);
    expect(getModelSpec('gpt-5.6-terra').pricing.inputPerMTok).toBe(2.5);
    expect(getModelSpec('gpt-5.6-luna').pricing.inputPerMTok).toBe(1);
  });
});
