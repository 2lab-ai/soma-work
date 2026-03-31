/**
 * ReportFormatter — Formats aggregated reports into Slack Block Kit messages.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 5
 *
 * Supports both basic (DailyReport/WeeklyReport) and enriched formats.
 * Enriched format: Bauhaus-inspired — form follows function, grid-based KPI layout,
 * maximum information density, zero decoration waste, rule-based action alerts.
 */

import type {
  Achievement,
  AggregatedMetrics,
  DailyBreakdown,
  DailyReport,
  DerivedMetrics,
  EnrichedDailyReport,
  EnrichedWeeklyReport,
  FunFact,
  HourlyDistribution,
  TrendComparison,
  UserRanking,
  WeeklyReport,
} from './types';

const MAX_RANKINGS_IN_BLOCKS = 5;

// === Block Kit Safety Layer ===

const MAX_BLOCKS = 50;
const MAX_FIELDS = 10;
const MAX_TEXT_LENGTH = 3000;
const MAX_HEADER_LENGTH = 150;
const MAX_FIELD_TEXT_LENGTH = 2000;

function truncateText(text: string, max = MAX_TEXT_LENGTH): string {
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function truncateFieldText(text: string): string {
  return truncateText(text, MAX_FIELD_TEXT_LENGTH);
}

function truncateHeader(text: string): string {
  return text.length > MAX_HEADER_LENGTH ? text.slice(0, MAX_HEADER_LENGTH - 1) + '…' : text;
}

function safeFields(fields: any[]): any[] {
  return fields.slice(0, MAX_FIELDS);
}

function safeBlocks(blocks: any[]): any[] {
  if (blocks.length <= MAX_BLOCKS) return blocks;
  const header = blocks[0];
  const footer = blocks[blocks.length - 1];
  const middle = blocks.slice(1, -1).slice(0, MAX_BLOCKS - 2);
  return [header, ...middle, footer];
}

interface FormattedReport {
  blocks: any[];
  text: string;
}

// === Visual Helpers (Bauhaus: functional only) ===

function miniBar(value: number, max: number, width = 8): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function progressBar(value: number, max: number, width = 8): string {
  return `${miniBar(value, max, width)} ${Math.round(max > 0 ? (value / max) * 100 : 0)}%`;
}

function deltaText(delta: number | undefined | null): string {
  if (delta === undefined || delta === null) return '';
  if (delta > 0) return `+${delta}%`;
  if (delta < 0) return `${delta}%`;
  return '0%';
}

function deltaArrow(delta: number | undefined | null): string {
  if (delta === undefined || delta === null) return '';
  if (delta > 5) return '↑';
  if (delta < -5) return '↓';
  return '→';
}

function trendBadge(delta: number | undefined | null, trend: TrendComparison | null): string {
  if (delta === undefined || delta === null) return '';
  if (trend?.baselineZero === true) return ' `NEW`';
  if (Math.abs(delta) < 5) return '';
  return ` \`${deltaArrow(delta)}${deltaText(delta)}\``;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function hourLabel(hour: number): string {
  const ampm = hour < 12 ? '오전' : '오후';
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${ampm} ${h}시`;
}

function codeChangeCompact(added: number, deleted: number, netLines?: number): string {
  const net = netLines !== undefined ? netLines : added - deleted;
  const netSign = net >= 0 ? '+' : '';
  if (deleted > 0) {
    return `+${fmt(added)} / -${fmt(deleted)} (순${netSign}${fmt(net)})`;
  }
  return `+${fmt(added)}줄`;
}

function hasAnyEvents(breakdown: DailyBreakdown[]): boolean {
  return breakdown.some((d) => d.totalEvents > 0);
}

function hasAnyHours(dist: HourlyDistribution[]): boolean {
  return dist.some((h) => h.eventCount > 0);
}

/** Korean day-of-week label */
function getDayLabel(dateStr: string): string {
  const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
  const d = new Date(dateStr + 'T00:00:00Z');
  return DAY_LABELS[d.getUTCDay()];
}

// === Plain text (fallback) ===

function metricsToPlainText(m: AggregatedMetrics, d?: DerivedMetrics): string {
  const lines = [
    `세션: ${m.sessionsCreated}생성 / ${m.sessionsClosed}닫기 / ${m.sessionsSlept}슬립`,
    `GitHub: 이슈 ${m.issuesCreated} / PR ${m.prsCreated} / 커밋 ${m.commitsCreated} / 코드 +${m.codeLinesAdded}`,
    `머지: PR ${m.prsMerged} / 코드 +${m.mergeLinesAdded}`,
    `대화: 턴 ${m.turnsUsed}`,
  ];
  if (d) {
    lines.push(
      `효율: 머지율 ${d.prMergeRate}% / 완료율 ${d.sessionCompletionRate}% / 순코드 ${d.netLines > 0 ? '+' : ''}${d.netLines} / churn ${d.churnRatio}%`,
    );
  }
  return lines.join('\n');
}

// === Basic Formatters (backward compatible) ===

function metricsToSections(m: AggregatedMetrics): any[] {
  return [
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*:computer: 세션*\n생성 \`${m.sessionsCreated}\` · 슬립 \`${m.sessionsSlept}\` · 닫기 \`${m.sessionsClosed}\``,
        },
        { type: 'mrkdwn', text: `*:speech_balloon: 대화*\n턴 \`${m.turnsUsed}\`` },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*:octocat: GitHub*\n이슈 \`${m.issuesCreated}\` · PR \`${m.prsCreated}\` · 커밋 \`${m.commitsCreated}\` · 코드 \`+${m.codeLinesAdded}\``,
        },
        { type: 'mrkdwn', text: `*:white_check_mark: 머지*\nPR \`${m.prsMerged}\` · 코드 \`+${m.mergeLinesAdded}\`` },
      ],
    },
  ];
}

// === Bauhaus Enriched Block Builders ===

/**
 * Compute a letter grade from operating metrics.
 * A: excellent flow, B: good, C: needs attention, D: action required.
 */
function computeGrade(d: DerivedMetrics, activeDays?: number): string {
  let score = 0;
  if (d.prMergeRate >= 60) score += 2;
  else if (d.prMergeRate >= 40) score += 1;
  if (d.sessionCompletionRate >= 60) score += 2;
  else if (d.sessionCompletionRate >= 40) score += 1;
  if (d.churnRatio <= 20) score += 2;
  else if (d.churnRatio <= 35) score += 1;
  if (activeDays !== undefined) {
    if (activeDays >= 5) score += 2;
    else if (activeDays >= 3) score += 1;
  } else {
    score += 1; // neutral for daily
  }
  if (score >= 7) return 'A';
  if (score >= 5) return 'B';
  if (score >= 3) return 'C';
  return 'D';
}

/**
 * Hero Band — The 4 most decision-relevant KPIs + letter grade.
 * This is the visual anchor of the entire report.
 */
function buildHeroBand(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  trend: TrendComparison | null,
  activeDays?: number,
): any {
  const t = trend;
  const tb = (delta: number | undefined) => trendBadge(delta, t);
  const grade = computeGrade(d, activeDays);

  const netSign = d.netLines >= 0 ? '+' : '';
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: truncateText(
        `*\`${grade}\`*  ` +
          `머지 \`${fmt(m.prsMerged)}\`건${tb(t?.prsMergedDelta)}  ·  ` +
          `머지율 \`${d.prMergeRate}%\`  ·  ` +
          `순코드 \`${netSign}${fmt(d.netLines)}\`줄${tb(t?.codeLinesAddedDelta)}  ·  ` +
          `커밋 \`${fmt(m.commitsCreated)}\`${tb(t?.commitsCreatedDelta)}`,
      ),
    },
  };
}

/**
 * KPI Grid — Secondary metrics, 2 rows × 4 cells.
 * Row 1: Quality metrics
 * Row 2: Efficiency metrics
 */
function buildKPIGrid(m: AggregatedMetrics, d: DerivedMetrics, trend: TrendComparison | null): any[] {
  const t = trend;
  const tb = (delta: number | undefined) => trendBadge(delta, t);

  return [
    {
      type: 'section',
      fields: safeFields([
        {
          type: 'mrkdwn',
          text: truncateFieldText(`세션 완료율\n\`${d.sessionCompletionRate}%\`${tb(t?.sessionsCreatedDelta)}`),
        },
        { type: 'mrkdwn', text: truncateFieldText(`Δ줄/PR\n\`${fmt(d.avgChangedLinesPerPr)}\``) },
        { type: 'mrkdwn', text: truncateFieldText(`턴/세션\n\`${d.avgTurnsPerSession}\`${tb(t?.turnsUsedDelta)}`) },
        { type: 'mrkdwn', text: truncateFieldText(`Churn\n\`${Math.round(d.churnRatio)}%\``) },
      ]),
    },
  ];
}

/**
 * Pipeline Flow — Session funnel + PR funnel side by side.
 */
function buildPipelineFlow(m: AggregatedMetrics, d: DerivedMetrics): any {
  const sessionFlow =
    `*세션 파이프라인*\n` +
    `\`${fmt(m.sessionsCreated)}\` 생성 → \`${m.sessionsSlept}\` 슬립 → \`${m.sessionsClosed}\` 닫기\n` +
    `완료율 \`${d.sessionCompletionRate}%\`  \`${miniBar(m.sessionsClosed, m.sessionsCreated, 10)}\``;

  const prFlow =
    `*PR 파이프라인*\n` +
    `\`${fmt(m.prsCreated)}\` 생성 → \`${m.prsMerged}\` 머지\n` +
    `머지율 \`${d.prMergeRate}%\`  \`${miniBar(m.prsMerged, m.prsCreated, 10)}\``;

  return {
    type: 'section',
    fields: safeFields([
      { type: 'mrkdwn', text: truncateFieldText(sessionFlow) },
      { type: 'mrkdwn', text: truncateFieldText(prFlow) },
    ]),
  };
}

/**
 * Efficiency Grid — All derived per-unit metrics in one row.
 */
function buildEfficiencyGrid(m: AggregatedMetrics, d: DerivedMetrics, activeDays?: number): any {
  const commitPerDay = activeDays ? `\`${d.commitPerActiveDay}\`/일` : '';
  const prPerDay = activeDays ? `\`${d.prPerActiveDay}\`/일` : '';

  return {
    type: 'section',
    fields: safeFields([
      { type: 'mrkdwn', text: truncateFieldText(`*줄/커밋*\n\`${fmt(d.avgCodePerCommit)}\``) },
      { type: 'mrkdwn', text: truncateFieldText(`*줄/PR*\n\`${fmt(d.avgCodePerPr)}\``) },
      { type: 'mrkdwn', text: truncateFieldText(`*커밋 밀도*\n${commitPerDay || `\`${fmt(m.commitsCreated)}\``}`) },
      { type: 'mrkdwn', text: truncateFieldText(`*PR 밀도*\n${prPerDay || `\`${fmt(m.prsCreated)}\``}`) },
    ]),
  };
}

/**
 * Action Needed — Rule-based alerts with thresholds.
 * Only shows when there are actual issues to address.
 */
function buildActionAlerts(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  trend: TrendComparison | null,
  peakHour: number | null,
  hourlyDistribution: HourlyDistribution[],
  activeDays?: number,
): any | null {
  const alerts: string[] = [];

  // Each alert: severity [P1/P2] + metric + delta + benchmark + target + action
  // Merge rate warning
  if (m.prsCreated >= 3 && d.prMergeRate < 50) {
    const severity = d.prMergeRate < 30 ? 'P1' : 'P2';
    const delta =
      trend && !trend.baselineZero ? ` ${deltaArrow(trend.prsMergedDelta)}${deltaText(trend.prsMergedDelta)}` : '';
    alerts.push(`\`${severity}\` 머지율 \`${d.prMergeRate}%\`${delta} (기준 60%) → PR 크기 축소, 리뷰 턴어라운드 단축`);
  }

  // High churn
  if (d.churnRatio > 30) {
    const severity = d.churnRatio > 50 ? 'P1' : 'P2';
    alerts.push(
      `\`${severity}\` Churn \`${Math.round(d.churnRatio)}%\` (기준 20%) → 재작업 원인 분석, 스펙 정합성 점검`,
    );
  }

  // Low active days
  if (activeDays !== undefined && activeDays < 4) {
    alerts.push(`\`P2\` 활동일 \`${activeDays}/7\` (기준 5일) → 일정 블록화, 컨텍스트 스위칭 최소화`);
  }

  // Late-night work pattern
  const lateNightEvents = [0, 1, 2, 3, 4, 5].reduce((sum, h) => sum + (hourlyDistribution[h]?.eventCount || 0), 0);
  const totalEvents = hourlyDistribution.reduce((sum, h) => sum + (h?.eventCount || 0), 0);
  if (totalEvents > 0 && lateNightEvents / totalEvents > 0.25) {
    const pct = Math.round((lateNightEvents / totalEvents) * 100);
    alerts.push(`\`P2\` 새벽 \`${pct}%\` (기준 15%) → 작업 시간대 조정, 지속가능성 확보`);
  }

  // Session completion low
  if (m.sessionsCreated >= 5 && d.sessionCompletionRate < 50) {
    const severity = d.sessionCompletionRate < 30 ? 'P1' : 'P2';
    alerts.push(
      `\`${severity}\` 완료율 \`${d.sessionCompletionRate}%\` (기준 70%) → 세션 중단 원인 파악, 프롬프트 구조 개선`,
    );
  }

  if (alerts.length === 0) return null;

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: truncateText(`*⚡ ACTION NEEDED*\n${alerts.slice(0, 3).join('\n')}`),
    },
  };
}

/**
 * Daily cadence strip — clean monospace grid, no decorative icons.
 */
function buildDailyCadence(breakdown: DailyBreakdown[]): any | null {
  if (breakdown.length === 0 || !hasAnyEvents(breakdown)) return null;

  const maxEvents = Math.max(...breakdown.map((d) => d.totalEvents), 1);
  const peakDay = breakdown.reduce((best, curr) => (curr.totalEvents > best.totalEvents ? curr : best));

  const lines = breakdown.map((d) => {
    const bar = miniBar(d.totalEvents, maxEvents, 10);
    const count = String(d.totalEvents).padStart(4);
    const c = d.metrics.commitsCreated > 0 ? ` c\`${d.metrics.commitsCreated}\`` : '';
    const p = d.metrics.prsCreated > 0 ? ` p\`${d.metrics.prsCreated}\`` : '';
    const peak = d === peakDay && d.totalEvents > 0 ? ' ◀' : '';
    return `\`${d.dayLabel}\` \`${bar}\` \`${count}\`${c}${p}${peak}`;
  });

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: truncateText(`*일별 활동*\n${lines.join('\n')}`),
    },
  };
}

/**
 * Time distribution — compact 4-block view.
 */
function buildTimeDistribution(dist: HourlyDistribution[], peakHour: number | null): any {
  const blocks = [
    { label: '새벽', hours: [0, 1, 2, 3, 4, 5] },
    { label: '오전', hours: [6, 7, 8, 9, 10, 11] },
    { label: '오후', hours: [12, 13, 14, 15, 16, 17] },
    { label: '저녁', hours: [18, 19, 20, 21, 22, 23] },
  ];

  const blockCounts = blocks.map((b) => ({
    label: b.label,
    count: b.hours.reduce((sum, h) => sum + (dist[h]?.eventCount || 0), 0),
  }));

  const maxBlock = Math.max(...blockCounts.map((b) => b.count), 1);
  const lines = blockCounts.map((b) => {
    const bar = miniBar(b.count, maxBlock, 8);
    return `\`${b.label}\` \`${bar}\` \`${String(b.count).padStart(4)}\``;
  });

  const peakText = peakHour !== null ? `\n피크 *${hourLabel(peakHour)}*` : '';

  return {
    type: 'mrkdwn',
    text: truncateFieldText(`*시간대 분포*\n${lines.join('\n')}${peakText}`),
  };
}

/**
 * Operational insights — data-driven bullets, no fluff.
 */
function buildInsights(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  peakHour: number | null,
  trend: TrendComparison | null,
): any {
  const bullets: string[] = [];

  // PR throughput trend
  const prDelta = trend?.prsMergedDelta;
  if (prDelta !== undefined && prDelta !== null && trend && !trend.baselineZero && Math.abs(prDelta) >= 10) {
    bullets.push(`머지 ${prDelta > 0 ? '증가' : '감소'} \`${Math.abs(prDelta)}%\``);
  }

  // Code efficiency
  if (d.avgCodePerCommit > 0) {
    const qualifier = d.avgCodePerCommit > 200 ? '대규모' : d.avgCodePerCommit < 50 ? '세분화' : '적정';
    bullets.push(`커밋 크기 ${qualifier} (\`${fmt(d.avgCodePerCommit)}\`줄/커밋)`);
  }

  // Peak hour
  if (peakHour !== null) {
    bullets.push(`집중 시간대 *${hourLabel(peakHour)}*`);
  }

  // Deep work
  if (d.avgTurnsPerSession >= 5) {
    bullets.push(`심층 작업 세션당 \`${d.avgTurnsPerSession}\`턴`);
  }

  // Issue-to-PR ratio
  if (m.issuesCreated > 0 && m.prsCreated > 0) {
    const ratio = Math.round((m.prsCreated / m.issuesCreated) * 10) / 10;
    bullets.push(`이슈당 PR \`${ratio}\`개`);
  }

  const bodyText = bullets.length > 0 ? bullets.join('\n') : '효율 양호';

  return {
    type: 'mrkdwn',
    text: truncateFieldText(`*인사이트*\n${bodyText}`),
  };
}

/**
 * Rankings — compact monospace table, top 5.
 */
function buildRankings(rankings: UserRanking[]): any[] {
  const blocks: any[] = [];
  if (rankings.length < 2) return blocks;

  const displayRankings = rankings.slice(0, MAX_RANKINGS_IN_BLOCKS);

  // Compute scores
  const scored = displayRankings.map((r) => {
    const score =
      r.metrics.turnsUsed +
      r.metrics.sessionsCreated +
      r.metrics.issuesCreated * 2 +
      r.metrics.commitsCreated * 3 +
      r.metrics.prsCreated * 5 +
      r.metrics.prsMerged * 10;
    return { ...r, score };
  });

  const topScore = scored[0]?.score || 1;

  // Header
  blocks.push({ type: 'divider' });

  // Build table-style ranking
  const lines = scored.map((r) => {
    const rank = r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : `#${r.rank}`;
    const bar = miniBar(r.score, topScore, 8);
    return (
      `${rank} *${r.userName}* \`${fmt(r.score)}점\`  \`${bar}\`\n` +
      `    PR \`${r.metrics.prsCreated}\`→\`${r.metrics.prsMerged}\` · 커밋 \`${r.metrics.commitsCreated}\` · \`+${fmt(r.metrics.codeLinesAdded)}\`줄`
    );
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: truncateText(`*팀 랭킹*\n${lines.join('\n')}`),
    },
  });

  return blocks;
}

/**
 * Achievements + Fun Facts — compressed to max 2 each, outcome-focused.
 */
function buildHighlights(achievements: Achievement[], funFacts: FunFact[]): any | null {
  if (achievements.length === 0 && funFacts.length === 0) return null;

  const parts: string[] = [];

  // Max 2 achievements
  const topAchievements = achievements.slice(0, 2);
  for (const a of topAchievements) {
    parts.push(`${a.icon} *${a.title}* — ${a.description}`);
  }

  // Max 2 fun facts
  const topFacts = funFacts.slice(0, 2);
  for (const f of topFacts) {
    parts.push(`${f.icon} ${f.text}`);
  }

  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: truncateText(parts.join('  ·  ')) }],
  };
}

/**
 * Narrative takeaway — one memorable sentence about the week's operating pattern.
 * This is what people remember from the report.
 */
function generateNarrative(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  trend: TrendComparison | null,
  activeDays?: number,
): string {
  // Determine dominant pattern
  if (d.prMergeRate >= 70 && d.churnRatio < 15) {
    return '높은 머지율과 낮은 churn — 효율적인 코드 생산 주간';
  }
  if (d.prMergeRate < 40 && m.prsCreated >= 5) {
    return '리뷰 병목: PR은 많지만 머지가 따라가지 못하는 패턴';
  }
  if (d.churnRatio > 30) {
    return '코드 재작업 비율이 높음 — 요구사항 변경 또는 설계 재검토 필요';
  }
  if (activeDays !== undefined && activeDays <= 3) {
    return '활동 집중도 낮음 — 산발적 작업 패턴, 블록 단위 집중 필요';
  }
  if (trend && !trend.baselineZero && (trend.productivityScoreDelta ?? 0) > 20) {
    return '전주 대비 생산성 급상승 — 현재 리듬 유지가 관건';
  }
  if (trend && !trend.baselineZero && (trend.productivityScoreDelta ?? 0) < -20) {
    return '생산성 하락 — 병목 원인 식별이 우선';
  }
  if (d.avgTurnsPerSession >= 8) {
    return 'AI 심층 활용 — 세션당 대화 밀도가 높은 집중 패턴';
  }
  return '안정적 운영 — 현재 페이스 유지';
}

/**
 * Weekly summary — data-driven, no quotes.
 */
function generateWeeklySummary(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  breakdown: DailyBreakdown[],
  activeDays: number,
  trend: TrendComparison | null,
): string {
  const parts: string[] = [];
  parts.push(`활동일 ${activeDays}/7`);

  if (trend && !trend.baselineZero && Math.abs(trend.productivityScoreDelta ?? 0) >= 5) {
    parts.push(`생산성 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)}`);
  } else if (trend?.baselineZero) {
    parts.push('첫 기록');
  }

  parts.push(`머지 ${m.prsMerged}건`);
  parts.push(`코드 ${d.netLines >= 0 ? '+' : ''}${fmt(d.netLines)}줄`);

  return parts.join(' · ');
}

/**
 * Daily summary — compact key metrics.
 */
function generateDailySummary(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  dayLabel: string,
  trend: TrendComparison | null,
): string {
  const parts: string[] = [];

  if (trend && !trend.baselineZero && Math.abs(trend.productivityScoreDelta ?? 0) >= 5) {
    parts.push(`생산성 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)}`);
  } else if (trend?.baselineZero) {
    parts.push('첫 기록');
  }

  if (m.commitsCreated > 0) parts.push(`커밋 ${m.commitsCreated}개`);
  if (m.prsCreated > 0) parts.push(`PR ${m.prsCreated}개`);

  return parts.length > 0 ? parts.join(' · ') : `${dayLabel}요일 활동 요약`;
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
        elements: [{ type: 'mrkdwn', text: `생성: ${new Date().toISOString().slice(0, 19)}Z` }],
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
        text: {
          type: 'plain_text',
          text: `:trophy: 주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}`,
          emoji: true,
        },
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
        const medal = r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : `#${r.rank}`;
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `${medal} *${r.userName}*\n` +
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
   * Enriched daily report — Bauhaus: grid KPIs, pipeline flow, action alerts.
   */
  formatEnrichedDaily(report: EnrichedDailyReport): FormattedReport {
    const { metrics: m, derived: d, trend, hourlyDistribution, peakHour, achievements, funFacts } = report;
    const dayLabel = getDayLabel(report.date);

    const blocks: any[] = [
      // ── Identity ──
      {
        type: 'header',
        text: { type: 'plain_text', text: truncateHeader(`일간 리포트 — ${report.date} (${dayLabel})`), emoji: true },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: generateDailySummary(m, d, dayLabel, trend) }],
      },

      // ── Hero Band ──
      buildHeroBand(m, d, trend),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_${generateNarrative(m, d, trend)}_` }],
      },
      { type: 'divider' },

      // ── Quality + Efficiency ──
      ...buildKPIGrid(m, d, trend),
      buildPipelineFlow(m, d),
      buildEfficiencyGrid(m, d),
    ];

    // ── Temporal ──
    if (hasAnyHours(hourlyDistribution)) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        fields: [buildTimeDistribution(hourlyDistribution, peakHour), buildInsights(m, d, peakHour, trend)],
      });
    }

    // ── Action ──
    const actionBlock = buildActionAlerts(m, d, trend, peakHour, hourlyDistribution);
    if (actionBlock) {
      blocks.push({ type: 'divider' });
      blocks.push(actionBlock);
    }

    // ── Footer ──
    const highlights = buildHighlights(achievements, funFacts);
    if (highlights) {
      blocks.push(highlights);
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `soma-work · ${new Date().toISOString().slice(0, 19)}Z` }],
    });

    const trendLine =
      trend && !trend.baselineZero
        ? `전일 대비 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)}`
        : trend?.baselineZero
          ? '첫 기록'
          : '';
    const text =
      `일간 리포트 — ${report.date} (${dayLabel})\n` +
      `생산성 ${d.productivityScore}점${trendLine ? ` · ${trendLine}` : ''}\n${metricsToPlainText(m, d)}`;

    return { blocks: safeBlocks(blocks), text };
  }

  /**
   * Enriched weekly report — Bauhaus: decision-first KPI grid, pipeline funnels,
   * efficiency metrics, action alerts, compact rankings.
   */
  formatEnrichedWeekly(report: EnrichedWeeklyReport): FormattedReport {
    const {
      metrics: m,
      derived: d,
      trend,
      dailyBreakdown,
      hourlyDistribution,
      peakHour,
      activeDays,
      rankings,
      achievements,
      funFacts,
    } = report;

    const blocks: any[] = [
      // ── ZONE 1: Identity ──
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: truncateHeader(`주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}`),
          emoji: true,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: generateWeeklySummary(m, d, dailyBreakdown, activeDays, trend) }],
      },

      // ── ZONE 2: Hero Band (decision-first) ──
      buildHeroBand(m, d, trend, activeDays),

      // ── ZONE 3: Narrative (memorable takeaway) ──
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_${generateNarrative(m, d, trend, activeDays)}_` }],
      },
      { type: 'divider' },

      // ── ZONE 4: Quality + Efficiency Grid ──
      ...buildKPIGrid(m, d, trend),
      buildPipelineFlow(m, d),
      buildEfficiencyGrid(m, d, activeDays),
    ];

    // ── ZONE 5: Temporal Pattern ──
    const cadence = buildDailyCadence(dailyBreakdown);
    if (cadence) {
      blocks.push({ type: 'divider' });
      blocks.push(cadence);
    }

    if (hasAnyHours(hourlyDistribution)) {
      blocks.push({
        type: 'section',
        fields: [buildTimeDistribution(hourlyDistribution, peakHour), buildInsights(m, d, peakHour, trend)],
      });
    }

    // ── ZONE 6: Action (threshold-based alerts with targets) ──
    const actionBlock = buildActionAlerts(m, d, trend, peakHour, hourlyDistribution, activeDays);
    if (actionBlock) {
      blocks.push({ type: 'divider' });
      blocks.push(actionBlock);
    }

    // ── ZONE 7: People ──
    blocks.push(...buildRankings(rankings));

    // ── ZONE 8: Footer ──
    const highlights = buildHighlights(achievements, funFacts);
    if (highlights) {
      blocks.push(highlights);
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `soma-work · 활동일 \`${activeDays}/7\` · ${new Date().toISOString().slice(0, 19)}Z`,
        },
      ],
    });

    const weeklyTrendLine =
      trend && !trend.baselineZero
        ? `전주 대비 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)}`
        : trend?.baselineZero
          ? '첫 기록'
          : '';
    const text =
      `주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}\n` +
      `생산성 ${d.productivityScore}점 · 활동일 ${activeDays}/7${weeklyTrendLine ? ` · ${weeklyTrendLine}` : ''}\n${metricsToPlainText(m, d)}`;

    return { blocks: safeBlocks(blocks), text };
  }
}
