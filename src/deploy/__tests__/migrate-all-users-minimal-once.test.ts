/**
 * 2026-10-16 one-time ALL-USER Slack verbosity rewrite to `minimal` (spec 10
 * §3.2-1).
 *
 * The property under test is "exactly once, ever": the marker is presence-only
 * (a corrupt marker still skips) and lands before the data, so a user who
 * picks another level after the rewrite is never rewritten again. Both stores
 * move: `user-settings.json` defaults and every persisted session mask in
 * `sessions.json`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getVerbosityFlags, LOG_MINIMAL } from '@soma/slack/output-flags';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserSettingsStore } from '../../user-settings-store';
import {
  ALL_USERS_LOG_MINIMAL_ONCE_MARKER,
  ALL_USERS_LOG_MINIMAL_ONCE_SESSIONS_SNAPSHOT,
  ALL_USERS_LOG_MINIMAL_ONCE_SETTINGS_SNAPSHOT,
  migrateAllUsersMinimalOnce,
} from '../migrate-all-users-minimal-once';

// Fault injection: make one data write throw on demand, while every other
// atomic write (the marker included) goes through for real.
const fault = vi.hoisted(() => ({ failWriteOf: '' }));
vi.mock('@soma/common/atomic-write', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@soma/common/atomic-write')>();
  return {
    ...orig,
    atomicWriteJson: (target: string, value: unknown, opts?: Parameters<typeof orig.atomicWriteJson>[2]) => {
      if (fault.failWriteOf && target.endsWith(fault.failWriteOf)) throw new Error('injected write failure');
      return orig.atomicWriteJson(target, value, opts);
    },
  };
});

afterEach(() => {
  fault.failWriteOf = '';
});

function makeDataDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'all-users-minimal-')), 'data');
}

function write(dataDir: string, file: string, value: unknown): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(value, null, 2), 'utf8');
}

// biome-ignore lint/suspicious/noExplicitAny: JSON fixtures read back for field-level assertions
function read(dataDir: string, file: string): any {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
}

const USERS: Record<string, Record<string, unknown>> = {
  U_DETAIL: { userId: 'U_DETAIL', defaultModel: 'claude-opus-5-5[1m]', defaultLogVerbosity: 'detail', accepted: true },
  U_VERBOSE: { userId: 'U_VERBOSE', defaultLogVerbosity: 'verbose' },
  U_COMPACT: { userId: 'U_COMPACT', defaultLogVerbosity: 'compact', persona: 'linus' },
  U_MINIMAL: { userId: 'U_MINIMAL', defaultLogVerbosity: 'minimal' },
  U_UNSET: { userId: 'U_UNSET', accepted: true },
};

const SESSIONS = [
  { key: 'C1-1.1', ownerId: 'U_DETAIL', sessionId: 's1', logVerbosity: getVerbosityFlags('detail'), model: 'm' },
  { key: 'C1-2.2', ownerId: 'U_VERBOSE', sessionId: 's2', logVerbosity: getVerbosityFlags('verbose') },
  { key: 'C1-3.3', ownerId: 'U_MINIMAL', sessionId: 's3', logVerbosity: LOG_MINIMAL },
  // No mask at all: consumers fall back to detail, so it must be written too.
  { key: 'C1-4.4', ownerId: 'U_UNSET', sessionId: 's4' },
];

describe('migrateAllUsersMinimalOnce', () => {
  it('rewrites every user default to minimal and keeps every other field', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'user-settings.json', USERS);

    const result = migrateAllUsersMinimalOnce({ dataDir });

    expect(result.status).toBe('applied');
    expect(result.users).toEqual({ migrated: 4, total: 5 });
    const after = read(dataDir, 'user-settings.json');
    for (const u of Object.keys(USERS)) {
      expect(after[u].defaultLogVerbosity).toBe('minimal');
      const { defaultLogVerbosity: _a, ...restAfter } = after[u];
      const { defaultLogVerbosity: _b, ...restBefore } = USERS[u] as Record<string, unknown>;
      expect(restAfter).toEqual(restBefore);
    }
  });

  it('rewrites every session mask (missing ones included) to LOG_MINIMAL and keeps every other field', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'sessions.json', SESSIONS);

    const result = migrateAllUsersMinimalOnce({ dataDir });

    expect(result.sessions).toEqual({ migrated: 3, total: 4 });
    const after = read(dataDir, 'sessions.json') as Array<Record<string, unknown>>;
    expect(after).toHaveLength(SESSIONS.length);
    after.forEach((session, i) => {
      expect(session.logVerbosity).toBe(LOG_MINIMAL);
      const { logVerbosity: _a, ...restAfter } = session;
      const { logVerbosity: _b, ...restBefore } = SESSIONS[i] as Record<string, unknown>;
      expect(restAfter).toEqual(restBefore);
    });
  });

  it('keeps pre-rewrite snapshots of both files', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'user-settings.json', USERS);
    write(dataDir, 'sessions.json', SESSIONS);

    migrateAllUsersMinimalOnce({ dataDir });

    expect(read(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_SETTINGS_SNAPSHOT)).toEqual(USERS);
    expect(read(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_SESSIONS_SNAPSHOT)).toEqual(SESSIONS);
  });

  it('writes the marker with the ATTEMPTED counts (pre-data) + timestamp', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'user-settings.json', USERS);
    write(dataDir, 'sessions.json', SESSIONS);
    const now = new Date('2026-10-16T09:00:00.000Z');

    const result = migrateAllUsersMinimalOnce({ dataDir, now: () => now });

    expect(result.markerFile).toBe(path.join(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_MARKER));
    expect(ALL_USERS_LOG_MINIMAL_ONCE_MARKER).toBe('.all-users-log-minimal-once-2026-10-16.json');
    expect(read(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_MARKER)).toEqual({
      markedAt: '2026-10-16T09:00:00.000Z',
      mask: LOG_MINIMAL,
      attemptedUsers: 4,
      totalUsers: 5,
      attemptedSessions: 3,
      totalSessions: 4,
    });
  });

  it('applies once: a second run is skipped and leaves both files byte-identical', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'user-settings.json', USERS);
    write(dataDir, 'sessions.json', SESSIONS);
    migrateAllUsersMinimalOnce({ dataDir });
    const settingsAfter = fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8');
    const sessionsAfter = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');

    const second = migrateAllUsersMinimalOnce({ dataDir });

    expect(second.status).toBe('skipped');
    expect(second.users).toEqual({ migrated: 0, total: 0 });
    expect(second.sessions).toEqual({ migrated: 0, total: 0 });
    expect(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8')).toBe(settingsAfter);
    expect(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8')).toBe(sessionsAfter);
  });

  it('treats a CORRUPT marker as done (presence-only) — never re-runs', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'user-settings.json', USERS);
    write(dataDir, 'sessions.json', SESSIONS);
    fs.writeFileSync(path.join(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_MARKER), '{not json', 'utf8');
    const settingsBefore = fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8');
    const sessionsBefore = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');

    expect(migrateAllUsersMinimalOnce({ dataDir }).status).toBe('skipped');
    expect(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8')).toBe(settingsBefore);
    expect(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8')).toBe(sessionsBefore);
  });

  it('a user who picks another level after the rewrite survives a second run', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'user-settings.json', USERS);
    migrateAllUsersMinimalOnce({ dataDir });

    new UserSettingsStore(dataDir).setUserDefaultLogVerbosity('U_DETAIL', 'detail');
    expect(migrateAllUsersMinimalOnce({ dataDir }).status).toBe('skipped');

    expect(new UserSettingsStore(dataDir).getUserDefaultLogVerbosity('U_DETAIL')).toBe('detail');
  });

  it('reloadSettings() makes a store loaded BEFORE the migration see minimal', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'user-settings.json', USERS);
    const store = new UserSettingsStore(dataDir);
    expect(store.getUserDefaultLogVerbosity('U_DETAIL')).toBe('detail');

    migrateAllUsersMinimalOnce({ dataDir });
    store.reloadSettings();

    for (const u of Object.keys(USERS)) {
      expect(store.getUserDefaultLogVerbosity(u)).toBe('minimal');
      expect(store.getUserLogVerbosityFlags(u)).toBe(LOG_MINIMAL);
    }
  });

  it('does not rewrite a file that is already all-minimal, but still marks', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'user-settings.json', { U1: { userId: 'U1', defaultLogVerbosity: 'minimal' } });
    write(dataDir, 'sessions.json', [{ key: 'k', sessionId: 's', logVerbosity: LOG_MINIMAL }]);
    const settingsBefore = fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8');
    const sessionsBefore = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');

    const result = migrateAllUsersMinimalOnce({ dataDir });

    expect(result).toMatchObject({
      status: 'applied',
      users: { migrated: 0, total: 1 },
      sessions: { migrated: 0, total: 1 },
    });
    expect(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8')).toBe(settingsBefore);
    expect(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8')).toBe(sessionsBefore);
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_SETTINGS_SNAPSHOT))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_SESSIONS_SNAPSHOT))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_MARKER))).toBe(true);
  });

  it('marks a fresh install (neither file) as done', () => {
    const dataDir = makeDataDir();

    const result = migrateAllUsersMinimalOnce({ dataDir });

    expect(result).toMatchObject({ status: 'applied', users: { migrated: 0, total: 0 } });
    expect(result.sessions).toEqual({ migrated: 0, total: 0 });
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'sessions.json'))).toBe(false);
  });

  it('migrates sessions even when user-settings.json is missing (and vice versa)', () => {
    const sessionsOnly = makeDataDir();
    write(sessionsOnly, 'sessions.json', SESSIONS);
    expect(migrateAllUsersMinimalOnce({ dataDir: sessionsOnly }).sessions).toEqual({ migrated: 3, total: 4 });

    const usersOnly = makeDataDir();
    write(usersOnly, 'user-settings.json', USERS);
    expect(migrateAllUsersMinimalOnce({ dataDir: usersOnly }).users).toEqual({ migrated: 4, total: 5 });
  });

  it('a data write failing AFTER the marker rethrows, and the next run skips', () => {
    const dataDir = makeDataDir();
    write(dataDir, 'user-settings.json', USERS);
    write(dataDir, 'sessions.json', SESSIONS);

    fault.failWriteOf = 'sessions.json';
    expect(() => migrateAllUsersMinimalOnce({ dataDir })).toThrow('injected write failure');
    fault.failWriteOf = '';

    // Marker landed first: a missed one-shot, never a replay. Its counts say
    // what was attempted, not what was written.
    expect(read(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_MARKER)).toMatchObject({ attemptedSessions: 3, totalSessions: 4 });
    expect(read(dataDir, 'sessions.json')).toEqual(SESSIONS);
    new UserSettingsStore(dataDir).setUserDefaultLogVerbosity('U_COMPACT', 'compact');
    expect(migrateAllUsersMinimalOnce({ dataDir }).status).toBe('skipped');
    expect(new UserSettingsStore(dataDir).getUserDefaultLogVerbosity('U_COMPACT')).toBe('compact');
  });

  it.each([
    ['user-settings.json', 'an array user record', '{"U1": ["x"]}'],
    ['user-settings.json', 'a null user record', '{"U1": null}'],
    ['user-settings.json', 'an array root', '[{"userId":"U1"}]'],
    ['user-settings.json', 'broken JSON', '{broken'],
    ['sessions.json', 'an object root', '{"C1-1.1": {"logVerbosity": 1}}'],
    ['sessions.json', 'a primitive session record', '[1]'],
    ['sessions.json', 'a null session record', '[null]'],
    ['sessions.json', 'broken JSON', '[{'],
  ])('throws on %s with %s — no marker, no write', (file, _label, body) => {
    const dataDir = makeDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const other = file === 'sessions.json' ? 'user-settings.json' : 'sessions.json';
    const otherBody = file === 'sessions.json' ? JSON.stringify(USERS) : JSON.stringify(SESSIONS);
    fs.writeFileSync(path.join(dataDir, file), body, 'utf8');
    fs.writeFileSync(path.join(dataDir, other), otherBody, 'utf8');

    expect(() => migrateAllUsersMinimalOnce({ dataDir })).toThrow();

    expect(fs.existsSync(path.join(dataDir, ALL_USERS_LOG_MINIMAL_ONCE_MARKER))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, file), 'utf8')).toBe(body);
    expect(fs.readFileSync(path.join(dataDir, other), 'utf8')).toBe(otherBody);
  });
});
