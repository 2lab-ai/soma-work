/**
 * CronStorage — Persistent cron job storage.
 * Trace: docs/cron-scheduler/trace.md, Scenarios 2-3
 *
 * Stores cron jobs as JSON at the file path supplied by the caller.
 * Pattern: src/metrics/report-scheduler.ts (loadScheduleState/saveScheduleState)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { StderrLogger } from '../stderr-logger';

const logger = new StderrLogger('CronStorage');

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
  /**
   * Non-owner uids the owner allowed to fire this job on demand (`cron run` /
   * the ▶ card button). The fire still runs with OWNER identity — the allowlist
   * only decides who may pull the trigger. Lives on the job, so a rename
   * carries the grants and a delete disposes of them.
   */
  runAllowlist?: string[];
}

/** May `userId` fire this job on demand? Owner always may; others need the allowlist. */
export function isRunAllowed(job: CronJob, userId: string): boolean {
  return job.owner === userId || (job.runAllowlist?.includes(userId) ?? false);
}

interface CronData {
  jobs: CronJob[];
}

/**
 * Presence-aware patch for updateJob. Omitted key = no change.
 * `null` on nullable/optional keys = clear the field:
 * - `modelConfig: null` → remove override (fire-time model = creator's current default model)
 * - `target: null` → remove override (deliver as new channel message)
 * - `mode: null` → remove override (default queueing)
 * - `threadTs: null` → clear thread anchor
 */
export interface CronJobPatch {
  /** Rename. Throws DUPLICATE_NAME when another job of the same owner already uses it. */
  name?: string;
  expression?: string;
  prompt?: string;
  channel?: string;
  threadTs?: string | null;
  mode?: CronMode | null;
  modelConfig?: CronModelConfig | null;
  target?: CronTarget | null;
  /** `null` clears every on-demand run grant. */
  runAllowlist?: string[] | null;
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
  /**
   * Who pulled the trigger when it was NOT the owner — an allowlisted user or
   * an owner-approved one-off `cron run`. Absent for scheduled fires and for
   * the owner firing their own job.
   */
  triggeredBy?: string;
}

interface CronHistoryData {
  history: CronExecutionRecord[];
}

const MAX_HISTORY_PER_JOB = 20;

// --- 5-field cron expression matching ---
// The hand-rolled engine (matchesCronExpression / isValidCronExpression /
// isValidCronName) moved verbatim to the shared soma-lib package in v0.3.0
// (src/domain/cron-expression — Step 3 of the convergence roadmap). Re-export
// so every existing import path keeps working unchanged. UTC semantics and
// the B1 timezone contract are pinned by soma-lib's own test suite.
export { isValidCronExpression, isValidCronName, matchesCronExpression } from 'soma-lib';

// --- Storage class ---

export class CronStorage {
  private filePath: string;

  constructor(filePath: string) {
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

  /**
   * Patch a job addressed by (owner, name). Presence-aware: omitted keys are
   * untouched; `null` clears optional overrides (see CronJobPatch).
   * Bookkeeping fields (id, createdAt, lastRunAt, lastRunMinute, lastRunDate)
   * are always preserved. Returns the updated job, or null if not found.
   */
  updateJob(owner: string, name: string, patch: CronJobPatch): CronJob | null {
    const data = this.load();
    const job = data.jobs.find((j) => j.owner === owner && j.name === name);
    if (!job) return null;

    if (patch.name !== undefined && patch.name !== job.name) {
      const clash = data.jobs.some((j) => j.owner === owner && j.name === patch.name);
      if (clash) {
        throw new Error(`DUPLICATE_NAME: Cron job '${patch.name}' already exists for this user`);
      }
      job.name = patch.name;
    }
    if (patch.expression !== undefined) job.expression = patch.expression;
    if (patch.prompt !== undefined) job.prompt = patch.prompt;
    if (patch.channel !== undefined) job.channel = patch.channel;
    if (patch.threadTs !== undefined) job.threadTs = patch.threadTs;
    if (patch.mode !== undefined) {
      if (patch.mode === null) delete job.mode;
      else job.mode = patch.mode;
    }
    if (patch.modelConfig !== undefined) {
      if (patch.modelConfig === null) delete job.modelConfig;
      else job.modelConfig = patch.modelConfig;
    }
    if (patch.target !== undefined) {
      if (patch.target === null) delete job.target;
      else job.target = patch.target;
    }
    if (patch.runAllowlist !== undefined) {
      if (patch.runAllowlist === null) delete job.runAllowlist;
      else job.runAllowlist = [...new Set(patch.runAllowlist)];
    }

    this.save(data);
    logger.info('Cron job updated', { id: job.id, name: job.name, owner: job.owner });
    return job;
  }

  /**
   * Add a user to the job's on-demand run allowlist (idempotent).
   * Returns the updated job, or null when the job is gone.
   */
  allowRun(owner: string, name: string, userId: string): CronJob | null {
    return this.mutateAllowlist(
      (j) => j.owner === owner && j.name === name,
      (list) => (list.includes(userId) ? list : [...list, userId]),
    );
  }

  /**
   * Same as {@link allowRun} but addressed by the job's immutable id — the
   * form the grant flow uses, because a job can be renamed between the ask
   * and the owner's click and consent belongs to the JOB, not to a name.
   */
  allowRunById(jobId: string, userId: string): CronJob | null {
    return this.mutateAllowlist(
      (j) => j.id === jobId,
      (list) => (list.includes(userId) ? list : [...list, userId]),
    );
  }

  /** Remove a user from the job's run allowlist. Null when the job is gone. */
  revokeRun(owner: string, name: string, userId: string): CronJob | null {
    return this.mutateAllowlist(
      (j) => j.owner === owner && j.name === name,
      (list) => list.filter((u) => u !== userId),
    );
  }

  /**
   * Read-modify-write of one job's allowlist. Narrow on purpose: it reloads
   * immediately before mutating and writes only that field's new value, so a
   * concurrent writer (the MCP cron server process) can at worst lose this
   * one grant/revoke instead of a whole stale list clobbering theirs.
   */
  private mutateAllowlist(match: (j: CronJob) => boolean, next: (list: string[]) => string[]): CronJob | null {
    const data = this.load();
    const job = data.jobs.find(match);
    if (!job) return null;

    const updated = next(job.runAllowlist ?? []);
    const current = job.runAllowlist ?? [];
    if (updated.length === current.length && updated.every((u, i) => u === current[i])) return job;

    if (updated.length === 0) delete job.runAllowlist;
    else job.runAllowlist = updated;
    this.save(data);
    logger.info('Cron run allowlist updated', { name: job.name, owner: job.owner, allowlist: updated });
    return job;
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

  /**
   * History lives in a sibling file. The canonical `cron-jobs.json` maps to
   * `cron-history.json`; ANY other filename derives `<name>-history.json`.
   *
   * The previous `String.replace(/cron-jobs\.json$/…)` silently returned the
   * jobs path itself for every other filename, so the first `addExecution`
   * would write the history array over the jobs array. It only ever appeared
   * benign because the resulting `data.history.push` on a jobs object threw
   * and the caller swallowed it — losing history instead of losing jobs.
   */
  private get historyFilePath(): string {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    if (base === 'cron-jobs.json') return path.join(dir, 'cron-history.json');
    return path.join(dir, `${base.replace(/\.json$/, '')}-history.json`);
  }

  private loadHistory(): CronHistoryData {
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const raw = fs.readFileSync(this.historyFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<CronHistoryData>;
        // A file that parses but has no `history` array (wrong file, older
        // shape) must not hand callers `undefined` to iterate over.
        return { history: Array.isArray(parsed?.history) ? parsed.history : [] };
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
