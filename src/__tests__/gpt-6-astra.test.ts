/**
 * Locks the gpt-6 (2026-09-03 release) wiring, added 2026-09-07.
 *
 * Per the openai/codex model catalog there is exactly ONE gpt-6 tier —
 * `gpt-6-astra` (display "GPT-6-Astra"; efforts low/medium/high/xhigh/max/
 * ultra, catalog default effort low; context_window 272000, the same class as
 * gpt-5.5's 272k input cap, NOT gpt-5.6's 372k). There is no
 * gpt-6-sol/terra/luna. It is served through llmux's codex backend group
 * (llmux forwards the slug verbatim and resolves the `astra` / `gpt-6`
 * aliases).
 *
 * Two load-bearing contracts:
 *   1. gpt-6-astra is user-SELECTABLE and the DEFAULT stays gpt-5.6-sol —
 *      the `gpt` alias is intentionally NOT bumped.
 *   2. Its declared auto-compact trigger is 240,000, which is exactly
 *      `sdkBlockingLimit − DEFAULT_COMPACT_HEADROOM`. An earlier cut used
 *      245,000; that number is unreachable — `safeMaxAutoCompactTokens`
 *      clamps to 240,000 — and 250,000 was worse still, sitting ABOVE the
 *      249,000 blocking limit, i.e. the SDK would refuse the input before the
 *      harness could schedule `/compact`. Both are pinned below.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANONICAL_MODEL_IDS, DEFAULT_COMPACT_HEADROOM, resolveModelProfile } from '../metrics/model-profile';
import {
  GPT_5_5_AUTO_COMPACT_TOKENS,
  GPT_5_5_CONTEXT_WINDOW,
  GPT_5_5_SDK_BLOCKING_LIMIT,
  GPT_5_6_AUTO_COMPACT_TOKENS,
  GPT_5_6_CONTEXT_WINDOW,
  GPT_5_6_SDK_BLOCKING_LIMIT,
  GPT_6_AUTO_COMPACT_TOKENS,
  GPT_6_CONTEXT_WINDOW,
  GPT_6_SDK_BLOCKING_LIMIT,
  getModelSpec,
  isGpt6Model,
  isGpt55Model,
  isGpt56Model,
  isNativeOneMModel,
  resolveAutoCompactTokens,
  resolveContextWindow,
} from '../metrics/model-registry';
import { resolveEffectiveAutoCompact, safeMaxAutoCompactTokens } from '../session/autocompact-policy';
import type { ConversationSession } from '../types';
import {
  AVAILABLE_MODELS,
  coerceToAvailableModel,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  UserSettingsStore,
} from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt6-test-'));
  return new UserSettingsStore(dir);
}

describe('gpt-6-astra — release wiring', () => {
  it('lists the single REAL tier id; no sol/terra/luna sibling exists', () => {
    const models = AVAILABLE_MODELS as readonly string[];
    expect(models).toContain('gpt-6-astra');
    expect(models).not.toContain('gpt-6');
    expect(models).not.toContain('gpt-6-sol');
    expect(models).not.toContain('gpt-6-terra');
    expect(models).not.toContain('gpt-6-luna');
  });

  it('offers no `[1m]` variant — the suffix was never probed on a gpt-6 id', () => {
    // gpt-5.6-sol ships `gpt-5.6-sol[1m]` because llmux was shown to accept it
    // upstream. No such evidence exists for gpt-6, so neither the allow-list
    // nor the policy table may advertise a 1M window for it.
    expect(AVAILABLE_MODELS as readonly string[]).not.toContain('gpt-6-astra[1m]');
    expect(CANONICAL_MODEL_IDS).not.toContain('gpt-6-astra[1m]');
  });

  it('is SELECTABLE but NOT the default — gpt-5.6-sol stays DEFAULT_MODEL', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES.gpt).toBe('gpt-5.6-sol');
  });

  it('resolves the astra / gpt-6 / gpt6 aliases to gpt-6-astra', () => {
    expect(MODEL_ALIASES.astra).toBe('gpt-6-astra');
    expect(MODEL_ALIASES['gpt-6']).toBe('gpt-6-astra');
    expect(MODEL_ALIASES.gpt6).toBe('gpt-6-astra');
    // The older generations must NOT be silently upgraded.
    expect(MODEL_ALIASES['gpt5.6']).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES['gpt5.5']).toBe('gpt-5.5');
    expect(MODEL_ALIASES.sol).toBe('gpt-5.6-sol');
  });

  it('resolveModelInput accepts the canonical id and the aliases', () => {
    const store = makeStore();
    expect(store.resolveModelInput('gpt-6-astra')).toBe('gpt-6-astra');
    expect(store.resolveModelInput('astra')).toBe('gpt-6-astra');
    expect(store.resolveModelInput('  GPT-6 ')).toBe('gpt-6-astra');
    expect(store.resolveModelInput('gpt6')).toBe('gpt-6-astra');
    // `gpt` still means the default generation.
    expect(store.resolveModelInput('gpt')).toBe('gpt-5.6-sol');
  });

  it('coerce round-trips gpt-6-astra and still falls back to sol otherwise', () => {
    expect(coerceToAvailableModel('gpt-6-astra')).toBe('gpt-6-astra');
    expect(coerceToAvailableModel('GPT-6-ASTRA')).toBe('gpt-6-astra');
    // The bare generation spelling is not in the allow-list — coerce lands on
    // DEFAULT_MODEL (which is deliberately NOT gpt-6).
    expect(coerceToAvailableModel('gpt-6')).toBe('gpt-5.6-sol');
    expect(coerceToAvailableModel('some-nonsense-model')).toBe('gpt-5.6-sol');
  });

  it('renders the curated display label', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('gpt-6-astra')).toBe('GPT-6 Astra (272k)');
  });
});

describe('gpt-6-astra — canonical profile (272k / 249k / 240k)', () => {
  it('is a DECLARED policy row, not a family-derived guess', () => {
    expect(CANONICAL_MODEL_IDS).toContain('gpt-6-astra');
    const p = resolveModelProfile('gpt-6-astra');
    expect(p.modelId).toBe('gpt-6-astra');
    expect(p.contextWindow).toBe(272_000);
    expect(p.sdkBlockingLimit).toBe(249_000);
    expect(p.autoCompactTokens).toBe(240_000);
    expect(p.compactHeadroom).toBe(DEFAULT_COMPACT_HEADROOM);
  });

  it('exports constants that agree with the profile', () => {
    expect(GPT_6_CONTEXT_WINDOW).toBe(272_000);
    expect(GPT_6_SDK_BLOCKING_LIMIT).toBe(249_000);
    expect(GPT_6_AUTO_COMPACT_TOKENS).toBe(240_000);
  });

  it('registry delegates resolve the same numbers', () => {
    expect(resolveContextWindow('gpt-6-astra')).toBe(272_000);
    expect(resolveAutoCompactTokens('gpt-6-astra')).toBe(240_000);
  });

  it('bare `gpt-6` and other family spellings inherit the family numbers', () => {
    // Not canonical ids, so they take the regex branch — which must answer the
    // same window/trigger rather than dropping to the 200k fallback.
    for (const id of ['gpt-6', 'GPT-6-Astra']) {
      const p = resolveModelProfile(id);
      expect(p.contextWindow).toBe(272_000);
      expect(p.autoCompactTokens).toBe(240_000);
    }
  });

  it('does not disturb the gpt-5.6 / gpt-5.5 or claude profiles', () => {
    expect(resolveContextWindow('gpt-5.6-sol')).toBe(372_000);
    expect(resolveAutoCompactTokens('gpt-5.6-sol')).toBe(340_000);
    expect(resolveContextWindow('gpt-5.5')).toBe(275_000);
    expect(resolveAutoCompactTokens('gpt-5.5')).toBe(250_000);
    expect(resolveContextWindow('claude-fable-5')).toBe(1_000_000);
  });

  it('isGpt6Model matches the generation boundary only', () => {
    for (const m of ['gpt-6', 'gpt-6-astra', 'gpt-6-astra[1m]', 'GPT-6-Astra']) {
      expect(isGpt6Model(m)).toBe(true);
    }
    // A future generation / unrelated numbering must NOT be swallowed.
    for (const m of ['gpt-60', 'gpt-6.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.5', 'claude-fable-5']) {
      expect(isGpt6Model(m)).toBe(false);
    }
  });

  it('gpt-6-astra is not mistaken for gpt-5.6 / gpt-5.5 / native-1M', () => {
    expect(isGpt56Model('gpt-6-astra')).toBe(false);
    expect(isGpt55Model('gpt-6-astra')).toBe(false);
    expect(isNativeOneMModel('gpt-6-astra')).toBe(false);
  });
});

// The ordering invariant for every model that declares an absolute trigger:
//
//   autoCompactTokens ≤ sdkBlockingLimit − compactHeadroom < contextWindow
//
// If the trigger lands at or above the blocking limit, the SDK hard-blocks the
// input BEFORE the turn-end checker can schedule `/compact` and the session
// dead-ends. The first cut of gpt-6 had exactly that bug (250k trigger vs a
// 249k limit), so all three gpt generations are pinned here.
describe('gpt generations — compact-before-hard-block invariant', () => {
  it('gpt-6: 240k ≤ 249k − 9k < 272k', () => {
    expect(GPT_6_AUTO_COMPACT_TOKENS).toBeLessThanOrEqual(GPT_6_SDK_BLOCKING_LIMIT - DEFAULT_COMPACT_HEADROOM);
    expect(GPT_6_SDK_BLOCKING_LIMIT).toBeLessThan(GPT_6_CONTEXT_WINDOW);
  });

  it('gpt-5.6: 340k ≤ 349k − 9k < 372k', () => {
    expect(GPT_5_6_AUTO_COMPACT_TOKENS).toBeLessThanOrEqual(GPT_5_6_SDK_BLOCKING_LIMIT - DEFAULT_COMPACT_HEADROOM);
    expect(GPT_5_6_SDK_BLOCKING_LIMIT).toBeLessThan(GPT_5_6_CONTEXT_WINDOW);
  });

  it('gpt-5.5: 250k < 252k < 275k (family default, below the limit)', () => {
    expect(GPT_5_5_AUTO_COMPACT_TOKENS).toBeLessThan(GPT_5_5_SDK_BLOCKING_LIMIT);
    expect(GPT_5_5_SDK_BLOCKING_LIMIT).toBeLessThan(GPT_5_5_CONTEXT_WINDOW);
  });

  it("gpt-6's declared trigger is REACHABLE — not clamped by the session policy", () => {
    // This is the test the 245k cut would have failed: safeMax is 240,000, so
    // a declared 245,000 would be silently reduced and the constant would not
    // describe what the session does.
    expect(safeMaxAutoCompactTokens('gpt-6-astra')).toBe(240_000);
    expect(GPT_6_AUTO_COMPACT_TOKENS).toBeLessThanOrEqual(safeMaxAutoCompactTokens('gpt-6-astra'));

    const session = { model: 'gpt-6-astra' } as ConversationSession;
    const store = { getUserCompactThreshold: () => 80 };
    const effective = resolveEffectiveAutoCompact(session, 'U1', store);
    expect(effective.source).toBe('model');
    expect(effective.tokens).toBe(GPT_6_AUTO_COMPACT_TOKENS);
    expect(effective.contextWindow).toBe(272_000);
  });
});

describe('gpt-6-astra — model-registry pricing (2026-09 launch rates)', () => {
  it('$10 in / $50 out / $1 cache-read, no cache-write charge, 272k window', () => {
    const spec = getModelSpec('gpt-6-astra');
    expect(spec.pricing.inputPerMTok).toBe(10);
    expect(spec.pricing.outputPerMTok).toBe(50);
    expect(spec.pricing.cacheReadPerMTok).toBe(1);
    expect(spec.pricing.cache5minWritePerMTok).toBe(0);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(0);
    expect(spec.contextWindow).toBe(272_000);
    expect(spec.maxOutput).toBe(128_000);
  });

  it('does not shadow the gpt-5.6 tiers (substring matching is first-wins)', () => {
    expect(getModelSpec('gpt-5.6-sol').pricing.inputPerMTok).toBe(5);
    expect(getModelSpec('gpt-5.6-terra').pricing.inputPerMTok).toBe(2.5);
    expect(getModelSpec('gpt-5.6-luna').pricing.inputPerMTok).toBe(1);
  });
});
