import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as zlib from 'zlib';
import {
  __closeMetricsDbs,
  __resetMetricsEnsureCache,
  MetricsEventStore,
  mergeJsonl,
  metricsSqliteAvailable,
} from '../event-store';

// node:sqlite needs Node >= 22.5; older runtimes keep the daily-JSONL store.
const SQLITE = metricsSqliteAvailable();

import type { MetricsEvent } from '../types';

// Contract tests — Scenario 1: MetricsEventStore (JSONL Storage Layer)
// Trace: docs/archive/features/daily-weekly-report/trace.md

const TEST_DATA_DIR = path.join(__dirname, '../../../.test-data-metrics');
const TEST_METRICS_DIR = path.join(TEST_DATA_DIR, 'metrics');

function makeEvent(overrides: Partial<MetricsEvent> = {}): MetricsEvent {
  return {
    id: 'test-id-1',
    timestamp: new Date('2026-03-25T10:00:00Z').getTime(),
    eventType: 'session_created',
    userId: 'U123',
    userName: 'TestUser',
    ...overrides,
  };
}

describe('MetricsEventStore', () => {
  let store: MetricsEventStore;

  beforeEach(() => {
    // Reset module-level migration cache so each test gets a fresh ensureDir run
    __resetMetricsEnsureCache();
    __closeMetricsDbs();
    // Clean test directory
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    store = new MetricsEventStore(TEST_DATA_DIR);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __closeMetricsDbs();
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  // Trace: Scenario 1, Section 3a — append writes to the event's report-day partition
  it.skipIf(!SQLITE)('append_writesToCorrectDayPartition', async () => {
    const event = makeEvent({ timestamp: new Date('2026-03-25T10:00:00Z').getTime() });
    await store.append(event);

    expect(fs.existsSync(path.join(TEST_METRICS_DIR, 'metrics.sqlite3'))).toBe(true);
    const events = await store.readRange('2026-03-25', '2026-03-25');
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('test-id-1');
    expect(events[0].eventType).toBe('session_created');
    expect(await store.readRange('2026-03-24', '2026-03-24')).toEqual([]);
  });

  // Trace: Scenario 1, Section 3b — readRange returns sorted events
  it('readRange_returnsSortedEvents', async () => {
    const event1 = makeEvent({ id: 'e1', timestamp: new Date('2026-03-25T14:00:00Z').getTime() });
    const event2 = makeEvent({ id: 'e2', timestamp: new Date('2026-03-25T08:00:00Z').getTime() });
    await store.append(event1);
    await store.append(event2);

    const events = await store.readRange('2026-03-25', '2026-03-25');
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('e2'); // earlier timestamp first
    expect(events[1].id).toBe('e1');
  });

  // Trace: Scenario 1, Section 5 — ENOENT: returns empty for missing date
  it('readRange_emptyForMissingDate', async () => {
    const events = await store.readRange('2026-01-01', '2026-01-01');
    expect(events).toEqual([]);
  });

  // Trace: Scenario 1, Section 5 — SyntaxError: skips corrupted lines
  it('readRange_skipsCorruptedLines', async () => {
    fs.mkdirSync(TEST_METRICS_DIR, { recursive: true });
    const filePath = path.join(TEST_METRICS_DIR, 'metrics-events-2026-03-25.jsonl');
    const a = JSON.stringify(makeEvent({ id: 'a' }));
    const b = JSON.stringify(makeEvent({ id: 'b' }));
    const body = `${a}\n{corrupted json\n${b}\n`;
    fs.writeFileSync(filePath, body);

    const events = await store.readRange('2026-03-25', '2026-03-25');
    expect(events).toHaveLength(2); // 2 valid, 1 skipped
    // The source file is a backup now: never modified.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(body);
  });

  // #477 successor: day files are imported once; a range is one indexed query,
  // returned in date order.
  it.skipIf(!SQLITE)('readRange_returnsImportedDayFilesInDateOrder', async () => {
    fs.mkdirSync(TEST_METRICS_DIR, { recursive: true });
    const days = ['2026-03-20', '2026-03-21', '2026-03-22', '2026-03-23', '2026-03-24'];
    for (const [i, d] of days.entries()) {
      // Same timestamp everywhere: the result order then comes from the import order alone.
      const line = JSON.stringify(makeEvent({ id: `d${i}`, timestamp: 1 }));
      fs.writeFileSync(path.join(TEST_METRICS_DIR, `metrics-events-${d}.jsonl`), `${line}\n`);
    }
    const events = await store.readRange(days[0], days[days.length - 1]);
    expect(events.map((e) => e.id)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    // A second read does not re-read unchanged files.
    const spy = vi.spyOn(fs.promises, 'readFile');
    await store.readRange(days[0], days[days.length - 1]);
    expect(spy).not.toHaveBeenCalled();
  });

  it.skipIf(!SQLITE)('readRange_reimportsAFileWhoseSizeChanged', async () => {
    fs.mkdirSync(TEST_METRICS_DIR, { recursive: true });
    const filePath = path.join(TEST_METRICS_DIR, 'metrics-events-2026-03-25.jsonl');
    fs.writeFileSync(filePath, `${JSON.stringify(makeEvent({ id: 'x1' }))}\n`);
    expect(await store.readRange('2026-03-25', '2026-03-25')).toHaveLength(1);
    fs.appendFileSync(filePath, `${JSON.stringify(makeEvent({ id: 'x2' }))}\n`);
    const events = await store.readRange('2026-03-25', '2026-03-25');
    expect(events.map((e) => e.id).sort()).toEqual(['x1', 'x2']);
  });

  it('readRange_yearRange_returnsEmptyWithoutDayFiles', async () => {
    const events = await store.readRange('2025-03-26', '2026-03-25');
    expect(events).toEqual([]);
  });

  it.skipIf(!SQLITE)('exportPastDays_backsUpDbOnlyDays_neverOverwrites', async () => {
    const archive = path.join(TEST_METRICS_DIR, 'archive');
    const decode = (file: string) =>
      zlib
        .zstdDecompressSync(fs.readFileSync(path.join(archive, file)))
        .toString('utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).id);
    // The first append of the (real) day already backs up the past day it wrote.
    await store.append(makeEvent({ id: 'p1', timestamp: new Date('2026-03-20T10:00:00Z').getTime() }));
    expect(decode('metrics-events-2026-03-20.jsonl.zst')).toEqual(['p1']);
    // A later event for that day: the next export is a NEW generation; the old one stays.
    await store.append(makeEvent({ id: 'p2', timestamp: new Date('2026-03-20T11:00:00Z').getTime() }));
    expect(await store.exportPastDays('2026-03-25')).toEqual(['metrics-events-2026-03-20.1.jsonl.zst']);
    expect(decode('metrics-events-2026-03-20.1.jsonl.zst')).toEqual(['p1', 'p2']);
    expect(decode('metrics-events-2026-03-20.jsonl.zst')).toEqual(['p1']);
    // Unchanged day: nothing new.
    expect(await store.exportPastDays('2026-03-25')).toEqual([]);
  });

  it.skipIf(!SQLITE)('exportPastDays_backsUpJsonlImportedDaysOnce_andUpdatesBySameCount', async () => {
    fs.mkdirSync(TEST_METRICS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(TEST_METRICS_DIR, 'metrics-events-2026-03-19.jsonl'),
      `${JSON.stringify(makeEvent({ id: 'j1', timestamp: new Date('2026-03-19T10:00:00Z').getTime() }))}\n`,
    );
    expect(await store.exportPastDays('2026-03-25')).toEqual(['metrics-events-2026-03-19.jsonl.zst']);
    expect(await store.exportPastDays('2026-03-25')).toEqual([]);
    // Same row count, changed content (an upsert of the same id): backed up
    // again as a new generation (the append's own daily check may write it).
    await store.append(
      makeEvent({ id: 'j1', timestamp: new Date('2026-03-19T10:00:00Z').getTime(), userName: 'Renamed' }),
    );
    await store.exportPastDays('2026-03-25');
    const gen1 = path.join(TEST_METRICS_DIR, 'archive', 'metrics-events-2026-03-19.1.jsonl.zst');
    expect(JSON.parse(zlib.zstdDecompressSync(fs.readFileSync(gen1)).toString('utf-8').trim()).userName).toBe(
      'Renamed',
    );
    expect(fs.existsSync(path.join(TEST_METRICS_DIR, 'archive', 'metrics-events-2026-03-19.jsonl.zst'))).toBe(true);
  });

  it.skipIf(!SQLITE)('import_keepsOtherEventsWhenOneCannotBeStored', async () => {
    fs.mkdirSync(TEST_METRICS_DIR, { recursive: true });
    const odd = JSON.stringify({ ...makeEvent({ id: 'odd' }), eventType: { nested: true } });
    const ok = JSON.stringify(makeEvent({ id: 'ok' }));
    fs.writeFileSync(path.join(TEST_METRICS_DIR, 'metrics-events-2026-03-25.jsonl'), `${odd}\n${ok}\n`);
    const ids = (await store.readRange('2026-03-25', '2026-03-25')).map((e) => e.id).sort();
    expect(ids).toEqual(['odd', 'ok']);
  });

  it.skipIf(SQLITE)('jsonlFallback_appendWritesTheDayFile', async () => {
    await store.append(makeEvent());
    const filePath = path.join(TEST_METRICS_DIR, 'metrics-events-2026-03-25.jsonl');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8').trim()).id).toBe('test-id-1');
  });

  // Trace: Scenario 1, Section 4 — file created on first write
  it.skipIf(!SQLITE)('append_databaseCreatedOnFirstWrite', async () => {
    const dbPath = path.join(TEST_METRICS_DIR, 'metrics.sqlite3');
    expect(fs.existsSync(dbPath)).toBe(false);

    await store.append(makeEvent());
    expect(fs.existsSync(dbPath)).toBe(true);
    // No new JSONL day file is written any more.
    expect(fs.existsSync(path.join(TEST_METRICS_DIR, 'metrics-events-2026-03-25.jsonl'))).toBe(false);
  });

  // Trace: Scenario 1, Section 3b — multi-day aggregation
  it('readRange_multiDayAggregation', async () => {
    const event1 = makeEvent({ id: 'day1', timestamp: new Date('2026-03-24T10:00:00Z').getTime() });
    const event2 = makeEvent({ id: 'day2', timestamp: new Date('2026-03-25T10:00:00Z').getTime() });
    const event3 = makeEvent({ id: 'day3', timestamp: new Date('2026-03-26T10:00:00Z').getTime() });
    await store.append(event1);
    await store.append(event2);
    await store.append(event3);

    const events = await store.readRange('2026-03-24', '2026-03-26');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.id)).toEqual(['day1', 'day2', 'day3']);
  });

  // ── Migration tests (plan v2.1) ────────────────────────────────────────

  // P0-1 indirect + plan §Test Plan #1
  it('migrate_movesLegacyFileWhenTargetMissing', async () => {
    // Plant a legacy file at dataDir root before first use
    const legacyName = 'metrics-events-2026-03-20.jsonl';
    const legacyEvent = makeEvent({
      id: 'legacy-1',
      timestamp: new Date('2026-03-20T10:00:00Z').getTime(),
    });
    const legacySrc = path.join(TEST_DATA_DIR, legacyName);
    fs.writeFileSync(legacySrc, JSON.stringify(legacyEvent) + '\n');

    // Trigger migration via append (brand new store instance)
    const s = new MetricsEventStore(TEST_DATA_DIR);
    await s.append(makeEvent()); // any event

    // Legacy src should be gone, dst should exist in metrics/
    expect(fs.existsSync(legacySrc)).toBe(false);
    const movedDst = path.join(TEST_METRICS_DIR, legacyName);
    expect(fs.existsSync(movedDst)).toBe(true);
    const content = fs.readFileSync(movedDst, 'utf-8').trim();
    expect(JSON.parse(content).id).toBe('legacy-1');
  });

  // plan §Test Plan #2
  it('migrate_mergesAndDedupesWhenBothExist', async () => {
    const date = '2026-03-20';
    const legacyName = `metrics-events-${date}.jsonl`;
    const legacySrc = path.join(TEST_DATA_DIR, legacyName);
    const metricsDst = path.join(TEST_METRICS_DIR, legacyName);

    fs.mkdirSync(TEST_METRICS_DIR, { recursive: true });

    const ts = (h: number) => new Date(`2026-03-20T${String(h).padStart(2, '0')}:00:00Z`).getTime();

    // src has ids [a, b, c]
    const srcLines =
      [
        JSON.stringify(makeEvent({ id: 'a', timestamp: ts(8), eventType: 'session_created' })),
        JSON.stringify(makeEvent({ id: 'b', timestamp: ts(10), eventType: 'turn_used' })),
        JSON.stringify(makeEvent({ id: 'c', timestamp: ts(12), eventType: 'pr_created' })),
      ].join('\n') + '\n';
    fs.writeFileSync(legacySrc, srcLines);

    // dst has ids [b, c, d] — b & c overlap
    const dstLines =
      [
        JSON.stringify(makeEvent({ id: 'b', timestamp: ts(10), eventType: 'turn_used' })),
        JSON.stringify(makeEvent({ id: 'c', timestamp: ts(12), eventType: 'pr_created' })),
        JSON.stringify(makeEvent({ id: 'd', timestamp: ts(14), eventType: 'commit_created' })),
      ].join('\n') + '\n';
    fs.writeFileSync(metricsDst, dstLines);

    // Trigger migration
    const s = new MetricsEventStore(TEST_DATA_DIR);
    const events = await s.readRange(date, date);

    // Src must be gone
    expect(fs.existsSync(legacySrc)).toBe(false);
    // Dst should have exactly 4 events: a, b, c, d (no dupes)
    const rawContent = fs.readFileSync(metricsDst, 'utf-8');
    const lines = rawContent.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(4);

    // Deterministic sort by timestamp asc
    expect(events.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  // plan §Test Plan #3
  it('migrate_isIdempotent', async () => {
    const legacyName = 'metrics-events-2026-03-20.jsonl';
    const legacySrc = path.join(TEST_DATA_DIR, legacyName);
    fs.writeFileSync(legacySrc, JSON.stringify(makeEvent({ id: 'x' })) + '\n');

    const s1 = new MetricsEventStore(TEST_DATA_DIR);
    await s1.append(makeEvent());

    const dstPath = path.join(TEST_METRICS_DIR, legacyName);
    const firstMtime = fs.statSync(dstPath).mtimeMs;

    // Reset cache + rerun — no legacy files remain, so no-op
    __resetMetricsEnsureCache();
    const s2 = new MetricsEventStore(TEST_DATA_DIR);
    await s2.readRange('2026-03-20', '2026-03-20');

    // File unchanged
    const secondMtime = fs.statSync(dstPath).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
    // Legacy src still gone
    expect(fs.existsSync(legacySrc)).toBe(false);
  });

  // P0-2 plan §Test Plan #4
  it('migrate_triggeredByReadRangeOnly', async () => {
    const legacyName = 'metrics-events-2026-03-20.jsonl';
    const legacySrc = path.join(TEST_DATA_DIR, legacyName);
    fs.writeFileSync(legacySrc, JSON.stringify(makeEvent({ id: 'r1' })) + '\n');

    // Use readRange WITHOUT any append call
    const s = new MetricsEventStore(TEST_DATA_DIR);
    const events = await s.readRange('2026-03-20', '2026-03-20');

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('r1');
    // Legacy src must be migrated
    expect(fs.existsSync(legacySrc)).toBe(false);
    expect(fs.existsSync(path.join(TEST_METRICS_DIR, legacyName))).toBe(true);
  });

  // P0-4 plan §Test Plan #5
  it('migrate_skipsMalformedEvents', async () => {
    const legacyName = 'metrics-events-2026-03-20.jsonl';
    const legacySrc = path.join(TEST_DATA_DIR, legacyName);
    // Build mixed content: 2 valid, 1 JSON syntax error, 1 missing id, 1 valid
    const content =
      [
        JSON.stringify(makeEvent({ id: 'valid-1' })),
        '{corrupted json here',
        JSON.stringify({ id: '', timestamp: 1, eventType: 'session_created', userId: 'u', userName: 'n' }),
        JSON.stringify(makeEvent({ id: 'valid-2', timestamp: Date.now() + 1 })),
        JSON.stringify(makeEvent({ id: 'valid-3', timestamp: Date.now() + 2 })),
      ].join('\n') + '\n';
    fs.writeFileSync(legacySrc, content);

    // Also create a dst with same date so merge path runs (malformed skip only activates on merge)
    fs.mkdirSync(TEST_METRICS_DIR, { recursive: true });
    const dst = path.join(TEST_METRICS_DIR, legacyName);
    fs.writeFileSync(dst, JSON.stringify(makeEvent({ id: 'dst-1', timestamp: Date.now() + 3 })) + '\n');

    const s = new MetricsEventStore(TEST_DATA_DIR);
    await s.append(makeEvent()); // trigger migration

    const merged = fs
      .readFileSync(dst, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    // Expect: 3 valid from src + 1 from dst = 4 total (2 skipped as corrupt)
    expect(merged).toHaveLength(4);
    const ids = merged.map((l) => JSON.parse(l).id).sort();
    expect(ids).toEqual(['dst-1', 'valid-1', 'valid-2', 'valid-3']);
  });

  // P0-4 plan §Test Plan #6
  it('migrate_deterministicSortOnTiedTimestamp', async () => {
    const date = '2026-03-20';
    const legacyName = `metrics-events-${date}.jsonl`;
    const legacySrc = path.join(TEST_DATA_DIR, legacyName);
    const metricsDst = path.join(TEST_METRICS_DIR, legacyName);
    fs.mkdirSync(TEST_METRICS_DIR, { recursive: true });

    const tiedTs = new Date('2026-03-20T10:00:00Z').getTime();
    // Intentionally reverse-sorted: src has 'b', dst has 'a' — both at same timestamp
    fs.writeFileSync(legacySrc, JSON.stringify(makeEvent({ id: 'b', timestamp: tiedTs })) + '\n');
    fs.writeFileSync(metricsDst, JSON.stringify(makeEvent({ id: 'a', timestamp: tiedTs })) + '\n');

    const s = new MetricsEventStore(TEST_DATA_DIR);
    const events = await s.readRange(date, date);

    // Tiebreak by id asc → a before b, regardless of which file held which
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  // P1-4 plan §Test Plan #7
  it('migrate_survivesRenameFailure', async () => {
    const legacyName = 'metrics-events-2026-03-20.jsonl';
    const legacySrc = path.join(TEST_DATA_DIR, legacyName);
    fs.writeFileSync(legacySrc, JSON.stringify(makeEvent({ id: 'keep' })) + '\n');

    // Mock fs.promises.rename to throw EACCES once (non-EXDEV)
    const originalRename = fs.promises.rename;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      const err: any = new Error('EACCES');
      err.code = 'EACCES';
      throw err;
    });

    const s = new MetricsEventStore(TEST_DATA_DIR);
    await s.append(makeEvent()); // triggers migration; failure should be logged, not thrown

    // Legacy src must remain untouched (failure preserves data)
    expect(fs.existsSync(legacySrc)).toBe(true);
    const preserved = fs.readFileSync(legacySrc, 'utf-8').trim();
    expect(JSON.parse(preserved).id).toBe('keep');

    renameSpy.mockRestore();
    fs.promises.rename = originalRename;
  });

  // NTH-3 plan §Test Plan #8 — pure function unit test
  it('mergeJsonl_unitTest', () => {
    const a = JSON.stringify({
      id: 'a',
      timestamp: 100,
      eventType: 'turn_used',
      userId: 'u',
      userName: 'n',
    });
    const b = JSON.stringify({
      id: 'b',
      timestamp: 50,
      eventType: 'turn_used',
      userId: 'u',
      userName: 'n',
    });
    const aDup = JSON.stringify({
      id: 'a',
      timestamp: 100,
      eventType: 'turn_used',
      userId: 'u',
      userName: 'n',
    });
    const corrupt = '{not valid json';
    const noId = JSON.stringify({ timestamp: 1, eventType: 'x' });
    const badTs = JSON.stringify({ id: 'badTs', timestamp: 'not-a-number', eventType: 'x' });

    const {
      out,
      duplicates,
      corrupt: corruptCount,
    } = mergeJsonl(`${a}\n${corrupt}\n${noId}\n${badTs}\n`, `${b}\n${aDup}\n`);

    expect(duplicates).toBe(1);
    // 3 corrupt = JSON syntax error + missing id + non-number timestamp
    expect(corruptCount).toBe(3);

    const lines = out.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    // Sort: b (ts=50) before a (ts=100)
    expect(JSON.parse(lines[0]).id).toBe('b');
    expect(JSON.parse(lines[1]).id).toBe('a');

    // Empty input
    const empty = mergeJsonl('', '');
    expect(empty.out).toBe('');
    expect(empty.duplicates).toBe(0);
    expect(empty.corrupt).toBe(0);
  });

  // P1-1 plan §Test Plan #9
  it('migrate_cleansStaleTmp', async () => {
    fs.mkdirSync(TEST_METRICS_DIR, { recursive: true });
    const staleTmp = path.join(TEST_METRICS_DIR, 'metrics-events-2026-03-20.jsonl.tmp-9999-123456');
    fs.writeFileSync(staleTmp, 'garbage');
    // Set mtime to 15 min ago
    const past = (Date.now() - 15 * 60 * 1000) / 1000;
    fs.utimesSync(staleTmp, past, past);

    // Fresh store triggers ensureDir → cleanupStaleTmp
    const s = new MetricsEventStore(TEST_DATA_DIR);
    await s.readRange('2026-03-20', '2026-03-20');

    expect(fs.existsSync(staleTmp)).toBe(false);
  });

  // P0-3 plan §Test Plan #10
  it('migrate_crossDeviceFallback', async () => {
    const legacyName = 'metrics-events-2026-03-20.jsonl';
    const legacySrc = path.join(TEST_DATA_DIR, legacyName);
    fs.writeFileSync(legacySrc, JSON.stringify(makeEvent({ id: 'xdev' })) + '\n');

    // Mock rename to throw EXDEV on the src→dst rename (but let tmp→dst succeed if any)
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async () => {
      const err: any = new Error('EXDEV');
      err.code = 'EXDEV';
      throw err;
    });
    // Subsequent rename calls use real impl — but spy.mockImplementationOnce only mocks first call
    // leaving tmp→dst rename inside copyThenUnlink to run unmocked (which would also hit the mock
    // again if we used .mockImplementation). Check how many renames happen: migrateOne src-missing
    // → rename (mocked EXDEV) → copyThenUnlink(src, dst) which does copyFile→rename→unlink.
    // That second rename should use real impl. vi.spyOn default preserves impl after mockOnce.

    const s = new MetricsEventStore(TEST_DATA_DIR);
    await s.append(makeEvent());

    // End state: src gone, dst has the legacy event
    expect(fs.existsSync(legacySrc)).toBe(false);
    const dst = path.join(TEST_METRICS_DIR, legacyName);
    expect(fs.existsSync(dst)).toBe(true);
    const content = fs.readFileSync(dst, 'utf-8').trim();
    expect(JSON.parse(content).id).toBe('xdev');

    renameSpy.mockRestore();
  });

  // P0-1 direct trace plan §Test Plan #11
  it('migrate_runsOnceAcrossInstances', async () => {
    // Plant 1 legacy file so migration has work to do
    const legacySrc = path.join(TEST_DATA_DIR, 'metrics-events-2026-03-20.jsonl');
    fs.writeFileSync(legacySrc, JSON.stringify(makeEvent({ id: 'once' })) + '\n');

    const readdirSpy = vi.spyOn(fs.promises, 'readdir');

    // 2 instances + 3 concurrent operations
    const s1 = new MetricsEventStore(TEST_DATA_DIR);
    const s2 = new MetricsEventStore(TEST_DATA_DIR);
    await Promise.all([
      s1.append(makeEvent({ id: 'e1' })),
      s2.append(makeEvent({ id: 'e2' })),
      s1.readRange('2026-03-20', '2026-03-20'),
    ]);

    // The legacy migration (migrateLegacyFiles → readdir on TEST_DATA_DIR) must
    // fire exactly once despite 2 instances & 3 concurrent ops. (TEST_METRICS_DIR
    // is also listed by the per-operation day-file import check, so its count is
    // not a migration signal any more.)
    const dataDirCalls = readdirSpy.mock.calls.filter(
      (c) => path.resolve(String(c[0])) === path.resolve(TEST_DATA_DIR),
    );

    expect(dataDirCalls).toHaveLength(1);

    readdirSpy.mockRestore();
  });
});
