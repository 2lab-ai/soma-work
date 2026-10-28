// Broker-held secrets (.prd/16-devops-tools-architecture.md §8): one file per secret under
// secrets/<kind>/, 0600 in 0700 directories owned by the broker user, written only by `ingest` from a
// pipe. A secret value never reaches an error, a log line or the terminal — messages name the file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrokerPaths } from './paths.js';
import { writeFileAtomic } from './state.js';

export type SecretKind = 'gh' | 'cf' | 'slack';
export const SECRET_KINDS: readonly SecretKind[] = ['gh', 'cf', 'slack'];

/** The broker's own Slack app token lives at secrets/slack/<this>.token. */
export const SLACK_APP_SECRET_NAME = 'broker-app';

export const MAX_SECRET_BYTES = 8 * 1024;

const EXTENSIONS: Record<SecretKind, string> = { gh: 'token', cf: 'forge', slack: 'token' };
const NAME_RE = /^[a-z0-9-]{1,32}$/;
/** Printable ASCII without spaces: every token format the broker holds. */
const VALUE_RE = /^[!-~]+$/;

/** `missing` = no file yet; `unsafe` = ownership, mode or file type is wrong; `invalid` = bad name or value. */
export type SecretProblem = 'missing' | 'unsafe' | 'invalid';

export class SecretError extends Error {
  readonly reason: SecretProblem;

  constructor(reason: SecretProblem, message: string) {
    super(message);
    this.name = 'SecretError';
    this.reason = reason;
  }
}

export interface SecretOwnerOptions {
  /** The uid every secret file and directory must belong to. Defaults to this process's uid. */
  ownerUid?: number;
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function expectedUid(options: SecretOwnerOptions): number {
  const uid = options.ownerUid ?? process.getuid?.();
  if (uid === undefined) throw new SecretError('unsafe', 'file ownership cannot be checked on this platform');
  return uid;
}

/** The file for one secret. Kind and name are checked; neither is echoed when wrong. */
export function secretFile(paths: BrokerPaths, kind: SecretKind, name: string): string {
  if (!SECRET_KINDS.includes(kind))
    throw new SecretError('invalid', `secret kind must be one of ${SECRET_KINDS.join(', ')}`);
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new SecretError('invalid', 'secret name must be 1-32 characters of a-z, 0-9 and -');
  }
  return path.join(paths.secretsDir, kind, `${name}.${EXTENSIONS[kind]}`);
}

function checkOwnerAndMode(where: string, stat: fs.Stats, uid: number): void {
  if (stat.uid !== uid) throw new SecretError('unsafe', `${where} is owned by uid ${stat.uid}, not ${uid}`);
  if ((stat.mode & 0o077) !== 0) {
    throw new SecretError('unsafe', `${where} has mode ${octal(stat.mode)}; group and other must have no access`);
  }
}

function checkDir(dir: string, uid: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') throw new SecretError('missing', `${dir} does not exist`);
    throw new SecretError('unsafe', `${dir} cannot be inspected (${errorCode(err) ?? 'error'})`);
  }
  if (stat.isSymbolicLink()) throw new SecretError('unsafe', `${dir} is a symlink`);
  if (!stat.isDirectory()) throw new SecretError('unsafe', `${dir} is not a directory`);
  checkOwnerAndMode(dir, stat, uid);
}

/** Strips trailing line breaks; the rest must be non-empty printable ASCII with no whitespace. */
function decodeValue(bytes: Buffer, where: string): string {
  const value = bytes.toString('utf8').replace(/[\r\n]+$/, '');
  if (value.length === 0) throw new SecretError('invalid', `${where} is empty`);
  if (!VALUE_RE.test(value)) {
    throw new SecretError('invalid', `${where} contains whitespace, control or non-ASCII characters inside the value`);
  }
  return value;
}

/**
 * Reads one secret. Refuses (without the value) a symlink, a non-regular file, a file or a directory
 * under secrets/ that another uid owns or that grants any group/other access. Directories above
 * secrets/ are not checked: the data root is 0750 broker:soma-devops by design.
 */
export function readSecret(
  paths: BrokerPaths,
  kind: SecretKind,
  name: string,
  options: SecretOwnerOptions = {},
): string {
  const file = secretFile(paths, kind, name);
  const uid = expectedUid(options);
  checkDir(paths.secretsDir, uid);
  checkDir(path.dirname(file), uid);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') throw new SecretError('missing', `${file} does not exist`);
    if (code === 'ELOOP') throw new SecretError('unsafe', `${file} is a symlink`);
    throw new SecretError('unsafe', `${file} cannot be opened (${code ?? 'error'})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new SecretError('unsafe', `${file} is not a regular file`);
    checkOwnerAndMode(file, stat, uid);
    if (stat.size > MAX_SECRET_BYTES)
      throw new SecretError('invalid', `${file} is larger than ${MAX_SECRET_BYTES} bytes`);
    return decodeValue(fs.readFileSync(fd), file);
  } finally {
    fs.closeSync(fd);
  }
}

async function readCapped(input: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    total += buffer.length;
    if (total > MAX_SECRET_BYTES) throw new SecretError('invalid', `input is larger than ${MAX_SECRET_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Creates a missing directory 0700; an existing one must already pass the checks — it is never loosened or fixed. */
function ensureDir(dir: string, uid: number): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err;
  }
  checkDir(dir, uid);
}

/**
 * Stores a secret read from `input` only — refused when `input` is a terminal, so the value is piped
 * and never typed into a scrollback or passed as an argument. Returns the stored byte count only.
 */
export async function ingestSecret(
  paths: BrokerPaths,
  kind: SecretKind,
  name: string,
  input: NodeJS.ReadableStream,
): Promise<{ bytes: number }> {
  const file = secretFile(paths, kind, name);
  if ((input as { isTTY?: boolean }).isTTY === true) {
    throw new SecretError('invalid', 'stdin is a terminal; pipe the secret in instead of typing it');
  }
  const uid = expectedUid({});
  const value = decodeValue(await readCapped(input), 'input');
  // The installer owns the data root (0750 broker:soma-devops); never create it here with another mode.
  if (!fs.existsSync(paths.root))
    throw new SecretError('missing', `${paths.root} does not exist; run the installer first`);
  ensureDir(paths.secretsDir, uid);
  ensureDir(path.dirname(file), uid);
  await writeFileAtomic(file, value, 0o600);
  return { bytes: Buffer.byteLength(value, 'utf8') };
}
