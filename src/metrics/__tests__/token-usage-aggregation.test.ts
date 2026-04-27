/**
 * Tests for token usage aggregation in ReportAggregator.
 * Verifies: per-model breakdown, per-user breakdown, per-day breakdown.
 */
import { describe, expect, it, vi } from 'vitest';
import { ReportAggregator } from '../report-aggregator';
import type { MetricsEvent } from '../types';

function makeTokenUsageEvent(
  overrides: Partial<{
    userId: string;
    userName: string;
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
    modelBreakdown: Record<string, any>;
  }> = {},
): MetricsEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: overrides.timestamp ?? Date.now(),
    eventType: 'token_usage',
    userId: overrides.userId ?? 'U001',
    userName: overrides.userName ?? 'TestUser',
    sessionKey: 'C1-t1',
    metadata: {
      sessionKey: 'C1-t1',
      model: overrides.model ?? 'claude-opus-4-6-20250414',
      inputTokens: overrides.inputTokens ?? 1000,
      outputTokens: overrides.outputTokens ?? 500,
      cacheReadInputTokens: overrides.cacheReadInputTokens ?? 200,
      cacheCreationInputTokens: overrides.cacheCreationInputTokens ?? 100,
      costUsd: overrides.costUsd ?? 0.05,
      modelBreakdown: overrides.modelBreakdown,
    },
  };
}

/** Create a store stub that returns given events for any date range */
function mockStore(events: MetricsEvent[]) {
  return {
    readRange: vi.fn().mockResolvedValue(events),
    append: vi.fn(),
  } as any;
}

describe('Token Usage Aggregation', () => {
  it('should aggregate total tokens from token_usage events', async () => {
    const events = [
      makeTokenUsageEvent({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
        costUsd: 0.05,
      }),
      makeTokenUsageEvent({
        inputTokens: 2000,
        outputTokens: 1000,
        cacheReadInputTokens: 400,
        cacheCreationInputTokens: 200,
        costUsd: 0.1,
      }),
    ];

    const aggregator = new ReportAggregator(mockStore(events));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-07');

    expect(report.totals.totalInputTokens).toBe(3000);
    expect(report.totals.totalOutputTokens).toBe(1500);
    expect(report.totals.totalCacheReadTokens).toBe(600);
    expect(report.totals.totalCacheCreateTokens).toBe(300);
    expect(report.totals.totalCostUsd).toBeCloseTo(0.15);
  });

  it('should aggregate by model when modelBreakdown is provided', async () => {
    const events = [
      makeTokenUsageEvent({
        modelBreakdown: {
          'claude-opus-4-6-20250414': {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
            costUsd: 0.05,
          },
          'claude-sonnet-4-6-20250514': {
            inputTokens: 500,
            outputTokens: 200,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 50,
            costUsd: 0.01,
          },
        },
        inputTokens: 1500,
        outputTokens: 700,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 150,
        costUsd: 0.06,
      }),
    ];

    const aggregator = new ReportAggregator(mockStore(events));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-07');

    expect(report.totals.byModel['claude-opus-4-6-20250414']).toBeDefined();
    expect(report.totals.byModel['claude-opus-4-6-20250414'].inputTokens).toBe(1000);
    expect(report.totals.byModel['claude-sonnet-4-6-20250514']).toBeDefined();
    expect(report.totals.byModel['claude-sonnet-4-6-20250514'].inputTokens).toBe(500);
  });

  it('should aggregate by model using event model when no breakdown', async () => {
    const events = [makeTokenUsageEvent({ model: 'claude-opus-4-6-20250414', inputTokens: 1000, costUsd: 0.05 })];

    const aggregator = new ReportAggregator(mockStore(events));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-07');

    expect(report.totals.byModel['claude-opus-4-6-20250414']).toBeDefined();
    expect(report.totals.byModel['claude-opus-4-6-20250414'].inputTokens).toBe(1000);
  });

  it('should aggregate by user', async () => {
    const events = [
      makeTokenUsageEvent({ userId: 'U001', userName: 'Alice', inputTokens: 1000, costUsd: 0.05 }),
      makeTokenUsageEvent({ userId: 'U002', userName: 'Bob', inputTokens: 2000, costUsd: 0.1 }),
      makeTokenUsageEvent({ userId: 'U001', userName: 'Alice', inputTokens: 500, costUsd: 0.02 }),
    ];

    const aggregator = new ReportAggregator(mockStore(events));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-07');

    expect(report.byUser['U001']).toBeDefined();
    expect(report.byUser['U001'].totalInputTokens).toBe(1500);
    expect(report.byUser['U001'].userName).toBe('Alice');
    expect(report.byUser['U002']).toBeDefined();
    expect(report.byUser['U002'].totalInputTokens).toBe(2000);
    expect(report.byUser['U002'].userName).toBe('Bob');
  });

  it('should filter by userId when provided', async () => {
    const events = [
      makeTokenUsageEvent({ userId: 'U001', inputTokens: 1000 }),
      makeTokenUsageEvent({ userId: 'U002', inputTokens: 2000 }),
    ];

    const aggregator = new ReportAggregator(mockStore(events));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-07', 'U001');

    expect(report.totals.totalInputTokens).toBe(1000);
  });

  it('should determine correct period from date range', async () => {
    const events: MetricsEvent[] = [];
    const aggregator = new ReportAggregator(mockStore(events));

    const daily = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-07');
    expect(daily.period).toBe('day');

    const weekly = await aggregator.aggregateTokenUsage('2026-04-01', '2026-04-07');
    expect(weekly.period).toBe('week');

    const monthly = await aggregator.aggregateTokenUsage('2026-03-08', '2026-04-07');
    expect(monthly.period).toBe('month');
  });

  it('should aggregate by day', async () => {
    // Two events on day 1, one on day 2
    const day1 = new Date('2026-04-07T10:00:00+09:00').getTime();
    const day2 = new Date('2026-04-08T10:00:00+09:00').getTime();

    const events = [
      makeTokenUsageEvent({ timestamp: day1, inputTokens: 1000 }),
      makeTokenUsageEvent({ timestamp: day1, inputTokens: 2000 }),
      makeTokenUsageEvent({ timestamp: day2, inputTokens: 3000 }),
    ];

    const aggregator = new ReportAggregator(mockStore(events));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-08');

    expect(report.byDay).toHaveLength(2);
    expect(report.byDay[0].date).toBe('2026-04-07');
    expect(report.byDay[0].totals.totalInputTokens).toBe(3000);
    expect(report.byDay[1].date).toBe('2026-04-08');
    expect(report.byDay[1].totals.totalInputTokens).toBe(3000);
  });

  it('should handle empty events gracefully', async () => {
    const aggregator = new ReportAggregator(mockStore([]));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-07');

    expect(report.totals.totalInputTokens).toBe(0);
    expect(report.totals.totalCostUsd).toBe(0);
    expect(Object.keys(report.byUser)).toHaveLength(0);
    expect(report.byDay).toHaveLength(1);
  });

  it('should correctly split events at UTC/KST midnight boundary', async () => {
    // 2026-04-07T14:59:59Z = 2026-04-07T23:59:59+09:00 (still Apr 7 KST)
    // 2026-04-07T15:00:00Z = 2026-04-08T00:00:00+09:00 (crosses to Apr 8 KST)
    const beforeMidnight = new Date('2026-04-07T14:59:59Z').getTime();
    const afterMidnight = new Date('2026-04-07T15:00:00Z').getTime();

    const events = [
      makeTokenUsageEvent({ timestamp: beforeMidnight, inputTokens: 1000 }),
      makeTokenUsageEvent({ timestamp: afterMidnight, inputTokens: 2000 }),
    ];

    const aggregator = new ReportAggregator(mockStore(events));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-08');

    expect(report.byDay).toHaveLength(2);
    expect(report.byDay[0].date).toBe('2026-04-07');
    expect(report.byDay[0].totals.totalInputTokens).toBe(1000);
    expect(report.byDay[1].date).toBe('2026-04-08');
    expect(report.byDay[1].totals.totalInputTokens).toBe(2000);
  });

  it('should filter out non-token_usage events', async () => {
    const events = [
      makeTokenUsageEvent({ inputTokens: 1000, costUsd: 0.05 }),
      // Simulate a non-token_usage event
      {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        eventType: 'turn_used' as const,
        userId: 'U001',
        userName: 'TestUser',
        sessionKey: 'C1-t1',
        metadata: { some: 'data' },
      },
    ];

    const aggregator = new ReportAggregator(mockStore(events));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-07');

    // Only the token_usage event should be counted
    expect(report.totals.totalInputTokens).toBe(1000);
    expect(report.totals.totalCostUsd).toBeCloseTo(0.05);
  });

  it('should exclude assistant and unknown users from byUser', async () => {
    const events = [
      makeTokenUsageEvent({ userId: 'assistant', userName: 'assistant' }),
      makeTokenUsageEvent({ userId: 'unknown', userName: 'unknown' }),
      makeTokenUsageEvent({ userId: 'U001', userName: 'Alice' }),
    ];

    const aggregator = new ReportAggregator(mockStore(events));
    const report = await aggregator.aggregateTokenUsage('2026-04-07', '2026-04-07');

    expect(Object.keys(report.byUser)).toHaveLength(1);
    expect(report.byUser['U001']).toBeDefined();
  });
});

// Trace: docs/usage-rolling-24h — Scenario: /usage rolling 24h window
// Issue: https://github.com/2lab-ai/soma-work/issues/650
describe('aggregateTokenUsageMs — rolling 24h window', () => {
  /**
   * Build a store stub keyed by KST day-file. `readRange(startKey, endKey)`
   * returns the union of events for the requested KST calendar dates.
   * Mirrors the real JSONL day-file rotation in MetricsEventStore.
   */
  function mockStoreByDay(eventsByDay: Record<string, MetricsEvent[]>) {
    const readRange = vi.fn(async (startKey: string, endKey: string) => {
      // Generate inclusive day-key range in UTC (same algorithm as generateDateRange)
      const out: MetricsEvent[] = [];
      const start = new Date(`${startKey}T00:00:00Z`);
      const end = new Date(`${endKey}T00:00:00Z`);
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        if (eventsByDay[key]) out.push(...eventsByDay[key]);
      }
      out.sort((a, b) => a.timestamp - b.timestamp);
      return out;
    });
    return { readRange, append: vi.fn() } as any;
  }

  /** Return KST day-key (YYYY-MM-DD) for a given ms timestamp. */
  function kstDayKey(ms: number): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ms));
  }

  it('includes event at now - 23h', async () => {
    // Anchor: 2026-04-20 12:00:00 KST = 2026-04-20 03:00:00 UTC
    const nowMs = new Date('2026-04-20T12:00:00+09:00').getTime();
    const event = makeTokenUsageEvent({
      timestamp: nowMs - 23 * 60 * 60 * 1000, // now - 23h = 13:00 KST (2026-04-19)
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.05,
    });
    const store = mockStoreByDay({
      [kstDayKey(event.timestamp)]: [event],
      [kstDayKey(nowMs)]: [],
    });
    const aggregator = new ReportAggregator(store);
    const report = await aggregator.aggregateTokenUsageMs(nowMs - 24 * 60 * 60 * 1000, nowMs);

    expect(report.totals.totalInputTokens).toBe(1000);
    expect(report.totals.totalCostUsd).toBeCloseTo(0.05);
  });

  it('excludes event at now - 24h - 1min', async () => {
    const nowMs = new Date('2026-04-20T12:00:00+09:00').getTime();
    const oldTs = nowMs - 24 * 60 * 60 * 1000 - 60_000; // just outside window
    const insideTs = nowMs - 60_000; // 1 min ago, clearly inside
    const store = mockStoreByDay({
      [kstDayKey(oldTs)]: [
        makeTokenUsageEvent({
          timestamp: oldTs,
          inputTokens: 9999,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 1.0,
        }),
      ],
      [kstDayKey(insideTs)]: [
        makeTokenUsageEvent({
          timestamp: insideTs,
          inputTokens: 100,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 0.01,
        }),
      ],
    });
    const aggregator = new ReportAggregator(store);
    const report = await aggregator.aggregateTokenUsageMs(nowMs - 24 * 60 * 60 * 1000, nowMs);

    // Only the inside event survives the ms-level filter
    expect(report.totals.totalInputTokens).toBe(100);
    expect(report.totals.totalCostUsd).toBeCloseTo(0.01);
  });

  it('window crossing KST midnight: yesterday day-file events are included', async () => {
    // Call at KST 02:00 — window spans [2026-04-19 02:00 KST, 2026-04-20 02:00 KST]
    const nowMs = new Date('2026-04-20T02:00:00+09:00').getTime();
    const yesterdayEveningTs = new Date('2026-04-19T15:00:00+09:00').getTime();
    const todayEarlyTs = new Date('2026-04-20T01:30:00+09:00').getTime();
    const store = mockStoreByDay({
      '2026-04-19': [
        makeTokenUsageEvent({
          timestamp: yesterdayEveningTs,
          inputTokens: 500,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 0.02,
        }),
      ],
      '2026-04-20': [
        makeTokenUsageEvent({
          timestamp: todayEarlyTs,
          inputTokens: 300,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 0.01,
        }),
      ],
    });
    const aggregator = new ReportAggregator(store);
    const report = await aggregator.aggregateTokenUsageMs(nowMs - 24 * 60 * 60 * 1000, nowMs);

    expect(report.totals.totalInputTokens).toBe(800); // both included
    expect(report.startDate).toBe('2026-04-19');
    expect(report.endDate).toBe('2026-04-20');
  });

  it('userId filter: only target user events counted', async () => {
    const nowMs = new Date('2026-04-20T12:00:00+09:00').getTime();
    const ts = nowMs - 60_000;
    const store = mockStoreByDay({
      [kstDayKey(nowMs)]: [
        makeTokenUsageEvent({
          userId: 'U001',
          userName: 'Alice',
          timestamp: ts,
          inputTokens: 100,
        }),
        makeTokenUsageEvent({
          userId: 'U002',
          userName: 'Bob',
          timestamp: ts,
          inputTokens: 9999,
        }),
      ],
    });
    const aggregator = new ReportAggregator(store);
    const report = await aggregator.aggregateTokenUsageMs(nowMs - 24 * 60 * 60 * 1000, nowMs, 'U001');

    expect(report.totals.totalInputTokens).toBe(100);
    // Rankings suppressed when userId filter applied
    expect(report.tokenRankings).toEqual([]);
    expect(report.costRankings).toEqual([]);
  });

  it('rankings: populated + 24h-scoped when no userId filter', async () => {
    const nowMs = new Date('2026-04-20T12:00:00+09:00').getTime();
    const insideTs = nowMs - 60 * 60 * 1000; // 1h ago — inside
    const outsideTs = nowMs - 25 * 60 * 60 * 1000; // 25h ago — outside
    const store = mockStoreByDay({
      [kstDayKey(outsideTs)]: [
        // Outside window — must not affect rankings
        makeTokenUsageEvent({
          userId: 'U002',
          userName: 'Bob',
          timestamp: outsideTs,
          inputTokens: 9999,
          costUsd: 1.0,
        }),
      ],
      [kstDayKey(insideTs)]: [
        makeTokenUsageEvent({
          userId: 'U001',
          userName: 'Alice',
          timestamp: insideTs,
          inputTokens: 100,
          costUsd: 0.01,
        }),
        makeTokenUsageEvent({
          userId: 'U002',
          userName: 'Bob',
          timestamp: insideTs,
          inputTokens: 200,
          costUsd: 0.02,
        }),
      ],
    });
    const aggregator = new ReportAggregator(store);
    const report = await aggregator.aggregateTokenUsageMs(nowMs - 24 * 60 * 60 * 1000, nowMs);

    // Rankings reflect only the 24h window — Bob's 9999-token event at now-25h is excluded.
    // makeTokenUsageEvent defaults output=500, cacheRead=200, cacheCreate=100 unless overridden,
    // so Bob inside total = 200+500+200+100 = 1000, Alice = 100+500+200+100 = 900.
    expect(report.tokenRankings).toHaveLength(2);
    expect(report.tokenRankings[0].userName).toBe('Bob');
    expect(report.tokenRankings[0].totalTokens).toBe(1000);
    expect(report.tokenRankings[0].rank).toBe(1);
    expect(report.tokenRankings[1].userName).toBe('Alice');
    expect(report.tokenRankings[1].totalTokens).toBe(900);
    expect(report.tokenRankings[1].rank).toBe(2);
    // Cost rankings: Bob (0.02) > Alice (0.01)
    expect(report.costRankings[0].userName).toBe('Bob');
  });

  it('period field is "day" and date strings are KST day-keys', async () => {
    const nowMs = new Date('2026-04-20T12:00:00+09:00').getTime();
    const store = mockStoreByDay({});
    const aggregator = new ReportAggregator(store);
    const report = await aggregator.aggregateTokenUsageMs(nowMs - 24 * 60 * 60 * 1000, nowMs);

    expect(report.period).toBe('day');
    expect(report.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
