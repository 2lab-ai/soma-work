/**
 * `somawork doctor` — the gate that must be green before a service is installed
 * (design §5 Step 5).
 *
 * ## Two properties this module is built around
 *
 * **1. It is a pure function of injected seams.** `runDoctor` performs no
 * network call, spawns no process, and reads no ambient global. Every effect —
 * the llmux fetch, the two Slack probes, the filesystem, the secret store, the
 * config load — arrives in {@link DoctorDeps}. That makes the security
 * assertions below testable as *behaviour* (a probe seam that really returns a
 * `wss://` URL, a seam that really throws an error containing a credential)
 * rather than as source greps.
 *
 * **2. Nothing observed becomes output.** A check's `detail` is chosen from a
 * fixed vocabulary written in this file. No value read from a secret store, a
 * Slack response, an llmux document, a filesystem path, or a caught exception
 * is ever interpolated into a detail, a report field, or a log line. The
 * consequences are deliberate and unusual:
 *
 * - The app-token probe seam returns `{ ok: boolean }` and nothing else. Slack's
 *   `apps.connections.open` response body carries a single-use `wss://` URL
 *   that is itself a credential; reducing at the seam means the URL has no
 *   representation inside this module to leak, and the default seam never
 *   connects to it.
 * - The bot probe seam returns `{ ok, fatalAuth }`, discarding
 *   `probeSlackApi`'s `message`/`user`/`team`/`botId` — the classification is
 *   reused, the workspace identity is not imported.
 * - Every check is individually wrapped: one seam throwing produces one `fail`
 *   with a fixed detail, and the remaining checks still run. A truncated report
 *   would read as "fewer problems", which is the wrong direction to fail in.
 * - Details carry no filesystem paths, so `doctor --json` is safe to paste into
 *   an issue or a CI receipt without redacting a home directory.
 *
 * The report is additionally run through the setup-state secret gate
 * (`assertSecretFree`) before it is returned, so a future field that breaks any
 * of the above fails here rather than in a caller's state write.
 */

import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { isProfileName, type ProfileName, type ProfilePaths, type RuntimeInstall } from './profile';
import { classifyLlmuxGroups, type LlmuxGroup, type LlmuxGroupCondition } from './setup/llmux';
import { DEFAULT_LLMUX_BASE_URL, LlmuxEndpointError, validateLlmuxBaseUrl } from './setup/llmux-endpoint';
import {
  RUNTIME_CONFIG_FILENAME,
  RUNTIME_DATA_DIRNAME,
  RUNTIME_ENV_FILENAME,
  RUNTIME_PROMPT_FILENAME,
} from './setup/materialize';
import type { SecretValues } from './setup/secrets';
import { assertSecretFree } from './setup/state';

/**
 * Stable check identifiers, in report order.
 *
 * Snake-case and deliberately free of `auth`/`token`/`secret`/`code`: these ids
 * are persisted in setup state and printed in CI receipts, and the setup-state
 * gate rejects credential-shaped *field names* as well as values.
 */
export const DOCTOR_CHECK_IDS = [
  'llmux',
  'llmux_claude',
  'llmux_codex',
  'slack_bot',
  'slack_socket',
  'base_directory',
  'profile_permissions',
  'runtime',
  'config',
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

/**
 * `pass` — the requirement is met.
 * `warn` — met, with a non-blocking deviation worth telling the operator about.
 * `fail` — not met; the service must not be installed or started.
 */
export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: DoctorCheckId;
  status: DoctorStatus;
  /** Fixed, path-free, credential-free explanation. */
  detail: string;
}

export interface DoctorReport {
  profile: ProfileName;
  /** True when no check failed. This is the service-install gate. */
  ok: boolean;
  checks: DoctorCheck[];
}

/** Metadata for one file the packaged runtime must ship. */
export interface DoctorRuntimeAsset {
  /** Path relative to the runtime root, e.g. `dist/index.js`. */
  path: string;
  /** A missing required asset fails; a missing optional asset warns. */
  required: boolean;
}

/** `lstat` projection — symlinks are reported, never followed. */
export interface DoctorStat {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  /** Permission bits only (`mode & 0o7777`). */
  mode: number;
  uid: number;
}

/**
 * Read-only filesystem facade.
 *
 * Read-only by construction: there is no write method, so a check cannot
 * "verify writability" by creating a probe file inside a profile the operator
 * is asking us to diagnose.
 */
export interface DoctorFileSystem {
  /**
   * `lstat` projection — a symlink reports as a symlink. Used everywhere a
   * symlink is itself the defect (profile directories, materialized files).
   * `null` when the path does not exist.
   */
  stat(target: string): Promise<DoctorStat | null>;
  /**
   * `stat` projection — symlinks are followed. Used only for the base
   * directory, which an operator may legitimately point at another volume
   * through a link. `null` when the path (or its target) does not exist.
   */
  statFollow(target: string): Promise<DoctorStat | null>;
  canWrite(target: string): Promise<boolean>;
  canEnter(target: string): Promise<boolean>;
  /** `null` when the path does not exist or cannot be read. */
  readFile(target: string): Promise<string | null>;
}

/** Reduced `probeSlackApi` outcome. Identity fields are dropped at the seam. */
export interface DoctorBotProbeResult {
  ok: boolean;
  /** True only for a genuine credential rejection, never for a transient fault. */
  fatalAuth: boolean;
}

/**
 * Why an `apps.connections.open` probe did not succeed. A closed vocabulary,
 * never a response body or an error message.
 *
 * The distinction is load-bearing, not cosmetic. Slack answers an
 * authentication failure with **HTTP 200 and `{"ok":false,"error":"..."}`**, so
 * a non-2xx status, an HTML body from a captive portal, or a timeout means the
 * credential was never evaluated at all. Collapsing those into "rejected"
 * tells an operator behind a proxy — or one caught in a Slack incident — to
 * revoke and regenerate a perfectly healthy `xapp-` token.
 */
export type DoctorSocketProbeReason = 'rejected' | 'transport';

/** Reduced `apps.connections.open` outcome. The returned URL is discarded at the seam. */
export interface DoctorSocketProbeResult {
  ok: boolean;
  /** Present only when `ok` is false. `rejected` requires a 2xx JSON `ok:false`. */
  reason?: DoctorSocketProbeReason;
}

/** Outcome of loading and substituting a profile's `config.json`. */
export interface DoctorConfigLoadResult {
  /**
   * False when the config failed to load for ANY reason.
   *
   * Required, and separate from {@link DoctorConfigLoadResult.missing},
   * because the two failure modes are disjoint: `${VAR:?msg}` *throws* inside
   * the substitution pass, which happens before the missing-placeholder list
   * is produced, so a required-placeholder failure reports `missing: []`. A
   * seam that only reported the list would answer "nothing unresolved" for the
   * config the runtime just failed to load — a false green on the gate that
   * authorizes the service install. The same applies to a malformed document
   * and to plugin/agent validation errors.
   */
  loaded: boolean;
  /** Names of bare `${VAR}` placeholders that did not resolve against the given env. */
  missing: string[];
}

export interface DoctorDeps {
  paths: ProfilePaths;
  runtime: RuntimeInstall;
  baseDirectory: string;
  /** Uid the profile is expected to be owned by. Injected, not read from `process`. */
  uid: number;
  runtimeAssets: readonly DoctorRuntimeAsset[];
  fs: DoctorFileSystem;
  /** Reads the profile's `secrets.env`. May throw; the caller isolates it. */
  readSecrets: () => SecretValues;
  probeSlackBot: (botToken: string) => Promise<DoctorBotProbeResult>;
  /** MUST reduce the response to `{ ok }` and MUST NOT connect to the returned URL. */
  openSlackSocket: (appToken: string) => Promise<DoctorSocketProbeResult>;
  fetchLlmuxStatus: () => Promise<unknown>;
  loadConfigFile: (
    configFile: string,
    env: Record<string, string | undefined>,
  ) => DoctorConfigLoadResult | Promise<DoctorConfigLoadResult>;
}

// ---------------------------------------------------------------------------
// Fixed detail vocabulary
// ---------------------------------------------------------------------------

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/**
 * Shortest stored value the cross-file leak scan will search for. Every real
 * Slack credential is far longer; anything shorter is a placeholder or a
 * truncated paste, and searching for it produces false positives.
 */
const MIN_SCANNABLE_SECRET_LENGTH = 12;

const GROUP_LABEL: Record<LlmuxGroup, string> = { claude: 'Claude', codex: 'Codex' };

function groupDetail(group: LlmuxGroup, condition: LlmuxGroupCondition): { status: DoctorStatus; detail: string } {
  const label = GROUP_LABEL[group];
  switch (condition) {
    case 'healthy':
      return { status: 'pass', detail: `at least one usable ${label} account is available` };
    case 'absent':
      return { status: 'fail', detail: `no ${label} account is configured in llmux` };
    case 'auth-failed':
      return { status: 'fail', detail: `every ${label} account needs to be signed in again` };
    case 'cooldown':
      return { status: 'fail', detail: `every ${label} account is rate-limited (cooldown); wait for the reset` };
  }
}

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

interface CheckOutcome {
  status: DoctorStatus;
  detail: string;
}

/**
 * Run one check, converting any throw into a fixed failure.
 *
 * `err` is intentionally not inspected. A seam's exception message is the most
 * likely place for a credential to appear — `llmux unreachable at <url>` and
 * Slack client errors both embed request context — so the only safe reduction
 * is to drop it entirely and report the check-specific fallback detail.
 */
async function runCheck(
  id: DoctorCheckId,
  fallbackDetail: string,
  body: () => Promise<CheckOutcome>,
): Promise<DoctorCheck> {
  try {
    const outcome = await body();
    return { id, status: outcome.status, detail: outcome.detail };
  } catch {
    return { id, status: 'fail', detail: fallbackDetail };
  }
}

/** Worst of a set of outcomes, with `fail` dominating `warn` dominating `pass`. */
function worst(outcomes: readonly CheckOutcome[], passDetail: string): CheckOutcome {
  const failed = outcomes.find((o) => o.status === 'fail');
  if (failed) return failed;
  const warned = outcomes.find((o) => o.status === 'warn');
  if (warned) return warned;
  return { status: 'pass', detail: passDetail };
}

async function checkDirectory(
  fsFacade: DoctorFileSystem,
  target: string,
  label: string,
  uid: number,
): Promise<CheckOutcome[]> {
  const stat = await fsFacade.stat(target);
  if (stat === null) return [{ status: 'fail', detail: `the ${label} does not exist` }];
  if (stat.isSymbolicLink) return [{ status: 'fail', detail: `the ${label} is a symlink` }];
  if (!stat.isDirectory) return [{ status: 'fail', detail: `the ${label} is not a directory` }];
  if (stat.uid !== uid) return [{ status: 'fail', detail: `the ${label} is owned by another user` }];
  if ((stat.mode & 0o777) !== DIR_MODE) {
    return [{ status: 'fail', detail: `the ${label} is not owner-only (expected mode 700)` }];
  }
  if (!(await fsFacade.canWrite(target)) || !(await fsFacade.canEnter(target))) {
    return [{ status: 'fail', detail: `the ${label} is not writable` }];
  }
  return [];
}

async function checkSecretFileMode(
  fsFacade: DoctorFileSystem,
  target: string,
  uid: number,
  required: boolean,
): Promise<CheckOutcome[]> {
  const stat = await fsFacade.stat(target);
  if (stat === null) {
    return required ? [{ status: 'fail', detail: 'the profile credential file has not been written yet' }] : [];
  }
  if (stat.isSymbolicLink) return [{ status: 'fail', detail: 'the profile credential file is a symlink' }];
  if (!stat.isFile) return [{ status: 'fail', detail: 'the profile credential file is not a regular file' }];
  if (stat.uid !== uid) return [{ status: 'fail', detail: 'the profile credential file is owned by another user' }];
  if ((stat.mode & 0o777) !== FILE_MODE) {
    return [{ status: 'fail', detail: 'the profile credential file is not owner-only (expected mode 600)' }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Diagnose `profile` against `deps` and return a secret-safe report.
 *
 * Checks run in {@link DOCTOR_CHECK_IDS} order and every one of them runs: a
 * failure never short-circuits the rest, so a single report shows the full set
 * of things an operator has to fix.
 */
export async function runDoctor(profile: ProfileName, deps: DoctorDeps): Promise<DoctorReport> {
  if (typeof profile !== 'string' || !isProfileName(profile)) {
    throw new TypeError('runDoctor requires a valid profile name.');
  }
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('runDoctor requires an explicit dependency set.');
  }

  const { fs: fsFacade, paths, runtime, uid } = deps;
  const checks: DoctorCheck[] = [];

  // Secrets are read at most once and the values never leave the closures that
  // hand them to a seam. `null` means "unreadable", which the Slack checks fail
  // on rather than guess about.
  let secretsCache: SecretValues | null | undefined;
  const secrets = (): SecretValues | null => {
    if (secretsCache === undefined) {
      try {
        secretsCache = deps.readSecrets();
      } catch {
        secretsCache = null;
      }
    }
    return secretsCache;
  };

  // ---- llmux ------------------------------------------------------------
  let groups: Array<{ group: LlmuxGroup; condition: LlmuxGroupCondition }> | null = null;
  checks.push(
    await runCheck('llmux', 'the llmux daemon is unreachable', async () => {
      let document: unknown;
      try {
        document = await deps.fetchLlmuxStatus();
      } catch (err) {
        // The one seam failure worth naming separately: nothing was contacted,
        // so "unreachable" would send the operator to check a daemon that is
        // probably fine. Covers both an endpoint the profile named and refused
        // (not a loopback http origin) and one it never named at all — the same
        // fix answers both, and the detail deliberately carries no URL, no path
        // and no hint of which of the two it was.
        if (err instanceof LlmuxEndpointError) {
          return {
            status: 'fail',
            detail: 'no supported local llmux endpoint is configured for this profile',
          };
        }
        throw err;
      }
      groups = classifyLlmuxGroups(document);
      return { status: 'pass', detail: 'the llmux daemon responded with a recognized status document' };
    }),
  );

  for (const group of ['claude', 'codex'] as const) {
    const id: DoctorCheckId = group === 'claude' ? 'llmux_claude' : 'llmux_codex';
    checks.push(
      await runCheck(id, `the ${GROUP_LABEL[group]} account group could not be read`, async () => {
        if (groups === null) {
          return { status: 'fail', detail: 'the llmux account status is unavailable' };
        }
        const report = groups.find((g) => g.group === group);
        if (report === undefined) {
          return { status: 'fail', detail: `no ${GROUP_LABEL[group]} account is configured in llmux` };
        }
        return groupDetail(group, report.condition);
      }),
    );
  }

  // ---- Slack ------------------------------------------------------------
  checks.push(
    await runCheck('slack_bot', 'the Slack bot credential could not be verified', async () => {
      const values = secrets();
      if (values === null) return { status: 'fail', detail: 'the profile credential file could not be read' };
      const botToken = values.SLACK_BOT_TOKEN;
      if (botToken === undefined || botToken.length === 0) {
        return { status: 'fail', detail: 'no Slack bot credential has been captured for this profile' };
      }
      if (!botToken.startsWith('xoxb-')) {
        return { status: 'fail', detail: 'the stored Slack bot credential does not have the expected prefix' };
      }
      const probe = await deps.probeSlackBot(botToken);
      if (probe.ok) return { status: 'pass', detail: 'the Slack bot credential was accepted' };
      if (probe.fatalAuth) {
        return { status: 'fail', detail: 'the Slack bot credential was rejected as invalid, revoked, or inactive' };
      }
      // Mandatory check: an exhausted transient failure still blocks the
      // service, but the detail says "unavailable" so the operator retries
      // instead of regenerating a credential that is probably fine.
      return { status: 'fail', detail: 'the Slack API was unavailable after retries; re-run when it recovers' };
    }),
  );

  checks.push(
    await runCheck('slack_socket', 'the Slack socket connection could not be verified', async () => {
      const values = secrets();
      if (values === null) return { status: 'fail', detail: 'the profile credential file could not be read' };
      const appToken = values.SLACK_APP_TOKEN;
      if (appToken === undefined || appToken.length === 0) {
        return { status: 'fail', detail: 'no Slack app-level credential has been captured for this profile' };
      }
      if (!appToken.startsWith('xapp-')) {
        return { status: 'fail', detail: 'the stored Slack app-level credential does not have the expected prefix' };
      }
      // The seam yields `{ ok }` only. Nothing here can observe, retain, log,
      // or dial the socket URL Slack returns.
      const probe = await deps.openSlackSocket(appToken);
      if (probe.ok) {
        return { status: 'pass', detail: 'apps.connections.open accepted the Slack app-level credential' };
      }
      // "Rejected" is claimed ONLY for a verdict Slack actually issued.
      if (probe.reason === 'rejected') {
        return { status: 'fail', detail: 'apps.connections.open rejected the Slack app-level credential' };
      }
      return {
        status: 'fail',
        detail:
          'the Slack socket endpoint was unavailable, so the app-level credential was not checked; re-run when it recovers',
      };
    }),
  );

  // ---- base directory ---------------------------------------------------
  checks.push(
    await runCheck('base_directory', 'the base directory could not be inspected', async () => {
      const target = deps.baseDirectory;
      // Followed, not lstat'd: unlike the profile directories, a base directory
      // reached through a symlink (a workspace parked on another volume) is a
      // supported operator setup, not a tampering signal.
      const stat = await fsFacade.statFollow(target);
      if (stat === null) return { status: 'fail', detail: 'the base directory does not exist' };
      if (!stat.isDirectory) {
        return { status: 'fail', detail: 'the base directory is not a directory' };
      }
      if (!(await fsFacade.canWrite(target)) || !(await fsFacade.canEnter(target))) {
        return { status: 'fail', detail: 'the base directory is not writable' };
      }
      return { status: 'pass', detail: 'the base directory exists and is writable' };
    }),
  );

  // ---- profile permissions ---------------------------------------------
  checks.push(
    await runCheck('profile_permissions', 'the profile directories could not be inspected', async () => {
      const outcomes: CheckOutcome[] = [];
      outcomes.push(...(await checkDirectory(fsFacade, paths.configDir, 'profile config directory', uid)));
      outcomes.push(...(await checkDirectory(fsFacade, paths.stateDir, 'profile state directory', uid)));
      outcomes.push(...(await checkDirectory(fsFacade, paths.dataDir, 'profile data directory', uid)));
      outcomes.push(
        ...(await checkDirectory(
          fsFacade,
          path.join(paths.configDir, RUNTIME_DATA_DIRNAME),
          'profile runtime data directory',
          uid,
        )),
      );
      outcomes.push(...(await checkSecretFileMode(fsFacade, paths.secretsFile, uid, true)));
      // `SecretStore` keeps the previous credentials at `<file>.bak` on every
      // write, so the backup holds live secrets too. It is checked when it
      // exists and ignored when it does not — a profile written exactly once
      // legitimately has none.
      outcomes.push(...(await checkSecretFileMode(fsFacade, `${paths.secretsFile}.bak`, uid, false)));
      return worst(outcomes, 'profile directories are owner-only and the credential files are mode 600');
    }),
  );

  // ---- runtime ----------------------------------------------------------
  checks.push(
    await runCheck('runtime', 'the runtime install could not be inspected', async () => {
      if (runtime.profile !== profile) {
        return { status: 'fail', detail: 'the installed runtime belongs to a different profile' };
      }
      const rootStat = await fsFacade.stat(runtime.root);
      if (rootStat === null) return { status: 'fail', detail: 'the runtime install directory does not exist' };
      if (!rootStat.isDirectory) return { status: 'fail', detail: 'the runtime install path is not a directory' };

      const assets = deps.runtimeAssets ?? [];
      if (assets.length === 0) {
        // Without an asset list this check degenerates to "a directory exists
        // with the right profile label", which is not what `runtime: pass`
        // claims. Warn so the missing list is visible rather than silently
        // weakening the gate.
        return {
          status: 'warn',
          detail: 'no runtime program files were listed, so only the install directory was checked',
        };
      }

      const outcomes: CheckOutcome[] = [];
      for (const asset of assets) {
        const stat = await fsFacade.stat(path.join(runtime.root, asset.path));
        if (stat !== null && stat.isFile) continue;
        outcomes.push(
          asset.required
            ? { status: 'fail', detail: 'the runtime install is missing a required program file' }
            : { status: 'warn', detail: 'the runtime install is missing an optional program file' },
        );
      }
      return worst(outcomes, 'the runtime install is present and matches this profile');
    }),
  );

  // ---- config -----------------------------------------------------------
  checks.push(
    await runCheck('config', 'the profile configuration could not be inspected', async () => {
      const envFile = path.join(paths.configDir, RUNTIME_ENV_FILENAME);
      const configFile = path.join(paths.configDir, RUNTIME_CONFIG_FILENAME);
      const promptFile = path.join(paths.configDir, RUNTIME_PROMPT_FILENAME);

      const artifacts: Array<[string, string]> = [
        [envFile, 'environment file'],
        [configFile, 'config file'],
        [promptFile, 'system prompt file'],
      ];
      const outcomes: CheckOutcome[] = [];
      for (const [target, label] of artifacts) {
        const stat = await fsFacade.stat(target);
        if (stat === null) {
          outcomes.push({ status: 'fail', detail: `the profile ${label} has not been written` });
          continue;
        }
        if (!stat.isFile || stat.isSymbolicLink) {
          outcomes.push({ status: 'fail', detail: `the profile ${label} is not a regular file` });
          continue;
        }
        if ((stat.mode & 0o777) !== FILE_MODE) {
          outcomes.push({ status: 'fail', detail: `the profile ${label} is not owner-only (expected mode 600)` });
        }
      }
      const artifactFailure = outcomes.find((o) => o.status === 'fail');
      if (artifactFailure !== undefined) return artifactFailure;

      const envText = await fsFacade.readFile(envFile);
      const configText = await fsFacade.readFile(configFile);
      const promptText = await fsFacade.readFile(promptFile);
      if (envText === null || configText === null || promptText === null) {
        return { status: 'fail', detail: 'a profile configuration file could not be read' };
      }

      try {
        const parsed: unknown = JSON.parse(configText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { status: 'fail', detail: 'the profile config file is not a JSON object' };
        }
      } catch {
        return { status: 'fail', detail: 'the profile config file is not valid JSON' };
      }

      // A merged view of what the service will actually see, built with
      // dotenv's own parser and NEVER installed into `process.env`: doctor may
      // be diagnosing a profile other than the one this process runs under, and
      // loading a profile's credentials into the controller's environment would
      // be the leak the whole capture path exists to avoid.
      const values = secrets();
      const env: Record<string, string | undefined> = { ...dotenv.parse(envText), ...(values ?? {}) };
      const load = await deps.loadConfigFile(configFile, env);
      if (!load.loaded) {
        return { status: 'fail', detail: 'the profile config file could not be loaded by the runtime loader' };
      }
      if (load.missing.length > 0) {
        return { status: 'fail', detail: 'the profile config file has placeholders that do not resolve' };
      }

      // Cross-file leak scan: a credential is allowed in exactly one file.
      //
      // Bounded below because a substring search is the wrong tool for short
      // strings: a truncated or placeholder credential of a few characters
      // would match ordinary `.env` or prompt text and fail the profile for no
      // reason. The bound is what makes the check's positives trustworthy; it
      // also bounds what the check can find — a transformed copy (base64,
      // URL-encoded, partial) is missed by construction, so this is a
      // byte-copy tripwire, not a leak detector.
      if (values !== null) {
        for (const value of Object.values(values)) {
          if (value === undefined || value.length < MIN_SCANNABLE_SECRET_LENGTH) continue;
          if (envText.includes(value) || configText.includes(value) || promptText.includes(value)) {
            return { status: 'fail', detail: 'a stored credential was found in a non-credential profile file' };
          }
        }
      }

      if (promptText.trim().length === 0) {
        return { status: 'warn', detail: 'the profile system prompt is empty' };
      }
      return { status: 'pass', detail: 'the profile configuration parses and resolves' };
    }),
  );

  const report: DoctorReport = {
    profile,
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
  };
  assertSecretFree(report, 'doctorReport');
  return report;
}

/** Serialize `report` for `doctor --json`. Emits exactly the report fields. */
export function doctorReportToJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      profile: report.profile,
      ok: report.ok,
      checks: report.checks.map((check) => ({ id: check.id, status: check.status, detail: check.detail })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Default seam implementations
// ---------------------------------------------------------------------------

/** Node-backed {@link DoctorFileSystem}. `lstat`-based: symlinks are reported, not followed. */
export function createNodeDoctorFileSystem(): DoctorFileSystem {
  const project = (stats: fs.Stats): DoctorStat => ({
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymbolicLink: stats.isSymbolicLink(),
    mode: stats.mode & 0o7777,
    uid: stats.uid,
  });

  return {
    async stat(target: string): Promise<DoctorStat | null> {
      try {
        return project(await fs.promises.lstat(target));
      } catch {
        return null;
      }
    },
    async statFollow(target: string): Promise<DoctorStat | null> {
      try {
        return project(await fs.promises.stat(target));
      } catch {
        return null;
      }
    },
    async canWrite(target: string): Promise<boolean> {
      try {
        await fs.promises.access(target, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    async canEnter(target: string): Promise<boolean> {
      try {
        await fs.promises.access(target, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async readFile(target: string): Promise<string | null> {
      try {
        return await fs.promises.readFile(target, 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

/** Slack's `apps.connections.open` endpoint. */
export const SLACK_CONNECTIONS_OPEN_URL = 'https://slack.com/api/apps.connections.open';
/**
 * Cap on the socket probe.
 *
 * `doctor` runs inside `somawork setup`, in front of a waiting human. Without a
 * deadline a black-holed connection parks the gate on undici's default header
 * timeout (minutes) with no output. The llmux client next door already bounds
 * its own requests the same way.
 */
export const SLACK_SOCKET_PROBE_TIMEOUT_MS = 10_000;

/** Injection points for {@link openSlackSocketProbe}. Both default to the real thing. */
export interface SlackSocketProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * `apps.connections.open` seam.
 *
 * A direct request rather than `WebClient` on purpose: the Slack client logs
 * request/response context through its own logger, and the response body here
 * contains a single-use socket URL. Only `ok` is ever read; everything else —
 * the URL included — goes out of scope unreferenced, so there is no value in
 * this function that a logger or a report could pick up. The credential
 * travels in the `Authorization` header, never in the URL, the body, or argv,
 * and the returned socket is never dialed.
 *
 * Never throws. Every failure shape is reduced to `{ok:false}` with a reason
 * from the closed {@link DoctorSocketProbeReason} vocabulary:
 *
 * | shape                                        | reason      |
 * |----------------------------------------------|-------------|
 * | 2xx JSON body with `ok:false`                | `rejected`  |
 * | non-2xx status (body never parsed)           | `transport` |
 * | 2xx body that is not JSON                    | `transport` |
 * | deadline elapsed, or the transport threw     | `transport` |
 *
 * Only the first row is a verdict about the credential; Slack issues those at
 * HTTP 200. The rest mean the credential was not evaluated, and the caller
 * must not describe them as a rejection.
 */
export async function openSlackSocketProbe(
  appToken: string,
  options: SlackSocketProbeOptions = {},
): Promise<DoctorSocketProbeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  // Tagged reason per the B-2 invariant (`src/__tests__/no-untagged-abort.test.ts`).
  // A fixed literal: the reason surfaces as the fetch rejection, and this
  // request's context is a credential.
  const timer = setTimeout(
    () => controller.abort('slack-socket-probe-timeout'),
    options.timeoutMs ?? SLACK_SOCKET_PROBE_TIMEOUT_MS,
  );
  try {
    let response: Response;
    try {
      response = await doFetch(SLACK_CONNECTIONS_OPEN_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${appToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        signal: controller.signal,
      });
    } catch {
      // Timeout (our own abort) or a network fault. The rejection may embed
      // request context, so it is discarded rather than inspected.
      return { ok: false, reason: 'transport' };
    }
    // Deliberately before any body read: an intercepting proxy's HTML error
    // page must not reach a JSON parser, and a non-2xx is never an auth verdict.
    if (!response.ok) return { ok: false, reason: 'transport' };
    let body: { ok?: unknown };
    try {
      body = (await response.json()) as { ok?: unknown };
    } catch {
      return { ok: false, reason: 'transport' };
    }
    return body?.ok === true ? { ok: true } : { ok: false, reason: 'rejected' };
  } finally {
    clearTimeout(timer);
  }
}

/** What {@link createDefaultDoctorDeps} cannot derive on its own. */
export interface DefaultDoctorDepsOptions {
  paths: ProfilePaths;
  runtime: RuntimeInstall;
  baseDirectory: string;
  uid: number;
  runtimeAssets: readonly DoctorRuntimeAsset[];
  readSecrets: () => SecretValues;
  /**
   * llmux base URL to probe. Omitted, the endpoint is the `ANTHROPIC_BASE_URL`
   * written in the profile's own `.env`; a profile that names none fails the
   * llmux check locally rather than falling back to any default.
   */
  llmuxBaseUrl?: string;
  /** Injection point for the socket probe's transport. Defaults to `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * The endpoint rule lives in `./setup/llmux-endpoint`, a leaf module, because
 * the materializer needs the same gate and this file already imports the
 * materializer — owning it here would be a cycle. Re-exported so existing
 * callers keep their import site.
 */
export { DEFAULT_LLMUX_BASE_URL, LlmuxEndpointError, validateLlmuxBaseUrl };

/**
 * Read `ANTHROPIC_BASE_URL` out of the profile's materialized `.env`.
 *
 * Doctor is profile-scoped; the llmux client is not. Called with no `baseUrl`,
 * `fetchLlmuxStatus` resolves one from the *controller's* ambient auth-runtime
 * state, whose store path is `process.env.DATA_DIR || './data'` — CWD-relative,
 * so a stray `./data/auth-runtime.json` silently redirects the check away from
 * the profile being diagnosed. Reading the profile's own file is the only
 * answer that is about the profile. `env-paths` is deliberately not imported:
 * it resolves a single ambient config directory at module load, which is the
 * same mistake one level down.
 *
 * Returns `undefined` when the file is absent, unreadable, or carries no
 * non-empty value for the key — three states the caller must not distinguish,
 * because all three mean the same thing: this profile has not told us where
 * its llmux is.
 */
function readProfileLlmuxBaseUrl(configDir: string): string | undefined {
  try {
    const parsed = dotenv.parse(fs.readFileSync(path.join(configDir, RUNTIME_ENV_FILENAME), 'utf-8'));
    const baseUrl = parsed.ANTHROPIC_BASE_URL;
    return typeof baseUrl === 'string' && baseUrl.trim().length > 0 ? baseUrl.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the endpoint to probe: explicit override, else the profile's `.env`.
 * There is no third answer.
 *
 * An explicit override is validated on the same terms as a file-supplied value;
 * being passed in code is not evidence of being safe, and the credential
 * exposure is identical either way.
 *
 * A profile that names no endpoint is a **local configuration failure**, not a
 * cue to try {@link DEFAULT_LLMUX_BASE_URL}. Setup materializes `.env` before
 * it ever runs doctor (`./setup/orchestrator`), so the only way to reach here
 * empty-handed is a standalone `doctor`/`status` on a profile that was never
 * set up — and for that profile, dialing 3456 would send the operator's llmux
 * admin key to whatever happens to be listening there and then report a
 * *daemon* verdict ("unreachable", or worse, a green from a stranger) about a
 * question that was never asked. Throwing {@link LlmuxEndpointError} is the
 * honest answer and costs zero network calls: it precedes the client import
 * and the admin-key resolution. {@link DEFAULT_LLMUX_BASE_URL} stays exported
 * from this module only to preserve the pre-existing public export site — no
 * production code reads it, here or anywhere else — and it must not become
 * reachable from this function again.
 */
export function resolveLlmuxBaseUrl(configDir: string, override?: string): string {
  const candidate = override ?? readProfileLlmuxBaseUrl(configDir);
  if (candidate === undefined) throw new LlmuxEndpointError();
  return validateLlmuxBaseUrl(candidate);
}

/**
 * Wire the real seams.
 *
 * The runtime modules are imported lazily inside each seam rather than at the
 * top of this file. `src/config.ts` builds a module-scoped config object from
 * `process.env` at import, and the config loader pulls in the plugin/surface
 * validators; a `doctor` that only needs to inspect a profile should not drag
 * that graph in, and a test importing `runDoctor` should not execute it at all.
 */
export function createDefaultDoctorDeps(options: DefaultDoctorDepsOptions): DoctorDeps {
  return {
    ...options,
    fs: createNodeDoctorFileSystem(),
    probeSlackBot: async (botToken: string): Promise<DoctorBotProbeResult> => {
      const { probeSlackApi } = await import('../config');
      const probe = await probeSlackApi(botToken);
      // Reduce here: `message`, `user`, `team` and `botId` do not cross back.
      return { ok: probe.ok, fatalAuth: probe.fatalAuth };
    },
    openSlackSocket: (appToken: string) => openSlackSocketProbe(appToken, { fetchImpl: options.fetchImpl }),
    fetchLlmuxStatus: async (): Promise<unknown> => {
      // Resolve and validate FIRST. A refusal must happen before the client is
      // even imported, so an unsupported endpoint costs zero network calls and
      // zero admin-key resolution.
      const baseUrl = resolveLlmuxBaseUrl(options.paths.configDir, options.llmuxBaseUrl);
      const { fetchLlmuxStatus } = await import('../auth/llmux-client');
      return fetchLlmuxStatus({ baseUrl });
    },
    loadConfigFile: async (configFile, env): Promise<DoctorConfigLoadResult> => {
      // `inspectConfig`, never bare `loadConfig`: the latter degrades a failed
      // load to `{}` (right for the runtime, a false green for a gate) and
      // rewrites the file it is reading when `ui` is absent or a legacy
      // `llmChat` key is present — making doctor the cause of the 0644 mode
      // failure a later doctor run would report.
      const { inspectConfig } = await import('../config-loader');
      const inspection = inspectConfig(configFile, { env });
      return { loaded: inspection.loaded, missing: inspection.missing };
    },
  };
}
