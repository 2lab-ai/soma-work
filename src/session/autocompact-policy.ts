/**
 * Session-scoped auto-compact threshold policy.
 *
 * One question, one answer: "at how many used tokens does THIS session
 * compact?". Three inputs can supply it and they are strictly ordered —
 *
 *   1. `session.autoCompactTokens` — the explicit `/autocompact <tokens>`
 *      override. Survives model switches and restarts.
 *   2. `ModelProfile.autoCompactTokens` — the declared model default
 *      (`metrics/model-profile.ts`).
 *   3. the legacy per-user percent (`/compact-threshold`), converted against
 *      the current model's context window.
 *
 * All three pass through {@link safeMaxAutoCompactTokens}, and that shared cap
 * is why they live in one module: the compact turn resends the full history
 * plus the summary prompt, so a trigger above
 * `min(contextWindow, sdkBlockingLimit) − compactHeadroom` is refused by the
 * SDK before `/compact` can run. The percent path historically had no such cap
 * — 95% of a 200k profile converts to 190,000, past that profile's 177,000
 * hard block, so the session wedges instead of compacting.
 */

import { resolveModelProfile } from '../metrics/model-profile';
import type { ConversationSession } from '../types';
import type { UserSettingsStore } from '../user-settings-store';

/** Where the effective threshold came from. Rendered by `/autocompact`. */
export type AutoCompactSource = 'session' | 'model' | 'legacy-percent';

/** The resolved auto-compact decision for one session. */
export interface EffectiveAutoCompact {
  /** Used-token count at which the turn-end checker schedules `/compact`. */
  tokens: number;
  /** Which of the three inputs won. */
  source: AutoCompactSource;
  /** The model's effective context window — the denominator for display. */
  contextWindow: number;
}

/**
 * Absolute band for a user-supplied threshold, independent of any model:
 * 100,000 … 1,000,000. The floor keeps `/autocompact 1.5k` (a session that
 * compacts on every turn) out; the ceiling is the largest window any supported
 * profile has. Model-specific refusal is a separate, tighter rule —
 * {@link validateAutoCompactTokensForModel}.
 */
export const AUTO_COMPACT_TOKENS_MIN = 100_000;
export const AUTO_COMPACT_TOKENS_MAX = 1_000_000;

/** The single word that clears the session override. */
const RESET_WORD = 'reset';

/** True when `raw` asks for the model default rather than a number. */
export function isAutoCompactReset(raw: string): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === RESET_WORD;
}

/**
 * `<number>[k|m]` with a bare-thousands shorthand.
 *
 * `800k` / `800K` / `0.8M` / `800000` / `800` all mean 800,000: a bare value
 * under 1,000 is read as thousands because `/autocompact 800` is what a user
 * types and no one compacts at 800 tokens.
 *
 * Returns `null` for anything malformed, fractional-in-tokens, or outside
 * {@link AUTO_COMPACT_TOKENS_MIN}..{@link AUTO_COMPACT_TOKENS_MAX} — the
 * caller renders the usage hint. `reset` is also `null`; ask
 * {@link isAutoCompactReset} first.
 */
export function parseAutoCompactTokens(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2]?.toLowerCase();
  let tokens: number;
  if (unit === 'k') tokens = value * 1_000;
  else if (unit === 'm') tokens = value * 1_000_000;
  else tokens = value < 1_000 ? value * 1_000 : value;

  if (!Number.isInteger(tokens)) return null;
  if (tokens < AUTO_COMPACT_TOKENS_MIN || tokens > AUTO_COMPACT_TOKENS_MAX) return null;
  return tokens;
}

/**
 * Largest threshold this model can actually compact at:
 * `min(contextWindow, sdkBlockingLimit) − compactHeadroom`.
 *
 * Both terms matter. The window bounds what the model holds; the blocking
 * limit bounds what the SDK accepts as input; the headroom leaves room for the
 * compact turn itself.
 */
export function safeMaxAutoCompactTokens(model?: string): number {
  const profile = resolveModelProfile(model);
  return Math.min(profile.contextWindow, profile.sdkBlockingLimit) - profile.compactHeadroom;
}

/** Result of set-time validation. Rejection carries the number to show. */
export type AutoCompactValidation = { ok: true; tokens: number } | { ok: false; safeMax: number; message: string };

/** Format a token count as `123,000` for user-facing text. */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/**
 * Refuse a threshold the model cannot reach. Visible failure by design: a
 * silently clamped set would report success and then compact somewhere the
 * user never asked for.
 */
export function validateAutoCompactTokensForModel(tokens: number, model?: string): AutoCompactValidation {
  const safeMax = safeMaxAutoCompactTokens(model);
  if (tokens > safeMax) {
    return {
      ok: false,
      safeMax,
      message: `${formatTokens(tokens)} tokens is above the safe maximum for \`${model ?? 'this model'}\` — use ${formatTokens(safeMax)} or less.`,
    };
  }
  return { ok: true, tokens };
}

/**
 * Resolve the threshold this session compacts at.
 *
 * The session override is clamped for the CURRENT model but never rewritten:
 * a user who set 900k on a 1M model and temporarily switches to a 200k model
 * gets a safe 168k this turn and their 900k back on switching home. Only the
 * no-override path recalculates from the model.
 */
export function resolveEffectiveAutoCompact(
  session: Pick<ConversationSession, 'model' | 'autoCompactTokens'>,
  userId: string,
  store: Pick<UserSettingsStore, 'getUserCompactThreshold'>,
): EffectiveAutoCompact {
  const profile = resolveModelProfile(session.model);
  const safeMax = Math.min(profile.contextWindow, profile.sdkBlockingLimit) - profile.compactHeadroom;

  const override = session.autoCompactTokens;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return { tokens: Math.min(override, safeMax), source: 'session', contextWindow: profile.contextWindow };
  }

  if (profile.autoCompactTokens !== undefined) {
    return {
      tokens: Math.min(profile.autoCompactTokens, safeMax),
      source: 'model',
      contextWindow: profile.contextWindow,
    };
  }

  const pct = store.getUserCompactThreshold(userId);
  const converted = Math.round((profile.contextWindow * pct) / 100);
  return { tokens: Math.min(converted, safeMax), source: 'legacy-percent', contextWindow: profile.contextWindow };
}
