/**
 * ReportAggregator — Aggregates metrics events into daily/weekly reports.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 4
 */

import { Logger } from '../logger';
import type { MetricsEventStore } from './event-store';
import {
  type Achievement,
  type AggregatedMetrics,
  type DailyBreakdown,
  type DailyReport,
  type DerivedMetrics,
  type EnrichedDailyReport,
  type EnrichedWeeklyReport,
  type FunFact,
  type HourlyDistribution,
  type MetricsEvent,
  MetricsEventType,
  type ModelTokenUsage,
  type TokenUsageAggregation,
  type TokenUsageMetadata,
  type TokenUsageRanking,
  type TrendComparison,
  type UsageReport,
  type UserRanking,
  type WeeklyReport,
} from './types';
import { currentStreak, longestStreak } from './usage-render/streaks';
import {
  type CarouselRanking,
  type CarouselStats,
  type CarouselTabStats,
  type EmptyTabStats,
  type ModelsTabRow,
  type ModelsTabStats,
  OTHER_MODEL_ID,
  type PeriodTabId,
} from './usage-render/types';

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
      case 'session_created':
        m.sessionsCreated++;
        break;
      case 'session_slept':
        m.sessionsSlept++;
        break;
      case 'session_closed':
        m.sessionsClosed++;
        break;
      case 'issue_created':
        m.issuesCreated++;
        break;
      case 'pr_created':
        m.prsCreated++;
        break;
      case 'commit_created':
        m.commitsCreated++;
        break;
      case 'pr_merged':
        m.prsMerged++;
        break;
      case 'turn_used':
        m.turnsUsed++;
        break;
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
    const activeDays = dailyBreakdown.filter((d) => d.totalEvents > 0).length;
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

  // === Token Usage Aggregation ===

  /**
   * Aggregate token usage for a date range, optionally filtered by userId.
   */
  async aggregateTokenUsage(startDate: string, endDate: string, userId?: string): Promise<UsageReport> {
    const events = await this.store.readRange(startDate, endDate);
    const tokenEvents = events.filter((e) => e.eventType === 'token_usage' && (!userId || e.userId === userId));
    return this.buildUsageReport({
      tokenEvents,
      startDate,
      endDate,
      userId,
      period: determinePeriod(startDate, endDate),
    });
  }

  /**
   * Aggregate token usage over a rolling millisecond window
   * `[startMs, endMs]`, optionally filtered by `userId`.
   *
   * Reads the minimum set of KST day-files overlapping the window (typically
   * two when the window crosses KST midnight) then post-filters by
   * `event.timestamp` for ms-level bounds. Used by `/usage` to show the last
   * 24h regardless of invocation time — e.g. `/usage` at KST 02:00 still
   * includes yesterday afternoon's events.
   */
  async aggregateTokenUsageMs(startMs: number, endMs: number, userId?: string): Promise<UsageReport> {
    const startKey = timestampToDateInTz(startMs);
    const endKey = timestampToDateInTz(endMs);
    const events = await this.store.readRange(startKey, endKey);
    const tokenEvents = events.filter(
      (e) =>
        e.eventType === 'token_usage' &&
        e.timestamp >= startMs &&
        e.timestamp <= endMs &&
        (!userId || e.userId === userId),
    );
    return this.buildUsageReport({
      tokenEvents,
      startDate: startKey,
      endDate: endKey,
      userId,
      period: 'day',
    });
  }

  private buildUsageReport(input: {
    tokenEvents: MetricsEvent[];
    startDate: string;
    endDate: string;
    userId?: string;
    period: UsageReport['period'];
  }): UsageReport {
    const { tokenEvents, startDate, endDate, userId, period } = input;

    const totals = aggregateTokenEvents(tokenEvents);
    const byUser = aggregateTokenEventsByUser(tokenEvents);
    const byDay = aggregateTokenEventsByDay(tokenEvents, startDate, endDate);

    // Rankings are meaningless when filtered to a single user.
    let tokenRankings: TokenUsageRanking[] = [];
    let costRankings: TokenUsageRanking[] = [];
    if (!userId) {
      const rankingEntries = Object.entries(byUser).map(([uid, agg]) => ({
        userId: uid,
        userName: agg.userName,
        totalTokens:
          agg.totalInputTokens + agg.totalOutputTokens + agg.totalCacheReadTokens + agg.totalCacheCreateTokens,
        totalCostUsd: agg.totalCostUsd,
        rank: 0,
      }));

      tokenRankings = [...rankingEntries]
        .sort((a, b) => b.totalTokens - a.totalTokens || a.userName.localeCompare(b.userName))
        .map((e, i) => ({ ...e, rank: i + 1 }));

      costRankings = [...rankingEntries]
        .sort((a, b) => b.totalCostUsd - a.totalCostUsd || a.userName.localeCompare(b.userName))
        .map((e, i) => ({ ...e, rank: i + 1 }));
    }

    // Legacy: events emitted before pricingVersion was introduced.
    const hasLegacyData = tokenEvents.some((e) => {
      const m = e.metadata as unknown as TokenUsageMetadata | undefined;
      return !m?.pricingVersion;
    });

    return {
      period,
      startDate,
      endDate,
      totals,
      byUser,
      byDay,
      tokenRankings,
      costRankings,
      hasLegacyData,
    };
  }

  /**
   * Aggregate carousel stats for a single target user across 4 windows in a
   * single scan over events.
   *
   * Trace: docs/usage-card-dark/trace.md — Scenario 2.
   *
   * Windows:
   * - `24h`: [now - 24h, now]
   * - `7d` : [endOfDay - 6d, endOfDay]
   * - `30d`: [endOfDay - 29d, endOfDay]
   * - `all`: [min(event.ts, 365d ago), endOfDay]
   *
   * Rankings are computed from the 30d window only and shared (reference-equal)
   * across all 4 tabs.
   */
  async aggregateCarousel(opts: {
    targetUserId: string;
    now: Date;
    targetUserName?: string;
    topN?: number;
  }): Promise<CarouselStats> {
    const { targetUserId, targetUserName } = opts;
    const now = opts.now;
    const topN = opts.topN ?? 10;
    const MS_PER_DAY = 86_400_000;

    const nowMs = now.getTime();
    const todayKey = timestampToDateInTz(nowMs);
    const endOfDayKey = todayKey; // windows end at today (KST)
    const endOfDayMs = kstDayEndMs(endOfDayKey);

    // Window boundaries (ms).
    const w24Start = nowMs - 24 * 60 * 60 * 1000;
    const w24End = nowMs;
    const w7Start = kstDayStartMs(kstShiftDay(endOfDayKey, -6));
    const w7End = endOfDayMs;
    const w30Start = kstDayStartMs(kstShiftDay(endOfDayKey, -29));
    const w30End = endOfDayMs;
    const w365Start = nowMs - 365 * MS_PER_DAY;
    const wAllEnd = endOfDayMs;

    // readRange input dates: use KST-day keys. 'all' reads up to 365 days.
    const firstDate = kstShiftDay(endOfDayKey, -365);
    const events = await this.store.readRange(firstDate, endOfDayKey);

    // Per-window builders for the target user. Only the 30d builder collects
    // per-(day, model) sub-counts; the Models tab is fixed to that window
    // and shares this builder via `buildModelsTab`.
    const builders: Record<PeriodTabId, WindowBuilder> = {
      '24h': makeWindowBuilder({ collectPerDayModel: false }),
      '7d': makeWindowBuilder({ collectPerDayModel: false }),
      '30d': makeWindowBuilder({ collectPerDayModel: true }),
      all: makeWindowBuilder({ collectPerDayModel: false }),
    };

    // Global rankings accumulator — 30d only, shared across tabs.
    const rankingsUsers = new Map<string, { tokens: number; userName?: string }>();

    // Track earliest event timestamp for 'all' window start.
    let earliestEventMs: number | null = null;
    let resolvedTargetUserName = targetUserName;

    for (const e of events) {
      if (e.eventType !== 'token_usage') continue;
      const m = e.metadata as unknown as TokenUsageMetadata | undefined;
      if (!m) continue;
      const tokens =
        (m.inputTokens || 0) +
        (m.outputTokens || 0) +
        (m.cacheReadInputTokens || 0) +
        (m.cacheCreationInputTokens || 0);
      const cost = m.costUsd || 0;

      // 365-day window cap — ignore events older than that for rankings/'all'.
      if (e.timestamp < w365Start) continue;

      // Global 30d rankings (skip system buckets).
      if (e.timestamp >= w30Start && e.timestamp <= w30End) {
        if (e.userId !== 'assistant' && e.userId !== 'unknown') {
          const bucket = rankingsUsers.get(e.userId) || { tokens: 0, userName: e.userName };
          bucket.tokens += tokens;
          if (e.userName && e.userName !== 'unknown') bucket.userName = e.userName;
          rankingsUsers.set(e.userId, bucket);
        }
      }

      if (e.userId !== targetUserId) continue;

      if (e.userName && e.userName !== 'unknown') {
        resolvedTargetUserName = e.userName;
      }

      if (earliestEventMs === null || e.timestamp < earliestEventMs) {
        earliestEventMs = e.timestamp;
      }

      const hour = getHourInTz(e.timestamp);
      const dayKey = timestampToDateInTz(e.timestamp);
      const sessionKey = m.sessionKey || e.sessionKey;

      // Each of 4 windows: if event in range, accumulate.
      const winRanges: Array<[PeriodTabId, number, number]> = [
        ['24h', w24Start, w24End],
        ['7d', w7Start, w7End],
        ['30d', w30Start, w30End],
        ['all', w365Start, wAllEnd],
      ];
      for (const [tabId, wStart, wEnd] of winRanges) {
        if (e.timestamp < wStart || e.timestamp > wEnd) continue;
        const b = builders[tabId];
        b.tokens += tokens;
        b.cost += cost;
        b.hourly[hour] += tokens;
        b.perDay.set(dayKey, (b.perDay.get(dayKey) || 0) + tokens);
        // Per-(day,hour) accumulator — needed for 7d tab's 168-cell heatmap.
        let dhArr = b.perDayHour.get(dayKey);
        if (!dhArr) {
          dhArr = new Array<number>(24).fill(0);
          b.perDayHour.set(dayKey, dhArr);
        }
        dhArr[hour] += tokens;
        b.daySet.add(dayKey);

        if (sessionKey) {
          const s = b.perSession.get(sessionKey) || {
            tokens: 0,
            firstMs: e.timestamp,
            lastMs: e.timestamp,
            count: 0,
          };
          s.tokens += tokens;
          if (e.timestamp < s.firstMs) s.firstMs = e.timestamp;
          if (e.timestamp > s.lastMs) s.lastMs = e.timestamp;
          s.count += 1;
          b.perSession.set(sessionKey, s);
        }

        if (m.modelBreakdown) {
          for (const [model, u] of Object.entries(m.modelBreakdown)) {
            const t =
              (u.inputTokens || 0) +
              (u.outputTokens || 0) +
              (u.cacheReadInputTokens || 0) +
              (u.cacheCreationInputTokens || 0);
            b.perModel.set(model, (b.perModel.get(model) || 0) + t);
            addPerDayModel(b, dayKey, model, u);
          }
        } else if (m.model) {
          b.perModel.set(m.model, (b.perModel.get(m.model) || 0) + tokens);
          // `m` already exposes the ModelTokenUsage token fields directly,
          // so pass it through as-is rather than repacking.
          addPerDayModel(b, dayKey, m.model, m);
        }
      }
    }

    // Build rankings (30d) — shared reference across all tabs.
    const rankingEntries = Array.from(rankingsUsers.entries()).map(([userId, v]) => ({
      userId,
      userName: v.userName,
      totalTokens: v.tokens,
      rank: 0,
    }));
    const tokensSorted: CarouselRanking[] = [...rankingEntries]
      .sort((a, b) => b.totalTokens - a.totalTokens || (a.userName || '').localeCompare(b.userName || ''))
      .map((e, i) => ({ ...e, rank: i + 1 }));
    const tokensTop = tokensSorted.slice(0, topN);
    const targetTokenRow = tokensSorted.find((r) => r.userId === targetUserId) ?? null;
    const sharedRankings = { tokensTop, targetTokenRow } as const;

    // Compute per-period-tab window boundaries as YYYY-MM-DD strings.
    const windowBoundsStr: Record<PeriodTabId, { start: string; end: string }> = {
      '24h': { start: timestampToDateInTz(w24Start), end: endOfDayKey },
      '7d': { start: kstShiftDay(endOfDayKey, -6), end: endOfDayKey },
      '30d': { start: kstShiftDay(endOfDayKey, -29), end: endOfDayKey },
      all: {
        start: earliestEventMs !== null ? timestampToDateInTz(earliestEventMs) : endOfDayKey,
        end: endOfDayKey,
      },
    };

    // Models tab is fixed to the 30d window — it shares the 30d builder so
    // the per-day-per-model accumulator is read straight from there with no
    // extra event scan.
    const models = buildModelsTab(builders['30d'], windowBoundsStr['30d'], targetUserId, resolvedTargetUserName);

    const tabs: CarouselStats['tabs'] = {
      '24h': buildTab(
        '24h',
        builders['24h'],
        windowBoundsStr['24h'],
        targetUserId,
        resolvedTargetUserName,
        sharedRankings,
        todayKey,
      ),
      '7d': buildTab(
        '7d',
        builders['7d'],
        windowBoundsStr['7d'],
        targetUserId,
        resolvedTargetUserName,
        sharedRankings,
        todayKey,
      ),
      '30d': buildTab(
        '30d',
        builders['30d'],
        windowBoundsStr['30d'],
        targetUserId,
        resolvedTargetUserName,
        sharedRankings,
        todayKey,
      ),
      all: buildTab(
        'all',
        builders.all,
        windowBoundsStr.all,
        targetUserId,
        resolvedTargetUserName,
        sharedRankings,
        todayKey,
      ),
      models,
    };

    return {
      targetUserId,
      targetUserName: resolvedTargetUserName,
      now: new Date(nowMs).toISOString(),
      tabs,
    };
  }
}

// === Carousel helpers ===

/**
 * Per-(day, model) token sub-counts collected by the 30d window scan and
 * consumed by `buildModelsTab`. Cost is intentionally NOT tracked — the Models
 * view shows token mix, not spend — so we drop `costUsd` from `ModelTokenUsage`.
 */
type ModelBucket = Omit<ModelTokenUsage, 'costUsd'>;

function emptyModelBucket(): ModelBucket {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

interface WindowBuilder {
  tokens: number;
  cost: number;
  hourly: number[];
  perDay: Map<string, number>;
  /**
   * Per-(dateKey, hour) token totals. Populated for every event; used by the
   * 7d tab's heatmap to emit 168 per-(day,hour) cells (24 cols × 7 rows).
   * Other tabs ignore this field.
   */
  perDayHour: Map<string, number[]>;
  daySet: Set<string>;
  perSession: Map<string, { tokens: number; firstMs: number; lastMs: number; count: number }>;
  perModel: Map<string, number>;
  /**
   * Per-(dateKey, model) token sub-counts — populated only on the 30d builder
   * (the only consumer is `buildModelsTab`, which is fixed to that window).
   * Other builders carry `null` so they don't pay the per-(day,model) Map
   * allocation cost on workspaces with hundreds of distinct models.
   */
  perDayModel: Map<string, Map<string, ModelBucket>> | null;
}

function makeWindowBuilder(opts: { collectPerDayModel: boolean }): WindowBuilder {
  return {
    tokens: 0,
    cost: 0,
    hourly: new Array<number>(24).fill(0),
    perDay: new Map(),
    perDayHour: new Map(),
    daySet: new Set(),
    perSession: new Map(),
    perModel: new Map(),
    perDayModel: opts.collectPerDayModel ? new Map() : null,
  };
}

/**
 * Add usage tokens to a `(dayKey, model)` bucket inside `b.perDayModel`.
 * No-op when `b.perDayModel` is null (non-30d builders don't track this).
 * Accepts the raw `ModelTokenUsage` shape so call sites pass through events
 * without re-keying field names.
 */
function addPerDayModel(b: WindowBuilder, dayKey: string, model: string, usage: Partial<ModelTokenUsage>): void {
  if (!b.perDayModel) return;
  let inner = b.perDayModel.get(dayKey);
  if (!inner) {
    inner = new Map();
    b.perDayModel.set(dayKey, inner);
  }
  let bucket = inner.get(model);
  if (!bucket) {
    bucket = emptyModelBucket();
    inner.set(model, bucket);
  }
  bucket.inputTokens += usage.inputTokens || 0;
  bucket.outputTokens += usage.outputTokens || 0;
  bucket.cacheReadInputTokens += usage.cacheReadInputTokens || 0;
  bucket.cacheCreationInputTokens += usage.cacheCreationInputTokens || 0;
}

/**
 * Shift a KST 'YYYY-MM-DD' day key by N calendar days (UTC arithmetic anchor —
 * safe because KST has no DST).
 */
function kstShiftDay(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map((s) => parseInt(s, 10));
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000;
  const nd = new Date(t);
  const yy = nd.getUTCFullYear();
  const mm = nd.getUTCMonth() + 1;
  const dd = nd.getUTCDate();
  return `${yy.toString().padStart(4, '0')}-${mm.toString().padStart(2, '0')}-${dd.toString().padStart(2, '0')}`;
}

/** Start-of-day (00:00:00 KST) in ms for a 'YYYY-MM-DD' KST day key. */
function kstDayStartMs(dayKey: string): number {
  return new Date(dayKey + 'T00:00:00+09:00').getTime();
}

/** End-of-day (23:59:59.999 KST) in ms for a 'YYYY-MM-DD' KST day key. */
function kstDayEndMs(dayKey: string): number {
  return new Date(dayKey + 'T23:59:59.999+09:00').getTime();
}

/** Diff (in days) between two KST day keys: b - a. */
function kstDaysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map((s) => parseInt(s, 10));
  const [yb, mb, db] = b.split('-').map((s) => parseInt(s, 10));
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/** Month diff (calendar months) between two KST day keys: b - a. */
function kstMonthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split('-').map((s) => parseInt(s, 10));
  const [yb, mb] = b.split('-').map((s) => parseInt(s, 10));
  return (yb - ya) * 12 + (mb - ma);
}

function buildTab(
  tabId: PeriodTabId,
  b: WindowBuilder,
  bounds: { start: string; end: string },
  targetUserId: string,
  targetUserName: string | undefined,
  sharedRankings: { tokensTop: CarouselRanking[]; targetTokenRow: CarouselRanking | null },
  todayKey: string,
): CarouselTabStats | EmptyTabStats {
  if (b.tokens <= 0 && b.daySet.size === 0) {
    const empty: EmptyTabStats = {
      empty: true,
      tabId,
      windowStart: bounds.start,
      windowEnd: bounds.end,
    };
    return empty;
  }

  // Favorite model
  let favoriteModel: { model: string; tokens: number } | null = null;
  for (const [model, t] of b.perModel) {
    if (!favoriteModel || t > favoriteModel.tokens) {
      favoriteModel = { model, tokens: t };
    }
  }

  // Hourly: only 24h/7d tabs expose activity; 30d/all all-zero per spec.
  const hourly = tabId === '24h' || tabId === '7d' ? b.hourly.slice() : new Array<number>(24).fill(0);

  // Heatmap shape per tab.
  const heatmap: CarouselTabStats['heatmap'] = [];
  if (tabId === '7d') {
    // 7 days × 24 hours = 168 cells; dayIdx 0 = bounds.start, dayIdx 6 = bounds.end.
    // cellIndex = dayIdx * 24 + hour — populated from `perDayHour` so every active
    // (day,hour) cell is distinct. Zero-token cells are omitted (chart visualMap
    // renders them as the zero-bucket color).
    for (let d = 0; d < 7; d++) {
      const dateKey = kstShiftDay(bounds.start, d);
      const dh = b.perDayHour.get(dateKey);
      if (!dh) continue;
      for (let h = 0; h < 24; h++) {
        const t = dh[h];
        if (t <= 0) continue;
        heatmap.push({
          date: dateKey,
          tokens: t,
          cellIndex: d * 24 + h,
          label: `${dateKey} ${h}시`,
        });
      }
    }
  } else if (tabId === '30d') {
    // 5 rows × 7 cols = 35 cells. cellIndex = row*7 + col, row 0..4, col 0..6.
    for (const [dateKey, tokens] of b.perDay) {
      const dayIdx = kstDaysBetween(bounds.start, dateKey);
      if (dayIdx < 0 || dayIdx > 29) continue;
      const cellIndex = dayIdx; // 0..29 mapped to 5x7 grid via (row=dayIdx/7, col=dayIdx%7)
      heatmap.push({ date: dateKey, tokens, cellIndex, label: dateKey });
    }
  } else if (tabId === 'all') {
    // monthIdx * 7 + kstDayOfWeek(dayKey) — up to 12 months × 7 weekdays = 84 cells.
    for (const [dateKey, tokens] of b.perDay) {
      const monthIdx = kstMonthsBetween(bounds.start, dateKey);
      if (monthIdx < 0) continue;
      const cellMonth = Math.min(monthIdx, 11);
      const dow = kstDayOfWeek(dateKey);
      const cellIndex = cellMonth * 7 + dow;
      heatmap.push({ date: dateKey, tokens, cellIndex, label: dateKey });
    }
  }
  // tabId === '24h' → heatmap remains [].

  // Streaks — uses daySet directly.
  const activeDays = b.daySet.size;
  const longestStreakDays = longestStreak(b.daySet);
  const currentStreakDays = currentStreak(b.daySet, todayKey);

  // Top sessions by tokens.
  const sessionsArr = Array.from(b.perSession.entries()).map(([sessionKey, s]) => ({
    sessionKey,
    totalTokens: s.tokens,
    durationMs: s.count >= 2 ? s.lastMs - s.firstMs : 0,
  }));
  const topSessions = [...sessionsArr].sort((a, b2) => b2.totalTokens - a.totalTokens).slice(0, 3);
  const longestSessionArr = [...sessionsArr]
    .filter((s) => s.durationMs > 0)
    .sort((a, b2) => b2.durationMs - a.durationMs);
  const longestSession = longestSessionArr.length
    ? { sessionKey: longestSessionArr[0].sessionKey, durationMs: longestSessionArr[0].durationMs }
    : null;

  // Most active day.
  let mostActiveDay: { date: string; tokens: number } | null = null;
  for (const [dateKey, tokens] of b.perDay) {
    if (!mostActiveDay || tokens > mostActiveDay.tokens) {
      mostActiveDay = { date: dateKey, tokens };
    }
  }

  const stats: CarouselTabStats = {
    empty: false,
    tabId,
    targetUserId,
    targetUserName,
    windowStart: bounds.start,
    windowEnd: bounds.end,
    totals: {
      tokens: b.tokens,
      costUsd: b.cost,
      sessions: b.perSession.size,
    },
    favoriteModel,
    hourly,
    heatmap,
    rankings: sharedRankings,
    activeDays,
    longestStreakDays,
    currentStreakDays,
    topSessions,
    longestSession,
    mostActiveDay,
  };
  return stats;
}

/**
 * Maximum distinct model series before we fold the long tail into a single
 * synthetic `'other'` row. Keeps the stacked-bar legend & color palette
 * from exploding when a workspace tries dozens of models in 30d.
 */
const MODELS_TAB_MAX_ROWS = 8;

/**
 * Build the per-model breakdown view (Models tab) from the 30d window builder.
 *
 * Trace: docs/usage-card-models/trace.md
 *
 * Pure transformation of `b.perDayModel` — no extra event scan. Returns
 * EmptyTabStats when no model events were recorded in the window.
 *
 * Sorting & folding:
 *  - Models are ranked by `totalTokens` desc (input+output+cacheRead+cacheCreate).
 *  - Top `MODELS_TAB_MAX_ROWS - 1` rows are kept; everything else is summed
 *    into a synthetic `'other'` row appended to the tail. When the source set
 *    already fits, no fold row is emitted.
 *  - `dayKeys` is always 30 entries (oldest → newest) regardless of activity,
 *    so the chart x-axis is stable across re-renders.
 */
function buildModelsTab(
  b: WindowBuilder,
  bounds: { start: string; end: string },
  targetUserId: string,
  targetUserName: string | undefined,
): ModelsTabStats | EmptyTabStats {
  // perDayModel is null on builders that didn't opt into per-(day,model) collection.
  // The aggregator only enables it for the 30d builder — anything else here is a bug.
  if (!b.perDayModel || b.perDayModel.size === 0) {
    return { empty: true, tabId: 'models', windowStart: bounds.start, windowEnd: bounds.end };
  }

  // Aggregate per-model totals across the window.
  const totals = new Map<string, ModelBucket>();
  for (const [, perModel] of b.perDayModel) {
    for (const [model, bucket] of perModel) {
      const acc = totals.get(model) ?? emptyModelBucket();
      acc.inputTokens += bucket.inputTokens;
      acc.outputTokens += bucket.outputTokens;
      acc.cacheReadInputTokens += bucket.cacheReadInputTokens;
      acc.cacheCreationInputTokens += bucket.cacheCreationInputTokens;
      totals.set(model, acc);
    }
  }

  // Defensive — if every bucket summed to zero (e.g. only `cost` was set),
  // treat as empty rather than emit a degenerate chart.
  const grandTotal = Array.from(totals.values()).reduce((s, buc) => s + bucketTotalTokens(buc), 0);
  if (grandTotal === 0) {
    return { empty: true, tabId: 'models', windowStart: bounds.start, windowEnd: bounds.end };
  }

  // Sort by total tokens desc; alpha-stable for ties so the rendered order
  // matches the implicit color assignment in `buildModelsTabOption`.
  const sorted = Array.from(totals.entries())
    .map(([model, buc]) => ({ model, buc, total: bucketTotalTokens(buc) }))
    .sort((a, c) => c.total - a.total || a.model.localeCompare(c.model));

  // Fold the long tail past MAX_ROWS-1 into a synthetic 'other' row.
  const kept = sorted.length <= MODELS_TAB_MAX_ROWS ? sorted : sorted.slice(0, MODELS_TAB_MAX_ROWS - 1);
  const tail = sorted.length <= MODELS_TAB_MAX_ROWS ? [] : sorted.slice(MODELS_TAB_MAX_ROWS - 1);

  const rows: ModelsTabRow[] = kept.map(({ model, buc }) => ({ model, ...buc }));

  if (tail.length > 0) {
    rows.push({
      model: OTHER_MODEL_ID,
      inputTokens: tail.reduce((s, x) => s + x.buc.inputTokens, 0),
      outputTokens: tail.reduce((s, x) => s + x.buc.outputTokens, 0),
      cacheReadInputTokens: tail.reduce((s, x) => s + x.buc.cacheReadInputTokens, 0),
      cacheCreationInputTokens: tail.reduce((s, x) => s + x.buc.cacheCreationInputTokens, 0),
    });
  }

  // Stable 30-day x-axis: always windowStart..windowStart+29 in KST,
  // even if some days have zero activity. Keeps the stacked bar's
  // x-axis consistent across re-renders for the same window.
  const dayKeys: string[] = [];
  for (let d = 0; d < 30; d++) dayKeys.push(kstShiftDay(bounds.start, d));

  // Build per-model per-day series. Tail folds into 'other' to match `rows`.
  const tailSet = new Set(tail.map((t) => t.model));
  const dailyByModel: Record<string, number[]> = {};
  for (const row of rows) dailyByModel[row.model] = new Array<number>(dayKeys.length).fill(0);
  for (let i = 0; i < dayKeys.length; i++) {
    const inner = b.perDayModel.get(dayKeys[i]);
    if (!inner) continue;
    for (const [model, bucket] of inner) {
      const seriesKey = tailSet.has(model) ? OTHER_MODEL_ID : model;
      const series = dailyByModel[seriesKey];
      if (!series) continue;
      series[i] += bucketTotalTokens(bucket);
    }
  }

  return {
    empty: false,
    tabId: 'models',
    targetUserId,
    targetUserName,
    windowStart: bounds.start,
    windowEnd: bounds.end,
    totalTokens: grandTotal,
    rows,
    dayKeys,
    dailyByModel,
  };
}

/** input + output + cacheRead + cacheCreate. Single-source-of-truth for "total tokens" of one model bucket / row. */
function bucketTotalTokens(b: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}): number {
  return b.inputTokens + b.outputTokens + b.cacheReadInputTokens + b.cacheCreationInputTokens;
}

// === Token Usage Helpers ===

function emptyTokenUsageAggregation(): TokenUsageAggregation {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreateTokens: 0,
    totalCostUsd: 0,
    byModel: {},
  };
}

function addModelToAggregation(agg: TokenUsageAggregation, model: string, usage: ModelTokenUsage): void {
  if (!agg.byModel[model]) {
    agg.byModel[model] = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    };
  }
  agg.byModel[model].inputTokens += usage.inputTokens;
  agg.byModel[model].outputTokens += usage.outputTokens;
  agg.byModel[model].cacheReadInputTokens += usage.cacheReadInputTokens;
  agg.byModel[model].cacheCreationInputTokens += usage.cacheCreationInputTokens;
  agg.byModel[model].costUsd += usage.costUsd;
}

function aggregateTokenEvents(events: MetricsEvent[]): TokenUsageAggregation {
  const agg = emptyTokenUsageAggregation();
  for (const e of events) {
    const m = e.metadata as unknown as TokenUsageMetadata | undefined;
    if (!m) continue;

    agg.totalInputTokens += m.inputTokens || 0;
    agg.totalOutputTokens += m.outputTokens || 0;
    agg.totalCacheReadTokens += m.cacheReadInputTokens || 0;
    agg.totalCacheCreateTokens += m.cacheCreationInputTokens || 0;
    agg.totalCostUsd += m.costUsd || 0;

    // Per-model breakdown
    if (m.modelBreakdown) {
      for (const [model, usage] of Object.entries(m.modelBreakdown)) {
        addModelToAggregation(agg, model, usage);
      }
    } else if (m.model) {
      addModelToAggregation(agg, m.model, {
        inputTokens: m.inputTokens || 0,
        outputTokens: m.outputTokens || 0,
        cacheReadInputTokens: m.cacheReadInputTokens || 0,
        cacheCreationInputTokens: m.cacheCreationInputTokens || 0,
        costUsd: m.costUsd || 0,
      });
    }
  }
  return agg;
}

function aggregateTokenEventsByUser(
  events: MetricsEvent[],
): Record<string, TokenUsageAggregation & { userName: string }> {
  const byUser: Record<string, TokenUsageAggregation & { userName: string }> = {};
  for (const e of events) {
    if (e.userId === 'assistant' || e.userId === 'unknown') continue;
    if (!byUser[e.userId]) {
      byUser[e.userId] = { ...emptyTokenUsageAggregation(), userName: e.userName || 'unknown' };
    }
    const userAgg = byUser[e.userId];
    const m = e.metadata as unknown as TokenUsageMetadata | undefined;
    if (!m) continue;

    userAgg.totalInputTokens += m.inputTokens || 0;
    userAgg.totalOutputTokens += m.outputTokens || 0;
    userAgg.totalCacheReadTokens += m.cacheReadInputTokens || 0;
    userAgg.totalCacheCreateTokens += m.cacheCreationInputTokens || 0;
    userAgg.totalCostUsd += m.costUsd || 0;
    // Update userName to latest
    if (e.userName && e.userName !== 'unknown') {
      userAgg.userName = e.userName;
    }

    if (m.modelBreakdown) {
      for (const [model, usage] of Object.entries(m.modelBreakdown)) {
        addModelToAggregation(userAgg, model, usage);
      }
    } else if (m.model) {
      addModelToAggregation(userAgg, m.model, {
        inputTokens: m.inputTokens || 0,
        outputTokens: m.outputTokens || 0,
        cacheReadInputTokens: m.cacheReadInputTokens || 0,
        cacheCreationInputTokens: m.cacheCreationInputTokens || 0,
        costUsd: m.costUsd || 0,
      });
    }
  }
  return byUser;
}

function aggregateTokenEventsByDay(
  events: MetricsEvent[],
  startDate: string,
  endDate: string,
): Array<{ date: string; totals: TokenUsageAggregation }> {
  // Group events by date
  const eventsByDate = new Map<string, MetricsEvent[]>();
  for (const e of events) {
    const date = timestampToDateInTz(e.timestamp);
    if (!eventsByDate.has(date)) eventsByDate.set(date, []);
    eventsByDate.get(date)!.push(e);
  }

  // Generate date range and aggregate each day.
  // NOTE: +09:00 (KST) is intentionally hardcoded to match REPORT_TIMEZONE ('Asia/Seoul')
  // used by dateFormatter throughout the metrics subsystem. If REPORT_TIMEZONE changes,
  // this offset must be updated accordingly.
  const result: Array<{ date: string; totals: TokenUsageAggregation }> = [];
  const current = new Date(startDate + 'T00:00:00+09:00');
  const end = new Date(endDate + 'T23:59:59+09:00');
  while (current <= end) {
    const date = dateFormatter.format(current);
    const dayEvents = eventsByDate.get(date) || [];
    result.push({ date, totals: aggregateTokenEvents(dayEvents) });
    current.setDate(current.getDate() + 1);
  }
  return result;
}

function determinePeriod(startDate: string, endDate: string): 'day' | 'week' | 'month' {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return 'day';
  if (diffDays <= 7) return 'week';
  return 'month';
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
  const prevTotal =
    previous.sessionsCreated +
    previous.turnsUsed +
    previous.prsCreated +
    previous.commitsCreated +
    previous.issuesCreated +
    previous.prsMerged +
    previous.codeLinesAdded;
  if (prevTotal === 0) {
    const baselinePctChange = (curr: number): number => (curr > 0 ? 100 : 0);
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

function computeDailyBreakdown(events: MetricsEvent[], weekStart: string): DailyBreakdown[] {
  const breakdown: DailyBreakdown[] = [];

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const d = new Date(date + 'T00:00:00Z');
    const dayOfWeek = d.getUTCDay();
    const dayLabel = DAY_LABELS[dayOfWeek];

    const dayEvents = events.filter((e) => {
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

function computeHourlyDistribution(events: MetricsEvent[]): HourlyDistribution[] {
  const hours = new Array(24).fill(0);

  for (const e of events) {
    const hour = getHourInTz(e.timestamp);
    hours[hour]++;
  }

  return hours.map((count, hour) => ({ hour, eventCount: count }));
}

function findPeakHour(distribution: HourlyDistribution[]): number | null {
  if (distribution.length === 0) return null;
  const max = distribution.reduce((best, curr) => (curr.eventCount > best.eventCount ? curr : best));
  return max.eventCount > 0 ? max.hour : null;
}

function computeAchievements(
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
    achievements.push({
      icon: '🏆',
      title: '퍼스널 베스트',
      description: `생산성 +${trend.productivityScoreDelta}% 향상!`,
    });
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
    achievements.push({
      icon: '🎯',
      title: '레이저 포커스',
      description: `세션당 ${d.avgTurnsPerSession}턴 — 집중력 MAX`,
    });
  }

  return achievements.slice(0, 5); // Max 5
}

function computeFunFacts(
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
    facts.push({
      icon: '🔄',
      text: `코드 변동: +${m.codeLinesAdded.toLocaleString()} / -${m.codeLinesDeleted.toLocaleString()} (순 ${netSign}${net.toLocaleString()})`,
    });
  }

  // Total events count
  facts.push({ icon: '📊', text: `총 이벤트: ${events.length.toLocaleString()}건 기록` });

  // Night owl / Early bird
  const nightEvents = hourlyDist.filter((h) => h.hour >= 22 || h.hour < 6).reduce((s, h) => s + h.eventCount, 0);
  const morningEvents = hourlyDist.filter((h) => h.hour >= 6 && h.hour < 12).reduce((s, h) => s + h.eventCount, 0);
  if (nightEvents > morningEvents && nightEvents > 10) {
    facts.push({ icon: '🦉', text: `야행성 모드: 심야 활동 ${nightEvents}건` });
  } else if (morningEvents > nightEvents && morningEvents > 10) {
    facts.push({ icon: '🐦', text: `얼리버드 모드: 오전 활동 ${morningEvents}건` });
  }

  // --- New fun facts ---

  // Busiest day (from dailyBreakdown if available)
  if (dailyBreakdown && dailyBreakdown.length > 0) {
    const busiestDay = dailyBreakdown.reduce((best, curr) => (curr.totalEvents > best.totalEvents ? curr : best));
    if (busiestDay.totalEvents > 0) {
      facts.push({
        icon: '📅',
        text: `가장 바쁜 날: ${busiestDay.dayLabel} (${busiestDay.date}, 이벤트 ${busiestDay.totalEvents}건)`,
      });
    }

    // Weekend warrior: any weekend day (토=6, 일=0) with activity
    const weekendActivity = dailyBreakdown
      .filter((day) => {
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
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const hourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIMEZONE,
  hour: 'numeric',
  hour12: false,
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

const dowFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIMEZONE,
  weekday: 'short',
});

function kstDayOfWeek(dateStr: string): number {
  // Use midday KST to avoid DST edge cases.
  const d = new Date(dateStr + 'T12:00:00+09:00');
  const short = dowFormatter.format(d);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[short] ?? 0;
}
