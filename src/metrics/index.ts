/**
 * Metrics module — exports factory for creating report components.
 * Used by CommandRouter to inject report dependencies into ReportHandler.
 */

export type {
  Achievement,
  AggregatedMetrics,
  DailyBreakdown,
  DailyReport,
  DerivedMetrics,
  EnrichedDailyReport,
  EnrichedWeeklyReport,
  FunFact,
  HourlyDistribution,
  MetricsEvent,
  MetricsEventType,
  ReportConfig,
  ScheduleState,
  TrendComparison,
  UserRanking,
  WeeklyReport,
} from './types';

import { Logger } from '../logger';
import { MetricsEventStore } from './event-store';
import { LinkLeakReporter, type LinkLeakReporterDeps } from './link-leak-report';
import { ReportAggregator } from './report-aggregator';
import { ReportFormatter } from './report-formatter';
import { ReportPublisher } from './report-publisher';
import { ReportScheduler } from './report-scheduler';
import type { ReportConfig } from './types';

const logger = new Logger('Metrics');

/**
 * Create a report deps object for use by ReportHandler.
 * Lazy-initialized singleton.
 */
let _reportDeps: {
  aggregator: ReportAggregator;
  formatter: ReportFormatter;
  linkLeak: { runNow(): Promise<{ text: string; blocks: any[] } | undefined> };
} | null = null;

export function getReportDeps(): {
  aggregator: ReportAggregator;
  formatter: ReportFormatter;
  linkLeak: { runNow(): Promise<{ text: string; blocks: any[] } | undefined> };
} {
  if (!_reportDeps) {
    const store = new MetricsEventStore();
    _reportDeps = {
      aggregator: new ReportAggregator(store),
      formatter: new ReportFormatter(),
      // `report leaks` (#835): the reporter exists only when its channel is configured.
      linkLeak: { runNow: async () => _linkLeak?.runNow() },
    };
  }
  return _reportDeps;
}

let _linkLeak: LinkLeakReporter | null = null;

/**
 * The task-card link leak report (#835). The caller wires the data sources. `report leaks` works whenever it exists;
 * the daily post runs only when `schedule` is true (a channel is configured).
 */
export function startLinkLeakReport(deps: LinkLeakReporterDeps, schedule: boolean): LinkLeakReporter {
  stopLinkLeakReport();
  _linkLeak = new LinkLeakReporter(deps);
  if (schedule) {
    _linkLeak.start();
    logger.info('Link leak report scheduled', { hour: deps.hour, timezone: deps.timezone });
  }
  return _linkLeak;
}

export function stopLinkLeakReport(): void {
  _linkLeak?.stop();
  _linkLeak = null;
}

/**
 * Start the report scheduler if REPORT_CHANNEL_ID is configured.
 * Called from app bootstrap after Slack app is started.
 *
 * @param slackApi - Object with postMessage method (e.g., SlackApiHelper)
 * @returns The scheduler instance (for shutdown), or null if not configured.
 */
let _scheduler: ReportScheduler | null = null;

export function startReportScheduler(slackApi: {
  postMessage(
    channel: string,
    text: string,
    options?: { blocks?: any[]; threadTs?: string },
  ): Promise<{ ts?: string; channel?: string }>;
}): ReportScheduler | null {
  const channelId = process.env.REPORT_CHANNEL_ID;
  if (!channelId) {
    logger.info('REPORT_CHANNEL_ID not set — report scheduler disabled');
    return null;
  }

  const config: ReportConfig = {
    channelId,
    timezone: process.env.REPORT_TIMEZONE || 'Asia/Seoul',
    dailyHour: parseInt(process.env.REPORT_DAILY_HOUR || '0', 10),
    weeklyDay: parseInt(process.env.REPORT_WEEKLY_DAY || '1', 10),
    weeklyHour: parseInt(process.env.REPORT_WEEKLY_HOUR || '9', 10),
  };

  const deps = getReportDeps();
  const publisher = new ReportPublisher(slackApi);
  _scheduler = new ReportScheduler(deps.aggregator, deps.formatter, publisher, config);
  _scheduler.start();

  logger.info('Report scheduler started', {
    channelId: config.channelId,
    timezone: config.timezone,
    dailyHour: config.dailyHour,
    weeklyDay: config.weeklyDay,
    weeklyHour: config.weeklyHour,
  });

  return _scheduler;
}

/**
 * Stop the report scheduler (for graceful shutdown).
 */
export function stopReportScheduler(): void {
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
}
