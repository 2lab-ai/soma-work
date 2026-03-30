/**
 * ReportFormatter — Formats aggregated reports into Slack Block Kit messages.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 5
 *
 * Supports both basic (DailyReport/WeeklyReport) and enriched formats.
 * Enriched format includes trends, heatmaps, achievements, fun facts.
 */

import {
  AggregatedMetrics,
  DailyReport,
  WeeklyReport,
  EnrichedDailyReport,
  EnrichedWeeklyReport,
  TrendComparison,
  DailyBreakdown,
  HourlyDistribution,
  Achievement,
  FunFact,
  DerivedMetrics,
  UserRanking,
} from './types';

const MAX_RANKINGS_IN_BLOCKS = 10;

interface FormattedReport {
  blocks: any[];
  text: string;  // Fallback plain text
}

// === Visual Helpers ===

function progressBar(value: number, max: number, width = 8): string {
  if (max <= 0) return '░'.repeat(width);
  const filled = Math.round((value / max) * width);
  return '▓'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(width - filled, 0));
}

function trendArrow(delta: number | undefined): string {
  if (delta === undefined || delta === null) return '';
  if (delta > 5) return '📈';
  if (delta < -5) return '📉';
  return '➡️';
}

function trendText(delta: number | undefined): string {
  if (delta === undefined || delta === null) return '';
  if (delta > 0) return `+${delta}%`;
  if (delta < 0) return `${delta}%`;
  return '0%';
}

function trendInline(delta: number | undefined): string {
  if (delta === undefined || delta === null) return '';
  return ` ${trendArrow(delta)}\`${trendText(delta)}\``;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function rankMedal(rank: number): string {
  switch (rank) {
    case 1: return ':first_place_medal:';
    case 2: return ':second_place_medal:';
    case 3: return ':third_place_medal:';
    default: return `#${rank}`;
  }
}

function hourLabel(hour: number): string {
  const ampm = hour < 12 ? '오전' : '오후';
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${ampm} ${h}시`;
}

function codeChangeText(added: number, deleted: number): string {
  const net = added - deleted;
  const netSign = net >= 0 ? '+' : '';
  if (deleted > 0) {
    return `\`+${fmt(added)}\` / \`-${fmt(deleted)}\` (순 \`${netSign}${fmt(net)}\`)`;
  }
  return `\`+${fmt(added)}\`줄`;
}

/** Generate a one-line weekly summary based on data. */
function generateWeeklySummary(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  breakdown: DailyBreakdown[],
): string {
  const peakDay = breakdown.reduce((best, curr) =>
    curr.totalEvents > best.totalEvents ? curr : best, breakdown[0]);

  const highlights: string[] = [];

  if (peakDay && peakDay.totalEvents > 0) {
    highlights.push(`${peakDay.dayLabel}요일이 가장 활발 (${peakDay.totalEvents}건)`);
  }

  if (m.commitsCreated >= 100) {
    highlights.push(`커밋 ${m.commitsCreated}개 돌파`);
  } else if (m.commitsCreated > 0) {
    highlights.push(`${m.commitsCreated}개 커밋`);
  }

  if (m.codeLinesAdded >= 10000) {
    highlights.push(`+${fmt(m.codeLinesAdded)}줄 작성`);
  }

  return highlights.length > 0
    ? `"${highlights.join(', ')}"`
    : '"한 주간의 활동을 돌아봅니다"';
}

/** Generate one-line daily summary. */
function generateDailySummary(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  dayLabel: string,
): string {
  const highlights: string[] = [];

  if (m.commitsCreated >= 20) highlights.push(`커밋 ${m.commitsCreated}개로 집중력 폭발`);
  else if (m.commitsCreated > 0) highlights.push(`${m.commitsCreated}개 커밋 완료`);

  if (m.prsCreated >= 10) highlights.push(`PR ${m.prsCreated}개 생성`);
  if (m.codeLinesAdded >= 5000) highlights.push(`+${fmt(m.codeLinesAdded)}줄 작성`);

  return highlights.length > 0
    ? `"${highlights.join(' · ')}"`
    : '"오늘의 활동을 정리합니다"';
}

/** Get Korean day-of-week label for a date string. */
function getDayLabel(dateStr: string): string {
  const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
  const d = new Date(dateStr + 'T00:00:00Z');
  return DAY_LABELS[d.getUTCDay()];
}

// === Basic Formatters (backward compatible) ===

function metricsToSections(m: AggregatedMetrics): any[] {
  return [
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*:computer: 세션*\n생성 \`${m.sessionsCreated}\` · 슬립 \`${m.sessionsSlept}\` · 닫기 \`${m.sessionsClosed}\`` },
        { type: 'mrkdwn', text: `*:speech_balloon: 대화*\n턴 \`${m.turnsUsed}\`` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*:octocat: GitHub*\n이슈 \`${m.issuesCreated}\` · PR \`${m.prsCreated}\` · 커밋 \`${m.commitsCreated}\` · 코드 \`+${m.codeLinesAdded}\`` },
        { type: 'mrkdwn', text: `*:white_check_mark: 머지*\nPR \`${m.prsMerged}\` · 코드 \`+${m.mergeLinesAdded}\`` },
      ],
    },
  ];
}

function metricsToPlainText(m: AggregatedMetrics): string {
  return [
    `세션: 생성 ${m.sessionsCreated} / 슬립 ${m.sessionsSlept} / 닫기 ${m.sessionsClosed}`,
    `GitHub: 이슈 ${m.issuesCreated} / PR ${m.prsCreated} / 커밋 ${m.commitsCreated} / 코드 +${m.codeLinesAdded}`,
    `머지: PR ${m.prsMerged} / 코드 +${m.mergeLinesAdded}`,
    `대화: 턴 ${m.turnsUsed}`,
  ].join('\n');
}

// === Enriched Block Builders ===

function buildExecutiveSummary(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  trend: TrendComparison | null,
): any {
  const scoreTrend = trend ? trendInline(trend.productivityScoreDelta) : '';
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*📊 생산성 스코어  \`${fmt(d.productivityScore)}\`점*${scoreTrend}\n\n` +
        `:computer: 세션 \`${fmt(m.sessionsCreated)}\` · :speech_balloon: 턴 \`${fmt(m.turnsUsed)}\` · ` +
        `:octocat: PR \`${fmt(m.prsCreated)}\` · 커밋 \`${fmt(m.commitsCreated)}\` · ` +
        `코드 ${codeChangeText(m.codeLinesAdded, m.codeLinesDeleted)}`,
    },
  };
}

function buildMetricsWithTrends(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  trend: TrendComparison | null,
  prevMetricsText?: { sessions?: number; turns?: number; code?: number },
): any[] {
  const t = trend;
  const prev = prevMetricsText;

  return [
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*:computer: 세션*\n` +
            `\`${fmt(m.sessionsCreated)}\` 생성 · \`${m.sessionsClosed}\` 닫기 · \`${m.sessionsSlept}\` 슬립\n` +
            `완료율 \`${d.sessionCompletionRate}%\`` +
            (t ? `\n전기간 ${trendArrow(t.sessionsCreatedDelta)}\`${trendText(t.sessionsCreatedDelta)}\`` : ''),
        },
        {
          type: 'mrkdwn',
          text: `*:speech_balloon: AI 대화*\n` +
            `\`${fmt(m.turnsUsed)}\` 턴 · 세션당 \`${d.avgTurnsPerSession}\`턴` +
            (t ? `\n전기간 ${trendArrow(t.turnsUsedDelta)}\`${trendText(t.turnsUsedDelta)}\`` : ''),
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*:octocat: GitHub 활동*\n` +
            `이슈 \`${m.issuesCreated}\` · PR \`${fmt(m.prsCreated)}\` · 커밋 \`${fmt(m.commitsCreated)}\`\n` +
            `코드 ${codeChangeText(m.codeLinesAdded, m.codeLinesDeleted)}` +
            (t ? ` ${trendArrow(t.codeLinesAddedDelta)}\`${trendText(t.codeLinesAddedDelta)}\`` : ''),
        },
        {
          type: 'mrkdwn',
          text: `*:white_check_mark: PR 파이프라인*\n` +
            `생성 \`${m.prsCreated}\` ──→ 머지 \`${m.prsMerged}\`\n` +
            `머지율 \`${d.prMergeRate}%\` · 평균 \`${fmt(d.avgCodePerPr)}\`줄/PR\n` +
            `\`${progressBar(m.prsMerged, m.prsCreated, 20)}\``,
        },
      ],
    },
  ];
}

function buildDailyHeatmap(breakdown: DailyBreakdown[]): any {
  if (breakdown.length === 0) return null;

  const maxEvents = Math.max(...breakdown.map(d => d.totalEvents), 1);
  const peakDay = breakdown.reduce((best, curr) =>
    curr.totalEvents > best.totalEvents ? curr : best);

  const lines = breakdown.map(d => {
    const bar = progressBar(d.totalEvents, maxEvents, 10);
    const count = String(d.totalEvents).padStart(4);
    const commits = d.metrics.commitsCreated > 0 ? ` 💻\`${d.metrics.commitsCreated}\`` : '';
    const prs = d.metrics.prsCreated > 0 ? ` :twisted_rightwards_arrows:\`${d.metrics.prsCreated}\`` : '';
    const peak = d === peakDay && d.totalEvents > 0 ? ' :fire:' : '';
    return `${d.dayLabel} \`${bar}\` \`${count}\`${commits}${prs}${peak}`;
  });

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*:calendar: 일별 활동*\n${lines.join('\n')}`,
    },
  };
}

function buildTimeDistribution(dist: HourlyDistribution[], peakHour: number | null): any {
  const blocks = [
    { label: '새벽', hours: [0,1,2,3,4,5] },
    { label: '오전', hours: [6,7,8,9,10,11] },
    { label: '오후', hours: [12,13,14,15,16,17] },
    { label: '저녁', hours: [18,19,20,21,22,23] },
  ];

  const blockCounts = blocks.map(b => ({
    label: b.label,
    count: b.hours.reduce((sum, h) => sum + (dist[h]?.eventCount || 0), 0),
  }));

  const maxBlock = Math.max(...blockCounts.map(b => b.count), 1);
  const lines = blockCounts.map(b => {
    const bar = progressBar(b.count, maxBlock, 8);
    const peak = b.count === maxBlock && b.count > 0 ? ' :zap:' : '';
    return `${b.label} \`${bar}\` ${String(b.count).padStart(4)}${peak}`;
  });

  const peakText = peakHour !== null ? `\n:zap: 피크: *${hourLabel(peakHour)}*` : '';

  return {
    type: 'mrkdwn',
    text: `*:clock3: 시간대 분포*\n${lines.join('\n')}${peakText}`,
  };
}

function buildEfficiencyMetrics(d: DerivedMetrics, peakHour: number | null): any {
  const peakText = peakHour !== null ? `\n:zap: 피크: *${hourLabel(peakHour)}*` : '';
  return {
    type: 'mrkdwn',
    text: `*:mag: 효율 지표*\n` +
      `세션 완료율 \`${d.sessionCompletionRate}%\`\n` +
      `PR 머지율 \`${d.prMergeRate}%\`\n` +
      `생산성 점수 \`${fmt(d.productivityScore)}\`` +
      peakText,
  };
}

function buildRankings(rankings: UserRanking[]): any[] {
  const blocks: any[] = [];
  const displayRankings = rankings.slice(0, MAX_RANKINGS_IN_BLOCKS);

  if (displayRankings.length === 0) return blocks;

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '🏅 사용자 랭킹', emoji: true },
  });

  for (const r of displayRankings) {
    const medal = rankMedal(r.rank);
    const userScore = r.metrics.turnsUsed * 1 + r.metrics.sessionsCreated * 1 +
      r.metrics.issuesCreated * 2 + r.metrics.commitsCreated * 3 +
      r.metrics.prsCreated * 5 + r.metrics.prsMerged * 10;

    const userBar = progressBar(userScore, displayRankings[0] ?
      (displayRankings[0].metrics.turnsUsed * 1 + displayRankings[0].metrics.sessionsCreated * 1 +
        displayRankings[0].metrics.issuesCreated * 2 + displayRankings[0].metrics.commitsCreated * 3 +
        displayRankings[0].metrics.prsCreated * 5 + displayRankings[0].metrics.prsMerged * 10) : 1, 20);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${medal} *${r.userName}*  \`${fmt(userScore)}점\`\n` +
          `\`${userBar}\` ` +
          `턴 \`${r.metrics.turnsUsed}\` · PR \`${r.metrics.prsCreated}\` · 머지 \`${r.metrics.prsMerged}\` · ` +
          `커밋 \`${r.metrics.commitsCreated}\` · \`+${fmt(r.metrics.codeLinesAdded)}\`줄`,
      },
    });
  }

  return blocks;
}

function buildAchievementsAndFunFacts(achievements: Achievement[], funFacts: FunFact[]): any | null {
  const parts: string[] = [];

  if (achievements.length > 0) {
    parts.push('*:dart: 업적 & 하이라이트*');
    for (const a of achievements) {
      parts.push(`${a.icon} *${a.title}* — ${a.description}`);
    }
  }

  if (funFacts.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('*:game_die: Fun Facts*');
    for (const f of funFacts) {
      parts.push(`${f.icon} ${f.text}`);
    }
  }

  if (parts.length === 0) return null;

  return {
    type: 'section',
    text: { type: 'mrkdwn', text: parts.join('\n') },
  };
}

// === Main Formatter Class ===

export class ReportFormatter {
  /**
   * Format a basic daily report (backward compatible).
   */
  formatDaily(report: DailyReport): FormattedReport {
    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:bar_chart: 일간 리포트 — ${report.date}`, emoji: true },
      },
      ...metricsToSections(report.metrics),
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `생성: ${new Date().toISOString().slice(0, 19)}Z` },
        ],
      },
    ];
    const text = `일간 리포트 — ${report.date}\n${metricsToPlainText(report.metrics)}`;
    return { blocks, text };
  }

  /**
   * Format a basic weekly report (backward compatible).
   */
  formatWeekly(report: WeeklyReport): FormattedReport {
    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:trophy: 주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}`, emoji: true },
      },
      ...metricsToSections(report.metrics),
    ];

    const displayRankings = report.rankings.slice(0, MAX_RANKINGS_IN_BLOCKS);
    if (displayRankings.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: ':medal: 사용자 랭킹', emoji: true },
      });
      for (const r of displayRankings) {
        const medal = rankMedal(r.rank);
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${medal} *${r.userName}*\n` +
              `턴 \`${r.metrics.turnsUsed}\` · PR \`${r.metrics.prsCreated}\` · 머지 \`${r.metrics.prsMerged}\` · 커밋 \`${r.metrics.commitsCreated}\` · 코드 \`+${r.metrics.codeLinesAdded}\``,
          },
        });
      }
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `생성: ${new Date().toISOString().slice(0, 19)}Z` }],
    });

    const text = `주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}\n${metricsToPlainText(report.metrics)}`;
    return { blocks, text };
  }

  /**
   * Enriched daily report — trends, hourly chart, achievements, fun facts.
   */
  formatEnrichedDaily(report: EnrichedDailyReport): FormattedReport {
    const { metrics: m, derived: d, trend, hourlyDistribution, peakHour, achievements, funFacts } = report;
    const dayLabel = getDayLabel(report.date);

    const blocks: any[] = [
      // Header with day-of-week
      {
        type: 'header',
        text: { type: 'plain_text', text: `📊 일간 리포트 — ${report.date} (${dayLabel})`, emoji: true },
      },
      // One-line summary
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `💡 _${generateDailySummary(m, d, dayLabel)}_` }],
      },
      // Executive summary
      buildExecutiveSummary(m, d, trend),
      { type: 'divider' },
      // Metrics with trends
      ...buildMetricsWithTrends(m, d, trend),
      { type: 'divider' },
      // Time distribution + Efficiency (side by side)
      {
        type: 'section',
        fields: [
          buildTimeDistribution(hourlyDistribution, peakHour),
          buildEfficiencyMetrics(d, null),
        ],
      },
    ];

    // Achievements + Fun Facts
    const afBlock = buildAchievementsAndFunFacts(achievements, funFacts);
    if (afBlock) {
      blocks.push({ type: 'divider' });
      blocks.push(afBlock);
    }

    // Footer
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `🤖 soma-work · 생성: ${new Date().toISOString().slice(0, 19)}Z` },
      ],
    });

    const text = `일간 리포트 — ${report.date} (${dayLabel})\n생산성 ${d.productivityScore}점\n${metricsToPlainText(m)}`;
    return { blocks, text };
  }

  /**
   * Enriched weekly report — the full rich experience.
   */
  formatEnrichedWeekly(report: EnrichedWeeklyReport): FormattedReport {
    const {
      metrics: m, derived: d, trend, dailyBreakdown,
      hourlyDistribution, peakHour, activeDays,
      rankings, achievements, funFacts,
    } = report;

    const blocks: any[] = [
      // Header
      {
        type: 'header',
        text: { type: 'plain_text', text: `🏆 주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}`, emoji: true },
      },
      // One-line summary
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `💡 _${generateWeeklySummary(m, d, dailyBreakdown)}_` }],
      },
      // Executive summary
      buildExecutiveSummary(m, d, trend),
      { type: 'divider' },
      // Metrics with trends
      ...buildMetricsWithTrends(m, d, trend),
      { type: 'divider' },
    ];

    // Daily heatmap
    const heatmap = buildDailyHeatmap(dailyBreakdown);
    if (heatmap) {
      blocks.push(heatmap);
    }

    // Time distribution + Efficiency (side by side)
    blocks.push({
      type: 'section',
      fields: [
        buildTimeDistribution(hourlyDistribution, peakHour),
        buildEfficiencyMetrics(d, peakHour),
      ],
    });

    // Rankings
    blocks.push(...buildRankings(rankings));

    // Achievements + Fun Facts
    const afBlock = buildAchievementsAndFunFacts(achievements, funFacts);
    if (afBlock) {
      blocks.push({ type: 'divider' });
      blocks.push(afBlock);
    }

    // Footer
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🤖 soma-work · 활동일 \`${activeDays}/7\`일` +
            (trend ? ` · 전주 대비 생산성 ${trendArrow(trend.productivityScoreDelta)}\`${trendText(trend.productivityScoreDelta)}\`` : '') +
            ` · 생성: ${new Date().toISOString().slice(0, 19)}Z`,
        },
      ],
    });

    const text = `주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}\n` +
      `생산성 ${d.productivityScore}점\n${metricsToPlainText(m)}`;
    return { blocks, text };
  }
}
