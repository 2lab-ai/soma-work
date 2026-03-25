/**
 * Metrics module — exports factory for creating report components.
 * Used by CommandRouter to inject report dependencies into ReportHandler.
 */

export { MetricsEventStore } from './event-store';
export { MetricsEventEmitter, getMetricsEmitter, initMetricsEmitter } from './event-emitter';
export { ReportAggregator } from './report-aggregator';
export { ReportFormatter } from './report-formatter';
export { ReportPublisher } from './report-publisher';
export { ReportScheduler } from './report-scheduler';
export type {
  MetricsEvent,
  MetricsEventType,
  AggregatedMetrics,
  DailyReport,
  WeeklyReport,
  UserRanking,
  ScheduleState,
  ReportConfig,
} from './types';

import { Logger } from '../logger';
import { MetricsEventStore } from './event-store';
import { ReportAggregator } from './report-aggregator';
import { ReportFormatter } from './report-formatter';
import { ReportPublisher } from './report-publisher';
import { ReportScheduler } from './report-scheduler';
import { ReportConfig } from './types';

const logger = new Logger('Metrics');

/**
 * Create a report deps object for use by ReportHandler.
 * Lazy-initialized singleton.
 */
let _reportDeps: { aggregator: ReportAggregator; formatter: ReportFormatter } | null = null;

export function getReportDeps(): { aggregator: ReportAggregator; formatter: ReportFormatter } {
  if (!_reportDeps) {
    const store = new MetricsEventStore();
    _reportDeps = {
      aggregator: new ReportAggregator(store),
      formatter: new ReportFormatter(),
    };
  }
  return _reportDeps;
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
  postMessage(channel: string, text: string, options?: { blocks?: any[]; threadTs?: string }): Promise<{ ts?: string; channel?: string }>;
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
