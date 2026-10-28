import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BrokerPaths, brokerPaths } from './paths.js';
import { ingestSecret, MAX_SECRET_BYTES, readSecret, SecretError, secretFile } from './secrets.js';

const VALUE = 'test-secret-0001';

let root: string;
let paths: BrokerPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-secrets-'));
  paths = brokerPaths(root);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function plant(kind: 'gh' | 'cf' | 'slack', name: string, content: string, mode = 0o600): string {
  fs.mkdirSync(path.join(paths.secretsDir, kind), { recursive: true, mode: 0o700 });
  const file = secretFile(paths, kind, name);
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
  return file;
}

function failure(fn: () => unknown): SecretError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SecretError);
    expect((err as Error).message).not.toContain(VALUE);
    return err as SecretError;
  }
  throw new Error('expected a SecretError');
}

async function asyncFailure(promise: Promise<unknown>, value = VALUE): Promise<SecretError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SecretError);
    expect((err as Error).message).not.toContain(value);
    return err as SecretError;
  }
  throw new Error('expected a SecretError');
}

function stream(...chunks: string[]): NodeJS.ReadableStream {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
}

describe('secretFile', () => {
  it('maps each kind to its directory and extension', () => {
    expect(secretFile(paths, 'gh', 'member')).toBe(path.join(root, 'secrets/gh/member.token'));
    expect(secretFile(paths, 'cf', 'dev2')).toBe(path.join(root, 'secrets/cf/dev2.forge'));
    expect(secretFile(paths, 'slack', 'broker-app')).toBe(path.join(root, 'secrets/slack/broker-app.token'));
  });

  it.each(['', 'Member', '../member', 'a/b', 'a'.repeat(33), 'a.b'])('rejects the name %j', (name) => {
    failure(() => secretFile(paths, 'gh', name));
  });

  it('rejects an unknown kind', () => {
    failure(() => secretFile(paths, 'npm' as 'gh', 'member'));
  });
});

describe('readSecret', () => {
  it('returns the value without the trailing newline', () => {
    plant('gh', 'member', `${VALUE}\n`);
    expect(readSecret(paths, 'gh', 'member')).toBe(VALUE);
    plant('cf', 'dev2', `${VALUE}\r\n`);
    expect(readSecret(paths, 'cf', 'dev2')).toBe(VALUE);
  });

  it.each([0o644, 0o640, 0o604, 0o620, 0o610, 0o601])('refuses file mode %o', (mode) => {
    plant('gh', 'member', VALUE, mode);
    expect(failure(() => readSecret(paths, 'gh', 'member')).reason).toBe('unsafe');
  });

  it('refuses a group-accessible kind directory', () => {
    plant('gh', 'member', VALUE);
    fs.chmodSync(path.join(paths.secretsDir, 'gh'), 0o750);
    expect(failure(() => readSecret(paths, 'gh', 'member')).message).toMatch(/secrets\/gh/);
  });

  it('refuses a group-accessible secrets directory', () => {
    plant('gh', 'member', VALUE);
    fs.chmodSync(paths.secretsDir, 0o755);
    expect(failure(() => readSecret(paths, 'gh', 'member')).reason).toBe('unsafe');
  });

  it('does not look above the secrets directory (the broker root is 0750 by design)', () => {
    plant('gh', 'member', VALUE);
    fs.chmodSync(root, 0o750);
    expect(readSecret(paths, 'gh', 'member')).toBe(VALUE);
  });

  // A file owned by another uid cannot be created without root, so the owner comparison is
  // exercised by naming a different expected owner for files this process does own.
  it('refuses files owned by another user', () => {
    plant('gh', 'member', VALUE);
    const uid = process.getuid?.() ?? 0;
    const err = failure(() => readSecret(paths, 'gh', 'member', { ownerUid: uid + 1 }));
    expect(err.reason).toBe('unsafe');
    expect(err.message).toMatch(/owned by uid/);
  });

  it('refuses a symlink', () => {
    const elsewhere = path.join(root, 'elsewhere.token');
    fs.writeFileSync(elsewhere, VALUE, { mode: 0o600 });
    fs.mkdirSync(path.join(paths.secretsDir, 'gh'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, secretFile(paths, 'gh', 'member'));
    expect(failure(() => readSecret(paths, 'gh', 'member')).message).toMatch(/symlink/);
  });

  it('refuses a directory where the file should be', () => {
    fs.mkdirSync(secretFile(paths, 'gh', 'member'), { recursive: true, mode: 0o700 });
    expect(failure(() => readSecret(paths, 'gh', 'member')).reason).toBe('unsafe');
  });

  it('reports a missing file as missing', () => {
    expect(failure(() => readSecret(paths, 'gh', 'member')).reason).toBe('missing');
    fs.mkdirSync(path.join(paths.secretsDir, 'gh'), { recursive: true, mode: 0o700 });
    expect(failure(() => readSecret(paths, 'gh', 'member')).reason).toBe('missing');
  });

  it.each([
    ['empty', ''],
    ['only a newline', '\n'],
    ['inner space', `${VALUE} ${VALUE}`],
    ['inner newline', `${VALUE}\n${VALUE}\n`],
    ['a tab', `${VALUE}\t`],
    ['non-ASCII', `${VALUE}é`],
  ])('refuses a value with %s, without echoing it', (_name, content) => {
    plant('gh', 'member', content);
    expect(failure(() => readSecret(paths, 'gh', 'member')).reason).toBe('invalid');
  });
});

describe('ingestSecret', () => {
  it('stores a piped value as a 0600 file in 0700 directories and returns only the byte count', async () => {
    await expect(ingestSecret(paths, 'gh', 'member', stream(`${VALUE}\n`))).resolves.toEqual({ bytes: VALUE.length });
    const file = secretFile(paths, 'gh', 'member');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(paths.secretsDir, 'gh')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.secretsDir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(file, 'utf8')).toBe(VALUE);
    expect(readSecret(paths, 'gh', 'member')).toBe(VALUE);
  });

  it('joins a value split across chunks', async () => {
    await ingestSecret(paths, 'cf', 'dev2', stream('test-', 'secret-', '0001'));
    expect(readSecret(paths, 'cf', 'dev2')).toBe(VALUE);
  });

  it('replaces an existing value atomically and leaves no temp files', async () => {
    await ingestSecret(paths, 'slack', 'broker-app', stream('first-value'));
    await ingestSecret(paths, 'slack', 'broker-app', stream(VALUE));
    expect(readSecret(paths, 'slack', 'broker-app')).toBe(VALUE);
    expect(fs.readdirSync(path.join(paths.secretsDir, 'slack'))).toEqual(['broker-app.token']);
  });

  it('refuses a terminal, telling the operator to pipe the value', async () => {
    const tty = Object.assign(stream(VALUE), { isTTY: true });
    expect((await asyncFailure(ingestSecret(paths, 'gh', 'member', tty))).message).toMatch(/pipe/);
    expect(fs.existsSync(secretFile(paths, 'gh', 'member'))).toBe(false);
  });

  it('refuses more than 8 KiB', async () => {
    const big = 'a'.repeat(MAX_SECRET_BYTES + 1);
    expect(MAX_SECRET_BYTES).toBe(8192);
    await asyncFailure(ingestSecret(paths, 'gh', 'member', stream(big)), big);
    expect(fs.existsSync(secretFile(paths, 'gh', 'member'))).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['only whitespace', ' \n'],
    ['inner space', `${VALUE} ${VALUE}`],
    ['two lines', `${VALUE}\n${VALUE}\n`],
  ])('refuses %s input, without echoing it', async (_name, content) => {
    const err = await asyncFailure(ingestSecret(paths, 'gh', 'member', stream(content)));
    expect(err.reason).toBe('invalid');
    expect(fs.existsSync(secretFile(paths, 'gh', 'member'))).toBe(false);
  });

  it('refuses an existing secrets directory that others can enter, instead of loosening or fixing it', async () => {
    fs.mkdirSync(paths.secretsDir, { mode: 0o755 });
    fs.chmodSync(paths.secretsDir, 0o755);
    expect((await asyncFailure(ingestSecret(paths, 'gh', 'member', stream(VALUE)))).reason).toBe('unsafe');
    expect(fs.existsSync(secretFile(paths, 'gh', 'member'))).toBe(false);
  });

  it('refuses a missing data root instead of creating it (the installer owns its mode)', async () => {
    const absent = brokerPaths(path.join(root, 'absent'));
    expect((await asyncFailure(ingestSecret(absent, 'gh', 'member', stream(VALUE)))).message).toMatch(/installer/);
    expect(fs.existsSync(absent.root)).toBe(false);
  });

  it('validates the name before reading anything', async () => {
    const input = stream(VALUE);
    await asyncFailure(ingestSecret(paths, 'gh', '../member', input));
    expect(fs.existsSync(paths.secretsDir)).toBe(false);
  });
});
