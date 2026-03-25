import { describe, expect, it } from 'vitest';
import { ReportFormatter } from './report-formatter';
import { DailyReport, WeeklyReport, AggregatedMetrics, UserRanking } from './types';

// Contract tests — Scenario 5: ReportFormatter + Publisher
// Trace: docs/daily-weekly-report/trace.md

function makeMetrics(overrides: Partial<AggregatedMetrics> = {}): AggregatedMetrics {
  return {
    sessionsCreated: 5,
    sessionsSlept: 2,
    sessionsClosed: 3,
    issuesCreated: 4,
    prsCreated: 3,
    commitsCreated: 10,
    codeLinesAdded: 500,
    prsMerged: 2,
    mergeLinesAdded: 300,
    turnsUsed: 50,
    ...overrides,
  };
}

function makeDailyReport(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    date: '2026-03-25',
    period: 'daily',
    metrics: makeMetrics(),
    ...overrides,
  };
}

function makeWeeklyReport(overrides: Partial<WeeklyReport> = {}): WeeklyReport {
  return {
    weekStart: '2026-03-23',
    weekEnd: '2026-03-29',
    period: 'weekly',
    metrics: makeMetrics(),
    rankings: [
      { userId: 'U1', userName: 'TopUser', metrics: makeMetrics(), rank: 1 },
      { userId: 'U2', userName: 'SecondUser', metrics: makeMetrics({ turnsUsed: 20 }), rank: 2 },
    ],
    ...overrides,
  };
}

describe('ReportFormatter', () => {
  const formatter = new ReportFormatter();

  // Trace: Scenario 5, Section 3a — daily produces valid Block Kit
  it('daily_producesValidBlockKit', () => {
    const result = formatter.formatDaily(makeDailyReport());

    expect(result.blocks).toBeDefined();
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toContain('2026-03-25');
    // Should have header block
    expect(result.blocks[0].type).toBe('header');
  });

  // Trace: Scenario 5, Section 3b — weekly includes rankings
  it('weekly_includesRankings', () => {
    const result = formatter.formatWeekly(makeWeeklyReport());

    expect(result.blocks).toBeDefined();
    const textContent = JSON.stringify(result.blocks);
    expect(textContent).toContain('TopUser');
    expect(textContent).toContain('SecondUser');
  });

  // Trace: Scenario 5, Section 5 — truncates rankings over 10
  it('weekly_truncatesRankingsOver10', () => {
    const manyRankings: UserRanking[] = Array.from({ length: 15 }, (_, i) => ({
      userId: `U${i}`,
      userName: `User${i}`,
      metrics: makeMetrics(),
      rank: i + 1,
    }));
    const report = makeWeeklyReport({ rankings: manyRankings });

    const result = formatter.formatWeekly(report);

    // Should only include top 10 in blocks
    const textContent = JSON.stringify(result.blocks);
    expect(textContent).toContain('User0');
    expect(textContent).toContain('User9');
    expect(textContent).not.toContain('User10');
  });

  // Trace: Scenario 5, Section 3a — all zeros still renders blocks
  it('daily_allZeros_stillRendersBlocks', () => {
    const zeroMetrics = makeMetrics({
      sessionsCreated: 0, sessionsSlept: 0, sessionsClosed: 0,
      issuesCreated: 0, prsCreated: 0, commitsCreated: 0,
      codeLinesAdded: 0, prsMerged: 0, mergeLinesAdded: 0, turnsUsed: 0,
    });
    const result = formatter.formatDaily(makeDailyReport({ metrics: zeroMetrics }));

    expect(result.blocks.length).toBeGreaterThan(0);
  });
});
