/**
 * Locks the Claude Fable 5 (2026-06-09) release wiring.
 *
 * 2026-08-26 correction. Fable 5 does serve 1M upstream on the bare id, and
 * `resolveContextWindow('claude-fable-5')` still says so. The auto-compact
 * trigger itself is a HARNESS number read from the model profile — the client
 * is not the authority for it. What the literal `[1m]` suffix buys is the SDK
 * side of the same session: the live llmux probe showed input accounting and
 * the blocking limit are sized at 1,000,000 only for `claude-fable-5[1m]`,
 * while the bare id is sized at 200,000 and hard-blocks input long before the
 * harness's 750k trigger could ever fire. So the user-facing aliases now point
 * at the literal `[1m]` spelling and the old "there is no fable[1m]" guards
 * are inverted here.
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

  it('ALSO lists the literal claude-fable-5[1m] variant (Claude Code 1M denominator)', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-fable-5[1m]');
  });

  it('resolves the `fable` / `fable-5` aliases to the literal claude-fable-5[1m]', () => {
    expect(MODEL_ALIASES.fable).toBe('claude-fable-5[1m]');
    expect(MODEL_ALIASES['fable-5']).toBe('claude-fable-5[1m]');
  });

  it('exposes explicit `fable[1m]` aliases pointing at the same literal id', () => {
    expect(MODEL_ALIASES['fable[1m]']).toBe('claude-fable-5[1m]');
    expect(MODEL_ALIASES['fable-5[1m]']).toBe('claude-fable-5[1m]');
  });

  it('the literal [1m] id round-trips through resolve + coerce (never downgraded)', () => {
    const store = makeStore();
    expect(store.resolveModelInput('claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
    expect(store.resolveModelInput('fable')).toBe('claude-fable-5[1m]');
    expect(coerceToAvailableModel('claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
    expect(coerceToAvailableModel('claude-fable-5[1M]')).toBe('claude-fable-5[1m]');
  });

  it('does NOT change DEFAULT_MODEL (Fable is opt-in, not the default)', () => {
    // Fable 5 is double opus pricing and becomes credit-gated post-launch, so
    // it must not silently become everyone's default.
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
  });

  it('coerce passes the bare id through and normalises an uppercase typo path', () => {
    expect(coerceToAvailableModel('claude-fable-5')).toBe('claude-fable-5');
    expect(coerceToAvailableModel('  claude-fable-5  ')).toBe('claude-fable-5');
  });

  it('renders curated display labels that tell the two spellings apart', () => {
    const store = makeStore();
    // "(1M)" now marks the spelling whose CLIENT denominator is 1M. The bare
    // id keeps a plain label: Claude Code sizes it at 200k.
    expect(store.getModelDisplayName('claude-fable-5')).toBe('Fable 5');
    expect(store.getModelDisplayName('claude-fable-5[1m]')).toBe('Fable 5 (1M)');
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
