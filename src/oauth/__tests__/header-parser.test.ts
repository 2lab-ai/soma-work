import { describe, expect, it } from 'vitest';
import { hintsIndicateExhausted, parseRateLimitHeaders } from '../header-parser';

describe('parseRateLimitHeaders', () => {
  it('parses unified-5h headers', () => {
    const hints = parseRateLimitHeaders({
      'anthropic-ratelimit-unified-5h-reset': '1700000000',
      'anthropic-ratelimit-unified-5h-limit': '1000',
      'anthropic-ratelimit-unified-5h-remaining': '500',
      'anthropic-ratelimit-unified-5h-percent': '50',
      'anthropic-ratelimit-unified-5h-representative-claim': 'some-claim',
    });
    expect(hints).toHaveLength(1);
    expect(hints[0].window).toBe('5h');
    expect(hints[0].resetAtMs).toBe(1700000000 * 1000);
    expect(hints[0].utilization).toBeCloseTo(0.5, 3);
    expect(hints[0].claim).toBe('some-claim');
  });

  it('parses unified-7d headers', () => {
    const hints = parseRateLimitHeaders({
      'anthropic-ratelimit-unified-7d-reset': '1700000001',
      'anthropic-ratelimit-unified-7d-percent': '75',
    });
    expect(hints).toHaveLength(1);
    expect(hints[0].window).toBe('7d');
    expect(hints[0].resetAtMs).toBe(1700000001 * 1000);
    expect(hints[0].utilization).toBeCloseTo(0.75, 3);
  });

  it('parses both 5h and 7d together', () => {
    const hints = parseRateLimitHeaders({
      'anthropic-ratelimit-unified-5h-percent': '10',
      'anthropic-ratelimit-unified-7d-percent': '20',
    });
    expect(hints).toHaveLength(2);
    const byWindow = new Map(hints.map((h) => [h.window, h]));
    expect(byWindow.get('5h')?.utilization).toBeCloseTo(0.1, 3);
    expect(byWindow.get('7d')?.utilization).toBeCloseTo(0.2, 3);
  });

  it('ignores unrelated anthropic-* headers', () => {
    const hints = parseRateLimitHeaders({
      'anthropic-version': '2023-06-01',
      'anthropic-request-id': 'abc',
      'x-other': 'ignored',
    });
    expect(hints).toHaveLength(0);
  });

  it('accepts a Headers instance', () => {
    const h = new Headers();
    h.set('anthropic-ratelimit-unified-5h-percent', '42');
    h.set('anthropic-ratelimit-unified-5h-reset', '1700000002');
    const hints = parseRateLimitHeaders(h);
    expect(hints).toHaveLength(1);
    expect(hints[0].window).toBe('5h');
    expect(hints[0].utilization).toBeCloseTo(0.42, 3);
  });

  it('interprets fractional percent values (0..1) correctly', () => {
    const hints = parseRateLimitHeaders({
      'anthropic-ratelimit-unified-5h-percent': '0.8',
    });
    expect(hints).toHaveLength(1);
    expect(hints[0].utilization).toBeCloseTo(0.8, 3);
  });

  it('returns empty array for undefined/empty header bags', () => {
    expect(parseRateLimitHeaders({})).toEqual([]);
    expect(parseRateLimitHeaders({ foo: undefined })).toEqual([]);
  });
});

describe('hintsIndicateExhausted', () => {
  it('returns true when percent >= 1.0', () => {
    expect(hintsIndicateExhausted([{ window: '5h', utilization: 1.0 }])).toBe(true);
  });

  it('returns true when percent > 1.0', () => {
    expect(hintsIndicateExhausted([{ window: '7d', utilization: 1.5 }])).toBe(true);
  });

  it('returns true when remaining is 0 (parsed as utilization = 1)', () => {
    const hints = parseRateLimitHeaders({
      'anthropic-ratelimit-unified-5h-limit': '100',
      'anthropic-ratelimit-unified-5h-remaining': '0',
    });
    expect(hintsIndicateExhausted(hints)).toBe(true);
  });

  it('returns false when utilization < 1 and remaining > 0', () => {
    expect(hintsIndicateExhausted([{ window: '5h', utilization: 0.9 }])).toBe(false);
  });

  it('returns false when both utilization and remaining absent', () => {
    expect(hintsIndicateExhausted([{ window: '5h' }])).toBe(false);
  });

  it('returns false for empty hints', () => {
    expect(hintsIndicateExhausted([])).toBe(false);
  });
});
