import { describe, expect, it } from 'vitest';
import { formatNmSSs } from './duration';

describe('formatNmSSs — Dashboard v2.1 chunk A-2', () => {
  it('formats 0ms as 0m 00s', () => {
    expect(formatNmSSs(0)).toBe('0m 00s');
  });

  it('formats seconds below 1 minute with zero-padded seconds', () => {
    expect(formatNmSSs(1_000)).toBe('0m 01s');
    expect(formatNmSSs(9_000)).toBe('0m 09s');
    expect(formatNmSSs(45_000)).toBe('0m 45s');
  });

  it('formats exact minute boundaries as "Nm 00s"', () => {
    expect(formatNmSSs(60_000)).toBe('1m 00s');
    expect(formatNmSSs(180_000)).toBe('3m 00s');
  });

  it('formats mixed minutes+seconds', () => {
    expect(formatNmSSs(65_500)).toBe('1m 05s');
    expect(formatNmSSs(605_000)).toBe('10m 05s');
  });

  it('floors sub-second remainders (does not round up)', () => {
    expect(formatNmSSs(999)).toBe('0m 00s');
    expect(formatNmSSs(1_999)).toBe('0m 01s');
  });

  it('handles invalid/negative/NaN inputs by returning 0m 00s', () => {
    expect(formatNmSSs(-1)).toBe('0m 00s');
    expect(formatNmSSs(Number.NaN)).toBe('0m 00s');
    // @ts-expect-error intentional wrong input
    expect(formatNmSSs(undefined)).toBe('0m 00s');
    // @ts-expect-error intentional wrong input
    expect(formatNmSSs(null)).toBe('0m 00s');
  });

  it('formats large values (>1 hour) as minute-count', () => {
    // 1h 30m 45s = 5445s
    expect(formatNmSSs(5_445_000)).toBe('90m 45s');
  });
});
