import { describe, expect, it } from 'vitest';
import { normalizeForLimitMatch, textIndicatesUsageLimit } from '../rate-limit';

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
