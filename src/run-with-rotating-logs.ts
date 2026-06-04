/**
 * Rotating-log supervisor for the launchd-managed soma-work daemon.
 *
 * Why this exists
 * ---------------
 * The service runs as a macOS user-level LaunchAgent (see `scripts/service.sh`).
 * launchd redirects the daemon's fd1/fd2 into `logs/stdout.log` / `logs/stderr.log`
 * via `StandardOutPath` / `StandardErrorPath` — but launchd has **no log rotation**
 * and no SIGHUP-reopen, so those files grow without bound forever. In-place
 * rotation (`mv stdout.log stdout.log.1`) is broken because launchd keeps the
 * inode open and keeps writing to the moved file.
 *
 * Strategy (decided with codex, see PR description)
 * -------------------------------------------------
 * Instead of letting launchd own the log files, launchd starts THIS wrapper.
 * The wrapper spawns the real entrypoint (`dist/index.js`) with piped stdio and
 * streams each pipe into its own {@link https://github.com/iccicci/rotating-file-stream
 * rotating-file-stream}. This captures the app's console output **and** V8/native
 * crash output written straight to fd2, preserves the stdout/stderr split, needs
 * no sudo, and keeps stable repo-local log paths that `service.sh logs` can tail.
 *
 * The wrapper's OWN recurring diagnostics (startup line, child-exit code) go to
 * a *rotating* `logs/supervisor.log` — never to plain stdout/stderr — so a
 * crash-looping child (which restarts the supervisor every ThrottleInterval)
 * cannot grow an unrotated file. The launchd `StandardOutPath`/`StandardErrorPath`
 * bootstrap files (`logs/launchd.{out,err}.log`) therefore only ever capture
 * catastrophic *pre-init* failures (e.g. node cannot even load this wrapper);
 * the supervisor caps them on startup as a last-resort bound.
 */

import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStream, type Options, type RotatingFileStream } from 'rotating-file-stream';

export interface RotationStreamOptions {
  /** Rotate once the live file reaches this size (primary trigger). */
  size: string;
  /** Maximum number of rotated files to retain. */
  maxFiles: number;
  /** Hard cap on the total bytes of rotated history (defence against disk fill). */
  maxSize: string;
  /** Compression for rotated files. `'gzip'` appends `.gz`. */
  compress: 'gzip' | boolean;
}

/**
 * Defaults agreed with codex for a chatty Slack-bot daemon: size-based rotation
 * is the right primary trigger (not time), with bounded retention + a total cap
 * + gzip so rotated history stays small.
 */
export const DEFAULT_ROTATION_OPTIONS: RotationStreamOptions = {
  size: '25M',
  maxFiles: 20,
  maxSize: '500M',
  compress: 'gzip',
};

/**
 * Resolve the directory the rotating log files live in.
 *
 * Defaults to `<cwd>/logs` (the launchd plist runs with `cwd = $PROJECT_DIR`).
 * `SOMA_LOG_DIR` overrides it; a relative override is resolved to an absolute
 * path so the streams never depend on the rotator's own working directory drift.
 */
export function resolveLogDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const override = env.SOMA_LOG_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(cwd, 'logs');
}

export interface LogStreams {
  stdout: RotatingFileStream;
  stderr: RotatingFileStream;
}

/**
 * Create the two rotating streams (`stdout.log`, `stderr.log`) inside `logDir`.
 * The non-rotated (live) file is always exactly `stdout.log` / `stderr.log`, so
 * `tail -F logs/stdout.log` stays valid across rotations.
 */
export function createLogStreams(logDir: string, overrides: Partial<RotationStreamOptions> = {}): LogStreams {
  fs.mkdirSync(logDir, { recursive: true });
  const opts: RotationStreamOptions = { ...DEFAULT_ROTATION_OPTIONS, ...overrides };

  const make = (basename: string): RotatingFileStream => {
    const streamOpts: Options = {
      path: logDir,
      size: opts.size,
      maxFiles: opts.maxFiles,
      maxSize: opts.maxSize,
      compress: opts.compress,
      // A history file lets rfs track rotated files for maxFiles/maxSize
      // bookkeeping even when compression renames them to `*.gz`.
      history: `${basename}.history`,
    };
    return createStream(basename, streamOpts);
  };

  return { stdout: make('stdout.log'), stderr: make('stderr.log') };
}

export interface RunOptions {
  command: string;
  args: string[];
  logDir: string;
  streamOptions?: Partial<RotationStreamOptions>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RunHandle {
  child: ChildProcess;
  streams: LogStreams;
  /**
   * Resolves with the effective exit code once the child has exited AND both
   * rotating streams have flushed their pending writes/rotations to disk.
   */
  done: Promise<number>;
}

/**
 * Spawn `command` and tee its stdout/stderr into rotating files.
 *
 * Lifecycle guarantees:
 *  - `child.stdout` / `child.stderr` are piped into the rotating streams; the
 *    default pipe behaviour ends each stream when the source ends.
 *  - `done` resolves only after the child has exited and both streams emitted
 *    `finish`, so callers (and `process.exit`) never truncate pending rotations.
 *  - A fatal stream error (e.g. `ENOSPC`) kills the child and surfaces a
 *    non-zero exit code, rather than letting the daemon run blind without logs.
 */
export function runWithRotatingLogs(options: RunOptions): RunHandle {
  const streams = createLogStreams(options.logDir, options.streamOptions);

  const child = spawn(options.command, options.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env ?? process.env,
    cwd: options.cwd,
  });

  child.stdout?.pipe(streams.stdout);
  child.stderr?.pipe(streams.stderr);

  const done = new Promise<number>((resolve) => {
    let childExited = false;
    let exitCode = 0;
    let stdoutDone = false;
    let stderrDone = false;
    let settled = false;

    const tryResolve = () => {
      if (!settled && childExited && stdoutDone && stderrDone) {
        settled = true;
        resolve(exitCode);
      }
    };

    streams.stdout.on('finish', () => {
      stdoutDone = true;
      tryResolve();
    });
    streams.stderr.on('finish', () => {
      stderrDone = true;
      tryResolve();
    });

    const onStreamError = (which: string) => (err: Error) => {
      // A rotating stream that cannot write (disk full, permissions) means we
      // are about to lose logs. Fail loud and stop the daemon so launchd's
      // restart/throttle surfaces the problem instead of a silent log gap.
      process.stderr.write(`[run-with-rotating-logs] fatal ${which} log stream error: ${err.message}\n`);
      exitCode = exitCode || 1;
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      // Mark this stream as done so `done` can still settle even if 'finish'
      // never arrives after the error.
      if (which === 'stdout') stdoutDone = true;
      else stderrDone = true;
      tryResolve();
    };
    streams.stdout.on('error', onStreamError('stdout'));
    streams.stderr.on('error', onStreamError('stderr'));

    child.on('error', (err) => {
      // spawn itself failed (e.g. ENOENT). No stdio pipes were created.
      process.stderr.write(`[run-with-rotating-logs] failed to spawn child: ${err.message}\n`);
      exitCode = exitCode || 1;
      childExited = true;
      streams.stdout.end();
      streams.stderr.end();
    });

    child.on('exit', (code, signal) => {
      childExited = true;
      if (typeof code === 'number') {
        exitCode = exitCode || code;
      } else if (signal) {
        // Mirror shell convention: 128 + signal number when killed by signal.
        exitCode = exitCode || 128 + (os.constants.signals[signal] ?? 0);
      }
      tryResolve();
    });
  });

  return { child, streams, done };
}

/** launchd bootstrap files only catch pre-init failures; cap them defensively. */
export const BOOTSTRAP_LOG_CAP_BYTES = 5 * 1024 * 1024;
const BOOTSTRAP_LOG_NAMES = ['launchd.out.log', 'launchd.err.log'] as const;
/** Default grace before the supervisor escalates SIGTERM → SIGKILL on the child. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 4000;

/**
 * Truncate the launchd-owned bootstrap logs if they have grown past the cap.
 *
 * These files are written by launchd (not rotated), so a pre-init crash loop
 * could grow them unbounded. Truncating at supervisor startup bounds them: with
 * `O_APPEND` (how launchd opens them) the next write lands at the new EOF, so a
 * truncate-to-zero is safe and leaves no sparse gap.
 *
 * @returns names of the files actually truncated (for logging/testing).
 */
export function capBootstrapLogs(logDir: string, capBytes: number = BOOTSTRAP_LOG_CAP_BYTES): string[] {
  const truncated: string[] = [];
  for (const name of BOOTSTRAP_LOG_NAMES) {
    const file = path.join(logDir, name);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      // File not created yet (launchd hasn't written) — nothing to cap.
      continue;
    }
    if (size > capBytes) {
      // Best-effort housekeeping: if truncation itself fails we leave the file
      // as-is rather than crash the supervisor over a non-critical log cap.
      try {
        fs.truncateSync(file, 0);
        truncated.push(name);
      } catch {
        // intentionally non-fatal
      }
    }
  }
  return truncated;
}

/** Minimal child surface needed for shutdown escalation (eases testing). */
export interface KillableChild {
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Forward `signal` to the child, then escalate to SIGKILL after `graceMs` if the
 * child is still alive.
 *
 * Why: on `launchctl unload`, launchd SIGTERMs the supervisor and SIGKILLs it
 * after a fixed grace. If the child ignores SIGTERM and the supervisor dies
 * first, the child is orphaned (holding the PID lock + Slack socket). The
 * escalation timer ensures the child is force-killed before that happens.
 * `graceMs` must stay below launchd's termination grace.
 *
 * @returns the escalation timer (unref'd so it never keeps the loop alive).
 */
export function forwardSignalWithEscalation(
  child: KillableChild,
  signal: NodeJS.Signals,
  graceMs: number,
  onEscalate?: () => void,
): NodeJS.Timeout {
  if (!child.killed) {
    child.kill(signal);
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      onEscalate?.();
      child.kill('SIGKILL');
    }
  }, graceMs);
  timer.unref();
  return timer;
}

function main(): void {
  // The plist invokes: `node dist/run-with-rotating-logs.js dist/index.js`.
  // Everything after this script's path is the entry (+ its args) to run under
  // the same node binary that launched the wrapper.
  const entry = process.argv.slice(2);
  const args = entry.length > 0 ? entry : ['dist/index.js'];
  const command = process.execPath;
  const logDir = resolveLogDir();
  fs.mkdirSync(logDir, { recursive: true });

  capBootstrapLogs(logDir);

  // Supervisor diagnostics get their OWN small rotating stream so a crash-looping
  // child can't grow an unrotated file (see module docstring).
  const diag = createStream('supervisor.log', {
    path: logDir,
    size: '5M',
    maxFiles: 5,
    maxSize: '50M',
    compress: 'gzip',
    history: 'supervisor.log.history',
  } satisfies Options);
  const logDiag = (line: string) => {
    diag.write(`[${new Date().toISOString()}] [supervisor] ${line}\n`);
  };

  logDiag(`starting "${command} ${args.join(' ')}" — logs → ${logDir}`);

  const handle = runWithRotatingLogs({ command, args, logDir });

  // Forward termination signals to the child so `service.sh stop`
  // (launchctl unload → SIGTERM) shuts the daemon down cleanly, escalating to
  // SIGKILL if it hangs so launchd never orphans the child by killing us first.
  const graceMs = Number(process.env.SOMA_SHUTDOWN_GRACE_MS) || DEFAULT_SHUTDOWN_GRACE_MS;
  let shuttingDown = false;
  const forward = (signal: NodeJS.Signals) => () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logDiag(`received ${signal}; forwarding to child (pid=${handle.child.pid})`);
    forwardSignalWithEscalation(handle.child as KillableChild, signal, graceMs, () =>
      logDiag(`child ignored ${signal} after ${graceMs}ms; sending SIGKILL`),
    );
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, forward(signal));
  }

  handle.done.then((code) => {
    logDiag(`child exited with code ${code}`);
    diag.end(() => process.exit(code));
  });
}

if (require.main === module) {
  main();
}
