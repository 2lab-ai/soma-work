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
const TRANSIENT_RATE_PATTERNS: readonly string[] = ['rate limit', 'rate_limit', 'too many requests', '429'] as const;

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
 * Explicit retry-after hint the upstream account-pool gateway attaches to a
 * pool-exhaustion rejection, e.g.:
 *
 *   "API Error: Request rejected (429) · All 9 eligible accounts are
 *    rate-limited right now; retry in 3283s."
 *
 * Captures the numeric amount + an optional unit. Applied to
 * `normalizeForLimitMatch`-normalized (lowercased, separator-collapsed) text,
 * so the alternation is lowercase-only. Longest unit spellings come first so
 * `seconds` is never shadowed by the bare `s`.
 */
const RETRY_AFTER_RE =
  /\bretry\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|millis?|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|s|m|h)?\b/;

/**
 * Gateway-DISTINCTIVE signals that, TOGETHER with an explicit retry-after
 * hint, mark a pool-exhaustion rate limit (as opposed to a per-account
 * subscription cap that rotation could cure). Matched on normalized text.
 *
 * Deliberately excludes weak/generic tokens (`429`, `rate limit`, `too many
 * requests`): because {@link textIndicatesRetryableRateLimit} also runs
 * against assistant/eval CONTENT, a bare `429` + a "retry after N seconds"
 * mention (e.g. an answer EXPLAINING HTTP 429 backoff) would otherwise be
 * misread as an infra rejection. These three phrasings are emitted by the
 * account-pool gateway and effectively never appear in ordinary prose.
 */
const POOL_RATE_SIGNALS: readonly string[] = ['rate-limited', 'request rejected', 'eligible accounts'] as const;

/**
 * Parse an explicit "retry in Ns" / "retry after N seconds" hint into
 * milliseconds. Returns `null` when no hint is present.
 *
 * Unit handling (default is SECONDS when the unit is omitted — matches the
 * gateway's bare `retry in 3283s` form):
 *   - `ms` / `millis` → milliseconds
 *   - `s` / `sec` / `second(s)` → seconds
 *   - `m` / `min` / `minute(s)` → minutes
 *   - `h` / `hr` / `hour(s)` → hours
 */
export function parseRetryAfterMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = normalizeForLimitMatch(raw).match(RETRY_AFTER_RE);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = match[2] ?? 's';
  let factor: number;
  if (unit === 'ms' || unit.startsWith('milli')) factor = 1;
  else if (unit === 'm' || unit.startsWith('min')) factor = 60_000;
  else if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')) factor = 3_600_000;
  else factor = 1_000; // s / sec / second(s) / omitted
  return Math.round(amount * factor);
}

/**
 * Upper bound on how long a single pool-rate-limit retry will wait, even when
 * the gateway advertises a longer window. Prevents a malformed or absurd
 * "retry in Ns" hint from pinning a dispatch/turn for hours. Shared by the
 * one-shot dispatch seam and the streaming turn seam so both bound identically.
 */
export const RATE_LIMIT_MAX_WAIT_MS = 60 * 60 * 1_000; // 1 hour

/**
 * Positive floor so a scheduled retry always actually fires. A gateway that
 * advertises `retry in 0s` must not collapse to a `0ms` delay — callers treat
 * `retryAfterMs` truthily (`setTimeout(..., 0)` runs, but the slack-handler
 * `if (retryAfterMs)` gate would skip a `0`), so clamp up to this minimum.
 */
export const RATE_LIMIT_MIN_WAIT_MS = 1_000;

/**
 * Fallback wait when the pool-rate-limit signal is present but no parseable
 * "retry in Ns" hint could be extracted.
 */
export const RATE_LIMIT_DEFAULT_WAIT_MS = 60_000;

/**
 * Clamp a parsed retry-after delay into the sane
 * [{@link RATE_LIMIT_MIN_WAIT_MS}, {@link RATE_LIMIT_MAX_WAIT_MS}] band. A
 * missing / non-finite / negative input (e.g. an unparseable hint) collapses
 * to {@link RATE_LIMIT_DEFAULT_WAIT_MS} — a present-but-tiny value (incl. `0`)
 * is floored so the retry still fires.
 */
export function boundRateLimitDelayMs(delayMs: number | null | undefined): number {
  if (delayMs == null || !Number.isFinite(delayMs) || delayMs < 0) return RATE_LIMIT_DEFAULT_WAIT_MS;
  return Math.min(Math.max(delayMs, RATE_LIMIT_MIN_WAIT_MS), RATE_LIMIT_MAX_WAIT_MS);
}

/**
 * True when `raw` is a POOL-exhaustion rate limit that carries an explicit
 * retry-after hint — i.e. every eligible account is capped right now and the
 * gateway told us exactly how long to wait. This is distinct from a
 * per-account subscription cap ({@link textIndicatesUsageLimit}): rotating to
 * another slot does NOT help (all are capped), so the correct recovery is to
 * WAIT the advertised window and retry the same pool.
 *
 * Content-safe by construction: it requires BOTH an explicit `retry in Ns`
 * hint AND a rate-limit token. That combination is essentially never present
 * in ordinary assistant prose, so it is safe to run against turn/eval CONTENT
 * (not just error/stderr payloads) — which is exactly where the gateway
 * rejection leaked before (goal-eval JSON parse crash, turn-answer leak).
 */
export function textIndicatesRetryableRateLimit(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const norm = normalizeForLimitMatch(raw);
  if (!RETRY_AFTER_RE.test(norm)) return false;
  return POOL_RATE_SIGNALS.some((s) => norm.includes(s));
}

/**
 * True when `raw` indicates the active credential hit a usage/rate cap.
 *
 * Default (content-safe) mode matches only the explicit cap-notice
 * phrasings. Pass `{ includeTransient: true }` for error/stderr text to
 * also catch transient 429 / rate-limit signals.
 */
export function textIndicatesUsageLimit(raw: string | null | undefined, opts: UsageLimitMatchOptions = {}): boolean {
  if (!raw) return false;
  const norm = normalizeForLimitMatch(raw);
  if (CAP_NOTICE_PATTERNS.some((p) => norm.includes(p))) return true;
  if (opts.includeTransient && TRANSIENT_RATE_PATTERNS.some((p) => norm.includes(p))) return true;
  return false;
}
