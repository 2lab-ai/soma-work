/**
 * `somawork service` — the profile-isolated LaunchAgent manager (Task 9).
 *
 * The properties these tests pin down:
 *
 * 1. **Two profiles never touch.** Label, plist, PID file, log root, and every
 *    config/data/state/runtime root differ, and the collision gate runs before
 *    the first filesystem or launchctl mutation. A shared `baseDirectory` is
 *    legal and must not be rejected.
 * 2. **The plist is secret-free and shell-free**, and writing it neither
 *    tightens `~/Library/LaunchAgents` nor litters a `.bak` in it.
 * 3. **The installed plist is the definition that runs.** launchd caches a job
 *    at `bootstrap` and `kickstart -k` restarts the *cached* definition, so an
 *    install over a live registration must boot out first. The simulator below
 *    models that caching — a stub where `kickstart` spawns unconditionally
 *    cannot see the bug and is why round one shipped it.
 * 4. **Registration is never liveness, and a live PID is not readiness.** Green
 *    requires the daemon's lock file *and* its own post-`app.start()` readiness
 *    marker for that same instance, re-probed after the doctor has run.
 * 5. **The last mutation is reversible, including the running job.** A failing
 *    post-start check restores the previous plist AND re-activates the previous
 *    definition when one was live.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_FILENAME } from '../../pid-lock';
import { READY_MARKER_FILENAME } from '../../service-readiness';
import type { DoctorReport } from '../doctor';
import { type ProfileName, profilePaths } from '../profile';
import {
  createNodeProcessProbe,
  createNodeServiceFileSystem,
  DAEMON_ENTRY_RELATIVE,
  HOMEBREW_NODE_PATH,
  PLIST_DIR_MODE,
  PLIST_FILE_MODE,
  type ProcessProbe,
  renderLaunchAgentPlist,
  resolveServiceNodePath,
  SERVICE_PID_FILENAME,
  type ServiceArtifacts,
  ServiceCollisionError,
  ServiceError,
  type ServiceFileSystem,
  ServiceManager,
  type ServiceManagerDeps,
  SUPERVISOR_ENTRY_RELATIVE,
  serviceArtifacts,
} from '../service';
import { FakeHost } from '../setup/fake-host';
import type { ProfileReceipt } from '../setup/materialize';

const HOME = '/Users/op';
const UID = 501;
const BASE_DIRECTORY = '/Users/op/somawork';

const SENTINEL_BOT_TOKEN = 'xoxb-9-8-SENTINELaaaabbbbcccc';
const SENTINEL_APP_TOKEN = 'xapp-1-A9-7-SENTINELddddeeeeffff';

const BOOT_TIME_MS = 1_700_000_000_000;
const SUPERVISOR_PID = 6666;
const DAEMON_PID = 7777;
/** Wall clock the manager reads immediately before it activates a candidate. */
const ACTIVATION_CLOCK_MS = BOOT_TIME_MS + 90_000;
/** The candidate daemon starts after activation, so it can be attributed to us. */
const DAEMON_STARTED_AT = BOOT_TIME_MS + 100_000;
/** An incumbent that was already running long before this invocation began. */
const INCUMBENT_PID = 5555;
const INCUMBENT_STARTED_AT = BOOT_TIME_MS + 10_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function receiptFor(profile: ProfileName, overrides: Partial<ProfileReceipt> = {}): ProfileReceipt {
  const paths = profilePaths(HOME, profile);
  const runtimeRoot = `/opt/homebrew/Cellar/somawork${profile === 'preview' ? '-preview' : ''}/1.2.3`;
  return {
    profile,
    runtimeVersion: '1.2.3',
    runtimeRoot,
    configDir: paths.configDir,
    runtimeEnvFile: `${paths.configDir}/.env`,
    configFile: `${paths.configDir}/config.json`,
    promptFile: `${paths.configDir}/.system.prompt`,
    runtimeDataDir: `${paths.configDir}/data`,
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    baseDirectory: BASE_DIRECTORY,
    appId: 'A0123456789',
    teamId: 'T0123456789',
    serviceEnvFiles: [`${paths.configDir}/.env`, paths.secretsFile],
    ...overrides,
  };
}

function artifactsFor(profile: ProfileName, overrides: Partial<ProfileReceipt> = {}): ServiceArtifacts {
  return serviceArtifacts({
    home: HOME,
    uid: UID,
    receipt: receiptFor(profile, overrides),
    paths: profilePaths(HOME, profile),
    nodePath: HOMEBREW_NODE_PATH,
  });
}

/** In-memory {@link ServiceFileSystem} with the inspection a test needs. */
function makeFs(seed: Record<string, string> = {}, dirs: string[] = [], executables: string[] = []) {
  const files = new Map<string, string>(Object.entries(seed));
  const symlinks = new Set<string>();
  const directories = new Set<string>(dirs);
  const execs = new Set<string>(executables);
  /** Permission bits per path; anything unset is owner-only, as setup writes it. */
  const modes = new Map<string, number>();
  /** Owner uid per path; anything unset belongs to us. */
  const owners = new Map<string, number>();
  const writes: Array<{ target: string; mode: number; dirMode: number }> = [];
  const removals: string[] = [];
  const ensured: string[] = [];
  const fsFacade: ServiceFileSystem = {
    dirStat: (p) => {
      if (symlinks.has(p)) return { mode: 0o700, uid: UID, isDirectory: false, isSymbolicLink: true };
      if (!directories.has(p)) return null;
      return {
        mode: modes.get(p) ?? 0o700,
        uid: owners.get(p) ?? UID,
        isDirectory: true,
        isSymbolicLink: false,
      };
    },
    currentUid: () => UID,
    exists: (p) => files.has(p) || directories.has(p),
    statExists: (p) => (files.has(p) || directories.has(p)) && !symlinks.has(p),
    isDirectory: (p) => directories.has(p) && !symlinks.has(p),
    isExecutableFile: (p) => execs.has(p) && !symlinks.has(p),
    isSymlink: (p) => symlinks.has(p),
    readFile: (p) => files.get(p) ?? null,
    writeFileAtomic: (p, body, mode, dirMode) => {
      writes.push({ target: p, mode, dirMode });
      files.set(p, body);
    },
    remove: (p) => {
      removals.push(p);
      files.delete(p);
    },
    ensureDir: (p) => {
      ensured.push(p);
      directories.add(p);
    },
  };
  return { fs: fsFacade, files, symlinks, directories, execs, modes, owners, writes, removals, ensured };
}

/** Live processes as pid → process-start identity (M1's reuse discriminator). */
function makeProcesses(alive: Map<number, number>) {
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const processes: ProcessProbe = {
    isAlive: (pid) => alive.has(pid),
    startedAt: (pid) => alive.get(pid) ?? null,
    bootTimeMs: () => BOOT_TIME_MS,
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === 'SIGKILL') alive.delete(pid);
    },
  };
  return { processes, signals };
}

/**
 * A launchctl that models the one behaviour that matters: `bootstrap` LOADS a
 * job definition from the plist bytes on disk and launchd keeps that copy until
 * `bootout`. `kickstart -k` restarts what was loaded — never what is on disk.
 */
interface FakeLaunchd {
  registered: boolean;
  /** Plist bytes captured at `bootstrap`; the running job's real definition. */
  loadedPlist: string | null;
  pid: number | null;
  /** `dist/index.js` path of the definition launchd actually ran. */
  runningEntry: string | null;
  refuseKickstart?: boolean;
  /** Non-zero makes `bootout` FAIL and leave the job loaded, as launchd can. */
  bootoutCode?: number;
  bootstrapCode?: number;
  kickstartCode?: number;
  /**
   * `bootout` reports failure but the unload HAPPENED — launchd's
   * `Boot-out failed: 36: Operation now in progress` is the common case.
   */
  bootoutCodeButUnloads?: number;
  /**
   * The child could not be started at all (EAGAIN/EMFILE/ENOMEM): `command`
   * REJECTS rather than resolving non-ok. This is the shape every launchctl
   * fixture missed, and the shape under which a doctor is already failing.
   */
  bootoutRejects?: boolean;
  /** The label is ALSO gone afterwards — a re-probe would say "not loaded". */
  unregisterOnBootoutReject?: boolean;
  bootstrapRejects?: boolean;
  /** Only the Nth and later bootouts reject — lets a rollback bootout fail alone. */
  bootoutRejectsFrom?: number;
}

function daemonEntryOf(plistBody: string): string | null {
  const match = /<string>([^<]*dist\/index\.js)<\/string>/.exec(plistBody);
  return match === null ? null : match[1];
}

interface LaunchdWorld {
  launchd: FakeLaunchd;
  files: Map<string, string>;
  alive: Map<number, number>;
  artifacts: ServiceArtifacts;
  /** Set false to model a daemon that takes the lock but never reaches app.start(). */
  daemonPublishesReadiness: boolean;
  /** Observations that the rollback would otherwise erase before we can assert. */
  saw: { liveSupervisor: boolean; lockFile: boolean };
  bootoutCalls: number;
  daemonPid: number | null;
  daemonStartedAt: number;
  /** True once a daemon was brought up by the detached fallback, not launchd. */
  daemonStartedByFallback: boolean;
}

/**
 * Bring a daemon up under the profile's lock — or don't, because somebody else
 * already holds it.
 *
 * The contention branch is the whole of N2: `acquirePidLock` makes a second
 * daemon for one data directory exit immediately (issue #152), so a fresh
 * launchd job started while an incumbent (headless) daemon is alive leaves the
 * lock and the marker naming the INCUMBENT. A simulator that always booted the
 * new daemon could not express that, which is why the manager could report
 * green for a definition that never ran.
 */
function bootDaemon(world: LaunchdWorld): void {
  if (world.daemonPid === null) return;
  const incumbent = world.files.get(world.artifacts.pidFile);
  if (incumbent !== undefined) {
    const pid = Number.parseInt(incumbent.split(':')[0], 10);
    if (world.alive.has(pid) && pid !== world.daemonPid) return; // lost the lock, exited
  }
  world.alive.set(world.daemonPid, world.daemonStartedAt);
  world.files.set(world.artifacts.pidFile, `${world.daemonPid}:${world.daemonStartedAt}`);
  if (world.daemonPublishesReadiness) {
    world.files.set(
      world.artifacts.readyFile,
      JSON.stringify({ pid: world.daemonPid, startedAtMs: world.daemonStartedAt }),
    );
  }
}

/**
 * Tear down the daemon LAUNCHD started.
 *
 * `bootout` unloads the job launchd manages and kills its children; it has no
 * effect on an unrelated headless daemon that merely happens to hold the same
 * profile's lock. Modelling it as "wipe the lock" would hide N2 by making the
 * incumbent disappear on the first bootout.
 */
function killDaemon(world: LaunchdWorld): void {
  if (world.daemonPid === null) return;
  // A daemon the FALLBACK spawned is detached from the launchd job; unloading
  // the job cannot reap it. Modelling otherwise hides strays.
  if (world.daemonStartedByFallback) return;
  const lock = world.files.get(world.artifacts.pidFile);
  const owner = lock === undefined ? null : Number.parseInt(lock.split(':')[0], 10);
  if (owner !== null && owner !== world.daemonPid) return; // somebody else's lock
  world.alive.delete(world.daemonPid);
  world.files.delete(world.artifacts.pidFile);
  world.files.delete(world.artifacts.readyFile);
  // A restarted daemon is a NEW process: same PID number is possible, the same
  // start time is not. Reusing one instance across a restart would make the
  // manager's ownership check compare a candidate against itself.
  world.daemonStartedAt += 1_000;
}

function stubLaunchctl(host: FakeHost, world: LaunchdWorld): void {
  const state = world.launchd;
  const is = (sub: string) => (spec: { command: string; args?: readonly string[] }) =>
    spec.command === '/bin/launchctl' && spec.args?.[0] === sub;

  host.stubCommand(is('bootstrap'), (spec) => {
    if (state.bootstrapRejects) return { throws: new Error('Failed to start "/bin/launchctl": spawn EAGAIN') };
    if (state.bootstrapCode !== undefined && state.bootstrapCode !== 0) {
      return { code: state.bootstrapCode, stderr: 'Load failed' };
    }
    if (state.registered) {
      // Real launchd: the label is already loaded, the file is NOT re-read.
      return { code: 37, stderr: 'Bootstrap failed: 37: Operation already in progress' };
    }
    const plistPath = spec.args?.[2] as string;
    const body = world.files.get(plistPath);
    if (body === undefined) return { code: 5, stderr: 'Input/output error' };
    state.registered = true;
    state.loadedPlist = body;
    return { code: 0 };
  });
  host.stubCommand(is('enable'), () => ({ code: 0 }));
  host.stubCommand(is('kickstart'), () => {
    if (state.kickstartCode !== undefined && state.kickstartCode !== 0) {
      return { code: state.kickstartCode, stderr: 'Could not kickstart' };
    }
    if (state.refuseKickstart) return { code: 3, stderr: 'Could not find service' };
    if (state.loadedPlist === null) return { code: 3, stderr: 'Could not find service' };
    state.pid = SUPERVISOR_PID;
    state.runningEntry = daemonEntryOf(state.loadedPlist);
    world.alive.set(SUPERVISOR_PID, BOOT_TIME_MS + 50_000);
    world.saw.liveSupervisor = true;
    bootDaemon(world);
    world.saw.lockFile = world.saw.lockFile || world.files.has(world.artifacts.pidFile);
    return { code: 0 };
  });
  host.stubCommand(is('bootout'), () => {
    world.bootoutCalls += 1;
    if (
      state.bootoutRejects ||
      (state.bootoutRejectsFrom !== undefined && world.bootoutCalls >= state.bootoutRejectsFrom)
    ) {
      // The label may ALSO be gone afterwards, for reasons that have nothing to
      // do with a call that never ran.
      if (state.unregisterOnBootoutReject) state.registered = false;
      throw new Error('Failed to start "/bin/launchctl": spawn EAGAIN');
    }
    if (state.bootoutCode !== undefined && state.bootoutCode !== 0) {
      // launchd refused to unload: the OLD definition stays loaded and running.
      return { code: state.bootoutCode, stderr: 'Boot-out failed' };
    }
    if (state.bootoutCodeButUnloads !== undefined) {
      // Reports failure, unloads anyway. The exit code is not the postcondition.
      state.registered = false;
      state.loadedPlist = null;
      state.pid = null;
      state.runningEntry = null;
      world.alive.delete(SUPERVISOR_PID);
      killDaemon(world);
      return { code: state.bootoutCodeButUnloads, stderr: 'Boot-out failed: 36: Operation now in progress' };
    }
    state.registered = false;
    state.loadedPlist = null;
    state.pid = null;
    state.runningEntry = null;
    world.alive.delete(SUPERVISOR_PID);
    killDaemon(world);
    return { code: 0 };
  });
  host.stubCommand(is('print'), () => {
    if (!state.registered) return { code: 113, stderr: 'Could not find service' };
    const pidLine = state.pid === null ? '' : `\tpid = ${state.pid}\n`;
    return { code: 0, stdout: `gui/${UID} = {\n${pidLine}\tstate = running\n}\n` };
  });
}

const OK_REPORT = (profile: ProfileName): DoctorReport => ({ profile, ok: true, checks: [] });
const FAIL_REPORT = (profile: ProfileName): DoctorReport => ({
  profile,
  ok: false,
  checks: [{ id: 'slack_bot', status: 'fail', detail: 'the workspace rejected the stored credential' }],
});

interface HarnessOptions {
  profile?: ProfileName;
  seed?: Record<string, string>;
  launchd?: Partial<FakeLaunchd>;
  alive?: Array<[number, number]>;
  runDoctor?: (world: LaunchdWorld) => Promise<DoctorReport>;
  peers?: readonly ServiceArtifacts[];
  daemonPid?: number | null;
  daemonPublishesReadiness?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const profile = options.profile ?? 'preview';
  const artifacts = artifactsFor(profile);
  // The fake clock sits on the same axis as the instance identities, so
  // `host.now()` at activation is directly comparable to a daemon's
  // `startedAtMs` — which is what the N2 lower bound compares.
  const host = new FakeHost({ now: ACTIVATION_CLOCK_MS });
  // The operator workspace and the node keg already exist by install time.
  const {
    fs: fsFacade,
    files,
    symlinks,
    directories,
    execs,
    modes,
    owners,
    writes,
    removals,
    ensured,
  } = makeFs({ ...options.seed }, [BASE_DIRECTORY, profilePaths(HOME, profile).dataDir], [HOMEBREW_NODE_PATH]);
  const alive = new Map<number, number>(options.alive ?? []);
  const { processes, signals } = makeProcesses(alive);

  const world: LaunchdWorld = {
    launchd: { registered: false, loadedPlist: null, pid: null, runningEntry: null, ...options.launchd },
    files,
    alive,
    artifacts,
    daemonPublishesReadiness: options.daemonPublishesReadiness ?? true,
    saw: { liveSupervisor: false, lockFile: false },
    bootoutCalls: 0,
    daemonPid: options.daemonPid === undefined ? DAEMON_PID : options.daemonPid,
    daemonStartedAt: DAEMON_STARTED_AT,
    daemonStartedByFallback: false,
  };
  stubLaunchctl(host, world);

  const events: string[] = [];
  const deps: ServiceManagerDeps = {
    artifacts,
    host,
    fs: fsFacade,
    processes,
    runDoctor: async () => {
      events.push('doctor');
      return options.runDoctor ? options.runDoctor(world) : OK_REPORT(profile);
    },
    ...(options.peers === undefined ? {} : { peers: options.peers }),
    readinessTimeoutMs: 5_000,
    pollIntervalMs: 1_000,
    stopGraceMs: 2_000,
  };

  return {
    artifacts,
    host,
    world,
    launchd: world.launchd,
    fs: fsFacade,
    files,
    symlinks,
    directories,
    execs,
    modes,
    owners,
    writes,
    removals,
    ensured,
    alive,
    signals,
    deps,
    events,
    bootDaemon: () => bootDaemon(world),
    killDaemon: () => killDaemon(world),
  };
}

function launchctlSubcommands(host: FakeHost): string[] {
  return host.calls
    .filter((c) => c.kind === 'command' && c.command === '/bin/launchctl')
    .map((c) => (c as { args: readonly string[] }).args[0]);
}

/**
 * Seed a live, ready daemon this invocation did NOT start: no registration, a
 * lock and marker of its own, and a start time from before activation.
 *
 * Reachable from this very module — every `start` that fell through to the
 * headless fallback leaves exactly this.
 */
function seedHeadlessIncumbent(h: ReturnType<typeof harness>, opts: { stubSpawn?: boolean } = {}): void {
  // By default the fallback supervisor starts and its daemon loses the lock
  // too, exactly as a real second daemon for one data directory does. Tests
  // that need the fallback to WIN register their own stub instead — the fake
  // matches stubs in registration order, so this one would shadow theirs.
  if (opts.stubSpawn !== false) h.host.stubSpawn(HOMEBREW_NODE_PATH, { runUntilKilled: true, pid: 4242 });
  h.alive.set(INCUMBENT_PID, INCUMBENT_STARTED_AT);
  h.files.set(h.artifacts.pidFile, `${INCUMBENT_PID}:${INCUMBENT_STARTED_AT}`);
  h.files.set(h.artifacts.readyFile, JSON.stringify({ pid: INCUMBENT_PID, startedAtMs: INCUMBENT_STARTED_AT }));
}

/** Seed a live, ready, launchd-managed service running `plistBody`. */
function seedLive(h: ReturnType<typeof harness>, plistBody: string): void {
  h.files.set(h.artifacts.plistPath, plistBody);
  h.launchd.registered = true;
  h.launchd.loadedPlist = plistBody;
  h.launchd.pid = SUPERVISOR_PID;
  h.launchd.runningEntry = daemonEntryOf(plistBody);
  h.alive.set(SUPERVISOR_PID, BOOT_TIME_MS + 50_000);
  h.bootDaemon();
}

// ---------------------------------------------------------------------------
// Artifacts and isolation
// ---------------------------------------------------------------------------

describe('serviceArtifacts', () => {
  it('derives every artifact from the receipt and never from a source checkout', () => {
    const a = artifactsFor('preview');
    expect(a.label).toBe('ai.2lab.somawork.preview');
    expect(a.plistPath).toBe(`${HOME}/Library/LaunchAgents/ai.2lab.somawork.preview.plist`);
    expect(a.workingDirectory).toBe(`${HOME}/.local/share/somawork/preview`);
    expect(a.pidFile).toBe(`${HOME}/.local/share/somawork/preview/${SERVICE_PID_FILENAME}`);
    expect(a.readyFile).toBe(`${HOME}/.local/share/somawork/preview/${READY_MARKER_FILENAME}`);
    expect(a.logDir).toBe(`${HOME}/.local/state/somawork/preview/logs`);
    expect(a.supervisorEntry).toBe(`/opt/homebrew/Cellar/somawork-preview/1.2.3/${SUPERVISOR_ENTRY_RELATIVE}`);
    expect(a.daemonEntry).toBe(`/opt/homebrew/Cellar/somawork-preview/1.2.3/${DAEMON_ENTRY_RELATIVE}`);
    expect(a.target).toBe(`gui/${UID}/ai.2lab.somawork.preview`);
    expect(a.domain).toBe(`gui/${UID}`);
  });

  it('shares the lock filename with the daemon that writes it (M7)', () => {
    // One owner: a rename in `service-readiness` must move both sides or fail
    // here, never leave the controller probing a file nobody writes.
    expect(SERVICE_PID_FILENAME).toBe(LOCK_FILENAME);
  });

  it('uses the exact production label', () => {
    expect(artifactsFor('production').label).toBe('ai.2lab.somawork.production');
  });

  it('gives preview and production disjoint label, plist, PID, logs, and roots', () => {
    const p = artifactsFor('preview');
    const q = artifactsFor('production');
    for (const field of [
      'label',
      'plistPath',
      'pidFile',
      'readyFile',
      'logDir',
      'configDir',
      'dataDir',
      'stateDir',
      'runtimeRoot',
    ] as const) {
      expect(p[field]).not.toBe(q[field]);
    }
  });

  it('names the two profile env files as separate variables, so a colon in a path is harmless (M5)', () => {
    const a = serviceArtifacts({
      home: '/Users/o:p',
      uid: UID,
      receipt: receiptFor('preview', {
        configDir: '/Users/o:p/cfg dir',
        serviceEnvFiles: ['/Users/o:p/cfg dir/.env', '/Users/o:p/cfg dir/secrets.env'],
      }),
      paths: profilePaths('/Users/o:p', 'preview'),
      nodePath: HOMEBREW_NODE_PATH,
    });
    expect(a.environment.SOMA_PROFILE_ENV_FILE).toBe('/Users/o:p/cfg dir/.env');
    expect(a.environment.SOMA_PROFILE_SECRETS_FILE).toBe('/Users/o:p/cfg dir/secrets.env');
    expect(a.environment.SOMA_PROFILE_ENV_FILES).toBeUndefined();
  });
});

describe('assertNoProfileCollision (through install)', () => {
  it('refuses before the first mutation when a peer shares the data root', async () => {
    const peer = artifactsFor('production', { dataDir: `${HOME}/.local/share/somawork/preview/nested` });
    const h = harness({ peers: [peer] });
    await expect(new ServiceManager(h.deps).install()).rejects.toBeInstanceOf(ServiceCollisionError);
    expect(h.writes).toEqual([]);
    expect(launchctlSubcommands(h.host)).toEqual([]);
  });

  it('names only safe fields and profiles — never a filesystem path — in the error', async () => {
    const peer = artifactsFor('production', { dataDir: `${HOME}/.local/share/somawork/preview` });
    const h = harness({ peers: [peer] });
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceCollisionError;
    expect(err).toBeInstanceOf(ServiceCollisionError);
    expect(err.message).toContain('dataDir');
    expect(err.message).toContain('preview');
    expect(err.message).toContain('production');
    expect(err.message).not.toContain(HOME);
  });

  it('allows preview and production to share a baseDirectory', async () => {
    const peer = artifactsFor('production');
    expect(peer.baseDirectory).toBe(artifactsFor('preview').baseDirectory);
    const h = harness({ peers: [peer] });
    await expect(new ServiceManager(h.deps).install()).resolves.toMatchObject({ state: 'running-launchd' });
  });
});

// ---------------------------------------------------------------------------
// Plist
// ---------------------------------------------------------------------------

describe('renderLaunchAgentPlist', () => {
  const xml = () => renderLaunchAgentPlist(artifactsFor('preview'));

  it('runs node on absolute runtime paths, with no shell anywhere', () => {
    const out = xml();
    expect(out).toContain(`<string>${HOMEBREW_NODE_PATH}</string>`);
    expect(out).toContain(`<string>/opt/homebrew/Cellar/somawork-preview/1.2.3/${SUPERVISOR_ENTRY_RELATIVE}</string>`);
    expect(out).toContain(`<string>/opt/homebrew/Cellar/somawork-preview/1.2.3/${DAEMON_ENTRY_RELATIVE}</string>`);
    expect(out).not.toContain('/bin/bash');
    expect(out).not.toContain('source ');
    expect(out).not.toContain('$(');
    expect(out).not.toMatch(/<string>[^<]*;\s*(cd|export|exec)\s/);
  });

  it('puts the working directory on the profile data dir and the logs under state', () => {
    const out = xml();
    expect(out).toContain(`<key>WorkingDirectory</key>\n    <string>${HOME}/.local/share/somawork/preview</string>`);
    expect(out).toContain(`${HOME}/.local/state/somawork/preview/logs/launchd.out.log`);
    expect(out).toContain(`${HOME}/.local/state/somawork/preview/logs/launchd.err.log`);
  });

  it('carries only fixed non-secret wiring in EnvironmentVariables', () => {
    const out = xml();
    for (const key of [
      'HOME',
      'PATH',
      'SOMA_CONFIG_DIR',
      'SOMA_DATA_DIR',
      'SOMA_BASE_DIRECTORY',
      'SOMA_LOG_DIR',
      'SOMA_PROFILE_ENV_FILE',
      'SOMA_PROFILE_SECRETS_FILE',
    ]) {
      expect(out).toContain(`<key>${key}</key>`);
    }
  });

  it('contains no credential key name and no credential value', () => {
    const out = xml();
    for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET']) {
      expect(out).not.toContain(key);
    }
    expect(out).not.toContain('xoxb');
    expect(out).not.toContain('xapp');
  });

  it('escapes XML metacharacters in every interpolated value', () => {
    const a = artifactsFor('preview', { baseDirectory: '/Users/op/a&b<c>"d"' });
    const out = renderLaunchAgentPlist(a);
    expect(out).toContain('/Users/op/a&amp;b&lt;c&gt;&quot;d&quot;');
    expect(out).not.toContain('a&b<c>');
  });
});

// ---------------------------------------------------------------------------
// install — C1 (job caching) and the plist writer (I4)
// ---------------------------------------------------------------------------

describe('ServiceManager.install', () => {
  it('writes the plist owner-only without tightening or backing up the LaunchAgents directory (I4)', async () => {
    const h = harness();
    await new ServiceManager(h.deps).install();
    expect(h.writes).toEqual([{ target: h.artifacts.plistPath, mode: PLIST_FILE_MODE, dirMode: PLIST_DIR_MODE }]);
    expect(PLIST_FILE_MODE).toBe(0o600);
    expect(PLIST_DIR_MODE).toBe(0o755);
  });

  it('registers, kickstarts, and only then reports running', async () => {
    const h = harness();
    const status = await new ServiceManager(h.deps).install();
    expect(launchctlSubcommands(h.host)).toEqual(expect.arrayContaining(['bootstrap', 'enable', 'kickstart']));
    expect(status.state).toBe('running-launchd');
    expect(status.manager).toBe('launchd');
    expect(status.pid).toBe(DAEMON_PID);
    expect(h.events.filter((e) => e === 'doctor').length).toBe(1);
  });

  it('boots out a live registration before activating the new plist (C1)', async () => {
    const h = harness();
    const oldArtifacts = artifactsFor('preview', { runtimeRoot: '/opt/homebrew/Cellar/somawork-preview/1.2.2' });
    seedLive(h, renderLaunchAgentPlist(oldArtifacts));

    const status = await new ServiceManager(h.deps).install();

    const subs = launchctlSubcommands(h.host);
    expect(subs).toContain('bootout');
    expect(subs.indexOf('bootout')).toBeLessThan(subs.indexOf('bootstrap'));
    // The definition launchd is RUNNING must be the new one, not the cached 1.2.2.
    expect(h.launchd.runningEntry).toBe(h.artifacts.daemonEntry);
    expect(h.launchd.runningEntry).not.toBe(oldArtifacts.daemonEntry);
    expect(h.launchd.loadedPlist).toBe(h.files.get(h.artifacts.plistPath));
    expect(status.state).toBe('running-launchd');
  });

  it('makes a changed SOMA_DATA_DIR live, not merely present on disk (C1)', async () => {
    const h = harness();
    const oldArtifacts = artifactsFor('preview', { dataDir: `${HOME}/.local/share/somawork/preview-old` });
    seedLive(h, renderLaunchAgentPlist(oldArtifacts));
    await new ServiceManager(h.deps).install();
    expect(h.launchd.loadedPlist).toContain(`<string>${h.artifacts.dataDir}</string>`);
    expect(h.launchd.loadedPlist).not.toContain('preview-old');
  });

  it('refuses to install when the operator workspace does not exist', async () => {
    const h = harness();
    h.directories.delete(BASE_DIRECTORY);
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-installed' });
    expect(h.writes).toEqual([]);
  });

  it('refuses a workspace that is only a dangling symlink (M2)', async () => {
    const h = harness();
    h.symlinks.add(BASE_DIRECTORY);
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-installed' });
  });

  it('refuses to call it green on a registration with no live process', async () => {
    const h = harness({ launchd: { refuseKickstart: true }, daemonPid: null });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, { runUntilKilled: true, pid: 4242 });
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-live' });
  });

  it('requires the daemon PID file, not merely a launchd PID', async () => {
    const h = harness({ daemonPid: null });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, { runUntilKilled: true, pid: 4242 });
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-live' });
    // launchd DID produce a live supervisor; the refusal came from the missing
    // daemon lock, not from a missing launchd process. (The rollback has since
    // torn the supervisor down, hence the recorded observation.)
    expect(h.world.saw.liveSupervisor).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I2 — daemon-owned readiness
// ---------------------------------------------------------------------------

describe('daemon readiness gate (I2)', () => {
  it('never accepts a lock without the daemon readiness marker', async () => {
    const h = harness({ daemonPublishesReadiness: false });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, { runUntilKilled: true, pid: 4242 });
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-live' });
    // The lock WAS written and the daemon WAS alive — readiness is the only
    // thing that was missing. (Both are gone again after the rollback.)
    expect(h.world.saw.lockFile).toBe(true);
    expect(h.world.saw.liveSupervisor).toBe(true);
  });

  it('never accepts a readiness marker left by a different daemon instance', async () => {
    const h = harness({ daemonPublishesReadiness: false });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, { runUntilKilled: true, pid: 4242 });
    // A marker from a previous boot: same PID number, different process.
    h.files.set(h.artifacts.readyFile, JSON.stringify({ pid: DAEMON_PID, startedAtMs: BOOT_TIME_MS - 5_000 }));
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-live' });
  });

  it('never accepts a readiness marker naming another process', async () => {
    const h = harness({ daemonPublishesReadiness: false });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, { runUntilKilled: true, pid: 4242 });
    h.files.set(h.artifacts.readyFile, JSON.stringify({ pid: 9999, startedAtMs: DAEMON_STARTED_AT }));
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-live' });
  });

  it('reports a live-but-unready daemon as stale, never as running', async () => {
    const h = harness({ daemonPublishesReadiness: false });
    h.bootDaemon();
    const status = await new ServiceManager(h.deps).status();
    expect(status.state).toBe('stale');
    expect(status.ready).toBe(false);
    expect(status.pid).toBe(DAEMON_PID);
  });
});

// ---------------------------------------------------------------------------
// I1 — the returned status is the post-doctor one
// ---------------------------------------------------------------------------

describe('post-doctor re-probe (I1)', () => {
  it('fails when the daemon dies while the doctor is running', async () => {
    const h = harness({
      runDoctor: async (world) => {
        killDaemon(world);
        return OK_REPORT('preview');
      },
    });
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-live' });
    expect(h.files.has(h.artifacts.plistPath)).toBe(false);
  });

  it('fails when the daemon is replaced by a different instance during the doctor', async () => {
    const h = harness({
      runDoctor: async (world) => {
        // A KeepAlive restart: same lock path, new process.
        world.daemonStartedAt = DAEMON_STARTED_AT + 9_999;
        world.daemonPid = DAEMON_PID + 1;
        killDaemon(world);
        world.alive.delete(DAEMON_PID);
        bootDaemon(world);
        return OK_REPORT('preview');
      },
    });
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-live' });
  });

  it('fails when readiness is retracted during the doctor', async () => {
    const h = harness({
      runDoctor: async (world) => {
        world.files.delete(world.artifacts.readyFile);
        return OK_REPORT('preview');
      },
    });
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-live' });
  });

  it('reports the supervisor launchd reports AFTER the doctor, not before it', async () => {
    const h = harness({
      runDoctor: async (world) => {
        // A KeepAlive restart of the SUPERVISOR: same daemon instance, same
        // manager, different launchd pid. Nothing here is a failure — it is
        // simply a fact that only a post-doctor probe can see, which is what
        // makes it the proof that the returned status is the later read.
        world.launchd.pid = SUPERVISOR_PID + 1;
        world.alive.set(SUPERVISOR_PID + 1, BOOT_TIME_MS + 60_000);
        return OK_REPORT('preview');
      },
    });
    const status = await new ServiceManager(h.deps).install();
    expect(status.supervisorPid).toBe(SUPERVISOR_PID + 1);
  });

  it('probes launchd again after the doctor, so the returned status cannot be the stale one', async () => {
    const h = harness();
    await new ServiceManager(h.deps).install();
    const printCount = launchctlSubcommands(h.host).filter((sub) => sub === 'print').length;
    // One before the doctor and one after it, at minimum.
    expect(printCount).toBeGreaterThanOrEqual(2);
    // The doctor is not the last thing that happened before we answered.
    expect(h.events).toContain('doctor');
  });
});

// ---------------------------------------------------------------------------
// C1 rollback — restore the previous DEFINITION, not just the previous bytes
// ---------------------------------------------------------------------------

describe('install rollback', () => {
  it('rolls back to no plist and no registration when there was nothing before', async () => {
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview') });
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'doctor-failed' });
    expect(h.files.has(h.artifacts.plistPath)).toBe(false);
    expect(launchctlSubcommands(h.host)).toContain('bootout');
    expect(h.launchd.registered).toBe(false);
  });

  it('restores the previous plist bytes', async () => {
    const oldArtifacts = artifactsFor('preview', { runtimeRoot: '/opt/homebrew/Cellar/somawork-preview/1.2.2' });
    const previous = renderLaunchAgentPlist(oldArtifacts);
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview') });
    h.files.set(h.artifacts.plistPath, previous);
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'doctor-failed' });
    expect(h.files.get(h.artifacts.plistPath)).toBe(previous);
  });

  it('restarts the previously running definition, not merely its XML (C1)', async () => {
    const oldArtifacts = artifactsFor('preview', { runtimeRoot: '/opt/homebrew/Cellar/somawork-preview/1.2.2' });
    const previous = renderLaunchAgentPlist(oldArtifacts);
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview') });
    seedLive(h, previous);

    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'doctor-failed' });

    expect(h.files.get(h.artifacts.plistPath)).toBe(previous);
    expect(h.launchd.registered).toBe(true);
    expect(h.launchd.runningEntry).toBe(oldArtifacts.daemonEntry);
    expect(h.alive.has(DAEMON_PID)).toBe(true);
  });

  it('does not restart anything when the prior registration was already dead', async () => {
    const previous = '<plist>previous generation</plist>';
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview'), launchd: { registered: true, pid: null } });
    h.files.set(h.artifacts.plistPath, previous);
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'doctor-failed' });
    expect(h.files.get(h.artifacts.plistPath)).toBe(previous);
    expect(h.launchd.registered).toBe(false);
  });

  it('reports a rollback failure without echoing any credential', async () => {
    const h = harness({
      runDoctor: async () => {
        throw new Error(`slack rejected ${SENTINEL_BOT_TOKEN} for app ${SENTINEL_APP_TOKEN}`);
      },
    });
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as Error;
    const serialized = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`;
    expect(serialized).not.toContain(SENTINEL_BOT_TOKEN);
    expect(serialized).not.toContain(SENTINEL_APP_TOKEN);
    expect(serialized).not.toContain('xoxb');
    expect(serialized).not.toContain('xapp');
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe('ServiceManager.start', () => {
  const installed = (h: ReturnType<typeof harness>) => {
    h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
  };

  it('refuses when no plist has been installed', async () => {
    const h = harness();
    await expect(new ServiceManager(h.deps).start()).rejects.toMatchObject({ code: 'not-installed' });
  });

  it('boots a stale registration out before bootstrapping again', async () => {
    const h = harness({ launchd: { registered: true, pid: null } });
    installed(h);
    const status = await new ServiceManager(h.deps).start();
    const subs = launchctlSubcommands(h.host);
    expect(subs).toContain('bootout');
    expect(subs.indexOf('bootout')).toBeLessThan(subs.indexOf('bootstrap'));
    expect(status.state).toBe('running-launchd');
  });

  it('falls back to a detached headless supervisor when launchd yields no live PID', async () => {
    const h = harness({ launchd: { refuseKickstart: true }, daemonPid: null });
    installed(h);
    h.host.stubSpawn(HOMEBREW_NODE_PATH, () => {
      h.world.daemonPid = 8888;
      h.world.daemonStartedAt = BOOT_TIME_MS + 200_000;
      h.bootDaemon();
      return { runUntilKilled: true, pid: 4242 };
    });

    const status = await new ServiceManager(h.deps).start();
    expect(status.state).toBe('running-headless');
    expect(status.manager).toBe('headless');
    expect(status.pid).toBe(8888);

    const spawnCall = h.host.calls.find((c) => c.kind === 'spawn') as {
      command: string;
      args: readonly string[];
      env: Record<string, string>;
      detached?: boolean;
      inheritEnv?: boolean;
      cwd?: string;
    };
    expect(spawnCall.detached).toBe(true);
    expect(spawnCall.inheritEnv).toBe(false);
    expect(spawnCall.cwd).toBe(h.artifacts.workingDirectory);
    expect(spawnCall.args).toEqual([h.artifacts.supervisorEntry, h.artifacts.daemonEntry]);
    for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET']) {
      expect(Object.keys(spawnCall.env)).not.toContain(key);
    }
  });

  it('fails through ServiceError when the detached supervisor exits immediately (I3)', async () => {
    const h = harness({ launchd: { refuseKickstart: true }, daemonPid: null });
    installed(h);
    h.host.stubSpawn(HOMEBREW_NODE_PATH, { code: 1, pid: 4242 });
    await expect(new ServiceManager(h.deps).start()).rejects.toMatchObject({ code: 'not-live' });
  });

  it('fails through ServiceError when the detached spawn rejects asynchronously (I3)', async () => {
    const h = harness({ launchd: { refuseKickstart: true }, daemonPid: null });
    installed(h);
    // Exactly RealHost's shape for an async ENOENT: `exited` rejects.
    h.host.stubSpawn(HOMEBREW_NODE_PATH, { failsAsync: new Error('spawn ENOENT'), pid: null });
    await expect(new ServiceManager(h.deps).start()).rejects.toMatchObject({ code: 'not-live' });

    // And it fails FAST: waiting out the whole readiness budget for a process
    // that never existed is how a broken interpreter costs 25 seconds per try.
    const sleepsAfterSpawn = h.host.calls
      .slice(h.host.calls.findIndex((c) => c.kind === 'spawn'))
      .filter((c) => c.kind === 'sleep').length;
    expect(sleepsAfterSpawn).toBeLessThanOrEqual(1);
  });

  it('stops the process and keeps the plist when the post-start doctor fails', async () => {
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview') });
    installed(h);
    await expect(new ServiceManager(h.deps).start()).rejects.toMatchObject({ code: 'doctor-failed' });
    expect(h.files.has(h.artifacts.plistPath)).toBe(true);
    expect(h.launchd.registered).toBe(false);
  });

  it('still runs the doctor and the post-doctor probe on an already-running service (M6)', async () => {
    const h = harness();
    installed(h);
    seedLive(h, renderLaunchAgentPlist(h.artifacts));
    const status = await new ServiceManager(h.deps).start();
    expect(status.state).toBe('running-launchd');
    expect(h.events).toContain('doctor');
    expect(launchctlSubcommands(h.host)).not.toContain('bootstrap');
  });

  it('reports an already-registered service that is not ready as a failure, not a green no-op (M6)', async () => {
    const h = harness({ daemonPublishesReadiness: false, launchd: { refuseKickstart: true } });
    installed(h);
    h.launchd.registered = true;
    h.launchd.pid = SUPERVISOR_PID;
    h.alive.set(SUPERVISOR_PID, BOOT_TIME_MS + 50_000);
    h.bootDaemon();
    h.host.stubSpawn(HOMEBREW_NODE_PATH, { runUntilKilled: true, pid: 4242 });
    await expect(new ServiceManager(h.deps).start()).rejects.toMatchObject({ code: 'not-live' });
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe('ServiceManager.stop', () => {
  it('cleans a stale registration even with no live process', async () => {
    const h = harness({ launchd: { registered: true, pid: null } });
    const status = await new ServiceManager(h.deps).stop();
    expect(launchctlSubcommands(h.host)).toContain('bootout');
    expect(status.state).toBe('stopped');
  });

  it('escalates SIGTERM to SIGKILL for a headless process that will not die', async () => {
    const h = harness({ alive: [[9001, BOOT_TIME_MS + 10]] });
    h.files.set(h.artifacts.pidFile, `9001:${BOOT_TIME_MS + 10}`);
    await new ServiceManager(h.deps).stop();
    expect(h.signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.alive.has(9001)).toBe(false);
    expect(h.files.has(h.artifacts.pidFile)).toBe(false);
  });

  it('clears the readiness marker along with the lock', async () => {
    const h = harness({ alive: [[9001, BOOT_TIME_MS + 10]] });
    h.files.set(h.artifacts.pidFile, `9001:${BOOT_TIME_MS + 10}`);
    h.files.set(h.artifacts.readyFile, JSON.stringify({ pid: 9001, startedAtMs: BOOT_TIME_MS + 10 }));
    await new ServiceManager(h.deps).stop();
    expect(h.files.has(h.artifacts.readyFile)).toBe(false);
  });

  it('never signals a PID from a malformed lock file', async () => {
    const h = harness({ alive: [[1234, BOOT_TIME_MS]] });
    h.files.set(h.artifacts.pidFile, 'not-a-pid:whatever');
    await new ServiceManager(h.deps).stop();
    expect(h.signals).toEqual([]);
  });

  it('never signals a non-positive PID even when that PID is alive', async () => {
    for (const forbidden of ['0', '1']) {
      const h = harness({
        alive: [
          [0, BOOT_TIME_MS + 1],
          [1, BOOT_TIME_MS + 1],
        ],
      });
      h.files.set(h.artifacts.pidFile, `${forbidden}:${BOOT_TIME_MS + 1}`);
      await new ServiceManager(h.deps).stop();
      expect(h.signals).toEqual([]);
    }
  });

  it('never signals a reused PID whose process start does not match the lock (M1/N6)', async () => {
    // PID 9001 is alive — but it started AFTER the instance the lock recorded,
    // i.e. the number was recycled while the stale lock sat on disk. Signalling
    // it would SIGKILL a stranger; DELETING the lock while that PID is alive
    // would re-open the duplicate-Socket-Mode window `pid-lock` exists to
    // close, because we cannot prove the process is not a soma-work daemon.
    const h = harness({ alive: [[9001, BOOT_TIME_MS + 500_000]] });
    h.files.set(h.artifacts.pidFile, `9001:${BOOT_TIME_MS + 10}`);
    h.files.set(h.artifacts.readyFile, JSON.stringify({ pid: 9001, startedAtMs: BOOT_TIME_MS + 10 }));
    await expect(new ServiceManager(h.deps).stop()).rejects.toMatchObject({ code: 'unsafe-state' });
    expect(h.signals).toEqual([]);
    expect(h.files.has(h.artifacts.pidFile)).toBe(true);
    expect(h.files.has(h.artifacts.readyFile)).toBe(true);
  });

  it('never signals a lock instance that predates the last boot (M1/N6)', async () => {
    const h = harness({ alive: [[9001, BOOT_TIME_MS + 5]] });
    // Production shape: macOS gives no shell-free start time for ANOTHER
    // process, so the per-PID comparison abstains and the boot bound is the
    // only thing standing between a stale lock and a SIGKILL to a stranger.
    h.deps.processes.startedAt = () => null;
    h.files.set(h.artifacts.pidFile, `9001:${BOOT_TIME_MS - 60_000}`);
    await expect(new ServiceManager(h.deps).stop()).rejects.toMatchObject({ code: 'unsafe-state' });
    expect(h.signals).toEqual([]);
    expect(h.files.has(h.artifacts.pidFile)).toBe(true);
  });

  it('removes the lock of a dead instance without signalling anything (N6)', async () => {
    const h = harness();
    h.files.set(h.artifacts.pidFile, `9001:${BOOT_TIME_MS + 10}`);
    h.files.set(h.artifacts.readyFile, JSON.stringify({ pid: 9001, startedAtMs: BOOT_TIME_MS + 10 }));
    const status = await new ServiceManager(h.deps).stop();
    expect(h.signals).toEqual([]);
    expect(h.files.has(h.artifacts.pidFile)).toBe(false);
    expect(h.files.has(h.artifacts.readyFile)).toBe(false);
    expect(status.state).toBe('stopped');
  });

  it('deregisters launchd before refusing on a symlinked lock file (M8)', async () => {
    const h = harness({ launchd: { registered: true, pid: SUPERVISOR_PID }, alive: [[SUPERVISOR_PID, BOOT_TIME_MS]] });
    h.files.set(h.artifacts.pidFile, `9001:${BOOT_TIME_MS + 10}`);
    h.symlinks.add(h.artifacts.pidFile);
    await expect(new ServiceManager(h.deps).stop()).rejects.toMatchObject({ code: 'unsafe-state' });
    // The operator is not left with a loaded registration and no way to clear it.
    expect(launchctlSubcommands(h.host)).toContain('bootout');
    expect(h.launchd.registered).toBe(false);
    expect(h.signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// restart / status
// ---------------------------------------------------------------------------

describe('ServiceManager.restart', () => {
  it('is exactly stop then start, with no extra retry loop', async () => {
    const h = harness();
    seedLive(h, renderLaunchAgentPlist(h.artifacts));
    const status = await new ServiceManager(h.deps).restart();
    const subs = launchctlSubcommands(h.host);
    expect(subs.filter((s) => s === 'bootout').length).toBe(1);
    expect(subs.filter((s) => s === 'bootstrap').length).toBe(1);
    expect(status.state).toBe('running-launchd');
  });
});

describe('ServiceManager.status', () => {
  it('reports stopped when nothing is registered and nothing is alive', async () => {
    const h = harness();
    const status = await new ServiceManager(h.deps).status();
    expect(status).toMatchObject({ state: 'stopped', manager: 'none', pid: null, registered: false, ready: false });
  });

  it('reports stale for a registration with no live process', async () => {
    const h = harness({ launchd: { registered: true, pid: null } });
    const status = await new ServiceManager(h.deps).status();
    expect(status.state).toBe('stale');
    expect(status.registered).toBe(true);
  });

  it('refuses to call a registration green when the daemon lock is dead', async () => {
    const h = harness({ launchd: { registered: true, pid: SUPERVISOR_PID }, alive: [[SUPERVISOR_PID, BOOT_TIME_MS]] });
    h.files.set(h.artifacts.pidFile, `${DAEMON_PID}:${DAEMON_STARTED_AT}`);
    const status = await new ServiceManager(h.deps).status();
    expect(status.state).toBe('stale');
  });

  it('reports running-headless for a live ready lock with no registration', async () => {
    const h = harness();
    h.bootDaemon();
    const status = await new ServiceManager(h.deps).status();
    expect(status).toMatchObject({ state: 'running-headless', manager: 'headless', pid: DAEMON_PID, ready: true });
  });

  it('returns a secret-free receipt carrying the profile paths', async () => {
    const h = harness();
    h.bootDaemon();
    const status = await new ServiceManager(h.deps).status();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('xoxb');
    expect(serialized).not.toContain('xapp');
    expect(serialized).not.toContain('SLACK_');
    expect(status.plistPath).toBe(h.artifacts.plistPath);
    expect(status.logDir).toBe(h.artifacts.logDir);
    expect(status.pidFile).toBe(h.artifacts.pidFile);
  });

  it('performs no mutation', async () => {
    const h = harness({ launchd: { registered: true, pid: SUPERVISOR_PID }, alive: [[SUPERVISOR_PID, BOOT_TIME_MS]] });
    h.bootDaemon();
    await new ServiceManager(h.deps).status();
    expect(h.writes).toEqual([]);
    expect(h.removals).toEqual([]);
    expect(h.signals).toEqual([]);
    expect(launchctlSubcommands(h.host).every((s) => s === 'print')).toBe(true);
  });
});

describe('post-start doctor injection', () => {
  it('treats a thrown probe as a failed gate', async () => {
    const h = harness({
      runDoctor: async () => {
        throw new Error('probe exploded');
      },
    });
    h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
    await expect(new ServiceManager(h.deps).start()).rejects.toMatchObject({ code: 'doctor-failed' });
  });

  it('runs the doctor only after the process is live', async () => {
    const order: string[] = [];
    const h = harness({
      runDoctor: async () => {
        order.push('doctor');
        return OK_REPORT('preview');
      },
    });
    const spy = vi.spyOn(h.fs, 'writeFileAtomic').mockImplementation((p, body) => {
      order.push('plist');
      h.files.set(p, body);
    });
    await new ServiceManager(h.deps).install();
    expect(order).toEqual(['plist', 'doctor']);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Production seams against a real filesystem (M9)
// ---------------------------------------------------------------------------

describe('production seams', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-service-seam-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a plist without tightening the existing LaunchAgents directory or leaving a .bak (I4)', () => {
    const agents = path.join(tmp, 'LaunchAgents');
    fs.mkdirSync(agents, { mode: 0o755 });
    fs.chmodSync(agents, 0o755);
    const target = path.join(agents, 'ai.2lab.somawork.preview.plist');
    const seam = createNodeServiceFileSystem();

    seam.writeFileAtomic(target, '<plist>one</plist>', PLIST_FILE_MODE, PLIST_DIR_MODE);
    seam.writeFileAtomic(target, '<plist>two</plist>', PLIST_FILE_MODE, PLIST_DIR_MODE);

    expect(fs.statSync(agents).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(agents)).toEqual(['ai.2lab.somawork.preview.plist']);
    expect(fs.statSync(target).mode & 0o777).toBe(PLIST_FILE_MODE);
    expect(fs.readFileSync(target, 'utf-8')).toBe('<plist>two</plist>');
  });

  it('creates a missing LaunchAgents directory at 0755 rather than 0700', () => {
    const agents = path.join(tmp, 'fresh', 'LaunchAgents');
    const seam = createNodeServiceFileSystem();
    seam.writeFileAtomic(path.join(agents, 'x.plist'), '<plist/>', PLIST_FILE_MODE, PLIST_DIR_MODE);
    expect(fs.statSync(agents).mode & 0o777).toBe(PLIST_DIR_MODE);
  });

  it('distinguishes a dangling symlink from a real file (M2)', () => {
    const seam = createNodeServiceFileSystem();
    const dangling = path.join(tmp, 'dangling');
    fs.symlinkSync(path.join(tmp, 'missing'), dangling);
    expect(seam.exists(dangling)).toBe(true); // lstat: the link itself is there
    expect(seam.statExists(dangling)).toBe(false); // follow: its target is not
    expect(seam.isSymlink(dangling)).toBe(true);
    expect(seam.isExecutableFile(dangling)).toBe(false);
    expect(seam.isDirectory(dangling)).toBe(false);
  });

  it('recognises only a followed, executable regular file as a node candidate (M2)', () => {
    const seam = createNodeServiceFileSystem();
    const plain = path.join(tmp, 'plain');
    fs.writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
    expect(seam.isExecutableFile(plain)).toBe(false);
    fs.chmodSync(plain, 0o755);
    expect(seam.isExecutableFile(plain)).toBe(true);
    expect(seam.isExecutableFile(tmp)).toBe(false); // a directory is not a node
    const link = path.join(tmp, 'link');
    fs.symlinkSync(plain, link);
    expect(seam.isExecutableFile(link)).toBe(true); // a WORKING symlink is fine
  });

  it('recognises a followed directory for the workspace gate (M2)', () => {
    const seam = createNodeServiceFileSystem();
    const dir = path.join(tmp, 'workspace');
    fs.mkdirSync(dir);
    expect(seam.isDirectory(dir)).toBe(true);
    expect(seam.isDirectory(path.join(tmp, 'nope'))).toBe(false);
    const link = path.join(tmp, 'wslink');
    fs.symlinkSync(dir, link);
    expect(seam.isDirectory(link)).toBe(true);
  });

  it('reports this process as alive with a start identity, and boot time in the past', () => {
    const probe = createNodeProcessProbe();
    expect(probe.isAlive(process.pid)).toBe(true);
    const started = probe.startedAt(process.pid);
    expect(started).not.toBeNull();
    expect(started as number).toBeLessThanOrEqual(Date.now());
    expect(probe.bootTimeMs()).toBeLessThanOrEqual(started as number);
    expect(probe.isAlive(0x7fffffff)).toBe(false);
  });
});

describe('resolveServiceNodePath', () => {
  it('prefers the Homebrew node when it is a working executable', async () => {
    const host = new FakeHost();
    const { fs: seam } = makeFs({}, [], [HOMEBREW_NODE_PATH]);
    await expect(resolveServiceNodePath({ host, fs: seam })).resolves.toBe(HOMEBREW_NODE_PATH);
  });

  it('falls back to a discovered node when the Homebrew path is a dangling symlink (M2)', async () => {
    const host = new FakeHost().stubWhich('node', '/usr/local/bin/node');
    // Present to `lstat`, broken to `stat` — the partial `brew upgrade node` case.
    const { fs: seam, symlinks } = makeFs({ [HOMEBREW_NODE_PATH]: '' }, [], []);
    symlinks.add(HOMEBREW_NODE_PATH);
    await expect(resolveServiceNodePath({ host, fs: seam })).resolves.toBe('/usr/local/bin/node');
  });

  it('fails loudly when there is no node at all', async () => {
    const host = new FakeHost().stubWhich('node', null);
    const { fs: seam } = makeFs();
    await expect(resolveServiceNodePath({ host, fs: seam })).rejects.toMatchObject({ code: 'node-missing' });
  });
});

// ---------------------------------------------------------------------------
// N1 — launchctl reports failure as a value, not an exception
// ---------------------------------------------------------------------------

/**
 * `host.launchctl` is `command(launchctlCommandSpec(op))`, which resolves with a
 * non-zero `code` rather than throwing. Round one issued the C1 bootout and
 * never looked at the result, so a routine boot-out failure put the manager
 * back in exactly the state C1 describes: new plist on disk, old definition
 * running, green receipt. Nothing downstream can catch it, because the readiness
 * gate reads the daemon's lock and marker in `dataDir` — which do not change
 * across a `brew upgrade`.
 */
describe('launchctl failures are checked (N1)', () => {
  it('refuses to activate when the bootout of a live registration fails', async () => {
    const h = harness({ launchd: { bootoutCode: 5 } });
    const oldArtifacts = artifactsFor('preview', { runtimeRoot: '/opt/homebrew/Cellar/somawork-preview/1.2.2' });
    const previous = renderLaunchAgentPlist(oldArtifacts);
    seedLive(h, previous);

    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('launchctl-failed');

    // The candidate was never activated…
    const subs = launchctlSubcommands(h.host);
    expect(subs).not.toContain('bootstrap');
    expect(subs).not.toContain('kickstart');
    // …and the old definition is still the one launchd is running.
    expect(h.launchd.runningEntry).toBe(oldArtifacts.daemonEntry);
    expect(h.files.get(h.artifacts.plistPath)).toBe(previous);
  });

  it('reports the bootout failure without a path, a token, or launchctl output', async () => {
    const h = harness({ launchd: { bootoutCode: 5 } });
    seedLive(h, renderLaunchAgentPlist(h.artifacts));
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as Error;
    const serialized = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`;
    expect(serialized).not.toContain(HOME);
    expect(serialized).not.toContain('Boot-out failed');
    expect(serialized).not.toContain('xoxb');
    expect(serialized).not.toContain('xapp');
  });

  it('fails before any health polling when bootstrap fails', async () => {
    const h = harness({ launchd: { bootstrapCode: 5 } });
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('launchctl-failed');
    expect(launchctlSubcommands(h.host)).not.toContain('kickstart');
    expect(h.events).not.toContain('doctor');
  });

  it('does not poll launchd for health when kickstart fails, and cannot pass through it', async () => {
    // A failed kickstart is the GUI-less-Mac symptom the detached fallback
    // exists for, so it is not a hard refusal — but launchd must not be polled
    // or believed, and if the fallback produces nothing the install still fails.
    const h = harness({ launchd: { kickstartCode: 3 }, daemonPid: null });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, { runUntilKilled: true, pid: 4242 });
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('not-live');
    expect(h.events).not.toContain('doctor');
    expect(h.files.has(h.artifacts.plistPath)).toBe(false);
  });

  it('never reports a launchd-managed service when kickstart failed', async () => {
    // The daemon comes up under the FALLBACK; launchd never ran the job, so the
    // receipt must not claim it did.
    const h = harness({ launchd: { kickstartCode: 3 } });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, () => {
      h.bootDaemon();
      return { runUntilKilled: true, pid: 4242 };
    });
    const status = await new ServiceManager(h.deps).install();
    expect(status.state).toBe('running-headless');
    expect(status.manager).toBe('headless');

    // "Fails before health polling": launchd is not waited on at all once it
    // has told us it could not start the job.
    const spawnAt = h.host.calls.findIndex((c) => c.kind === 'spawn');
    expect(spawnAt).toBeGreaterThanOrEqual(0);
    expect(h.host.calls.slice(0, spawnAt).filter((c) => c.kind === 'sleep')).toEqual([]);
  });

  it('never turns a failed restoration into a successful install', async () => {
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview') });
    const oldArtifacts = artifactsFor('preview', { runtimeRoot: '/opt/homebrew/Cellar/somawork-preview/1.2.2' });
    seedLive(h, renderLaunchAgentPlist(oldArtifacts));
    // The rollback's own re-activation fails; the reported error must still be
    // the doctor failure that caused the rollback.
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('doctor-failed');
  });
});

// ---------------------------------------------------------------------------
// N2 — the daemon we report green must have started after we activated
// ---------------------------------------------------------------------------

describe('activation lower bound (N2)', () => {
  it('refuses to report green for an incumbent headless daemon it never replaced', async () => {
    const h = harness();
    seedHeadlessIncumbent(h);

    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('not-live');

    // The incumbent is untouched: still alive, still holding its lock, never
    // signalled. It is not ours to kill — we could not replace it.
    expect(h.alive.has(INCUMBENT_PID)).toBe(true);
    expect(h.files.get(h.artifacts.pidFile)).toBe(`${INCUMBENT_PID}:${INCUMBENT_STARTED_AT}`);
    expect(h.signals).toEqual([]);
    // launchd's job did not produce OUR daemon, so the fallback was attempted
    // rather than the incumbent being accepted as the launchd path's success.
    expect(h.host.calls.some((c) => c.kind === 'spawn')).toBe(true);
  });

  it('restores the prior plist after refusing an unreplaceable incumbent', async () => {
    const previous = '<plist>previous generation</plist>';
    const h = harness();
    h.files.set(h.artifacts.plistPath, previous);
    seedHeadlessIncumbent(h);
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'not-live' });
    expect(h.files.get(h.artifacts.plistPath)).toBe(previous);
  });

  it('diagnoses an incumbent that reclaims the lock during the doctor as definition drift', async () => {
    const restoreIncumbent = (world: LaunchdWorld) => {
      world.alive.delete(DAEMON_PID);
      world.alive.set(INCUMBENT_PID, INCUMBENT_STARTED_AT);
      world.files.set(world.artifacts.pidFile, `${INCUMBENT_PID}:${INCUMBENT_STARTED_AT}`);
      world.files.set(
        world.artifacts.readyFile,
        JSON.stringify({ pid: INCUMBENT_PID, startedAtMs: INCUMBENT_STARTED_AT }),
      );
    };
    const h = harness({ runDoctor: async (world) => (restoreIncumbent(world), OK_REPORT('preview')) });
    // An incumbent is present at activation, the candidate wins the lock from
    // it, and then it comes back while the doctor is running.
    seedHeadlessIncumbent(h, { stubSpawn: false });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, () => {
      h.alive.delete(INCUMBENT_PID);
      h.files.delete(h.artifacts.pidFile);
      h.files.delete(h.artifacts.readyFile);
      h.world.daemonStartedByFallback = true;
      h.bootDaemon();
      return { runUntilKilled: true, pid: 4242 };
    });

    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('not-live');
    // The actionable diagnosis, not "something replaced it".
    expect(err.message).toMatch(/this activation did not start/);
  });

  it('accepts a candidate that replaced the incumbent, even under a backwards clock step', async () => {
    // Ownership is instance identity, not wall clock: a candidate whose start
    // time an NTP step put BEFORE the moment we activated is still ours,
    // because it is not the instance that was there when we looked.
    const h = harness();
    seedHeadlessIncumbent(h, { stubSpawn: false });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, () => {
      // The fallback's daemon wins the lock this time.
      h.alive.delete(INCUMBENT_PID);
      h.world.daemonPid = DAEMON_PID;
      h.world.daemonStartedAt = ACTIVATION_CLOCK_MS - 1; // clock went backwards
      h.world.daemonStartedByFallback = true;
      h.files.delete(h.artifacts.pidFile);
      h.files.delete(h.artifacts.readyFile);
      h.bootDaemon();
      return { runUntilKilled: true, pid: 4242 };
    });
    const status = await new ServiceManager(h.deps).install();
    expect(status.pid).toBe(DAEMON_PID);
    expect(status.state).toBe('running-headless');
  });

  it('terminates a failed candidate this invocation started, whatever the clock says', async () => {
    // A candidate the FALLBACK started: detached from the launchd job, so a
    // bootout cannot reap it and only the rollback's terminate can. Its start
    // time is also "before" activation, the shape a backwards clock produces.
    const h = harness({
      runDoctor: async () => FAIL_REPORT('preview'),
      launchd: { kickstartCode: 3 },
      daemonPid: null,
    });
    h.host.stubSpawn(HOMEBREW_NODE_PATH, () => {
      h.world.daemonPid = DAEMON_PID;
      h.world.daemonStartedAt = ACTIVATION_CLOCK_MS - 1;
      h.world.daemonStartedByFallback = true;
      h.bootDaemon();
      return { runUntilKilled: true, pid: 4242 };
    });

    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'doctor-failed' });
    // Not left holding the profile's lock.
    expect(h.alive.has(DAEMON_PID)).toBe(false);
    expect(h.files.has(h.artifacts.pidFile)).toBe(false);
    expect(h.signals.map((sig) => sig.pid)).toContain(DAEMON_PID);
  });

  it('does not apply the lower bound to an incumbent that start() merely confirms', async () => {
    const h = harness();
    h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
    seedHeadlessIncumbent(h);
    const status = await new ServiceManager(h.deps).start();
    // Confirming a service that was already up is not an activation, so a
    // start time from before this invocation is exactly what we expect.
    expect(status.state).toBe('running-headless');
    expect(status.pid).toBe(INCUMBENT_PID);
    expect(h.events).toContain('doctor');
  });
});

// ---------------------------------------------------------------------------
// N5 / N9 — an idempotent start never stops what it did not start
// ---------------------------------------------------------------------------

describe('idempotent start leaves an incumbent alone (N5/N9)', () => {
  it('reports a doctor failure against a healthy launchd service without tearing it down', async () => {
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview') });
    h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
    seedLive(h, renderLaunchAgentPlist(h.artifacts));

    await expect(new ServiceManager(h.deps).start()).rejects.toMatchObject({ code: 'doctor-failed' });

    // `somawork service start` during a Slack blip must not take production
    // down — and a bootout would leave it down, because KeepAlive cannot
    // restart a label that is no longer registered.
    expect(h.launchd.registered).toBe(true);
    expect(h.launchd.runningEntry).toBe(h.artifacts.daemonEntry);
    expect(h.alive.has(DAEMON_PID)).toBe(true);
    expect(h.signals).toEqual([]);
    expect(launchctlSubcommands(h.host)).not.toContain('bootout');
  });

  it('reports a doctor failure against a healthy headless daemon without signalling it', async () => {
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview') });
    h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
    seedHeadlessIncumbent(h);

    await expect(new ServiceManager(h.deps).start()).rejects.toMatchObject({ code: 'doctor-failed' });
    expect(h.alive.has(INCUMBENT_PID)).toBe(true);
    expect(h.signals).toEqual([]);
    expect(launchctlSubcommands(h.host)).not.toContain('bootout');
  });

  it('does not spawn a redundant supervisor over a healthy headless daemon (N9)', async () => {
    const h = harness();
    h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
    seedHeadlessIncumbent(h);

    const status = await new ServiceManager(h.deps).start();
    expect(status.state).toBe('running-headless');
    expect(h.host.calls.some((c) => c.kind === 'spawn')).toBe(false);
    expect(launchctlSubcommands(h.host)).not.toContain('bootstrap');
  });
});

// ---------------------------------------------------------------------------
// N-B1 / N-B5 — a launchctl that cannot be SPAWNED
// ---------------------------------------------------------------------------

/**
 * `host.launchctl` is `command(...)`: it RESOLVES non-ok when launchctl runs and
 * refuses, and it REJECTS when the child cannot be started at all — EAGAIN,
 * EMFILE, ENOMEM. Every launchctl fixture until now drove the first shape only,
 * which is how an unguarded `await` inside the rollback survived: it replaces
 * the reported diagnosis, skips the plist restore, and leaves the plist on disk
 * describing a definition launchd is not running. The conditions that produce a
 * fork failure are the same conditions under which a doctor is already failing,
 * so the two arrive together.
 */
describe('launchctl spawn rejections (N-B1/N-B5)', () => {
  it('keeps the original doctor failure when the rollback bootout cannot be spawned', async () => {
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview'), launchd: { bootoutRejects: true } });
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('doctor-failed');
  });

  it('still removes the candidate plist when the rollback bootout cannot be spawned', async () => {
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview'), launchd: { bootoutRejects: true } });
    await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({ code: 'doctor-failed' });
    expect(h.files.has(h.artifacts.plistPath)).toBe(false);
  });

  it('still restores a live prior generation when the rollback bootout cannot be spawned', async () => {
    const oldArtifacts = artifactsFor('preview', { runtimeRoot: '/opt/homebrew/Cellar/somawork-preview/1.2.2' });
    const previous = renderLaunchAgentPlist(oldArtifacts);
    // The pre-activation bootout succeeds; only the rollback's own fails.
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview'), launchd: { bootoutRejectsFrom: 2 } });
    seedLive(h, previous);

    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('doctor-failed');
    // The bytes are back — this is C1's harm shape, and it must not be
    // reachable through a cleanup failure.
    expect(h.files.get(h.artifacts.plistPath)).toBe(previous);
  });

  it('keeps the original failure when start rolls back its own candidate', async () => {
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview'), launchd: { bootoutRejectsFrom: 1 } });
    h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
    const err = (await new ServiceManager(h.deps).start().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('doctor-failed');
    // start never deletes the plist it did not write.
    expect(h.files.has(h.artifacts.plistPath)).toBe(true);
  });

  it('serializes no launchctl stderr, path, or credential from any rejection path', async () => {
    const h = harness({ runDoctor: async () => FAIL_REPORT('preview'), launchd: { bootoutRejects: true } });
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as Error;
    const serialized = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`;
    expect(serialized).not.toContain('EAGAIN');
    expect(serialized).not.toContain('/bin/launchctl');
    expect(serialized).not.toContain(HOME);
    expect(serialized).not.toContain('xoxb');
  });

  it('converts a pre-activation bootout rejection into a typed failure and restores the plist', async () => {
    const previous = '<plist>previous generation</plist>';
    const h = harness({ launchd: { bootoutRejects: true } });
    h.files.set(h.artifacts.plistPath, previous);
    seedLive(h, previous);

    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('launchctl-failed');
    expect(h.files.get(h.artifacts.plistPath)).toBe(previous);
    expect(launchctlSubcommands(h.host)).not.toContain('bootstrap');
  });

  it('refuses after a rejected bootout even when a re-probe says the label is gone', async () => {
    // launchctl never RAN, so nothing it did can be inferred — including from a
    // registration that has disappeared for some other reason. Trusting a
    // re-probe here would let an unspawnable bootout stand in for a real one.
    const h = harness({ launchd: { bootoutRejects: true, unregisterOnBootoutReject: true } });
    seedLive(h, renderLaunchAgentPlist(h.artifacts));
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('launchctl-failed');
    expect(launchctlSubcommands(h.host)).not.toContain('bootstrap');
  });

  it('converts a bootstrap rejection into a typed failure', async () => {
    const h = harness({ launchd: { bootstrapRejects: true } });
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('launchctl-failed');
    expect(`${err.message}`).not.toContain('EAGAIN');
  });
});

// ---------------------------------------------------------------------------
// N-B2 — the manager that actually won owns the label
// ---------------------------------------------------------------------------

describe('manager attribution (N-B2)', () => {
  it('labels a fallback-started daemon headless even when a launchd supervisor PID exists', async () => {
    // `bootstrap` succeeds and `RunAtLoad` brings a supervisor up; `kickstart`
    // then fails, and the FALLBACK's daemon wins the lock. `launchctl print`
    // reports a live supervisor pid the whole time — but launchd is not what
    // produced the running daemon, and the receipt must not say it was.
    const h = harness({ launchd: { kickstartCode: 3 }, daemonPid: null });
    h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
    h.host.stubSpawn(HOMEBREW_NODE_PATH, () => {
      h.launchd.pid = SUPERVISOR_PID; // RunAtLoad spawned a supervisor
      h.alive.set(SUPERVISOR_PID, BOOT_TIME_MS + 50_000);
      h.world.daemonPid = DAEMON_PID;
      h.world.daemonStartedByFallback = true;
      h.bootDaemon();
      return { runUntilKilled: true, pid: 4242 };
    });

    const status = await new ServiceManager(h.deps).start();
    expect(status.supervisorPid).toBe(SUPERVISOR_PID);
    expect(status.state).toBe('running-headless');
    expect(status.manager).toBe('headless');
  });
});

// ---------------------------------------------------------------------------
// N-B3 — the bootout postcondition, not the exit code
// ---------------------------------------------------------------------------

describe('bootout postcondition (N-B3)', () => {
  it('continues when a non-zero bootout actually unloaded the job', async () => {
    // `Boot-out failed: 36: Operation now in progress` while the unload proceeds.
    const h = harness({ launchd: { bootoutCodeButUnloads: 36 } });
    seedLive(h, renderLaunchAgentPlist(h.artifacts));
    const status = await new ServiceManager(h.deps).install();
    expect(status.state).toBe('running-launchd');
    expect(launchctlSubcommands(h.host)).toContain('bootstrap');
  });

  it('refuses when a non-zero bootout left the job loaded', async () => {
    const h = harness({ launchd: { bootoutCode: 5 } });
    seedLive(h, renderLaunchAgentPlist(h.artifacts));
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('launchctl-failed');
    expect(err.message).toMatch(/could not be confirmed/);
    expect(launchctlSubcommands(h.host)).not.toContain('bootstrap');
  });
});

// ---------------------------------------------------------------------------
// N-B6 — the profile data directory is validated before anything mutates
// ---------------------------------------------------------------------------

/**
 * `acquirePidLock` creates a missing `dataDir` with a bare recursive `mkdirSync`
 * — 0755 under the default umask — and readiness publication deliberately no
 * longer tightens it (N4). That directory holds `cct-store.json`. So an
 * operator who deletes `~/.local/share/somawork/<profile>` gets it recreated
 * world-readable by the daemon. The materializer owns creation and the doctor
 * owns reporting; the service's job is to refuse to activate over it.
 */
describe('profile data directory validation (N-B6)', () => {
  const cases: Array<[string, (h: ReturnType<typeof harness>) => void, RegExp]> = [
    ['missing', (h) => h.directories.delete(h.artifacts.dataDir), /does not exist/],
    ['group- or other-accessible', (h) => h.modes.set(h.artifacts.dataDir, 0o755), /group or other/],
    ['owned by another user', (h) => h.owners.set(h.artifacts.dataDir, 502), /owned by another user/],
    // `lstat` on a symlink reports the LINK, so "not a directory" would also
    // fire — but an operator told "not a directory" about a symlink to a
    // perfectly good directory will not find the problem.
    ['a symlink', (h) => h.symlinks.add(h.artifacts.dataDir), /is a symlink/],
  ];

  for (const [label, corrupt, diagnosis] of cases) {
    it(`refuses to install when the profile data directory is ${label}`, async () => {
      const h = harness();
      corrupt(h);
      await expect(new ServiceManager(h.deps).install()).rejects.toMatchObject({
        code: 'unsafe-state',
        message: expect.stringMatching(diagnosis),
      });
      // Before the plist, before any launchctl call at all, before any spawn.
      expect(h.writes).toEqual([]);
      expect(launchctlSubcommands(h.host)).toEqual([]);
      expect(h.host.calls.some((c) => c.kind === 'spawn')).toBe(false);
    });

    it(`refuses to start when the profile data directory is ${label}`, async () => {
      const h = harness();
      h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
      corrupt(h);
      await expect(new ServiceManager(h.deps).start()).rejects.toMatchObject({ code: 'unsafe-state' });
      expect(launchctlSubcommands(h.host)).toEqual([]);
    });
  }

  it('accepts an exactly-0700 profile data directory owned by this user', async () => {
    const h = harness();
    await expect(new ServiceManager(h.deps).install()).resolves.toMatchObject({ state: 'running-launchd' });
  });

  it('neither creates nor chmods the profile data directory', async () => {
    const h = harness();
    await new ServiceManager(h.deps).install();
    // Only the log root is ensured; the data root belongs to the materializer.
    expect(h.ensured).toEqual([h.artifacts.logDir]);
  });
});

// ---------------------------------------------------------------------------
// N-B7 — an alive lock we cannot attribute is a diagnosis, not "not-live"
// ---------------------------------------------------------------------------

describe('foreign lock diagnosis (N-B7)', () => {
  const seedForeignLock = (h: ReturnType<typeof harness>) => {
    // Alive PID, identity that does not match the lock: a stale lock whose
    // number the OS handed to something else. `acquirePidLock` will refuse, so
    // every daemon we start exits immediately.
    h.alive.set(9001, BOOT_TIME_MS + 500_000);
    h.files.set(h.artifacts.pidFile, `9001:${BOOT_TIME_MS + 10}`);
  };

  it('reports a blocked status instead of stopped', async () => {
    const h = harness();
    seedForeignLock(h);
    const status = await new ServiceManager(h.deps).status();
    expect(status.state).toBe('blocked');
    // Never the foreign PID, never its start time, never a path to it.
    expect(status.pid).toBeNull();
    expect(JSON.stringify(status)).not.toContain('9001');
  });

  it('fails install with the actionable diagnosis before burning the readiness budget', async () => {
    const h = harness();
    seedForeignLock(h);
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('unsafe-state');
    expect(h.writes).toEqual([]);
    // Read-only probes are fine; nothing may MUTATE, and no readiness budget
    // may be spent on a daemon that could never acquire the lock.
    expect(launchctlSubcommands(h.host).filter((sub) => sub !== 'print')).toEqual([]);
    expect(h.host.calls.filter((c) => c.kind === 'sleep')).toEqual([]);
  });

  it('fails start with the same diagnosis', async () => {
    const h = harness();
    h.files.set(h.artifacts.plistPath, renderLaunchAgentPlist(h.artifacts));
    seedForeignLock(h);
    const err = (await new ServiceManager(h.deps).start().catch((e) => e)) as ServiceError;
    expect(err.code).toBe('unsafe-state');
    expect(h.host.calls.some((c) => c.kind === 'spawn')).toBe(false);
  });

  it('names no PID, start time, or path in the diagnosis', async () => {
    const h = harness();
    seedForeignLock(h);
    const err = (await new ServiceManager(h.deps).install().catch((e) => e)) as Error;
    const serialized = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`;
    expect(serialized).not.toContain('9001');
    expect(serialized).not.toContain(String(BOOT_TIME_MS + 10));
    expect(serialized).not.toContain(HOME);
  });
});
