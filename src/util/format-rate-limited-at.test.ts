import { describe, expect, it } from 'vitest';
import { formatRateLimitedAt } from './format-rate-limited-at';

describe('formatRateLimitedAt', () => {
  it('renders KST local + UTC + relative for a 5-minute-old timestamp', () => {
    const out = formatRateLimitedAt('2026-04-18T03:37:00Z', 'Asia/Seoul', Date.parse('2026-04-18T03:42:00Z'));
    expect(out).toBe('2026-04-18 12:37 KST / 03:37Z (5m ago)');
  });

  it('local side reflects the user timezone, not UTC', () => {
    // 03:37 UTC → 12:37 KST (+9h)
    const out = formatRateLimitedAt('2026-04-18T03:37:00Z', 'Asia/Seoul', Date.parse('2026-04-18T03:42:00Z'));
    expect(out).toContain('12:37 KST');
    expect(out).toContain('03:37Z');
  });

  it("returns 'now' under 30s", () => {
    const out = formatRateLimitedAt('2026-04-18T03:37:00Z', 'Asia/Seoul', Date.parse('2026-04-18T03:37:29Z'));
    expect(out).toContain('(now)');
  });

  it("returns '1m ago' at 90s boundary", () => {
    const out = formatRateLimitedAt('2026-04-18T03:37:00Z', 'Asia/Seoul', Date.parse('2026-04-18T03:38:30Z'));
    expect(out).toContain('(1m ago)');
  });

  it("returns '59m ago' just under the hour", () => {
    const out = formatRateLimitedAt('2026-04-18T03:00:00Z', 'Asia/Seoul', Date.parse('2026-04-18T03:59:00Z'));
    expect(out).toContain('(59m ago)');
  });

  it("returns '1h ago' at 60m exactly", () => {
    const out = formatRateLimitedAt('2026-04-18T03:00:00Z', 'Asia/Seoul', Date.parse('2026-04-18T04:00:00Z'));
    expect(out).toContain('(1h ago)');
  });

  it("returns '23h ago' just under the day", () => {
    const out = formatRateLimitedAt('2026-04-17T04:00:00Z', 'Asia/Seoul', Date.parse('2026-04-18T03:00:00Z'));
    expect(out).toContain('(23h ago)');
  });

  it("returns '1d ago' at 24h exactly", () => {
    const out = formatRateLimitedAt('2026-04-17T04:00:00Z', 'Asia/Seoul', Date.parse('2026-04-18T04:00:00Z'));
    expect(out).toContain('(1d ago)');
  });

  it('honours non-Seoul IANA timezones (LA → PDT/PST)', () => {
    const out = formatRateLimitedAt(
      '2026-04-18T20:00:00Z', // Spring DST → PDT (UTC-7) → 13:00
      'America/Los_Angeles',
      Date.parse('2026-04-18T20:05:00Z'),
    );
    expect(out).toMatch(/\bP[DS]T\b/);
    expect(out).toContain('20:00Z');
    expect(out).toContain('(5m ago)');
  });

  it('returns 30s as seconds (boundary)', () => {
    const out = formatRateLimitedAt('2026-04-18T03:37:00Z', 'Asia/Seoul', Date.parse('2026-04-18T03:37:30Z'));
    expect(out).toContain('(30s ago)');
  });
});
