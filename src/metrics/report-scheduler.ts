/**
 * ReportScheduler — Automatic daily/weekly report scheduling via setInterval polling.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 6
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';
import { DATA_DIR } from '../env-paths';
import { ReportAggregator } from './report-aggregator';
import { ReportFormatter } from './report-formatter';
import { ReportPublisher } from './report-publisher';
import { ReportConfig, ScheduleState } from './types';

const logger = new Logger('ReportScheduler');
const POLL_INTERVAL_MS = 60_000; // 1 minute
const SCHEDULE_FILE = path.join(DATA_DIR, 'report-schedule.json');

/**
 * Get current date/time in configured timezone.
 * Returns { year, month, day, hour, minute, dayOfWeek, dateStr }
 */
function nowInTimezone(timezone: string): {
  hour: number;
  minute: number;
  dayOfWeek: number;
  dateStr: string;
} {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '0';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);

  // Get day of week (0=Sunday, 1=Monday, ...)
  const dateInTz = new Date(`${year}-${month}-${day}T00:00:00`);
  const dayOfWeek = dateInTz.getDay();

  return { hour, minute, dayOfWeek, dateStr: `${year}-${month}-${day}` };
}

/**
 * Subtract one day from a YYYY-MM-DD string.
 */
function yesterday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Get last Monday's YYYY-MM-DD from a given date string.
 */
function lastMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon
  const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const lastMon = daysToLastMonday + 7; // go to PREVIOUS week's Monday
  d.setUTCDate(d.getUTCDate() - lastMon);
  return d.toISOString().slice(0, 10);
}

export class ReportScheduler {
  private aggregator: ReportAggregator;
  private formatter: ReportFormatter;
  private publisher: ReportPublisher;
  private config: ReportConfig;
  private scheduleState: ScheduleState;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    aggregator: ReportAggregator,
    formatter: ReportFormatter,
    publisher: ReportPublisher,
    config: ReportConfig,
  ) {
    this.aggregator = aggregator;
    this.formatter = formatter;
    this.publisher = publisher;
    this.config = config;
    this.scheduleState = this.loadScheduleState();
  }

  /**
   * Start the scheduler. Polls every minute.
   */
  start(): void {
    if (this.timer) return;
    logger.info('Report scheduler started', {
      channelId: this.config.channelId,
      timezone: this.config.timezone,
      dailyHour: this.config.dailyHour,
      weeklyDay: this.config.weeklyDay,
      weeklyHour: this.config.weeklyHour,
    });
    this.timer = setInterval(() => this.checkAndRun(), POLL_INTERVAL_MS);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Report scheduler stopped');
    }
  }

  /**
   * Check current time and trigger reports if needed.
   */
  async checkAndRun(): Promise<void> {
    const now = nowInTimezone(this.config.timezone);

    // Daily check: at configured hour, minute 0
    try {
      if (now.hour === this.config.dailyHour && now.minute === 0) {
        if (this.scheduleState.lastDailyDate !== now.dateStr) {
          const reportDate = yesterday(now.dateStr);
          logger.info(`Daily report triggered for ${reportDate}`);

          const report = await this.aggregator.aggregateDaily(reportDate);
          const formatted = this.formatter.formatDaily(report);
          const result = await this.publisher.publish(this.config.channelId, formatted.blocks, formatted.text);

          // Only mark as sent if publish succeeded (spec: retry next minute on failure)
          if (result) {
            this.scheduleState.lastDailyDate = now.dateStr;
            this.saveScheduleState();
          }
        }
      }
    } catch (error) {
      logger.error('Daily report check failed', error);
    }

    // Weekly check: on configured day, at configured hour, minute 0
    try {
      if (now.dayOfWeek === this.config.weeklyDay && now.hour === this.config.weeklyHour && now.minute === 0) {
        if (this.scheduleState.lastWeeklyDate !== now.dateStr) {
          const weekStart = lastMonday(now.dateStr);
          logger.info(`Weekly report triggered for week ${weekStart}`);

          const report = await this.aggregator.aggregateWeekly(weekStart);
          const formatted = this.formatter.formatWeekly(report);
          const result = await this.publisher.publish(this.config.channelId, formatted.blocks, formatted.text);

          // Only mark as sent if publish succeeded (spec: retry next minute on failure)
          if (result) {
            this.scheduleState.lastWeeklyDate = now.dateStr;
            this.saveScheduleState();
          }
        }
      }
    } catch (error) {
      logger.error('Weekly report check failed', error);
    }
  }

  /**
   * Load schedule state from disk. Returns empty state on error.
   */
  private loadScheduleState(): ScheduleState {
    try {
      if (fs.existsSync(SCHEDULE_FILE)) {
        const raw = fs.readFileSync(SCHEDULE_FILE, 'utf-8');
        return JSON.parse(raw) as ScheduleState;
      }
    } catch (error) {
      logger.warn('Failed to load schedule state, resetting', error);
    }
    return {};
  }

  /**
   * Save schedule state to disk.
   */
  private saveScheduleState(): void {
    try {
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(this.scheduleState, null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save schedule state', error);
    }
  }

  /**
   * Set schedule state directly (for testing).
   */
  setScheduleState(state: ScheduleState): void {
    this.scheduleState = state;
  }
}
