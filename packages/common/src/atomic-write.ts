/**
 * Atomic, symlink-hardened file/JSON persistence helpers.
 *
 * `rules/config.md` §3–4 require every on-disk state write to be atomic
 * (temp → fsync → rename) and every load to fall back to `.bak` with a WARN
 * instead of silently degrading to an empty value. This module is the single
 * implementation of that contract; domain code must not open live state files
 * for writing on its own.
 *
 * Threat model notes:
 *   - The temp file is opened `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` so a planted
 *     symlink at the temp path cannot be written through.
 *   - The destination path and its ancestor chain are `lstat`-checked. The walk
 *     stops at the home/temp directory boundary because on macOS `/var` and
 *     `/tmp` are themselves symlinks, so an unbounded walk would reject every
 *     legitimate path. All somawork-owned components sit below those roots.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Default mode for files written through this module: owner read/write only. */
export const DEFAULT_FILE_MODE = 0o600;
/** Default mode for directories created through this module: owner only. */
export const DEFAULT_DIR_MODE = 0o700;

export interface AtomicWriteOptions {
  /** Mode applied to the written file. Defaults to {@link DEFAULT_FILE_MODE}. */
  mode?: number;
  /** When true, the previous live contents are copied to `<path>.bak` first. */
  backup?: boolean;
  /** Mode applied to directories this call creates. Defaults to {@link DEFAULT_DIR_MODE}. */
  dirMode?: number;
  /**
   * Whether a directory that ALREADY EXISTS may be tightened to `dirMode`.
   * Defaults to `true`.
   *
   * Creating and tightening are two different decisions and this flag keeps
   * them separable. A caller that owns its directory tree (a profile's config
   * or state root) wants both. A caller that merely writes a file into
   * somebody else's directory — `config.json` at a repository checkout — wants
   * the first and not the second, because chmod'ing a checkout from 0755 to
   * 0700 is not a side effect a config save may have.
   *
   * The wrong way to express that is a permissive `dirMode`: `dirMode` is also
   * the mode every CREATED component gets, so `dirMode: 0o7777` silently makes
   * a missing parent world-writable while appearing to only disable
   * tightening. Symlink refusal is unaffected either way.
   */
  tightenExistingDir?: boolean;
}

/** Raised when a path (or one of its ancestors) is a symlink we refuse to follow. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

/** Raised when neither the live file nor its `.bak` could be parsed/validated. */
export class CorruptStateError extends Error {
  readonly failures: string[];

  constructor(message: string, failures: string[]) {
    super(message);
    this.name = 'CorruptStateError';
    this.failures = failures;
  }
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Directories at which the ancestor symlink scan stops (see module doc). */
function scanBoundaries(): Set<string> {
  const boundaries = new Set<string>();
  for (const candidate of [os.tmpdir(), os.homedir()]) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    boundaries.add(resolved);
    try {
      boundaries.add(fs.realpathSync(resolved));
    } catch {
      // Boundary may not exist in a stripped environment; the lexical form is enough.
    }
  }
  return boundaries;
}

/** Throw if `target` exists and is a symlink. Missing paths are fine. */
export function assertNotSymlink(target: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (err) {
    if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR') return;
    throw err;
  }
  if (stats.isSymbolicLink()) {
    throw new UnsafePathError(`Refusing to use "${target}": path is a symlink.`);
  }
}

/**
 * Throw if `target` or any ancestor below the home/temp boundary is a symlink.
 */
export function assertNoSymlinkPath(target: string): void {
  const abs = path.resolve(target);
  assertNotSymlink(abs);

  const boundaries = scanBoundaries();
  const root = path.parse(abs).root;
  let current = path.dirname(abs);

  while (current !== root && !boundaries.has(current)) {
    assertNotSymlink(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Throw unless `target` resolves to a directory. */
function assertIsDirectory(target: string): void {
  if (!fs.statSync(target).isDirectory()) {
    throw new UnsafePathError(`Refusing to use "${target}": expected a directory.`);
  }
}

/**
 * Bring `dir` down to `dirMode` — never up. Only bits granted beyond `dirMode`
 * are cleared, so a directory that is already stricter (or has a setgid bit we
 * would not want on a secrets directory) is tightened rather than reopened.
 *
 * Boundary roots ($HOME, $TMPDIR, filesystem root) are exempt: a caller writing
 * straight into one must not end up locking the user out of their own home.
 */
function tightenDirMode(dir: string, dirMode: number, boundaries: Set<string>): void {
  if (boundaries.has(dir) || dir === path.parse(dir).root) return;
  const current = fs.statSync(dir).mode & 0o7777;
  if ((current & ~dirMode) === 0) return;
  fs.chmodSync(dir, current & dirMode);
}

/**
 * Create `dir` (and missing ancestors) and guarantee `dirMode` on the directory
 * that will hold the file.
 *
 * A directory this call CREATES always lands at exactly `dirMode`, regardless
 * of `tightenExisting` and of the umask.
 *
 * For a directory that already exists, `tightenExisting` decides. When true
 * (the default) the mode guarantee is unconditional rather than create-only:
 * `task-2-context.md` states "Profile parent directory is mode 0700" flatly,
 * and a profile directory left at 0755 by an earlier build or a restore would
 * otherwise be accepted as-is. Ancestors above the immediate parent are only
 * set when this call creates them — tightening `$HOME/.config` would be
 * overreach.
 */
function ensureDir(dir: string, dirMode: number, tightenExisting: boolean): void {
  const abs = path.resolve(dir);
  const root = path.parse(abs).root;
  const boundaries = scanBoundaries();
  const missing: string[] = [];

  let current = abs;
  while (current !== root && !fs.existsSync(current)) {
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const dirPath of missing) {
    let created = true;
    try {
      fs.mkdirSync(dirPath, { mode: dirMode });
    } catch (err) {
      if (errno(err) !== 'EEXIST') throw err;
      created = false;
    }

    if (created) {
      // mkdir's mode is masked by the process umask; force the intended bits.
      // Unconditional: a directory this call brought into existence is ours to
      // set exactly, and `tightenExisting` says nothing about it.
      fs.chmodSync(dirPath, dirMode);
      continue;
    }

    // We lost a race: something created this component between the existsSync
    // probe above and our mkdir. Re-establish what assertNoSymlinkPath proved
    // before that window opened, then apply the mode we would have created it
    // with. Same-uid only, so this is defense in depth rather than a boundary.
    assertNotSymlink(dirPath);
    assertIsDirectory(dirPath);
    // The racing creator won, so from here this component is pre-existing and
    // the caller's policy for pre-existing directories applies.
    if (tightenExisting) tightenDirMode(dirPath, dirMode, boundaries);
  }

  assertIsDirectory(abs);
  if (tightenExisting) tightenDirMode(abs, dirMode, boundaries);
}

/**
 * Create `dir` (and missing ancestors) with `mode`, refusing symlinked
 * components, and **tighten** `dir` to `mode`.
 *
 * Tighten, never loosen: `tightenDirMode` only clears bits granted beyond
 * `mode`, so a pre-existing 0500 directory stays 0500 rather than being opened
 * up to 0700, and the boundary roots ($HOME, $TMPDIR, filesystem root) are
 * exempt entirely. A caller that needs a guaranteed exact mode must check it
 * afterwards; this function will not widen access to satisfy a request.
 *
 * Exported so a caller that needs a *directory* with no file in it (a profile's
 * data/state root) gets the identical create-and-tighten semantics
 * {@link atomicWriteFile} applies to a file's parent, instead of hand-rolling
 * `mkdirSync` + `chmodSync` and drifting from the umask/race handling above.
 */
export function ensureDirectory(dir: string, mode: number = DEFAULT_DIR_MODE): void {
  const abs = path.resolve(dir);
  assertNoSymlinkPath(abs);
  ensureDir(abs, mode, true);
}

/** Best-effort durability for the rename itself. Failures are non-fatal. */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some filesystems; the rename still stands.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing actionable if the descriptor is already gone.
      }
    }
  }
}

/**
 * Write `data` to `target` atomically: unique same-directory temp file, fsync,
 * chmod, optional `.bak` of the previous contents, then rename into place.
 */
export function atomicWriteFile(target: string, data: string | Buffer, opts: AtomicWriteOptions = {}): void {
  const abs = path.resolve(target);
  const mode = opts.mode ?? DEFAULT_FILE_MODE;
  const dirMode = opts.dirMode ?? DEFAULT_DIR_MODE;

  assertNoSymlinkPath(abs);

  const dir = path.dirname(abs);
  ensureDir(dir, dirMode, opts.tightenExistingDir ?? true);

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);

  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      mode,
    );

    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fs.fsyncSync(fd);
    // openSync's mode is umask-masked, so restate the intended bits on the fd.
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
    fd = undefined;

    if (opts.backup === true && fs.existsSync(abs)) {
      const backupPath = `${abs}.bak`;
      assertNotSymlink(backupPath);
      fs.copyFileSync(abs, backupPath);
      fs.chmodSync(backupPath, mode);
    }

    fs.renameSync(tmp, abs);
    fsyncDir(dir);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed or never opened cleanly.
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Leaving a temp behind is preferable to masking the original failure.
    }
    throw err;
  }
}

/** Recursively sort object keys so serialized JSON is byte-stable across saves. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortKeysDeep(source[key]);
  }
  return sorted;
}

/** Serialize `value` as stable, newline-terminated JSON through {@link atomicWriteFile}. */
export function atomicWriteJson<T>(target: string, value: T, opts: AtomicWriteOptions = {}): void {
  atomicWriteFile(target, `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`, opts);
}

function readTextIfPresent(target: string): string | null {
  assertNotSymlink(target);
  try {
    return fs.readFileSync(target, 'utf-8');
  } catch (err) {
    if (errno(err) === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Load JSON from `target`, falling back to `<target>.bak` when the live file is
 * unreadable or fails `validate`.
 *
 * Returns `null` only when neither path exists. A corrupt live file with a
 * corrupt/absent backup throws {@link CorruptStateError} — per `rules/config.md`
 * §4 a load failure must never degrade silently into an empty value.
 */
export function loadJsonWithBackup<T>(target: string, validate: (value: unknown) => T): T | null {
  const abs = path.resolve(target);
  const backupPath = `${abs}.bak`;

  const liveRaw = readTextIfPresent(abs);
  const backupRaw = readTextIfPresent(backupPath);

  if (liveRaw === null && backupRaw === null) return null;

  const failures: string[] = [];

  if (liveRaw !== null) {
    try {
      return validate(JSON.parse(liveRaw));
    } catch (err) {
      failures.push(`live "${abs}": ${describe(err)}`);
      console.warn(`[atomic-write] WARN unusable state at "${abs}" (${describe(err)}); trying "${backupPath}".`);
    }
  }

  if (backupRaw !== null) {
    try {
      return validate(JSON.parse(backupRaw));
    } catch (err) {
      failures.push(`backup "${backupPath}": ${describe(err)}`);
    }
  }

  throw new CorruptStateError(
    `Unable to load JSON state from "${abs}" or its backup: ${failures.join('; ')}`,
    failures,
  );
}
