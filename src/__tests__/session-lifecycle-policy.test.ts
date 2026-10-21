/**
 * Session lifecycle policy store — the admin-editable durations behind
 * sleep, archive and the dashboard's DONE column.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSessionLifecyclePolicyForTests,
  countLifecycleTransitions,
  DEFAULT_SESSION_LIFECYCLE_POLICY,
  getSessionLifecyclePolicy,
  isSessionLifecyclePolicyDegraded,
  parseSessionLifecyclePatch,
  SessionLifecyclePolicyError,
  updateSessionLifecyclePolicy,
} from '../session-lifecycle-policy';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('session lifecycle policy store', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-lifecycle-'));
    file = path.join(dir, 'session-lifecycle.json');
    __resetSessionLifecyclePolicyForTests(file);
  });

  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to the shipped lifecycle: sleep after 24h idle, end after 7d asleep, list archives 48h', () => {
    expect(DEFAULT_SESSION_LIFECYCLE_POLICY).toEqual({
      sleepAfterMs: 24 * HOUR,
      archiveAfterMs: 7 * DAY,
      boardArchiveWindowMs: 48 * HOUR,
    });
    expect(getSessionLifecyclePolicy()).toEqual(DEFAULT_SESSION_LIFECYCLE_POLICY);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('an update merges, persists, and survives a reload', () => {
    const next = updateSessionLifecyclePolicy({ sleepAfterMs: 6 * HOUR, boardArchiveWindowMs: 0 });
    expect(next).toEqual({ ...DEFAULT_SESSION_LIFECYCLE_POLICY, sleepAfterMs: 6 * HOUR, boardArchiveWindowMs: 0 });

    __resetSessionLifecyclePolicyForTests(file); // drop the cache: read from disk
    expect(getSessionLifecyclePolicy()).toEqual(next);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(next);
  });

  it('returns copies: mutating the result does not change the policy', () => {
    const p = getSessionLifecyclePolicy();
    p.sleepAfterMs = 1;
    expect(getSessionLifecyclePolicy().sleepAfterMs).toBe(24 * HOUR);
  });

  it.each([
    [{ sleepAfterMs: HOUR - 1 }, 'sleepAfterMs'],
    [{ sleepAfterMs: 31 * DAY }, 'sleepAfterMs'],
    [{ archiveAfterMs: 0 }, 'archiveAfterMs'],
    [{ boardArchiveWindowMs: -1 }, 'boardArchiveWindowMs'],
    [{ archiveAfterMs: 1.5 * HOUR + 0.5 }, 'archiveAfterMs'],
    [{ sleepAfterMs: '3600000' }, 'sleepAfterMs'],
  ])('refuses %j (field %s) and leaves the stored policy alone', (body, field) => {
    let caught: unknown;
    try {
      updateSessionLifecyclePolicy(body);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionLifecyclePolicyError);
    expect((caught as SessionLifecyclePolicyError).field).toBe(field);
    expect(getSessionLifecyclePolicy()).toEqual(DEFAULT_SESSION_LIFECYCLE_POLICY);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses a malformed body, an unknown key, and an empty update', () => {
    for (const body of [null, [], 'x', {}, { sleepAfter: HOUR }]) {
      expect(() => parseSessionLifecyclePatch(body)).toThrow(SessionLifecyclePolicyError);
    }
  });

  it('a corrupt live file falls back to the .bak generation', () => {
    updateSessionLifecyclePolicy({ sleepAfterMs: 2 * HOUR });
    updateSessionLifecyclePolicy({ sleepAfterMs: 3 * HOUR }); // promotes the 2h file to .bak
    fs.writeFileSync(file, '{ truncated');
    __resetSessionLifecyclePolicyForTests(file);
    expect(getSessionLifecyclePolicy().sleepAfterMs).toBe(2 * HOUR);
  });

  it('a missing file is not degraded; an unusable file and .bak are, until the next save', () => {
    expect(isSessionLifecyclePolicyDegraded()).toBe(false);
    fs.writeFileSync(file, '{ truncated');
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ sleepAfterMs: 1 }));
    __resetSessionLifecyclePolicyForTests(file);
    expect(getSessionLifecyclePolicy()).toEqual(DEFAULT_SESSION_LIFECYCLE_POLICY);
    expect(isSessionLifecyclePolicyDegraded()).toBe(true);
    updateSessionLifecyclePolicy({ sleepAfterMs: 5 * HOUR });
    expect(isSessionLifecyclePolicyDegraded()).toBe(false);
    __resetSessionLifecyclePolicyForTests(file);
    expect(getSessionLifecyclePolicy().sleepAfterMs).toBe(5 * HOUR);
  });
});

describe('countLifecycleTransitions', () => {
  const NOW = Date.parse('2026-10-21T00:00:00Z');
  const from = { sleepAfterMs: 24 * HOUR, archiveAfterMs: 7 * DAY, boardArchiveWindowMs: 48 * HOUR };
  const sessions = [
    { state: 'MAIN', lastActivity: new Date(NOW - 3 * HOUR) },
    { state: 'MAIN', lastActivity: new Date(NOW - 30 * HOUR).toISOString() }, // already past 24h: sweep moves it anyway
    { state: 'SLEEPING', lastActivity: new Date(NOW - 5 * DAY), sleepStartedAt: new Date(NOW - 2 * DAY) },
    { state: 'SLEEPING', lastActivity: new Date(NOW - 9 * DAY), sleepStartedAt: new Date(NOW - 8 * DAY) }, // already past 7d
  ];

  it('counts only sessions the change itself would move', () => {
    expect(
      countLifecycleTransitions(sessions, from, { ...from, sleepAfterMs: 2 * HOUR, archiveAfterMs: DAY }, NOW),
    ).toEqual({
      willSleep: 1,
      willArchive: 1,
    });
  });

  it('lengthening or keeping the durations moves nothing', () => {
    expect(countLifecycleTransitions(sessions, from, from, NOW)).toEqual({ willSleep: 0, willArchive: 0 });
    expect(
      countLifecycleTransitions(sessions, from, { ...from, sleepAfterMs: 48 * HOUR, archiveAfterMs: 30 * DAY }, NOW),
    ).toEqual({ willSleep: 0, willArchive: 0 });
  });
});
