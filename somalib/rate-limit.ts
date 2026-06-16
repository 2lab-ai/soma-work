/**
 * Shared usage-limit / rate-limit text detector.
 *
 * Claude Code surfaces a subscription usage cap in TWO different shapes:
 *
 *   1. As a thrown SDK error — the cap text lands in `error.message` /
 *      `error.stderrContent` and the streaming turn rejects.
 *   2. As an ordinary assistant *text* message followed by a *successful*
 *      `result` event, e.g. "You've hit your limit · resets 9pm
 *      (Asia/Seoul)". The turn completes with no error at all.
 *
 * Shape (2) is the one that silently broke auto-rotation: the only place
 * rotation was wired (`stream-executor.handleError` → `isRateLimitError`
 * → `tryRotateToken`) runs exclusively on the thrown-error path. When the
 * cap arrives as content the turn "succeeds", `handleError` never runs,
 * rotation never fires, and the cap notice leaks to the user (and into
 * the goal-completion eval's JSON parser, which then fails on
 * `Unexpected token 'Y', "You've hit"...`).
 *
 * This module is the single source of truth for that detection so the
 * error path and the content paths can no longer diverge.
 */

/**
 * Cap-notice patterns that are safe to match inside free-form assistant
 * text. These are the exact phrasings Claude Code emits for a hard
 * subscription/usage cap, so a false positive on normal prose is highly
 * unlikely.
 */
const CAP_NOTICE_PATTERNS: readonly string[] = [
  "you've hit your limit",
  'hit your usage limit',
  'out of extra usage',
  'usage limit reached',
  'claude usage limit',
  'reached your usage limit',
] as const;

/**
 * Transient rate-limit patterns. These are only trustworthy inside an
 * error/stderr payload — matching them against arbitrary assistant
 * content would false-positive on any turn that merely *discusses* rate
 * limits or contains the number 429. Enable with `includeTransient`.
 */
const TRANSIENT_RATE_PATTERNS: readonly string[] = [
  'rate limit',
  'rate_limit',
  'too many requests',
  '429',
] as const;

/**
 * Normalize text before substring matching:
 *  - fold typographic apostrophes (U+2018/U+2019/U+02BC/U+2032) to ASCII
 *    `'` so "You've" (curly — the form Claude actually emits) matches the
 *    literal `you've` pattern. This apostrophe mismatch ALONE could
 *    defeat the cap detector even on the error path.
 *  - collapse the middot/whitespace runs so "limit · resets" matches
 *    regardless of separator rendering.
 *  - lowercase.
 */
export function normalizeForLimitMatch(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/[\u00b7\u2022]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export interface UsageLimitMatchOptions {
  /**
   * Also match transient rate-limit signals (`rate limit`, `429`, …).
   * Use ONLY for error/stderr payloads, never for free assistant text.
   */
  includeTransient?: boolean;
}

/**
 * True when `raw` indicates the active credential hit a usage/rate cap.
 *
 * Default (content-safe) mode matches only the explicit cap-notice
 * phrasings. Pass `{ includeTransient: true }` for error/stderr text to
 * also catch transient 429 / rate-limit signals.
 */
export function textIndicatesUsageLimit(
  raw: string | null | undefined,
  opts: UsageLimitMatchOptions = {},
): boolean {
  if (!raw) return false;
  const norm = normalizeForLimitMatch(raw);
  if (CAP_NOTICE_PATTERNS.some((p) => norm.includes(p))) return true;
  if (opts.includeTransient && TRANSIENT_RATE_PATTERNS.some((p) => norm.includes(p))) return true;
  return false;
}
