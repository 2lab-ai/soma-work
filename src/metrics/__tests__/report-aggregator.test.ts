import { beforeEach, describe, expect, it } from 'vitest';
import { ReportAggregator } from '../report-aggregator';
import type { MetricsEvent } from '../types';

/**
 * In-memory MetricsEventStore stub for aggregator tests.
 * Only implements readRange, which is the sole method ReportAggregator uses.
 */
class InMemoryStore {
  public events: MetricsEvent[] = [];

  async readRange(startDate: string, endDate: string): Promise<MetricsEvent[]> {
    // Simple inclusive date-string range filter on ISO timestamp.
    const start = new Date(startDate + 'T00:00:00Z').getTime();
    const end = new Date(endDate + 'T23:59:59.999Z').getTime();
    return this.events
      .filter((e) => e.timestamp >= start && e.timestamp <= end)
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}

// Fixed mid-day UTC timestamp on 2026-04-15. In Asia/Seoul this is 2026-04-15.
const T_20260415 = new Date('2026-04-15T03:00:00Z').getTime();

function tokenEvent(opts: {
  userId: string;
  userName: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreate?: number;
  costUsd?: number;
  model?: string;
  pricingVersion?: string | null;
  costSource?: 'sdk' | 'calculated';
  timestamp?: number;
}): MetricsEvent {
  const metadata: Record<string, unknown> = {
    sessionKey: `sk-${opts.userId}`,
    model: opts.model ?? 'claude-opus-4-6-20250414',
    inputTokens: opts.inputTokens ?? 0,
    outputTokens: opts.outputTokens ?? 0,
    cacheReadInputTokens: opts.cacheRead ?? 0,
    cacheCreationInputTokens: opts.cacheCreate ?? 0,
    costUsd: opts.costUsd ?? 0,
  };
  if (opts.costSource) metadata.costSource = opts.costSource;
  // pricingVersion omitted when explicitly null (simulates legacy event)
  if (opts.pricingVersion !== null) {
    metadata.pricingVersion = opts.pricingVersion ?? '2026-04-16';
  }
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: opts.timestamp ?? T_20260415,
    eventType: 'token_usage',
    userId: opts.userId,
    userName: opts.userName,
    metadata,
  };
}

describe('ReportAggregator.aggregateTokenUsage', () => {
  let store: InMemoryStore;
  let aggregator: ReportAggregator;

  beforeEach(() => {
    store = new InMemoryStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    aggregator = new ReportAggregator(store as any);
  });

  it('end-to-end: aggregates mixed events, excludes non-token events and assistant/unknown users, computes rankings correctly', async () => {
    store.events = [
      // alice: 1M input + 2M output + $5 cost (Opus)
      tokenEvent({
        userId: 'U_ALICE',
        userName: 'alice',
        inputTokens: 1_000_000,
        outputTokens: 2_000_000,
        costUsd: 5,
      }),
      // bob: 500k input + 0 output + $3 cost (Sonnet)
      tokenEvent({
        userId: 'U_BOB',
        userName: 'bob',
        inputTokens: 500_000,
        costUsd: 3,
        model: 'claude-sonnet-4-6-20250414',
      }),
      // carol: 10k cacheCreate + $0.01 cost
      tokenEvent({
        userId: 'U_CAROL',
        userName: 'carol',
        cacheCreate: 10_000,
        costUsd: 0.01,
      }),
      // 'assistant' userId MUST be excluded from byUser and rankings
      tokenEvent({ userId: 'assistant', userName: 'assistant', inputTokens: 999_999_999, costUsd: 999 }),
      // 'unknown' userId MUST be excluded
      tokenEvent({ userId: 'unknown', userName: 'unknown', inputTokens: 88_888_888, costUsd: 88 }),
      // non-token_usage event — must be ignored by aggregateTokenUsage
      {
        id: 'evt-non-token',
        timestamp: T_20260415,
        eventType: 'commit_created',
        userId: 'U_ALICE',
        userName: 'alice',
        metadata: {},
      },
    ];

    const report = await aggregator.aggregateTokenUsage('2026-04-15', '2026-04-15');

    // Totals INCLUDE assistant/unknown tokens at the aggregate level (the exclusion
    // is per-user ranking policy, not total usage accounting).
    // Verify totals sum all token_usage events.
    expect(report.totals.totalInputTokens).toBe(1_000_000 + 500_000 + 999_999_999 + 88_888_888);

    // byUser must exclude assistant/unknown
    expect(Object.keys(report.byUser).sort()).toEqual(['U_ALICE', 'U_BOB', 'U_CAROL']);

    // Rankings: no userId filter → populated, excluding assistant/unknown
    expect(report.tokenRankings).toHaveLength(3);
    expect(report.costRankings).toHaveLength(3);

    // tokenRankings sorted desc: alice (3M) > bob (500k) > carol (10k)
    expect(report.tokenRankings.map((r) => r.userId)).toEqual(['U_ALICE', 'U_BOB', 'U_CAROL']);
    expect(report.tokenRankings.map((r) => r.rank)).toEqual([1, 2, 3]);

    // costRankings sorted desc: alice ($5) > bob ($3) > carol ($0.01)
    expect(report.costRankings.map((r) => r.userId)).toEqual(['U_ALICE', 'U_BOB', 'U_CAROL']);
    expect(report.costRankings.map((r) => r.rank)).toEqual([1, 2, 3]);

    // Period detection
    expect(report.period).toBe('day');

    // No legacy data when all events have pricingVersion
    expect(report.hasLegacyData).toBe(false);
  });

  it('userId filter forces both tokenRankings and costRankings to empty arrays', async () => {
    store.events = [
      tokenEvent({ userId: 'U_ALICE', userName: 'alice', inputTokens: 100, costUsd: 1 }),
      tokenEvent({ userId: 'U_BOB', userName: 'bob', inputTokens: 200, costUsd: 2 }),
    ];

    const report = await aggregator.aggregateTokenUsage('2026-04-15', '2026-04-15', 'U_ALICE');

    // When filtered, rankings MUST be empty — prevents leaking other users' ordering
    expect(report.tokenRankings).toEqual([]);
    expect(report.costRankings).toEqual([]);

    // byUser still scoped to the filtered user
    expect(Object.keys(report.byUser)).toEqual(['U_ALICE']);
    expect(report.totals.totalInputTokens).toBe(100);
  });

  it('rankings tie-break: equal totalTokens ordered alphabetically by userName (ascending)', async () => {
    // Three users with identical token counts → tie-break should be alphabetical
    store.events = [
      tokenEvent({ userId: 'U_CHARLIE', userName: 'charlie', inputTokens: 1000, costUsd: 1 }),
      tokenEvent({ userId: 'U_ALICE', userName: 'alice', inputTokens: 1000, costUsd: 1 }),
      tokenEvent({ userId: 'U_BOB', userName: 'bob', inputTokens: 1000, costUsd: 1 }),
    ];

    const report = await aggregator.aggregateTokenUsage('2026-04-15', '2026-04-15');

    // Alphabetical userName: alice, bob, charlie
    expect(report.tokenRankings.map((r) => r.userName)).toEqual(['alice', 'bob', 'charlie']);
    expect(report.costRankings.map((r) => r.userName)).toEqual(['alice', 'bob', 'charlie']);
  });

  it('hasLegacyData = true when any event lacks pricingVersion metadata', async () => {
    store.events = [
      tokenEvent({ userId: 'U_ALICE', userName: 'alice', inputTokens: 100 }),
      // legacy event: omit pricingVersion
      tokenEvent({ userId: 'U_BOB', userName: 'bob', inputTokens: 200, pricingVersion: null }),
    ];

    const report = await aggregator.aggregateTokenUsage('2026-04-15', '2026-04-15');
    expect(report.hasLegacyData).toBe(true);
  });

  it('hasLegacyData = false when every event has pricingVersion metadata', async () => {
    store.events = [
      tokenEvent({ userId: 'U_ALICE', userName: 'alice', inputTokens: 100, pricingVersion: '2026-04-16' }),
      tokenEvent({ userId: 'U_BOB', userName: 'bob', inputTokens: 200, pricingVersion: '2026-04-16' }),
    ];

    const report = await aggregator.aggregateTokenUsage('2026-04-15', '2026-04-15');
    expect(report.hasLegacyData).toBe(false);
  });

  it('empty event set returns zero totals, empty rankings, and hasLegacyData=false', async () => {
    store.events = [];

    const report = await aggregator.aggregateTokenUsage('2026-04-15', '2026-04-15');

    expect(report.totals.totalInputTokens).toBe(0);
    expect(report.totals.totalCostUsd).toBe(0);
    expect(report.tokenRankings).toEqual([]);
    expect(report.costRankings).toEqual([]);
    expect(report.hasLegacyData).toBe(false);
    expect(Object.keys(report.byUser)).toHaveLength(0);
  });

  it('period detection: day (1 day), week (7 days), month (>7 days)', async () => {
    const day = await aggregator.aggregateTokenUsage('2026-04-15', '2026-04-15');
    expect(day.period).toBe('day');

    const week = await aggregator.aggregateTokenUsage('2026-04-09', '2026-04-15');
    expect(week.period).toBe('week');

    const month = await aggregator.aggregateTokenUsage('2026-03-16', '2026-04-15');
    expect(month.period).toBe('month');
  });
});
