/**
 * 2026-09-28 one-time rewrite of every cron job's model to the floating
 * `opus` alias type (`{ type: 'opus' }`, resolved to `MODEL_ALIASES.opus` at
 * fire time by `cron-scheduler.resolveModelOverride`).
 *
 * Same "exactly once, ever" contract as `migrate-all-users-opus-once.ts`: the
 * marker is PRESENCE-only (a corrupt marker still means done), so a job whose
 * owner switches it back afterwards is never rewritten again.
 *
 * Ordering — MARKER FIRST, same rule as the all-users migration:
 *   1. read + shape-validate `cron-jobs.json` (`{ jobs: [ {…}, … ] }`). This
 *      pre-parse also matters because `CronStorage.load` swallows a corrupt
 *      file and returns `{ jobs: [] }`, which would otherwise mark the
 *      one-shot done with zero jobs migrated;
 *   2. write the marker, with the per-job previous modelConfig snapshot;
 *   3. only then patch the jobs. A throw here is a missed one-shot (logged by
 *      the caller), never a later replay over choices made in between.
 *
 * Writes go through `CronStorage.updateJob`, the same load → patch → tmp +
 * rename path the cron MCP subprocess uses. `src/index.ts` runs this before
 * `app.start()`, so no Slack event can have spawned such a subprocess yet.
 * Bookkeeping fields (`lastRunMinute` etc.) are preserved by `updateJob`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '@soma/common/atomic-write';
import { type CronJob, CronStorage } from 'somalib/cron/cron-storage';

/** Presence of this file (in DATA_DIR) = migration done. */
export const CRON_OPUS_ONCE_MARKER = '.cron-opus-once-2026-09-28.json';

export interface MigrateCronOpusOnceParams {
  /** Absolute path of `cron-jobs.json`. */
  cronFile: string;
  /** Directory the marker is written to. */
  dataDir: string;
  /** Injected clock for deterministic marker timestamps in tests. */
  now?: () => Date;
}

export interface MigrateCronOpusOnceResult {
  status: 'skipped' | 'applied';
  markerFile: string;
  /** Jobs whose modelConfig was changed by this run. */
  migrated: number;
  /** Jobs inspected. */
  total: number;
}

interface CronOpusOnceMarker {
  migratedAt: string;
  modelConfig: { type: 'opus' };
  migrated: number;
  total: number;
  /** Per-job previous modelConfig (`null` = none), for a manual revert. */
  previous: Array<{ owner: string; name: string; modelConfig: unknown }>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse + shape-check the cron file. Throws on anything but `{ jobs: [ {…} ] }`. */
function readJobs(cronFile: string): CronJob[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
  if (!isPlainObject(parsed) || !Array.isArray(parsed.jobs)) {
    throw new Error(`cron-jobs file has no jobs array: ${cronFile}`);
  }
  parsed.jobs.forEach((job, i) => {
    if (!isPlainObject(job)) throw new Error(`cron-jobs file job #${i} is not an object: ${cronFile}`);
  });
  return parsed.jobs as CronJob[];
}

function isAlreadyOpus(job: CronJob): boolean {
  const c = job.modelConfig;
  return !!c && c.type === 'opus' && Object.keys(c).length === 1;
}

export function migrateCronOpusOnce(params: MigrateCronOpusOnceParams): MigrateCronOpusOnceResult {
  const now = params.now ?? (() => new Date());
  const markerFile = path.join(params.dataDir, CRON_OPUS_ONCE_MARKER);

  if (fs.existsSync(markerFile)) {
    return { status: 'skipped', markerFile, migrated: 0, total: 0 };
  }

  // 1. Read + validate (throws before anything is written).
  const jobs = fs.existsSync(params.cronFile) ? readJobs(params.cronFile) : [];
  const pending = jobs.filter((job) => !isAlreadyOpus(job));

  // 2. Marker FIRST — from here on this host never replays the rewrite.
  fs.mkdirSync(params.dataDir, { recursive: true });
  const marker: CronOpusOnceMarker = {
    migratedAt: now().toISOString(),
    modelConfig: { type: 'opus' },
    migrated: pending.length,
    total: jobs.length,
    previous: pending.map((job) => ({ owner: job.owner, name: job.name, modelConfig: job.modelConfig ?? null })),
  };
  atomicWriteJson(markerFile, marker);

  // 3. Data write. A throw here propagates; the caller logs it at error level.
  const storage = new CronStorage(params.cronFile);
  let migrated = 0;
  for (const job of pending) {
    if (storage.updateJob(job.owner, job.name, { modelConfig: { type: 'opus' } })) migrated += 1;
  }

  return { status: 'applied', markerFile, migrated, total: jobs.length };
}
