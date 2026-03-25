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
}
