/**
 * ReportAggregator — Aggregates metrics events into daily/weekly reports.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 4
 */

import { Logger } from '../logger';
import { MetricsEventStore } from './event-store';
import {
  MetricsEvent,
  MetricsEventType,
  AggregatedMetrics,
  DailyReport,
  WeeklyReport,
  UserRanking,
  DerivedMetrics,
  TrendComparison,
  DailyBreakdown,
  HourlyDistribution,
  Achievement,
  FunFact,
  EnrichedDailyReport,
  EnrichedWeeklyReport,
} from './types';

const logger = new Logger('ReportAggregator');

/**
 * Add N days to a YYYY-MM-DD string and return YYYY-MM-DD.
 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Create a zero-valued AggregatedMetrics.
 */
function emptyMetrics(): AggregatedMetrics {
  return {
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
}

/**
 * Aggregate an array of events into AggregatedMetrics.
 */
function aggregateEvents(events: MetricsEvent[]): AggregatedMetrics {
  const m = emptyMetrics();

  for (const e of events) {
    switch (e.eventType) {
      case 'session_created':  m.sessionsCreated++; break;
      case 'session_slept':    m.sessionsSlept++; break;
      case 'session_closed':   m.sessionsClosed++; break;
      case 'issue_created':    m.issuesCreated++; break;
      case 'pr_created':       m.prsCreated++; break;
      case 'commit_created':   m.commitsCreated++; break;
      case 'pr_merged':        m.prsMerged++; break;
      case 'turn_used':        m.turnsUsed++; break;
      case 'code_lines_added':
        m.codeLinesAdded += (e.metadata?.linesAdded as number) || 0;
        m.codeLinesDeleted += (e.metadata?.linesDeleted as number) || 0;
        break;
      case 'merge_lines_added':
        m.mergeLinesAdded += (e.metadata?.linesAdded as number) || 0;
        break;
    }
  }

  return m;
}

/**
 * Calculate weighted score for ranking.
 * Weights: turns*1, sessions*1, issues*2, commits*3, prs*5, merged*10
 */
function weightedScore(m: AggregatedMetrics): number {
  return (
    m.turnsUsed * 1 +
    m.sessionsCreated * 1 +
    m.issuesCreated * 2 +
    m.commitsCreated * 3 +
    m.prsCreated * 5 +
    m.prsMerged * 10
  );
}

export class ReportAggregator {
  private store: MetricsEventStore;

  constructor(store: MetricsEventStore) {
    this.store = store;
  }

  /**
   * Aggregate metrics for a single day.
   */
  async aggregateDaily(date: string): Promise<DailyReport> {
    const events = await this.store.readRange(date, date);

    return {
      date,
      period: 'daily',
      metrics: aggregateEvents(events),
    };
  }

  /**
   * Aggregate metrics for a week (Monday–Sunday) with per-user rankings.
   */
  async aggregateWeekly(weekStart: string): Promise<WeeklyReport> {
    const weekEnd = addDays(weekStart, 6);
    const events = await this.store.readRange(weekStart, weekEnd);

    const totalMetrics = aggregateEvents(events);

    // Group events by userId
    const userEventsMap = new Map<string, { userName: string; events: MetricsEvent[] }>();
    for (const e of events) {
      const existing = userEventsMap.get(e.userId);
      if (existing) {
        existing.events.push(e);
        // Take the latest userName
        if (e.userName && e.userName !== 'unknown') {
          existing.userName = e.userName;
        }
      } else {
        userEventsMap.set(e.userId, { userName: e.userName || 'unknown', events: [e] });
      }
    }

    // Build per-user metrics and sort by weighted score
    const userRankings: UserRanking[] = [];
    for (const [userId, { userName, events: userEvents }] of userEventsMap) {
      // Skip system/assistant entries from rankings
      if (userId === 'assistant' || userId === 'unknown') continue;

      const metrics = aggregateEvents(userEvents);
      userRankings.push({ userId, userName, metrics, rank: 0 });
    }

    // Sort: by weighted score desc, then alphabetical by userName for ties
    userRankings.sort((a, b) => {
      const scoreDiff = weightedScore(b.metrics) - weightedScore(a.metrics);
      if (scoreDiff !== 0) return scoreDiff;
      return a.userName.localeCompare(b.userName);
    });

    // Assign ranks
    for (let i = 0; i < userRankings.length; i++) {
      userRankings[i].rank = i + 1;
    }

    return {
      weekStart,
      weekEnd,
      period: 'weekly',
      metrics: totalMetrics,
      rankings: userRankings,
    };
  }

  // === Enriched Aggregation Methods ===

  /**
   * Enriched daily report with derived metrics, trends, hourly dist, achievements, fun facts.
   */
  async aggregateEnrichedDaily(date: string): Promise<EnrichedDailyReport> {
    const base = await this.aggregateDaily(date);
    const events = await this.store.readRange(date, date);

    // Previous day for trend comparison
    const prevDate = addDays(date, -1);
    const prevEvents = await this.store.readRange(prevDate, prevDate);
    const prevMetrics = aggregateEvents(prevEvents);

    const derived = computeDerivedMetrics(base.metrics, 1);
    const trend = computeTrend(base.metrics, prevMetrics);
    const hourlyDistribution = computeHourlyDistribution(events);
    const peakHour = findPeakHour(hourlyDistribution);
    const achievements = computeAchievements(base.metrics, derived, null, 1, trend);
    const funFacts = computeFunFacts(base.metrics, derived, events, hourlyDistribution, peakHour);

    return {
      ...base,
      derived,
      trend,
      hourlyDistribution,
      peakHour,
      achievements,
      funFacts,
    };
  }

  /**
   * Enriched weekly report with derived metrics, daily breakdown, trends, achievements, fun facts.
   */
  async aggregateEnrichedWeekly(weekStart: string): Promise<EnrichedWeeklyReport> {
    const base = await this.aggregateWeekly(weekStart);
    const weekEnd = addDays(weekStart, 6);
    const events = await this.store.readRange(weekStart, weekEnd);

    // Previous week for trend comparison
    const prevWeekStart = addDays(weekStart, -7);
    const prevWeekEnd = addDays(prevWeekStart, 6);
    const prevEvents = await this.store.readRange(prevWeekStart, prevWeekEnd);
    const prevMetrics = aggregateEvents(prevEvents);

    const dailyBreakdown = computeDailyBreakdown(events, weekStart);
    const activeDays = dailyBreakdown.filter(d => d.totalEvents > 0).length;
    const derived = computeDerivedMetrics(base.metrics, activeDays);
    const trend = computeTrend(base.metrics, prevMetrics);
    const hourlyDistribution = computeHourlyDistribution(events);
    const peakHour = findPeakHour(hourlyDistribution);
    const achievements = computeAchievements(base.metrics, derived, dailyBreakdown, activeDays, trend);
    const funFacts = computeFunFacts(base.metrics, derived, events, hourlyDistribution, peakHour, dailyBreakdown);

    return {
      ...base,
      derived,
      trend,
      dailyBreakdown,
      hourlyDistribution,
      peakHour,
      activeDays,
      achievements,
      funFacts,
    };
  }
}

// === Enriched Computation Helpers ===

const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Seoul';

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * Compute derived metrics from raw aggregated metrics.
 *
 * @param m - Raw aggregated metrics for the period.
 * @param activeDays - Number of days with activity in the period (default 1 for daily reports).
 *
 * Note on `prMergeRate`: this is in-period throughput, not cohort conversion.
 * A PR created in a previous period but merged in the current one will inflate
 * `prsMerged` without a corresponding `prsCreated` entry, and vice-versa.
 */
export function computeDerivedMetrics(m: AggregatedMetrics, activeDays: number = 1): DerivedMetrics {
  const totalChangedLines = m.codeLinesAdded + m.codeLinesDeleted;
  const safeActiveDays = activeDays > 0 ? activeDays : 1;

  return {
    productivityScore: weightedScore(m),
    prMergeRate: m.prsCreated > 0 ? Math.round((m.prsMerged / m.prsCreated) * 1000) / 10 : 0,
    avgCodePerPr: m.prsCreated > 0 ? Math.round(m.codeLinesAdded / m.prsCreated) : 0,
    avgCodePerCommit: m.commitsCreated > 0 ? Math.round(m.codeLinesAdded / m.commitsCreated) : 0,
    avgTurnsPerSession: m.sessionsCreated > 0 ? Math.round((m.turnsUsed / m.sessionsCreated) * 10) / 10 : 0,
    sessionCompletionRate: m.sessionsCreated > 0 ? Math.round((m.sessionsClosed / m.sessionsCreated) * 1000) / 10 : 0,
    netLines: m.codeLinesAdded - m.codeLinesDeleted,
    churnRatio: totalChangedLines > 0 ? Math.round((m.codeLinesDeleted / totalChangedLines) * 1000) / 10 : 0,
    avgChangedLinesPerPr: m.prsCreated > 0 ? Math.round(totalChangedLines / m.prsCreated) : 0,
    commitPerActiveDay: Math.round((m.commitsCreated / safeActiveDays) * 10) / 10,
    prPerActiveDay: Math.round((m.prsCreated / safeActiveDays) * 10) / 10,
  };
}

export function computeTrend(current: AggregatedMetrics, previous: AggregatedMetrics): TrendComparison | null {
  // If previous period has zero activity, return a baseline-zero trend instead of null.
  // All deltas are set to the current values (treat as +100% for non-zero, 0% for zero).
  const prevTotal = previous.sessionsCreated + previous.turnsUsed + previous.prsCreated +
    previous.commitsCreated + previous.issuesCreated + previous.prsMerged + previous.codeLinesAdded;
  if (prevTotal === 0) {
    const baselinePctChange = (curr: number): number => curr > 0 ? 100 : 0;
    return {
      sessionsCreatedDelta: baselinePctChange(current.sessionsCreated),
      turnsUsedDelta: baselinePctChange(current.turnsUsed),
      prsCreatedDelta: baselinePctChange(current.prsCreated),
      commitsCreatedDelta: baselinePctChange(current.commitsCreated),
      codeLinesAddedDelta: baselinePctChange(current.codeLinesAdded),
      prsMergedDelta: baselinePctChange(current.prsMerged),
      productivityScoreDelta: baselinePctChange(weightedScore(current)),
      baselineZero: true,
    };
  }

  const pctChange = (curr: number, prev: number): number => {
    if (prev === 0) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 1000) / 10;
  };

  return {
    sessionsCreatedDelta: pctChange(current.sessionsCreated, previous.sessionsCreated),
    turnsUsedDelta: pctChange(current.turnsUsed, previous.turnsUsed),
    prsCreatedDelta: pctChange(current.prsCreated, previous.prsCreated),
    commitsCreatedDelta: pctChange(current.commitsCreated, previous.commitsCreated),
    codeLinesAddedDelta: pctChange(current.codeLinesAdded, previous.codeLinesAdded),
    prsMergedDelta: pctChange(current.prsMerged, previous.prsMerged),
    productivityScoreDelta: pctChange(weightedScore(current), weightedScore(previous)),
    baselineZero: false,
  };
}

export function computeDailyBreakdown(events: MetricsEvent[], weekStart: string): DailyBreakdown[] {
  const breakdown: DailyBreakdown[] = [];

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const d = new Date(date + 'T00:00:00Z');
    const dayOfWeek = d.getUTCDay();
    const dayLabel = DAY_LABELS[dayOfWeek];

    const dayEvents = events.filter(e => {
      const eventDate = timestampToDateInTz(e.timestamp);
      return eventDate === date;
    });

    breakdown.push({
      date,
      dayLabel,
      totalEvents: dayEvents.length,
      metrics: aggregateEvents(dayEvents),
    });
  }

  return breakdown;
}

export function computeHourlyDistribution(events: MetricsEvent[]): HourlyDistribution[] {
  const hours = new Array(24).fill(0);

  for (const e of events) {
    const hour = getHourInTz(e.timestamp);
    hours[hour]++;
  }

  return hours.map((count, hour) => ({ hour, eventCount: count }));
}

export function findPeakHour(distribution: HourlyDistribution[]): number | null {
  if (distribution.length === 0) return null;
  const max = distribution.reduce((best, curr) =>
    curr.eventCount > best.eventCount ? curr : best
  );
  return max.eventCount > 0 ? max.hour : null;
}

export function computeAchievements(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  dailyBreakdown: DailyBreakdown[] | null,
  activeDays: number,
  trend?: TrendComparison | null,
): Achievement[] {
  const achievements: Achievement[] = [];

  // Streak achievements
  if (activeDays >= 7) {
    achievements.push({ icon: '🔥', title: '풀 스트릭', description: '7일 연속 활동!' });
  } else if (activeDays >= 5) {
    achievements.push({ icon: '⚡', title: '워크위크 마스터', description: `${activeDays}일 활동` });
  }

  // Commit milestones
  if (m.commitsCreated >= 100) {
    achievements.push({ icon: '💯', title: '커밋 센추리온', description: `커밋 ${m.commitsCreated}개 돌파!` });
  } else if (m.commitsCreated >= 50) {
    achievements.push({ icon: '🎯', title: '커밋 마라토너', description: `커밋 ${m.commitsCreated}개` });
  }

  // Code volume
  if (m.codeLinesAdded >= 10000) {
    achievements.push({ icon: '🚀', title: '코드 로켓', description: `+${m.codeLinesAdded.toLocaleString()}줄` });
  }

  // PR merge rate
  if (d.prMergeRate >= 80 && m.prsMerged >= 5) {
    achievements.push({ icon: '✅', title: '머지 마스터', description: `머지율 ${d.prMergeRate}%` });
  }

  // Session efficiency
  if (d.avgTurnsPerSession >= 5) {
    achievements.push({ icon: '💬', title: '딥 다이버', description: `세션당 ${d.avgTurnsPerSession}턴` });
  }

  // PR count
  if (m.prsCreated >= 20) {
    achievements.push({ icon: '📦', title: 'PR 머신', description: `PR ${m.prsCreated}개 생성` });
  }

  // Issues
  if (m.issuesCreated >= 10) {
    achievements.push({ icon: '📋', title: '이슈 헌터', description: `이슈 ${m.issuesCreated}개 생성` });
  }

  // --- Adaptive / personal-best achievements ---

  // Personal best: >50% improvement in productivity score vs previous period
  if (trend && !trend.baselineZero && trend.productivityScoreDelta > 50) {
    achievements.push({ icon: '🏆', title: '퍼스널 베스트', description: `생산성 +${trend.productivityScoreDelta}% 향상!` });
  }

  // Consistency badge: session completion rate > 80%
  if (d.sessionCompletionRate > 80) {
    achievements.push({ icon: '🎖️', title: '일관성 챔피언', description: `세션 완료율 ${d.sessionCompletionRate}%` });
  }

  // Code surgeon: heavy refactoring (churn > 30%)
  if (d.churnRatio > 30) {
    achievements.push({ icon: '🔬', title: '코드 서전', description: `코드 정제율 ${d.churnRatio}% (리팩토링 고수!)` });
  }

  // Laser focus: deep engagement per session
  if (d.avgTurnsPerSession > 10) {
    achievements.push({ icon: '🎯', title: '레이저 포커스', description: `세션당 ${d.avgTurnsPerSession}턴 — 집중력 MAX` });
  }

  return achievements.slice(0, 5); // Max 5
}

export function computeFunFacts(
  m: AggregatedMetrics,
  d: DerivedMetrics,
  events: MetricsEvent[],
  hourlyDist: HourlyDistribution[],
  peakHour: number | null,
  dailyBreakdown?: DailyBreakdown[],
): FunFact[] {
  const facts: FunFact[] = [];

  // Peak hour
  if (peakHour !== null) {
    const peakCount = hourlyDist[peakHour]?.eventCount || 0;
    const ampm = peakHour < 12 ? '오전' : '오후';
    const displayHour = peakHour === 0 ? 12 : peakHour > 12 ? peakHour - 12 : peakHour;
    facts.push({ icon: '⏰', text: `가장 활발한 시간: ${ampm} ${displayHour}시 (${peakCount}개 이벤트)` });
  }

  // Avg PR size
  if (d.avgCodePerPr > 0) {
    facts.push({ icon: '📐', text: `평균 PR 크기: ${d.avgCodePerPr.toLocaleString()}줄` });
  }

  // Avg code per commit
  if (d.avgCodePerCommit > 0) {
    facts.push({ icon: '📝', text: `커밋당 평균: ${d.avgCodePerCommit.toLocaleString()}줄` });
  }

  // Session efficiency
  if (d.avgTurnsPerSession > 0) {
    facts.push({ icon: '💬', text: `세션당 평균 대화: ${d.avgTurnsPerSession}턴` });
  }

  // Code churn (net lines)
  if (m.codeLinesDeleted > 0) {
    const net = m.codeLinesAdded - m.codeLinesDeleted;
    const netSign = net >= 0 ? '+' : '';
    facts.push({ icon: '🔄', text: `코드 변동: +${m.codeLinesAdded.toLocaleString()} / -${m.codeLinesDeleted.toLocaleString()} (순 ${netSign}${net.toLocaleString()})` });
  }

  // Total events count
  facts.push({ icon: '📊', text: `총 이벤트: ${events.length.toLocaleString()}건 기록` });

  // Night owl / Early bird
  const nightEvents = hourlyDist.filter(h => h.hour >= 22 || h.hour < 6).reduce((s, h) => s + h.eventCount, 0);
  const morningEvents = hourlyDist.filter(h => h.hour >= 6 && h.hour < 12).reduce((s, h) => s + h.eventCount, 0);
  if (nightEvents > morningEvents && nightEvents > 10) {
    facts.push({ icon: '🦉', text: `야행성 모드: 심야 활동 ${nightEvents}건` });
  } else if (morningEvents > nightEvents && morningEvents > 10) {
    facts.push({ icon: '🐦', text: `얼리버드 모드: 오전 활동 ${morningEvents}건` });
  }

  // --- New fun facts ---

  // Busiest day (from dailyBreakdown if available)
  if (dailyBreakdown && dailyBreakdown.length > 0) {
    const busiestDay = dailyBreakdown.reduce((best, curr) =>
      curr.totalEvents > best.totalEvents ? curr : best
    );
    if (busiestDay.totalEvents > 0) {
      facts.push({ icon: '📅', text: `가장 바쁜 날: ${busiestDay.dayLabel} (${busiestDay.date}, 이벤트 ${busiestDay.totalEvents}건)` });
    }

    // Weekend warrior: any weekend day (토=6, 일=0) with activity
    const weekendActivity = dailyBreakdown
      .filter(day => {
        const dayOfWeek = new Date(day.date + 'T00:00:00Z').getUTCDay();
        return (dayOfWeek === 0 || dayOfWeek === 6) && day.totalEvents > 0;
      })
      .reduce((sum, day) => sum + day.totalEvents, 0);
    if (weekendActivity > 0) {
      facts.push({ icon: '🏄', text: `주말 전사: 주말에도 이벤트 ${weekendActivity}건 활동!` });
    }
  }

  // Commit velocity (commits per active day)
  if (d.commitPerActiveDay > 0) {
    facts.push({ icon: '⚡', text: `커밋 속도: 하루 평균 ${d.commitPerActiveDay}개 커밋` });
  }

  // "If you wrote a book..." (codeLinesAdded / 250 = pages)
  if (m.codeLinesAdded >= 250) {
    const pages = Math.round(m.codeLinesAdded / 250);
    facts.push({ icon: '📚', text: `코드를 책으로 쓰면? ${pages.toLocaleString()}페이지짜리 소설!` });
  }

  return facts.slice(0, 5); // Max 5
}

// Cache Intl.DateTimeFormat instances — these are expensive to construct.
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
});

const hourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIMEZONE,
  hour: 'numeric', hour12: false,
});

/**
 * Convert timestamp to date string in report timezone.
 */
function timestampToDateInTz(timestamp: number): string {
  return dateFormatter.format(new Date(timestamp));
}

/**
 * Get hour (0-23) in report timezone.
 */
function getHourInTz(timestamp: number): number {
  const hourStr = hourFormatter.format(new Date(timestamp));
  return parseInt(hourStr, 10) % 24;
}
