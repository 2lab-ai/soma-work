import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteJson, readJsonWithBackup } from '../atomic-json';

/**
 * Contract tests for the shared atomic JSON store helper required by
 * `rules/config.md:10-11` (atomic write + WARN/`.bak` fallback on load).
 *
 * Everything here runs against a real temp directory — the failure modes we
 * care about (truncated file, missing file, unwritable directory) are
 * filesystem behaviour, and mocking them would only test the mock.
 *
 * The one exception is the rename step: there is no portable way to make
 * `renameSync` fail *after* a successful temp write, so `node:fs` is loaded
 * for real and only `renameSync` is wrapped by a switch. No test below calls
 * `renameSync` itself, so every other filesystem call is the real thing.
 *
 * The switch selects by *destination*, because a write over an existing store
 * renames twice — first the `.bak` promotion, then the live file. A blanket
 * "fail the next rename" only ever reaches the backup rename and would leave
 * the live-rename rollback untested.
 */
const renameControl = vi.hoisted(() => ({ failOn: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    renameSync: (oldPath: fs.PathLike, newPath: fs.PathLike): void => {
      if (renameControl.failOn !== null && String(newPath) === renameControl.failOn) {
        throw new Error(`EIO: injected rename failure for ${String(newPath)}`);
      }
      actual.renameSync(oldPath, newPath);
    },
  };
});

interface Queue {
  items: string[];
}

/** Validator in the shape a real store would pass in: throws on anything it cannot use. */
function validateQueue(raw: unknown): Queue {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as Queue).items)) {
    throw new Error('not a queue');
  }
  return raw as Queue;
}

function collectWarnings() {
  const warnings: string[] = [];
  return {
    warnings,
    warn: (message: string) => {
      warnings.push(message);
    },
  };
}

function readRaw(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

function tmpLeftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

describe('atomic-json', () => {
  let dir: string;
  let file: string;
  let backup: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-atomic-json-'));
    file = path.join(dir, 'queue.json');
    backup = `${file}.bak`;
  });

  afterEach(() => {
    renameControl.failOn = null;
    // Only ever removes the directory this test created.
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('atomicWriteJson', () => {
    it('writes JSON that reads back through readJsonWithBackup', () => {
      atomicWriteJson(file, { items: ['a'] });

      expect(readJsonWithBackup(file, validateQueue)).toEqual({ items: ['a'] });
      expect(JSON.parse(readRaw(file))).toEqual({ items: ['a'] });
    });

    it('creates missing parent directories and leaves no temp file behind', () => {
      const nested = path.join(dir, 'deep', 'nested', 'queue.json');

      atomicWriteJson(nested, { items: [] });

      expect(fs.existsSync(nested)).toBe(true);
      expect(tmpLeftovers(path.dirname(nested))).toEqual([]);
    });

    it('creates the live file with owner-only permissions (0600)', () => {
      atomicWriteJson(file, { items: ['secret message'] });

      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('preserves the previous live content as .bak on the next write', () => {
      atomicWriteJson(file, { items: ['v1'] });
      atomicWriteJson(file, { items: ['v2'] });

      expect(JSON.parse(readRaw(file))).toEqual({ items: ['v2'] });
      expect(JSON.parse(readRaw(backup))).toEqual({ items: ['v1'] });
    });

    it('does not create a .bak on the very first write', () => {
      atomicWriteJson(file, { items: ['v1'] });

      expect(fs.existsSync(backup)).toBe(false);
    });

    it('never overwrites a healthy .bak with a corrupt live file', () => {
      atomicWriteJson(file, { items: ['v1'] });
      atomicWriteJson(file, { items: ['v2'] }); // .bak = v1
      fs.writeFileSync(file, '{"items": ["v2"', 'utf-8'); // live truncated by a crash
      const { warn, warnings } = collectWarnings();

      atomicWriteJson(file, { items: ['v3'] }, { warn });

      expect(JSON.parse(readRaw(backup))).toEqual({ items: ['v1'] });
      expect(JSON.parse(readRaw(file))).toEqual({ items: ['v3'] });
      expect(warnings).toHaveLength(1);
    });

    it('skips the .bak promotion when validatePrevious rejects the live content', () => {
      atomicWriteJson(file, { items: ['v1'] });
      atomicWriteJson(file, { items: ['v2'] }); // .bak = v1
      fs.writeFileSync(file, JSON.stringify({ items: 'not-an-array' }), 'utf-8');
      const { warn, warnings } = collectWarnings();

      atomicWriteJson(
        file,
        { items: ['v3'] },
        { validatePrevious: (parsed) => Array.isArray((parsed as Queue).items), warn },
      );

      expect(JSON.parse(readRaw(backup))).toEqual({ items: ['v1'] });
      expect(warnings).toHaveLength(1);
    });

    it('throws on an unserializable value without touching the live file', () => {
      atomicWriteJson(file, { items: ['v1'] });
      const circular: { items: string[]; self?: unknown } = { items: ['v2'] };
      circular.self = circular;

      expect(() => atomicWriteJson(file, circular)).toThrow();
      expect(JSON.parse(readRaw(file))).toEqual({ items: ['v1'] });
      expect(tmpLeftovers(dir)).toEqual([]);
    });

    it('leaves the live file untouched when the filesystem write fails', () => {
      atomicWriteJson(file, { items: ['v1'] });
      fs.chmodSync(dir, 0o500); // read-only directory: temp file cannot be created

      expect(() => atomicWriteJson(file, { items: ['v2'] })).toThrow();

      fs.chmodSync(dir, 0o700);
      expect(JSON.parse(readRaw(file))).toEqual({ items: ['v1'] });
      expect(tmpLeftovers(dir)).toEqual([]);
    });

    it('leaves the live file untouched and cleans the temp file when the .bak rename fails', () => {
      atomicWriteJson(file, { items: ['v1'] });
      renameControl.failOn = backup;

      expect(() => atomicWriteJson(file, { items: ['v2'] })).toThrow(/queue\.json\.bak/);

      renameControl.failOn = null;
      // Backup promotion runs first, so the live file must not have advanced.
      expect(JSON.parse(readRaw(file))).toEqual({ items: ['v1'] });
      expect(fs.existsSync(backup)).toBe(false);
      expect(tmpLeftovers(dir)).toEqual([]);
    });

    it('leaves the live file untouched and cleans the temp file when the live rename fails', () => {
      atomicWriteJson(file, { items: ['v1'] });
      renameControl.failOn = file;

      expect(() => atomicWriteJson(file, { items: ['v2'] })).toThrow(/queue\.json:/);

      renameControl.failOn = null;
      expect(JSON.parse(readRaw(file))).toEqual({ items: ['v1'] });
      // The .bak rename succeeded before the live one failed — proof the failure
      // was injected at the final rename, and that .bak never runs ahead of live.
      expect(JSON.parse(readRaw(backup))).toEqual({ items: ['v1'] });
      expect(tmpLeftovers(dir)).toEqual([]);
    });
  });

  describe('readJsonWithBackup', () => {
    it('returns undefined only for a genuinely new store (no live, no backup)', () => {
      const { warn, warnings } = collectWarnings();

      expect(readJsonWithBackup(file, validateQueue, { warn })).toBeUndefined();
      expect(warnings).toEqual([]);
    });

    it('falls back to .bak with a WARN when the live file is truncated', () => {
      atomicWriteJson(file, { items: ['v1'] });
      atomicWriteJson(file, { items: ['v2'] }); // .bak = v1
      fs.writeFileSync(file, '{"items": ["v2"', 'utf-8');
      const { warn, warnings } = collectWarnings();

      expect(readJsonWithBackup(file, validateQueue, { warn })).toEqual({ items: ['v1'] });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(file);
    });

    it('falls back to .bak when the live file is valid JSON of the wrong shape', () => {
      atomicWriteJson(file, { items: ['v1'] });
      atomicWriteJson(file, { items: ['v2'] }); // .bak = v1
      fs.writeFileSync(file, JSON.stringify({ items: 'not-an-array' }), 'utf-8');
      const { warn, warnings } = collectWarnings();

      expect(readJsonWithBackup(file, validateQueue, { warn })).toEqual({ items: ['v1'] });
      expect(warnings).toHaveLength(1);
    });

    it('does not repair the live file on read (read never writes)', () => {
      atomicWriteJson(file, { items: ['v1'] });
      atomicWriteJson(file, { items: ['v2'] });
      fs.writeFileSync(file, 'garbage', 'utf-8');
      const { warn } = collectWarnings();

      readJsonWithBackup(file, validateQueue, { warn });

      expect(readRaw(file)).toBe('garbage');
      expect(JSON.parse(readRaw(backup))).toEqual({ items: ['v1'] });
    });

    it('restores from .bak with a WARN when the live file disappeared', () => {
      atomicWriteJson(file, { items: ['v1'] });
      atomicWriteJson(file, { items: ['v2'] }); // .bak = v1
      fs.unlinkSync(file);
      const { warn, warnings } = collectWarnings();

      expect(readJsonWithBackup(file, validateQueue, { warn })).toEqual({ items: ['v1'] });
      expect(warnings).toHaveLength(1);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('throws instead of reporting an empty store when live and backup are both unusable', () => {
      atomicWriteJson(file, { items: ['v1'] });
      atomicWriteJson(file, { items: ['v2'] });
      fs.writeFileSync(file, 'garbage', 'utf-8');
      fs.writeFileSync(backup, 'also garbage', 'utf-8');
      const { warn } = collectWarnings();

      expect(() => readJsonWithBackup(file, validateQueue, { warn })).toThrow(/atomic-json|unusable/i);
    });

    it('throws when the live file is corrupt and no backup exists', () => {
      fs.writeFileSync(file, 'garbage', 'utf-8');
      const { warn } = collectWarnings();

      expect(() => readJsonWithBackup(file, validateQueue, { warn })).toThrow();
    });
  });
});
