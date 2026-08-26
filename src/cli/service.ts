/**
 * `somawork service` — the profile-isolated LaunchAgent manager (design §5 Step 6).
 *
 * ## What this owns
 *
 * The last mutation `somawork setup` performs: turning a validated
 * {@link ProfileReceipt} into a running daemon, under a label, a plist, a PID
 * file, and a log root that belong to exactly one profile.
 *
 * ## Four properties the module is built around
 *
 * **1. The receipt is the map; nothing is rediscovered.** Every path comes from
 * the receipt or from {@link ProfilePaths}. The manager never looks for a source
 * checkout, never assumes `/opt/soma-work/{dev,main}`, and never `cd`s into the
 * mutable config directory expecting runtime files there. `WorkingDirectory` is
 * the profile's *data* directory — the one place the daemon is allowed to write
 * — and every executable path is absolute under the immutable runtime root.
 *
 * **2. The plist is secret-free and shell-free.** A LaunchAgent is readable
 * XML; a token in its `EnvironmentVariables` is a token published to anything
 * that can read a plist or run `launchctl print`. So `ProgramArguments` is an
 * argv of three absolute paths — no `/bin/bash -c`, no `source`, no command
 * substitution — and the credentials stay in the profile's two 0600 files until
 * the supervisor reads them after launch (`composeProfileEnv` in
 * `src/run-with-rotating-logs.ts`). The plist only names *where* those files
 * are.
 *
 * **3. Registration is never liveness.** `launchctl` will happily report a
 * label it knows about while nothing is running — the classic
 * `LimitLoadToSessionType=Aqua`-loaded-from-SSH failure, which made CI mark
 * dead deploys green for months. Green here requires a live process *and* the
 * daemon's own PID lock file. A registered-but-dead label is `stale`, and
 * `start` boots it out before trying again rather than issuing a `bootstrap`
 * that is a silent no-op against an existing registration.
 *
 * **4. The last mutation is reversible.** `install` snapshots whatever plist
 * was there, and a failing post-start doctor puts it back — a working
 * installation is never destroyed before its replacement is proven. `start`
 * stops the process it started but keeps the plist, because the plist was not
 * the thing that failed.
 *
 * ## What it deliberately does NOT own
 *
 * CLI routing and JSON rendering (Task 10), published docs and the bundle smoke
 * (Task 11), and creating a missing `baseDirectory` — `ensureDirectory` would
 * tighten the permissions of an operator-selected workspace that already
 * exists, so this module only ever *requires* the directories it did not make.
 */

import { assertNoSymlinkPath, atomicWriteFile, ensureDirectory } from '@soma/common/atomic-write';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PROFILE_ENV_FILE_VAR, PROFILE_SECRETS_FILE_VAR } from '../profile-env-vars';
import {
  type DaemonInstance,
  matchesProcessStart,
  PID_LOCK_FILENAME,
  parsePidLockContent,
  parseReadyMarker,
  processStartedAtMs,
  READY_MARKER_FILENAME,
  START_IDENTITY_TOLERANCE_MS,
  sameDaemonInstance,
} from '../service-readiness';
import type { DoctorReport } from './doctor';
import type { ProfileName, ProfilePaths } from './profile';
import type { LaunchctlOperation, SetupHost } from './setup/host';
import type { ProfileReceipt } from './setup/materialize';
import { assertSecretFree } from './setup/state';

// ---------------------------------------------------------------------------
// Fixed contract
// ---------------------------------------------------------------------------

/** Preferred node: the Homebrew keg the formula depends on. */
export const HOMEBREW_NODE_PATH = '/opt/homebrew/opt/node/bin/node';

/** Rotating-log supervisor, relative to the immutable runtime root. */
export const SUPERVISOR_ENTRY_RELATIVE = 'dist/run-with-rotating-logs.js';

/** Daemon entrypoint, relative to the immutable runtime root. */
export const DAEMON_ENTRY_RELATIVE = 'dist/index.js';

/**
 * The daemon's own lock and readiness filenames.
 *
 * Re-exported from `src/service-readiness.ts` rather than restated, so the
 * daemon, the controller, and `src/pid-lock.ts` cannot drift apart on a rename.
 * Both live under the profile *data* directory because that is where the daemon
 * writes them — `acquirePidLock(DATA_DIR)` — and `SOMA_DATA_DIR` now pins
 * `DATA_DIR` to exactly this profile's data root.
 */
export const SERVICE_PID_FILENAME = PID_LOCK_FILENAME;
export const SERVICE_READY_FILENAME = READY_MARKER_FILENAME;

/** Log root, relative to the profile state directory. */
export const SERVICE_LOG_DIRNAME = 'logs';

/** Non-secret PATH the service runs with, after the node directory. */
const SERVICE_PATH_TAIL = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Owner-only plist, and a LaunchAgents directory left exactly as found.
 *
 * `~/Library/LaunchAgents` is Apple's, shared with every other agent on the
 * machine. The atomic writer's defaults would create it 0700 AND tighten an
 * existing 0755 to 0700 — the same overreach `fa76126` removed elsewhere,
 * applied here to a system directory. 0755 is therefore passed explicitly for
 * *creation*, and tightening is switched off for the pre-existing case.
 */
export const PLIST_FILE_MODE = 0o600;
export const PLIST_DIR_MODE = 0o755;
const LOG_DIR_MODE = 0o700;

const DEFAULT_READINESS_TIMEOUT_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STOP_GRACE_MS = 4_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a service operation refused or failed.
 *
 * A discriminant rather than a message match, for the same reason
 * `SecretPromptError` has one: a caller that branches on prose breaks the first
 * time a message is reworded.
 */
export type ServiceErrorCode =
  | 'collision'
  | 'launchctl-failed'
  | 'not-installed'
  | 'not-live'
  | 'doctor-failed'
  | 'node-missing'
  | 'unsafe-state'
  | 'stop-failed';

/**
 * A service operation could not complete.
 *
 * Nothing observed — not a doctor exception, not launchctl's stderr, not a file
 * body — is ever interpolated into `message`. Those are the three most likely
 * places for a credential to surface, and a rollback report that leaks the
 * token it was rolling back is worse than no report.
 */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code: ServiceErrorCode,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** Two profiles would share an artifact. Raised before any mutation. */
export class ServiceCollisionError extends ServiceError {
  constructor(
    message: string,
    /** Safe field names only — never the colliding paths. */
    readonly fields: readonly string[],
  ) {
    super(message, 'collision');
    this.name = 'ServiceCollisionError';
  }
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/** Everything one profile's service is, derived once and never rediscovered. */
export interface ServiceArtifacts {
  profile: ProfileName;
  label: string;
  plistPath: string;
  /** launchd `WorkingDirectory` — the profile data root, never the install tree. */
  workingDirectory: string;
  logDir: string;
  pidFile: string;
  /** The daemon's post-`app.start()` readiness marker. */
  readyFile: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
  runtimeRoot: string;
  baseDirectory: string;
  nodePath: string;
  supervisorEntry: string;
  daemonEntry: string;
  /** `gui/<uid>` — the launchd domain the agent is bootstrapped into. */
  domain: string;
  /** `gui/<uid>/<label>` — the service target for bootout/kickstart/print. */
  target: string;
  /** Fixed, non-secret wiring for the plist and the headless fallback alike. */
  environment: Record<string, string>;
}

export interface ServiceArtifactsInput {
  /** The operator's home directory; `~/Library/LaunchAgents` lives under it. */
  home: string;
  /** Injected, not read from `process`, so tests never depend on the runner's uid. */
  uid: number;
  receipt: ProfileReceipt;
  paths: ProfilePaths;
  nodePath: string;
}

/** Derive one profile's complete service surface from its receipt. */
export function serviceArtifacts(input: ServiceArtifactsInput): ServiceArtifacts {
  const { home, uid, receipt, paths, nodePath } = input;
  const label = paths.serviceLabel;
  const logDir = path.join(receipt.stateDir, SERVICE_LOG_DIRNAME);
  const [runtimeEnvFile, secretsFile] = receipt.serviceEnvFiles;

  const environment: Record<string, string> = {
    HOME: home,
    PATH: [path.dirname(nodePath), ...SERVICE_PATH_TAIL].join(':'),
    SOMA_CONFIG_DIR: receipt.configDir,
    // The first-priority override that pins `@soma/common/env-paths` (and, via
    // `src/index.ts`, the lazy cct/auth stores) to the canonical profile data
    // root instead of `<configDir>/data`.
    SOMA_DATA_DIR: receipt.dataDir,
    SOMA_BASE_DIRECTORY: receipt.baseDirectory,
    SOMA_LOG_DIR: logDir,
    // Paths only, and one variable each: a profile path may contain a colon or
    // a space, so a joined list would make such a machine un-startable. The
    // supervisor reads these two files after launch; the plist never carries
    // what is inside them.
    [PROFILE_ENV_FILE_VAR]: runtimeEnvFile,
    [PROFILE_SECRETS_FILE_VAR]: secretsFile,
  };

  return {
    profile: receipt.profile,
    label,
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    workingDirectory: receipt.dataDir,
    logDir,
    pidFile: path.join(receipt.dataDir, SERVICE_PID_FILENAME),
    readyFile: path.join(receipt.dataDir, SERVICE_READY_FILENAME),
    configDir: receipt.configDir,
    dataDir: receipt.dataDir,
    stateDir: receipt.stateDir,
    runtimeRoot: receipt.runtimeRoot,
    baseDirectory: receipt.baseDirectory,
    nodePath,
    supervisorEntry: path.join(receipt.runtimeRoot, SUPERVISOR_ENTRY_RELATIVE),
    daemonEntry: path.join(receipt.runtimeRoot, DAEMON_ENTRY_RELATIVE),
    domain: `gui/${uid}`,
    target: `gui/${uid}/${label}`,
    environment,
  };
}

// ---------------------------------------------------------------------------
// Plist rendering
// ---------------------------------------------------------------------------

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render the LaunchAgent for `artifacts`.
 *
 * Deliberately not a port of the shell heredoc in `scripts/service.sh`: that
 * one runs `/bin/bash -c "export PATH=…; cd …; exec node …"`, which makes the
 * plist a shell program whose arguments are string-interpolated. Here
 * `ProgramArguments` is a literal argv, so there is nothing to quote and
 * nothing to inject, and `WorkingDirectory` replaces the `cd`.
 */
export function renderLaunchAgentPlist(artifacts: ServiceArtifacts): string {
  const argv = [artifacts.nodePath, artifacts.supervisorEntry, artifacts.daemonEntry];
  const programArguments = argv.map((arg) => `        <string>${xmlEscape(arg)}</string>`).join('\n');
  const environment = Object.entries(artifacts.environment)
    .map(([key, value]) => `        <key>${xmlEscape(key)}</key>\n        <string>${xmlEscape(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(artifacts.label)}</string>

    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>

    <key>WorkingDirectory</key>
    <string>${xmlEscape(artifacts.workingDirectory)}</string>

    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${xmlEscape(path.join(artifacts.logDir, 'launchd.out.log'))}</string>

    <key>StandardErrorPath</key>
    <string>${xmlEscape(path.join(artifacts.logDir, 'launchd.err.log'))}</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Collision gate
// ---------------------------------------------------------------------------

/** Path fields that must not be equal to, contain, or live inside a peer's. */
const COLLIDING_PATH_FIELDS = [
  'plistPath',
  'pidFile',
  'readyFile',
  'logDir',
  'configDir',
  'dataDir',
  'stateDir',
  'runtimeRoot',
] as const;

/** True when `a` is `b`, or one lives inside the other, after normalisation. */
function pathsOverlap(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (left === right) return true;
  const inside = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  return inside(left, right) || inside(right, left);
}

/**
 * Refuse to install or start a profile whose service artifacts touch another's.
 *
 * Ancestor/descendant overlap counts, not just equality: a data root nested
 * inside another profile's data root means one profile's uninstall deletes the
 * other's state, and one profile's PID lock is visible in the other's tree.
 *
 * `baseDirectory` is deliberately absent from the comparison — preview and
 * production sharing one workspace is the intended arrangement (design §4.2
 * isolates config/data/state/logs/labels, not the operator's work tree).
 *
 * The error names fields and profiles only. The colliding *paths* would be the
 * natural thing to print and are exactly what must not appear: a service error
 * is printed, logged, and pasted into issues.
 */
export function assertNoProfileCollision(target: ServiceArtifacts, peers: readonly ServiceArtifacts[]): void {
  for (const peer of peers) {
    if (peer.profile === target.profile) continue;

    const fields: string[] = [];
    if (peer.label === target.label) fields.push('label');
    for (const field of COLLIDING_PATH_FIELDS) {
      if (pathsOverlap(target[field], peer[field])) fields.push(field);
    }

    if (fields.length > 0) {
      throw new ServiceCollisionError(
        `Refusing to manage the "${target.profile}" service: it shares ${fields.join(', ')} with the "${peer.profile}" profile. ` +
          'Preview and production must not share any service artifact.',
        fields,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** The narrow filesystem surface the manager needs. Injectable for tests. */
export interface ServiceFileSystem {
  /** `lstat`-based presence: a dangling symlink counts as existing. */
  exists(target: string): boolean;
  /** `stat`-based presence: a dangling symlink does NOT count. */
  statExists(target: string): boolean;
  /** Followed: true only for a real directory (or a link to one). */
  isDirectory(target: string): boolean;
  /** Followed: true only for a regular file this user may execute. */
  isExecutableFile(target: string): boolean;
  /** `lstat`-based: a symlink is reported, never followed. */
  isSymlink(target: string): boolean;
  /**
   * `lstat` projection used to gate a directory this tool must not repair.
   * Mode bits, owner uid, and symlink-ness in one call.
   */
  dirStat(target: string): { mode: number; uid: number; isDirectory: boolean; isSymbolicLink: boolean } | null;
  /** Current uid, or `null` where the platform has no such concept. */
  currentUid(): number | null;
  readFile(target: string): string | null;
  writeFileAtomic(target: string, body: string, mode: number, dirMode: number): void;
  remove(target: string): void;
  ensureDir(target: string, mode: number): void;
}

/**
 * Process liveness/signalling, injected so tests never signal a real PID.
 *
 * `startedAt` and `bootTimeMs` exist for one reason: a PID number is not a
 * process. A lock left by a `SIGKILL` or a power cut names a number the OS is
 * free to hand to something else, and `isAlive` is then true of the wrong
 * process — which `stop` would SIGKILL.
 */
export interface ProcessProbe {
  isAlive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
  /** Process-start identity for a live pid, or `null` when unobtainable. */
  startedAt(pid: number): number | null;
  /** Epoch ms of the machine's last boot. Nothing older can still be running. */
  bootTimeMs(): number;
}

export type ServiceRunState = 'running-launchd' | 'running-headless' | 'stale' | 'blocked' | 'stopped';
export type ServiceManagerKind = 'launchd' | 'headless' | 'none';

/**
 * A non-secret structured receipt of what the service is doing.
 *
 * Every field is a profile identifier or a path this module derived; nothing
 * read from a credential file, a Slack response, or launchctl's stderr reaches
 * it. Task 10 renders this as `--json`.
 */
export interface ServiceStatus {
  profile: ProfileName;
  label: string;
  state: ServiceRunState;
  manager: ServiceManagerKind;
  /** The DAEMON's pid (from its own lock file), or `null`. */
  pid: number | null;
  /**
   * The pid launchd reports for the supervisor, or `null`.
   *
   * Distinct from {@link ServiceStatus.pid}: the supervisor is the process
   * launchd manages, the daemon is the child that holds the lock and talks to
   * Slack. A `KeepAlive` restart changes this one without changing the daemon
   * instance, which is also what makes it the field that proves this status was
   * read AFTER the post-start check rather than before it.
   */
  supervisorPid: number | null;
  /** launchd knows the label. On its own this is never green. */
  registered: boolean;
  /** The daemon published readiness for the instance the lock names. */
  ready: boolean;
  plistInstalled: boolean;
  plistPath: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
  runtimeRoot: string;
  logDir: string;
  pidFile: string;
  readyFile: string;
}

export interface ServiceManagerDeps {
  artifacts: ServiceArtifacts;
  host: SetupHost;
  fs: ServiceFileSystem;
  processes: ProcessProbe;
  /**
   * Post-start gate. Injected because it is the one check that must run against
   * the *live* service, and because a service test must be able to make it fail
   * without a Slack workspace.
   */
  runDoctor: () => Promise<DoctorReport>;
  /** Other known profiles, for the collision gate. */
  peers?: readonly ServiceArtifacts[];
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
  stopGraceMs?: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** launchd reports `pid = N` inside `launchctl print`'s dictionary output. */
const LAUNCHCTL_PID_PATTERN = /^\s*pid\s*=\s*(\d+)\s*$/m;

interface LiveProbe {
  registered: boolean;
  launchdPid: number | null;
  /** The instance the lock names, only when that instance is genuinely alive. */
  daemon: DaemonInstance | null;
  /** The daemon published readiness for exactly that instance. */
  ready: boolean;
  /**
   * The lock names a PID that is ALIVE but whose identity does not match it.
   *
   * Neither running nor stopped: `acquirePidLock` will refuse for every daemon
   * we start, so nothing can come up until a human resolves it — and we may
   * neither signal nor delete, because the live process might be a soma-work
   * daemon. Reporting this as `stopped` sent operators looking for a service
   * that was never going to start.
   */
  blocked: boolean;
}

/** Which path actually produced the running daemon. */
type ActivationManager = 'launchd' | 'headless';

export class ServiceManager {
  private readonly artifacts: ServiceArtifacts;
  private readonly host: SetupHost;
  private readonly fs: ServiceFileSystem;
  private readonly processes: ProcessProbe;
  private readonly runDoctor: () => Promise<DoctorReport>;
  private readonly peers: readonly ServiceArtifacts[];
  private readonly readinessTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly stopGraceMs: number;

  constructor(deps: ServiceManagerDeps) {
    this.artifacts = deps.artifacts;
    this.host = deps.host;
    this.fs = deps.fs;
    this.processes = deps.processes;
    this.runDoctor = deps.runDoctor;
    this.peers = deps.peers ?? [];
    this.readinessTimeoutMs = deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  // -- probes ---------------------------------------------------------------

  /**
   * The instance the lock file names, or `null`.
   *
   * Refuses, rather than guesses, in every case where the file cannot be tied
   * to a process: a symlinked lock (whoever made the link chose the PID), an
   * unparseable body, and a legacy bare PID with no instance identity.
   */
  private readLockInstance(): DaemonInstance | null {
    const { pidFile } = this.artifacts;

    if (this.fs.isSymlink(pidFile)) {
      throw new ServiceError(
        "Refusing to act on the profile lock file: it is a symlink, so the process it names is not this profile's.",
        'unsafe-state',
      );
    }

    return parsePidLockContent(this.fs.readFile(pidFile));
  }

  /**
   * Is `instance` the process that is actually running under that PID?
   *
   * Two independent discriminators, because macOS offers no shell-free way to
   * read another process's start time and a seam that can only answer "unknown"
   * would be no guard at all:
   *
   * - the probe's own start identity when it has one, compared with tolerance
   *   because such sources report seconds, not milliseconds;
   * - the machine's boot time, which no running process can predate. This is
   *   the common case in practice: a stale lock survives a power cut, the
   *   machine reboots, PIDs restart low, and reuse becomes likely.
   */
  private isLiveInstance(instance: DaemonInstance): boolean {
    if (!this.processes.isAlive(instance.pid)) return false;
    if (instance.startedAtMs < this.processes.bootTimeMs() - START_IDENTITY_TOLERANCE_MS) return false;
    return matchesProcessStart(instance.startedAtMs, this.processes.startedAt(instance.pid));
  }

  /** The readiness marker, refusing a symlinked one exactly like the lock. */
  private readReadyInstance(): DaemonInstance | null {
    const { readyFile } = this.artifacts;
    if (this.fs.isSymlink(readyFile)) return null;
    return parseReadyMarker(this.fs.readFile(readyFile));
  }

  private async probe(): Promise<LiveProbe> {
    const registration = await this.probeRegistration();
    const recorded = this.readLockInstance();
    const daemon = recorded !== null && this.isLiveInstance(recorded) ? recorded : null;
    // Readiness is only readiness for THIS instance: a marker left by a
    // previous run under a recycled PID is exactly the lie this closes.
    const ready = daemon !== null && sameDaemonInstance(daemon, this.readReadyInstance());
    const blocked = recorded !== null && daemon === null && this.processes.isAlive(recorded.pid);
    return { ...registration, daemon, ready, blocked };
  }

  /** launchd's view alone — no lock file read, so it cannot throw on a symlink. */
  private async probeRegistration(): Promise<{ registered: boolean; launchdPid: number | null }> {
    const printed = await this.host.launchctl({ kind: 'print', target: this.artifacts.target });
    const registered = printed.ok;

    let launchdPid: number | null = null;
    if (registered) {
      // Machine parsing, so the raw bytes; only the parsed integer escapes.
      const match = LAUNCHCTL_PID_PATTERN.exec(printed.unsafeRawStdout());
      if (match !== null) {
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isInteger(parsed) && parsed > 1 && this.processes.isAlive(parsed)) launchdPid = parsed;
      }
    }
    return { registered, launchdPid };
  }

  /** launchd's view, normalised: a call that could not be spawned is `rejected`. */
  private async attemptRegistrationProbe(): Promise<{ registered: boolean; rejected: boolean }> {
    try {
      const printed = await this.host.launchctl({ kind: 'print', target: this.artifacts.target });
      return { registered: printed.ok, rejected: false };
    } catch {
      return { registered: false, rejected: true };
    }
  }

  /**
   * Refuse to act when the lock names a live process we cannot attribute.
   *
   * Every daemon we could start would lose `acquirePidLock` to that PID and
   * exit, so activating would burn the whole readiness budget and then report a
   * generic "did not come up" while the actionable cause sat three frames down.
   * The diagnosis names no PID, no start time, and no path: it is printed,
   * logged, and pasted into issues.
   */
  private assertNotBlocked(probe: LiveProbe): void {
    if (!probe.blocked) return;
    throw new ServiceError(
      `The "${this.artifacts.profile}" lock names a live process whose identity does not match it, so no daemon can acquire it. Resolve the lock by hand before installing or starting the service.`,
      'unsafe-state',
    );
  }

  /**
   * Gate on the profile data directory without repairing it.
   *
   * `acquirePidLock` creates a missing data root with a bare recursive
   * `mkdirSync` — 0755 under the default umask — and readiness publication
   * deliberately no longer tightens it. That directory holds `cct-store.json`,
   * so an operator who deletes it gets it back world-readable from the daemon
   * itself. Creation belongs to the materializer and reporting to the doctor;
   * the service's job is to refuse to activate over it, before it mutates
   * anything.
   */
  private assertProfileDataDirSafe(): void {
    const { dataDir, profile } = this.artifacts;
    const refuse = (why: string): never => {
      throw new ServiceError(
        `The data directory for the "${profile}" profile ${why}; run "somawork setup" to repair it.`,
        'unsafe-state',
      );
    };

    const stat = this.fs.dirStat(dataDir);
    if (stat === null) refuse('does not exist');
    if ((stat as NonNullable<typeof stat>).isSymbolicLink) refuse('is a symlink');
    if (!(stat as NonNullable<typeof stat>).isDirectory) refuse('is not a directory');
    if (((stat as NonNullable<typeof stat>).mode & 0o077) !== 0) {
      refuse('is accessible to group or other (expected mode 700)');
    }
    const uid = this.fs.currentUid();
    if (uid !== null && (stat as NonNullable<typeof stat>).uid !== uid) refuse('is owned by another user');
  }

  private toStatus(probe: LiveProbe, activationManager?: ActivationManager): ServiceStatus {
    const a = this.artifacts;
    const up = probe.daemon !== null && probe.ready;

    let state: ServiceRunState;
    let manager: ServiceManagerKind;
    if (up && activationManager !== undefined) {
      // The path that actually produced this daemon, not whatever supervisor
      // pid happens to be lying around: `RunAtLoad` can leave a live launchd
      // supervisor after a failed `kickstart`, while the daemon holding the
      // lock is the one the detached fallback spawned.
      state = activationManager === 'launchd' ? 'running-launchd' : 'running-headless';
      manager = activationManager;
    } else if (up && probe.registered && probe.launchdPid !== null) {
      state = 'running-launchd';
      manager = 'launchd';
    } else if (up) {
      // A ready daemon that launchd is not (successfully) managing: the
      // headless direct-spawn fallback.
      state = 'running-headless';
      manager = 'headless';
    } else if (probe.blocked) {
      state = 'blocked';
      manager = probe.registered ? 'launchd' : 'none';
    } else if (probe.registered) {
      state = 'stale';
      manager = 'launchd';
    } else if (probe.daemon !== null) {
      // Alive but never published readiness — mid-boot, or crashlooping before
      // `app.start()`. Not stopped (stop still has work to do) and not running.
      state = 'stale';
      manager = 'headless';
    } else {
      state = 'stopped';
      manager = 'none';
    }

    const status: ServiceStatus = {
      profile: a.profile,
      label: a.label,
      state,
      manager,
      pid: probe.daemon?.pid ?? null,
      supervisorPid: probe.launchdPid,
      registered: probe.registered,
      ready: probe.ready,
      plistInstalled: this.fs.exists(a.plistPath),
      plistPath: a.plistPath,
      configDir: a.configDir,
      dataDir: a.dataDir,
      stateDir: a.stateDir,
      runtimeRoot: a.runtimeRoot,
      logDir: a.logDir,
      pidFile: a.pidFile,
      readyFile: a.readyFile,
    };

    // Defence in depth: the shape is designed to clear this gate, and a future
    // field that does not must fail here rather than in a caller's JSON output.
    assertSecretFree(status, 'serviceStatus');
    return status;
  }

  // -- lifecycle primitives -------------------------------------------------

  /**
   * Run one launchctl operation and treat its RESULT as the answer.
   *
   * `host.launchctl` is `command(launchctlCommandSpec(op))`, which resolves with
   * a non-zero `code` rather than throwing. Discarding that result is how the
   * C1 bootout became a no-op nobody noticed: the plist was replaced on disk,
   * launchd kept running the cached definition, and the readiness gate was
   * satisfied by the OLD daemon's lock and marker — which do not change across
   * a `brew upgrade`. Nothing downstream can catch that, so it has to be caught
   * here.
   *
   * The refusal message names the operation and nothing else: launchctl's
   * stderr can carry paths, and a service error is printed, logged, and pasted
   * into issues.
   */
  private async runLaunchctl(op: LaunchctlOperation, what: string): Promise<void> {
    const outcome = await this.attemptLaunchctl(op);
    if (outcome.ok) return;
    throw new ServiceError(
      `launchctl could not ${what} the "${this.artifacts.profile}" service; the service was left as it was.`,
      'launchctl-failed',
    );
  }

  /**
   * Run one launchctl operation and normalise BOTH failure shapes.
   *
   * `host.launchctl` is `command(...)`, which resolves non-ok when launchctl
   * ran and refused, and REJECTS when the child could not be started at all
   * (EAGAIN, EMFILE, ENOMEM). The two are easy to conflate and the second is
   * the dangerous one: it arrives under exactly the conditions that make a
   * doctor fail, and an unguarded `await` on it inside a cleanup path replaces
   * the reported diagnosis and skips whatever came after. Nothing above this
   * line ever sees a raw error — launchctl's message can carry paths.
   */
  private async attemptLaunchctl(op: LaunchctlOperation): Promise<{ ok: boolean; rejected: boolean }> {
    try {
      const result = await this.host.launchctl(op);
      return { ok: result.ok, rejected: false };
    } catch {
      return { ok: false, rejected: true };
    }
  }

  /**
   * Unload the label, and believe the POSTCONDITION rather than the exit code.
   *
   * `launchctl bootout` routinely returns non-zero while the unload proceeds
   * (`Boot-out failed: 36: Operation now in progress`). Refusing on the code
   * alone leaves the operator's service down under a message asserting it was
   * "left as it was". So a non-ok bootout is followed by one re-probe: still
   * registered means the unload really did not happen and activation must not
   * continue; no longer registered means the postcondition is satisfied.
   *
   * A REJECTED call is different: launchctl never ran, so it establishes
   * nothing — and neither can a re-probe that also cannot be spawned.
   */
  private async bootout(): Promise<void> {
    const outcome = await this.attemptLaunchctl({ kind: 'bootout', target: this.artifacts.target });
    if (outcome.ok) return;

    if (!outcome.rejected) {
      const after = await this.attemptRegistrationProbe();
      if (!after.rejected && !after.registered) return; // unloaded despite the exit code
    }

    throw new ServiceError(
      `The unload of the "${this.artifacts.profile}" service could not be confirmed; refusing to activate over a definition that may still be loaded.`,
      'launchctl-failed',
    );
  }

  /** Best-effort unload for cleanup paths. Never throws, whatever launchctl does. */
  private async bootoutBestEffort(): Promise<boolean> {
    const outcome = await this.attemptLaunchctl({ kind: 'bootout', target: this.artifacts.target });
    return outcome.ok;
  }

  /**
   * Register and force a spawn.
   *
   * `bootstrap` alone only REGISTERS the agent: when the caller's session is not
   * the GUI/Aqua seat, `RunAtLoad` is deferred as speculative and the process
   * never starts. `kickstart -k` against the GUI target forces it.
   *
   * All three results are checked. The previous "a non-zero bootstrap against
   * an already-registered label is a benign no-op" tolerance is gone with the
   * reason for it: every caller now boots out first, so a bootstrap that fails
   * means the definition on disk did not become the loaded one — which is the
   * only thing this method exists to accomplish.
   */
  private async bootstrapAndKick(): Promise<boolean> {
    const { domain, plistPath, target } = this.artifacts;

    // Loading is not optional. If the plist did not become the loaded
    // definition, nothing later can make it so, and the headless fallback would
    // paper over a real configuration error (a malformed plist, a domain the
    // user cannot bootstrap into) by starting the daemon a different way.
    await this.runLaunchctl({ kind: 'bootstrap', domain, plistPath }, 'load');
    await this.runLaunchctl({ kind: 'enable', target }, 'enable');

    // Kickstart is the one that legitimately fails on a healthy machine: on a
    // Mac sitting at the login window there is no GUI seat to spawn into, and
    // `launchctl kickstart` returns non-zero. That is exactly the condition the
    // detached fallback exists for (task context: "If launchd cannot produce a
    // live PID, use the detached supervisor fallback"). So a failed kickstart
    // does not poll launchd for health — it reports that launchd did not
    // activate, and the caller falls through to the fallback, whose success is
    // then proven by the same ownership-checked readiness gate.
    const kicked = await this.attemptLaunchctl({ kind: 'kickstart', target, restart: true });
    return kicked.ok;
  }

  /** Poll until `predicate` holds, bounded by the readiness timeout. */
  private async pollFor(predicate: () => Promise<boolean>): Promise<boolean> {
    const attempts = Math.max(1, Math.ceil(this.readinessTimeoutMs / this.pollIntervalMs));
    for (let i = 0; i < attempts; i++) {
      if (await predicate()) return true;
      await this.host.sleep(this.pollIntervalMs);
    }
    return predicate();
  }

  /**
   * Bring the service up: launchd first, detached supervisor second.
   *
   * The fallback exists for a Mac sitting at the login window, where launchd
   * has no GUI seat to schedule the agent into and the launchd path fails
   * permanently rather than transiently.
   *
   * Readiness is the DAEMON's own marker for the instance its lock names —
   * never the lock alone (acquired at boot-second one, before the token
   * manager, preflight, and the socket) and never the detached parent's pid
   * (alive long before the daemon has connected to anything). Waiting on the
   * lock is what let a green receipt coexist with a ten-second crashloop.
   */
  private async bringUp(incumbent: DaemonInstance | null): Promise<{ probe: LiveProbe; manager: ActivationManager }> {
    const launchdActivated = await this.bootstrapAndKick();

    // Ownership is instance identity, not wall clock. The property that matters
    // is "this is not the daemon that was already there": an incumbent holding
    // the profile's PID lock makes the job we just started exit on contention,
    // and accepting it would earn a green receipt for a definition that never
    // ran. Comparing identities instead of timestamps also removes the NTP
    // hazard — a backwards clock step used to make a candidate we DID start
    // look like an incumbent, failing the install and orphaning the daemon.
    const ours = (p: LiveProbe) => p.daemon !== null && p.ready && !sameDaemonInstance(p.daemon, incumbent);
    const launchdUp = (p: LiveProbe) => p.launchdPid !== null && ours(p);

    let probe = await this.probe();
    if (launchdActivated) {
      if (!launchdUp(probe)) {
        await this.pollFor(async () => {
          probe = await this.probe();
          return launchdUp(probe);
        });
      }
      if (launchdUp(probe)) return { probe, manager: 'launchd' };
    }

    const detached = this.spawnDetachedSupervisor();

    await this.pollFor(async () => {
      // An interpreter that cannot be exec'd fails AFTER spawn() returns. Stop
      // waiting the moment we know the child is gone: the alternative is
      // burning the whole readiness budget on a process that never existed.
      if (detached.gone()) return true;
      probe = await this.probe();
      return ours(probe);
    });
    if (ours(probe)) return { probe, manager: 'headless' };

    throw new ServiceError(
      `The "${this.artifacts.profile}" service did not come up: no live, connected daemon started by this activation appeared under launchd or the headless fallback.`,
      'not-live',
    );
  }

  /**
   * Start the supervisor detached and keep a handle on whether it died.
   *
   * The handle is deliberately not discarded. `RealHost` reports a spawn that
   * fails after `spawn()` returns — the ENOENT of a dangling node symlink —
   * by rejecting `exited`; the host observes that rejection so it cannot crash
   * the CLI, and this records it so `bringUp` fails through `ServiceError` and
   * the rollback actually runs.
   */
  private spawnDetachedSupervisor(): { gone: () => boolean } {
    const a = this.artifacts;
    let gone = false;
    // Fire-and-forget through the host boundary — never `child_process` here,
    // and never a shell. `inheritEnv: false` means the daemon gets exactly the
    // fixed profile wiring, not whatever the operator's shell was carrying.
    const handle = this.host.spawn({
      command: a.nodePath,
      args: [a.supervisorEntry, a.daemonEntry],
      env: a.environment,
      inheritEnv: false,
      cwd: a.workingDirectory,
      detached: true,
    });
    handle.exited.then(
      () => {
        gone = true;
      },
      () => {
        gone = true;
      },
    );
    return { gone: () => gone };
  }

  /**
   * Terminate the daemon named by the profile's own lock file.
   *
   * SIGTERM, a bounded grace period, then SIGKILL — and nothing at all when the
   * lock cannot be tied to a live process. "Nothing at all" covers more cases
   * than it looks: missing, malformed, legacy-format, PID 0 or 1, a PID whose
   * process started at a different time than the lock recorded, and a lock
   * instance older than the machine's last boot. Every one of those is a stale
   * file naming a number that now belongs to somebody else's process.
   */
  private async terminateDaemon(options: { incumbent?: DaemonInstance | null } = {}): Promise<void> {
    const recorded = this.readLockInstance();
    if (recorded === null) return;

    if (!this.isLiveInstance(recorded)) {
      if (this.processes.isAlive(recorded.pid)) {
        // The PID is alive but its identity does not match the lock. We may not
        // signal it — it could be any process the OS handed the recycled number
        // to — and we may not DELETE the lock either: we cannot prove the live
        // process is not a soma-work daemon, and removing its lock re-opens the
        // duplicate-Socket-Mode window `pid-lock` exists to close (issue #152).
        throw new ServiceError(
          `The "${this.artifacts.profile}" lock names a process whose identity does not match it; refusing to signal or clear it. Resolve it by hand.`,
          'unsafe-state',
        );
      }
      // The named process is gone: the file is unambiguously stale.
      this.clearDaemonFiles();
      return;
    }

    if (options.incumbent !== undefined && sameDaemonInstance(recorded, options.incumbent ?? null)) {
      // The exact instance that was already there when we looked. Rolling back
      // our own failure must not take down somebody else's working daemon —
      // and identity, unlike a timestamp, cannot be confused by a clock step.
      return;
    }

    const pid = recorded.pid;
    this.processes.signal(pid, 'SIGTERM');
    const attempts = Math.max(1, Math.ceil(this.stopGraceMs / this.pollIntervalMs));
    for (let i = 0; i < attempts && this.processes.isAlive(pid); i++) {
      await this.host.sleep(this.pollIntervalMs);
    }

    if (this.processes.isAlive(pid)) {
      this.processes.signal(pid, 'SIGKILL');
      await this.host.sleep(this.pollIntervalMs);
    }

    if (this.processes.isAlive(pid)) {
      throw new ServiceError(
        `The "${this.artifacts.profile}" daemon ignored SIGTERM and SIGKILL; stop it manually before retrying.`,
        'stop-failed',
      );
    }
    this.clearDaemonFiles();
  }

  /** Drop the lock and the readiness marker together; a lone marker is a lie. */
  private clearDaemonFiles(): void {
    this.fs.remove(this.artifacts.pidFile);
    this.fs.remove(this.artifacts.readyFile);
  }

  /** Run the injected doctor; any failure mode is one failure mode. */
  private async gateOnDoctor(): Promise<void> {
    let report: DoctorReport;
    try {
      report = await this.runDoctor();
    } catch {
      // The exception is not inspected: a probe's message is the most likely
      // place for a credential to appear.
      throw new ServiceError(
        `The post-start check for the "${this.artifacts.profile}" service could not complete.`,
        'doctor-failed',
      );
    }
    if (!report.ok) {
      const failed = report.checks
        .filter((c) => c.status === 'fail')
        .map((c) => c.id)
        .join(', ');
      throw new ServiceError(
        `The "${this.artifacts.profile}" service started but failed its post-start check${failed ? ` (${failed})` : ''}.`,
        'doctor-failed',
      );
    }
  }

  // -- public commands ------------------------------------------------------

  /**
   * Install the LaunchAgent and prove the service is live, connected, and healthy.
   *
   * Ordering is load-bearing, and the least obvious step is the bootout:
   * `bootstrap` is what LOADS a plist into the launchd domain, and the loaded
   * copy lives there until `bootout`. `kickstart -k` restarts *that* copy — it
   * does not re-read the file. So an install over a live registration that
   * skips the bootout writes a new plist, restarts the OLD job, passes a doctor
   * that probes Slack rather than the daemon's argv, and reports green for a
   * configuration that is not running. After `brew upgrade` that old job points
   * into a Cellar path Homebrew has already deleted.
   */
  async install(): Promise<ServiceStatus> {
    const a = this.artifacts;
    assertNoProfileCollision(a, this.peers);

    // Followed, not `lstat`: a dangling symlink is not a workspace. Creating a
    // missing one is Task 10's job — `ensureDirectory` on an existing
    // operator-chosen directory would tighten its permissions — so this only
    // ever requires it.
    if (!this.fs.isDirectory(a.baseDirectory)) {
      throw new ServiceError(
        `The workspace directory for the "${a.profile}" profile does not exist; run "somawork setup" before installing the service.`,
        'not-installed',
      );
    }
    this.assertProfileDataDirSafe();

    // Snapshot everything the rollback has to be able to put back: the bytes,
    // whether the job those bytes describe was actually RUNNING, and which
    // daemon instance (if any) was already there.
    const previousPlist = this.fs.readFile(a.plistPath);
    const priorRegistration = await this.probeRegistration();
    const priorWasLive = priorRegistration.registered && priorRegistration.launchdPid !== null;
    const before = await this.probe();
    this.assertNotBlocked(before);
    const incumbent = before.daemon;

    this.fs.ensureDir(a.logDir, LOG_DIR_MODE);
    this.fs.writeFileAtomic(a.plistPath, renderLaunchAgentPlist(a), PLIST_FILE_MODE, PLIST_DIR_MODE);

    // Unload the cached definition BEFORE activating, and only continue if the
    // unload actually happened. A bootout that failed leaves the old job loaded
    // and running; bootstrapping over it is a no-op, and the old daemon's lock
    // and marker would then satisfy the readiness gate.
    if (priorRegistration.registered) {
      try {
        await this.bootout();
      } catch (err) {
        // Nothing was activated, so there is nothing to tear down: put the
        // bytes back and report the unload failure unchanged.
        this.restorePlist(previousPlist);
        throw err;
      }
    }

    try {
      const activated = await this.bringUp(incumbent);
      return await this.gateAndConfirm({ incumbent, manager: activated.manager });
    } catch (err) {
      await this.rollbackInstall(previousPlist, priorWasLive, incumbent);
      throw err;
    }
  }

  /** Put the previous plist bytes back, or remove ours when there were none. */
  private restorePlist(previousPlist: string | null): void {
    try {
      if (previousPlist === null) this.fs.remove(this.artifacts.plistPath);
      else this.fs.writeFileAtomic(this.artifacts.plistPath, previousPlist, PLIST_FILE_MODE, PLIST_DIR_MODE);
    } catch {
      /* the original failure is the one worth reporting */
    }
  }

  /**
   * Undo a failed install, in an order chosen so that no cleanup step can
   * prevent a later one.
   *
   * 1. terminate only a daemon THIS activation started (identity, not clock);
   * 2. **restore the plist bytes** — before any further awaited launchctl call,
   *    because a launchctl that cannot be spawned (EAGAIN under the same load
   *    that is failing the doctor) would otherwise skip the restore and leave
   *    the plist on disk describing a definition launchd is not running. That
   *    is C1's harm shape, reachable through the cleanup path instead of the
   *    bug it fixed, and one `start` away from a green receipt;
   * 3. best-effort bootout of the candidate registration;
   * 4. re-activate the previous definition when one was live — a file without a
   *    loaded job is a stopped service, not a rollback.
   *
   * Every step swallows its own failure. The error being reported is the
   * original one; whether re-activation succeeded is returned for the caller's
   * information and never turned into success.
   */
  private async rollbackInstall(
    previousPlist: string | null,
    priorWasLive: boolean,
    incumbent: DaemonInstance | null,
  ): Promise<{ restored: boolean }> {
    try {
      await this.terminateDaemon({ incumbent });
    } catch {
      /* the original failure is the one worth reporting */
    }

    this.restorePlist(previousPlist);
    await this.bootoutBestEffort();

    if (previousPlist === null || !priorWasLive) return { restored: false };
    try {
      await this.bootstrapAndKick();
      return { restored: true };
    } catch {
      // The operator's old service could not be brought back. That is worse
      // news than the original failure, but it is not a different *failure* —
      // the install still failed, and that is what the caller reports.
      return { restored: false };
    }
  }

  /**
   * Start an already-installed service.
   *
   * A registered-but-dead label is STALE and is booted out first: `bootstrap`
   * against an existing registration is a no-op, so without this the retry
   * silently does nothing and the operator sees the same dead label again.
   *
   * An already-running service — under launchd OR the headless fallback — still
   * goes through the doctor and the post-doctor re-probe (M6), so "start
   * returned green" means one thing: the service is up and healthy right now.
   * But it is confirmed, not restarted, and a failure confirming it tears down
   * NOTHING. `somawork service start` is the natural idempotent "make sure it
   * is up" command; running it during a Slack blip must not take production
   * down, and a bootout would leave it down because `KeepAlive` cannot restart
   * a label that is no longer registered.
   */
  async start(): Promise<ServiceStatus> {
    const a = this.artifacts;
    assertNoProfileCollision(a, this.peers);

    if (!this.fs.exists(a.plistPath)) {
      throw new ServiceError(
        `No LaunchAgent is installed for the "${a.profile}" profile; run "somawork service install" first.`,
        'not-installed',
      );
    }
    this.assertProfileDataDirSafe();

    const initial = await this.probe();
    this.assertNotBlocked(initial);
    // Any live, ready daemon counts — a healthy headless service is up, and
    // re-entering `bringUp` for it would spawn a second supervisor whose daemon
    // immediately loses the lock and exits.
    const alreadyUp = initial.daemon !== null && initial.ready;

    if (alreadyUp) {
      // Nothing was activated, so there is no ownership check to apply, no
      // manager to attribute, and nothing of ours to roll back.
      return await this.gateAndConfirm({});
    }

    if (initial.registered) await this.bootout();
    this.fs.ensureDir(a.logDir, LOG_DIR_MODE);
    const incumbent = initial.daemon;

    try {
      const activated = await this.bringUp(incumbent);
      return await this.gateAndConfirm({ incumbent, manager: activated.manager });
    } catch (err) {
      // Stop what we started, but keep the plist: the installation was not
      // what failed, and deleting it would turn a retryable health problem
      // into a reinstall.
      try {
        await this.terminateDaemon({ incumbent });
      } catch {
        /* the original failure is the one worth reporting */
      }
      await this.bootoutBestEffort();
      throw err;
    }
  }

  /**
   * Run the doctor, then look again.
   *
   * The doctor is a network round-trip to Slack and llmux — seconds of wall
   * clock during which the daemon is still finishing a long boot and can exit
   * (preflight failure, socket watchdog, duplicate-instance guard). Returning
   * the probe captured before it would report a process that is already dead,
   * which is precisely the window `KeepAlive` + `ThrottleInterval 10` keeps
   * reopening. So the answer is the probe taken AFTER the check, and it must
   * describe the same daemon instance that passed it.
   *
   * `incumbent`/`manager` are present only when this invocation activated a
   * candidate. Confirming a service that was already up is not an activation:
   * there is no incumbent to be distinct from and no path to attribute.
   */
  private async gateAndConfirm(options: {
    incumbent?: DaemonInstance | null;
    manager?: ActivationManager;
  }): Promise<ServiceStatus> {
    const before = await this.probe();
    await this.gateOnDoctor();
    const after = await this.probe();

    if (after.daemon === null || !after.ready) {
      throw new ServiceError(
        `The "${this.artifacts.profile}" daemon stopped being live and connected while its post-start check ran.`,
        'not-live',
      );
    }
    // Ordered before the same-instance check on purpose: when an incumbent has
    // taken the lock back, both are true, and "the installed definition never
    // took effect" is the diagnosis an operator can act on. "It was replaced"
    // would send them looking for a crash that did not happen.
    if (options.incumbent !== undefined && sameDaemonInstance(after.daemon, options.incumbent ?? null)) {
      throw new ServiceError(
        `The "${this.artifacts.profile}" service is running a daemon this activation did not start; the installed definition never took effect.`,
        'not-live',
      );
    }
    if (!sameDaemonInstance(before.daemon, after.daemon)) {
      throw new ServiceError(
        `The "${this.artifacts.profile}" daemon was replaced by another instance while its post-start check ran.`,
        'not-live',
      );
    }
    if (options.manager === 'launchd') {
      // A launchd activation must still be launchd-managed. The converse does
      // NOT hold: a headless activation happens precisely when launchd's job
      // did not produce our daemon, and `bootstrap` + `RunAtLoad` can leave a
      // live supervisor pid behind while the daemon holding the lock is the one
      // the detached fallback spawned. Requiring "not launchd" there would fail
      // the exact case the fallback exists for.
      if (!(after.registered && after.launchdPid !== null)) {
        throw new ServiceError(
          `The "${this.artifacts.profile}" service changed manager while its post-start check ran.`,
          'not-live',
        );
      }
    } else if (options.manager === undefined) {
      const managerChanged =
        (before.registered && before.launchdPid !== null) !== (after.registered && after.launchdPid !== null);
      if (managerChanged) {
        throw new ServiceError(
          `The "${this.artifacts.profile}" service changed manager while its post-start check ran.`,
          'not-live',
        );
      }
    }
    return this.toStatus(after, options.manager);
  }

  /**
   * Clean both a launchd registration (live or stale) and a headless daemon.
   *
   * The registration is cleared FIRST and from launchd's view alone, because
   * reading the lock file can legitimately refuse (a symlinked lock must never
   * be signalled). Probing the lock first meant that refusal left the operator
   * with a loaded registration and no tool-side way to clear it.
   */
  async stop(): Promise<ServiceStatus> {
    const registration = await this.probeRegistration();
    if (registration.registered) await this.bootout();
    await this.terminateDaemon();
    return this.toStatus(await this.probe());
  }

  /**
   * Stop, then start.
   *
   * Nothing else: `start` already owns the bounded launchd→headless algorithm,
   * and a second retry loop layered on top of it would multiply the worst-case
   * wait without adding a single new way to succeed.
   */
  async restart(): Promise<ServiceStatus> {
    await this.stop();
    return this.start();
  }

  /** Read-only. Distinguishes running-launchd, running-headless, stale, stopped. */
  async status(): Promise<ServiceStatus> {
    return this.toStatus(await this.probe());
  }
}

// ---------------------------------------------------------------------------
// Production seams
// ---------------------------------------------------------------------------

/**
 * Find the node the LaunchAgent should exec.
 *
 * The Homebrew keg first, because that is the interpreter the formula declares
 * a dependency on and the one that survives a user changing shells or nvm
 * versions; a discovered `node` only as a fallback, so a machine without the
 * keg is still installable.
 */
export async function resolveServiceNodePath(deps: { host: SetupHost; fs: ServiceFileSystem }): Promise<string> {
  if (deps.fs.isExecutableFile(HOMEBREW_NODE_PATH)) return HOMEBREW_NODE_PATH;
  const discovered = await deps.host.which('node');
  if (discovered !== null && discovered.length > 0) return discovered;
  throw new ServiceError(
    'No node interpreter was found; install the Homebrew node keg before installing the service.',
    'node-missing',
  );
}

/** Real-filesystem {@link ServiceFileSystem}. */
export function createNodeServiceFileSystem(): ServiceFileSystem {
  const lstat = (target: string): fs.Stats | null => {
    try {
      return fs.lstatSync(target);
    } catch {
      return null;
    }
  };
  const stat = (target: string): fs.Stats | null => {
    try {
      return fs.statSync(target);
    } catch {
      return null;
    }
  };

  return {
    exists: (target) => lstat(target) !== null,
    // Followed. A dangling symlink is `lstat`-present and `stat`-absent, which
    // is exactly the shape a partial `brew upgrade node` leaves behind — and
    // picking it as the interpreter is how the LaunchAgent ends up exec'ing
    // nothing.
    statExists: (target) => stat(target) !== null,
    isDirectory: (target) => stat(target)?.isDirectory() === true,
    isExecutableFile(target) {
      if (stat(target)?.isFile() !== true) return false;
      try {
        fs.accessSync(target, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    isSymlink: (target) => lstat(target)?.isSymbolicLink() === true,
    dirStat(target) {
      // `lstat`, not `stat`: a symlinked profile data root is a finding, not
      // something to follow and then report on whatever it points at.
      const st = lstat(target);
      if (st === null) return null;
      return {
        mode: st.mode & 0o777,
        uid: st.uid,
        isDirectory: st.isDirectory(),
        isSymbolicLink: st.isSymbolicLink(),
      };
    },
    currentUid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    readFile(target) {
      try {
        assertNoSymlinkPath(target);
        return fs.readFileSync(target, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFileAtomic(target, body, mode, dirMode) {
      // `tightenExistingDir: false` and an explicit 0755 `dirMode`:
      // `~/Library/LaunchAgents` is Apple's, shared with every other agent on
      // the machine, and the writer's defaults would both create it 0700 and
      // chmod an existing 0755 down to 0700. `backup: false` for the same
      // reason — a `.plist.bak` on every reinstall and every rollback is
      // litter in a directory this tool does not own, and the rollback keeps
      // the previous bytes in memory anyway.
      atomicWriteFile(target, body, { mode, dirMode, tightenExistingDir: false, backup: false });
    },
    remove(target) {
      try {
        fs.unlinkSync(target);
      } catch {
        /* already gone */
      }
    },
    ensureDir(target, mode) {
      ensureDirectory(target, mode);
    },
  };
}

/** Real {@link ProcessProbe}. `kill(pid, 0)` tests liveness without signalling. */
export function createNodeProcessProbe(): ProcessProbe {
  return {
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    signal(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch {
        /* the process died between the liveness check and the signal */
      }
    },
    /**
     * macOS exposes no shell-free way to read ANOTHER process's start time, and
     * this module may not shell out, so the honest answer for anything but this
     * process is `null` — "unknown", which {@link matchesProcessStart} treats as
     * "not a mismatch". The PID-reuse guard that does bite in production is the
     * boot-time bound in {@link ServiceManager}: a lock instance older than the
     * machine's last boot cannot still be running, which is the common case
     * (stale lock survives a power cut, PIDs restart low, reuse follows).
     */
    startedAt(pid) {
      return pid === process.pid ? processStartedAtMs() : null;
    },
    bootTimeMs() {
      return Date.now() - Math.round(os.uptime() * 1000);
    },
  };
}
