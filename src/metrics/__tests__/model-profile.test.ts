/**
 * Canonical model profiles (Task 1 of the autocompact-model-thresholds plan).
 *
 * `resolveModelProfile` is the ONE place that answers, for a model id:
 *   • effective context window
 *   • SDK input hard-block limit (`CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`)
 *   • auto-compact default in tokens (a HARNESS number — consumed by
 *     `checkAndSchedulePendingCompact`, never exported to the SDK env)
 *   • the headroom a session threshold must keep below the blocking limit
 *
 * Compaction authority is the harness scheduler's (ruling 2026-08-26); the
 * SDK's own automatic compaction is switched off in `build-stream-options.ts`.
 *
 * The tests below are a LITERAL table — the requested thresholds are policy,
 * not a formula, so they are pinned by value. Everything not in the policy
 * overlay must keep its pre-existing resolution (regex families → catalog →
 * 200k fallback), which the regression block pins.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { modelCatalog } from '../../model-catalog';
import {
  CANONICAL_MODEL_IDS,
  DEFAULT_COMPACT_HEADROOM,
  isRejectedModelInput,
  type ModelInputCompatibility,
  type ModelInputRejected,
  type ModelProfile,
  resolveModelInputCompatibility,
  resolveModelProfile,
} from '../model-profile';
import { resolveAutoCompactTokens, resolveContextWindow } from '../model-registry';

const GROK_4_5 = {
  id: 'grok-4.5',
  aliases: ['grok'],
  name: 'Grok 4.5',
  efforts: ['low', 'medium', 'high'],
  max_context: 500_000,
  group: 'grok',
};

afterEach(() => {
  modelCatalog.__testReset();
});

interface TableRow {
  modelId: string;
  contextWindow: number;
  sdkBlockingLimit: number;
  autoCompactTokens: number | undefined;
}

/** The requested policy table, verbatim from the plan's global constraints. */
const POLICY_TABLE: TableRow[] = [
  { modelId: 'claude-fable-5[1m]', contextWindow: 1_000_000, sdkBlockingLimit: 977_000, autoCompactTokens: 750_000 },
  { modelId: 'claude-opus-5[1m]', contextWindow: 1_000_000, sdkBlockingLimit: 977_000, autoCompactTokens: 750_000 },
  { modelId: 'claude-opus-5', contextWindow: 200_000, sdkBlockingLimit: 177_000, autoCompactTokens: undefined },
  { modelId: 'gpt-5.6-sol[1m]', contextWindow: 1_000_000, sdkBlockingLimit: 977_000, autoCompactTokens: 600_000 },
  { modelId: 'gpt-5.6-sol', contextWindow: 372_000, sdkBlockingLimit: 349_000, autoCompactTokens: 340_000 },
  { modelId: 'grok-4.6', contextWindow: 500_000, sdkBlockingLimit: 477_000, autoCompactTokens: 450_000 },
];

describe('resolveModelProfile — canonical policy table', () => {
  for (const row of POLICY_TABLE) {
    it(`${row.modelId} → ${row.contextWindow} / ${row.sdkBlockingLimit} / ${row.autoCompactTokens ?? 'no default'}`, () => {
      const profile: ModelProfile = resolveModelProfile(row.modelId);
      expect(profile.modelId).toBe(row.modelId);
      expect(profile.contextWindow).toBe(row.contextWindow);
      expect(profile.sdkBlockingLimit).toBe(row.sdkBlockingLimit);
      expect(profile.autoCompactTokens).toBe(row.autoCompactTokens);
    });
  }

  it('claude-opus-5 (bare) carries NO 750k default — 1M is the `[1m]` opt-in only', () => {
    expect(resolveModelProfile('claude-opus-5').autoCompactTokens).toBeUndefined();
    expect(resolveModelProfile('claude-opus-5').contextWindow).toBe(200_000);
    expect(resolveModelProfile('claude-opus-5[1m]').autoCompactTokens).toBe(750_000);
  });

  it('gpt-5.6-sol[1m] does NOT inherit the bare family 349k blocking limit', () => {
    expect(resolveModelProfile('gpt-5.6-sol[1m]').sdkBlockingLimit).toBe(977_000);
    expect(resolveModelProfile('gpt-5.6-sol').sdkBlockingLimit).toBe(349_000);
  });

  it('is case-insensitive and trims, echoing the canonical id back', () => {
    expect(resolveModelProfile('  GPT-5.6-SOL[1M] ').modelId).toBe('gpt-5.6-sol[1m]');
    expect(resolveModelProfile('  GPT-5.6-SOL[1M] ').autoCompactTokens).toBe(600_000);
    expect(resolveModelProfile('Claude-Opus-5[1m]').modelId).toBe('claude-opus-5[1m]');
  });

  it('resolves the policy table without any catalog snapshot loaded', () => {
    // The overlay is policy, not catalog-derived: an empty catalog must not
    // downgrade grok-4.6 to the 200k fallback.
    expect(modelCatalog.getModels()).toHaveLength(0);
    expect(resolveModelProfile('grok-4.6').contextWindow).toBe(500_000);
  });

  it('exports the canonical id set covering the whole policy table', () => {
    for (const row of POLICY_TABLE) {
      expect(CANONICAL_MODEL_IDS).toContain(row.modelId);
    }
  });
});

describe('resolveModelProfile — compact headroom safety invariant', () => {
  it('every canonical default satisfies tokens ≤ blockingLimit − compactHeadroom', () => {
    for (const id of CANONICAL_MODEL_IDS) {
      const p = resolveModelProfile(id);
      expect(p.compactHeadroom).toBe(DEFAULT_COMPACT_HEADROOM);
      if (p.autoCompactTokens !== undefined) {
        expect(p.autoCompactTokens).toBeLessThanOrEqual(p.sdkBlockingLimit - p.compactHeadroom);
      }
    }
  });

  it('gpt-5.6-sol is the tightest pair and pins the headroom value', () => {
    const p = resolveModelProfile('gpt-5.6-sol');
    expect(p.sdkBlockingLimit - (p.autoCompactTokens as number)).toBe(DEFAULT_COMPACT_HEADROOM);
  });
});

describe('resolveModelProfile — sdkBlockingLimit is a window fact, not a classifier', () => {
  /**
   * There is no per-model "does the SDK know this id?" tier any more. The
   * blocking limit is always the SDK's own formula on the profile window, and
   * the builder always injects it — for the ids the SDK sizes correctly the
   * injected number simply equals what the SDK would have computed, and for
   * the ones it does not it stops the ~177k hard block. One rule, no
   * classifier to keep in sync.
   */
  it('exposes no per-model override / disable classifier fields', () => {
    for (const id of ['claude-fable-5[1m]', 'claude-opus-5', 'grok-4.6']) {
      expect(resolveModelProfile(id)).not.toHaveProperty('overrideSdkBlockingLimit');
      expect(resolveModelProfile(id)).not.toHaveProperty('disableSdkAutoCompact');
    }
  });

  it('always answers window − 23k, for known and unknown ids alike', () => {
    const limits: [model: string, limit: number][] = [
      ['claude-fable-5', 977_000],
      ['claude-fable-5[1m]', 977_000],
      ['claude-opus-5', 177_000],
      ['claude-opus-5[1m]', 977_000],
      ['gpt-5.6-sol', 349_000],
      ['gpt-5.6-sol[1m]', 977_000],
      ['gpt-5.5', 252_000],
      ['grok-4.6', 477_000],
      ['claude-opus-4-7', 177_000],
      ['claude-opus-4-7[1m]', 977_000],
      ['', 177_000],
    ];
    for (const [model, limit] of limits) {
      const p = resolveModelProfile(model);
      expect(p.sdkBlockingLimit).toBe(limit);
      expect(p.sdkBlockingLimit).toBe(p.contextWindow - 23_000);
    }
  });
});

describe('resolveModelProfile — non-policy models keep their prior resolution', () => {
  it('bare claude ids stay on the 200k fallback', () => {
    const p = resolveModelProfile('claude-opus-4-7');
    expect(p.contextWindow).toBe(200_000);
    expect(p.sdkBlockingLimit).toBe(177_000);
    expect(p.autoCompactTokens).toBeUndefined();
  });

  it('bare claude-sonnet-4-6 stays 200k/177k despite the SDK coral_reef experiment', () => {
    // The pinned SDK can answer 1e6 for BARE sonnet-4-6 (`XV8` in cli.js:
    // `O3(q).includes("sonnet-4-6") && clientDataCache?.coral_reef_sonnet==="true"`)
    // — an account-level experiment we neither control nor observe. The
    // soma-work profile stays 200k anyway: that is the window the harness
    // advertises, meters and schedules compaction against, and the universal
    // 177000 blocking-limit injection makes the SDK agree with it instead of
    // silently running a different budget. 1M on sonnet is reached the same
    // way as on opus — by asking for `[1m]`.
    const p = resolveModelProfile('claude-sonnet-4-6');
    expect(p.contextWindow).toBe(200_000);
    expect(p.sdkBlockingLimit).toBe(177_000);
    expect(p.autoCompactTokens).toBeUndefined();
    expect(resolveModelProfile('claude-sonnet-4-6[1m]').contextWindow).toBe(1_000_000);
  });

  it('the generic `[1m]` opt-in stays 1M / 977k', () => {
    const p = resolveModelProfile('claude-opus-4-7[1m]');
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.sdkBlockingLimit).toBe(977_000);
  });

  it('native-1M fable (bare) keeps 1M / 977k / no token default', () => {
    const p = resolveModelProfile('claude-fable-5');
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.sdkBlockingLimit).toBe(977_000);
    expect(p.autoCompactTokens).toBeUndefined();
  });

  it('gpt-5.6 sibling tiers keep the family window / limit / trigger', () => {
    for (const id of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6']) {
      const p = resolveModelProfile(id);
      expect(p.contextWindow).toBe(372_000);
      expect(p.sdkBlockingLimit).toBe(349_000);
      expect(p.autoCompactTokens).toBe(340_000);
    }
  });

  it('gpt-5.5 keeps 275k / 252k / 250k', () => {
    const p = resolveModelProfile('gpt-5.5');
    expect(p.contextWindow).toBe(275_000);
    expect(p.sdkBlockingLimit).toBe(252_000);
    expect(p.autoCompactTokens).toBe(250_000);
  });

  it('non-claude catalog models resolve from the catalog window (grok-4.5 → 500k/477k)', () => {
    modelCatalog.__testSeed([GROK_4_5]);
    const p = resolveModelProfile('grok-4.5');
    expect(p.contextWindow).toBe(500_000);
    expect(p.sdkBlockingLimit).toBe(477_000);
    expect(p.autoCompactTokens).toBeUndefined();
  });

  it('falls back to 200k / 177k for a catalog-less unknown id', () => {
    const p = resolveModelProfile('grok-4.5');
    expect(p.contextWindow).toBe(200_000);
    expect(p.sdkBlockingLimit).toBe(177_000);
  });

  it('claude-group catalog entries never override the bare-id 200k contract', () => {
    modelCatalog.__testSeed([
      { id: 'claude-opus-4-8', aliases: [], name: 'Opus 4.8', efforts: [], max_context: 1_000_000, group: 'claude' },
    ]);
    const p = resolveModelProfile('claude-opus-4-8');
    expect(p.contextWindow).toBe(200_000);
    expect(p.sdkBlockingLimit).toBe(177_000);
  });

  it('an empty / missing model id resolves to the 200k fallback', () => {
    expect(resolveModelProfile('').contextWindow).toBe(200_000);
    expect(resolveModelProfile('   ').autoCompactTokens).toBeUndefined();
  });
});

describe('resolveModelProfile — results are immutable across callers', () => {
  /**
   * The resolver is a hot path shared by the stream executor, the threshold
   * checker and the options builder. Handing out a live reference to a policy
   * record means one caller's bookkeeping ("let me just clamp this window")
   * silently rewrites the policy every other caller reads afterwards, for the
   * lifetime of the process. So a resolved profile must be frozen, and a
   * mutation attempt must never be observable by the next resolve.
   */
  type MutableProfile = { -readonly [K in keyof ModelProfile]: ModelProfile[K] };

  /** Attempt an in-place mutation; a frozen object throws in strict mode. */
  function attemptMutate(profile: ModelProfile, patch: Partial<MutableProfile>): void {
    try {
      Object.assign(profile as MutableProfile, patch);
    } catch {
      // Frozen — the mutation was refused outright, which is the point.
    }
  }

  it('one caller cannot mutate the profile another caller resolves', () => {
    const first = resolveModelProfile('grok-4.6');
    attemptMutate(first, { contextWindow: 42, sdkBlockingLimit: 42, autoCompactTokens: 42 });

    const second = resolveModelProfile('grok-4.6');
    expect(second.contextWindow).toBe(500_000);
    expect(second.sdkBlockingLimit).toBe(477_000);
    expect(second.autoCompactTokens).toBe(450_000);
  });

  it('freezes every canonical policy record it hands out', () => {
    for (const id of CANONICAL_MODEL_IDS) {
      expect(Object.isFrozen(resolveModelProfile(id))).toBe(true);
    }
  });

  it('freezes derived (non-policy) profiles too', () => {
    for (const id of ['claude-fable-5', 'gpt-5.5', 'claude-opus-4-7', 'claude-opus-4-7[1m]', '']) {
      expect(Object.isFrozen(resolveModelProfile(id))).toBe(true);
    }
  });

  it('a mutated derived profile does not leak into the registry delegates', () => {
    attemptMutate(resolveModelProfile('gpt-5.6-sol'), { contextWindow: 1, autoCompactTokens: 1 });
    expect(resolveContextWindow('gpt-5.6-sol')).toBe(372_000);
    expect(resolveAutoCompactTokens('gpt-5.6-sol')).toBe(340_000);
  });

  it('the exported canonical id list is frozen', () => {
    expect(Object.isFrozen(CANONICAL_MODEL_IDS)).toBe(true);
  });
});

describe('resolveModelInputCompatibility — grok `[1m]` is REJECTED, not normalized', () => {
  /**
   * llmux's grok provider forwards any `grok-*` id verbatim upstream
   * (`src/provider/grok.rs:226-244`) — unlike the claude/codex paths, nothing
   * strips the suffix. So `grok-4.6[1m]` is not a spelling of a real model:
   * routing it would hit a nonexistent upstream id, and silently rewriting it
   * would serve a different model than the one asked for.
   */
  it('refuses grok-4.6[1m] and points at bare grok-4.6', () => {
    const result = resolveModelInputCompatibility('grok-4.6[1m]');
    expect(result).not.toBeNull();
    expect(isRejectedModelInput(result as ModelInputCompatibility)).toBe(true);
    expect(result).toMatchObject({ suggestedModel: 'grok-4.6' });
    expect((result as ModelInputRejected).rejectedReason).toContain('grok-4.6[1m]');
  });

  it('never returns a routable modelId for the rejected spelling', () => {
    expect(resolveModelInputCompatibility('grok-4.6[1m]')).not.toHaveProperty('modelId');
    expect(resolveModelInputCompatibility('  GROK-4.6[1M]  ')).not.toHaveProperty('modelId');
  });

  it('rejects the suffix on every grok id, not just the canonical one', () => {
    expect(resolveModelInputCompatibility('grok-4.5[1m]')).toMatchObject({ suggestedModel: 'grok-4.5' });
  });

  it('bare grok-4.6 stays a normal canonical input (500k / 477k / 450k)', () => {
    expect(resolveModelInputCompatibility('grok-4.6')).toEqual({ modelId: 'grok-4.6' });
    const profile = resolveModelProfile('grok-4.6');
    expect(profile.contextWindow).toBe(500_000);
    expect(profile.sdkBlockingLimit).toBe(477_000);
    expect(profile.autoCompactTokens).toBe(450_000);
  });

  it('canonical ids pass through as exactly { modelId }', () => {
    for (const id of CANONICAL_MODEL_IDS) {
      expect(resolveModelInputCompatibility(id)).toEqual({ modelId: id });
    }
  });

  it('returns null for inputs it has no opinion about', () => {
    expect(resolveModelInputCompatibility('gpt-5.6-terra')).toBeNull();
    expect(resolveModelInputCompatibility('totally-unknown')).toBeNull();
    expect(resolveModelInputCompatibility('')).toBeNull();
  });
});

describe('model-registry delegates to the profile resolver', () => {
  it('resolveContextWindow matches the profile for every canonical id', () => {
    for (const row of POLICY_TABLE) {
      expect(resolveContextWindow(row.modelId)).toBe(row.contextWindow);
    }
  });

  it('resolveAutoCompactTokens matches the profile for every canonical id', () => {
    for (const row of POLICY_TABLE) {
      expect(resolveAutoCompactTokens(row.modelId)).toBe(row.autoCompactTokens);
    }
  });

  it('keeps the pre-existing registry answers for non-policy ids', () => {
    expect(resolveContextWindow('claude-opus-4-8')).toBe(200_000);
    expect(resolveContextWindow('claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(resolveContextWindow('claude-fable-5')).toBe(1_000_000);
    expect(resolveContextWindow('gpt-5.5')).toBe(275_000);
    expect(resolveContextWindow(undefined)).toBe(200_000);
    expect(resolveAutoCompactTokens('claude-fable-5')).toBeUndefined();
    expect(resolveAutoCompactTokens('gpt-5.5')).toBe(250_000);
    expect(resolveAutoCompactTokens(undefined)).toBeUndefined();
  });
});
