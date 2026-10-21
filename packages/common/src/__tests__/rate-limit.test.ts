import { describe, expect, it } from 'vitest';
import {
  boundRateLimitDelayMs,
  normalizeForLimitMatch,
  parseRetryAfterMs,
  RATE_LIMIT_DEFAULT_WAIT_MS,
  RATE_LIMIT_MAX_WAIT_MS,
  RATE_LIMIT_MIN_WAIT_MS,
  textIndicatesRetryableRateLimit,
  textIndicatesUsageLimit,
} from '../rate-limit';

describe('textIndicatesUsageLimit', () => {
  // The exact string from the incident report (curly apostrophe + middot).
  const INCIDENT = "You've hit your limit · resets 9pm (Asia/Seoul)";

  it('detects the exact incident cap notice (curly apostrophe + middot)', () => {
    // RED before the fix: the old detector matched the literal ASCII
    // `you've` after lowercasing, but Claude emits a typographic apostrophe
    // (U+2019), so the substring never matched and rotation never fired.
    expect(textIndicatesUsageLimit(INCIDENT)).toBe(true);
  });

  it('detects the ASCII-apostrophe variant too', () => {
    expect(textIndicatesUsageLimit("You've hit your limit · resets 9pm (Asia/Seoul)")).toBe(true);
  });

  it('detects other cap-notice phrasings', () => {
    expect(textIndicatesUsageLimit('You are out of extra usage')).toBe(true);
    expect(textIndicatesUsageLimit('Claude usage limit reached')).toBe(true);
    expect(textIndicatesUsageLimit('You have reached your usage limit')).toBe(true);
    expect(textIndicatesUsageLimit('You hit your usage limit for the day')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(textIndicatesUsageLimit("YOU'VE HIT YOUR LIMIT")).toBe(true);
  });

  it('does NOT treat transient rate-limit signals as caps in free content', () => {
    // Content-safe default: a normal answer that merely mentions these must
    // NOT trigger a (wrong) rotation.
    expect(textIndicatesUsageLimit('The API rate limit is 50 requests/sec')).toBe(false);
    expect(textIndicatesUsageLimit('HTTP 429 means too many requests')).toBe(false);
  });

  it('treats transient signals as a hit only when includeTransient=true (error path)', () => {
    expect(textIndicatesUsageLimit('rate limit exceeded', { includeTransient: true })).toBe(true);
    expect(textIndicatesUsageLimit('Error 429: too many requests', { includeTransient: true })).toBe(true);
    expect(textIndicatesUsageLimit('temporarily overloaded', { includeTransient: true })).toBe(false);
  });

  it('still catches the cap notice on the error path (includeTransient=true)', () => {
    const errLike = `process exited with code 1 ${INCIDENT}`;
    expect(textIndicatesUsageLimit(errLike, { includeTransient: true })).toBe(true);
  });

  it('returns false for empty / nullish input', () => {
    expect(textIndicatesUsageLimit('')).toBe(false);
    expect(textIndicatesUsageLimit(null)).toBe(false);
    expect(textIndicatesUsageLimit(undefined)).toBe(false);
  });

  it('returns false for ordinary assistant output', () => {
    expect(textIndicatesUsageLimit('{"completed": true, "reason": "done", "remaining": []}')).toBe(false);
    expect(textIndicatesUsageLimit('작업 완료 — 추가 대기 작업 없음.')).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  // The exact gateway rejection from the incident report.
  const INCIDENT =
    'API Error: Request rejected (429) · All 9 eligible accounts are rate-limited right now; retry in 3283s.';

  it('parses the incident retry hint (bare `s` unit → seconds)', () => {
    expect(parseRetryAfterMs(INCIDENT)).toBe(3283 * 1000);
  });

  it('defaults to seconds when the unit is omitted', () => {
    expect(parseRetryAfterMs('retry in 30')).toBe(30_000);
  });

  it('honors explicit units', () => {
    expect(parseRetryAfterMs('retry in 500ms')).toBe(500);
    expect(parseRetryAfterMs('retry in 45 seconds')).toBe(45_000);
    expect(parseRetryAfterMs('retry in 2 min')).toBe(120_000);
    expect(parseRetryAfterMs('retry in 1 hour')).toBe(3_600_000);
  });

  it('supports the "retry after" phrasing', () => {
    expect(parseRetryAfterMs('please retry after 10s')).toBe(10_000);
  });

  it('does not confuse `seconds` with the bare `s` unit', () => {
    // Regression guard: the alternation must prefer the longer spelling.
    expect(parseRetryAfterMs('retry in 7seconds')).toBe(7_000);
  });

  it('returns null when there is no hint', () => {
    expect(parseRetryAfterMs('You have hit your usage limit')).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });
});

describe('textIndicatesRetryableRateLimit', () => {
  const INCIDENT =
    'API Error: Request rejected (429) · All 9 eligible accounts are rate-limited right now; retry in 3283s.';

  it('detects the pool-exhaustion rejection with a retry hint', () => {
    expect(textIndicatesRetryableRateLimit(INCIDENT)).toBe(true);
  });

  it('requires BOTH a retry hint AND a gateway signal (content-safe)', () => {
    // Rate signal but no retry hint → not actionable as a timed retry.
    expect(textIndicatesRetryableRateLimit('HTTP 429 too many requests')).toBe(false);
    // Retry hint but no rate signal → could be unrelated prose.
    expect(textIndicatesRetryableRateLimit('I will retry in 5 seconds after the deploy')).toBe(false);
  });

  it('does NOT fire on prose explaining HTTP 429 backoff (weak-signal false positive)', () => {
    // Regression (codex review): a bare `429` + a "retry in N" mention must
    // NOT be misread as an infra rejection — the gateway-distinctive tokens
    // (rate-limited / request rejected / eligible accounts) are required.
    expect(textIndicatesRetryableRateLimit('When you get HTTP 429, retry in 60 seconds with backoff.')).toBe(false);
    expect(textIndicatesRetryableRateLimit('The rate limit is 50 req/s; if exceeded, retry after 30 seconds.')).toBe(
      false,
    );
  });

  it('does not fire on ordinary assistant output', () => {
    expect(textIndicatesRetryableRateLimit('작업 완료 — 추가 대기 작업 없음.')).toBe(false);
    expect(textIndicatesRetryableRateLimit('{"completed": true, "reason": "done", "remaining": []}')).toBe(false);
  });

  it('returns false for empty / nullish input', () => {
    expect(textIndicatesRetryableRateLimit('')).toBe(false);
    expect(textIndicatesRetryableRateLimit(null)).toBe(false);
    expect(textIndicatesRetryableRateLimit(undefined)).toBe(false);
  });
});

describe('boundRateLimitDelayMs', () => {
  it('passes a normal advertised window through unchanged', () => {
    expect(boundRateLimitDelayMs(3283 * 1000)).toBe(3283 * 1000);
  });

  it('clamps an absurd window to the 1-hour ceiling', () => {
    expect(boundRateLimitDelayMs(999_999_000)).toBe(RATE_LIMIT_MAX_WAIT_MS);
  });

  it('floors a present-but-tiny value (incl. 0) so the retry still fires', () => {
    // A gateway `retry in 0s` must not collapse to a 0ms (skipped) retry.
    expect(boundRateLimitDelayMs(0)).toBe(RATE_LIMIT_MIN_WAIT_MS);
    expect(boundRateLimitDelayMs(250)).toBe(RATE_LIMIT_MIN_WAIT_MS);
  });

  it('collapses a missing / invalid hint to the default wait', () => {
    expect(boundRateLimitDelayMs(null)).toBe(RATE_LIMIT_DEFAULT_WAIT_MS);
    expect(boundRateLimitDelayMs(undefined)).toBe(RATE_LIMIT_DEFAULT_WAIT_MS);
    expect(boundRateLimitDelayMs(Number.NaN)).toBe(RATE_LIMIT_DEFAULT_WAIT_MS);
    expect(boundRateLimitDelayMs(-5)).toBe(RATE_LIMIT_DEFAULT_WAIT_MS);
  });
});

describe('normalizeForLimitMatch', () => {
  it('folds typographic apostrophes to ASCII', () => {
    expect(normalizeForLimitMatch('You\u2019ve')).toBe("you've");
    expect(normalizeForLimitMatch('You\u2018ve')).toBe("you've");
  });

  it('collapses middot/bullet separators and whitespace runs', () => {
    expect(normalizeForLimitMatch('limit \u00b7  resets')).toBe('limit resets');
    expect(normalizeForLimitMatch('a\u2022b')).toBe('a b');
  });

  it('lowercases', () => {
    expect(normalizeForLimitMatch('HELLO World')).toBe('hello world');
  });
});
