import { describe, expect, it } from 'vitest';
import { activeDays, currentStreak, longestStreak } from './streaks';

// Trace: docs/usage-card-dark/trace.md, Scenarios 4/5/6
describe('activeDays', () => {
  const windowStart = new Date('2026-04-01T00:00:00+09:00');
  const windowEnd = new Date('2026-04-30T23:59:59+09:00');

  it('empty events → 0', () => {
    expect(activeDays([], windowStart, windowEnd)).toBe(0);
  });

  it('three events all on 2026-04-10 KST → 1', () => {
    const events = [
      { ts: new Date('2026-04-10T05:00:00+09:00') },
      { ts: new Date('2026-04-10T12:00:00+09:00') },
      { ts: new Date('2026-04-10T22:30:00+09:00') },
    ];
    expect(activeDays(events, windowStart, windowEnd)).toBe(1);
  });

  it('events on 2026-04-10 KST + one on 2026-04-11 KST → 2', () => {
    const events = [
      { ts: new Date('2026-04-10T05:00:00+09:00') },
      { ts: new Date('2026-04-10T18:00:00+09:00') },
      { ts: new Date('2026-04-11T09:00:00+09:00') },
    ];
    expect(activeDays(events, windowStart, windowEnd)).toBe(2);
  });

  it('timezone boundary — two UTC-adjacent events cross KST midnight → 2', () => {
    // 14:30Z = 23:30 KST on 2026-04-09
    // 15:30Z = 00:30 KST on 2026-04-10
    const events = [
      { ts: new Date('2026-04-09T14:30:00Z') },
      { ts: new Date('2026-04-09T15:30:00Z') },
    ];
    expect(activeDays(events, windowStart, windowEnd)).toBe(2);
  });

  it('events outside window excluded', () => {
    const narrowStart = new Date('2026-04-10T00:00:00+09:00');
    const narrowEnd = new Date('2026-04-11T23:59:59+09:00');
    const events = [
      { ts: new Date('2026-04-09T12:00:00+09:00') }, // outside
      { ts: new Date('2026-04-10T12:00:00+09:00') }, // in
      { ts: new Date('2026-04-11T12:00:00+09:00') }, // in
    ];
    expect(activeDays(events, narrowStart, narrowEnd)).toBe(2);
  });

  it('ts as number (ms epoch) works same as Date', () => {
    const events = [
      { ts: new Date('2026-04-10T05:00:00+09:00').getTime() },
      { ts: new Date('2026-04-10T22:30:00+09:00').getTime() },
      { ts: new Date('2026-04-11T09:00:00+09:00').getTime() },
    ];
    expect(activeDays(events, windowStart, windowEnd)).toBe(2);
  });
});

describe('longestStreak', () => {
  it('empty set → 0', () => {
    expect(longestStreak(new Set())).toBe(0);
  });

  it('single day → 1', () => {
    expect(longestStreak(new Set(['2026-04-10']))).toBe(1);
  });

  it('three consecutive → 3', () => {
    expect(longestStreak(new Set(['2026-04-10', '2026-04-11', '2026-04-12']))).toBe(3);
  });

  it('gap between two → 1', () => {
    expect(longestStreak(new Set(['2026-04-10', '2026-04-12']))).toBe(1);
  });

  it('split runs, returns max (2 + 3 → 3)', () => {
    expect(
      longestStreak(
        new Set(['2026-04-10', '2026-04-11', '2026-04-13', '2026-04-14', '2026-04-15']),
      ),
    ).toBe(3);
  });
});

describe('currentStreak', () => {
  it("today missing from set → 0", () => {
    const set = new Set(['2026-04-15', '2026-04-16', '2026-04-17']);
    expect(currentStreak(set, '2026-04-18')).toBe(0);
  });

  it('today + 2 previous consecutive → 3', () => {
    const set = new Set(['2026-04-16', '2026-04-17', '2026-04-18']);
    expect(currentStreak(set, '2026-04-18')).toBe(3);
  });

  it('today + 1 previous consecutive → 2', () => {
    const set = new Set(['2026-04-17', '2026-04-18']);
    expect(currentStreak(set, '2026-04-18')).toBe(2);
  });

  it('only today → 1', () => {
    const set = new Set(['2026-04-18']);
    expect(currentStreak(set, '2026-04-18')).toBe(1);
  });

  it('empty set → 0', () => {
    expect(currentStreak(new Set(), '2026-04-18')).toBe(0);
  });

  it('month boundary — 2026-04-30 + 2026-05-01 → 2', () => {
    const set = new Set(['2026-04-30', '2026-05-01']);
    expect(currentStreak(set, '2026-05-01')).toBe(2);
  });
});
