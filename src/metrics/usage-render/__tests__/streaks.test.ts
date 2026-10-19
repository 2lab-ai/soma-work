import { describe, expect, it } from 'vitest';
import { currentStreak, longestStreak } from '../streaks';

// Trace: docs/current/plans/usage-card-dark/trace.md, Scenarios 5/6
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
    expect(longestStreak(new Set(['2026-04-10', '2026-04-11', '2026-04-13', '2026-04-14', '2026-04-15']))).toBe(3);
  });
});

describe('currentStreak', () => {
  it('today missing from set → 0', () => {
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
