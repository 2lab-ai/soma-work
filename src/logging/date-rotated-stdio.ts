/**
 * Date-rotated stdio writer.
 *
 * Patches `process.stdout.write` and `process.stderr.write` so that every
 * chunk is also written to `<logsDir>/<prefix>-YYYY-MM-DD.log` (one file
 * per local-time day). When the local date changes between writes, the
 * previous fd is closed and a new dated file is opened.
 *
 * Designed for launchd-managed services where `StandardOutPath` /
 * `StandardErrorPath` would otherwise grow unbounded into a single file.
 *
 * Why patch `process.stdout.write` instead of wrapping with a shell
 * runner: pure Node, no extra process, cross-platform, unit-testable.
 *
 * Rules (per codex review):
 *   - One fd per (stream, date). Reopen on date change.
 *   - Use fs.openSync + fs.writeSync (synchronous, deterministic, no flush
 *     lifecycle problems on exit). Loop for partial writes; retry EINTR.
 *   - `passthrough` defaults to true (preserves TTY/dev output). Set to
 *     false under launchd so the bootstrap fallback files do not also
 *     receive the full firehose.
 *   - Retention prunes by *filename date*, not stat mtime. Today's file
 *     is never pruned. Non-matching filenames are ignored.
 *   - Idempotent: second install returns the existing handle.
 */

import * as fs from 'fs';
import * as path from 'path';

export type LogStreamName = 'stdout' | 'stderr';

export interface DateRotatedStdioOptions {
  /** Directory where date-stamped log files live. Created if missing. */
  logsDir: string;
  /** Clock for date computation. Defaults to `() => new Date()`. Read on every write. */
  clock?: () => Date;
  /** Retention in days (default 30). Files whose filename date is older are pruned. 0 disables. */
  retentionDays?: number;
  /** If true (default), also call the original `process.stdout/stderr.write`. */
  passthrough?: boolean;
  /** Internal — set false in tests to suppress the 24h retention timer. */
  scheduleRetention?: boolean;
}

export interface DateRotatedStdioHandle {
  /** Restore original write methods and close open fds. */
  uninstall(): void;
  /** Force `fsync` on all currently-open log fds (tests + graceful shutdown). */
  flush(): void;
  /** Run retention pruning synchronously. Returns the number of files deleted. */
  pruneNow(): number;
}

const INSTALL_BRAND = Symbol.for('soma-work.logging.date-rotated-stdio.installed');
const FILENAME_RE = /^(?:stdout|stderr)-(\d{4})-(\d{2})-(\d{2})\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;

interface GlobalState {
  [INSTALL_BRAND]?: DateRotatedStdioHandle;
}

/** Format a Date as a local-timezone `YYYY-MM-DD` stamp. */
export function formatLocalDateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Build `<logsDir>/<prefix>-<dateStamp>.log`. */
export function buildLogPath(logsDir: string, prefix: LogStreamName, dateStamp: string): string {
  return path.join(logsDir, `${prefix}-${dateStamp}.log`);
}

/** Extract the `YYYY-MM-DD` from a rotated-log filename, or null when not matching. */
export function parseDateFromLogFilename(name: string): string | null {
  const m = FILENAME_RE.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

interface StreamState {
  currentDate: string;
  fd: number;
}

function openForDate(logsDir: string, prefix: LogStreamName, dateStamp: string): number {
  fs.mkdirSync(logsDir, { recursive: true });
  return fs.openSync(buildLogPath(logsDir, prefix, dateStamp), 'a');
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    try {
      const n = fs.writeSync(fd, data, offset, data.length - offset);
      if (n <= 0) break;
      offset += n;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EINTR' || code === 'EAGAIN') continue;
      throw err;
    }
  }
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8');
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  // Last-resort coercion. We never crash inside the write path.
  return Buffer.from(String(chunk));
}

type WriteFn = typeof process.stdout.write;

/**
 * Install date-rotated logging for stdout and stderr. Idempotent — calling
 * twice returns the same handle (the second call's options are ignored).
 */
interface InstalledRecord {
  handle: DateRotatedStdioHandle;
  effective: { logsDir: string; retentionDays: number; passthrough: boolean };
}
const INSTALLED_REC: { current: InstalledRecord | null } = { current: null };

/** Return the active handle for graceful shutdown (flush). Null if not installed. */
export function getInstalledDateRotatedStdio(): DateRotatedStdioHandle | null {
  return INSTALLED_REC.current?.handle ?? null;
}

export function installDateRotatedStdio(options: DateRotatedStdioOptions): DateRotatedStdioHandle {
  const globalState = global as unknown as GlobalState;
  const existing = globalState[INSTALL_BRAND];

  const logsDir = options.logsDir;
  const clock = options.clock ?? (() => new Date());
  const retentionDays = options.retentionDays ?? 30;
  const passthrough = options.passthrough ?? true;
  const scheduleRetention = options.scheduleRetention ?? true;

  if (existing) {
    // Re-install with mismatched options is almost always a wiring bug:
    // two call sites disagreeing on logsDir/retention/passthrough. Surface
    // it via process.stderr.write (already patched by the first install,
    // so the warning lands in the rotated stderr file) but do not throw —
    // preserves back-compat for idempotent re-install with same options.
    const eff = INSTALLED_REC.current?.effective;
    if (eff && (eff.logsDir !== logsDir || eff.retentionDays !== retentionDays || eff.passthrough !== passthrough)) {
      const msg =
        `[date-rotated-stdio] second install attempted with different options ` +
        `(active: logsDir=${eff.logsDir} retentionDays=${eff.retentionDays} passthrough=${eff.passthrough}; ` +
        `requested: logsDir=${logsDir} retentionDays=${retentionDays} passthrough=${passthrough}). ` +
        `Keeping active install.\n`;
      try {
        process.stderr.write(msg);
      } catch {
        // stderr unavailable; nothing we can do.
      }
    }
    return existing;
  }

  fs.mkdirSync(logsDir, { recursive: true });

  // Hold the unbound function references so uninstall can restore them by
  // identity. We re-supply `this` explicitly when invoking through them.
  const originalStdoutWrite: WriteFn = process.stdout.write;
  const originalStderrWrite: WriteFn = process.stderr.write;

  const states: Record<LogStreamName, StreamState | null> = {
    stdout: null,
    stderr: null,
  };

  const ensureState = (prefix: LogStreamName, dateStamp: string): StreamState => {
    const cur = states[prefix];
    if (cur && cur.currentDate === dateStamp) return cur;
    if (cur) {
      try {
        fs.closeSync(cur.fd);
      } catch {
        // Best-effort close.
      }
    }
    const fd = openForDate(logsDir, prefix, dateStamp);
    const next: StreamState = { currentDate: dateStamp, fd };
    states[prefix] = next;
    return next;
  };

  // Date-stamp cache. The hot path computes today's stamp on every write;
  // we cheaply detect day rollover via Date#getDate() and only rebuild the
  // string on a different day. Survives clock backflow (same getDate() →
  // cached stamp is reused; tests pin this behavior).
  let cachedDay = -1;
  let cachedStamp = '';
  const computeDateStamp = (): string => {
    const now = clock();
    const day = now.getDate();
    if (day === cachedDay) return cachedStamp;
    cachedStamp = formatLocalDateStamp(now);
    cachedDay = day;
    return cachedStamp;
  };

  const routeWrite = (
    prefix: LogStreamName,
    stream: NodeJS.WriteStream,
    original: WriteFn,
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    let encoding: BufferEncoding | undefined;
    let callback: ((err?: Error | null) => void) | undefined;
    if (typeof encodingOrCb === 'function') {
      callback = encodingOrCb;
    } else {
      encoding = encodingOrCb;
      callback = cb;
    }

    let writeErr: Error | null = null;
    try {
      const buf = toBuffer(chunk, encoding);
      const dateStamp = computeDateStamp();
      const state = ensureState(prefix, dateStamp);
      writeAll(state.fd, buf);
    } catch (err) {
      writeErr = err as Error;
      // Surface to raw fd 2 — never reenter our own wrapper or console.
      try {
        const msg = `[date-rotated-stdio] write to ${prefix} failed: ${(err as Error).message}\n`;
        fs.writeSync(2, msg);
      } catch {
        // If even fd 2 is broken, we have nothing left to do.
      }
    }

    if (!passthrough) {
      if (callback) {
        try {
          callback(writeErr);
        } catch {
          // User-provided callback threw; we have no logger available here.
        }
      }
      return true;
    }

    // Preserve the original Writable.write overload shape, supplying the
    // correct `this` because we stash the unbound function reference.
    // Reflect.apply keeps the overload union intact (the TS narrowing of
    // encodingOrCb cannot reach overload selection on a bound .call).
    const args: unknown[] = [chunk];
    if (encoding !== undefined) args.push(encoding);
    if (callback) args.push(callback);
    return Reflect.apply(original, stream, args) as boolean;
  };

  const patchedStdout: WriteFn = ((
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => routeWrite('stdout', process.stdout, originalStdoutWrite, chunk, encodingOrCb, cb)) as WriteFn;

  const patchedStderr: WriteFn = ((
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => routeWrite('stderr', process.stderr, originalStderrWrite, chunk, encodingOrCb, cb)) as WriteFn;

  let retentionTimer: NodeJS.Timeout | null = null;

  // Restore writes on any failure during retention/handle setup so a
  // throw between patching and brand-set cannot leave the process with
  // patched writes but no install record (which would let a subsequent
  // install double-patch).
  const restoreOnFailure = (err: unknown): never => {
    if (process.stdout.write === patchedStdout) process.stdout.write = originalStdoutWrite;
    if (process.stderr.write === patchedStderr) process.stderr.write = originalStderrWrite;
    throw err;
  };

  process.stdout.write = patchedStdout;
  process.stderr.write = patchedStderr;

  const pruneNow = (): number => {
    if (retentionDays <= 0) return 0;
    const nowDate = clock();
    const todayStamp = formatLocalDateStamp(nowDate);
    const cutoffStamp = formatLocalDateStamp(new Date(nowDate.getTime() - retentionDays * DAY_MS));
    let deleted = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(logsDir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const fileDate = parseDateFromLogFilename(name);
      if (!fileDate) continue;
      if (fileDate === todayStamp) continue;
      if (fileDate < cutoffStamp) {
        try {
          fs.unlinkSync(path.join(logsDir, name));
          deleted++;
        } catch {
          // Best-effort; permission or race — skip.
        }
      }
    }
    return deleted;
  };

  try {
    if (scheduleRetention && retentionDays > 0) {
      pruneNow();
      retentionTimer = setInterval(pruneNow, DAY_MS);
      retentionTimer.unref();
    }

    const handle: DateRotatedStdioHandle = {
      uninstall() {
        if (process.stdout.write === patchedStdout) {
          process.stdout.write = originalStdoutWrite;
        }
        if (process.stderr.write === patchedStderr) {
          process.stderr.write = originalStderrWrite;
        }
        for (const key of ['stdout', 'stderr'] as const) {
          const s = states[key];
          if (s) {
            try {
              fs.closeSync(s.fd);
            } catch {
              // Best-effort.
            }
            states[key] = null;
          }
        }
        if (retentionTimer) {
          clearInterval(retentionTimer);
          retentionTimer = null;
        }
        delete globalState[INSTALL_BRAND];
        INSTALLED_REC.current = null;
      },
      flush() {
        for (const key of ['stdout', 'stderr'] as const) {
          const s = states[key];
          if (s) {
            try {
              fs.fsyncSync(s.fd);
            } catch {
              // Best-effort.
            }
          }
        }
      },
      pruneNow,
    };

    globalState[INSTALL_BRAND] = handle;
    INSTALLED_REC.current = { handle, effective: { logsDir, retentionDays, passthrough } };
    return handle;
  } catch (err) {
    return restoreOnFailure(err);
  }
}

/**
 * Read environment variables to compute a sane default config for
 * launchd-managed services. Caller still passes `logsDir` explicitly.
 *
 *   SOMA_LOG_PASSTHROUGH=0|false → passthrough=false (default under launchd)
 *   LOG_RETENTION_DAYS=<n>       → retention in days (default 30)
 */
export function readEnvOptions(env: NodeJS.ProcessEnv = process.env): {
  passthrough: boolean;
  retentionDays: number;
} {
  const raw = (env.SOMA_LOG_PASSTHROUGH ?? '').trim().toLowerCase();
  const passthrough = !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
  const retentionRaw = env.LOG_RETENTION_DAYS;
  let retentionDays = 30;
  if (retentionRaw !== undefined && retentionRaw !== '') {
    const parsed = Number.parseInt(retentionRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) retentionDays = parsed;
  }
  return { passthrough, retentionDays };
}
