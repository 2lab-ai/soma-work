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

    // Should only include top 5 in blocks (Bauhaus: compact ranking)
    const textContent = JSON.stringify(result.blocks);
    expect(textContent).toContain('User0');
    expect(textContent).toContain('User4');
    expect(textContent).not.toContain('User5');
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
        netLines: 450,
        churnRatio: 10,
        avgChangedLinesPerPr: 183,
        commitPerActiveDay: 10,
        prPerActiveDay: 3,
      },
      trend: {
        sessionsCreatedDelta: 10,
        turnsUsedDelta: -5,
        prsCreatedDelta: 20,
        commitsCreatedDelta: 15,
        codeLinesAddedDelta: 30,
        prsMergedDelta: 50,
        productivityScoreDelta: 25,
        baselineZero: false,
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
    const firstBlock = result.blocks[0];
    const headerText = (firstBlock && 'text' in firstBlock && firstBlock.text) ? firstBlock.text.text : '';
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
        netLines: 3500,
        churnRatio: 5,
        avgChangedLinesPerPr: 460,
        commitPerActiveDay: 16,
        prPerActiveDay: 2.6,
      },
      trend: {
        sessionsCreatedDelta: 12.4,
        turnsUsedDelta: 8.8,
        prsCreatedDelta: 15,
        commitsCreatedDelta: 20,
        codeLinesAddedDelta: 44.3,
        prsMergedDelta: 30,
        productivityScoreDelta: 23.5,
        baselineZero: false,
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
    expect(result.blocks.length).toBeGreaterThanOrEqual(8); // v5: min ~8 blocks
    expect(result.blocks.length).toBeLessThanOrEqual(50); // Block Kit limit
    expect(result.blocks[0].type).toBe('header');
    expect(result.text).toContain('847');

    // Should contain rankings
    const allText = JSON.stringify(result.blocks);
    expect(allText).toContain('TopUser');
    expect(allText).toContain('SecondUser');

    // v5: achievements/funFacts suppressed (Bauhaus: no decorative content)
    // Instead verify grade in header and narrative section exist
    expect(allText).toContain('· 주간 리포트');

    // Should contain trend indicators (Bauhaus: ↑/↓ arrows)
    expect(allText).toContain('↑');
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
        netLines: 0,
        churnRatio: 0,
        avgChangedLinesPerPr: 0,
        commitPerActiveDay: 0,
        prPerActiveDay: 0,
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

  // === Gating Rule Tests ===

  it('enrichedWeekly_baselineZero_showsFirstRecord', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport(),
      derived: {
        productivityScore: 50, prMergeRate: 0, avgCodePerPr: 0, avgCodePerCommit: 0,
        avgTurnsPerSession: 0, sessionCompletionRate: 0,
        netLines: 0, churnRatio: 0, avgChangedLinesPerPr: 0, commitPerActiveDay: 0, prPerActiveDay: 0,
      },
      trend: {
        sessionsCreatedDelta: 100, turnsUsedDelta: 100, prsCreatedDelta: 100,
        commitsCreatedDelta: 100, codeLinesAddedDelta: 100, prsMergedDelta: 100,
        productivityScoreDelta: 100, baselineZero: true,
      },
      dailyBreakdown: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-03-${23 + i}`, dayLabel: ['월', '화', '수', '목', '금', '토', '일'][i],
        totalEvents: 10, metrics: makeMetrics(),
      })),
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 1 })),
      peakHour: 14, activeDays: 7, achievements: [], funFacts: [],
    });

    const allText = JSON.stringify(result.blocks);
    expect(allText).toContain('첫 기록');
    // Should NOT contain trend arrows when baselineZero
    expect(allText).not.toContain('📈');
    expect(allText).not.toContain('📉');
  });

  it('enrichedWeekly_singleUser_skipsRankings', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport({
        rankings: [{ userId: 'U1', userName: 'SoloUser', metrics: makeMetrics(), rank: 1 }],
      }),
      derived: {
        productivityScore: 100, prMergeRate: 0, avgCodePerPr: 0, avgCodePerCommit: 0,
        avgTurnsPerSession: 0, sessionCompletionRate: 0,
        netLines: 0, churnRatio: 0, avgChangedLinesPerPr: 0, commitPerActiveDay: 0, prPerActiveDay: 0,
      },
      trend: null, dailyBreakdown: [], hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 0 })),
      peakHour: null, activeDays: 0, achievements: [], funFacts: [],
    });

    const allText = JSON.stringify(result.blocks);
    expect(allText).not.toContain('랭킹');
    expect(allText).not.toContain('SoloUser');
  });

  it('enrichedWeekly_allZeroHeatmap_skipsHeatmap', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport(),
      derived: {
        productivityScore: 100, prMergeRate: 0, avgCodePerPr: 0, avgCodePerCommit: 0,
        avgTurnsPerSession: 0, sessionCompletionRate: 0,
        netLines: 0, churnRatio: 0, avgChangedLinesPerPr: 0, commitPerActiveDay: 0, prPerActiveDay: 0,
      },
      trend: null,
      dailyBreakdown: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-03-${23 + i}`, dayLabel: ['월', '화', '수', '목', '금', '토', '일'][i],
        totalEvents: 0, metrics: makeMetrics({ sessionsCreated: 0, turnsUsed: 0, prsCreated: 0, commitsCreated: 0, codeLinesAdded: 0, codeLinesDeleted: 0, prsMerged: 0, mergeLinesAdded: 0, issuesCreated: 0, sessionsSlept: 0, sessionsClosed: 0 }),
      })),
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 0 })),
      peakHour: null, activeDays: 0, achievements: [], funFacts: [],
    });

    const allText = JSON.stringify(result.blocks);
    expect(allText).not.toContain('일별 활동');
  });

  it('enrichedWeekly_emptyAchievementsAndFacts_skipsSection', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport(),
      derived: {
        productivityScore: 100, prMergeRate: 0, avgCodePerPr: 0, avgCodePerCommit: 0,
        avgTurnsPerSession: 0, sessionCompletionRate: 0,
        netLines: 0, churnRatio: 0, avgChangedLinesPerPr: 0, commitPerActiveDay: 0, prPerActiveDay: 0,
      },
      trend: null, dailyBreakdown: [],
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 0 })),
      peakHour: null, activeDays: 0, achievements: [], funFacts: [],
    });

    const allText = JSON.stringify(result.blocks);
    expect(allText).not.toContain('업적');
    expect(allText).not.toContain('Fun Facts');
  });

  it('enrichedWeekly_blockCountNeverExceeds50', () => {
    // Stress test: 10 users, all sections active
    const manyRankings: UserRanking[] = Array.from({ length: 10 }, (_, i) => ({
      userId: `U${i}`, userName: `User${i}`, metrics: makeMetrics(), rank: i + 1,
    }));
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport({ rankings: manyRankings }),
      derived: {
        productivityScore: 999, prMergeRate: 80, avgCodePerPr: 500, avgCodePerCommit: 100,
        avgTurnsPerSession: 8, sessionCompletionRate: 90,
        netLines: 4500, churnRatio: 15, avgChangedLinesPerPr: 600, commitPerActiveDay: 12, prPerActiveDay: 3,
      },
      trend: {
        sessionsCreatedDelta: 20, turnsUsedDelta: 15, prsCreatedDelta: 30,
        commitsCreatedDelta: 25, codeLinesAddedDelta: 40, prsMergedDelta: 50,
        productivityScoreDelta: 35, baselineZero: false,
      },
      dailyBreakdown: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-03-${23 + i}`, dayLabel: ['월', '화', '수', '목', '금', '토', '일'][i],
        totalEvents: 100 + i * 20, metrics: makeMetrics(),
      })),
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 10 + h })),
      peakHour: 14, activeDays: 7,
      achievements: [
        { icon: '🔥', title: 'A1', description: 'd1' },
        { icon: '⚡', title: 'A2', description: 'd2' },
        { icon: '🎯', title: 'A3', description: 'd3' },
      ],
      funFacts: [
        { icon: '⏰', text: 'f1' },
        { icon: '📐', text: 'f2' },
        { icon: '📝', text: 'f3' },
      ],
    });

    expect(result.blocks.length).toBeLessThanOrEqual(50);
    // Bauhaus: compact layout — expect 10-20 blocks with 10 users (top 5 shown in one block)
    expect(result.blocks.length).toBeGreaterThan(8);
  });

  it('enrichedWeekly_longUserName_truncated', () => {
    const longName = 'A'.repeat(300);
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport({
        rankings: [
          { userId: 'U1', userName: longName, metrics: makeMetrics(), rank: 1 },
          { userId: 'U2', userName: 'Short', metrics: makeMetrics(), rank: 2 },
        ],
      }),
      derived: {
        productivityScore: 100, prMergeRate: 0, avgCodePerPr: 0, avgCodePerCommit: 0,
        avgTurnsPerSession: 0, sessionCompletionRate: 0,
        netLines: 0, churnRatio: 0, avgChangedLinesPerPr: 0, commitPerActiveDay: 0, prPerActiveDay: 0,
      },
      trend: null, dailyBreakdown: [],
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 0 })),
      peakHour: null, activeDays: 0, achievements: [], funFacts: [],
    });

    // All text blocks should be within 3000 char limit
    for (const block of result.blocks) {
      if ('text' in block && block.text) {
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
      }
      if (block.type === 'header') {
        expect(block.text.text.length).toBeLessThanOrEqual(150);
      }
    }
  });

  it('enrichedDaily_fallbackText_includesTrend', () => {
    const result = formatter.formatEnrichedDaily({
      ...makeDailyReport(),
      derived: {
        productivityScore: 150, prMergeRate: 66.7, avgCodePerPr: 167, avgCodePerCommit: 50,
        avgTurnsPerSession: 10, sessionCompletionRate: 60,
        netLines: 450, churnRatio: 10, avgChangedLinesPerPr: 183, commitPerActiveDay: 10, prPerActiveDay: 3,
      },
      trend: {
        sessionsCreatedDelta: 10, turnsUsedDelta: -5, prsCreatedDelta: 20,
        commitsCreatedDelta: 15, codeLinesAddedDelta: 30, prsMergedDelta: 50,
        productivityScoreDelta: 25, baselineZero: false,
      },
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: h === 14 ? 20 : 2 })),
      peakHour: 14,
      achievements: [{ icon: '🔥', title: '테스트', description: '테스트 업적' }],
      funFacts: [{ icon: '⏰', text: '피크: 오후 2시' }],
    });

    // Fallback text should include trend info
    expect(result.text).toContain('+25%');
    expect(result.text).toContain('150');
  });

  // === v5 Bauhaus-specific tests ===

  it('v5_weekly_blockCount_never_exceeds_12', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport(),
      derived: {
        productivityScore: 50, prMergeRate: 10, avgCodePerPr: 500, avgCodePerCommit: 100,
        avgTurnsPerSession: 2, sessionCompletionRate: 20,
        netLines: 1000, churnRatio: 40, avgChangedLinesPerPr: 600, commitPerActiveDay: 5, prPerActiveDay: 2,
      },
      trend: {
        sessionsCreatedDelta: 10, turnsUsedDelta: 5, prsCreatedDelta: 20,
        commitsCreatedDelta: 15, codeLinesAddedDelta: 30, prsMergedDelta: 10,
        productivityScoreDelta: -25, baselineZero: false,
      },
      dailyBreakdown: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-03-${23 + i}`, dayLabel: ['월', '화', '수', '목', '금', '토', '일'][i],
        totalEvents: 50 + i * 10, metrics: makeMetrics(),
      })),
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 10 })),
      peakHour: 14, activeDays: 2, achievements: [], funFacts: [],
    });
    expect(result.blocks.length).toBeLessThanOrEqual(12);
    expect(result.blocks[0].type).toBe('header');
    expect(result.blocks[result.blocks.length - 1].type).toBe('context'); // footer preserved
  });

  it('v5_daily_blockCount_never_exceeds_10', () => {
    const result = formatter.formatEnrichedDaily({
      date: '2026-03-30', period: 'daily',
      metrics: makeMetrics(),
      derived: {
        productivityScore: 50, prMergeRate: 10, avgCodePerPr: 500, avgCodePerCommit: 100,
        avgTurnsPerSession: 2, sessionCompletionRate: 20,
        netLines: 1000, churnRatio: 40, avgChangedLinesPerPr: 600, commitPerActiveDay: 5, prPerActiveDay: 2,
      },
      trend: {
        sessionsCreatedDelta: 10, turnsUsedDelta: 5, prsCreatedDelta: 20,
        commitsCreatedDelta: 15, codeLinesAddedDelta: 30, prsMergedDelta: 10,
        productivityScoreDelta: 5, baselineZero: false,
      },
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 10 })),
      peakHour: 14,
      achievements: [], funFacts: [],
    });
    expect(result.blocks.length).toBeLessThanOrEqual(10);
    expect(result.blocks[0].type).toBe('header');
    expect(result.blocks[result.blocks.length - 1].type).toBe('context'); // footer preserved
  });

  it('v5_zeroActivity_narrative', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport(),
      metrics: makeMetrics({
        sessionsCreated: 0, sessionsClosed: 0, sessionsSlept: 0,
        prsCreated: 0, prsMerged: 0, commitsCreated: 0,
        codeLinesAdded: 0, codeLinesDeleted: 0, mergeLinesAdded: 0,
        issuesCreated: 0, turnsUsed: 0,
      }),
      derived: {
        productivityScore: 0, prMergeRate: 0, avgCodePerPr: 0, avgCodePerCommit: 0,
        avgTurnsPerSession: 0, sessionCompletionRate: 0,
        netLines: 0, churnRatio: 0, avgChangedLinesPerPr: 0, commitPerActiveDay: 0, prPerActiveDay: 0,
      },
      trend: null,
      dailyBreakdown: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-03-${23 + i}`, dayLabel: ['월', '화', '수', '목', '금', '토', '일'][i],
        totalEvents: 0, metrics: makeMetrics({ sessionsCreated: 0, turnsUsed: 0, prsCreated: 0, commitsCreated: 0, codeLinesAdded: 0, codeLinesDeleted: 0, prsMerged: 0, mergeLinesAdded: 0, issuesCreated: 0, sessionsSlept: 0, sessionsClosed: 0 }),
      })),
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 0 })),
      peakHour: null, activeDays: 0, achievements: [], funFacts: [],
    });
    const allText = JSON.stringify(result.blocks);
    expect(allText).toContain('기간 내 활동 없음');
  });

  it('v5_actionAlert_P1_shows_recovery_target', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport(),
      derived: {
        productivityScore: 30, prMergeRate: 15, avgCodePerPr: 500, avgCodePerCommit: 100,
        avgTurnsPerSession: 2, sessionCompletionRate: 20,
        netLines: 1000, churnRatio: 10, avgChangedLinesPerPr: 600, commitPerActiveDay: 5, prPerActiveDay: 2,
      },
      trend: null,
      dailyBreakdown: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-03-${23 + i}`, dayLabel: ['월', '화', '수', '목', '금', '토', '일'][i],
        totalEvents: 50, metrics: makeMetrics(),
      })),
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 10 })),
      peakHour: 14, activeDays: 5, achievements: [], funFacts: [],
    });
    const allText = JSON.stringify(result.blocks);
    expect(allText).toContain('P1');
    expect(allText).toContain('1차목표 50%+');
    expect(allText).toContain('기준 60%');
  });

  it('v5_rankings_show_all_formula_components', () => {
    const result = formatter.formatEnrichedWeekly({
      ...makeWeeklyReport(),
      derived: {
        productivityScore: 100, prMergeRate: 50, avgCodePerPr: 100, avgCodePerCommit: 50,
        avgTurnsPerSession: 5, sessionCompletionRate: 80,
        netLines: 3000, churnRatio: 10, avgChangedLinesPerPr: 200, commitPerActiveDay: 5, prPerActiveDay: 2,
      },
      trend: null,
      dailyBreakdown: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-03-${23 + i}`, dayLabel: ['월', '화', '수', '목', '금', '토', '일'][i],
        totalEvents: 50, metrics: makeMetrics(),
      })),
      hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, eventCount: 10 })),
      peakHour: 14, activeDays: 5, achievements: [], funFacts: [],
    });
    const allText = JSON.stringify(result.blocks);
    // Scoring formula visible
    expect(allText).toContain('턴+세션+이슈×2+커밋×3+PR×5+머지×10');
    // All formula components in top 1 detail
    expect(allText).toContain('턴');
    expect(allText).toContain('세션');
    expect(allText).toContain('이슈');
    expect(allText).toContain('커밋');
    expect(allText).toContain('PR');
  });
});
