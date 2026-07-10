/**
 * Locks the gpt-5.6 (2026-07-10) release wiring. gpt-5.6's defining traits:
 *   - the DEFAULT_MODEL since 2026-07-10 (operator decision — was opus[1m]);
 *   - served via llmux's codex backend group; llmux ≥ 0.2.16 pins the
 *     upstream codex slug to `gpt-5.6-sol` (the bare `gpt-5.6` id is
 *     rejected by the ChatGPT-account codex backend);
 *   - a 370k context window measured empirically against the codex backend
 *     on 2026-07-10 (369,755-token input accepted, ~380k rejected — the
 *     272k input split of the gpt-5.5 era is gone). The pinned Agent SDK
 *     does not know the id (workaround env injected in
 *     build-stream-options.ts);
 *   - a FIXED 340k-token auto-compact trigger instead of the per-user
 *     percent threshold.
 * These tests pin the allow-list/alias/default/display surfaces plus the
 * 370k/340k contract so a future refactor can't silently drop the model,
 * change the default, or re-route it through the percent-threshold or
 * [1m]-suffix paths.
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

describe('gpt-5.6 — release wiring', () => {
  it('lists gpt-5.6 in AVAILABLE_MODELS (user-selectable)', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain('gpt-5.6');
  });

  it('IS the DEFAULT_MODEL (2026-07-10 operator decision)', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6');
  });

  it('resolves the `gpt` and `gpt5.6` aliases to gpt-5.6', () => {
    expect(MODEL_ALIASES.gpt).toBe('gpt-5.6');
    expect(MODEL_ALIASES['gpt5.6']).toBe('gpt-5.6');
    // The version-pinned gpt-5.5 alias must NOT be silently upgraded.
    expect(MODEL_ALIASES['gpt5.5']).toBe('gpt-5.5');
  });

  it('resolveModelInput accepts the canonical id and both aliases', () => {
    const store = makeStore();
    expect(store.resolveModelInput('gpt-5.6')).toBe('gpt-5.6');
    expect(store.resolveModelInput('gpt')).toBe('gpt-5.6');
    expect(store.resolveModelInput('  GPT5.6 ')).toBe('gpt-5.6');
  });

  it('coerce passes the id through (persisted settings survive restarts)', () => {
    expect(coerceToAvailableModel('gpt-5.6')).toBe('gpt-5.6');
    expect(coerceToAvailableModel('  GPT-5.6  ')).toBe('gpt-5.6');
  });

  it('coerce falls back to gpt-5.6 for unknown ids (DEFAULT_MODEL fallback)', () => {
    expect(coerceToAvailableModel('some-nonsense-model')).toBe('gpt-5.6');
    expect(coerceToAvailableModel(undefined)).toBe('gpt-5.6');
  });

  it('renders a curated display label (not the raw id)', () => {
    const label = makeStore().getModelDisplayName('gpt-5.6');
    expect(label).toBe('GPT-5.6 (370k)');
    expect(label).not.toBe('gpt-5.6');
  });
});

describe('gpt-5.6 — 370k context / 340k auto-compact (the key contract)', () => {
  it('resolveContextWindow returns 370k for gpt-5.6 and the upstream slugs', () => {
    expect(GPT_5_6_CONTEXT_WINDOW).toBe(370_000);
    expect(resolveContextWindow('gpt-5.6')).toBe(370_000);
    // Usage events may carry the upstream-reported slug — same window.
    expect(resolveContextWindow('gpt-5.6-sol')).toBe(370_000);
  });

  it('does not disturb the gpt-5.5 window (275k) or claude windows', () => {
    expect(resolveContextWindow('gpt-5.5')).toBe(275_000);
    expect(resolveContextWindow('claude-fable-5')).toBe(1_000_000);
    expect(resolveContextWindow('claude-opus-4-8[1m]')).toBe(1_000_000);
  });

  it('resolveAutoCompactTokens returns the fixed 340k trigger for gpt-5.6', () => {
    expect(GPT_5_6_AUTO_COMPACT_TOKENS).toBe(340_000);
    expect(resolveAutoCompactTokens('gpt-5.6')).toBe(340_000);
    expect(resolveAutoCompactTokens('gpt-5.6-sol')).toBe(340_000);
    // gpt-5.5 keeps its own trigger; claude models stay percent-based.
    expect(resolveAutoCompactTokens('gpt-5.5')).toBe(250_000);
    expect(resolveAutoCompactTokens('claude-fable-5')).toBeUndefined();
    expect(resolveAutoCompactTokens(undefined)).toBeUndefined();
  });

  it('SDK blocking-limit override is the SDK formula on the measured window (370k − 20k − 3k)', () => {
    expect(GPT_5_6_SDK_BLOCKING_LIMIT).toBe(347_000);
    // Must sit ABOVE the 340k compact trigger — otherwise the SDK would
    // hard-block input before the harness ever schedules /compact.
    expect(GPT_5_6_SDK_BLOCKING_LIMIT).toBeGreaterThan(GPT_5_6_AUTO_COMPACT_TOKENS);
  });

  it('is matched by isGpt56Model and NOT by isGpt55Model or the native-1M matcher', () => {
    expect(isGpt56Model('gpt-5.6')).toBe(true);
    expect(isGpt56Model('gpt-5.6-sol')).toBe(true);
    expect(isGpt56Model('gpt-5.5')).toBe(false);
    expect(isGpt55Model('gpt-5.6')).toBe(false);
    expect(isNativeOneMModel('gpt-5.6')).toBe(false);
  });
});

describe('gpt-5.6 — model-registry pricing + spec', () => {
  it('mirrors OpenAI launch rates: $5 in / $30 out / $0.5 cache-read, no cache-write charge', () => {
    const spec = getModelSpec('gpt-5.6');
    expect(spec.pricing.inputPerMTok).toBe(5);
    expect(spec.pricing.outputPerMTok).toBe(30);
    expect(spec.pricing.cacheReadPerMTok).toBe(0.5);
    expect(spec.pricing.cache5minWritePerMTok).toBe(0);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(0);
    expect(spec.contextWindow).toBe(370_000);
    expect(spec.maxOutput).toBe(128_000);
  });

  it('the upstream-reported slug resolves to the same spec (includes matching)', () => {
    expect(getModelSpec('gpt-5.6-sol').contextWindow).toBe(370_000);
  });
});
