/**
 * MetricsEventStore — JSONL-based event storage with daily file rotation.
 * Trace: docs/daily-weekly-report/trace.md, Scenario 1
 *
 * Files live under `{DATA_DIR}/metrics/metrics-events-YYYY-MM-DD.jsonl`.
 * On first use per process, any legacy files at `{DATA_DIR}/metrics-events-*.jsonl`
 * are auto-migrated into the subdir (id-dedupe + deterministic sort merge).
 */

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';
import type { MetricsEvent } from './types';

const logger = new Logger('MetricsEventStore');

/**
 * Convert a Unix ms timestamp to 'YYYY-MM-DD' string in configured timezone.
 * Uses REPORT_TIMEZONE (default: Asia/Seoul) so file partitioning matches
 * the scheduler/handler query dates, which also use the configured timezone.
 */
const EVENT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Seoul';

function timestampToDateStr(timestamp: number): string {
  const d = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(d);
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

// ─────────────────────────────────────────────────────────────────────────────
// Module-level 1-shot migration state
//
// Keyed by path.resolve(dataDir) so multiple MetricsEventStore instances with
// the same dataDir share a single migration promise — mkdir/readdir run once
// per dataDir per process lifetime. Rejected promises are kept intentionally to
// prevent retry storms; process restart re-runs migration.
// ─────────────────────────────────────────────────────────────────────────────

const ensurePromises = new Map<string, Promise<void>>();

/**
 * Test-only: clears the module-level ensure cache.
 * Do not call in production paths.
 */
export function __resetMetricsEnsureCache(): void {
  ensurePromises.clear();
}

const LEGACY_FILE_PATTERN = /^metrics-events-\d{4}-\d{2}-\d{2}\.jsonl$/;
const STALE_TMP_PATTERN = /^metrics-events-\d{4}-\d{2}-\d{2}\.jsonl\.tmp-/;
const STALE_TMP_AGE_MS = 10 * 60 * 1000; // 10 minutes

function ensureDirOnce(dataDir: string, metricsDir: string): Promise<void> {
  const key = path.resolve(dataDir); // trailing-slash defense
  const existing = ensurePromises.get(key);
  if (existing) return existing;

  const p = (async () => {
    await fs.promises.mkdir(metricsDir, { recursive: true });
    await cleanupStaleTmp(metricsDir);
    await migrateLegacyFiles(dataDir, metricsDir);
  })().catch((err) => {
    // Intentional: keep rejected promise in cache so we don't retry-storm.
    // A crashed migration is fixed by process restart.
    logger.error('[metrics] ensureDir failed — migration aborted', err);
    throw err;
  });

  ensurePromises.set(key, p);
  return p;
}

/**
 * Remove orphaned `.tmp-*` files in metricsDir whose mtime is older than
 * STALE_TMP_AGE_MS. These are artifacts of a prior crashed migration
 * (writeFile succeeded but rename failed).
 */
async function cleanupStaleTmp(metricsDir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(metricsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const d of entries) {
    if (!d.isFile() || !STALE_TMP_PATTERN.test(d.name)) continue;
    const full = path.join(metricsDir, d.name);
    try {
      const st = await fs.promises.stat(full);
      if (now - st.mtimeMs > STALE_TMP_AGE_MS) {
        await fs.promises.unlink(full);
      }
    } catch {
      /* ignore per-file errors */
    }
  }
}

/**
 * Move any legacy `{dataDir}/metrics-events-*.jsonl` files into
 * `{metricsDir}/`. When both source and destination exist for the same
 * date, merge by `event.id` (dedupe) with deterministic sort.
 */
async function migrateLegacyFiles(dataDir: string, metricsDir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dataDir, { withFileTypes: true });
  } catch {
    return;
  }
  const legacy = entries.filter((d) => d.isFile() && LEGACY_FILE_PATTERN.test(d.name));
  if (legacy.length === 0) return;

  let migrated = 0;
  let merged = 0;
  let deduped = 0;
  let skippedCorrupt = 0;

  logger.info(`[metrics] migrating ${legacy.length} legacy files to ${metricsDir}`);

  for (const d of legacy) {
    const src = path.join(dataDir, d.name);
    const dst = path.join(metricsDir, d.name);
    try {
      const r = await migrateOne(src, dst);
      migrated++;
      if (r.mergedWithExisting) merged++;
      deduped += r.duplicates;
      skippedCorrupt += r.corrupt;
    } catch (err) {
      logger.error(`[metrics] failed to migrate ${d.name}`, err);
    }
  }

  logger.info('[metrics] migration done', { migrated, merged, deduped, skippedCorrupt });
}

async function migrateOne(
  src: string,
  dst: string,
): Promise<{ mergedWithExisting: boolean; duplicates: number; corrupt: number }> {
  const dstExists = await fs.promises.stat(dst).then(
    () => true,
    () => false,
  );

  if (!dstExists) {
    try {
      await fs.promises.rename(src, dst);
    } catch (e: any) {
      if (e?.code === 'EXDEV') {
        await copyThenUnlink(src, dst);
      } else {
        throw e;
      }
    }
    return { mergedWithExisting: false, duplicates: 0, corrupt: 0 };
  }

  // Merge path: both files exist for same date.
  const [srcBuf, dstBuf] = await Promise.all([fs.promises.readFile(src, 'utf-8'), fs.promises.readFile(dst, 'utf-8')]);
  const { out, duplicates, corrupt } = mergeJsonl(srcBuf, dstBuf);
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, out, 'utf-8');
  try {
    await fs.promises.rename(tmp, dst); // atomic on same-fs
  } catch (e: any) {
    if (e?.code === 'EXDEV') {
      await fs.promises.copyFile(tmp, dst);
      await fs.promises.unlink(tmp);
    } else {
      await fs.promises.unlink(tmp).catch(() => {});
      throw e;
    }
  }
  // Partial writeFile leaks are handled by cleanupStaleTmp on next boot.
  await fs.promises.unlink(src);
  return { mergedWithExisting: true, duplicates, corrupt };
}

async function copyThenUnlink(src: string, dst: string): Promise<void> {
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.copyFile(src, tmp);
  await fs.promises.rename(tmp, dst);
  await fs.promises.unlink(src);
}

/**
 * Merge multiple JSONL buffers into a single deterministic JSONL output.
 *
 * - Deduplicates by `event.id` (later wins — insertion order follows argument order).
 * - Skips lines that fail JSON.parse or lack `id`/`timestamp` required fields.
 * - Sorts by `(timestamp asc, id asc)` for stable, deterministic output.
 *
 * Exported for unit testing independent of fs.
 */
export function mergeJsonl(...contents: string[]): {
  out: string;
  duplicates: number;
  corrupt: number;
} {
  const byId = new Map<string, MetricsEvent>();
  let duplicates = 0;
  let corrupt = 0;

  for (const c of contents) {
    for (const line of c.split('\n')) {
      if (!line.trim()) continue;
      let ev: MetricsEvent | null = null;
      try {
        ev = JSON.parse(line) as MetricsEvent;
      } catch {
        corrupt++;
        continue;
      }
      if (!ev || typeof ev.id !== 'string' || !ev.id || typeof ev.timestamp !== 'number') {
        corrupt++;
        continue;
      }
      if (byId.has(ev.id)) duplicates++;
      byId.set(ev.id, ev); // later wins
    }
  }

  const all = [...byId.values()];
  all.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const out = all.length ? all.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
  return { out, duplicates, corrupt };
}

// ─────────────────────────────────────────────────────────────────────────────

export class MetricsEventStore {
  private dataDir: string;
  private metricsDir: string;
  /** Per-file promise chain to serialize concurrent writes and prevent JSONL interleave. */
  private writeQueues = new Map<string, Promise<void>>();

  constructor(dataDir?: string) {
    this.dataDir = dataDir || DATA_DIR;
    this.metricsDir = path.join(this.dataDir, 'metrics');
  }

  /**
   * Get the file path for a given date string.
   */
  private getFilePath(dateStr: string): string {
    return path.join(this.metricsDir, `metrics-events-${dateStr}.jsonl`);
  }

  /**
   * Append a single event to the date-partitioned JSONL file.
   * Fire-and-forget safe — errors are logged but not thrown.
   */
  async append(event: MetricsEvent): Promise<void> {
    try {
      await ensureDirOnce(this.dataDir, this.metricsDir);
      const dateStr = timestampToDateStr(event.timestamp);
      const filePath = this.getFilePath(dateStr);
      const line = JSON.stringify(event) + '\n';

      // Serialize writes per file to prevent JSONL line interleave under concurrency
      const prev = this.writeQueues.get(filePath) || Promise.resolve();
      const next = prev.then(() => fs.promises.appendFile(filePath, line, 'utf-8'));
      this.writeQueues.set(
        filePath,
        next.catch(() => {}),
      ); // keep chain alive on error
      await next;

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
    await ensureDirOnce(this.dataDir, this.metricsDir);
    const dates = generateDateRange(startDate, endDate);
    const allEvents: MetricsEvent[] = [];

    for (const dateStr of dates) {
      const filePath = this.getFilePath(dateStr);

      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter((line) => line.trim().length > 0);

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
