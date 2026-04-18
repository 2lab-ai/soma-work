import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve a sandbox-writable tmp dir before vi.mock hoists. Hoisted so the
// factory below sees it when env-paths gets mocked.
const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-session-registry-timer-test-${process.pid}`),
  };
});

// Mock before importing SessionRegistry so the data-dir resolves to a tmp path.
vi.mock('./env-paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
}));

import { MAX_LEG_MS, SessionRegistry } from './session-registry';

// Keep the `os`/`path`/explicit import above as runtime assertions that we
// resolve the temp dir the same way at test time.
void os;
void path;

describe('SessionRegistry — Dashboard v2.1 turn timer', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('beginTurn/endTurn accumulates elapsed time into activeAccumulatedMs', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '100.001');
    session.sessionId = 'timer-1';

    const t0 = 1_700_000_000_000;
    reg.beginTurn(session, t0);
    expect(session.activeLegStartedAtMs).toBe(t0);
    expect(session.activeAccumulatedMs ?? 0).toBe(0);

    // Finish 5s later
    reg.endTurn(session, t0 + 5_000);
    expect(session.activeLegStartedAtMs).toBeUndefined();
    expect(session.activeAccumulatedMs).toBe(5_000);

    // Second turn adds on top
    reg.beginTurn(session, t0 + 10_000);
    reg.endTurn(session, t0 + 13_500);
    expect(session.activeAccumulatedMs).toBe(8_500);
  });

  it('endTurn without matching beginTurn is a no-op (accumulator unchanged)', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '100.002');
    session.activeAccumulatedMs = 42_000;
    reg.endTurn(session, Date.now());
    expect(session.activeAccumulatedMs).toBe(42_000);
    expect(session.activeLegStartedAtMs).toBeUndefined();
  });

  it('beginTurn with a stale leg folds it in (capped by MAX_LEG_MS)', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C1', '100.003');
    const t0 = 1_700_000_000_000;
    // Simulate a crash mid-turn where activeLegStartedAtMs was never cleared
    // and a very long time has passed (well beyond MAX_LEG_MS).
    session.activeLegStartedAtMs = t0;
    const laterFarPastCap = t0 + MAX_LEG_MS + 60 * 60 * 1000; // +1h past the cap
    reg.beginTurn(session, laterFarPastCap);

    // The stale leg should have contributed at most MAX_LEG_MS.
    expect(session.activeAccumulatedMs).toBe(MAX_LEG_MS);
    // And a new leg should now be running.
    expect(session.activeLegStartedAtMs).toBe(laterFarPastCap);
  });

  it('boot orphan sweep folds a pre-crash active leg (capped)', () => {
    // Write a sessions.json with an activeLegStartedAtMs "from the past" but no endTurn.
    // Reloading should fold the stale leg into activeAccumulatedMs.
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'User', 'C1', '100.004');
    session.sessionId = 'orphan-1';
    session.activeLegStartedAtMs = Date.now() - (MAX_LEG_MS + 60_000); // >cap old
    session.activeAccumulatedMs = 1_000;
    writer.saveSessions();

    const reader = new SessionRegistry();
    const loaded = reader.loadSessions();
    expect(loaded).toBe(1);
    const restored = reader.getSession('C1', '100.004');
    expect(restored).toBeDefined();
    expect(restored?.activeLegStartedAtMs).toBeUndefined();
    // accumulator = 1_000 + cap
    expect(restored?.activeAccumulatedMs).toBe(1_000 + MAX_LEG_MS);
  });

  it('getThreadAggregate derives live totals from the active session only (one per threadKey)', () => {
    // NOTE: sessions map is keyed by `channelId-threadTs`, so a thread has at
    // most one live session in-memory. Cross-session historical totals are
    // owned by the archive store (follow-up: wire archive into aggregate).
    const reg = new SessionRegistry();
    const live = reg.createSession('U1', 'User', 'C1', '200.001');
    live.activeAccumulatedMs = 5_000;
    live.compactionCount = 3;

    // A different thread must not leak into C1/200.001's aggregate.
    const other = reg.createSession('U1', 'User', 'C2', '200.001');
    other.activeAccumulatedMs = 999_999;
    other.compactionCount = 42;

    const agg = reg.getThreadAggregate('C1', '200.001');
    expect(agg.totalActiveMs).toBe(5_000);
    expect(agg.sessionCount).toBe(1);
    expect(agg.compactionCount).toBe(3);
  });

  it('getThreadAggregate includes live leg time (capped by MAX_LEG_MS)', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'User', 'C1', '300.001');
    s.activeAccumulatedMs = 1_000;
    const t0 = Date.now();
    s.activeLegStartedAtMs = t0;

    const agg1 = reg.getThreadAggregate('C1', '300.001', t0 + 2_000);
    expect(agg1.totalActiveMs).toBe(3_000);

    // Live leg longer than cap should be truncated.
    const agg2 = reg.getThreadAggregate('C1', '300.001', t0 + MAX_LEG_MS + 99_999);
    expect(agg2.totalActiveMs).toBe(1_000 + MAX_LEG_MS);
  });
});
