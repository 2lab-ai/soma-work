/**
 * Deploy lanes — fire the cron jobs that asked to run when a deploy lands.
 *
 * The deploy workflow runs in whoever asked for the deploy's session and emits a
 * `deploy_completed` directive per repo once the merge landed and the deployment
 * succeeded (packages/slack/src/directives/deploy-completed-directive.ts). A cron
 * job opts in with `onDeploy: [{ repo, target }]`; that entry is the OWNER's
 * consent, so the fire skips the run-allowlist / permission prompt that a
 * non-owner `cron run` goes through. It is still a real cron fire
 * (`CronScheduler.runJobNow`): owner identity, the job's own target/mode/model,
 * execution history attributed to the deployer.
 *
 * The signal is model output: the lane must verify the deploy itself and be
 * idempotent. The dedupe below only stops a repeated directive for the same merge
 * commit; it lives in memory, so a restart forgets it.
 */

import type { DeployCompletedPayload } from '@soma/slack/directives/deploy-completed-directive';
import * as path from 'path';
import { type CronJob, CronStorage, jobMatchesDeploy } from 'somalib/cron/cron-storage';
import { type CronScheduler, getActiveCronScheduler } from './cron-scheduler';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

const logger = new Logger('DeployLanes');

/** A (job, merge commit) pair fires at most once in this window. */
export const DEPLOY_LANE_DEDUPE_MS = 6 * 60 * 60 * 1000;

/**
 * How long to wait for a fire to report back. `runJobNow` resolves only when the
 * lane's turn ends on the new-thread / idle-inject paths, which can take hours;
 * every failure branch settles well inside this. Still running after it = started.
 */
const DEFAULT_SETTLE_MS = 5_000;

export interface DeployLaneContext {
  channel: string;
  threadTs: string;
  /** Who ran the deploy — recorded as `triggeredBy` in cron history. */
  user: string;
}

export interface DeployLaneTriggerOptions {
  /** Test seam — defaults to DATA_DIR/cron-jobs.json (same file the scheduler reads). */
  storagePath?: string;
  /** Test seam — defaults to the running scheduler. */
  getScheduler?: () => Pick<CronScheduler, 'runJobNow'> | null;
  now?: () => number;
  settleMs?: number;
}

type FireOutcome = { job: CronJob; ok: boolean; detail?: string };

export class DeployLaneTrigger {
  /** `${jobId}:${after}` → when it fired. */
  private readonly fired = new Map<string, number>();

  constructor(private readonly opts: DeployLaneTriggerOptions = {}) {}

  /**
   * Fire every job registered for this repo + target. Returns the one-line reply
   * for the deploy thread, or undefined when there is nothing to say (no
   * scheduler, no match, or every match already fired for this merge commit).
   */
  async handle(payload: DeployCompletedPayload, ctx: DeployLaneContext): Promise<string | undefined> {
    const scheduler = (this.opts.getScheduler ?? getActiveCronScheduler)();
    if (!scheduler) {
      logger.info('deploy_completed ignored — cron scheduler not running', { repo: payload.repo });
      return undefined;
    }

    let jobs: CronJob[];
    try {
      jobs = new CronStorage(this.opts.storagePath ?? path.join(DATA_DIR, 'cron-jobs.json')).getAll();
    } catch (error) {
      logger.warn('deploy_completed ignored — cron jobs unreadable', { error: (error as Error).message });
      return undefined;
    }
    // A file that parses but is not `{ jobs: [...] }` must not throw out of here.
    const matched = (Array.isArray(jobs) ? jobs : []).filter((job) =>
      jobMatchesDeploy(job, payload.repo, payload.target),
    );
    if (matched.length === 0) {
      logger.info('deploy_completed matched no lane', { repo: payload.repo, target: payload.target });
      return undefined;
    }

    const now = (this.opts.now ?? Date.now)();
    for (const [key, at] of this.fired) {
      if (now - at >= DEPLOY_LANE_DEDUPE_MS) this.fired.delete(key);
    }
    const after = payload.after.toLowerCase();
    const fresh = matched.filter((job) => {
      const key = `${job.id}:${after}`;
      if (this.fired.has(key)) {
        logger.info('deploy_completed already fired this lane for this commit', { name: job.name, after });
        return false;
      }
      this.fired.set(key, now);
      return true;
    });
    if (fresh.length === 0) return undefined;

    const outcomes = await Promise.all(fresh.map((job) => this.fire(scheduler, job, ctx.user)));
    return describeOutcomes(payload, outcomes);
  }

  private async fire(
    scheduler: Pick<CronScheduler, 'runJobNow'>,
    job: CronJob,
    triggeredBy: string,
  ): Promise<FireOutcome> {
    logger.info('deploy_completed firing lane', { name: job.name, owner: job.owner, triggeredBy });
    const run = Promise.resolve()
      .then(() => scheduler.runJobNow(job.owner, job.name, { triggeredBy: triggeredBy || undefined }))
      .then(
        (result): FireOutcome => ({ job, ok: result.ok, detail: result.message }),
        (error): FireOutcome => ({ job, ok: false, detail: (error as Error)?.message ?? String(error) }),
      );
    // Log the late result of a lane that outlived the settle window.
    run.then((outcome) => {
      if (!outcome.ok) logger.warn('deploy lane fire failed', { name: job.name, detail: outcome.detail });
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = new Promise<FireOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ job, ok: true }), this.opts.settleMs ?? DEFAULT_SETTLE_MS);
    });
    try {
      return await Promise.race([run, running]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Where a fired job's output lands — mirrors CronScheduler.executeJob's target dispatch. */
function describeDestination(job: CronJob): string {
  if (job.target === 'dm') return `<@${job.owner}> DM`;
  if (job.target === 'thread') return `<#${job.channel}> 스레드`;
  return `<#${job.channel}>`;
}

function describeOutcomes(payload: DeployCompletedPayload, outcomes: FireOutcome[]): string {
  const deploy = `${payload.repo} → ${payload.target} (${payload.after.slice(0, 7)})`;
  const started = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  const startedText = started.map((o) => `*${o.job.name}* → ${describeDestination(o.job)}`).join(', ');
  const failedText = failed.map((o) => `*${o.job.name}* (${o.detail ?? 'unknown error'})`).join(', ');

  if (failed.length === 0) return `▶ 배포 레인 시작 — ${deploy}: ${startedText}`;
  if (started.length === 0) return `⚠️ 배포 레인 미발동 — ${deploy}: ${failedText}`;
  return `▶ 배포 레인 시작 — ${deploy}: ${startedText} · ⚠️ 미발동: ${failedText}`;
}
