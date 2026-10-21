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

import { assertNoSymlinkPath, ensureDirectory } from '@soma/common/atomic-write';
import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStream, type Options, type RotatingFileStream } from 'rotating-file-stream';
import { SECRET_KEYS } from './cli/setup/secrets';
import { PROFILE_ENV_FILE_VAR, PROFILE_SECRETS_FILE_VAR } from './profile-env-vars';

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
function createLogStreams(logDir: string, overrides: Partial<RotationStreamOptions> = {}): LogStreams {
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

// ---------------------------------------------------------------------------
// Profile runtime environment composition
// ---------------------------------------------------------------------------

/**
 * Why the supervisor — and not the LaunchAgent — joins credentials to the
 * runtime.
 *
 * A launchd plist lives in `~/Library/LaunchAgents` as readable XML. Putting
 * `SLACK_BOT_TOKEN` in its `EnvironmentVariables` would publish the token to
 * anything that can read a plist, and to every `launchctl print` of the label.
 * So the plist carries only fixed, non-secret wiring, and the credentials stay
 * in the profile's two 0600 files until this process — already running as the
 * user, already the parent of the daemon — reads them and hands the result to
 * the child through its environment and nowhere else.
 *
 * Three properties the implementation holds, in order of how badly each one
 * bites when it is missing:
 *
 * 1. **No shell, ever.** The bytes of a mutable file are parsed by the strict
 *    grammar below, never `source`d and never handed to `/bin/bash -c`. A
 *    `source`d env file is arbitrary code execution with the daemon's
 *    privileges, triggered by whoever can write one line into it.
 * 2. **Fixed wiring is reasserted last.** `.env` is mutable; if it could set
 *    `SOMA_DATA_DIR` or `SOMA_LOG_DIR`, an edit there would silently redirect
 *    the profile's data or logs — including onto the *other* profile. The
 *    caller's fixed map is applied after both files, so a file can supply
 *    values but can never move the profile.
 * 3. **Values never leave this function except through the child env.** Errors
 *    name keys and roles; they never interpolate a value, a file body, or a
 *    caught exception's message.
 */

/**
 * The two env-var names this supervisor shares with the controller.
 *
 * Imported from a leaf module rather than declared here so the controller's
 * bundled archive does not have to contain the supervisor for two strings —
 * see `src/profile-env-vars.ts` for the failure that motivated the split.
 */

/**
 * Non-secret keys a profile `.env` may set.
 *
 * Exactly the set `somawork setup` generates. An unknown key is a bug or an
 * injection attempt, not something to forward "just in case" — and forwarding
 * one would be the difference between a file that configures the daemon and a
 * file that reconfigures its whole environment.
 */
export const PROFILE_RUNTIME_ENV_KEYS = [
  'AUTH_MODE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'BASE_DIRECTORY',
  'SOMA_BASE_DIRECTORY',
] as const;

/** Fixed profile wiring the LaunchAgent supplies and this module reasserts. */
export const PROFILE_FIXED_ENV_KEYS = [
  'HOME',
  'PATH',
  'SOMA_CONFIG_DIR',
  'SOMA_DATA_DIR',
  'SOMA_BASE_DIRECTORY',
  'SOMA_LOG_DIR',
] as const;

/**
 * Required mode for BOTH profile env files.
 *
 * The credential file is obvious. The runtime file matters because
 * `ANTHROPIC_API_KEY` is on its allowlist: today the materializer writes the
 * `llmux-local` placeholder, but an operator who switches to a real key must
 * not be able to leave it in a world-readable file without a refusal.
 */
const PROFILE_ENV_FILE_MODE = 0o600;

/**
 * Credentials the daemon cannot run without.
 *
 * A present-but-empty `secrets.env` used to compose cleanly and start a daemon
 * with no Slack identity at all, which then fails at connect time as an opaque
 * auth error. Refusing here turns that into one legible refusal at the only
 * moment anybody is looking.
 */
const REQUIRED_SECRET_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const;

/**
 * The profile environment could not be composed, so the daemon must not start.
 *
 * Fails closed on purpose: a daemon started with a half-loaded environment
 * connects to Slack with whatever it did get, which is a harder failure to
 * diagnose than not starting at all.
 */
export class ProfileEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileEnvError';
  }
}

/** Injectable filesystem seam (production default reads the real disk). */
export interface ProfileEnvStat {
  mode: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  uid: number;
}

export interface ProfileEnvFs {
  assertNoSymlinkPath(target: string): void;
  lstat(target: string): ProfileEnvStat | null;
  readFile(target: string): string;
  /** Current uid, or `null` where the platform has no such concept. */
  currentUid(): number | null;
}

const nodeProfileEnvFs: ProfileEnvFs = {
  assertNoSymlinkPath,
  lstat(target) {
    try {
      const st = fs.lstatSync(target);
      return {
        mode: st.mode & 0o777,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        isSymbolicLink: st.isSymbolicLink(),
        uid: st.uid,
      };
    } catch {
      return null;
    }
  },
  readFile: (target) => fs.readFileSync(target, 'utf-8'),
  currentUid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
};

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_KEY_SET: ReadonlySet<string> = new Set<string>(SECRET_KEYS);
const RUNTIME_KEY_SET: ReadonlySet<string> = new Set<string>(PROFILE_RUNTIME_ENV_KEYS);

interface ParseOptions {
  /** Role name used in refusals; never a path. */
  role: string;
  allowed: ReadonlySet<string>;
  /** False for the non-secret file: a credential name there is a hard refusal. */
  allowCredentialKeys: boolean;
}

/**
 * Strict `KEY=VALUE` reader — the same shape {@link SecretStore} writes, minus
 * its tolerance.
 *
 * `SecretStore.read()` warns and skips a malformed or unknown line because it
 * has to keep reading files written by older versions. The service start path
 * has the opposite duty: a line it does not understand is a reason to refuse to
 * start, because "skipped silently" is how a redirected key or a truncated
 * paste becomes a running daemon with the wrong environment. That tolerance is
 * left in place there and deliberately not reused here.
 */
function parseProfileEnvFile(body: string, opts: ParseOptions): Record<string, string> {
  const values: Record<string, string> = {};
  // A separate key set rather than an own-property probe on `values`: the key
  // grammar admits `constructor`/`__proto__`, and an `in`/`hasOwnProperty`
  // check on a plain object literal is exactly where those two get interesting.
  const seenKeys = new Set<string>();
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const at = `line ${i + 1} of the ${opts.role}`;

    // Checked on the RAW line: trimming would swallow a stray CR and let a
    // CRLF-mangled or embedded-control-character file through.
    if (/[\r\0]/.test(raw)) {
      throw new ProfileEnvError(`Refusing to start: ${at} contains a control character.`);
    }

    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new ProfileEnvError(`Refusing to start: ${at} is not a KEY=VALUE assignment.`);
    }

    const key = line.slice(0, separator).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new ProfileEnvError(`Refusing to start: ${at} has a malformed key.`);
    }
    if (seenKeys.has(key)) {
      throw new ProfileEnvError(`Refusing to start: "${key}" is assigned twice in the ${opts.role}.`);
    }
    seenKeys.add(key);
    if (!opts.allowCredentialKeys && SECRET_KEY_SET.has(key)) {
      throw new ProfileEnvError(
        `Refusing to start: "${key}" is a credential and must live in the profile credential file, not the ${opts.role}.`,
      );
    }
    if (!opts.allowed.has(key)) {
      throw new ProfileEnvError(`Refusing to start: "${key}" is not an allowed key in the ${opts.role}.`);
    }
    values[key] = line.slice(separator + 1);
  }

  return values;
}

/**
 * Validate the directory that GOVERNS both env files.
 *
 * Checking each file's own mode is not enough: permission to replace a file
 * lives on its directory, not on the file. A 0777 `<configDir>` lets any local
 * user unlink `secrets.env` and drop in their own 0600 replacement, which then
 * passes every per-file check and is handed to the daemon on the next launchd
 * restart — when the doctor is not in the loop. The allowlist limits but does
 * not close the blast radius: `ANTHROPIC_BASE_URL` is a runtime key that is not
 * fixed wiring, so it is attacker-settable and would redirect model traffic.
 */
function assertProfileConfigDirSafe(configDir: string, fsFacade: ProfileEnvFs): void {
  const role = 'profile config directory';
  try {
    fsFacade.assertNoSymlinkPath(configDir);
  } catch {
    throw new ProfileEnvError(`Refusing to start: the ${role} is reached through a symlink.`);
  }
  const stat = fsFacade.lstat(configDir);
  if (stat === null) throw new ProfileEnvError(`Refusing to start: the ${role} does not exist.`);
  if (stat.isSymbolicLink) throw new ProfileEnvError(`Refusing to start: the ${role} is a symlink.`);
  if (!stat.isDirectory) throw new ProfileEnvError(`Refusing to start: the ${role} is not a directory.`);
  if ((stat.mode & 0o077) !== 0) {
    throw new ProfileEnvError(`Refusing to start: the ${role} is accessible to group or other (expected mode 700).`);
  }
  assertOwnedByUs(stat, role, fsFacade);
}

/** Refuse a file or directory owned by somebody else, where uids exist at all. */
function assertOwnedByUs(stat: ProfileEnvStat, role: string, fsFacade: ProfileEnvFs): void {
  const uid = fsFacade.currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new ProfileEnvError(`Refusing to start: the ${role} is owned by another user.`);
  }
}

function readProfileEnvFile(
  file: string,
  fsFacade: ProfileEnvFs,
  opts: ParseOptions & { requiredMode?: number },
): Record<string, string> {
  // Symlinked component anywhere on the path means the bytes we are about to
  // trust are not the bytes the profile owns.
  try {
    fsFacade.assertNoSymlinkPath(file);
  } catch {
    throw new ProfileEnvError(`Refusing to start: the ${opts.role} is reached through a symlink.`);
  }

  const stat = fsFacade.lstat(file);
  if (stat === null) throw new ProfileEnvError(`Refusing to start: the ${opts.role} does not exist.`);
  if (stat.isSymbolicLink) throw new ProfileEnvError(`Refusing to start: the ${opts.role} is a symlink.`);
  if (!stat.isFile) throw new ProfileEnvError(`Refusing to start: the ${opts.role} is not a regular file.`);
  if (opts.requiredMode !== undefined && stat.mode !== opts.requiredMode) {
    throw new ProfileEnvError(`Refusing to start: the ${opts.role} is not owner-only (expected mode 600).`);
  }
  assertOwnedByUs(stat, opts.role, fsFacade);

  let body: string;
  try {
    body = fsFacade.readFile(file);
  } catch {
    throw new ProfileEnvError(`Refusing to start: the ${opts.role} could not be read.`);
  }

  return parseProfileEnvFile(body, opts);
}

export interface ComposeProfileEnvInput {
  /** Environment the composed map extends (normally the supervisor's own). */
  base: NodeJS.ProcessEnv;
  /** `<configDir>/.env` — non-secret runtime settings. */
  runtimeEnvFile: string;
  /** `<configDir>/secrets.env` — 0600 credential storage. */
  secretsFile: string;
  /** Fixed profile wiring, reasserted last. */
  fixed: Readonly<Record<string, string>>;
  fs?: ProfileEnvFs;
}

/**
 * Build the daemon's environment: base, then `.env`, then `secrets.env`
 * (credentials win on overlap), then the fixed profile wiring.
 *
 * The ordering is the whole point and it is the opposite of the obvious
 * implementation: `dotenv.config()` is first-writer-wins, so loading the two
 * files in receipt order would give `.env` precedence over the credentials.
 */
export function composeProfileEnv(input: ComposeProfileEnvInput): NodeJS.ProcessEnv {
  const fsFacade = input.fs ?? nodeProfileEnvFs;

  // The directory first: it is what governs replacing either file.
  assertProfileConfigDirSafe(path.dirname(input.secretsFile), fsFacade);

  const runtimeValues = readProfileEnvFile(input.runtimeEnvFile, fsFacade, {
    role: 'profile environment file',
    allowed: RUNTIME_KEY_SET,
    allowCredentialKeys: false,
    requiredMode: PROFILE_ENV_FILE_MODE,
  });

  // The credential file may also carry runtime keys; that is what makes the
  // "secrets win on overlap" rule expressible rather than merely asserted.
  const secretValues = readProfileEnvFile(input.secretsFile, fsFacade, {
    role: 'profile credential file',
    allowed: new Set<string>([...RUNTIME_KEY_SET, ...SECRET_KEY_SET]),
    allowCredentialKeys: true,
    requiredMode: PROFILE_ENV_FILE_MODE,
  });

  for (const key of REQUIRED_SECRET_KEYS) {
    const value = secretValues[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ProfileEnvError(`Refusing to start: "${key}" is missing from the profile credential file.`);
    }
  }

  return { ...input.base, ...runtimeValues, ...secretValues, ...input.fixed };
}

/**
 * Decide whether this supervisor run is a profile install and, if so, compose
 * the daemon environment for it.
 *
 * Returns `env` unchanged (same reference) for a source-tree run, so the legacy
 * `scripts/service.sh` path keeps working byte-for-byte while Tasks 10/11
 * validate the replacement.
 */
export function resolveSupervisorChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  fsFacade: ProfileEnvFs = nodeProfileEnvFs,
): NodeJS.ProcessEnv {
  const declaredEnvFile = env[PROFILE_ENV_FILE_VAR]?.trim();
  const declaredSecretsFile = env[PROFILE_SECRETS_FILE_VAR]?.trim();
  if (!declaredEnvFile && !declaredSecretsFile) return env;
  if (!declaredEnvFile || !declaredSecretsFile) {
    throw new ProfileEnvError('Refusing to start: the profile env file wiring is incomplete.');
  }

  const configDir = env.SOMA_CONFIG_DIR?.trim();
  if (!configDir || !path.isAbsolute(configDir)) {
    throw new ProfileEnvError('Refusing to start: the profile config directory is missing or not absolute.');
  }

  // Derived, then compared — the plist declares the paths, but it may only
  // declare the two this profile actually owns. Anything else is a redirect.
  const expectedEnvFile = path.join(configDir, '.env');
  const expectedSecretsFile = path.join(configDir, 'secrets.env');
  if (path.resolve(declaredEnvFile) !== expectedEnvFile) {
    throw new ProfileEnvError(`Refusing to start: ${PROFILE_ENV_FILE_VAR} is not inside the profile config directory.`);
  }
  if (path.resolve(declaredSecretsFile) !== expectedSecretsFile) {
    throw new ProfileEnvError(
      `Refusing to start: ${PROFILE_SECRETS_FILE_VAR} is not inside the profile config directory.`,
    );
  }

  const fixed: Record<string, string> = {};
  for (const key of PROFILE_FIXED_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) fixed[key] = value;
  }

  return composeProfileEnv({
    base: env,
    runtimeEnvFile: expectedEnvFile,
    secretsFile: expectedSecretsFile,
    fixed,
    fs: fsFacade,
  });
}

/** True when this supervisor run is managing an installed profile. */
export function isProfileSupervisorRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[PROFILE_ENV_FILE_VAR]?.trim() ?? '') !== '';
}

/**
 * Create and validate the log root (M11).
 *
 * A profile's log root is ours, so it gets the same owner-only contract the
 * service install applies (`ensureDir(logDir, 0o700)`) — otherwise a state
 * directory removed under a relaunching service comes back at the 0755 default
 * and the two owners silently disagree about the profile's permissions.
 *
 * A source-tree run keeps `mkdirSync` untouched: `<cwd>/logs` in a checkout is
 * the operator's, and chmod'ing it to 0700 is the same class of overreach as
 * tightening `~/Library/LaunchAgents`.
 */
export function prepareProfileLogDir(logDir: string, profileRun: boolean): void {
  if (!profileRun) {
    fs.mkdirSync(logDir, { recursive: true });
    return;
  }
  try {
    ensureDirectory(logDir, 0o700);
  } catch (err) {
    if (err instanceof ProfileEnvError) throw err;
    throw new ProfileEnvError('Refusing to start: the profile log directory is unsafe or could not be created.');
  }
}

/** launchd bootstrap files only catch pre-init failures; cap them defensively. */
export const BOOTSTRAP_LOG_CAP_BYTES = 5 * 1024 * 1024;
const BOOTSTRAP_LOG_NAMES = ['launchd.out.log', 'launchd.err.log'] as const;
/** Default grace before the supervisor escalates SIGTERM → SIGKILL on the child. */
const DEFAULT_SHUTDOWN_GRACE_MS = 4000;

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
  const profileRun = isProfileSupervisorRun();
  try {
    prepareProfileLogDir(logDir, profileRun);
  } catch (err) {
    process.stderr.write(
      `[run-with-rotating-logs] ${err instanceof ProfileEnvError ? err.message : 'log directory unusable'}\n`,
    );
    process.exit(78); // EX_CONFIG
  }

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

  // Credentials join the runtime here, not in the plist (see
  // `composeProfileEnv`). A composition failure is fatal: the alternative is a
  // daemon running with a partial environment, which fails later and less
  // legibly. Only the refusal *message* is logged — it names keys and roles,
  // never values.
  let childEnv: NodeJS.ProcessEnv;
  try {
    childEnv = resolveSupervisorChildEnv();
  } catch (err) {
    const reason = err instanceof ProfileEnvError ? err.message : 'the profile environment could not be composed';
    logDiag(`refusing to start: ${reason}`);
    diag.end(() => process.exit(78)); // EX_CONFIG
    return;
  }

  const handle = runWithRotatingLogs({ command, args, logDir, env: childEnv });

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
