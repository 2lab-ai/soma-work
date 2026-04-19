import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetMetricsEnsureCache, MetricsEventStore, mergeJsonl } from './event-store';
import type { MetricsEvent } from './types';

// Contract tests — Scenario 1: MetricsEventStore (JSONL Storage Layer)
// Trace: docs/daily-weekly-report/trace.md

const TEST_DATA_DIR = path.join(__dirname, '../../.test-data-metrics');
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
    // Clean test directory
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    store = new MetricsEventStore(TEST_DATA_DIR);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  // Trace: Scenario 1, Section 3a — append writes to correct date-based file
  it('append_writesToCorrectDateFile', async () => {
    const event = makeEvent({ timestamp: new Date('2026-03-25T10:00:00Z').getTime() });
    await store.append(event);

    const filePath = path.join(TEST_METRICS_DIR, 'metrics-events-2026-03-25.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe('test-id-1');
    expect(parsed.eventType).toBe('session_created');
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
    const validEvent = JSON.stringify(makeEvent());
    fs.writeFileSync(filePath, `${validEvent}\n{corrupted json\n${validEvent}\n`);

    const events = await store.readRange('2026-03-25', '2026-03-25');
    expect(events).toHaveLength(2); // 2 valid, 1 skipped
  });

  // Trace: Scenario 1, Section 4 — file created on first write
  it('append_fileCreatedOnFirstWrite', async () => {
    const filePath = path.join(TEST_METRICS_DIR, 'metrics-events-2026-03-25.jsonl');
    expect(fs.existsSync(filePath)).toBe(false);

    await store.append(makeEvent());
    expect(fs.existsSync(filePath)).toBe(true);
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

    const { out, duplicates, corrupt: corruptCount } = mergeJsonl(
      `${a}\n${corrupt}\n${noId}\n${badTs}\n`,
      `${b}\n${aDup}\n`,
    );

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

    // ensureDirOnce runs readdir twice per migration run:
    //   1. cleanupStaleTmp(metricsDir) → readdir on TEST_METRICS_DIR
    //   2. migrateLegacyFiles(dataDir, metricsDir) → readdir on TEST_DATA_DIR
    // Both should fire exactly once total despite 2 instances & 3 concurrent ops.
    const dataDirCalls = readdirSpy.mock.calls.filter(
      (c) => path.resolve(String(c[0])) === path.resolve(TEST_DATA_DIR),
    );
    const metricsDirCalls = readdirSpy.mock.calls.filter(
      (c) => path.resolve(String(c[0])) === path.resolve(TEST_METRICS_DIR),
    );

    expect(dataDirCalls).toHaveLength(1);
    expect(metricsDirCalls).toHaveLength(1);

    readdirSpy.mockRestore();
  });
});
