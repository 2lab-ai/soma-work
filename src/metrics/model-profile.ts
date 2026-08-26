/**
 * Canonical model profiles — the single answer to "what are this model's
 * context numbers?".
 *
 * Before this module the three numbers a session needs (effective context
 * window, SDK input hard-block limit, auto-compact trigger) were derived by
 * three independent regex chains in three
 * files: `resolveContextWindow` / `resolveAutoCompactTokens` in
 * `model-registry.ts` and the blocking-limit ladder in
 * `agent-runtime/claude-code/build-stream-options.ts`. They disagreed: a
 * `gpt-5.6-sol[1m]` session got a 1,000,000 window from the suffix rule but
 * the BARE family's 349,000 blocking limit from the regex ladder, so the SDK
 * refused input at 349k on a model the harness advertised as 1M.
 *
 * Resolution order (first match wins):
 *   1. exact canonical id in {@link POLICY_PROFILES} — declared policy, not a
 *      formula, so the requested thresholds are literals;
 *   2. the `[1m]` opt-in suffix — 1M window; the BASE id decides which family
 *      auto-compact trigger applies;
 *   3. native-1M ids (fable-5) → 1M;
 *   4. the gpt-5.6 / gpt-5.5 families (llmux codex backend);
 *   5. the llmux model-catalog overlay, NON-claude groups only;
 *   6. the 200k fallback.
 *
 * Layering (must stay acyclic):
 *   model-catalog  ←  metrics/model-profile  ←  metrics/model-registry
 *                                           ←  build-stream-options
 * This module must NOT import `user-settings-store` (which imports the
 * `[1m]` helpers below, via model-registry) nor `model-registry` itself.
 */

import { modelCatalog } from '../model-catalog';

/**
 * Everything a session needs to know about its model's context budget.
 *
 * Automatic compaction has ONE authority: the harness turn-end scheduler
 * (`session/compact-threshold-checker.ts#checkAndSchedulePendingCompact`),
 * which reads `autoCompactTokens` / `contextWindow` from here. The SDK's own
 * automatic compaction is switched off at the process boundary
 * (`DISABLE_AUTO_COMPACT=1`, see `build-stream-options.ts`) — it cannot be
 * calibrated per model, because the pinned SDK clamps
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to its own model window (`Jn` →
 * `Math.min(ff(model), value)`) and `ff` answers 200,000 (`WR1`) for every id
 * it does not know. So `autoCompactTokens` is a HARNESS number and is never
 * exported to the SDK env.
 *
 * Every field is `readonly` and every returned object is frozen: callers share
 * one process-wide policy record, so a single in-place edit would rewrite the
 * numbers every other caller reads for the rest of the process.
 */
export interface ModelProfile {
  /** Canonical (trimmed, lowercased) model id this profile describes. */
  readonly modelId: string;
  /** Effective context window in tokens. */
  readonly contextWindow: number;
  /**
   * SDK input hard-block limit: `window − 20k output reserve − 3k safety`.
   * Always injected as `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`, for every model:
   * where the pinned SDK sizes the id correctly this equals its own
   * computation, and where it does not it replaces the ~177k hard block with
   * the true window's limit. No "is this id known to the SDK?" tier exists.
   */
  readonly sdkBlockingLimit: number;
  /**
   * Auto-compact trigger in tokens, consumed by the harness scheduler.
   * `undefined` = this model has no absolute default and keeps the per-user
   * percent threshold.
   */
  readonly autoCompactTokens?: number;
  /** Minimum gap a session threshold must keep below {@link sdkBlockingLimit}. */
  readonly compactHeadroom: number;
}

/** Fallback context window size when nothing else resolves. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/** Output tokens the SDK reserves out of the window before hard-blocking input. */
const SDK_OUTPUT_RESERVE = 20_000;
/** Extra safety margin the SDK subtracts on top of the output reserve. */
const SDK_SAFETY_MARGIN = 3_000;

/** The SDK's own input hard-block formula, evaluated on a true window. */
export function sdkBlockingLimitFor(contextWindow: number): number {
  return contextWindow - SDK_OUTPUT_RESERVE - SDK_SAFETY_MARGIN;
}

/**
 * Gap every auto-compact threshold must keep below the blocking limit: the
 * compact turn resends the full history plus the summary prompt, so a trigger
 * flush with the limit would be refused before `/compact` ever ran.
 *
 * 9,000 is the tightest gap in the canonical table (gpt-5.6-sol: 349,000
 * limit − 340,000 trigger), so it is the largest headroom under which every
 * declared default is still valid. The invariant is pinned by test.
 */
export const DEFAULT_COMPACT_HEADROOM = 9_000;

/**
 * `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` value for every 1M profile: the SDK
 * formula on a true 1,000,000-token window.
 */
export const ONE_M_SDK_BLOCKING_LIMIT = sdkBlockingLimitFor(1_000_000);

/* ------------------------------------------------------------------ *
 * `[1m]` suffix — the 1M-context opt-in
 * ------------------------------------------------------------------ */

/**
 * Suffix marker for the 1M-context variant of a model id.
 * Convention: `{baseModelId}[1m]` enables the 1M beta context window.
 * The Claude Agent SDK (≥ 0.2.111) detects this suffix, strips it before the
 * API call, and injects the `context-1m-2025-08-07` beta header uniformly
 * across API-key and OAuth auth — so no runtime beta-header injection is needed.
 */
export const ONE_M_SUFFIX_RE = /\[1m\]$/i;

/** Returns true when `model` ends with the 1M suffix (case-insensitive). */
export function hasOneMSuffix(model: string): boolean {
  return ONE_M_SUFFIX_RE.test(model);
}

/** Strips the `[1m]` suffix from `model` if present. Case-insensitive. */
export function stripOneMSuffix(model: string): string {
  return model.replace(ONE_M_SUFFIX_RE, '');
}

/**
 * Models that serve a 1M context window on the BARE id — no `[1m]` suffix and
 * no `context-1m-2025-08-07` beta header.
 *
 * Fable 5 ships 1M as its native, generally-available context (Anthropic docs,
 * 2026-06-09), unlike opus where 1M is a beta opt-in gated behind the `[1m]`
 * suffix + beta header. So `claude-fable-5` must resolve to 1M directly; it has
 * no `[1m]` variant and must NOT go through the suffix/beta-header path.
 */
const NATIVE_ONE_M_RE = /fable-5/i;

/** Returns true when `model` serves 1M context on its bare id (no suffix). */
export function isNativeOneMModel(model: string): boolean {
  return NATIVE_ONE_M_RE.test(model);
}

/**
 * `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` value injected for native-1M models.
 * Kept as a named alias of {@link ONE_M_SDK_BLOCKING_LIMIT} because the pinned
 * SDK resolves native-1M ids to 200k; remove it together with that workaround.
 */
export const NATIVE_ONE_M_SDK_BLOCKING_LIMIT = ONE_M_SDK_BLOCKING_LIMIT;

/* ------------------------------------------------------------------ *
 * gpt-5.5 / gpt-5.6 (llmux codex backend)
 * ------------------------------------------------------------------ */

/**
 * gpt-5.5 — an OpenAI model served through llmux's codex backend group
 * (llmux routes `gpt-` prefixed ids to codex accounts; the SDK subprocess
 * talks to llmux exactly as it does for claude ids). The pinned Agent SDK
 * does not know this id, so — like native-1M models — the harness owns the
 * context-window math.
 */
const GPT_5_5_RE = /gpt-5\.5/i;

/** Returns true when `model` is a gpt-5.5 id (case-insensitive). */
export function isGpt55Model(model: string): boolean {
  return GPT_5_5_RE.test(model);
}

/** gpt-5.5 true context window: 275k. */
export const GPT_5_5_CONTEXT_WINDOW = 275_000;

/**
 * Harness-side auto-compact trigger for gpt-5.5: when a session's used
 * context tokens reach 250k, the turn-end checker schedules `/compact` for
 * the next turn — a fixed token count (not the per-user percent threshold),
 * per the model's spec.
 */
export const GPT_5_5_AUTO_COMPACT_TOKENS = 250_000;

/**
 * `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` value injected for gpt-5.5. Without it
 * the pinned SDK resolves the unknown id to 200k and refuses input at ~177k.
 */
export const GPT_5_5_SDK_BLOCKING_LIMIT = sdkBlockingLimitFor(GPT_5_5_CONTEXT_WINDOW);

/**
 * gpt-5.6 — OpenAI's 2026-07-09 release, served through llmux's codex
 * backend group like gpt-5.5. llmux ≥ 0.2.16 pins the upstream slug to
 * `gpt-5.6-sol` (the bare `gpt-5.6` id is rejected by the ChatGPT-account
 * codex backend). The regex matches the soma-work id AND the upstream-reported
 * slugs (`gpt-5.6-sol`, `gpt-5.6-terra`) so usage events that carry the
 * upstream name resolve to the same window.
 */
const GPT_5_6_RE = /gpt-5\.6/i;

/** Returns true when `model` is a gpt-5.6 family id (case-insensitive). */
export function isGpt56Model(model: string): boolean {
  return GPT_5_6_RE.test(model);
}

/**
 * gpt-5.6 context window: 372k — the official value from the openai/codex
 * model catalog (models-manager/models.json: context_window 372000 for
 * sol/terra/luna alike), cross-checked by probing the ChatGPT-account codex
 * backend on 2026-07-10 (369,755-token input accepted, ~380k rejected). The
 * official API window is 1.05M, but the codex backend clamps to the catalog
 * value — do NOT raise this without re-checking the catalog.
 */
export const GPT_5_6_CONTEXT_WINDOW = 372_000;

/**
 * Harness-side auto-compact trigger for gpt-5.6: fixed 340k tokens (~91% of
 * the 372k window, mirroring gpt-5.5's 250k/275k ratio). The 32k headroom
 * matters: the compact turn itself resends the full history plus the summary
 * prompt, so the trigger must sit safely below the hard window.
 */
export const GPT_5_6_AUTO_COMPACT_TOKENS = 340_000;

/**
 * `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` value injected for gpt-5.6. Without it
 * the pinned SDK resolves the unknown id to 200k and refuses input at ~177k.
 */
export const GPT_5_6_SDK_BLOCKING_LIMIT = sdkBlockingLimitFor(GPT_5_6_CONTEXT_WINDOW);

/* ------------------------------------------------------------------ *
 * Canonical policy overlay
 * ------------------------------------------------------------------ */

/**
 * Freeze a profile before it leaves this module.
 *
 * Profiles are flat records of primitives, so a shallow freeze is a deep
 * freeze. Freezing (rather than copy-on-read) is deliberate: a caller that
 * tries to "fix up" a profile in place gets a loud TypeError under strict mode
 * instead of a private copy that silently drifts from the policy.
 */
function freezeProfile(profile: ModelProfile): ModelProfile {
  return Object.freeze(profile);
}

/**
 * Exact-id policy. These numbers are OPERATOR POLICY, not a formula — the
 * requested auto-compact defaults (750k / 600k / 450k) are choices, so they
 * are declared literally and pinned by a literal-table test.
 *
 * `sdkBlockingLimit` is always the SDK formula on the declared window — there
 * is no "can the SDK size this id?" tier, because the builder injects the
 * override unconditionally (for `claude-opus-5` that means re-stating the
 * 177,000 the SDK would have computed anyway).
 *
 * Each record is frozen at construction — these are shared, process-lifetime
 * objects and `resolveModelProfile` hands the very same reference to every
 * caller.
 */
const POLICY_PROFILES: readonly ModelProfile[] = [
  {
    modelId: 'claude-fable-5[1m]',
    contextWindow: 1_000_000,
    sdkBlockingLimit: ONE_M_SDK_BLOCKING_LIMIT,
    autoCompactTokens: 750_000,
    compactHeadroom: DEFAULT_COMPACT_HEADROOM,
  },
  {
    modelId: 'claude-opus-5[1m]',
    contextWindow: 1_000_000,
    sdkBlockingLimit: ONE_M_SDK_BLOCKING_LIMIT,
    autoCompactTokens: 750_000,
    compactHeadroom: DEFAULT_COMPACT_HEADROOM,
  },
  {
    // Bare opus-5 keeps the 200k opt-in contract: 1M is reached only through
    // the `[1m]` variant, so there is no 750k default here.
    modelId: 'claude-opus-5',
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    sdkBlockingLimit: sdkBlockingLimitFor(FALLBACK_CONTEXT_WINDOW),
    compactHeadroom: DEFAULT_COMPACT_HEADROOM,
  },
  {
    modelId: 'gpt-5.6-sol[1m]',
    contextWindow: 1_000_000,
    sdkBlockingLimit: ONE_M_SDK_BLOCKING_LIMIT,
    autoCompactTokens: 600_000,
    compactHeadroom: DEFAULT_COMPACT_HEADROOM,
  },
  {
    modelId: 'gpt-5.6-sol',
    contextWindow: GPT_5_6_CONTEXT_WINDOW,
    sdkBlockingLimit: GPT_5_6_SDK_BLOCKING_LIMIT,
    autoCompactTokens: GPT_5_6_AUTO_COMPACT_TOKENS,
    compactHeadroom: DEFAULT_COMPACT_HEADROOM,
  },
  {
    // Declared, not catalog-derived: a cold start with no catalog snapshot
    // must not downgrade grok-4.6 to the 200k fallback.
    modelId: 'grok-4.6',
    contextWindow: 500_000,
    sdkBlockingLimit: sdkBlockingLimitFor(500_000),
    autoCompactTokens: 450_000,
    compactHeadroom: DEFAULT_COMPACT_HEADROOM,
  },
].map(freezeProfile);

const POLICY_BY_ID = new Map(POLICY_PROFILES.map((p) => [p.modelId, p]));

/** Every model id covered by the exact-id policy overlay. */
export const CANONICAL_MODEL_IDS: readonly string[] = Object.freeze(POLICY_PROFILES.map((p) => p.modelId));

/**
 * An input this module recognizes as a canonical model id.
 *
 * There is no `normalizedFrom` / rewrite channel: the only compatibility case
 * this module has is grok `[1m]`, and that is REFUSED rather than rewritten
 * (see {@link GROK_ID_RE}). A field that is always `undefined` would just
 * invite callers to build a "we quietly changed your model" path.
 */
export interface ModelInputAccepted {
  /** The canonical model id to store in session/user state. */
  modelId: string;
}

/** An input that must be refused outright, with the id the user probably meant. */
export interface ModelInputRejected {
  /** User-facing explanation — why this spelling cannot be routed at all. */
  rejectedReason: string;
  /** The canonical id to offer instead. */
  suggestedModel: string;
}

export type ModelInputCompatibility = ModelInputAccepted | ModelInputRejected;

/** Narrow a compatibility result to the rejection branch. */
export function isRejectedModelInput(result: ModelInputCompatibility): result is ModelInputRejected {
  return 'rejectedReason' in result;
}

/**
 * `[1m]` is meaningless — and actively harmful — on a grok id.
 *
 * Claude and codex ids survive the suffix because the layer below strips it
 * (the Agent SDK for claude, llmux for codex). llmux's grok provider does not:
 * it forwards any `grok-*` id VERBATIM upstream (llmux
 * `src/provider/grok.rs:226-244`), so `grok-4.6[1m]` would reach xAI as a
 * model name that does not exist. Silently normalizing it to `grok-4.6` would
 * also mean the harness quietly served a different model than the one asked
 * for, so the input is refused instead of rewritten.
 */
const GROK_ID_RE = /^grok-/i;

/**
 * Resolve a raw model input against the canonical set.
 *
 * Three outcomes:
 *   • an accepted canonical id — exactly `{ modelId }`, never a rewrite;
 *   • a rejection carrying the id the user should use instead;
 *   • `null` — no opinion, the caller falls through to its own alias /
 *     allow-list resolution.
 *
 * This function never invents a model.
 */
export function resolveModelInputCompatibility(input: string): ModelInputCompatibility | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const key = trimmed.toLowerCase();

  if (hasOneMSuffix(key)) {
    const base = stripOneMSuffix(key);
    if (GROK_ID_RE.test(base)) {
      return {
        rejectedReason: `\`${trimmed}\` is not a real model id — grok has no 1M variant and llmux forwards grok ids verbatim upstream. Use \`${base}\`.`,
        suggestedModel: base,
      };
    }
  }

  const canonical = POLICY_BY_ID.get(key);
  if (canonical) return { modelId: canonical.modelId };

  return null;
}

/** Context window advertised by the llmux catalog for NON-claude groups only. */
function catalogWindowFor(modelId: string): number | undefined {
  const group = modelCatalog.getGroupFor(modelId);
  if (!group || group === 'claude') return undefined;
  const window = modelCatalog.getContextWindowFor(modelId);
  return typeof window === 'number' && window > 0 ? window : undefined;
}

/** Family-level auto-compact default for an id outside the policy overlay. */
function familyAutoCompactTokens(modelId: string): number | undefined {
  if (isGpt56Model(modelId)) return GPT_5_6_AUTO_COMPACT_TOKENS;
  if (isGpt55Model(modelId)) return GPT_5_5_AUTO_COMPACT_TOKENS;
  return undefined;
}

/**
 * Resolve the canonical profile for `modelId`.
 *
 * Total function: an unknown, empty, or missing id resolves to the 200k
 * SDK-managed fallback rather than throwing, because every caller sits on a
 * hot path (stream executor, threshold checker, options builder) that must
 * always have a denominator.
 */
export function resolveModelProfile(modelId?: string): ModelProfile {
  const id = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';

  const policy = POLICY_BY_ID.get(id);
  if (policy) return policy;

  const derived = (contextWindow: number, autoCompactTokens?: number): ModelProfile =>
    freezeProfile({
      modelId: id,
      contextWindow,
      sdkBlockingLimit: sdkBlockingLimitFor(contextWindow),
      ...(autoCompactTokens !== undefined ? { autoCompactTokens } : {}),
      compactHeadroom: DEFAULT_COMPACT_HEADROOM,
    });

  if (id.length === 0) return derived(FALLBACK_CONTEXT_WINDOW);

  // `[1m]` opt-in: the window is 1M, so the blocking limit is the 1M one —
  // inheriting the BARE family's smaller limit is the bug this module kills.
  if (hasOneMSuffix(id)) {
    return derived(1_000_000, familyAutoCompactTokens(stripOneMSuffix(id)));
  }

  if (isNativeOneMModel(id)) return derived(1_000_000);
  if (isGpt56Model(id)) return derived(GPT_5_6_CONTEXT_WINDOW, GPT_5_6_AUTO_COMPACT_TOKENS);
  if (isGpt55Model(id)) return derived(GPT_5_5_CONTEXT_WINDOW, GPT_5_5_AUTO_COMPACT_TOKENS);

  const catalogWindow = catalogWindowFor(id);
  if (catalogWindow !== undefined) return derived(catalogWindow);

  // 200k fallback — and for bare claude ids that is a PRODUCT decision, not a
  // gap. Notably `claude-sonnet-4-6`: the pinned SDK may size it at 1M
  // (cli.js `XV8`, gated on the account-level `coral_reef_sonnet` experiment
  // we neither control nor observe), but the harness advertises, meters and
  // schedules compaction against 200k, and the universal 177,000 blocking-limit
  // injection makes the SDK agree. 1M is reached ONLY through the explicit
  // `[1m]` profile — same contract as opus.
  return derived(FALLBACK_CONTEXT_WINDOW);
}
