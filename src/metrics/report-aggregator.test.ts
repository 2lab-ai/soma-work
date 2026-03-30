import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReportAggregator } from './report-aggregator';
import { MetricsEventStore } from './event-store';
import { MetricsEvent, MetricsEventType } from './types';

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
  });
});
