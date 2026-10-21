/**
 * Deploy lanes — fire the cron jobs that asked to run when a deploy lands.
 *
 * The deploy workflow runs in whoever asked for the deploy's session and emits a
 * `deploy_completed` directive per repo once the merge landed
 * (packages/slack/src/directives/deploy-completed-directive.ts); the stream
 * executor forwards it here only from a deploy-workflow session. A cron job opts
 * in with `onDeploy: [{ repo, target }]`; that entry is the OWNER's consent, so
 * the fire skips the run-allowlist / permission prompt that a non-owner
 * `cron run` goes through. It is a real cron fire (`CronScheduler.runJobNow`):
 * owner identity, the job's model, execution history attributed to the deployer.
 * Two things differ from a scheduled fire, on purpose:
 *   - it always opens a new thread in the job's channel (`forceNewThread`):
 *     queued behind the owner's busy session it would be reported as started
 *     and might never run;
 *   - the prompt carries a note naming the deploy, so a job registered for
 *     several repos knows which one it is checking.
 *
 * Every outcome a lane owner would want to know about gets one line in the
 * deploy thread; every ⚠️ line ends with what the owner can do about it.
 *
 * The signal is model output: the lane must verify the deploy itself and be
 * idempotent. The dedupe below only stops a repeated directive for the same merge
 * commit; it lives in memory, so a restart forgets it.
 */

import type {
  DeployCompletedHookContext,
  DeployCompletedPayload,
  DeployCompletedRejection,
  DeployCompletedSignal,
} from '@soma/slack/directives/deploy-completed-directive';
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
 * lane's turn ends on the new-thread path, which can take hours; every failure
 * before the lane's turn starts settles well inside this. Still running after it
 * = started; a failure after it is posted as a follow-up.
 */
const DEFAULT_SETTLE_MS = 5_000;

/** Recovery hint when the lane names are not known. */
const UNKNOWN_LANE = '레인 이름';

export interface DeployLaneTriggerOptions {
  /** Test seam — defaults to DATA_DIR/cron-jobs.json (same file the scheduler reads). */
  storagePath?: string;
  /** Test seam — defaults to the running scheduler. */
  getScheduler?: () => Pick<CronScheduler, 'runJobNow'> | null;
  now?: () => number;
  settleMs?: number;
}

type FireOutcome = { job: CronJob; ok: boolean; detail?: string; running?: boolean };

export class DeployLaneTrigger {
  /** `${jobId}:${after}` → when it fired. */
  private readonly fired = new Map<string, number>();

  constructor(private readonly opts: DeployLaneTriggerOptions = {}) {}

  /** Entry point for `StreamExecutor`'s `onDeployCompleted` hook. */
  async handle(signal: DeployCompletedSignal, ctx: DeployCompletedHookContext): Promise<void> {
    if (signal.kind === 'rejected') return this.handleRejected(signal.rejections, ctx);
    return this.handleCompleted(signal.payload, ctx);
  }

  private async handleCompleted(payload: DeployCompletedPayload, ctx: DeployCompletedHookContext): Promise<void> {
    const deploy = `${payload.repo} → ${payload.target} (${payload.after.slice(0, 7)})`;

    let jobs: CronJob[];
    try {
      jobs = this.storage().getAllStrict();
    } catch (error) {
      const message = (error as Error).message;
      logger.error('deploy_completed: cron jobs unreadable — no lane can be matched', { deploy, error: message });
      await ctx.reply(`⚠️ 배포 레인 확인 불가 — ${deploy}: cron jobs file unreadable (${message}) ${recovery([])}`);
      return;
    }

    const matched = jobs.filter((job) => jobMatchesDeploy(job, payload.repo, payload.target));
    if (matched.length === 0) {
      const registered = targetsForRepo(jobs, payload.repo);
      logger.info('deploy_completed matched no lane', { deploy, registered });
      if (registered.length > 0) {
        await ctx.reply(`ℹ️ ${payload.repo} → ${payload.target}: 레인 없음 (등록: ${registered.join(', ')})`);
      }
      return;
    }

    if (!payload.confirmed) {
      logger.warn('deploy_completed unconfirmed — lanes not fired', { deploy, lanes: names(matched) });
      await ctx.reply(
        `⚠️ ${payload.repo} → ${payload.target} 머지됨, 배포 미확인 — 레인 미발동: ${bold(matched)} ${recovery(matched)}`,
      );
      return;
    }

    const scheduler = (this.opts.getScheduler ?? getActiveCronScheduler)();
    if (!scheduler) {
      logger.error('deploy_completed matched lanes but the cron scheduler is not running', {
        deploy,
        lanes: names(matched),
      });
      await ctx.reply(`⚠️ 배포 레인 미발동 — cron scheduler not running: ${bold(matched)} ${recovery(matched)}`);
      return;
    }

    const now = (this.opts.now ?? Date.now)();
    for (const [key, at] of this.fired) {
      if (now - at >= DEPLOY_LANE_DEDUPE_MS) this.fired.delete(key);
    }
    const after = payload.after.toLowerCase();
    const fresh: CronJob[] = [];
    const already: CronJob[] = [];
    let firstFiredAt = Number.POSITIVE_INFINITY;
    for (const job of matched) {
      const at = this.fired.get(dedupeKey(job, after));
      if (at === undefined) {
        this.fired.set(dedupeKey(job, after), now);
        fresh.push(job);
      } else {
        already.push(job);
        firstFiredAt = Math.min(firstFiredAt, at);
      }
    }
    const alreadyText = already.length > 0 ? `이미 발동됨 ${formatKst(firstFiredAt)}` : '';
    if (fresh.length === 0) {
      logger.info('deploy_completed already fired these lanes for this commit', { deploy, lanes: names(already) });
      await ctx.reply(`ℹ️ 배포 레인 ${alreadyText} — ${deploy}: ${bold(already)}`);
      return;
    }

    const note = `\n\n[deploy_completed repo=${payload.repo} target=${payload.target} before=${payload.before ?? '-'} after=${payload.after} by=${ctx.user}]`;
    const outcomes = await Promise.all(fresh.map((job) => this.fire(scheduler, job, payload, deploy, note, ctx)));
    await ctx.reply(describeOutcomes(deploy, outcomes, already, alreadyText));
  }

  /**
   * Fire one lane. Resolves within the settle window: the fire's own result, or
   * "running" when its turn is still going. A failure — inside the window or
   * after it — frees the (job, commit) pair so a re-sent signal can retry; a late
   * one is posted as a follow-up line.
   */
  private async fire(
    scheduler: Pick<CronScheduler, 'runJobNow'>,
    job: CronJob,
    payload: DeployCompletedPayload,
    deploy: string,
    note: string,
    ctx: DeployCompletedHookContext,
  ): Promise<FireOutcome> {
    logger.info('deploy_completed firing lane', { name: job.name, owner: job.owner, deploy, triggeredBy: ctx.user });
    const key = dedupeKey(job, payload.after.toLowerCase());
    // Set when the settle window closes with the fire still running: from then
    // on a failure is news the deploy thread has not heard yet.
    let reportedRunning = false;

    const run = Promise.resolve()
      .then(() =>
        scheduler.runJobNow(job.owner, job.name, {
          triggeredBy: ctx.user || undefined,
          forceNewThread: true,
          note,
        }),
      )
      .then(
        (result): FireOutcome => ({ job, ok: result.ok, detail: result.message }),
        (error): FireOutcome => ({ job, ok: false, detail: (error as Error)?.message ?? String(error) }),
      );
    void run
      .then(async (outcome) => {
        if (outcome.ok) return;
        this.fired.delete(key);
        if (!reportedRunning) return;
        logger.error('deploy lane failed after it was reported started', {
          name: job.name,
          owner: job.owner,
          after: payload.after,
          detail: outcome.detail,
        });
        await ctx.reply(`⚠️ 배포 레인 실패 — ${deploy}: ${failureText([outcome])} ${recovery([job])}`);
      })
      .catch((error) => {
        logger.error('deploy lane follow-up failed', { name: job.name, error: (error as Error)?.message });
      });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = new Promise<FireOutcome>((resolve) => {
      timer = setTimeout(() => {
        reportedRunning = true;
        resolve({ job, ok: true, running: true });
      }, this.opts.settleMs ?? DEFAULT_SETTLE_MS);
    });
    try {
      const outcome = await Promise.race([run, running]);
      if (!outcome.ok) {
        logger.warn('deploy lane did not start', { name: job.name, after: payload.after, detail: outcome.detail });
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  /** An attempt that yielded no payload: say so, naming the lanes of its repo when it names one. */
  private async handleRejected(rejections: DeployCompletedRejection[], ctx: DeployCompletedHookContext): Promise<void> {
    let lanes: CronJob[] = [];
    try {
      const repos = new Set(rejections.map((r) => r.repo?.trim().toLowerCase()).filter(Boolean));
      lanes = this.storage()
        .getAllStrict()
        .filter((job) => Array.isArray(job.onDeploy) && job.onDeploy.some((t) => repos.has(t?.repo?.toLowerCase())));
    } catch {
      // The line still goes out, with the generic recovery hint.
    }
    const problems = rejections.map((r) => (r.repo ? `${r.repo}: ${r.problem}` : r.problem)).join('; ');
    logger.warn('deploy_completed rejected — no lane fired', { rejections, lanes: names(lanes) });
    await ctx.reply(`⚠️ deploy_completed 무시됨 — ${problems}; 레인 미발동 ${recovery(lanes)}`);
  }

  private storage(): CronStorage {
    return new CronStorage(this.opts.storagePath ?? path.join(DATA_DIR, 'cron-jobs.json'));
  }
}

function dedupeKey(job: CronJob, after: string): string {
  return `${job.id}:${after}`;
}

function names(jobs: CronJob[]): string[] {
  return jobs.map((job) => job.name);
}

function bold(jobs: CronJob[]): string {
  return jobs.map((job) => `*${job.name}*`).join(', ');
}

/** What the owner can do: run the lane by hand. Ends every ⚠️ line. */
function recovery(jobs: CronJob[]): string {
  const lanes = jobs.length > 0 ? [...new Set(names(jobs))] : [UNKNOWN_LANE];
  return `(owner: ${lanes.map((name) => `cron run ${name}`).join(' · ')})`;
}

/** Distinct targets registered for `repo` across all jobs, for the near-miss reply. */
function targetsForRepo(jobs: CronJob[], repo: string): string[] {
  const want = repo.trim().toLowerCase();
  const targets = new Set<string>();
  for (const job of jobs) {
    if (!Array.isArray(job.onDeploy)) continue;
    for (const t of job.onDeploy) {
      if (typeof t?.repo === 'string' && typeof t?.target === 'string' && t.repo.toLowerCase() === want) {
        targets.add(t.target);
      }
    }
  }
  return [...targets];
}

function failureText(outcomes: FireOutcome[]): string {
  return outcomes.map((o) => `*${o.job.name}* (${o.detail ?? 'unknown error'})`).join(', ');
}

/** HH:MM in KST, the team's clock (same default as format-rate-limited-at). */
function formatKst(epochMs: number): string {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
  return `${hhmm} KST`;
}

/**
 * The deploy thread's one line. A deploy fire always opens a new thread in the
 * job's channel, so that is where a started lane posts. Anything else that came
 * back ok (a queue) is named for what it is, never as started.
 */
function describeOutcomes(deploy: string, outcomes: FireOutcome[], already: CronJob[], alreadyText: string): string {
  const started = outcomes.filter((o) => o.ok && (o.running || o.detail === 'new_thread'));
  const other = outcomes.filter((o) => o.ok && !started.includes(o));
  const failed = outcomes.filter((o) => !o.ok);

  const parts: string[] = [];
  if (started.length > 0) {
    parts.push(started.map((o) => `*${o.job.name}* → <#${o.job.channel}> 새 스레드`).join(', '));
  }
  if (other.length > 0) {
    parts.push(
      other
        .map((o) =>
          o.detail === 'busy_queue' ? `*${o.job.name}* 대기열 등록(아직 시작 안 됨)` : `*${o.job.name}* (${o.detail})`,
        )
        .join(', '),
    );
  }
  if (already.length > 0) parts.push(`${alreadyText}: ${bold(already)}`);

  const head = started.length > 0 ? `▶ 배포 레인 시작 — ${deploy}: ` : `ℹ️ 배포 레인 — ${deploy}: `;
  if (failed.length === 0) return `${head}${parts.join(' · ')}`;
  const failedText = `${failureText(failed)} ${recovery(failed.map((o) => o.job))}`;
  if (parts.length === 0) return `⚠️ 배포 레인 미발동 — ${deploy}: ${failedText}`;
  return `${head}${parts.join(' · ')} · ⚠️ 미발동: ${failedText}`;
}
