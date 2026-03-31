/**
 * ReportFormatter — Formats aggregated reports into Slack Block Kit messages.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 5
 *
 * Supports both basic (DailyReport/WeeklyReport) and enriched formats.
 * Enriched format: Bauhaus-inspired — form follows function, grid-based KPI layout,
 * maximum information density, zero decoration waste, rule-based action alerts.
 */

import type {
  AggregatedMetrics,
  DailyBreakdown,
  DailyReport,
  DerivedMetrics,
  EnrichedDailyReport,
  EnrichedWeeklyReport,
  HourlyDistribution,
  TrendComparison,
  UserRanking,
  WeeklyReport,
} from './types';

const MAX_RANKINGS_IN_BLOCKS = 5;

// === Bauhaus v5 Layout Constraints ===
const V5_MAX_WEEKLY_BLOCKS = 12;
const V5_MAX_DAILY_BLOCKS = 10;

// === Slack Block Kit Type Definitions ===

interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

interface SlackHeaderBlock {
  type: 'header';
  text: { type: 'plain_text'; text: string; emoji?: boolean };
  block_id?: string;
}

interface SlackSectionBlock {
  type: 'section';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  block_id?: string;
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackTextObject[];
  block_id?: string;
}

interface SlackDividerBlock {
  type: 'divider';
  block_id?: string;
}

type SlackBlock = SlackHeaderBlock | SlackSectionBlock | SlackContextBlock | SlackDividerBlock;

// === Block Kit Safety Layer ===

/** Sanitize user-provided text to prevent Slack mrkdwn injection and layout breakage. */
function escapeMrkdwn(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ') // collapse newlines — prevent layout breakage
    .replace(/[*_~`]/g, '') // strip mrkdwn formatting chars — prevent emphasis injection
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Coerce a number to finite. Returns 0 for NaN, Infinity, -Infinity. Logs a warning in dev. */
function safeNum(n: number): number {
  if (!Number.isFinite(n)) {
    if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
      console.warn(`[report-formatter] safeNum received non-finite value: ${n}`);
    }
    return 0;
  }
  return n;
}

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

function safeFields(fields: SlackTextObject[]): SlackTextObject[] {
  return fields.slice(0, MAX_FIELDS).map((f) => ({
    ...f,
    text: truncateFieldText(f.text),
  }));
}

const MAX_CONTEXT_ELEMENTS = 10;

function safeContextElements(elements: SlackTextObject[]): SlackTextObject[] {
  return elements.slice(0, MAX_CONTEXT_ELEMENTS);
}

/**
 * Sanitize + truncate in correct order: escape entities first, then truncate the final payload.
 * This prevents entity expansion from pushing text over Slack limits.
 */
function sanitizeMrkdwn(text: string, max = MAX_TEXT_LENGTH): string {
  return truncateText(escapeMrkdwn(text), max);
}

function safeBlocks(blocks: SlackBlock[]): SlackBlock[] {
  if (blocks.length <= MAX_BLOCKS) return blocks;
  const header = blocks[0];
  const footer = blocks[blocks.length - 1];
  const middle = blocks.slice(1, -1).slice(0, MAX_BLOCKS - 2);
  return [header, ...middle, footer];
}

/**
 * Priority-based block trimming: preserves header (first) and footer (last).
 * Drops blocks in priority order: dividers first, then middle context blocks,
 * then middle sections — ensuring highest-value diagnostic blocks survive.
 */
function trimToLimit(blocks: SlackBlock[], limit: number): SlackBlock[] {
  if (blocks.length <= limit) return blocks;

  const header = blocks[0];
  const footer = blocks[blocks.length - 1];
  const middle = blocks.slice(1, -1);

  // Assign priority: divider=0 (drop first), context=1, section=2 (keep), header=3 (keep)
  const prioritized = middle.map((block, idx) => {
    let priority = 2;
    if (block.type === 'divider') priority = 0;
    else if (block.type === 'context') priority = 1;
    return { block, idx, priority };
  });

  // Sort by priority descending (highest priority = keep first), stable by original index
  prioritized.sort((a, b) => b.priority - a.priority || a.idx - b.idx);

  // Keep only what fits
  const kept = prioritized.slice(0, limit - 2);
  // Restore original order
  kept.sort((a, b) => a.idx - b.idx);

  return [header, ...kept.map((k) => k.block), footer];
}

interface FormattedReport {
  blocks: SlackBlock[];
  text: string;
}

/**
 * Sanitize DerivedMetrics at the formatter boundary.
 * Replaces NaN/Infinity with 0 for all numeric fields, ensuring downstream
 * rendering never emits "NaN%" or "Infinity" in any display path.
 */
function safeDerived(d: DerivedMetrics): DerivedMetrics {
  return {
    ...d,
    prMergeRate: safeNum(d.prMergeRate),
    sessionCompletionRate: safeNum(d.sessionCompletionRate),
    churnRatio: safeNum(d.churnRatio),
    netLines: safeNum(d.netLines),
    avgCodePerCommit: safeNum(d.avgCodePerCommit),
    avgCodePerPr: safeNum(d.avgCodePerPr),
    avgTurnsPerSession: safeNum(d.avgTurnsPerSession),
    productivityScore: safeNum(d.productivityScore),
  };
}

// === Visual Helpers (Bauhaus: functional only) ===

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

function fmt(n: number): string {
  return n.toLocaleString();
}

function hourLabel(hour: number): string {
  const ampm = hour < 12 ? '오전' : '오후';
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${ampm} ${h}시`;
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

function metricsToSections(m: AggregatedMetrics): SlackBlock[] {
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

// === Bauhaus v5 Enriched Block Builders ===

/**
 * Compute a letter grade from operating metrics.
 * A: excellent flow, B: good, C: needs attention, D: action required.
 */
function computeGrade(d: DerivedMetrics, activeDays?: number): string {
  let score = 0;
  let maxScore = 6; // 3 axes × 2 points each (daily baseline)
  if (d.prMergeRate >= 60) score += 2;
  else if (d.prMergeRate >= 40) score += 1;
  if (d.sessionCompletionRate >= 60) score += 2;
  else if (d.sessionCompletionRate >= 40) score += 1;
  if (d.churnRatio <= 20) score += 2;
  else if (d.churnRatio <= 35) score += 1;
  if (activeDays !== undefined) {
    maxScore = 8; // 4 axes × 2 points (weekly)
    if (activeDays >= 5) score += 2;
    else if (activeDays >= 3) score += 1;
  }
  // Normalize to percentage of max, then map to grade.
  // This ensures daily (3-axis) and weekly (4-axis) are graded on the same scale.
  const pct = (score / maxScore) * 100;
  if (pct >= 87.5) return 'A'; // ≥7/8 or ≥5.25/6
  if (pct >= 62.5) return 'B'; // ≥5/8 or ≥3.75/6
  if (pct >= 37.5) return 'C'; // ≥3/8 or ≥2.25/6
  return 'D';
}

/**
 * v5: Pipeline flow — session funnel + PR funnel as 4-field KPI grid section.
 * Includes sessions, PR flow, code, and activity.
 */
function buildPipelineFlow(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  activeDays?: number,
  dailyBreakdown?: DailyBreakdown[],
): SlackBlock {
  const unmerged = Math.max(0, m.prsCreated - m.prsMerged);
  const netSign = d.netLines >= 0 ? '+' : '';
  const churnQuality = d.churnRatio <= 20 ? '양호' : d.churnRatio <= 35 ? '주의' : '높음';

  // Find peak day for activity field
  let peakDayLabel = '';
  if (dailyBreakdown && dailyBreakdown.length > 0 && hasAnyEvents(dailyBreakdown)) {
    const peakDay = dailyBreakdown.reduce((best, curr) => (curr.totalEvents > best.totalEvents ? curr : best));
    if (peakDay.totalEvents > 0) {
      peakDayLabel = `이벤트 ${fmt(peakDay.totalEvents)}건이 ${peakDay.dayLabel}요일에 집중`;
    }
  }

  const activityText =
    activeDays !== undefined
      ? `*활동*\n\`${activeDays}/7\`일 (목표 5+)\n${peakDayLabel || '활동 분포 균등'}`
      : `*활동*\n이벤트 ${fmt(m.sessionsCreated + m.prsCreated + m.commitsCreated)}건\n${peakDayLabel || ''}`;

  return {
    type: 'section',
    fields: safeFields([
      {
        type: 'mrkdwn',
        text: truncateFieldText(
          `*세션*\n${fmt(m.sessionsCreated)} 생성 · ${fmt(m.sessionsClosed)} 닫기 · ${m.sessionsSlept} 슬립\n완료율 ${d.sessionCompletionRate}% (닫기/생성)`,
        ),
      },
      {
        type: 'mrkdwn',
        text: truncateFieldText(
          `*PR 흐름*\n${fmt(m.prsCreated)} 생성 → ${fmt(m.prsMerged)} 머지\n머지율 \`${d.prMergeRate}%\` (목표 60%) · 미머지 ${unmerged}건`,
        ),
      },
      {
        type: 'mrkdwn',
        text: truncateFieldText(
          `*코드*\n${fmt(m.commitsCreated)} 커밋 · +${fmt(m.codeLinesAdded)} / -${fmt(m.codeLinesDeleted)}\n순 ${netSign}${fmt(d.netLines)} · churn ${Math.round(d.churnRatio)}% (<20% ${churnQuality})`,
        ),
      },
      {
        type: 'mrkdwn',
        text: truncateFieldText(activityText),
      },
    ]),
  };
}

/**
 * v5: Efficiency + throughput — 2-field section.
 */
function buildEfficiencyGrid(m: AggregatedMetrics, d: DerivedMetrics, _activeDays?: number): SlackBlock {
  const unmerged = Math.max(0, m.prsCreated - m.prsMerged);
  const commitPerPR = m.prsCreated > 0 ? safeNum(Math.round((m.commitsCreated / m.prsCreated) * 100) / 100) : 0;

  return {
    type: 'section',
    fields: safeFields([
      {
        type: 'mrkdwn',
        text: truncateFieldText(
          `*효율*\n줄/커밋 ${fmt(safeNum(d.avgCodePerCommit))} · 줄/PR ${fmt(safeNum(d.avgCodePerPr))}\n커밋당 순증가 ${fmt(safeNum(Math.round(d.netLines / Math.max(m.commitsCreated, 1))))}줄`,
        ),
      },
      {
        type: 'mrkdwn',
        text: truncateFieldText(
          `*처리량*\n턴 ${fmt(m.turnsUsed)}회 · 세션당 ${d.avgTurnsPerSession}턴\nPR당 커밋 ${commitPerPR} · 미머지 PR ${unmerged}건`,
        ),
      },
    ]),
  };
}

/**
 * v5: Action alerts — fields layout with P1/P2 severity and specific targets.
 * Returns null when no alerts triggered.
 */
function buildActionAlerts(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  _trend: TrendComparison | null,
  _peakHour: number | null,
  hourlyDistribution: HourlyDistribution[],
  activeDays?: number,
): SlackBlock | null {
  const fields: SlackTextObject[] = [];

  // Merge rate — P1: critical (<30%), immediate target 50%. P2: needs work (30-49%), target 60%.
  if (m.prsCreated >= 3 && d.prMergeRate < 50) {
    const isP1 = d.prMergeRate < 30;
    const severity = isP1 ? 'P1' : 'P2';
    // P1 = 1차 회복선(50%), P2 = 정상 운영선(60%)
    const target = isP1 ? 50 : 60;
    const action = isP1 ? '당일 리뷰 + PR당 변경 50줄 이하로 즉시 축소.' : '당일 리뷰 + PR당 변경 100줄 이하 유지.';
    fields.push({
      type: 'mrkdwn',
      text: truncateFieldText(
        `*${severity} — 머지율*\n${action}\n1차목표 ${target}%+ (현재 ${d.prMergeRate}%, 기준 60%).`,
      ),
    });
  }

  // Low active days
  if (activeDays !== undefined && activeDays < 3) {
    fields.push({
      type: 'mrkdwn',
      text: truncateFieldText(`*P2 — 활동 분산*\n작업을 3일 이상 분산.\n목표: 활동일 3+일 (현재 ${activeDays}일).`),
    });
  }

  // High churn
  if (d.churnRatio > 30) {
    const severity = d.churnRatio > 50 ? 'P1' : 'P2';
    fields.push({
      type: 'mrkdwn',
      text: truncateFieldText(
        `*${severity} — churn*\n재작업 원인 분석, 스펙 정합성 점검.\n목표: churn 20% 이하 (현재 ${Math.round(d.churnRatio)}%).`,
      ),
    });
  }

  // Late-night work pattern
  const lateNightEvents = [0, 1, 2, 3, 4, 5].reduce((sum, h) => sum + (hourlyDistribution[h]?.eventCount || 0), 0);
  const totalHourEvents = hourlyDistribution.reduce((sum, h) => sum + (h?.eventCount || 0), 0);
  if (totalHourEvents > 0 && lateNightEvents / totalHourEvents > 0.25) {
    const pct = Math.round((lateNightEvents / totalHourEvents) * 100);
    fields.push({
      type: 'mrkdwn',
      text: truncateFieldText(
        `*P2 — 작업 시간대*\n새벽 집중 ${pct}% — 지속가능성 확보.\n목표: 새벽 비율 15% 이하 유지.`,
      ),
    });
  }

  // Session completion low
  if (m.sessionsCreated >= 5 && d.sessionCompletionRate < 50) {
    const severity = d.sessionCompletionRate < 30 ? 'P1' : 'P2';
    fields.push({
      type: 'mrkdwn',
      text: truncateFieldText(
        `*${severity} — 세션 완료율*\n세션 중단 원인 파악, 프롬프트 구조 개선.\n목표: 완료율 70%+ (현재 ${d.sessionCompletionRate}%).`,
      ),
    });
  }

  if (fields.length === 0) return null;

  // Sort P1 before P2 so high-severity alerts are never truncated
  const sorted = fields.sort((a, b) => {
    const getPriority = (t: string) => (t.startsWith('*P1') ? 0 : 1);
    return getPriority(a.text) - getPriority(b.text);
  });

  return {
    type: 'section',
    fields: safeFields(sorted.slice(0, 4)),
  };
}

/**
 * v5: Daily cadence strip — context elements, one per day, peak day bolded.
 */
function buildDailyCadence(breakdown: DailyBreakdown[]): SlackBlock | null {
  if (breakdown.length === 0 || !hasAnyEvents(breakdown)) return null;

  const peakDay = breakdown.reduce((best, curr) => (curr.totalEvents > best.totalEvents ? curr : best));

  const elements = breakdown.map((d) => {
    const isPeak = d === peakDay && d.totalEvents > 0;
    let label: string;
    if (isPeak) {
      const c = d.metrics.commitsCreated > 0 ? ` · ${d.metrics.commitsCreated} 커밋` : '';
      const p = d.metrics.prsCreated > 0 ? ` · ${d.metrics.prsCreated} PR` : '';
      label = `*${d.dayLabel} ${d.totalEvents}${p}${c}*`;
    } else {
      label = `${d.dayLabel} ${d.totalEvents}`;
    }
    return { type: 'mrkdwn' as const, text: truncateText(label) };
  });

  return {
    type: 'context' as const,
    elements: safeContextElements(elements),
  };
}

/**
 * v5: Rankings — top 1 gets full detail, rest compressed to single line.
 * Shows scoring formula as context element.
 */
function buildRankings(rankings: UserRanking[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (rankings.length < 2) return blocks;

  // Score ALL rankings first, THEN sort, THEN slice top N.
  // This ensures the leaderboard reflects the true top performers, not just the first N inputs.
  const scored = rankings
    .map((r) => {
      const score =
        r.metrics.turnsUsed +
        r.metrics.sessionsCreated +
        r.metrics.issuesCreated * 2 +
        r.metrics.commitsCreated * 3 +
        r.metrics.prsCreated * 5 +
        r.metrics.prsMerged * 10;
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score || a.userName.localeCompare(b.userName, 'en', { sensitivity: 'base' }))
    .slice(0, MAX_RANKINGS_IN_BLOCKS);

  const top = scored[0];
  const rest = scored.slice(1);

  // Top 1: full detail — all scoring formula components visible
  const tm = top.metrics;
  const topLine = `1위 *${sanitizeMrkdwn(top.userName, 100)}* ${fmt(top.score)}점 — 턴${tm.turnsUsed} · 세션${tm.sessionsCreated} · 이슈${tm.issuesCreated} · 커밋${tm.commitsCreated} · PR ${tm.prsCreated}→${tm.prsMerged} · +${fmt(tm.codeLinesAdded)}줄`;

  // Rest: use sorted index as rank (not original r.rank which may be stale after re-sorting)
  const restCompact = rest
    .map((r, i) => `${i + 2}위 *${sanitizeMrkdwn(r.userName, 100)}* ${fmt(r.score)}점`)
    .join(' · ');

  const rankingText = truncateText(`*팀* (턴+세션+이슈×2+커밋×3+PR×5+머지×10)\n${topLine}\n${restCompact}`);

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: rankingText,
    },
  });

  return blocks;
}

/**
 * v5: Time distribution — context elements, 4 time blocks.
 */
function buildTimeDistribution(dist: HourlyDistribution[], peakHour: number | null): SlackTextObject[] {
  const timeBlocks = [
    { label: '새벽', hours: [0, 1, 2, 3, 4, 5] },
    { label: '오전', hours: [6, 7, 8, 9, 10, 11] },
    { label: '오후', hours: [12, 13, 14, 15, 16, 17] },
    { label: '저녁', hours: [18, 19, 20, 21, 22, 23] },
  ];

  const blockCounts = timeBlocks.map((b) => ({
    label: b.label,
    count: b.hours.reduce((sum, h) => sum + (dist[h]?.eventCount || 0), 0),
    hours: b.hours,
  }));

  // maxBlock intentionally computed but unused — reserved for future proportional bar rendering

  const elements = blockCounts.map((b) => {
    const isPeak = peakHour !== null && b.hours.includes(peakHour);
    const label = isPeak ? `*${b.label} ${b.count}*` : `${b.label} ${b.count}`;
    return { type: 'mrkdwn' as const, text: truncateText(label) };
  });

  if (peakHour !== null) {
    elements.push({ type: 'mrkdwn' as const, text: `피크 ${hourLabel(peakHour)}` });
  }

  return elements;
}

/**
 * v5: Narrative — natural language diagnosis based on data patterns.
 * Full sentence, not just a label.
 */
function generateNarrative(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  trend: TrendComparison | null,
  activeDays?: number,
): string {
  // Zero activity guard — no meaningful work output
  const totalActivity =
    m.prsCreated + m.commitsCreated + m.sessionsCreated + m.prsMerged + m.issuesCreated + m.turnsUsed;
  if (totalActivity === 0) {
    return '기간 내 활동 없음.';
  }
  // High volume coding but review bottleneck
  if (m.prsCreated >= 10 && d.prMergeRate < 20) {
    const unmerged = Math.max(0, m.prsCreated - m.prsMerged);
    return `코딩 볼륨은 컸으나 리뷰가 따라가지 못했다. ${fmt(m.prsCreated)}건 PR 중 ${m.prsMerged}건 머지, ${unmerged}건 미처리.`;
  }
  // Good merge rate + low churn
  if (d.prMergeRate >= 70 && d.churnRatio < 15) {
    return `높은 머지율(${d.prMergeRate}%)과 낮은 churn(${Math.round(d.churnRatio)}%) — 효율적인 코드 생산 주간. 현재 리듬 유지.`;
  }
  // Review bottleneck with many PRs
  if (d.prMergeRate < 40 && m.prsCreated >= 5) {
    const unmerged = Math.max(0, m.prsCreated - m.prsMerged);
    return `리뷰 병목: ${m.prsCreated}건 PR 생성, ${m.prsMerged}건 머지(${d.prMergeRate}%). ${unmerged}건 미처리 — PR 크기 축소와 당일 리뷰 문화 필요.`;
  }
  // High churn
  if (d.churnRatio > 30) {
    return `코드 재작업 비율 ${Math.round(d.churnRatio)}% — 요구사항 변경 또는 설계 재검토가 필요한 주간.`;
  }
  // Low active days (weekly)
  if (activeDays !== undefined && activeDays <= 2) {
    return `활동이 ${activeDays}일에 집중 — 산발적 패턴. 작업을 3일 이상으로 분산하면 컨텍스트 전환 비용이 줄어든다.`;
  }
  // Low active days moderate
  if (activeDays !== undefined && activeDays === 3) {
    return `활동일 3일 — 목표(5일)에 미달. PR ${m.prsMerged}건 머지, 커밋 ${m.commitsCreated}건. 일정 블록화 권장.`;
  }
  // Strong productivity improvement
  if (trend && !trend.baselineZero && (trend.productivityScoreDelta ?? 0) > 20) {
    return `전주 대비 생산성 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)} 급상승 — 현재 리듬 유지가 관건.`;
  }
  // Productivity drop
  if (trend && !trend.baselineZero && (trend.productivityScoreDelta ?? 0) < -20) {
    return `생산성 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)} 하락 — 병목 원인 식별이 우선.`;
  }
  // Deep AI usage
  if (d.avgTurnsPerSession >= 8) {
    return `AI 심층 활용 — 세션당 ${d.avgTurnsPerSession}턴. 고밀도 집중 패턴이지만 세션 완료율(${d.sessionCompletionRate}%) 점검 필요.`;
  }
  // Default: stable
  return `안정적 운영 — 머지율 ${d.prMergeRate}%, 커밋 ${m.commitsCreated}건, 세션 완료율 ${d.sessionCompletionRate}%.`;
}

/**
 * v5: Weekly context line text — key metrics for context block.
 */
function generateWeeklySummary(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  _breakdown: DailyBreakdown[],
  activeDays: number,
  trend: TrendComparison | null,
): string {
  const netSign = d.netLines >= 0 ? '+' : '';
  const trendSuffix = trend?.baselineZero
    ? ' · 첫 기록'
    : trend && !trend.baselineZero && Math.abs(trend.productivityScoreDelta ?? 0) >= 5
      ? ` · 전주 대비 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)}`
      : '';

  const totalLines = m.codeLinesAdded + m.codeLinesDeleted;
  const netContext = totalLines > 0 ? ` (총변경 ${fmt(totalLines)}줄)` : '';
  return `머지율 \`${d.prMergeRate}%\` (목표 60%) · 활동일 \`${activeDays}/7\` (목표 5+) · 순코드 ${netSign}${fmt(d.netLines)}줄${netContext}${trendSuffix}`;
}

/**
 * v5: Daily context line text — key metrics for context block.
 */
function generateDailySummary(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  dayLabel: string,
  trend: TrendComparison | null,
): string {
  const netSign = d.netLines >= 0 ? '+' : '';
  const trendSuffix = trend?.baselineZero
    ? ' · 첫 기록'
    : trend && !trend.baselineZero && Math.abs(trend.productivityScoreDelta ?? 0) >= 5
      ? ` · 전일 대비 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)}`
      : '';

  const parts: string[] = [];
  if (m.prsCreated > 0) {
    parts.push(`머지율 \`${d.prMergeRate}%\``);
  }
  parts.push(`순코드 ${netSign}${fmt(d.netLines)}줄`);
  if (m.commitsCreated > 0) parts.push(`커밋 ${m.commitsCreated}건`);
  parts.push(trendSuffix ? trendSuffix.replace(/^ · /, '') : `${dayLabel}요일`);

  return parts.filter(Boolean).join(' · ');
}

// === Main Formatter Class ===

export class ReportFormatter {
  /**
   * Format a basic daily report (backward compatible).
   */
  formatDaily(report: DailyReport): FormattedReport {
    const blocks: SlackBlock[] = [
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
    const blocks: SlackBlock[] = [
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

    // Sort rankings by consistent scoring formula, then take top N — same logic as buildRankings
    const sortedRankings = [...report.rankings]
      .sort((a, b) => {
        const scoreOf = (r: UserRanking) =>
          r.metrics.turnsUsed +
          r.metrics.sessionsCreated +
          r.metrics.issuesCreated * 2 +
          r.metrics.commitsCreated * 3 +
          r.metrics.prsCreated * 5 +
          r.metrics.prsMerged * 10;
        return scoreOf(b) - scoreOf(a) || a.userName.localeCompare(b.userName, 'en', { sensitivity: 'base' });
      })
      .slice(0, MAX_RANKINGS_IN_BLOCKS);
    if (sortedRankings.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: ':medal: 사용자 랭킹', emoji: true },
      });
      for (let idx = 0; idx < sortedRankings.length; idx++) {
        const r = sortedRankings[idx];
        const displayRank = idx + 1;
        const medal = displayRank <= 3 ? ['🥇', '🥈', '🥉'][displayRank - 1] : `#${displayRank}`;
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `${medal} *${sanitizeMrkdwn(r.userName, 100)}*\n` +
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
   * Enriched daily report — Bauhaus v5: grade in header, natural language narrative,
   * 4-field KPI grid, 2-field efficiency, time distribution, action alerts. ≤10 blocks.
   */
  formatEnrichedDaily(report: EnrichedDailyReport): FormattedReport {
    const { metrics: m, derived: rawD, trend, hourlyDistribution, peakHour } = report;
    const d = safeDerived(rawD);
    const dayLabel = getDayLabel(report.date);
    const grade = computeGrade(d);
    const reportTitle = `일간 리포트 — ${report.date} (${dayLabel})`;

    const blocks: SlackBlock[] = [];

    // Block 1: Header with grade
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncateHeader(`${grade} · ${reportTitle}`),
        emoji: true,
      },
    });

    // Block 2: Context line — key metrics
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: generateDailySummary(m, d, dayLabel, trend) }],
    });

    // Block 3: Narrative — natural language diagnosis
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateText(generateNarrative(m, d, trend)),
      },
    });

    // Block 4: Divider
    blocks.push({ type: 'divider' });

    // Block 5: KPI grid — sessions, PR, code, conversations (4 fields)
    const unmerged = Math.max(0, m.prsCreated - m.prsMerged);
    const netSign = d.netLines >= 0 ? '+' : '';
    const churnQuality = d.churnRatio <= 20 ? '양호' : d.churnRatio <= 35 ? '주의' : '높음';
    blocks.push({
      type: 'section',
      fields: safeFields([
        {
          type: 'mrkdwn',
          text: truncateFieldText(
            `*세션*\n${fmt(m.sessionsCreated)} 생성 · ${fmt(m.sessionsClosed)} 닫기 · ${m.sessionsSlept} 슬립\n완료율 ${d.sessionCompletionRate}% (닫기/생성)`,
          ),
        },
        {
          type: 'mrkdwn',
          text: truncateFieldText(
            `*PR 흐름*\n${fmt(m.prsCreated)} 생성 → ${fmt(m.prsMerged)} 머지\n머지율 \`${d.prMergeRate}%\` (목표 60%) · 미머지 ${unmerged}건`,
          ),
        },
        {
          type: 'mrkdwn',
          text: truncateFieldText(
            `*코드*\n${fmt(m.commitsCreated)} 커밋 · +${fmt(m.codeLinesAdded)} / -${fmt(m.codeLinesDeleted)}\n순 ${netSign}${fmt(d.netLines)} · churn ${Math.round(d.churnRatio)}% (<20% ${churnQuality})`,
          ),
        },
        {
          type: 'mrkdwn',
          text: truncateFieldText(
            `*대화*\n턴 ${fmt(m.turnsUsed)}회 · 세션당 ${d.avgTurnsPerSession}턴\n이슈 ${m.issuesCreated}건`,
          ),
        },
      ]),
    });

    // Block 6: Efficiency (2 fields)
    blocks.push(buildEfficiencyGrid(m, d));

    // Block 7: Divider (before time distribution, if present)
    if (hasAnyHours(hourlyDistribution)) {
      blocks.push({ type: 'divider' });

      // Block 8: Time distribution as context elements
      const timeElements = buildTimeDistribution(hourlyDistribution, peakHour);
      blocks.push({
        type: 'context',
        elements: safeContextElements(timeElements),
      });
    }

    // Block 9 (conditional): Action alerts
    const actionBlock = buildActionAlerts(m, d, trend, peakHour, hourlyDistribution);
    if (actionBlock) {
      blocks.push(actionBlock);
    }

    // Block 10: Footer
    const today = new Date().toISOString().slice(0, 10);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `soma-work · ${today} · 비활성 유저 생략` }],
    });

    const trendLine =
      trend && !trend.baselineZero
        ? `전일 대비 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)}`
        : trend?.baselineZero
          ? '첫 기록'
          : '';
    const text =
      `${grade} · 일간 리포트 — ${report.date} (${dayLabel})\n` +
      `생산성 ${d.productivityScore}점${trendLine ? ` · ${trendLine}` : ''}\n${metricsToPlainText(m, d)}`;

    // v5 layout contract: daily ≤ 10 blocks.
    // Priority-based trim: drop dividers first, then context (except footer), preserve data blocks.
    return { blocks: trimToLimit(safeBlocks(blocks), V5_MAX_DAILY_BLOCKS), text };
  }

  /**
   * Enriched weekly report — Bauhaus v5: grade in header, natural language narrative,
   * 4-field KPI grid, 2-field efficiency, compact cadence strip, action alerts,
   * rankings with scoring formula. Exactly 12 blocks (or fewer if data missing).
   */
  formatEnrichedWeekly(report: EnrichedWeeklyReport): FormattedReport {
    const {
      metrics: m,
      derived: rawD,
      trend,
      dailyBreakdown,
      hourlyDistribution,
      peakHour,
      activeDays,
      rankings,
    } = report;
    const d = safeDerived(rawD);

    const grade = computeGrade(d, activeDays);
    const weekEnd = report.weekEnd.slice(5); // "MM-DD" portion
    const reportTitle = `주간 리포트 — ${report.weekStart} ~ ${weekEnd}`;

    const blocks: SlackBlock[] = [];

    // Block 1: Header with grade
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncateHeader(`${grade} · ${reportTitle}`),
        emoji: true,
      },
    });

    // Block 2: Context line — key metrics + targets
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: generateWeeklySummary(m, d, dailyBreakdown, activeDays, trend) }],
    });

    // Block 3: Narrative — rules-based diagnosis (full sentence)
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncateText(generateNarrative(m, d, trend, activeDays)),
      },
    });

    // Block 4: Divider (before KPI grid)
    blocks.push({ type: 'divider' });

    // Block 5: KPI grid — sessions, PR flow, code, activity (4 fields)
    blocks.push(buildPipelineFlow(m, d, activeDays, dailyBreakdown));

    // Block 6: Efficiency + throughput (2 fields)
    blocks.push(buildEfficiencyGrid(m, d, activeDays));

    // Block 7: Divider (before cadence)
    blocks.push({ type: 'divider' });

    // Block 8: Daily cadence as context elements (skipped if no data)
    const cadence = buildDailyCadence(dailyBreakdown);
    if (cadence) {
      blocks.push(cadence);
    }

    // Block 9: Divider (before actions)
    blocks.push({ type: 'divider' });

    // Block 10: Action items with P1/P2 severity
    const actionBlock = buildActionAlerts(m, d, trend, peakHour, hourlyDistribution, activeDays);
    if (actionBlock) {
      blocks.push(actionBlock);
    } else {
      // No critical alerts — show a positive note
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: truncateText(
            `임계치 초과 항목 없음. 머지율 ${d.prMergeRate}% · 완료율 ${d.sessionCompletionRate}% · churn ${Math.round(d.churnRatio)}%.`,
          ),
        },
      });
    }

    // Block 11: Rankings with scoring formula
    if (rankings.length >= 2) {
      blocks.push(...buildRankings(rankings));
    }

    // Block 12: Footer
    const today = new Date().toISOString().slice(0, 10);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `soma-work · ${today} · 비활성 유저 생략` }],
    });

    const weeklyTrendLine =
      trend && !trend.baselineZero
        ? `전주 대비 ${deltaArrow(trend.productivityScoreDelta)}${deltaText(trend.productivityScoreDelta)}`
        : trend?.baselineZero
          ? '첫 기록'
          : '';
    const text =
      `${grade} · 주간 리포트 — ${report.weekStart} ~ ${report.weekEnd}\n` +
      `생산성 ${d.productivityScore}점 · 활동일 ${activeDays}/7${weeklyTrendLine ? ` · ${weeklyTrendLine}` : ''}\n${metricsToPlainText(m, d)}`;

    // v5 layout contract: weekly ≤ 12 blocks.
    // Priority-based trim: drop dividers first, then context (except footer), preserve data blocks.
    return { blocks: trimToLimit(safeBlocks(blocks), V5_MAX_WEEKLY_BLOCKS), text };
  }
}
