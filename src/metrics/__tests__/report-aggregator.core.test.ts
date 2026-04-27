import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsEventStore } from '../event-store';
import { computeDerivedMetrics, computeTrend, ReportAggregator } from '../report-aggregator';
import type { AggregatedMetrics, MetricsEvent, MetricsEventType } from '../types';

// Contract tests — Scenario 4: ReportAggregator
// Trace: docs/daily-weekly-report/trace.md

function makeEvent(
  type: MetricsEventType,
  userId = 'U123',
  userName = 'User1',
  metadata?: Record<string, unknown>,
): MetricsEvent {
  return {
    id: `evt-${Math.random()}`,
    timestamp: Date.now(),
    eventType: type,
    userId,
    userName,
    metadata,
  };
}

describe('ReportAggregator', () => {
  let aggregator: ReportAggregator;
  let mockStore: { readRange: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockStore = { readRange: vi.fn().mockResolvedValue([]) };
    aggregator = new ReportAggregator(mockStore as any);
  });

  // Trace: Scenario 4, Section 3a — counts all event types
  it('daily_countsAllEventTypes', async () => {
    mockStore.readRange.mockResolvedValue([
      makeEvent('session_created'),
      makeEvent('session_created'),
      makeEvent('session_slept'),
      makeEvent('session_closed'),
      makeEvent('issue_created'),
      makeEvent('pr_created'),
      makeEvent('commit_created'),
      makeEvent('code_lines_added', 'U123', 'User1', { linesAdded: 50, linesDeleted: 10 }),
      makeEvent('pr_merged'),
      makeEvent('merge_lines_added', 'U123', 'User1', { linesAdded: 100, linesDeleted: 20 }),
      makeEvent('turn_used'),
      makeEvent('turn_used'),
      makeEvent('turn_used'),
    ]);

    const report = await aggregator.aggregateDaily('2026-03-25');

    expect(report.period).toBe('daily');
    expect(report.date).toBe('2026-03-25');
    expect(report.metrics.sessionsCreated).toBe(2);
    expect(report.metrics.sessionsSlept).toBe(1);
    expect(report.metrics.sessionsClosed).toBe(1);
    expect(report.metrics.issuesCreated).toBe(1);
    expect(report.metrics.prsCreated).toBe(1);
    expect(report.metrics.commitsCreated).toBe(1);
    expect(report.metrics.codeLinesAdded).toBe(50);
    expect(report.metrics.prsMerged).toBe(1);
    expect(report.metrics.mergeLinesAdded).toBe(100);
    expect(report.metrics.turnsUsed).toBe(3);
  });

  // Trace: Scenario 4, Section 5 — no events returns all zeros
  it('daily_noEvents_allZeros', async () => {
    mockStore.readRange.mockResolvedValue([]);

    const report = await aggregator.aggregateDaily('2026-03-25');

    expect(report.metrics.sessionsCreated).toBe(0);
    expect(report.metrics.turnsUsed).toBe(0);
    expect(report.metrics.prsCreated).toBe(0);
  });

  // Trace: Scenario 4, Section 3b — weekly aggregates 7 days
  it('weekly_aggregatesSevenDays', async () => {
    mockStore.readRange.mockResolvedValue([makeEvent('session_created'), makeEvent('turn_used')]);

    const report = await aggregator.aggregateWeekly('2026-03-23'); // Monday

    expect(report.period).toBe('weekly');
    expect(report.weekStart).toBe('2026-03-23');
    expect(report.weekEnd).toBe('2026-03-29');
    expect(mockStore.readRange).toHaveBeenCalledWith('2026-03-23', '2026-03-29');
  });

  // Trace: Scenario 4, Section 3b-3c — weekly ranks users by weighted score
  it('weekly_ranksUsersByWeightedScore', async () => {
    mockStore.readRange.mockResolvedValue([
      // User1: 2 turns (2pts) + 1 PR created (5pts) = 7pts
      makeEvent('turn_used', 'U1', 'User1'),
      makeEvent('turn_used', 'U1', 'User1'),
      makeEvent('pr_created', 'U1', 'User1'),
      // User2: 1 turn (1pt) + 1 PR merged (10pts) = 11pts
      makeEvent('turn_used', 'U2', 'User2'),
      makeEvent('pr_merged', 'U2', 'User2'),
    ]);

    const report = await aggregator.aggregateWeekly('2026-03-23');

    expect(report.rankings).toHaveLength(2);
    expect(report.rankings[0].userName).toBe('User2'); // Higher score
    expect(report.rankings[0].rank).toBe(1);
    expect(report.rankings[1].userName).toBe('User1');
    expect(report.rankings[1].rank).toBe(2);
  });

  // Trace: Scenario 4, Section 3c — tied scores: alphabetical order
  it('weekly_tiedScores_alphabeticalOrder', async () => {
    mockStore.readRange.mockResolvedValue([
      makeEvent('turn_used', 'U1', 'Bravo'),
      makeEvent('turn_used', 'U2', 'Alpha'),
    ]);

    const report = await aggregator.aggregateWeekly('2026-03-23');

    // Same score (1 turn each = 1pt), so alphabetical
    expect(report.rankings[0].userName).toBe('Alpha');
    expect(report.rankings[1].userName).toBe('Bravo');
  });

  // Trace: Scenario 4, Section 3a — metadata.linesAdded aggregation
  it('codeLinesAdded_sumsMetadata', async () => {
    mockStore.readRange.mockResolvedValue([
      makeEvent('code_lines_added', 'U1', 'User1', { linesAdded: 100, linesDeleted: 10 }),
      makeEvent('code_lines_added', 'U1', 'User1', { linesAdded: 200, linesDeleted: 30 }),
    ]);

    const report = await aggregator.aggregateDaily('2026-03-25');

    expect(report.metrics.codeLinesAdded).toBe(300);
    expect(report.metrics.codeLinesDeleted).toBe(40);
  });

  // === Enriched Aggregation Tests ===

  it('enrichedDaily_includesDerivedMetrics', async () => {
    mockStore.readRange.mockResolvedValue([
      makeEvent('session_created'),
      makeEvent('session_closed'),
      makeEvent('turn_used'),
      makeEvent('turn_used'),
      makeEvent('pr_created'),
      makeEvent('pr_merged'),
      makeEvent('commit_created'),
      makeEvent('code_lines_added', 'U123', 'User1', { linesAdded: 200, linesDeleted: 30 }),
    ]);

    const report = await aggregator.aggregateEnrichedDaily('2026-03-25');

    expect(report.derived).toBeDefined();
    expect(report.derived.productivityScore).toBeGreaterThan(0);
    expect(report.derived.prMergeRate).toBe(100); // 1 merged / 1 created
    expect(report.derived.avgCodePerPr).toBe(200);
    expect(report.derived.sessionCompletionRate).toBe(100); // 1 closed / 1 created
    expect(report.hourlyDistribution).toHaveLength(24);
    expect(report.achievements).toBeDefined();
    expect(report.funFacts).toBeDefined();
  });

  it('enrichedDaily_trendHasBaselineZeroWhenNoPreviousData', async () => {
    mockStore.readRange.mockResolvedValue([]);

    const report = await aggregator.aggregateEnrichedDaily('2026-03-25');

    // With no previous data AND no current data, trend should still indicate baselineZero
    // When both periods are empty, computeTrend returns baselineZero: true
    if (report.trend) {
      expect(report.trend.baselineZero).toBe(true);
    } else {
      // If both current and previous are zero, null is also acceptable
      expect(report.trend).toBeNull();
    }
  });

  it('enrichedWeekly_includesDailyBreakdown', async () => {
    const baseTime = new Date('2026-03-23T10:00:00Z').getTime(); // Monday 19:00 KST
    mockStore.readRange.mockResolvedValue([
      { ...makeEvent('session_created'), timestamp: baseTime },
      { ...makeEvent('turn_used'), timestamp: baseTime + 86400000 }, // +1 day
      { ...makeEvent('commit_created'), timestamp: baseTime + 86400000 * 2 }, // +2 days
    ]);

    const report = await aggregator.aggregateEnrichedWeekly('2026-03-23');

    expect(report.dailyBreakdown).toHaveLength(7);
    expect(report.activeDays).toBeGreaterThan(0);
    expect(report.derived).toBeDefined();
    expect(report.hourlyDistribution).toHaveLength(24);
    expect(report.achievements).toBeDefined();
    expect(report.funFacts).toBeDefined();
  });

  // === Unit tests for computeDerivedMetrics and computeTrend ===

  it('computeDerivedMetrics_zeroActiveDays_noDivisionError', () => {
    const m: AggregatedMetrics = {
      sessionsCreated: 5,
      sessionsSlept: 1,
      sessionsClosed: 3,
      issuesCreated: 2,
      prsCreated: 3,
      commitsCreated: 10,
      codeLinesAdded: 500,
      codeLinesDeleted: 50,
      prsMerged: 2,
      mergeLinesAdded: 300,
      turnsUsed: 20,
    };

    // activeDays = 0 should NOT throw, should use safeActiveDays = 1
    const d = computeDerivedMetrics(m, 0);
    expect(d.commitPerActiveDay).toBe(10); // 10 / max(0,1)=1
    expect(d.prPerActiveDay).toBe(3);
    expect(Number.isFinite(d.productivityScore)).toBe(true);
    expect(Number.isFinite(d.prMergeRate)).toBe(true);
  });

  it('computeTrend_prevHasOnlyIssuesAndMerges_notBaselineZero', () => {
    const current: AggregatedMetrics = {
      sessionsCreated: 0,
      sessionsSlept: 0,
      sessionsClosed: 0,
      issuesCreated: 0,
      prsCreated: 0,
      commitsCreated: 0,
      codeLinesAdded: 0,
      codeLinesDeleted: 0,
      prsMerged: 0,
      mergeLinesAdded: 0,
      turnsUsed: 0,
    };
    const previous: AggregatedMetrics = {
      ...current,
      issuesCreated: 5, // Only issues — old code would miss this
      prsMerged: 3, // Only merges — old code would miss this
    };

    const trend = computeTrend(current, previous);
    // previous had activity (issues+merges), so baselineZero must be false
    expect(trend).not.toBeNull();
    expect(trend!.baselineZero).toBe(false);
  });

  it('computeTrend_prevHasOnlyCodeLines_notBaselineZero', () => {
    const zero: AggregatedMetrics = {
      sessionsCreated: 0,
      sessionsSlept: 0,
      sessionsClosed: 0,
      issuesCreated: 0,
      prsCreated: 0,
      commitsCreated: 0,
      codeLinesAdded: 0,
      codeLinesDeleted: 0,
      prsMerged: 0,
      mergeLinesAdded: 0,
      turnsUsed: 0,
    };
    const previous: AggregatedMetrics = { ...zero, codeLinesAdded: 1000 };

    const trend = computeTrend(zero, previous);
    expect(trend!.baselineZero).toBe(false);
  });

  it('enrichedWeekly_computesTrendVsPreviousWeek', async () => {
    // First call: current week events
    // Second call: previous week events
    let callCount = 0;
    mockStore.readRange.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        // Current week (first two calls: weekly + enriched)
        return [
          makeEvent('session_created'),
          makeEvent('turn_used'),
          makeEvent('pr_created'),
          makeEvent('commit_created'),
        ];
      }
      // Previous week
      return [makeEvent('session_created'), makeEvent('turn_used')];
    });

    const report = await aggregator.aggregateEnrichedWeekly('2026-03-23');

    // Should have a trend since previous week had data
    expect(report.trend).not.toBeNull();
    if (report.trend) {
      expect(typeof report.trend.sessionsCreatedDelta).toBe('number');
      expect(typeof report.trend.productivityScoreDelta).toBe('number');
    }
  });
});

// === Carousel (v2) aggregation tests ===
// Trace: docs/usage-card-dark/trace.md — Scenario 2

describe('aggregateCarousel', () => {
  /** Build a token_usage event in KST. */
  function tokenEvent(opts: {
    timestamp: number;
    userId: string;
    userName?: string;
    tokens?: number;
    cost?: number;
    sessionKey?: string;
    model?: string;
  }): MetricsEvent {
    const tokens = opts.tokens ?? 1000;
    const sessionKey = opts.sessionKey ?? `S_${opts.userId}`;
    return {
      id: `evt-${Math.random()}`,
      timestamp: opts.timestamp,
      eventType: 'token_usage',
      userId: opts.userId,
      userName: opts.userName ?? opts.userId,
      sessionKey,
      metadata: {
        sessionKey,
        model: opts.model ?? 'claude-opus-4-7',
        inputTokens: tokens,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: opts.cost ?? 0.01,
      },
    } as MetricsEvent;
  }

  /** Millisecond helpers relative to now. */
  function hoursAgo(now: Date, h: number): number {
    return now.getTime() - h * 60 * 60 * 1000;
  }
  function daysAgo(now: Date, d: number): number {
    return now.getTime() - d * 24 * 60 * 60 * 1000;
  }

  function makeAgg(events: MetricsEvent[]) {
    const readRange = vi.fn().mockResolvedValue(events);
    const store = { readRange } as any;
    return { aggregator: new ReportAggregator(store), readRange };
  }

  const TARGET = 'U_TARGET';

  it('all 4 empty: target user has 0 events → every tab is {empty:true}', async () => {
    const now = new Date('2026-04-18T12:00:00+09:00');
    const { aggregator } = makeAgg([]);
    const result = await aggregator.aggregateCarousel({ targetUserId: TARGET, now });

    expect(result.targetUserId).toBe(TARGET);
    for (const tabId of ['24h', '7d', '30d', 'all'] as const) {
      expect(result.tabs[tabId]).toMatchObject({ empty: true, tabId });
      expect(typeof (result.tabs[tabId] as any).windowStart).toBe('string');
      expect(typeof (result.tabs[tabId] as any).windowEnd).toBe('string');
    }
  });

  it('single scan: store.readRange called exactly once', async () => {
    const now = new Date('2026-04-18T12:00:00+09:00');
    const { aggregator, readRange } = makeAgg([tokenEvent({ timestamp: hoursAgo(now, 3), userId: TARGET })]);
    await aggregator.aggregateCarousel({ targetUserId: TARGET, now });
    expect(readRange).toHaveBeenCalledTimes(1);
  });

  it('disjoint windows: events are accumulated into all windows they fall inside', async () => {
    const now = new Date('2026-04-18T12:00:00+09:00');
    const events: MetricsEvent[] = [
      tokenEvent({ timestamp: hoursAgo(now, 12), userId: TARGET, tokens: 100, sessionKey: 'S_24h' }),
      tokenEvent({ timestamp: daysAgo(now, 6), userId: TARGET, tokens: 200, sessionKey: 'S_7d' }),
      tokenEvent({ timestamp: daysAgo(now, 15), userId: TARGET, tokens: 400, sessionKey: 'S_15d' }),
      tokenEvent({ timestamp: daysAgo(now, 60), userId: TARGET, tokens: 800, sessionKey: 'S_60d' }),
    ];
    const { aggregator } = makeAgg(events);
    const result = await aggregator.aggregateCarousel({ targetUserId: TARGET, now });

    const t24 = result.tabs['24h'];
    const t7 = result.tabs['7d'];
    const t30 = result.tabs['30d'];
    const tAll = result.tabs['all'];
    if (t24.empty) throw new Error('24h should not be empty');
    if (t7.empty) throw new Error('7d should not be empty');
    if (t30.empty) throw new Error('30d should not be empty');
    if (tAll.empty) throw new Error('all should not be empty');

    expect(t24.totals.tokens).toBe(100);
    // 7d covers day(now-6d..now) — events at now-12h and now-6d both fall inside.
    expect(t7.totals.tokens).toBe(100 + 200);
    expect(t30.totals.tokens).toBe(100 + 200 + 400);
    expect(tAll.totals.tokens).toBe(100 + 200 + 400 + 800);
  });

  it('hourly 24h: events spread across distinct hours in last 24h', async () => {
    const now = new Date('2026-04-18T12:00:00+09:00');
    // Hours 03:00, 06:00, 09:00, 10:30, 11:45 KST on 2026-04-18 — all within last 24h.
    const base = new Date('2026-04-18T03:00:00+09:00').getTime();
    const events: MetricsEvent[] = [
      tokenEvent({ timestamp: base, userId: TARGET, tokens: 111 }),
      tokenEvent({ timestamp: base + 3 * 3_600_000, userId: TARGET, tokens: 222 }),
      tokenEvent({ timestamp: base + 6 * 3_600_000, userId: TARGET, tokens: 333 }),
      tokenEvent({ timestamp: base + 7.5 * 3_600_000, userId: TARGET, tokens: 444 }),
      tokenEvent({ timestamp: base + 8.75 * 3_600_000, userId: TARGET, tokens: 555 }),
    ];
    const { aggregator } = makeAgg(events);
    const result = await aggregator.aggregateCarousel({ targetUserId: TARGET, now });

    const t24 = result.tabs['24h'];
    if (t24.empty) throw new Error('expected non-empty');
    expect(t24.hourly).toHaveLength(24);
    expect(t24.hourly.reduce((s, v) => s + v, 0)).toBe(111 + 222 + 333 + 444 + 555);
    // 5 hours have data, 19 hours are zero.
    const nonZero = t24.hourly.filter((v) => v > 0).length;
    expect(nonZero).toBe(5);
  });

  it('streaks: activeDays/longestStreak/currentStreak piped through', async () => {
    // today = '2026-04-18'
    // activeDays in 7d window: 04-15, 04-16, 04-18 → 3
    // longestStreak: 04-15→04-16 consecutive → 2
    // currentStreak: today is active, yesterday (04-17) NOT → 1
    const now = new Date('2026-04-18T12:00:00+09:00');
    const events: MetricsEvent[] = [
      tokenEvent({ timestamp: new Date('2026-04-15T10:00:00+09:00').getTime(), userId: TARGET }),
      tokenEvent({ timestamp: new Date('2026-04-16T14:00:00+09:00').getTime(), userId: TARGET }),
      tokenEvent({ timestamp: new Date('2026-04-18T09:00:00+09:00').getTime(), userId: TARGET }),
    ];
    const { aggregator } = makeAgg(events);
    const result = await aggregator.aggregateCarousel({ targetUserId: TARGET, now });

    const t7 = result.tabs['7d'];
    if (t7.empty) throw new Error('7d should not be empty');
    expect(t7.activeDays).toBe(3);
    expect(t7.longestStreakDays).toBe(2);
    expect(t7.currentStreakDays).toBe(1);
  });

  it('rankings 30d: target ranked correctly and shared (deep-equal) across all tabs', async () => {
    const now = new Date('2026-04-18T12:00:00+09:00');
    const ts = hoursAgo(now, 5);
    const events: MetricsEvent[] = [
      // Target has 300 tokens
      tokenEvent({ timestamp: ts, userId: TARGET, tokens: 300 }),
      // Two other users ahead of target
      tokenEvent({ timestamp: ts, userId: 'U_A', tokens: 1000 }),
      tokenEvent({ timestamp: ts, userId: 'U_B', tokens: 700 }),
      // Two behind
      tokenEvent({ timestamp: ts, userId: 'U_C', tokens: 100 }),
      tokenEvent({ timestamp: ts, userId: 'U_D', tokens: 50 }),
    ];
    const { aggregator } = makeAgg(events);
    const result = await aggregator.aggregateCarousel({ targetUserId: TARGET, now });

    const t30 = result.tabs['30d'];
    if (t30.empty) throw new Error('30d should not be empty');
    expect(t30.rankings.tokensTop[0].userId).toBe('U_A');
    expect(t30.rankings.tokensTop[1].userId).toBe('U_B');
    expect(t30.rankings.tokensTop[2].userId).toBe(TARGET);
    expect(t30.rankings.tokensTop[2].rank).toBe(3);

    // Shared across all tabs — deep-equal.
    const tabs = ['24h', '7d', '30d', 'all'] as const;
    const refRanking = (result.tabs['30d'] as any).rankings;
    for (const id of tabs) {
      const tab = result.tabs[id];
      if (tab.empty) continue;
      expect(tab.rankings).toEqual(refRanking);
    }
  });

  it('favorite model: winner is the model with the most tokens', async () => {
    const now = new Date('2026-04-18T12:00:00+09:00');
    const ts = hoursAgo(now, 2);
    const events: MetricsEvent[] = [
      tokenEvent({ timestamp: ts, userId: TARGET, tokens: 100, model: 'claude-sonnet-4-6' }),
      tokenEvent({ timestamp: ts + 1000, userId: TARGET, tokens: 500, model: 'claude-opus-4-7' }),
      tokenEvent({ timestamp: ts + 2000, userId: TARGET, tokens: 200, model: 'claude-haiku-3' }),
    ];
    const { aggregator } = makeAgg(events);
    const result = await aggregator.aggregateCarousel({ targetUserId: TARGET, now });
    const t24 = result.tabs['24h'];
    if (t24.empty) throw new Error('24h should not be empty');
    expect(t24.favoriteModel?.model).toBe('claude-opus-4-7');
    expect(t24.favoriteModel?.tokens).toBe(500);
  });

  it('empty 24h but non-empty 7d (old events only)', async () => {
    const now = new Date('2026-04-18T12:00:00+09:00');
    // Event 3 days ago — outside 24h, inside 7d.
    const events: MetricsEvent[] = [tokenEvent({ timestamp: daysAgo(now, 3), userId: TARGET, tokens: 500 })];
    const { aggregator } = makeAgg(events);
    const result = await aggregator.aggregateCarousel({ targetUserId: TARGET, now });

    expect(result.tabs['24h'].empty).toBe(true);
    expect(result.tabs['7d'].empty).toBe(false);
  });

  it('all tab heatmap spans multiple calendar months', async () => {
    const now = new Date('2026-04-18T12:00:00+09:00');
    const events: MetricsEvent[] = [
      tokenEvent({ timestamp: new Date('2026-02-10T10:00:00+09:00').getTime(), userId: TARGET }),
      tokenEvent({ timestamp: new Date('2026-03-15T10:00:00+09:00').getTime(), userId: TARGET }),
      tokenEvent({ timestamp: new Date('2026-04-18T09:00:00+09:00').getTime(), userId: TARGET }),
    ];
    const { aggregator } = makeAgg(events);
    const result = await aggregator.aggregateCarousel({ targetUserId: TARGET, now });
    const tAll = result.tabs['all'];
    if (tAll.empty) throw new Error('all should not be empty');
    // 3 distinct months with data → 3 non-zero heatmap cells minimum.
    const nonZeroCells = tAll.heatmap.filter((c) => c.tokens > 0);
    expect(nonZeroCells.length).toBe(3);
  });

  it('all window start = earliest event KST day', async () => {
    const now = new Date('2026-04-18T12:00:00+09:00');
    const events: MetricsEvent[] = [
      tokenEvent({ timestamp: new Date('2026-01-15T10:00:00+09:00').getTime(), userId: TARGET }),
      tokenEvent({ timestamp: new Date('2026-04-10T10:00:00+09:00').getTime(), userId: TARGET }),
    ];
    const { aggregator } = makeAgg(events);
    const result = await aggregator.aggregateCarousel({ targetUserId: TARGET, now });
    const tAll = result.tabs['all'];
    if (tAll.empty) throw new Error('all should not be empty');
    expect(tAll.windowStart).toBe('2026-01-15');
    expect(tAll.windowEnd).toBe('2026-04-18');
  });
});
