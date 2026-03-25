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

import { MetricsEventStore } from './event-store';
import { ReportAggregator } from './report-aggregator';
import { ReportFormatter } from './report-formatter';

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
