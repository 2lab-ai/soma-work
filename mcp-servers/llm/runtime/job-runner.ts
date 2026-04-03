/**
 * JobRunner — Manages job lifecycle for the LLM MCP server.
 *
 * Responsibilities:
 * - Generate job IDs (kind-timestamp36-random6)
 * - Run jobs synchronously or in background
 * - Track running promises for cancellation
 * - Write job logs
 * - Enforce max concurrent job limit
 *
 * The runner does NOT own the store — it receives it via constructor
 * so the router can share a single store instance.
 *
 * Cancellation note:
 * The LlmRuntime interface does not accept AbortSignal, so cancel()
 * cannot interrupt an in-flight runtime call. It marks the job as
 * cancelled and signals the abort, but the underlying provider call
 * continues until it finishes. The inflight entry is kept until the
 * promise settles so MAX_RUNNING accurately reflects true load.
 *
 * @see Issue #334 — Persistent Job System
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Backend, Job, JobKind, JobStore, LlmRuntime, SessionOptions } from './types.js';
import { MAX_RUNNING } from './job-store.js';

const LOG_DIR = path.join(os.homedir(), '.soma-work', 'jobs');

// ── Job ID Generation ─────────────────────────────────────

function generateJobId(kind: JobKind): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${kind}-${ts}-${rand}`;
}

function summarizePrompt(prompt: string): string {
  return prompt.length > 120 ? prompt.slice(0, 117) + '...' : prompt;
}

// ── JobRunner ─────────────────────────────────────────────

export interface JobRunnerDeps {
  jobStore: JobStore;
  runtimes: Record<Backend, LlmRuntime>;
}

export interface StartJobOptions {
  kind: JobKind;
  prompt: string;
  backend: Backend;
  model: string;
  sessionOptions: SessionOptions;
  sessionId?: string;
  backendSessionId?: string;
  background?: boolean;
}

export class JobRunner {
  private readonly store: JobStore;
  private readonly runtimes: Record<Backend, LlmRuntime>;
  /**
   * In-flight promises keyed by job ID.
   * Kept until the promise settles (not on cancel) so MAX_RUNNING
   * accurately counts real provider load.
   */
  private readonly inflight = new Map<string, { promise: Promise<void>; abortController: AbortController }>();

  constructor(deps: JobRunnerDeps) {
    this.store = deps.jobStore;
    this.runtimes = deps.runtimes;
  }

  /**
   * Start a new job. If background=true, returns immediately with the job.
   * Otherwise waits for completion and returns the finished job.
   */
  async startJob(opts: StartJobOptions): Promise<Job> {
    // Enforce max running limit (inflight count = true provider load)
    if (this.inflight.size >= MAX_RUNNING) {
      throw new Error(
        `Max concurrent jobs (${MAX_RUNNING}) reached. ` +
        `Cancel a running job or wait for one to complete.`,
      );
    }

    const jobId = generateJobId(opts.kind);
    const logFile = path.join(LOG_DIR, `${jobId}.log`);
    const now = new Date().toISOString();

    const job: Job = {
      id: jobId,
      kind: opts.kind,
      status: 'queued',
      phase: 'starting',
      backend: opts.backend,
      model: opts.model,
      sessionId: opts.sessionId,
      backendSessionId: opts.backendSessionId,
      promptSummary: summarizePrompt(opts.prompt),
      cwd: opts.sessionOptions.cwd,
      startedAt: now,
      logFile,
    };

    this.store.save(job);
    this.appendLog(logFile, `[${now}] Job created: ${jobId} (${opts.kind}/${opts.backend})`);

    if (opts.background) {
      // Fire-and-forget — caller gets the queued job immediately
      this.executeJob(job, opts);
      return job;
    }

    // Synchronous path — wait for completion
    await this.executeJob(job, opts);
    return this.store.get(jobId) ?? job;
  }

  /**
   * Cancel a running job.
   * Signals abort but does NOT remove from inflight — the promise
   * will settle naturally and clean up. This ensures MAX_RUNNING
   * accurately reflects true provider load.
   */
  cancel(jobId: string): Job | undefined {
    const job = this.store.get(jobId);
    if (!job) return undefined;

    if (job.status !== 'running' && job.status !== 'queued') {
      return job; // Already terminal
    }

    // Signal abort to the in-flight promise
    const flight = this.inflight.get(jobId);
    if (flight) {
      flight.abortController.abort();
    }

    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    this.store.save(job);
    this.appendLog(job.logFile, `[${job.completedAt}] Job cancelled`);

    return job;
  }

  /**
   * Get the in-flight job IDs (for shutdown).
   */
  getInflightIds(): string[] {
    return [...this.inflight.keys()];
  }

  // ── Private ─────────────────────────────────────────────

  private async executeJob(job: Job, opts: StartJobOptions): Promise<void> {
    const abortController = new AbortController();
    const execPromise = this.doExecute(job, opts, abortController.signal);
    this.inflight.set(job.id, { promise: execPromise, abortController });

    try {
      await execPromise;
    } finally {
      // Only remove from inflight after promise settles
      this.inflight.delete(job.id);
    }
  }

  private async doExecute(job: Job, opts: StartJobOptions, signal: AbortSignal): Promise<void> {
    try {
      // Transition to running
      job.status = 'running';
      job.phase = 'starting';
      this.store.save(job);
      this.appendLog(job.logFile, `[${new Date().toISOString()}] Status: running`);

      // Check abort before proceeding
      if (signal.aborted) throw new DOMException('Job cancelled', 'AbortError');

      const runtime = this.runtimes[opts.backend];
      let result;

      if (opts.backendSessionId) {
        // Resume existing session
        job.phase = 'investigating';
        this.store.save(job);
        result = await runtime.resumeSession(opts.backendSessionId, opts.prompt);
      } else {
        // Start new session
        job.phase = 'investigating';
        this.store.save(job);
        result = await runtime.startSession(opts.prompt, opts.sessionOptions);
      }

      if (signal.aborted) throw new DOMException('Job cancelled', 'AbortError');

      // Success
      job.status = 'completed';
      job.phase = 'done';
      job.completedAt = new Date().toISOString();
      job.result = result.content;
      job.backendSessionId = result.backendSessionId;
      this.store.save(job);
      this.appendLog(job.logFile, `[${job.completedAt}] Completed. Result length: ${result.content.length}`);

    } catch (err: any) {
      if (err?.name === 'AbortError' || signal.aborted) {
        // Already handled by cancel() — just ensure store is consistent
        const current = this.store.get(job.id);
        if (current && current.status !== 'cancelled') {
          job.status = 'cancelled';
          job.completedAt = new Date().toISOString();
          this.store.save(job);
        }
        return;
      }

      job.status = 'failed';
      job.phase = 'done';
      job.completedAt = new Date().toISOString();
      job.error = err?.message ?? String(err);
      this.store.save(job);
      this.appendLog(job.logFile, `[${job.completedAt}] Failed: ${job.error}`);
    }
  }

  private appendLog(logFile: string, line: string): void {
    try {
      const dir = path.dirname(logFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(logFile, line + '\n', 'utf-8');
    } catch { /* best-effort logging */ }
  }
}
