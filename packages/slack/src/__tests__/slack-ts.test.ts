/**
 * Re-run (astra P1, verified after 8bc48b54): the owner's chronology must survive
 * Slack's microsecond ts. Flooring or rounding to ms ties — or inverts — two
 * messages sent within the same millisecond, and the classifier then quotes a
 * later "don't" before the earlier "do".
 */

import { describe, expect, it } from 'vitest';
import { slackTsOrderMs } from '../slack-ts';

describe('slackTsOrderMs', () => {
  it('keeps two messages of the same millisecond apart, in order', () => {
    expect(slackTsOrderMs('1792900000.000100')).toBeLessThan(slackTsOrderMs('1792900000.000200') as number);
  });

  it('never inverts across a rounding boundary', () => {
    expect(slackTsOrderMs('1792900000.000600')).toBeLessThan(slackTsOrderMs('1792900000.000700') as number);
  });

  it('orders adjacent microseconds of a real-sized ts', () => {
    const ts = Array.from({ length: 20 }, (_, i) => `1793067439.2735${String(80 + i).padStart(2, '0')}`);
    const ms = ts.map((t) => slackTsOrderMs(t) as number);
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1]);
  });

  it('is in epoch milliseconds', () => {
    expect(Math.floor(slackTsOrderMs('1792900000.000100') as number)).toBe(1792900000000);
  });

  it('is undefined for something that is not a Slack ts', () => {
    expect(slackTsOrderMs(undefined)).toBeUndefined();
    expect(slackTsOrderMs('')).toBeUndefined();
    expect(slackTsOrderMs('dashboard:9')).toBeUndefined();
    expect(slackTsOrderMs('0')).toBeUndefined();
  });
});
