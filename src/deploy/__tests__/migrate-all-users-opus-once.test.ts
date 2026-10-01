/**
 * 2026-09-28 one-time ALL-USER default rewrite to the latest opus.
 *
 * The property under test is "exactly once, ever": the marker is presence-only
 * (a corrupt marker still skips), and a user who changes their model after
 * the rewrite is never rewritten again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_ALIASES, UserSettingsStore } from '../../user-settings-store';
import {
  ALL_USERS_OPUS_ONCE_MARKER,
  ALL_USERS_OPUS_ONCE_SNAPSHOT,
  migrateAllUsersOpusOnce,
} from '../migrate-all-users-opus-once';

// Fault injection: make the user-settings.json data write throw on demand,
// while every other atomic write (the marker included) goes through for real.
const fault = vi.hoisted(() => ({ failSettingsWrite: false }));
vi.mock('@soma/common/atomic-write', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@soma/common/atomic-write')>();
  return {
    ...orig,
    atomicWriteJson: (target: string, value: unknown, opts?: Parameters<typeof orig.atomicWriteJson>[2]) => {
      if (fault.failSettingsWrite && target.endsWith('user-settings.json')) throw new Error('injected write failure');
      return orig.atomicWriteJson(target, value, opts);
    },
  };
});

afterEach(() => {
  fault.failSettingsWrite = false;
});

const TARGET = 'claude-opus-5-5[1m]';

function makeDataDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'all-users-opus-')), 'data');
}

function writeSettings(dataDir: string, settings: Record<string, Record<string, unknown>>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'user-settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}

function readSettings(dataDir: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8'));
}

const POPULATION: Record<string, Record<string, unknown>> = {
  U_SOL: { userId: 'U_SOL', defaultModel: 'gpt-5.6-sol', persona: 'a', accepted: true },
  U_FABLE: { userId: 'U_FABLE', defaultModel: 'claude-fable-5-1[1m]', accepted: true },
  U_SONNET: { userId: 'U_SONNET', defaultModel: 'claude-sonnet-4-6', defaultEffort: 'xhigh' },
  U_OPUS_OLD: { userId: 'U_OPUS_OLD', defaultModel: 'claude-opus-4-8[1m]' },
  U_ON_TARGET: { userId: 'U_ON_TARGET', defaultModel: TARGET },
  U_NO_MODEL: { userId: 'U_NO_MODEL', accepted: true },
};

describe('migrateAllUsersOpusOnce', () => {
  it('targets the current `opus` alias (claude-opus-5-5[1m])', () => {
    expect(MODEL_ALIASES.opus).toBe(TARGET);
    const dataDir = makeDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    expect(migrateAllUsersOpusOnce({ dataDir }).target).toBe(TARGET);
  });

  it('rewrites EVERY user default (non-opus and missing included) and keeps other fields', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);

    const result = migrateAllUsersOpusOnce({ dataDir });

    expect(result.status).toBe('applied');
    expect(result.total).toBe(6);
    // U_ON_TARGET already there → 5 changed.
    expect(result.migrated).toBe(5);
    const after = readSettings(dataDir);
    for (const u of Object.keys(POPULATION)) {
      expect(after[u]?.defaultModel).toBe(TARGET);
      const { defaultModel: _a, ...restAfter } = after[u] as Record<string, unknown>;
      const { defaultModel: _b, ...restBefore } = POPULATION[u] as Record<string, unknown>;
      expect(restAfter).toEqual(restBefore);
    }
  });

  it('keeps a pre-rewrite snapshot of the original per-user choices', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    migrateAllUsersOpusOnce({ dataDir });
    const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_SNAPSHOT), 'utf8'));
    expect(snapshot).toEqual(POPULATION);
  });

  it('writes the marker with target + counts + timestamp', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    const now = new Date('2026-09-28T10:00:00.000Z');
    migrateAllUsersOpusOnce({ dataDir, now: () => now });
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_MARKER), 'utf8'));
    expect(marker).toEqual({ migratedAt: '2026-09-28T10:00:00.000Z', target: TARGET, migrated: 5, total: 6 });
  });

  it('applies once: a second run is skipped and leaves the file byte-identical', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    migrateAllUsersOpusOnce({ dataDir });
    const file = path.join(dataDir, 'user-settings.json');
    const afterFirst = fs.readFileSync(file, 'utf8');

    const second = migrateAllUsersOpusOnce({ dataDir });

    expect(second.status).toBe('skipped');
    expect(second.migrated).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(afterFirst);
  });

  it('skips when the marker already exists, without reading or writing settings', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    fs.writeFileSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_MARKER), JSON.stringify({ migratedAt: 'x' }), 'utf8');
    const before = fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8');

    const result = migrateAllUsersOpusOnce({ dataDir });

    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8')).toBe(before);
  });

  it('treats a CORRUPT marker as done (presence-only) — never re-runs', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    fs.writeFileSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_MARKER), '{not json', 'utf8');
    const before = fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8');

    const result = migrateAllUsersOpusOnce({ dataDir });

    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8')).toBe(before);
  });

  it('a user who switches back after the rewrite survives a second run', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    migrateAllUsersOpusOnce({ dataDir });

    const store = new UserSettingsStore(dataDir);
    store.setUserDefaultModel('U_SOL', 'gpt-5.6-sol');
    expect(migrateAllUsersOpusOnce({ dataDir }).status).toBe('skipped');

    expect(readSettings(dataDir).U_SOL?.defaultModel).toBe('gpt-5.6-sol');
    expect(new UserSettingsStore(dataDir).getUserDefaultModel('U_SOL')).toBe('gpt-5.6-sol');
  });

  it('reloadSettings() makes a store loaded BEFORE the migration see the new defaults', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    const store = new UserSettingsStore(dataDir);
    expect(store.getUserDefaultModel('U_SOL')).toBe('gpt-5.6-sol');

    const result = migrateAllUsersOpusOnce({ dataDir });
    expect(result.migrated).toBeGreaterThan(0);
    // Stale until reloaded — the index.ts wiring reloads on migrated > 0.
    expect(store.getUserDefaultModel('U_SOL')).toBe('gpt-5.6-sol');

    store.reloadSettings();
    for (const u of Object.keys(POPULATION)) {
      expect(store.getUserDefaultModel(u)).toBe(TARGET);
    }
  });

  it('does not write settings when everyone is already on target, but still marks', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, { U1: { userId: 'U1', defaultModel: TARGET } });
    const file = path.join(dataDir, 'user-settings.json');
    const before = fs.readFileSync(file, 'utf8');

    const result = migrateAllUsersOpusOnce({ dataDir });

    expect(result).toMatchObject({ status: 'applied', migrated: 0, total: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_SNAPSHOT))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_MARKER))).toBe(true);
  });

  it('marks a fresh install (no user-settings.json) as done', () => {
    const dataDir = makeDataDir();
    const result = migrateAllUsersOpusOnce({ dataDir });
    expect(result).toMatchObject({ status: 'applied', migrated: 0, total: 0 });
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_MARKER))).toBe(true);
  });

  it('never touches sessions.json', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    const sessionsFile = path.join(dataDir, 'sessions.json');
    const sentinel = JSON.stringify({ 'C1:1.1': { model: 'gpt-5.6-sol' } });
    fs.writeFileSync(sessionsFile, sentinel, 'utf8');
    migrateAllUsersOpusOnce({ dataDir });
    expect(fs.readFileSync(sessionsFile, 'utf8')).toBe(sentinel);
  });

  it('data write fails AFTER the marker: rethrows, next run skips, a later user choice is never overwritten', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    const file = path.join(dataDir, 'user-settings.json');
    const before = fs.readFileSync(file, 'utf8');

    fault.failSettingsWrite = true;
    expect(() => migrateAllUsersOpusOnce({ dataDir })).toThrow('injected write failure');
    fault.failSettingsWrite = false;

    // Marker landed first; the data did not change (a missed one-shot).
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_MARKER))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    // A user makes a choice in between; the next boot must not replay.
    new UserSettingsStore(dataDir).setUserDefaultModel('U_SOL', 'gpt-6-astra[1m]');
    expect(migrateAllUsersOpusOnce({ dataDir }).status).toBe('skipped');
    expect(readSettings(dataDir).U_SOL?.defaultModel).toBe('gpt-6-astra[1m]');
    expect(readSettings(dataDir).U_FABLE?.defaultModel).toBe('claude-fable-5-1[1m]');
  });

  it.each([
    ['an array user record', '{"U1": ["x"]}'],
    ['a primitive user record', '{"U1": "gpt-5.6-sol"}'],
    ['a null user record', '{"U1": null}'],
    ['an array root', '[{"userId":"U1"}]'],
  ])('throws on %s with no marker and no write', (_label, body) => {
    const dataDir = makeDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'user-settings.json');
    fs.writeFileSync(file, body, 'utf8');

    expect(() => migrateAllUsersOpusOnce({ dataDir })).toThrow();
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_SNAPSHOT))).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
  });

  it('a corrupt user-settings.json throws BEFORE the marker is written (not burned)', () => {
    const dataDir = makeDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'user-settings.json'), '{broken', 'utf8');
    expect(() => migrateAllUsersOpusOnce({ dataDir })).toThrow();
    expect(fs.existsSync(path.join(dataDir, ALL_USERS_OPUS_ONCE_MARKER))).toBe(false);
  });
});
