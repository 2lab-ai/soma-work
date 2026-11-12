import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSecretRef, readSecret, resolveSecretRefs, SecretRefError } from './secret-ref';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-ref-'));
  fs.writeFileSync(path.join(dir, 'db-app'), 's3cret-value\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'gh.org-admin'), 'ghp_token', { mode: 0o600 });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isSecretRef', () => {
  it('is an object with exactly one string `$secret` key', () => {
    expect(isSecretRef({ $secret: 'db-app' })).toBe(true);
    expect(isSecretRef({ $secret: 'db-app', other: 1 })).toBe(false);
    expect(isSecretRef({ $secret: 3 })).toBe(false);
    expect(isSecretRef('db-app')).toBe(false);
    expect(isSecretRef(null)).toBe(false);
    expect(isSecretRef(['$secret'])).toBe(false);
  });
});

describe('readSecret', () => {
  it('reads the named file and drops one trailing newline', () => {
    expect(readSecret('db-app', dir)).toBe('s3cret-value');
    expect(readSecret('gh.org-admin', dir)).toBe('ghp_token');
  });

  it('refuses a name that is not one safe path segment', () => {
    for (const bad of ['', '..', '../x', 'a/b', '.hidden', 'a b', 'x\0y']) {
      expect(() => readSecret(bad, dir)).toThrow(SecretRefError);
    }
  });

  it('fails closed on a missing file, a missing store, or no store configured', () => {
    expect(() => readSecret('nope', dir)).toThrow(SecretRefError);
    expect(() => readSecret('db-app', path.join(dir, 'missing'))).toThrow(SecretRefError);
    expect(() => readSecret('db-app', undefined)).toThrow(SecretRefError);
    expect(() => readSecret('db-app', '')).toThrow(SecretRefError);
  });

  it('never puts the secret value in its error message', () => {
    fs.writeFileSync(path.join(dir, 'empty'), '');
    try {
      readSecret('empty', dir);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SecretRefError);
      expect((error as Error).message).toContain('empty');
    }
  });

  it('refuses a symbolic link that leaves the store', () => {
    const outside = path.join(os.tmpdir(), `secret-ref-outside-${process.pid}`);
    fs.writeFileSync(outside, 'leak');
    try {
      fs.symlinkSync(outside, path.join(dir, 'link'));
      expect(() => readSecret('link', dir)).toThrow(SecretRefError);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

describe('resolveSecretRefs', () => {
  it('replaces every reference, deep, and leaves the input untouched', () => {
    const input = {
      dev2: {
        ssh: { host: 'dev2' },
        databases: { app: { type: 'mysql', password: { $secret: 'db-app' }, port: 3306 } },
        list: [{ token: { $secret: 'gh.org-admin' } }, 'plain'],
      },
    };
    const out = resolveSecretRefs(input, dir);
    expect(out).toEqual({
      dev2: {
        ssh: { host: 'dev2' },
        databases: { app: { type: 'mysql', password: 's3cret-value', port: 3306 } },
        list: [{ token: 'ghp_token' }, 'plain'],
      },
    });
    expect(input.dev2.databases.app.password).toEqual({ $secret: 'db-app' });
  });

  it('passes a value without references through unchanged, with no store needed', () => {
    const plain = { a: { password: 'inline' }, n: 1, b: [true, null] };
    expect(resolveSecretRefs(plain, undefined)).toEqual(plain);
  });

  it('refuses a `$secret` key in any other shape instead of passing it through', () => {
    expect(() => resolveSecretRefs({ a: { $secret: 1 } }, dir)).toThrow(SecretRefError);
    expect(() => resolveSecretRefs({ a: { $secret: 'db-app', note: 'x' } }, dir)).toThrow(SecretRefError);
  });

  it('never echoes an invalid name (it may be a pasted value)', () => {
    try {
      readSecret('p@ss w0rd!', dir);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('p@ss');
    }
  });

  it('throws on the first unresolvable reference', () => {
    expect(() => resolveSecretRefs({ a: { $secret: 'nope' } }, dir)).toThrow(SecretRefError);
  });
});
