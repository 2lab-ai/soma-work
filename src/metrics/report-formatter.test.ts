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
    codeLinesDeleted: 50,
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
      codeLinesAdded: 0, codeLinesDeleted: 0, prsMerged: 0, mergeLinesAdded: 0, turnsUsed: 0,
    });
    const result = formatter.formatDaily(makeDailyReport({ metrics: zeroMetrics }));

    expect(result.blocks.length).toBeGreaterThan(0);
  });

  // === Enriched Formatter Tests ===

  it('enrichedDaily_producesValidBlockKit', () => {
    const result = formatter.formatEnrichedDaily({
      ...makeDailyReport(),
      derived: {
        productivityScore: 150,
        prMergeRate: 66.7,
        avgCodePerPr: 167,
        avgCodePerCommit: 50,
        avgTurnsPerSession: 10,
        sessionCompletionRate: 60,
      },
      trend: {
        sessionsCreatedDelta: 10,
        turnsUsedDelta: -5,
        prsCreatedDelta: 20,
        commitsCreatedDelta: 15,
        codeLinesAddedDelta: 30,
        prsMergedDelta: 50,
        productivityScoreDelta: 25,
      },
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: h === 14 ? 20 : 2 })),
      peakHour: 14,
      achievements: [{ icon: '🔥', title: '테스트', description: '테스트 업적' }],
      funFacts: [{ icon: '⏰', text: '피크: 오후 2시' }],
    });

    expect(result.blocks).toBeDefined();
    expect(result.blocks.length).toBeGreaterThan(5);
    expect(result.blocks.length).toBeLessThanOrEqual(50); // Block Kit limit
    expect(result.blocks[0].type).toBe('header');
    expect(result.text).toContain('2026-03-25');
    expect(result.text).toContain('150');

    // Should contain day-of-week
    const headerText = result.blocks[0].text.text;
    expect(headerText).toMatch(/\([월화수목금토일]\)/);
  });

  it('enrichedWeekly_producesValidBlockKit', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport(),
      derived: {
        productivityScore: 847,
        prMergeRate: 17.8,
        avgCodePerPr: 437,
        avgCodePerCommit: 285,
        avgTurnsPerSession: 0.2,
        sessionCompletionRate: 20.4,
      },
      trend: {
        sessionsCreatedDelta: 12.4,
        turnsUsedDelta: 8.8,
        prsCreatedDelta: 15,
        commitsCreatedDelta: 20,
        codeLinesAddedDelta: 44.3,
        prsMergedDelta: 30,
        productivityScoreDelta: 23.5,
      },
      dailyBreakdown: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-03-${23 + i}`,
        dayLabel: ['월', '화', '수', '목', '금', '토', '일'][i],
        totalEvents: [142, 178, 98, 125, 203, 33, 11][i],
        metrics: makeMetrics(),
      })),
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: h === 14 ? 48 : 5 })),
      peakHour: 14,
      activeDays: 7,
      achievements: [
        { icon: '🔥', title: '풀 스트릭', description: '7일 연속!' },
        { icon: '💯', title: '커밋 센추리온', description: '112개!' },
      ],
      funFacts: [
        { icon: '⏰', text: '피크: 오후 2시' },
        { icon: '📐', text: '평균 PR: 437줄' },
      ],
    });

    expect(result.blocks).toBeDefined();
    expect(result.blocks.length).toBeGreaterThan(10);
    expect(result.blocks.length).toBeLessThanOrEqual(50); // Block Kit limit
    expect(result.blocks[0].type).toBe('header');
    expect(result.text).toContain('847');

    // Should contain rankings
    const allText = JSON.stringify(result.blocks);
    expect(allText).toContain('TopUser');
    expect(allText).toContain('SecondUser');

    // Should contain achievements
    expect(allText).toContain('풀 스트릭');

    // Should contain fun facts
    expect(allText).toContain('피크');

    // Should contain trend arrows
    expect(allText).toContain('📈');
  });

  it('enrichedWeekly_noTrend_stillWorks', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport(),
      derived: {
        productivityScore: 100,
        prMergeRate: 0,
        avgCodePerPr: 0,
        avgCodePerCommit: 0,
        avgTurnsPerSession: 0,
        sessionCompletionRate: 0,
      },
      trend: null,
      dailyBreakdown: [],
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 0 })),
      peakHour: null,
      activeDays: 0,
      achievements: [],
      funFacts: [],
    });

    expect(result.blocks).toBeDefined();
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.length).toBeLessThanOrEqual(50);
  });
});
