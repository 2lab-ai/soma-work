/**
 * Cron jobs as the dashboard's CRON lane sees them (SSOT 2026-10-23 T4/T5).
 *
 * One entry per job of this instance: schedule, next fire, and its runs newest
 * first — each run linked to the session it opened when that session is still
 * live or archived. The job's prompt never leaves the server.
 *
 * Runs come from the cron execution history, which keeps the last
 * {@link CRON_HISTORY_CAP} runs per job; the lane says so instead of
 * presenting them as the full past.
 */

import { type CronExecutionRecord, type CronJob, matchesCronExpression } from 'somalib/cron/cron-storage';
import { normalizeSessionKey } from '../session-identity';

/** Runs kept per job by the cron history (somalib/cron/cron-storage MAX_HISTORY_PER_JOB). */
export const CRON_HISTORY_CAP = 20;

const MINUTE_MS = 60_000;
/** How far ahead the next fire is searched (a weekly job always lands in it). */
const NEXT_FIRE_HORIZON_MINUTES = 8 * 24 * 60;

export interface KanbanCronRunSession {
  headline: string;
  conversationId?: string;
  activityState: string;
  /** Still in the session registry (not archived). */
  live: boolean;
  /** The board card key, when the session has one. */
  boardKey?: string;
  slackThreadUrl?: string;
  /** An earlier run in a thread a later run reused: linked, but the thread's state and usage belong to the later run. */
  earlierInThread?: boolean;
  /** Tokens / cost / active time — only for a session this job created (an injected run shares a human session). */
  tokens?: number;
  costUsd?: number;
  activeMs?: number;
}

export interface KanbanCronRun {
  /** Epoch ms. */
  executedAt: number;
  status: CronExecutionRecord['status'];
  executionPath: CronExecutionRecord['executionPath'];
  triggeredBy?: string;
  error?: string;
  session?: KanbanCronRunSession;
}

export interface KanbanCronJob {
  id: string;
  name: string;
  expression: string;
  owner: string;
  channel: string;
  mode: string;
  target: string;
  model: string;
  /** Epoch ms of the next scheduled fire (UTC cron), or null when none within 8 days. */
  nextRunAt: number | null;
  lastRunAt: number | null;
  historyCap: number;
  runs: KanbanCronRun[];
}

/** The run's session as the lane shows it. `createdByJob` says whether its usage belongs to the run. */
export type CronRunSessionLookup = (
  canonicalSessionKey: string,
) => { session: KanbanCronRunSession; cronJobId?: string; cronJobName?: string } | undefined;

const nextFireCache = new Map<string, number | null>();

/** First minute strictly after `fromMs` the expression matches (UTC), or null within the horizon. */
export function nextCronFire(expression: string, fromMs: number): number | null {
  const fromMinute = Math.floor(fromMs / MINUTE_MS);
  const cacheKey = `${expression}|${fromMinute}`;
  const cached = nextFireCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let found: number | null = null;
  try {
    for (let m = fromMinute + 1; m <= fromMinute + NEXT_FIRE_HORIZON_MINUTES; m++) {
      if (matchesCronExpression(expression, new Date(m * MINUTE_MS))) {
        found = m * MINUTE_MS;
        break;
      }
    }
  } catch {
    found = null;
  }
  if (nextFireCache.size > 500) nextFireCache.clear();
  nextFireCache.set(cacheKey, found);
  return found;
}

function epoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function buildCronJobsView(args: {
  jobs: CronJob[];
  history: CronExecutionRecord[];
  userId?: string;
  nowMs: number;
  findSession: CronRunSessionLookup;
}): KanbanCronJob[] {
  const jobs = args.userId ? args.jobs.filter((j) => j.owner === args.userId) : args.jobs;
  const byJob = new Map<string, CronExecutionRecord[]>();
  for (const record of args.history) {
    const rows = byJob.get(record.jobId) ?? [];
    rows.push(record);
    byJob.set(record.jobId, rows);
  }
  return jobs.map((job) => {
    // Newest first. The stored history is grouped by job, not time-ordered.
    const records = (byJob.get(job.id) ?? [])
      .map((record) => ({ record, executedAt: epoch(record.executedAt) }))
      .filter((r): r is { record: CronExecutionRecord; executedAt: number } => r.executedAt !== null)
      .sort((a, b) => b.executedAt - a.executedAt);
    // A thread can carry several runs (a default-mode job injecting into the
    // same session). Only the newest run of a thread owns its live state and
    // usage; an earlier run there gets the link, not the thread's current
    // activity or cumulative cost.
    const threadSeen = new Set<string>();
    const runs = records.map(({ record, executedAt }): KanbanCronRun => {
      const key = record.sessionKey ? normalizeSessionKey(record.sessionKey) : undefined;
      const found = key ? args.findSession(key) : undefined;
      let session: KanbanCronRunSession | undefined = found?.session;
      if (session && found && key) {
        const createdByJob = found.cronJobId ? found.cronJobId === job.id : found.cronJobName === job.name;
        const earlier = threadSeen.has(key);
        threadSeen.add(key);
        if (earlier) {
          session = {
            headline: session.headline,
            conversationId: session.conversationId,
            slackThreadUrl: session.slackThreadUrl,
            boardKey: session.boardKey,
            live: false,
            activityState: 'idle',
            earlierInThread: true,
          };
        } else if (!createdByJob) {
          // Injected into someone else's session: whatever runs there now is
          // not this job's run — link it, but no live activity and no usage.
          const { tokens: _t, costUsd: _c, activeMs: _a, ...shared } = session;
          session = { ...shared, activityState: 'idle' };
        }
      }
      return {
        executedAt,
        status: record.status,
        executionPath: record.executionPath,
        ...(record.triggeredBy ? { triggeredBy: record.triggeredBy } : {}),
        ...(record.error ? { error: record.error } : {}),
        ...(session ? { session } : {}),
      };
    });
    return {
      id: job.id,
      name: job.name,
      expression: job.expression,
      owner: job.owner,
      channel: job.channel,
      mode: job.mode ?? 'default',
      target: job.target ?? 'channel',
      model:
        job.modelConfig?.type === 'custom' ? (job.modelConfig.model ?? 'custom') : (job.modelConfig?.type ?? 'default'),
      nextRunAt: nextCronFire(job.expression, args.nowMs),
      lastRunAt: epoch(job.lastRunAt),
      historyCap: CRON_HISTORY_CAP,
      runs,
    };
  });
}
