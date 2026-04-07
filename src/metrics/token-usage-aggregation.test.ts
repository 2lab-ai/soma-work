/**
 * Tests for token usage aggregation in ReportAggregator.
 * Verifies: per-model breakdown, per-user breakdown, per-day breakdown.
 */
import { describe, expect, it, vi } from 'vitest';
import { ReportAggregator } from './report-aggregator';
import type { MetricsEvent } from './types';

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
