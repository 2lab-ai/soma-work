/**
 * CronStorage — Persistent cron job storage.
 * Trace: docs/cron-scheduler/trace.md, Scenarios 2-3
 *
 * Stores cron jobs as JSON in ${DATA_DIR}/cron-jobs.json.
 * Pattern: src/metrics/report-scheduler.ts (loadScheduleState/saveScheduleState)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('CronStorage');
const CRON_FILE = path.join(DATA_DIR, 'cron-jobs.json');

// --- Types ---

export interface CronJob {
  id: string;
  name: string;
  expression: string;
  prompt: string;
  owner: string;
  channel: string;
  threadTs: string | null;
  createdAt: string;
  lastRunAt: string | null;
  /** Dedup key: YYYY-MM-DDTHH:mm — prevents re-fire within the same minute */
  lastRunMinute: string | null;
  /** @deprecated Use lastRunMinute. Kept for backward compat with existing data. */
  lastRunDate?: string | null;
}

interface CronData {
  jobs: CronJob[];
}

// --- 5-field cron expression matching ---

/**
 * Match a 5-field cron expression (min hour dom mon dow) against a Date.
 * Supports: numbers, *, comma-separated lists, ranges (1-5), step values (star/N).
 */
export function matchesCronExpression(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // 1-based
  const dow = date.getDay(); // 0=Sunday

  return (
    matchField(fields[0], minute, 0, 59) &&
    matchField(fields[1], hour, 0, 23) &&
    matchField(fields[2], dom, 1, 31) &&
    matchField(fields[3], month, 1, 12) &&
    matchField(fields[4], dow, 0, 7) // 0 and 7 both = Sunday
  );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  // Handle comma-separated values
  const parts = field.split(',');
  return parts.some(part => matchPart(part.trim(), value, min, max));
}

function matchPart(part: string, value: number, min: number, max: number): boolean {
  // Wildcard
  if (part === '*') return true;

  // Step: */N or range/N
  if (part.includes('/')) {
    const [rangePart, stepStr] = part.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;

    let start = min;
    let end = max;
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        [start, end] = rangePart.split('-').map(Number);
      } else {
        start = parseInt(rangePart, 10);
      }
    }

    for (let i = start; i <= end; i += step) {
      if (i === value) return true;
    }
    return false;
  }

  // Range: N-M
  if (part.includes('-')) {
    const [startStr, endStr] = part.split('-');
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return value >= start && value <= end;
  }

  // Exact number
  const num = parseInt(part, 10);
  return num === value || (max === 7 && num === 7 && value === 0); // Sunday: 0 === 7
}

// --- Validation ---

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  // Regex: *, N, N-M, */N, N-M/N, comma-separated combinations
  const cronFieldRegex = /^((\*|\d+(-\d+)?)(\/\d+)?)(,((\*|\d+(-\d+)?)(\/\d+)?))*$/;
  if (!fields.every(f => cronFieldRegex.test(f))) return false;

  // Range validation per field: [min, max]
  const ranges: [number, number][] = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day of month
    [1, 12],  // month
    [0, 7],   // day of week (0 and 7 = Sunday)
  ];

  for (let i = 0; i < 5; i++) {
    const [min, max] = ranges[i];
    // Extract all numeric values from the field
    const nums = fields[i].match(/\d+/g);
    if (nums && nums.some(n => {
      const v = parseInt(n, 10);
      return v < min || v > max;
    })) {
      return false;
    }
  }

  return true;
}

export function isValidCronName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}

// --- Storage class ---

export class CronStorage {
  private filePath: string;

  constructor(filePath: string = CRON_FILE) {
    this.filePath = filePath;
  }

  /** Load all jobs from disk. Returns empty on error. */
  private load(): CronData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(raw) as CronData;
      }
    } catch (error) {
      logger.warn('Failed to load cron jobs, returning empty', error);
    }
    return { jobs: [] };
  }

  /** Atomic write: tmp + rename. Pattern: report-scheduler.ts:187-195 */
  private save(data: CronData): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      logger.error('Failed to save cron jobs', error);
      throw error;
    }
  }

  /** Get all jobs. */
  getAll(): CronJob[] {
    return this.load().jobs;
  }

  /** Get jobs for a specific owner. */
  getJobsByOwner(owner: string): CronJob[] {
    return this.load().jobs.filter(j => j.owner === owner);
  }

  /** Add a new job. Throws on duplicate name for same owner. */
  addJob(job: Omit<CronJob, 'id' | 'createdAt' | 'lastRunAt' | 'lastRunMinute' | 'lastRunDate'>): CronJob {
    const data = this.load();

    // Check duplicate
    const existing = data.jobs.find(j => j.owner === job.owner && j.name === job.name);
    if (existing) {
      throw new Error(`DUPLICATE_NAME: Cron job '${job.name}' already exists for this user`);
    }

    const newJob: CronJob = {
      ...job,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastRunMinute: null,
    };

    data.jobs.push(newJob);
    this.save(data);

    logger.info('Cron job created', { id: newJob.id, name: newJob.name, owner: newJob.owner });
    return newJob;
  }

  /** Remove a job by owner + name. Returns true if removed, false if not found. */
  removeJob(owner: string, name: string): boolean {
    const data = this.load();
    const before = data.jobs.length;
    data.jobs = data.jobs.filter(j => !(j.owner === owner && j.name === name));

    if (data.jobs.length === before) {
      return false; // Not found
    }

    this.save(data);
    logger.info('Cron job deleted', { name, owner });
    return true;
  }

  /** Update lastRunAt and lastRunMinute for a job. */
  updateLastRun(jobId: string, now: Date): void {
    const data = this.load();
    const job = data.jobs.find(j => j.id === jobId);
    if (!job) return;

    job.lastRunAt = now.toISOString();
    job.lastRunMinute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
    this.save(data);
  }
}
