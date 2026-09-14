import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFile, atomicWriteJson, loadJsonWithBackup, UnsafePathError } from '../atomic-write';

describe('atomicWriteFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes content that reads back exactly', () => {
    const target = path.join(dir, 'nested', 'file.txt');
    atomicWriteFile(target, 'hello world');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello world');
  });

  it('accepts Buffer data', () => {
    const target = path.join(dir, 'file.bin');
    atomicWriteFile(target, Buffer.from('binary-data'));
    expect(fs.readFileSync(target, 'utf-8')).toBe('binary-data');
  });

  it('creates a missing parent directory at mode 0700', () => {
    const target = path.join(dir, 'profiles', 'preview', 'state.json');
    atomicWriteFile(target, '{}');
    const parentMode = fs.statSync(path.join(dir, 'profiles', 'preview')).mode & 0o777;
    expect(parentMode).toBe(0o700);
  });

  it('creates nested missing parent directories, each at mode 0700', () => {
    const target = path.join(dir, 'a', 'b', 'c', 'file.txt');
    atomicWriteFile(target, 'x');
    expect(fs.statSync(path.join(dir, 'a')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'a', 'b')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'a', 'b', 'c')).mode & 0o777).toBe(0o700);
  });

  it('defaults the written file to mode 0600 when opts.mode is omitted', () => {
    const target = path.join(dir, 'file.txt');
    atomicWriteFile(target, 'hello');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('honors an explicit opts.mode', () => {
    const target = path.join(dir, 'secrets.env');
    atomicWriteFile(target, 'KEY=1', { mode: 0o600 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('does not create a .bak file on first write (no prior live file)', () => {
    const target = path.join(dir, 'file.txt');
    atomicWriteFile(target, 'v1', { backup: true });
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
  });

  it('backs up the previous content to .bak when opts.backup is true', () => {
    const target = path.join(dir, 'file.txt');
    atomicWriteFile(target, 'v1', { backup: true });
    atomicWriteFile(target, 'v2', { backup: true });
    expect(fs.readFileSync(target, 'utf-8')).toBe('v2');
    expect(fs.readFileSync(`${target}.bak`, 'utf-8')).toBe('v1');
  });

  it('does not create a .bak file when opts.backup is false/omitted', () => {
    const target = path.join(dir, 'file.txt');
    atomicWriteFile(target, 'v1');
    atomicWriteFile(target, 'v2');
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
  });

  it('leaves no leftover temp files in the directory after a successful write', () => {
    const target = path.join(dir, 'file.txt');
    atomicWriteFile(target, 'v1');
    const entries = fs.readdirSync(dir);
    const tmpEntries = entries.filter((e) => e.includes('.tmp-'));
    expect(tmpEntries).toEqual([]);
  });

  it('rejects writing when the target path is a symlink', () => {
    const real = path.join(dir, 'real.txt');
    fs.writeFileSync(real, 'untouched');
    const link = path.join(dir, 'link.txt');
    fs.symlinkSync(real, link);

    expect(() => atomicWriteFile(link, 'attacker-controlled')).toThrow();
    expect(fs.readFileSync(real, 'utf-8')).toBe('untouched');
  });

  it('rejects writing when the parent directory is a symlink', () => {
    const realDir = path.join(dir, 'real-dir');
    fs.mkdirSync(realDir);
    const linkDir = path.join(dir, 'link-dir');
    fs.symlinkSync(realDir, linkDir);

    const target = path.join(linkDir, 'file.txt');
    expect(() => atomicWriteFile(target, 'attacker-controlled')).toThrow();
    expect(fs.existsSync(path.join(realDir, 'file.txt'))).toBe(false);
  });

  it('tightens a pre-existing parent directory down to the requested dirMode', () => {
    // task-2-context: "Profile parent directory is mode 0700." A profile dir left
    // at 0755 by an earlier build/restore must be tightened, not accepted as-is.
    const parent = path.join(dir, 'pre-existing');
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.chmodSync(parent, 0o755);
    expect(fs.statSync(parent).mode & 0o777).toBe(0o755);

    atomicWriteFile(path.join(parent, 'secrets.env'), 'K=1');
    expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
  });

  it('does not loosen a parent directory that is already stricter than dirMode', () => {
    const parent = path.join(dir, 'strict');
    fs.mkdirSync(parent, { mode: 0o700 });
    fs.chmodSync(parent, 0o500);

    // 0500 grants nothing beyond 0700, so the mode is left alone: we tighten, never grant.
    expect(() => atomicWriteFile(path.join(parent, 'f.txt'), 'x')).toThrow();
    expect(fs.statSync(parent).mode & 0o777).toBe(0o500);
    fs.chmodSync(parent, 0o700);
  });

  it('rejects writing when a path component is an existing regular file', () => {
    const notADir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(notADir, 'i am a file');

    expect(() => atomicWriteFile(path.join(notADir, 'file.txt'), 'x')).toThrow();
    expect(fs.readFileSync(notADir, 'utf-8')).toBe('i am a file');
  });

  it('rejects a symlink several levels up the ancestor chain', () => {
    // Guards the walk itself: a regression that stopped after the immediate
    // parent would leave this green.
    const realDir = path.join(dir, 'real-deep');
    fs.mkdirSync(path.join(realDir, 'a', 'b'), { recursive: true });
    const linkMid = path.join(dir, 'link-mid');
    fs.symlinkSync(realDir, linkMid);

    const target = path.join(linkMid, 'a', 'b', 'file.txt');
    expect(() => atomicWriteFile(target, 'attacker-controlled')).toThrow();
    expect(fs.existsSync(path.join(realDir, 'a', 'b', 'file.txt'))).toBe(false);
  });

  it('does not introduce a non-atomic write-file call in the module source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'atomic-write.ts'), 'utf-8');
    // rules/config.md §3: live files are never opened through the convenience
    // write-file helper. Matched unqualified so `fs.`-prefixed calls are caught
    // too (the previous `[^.]` guard could never match a `fs.`-prefixed call).
    expect(src).not.toMatch(/writeFileSync\s*\(/);
  });
});

describe('atomicWriteJson', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-json-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serializes stable JSON with a trailing newline', () => {
    const target = path.join(dir, 'state.json');
    atomicWriteJson(target, { a: 1, b: 'two' });
    const raw = fs.readFileSync(target, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual({ a: 1, b: 'two' });
  });

  it('round-trips through loadJsonWithBackup', () => {
    const target = path.join(dir, 'state.json');
    atomicWriteJson(target, { schemaVersion: 1 }, { backup: true });
    const loaded = loadJsonWithBackup(target, (v) => v as { schemaVersion: number });
    expect(loaded).toEqual({ schemaVersion: 1 });
  });
});

describe('loadJsonWithBackup', () => {
  let dir: string;
  const identity = (v: unknown) => v as Record<string, unknown>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-load-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when neither the live file nor the backup exists', () => {
    const target = path.join(dir, 'missing.json');
    expect(loadJsonWithBackup(target, identity)).toBeNull();
  });

  it('returns the parsed+validated live file when it is well-formed', () => {
    const target = path.join(dir, 'state.json');
    atomicWriteJson(target, { ok: true });
    expect(loadJsonWithBackup(target, identity)).toEqual({ ok: true });
  });

  it('falls back to .bak when the live file is corrupt JSON', () => {
    const target = path.join(dir, 'state.json');
    atomicWriteJson(target, { v: 1 }, { backup: true });
    atomicWriteJson(target, { v: 2 }, { backup: true });
    // Simulate an interrupted write: live file corrupted, backup intact.
    fs.writeFileSync(target, '{not valid json');
    expect(loadJsonWithBackup(target, identity)).toEqual({ v: 1 });
  });

  it('throws (does not silently return empty) when both live and backup are corrupt', () => {
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, '{corrupt-live');
    fs.writeFileSync(`${target}.bak`, '{corrupt-backup');
    expect(() => loadJsonWithBackup(target, identity)).toThrow();
  });

  it('throws when the live file is missing but the backup is corrupt', () => {
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(`${target}.bak`, '{corrupt-backup');
    expect(() => loadJsonWithBackup(target, identity)).toThrow();
  });

  it('propagates a validate() rejection on the live file and still tries the backup', () => {
    const target = path.join(dir, 'state.json');
    atomicWriteJson(target, { schemaVersion: 1 }, { backup: true });
    atomicWriteJson(target, { schemaVersion: 999 }, { backup: true });
    const validate = (v: unknown) => {
      const value = v as { schemaVersion: number };
      if (value.schemaVersion !== 1) throw new Error('unsupported schemaVersion');
      return value;
    };
    expect(loadJsonWithBackup(target, validate)).toEqual({ schemaVersion: 1 });
  });

  it('does not leave a leftover corrupted-recovery temp artifact behind', () => {
    const target = path.join(dir, 'state.json');
    atomicWriteJson(target, { v: 1 }, { backup: true });
    atomicWriteJson(target, { v: 2 }, { backup: true });
    fs.writeFileSync(target, '{not valid json');
    loadJsonWithBackup(target, identity);
    const entries = fs.readdirSync(dir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
  });
});

/**
 * `dirMode` is the mode a *created* parent gets; tightening a *pre-existing*
 * parent is a separate decision. They were conflated by callers passing a wide
 * `dirMode` purely to disable tightening, which silently made every directory
 * they created world-writable.
 */
describe('atomicWriteFile — tightenExistingDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-tighten-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a missing parent at exactly dirMode even with tightening disabled', () => {
    const parent = path.join(dir, 'made', 'deeper');
    atomicWriteFile(path.join(parent, 'config.json'), '{}\n', {
      mode: 0o600,
      dirMode: 0o700,
      tightenExistingDir: false,
    });
    expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'made')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(parent, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('creates a missing parent at exactly dirMode under a permissive umask', () => {
    const saved = process.umask(0o000);
    try {
      const parent = path.join(dir, 'umask-made');
      atomicWriteFile(path.join(parent, 'config.json'), '{}\n', {
        mode: 0o600,
        dirMode: 0o700,
        tightenExistingDir: false,
      });
      expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(saved);
    }
  });

  it('leaves a pre-existing parent alone when tightening is disabled', () => {
    const parent = path.join(dir, 'checkout');
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.chmodSync(parent, 0o755);

    atomicWriteFile(path.join(parent, 'config.json'), '{}\n', {
      mode: 0o600,
      dirMode: 0o700,
      tightenExistingDir: false,
    });
    expect(fs.statSync(parent).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(parent, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('still tightens a pre-existing parent by default', () => {
    const parent = path.join(dir, 'default-tighten');
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.chmodSync(parent, 0o755);

    atomicWriteFile(path.join(parent, 'secrets.env'), 'K=1');
    expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
  });

  it('still refuses a symlinked parent when tightening is disabled', () => {
    const realDir = path.join(dir, 'real');
    fs.mkdirSync(realDir);
    const linkDir = path.join(dir, 'link');
    fs.symlinkSync(realDir, linkDir);

    expect(() =>
      atomicWriteFile(path.join(linkDir, 'config.json'), '{}\n', { dirMode: 0o700, tightenExistingDir: false }),
    ).toThrow(UnsafePathError);
    expect(fs.existsSync(path.join(realDir, 'config.json'))).toBe(false);
  });
});
