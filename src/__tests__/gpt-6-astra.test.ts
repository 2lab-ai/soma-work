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

  it('ships the `[1m]` variant alongside the bare id (user-selectable 1M opt-in)', () => {
    // The 1M opt-in is user-selectable — the [1m] SDK-side unlock path is the
    // same as gpt-5.6-sol[1m]: soma-work/SDK sends the `[1m]`-annotated id to
    // llmux, and llmux's codex provider strips the trailing `[1m]` before
    // forwarding upstream as the bare slug (llmux src/provider/codex.rs
    // CLIENT_CONTEXT_SUFFIX). The 1M numbers are derived by model-profile.ts
    // via the suffix rule, not a canonical POLICY_PROFILES row.
    expect(AVAILABLE_MODELS as readonly string[]).toContain('gpt-6-astra[1m]');
    // No new canonical row — model-profile.ts derives the 1M numbers from the
    // [1m] suffix rule + the family branch.
    expect(CANONICAL_MODEL_IDS).not.toContain('gpt-6-astra[1m]');
  });

  it('is SELECTABLE but NOT the default — gpt-5.6-sol stays DEFAULT_MODEL', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES.gpt).toBe('gpt-5.6-sol');
  });

  it('astra / gpt-6 / gpt6 aliases point at the [1m] id (the 1M-opt-in default)', () => {
    // A user typing `astra` / `gpt-6` / `gpt6` gets the 1M window — the bare
    // 272k id is still selectable via its literal spelling, but shorthand must
    // NOT silently hand a fifth of the window the user expects.
    expect(MODEL_ALIASES.astra).toBe('gpt-6-astra[1m]');
    expect(MODEL_ALIASES['gpt-6']).toBe('gpt-6-astra[1m]');
    expect(MODEL_ALIASES.gpt6).toBe('gpt-6-astra[1m]');
    // The older generations must NOT be silently upgraded.
    expect(MODEL_ALIASES['gpt5.6']).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES['gpt5.5']).toBe('gpt-5.5');
    expect(MODEL_ALIASES.sol).toBe('gpt-5.6-sol');
  });

  it('resolveModelInput resolves the aliases to the [1m] variant, canonical stays bare', () => {
    const store = makeStore();
    // Literal canonical id — the caller explicitly asked for the 272k profile.
    expect(store.resolveModelInput('gpt-6-astra')).toBe('gpt-6-astra');
    // Shorthand — the 1M-opt-in variant.
    expect(store.resolveModelInput('astra')).toBe('gpt-6-astra[1m]');
    expect(store.resolveModelInput('  GPT-6 ')).toBe('gpt-6-astra[1m]');
    expect(store.resolveModelInput('gpt6')).toBe('gpt-6-astra[1m]');
    // Literal [1m] spelling round-trips as itself (allow-list membership).
    expect(store.resolveModelInput('gpt-6-astra[1m]')).toBe('gpt-6-astra[1m]');
    // `gpt` still means the default generation.
    expect(store.resolveModelInput('gpt')).toBe('gpt-5.6-sol');
  });

  it('astra[1m] shorthand resolves to gpt-6-astra[1m] (matches sol[1m] rule)', () => {
    // Regression: the tier-shorthand + `[1m]` spelling must resolve — the same
    // rule as `sol[1m]` → `gpt-5.6-sol[1m]` and `opus[1m]` → `claude-opus-5[1m]`.
    // Without an explicit `astra[1m]` alias entry, resolution falls through the
    // canonical policy (no row), AVAILABLE_MODELS (no match), MODEL_ALIASES (no
    // match), and the llmux catalog overlay (which advertises `astra` but not
    // `astra[1m]`), leaving a user-visible "unknown model" for a spelling that
    // is otherwise valid muscle-memory input.
    const store = makeStore();
    expect(store.resolveModelInput('astra[1m]')).toBe('gpt-6-astra[1m]');
    // Case/whitespace symmetry, mirroring the other alias assertions above.
    expect(store.resolveModelInput('  ASTRA[1M] ')).toBe('gpt-6-astra[1m]');
    // Also present in the exported alias table itself, so downstream consumers
    // that read MODEL_ALIASES directly see the mapping.
    expect(MODEL_ALIASES['astra[1m]']).toBe('gpt-6-astra[1m]');
  });

  it('coerce round-trips gpt-6-astra AND gpt-6-astra[1m]; nonsense falls back to sol', () => {
    // Both literal ids are in the allow-list, so both round-trip byte-identical.
    expect(coerceToAvailableModel('gpt-6-astra')).toBe('gpt-6-astra');
    expect(coerceToAvailableModel('GPT-6-ASTRA')).toBe('gpt-6-astra');
    expect(coerceToAvailableModel('gpt-6-astra[1m]')).toBe('gpt-6-astra[1m]');
    expect(coerceToAvailableModel('GPT-6-ASTRA[1M]')).toBe('gpt-6-astra[1m]');
    // The bare generation spelling is not in the allow-list — coerce (which
    // does NOT consult MODEL_ALIASES) still lands on DEFAULT_MODEL.
    expect(coerceToAvailableModel('gpt-6')).toBe('gpt-5.6-sol');
    expect(coerceToAvailableModel('some-nonsense-model')).toBe('gpt-5.6-sol');
  });

  it('renders the curated display labels for both variants', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('gpt-6-astra')).toBe('GPT-6 Astra (272k)');
    // The 1M spelling gets its own label, mirroring gpt-5.6-sol[1m] → "(1M)".
    expect(store.getModelDisplayName('gpt-6-astra[1m]')).toBe('GPT-6 Astra (1M)');
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

  it('gpt-6-astra[1m] derives a 1M profile via the suffix rule (no canonical row needed)', () => {
    // Mirrors the gpt-5.6-sol[1m] contract: model-profile.ts already answers
    // contextWindow=1_000_000 / sdkBlockingLimit=977_000 for any [1m] id, and
    // family lookup on the stripped base yields the gpt-6 auto-compact trigger.
    const p = resolveModelProfile('gpt-6-astra[1m]');
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.sdkBlockingLimit).toBe(977_000);
    // Family auto-compact trigger is preserved through the strip → family
    // branch: GPT_6_AUTO_COMPACT_TOKENS (240,000). It must NOT jump to the
    // 750k / 600k literals attached to opus[1m] / sol[1m].
    expect(p.autoCompactTokens).toBe(GPT_6_AUTO_COMPACT_TOKENS);
  });

  it('registry delegates agree on the [1m] window / trigger', () => {
    expect(resolveContextWindow('gpt-6-astra[1m]')).toBe(1_000_000);
    expect(resolveAutoCompactTokens('gpt-6-astra[1m]')).toBe(GPT_6_AUTO_COMPACT_TOKENS);
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
