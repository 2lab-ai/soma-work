import { describe, expect, it } from 'vitest';
import { mintEventTs } from '../event-ts';

describe('mintEventTs', () => {
  // The counter is process-wide, so each case reads only what holds whatever ran before it.
  it('is a Slack-format ts no earlier than the given time', () => {
    const now = 1_793_179_847_931;
    const ts = mintEventTs(now);
    expect(ts).toMatch(/^\d+\.\d{6}$/);
    expect(Number(ts) * 1000).toBeGreaterThanOrEqual(now);
  });

  it('never repeats, even within one millisecond', () => {
    const now = 1_793_179_847_931;
    const minted = [mintEventTs(now), mintEventTs(now), mintEventTs(now)];
    expect(new Set(minted).size).toBe(3);
    expect(minted.map(Number)).toEqual([...minted.map(Number)].sort((a, b) => a - b));
  });
});
