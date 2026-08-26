/**
 * `somawork setup` — the resumable onboarding orchestrator (design §5).
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is a **sequencer over already-approved adapters**. Every product-touching
 * capability — llmux onboarding, Slack CLI authorization, Slack app creation and
 * token capture, profile materialization, the doctor gate, the LaunchAgent —
 * lives in its own module with its own tests and its own security review. This
 * file decides *which* of them runs, *in what order*, *what a failure means*,
 * and *what is safe to remember*. It re-implements none of them: there is no
 * launchctl call, no PID logic, no token handling, and no manifest construction
 * anywhere below.
 *
 * Three properties it is built around:
 *
 * **1. A completion marker is advisory, never authority.** Every step calls its
 * adapter on every run. The adapters inspect live state first (`ensureLlmux`
 * reads the roster, `ensureSlackCliAuth` reads `slack auth list`,
 * `materializeProfile` is deterministic and idempotent, the doctor probes, and
 * Task 9's `install` gates on a live registration + lock + readiness). What the
 * markers do is record *how far a previous run got* so the operator can be told
 * where they are — they can never let a step be skipped, because there is no
 * skip branch to take. {@link completeStep} additionally **truncates** every
 * later marker whenever an earlier step completes, so a re-validated early step
 * can never leave a stale green receipt for a later one behind it.
 *
 * **2. Nothing observed becomes persisted text.** `lastError` receives
 * {@link classifySetupFailure}'s output and nothing else: the step name plus the
 * error's *class name*, validated against a conservative identifier pattern.
 * No `.message`, no command output, no path, no URL, no provider text. That is
 * the same reduction the llmux and Slack adapters apply at their own boundaries,
 * applied once more at the state boundary, so a future adapter that starts
 * embedding request context in a message cannot leak it into setup state.
 *
 * **3. The prompt budget is a hard contract, not a style preference.** A machine
 * with one runtime and one authorized workspace asks **zero** product questions.
 * The only two that exist are profile choice (both runtimes installed, no
 * `--profile`) and workspace choice (more than one Slack authorization), each at
 * most once. Base directory, display names, icons, GitHub, debug flags and env
 * vars are product defaults and are never asked.
 *
 * `--resume` is compatibility syntax. Plain `somawork setup` executes this exact
 * function with this exact behaviour; there is no resume branch to diverge.
 */

import * as path from 'path';
import type { DoctorReport } from '../doctor';
import { isProfileName, type ProfileName, type ProfilePaths, profilePaths, type RuntimeInstall } from '../profile';
import type { ServiceStatus } from '../service';
import type { SetupHost } from './host';
import type { EnsureLlmuxOptions, LlmuxReceipt } from './llmux';
import type { MaterializeProfileInput, PackagedAsset, ProfileReceipt } from './materialize';
import type { SecretValues } from './secrets';
import {
  type EnsureSlackCliAuthOptions,
  SLACK_BIN,
  type SlackAuthCandidate,
  SlackAuthSelectionRequiredError,
  SlackAuthTeamNotFoundError,
  type SlackCliAuthReceipt,
} from './slack-auth';
import type { CaptureAndPersistOptions, SlackCaptureReceipt, SlackSecretSink } from './slack-capture';
import type { MaterializeSlackProjectOptions, SlackAppMapping, SlackProject } from './slack-manifest';
import {
  type CompletedStepReceipt,
  createDefaultSetupState,
  isRecoverableSetupStateError,
  type SetupState,
  type SetupStateStore,
} from './state';

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * The exact, ordered step vocabulary. These strings are persisted in setup
 * state and printed in receipts, so they are snake-case and carry no word the
 * state gate reads as a credential (`auth` is a `SECRET_KEY_WORDS` member —
 * hence `slack_cli_auth` would trip a *key* check but is only ever a *value*,
 * which is why the gate's key scan is not a problem here and the value scan is
 * satisfied by these being fixed literals).
 */
export const SETUP_STEPS = [
  'inspect',
  'llmux',
  'slack_cli_auth',
  'slack_app',
  'profile',
  'doctor',
  'service',
  'post_start_doctor',
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Exit code for the pending-Slack-admin-approval outcome.
 *
 * `EX_TEMPFAIL` from `sysexits.h`: "temporary failure, indicating something that
 * is not really an error — the request should be retried later". That is exactly
 * this state, and it is distinct from `1` so a CI receipt or a wrapper script
 * can tell "an admin has to click approve" from "setup failed".
 */
export const SETUP_PENDING_EXIT_CODE = 75;

/** Directory created under the profile's data root when no workspace root exists. */
export const DEFAULT_WORKSPACES_DIRNAME = 'workspaces';

/** Exact mode of a workspace root **this tool creates**. Never applied to one it finds. */
export const WORKSPACE_DIR_MODE = 0o700;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A setup failure, carrying the step it happened at and a persistable summary.
 *
 * `message` is for the human in front of the terminal and is written here, in
 * this file, from fixed strings. `summary` is what reaches setup state and is
 * always {@link classifySetupFailure}'s output.
 */
export class SetupError extends Error {
  constructor(
    readonly step: SetupStep,
    readonly summary: string,
    message: string,
  ) {
    super(message);
    this.name = 'SetupError';
  }
}

/** A class name is the only fragment of a foreign error worth repeating. */
const SAFE_ERROR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Reduce any thrown value to `"<step>: <SafeClassName>"`.
 *
 * `name` is a writable property on every JS object, so it is validated rather
 * than trusted: anything that is not a plain identifier becomes `Error`. The
 * result is the ONLY thing this module ever writes to `lastError`.
 */
export function classifySetupFailure(step: SetupStep, error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  const safe = typeof name === 'string' && SAFE_ERROR_NAME_RE.test(name) ? name : 'Error';
  return `${step}: ${safe}`;
}

// ---------------------------------------------------------------------------
// Runtime discovery
// ---------------------------------------------------------------------------

/** Homebrew formula that ships each profile's immutable runtime. */
export const RUNTIME_FORMULAE: Readonly<Record<ProfileName, string>> = {
  preview: 'somawork-preview',
  production: 'somawork',
};

/**
 * The entries Task 9's `ServiceManager` `exec`s, relative to the runtime root.
 *
 * Verified here rather than assumed: "a Homebrew prefix exists" is not the same
 * claim as "this prefix is a somawork runtime". `brew --prefix <formula>` prints
 * a path for a formula that is merely *known*, and an interrupted upgrade leaves
 * a directory whose `dist/` is incomplete. Installing a LaunchAgent whose
 * `ProgramArguments` name a missing file produces a job that launchd retries
 * forever, which is the failure mode this check exists to prevent.
 */
export const REQUIRED_RUNTIME_ENTRIES = ['dist/run-with-rotating-logs.js', 'dist/index.js'] as const;

/** Where the non-secret runtime version is read from. */
export const RUNTIME_VERSION_FILE = 'package.json';

/** Narrow, synchronous filesystem surface used by discovery. Injectable. */
export interface RuntimeDiscoveryFileSystem {
  /** Canonical absolute path, or `null` when it cannot be resolved. */
  realpath(target: string): string | null;
  isDirectory(target: string): boolean;
  isFile(target: string): boolean;
  readFile(target: string): string | null;
}

export interface RuntimeDiscoveryDeps {
  host: SetupHost;
  fs: RuntimeDiscoveryFileSystem;
  /** Cap on one `brew --prefix`. Default 30s. */
  timeoutMs?: number;
}

const BREW_BIN = 'brew';
const DEFAULT_BREW_TIMEOUT_MS = 30_000;

/**
 * A safe, non-secret version string. Bounded and restricted to the characters a
 * semver-ish version uses, so a tampered `package.json` cannot smuggle arbitrary
 * text into a receipt or a completion card.
 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

/**
 * Discover installed somawork runtimes.
 *
 * A prefix counts as an installed runtime only when **all** of the following
 * hold: `brew --prefix <formula>` exits 0 with exactly one absolute path;
 * `realpath` resolves it (so preview/production roots are compared in one
 * canonical representation, per the Task 9 handoff); it is a directory; every
 * entry in {@link REQUIRED_RUNTIME_ENTRIES} is a file inside it; and its
 * `package.json` parses with a plausible `version`. Anything else is *not an
 * installed runtime* — never a warning, never a partial result.
 *
 * A source checkout and `/opt/soma-work/{dev,main}` are never inferred: the only
 * way in is a Homebrew prefix for one of the two known formulae.
 */
export async function discoverRuntimes(deps: RuntimeDiscoveryDeps): Promise<RuntimeInstall[]> {
  const brew = await deps.host.which(BREW_BIN);
  if (brew === null) return [];

  const timeoutMs = deps.timeoutMs ?? DEFAULT_BREW_TIMEOUT_MS;
  const found: RuntimeInstall[] = [];

  for (const profile of Object.keys(RUNTIME_FORMULAE) as ProfileName[]) {
    const install = await discoverOne(deps, brew, profile, timeoutMs);
    if (install !== null) found.push(install);
  }

  return found;
}

async function discoverOne(
  deps: RuntimeDiscoveryDeps,
  brew: string,
  profile: ProfileName,
  timeoutMs: number,
): Promise<RuntimeInstall | null> {
  let result: { code: number | null; stdout: string };
  try {
    const outcome = await deps.host.command({
      command: brew,
      args: ['--prefix', RUNTIME_FORMULAE[profile]],
      timeoutMs,
    });
    result = { code: outcome.code, stdout: outcome.stdout };
  } catch {
    // brew could not be spawned at all. Not an installed runtime; not a reason
    // to stop looking for the other profile.
    return null;
  }

  if (result.code !== 0) return null;

  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // Exactly one line: a `brew` that printed a warning alongside the prefix, or
  // an aliased formula that printed two, is ambiguous rather than informative.
  if (lines.length !== 1) return null;

  const declared = lines[0];
  if (!path.isAbsolute(declared)) return null;

  const root = deps.fs.realpath(declared);
  if (root === null || !path.isAbsolute(root)) return null;
  if (!deps.fs.isDirectory(root)) return null;

  for (const entry of REQUIRED_RUNTIME_ENTRIES) {
    if (!deps.fs.isFile(path.join(root, entry))) return null;
  }

  const version = readRuntimeVersion(deps.fs, root);
  if (version === null) return null;

  return { profile, root, version };
}

function readRuntimeVersion(fsFacade: RuntimeDiscoveryFileSystem, root: string): string | null {
  const raw = fsFacade.readFile(path.join(root, RUNTIME_VERSION_FILE));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;
  return version;
}

// ---------------------------------------------------------------------------
// Base directory
// ---------------------------------------------------------------------------

/**
 * Filesystem surface for the workspace root. Deliberately has **no chmod**.
 *
 * That absence is the design: an operator-owned workspace root is not ours to
 * repair, and `ensureDirectory` — which tightens an existing directory up to
 * 0700 — is the wrong tool for a directory the operator chose. The only mutation
 * available here is {@link SetupWorkspaceFs.createDir}, and the resolver calls it
 * exactly once, only for the default path, only when nothing is there.
 */
export interface SetupWorkspaceFs {
  /** `lstat`-based presence: a dangling symlink counts as existing. */
  exists(target: string): boolean;
  /** `lstat` projection; `null` when absent. Symlinks are reported, not followed. */
  lstat(target: string): { isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean } | null;
  canWrite(target: string): boolean;
  /** Create `target` and missing parents at exactly `mode`, refusing symlinked ancestors. */
  createDir(target: string, mode: number): void;
}

export interface ResolveBaseDirectoryInput {
  fs: SetupWorkspaceFs;
  /** `ProfilePaths.dataDir`; the default workspace root lives directly under it. */
  dataDir: string;
  /** An operator-owned root (from an existing profile, or an explicit choice). */
  selected?: string;
}

/**
 * Resolve the profile's workspace root.
 *
 * Two cases with deliberately different permissions policy:
 *
 * - **Default** (`<dataDir>/workspaces`): created at exactly {@link
 *   WORKSPACE_DIR_MODE} when absent. When it already exists it is verified and
 *   left completely alone — no chmod, no re-create.
 * - **Selected** (an operator's existing absolute directory): verified to be a
 *   real, writable directory and **never** mutated. Tightening a directory the
 *   operator pointed us at — which may hold their existing work, or be shared
 *   with the other profile — is not a repair, it is damage.
 *
 * A relative path, a file, a symlink, a missing selected directory, or an
 * unwritable one is refused before any profile artifact is written.
 */
export function resolveBaseDirectory(input: ResolveBaseDirectoryInput): string {
  const { fs: fsFacade, dataDir, selected } = input;

  if (selected !== undefined) {
    if (typeof selected !== 'string' || selected.trim().length === 0 || !path.isAbsolute(selected)) {
      throw new SetupError('profile', 'profile: SetupError', 'The workspace directory must be an absolute path.');
    }
    assertUsableWorkspaceDir(fsFacade, selected, 'The selected workspace directory');
    return selected;
  }

  const target = path.join(dataDir, DEFAULT_WORKSPACES_DIRNAME);
  const stat = fsFacade.lstat(target);
  if (stat === null) {
    fsFacade.createDir(target, WORKSPACE_DIR_MODE);
    return target;
  }
  assertUsableWorkspaceDir(fsFacade, target, 'The workspace directory');
  return target;
}

function assertUsableWorkspaceDir(fsFacade: SetupWorkspaceFs, target: string, label: string): void {
  const stat = fsFacade.lstat(target);
  const fail = (detail: string): never => {
    throw new SetupError('profile', 'profile: SetupError', `${label} ${detail}`);
  };
  if (stat === null) fail('does not exist. Create it, or remove it from the profile so setup can use its default.');
  else if (stat.isSymbolicLink) fail('is a symlink. Point setup at the real directory instead.');
  else if (!stat.isDirectory) fail('is not a directory.');
  else if (!fsFacade.canWrite(target)) fail('is not writable by this user.');
  return;
}

// ---------------------------------------------------------------------------
// Pending Slack admin approval
// ---------------------------------------------------------------------------

/**
 * Phrases the Slack CLI prints while an installation waits for a workspace
 * admin. Anchored on multi-word forms so the bare word "approval" — which
 * appears in ordinary manifest/scope chatter — never trips them.
 */
const SLACK_APPROVAL_PENDING_PATTERNS: readonly RegExp[] = [
  /\brequires?\s+admin\s+approval\b/i,
  /\bpending\s+admin\s+approval\b/i,
  /\bawaiting\s+approval\b/i,
  /\bapproval\s+(?:is\s+)?required\b/i,
  /\bapproval\s+request\b/i,
];

/**
 * Whether one redacted child-output line says the install is waiting on an admin.
 *
 * This classification is what separates a **resumable non-error terminal state**
 * from a genuine capture failure. Without it, an install that a workspace admin
 * simply has not clicked yet is indistinguishable from a broken socket, and the
 * operator is told to debug something that is working exactly as designed.
 */
export function isSlackApprovalPendingLine(line: string): boolean {
  if (typeof line !== 'string') return false;
  return SLACK_APPROVAL_PENDING_PATTERNS.some((pattern) => pattern.test(line));
}

// ---------------------------------------------------------------------------
// Peers (service collision gate)
// ---------------------------------------------------------------------------

/**
 * Build the *other* profiles' receipts, for Task 9's collision gate.
 *
 * Only profiles with a **discovered** runtime are included, and their roots come
 * straight from {@link discoverRuntimes} — already `realpath`-canonical — so the
 * gate's lexical overlap comparison sees one representation on both sides. A
 * profile whose runtime is not installed contributes no root we could name
 * without inventing one, and its label/paths are derived deterministically from
 * `profilePaths` anyway, so it cannot be the thing that collides.
 */
export function buildPeerReceipts(input: {
  home: string;
  profile: ProfileName;
  runtimes: readonly RuntimeInstall[];
}): ProfileReceipt[] {
  const peers: ProfileReceipt[] = [];
  const seen = new Set<ProfileName>();

  for (const install of input.runtimes) {
    if (install.profile === input.profile || seen.has(install.profile)) continue;
    seen.add(install.profile);
    peers.push(receiptForPaths(install.profile, profilePaths(input.home, install.profile), install));
  }

  return peers;
}

function receiptForPaths(profile: ProfileName, paths: ProfilePaths, install: RuntimeInstall): ProfileReceipt {
  const runtimeEnvFile = path.join(paths.configDir, '.env');
  return {
    profile,
    runtimeVersion: install.version,
    runtimeRoot: install.root,
    configDir: paths.configDir,
    runtimeEnvFile,
    configFile: path.join(paths.configDir, 'config.json'),
    promptFile: path.join(paths.configDir, '.system.prompt'),
    runtimeDataDir: path.join(paths.configDir, 'data'),
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    baseDirectory: path.join(paths.dataDir, DEFAULT_WORKSPACES_DIRNAME),
    appId: '',
    teamId: '',
    serviceEnvFiles: [runtimeEnvFile, paths.secretsFile],
  };
}

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

export interface SetupChoice {
  value: string;
  label: string;
}

/** The single non-secret question surface. At most two calls per whole setup. */
export interface SetupPrompt {
  choose(question: string, choices: readonly SetupChoice[]): Promise<string>;
}

/** Terminal renderer. Separated so tests assert on structure, not on ANSI bytes. */
export interface SetupOutput {
  /** A step is starting. */
  step(step: SetupStep, message: string): void;
  info(message: string): void;
  /**
   * The one carrier for the `/slackauthticket <ticket>` line.
   *
   * Ephemeral display only. Never logged, never persisted, never reported —
   * see `EnsureSlackCliAuthOptions.onInstruction` for why it must exist at all.
   */
  instruction(text: string): void;
  card(lines: readonly string[]): void;
}

export interface SetupDoctorInput {
  profile: ProfileName;
  paths: ProfilePaths;
  runtime: RuntimeInstall;
  baseDirectory: string;
  receipt: ProfileReceipt;
}

/** The subset of Task 9's `ServiceManager` the orchestrator is allowed to touch. */
export interface SetupServiceManager {
  install(): Promise<ServiceStatus>;
  status(): Promise<ServiceStatus>;
}

export interface SetupServiceInput {
  receipt: ProfileReceipt;
  runtime: RuntimeInstall;
  paths: ProfilePaths;
  /** Every other installed profile, for the collision gate. Never empty by default. */
  peers: readonly ProfileReceipt[];
}

export interface SetupDeps {
  host: SetupHost;
  home: string;
  uid: number;
  /** ISO timestamp source for completion receipts. */
  now: () => string;
  requestedProfile?: ProfileName;
  /**
   * Compatibility only. `--resume` and plain `setup` execute the identical
   * function; this field exists so a caller may pass what it parsed without the
   * orchestrator ever branching on it.
   */
  resume?: boolean;
  signal?: AbortSignal;

  discoverRuntimes: () => Promise<RuntimeInstall[]>;
  prompt: SetupPrompt;
  output: SetupOutput;
  workspaceFs: SetupWorkspaceFs;
  createStateStore: (profile: ProfileName, stateDir: string) => SetupStateStore;

  ensureLlmux: (host: SetupHost, options: EnsureLlmuxOptions) => Promise<LlmuxReceipt>;
  ensureSlackCliAuth: (
    host: SetupHost,
    requestedTeam: string | undefined,
    options: EnsureSlackCliAuthOptions,
  ) => Promise<SlackCliAuthReceipt>;
  materializeSlackProject: (
    profile: ProfileName,
    teamId: string,
    runtimeRoot: string,
    options: MaterializeSlackProjectOptions,
  ) => SlackProject;
  captureSlackTokens: (host: SetupHost, options: CaptureAndPersistOptions) => Promise<SlackCaptureReceipt>;
  secretSink: (secretsFile: string) => SlackSecretSink;
  readSlackAppMapping: (projectRoot: string, teamId: string) => SlackAppMapping | null;
  /** `BASE_DIRECTORY` an already-materialized profile declares, or `null`. */
  readExistingBaseDirectory: (configDir: string) => string | null;
  materializeProfile: (input: MaterializeProfileInput) => ProfileReceipt;
  packagedAssets: (runtimeRoot: string) => { defaultConfig: PackagedAsset; systemPrompt: PackagedAsset };
  runDoctor: (input: SetupDoctorInput) => Promise<DoctorReport>;
  createServiceManager: (input: SetupServiceInput) => SetupServiceManager | Promise<SetupServiceManager>;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export interface SetupCompleteOutcome {
  status: 'complete';
  profile: ProfileName;
  appId: string;
  teamId: string;
  runtimeVersion: string;
  service: ServiceStatus;
}

export interface SetupPendingOutcome {
  status: 'pending-slack-approval';
  profile: ProfileName;
  appId: string | null;
  teamId: string;
  step: SetupStep;
}

export type SetupOutcome = SetupCompleteOutcome | SetupPendingOutcome;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

const STEP_ORDER = new Map<string, number>(SETUP_STEPS.map((step, index) => [step, index]));

/**
 * Record `step` as complete and **drop every later marker**.
 *
 * The truncation is the load-bearing half. Steps run in order, so completing
 * step N means the world was just re-validated up to N — and any marker for a
 * step after N was written against a world that may no longer exist (a
 * reinstalled runtime, a rotated credential, a deleted profile). Carrying it
 * forward would report a green service for a profile that has not been
 * materialized yet.
 */
function completeStep(state: SetupState, step: SetupStep, at: string): SetupState {
  const index = STEP_ORDER.get(step) ?? -1;
  const kept: CompletedStepReceipt[] = state.completedSteps.filter((receipt) => {
    const position = STEP_ORDER.get(receipt.step);
    return position !== undefined && position < index;
  });
  kept.push({ step, completedAt: at });
  return { ...state, completedSteps: kept, currentStep: null, lastError: null };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run (or resume) onboarding for one profile.
 *
 * Resolves with {@link SetupCompleteOutcome} when the daemon is live and its
 * post-start doctor is green, or with {@link SetupPendingOutcome} when a Slack
 * workspace admin still has to approve the installation — a *non-error* terminal
 * state that carries the ids a rerun needs and creates nothing further.
 *
 * Rejects with {@link SetupError} for every other failure. The reason reaching
 * disk is always {@link classifySetupFailure}'s classified form.
 */
export async function runSetup(deps: SetupDeps): Promise<SetupOutcome> {
  // --- Step 0: inspect ----------------------------------------------------
  deps.output.step('inspect', 'Inspecting this machine');

  const runtimes = await deps.discoverRuntimes();
  const profile = await resolveSetupProfile(deps, runtimes);
  const runtime = runtimes.find((install) => install.profile === profile);
  if (runtime === undefined) {
    throw new SetupError(
      'inspect',
      'inspect: SetupError',
      `The "${profile}" runtime is not installed. Install it with \`brew install 2lab-ai/tap/${RUNTIME_FORMULAE[profile]}\`, then re-run \`somawork setup\`.`,
    );
  }

  const paths = profilePaths(deps.home, profile);
  const store = deps.createStateStore(profile, paths.stateDir);

  // A persisted state whose profile is not the one we resolved is not this
  // profile's state. It is never adopted and never partially read: the whole
  // document is discarded in favour of a fresh one, so no field (team id, app
  // id, markers) can cross the profile boundary.
  //
  // I-5: and an *unloadable* one is not this profile's state either. The file
  // is advisory by design (see the module header): every step below re-checks
  // the machine live, and `:626` already discards a whole document whose
  // profile does not match. Refusing to run because an advisory file is
  // unparseable — or because it carries a schema version a future release
  // wrote — would make setup permanently unrunnable for that profile, with the
  // generic recovery advice pointing at `somawork setup` itself. So the
  // unusable documents are moved out of the load path (never deleted: they are
  // the only evidence of how it broke) and the run continues from a default.
  // Only the document's own failure family is caught; an EACCES or a symlinked
  // state file still stops the run.
  let persisted: SetupState | null;
  try {
    persisted = store.load();
  } catch (error) {
    if (!isRecoverableSetupStateError(error)) throw error;
    const quarantined = store.quarantine();
    if (quarantined.length > 0) {
      // Paths and one verb only. The caught error's message quotes the parser's
      // complaint about the document, and that document is exactly the thing
      // that may hold credential-shaped bytes.
      deps.output.info(
        `Set aside unusable ${profile} setup state as ${quarantined.join(' and ')}; continuing from a fresh state and re-checking this machine.`,
      );
    }
    persisted = null;
  }
  let state: SetupState =
    persisted !== null && persisted.profile === profile ? persisted : createDefaultSetupState(profile);

  const save = (next: SetupState): void => {
    state = next;
    store.save(next);
  };

  const fail = (step: SetupStep, error: unknown, message: string): never => {
    const summary = classifySetupFailure(step, error);
    try {
      store.save({ ...state, currentStep: step, lastError: summary });
    } catch {
      // A state write that itself fails must not replace the real diagnosis.
    }
    if (error instanceof SetupError) throw error;
    throw new SetupError(step, summary, message);
  };

  save(completeStep(state, 'inspect', deps.now()));

  // --- Step 1: local llmux ------------------------------------------------
  //
  // The endpoint travels from here to Step 4. It is llmux's answer about its
  // own `proxy.port`, and the profile that Step 4 writes is what the service
  // dials forever after — so re-deriving it downstream (or defaulting to 3456)
  // is how a profile ends up pointed at a *different* llmux that happens to own
  // the default port under the same uid.
  deps.output.step('llmux', 'Checking the local llmux daemon');
  let llmuxBaseUrl: string;
  try {
    const receipt = await deps.ensureLlmux(deps.host, {
      signal: deps.signal,
      onProgress: (line) => deps.output.info(line),
    });
    llmuxBaseUrl = receipt.baseUrl;
    deps.output.info(
      `llmux ready at ${receipt.baseUrl}: ${receipt.claudeHealthy} Claude / ${receipt.codexHealthy} Codex account(s).`,
    );
  } catch (error) {
    fail('llmux', error, 'llmux is not ready. Re-run `somawork setup` to resume from this step.');
    throw error; // unreachable; keeps control-flow analysis honest
  }
  save(completeStep(state, 'llmux', deps.now()));

  // --- Step 2: Slack CLI authorization ------------------------------------
  deps.output.step('slack_cli_auth', 'Authorizing the Slack CLI');
  const authReceipt = await authorizeSlackCli(deps, state.slackTeamId ?? undefined, fail);
  save(completeStep({ ...state, slackTeamId: authReceipt.teamId }, 'slack_cli_auth', deps.now()));

  // --- Step 3: Slack app + token capture ----------------------------------
  deps.output.step('slack_app', 'Creating the Slack app and capturing its runtime credentials');
  const teamId = authReceipt.teamId;

  let project: SlackProject;
  try {
    project = deps.materializeSlackProject(profile, teamId, runtime.root, { stateDir: paths.stateDir });
  } catch (error) {
    fail('slack_app', error, 'The Slack project could not be prepared. Re-run `somawork setup` to resume.');
    throw error; // unreachable; keeps control-flow analysis honest
  }

  const slackBin = await deps.host.which(SLACK_BIN);
  if (slackBin === null) {
    fail(
      'slack_app',
      new Error('slack-cli-missing'),
      'The Slack CLI (`slack`) is not on PATH. Install it, open a new shell, then re-run `somawork setup`.',
    );
  }

  let approvalPending = false;
  let capture: SlackCaptureReceipt;
  try {
    capture = await deps.captureSlackTokens(deps.host, {
      project,
      slackBin: slackBin as string,
      secretStore: deps.secretSink(paths.secretsFile),
      signal: deps.signal,
      onProgress: (chunk: string) => {
        for (const line of String(chunk).split('\n')) {
          if (isSlackApprovalPendingLine(line)) approvalPending = true;
        }
        deps.output.info(String(chunk));
      },
    });
  } catch (error) {
    // Whether the app itself exists is answered by re-reading the mapping the
    // Slack CLI wrote, not by trusting the failure: a capture can fail long
    // after the app was created, and a rerun must link to it rather than make
    // a second one.
    const mapping = safeReadMapping(deps, project, teamId);
    const nextState: SetupState = {
      ...state,
      slackTeamId: teamId,
      ...(mapping === null ? {} : { slackAppId: mapping.appId }),
    };

    if (approvalPending) {
      // Not an error: a workspace admin has to click approve. Persist the ids,
      // say so once, and stop. Nothing further is created or mutated.
      try {
        store.save({ ...nextState, currentStep: 'slack_app', lastError: null });
        state = { ...nextState, currentStep: 'slack_app', lastError: null };
      } catch {
        // The instruction below is still correct without a state write.
      }
      deps.output.info(
        'This Slack workspace requires an admin to approve the installation. Once it is approved, re-run `somawork setup` — it resumes here and will not create another app.',
      );
      return {
        status: 'pending-slack-approval',
        profile,
        appId: mapping?.appId ?? state.slackAppId ?? null,
        teamId,
        step: 'slack_app',
      };
    }

    state = nextState;
    fail('slack_app', error, 'Capturing the Slack runtime credentials failed. Re-run `somawork setup` to resume.');
    throw error; // unreachable
  }

  save(completeStep({ ...state, slackAppId: capture.appId, slackTeamId: capture.teamId }, 'slack_app', deps.now()));

  // --- Step 4: profile materialization ------------------------------------
  deps.output.step('profile', 'Writing the profile');
  let receipt: ProfileReceipt;
  try {
    const existing = deps.readExistingBaseDirectory(paths.configDir);
    const baseDirectory = resolveBaseDirectory({
      fs: deps.workspaceFs,
      dataDir: paths.dataDir,
      ...(existing === null ? {} : { selected: existing }),
    });
    const assets = deps.packagedAssets(runtime.root);
    receipt = deps.materializeProfile({
      profile,
      paths,
      runtime,
      baseDirectory,
      llmuxBaseUrl,
      slack: { appId: capture.appId, teamId: capture.teamId },
      defaultConfig: assets.defaultConfig,
      systemPrompt: assets.systemPrompt,
    });
  } catch (error) {
    fail('profile', error, 'Writing the profile failed; the previous profile was left untouched.');
    throw error; // unreachable
  }
  save(completeStep(state, 'profile', deps.now()));

  // --- Step 5: doctor -----------------------------------------------------
  deps.output.step('doctor', 'Running pre-service checks');
  let report: DoctorReport;
  try {
    report = await deps.runDoctor({ profile, paths, runtime, baseDirectory: receipt.baseDirectory, receipt });
  } catch (error) {
    fail('doctor', error, 'The pre-service checks could not be completed.');
    throw error; // unreachable
  }
  if (!report.ok) {
    // Check ids are a fixed vocabulary written in `doctor.ts` and carry no path,
    // credential, or provider text — they are the one detail safe to echo.
    const failed = report.checks.filter((check) => check.status === 'fail').map((check) => check.id);
    fail(
      'doctor',
      new Error('doctor-failed'),
      `The service was not installed because these checks failed: ${failed.join(', ')}. Run \`somawork doctor\` for the details.`,
    );
  }
  save(completeStep(state, 'doctor', deps.now()));

  // --- Step 6: service ----------------------------------------------------
  deps.output.step('service', 'Installing and starting the background service');
  let manager: SetupServiceManager;
  try {
    manager = await deps.createServiceManager({
      receipt,
      runtime,
      paths,
      peers: buildPeerReceipts({ home: deps.home, profile, runtimes }),
    });
    // Task 9 owns cached-plist replacement, launchd/headless activation,
    // instance-bound readiness, its own post-start doctor, and rollback. The
    // marker below is written only against the receipt it returns.
    await manager.install();
  } catch (error) {
    fail('service', error, 'The background service did not come up; the previous service state was restored.');
    throw error; // unreachable
  }
  save(completeStep(state, 'service', deps.now()));

  // --- Step 7: post-start doctor ------------------------------------------
  deps.output.step('post_start_doctor', 'Confirming the running service');
  let live: ServiceStatus;
  try {
    // Read-only re-probe. `install()` already started the daemon and ran its own
    // post-start doctor; starting a second process here would be a duplicate
    // Socket Mode connection, which is exactly what Task 9's gate prevents.
    live = await manager.status();
  } catch (error) {
    fail('post_start_doctor', error, 'The service status could not be read back.');
    throw error; // unreachable
  }
  if (!live.ready || (live.state !== 'running-launchd' && live.state !== 'running-headless')) {
    fail(
      'post_start_doctor',
      new Error('service-not-ready'),
      'The service was installed but is not reporting ready. Run `somawork service status` and `somawork doctor`.',
    );
  }
  save(completeStep(state, 'post_start_doctor', deps.now()));

  deps.output.card([
    `Profile        ${profile}`,
    `Runtime        ${runtime.version}`,
    `Workspace      ${receipt.baseDirectory}`,
    `Slack app      ${capture.appId} (team ${capture.teamId})`,
    `Service        ${live.label} (${live.state})`,
    '',
    `Status         somawork status --profile ${profile}`,
    `Diagnostics    somawork doctor --profile ${profile}`,
    `Logs           ${live.logDir}`,
  ]);

  return {
    status: 'complete',
    profile,
    appId: capture.appId,
    teamId: capture.teamId,
    runtimeVersion: runtime.version,
    service: live,
  };
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the profile, spending at most one prompt.
 *
 * `resolveProfile` in `profile.ts` remains the authority for the explicit and
 * single-runtime cases; the only thing added here is the *one* question the
 * ambiguous case is allowed to ask.
 */
async function resolveSetupProfile(deps: SetupDeps, runtimes: readonly RuntimeInstall[]): Promise<ProfileName> {
  const requested = deps.requestedProfile;
  if (requested !== undefined) {
    if (!isProfileName(requested)) {
      throw new SetupError('inspect', 'inspect: SetupError', `Invalid profile "${String(requested)}".`);
    }
    return requested;
  }

  const distinct = Array.from(new Set(runtimes.map((install) => install.profile)));

  if (distinct.length === 0) {
    throw new SetupError(
      'inspect',
      'inspect: SetupError',
      'No somawork runtime is installed. Install one with `brew install 2lab-ai/tap/somawork` (or `somawork-preview`), then re-run `somawork setup`.',
    );
  }

  if (distinct.length === 1) return distinct[0];

  const chosen = await deps.prompt.choose(
    'Which profile do you want to set up?',
    distinct.map((name) => ({ value: name, label: name })),
  );
  if (!isProfileName(chosen)) {
    throw new SetupError('inspect', 'inspect: SetupError', `"${String(chosen)}" is not a profile.`);
  }
  return chosen;
}

/**
 * Authorize the Slack CLI, asking at most one workspace question.
 *
 * The retry is bounded to exactly one round: the adapter's ambiguity errors
 * carry their candidates, so a chosen team either resolves or it is a real
 * failure. A loop here would turn a mis-listed workspace into an infinite prompt.
 */
async function authorizeSlackCli(
  deps: SetupDeps,
  persistedTeam: string | undefined,
  fail: (step: SetupStep, error: unknown, message: string) => never,
): Promise<SlackCliAuthReceipt> {
  const options: EnsureSlackCliAuthOptions = {
    signal: deps.signal,
    onInstruction: (text) => deps.output.instruction(text),
  };

  try {
    return await deps.ensureSlackCliAuth(deps.host, persistedTeam, options);
  } catch (error) {
    const candidates = ambiguityCandidates(error);
    if (candidates === null || candidates.length === 0) {
      fail('slack_cli_auth', error, 'Authorizing the Slack CLI failed. Re-run `somawork setup` to resume.');
    }

    const chosen = await deps.prompt.choose(
      'Which Slack workspace should somawork use?',
      (candidates as readonly SlackAuthCandidate[]).map((candidate) => ({
        value: candidate.teamId,
        label: `${candidate.domain} (${candidate.teamId})`,
      })),
    );

    try {
      return await deps.ensureSlackCliAuth(deps.host, chosen, options);
    } catch (retryError) {
      fail('slack_cli_auth', retryError, 'The selected Slack workspace could not be used. Re-run `somawork setup`.');
      throw retryError; // unreachable
    }
  }
}

function ambiguityCandidates(error: unknown): readonly SlackAuthCandidate[] | null {
  if (error instanceof SlackAuthSelectionRequiredError || error instanceof SlackAuthTeamNotFoundError) {
    return error.candidates;
  }
  return null;
}

function safeReadMapping(deps: SetupDeps, project: SlackProject, teamId: string): SlackAppMapping | null {
  try {
    return deps.readSlackAppMapping(project.root, teamId);
  } catch {
    return null;
  }
}

/** Re-exported so `index.ts` can build the doctor's secret reader without a second import path. */
export type SetupSecretValues = SecretValues;
