/**
 * Locks the gpt-5.5 (2026-07-06) release wiring. gpt-5.5's defining traits vs.
 * the claude lineup:
 *   - served via llmux's codex backend group (llmux routes `gpt-` prefixed
 *     ids to codex accounts — soma-work dispatches it like any other id);
 *   - a 275k context window the pinned Agent SDK does not know (workaround
 *     env is injected in build-stream-options.ts);
 *   - a FIXED 250k-token auto-compact trigger instead of the per-user
 *     percent threshold.
 * These tests pin the allow-list/alias/display surfaces plus the 275k/250k
 * contract so a future refactor can't silently drop the model or re-route it
 * through the percent-threshold or [1m]-suffix paths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GPT_5_5_AUTO_COMPACT_TOKENS,
  GPT_5_5_CONTEXT_WINDOW,
  GPT_5_5_SDK_BLOCKING_LIMIT,
  getModelSpec,
  isGpt55Model,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt55-test-'));
  return new UserSettingsStore(dir);
}

describe('gpt-5.5 — release wiring', () => {
  it('lists gpt-5.5 in AVAILABLE_MODELS (user-selectable)', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain('gpt-5.5');
  });

  it('keeps the version-pinned `gpt5.5` alias (the bare `gpt` moved to gpt-5.6)', () => {
    expect(MODEL_ALIASES['gpt5.5']).toBe('gpt-5.5');
  });

  it('resolveModelInput accepts the canonical id and the pinned alias', () => {
    const store = makeStore();
    expect(store.resolveModelInput('gpt-5.5')).toBe('gpt-5.5');
    expect(store.resolveModelInput('  GPT5.5 ')).toBe('gpt-5.5');
  });

  it('is NOT the DEFAULT_MODEL (superseded by gpt-5.6-sol on 2026-07-10)', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
  });

  it('coerce passes the id through (persisted settings survive restarts)', () => {
    expect(coerceToAvailableModel('gpt-5.5')).toBe('gpt-5.5');
    expect(coerceToAvailableModel('  GPT-5.5  ')).toBe('gpt-5.5');
  });

  it('renders a curated display label (not the raw id)', () => {
    const label = makeStore().getModelDisplayName('gpt-5.5');
    expect(label).toBe('GPT-5.5 (275k)');
    expect(label).not.toBe('gpt-5.5');
  });
});

describe('gpt-5.5 — 275k context / 250k auto-compact (the key contract)', () => {
  it('resolveContextWindow returns 275k for gpt-5.5', () => {
    expect(GPT_5_5_CONTEXT_WINDOW).toBe(275_000);
    expect(resolveContextWindow('gpt-5.5')).toBe(275_000);
  });

  it('resolveAutoCompactTokens returns the fixed 250k trigger for gpt-5.5', () => {
    expect(GPT_5_5_AUTO_COMPACT_TOKENS).toBe(250_000);
    expect(resolveAutoCompactTokens('gpt-5.5')).toBe(250_000);
    expect(resolveAutoCompactTokens('claude-fable-5')).toBeUndefined();
    expect(resolveAutoCompactTokens('claude-opus-4-8[1m]')).toBeUndefined();
    expect(resolveAutoCompactTokens(undefined)).toBeUndefined();
  });

  it('SDK blocking-limit override is the SDK formula on the true window (275k − 20k − 3k)', () => {
    expect(GPT_5_5_SDK_BLOCKING_LIMIT).toBe(252_000);
    // Must sit ABOVE the 250k compact trigger — otherwise the SDK would
    // hard-block input before the harness ever schedules /compact.
    expect(GPT_5_5_SDK_BLOCKING_LIMIT).toBeGreaterThan(GPT_5_5_AUTO_COMPACT_TOKENS);
  });

  it('is matched by isGpt55Model and NOT by the native-1M matcher', () => {
    expect(isGpt55Model('gpt-5.5')).toBe(true);
    expect(isGpt55Model('claude-fable-5')).toBe(false);
    expect(isNativeOneMModel('gpt-5.5')).toBe(false);
  });
});

describe('gpt-5.5 — model-registry pricing + spec', () => {
  it('mirrors llmux built-in codex rates: $5 in / $30 out / $0.5 cache-read, no cache-write charge', () => {
    const spec = getModelSpec('gpt-5.5');
    expect(spec.pricing.inputPerMTok).toBe(5);
    expect(spec.pricing.outputPerMTok).toBe(30);
    expect(spec.pricing.cacheReadPerMTok).toBe(0.5);
    expect(spec.pricing.cache5minWritePerMTok).toBe(0);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(0);
    expect(spec.contextWindow).toBe(275_000);
    expect(spec.maxOutput).toBe(128_000);
  });
});
