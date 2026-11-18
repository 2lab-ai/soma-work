import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteSecret,
  listSecrets,
  SECRET_VALUE_MAX_BYTES,
  SecretAdminError,
  writeSecret,
} from '../secret-admin-store';

/**
 * secret-access WU1 (#1337, .prd/33 §2.1): the bot's side of the secret store — names and times out, values in
 * once, never back out. The store is `<config dir>/secrets/`, one file per secret, 0600 in a 0700 directory.
 */

// biome-ignore lint/style/noCommonJs: @soma/process-shared sub-path types are not visible under moduleResolution node
const { readSecret } = require('@soma/process-shared/secret-ref.js') as {
  readSecret(name: string, dir: string | undefined): string;
};

describe('secret-admin-store', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-admin-'));
    dir = path.join(root, 'secrets');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses a value the reader would find empty (a lone newline), and keeps the old one', () => {
    writeSecret('dev2-db-app', 'kept', { overwrite: false }, dir);
    for (const value of ['\n', '\r\n']) {
      expect(() => writeSecret('dev2-db-app', value, { overwrite: true }, dir)).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
      expect(() => writeSecret('fresh', value, { overwrite: false }, dir)).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    }
    expect(fs.readFileSync(path.join(dir, 'dev2-db-app'), 'utf-8')).toBe('kept');
    expect(fs.existsSync(path.join(dir, 'fresh'))).toBe(false);
  });

  it('writes a new secret 0600 in a 0700 store that readSecret resolves', () => {
    const { entry, created } = writeSecret('dev2-db-app', 'p@ss word\nline2', { overwrite: false }, dir);
    expect(created).toBe(true);
    expect(entry.name).toBe('dev2-db-app');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'dev2-db-app')).mode & 0o777).toBe(0o600);
    expect(readSecret('dev2-db-app', dir)).toBe('p@ss word\nline2');
  });

  it('lists names and times only — never a value', () => {
    writeSecret('b-token', 'VALUE-MARKER-1', { overwrite: false }, dir);
    writeSecret('a-token', 'VALUE-MARKER-2', { overwrite: false }, dir);
    const list = listSecrets(dir);
    expect(list.map((s) => s.name)).toEqual(['a-token', 'b-token']);
    expect(Object.keys(list[0]).sort()).toEqual(['name', 'updatedAt']);
    expect(JSON.stringify(list)).not.toContain('VALUE-MARKER');
    expect(Number.isNaN(Date.parse(list[0].updatedAt))).toBe(false);
  });

  it('lists nothing (not an error) when the store does not exist yet', () => {
    expect(listSecrets(dir)).toEqual([]);
  });

  it('skips what the store cannot resolve: dot files, other names, directories, links that leave the store', () => {
    writeSecret('kept', 'v', { overwrite: false }, dir);
    fs.writeFileSync(path.join(dir, '.kept.tmp-1-abc'), 'partial');
    fs.writeFileSync(path.join(dir, 'bad name'), 'x');
    fs.mkdirSync(path.join(dir, 'subdir'));
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'x');
    fs.symlinkSync(outside, path.join(dir, 'escape'));
    expect(listSecrets(dir).map((s) => s.name)).toEqual(['kept']);
  });

  it('refuses to replace an existing secret unless asked to overwrite, then replaces the value', () => {
    writeSecret('gh-token', 'old', { overwrite: false }, dir);
    expect(() => writeSecret('gh-token', 'new', { overwrite: false }, dir)).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(readSecret('gh-token', dir)).toBe('old');
    const { created } = writeSecret('gh-token', 'new', { overwrite: true }, dir);
    expect(created).toBe(false);
    expect(readSecret('gh-token', dir)).toBe('new');
    // No plaintext copy of the old value is left behind.
    expect(fs.readdirSync(dir)).toEqual(['gh-token']);
  });

  it.each([
    ['../escape', 'a path'],
    ['.hidden', 'a dot name'],
    ['has space', 'a space'],
    ['', 'empty'],
    ['a'.repeat(129), 'too long'],
  ])('rejects the name %j (%s) without echoing it', (name) => {
    let error: unknown;
    try {
      writeSecret(name, 'v', { overwrite: false }, dir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SecretAdminError);
    expect((error as SecretAdminError).statusCode).toBe(400);
    if (name.length > 3) expect((error as Error).message).not.toContain(name);
  });

  it.each([
    ['', 'empty'],
    ['a\0b', 'a NUL byte'],
    ['x'.repeat(SECRET_VALUE_MAX_BYTES + 1), 'over the size cap'],
  ])('rejects the value (%s) and says nothing of it', (value) => {
    expect(() => writeSecret('ok-name', value, { overwrite: false }, dir)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(fs.existsSync(path.join(dir, 'ok-name'))).toBe(false);
  });

  it('rejects a value that is not a string', () => {
    expect(() => writeSecret('ok-name', 42 as unknown as string, { overwrite: false }, dir)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('will not write through a link in the store', () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'untouched');
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    expect(() => writeSecret('linked', 'new', { overwrite: true }, dir)).toThrow(SecretAdminError);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('untouched');
  });

  it('deletes a secret and says 404 for one that is not there', () => {
    writeSecret('gone', 'v', { overwrite: false }, dir);
    deleteSecret('gone', dir);
    expect(listSecrets(dir)).toEqual([]);
    expect(() => deleteSecret('gone', dir)).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('deleting a link removes the link, never its target', () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'target');
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    deleteSecret('linked', dir);
    expect(fs.existsSync(path.join(dir, 'linked'))).toBe(false);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('target');
  });

  it('fails closed when no store is configured (an empty path)', () => {
    expect(() => listSecrets('')).toThrow(expect.objectContaining({ statusCode: 500 }));
    expect(() => writeSecret('x', 'v', { overwrite: false }, '')).toThrow(expect.objectContaining({ statusCode: 500 }));
  });
});
