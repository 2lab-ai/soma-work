/**
 * CronStorage — Persistent cron job storage.
 * Trace: docs/cron-scheduler/trace.md, Scenarios 2-3
 *
 * Stores cron jobs as JSON in ${DATA_DIR}/cron-jobs.json.
 * Pattern: src/metrics/report-scheduler.ts (loadScheduleState/saveScheduleState)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('CronStorage');
const CRON_FILE = path.join(DATA_DIR, 'cron-jobs.json');

// --- Types ---

/** Execution mode: default queues behind active sessions; fastlane always opens a new thread. */
export type CronMode = 'default' | 'fastlane';

/** Where cron results are delivered. */
export type CronTarget = 'channel' | 'thread' | 'dm';

/** Model override config attached to a cron job. */
export interface CronModelConfig {
  type: 'default' | 'fast' | 'custom';
  /** Model identifier for custom type (e.g. "claude-sonnet-4-20250514") */
  model?: string;
  /** Reasoning effort for custom type */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Fast mode for custom type */
  fastMode?: boolean;
}

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
  /** Execution mode. Omitted = 'default' for backward compat. */
  mode?: CronMode;
  /** Model override. Omitted = 'default' (use session model). */
  modelConfig?: CronModelConfig;
  /** Delivery target. Omitted = 'channel' (new channel message). */
  target?: CronTarget;
}

interface CronData {
  jobs: CronJob[];
}

// --- Execution History Types ---

export interface CronExecutionRecord {
  jobId: string;
  jobName: string;
  executedAt: string;
  status: 'success' | 'failed' | 'queued';
  executionPath: 'idle_inject' | 'busy_queue' | 'new_thread' | 'dm' | 'thread_reply';
  error?: string;
  sessionKey?: string;
}

interface CronHistoryData {
  history: CronExecutionRecord[];
}

const MAX_HISTORY_PER_JOB = 20;

// --- 5-field cron expression matching ---

/**
 * Match a 5-field cron expression (min hour dom mon dow) against a Date.
 * Supports: numbers, *, comma-separated lists, ranges (1-5), step values (star/N).
 */
export function matchesCronExpression(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  // Use UTC methods — cron expressions are evaluated in UTC
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // 1-based
  const dow = date.getUTCDay(); // 0=Sunday

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
  return parts.some((part) => matchPart(part.trim(), value, min, max));
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
  if (!fields.every((f) => cronFieldRegex.test(f))) return false;

  // Range validation per field: [min, max]
  const ranges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 7], // day of week (0 and 7 = Sunday)
  ];

  for (let i = 0; i < 5; i++) {
    const [min, max] = ranges[i];
    const parts = fields[i].split(',');
    for (const part of parts) {
      // Check step value: */0 is invalid (division by zero)
      if (part.includes('/')) {
        const step = parseInt(part.split('/')[1], 10);
        if (isNaN(step) || step <= 0) return false;
      }
      // Check reversed ranges: 5-1 is invalid
      if (part.includes('-') && !part.startsWith('*')) {
        const rangePart = part.split('/')[0]; // strip step
        const [startStr, endStr] = rangePart.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (!isNaN(start) && !isNaN(end) && start > end) return false;
      }
    }
    // Check numeric values in range
    const nums = fields[i].match(/\d+/g);
    if (
      nums &&
      nums.some((n) => {
        const v = parseInt(n, 10);
        return v < min || v > max;
      })
    ) {
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
    return this.load().jobs.filter((j) => j.owner === owner);
  }

  /** Add a new job. Throws on duplicate name for same owner. */
  addJob(job: Omit<CronJob, 'id' | 'createdAt' | 'lastRunAt' | 'lastRunMinute' | 'lastRunDate'>): CronJob {
    const data = this.load();

    // Check duplicate
    const existing = data.jobs.find((j) => j.owner === job.owner && j.name === job.name);
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
    data.jobs = data.jobs.filter((j) => !(j.owner === owner && j.name === name));

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
    const job = data.jobs.find((j) => j.id === jobId);
    if (!job) return;

    job.lastRunAt = now.toISOString();
    job.lastRunMinute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
    this.save(data);
  }

  // --- Execution History ---

  private get historyFilePath(): string {
    return this.filePath.replace(/cron-jobs\.json$/, 'cron-history.json');
  }

  private loadHistory(): CronHistoryData {
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const raw = fs.readFileSync(this.historyFilePath, 'utf-8');
        return JSON.parse(raw) as CronHistoryData;
      }
    } catch (error) {
      logger.warn('Failed to load cron history, returning empty', error);
    }
    return { history: [] };
  }

  private saveHistory(data: CronHistoryData): void {
    try {
      const dir = path.dirname(this.historyFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = this.historyFilePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.historyFilePath);
    } catch (error) {
      logger.error('Failed to save cron history', error);
    }
  }

  /**
   * Record a cron execution. FIFO trims to MAX_HISTORY_PER_JOB per job.
   * Trace: docs/cron-execution-history/trace.md, S1 + S3
   */
  addExecution(record: Omit<CronExecutionRecord, 'executedAt'>): void {
    const data = this.loadHistory();

    data.history.push({
      ...record,
      executedAt: new Date().toISOString(),
    });

    // S3: FIFO trim — keep only last MAX_HISTORY_PER_JOB per job
    const byJob = new Map<string, CronExecutionRecord[]>();
    for (const r of data.history) {
      const arr = byJob.get(r.jobId) || [];
      arr.push(r);
      byJob.set(r.jobId, arr);
    }

    const trimmed: CronExecutionRecord[] = [];
    for (const [, records] of byJob) {
      if (records.length > MAX_HISTORY_PER_JOB) {
        trimmed.push(...records.slice(records.length - MAX_HISTORY_PER_JOB));
      } else {
        trimmed.push(...records);
      }
    }

    data.history = trimmed;
    this.saveHistory(data);
  }

  /**
   * Get execution history, optionally filtered by job name and/or owner.
   * Returns most recent first. Respects limit.
   * Trace: docs/cron-execution-history/trace.md, S2
   */
  getExecutionHistory(name?: string, owner?: string, limit?: number): CronExecutionRecord[] {
    const data = this.loadHistory();
    let results = data.history;

    if (name) {
      results = results.filter((r) => r.jobName === name);
    }

    if (owner) {
      const jobs = this.load().jobs;
      const ownerJobIds = new Set(jobs.filter((j) => j.owner === owner).map((j) => j.id));
      const ownerJobNames = new Set(jobs.filter((j) => j.owner === owner).map((j) => j.name));
      results = results.filter((r) => ownerJobIds.has(r.jobId) || ownerJobNames.has(r.jobName));
    }

    // Most recent first — reverse preserves insertion order for same-timestamp entries
    results = [...results].reverse();

    if (limit && limit > 0) {
      results = results.slice(0, limit);
    }

    return results;
  }
}
