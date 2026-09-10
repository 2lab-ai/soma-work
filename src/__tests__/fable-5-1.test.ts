/**
 * Locks the Claude Fable 5.1 (`claude-fable-5-1`) wiring, added 2026-09-10.
 *
 * Operator instruction: "모델 선택시 fable -> fable-5-1[1m] 이 선택되야함" — the bare
 * `fable` shorthand rolls to the newest fable generation, exactly as `opus`
 * follows the newest opus. Everything else about the pair of spellings is
 * inherited verbatim from Fable 5 (see fable-5.test.ts):
 *
 *   1. Profile identity. The declared 750k auto-compact default is a
 *      POLICY_PROFILES row keyed on the EXACT id `claude-fable-5-1[1m]`; the
 *      bare id takes the derived native-1M branch, which carries no
 *      `autoCompactTokens`, so the threshold is unreachable there.
 *   2. Client accounting. llmux serves `claude-fable-5-1[1m]` with a 1M client
 *      contextWindow, so the shorthand must land on the suffixed spelling or a
 *      user typing `fable` silently gets a fifth of the window they meant.
 *
 * The generation-pinned `fable-5` / `fable-5[1m]` aliases must NOT follow the
 * roll — that is the whole point of a pinned spelling.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANONICAL_MODEL_IDS, DEFAULT_COMPACT_HEADROOM, resolveModelProfile } from '../metrics/model-profile';
import {
  getModelSpec,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable51-test-'));
  return new UserSettingsStore(dir);
}

describe('fable-5.1 — release wiring', () => {
  it('lists both spellings, each directly above its Fable 5 predecessor', () => {
    const models = [...AVAILABLE_MODELS] as string[];
    expect(models).toContain('claude-fable-5-1');
    expect(models).toContain('claude-fable-5-1[1m]');
    // Newest generation first — the same ordering rule that puts 4.8 above 4.7.
    expect(models.indexOf('claude-fable-5-1')).toBe(models.indexOf('claude-fable-5') - 1);
    expect(models.indexOf('claude-fable-5-1[1m]')).toBe(models.indexOf('claude-fable-5[1m]') - 1);
  });

  it('keeps Fable 5 selectable — a roll adds a generation, it does not delete one', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-fable-5');
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-fable-5[1m]');
  });

  it('points every bare/5.1 `fable` alias at the literal claude-fable-5-1[1m]', () => {
    expect(MODEL_ALIASES.fable).toBe('claude-fable-5-1[1m]');
    expect(MODEL_ALIASES['fable[1m]']).toBe('claude-fable-5-1[1m]');
    expect(MODEL_ALIASES['fable-5-1']).toBe('claude-fable-5-1[1m]');
    expect(MODEL_ALIASES['fable-5-1[1m]']).toBe('claude-fable-5-1[1m]');
    // The release is written "5.1" as often as the id spells it "5-1".
    expect(MODEL_ALIASES['fable-5.1']).toBe('claude-fable-5-1[1m]');
    expect(MODEL_ALIASES['fable-5.1[1m]']).toBe('claude-fable-5-1[1m]');
  });

  it('leaves the generation-pinned `fable-5` aliases on Fable 5', () => {
    expect(MODEL_ALIASES['fable-5']).toBe('claude-fable-5[1m]');
    expect(MODEL_ALIASES['fable-5[1m]']).toBe('claude-fable-5[1m]');
  });

  it('resolves the aliases through the store, canonical bare id stays bare', () => {
    const store = makeStore();
    expect(store.resolveModelInput('fable')).toBe('claude-fable-5-1[1m]');
    expect(store.resolveModelInput('  FABLE ')).toBe('claude-fable-5-1[1m]');
    expect(store.resolveModelInput('fable-5.1')).toBe('claude-fable-5-1[1m]');
    expect(store.resolveModelInput('fable-5')).toBe('claude-fable-5[1m]');
    // The literal ids round-trip as themselves (allow-list membership).
    expect(store.resolveModelInput('claude-fable-5-1[1m]')).toBe('claude-fable-5-1[1m]');
    expect(store.resolveModelInput('claude-fable-5-1')).toBe('claude-fable-5-1');
  });

  it('round-trips through coerce without downgrading to DEFAULT_MODEL', () => {
    expect(coerceToAvailableModel('claude-fable-5-1[1m]')).toBe('claude-fable-5-1[1m]');
    expect(coerceToAvailableModel('claude-fable-5-1[1M]')).toBe('claude-fable-5-1[1m]');
    expect(coerceToAvailableModel('  claude-fable-5-1  ')).toBe('claude-fable-5-1');
  });

  it('does NOT change DEFAULT_MODEL (fable is opt-in, not the default)', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES.gpt).toBe('gpt-5.6-sol');
  });

  it('renders curated display labels that tell the two spellings apart', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(store.getModelDisplayName('claude-fable-5-1[1m]')).toBe('Fable 5.1 (1M)');
    // The predecessor's labels are untouched — the picker shows four rows.
    expect(store.getModelDisplayName('claude-fable-5')).toBe('Fable 5');
    expect(store.getModelDisplayName('claude-fable-5[1m]')).toBe('Fable 5 (1M)');
  });
});

describe('fable-5.1 — native 1M context (inherited from the fable family)', () => {
  it('resolveContextWindow returns 1M for the BARE id — no [1m] suffix', () => {
    expect(resolveContextWindow('claude-fable-5-1')).toBe(1_000_000);
  });

  it('is recognised as a native-1M model', () => {
    expect(isNativeOneMModel('claude-fable-5-1')).toBe(true);
  });

  it('the bare id carries NO auto-compact default — 750k lives on the [1m] id', () => {
    expect(resolveAutoCompactTokens('claude-fable-5-1')).toBeUndefined();
  });
});

describe('fable-5.1 — canonical policy row', () => {
  it('declares a POLICY_PROFILES row identical to claude-fable-5[1m]', () => {
    const five = resolveModelProfile('claude-fable-5[1m]');
    const fiveOne = resolveModelProfile('claude-fable-5-1[1m]');
    expect(fiveOne.modelId).toBe('claude-fable-5-1[1m]');
    expect(fiveOne.contextWindow).toBe(five.contextWindow);
    expect(fiveOne.sdkBlockingLimit).toBe(five.sdkBlockingLimit);
    expect(fiveOne.autoCompactTokens).toBe(five.autoCompactTokens);
    expect(fiveOne.autoCompactTokens).toBe(750_000);
    expect(CANONICAL_MODEL_IDS).toContain('claude-fable-5-1[1m]');
  });

  it('satisfies the compact-headroom invariant (tokens ≤ limit − headroom)', () => {
    const p = resolveModelProfile('claude-fable-5-1[1m]');
    expect(p.compactHeadroom).toBe(DEFAULT_COMPACT_HEADROOM);
    expect(p.autoCompactTokens as number).toBeLessThanOrEqual(p.sdkBlockingLimit - p.compactHeadroom);
  });

  it('is case-insensitive and trims, echoing the canonical id back', () => {
    expect(resolveModelProfile('  Claude-Fable-5-1[1M] ').modelId).toBe('claude-fable-5-1[1m]');
    expect(resolveModelProfile('  Claude-Fable-5-1[1M] ').autoCompactTokens).toBe(750_000);
  });
});

describe('fable-5.1 — model-registry pricing', () => {
  it('bills at the Fable tier ($10 in / $50 out), same row as Fable 5', () => {
    const spec = getModelSpec('claude-fable-5-1');
    expect(spec.pricing.inputPerMTok).toBe(10);
    expect(spec.pricing.outputPerMTok).toBe(50);
    expect(spec.pricing.cacheReadPerMTok).toBe(1);
    expect(spec.pricing.cache5minWritePerMTok).toBe(12.5);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(20);
    expect(spec.maxOutput).toBe(128_000);
    expect(spec.pricing).toEqual(getModelSpec('claude-fable-5').pricing);
  });

  it('bills the SUFFIXED id the same — that is the id every shorthand selects', () => {
    // The bare id is a spelling almost nobody types: `fable`, `fable[1m]`,
    // `fable-5.1`, … all resolve to `claude-fable-5-1[1m]`, so the runtime
    // billing lookup is done on the SUFFIXED id. The registry is substring
    // matched (`includes('fable-5')`), which is what makes the two agree —
    // assert it rather than trust it.
    const spec = getModelSpec('claude-fable-5-1[1m]');
    expect(spec.pricing.inputPerMTok).toBe(10);
    expect(spec.pricing.outputPerMTok).toBe(50);
    expect(spec.pricing.cacheReadPerMTok).toBe(1);
    expect(spec.pricing.cache5minWritePerMTok).toBe(12.5);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(20);
    expect(spec.contextWindow).toBe(1_000_000);
    expect(spec.maxOutput).toBe(128_000);
    expect(spec).toBe(getModelSpec('claude-fable-5-1'));
  });

  it('resolveContextWindow answers 1M for the suffixed runtime id', () => {
    // `resolveContextWindow` goes through the profile (the authoritative
    // number), not through the legacy `ModelSpec.contextWindow` field above.
    expect(resolveContextWindow('claude-fable-5-1[1m]')).toBe(1_000_000);
  });
});

describe('fable-5.1 — substring blast radius', () => {
  it('treats an unrelated `claude-fable-50-preview` as native-1M Fable tier', () => {
    // documents current blast radius — NOT a desired contract. Both the
    // native-1M predicate (`NATIVE_ONE_M_RE = /fable-5/i`, model-profile.ts)
    // and the pricing table (`includes('fable-5')`, model-registry.ts) are
    // substring matchers, so any future id containing "fable-5" — e.g. a
    // hypothetical `claude-fable-50-preview` — silently inherits the 1M window
    // and the $10/$50 Fable tier. Adding Fable 5.1 did not widen this (the
    // 5.1 id matches the same pre-existing pattern), and narrowing the regex
    // is a separate change with its own blast radius; this test exists so the
    // behaviour is visible instead of latent.
    expect(isNativeOneMModel('claude-fable-50-preview')).toBe(true);
    expect(resolveContextWindow('claude-fable-50-preview')).toBe(1_000_000);
    expect(getModelSpec('claude-fable-50-preview').pricing.inputPerMTok).toBe(10);
    // It is NOT selectable, though — the allow-list is exact-match, so the
    // substring matchers can only be reached by an id some other layer minted.
    expect(AVAILABLE_MODELS as readonly string[]).not.toContain('claude-fable-50-preview');
    expect(coerceToAvailableModel('claude-fable-50-preview')).toBe(DEFAULT_MODEL);
  });
});
