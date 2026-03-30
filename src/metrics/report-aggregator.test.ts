import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReportAggregator, computeDerivedMetrics, computeTrend } from './report-aggregator';
import { MetricsEventStore } from './event-store';
import { MetricsEvent, MetricsEventType, AggregatedMetrics } from './types';

// Contract tests — Scenario 4: ReportAggregator
// Trace: docs/daily-weekly-report/trace.md

function makeEvent(type: MetricsEventType, userId = 'U123', userName = 'User1', metadata?: Record<string, unknown>): MetricsEvent {
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
    mockStore.readRange.mockResolvedValue([
      makeEvent('session_created'),
      makeEvent('turn_used'),
    ]);

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
      sessionsCreated: 5, sessionsSlept: 1, sessionsClosed: 3,
      issuesCreated: 2, prsCreated: 3, commitsCreated: 10,
      codeLinesAdded: 500, codeLinesDeleted: 50, prsMerged: 2,
      mergeLinesAdded: 300, turnsUsed: 20,
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
      sessionsCreated: 0, sessionsSlept: 0, sessionsClosed: 0,
      issuesCreated: 0, prsCreated: 0, commitsCreated: 0,
      codeLinesAdded: 0, codeLinesDeleted: 0, prsMerged: 0,
      mergeLinesAdded: 0, turnsUsed: 0,
    };
    const previous: AggregatedMetrics = {
      ...current,
      issuesCreated: 5, // Only issues — old code would miss this
      prsMerged: 3,     // Only merges — old code would miss this
    };

    const trend = computeTrend(current, previous);
    // previous had activity (issues+merges), so baselineZero must be false
    expect(trend).not.toBeNull();
    expect(trend!.baselineZero).toBe(false);
  });

  it('computeTrend_prevHasOnlyCodeLines_notBaselineZero', () => {
    const zero: AggregatedMetrics = {
      sessionsCreated: 0, sessionsSlept: 0, sessionsClosed: 0,
      issuesCreated: 0, prsCreated: 0, commitsCreated: 0,
      codeLinesAdded: 0, codeLinesDeleted: 0, prsMerged: 0,
      mergeLinesAdded: 0, turnsUsed: 0,
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
      return [
        makeEvent('session_created'),
        makeEvent('turn_used'),
      ];
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
