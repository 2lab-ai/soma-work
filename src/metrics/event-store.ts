/**
 * MetricsEventStore — SQLite event storage, one row per event, partitioned by
 * report day (same storage contract as llmux's raw-io store: SQLite now, a
 * server DBMS later, nothing ever deleted).
 * Trace: docs/archive/features/daily-weekly-report/trace.md, Scenario 1
 *
 * Database: `{DATA_DIR}/metrics/metrics.sqlite3`, table `metrics_events`
 * (`id` unique, `ts`, `day` = REPORT_TIMEZONE date, `event_type`, `json`).
 * The pre-SQLite daily files `{DATA_DIR}/metrics/metrics-events-YYYY-MM-DD.jsonl`
 * are imported idempotently (re-imported only when a file's size changes) and
 * are NEVER modified or removed — they stay as the backup of those days.
 * Unparseable lines are kept verbatim in `metrics_unparsed`. Past days that
 * exist only in the database are exported once to
 * `{DATA_DIR}/metrics/archive/metrics-events-YYYY-MM-DD[.N].jsonl.zst`.
 * On first use per process, any legacy files at `{DATA_DIR}/metrics-events-*.jsonl`
 * are still auto-migrated into the subdir first (id-dedupe + deterministic sort merge).
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
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

// Built once: constructing an Intl.DateTimeFormat costs tens of microseconds.
const EVENT_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: EVENT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function timestampToDateStr(timestamp: number): string {
  return EVENT_DATE_FORMAT.format(timestamp);
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
  } catch (err: any) {
    // ENOENT = dir doesn't exist yet (first boot before mkdir effect) — expected.
    // Anything else (EACCES/EIO) is a real problem; log for observability.
    if (err?.code !== 'ENOENT') {
      logger.warn('[metrics] cleanupStaleTmp readdir failed', err);
    }
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
  } catch (err: any) {
    // ENOENT on DATA_DIR is expected on a completely fresh install — nothing to migrate.
    // EACCES/EIO/EPERM here means legacy files (if any) would be silently orphaned and
    // invisible to readRange. Rethrow so the caller's ensureDirOnce cache holds the
    // failure and the error surfaces (instead of looking like a successful no-op boot).
    if (err?.code !== 'ENOENT') {
      logger.error('[metrics] migrateLegacyFiles readdir failed', err);
      throw err;
    }
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
  // Only treat ENOENT as "doesn't exist". EACCES/EIO must propagate — otherwise we'd
  // mis-classify an unreadable dst as missing and overwrite with src via rename.
  const dstExists = await fs.promises.stat(dst).then(
    () => true,
    (err: any) => {
      if (err?.code === 'ENOENT') return false;
      throw err;
    },
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
// SQLite layer
// ─────────────────────────────────────────────────────────────────────────────

const DB_FILE = 'metrics.sqlite3';
const DAY_FILE_PATTERN = /^metrics-events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metrics_events (
  seq        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  ts         INTEGER NOT NULL,
  day        TEXT NOT NULL,
  event_type TEXT,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS metrics_events_day_ts ON metrics_events(day, ts);
CREATE TABLE IF NOT EXISTS metrics_unparsed (
  file    TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  text    TEXT NOT NULL,
  PRIMARY KEY (file, line_no)
);
CREATE TABLE IF NOT EXISTS metrics_jsonl_imports (
  file        TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  lines       INTEGER NOT NULL,
  events      INTEGER NOT NULL,
  corrupt     INTEGER NOT NULL,
  imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics_exports (
  file        TEXT PRIMARY KEY,
  day         TEXT NOT NULL,
  rows        INTEGER NOT NULL,
  exported_at INTEGER NOT NULL
);
`;

const UPSERT_SQL = `INSERT INTO metrics_events (id, ts, day, event_type, json) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, day = excluded.day,
    event_type = excluded.event_type, json = excluded.json`;

/** One open database per metrics dir (shared by every store instance). */
const dbs = new Map<string, DatabaseSync>();

/** Test-only: close and forget every open metrics database. */
export function __closeMetricsDbs(): void {
  for (const db of dbs.values()) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  dbs.clear();
}

function openDb(metricsDir: string): DatabaseSync {
  const key = path.resolve(metricsDir);
  const existing = dbs.get(key);
  if (existing) return existing;
  fs.mkdirSync(metricsDir, { recursive: true });
  const db = new DatabaseSync(path.join(metricsDir, DB_FILE));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA_SQL);
  dbs.set(key, db);
  return db;
}

function isValidEvent(ev: unknown): ev is MetricsEvent {
  const e = ev as MetricsEvent | null;
  return !!e && typeof e.id === 'string' && !!e.id && typeof e.timestamp === 'number';
}

function upsert(db: DatabaseSync, ev: MetricsEvent, day: string): void {
  db.prepare(UPSERT_SQL).run(ev.id, ev.timestamp, day, ev.eventType ?? null, JSON.stringify(ev));
}

/**
 * Import the daily JSONL files into the database. A file is (re)imported only
 * when its size differs from the last import, so a steady state costs one
 * readdir + stat per file. Events keep the day of the file they came from
 * (exactly what the file-based reader returned); later lines win per id, like
 * the legacy merge. The files themselves are never touched.
 */
async function syncJsonlFiles(db: DatabaseSync, metricsDir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(metricsDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') logger.warn('[metrics] syncJsonlFiles readdir failed', err);
    return;
  }
  const files = entries
    .filter((d) => d.isFile() && DAY_FILE_PATTERN.test(d.name))
    .map((d) => d.name)
    .sort();
  const known = db.prepare('SELECT size FROM metrics_jsonl_imports WHERE file = ?');
  for (const name of files) {
    const full = path.join(metricsDir, name);
    let size: number;
    try {
      size = (await fs.promises.stat(full)).size;
    } catch {
      continue;
    }
    const row = known.get(name) as { size: number } | undefined;
    if (row && Number(row.size) === size) continue;
    const day = DAY_FILE_PATTERN.exec(name)?.[1] ?? '';
    let content: string;
    try {
      content = await fs.promises.readFile(full, 'utf-8');
    } catch (err) {
      logger.error(`[metrics] failed to read ${name} for import`, err);
      continue;
    }
    const lines = content.split('\n');
    let events = 0;
    let corrupt = 0;
    let nonBlank = 0;
    db.exec('BEGIN');
    try {
      const unparsed = db.prepare('INSERT OR IGNORE INTO metrics_unparsed (file, line_no, text) VALUES (?, ?, ?)');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        nonBlank++;
        let ev: unknown = null;
        try {
          ev = JSON.parse(line);
        } catch {
          ev = null;
        }
        if (!isValidEvent(ev)) {
          corrupt++;
          unparsed.run(name, i + 1, line);
          continue;
        }
        upsert(db, ev, day);
        events++;
      }
      db.prepare(
        `INSERT INTO metrics_jsonl_imports (file, size, lines, events, corrupt, imported_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(file) DO UPDATE SET size = excluded.size, lines = excluded.lines, events = excluded.events,
           corrupt = excluded.corrupt, imported_at = excluded.imported_at`,
      ).run(name, size, nonBlank, events, corrupt, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      logger.error(`[metrics] import of ${name} failed — file left as-is`, err);
      continue;
    }
    if (corrupt > 0) logger.warn(`[metrics] ${name}: ${corrupt} unparseable lines kept in metrics_unparsed`);
    logger.info(`[metrics] imported ${name}`, { events, corrupt });
  }
}

/**
 * Export every past day whose rows are not yet backed up — no daily JSONL file
 * with the same event count and no earlier export with the same row count — to
 * `archive/metrics-events-DAY[.N].jsonl.zst`. Existing exports are never
 * overwritten (a changed day gets the next generation).
 */
function exportPastDays(db: DatabaseSync, metricsDir: string, today: string): string[] {
  const written: string[] = [];
  const days = db
    .prepare('SELECT day, count(*) AS n FROM metrics_events WHERE day < ? GROUP BY day ORDER BY day')
    .all(today) as Array<{ day: string; n: number }>;
  if (days.length === 0) return written;
  const archiveDir = path.join(metricsDir, 'archive');
  for (const { day, n } of days) {
    const rows = Number(n);
    const jsonl = db
      .prepare('SELECT events FROM metrics_jsonl_imports WHERE file = ?')
      .get(`metrics-events-${day}.jsonl`) as { events: number } | undefined;
    if (jsonl && Number(jsonl.events) === rows) continue;
    const exported = db
      .prepare('SELECT rows FROM metrics_exports WHERE day = ? ORDER BY exported_at DESC LIMIT 1')
      .get(day) as { rows: number } | undefined;
    if (exported && Number(exported.rows) === rows) continue;
    const events = db.prepare('SELECT json FROM metrics_events WHERE day = ? ORDER BY ts, seq').all(day) as Array<{
      json: string;
    }>;
    const body = events.map((e) => e.json).join('\n') + '\n';
    fs.mkdirSync(archiveDir, { recursive: true });
    let gen = 0;
    let file = `metrics-events-${day}.jsonl.zst`;
    while (fs.existsSync(path.join(archiveDir, file))) {
      gen++;
      file = `metrics-events-${day}.${gen}.jsonl.zst`;
    }
    const full = path.join(archiveDir, file);
    const tmp = `${full}.tmp-${process.pid}`;
    const compressed = zlib.zstdCompressSync(Buffer.from(body, 'utf-8'));
    // Verify before publishing: the export must decode to the same bytes.
    if (zlib.zstdDecompressSync(compressed).toString('utf-8') !== body) {
      throw new Error(`metrics export of ${day} did not round-trip`);
    }
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, compressed);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, full);
    db.prepare('INSERT INTO metrics_exports (file, day, rows, exported_at) VALUES (?, ?, ?, ?)').run(
      file,
      day,
      rows,
      Date.now(),
    );
    written.push(file);
  }
  return written;
}

export class MetricsEventStore {
  private dataDir: string;
  private metricsDir: string;
  /** Report day of the last export check (once per day per process). */
  private exportCheckedDay: string | null = null;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || DATA_DIR;
    this.metricsDir = path.join(this.dataDir, 'metrics');
  }

  private async db(): Promise<DatabaseSync> {
    await ensureDirOnce(this.dataDir, this.metricsDir);
    const db = openDb(this.metricsDir);
    await syncJsonlFiles(db, this.metricsDir);
    return db;
  }

  /**
   * Append a single event (upsert by id) into its report-day partition.
   * Fire-and-forget safe — errors are logged but not thrown.
   */
  async append(event: MetricsEvent): Promise<void> {
    try {
      const db = await this.db();
      const day = timestampToDateStr(event.timestamp);
      upsert(db, event, day);
      logger.debug(`Appended event ${event.eventType} for ${day}`);
      const today = timestampToDateStr(Date.now());
      if (this.exportCheckedDay !== today) {
        this.exportCheckedDay = today;
        try {
          exportPastDays(db, this.metricsDir, today);
        } catch (err) {
          logger.error('[metrics] past-day export failed — rows stay in the database', err);
        }
      }
    } catch (error) {
      logger.error('Failed to append metrics event', error);
    }
  }

  /**
   * Back up past days that live only in the database (see `exportPastDays`).
   * Returns the archive file names written.
   */
  async exportPastDays(today: string = timestampToDateStr(Date.now())): Promise<string[]> {
    const db = await this.db();
    return exportPastDays(db, this.metricsDir, today);
  }

  /**
   * Read all events in a date range (inclusive) — one indexed query.
   * Returns events sorted by timestamp ascending (insertion order on ties).
   */
  async readRange(startDate: string, endDate: string): Promise<MetricsEvent[]> {
    const db = await this.db();
    const rows = db
      .prepare('SELECT json FROM metrics_events WHERE day BETWEEN ? AND ? ORDER BY ts, seq')
      .all(startDate, endDate) as Array<{ json: string }>;
    const events: MetricsEvent[] = [];
    for (const r of rows) {
      try {
        events.push(JSON.parse(r.json) as MetricsEvent);
      } catch {
        logger.warn('Skipped an unreadable metrics row');
      }
    }
    logger.debug(`Read ${events.length} events from ${startDate} to ${endDate}`);
    return events;
  }
}
