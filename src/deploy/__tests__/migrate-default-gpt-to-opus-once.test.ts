/**
 * 2026-11-19 one-time rewrite of users on the OLD default (gpt-5.6-sol, or the
 * retired gpt-5.5) to the latest opus.
 *
 * The properties under test: only the previous default moves (every other
 * saved choice is kept), and "exactly once, ever" — the marker is
 * presence-only (a corrupt marker still skips), and a user who switches back
 * after the rewrite is never rewritten again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, MODEL_ALIASES, UserSettingsStore } from '../../user-settings-store';
import {
  DEFAULT_GPT_TO_OPUS_ONCE_MARKER,
  DEFAULT_GPT_TO_OPUS_ONCE_SNAPSHOT,
  migrateDefaultGptToOpusOnce,
} from '../migrate-default-gpt-to-opus-once';

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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'default-gpt-to-opus-')), 'data');
}

function writeSettings(dataDir: string, settings: Record<string, Record<string, unknown>>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'user-settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}

function readSettings(dataDir: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8'));
}

// Users on the previous default (any spelling coercion folds) and on the
// retired gpt-5.5 move; everyone else keeps their saved value.
const MOVES = ['U_SOL', 'U_SOL_CASE', 'U_GPT55', 'U_GPT55_ALIAS'] as const;
const POPULATION: Record<string, Record<string, unknown>> = {
  U_SOL: { userId: 'U_SOL', defaultModel: 'gpt-5.6-sol', persona: 'a', accepted: true },
  U_SOL_CASE: { userId: 'U_SOL_CASE', defaultModel: '  GPT-5.6-SOL ', defaultEffort: 'xhigh' },
  U_GPT55: { userId: 'U_GPT55', defaultModel: 'gpt-5.5', accepted: true },
  U_GPT55_ALIAS: { userId: 'U_GPT55_ALIAS', defaultModel: 'gpt5.5' },
  U_SOL_1M: { userId: 'U_SOL_1M', defaultModel: 'gpt-5.6-sol[1m]', accepted: true },
  U_SOL_62: { userId: 'U_SOL_62', defaultModel: 'gpt-6.2-sol[1m]' },
  U_TERRA: { userId: 'U_TERRA', defaultModel: 'gpt-5.6-terra' },
  U_FABLE: { userId: 'U_FABLE', defaultModel: 'claude-fable-5-1[1m]', accepted: true },
  U_SONNET: { userId: 'U_SONNET', defaultModel: 'claude-sonnet-4-6', defaultEffort: 'xhigh' },
  U_ON_TARGET: { userId: 'U_ON_TARGET', defaultModel: TARGET },
  U_NO_MODEL: { userId: 'U_NO_MODEL', accepted: true },
};
const TOTAL = Object.keys(POPULATION).length;

describe('migrateDefaultGptToOpusOnce', () => {
  it('targets the current `opus` alias, which is DEFAULT_MODEL (claude-opus-5-5[1m])', () => {
    expect(MODEL_ALIASES.opus).toBe(TARGET);
    expect(DEFAULT_MODEL).toBe(TARGET);
    const dataDir = makeDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    expect(migrateDefaultGptToOpusOnce({ dataDir }).target).toBe(TARGET);
  });

  it('moves ONLY gpt-5.6-sol / gpt-5.5 defaults; every other saved value (and missing) is kept', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);

    const result = migrateDefaultGptToOpusOnce({ dataDir });

    expect(result.status).toBe('applied');
    expect(result.total).toBe(TOTAL);
    expect(result.migrated).toBe(MOVES.length);
    const after = readSettings(dataDir);
    for (const u of Object.keys(POPULATION)) {
      const moved = (MOVES as readonly string[]).includes(u);
      expect(after[u]?.defaultModel).toBe(moved ? TARGET : POPULATION[u]?.defaultModel);
      // Every other field is untouched.
      const { defaultModel: _a, ...restAfter } = after[u] as Record<string, unknown>;
      const { defaultModel: _b, ...restBefore } = POPULATION[u] as Record<string, unknown>;
      expect(restAfter).toEqual(restBefore);
    }
    expect(after.U_NO_MODEL).not.toHaveProperty('defaultModel');
  });

  it('keeps a pre-rewrite snapshot of the original per-user choices', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    migrateDefaultGptToOpusOnce({ dataDir });
    const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_SNAPSHOT), 'utf8'));
    expect(snapshot).toEqual(POPULATION);
  });

  it('writes the marker with target + counts + timestamp', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    const now = new Date('2026-11-19T10:00:00.000Z');
    migrateDefaultGptToOpusOnce({ dataDir, now: () => now });
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_MARKER), 'utf8'));
    expect(marker).toEqual({
      migratedAt: '2026-11-19T10:00:00.000Z',
      target: TARGET,
      migrated: MOVES.length,
      total: TOTAL,
    });
  });

  it('applies once: a second run is skipped and leaves the file byte-identical', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    migrateDefaultGptToOpusOnce({ dataDir });
    const file = path.join(dataDir, 'user-settings.json');
    const afterFirst = fs.readFileSync(file, 'utf8');

    const second = migrateDefaultGptToOpusOnce({ dataDir });

    expect(second.status).toBe('skipped');
    expect(second.migrated).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(afterFirst);
  });

  it('skips when the marker already exists, without reading or writing settings', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    fs.writeFileSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_MARKER), JSON.stringify({ migratedAt: 'x' }), 'utf8');
    const before = fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8');

    const result = migrateDefaultGptToOpusOnce({ dataDir });

    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8')).toBe(before);
  });

  it('treats a CORRUPT marker as done (presence-only) — never re-runs', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    fs.writeFileSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_MARKER), '{not json', 'utf8');
    const before = fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8');

    const result = migrateDefaultGptToOpusOnce({ dataDir });

    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(path.join(dataDir, 'user-settings.json'), 'utf8')).toBe(before);
  });

  it('a user who switches back to gpt-5.6-sol after the rewrite survives a second run', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    migrateDefaultGptToOpusOnce({ dataDir });

    const store = new UserSettingsStore(dataDir);
    store.setUserDefaultModel('U_SOL', 'gpt-5.6-sol');
    expect(migrateDefaultGptToOpusOnce({ dataDir }).status).toBe('skipped');

    expect(readSettings(dataDir).U_SOL?.defaultModel).toBe('gpt-5.6-sol');
    expect(new UserSettingsStore(dataDir).getUserDefaultModel('U_SOL')).toBe('gpt-5.6-sol');
  });

  it('reloadSettings() makes a store loaded BEFORE the migration see the new defaults', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    const store = new UserSettingsStore(dataDir);
    expect(store.getUserDefaultModel('U_SOL')).toBe('gpt-5.6-sol');

    const result = migrateDefaultGptToOpusOnce({ dataDir });
    expect(result.migrated).toBeGreaterThan(0);
    // Stale until reloaded — the index.ts wiring reloads unless it was a clean skip.
    expect(store.getUserDefaultModel('U_SOL')).toBe('gpt-5.6-sol');

    store.reloadSettings();
    expect(store.getUserDefaultModel('U_SOL')).toBe(TARGET);
    expect(store.getUserDefaultModel('U_SOL_1M')).toBe('gpt-5.6-sol[1m]');
    expect(store.getUserDefaultModel('U_FABLE')).toBe('claude-fable-5-1[1m]');
  });

  it('does not write settings when nobody is on the old default, but still marks', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, { U1: { userId: 'U1', defaultModel: 'claude-fable-5-1[1m]' } });
    const file = path.join(dataDir, 'user-settings.json');
    const before = fs.readFileSync(file, 'utf8');

    const result = migrateDefaultGptToOpusOnce({ dataDir });

    expect(result).toMatchObject({ status: 'applied', migrated: 0, total: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_SNAPSHOT))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_MARKER))).toBe(true);
  });

  it('marks a fresh install (no user-settings.json) as done', () => {
    const dataDir = makeDataDir();
    const result = migrateDefaultGptToOpusOnce({ dataDir });
    expect(result).toMatchObject({ status: 'applied', migrated: 0, total: 0 });
    expect(fs.existsSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_MARKER))).toBe(true);
  });

  it('never touches sessions.json', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    const sessionsFile = path.join(dataDir, 'sessions.json');
    const sentinel = JSON.stringify({ 'C1:1.1': { model: 'gpt-5.6-sol' } });
    fs.writeFileSync(sessionsFile, sentinel, 'utf8');
    migrateDefaultGptToOpusOnce({ dataDir });
    expect(fs.readFileSync(sessionsFile, 'utf8')).toBe(sentinel);
  });

  it('data write fails AFTER the marker: rethrows, next run skips, a later user choice is never overwritten', () => {
    const dataDir = makeDataDir();
    writeSettings(dataDir, POPULATION);
    const file = path.join(dataDir, 'user-settings.json');
    const before = fs.readFileSync(file, 'utf8');

    fault.failSettingsWrite = true;
    expect(() => migrateDefaultGptToOpusOnce({ dataDir })).toThrow('injected write failure');
    fault.failSettingsWrite = false;

    // Marker landed first; the data did not change (a missed one-shot).
    expect(fs.existsSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_MARKER))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    // A user makes a choice in between; the next boot must not replay.
    new UserSettingsStore(dataDir).setUserDefaultModel('U_SOL', 'gpt-5.6-sol');
    expect(migrateDefaultGptToOpusOnce({ dataDir }).status).toBe('skipped');
    expect(readSettings(dataDir).U_SOL?.defaultModel).toBe('gpt-5.6-sol');
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

    expect(() => migrateDefaultGptToOpusOnce({ dataDir })).toThrow();
    expect(fs.existsSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_SNAPSHOT))).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
  });

  it('a corrupt user-settings.json throws BEFORE the marker is written (not burned)', () => {
    const dataDir = makeDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'user-settings.json'), '{broken', 'utf8');
    expect(() => migrateDefaultGptToOpusOnce({ dataDir })).toThrow();
    expect(fs.existsSync(path.join(dataDir, DEFAULT_GPT_TO_OPUS_ONCE_MARKER))).toBe(false);
  });
});
