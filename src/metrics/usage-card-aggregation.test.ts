import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ReportAggregator } from './report-aggregator';
import type { MetricsEvent } from './types';

// Trace: docs/usage-card/trace.md, Scenario 2, 3, 11
// Fixture: 30 days of synthetic token_usage events anchored at 2026-04-17 KST.

const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'usage-card.jsonl');
const FIXTURE_END_DATE = '2026-04-17';
const FIXTURE_START_DATE = '2026-03-19';

function loadFixture(): MetricsEvent[] {
  const content = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  return content
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as MetricsEvent);
}

function makeAggregator(events: MetricsEvent[]) {
  const readRange = vi.fn().mockResolvedValue(events);
  const store = { readRange } as any;
  return { aggregator: new ReportAggregator(store), readRange };
}

describe('aggregateUsageCard', () => {
  it('returns shape of UsageCardStats for target user with activity', async () => {
    const events = loadFixture();
    const { aggregator } = makeAggregator(events);
    // Set `now` to end of the fixture window so 24h/7d slices are meaningful.
    const now = new Date('2026-04-17T23:00:00+09:00');

    const result = await aggregator.aggregateUsageCard({
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      targetUserId: 'U_TEST_TARGET',
      now,
    });

    if ('empty' in result && result.empty === true) {
      throw new Error('expected non-empty stats');
    }
    expect(result.targetUserId).toBe('U_TEST_TARGET');
    expect(result.windowStart).toBe(FIXTURE_START_DATE);
    expect(result.windowEnd).toBe(FIXTURE_END_DATE);
    expect(result.heatmap).toHaveLength(42);
    expect(result.hourly).toHaveLength(24);
    expect(result.totals.last30d).toBeGreaterThan(0);
    expect(result.totals.last7d).toBeLessThanOrEqual(result.totals.last30d);
    expect(result.totals.last24h).toBeLessThanOrEqual(result.totals.last7d);
    expect(result.rankings.tokensTop.length).toBeGreaterThan(0);
    expect(result.rankings.costTop.length).toBeGreaterThan(0);
    expect(result.totalSessions).toBeGreaterThan(0);
    expect(result.favoriteModel).not.toBeNull();
  });

  it('heatmap cells: real days fill cellIndex 12..41 (leading pad 12 blanks max)', async () => {
    const events = loadFixture();
    const { aggregator } = makeAggregator(events);
    const now = new Date('2026-04-17T23:00:00+09:00');
    const result = await aggregator.aggregateUsageCard({
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      targetUserId: 'U_TEST_TARGET',
      now,
    });
    if ('empty' in result && result.empty === true) throw new Error('expected non-empty');

    const realCells = result.heatmap.filter((c) => c.date !== '');
    expect(realCells).toHaveLength(30);
    expect(result.heatmap.every((c, i) => c.cellIndex === i)).toBe(true);
    // Blanks must have tokens: 0 and date: ''.
    for (const c of result.heatmap) {
      if (c.date === '') expect(c.tokens).toBe(0);
    }
  });

  it('rankings include target user with highest tokens (fixture-target gets most events)', async () => {
    const events = loadFixture();
    const { aggregator } = makeAggregator(events);
    const result = await aggregator.aggregateUsageCard({
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      targetUserId: 'U_TEST_TARGET',
      now: new Date('2026-04-17T23:00:00+09:00'),
    });
    if ('empty' in result && result.empty === true) throw new Error('expected non-empty');

    const targetRank = result.rankings.tokensTop.find((r) => r.userId === 'U_TEST_TARGET');
    expect(targetRank).toBeDefined();
    expect(targetRank?.totalTokens).toBeGreaterThan(0);
    // Target sits in top-5 (fixture gives them most events) → overflow row null.
    expect(result.rankings.targetTokenRow).toBeNull();
    expect(result.rankings.targetCostRow).toBeNull();
  });

  it('rankings assign sequential rank starting at 1, descending by tokens', async () => {
    const events = loadFixture();
    const { aggregator } = makeAggregator(events);
    const result = await aggregator.aggregateUsageCard({
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      targetUserId: 'U_TEST_TARGET',
      now: new Date('2026-04-17T23:00:00+09:00'),
    });
    if ('empty' in result && result.empty === true) throw new Error('expected non-empty');
    result.rankings.tokensTop.forEach((r, i) => expect(r.rank).toBe(i + 1));
    for (let i = 1; i < result.rankings.tokensTop.length; i++) {
      expect(result.rankings.tokensTop[i - 1].totalTokens).toBeGreaterThanOrEqual(
        result.rankings.tokensTop[i].totalTokens,
      );
    }
  });

  it('target outside rendered top-5 → targetTokenRow surfaces overflow with real rank', async () => {
    // Synthesise a scenario where the target is clearly outside top-5 by
    // adding 6 higher-volume users on top of the fixture.
    const events = loadFixture();
    const extras: MetricsEvent[] = [];
    for (let u = 0; u < 6; u++) {
      const userId = `U_TOP_${u}`;
      for (let i = 0; i < 5; i++) {
        extras.push({
          eventType: 'token_usage',
          timestamp: Date.parse('2026-04-17T12:00:00+09:00') + i * 1000,
          userId,
          userName: `Top${u}`,
          sessionKey: `s_${userId}_${i}`,
          metadata: {
            inputTokens: 10_000_000, // massively larger than any fixture user
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUsd: 100,
            model: 'claude-opus-4-7',
          },
        } as unknown as MetricsEvent);
      }
    }
    const { aggregator } = makeAggregator([...events, ...extras]);
    const result = await aggregator.aggregateUsageCard({
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      targetUserId: 'U_TEST_TARGET',
      now: new Date('2026-04-17T23:00:00+09:00'),
    });
    if ('empty' in result && result.empty === true) throw new Error('expected non-empty');

    expect(result.rankings.targetTokenRow).not.toBeNull();
    expect(result.rankings.targetTokenRow?.userId).toBe('U_TEST_TARGET');
    expect(result.rankings.targetTokenRow?.rank).toBeGreaterThan(5);
    // Target must NOT appear in the rendered top-5 slice.
    expect(result.rankings.tokensTop.slice(0, 5).some((r) => r.userId === 'U_TEST_TARGET')).toBe(false);
  });

  it('empty short-circuit: unknown target user → {empty: true}', async () => {
    const events = loadFixture();
    const { aggregator } = makeAggregator(events);
    const result = await aggregator.aggregateUsageCard({
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      targetUserId: 'U_NOT_IN_FIXTURE',
      now: new Date('2026-04-17T23:00:00+09:00'),
    });
    expect(result).toEqual({
      empty: true,
      windowStart: FIXTURE_START_DATE,
      windowEnd: FIXTURE_END_DATE,
      targetUserId: 'U_NOT_IN_FIXTURE',
    });
  });

  it('empty short-circuit: no events at all → {empty: true}', async () => {
    const { aggregator } = makeAggregator([]);
    const result = await aggregator.aggregateUsageCard({
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      targetUserId: 'U_TEST_TARGET',
      now: new Date('2026-04-17T23:00:00+09:00'),
    });
    expect(result).toHaveProperty('empty', true);
  });

  it('currentStreakDays: counts consecutive days ending at windowEnd', async () => {
    const events = loadFixture();
    const { aggregator } = makeAggregator(events);
    const result = await aggregator.aggregateUsageCard({
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      targetUserId: 'U_TEST_TARGET',
      now: new Date('2026-04-17T23:00:00+09:00'),
    });
    if ('empty' in result && result.empty === true) throw new Error('expected non-empty');
    expect(result.currentStreakDays).toBeGreaterThanOrEqual(0);
    expect(result.currentStreakDays).toBeLessThanOrEqual(30);
  });

  it('sessions.tokenTop3 has ≤3 entries; spanTop3 only includes sessions with ≥2 events', async () => {
    const events = loadFixture();
    const { aggregator } = makeAggregator(events);
    const result = await aggregator.aggregateUsageCard({
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      targetUserId: 'U_TEST_TARGET',
      now: new Date('2026-04-17T23:00:00+09:00'),
    });
    if ('empty' in result && result.empty === true) throw new Error('expected non-empty');
    expect(result.sessions.tokenTop3.length).toBeLessThanOrEqual(3);
    expect(result.sessions.spanTop3.length).toBeLessThanOrEqual(3);
    for (const s of result.sessions.spanTop3) {
      expect(s.durationMs).toBeGreaterThan(0);
    }
  });
});
