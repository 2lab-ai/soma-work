/**
 * Model inputs soma-work refuses outright — the ONE rule table shared by the
 * runtime store (`metrics/model-profile.ts` → `resolveModelInputCompatibility`)
 * and the deploy-time bootstrap (`deploy/main-env-bootstrap.ts`).
 *
 * This file has NO imports, on purpose: the bootstrap runs before the main
 * process and must not load the llmux catalog or the settings store, so it
 * used to keep its own copy of these rules, and the copies could drift. Both
 * now import this file. What each caller knows about the llmux catalog is
 * passed in as a {@link CatalogResolver}; the rules never look it up.
 *
 * Every rule REFUSES — none rewrites the input into another model.
 */

/** The `[1m]` 1M-context opt-in suffix (case-insensitive). */
export const ONE_M_SUFFIX_RE = /\[1m\]$/i;

/** The llmux catalog row an input names (by id or alias), as far as the caller knows. */
export interface CatalogRow {
  /** The row's canonical id. */
  readonly id: string;
  /** The row's backend group (`claude`, `codex`, `grok`, `gemini`, …), or null when it has none. */
  readonly group: string | null;
}

/**
 * Look an input up in the llmux catalog the caller has (runtime: the live
 * overlay; bootstrap: the on-disk snapshot). Returns null when the catalog
 * does not know it.
 */
export type CatalogResolver = (key: string) => CatalogRow | null;

/** A refused input: why, and the id to offer instead. */
export interface ModelRefusal {
  /** User-facing explanation, one sentence. */
  readonly rejectedReason: string;
  /** The canonical id to offer instead. */
  readonly suggestedModel: string;
}

/* ------------------------------------------------------------------ *
 * Retired ids
 * ------------------------------------------------------------------ */

/** Why and when a model id left the selectable set, and what to use instead. */
interface RetiredModel {
  /** Date the id was retired from selection (YYYY-MM-DD). */
  readonly retiredOn: string;
  /** User-facing reason, without a trailing "use X" (callers append the suggestion). */
  readonly why: string;
  /** Selectable id offered instead. */
  readonly suggestedModel: string;
}

/**
 * gpt-5.5 — retired from selection on 2026-11-19 (owner instruction). The
 * ChatGPT-account Codex backend has rejected it since 2026-10-14: a llmux
 * probe on 2026-11-18 got 400 "The 'gpt-5.5' model is not supported when
 * using Codex with a ChatGPT account." (2lab-ai/llmux#309). The suggestion is
 * gpt-5.6-sol — the next generation and the `gpt` alias target. The price row
 * stays in model-registry.ts so past gpt-5.5 usage keeps its cost.
 */
const GPT_5_5_RETIREMENT: RetiredModel = Object.freeze({
  retiredOn: '2026-11-19',
  why: 'the Codex backend no longer serves it to ChatGPT accounts',
  suggestedModel: 'gpt-5.6-sol',
});

/**
 * Retired model inputs, keyed by every spelling a user may still type — the
 * canonical id and any removed alias — compared after trimming, lowercasing
 * and stripping `[1m]`. Typed input gets the reason and a suggestion, and a
 * stored value goes to the default model before the llmux catalog overlay
 * could keep it.
 */
const RETIRED_MODEL_INPUTS: ReadonlyMap<string, RetiredModel> = new Map([
  ['gpt-5.5', GPT_5_5_RETIREMENT],
  ['gpt5.5', GPT_5_5_RETIREMENT],
]);

/* ------------------------------------------------------------------ *
 * grok `[1m]`
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * gemini
 * ------------------------------------------------------------------ */

/**
 * Gemini models are refused outright (2026-11-21). soma-work reaches llmux as
 * Claude Code (Agent SDK), and llmux answers every Claude Code request routed
 * to its gemini group with a local 400 (since 2026-10-15): Google's
 * Antigravity backend refuses them. A gemini selection can therefore only
 * fail.
 *
 * The match mirrors llmux's own builtin gemini routing (llmux
 * `src/routing.rs` `builtin_gemini_rules`), which needs no catalog: after one
 * `[1m]` is stripped (case- and whitespace-insensitive), any name starting
 * with `gemini` — no dash needed — and the exact element names below go to
 * the gemini group. `neon`, `carbon` and `hydrogen` join `argon` with
 * 2lab-ai/llmux#313. So a cold start with no catalog snapshot refuses them
 * too. On top of that, a llmux catalog row in group `gemini` is refused by
 * whatever id or alias names it.
 */
const GEMINI_ROUTE_PREFIX = 'gemini';
const GEMINI_ROUTE_EXACT: ReadonlySet<string> = new Set(['argon', 'neon', 'carbon', 'hydrogen']);
const GEMINI_GROUP = 'gemini';

/**
 * The opus default offered instead of a gemini model. A literal — the
 * settings store's `DEFAULT_MODEL` follows the `opus` alias to the same id
 * (pinned by test), and this file imports nothing.
 */
const GEMINI_SUGGESTED_MODEL = 'claude-opus-5-5[1m]';

/** True when llmux's builtin routing sends `name` (lowercased, `[1m]` stripped) to its gemini group. */
function routesToGemini(name: string): boolean {
  return name.startsWith(GEMINI_ROUTE_PREFIX) || GEMINI_ROUTE_EXACT.has(name);
}

function isGeminiInput(key: string, base: string, resolve?: CatalogResolver): boolean {
  if (routesToGemini(base)) return true;
  if (!resolve) return false;
  const row = resolve(key) ?? resolve(base);
  if (!row) return false;
  const rowId = row.id.trim().toLowerCase().replace(ONE_M_SUFFIX_RE, '');
  return routesToGemini(rowId) || row.group?.trim().toLowerCase() === GEMINI_GROUP;
}

/* ------------------------------------------------------------------ *
 * The one entry point
 * ------------------------------------------------------------------ */

/**
 * The refusal for `input`, or null when no rule refuses it.
 *
 * Rules, first match wins: retired ids → gemini models → grok `[1m]`.
 * `resolve` is the caller's view of the llmux catalog; without it only the
 * catalog-free rules apply.
 */
export function findModelRefusal(input: string, resolve?: CatalogResolver): ModelRefusal | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const key = trimmed.toLowerCase();
  const base = key.replace(ONE_M_SUFFIX_RE, '');

  const retired = RETIRED_MODEL_INPUTS.get(base);
  if (retired) {
    return {
      rejectedReason: `\`${trimmed}\` was retired on ${retired.retiredOn} — ${retired.why}.`,
      suggestedModel: retired.suggestedModel,
    };
  }

  if (isGeminiInput(key, base, resolve)) {
    return {
      rejectedReason: `\`${trimmed}\` is a Gemini model — llmux does not forward Claude Code requests to Google's Antigravity backend, which refuses them.`,
      suggestedModel: GEMINI_SUGGESTED_MODEL,
    };
  }

  if (base !== key && GROK_ID_RE.test(base)) {
    return {
      rejectedReason: `\`${trimmed}\` is not a real model id — grok has no 1M variant and llmux forwards grok ids verbatim upstream. Use \`${base}\`.`,
      suggestedModel: base,
    };
  }

  return null;
}
