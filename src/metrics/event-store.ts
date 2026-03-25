/**
 * MetricsEventStore — JSONL-based event storage with daily file rotation.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 1
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Logger } from '../logger';
import { MetricsEvent, MetricsEventType } from './types';
import { DATA_DIR } from '../env-paths';

const logger = new Logger('MetricsEventStore');

/**
 * Convert a Unix ms timestamp to 'YYYY-MM-DD' string (UTC).
 */
function timestampToDateStr(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toISOString().slice(0, 10);
}

/**
 * Generate an inclusive list of date strings between start and end.
 */
function generateDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export class MetricsEventStore {
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || DATA_DIR;
  }

  /**
   * Get the file path for a given date string.
   */
  private getFilePath(dateStr: string): string {
    return path.join(this.dataDir, `metrics-events-${dateStr}.jsonl`);
  }

  /**
   * Append a single event to the date-partitioned JSONL file.
   * Fire-and-forget safe — errors are logged but not thrown.
   */
  async append(event: MetricsEvent): Promise<void> {
    try {
      const dateStr = timestampToDateStr(event.timestamp);
      const filePath = this.getFilePath(dateStr);
      const line = JSON.stringify(event) + '\n';

      await fs.promises.appendFile(filePath, line, 'utf-8');
      logger.debug(`Appended event ${event.eventType} to ${path.basename(filePath)}`);
    } catch (error) {
      logger.error('Failed to append metrics event', error);
    }
  }

  /**
   * Read all events in a date range (inclusive).
   * Returns events sorted by timestamp ascending.
   * Skips corrupted lines gracefully.
   */
  async readRange(startDate: string, endDate: string): Promise<MetricsEvent[]> {
    const dates = generateDateRange(startDate, endDate);
    const allEvents: MetricsEvent[] = [];

    for (const dateStr of dates) {
      const filePath = this.getFilePath(dateStr);

      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim().length > 0);

        for (let i = 0; i < lines.length; i++) {
          try {
            const event = JSON.parse(lines[i]) as MetricsEvent;
            allEvents.push(event);
          } catch {
            logger.warn(`Skipped corrupted line in ${path.basename(filePath)}:${i + 1}`);
          }
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // No events for this date — expected
          continue;
        }
        logger.error(`Failed to read metrics file for ${dateStr}`, error);
      }
    }

    // Sort by timestamp ascending
    allEvents.sort((a, b) => a.timestamp - b.timestamp);

    logger.debug(`Read ${allEvents.length} events from ${startDate} to ${endDate}`);
    return allEvents;
  }
}
