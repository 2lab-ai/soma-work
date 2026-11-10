/**
 * Unified model registry — single source of truth for pricing, context windows, and max output.
 * Source: https://docs.anthropic.com/en/docs/about-claude/models (claude rows); each non-claude
 * row names its own source.
 * Last updated: 2026-11-10 (Fable 5.2, gpt-6.1-terra, gpt-6-sol / gpt-6-luna and grok rows)
 */

import { resolveModelProfile } from './model-profile';

/**
 * Context-window / auto-compact / blocking-limit facts now live in
 * `model-profile.ts` (the single canonical resolver). They are re-exported
 * here so the many existing importers of this module keep working unchanged.
 */
export {
  FALLBACK_CONTEXT_WINDOW,
  GPT_5_5_AUTO_COMPACT_TOKENS,
  GPT_5_5_CONTEXT_WINDOW,
  GPT_5_5_SDK_BLOCKING_LIMIT,
  GPT_5_6_AUTO_COMPACT_TOKENS,
  GPT_5_6_CONTEXT_WINDOW,
  GPT_5_6_SDK_BLOCKING_LIMIT,
  GPT_6_AUTO_COMPACT_TOKENS,
  GPT_6_CONTEXT_WINDOW,
  GPT_6_SDK_BLOCKING_LIMIT,
  hasOneMSuffix,
  isGpt6Model,
  isGpt55Model,
  isGpt56Model,
  isNativeOneMModel,
  isRejectedModelInput,
  type ModelInputAccepted,
  type ModelInputCompatibility,
  type ModelInputRejected,
  type ModelProfile,
  ONE_M_SUFFIX_RE,
  resolveModelInputCompatibility,
  resolveModelProfile,
  stripOneMSuffix,
} from './model-profile';

export const PRICING_VERSION = '2026-11-10';

export interface ModelPricingSpec {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /** Cache write with 5-minute TTL (default) — 1.25× base input */
  cache5minWritePerMTok: number;
  /** Cache write with 1-hour TTL — 2× base input */
  cache1hrWritePerMTok: number;
}

export interface ModelSpec {
  pricing: ModelPricingSpec;
  /**
   * LEGACY, NOT AUTHORITATIVE. The registry is substring-matched, so one row
   * covers a family including its `[1m]` variant and it cannot express the
   * suffix opt-in at all (the `opus-4-8` row says 1M while bare
   * `claude-opus-4-8` is a 200k profile). The effective window every consumer
   * must use is `resolveModelProfile(id).contextWindow` — this field survives
   * only because `getModelSpec` is a public shape. Nothing in `src/` reads it.
   */
  contextWindow: number;
  maxOutput: number;
}

/**
 * Model registry. Key = substring matched against full model name.
 * Order matters — first match wins.
 */
const MODEL_REGISTRY: [pattern: string, spec: ModelSpec][] = [
  // Claude Fable 5.2 (released 2026-11-09) — CHEAPER than Fable 5 / 5.1:
  // $8 in / $40 out / $0.20 cache read / $10 5-min write / $16 1-h write per
  // MTok, no long-context tier (the full 1M bills at these rates). Source:
  // https://platform.claude.com/docs/en/about-claude/pricing (read
  // 2026-11-10); llmux `src/pricing.rs` `FABLE_5_2` carries the same
  // (8.0, 40.0, 0.20, 10.0). `claude-fable-5-2` also contains `fable-5`, so
  // this row MUST stay above `fable-5` (and, by convention, above
  // `fable-5-1`): without it every Fable 5.2 call was priced at Fable 5's
  // $10 / $50 / $1.
  [
    'fable-5-2',
    {
      pricing: {
        inputPerMTok: 8,
        outputPerMTok: 40,
        cacheReadPerMTok: 0.2,
        cache5minWritePerMTok: 10,
        cache1hrWritePerMTok: 16,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // Claude Fable 5.1 — same input/output as Fable 5, but cache reads at
  // $0.25/MTok (Fable 5: $1). Official first-party rates (claude-api reference,
  // 2026-09-25); the Agent SDK prices its result `modelUsage` with exactly
  // these (fitted from dev token_usage records, 2026-10-27: 0% error). Before
  // this row `claude-fable-5-1` matched `fable-5` and its cache reads — most of
  // its tokens — were priced 4x too high. MUST stay above `fable-5`.
  [
    'fable-5-1',
    {
      pricing: {
        inputPerMTok: 10,
        outputPerMTok: 50,
        cacheReadPerMTok: 0.25,
        cache5minWritePerMTok: 12.5,
        cache1hrWritePerMTok: 20,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // Claude Fable 5 (2026-06-09). Anthropic's most capable generally-available
  // model: 1M context, 128k max output. Pricing is double Opus-tier
  // ($10 in / $50 out per MTok). cacheRead = 0.1×input, 5min write = 1.25×input,
  // 1hr write = 2×input — same multipliers as every other tier. Listed first so
  // the `includes('fable-5')` matcher resolves before any opus/sonnet pattern.
  [
    'fable-5',
    {
      pricing: {
        inputPerMTok: 10,
        outputPerMTok: 50,
        cacheReadPerMTok: 1,
        cache5minWritePerMTok: 12.5,
        cache1hrWritePerMTok: 20,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // Claude Opus 5.5 — successor to Opus 5 at a lower price: $4 in / $20 out /
  // $0.20 cache read per MTok; 5min write 1.25×input, 1hr 2×input. Official
  // first-party rates (claude-api reference, 2026-09-25), the same the Agent
  // SDK prices its results with (fitted from 369 dev records, 2026-10-27).
  // `claude-opus-5-5` also contains `opus-5`, so this row MUST stay above it —
  // without it every Opus 5.5 call was priced at Opus 5's $5 / $25 / $0.50.
  [
    'opus-5-5',
    {
      pricing: {
        inputPerMTok: 4,
        outputPerMTok: 20,
        cacheReadPerMTok: 0.2,
        cache5minWritePerMTok: 5,
        cache1hrWritePerMTok: 8,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // Claude Opus 5 (2026-08-26) — Opus tier, same rates as the 4.x opus rows
  // ($5 in / $25 out / $0.5 cache-read; 5min write 1.25×input, 1hr 2×input).
  // Cross-checked against llmux, which is the component that actually bills
  // this traffic: `llmux/src/pricing.rs:103-105` maps `claude-opus-5` to
  // `OPUS_TIER` = ModelPrice::new(5.0, 25.0, 0.5, 6.25).
  //
  // MUST stay above the generic `sonnet-4-` / `haiku-4-` fallbacks — and it
  // must exist at all: `claude-opus-5` matches NO other pattern in this table
  // (`opus-4-8`, `opus-4-5`, … all carry a `4-`), so without this row every
  // Opus 5 turn was priced at FALLBACK_SPEC's Sonnet rates. `opus-5` does not
  // collide with `claude-opus-4-5-*` either — that id spells `opus-4-5`.
  [
    'opus-5',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 6.25,
        cache1hrWritePerMTok: 10,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-6-astra — the gpt-6 generation (2026-09-03 release; $10 in /
  // $50 out / $1 cache-read per MTok, 2026-09 launch standard-tier rates; no
  // cache-creation charge on codex, same as every other gpt row). 272k
  // window — the openai/codex model catalog value (context_window 272000),
  // the same class as gpt-5.5's 272k input cap, NOT gpt-5.6's 372k. Context
  // numbers are policy and live in model-profile.ts; this row is pricing.
  [
    'gpt-6-astra',
    {
      pricing: {
        inputPerMTok: 10,
        outputPerMTok: 50,
        cacheReadPerMTok: 1,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 272_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-6-sol (released 2026-09-22) — $2 in / $10 out / $0.20 cache
  // read per MTok (developers.openai.com model page; llmux `src/pricing.rs`
  // `GPT_6_SOL` = (2.0, 10.0, 0.20, 2.5)). Not a static allow-list id — it
  // reaches users through the llmux catalog overlay, and as a non-claude
  // catalog model it is priced by THIS table (host-pricing.ts), so without a
  // row it was booked at FALLBACK_SPEC's Sonnet rates. Cache writes stay 0:
  // llmux reports no cache-creation tokens on the codex wire. `gpt-6-sol` is
  // not a substring of `gpt-6.1-sol` (`gpt-6-` vs `gpt-6.`), and no other
  // pattern here is a substring of it.
  [
    'gpt-6-sol',
    {
      pricing: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.2,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 272_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-6-luna (released 2026-09-22) — $0.10 in / $0.50 out / $0.01
  // cache read per MTok (OpenAI pricing page; llmux `GPT_6_LUNA` = (0.10,
  // 0.50, 0.01, 0.125)). Catalog-overlay model, host-priced like gpt-6-sol;
  // cache writes 0 for the same codex-wire reason.
  [
    'gpt-6-luna',
    {
      pricing: {
        inputPerMTok: 0.1,
        outputPerMTok: 0.5,
        cacheReadPerMTok: 0.01,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 272_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-6.1-sol — the newest sol generation ($2 in / $10 out / $0.10
  // cache-read per MTok, OpenAI standard-tier rates). OpenAI also lists a
  // $2.50 cache-write rate and llmux carries it (`llmux/src/pricing.rs`
  // `GPT_6_1_SOL` = ModelPrice::new(2.0, 10.0, 0.10, 2.5)), but llmux reports
  // cache_creation_input_tokens as 0 on the codex wire
  // (`llmux/src/provider/responses.rs`, cache_write_tokens mapping), so the
  // write rate never applies here — both cache-write fields stay 0. 272k
  // window — the openai/codex model catalog value (context_window 272000);
  // the `[1m]` twin reaches 1M.
  // Context numbers are policy and live in model-profile.ts; this row is
  // pricing. No other pattern in this table is a substring of `gpt-6.1-sol`,
  // and it is a substring of no other id, so first-wins cannot misattribute.
  [
    'gpt-6.1-sol',
    {
      pricing: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.1,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 272_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-6.1-terra (released 2026-10-26) — generation 6.1's mid tier:
  // $1 in / $5 out / $0.05 cache read per MTok, half of 6.1-sol (OpenAI model
  // page https://developers.openai.com/api/docs/models/gpt-6.1-terra and the
  // pricing page, read 2026-11-10; llmux `GPT_6_1_TERRA` = (1.0, 5.0, 0.05,
  // 1.25)). OpenAI's $1.25 cache-write rate never applies here — llmux
  // reports no cache-creation tokens on the codex wire — so both cache-write
  // fields stay 0, like every codex row. The >272k-input long-context
  // surcharge is not modeled (llmux does not model it either). 500k window —
  // the openai/codex models.json context_window; the `[1m]` twin reaches 1M.
  // Context numbers are policy and live in model-profile.ts. No pattern here
  // is a substring of `gpt-6.1-terra` (`gpt-5.6-terra` differs in its
  // generation), and it is a substring of no other id.
  [
    'gpt-6.1-terra',
    {
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.05,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 500_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-5.6-terra — mid tier of the gpt-5.6 family ($2.50 in / $15
  // out / $0.25 cache-read per MTok, 2026-07-09 launch rates; no
  // cache-creation charge on codex). Same 372k window as sol — official
  // value from the openai/codex model catalog (models-manager/models.json),
  // probe-consistent (369,755-token input accepted, ~380k rejected).
  // MUST stay ABOVE the 'gpt-5.6' entry — patterns are substring-matched
  // first-wins, and 'gpt-5.6' would swallow 'gpt-5.6-terra'.
  [
    'gpt-5.6-terra',
    {
      pricing: {
        inputPerMTok: 2.5,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.25,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 372_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-5.6-luna — budget tier ($1 in / $6 out / $0.1 cache-read per
  // MTok, 2026-07-09 launch rates; no cache-creation charge on codex). Same
  // 372k catalog window. MUST stay above the generic 'gpt-5.6' pattern.
  [
    'gpt-5.6-luna',
    {
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 6,
        cacheReadPerMTok: 0.1,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 372_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-5.6 family fallback (sol rates) — served via llmux's codex
  // backend group. There is no bare `gpt-5.6` model; this pattern catches
  // `gpt-5.6-sol` plus the legacy bare-id spelling in old transcripts and
  // future dated sol snapshots. Rates match OpenAI's 2026-07-09 launch
  // pricing for the sol flagship: $5 in / $30 out / $0.5 cache-read per
  // MTok, no cache-creation charge on codex. Context window is 372k — the
  // official openai/codex catalog value (models-manager/models.json:
  // context_window 372000 for sol/terra/luna alike), probe-consistent
  // (369,755-token input accepted, ~380k rejected) — with harness-side
  // auto-compact at 340k (see GPT_5_6_* constants below). Terra/luna have
  // their own entries ABOVE this one (substring matching is first-wins).
  [
    'gpt-5.6',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 30,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 372_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-5.5 — served via llmux's codex backend group (llmux routes
  // `gpt-` prefixed ids to codex; see llmux src/routing.rs). Rates mirror
  // llmux's built-in gpt-5.5 pricing (2026-04-23): $5 in / $30 out /
  // $0.5 cache-read per MTok, and NO cache-creation charge (codex has no
  // cache-write billing — both write rates are 0). Context window is 275k
  // with harness-side auto-compact at 250k (see GPT_5_5_* constants below).
  [
    'gpt-5.5',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 30,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 275_000,
      maxOutput: 128_000,
    },
  ],
  // xAI grok rows — served through llmux's grok group, so (like the codex
  // rows) host-priced by THIS table via host-pricing.ts; without them every
  // grok call was booked at FALLBACK_SPEC's Sonnet rates. Rates are xAI's
  // list prices below 200k prompt tokens (docs.x.ai models / pricing pages,
  // re-read 2026-11-10) and match llmux `src/pricing.rs` `GROK_4_7` /
  // `GROK_4_6` / `GROK_4_5`. The ≥200k tier (rates double) is not modeled,
  // and both cache-write fields are 0: xAI lists no cache-write rate and
  // llmux reports no cache-creation tokens for grok. Windows are 500k each;
  // xAI publishes no max output, so `maxOutput` is a placeholder (only tests
  // read that field).
  // `grok-4.7` also prices the Grok Build subscription id
  // `grok-4.7-build-fast` by substring (same model; xAI lists its Fast mode
  // at 2x, which is not modeled). No grok pattern is a substring of another.
  [
    'grok-4.7',
    {
      pricing: {
        inputPerMTok: 2,
        outputPerMTok: 6,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 500_000,
      maxOutput: 128_000,
    },
  ],
  [
    'grok-4.6',
    {
      pricing: {
        inputPerMTok: 2,
        outputPerMTok: 6,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 500_000,
      maxOutput: 128_000,
    },
  ],
  // grok-4.5 lists $0.30 cached (not 4.6 / 4.7's $0.50) — llmux corrected
  // its row to this on 2026-10-23.
  [
    'grok-4.5',
    {
      pricing: {
        inputPerMTok: 2,
        outputPerMTok: 6,
        cacheReadPerMTok: 0.3,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 500_000,
      maxOutput: 128_000,
    },
  ],
  // Claude 4.8 (2026-05-28). Same $/MTok as 4.7; 1M context (default per
  // Anthropic spec, but per soma-work convention only `[1m]`-suffixed ids
  // actually opt into 1M at resolveContextWindow — see hasOneMSuffix).
  [
    'opus-4-8',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 6.25,
        cache1hrWritePerMTok: 10,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // Claude 4.7
  [
    'opus-4-7',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 6.25,
        cache1hrWritePerMTok: 10,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // Claude 4.6
  [
    'opus-4-6',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 6.25,
        cache1hrWritePerMTok: 10,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  [
    'sonnet-4-6',
    {
      pricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cache5minWritePerMTok: 3.75,
        cache1hrWritePerMTok: 6,
      },
      contextWindow: 1_000_000,
      maxOutput: 64_000,
    },
  ],
  // Claude 4.5
  [
    'opus-4-5',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 6.25,
        cache1hrWritePerMTok: 10,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  [
    'sonnet-4-5',
    {
      pricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cache5minWritePerMTok: 3.75,
        cache1hrWritePerMTok: 6,
      },
      contextWindow: 1_000_000,
      maxOutput: 64_000,
    },
  ],
  [
    'haiku-4-5',
    {
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.1,
        cache5minWritePerMTok: 1.25,
        cache1hrWritePerMTok: 2,
      },
      contextWindow: 200_000,
      maxOutput: 64_000,
    },
  ],
  // Claude 4.0 (generic fallbacks)
  [
    'sonnet-4-',
    {
      pricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cache5minWritePerMTok: 3.75,
        cache1hrWritePerMTok: 6,
      },
      contextWindow: 200_000,
      maxOutput: 64_000,
    },
  ],
  [
    'haiku-4-',
    {
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.1,
        cache5minWritePerMTok: 1.25,
        cache1hrWritePerMTok: 2,
      },
      contextWindow: 200_000,
      maxOutput: 64_000,
    },
  ],
];

/** Fallback spec (Sonnet-tier) when model is unknown */
const FALLBACK_SPEC: ModelSpec = {
  pricing: {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cache5minWritePerMTok: 3.75,
    cache1hrWritePerMTok: 6,
  },
  contextWindow: 200_000,
  maxOutput: 64_000,
};

/**
 * Get full model spec by name pattern matching.
 */
export function getModelSpec(modelName?: string): ModelSpec {
  if (!modelName) return FALLBACK_SPEC;
  for (const [pattern, spec] of MODEL_REGISTRY) {
    if (modelName.includes(pattern)) return spec;
  }
  return FALLBACK_SPEC;
}

/** Whether the price table knows `modelName` (otherwise `getModelSpec` falls back to Sonnet-tier rates). */
export function hasModelPricing(modelName?: string): boolean {
  if (!modelName) return false;
  for (const [pattern] of MODEL_REGISTRY) if (modelName.includes(pattern)) return true;
  return false;
}

/**
 * Get pricing for a model. Backward-compatible wrapper.
 */
export function getModelPricing(modelName?: string): ModelPricingSpec {
  return getModelSpec(modelName).pricing;
}

/**
 * The registry's own pricing row for a model, or null when no row matches.
 * Unlike `getModelPricing` it never answers with `FALLBACK_SPEC`: a display
 * that shows a price (the dashboard model picker) must say "unknown" for an
 * id the registry does not know instead of quoting Sonnet rates for it. Cost
 * accounting keeps using `getModelPricing` and its fallback.
 */
export function findModelPricing(modelName?: string): ModelPricingSpec | null {
  if (!modelName) return null;
  for (const [pattern, spec] of MODEL_REGISTRY) {
    if (modelName.includes(pattern)) return spec.pricing;
  }
  return null;
}

/**
 * Fixed token-count auto-compact trigger for models whose compaction point
 * is defined in absolute tokens rather than the per-user percent threshold.
 * Returns `undefined` for every other model — callers fall back to the
 * percent-based check (#617).
 *
 * Thin delegate over the canonical resolver (`model-profile.ts`), which owns
 * both the exact-id policy overlay and the family defaults.
 */
export function resolveAutoCompactTokens(modelName?: string): number | undefined {
  return resolveModelProfile(modelName).autoCompactTokens;
}

/**
 * Error code surfaced on thrown errors when the account lacks 1M-context
 * entitlement. Set by `claude-handler.maybeThrowOneMUnavailable` and checked
 * by `stream-executor.isOneMContextUnavailableError` — keeping the literal in
 * one place prevents drift between producer and matcher.
 */
export const ONE_M_CONTEXT_UNAVAILABLE_CODE = 'ONE_M_CONTEXT_UNAVAILABLE';

/**
 * Detect whether `text` matches any of the three stable SDK signals that
 * indicate the account cannot use the 1M-context beta for the attempted model.
 *
 * Issue #661 — Claude Agent SDK ≥ 0.2.111 surfaces these via
 * `isApiErrorMessage: true` assistant messages (not via throw). stream-executor
 * uses this matcher downstream to decide whether to strip `[1m]` and retry.
 *
 * Signal sources (observed in `@anthropic-ai/claude-agent-sdk@0.2.111`
 * `cli.js` bundle):
 *   1. "Extra usage is required for 1M context" (HTTP 429 rewrite)
 *   2. "long context beta" — covers both the 400 "not yet available for this
 *      subscription" and the 400 "incompatible with the long context beta
 *      header" variants.
 *   3. "not yet available for this subscription" — defensive redundancy for
 *      the 400 subscription variant in case the "long context beta" phrasing
 *      changes.
 *
 * Keeping the matcher narrow is the whole point: a broad substring like
 * "context" would misfire on `prompt is too long` errors (Issue #661 spec
 * test case 4) and downgrade the user's model without their consent.
 */
export function isOneMContextUnavailableSignal(text: string): boolean {
  return classifyOneMUnavailable(text) !== 'none';
}

/**
 * Classify the root cause of a 1M-context unavailability signal. The fallback
 * (strip `[1m]`, retry bare) is the same for all kinds, but the USER-facing
 * remediation is not: entitlement errors point to Claude Extra Usage /
 * subscription upgrade, while auth errors need the operator to reconfigure
 * the authentication mode.
 *
 * - `entitlement`: account-level 1M usage not enabled. 429 "Extra usage is
 *   required for 1M context" or 400 "not yet available for this subscription".
 * - `auth`: the current auth style cannot carry the long-context beta header.
 *   400 "This authentication style is incompatible with the long context
 *   beta header." No amount of Extra Usage will help — the fix is to change
 *   how the bot authenticates (CCT slot / token type).
 * - `none`: text does not match any known 1M-unavailable signal.
 *
 * Narrowing note: the "long context beta" substring is intentionally scoped
 * to the auth variant and no longer overlaps with the subscription variant —
 * keep `not yet available for this subscription` as the dedicated gate for
 * the entitlement case.
 */
export type OneMUnavailableKind = 'entitlement' | 'auth' | 'none';

export function classifyOneMUnavailable(text: string): OneMUnavailableKind {
  const s = text.toLowerCase();
  if (s.includes('incompatible with the long context beta header')) return 'auth';
  if (s.includes('extra usage is required for 1m context')) return 'entitlement';
  if (s.includes('not yet available for this subscription')) return 'entitlement';
  // Residual "long context beta" mentions (without the specific auth phrase)
  // are still treated as auth-ish: the Anthropic SDK uses this phrasing in
  // several 400-class auth/header rejections. Safer to steer the user to
  // an operator than to bill.
  if (s.includes('long context beta')) return 'auth';
  return 'none';
}

/**
 * Resolve context window for a model by name.
 *
 * Thin delegate over the canonical resolver (`model-profile.ts`): exact-id
 * policy overlay → `[1m]` opt-in → native-1M → gpt families → llmux catalog
 * (non-claude groups only) → 200k fallback.
 *
 * Used by stream-executor hot paths and threshold checks that need a non-zero
 * denominator before the SDK reports `contextWindow`.
 */
export function resolveContextWindow(modelName?: string): number {
  return resolveModelProfile(modelName).contextWindow;
}

/**
 * Calculate cost from token counts and model name.
 * Uses cache5minWritePerMTok for cacheCreateTokens (default behavior).
 * Returns cost in USD.
 */
export function calculateTokenCost(
  modelName: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
): number {
  const pricing = getModelPricing(modelName);
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok +
    (cacheCreateTokens / 1_000_000) * pricing.cache5minWritePerMTok
  );
}
