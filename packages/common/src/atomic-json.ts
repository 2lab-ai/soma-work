/**
 * Atomic JSON state store helper — the single implementation named by
 * `rules/config.md` §절대규칙 3–4:
 *
 *   3. JSON 상태 저장은 원자적이어야 한다 (temp write → renameSync).
 *   4. 로드 실패를 조용히 빈값으로 떨어뜨리지 않는다 (WARN + `.bak` 폴백).
 *
 * The pattern is the one already proven in
 * `packages/process-shared/src/mcp-tool-grant-store.ts:119-121` (temp +
 * rename), with three differences that the rule asks for and that store does
 * not provide: a shared entry point, a `.bak` generation of the last
 * *validated* content, and a loader that refuses to report an empty store when
 * the data is merely unreadable (that store's `loadGrants` resets to `{}` on
 * error — `mcp-tool-grant-store.ts:109-110` — which is exactly the silent data
 * loss rule 4 forbids, so it is deliberately not copied here).
 *
 * Scope of the durability claim — deliberately narrow. The payload is written
 * to a temp file and `fsync`ed before the rename, so a concurrent reader of
 * the live path never observes a half-written file: it sees either the whole
 * old generation or the whole new one. That is the *only* guarantee claimed.
 * It is NOT crash-safety: `fsync(2)` on macOS flushes to the drive, not
 * necessarily through its write cache (that needs `F_FULLFSYNC`), and the
 * containing directory is never fsynced, so a power loss can still lose the
 * rename. Read this as "no torn live file, no silent loss", nothing more.
 *
 * Known residual: a process killed between the temp write and the rename
 * leaves a `<file>.<pid>.<hex>.tmp` orphan behind. This module does not reap
 * them — a sweeper cannot tell a dead process's orphan from another live
 * process's in-flight temp, and deleting the latter would break the very
 * atomicity this helper exists for. Orphans are inert (never read, never
 * renamed into place); cleaning them up is an ops/store-owner decision.
 *
 * Everything is synchronous on purpose: callers mutate in-memory state and
 * persist it inside a single same-process transaction, and an `await` in the
 * middle of that is an interleaving hazard, not a performance win.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from './logger';

const logger = new Logger('atomic-json');

/** Owner-only: these files hold user messages and grants, not public config. */
const FILE_MODE = 0o600;

/** WARN sink. Defaults to the package logger; stores may pass their own. */
export type WarnFn = (message: string, detail?: unknown) => void;

export interface AtomicWriteJsonOptions {
  /**
   * Validates the *previous* live content before it is promoted to `.bak`.
   * Return `false` (or throw) to keep the existing backup instead. Syntax is
   * always checked; pass this when the store's schema matters too, so that a
   * structurally broken live file cannot displace a healthy backup.
   */
  validatePrevious?: (parsed: unknown) => boolean;
  warn?: WarnFn;
}

export interface ReadJsonWithBackupOptions {
  warn?: WarnFn;
}

function defaultWarn(message: string, detail?: unknown): void {
  logger.warn(message, detail);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function backupPath(filePath: string): string {
  return `${filePath}.bak`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Persist `value` as JSON at `filePath`.
 *
 * Order of operations:
 *   1. serialize (a value that cannot be stringified throws before any I/O);
 *   2. `mkdir -p` the parent;
 *   3. promote the previous live content to `.bak` *if it is valid*;
 *   4. temp write → fsync → rename over the live path.
 *
 * Steps 2–3 do touch the filesystem before step 4 — the parent directory may
 * be created and `<file>.bak` may be replaced even on a call that later throws.
 * Both are additive and idempotent; the invariant is narrower and is about the
 * **live path only**: `filePath` changes exactly once, at the final rename, and
 * on any failure it is left byte-identical to what it was, the temp file is
 * removed, and the error is thrown (never swallowed into a silent no-op).
 */
export function atomicWriteJson(filePath: string, value: unknown, options: AtomicWriteJsonOptions = {}): void {
  const warn = options.warn ?? defaultWarn;
  const serialized = serialize(filePath, value);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  promotePreviousToBackup(filePath, options.validatePrevious, warn);
  writeFileAtomic(filePath, serialized);
}

function serialize(filePath: string, value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, 2);
  } catch (error) {
    throw new Error(`atomic-json: cannot serialize value for ${filePath}: ${describeError(error)}`);
  }
  if (json === undefined) {
    throw new Error(`atomic-json: value for ${filePath} is not JSON-serializable`);
  }
  return `${json}\n`;
}

/**
 * Copy the current live file to `<file>.bak`, but only when it is usable.
 *
 * A corrupt live file (truncated by a crash, wrong schema) must never replace
 * a healthy backup — that would destroy the only remaining good generation.
 * A missing live file (first write) is not an error.
 */
function promotePreviousToBackup(
  filePath: string,
  validatePrevious: ((parsed: unknown) => boolean) | undefined,
  warn: WarnFn,
): void {
  let previous: string;
  try {
    previous = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return;
    throw new Error(`atomic-json: cannot read ${filePath} before backup: ${describeError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(previous);
  } catch (error) {
    warn(`atomic-json: keeping existing backup — live file ${filePath} is not valid JSON`, describeError(error));
    return;
  }

  if (validatePrevious) {
    let accepted = false;
    try {
      accepted = validatePrevious(parsed);
    } catch (error) {
      warn(`atomic-json: keeping existing backup — validator rejected ${filePath}`, describeError(error));
      return;
    }
    if (!accepted) {
      warn(`atomic-json: keeping existing backup — validator rejected ${filePath}`);
      return;
    }
  }

  writeFileAtomic(backupPath(filePath), previous);
}

function writeFileAtomic(target: string, contents: string): void {
  const tempPath = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    // 'wx' + a unique name: a collision is a bug, not something to overwrite.
    fd = fs.openSync(tempPath, 'wx', FILE_MODE);
    fs.writeFileSync(fd, contents, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, target);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort: the write already failed */
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* best-effort: temp may not exist */
    }
    throw new Error(`atomic-json: failed to write ${target}: ${describeError(error)}`);
  }
}

type Candidate<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'invalid'; reason: string };

/**
 * Load JSON state, falling back to `<file>.bak` with a WARN.
 *
 * Returns `undefined` **only** for a genuinely new store — live and backup
 * both absent. Anything else that cannot be parsed or validated throws, so a
 * caller can never mistake "unreadable" for "empty" (an empty queue rendered
 * to a user is indistinguishable from "my message vanished").
 *
 * `validate` is the store's schema gate: throw (or let a destructure throw) on
 * anything unusable. Reading never writes — a damaged live file is left in
 * place for inspection and is not repaired from the backup.
 */
export function readJsonWithBackup<T>(
  filePath: string,
  validate: (raw: unknown) => T,
  options: ReadJsonWithBackupOptions = {},
): T | undefined {
  const warn = options.warn ?? defaultWarn;
  const live = loadCandidate(filePath, validate);
  if (live.kind === 'ok') return live.value;

  const bak = backupPath(filePath);
  const backup = loadCandidate(bak, validate);

  if (live.kind === 'missing' && backup.kind === 'missing') {
    return undefined;
  }

  if (backup.kind === 'ok') {
    const why = live.kind === 'missing' ? 'is missing' : `is unusable (${live.reason})`;
    warn(`atomic-json: live file ${filePath} ${why} — falling back to ${bak}`);
    return backup.value;
  }

  const liveReason = live.kind === 'missing' ? 'missing' : live.reason;
  const backupReason = backup.kind === 'missing' ? 'missing' : backup.reason;
  throw new Error(
    `atomic-json: ${filePath} is unusable (${liveReason}) and backup ${bak} is unusable (${backupReason}) — ` +
      'refusing to report an empty store',
  );
}

function loadCandidate<T>(filePath: string, validate: (raw: unknown) => T): Candidate<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' };
    return { kind: 'invalid', reason: `unreadable: ${describeError(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'invalid', reason: `invalid JSON: ${describeError(error)}` };
  }

  try {
    return { kind: 'ok', value: validate(parsed) };
  } catch (error) {
    return { kind: 'invalid', reason: `failed validation: ${describeError(error)}` };
  }
}
