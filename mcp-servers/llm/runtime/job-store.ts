/**
 * FileJobStore — Durable JSON-file-backed job store.
 *
 * Stores jobs as a single JSON file at ~/.soma-work/llm-jobs.json.
 * Same atomic-write pattern as FileSessionStore.
 *
 * All reads return defensive copies to prevent callers from mutating
 * internal state without going through save().
 *
 * Known limitations:
 * - Single-writer assumption (same as session store).
 * - Completed/failed jobs retained for 24h then auto-pruned.
 *
 * @see Issue #334 — Persistent Job System
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Job, JobStore } from './types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.soma-work');
const DEFAULT_FILE = 'llm-jobs.json';
const MAX_JOBS = 100;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for completed/failed jobs
const MAX_RUNNING = 5;

export { MAX_RUNNING };

/** Shallow clone a Job to prevent external mutation of store internals. */
function cloneJob(job: Job): Job {
  return { ...job };
}

export class FileJobStore implements JobStore {
  private readonly filePath: string;
  private records: Map<string, Job> | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(DEFAULT_DIR, DEFAULT_FILE);
  }

  get(jobId: string): Job | undefined {
    this.ensureLoaded();
    const job = this.records!.get(jobId);
    return job ? cloneJob(job) : undefined;
  }

  getAll(): Job[] {
    this.ensureLoaded();
    return [...this.records!.values()].map(cloneJob);
  }

  getRunning(): Job[] {
    this.ensureLoaded();
    return [...this.records!.values()]
      .filter(j => j.status === 'running' || j.status === 'queued')
      .map(cloneJob);
  }

  save(job: Job): void {
    this.ensureLoaded();
    this.records!.set(job.id, cloneJob(job));
    this.pruneExcess();
    this.flush();
  }

  delete(jobId: string): void {
    this.ensureLoaded();
    this.records!.delete(jobId);
    this.flush();
  }

  prune(): void {
    this.ensureLoaded();
    const now = Date.now();
    let changed = false;
    for (const [id, job] of this.records!) {
      if (this.isExpired(job, now)) {
        this.records!.delete(id);
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  // ── Internal ──────────────────────────────────────────────

  /** Only completed/failed/cancelled jobs expire. Running/queued never expire by TTL. */
  private isExpired(job: Job, now: number = Date.now()): boolean {
    if (job.status === 'running' || job.status === 'queued') return false;
    const ref = job.completedAt ?? job.startedAt;
    return now - new Date(ref).getTime() > TTL_MS;
  }

  private ensureLoaded(): void {
    if (this.records !== null) return;
    this.records = new Map();
    try {
      const data = fs.readFileSync(this.filePath, 'utf-8');
      const arr: Job[] = JSON.parse(data);
      if (Array.isArray(arr)) {
        for (const j of arr) {
          // Recover stale running/queued jobs from previous crash
          if (j.status === 'running' || j.status === 'queued') {
            j.status = 'failed';
            j.phase = 'done';
            j.completedAt = new Date().toISOString();
            j.error = 'Recovered: server restarted while job was in progress';
          }
          this.records.set(j.id, j);
        }
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        try {
          const backupPath = this.filePath + '.corrupt.' + Date.now();
          fs.copyFileSync(this.filePath, backupPath);
        } catch { /* best-effort backup */ }
      }
    }
  }

  private pruneExcess(): void {
    const now = Date.now();
    // Remove expired
    for (const [id, job] of this.records!) {
      if (this.isExpired(job, now)) {
        this.records!.delete(id);
      }
    }
    // Trim oldest completed/failed if over limit
    if (this.records!.size > MAX_JOBS) {
      const terminal = [...this.records!.entries()]
        .filter(([, j]) => j.status !== 'running' && j.status !== 'queued')
        .sort((a, b) => new Date(a[1].startedAt).getTime() - new Date(b[1].startedAt).getTime());
      const toRemove = this.records!.size - MAX_JOBS;
      for (let i = 0; i < Math.min(toRemove, terminal.length); i++) {
        this.records!.delete(terminal[i][0]);
      }
    }
  }

  /** Atomic write: write to .tmp, then rename. */
  private flush(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = this.filePath + '.tmp';
    const arr = [...this.records!.values()];
    fs.writeFileSync(tmpPath, JSON.stringify(arr, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
