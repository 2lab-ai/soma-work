/**
 * The bot's side of the secret store (secret-access WU1, #1337, `.prd/33-secret-access-architecture.md` §2.1):
 * what the dashboard's 비밀 tab lists, adds, overwrites and deletes.
 *
 * The store is `<config dir>/secrets/` (`SECRETS_DIR`), one file per secret, read by the bot and its MCP servers
 * through `{"$secret": "<name>"}` (`@soma/process-shared/secret-ref`). No model reads or writes it — the sandbox,
 * the CLI deny rules and policy step 1b close it — so this module runs only in the bot process.
 *
 * Values go in once and never come back out: {@link listSecrets} stats files and never reads one, a write answers
 * with the name and the time, and no error message carries a value (or a rejected name — an admin may paste the
 * value into the name field). An overwrite replaces the file atomically and leaves no copy of the old value.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from '@soma/common/atomic-write';
import { SECRETS_DIR } from '../env-paths';

// biome-ignore lint/style/noCommonJs: @soma/process-shared sub-path types are not visible under moduleResolution node
const { isSecretName } = require('@soma/process-shared/secret-ref.js') as { isSecretName(name: unknown): boolean };

/** The largest value the page accepts: far above any token or key, small enough never to be a dump. */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface SecretEntry {
  name: string;
  /** ISO time of the file's last change. */
  updatedAt: string;
}

/** A refusal the dashboard can show as is: it names no value and no rejected name. */
export class SecretAdminError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 500,
  ) {
    super(message);
    this.name = 'SecretAdminError';
  }
}

function storeDir(dir: string | undefined): string {
  if (!dir) throw new SecretAdminError('비밀 저장소가 설정되어 있지 않습니다', 500);
  return dir;
}

function checkName(name: unknown): string {
  if (!isSecretName(name)) {
    const length = typeof name === 'string' ? name.length : 0;
    throw new SecretAdminError(
      `이름은 영문자·숫자로 시작하고 영문자·숫자·. _ - 만 쓰는 128자 이하여야 합니다 (받은 이름 ${length}자)`,
      400,
    );
  }
  return name as string;
}

function checkValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new SecretAdminError('값이 비어 있습니다', 400);
  // readSecret drops one trailing newline and refuses what is left empty: a lone newline would be "saved" and then
  // take its server out at the next read.
  if (value === '\n' || value === '\r\n') throw new SecretAdminError('값이 비어 있습니다 (줄바꿈뿐)', 400);
  if (value.includes('\0')) throw new SecretAdminError('값에 NUL 문자를 넣을 수 없습니다', 400);
  if (Buffer.byteLength(value, 'utf-8') > SECRET_VALUE_MAX_BYTES) {
    throw new SecretAdminError(`값은 ${SECRET_VALUE_MAX_BYTES / 1024} KiB 이하여야 합니다`, 400);
  }
  return value;
}

/** The real path of the store, or null when it does not exist yet. */
function realRoot(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** The entry `name` as the store resolves it (a regular file inside the store), or null. */
function resolvedEntry(dir: string, root: string, name: string): fs.Stats | null {
  let real: string;
  try {
    real = fs.realpathSync(path.join(dir, name));
  } catch {
    return null;
  }
  if (path.dirname(real) !== root) return null;
  const stat = fs.statSync(real);
  return stat.isFile() ? stat : null;
}

/** Every secret the store can resolve, by name. Values are never read. */
export function listSecrets(dir: string | undefined = SECRETS_DIR): SecretEntry[] {
  const store = storeDir(dir);
  const root = realRoot(store);
  if (!root) return [];
  const out: SecretEntry[] = [];
  for (const name of fs.readdirSync(store)) {
    if (!isSecretName(name)) continue;
    const stat = resolvedEntry(store, root, name);
    if (stat) out.push({ name, updatedAt: stat.mtime.toISOString() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Write `value` as secret `name`. A name already in the store is replaced only with `overwrite` (else 409). The
 * file is written whole and renamed into place (0600), so a reader sees the old value or the new one, never a mix.
 */
export function writeSecret(
  name: string,
  value: string,
  opts: { overwrite: boolean },
  dir: string | undefined = SECRETS_DIR,
): { entry: SecretEntry; created: boolean } {
  const store = storeDir(dir);
  const checkedName = checkName(name);
  const checkedValue = checkValue(value);
  const target = path.join(store, checkedName);
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing && !existing.isFile()) {
    throw new SecretAdminError('같은 이름의 항목이 일반 파일이 아닙니다 — 호스트에서 확인하세요', 409);
  }
  if (existing && !opts.overwrite) throw new SecretAdminError('같은 이름의 비밀이 이미 있습니다', 409);
  try {
    atomicWriteFile(target, checkedValue, { mode: FILE_MODE, dirMode: DIR_MODE });
  } catch (error) {
    // The cause may be a path or an errno — never the value; keep only the code.
    throw new SecretAdminError(
      `비밀을 쓰지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`,
      500,
    );
  }
  return {
    entry: { name: checkedName, updatedAt: fs.statSync(target).mtime.toISOString() },
    created: existing === null,
  };
}

/** Remove secret `name` (404 when there is none). A link is removed itself — its target is never touched. */
export function deleteSecret(name: string, dir: string | undefined = SECRETS_DIR): void {
  const store = storeDir(dir);
  const target = path.join(store, checkName(name));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SecretAdminError('그런 비밀이 없습니다', 404);
    throw error;
  }
  if (stat.isDirectory())
    throw new SecretAdminError('같은 이름의 항목이 일반 파일이 아닙니다 — 호스트에서 확인하세요', 409);
  fs.unlinkSync(target);
  // The removal is durable before it is acknowledged and audited, as a write is (atomicWriteFile syncs too).
  const fd = fs.openSync(store, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
