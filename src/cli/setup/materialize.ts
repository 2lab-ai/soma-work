/**
 * Atomic profile materialization for `somawork setup` (design §5 Step 4).
 *
 * ## What this owns
 *
 * Turning a validated set of *decisions* — which profile, which runtime
 * install, which workspace root, which Slack app — into the three files the
 * packaged runtime actually reads, written atomically, owner-only, and
 * byte-identical on a re-run.
 *
 * ## What it deliberately does NOT own
 *
 * Credentials. `secrets.env` belongs to {@link SecretStore} (Task 2) and is
 * written by the Slack capture path (Task 6). This module never accepts a
 * token, never reads one, and never writes one — {@link materializeProfile}'s
 * input has no field that could carry one, and the identifiers it does take are
 * run through the same secret-shape gate the setup state uses, so a token
 * smuggled in as an "app id" is rejected rather than persisted.
 *
 * ## How the runtime finds these files
 *
 * The service (Task 9) sets `SOMA_CONFIG_DIR=<configDir>`.
 * `@soma/common/env-paths` reads that at module load and binds:
 *
 * | env-paths constant  | resolved path                |
 * |---------------------|------------------------------|
 * | `ENV_FILE`          | `<configDir>/.env`           |
 * | `CONFIG_FILE`       | `<configDir>/config.json`    |
 * | `SYSTEM_PROMPT_FILE`| `<configDir>/.system.prompt` |
 * | `DATA_DIR`          | `<configDir>/data`           |
 *
 * So there is exactly ONE env file per profile and it is named `.env`. The
 * design prose calls it `runtime.env`; that is the *role*, not the filename,
 * and the receipt exposes it under {@link ProfileReceipt.runtimeEnvFile}.
 * Materializing a second `runtime.env` nobody loads would be a decoy.
 *
 * The two path families disagree on where mutable data lives — `env-paths`
 * binds `<configDir>/data`, design §4.2 declares
 * `~/.local/share/somawork/<profile>` — so both are created here, 0700, as
 * real directories, and both are named in the receipt (`runtimeDataDir`,
 * `dataDir`). Setup does not try to reconcile them: it writes no `DATA_DIR`
 * line (see {@link buildRuntimeEnv}) rather than emit a value the running
 * process contradicts, and the reconciliation itself is a runtime change owned
 * by the service task. A symlink between the two is explicitly not used —
 * `assertNoSymlinkPath` refuses symlinked components on every subsequent
 * write, so the link would turn every later materialize and doctor run into a
 * hard failure.
 *
 * ## Atomicity boundary
 *
 * Each of the three writes is individually atomic (temp → fsync → chmod →
 * `.bak` → rename); the set of three is **not** transactional. A crash between
 * them leaves a mixed generation, and nothing detects that — there is no
 * generation stamp. That is deliberate and sufficient: design §6 requires
 * per-write atomicity only, all three bodies are pure functions of validated
 * inputs, so re-running converges on the same bytes. `<file>.bak` is the only
 * recovery affordance for a body that was replaced.
 */

import { assertNoSymlinkPath, atomicWriteFile, atomicWriteJson, ensureDirectory } from '@soma/common/atomic-write';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { isProfileName, type ProfileName, type ProfilePaths, type RuntimeInstall } from '../profile';
import { LlmuxEndpointError, validateLlmuxBaseUrl } from './llmux-endpoint';
import { assertSecretFree, SecretInStateError } from './state';

/** Mode for every file this module writes. */
const PROFILE_FILE_MODE = 0o600;
/** Mode for every directory this module creates. */
const PROFILE_DIR_MODE = 0o700;

/** File names inside the profile config directory, fixed by `@soma/common/env-paths`. */
export const RUNTIME_ENV_FILENAME = '.env';
export const RUNTIME_CONFIG_FILENAME = 'config.json';
export const RUNTIME_PROMPT_FILENAME = '.system.prompt';
/** Directory `env-paths` binds to `DATA_DIR` when `SOMA_CONFIG_DIR` is set. */
export const RUNTIME_DATA_DIRNAME = 'data';

/**
 * Throwaway upstream key. llmux owns real provider auth and ignores the value
 * (`src/config.ts` documents it as such), so this is a constant, not a secret:
 * it is identical on every machine and grants nothing.
 */
const LLMUX_PLACEHOLDER_API_KEY = 'llmux-local';

/** Raised for any input this module refuses to materialize. */
export class MaterializeProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializeProfileError';
  }
}

/**
 * A file the packaged formula ships. Exactly one of the two fields must be set;
 * `path` is the normal case and `content` exists for tests and for a caller
 * that already holds the bytes.
 */
export interface PackagedAsset {
  path?: string;
  content?: string;
}

/** Everything {@link materializeProfile} needs. Contains no credential field. */
export interface MaterializeProfileInput {
  profile: ProfileName;
  /** Profile-scoped paths, from `profilePaths(home, profile)`. */
  paths: ProfilePaths;
  /** The immutable runtime install this profile runs. */
  runtime: RuntimeInstall;
  /** Absolute workspace root; per-user directories are created beneath it. */
  baseDirectory: string;
  /**
   * The endpoint the local llmux daemon actually serves, from `ensureLlmux`'s
   * receipt (which reads `llmux env`).
   *
   * Required, and deliberately without a default. A default here would be a
   * second opinion about a fact only llmux holds: the same uid can already have
   * an llmux on 3456, in which case this machine's daemon is on another port
   * and a fallback would materialize a profile — and start a service — pointed
   * at somebody else's proxy. A caller that cannot say must not materialize.
   * Validated on the same terms as a file-supplied value; being passed in code
   * is not evidence of being safe.
   */
  llmuxBaseUrl: string;
  /** Non-secret Slack identifiers recorded in the receipt (never in `.env`). */
  slack: { appId: string; teamId: string };
  /** Packaged canonical `config.json` defaults. */
  defaultConfig: PackagedAsset;
  /** Packaged default `.system.prompt`. */
  systemPrompt: PackagedAsset;
}

/**
 * Non-secret proof of what was materialized.
 *
 * Every key here is deliberately chosen to clear `assertSecretFree`'s field-name
 * gate, so a caller can persist this verbatim in setup state. That rules out the
 * obvious `secretsFile` name (the tokenizer reads `secrets` as a credential
 * field), which is why the secrets path is carried inside
 * {@link ProfileReceipt.serviceEnvFiles} — a list whose meaning is "what the
 * service must load", which is exactly what the consumer needs it for.
 */
export interface ProfileReceipt {
  profile: ProfileName;
  runtimeVersion: string;
  runtimeRoot: string;
  configDir: string;
  /** `<configDir>/.env` — the runtime env file (design's `runtime.env` role). */
  runtimeEnvFile: string;
  configFile: string;
  promptFile: string;
  /** `<configDir>/data` — what `env-paths` binds `DATA_DIR` to under `SOMA_CONFIG_DIR`. */
  runtimeDataDir: string;
  /** `ProfilePaths.dataDir` — the canonical mutable-data root (design §4.2). */
  dataDir: string;
  stateDir: string;
  baseDirectory: string;
  appId: string;
  teamId: string;
  /**
   * Env files the service environment must be composed from, in order:
   * `[<configDir>/.env, <configDir>/secrets.env]`.
   *
   * This ordering is the Task 9 contract. `dotenv` reads a single file and does
   * not expand `${VAR}` or `source` inside one, so the runtime cannot reach the
   * credentials by way of `.env` — the launch agent must load both files (or
   * compose an explicit environment from both) before exec.
   *
   * **The list is in increasing precedence: on any overlapping key,
   * `secrets.env` wins.** No key overlaps today, and this module guarantees
   * none can be introduced from the `.env` side (it refuses to write a
   * credential name at all), but the rule has to be stated because the obvious
   * implementation gets it backwards: `dotenv.config()` is first-writer-wins,
   * so loading these two files in array order gives `.env` precedence. Task 9
   * must load with `override: true`, load them in reverse, or build the
   * environment map explicitly — which is what `somawork doctor` does.
   */
  serviceEnvFiles: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function requireAbsolute(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MaterializeProfileError(`${label} must be a non-empty path.`);
  }
  if (!path.isAbsolute(value)) {
    throw new MaterializeProfileError(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

/** True when `target` is `ancestor` or lives beneath it. */
function isWithin(target: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Homebrew's Cellar is replaced wholesale on upgrade and removed on uninstall.
 * Anything mutable written there is lost without warning, so it is refused by
 * path shape as well as by the runtime-root containment check — a profile can
 * be pointed at a Cellar directory that is not this runtime's root.
 */
function assertNotPackagedLocation(target: string, runtimeRoot: string, label: string): void {
  if (isWithin(target, runtimeRoot)) {
    throw new MaterializeProfileError(
      `${label} resolves inside the immutable runtime root; profile state must never live in the install tree.`,
    );
  }
  if (target.split(path.sep).includes('Cellar')) {
    throw new MaterializeProfileError(
      `${label} resolves inside a Homebrew Cellar path; upgrade or uninstall would delete it.`,
    );
  }
}

/**
 * Reject a value `dotenv` would not read back verbatim.
 *
 * The rule is not a denylist of scary characters — it is a round trip. The
 * value is rendered as the exact `KEY=VALUE` line this module is about to
 * write and handed to the same parser the runtime uses; if what comes back is
 * not identical, the line is refused. That makes the check exactly as wide as
 * the hazard and no wider, and it cannot drift from dotenv's behaviour on an
 * upgrade the way a hand-maintained character list does.
 *
 * The named refusals below are kept only because they carry an actionable
 * message; each is also caught by the round trip. What the round trip changes
 * versus a character denylist (measured, `dotenv@16.6.0`):
 *
 * | written line                | parsed value          | verdict |
 * |-----------------------------|-----------------------|---------|
 * | `K=/Users/z/Bob's Code`     | `/Users/z/Bob's Code` | accept  |
 * | `K=/Users/z/say"hi`         | `/Users/z/say"hi`     | accept  |
 * | `K='/Users/z/quoted'`       | `/Users/z/quoted`     | refuse  |
 * | `K=/x#y`                    | `/x`                  | refuse  |
 * | `K=/p q ` (trailing space)  | `/p q`                | refuse  |
 *
 * An apostrophe in a folder name (`~/Bob's Projects`) is ordinary on macOS.
 * The previous blanket quote refusal stopped setup dead on it with no remedy
 * but renaming the folder, for a value dotenv handles correctly.
 */
function assertEnvValueSafe(value: string, key: string): void {
  if (/[\n\r\0]/.test(value)) {
    throw new MaterializeProfileError(`Refusing to write ${key}: the value contains a newline or NUL byte.`);
  }
  if (value.includes('#')) {
    throw new MaterializeProfileError(`Refusing to write ${key}: dotenv would truncate the value at "#".`);
  }
  if (value !== value.trim()) {
    throw new MaterializeProfileError(`Refusing to write ${key}: dotenv would trim the surrounding whitespace.`);
  }
  if (!envValueRoundTrips(key, value)) {
    throw new MaterializeProfileError(
      `Refusing to write ${key}: dotenv would not read the value back unchanged (a value wrapped in matching quotes has them stripped).`,
    );
  }
}

/** True when `KEY=value\n` parses back to exactly `value`. */
function envValueRoundTrips(key: string, value: string): boolean {
  try {
    return dotenv.parse(`${key}=${value}\n`)[key] === value;
  } catch {
    return false;
  }
}

/**
 * Accept only a plain loopback llmux endpoint, and return the validated origin.
 *
 * The same gate `somawork doctor` applies when it reads this line back, shared
 * through a leaf module so the writer and the reader cannot drift. Writing an
 * unvalidated value here would be the more dangerous half of that pair: doctor
 * refuses a bad endpoint on one run, while a bad line in `.env` is what the
 * long-lived service dials on every request.
 *
 * The rejected value is not named. It reached this module from a child process
 * (`llmux env`) by way of a receipt, and the refusal may be printed or
 * persisted by a caller.
 */
function requireLlmuxBaseUrl(candidate: unknown): string {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new MaterializeProfileError(
      'The local llmux endpoint is required; setup reads it from `llmux env` rather than assuming a port.',
    );
  }
  try {
    return validateLlmuxBaseUrl(candidate.trim());
  } catch (err) {
    if (err instanceof LlmuxEndpointError) {
      throw new MaterializeProfileError(
        'The llmux endpoint is not a plain local http address; setup will not point a profile at it.',
      );
    }
    throw err;
  }
}

function readAsset(asset: PackagedAsset | undefined, label: string): string {
  if (asset === null || typeof asset !== 'object') {
    throw new MaterializeProfileError(`${label} was not supplied.`);
  }
  const hasContent = typeof asset.content === 'string';
  const hasPath = typeof asset.path === 'string' && asset.path.length > 0;
  if (hasContent === hasPath) {
    throw new MaterializeProfileError(`${label} must be supplied as exactly one of { path } or { content }.`);
  }
  if (hasContent) return asset.content as string;

  const assetPath = requireAbsolute(asset.path, `${label} path`);
  try {
    return fs.readFileSync(assetPath, 'utf-8');
  } catch {
    // The path itself is safe to name — it is a packaged install path, and the
    // operator cannot fix a missing asset without knowing which one it is.
    throw new MaterializeProfileError(`${label} could not be read from "${assetPath}"; the install looks incomplete.`);
  }
}

// ---------------------------------------------------------------------------
// Artifact bodies
// ---------------------------------------------------------------------------

/**
 * Build the `.env` body.
 *
 * Every line here has a live reader in this repository. Nothing is written
 * "for documentation":
 *
 * | key                   | read by                                                   |
 * |-----------------------|-----------------------------------------------------------|
 * | `AUTH_MODE`           | `src/config.ts` `parseAuthMode`                            |
 * | `ANTHROPIC_BASE_URL`  | `src/config.ts` `config.auth.llmux.baseUrl`                 |
 * | `ANTHROPIC_API_KEY`   | `src/config.ts` `config.auth.llmux.apiKey`                  |
 * | `BASE_DIRECTORY`      | `src/config.ts`, `src/mcp/server-factory.ts`               |
 * | `SOMA_BASE_DIRECTORY` | `packages/slack` message-validator / directory-formatter   |
 *
 * The first three are legacy non-`SOMA_` names and are migration debt: they are
 * what the shipped runtime reads today, so setup must emit them.
 *
 * `ANTHROPIC_BASE_URL` is an *input* ({@link MaterializeProfileInput.llmuxBaseUrl}),
 * not a constant this module owns: the port llmux serves is llmux's fact, and
 * hardcoding it wrote a profile that pointed at whichever daemon happened to
 * hold 3456. New readers
 * must use `SOMA_`-prefixed names (plan global constraints).
 *
 * `DATA_DIR` is deliberately absent even though two modules read it
 * (`src/auth/auth-runtime.ts`, `src/cct-store/index.ts`): under
 * `SOMA_CONFIG_DIR` those readers are first reached *after*
 * `src/index.ts` overwrites `process.env.DATA_DIR` with the env-paths value,
 * so a line here would state one path while the process uses another. A
 * generated file that disagrees with the running process is a trap, so the
 * line is not written at all and `env-paths` owns the variable. Reconciling
 * the two locations is a runtime change owned by the service task.
 *
 * `SOMA_CONFIG_DIR` is absent on purpose — it is what *selects* this file, so
 * it belongs in the service environment (Task 9), not inside the file it points
 * at. The Slack credentials are absent for the reason in {@link ProfileReceipt}.
 */
function buildRuntimeEnv(baseDirectory: string, llmuxBaseUrl: string): string {
  const entries: Array<[string, string]> = [
    ['AUTH_MODE', 'llmux'],
    ['ANTHROPIC_BASE_URL', llmuxBaseUrl],
    ['ANTHROPIC_API_KEY', LLMUX_PLACEHOLDER_API_KEY],
    ['BASE_DIRECTORY', baseDirectory],
    ['SOMA_BASE_DIRECTORY', baseDirectory],
  ];

  for (const [key, value] of entries) assertEnvValueSafe(value, key);

  const header = [
    '# somawork profile environment - generated by `somawork setup`; edits are overwritten.',
    '# Runtime credentials live in secrets.env (0600) and are never duplicated here.',
  ];
  return `${[...header, ...entries.map(([key, value]) => `${key}=${value}`)].join('\n')}\n`;
}

/**
 * Parse and validate the packaged canonical config.
 *
 * The shipped `config.default.json` is used as-is rather than a hand-written
 * subset because of what it actually contains: only the `ui` surface
 * composition — literal display data with no filesystem paths, no `mcpServers`,
 * no `plugin` block, and no `${VAR}` placeholders. There is nothing in it a
 * packaged runtime cannot honour, and copying it forward has a second, load-
 * bearing effect: `loadConfig` *seeds* `DEFAULT_UI_SURFACES` into `config.json`
 * and rewrites the file when the `ui` key is missing. Materializing a config
 * that already has `ui` keeps the first runtime boot (and every doctor run)
 * from mutating a file setup just wrote atomically.
 */
function parseDefaultConfig(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MaterializeProfileError('The packaged default config is not valid JSON; the install looks incomplete.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MaterializeProfileError('The packaged default config must be a JSON object.');
  }
  const asRecord = parsed as Record<string, unknown>;
  if (JSON.stringify(asRecord).includes('${')) {
    throw new MaterializeProfileError(
      'The packaged default config contains an env placeholder; setup will not materialize a config it cannot resolve.',
    );
  }
  // A `ui` object is not decoration — it is what makes the paragraph above
  // true. `loadConfig` seeds `DEFAULT_UI_SURFACES` and REWRITES config.json
  // whenever the key is absent, so a template without it produces a profile
  // that the first runtime boot silently rewrites at the ambient umask,
  // defeating the atomic 0600 write this module just performed. Refusing here
  // keeps the claim "the runtime will not seed" checkable rather than lucky.
  const ui = asRecord.ui;
  if (ui === undefined || ui === null || typeof ui !== 'object' || Array.isArray(ui)) {
    throw new MaterializeProfileError(
      'The packaged default config has no `ui` object; the runtime would seed and rewrite the materialized config on first boot.',
    );
  }
  return asRecord;
}

function normalizeSystemPrompt(raw: string): string {
  if (raw.trim().length === 0) {
    throw new MaterializeProfileError(
      'The packaged system prompt is empty; refusing to materialize a silent empty prompt.',
    );
  }
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Materialize `profile`'s runtime files and return a non-secret receipt.
 *
 * Deterministic and idempotent: the same input yields byte-identical artifacts
 * and an equal receipt. Every input is validated and every artifact body is
 * built **before** the first write, so a bad packaged asset or an unsafe path
 * cannot leave a half-written profile behind.
 */
export function materializeProfile(input: MaterializeProfileInput): ProfileReceipt {
  if (input === null || typeof input !== 'object') {
    throw new MaterializeProfileError('Materialization input is required.');
  }

  const { profile, paths, runtime, slack } = input;

  if (typeof profile !== 'string' || !isProfileName(profile)) {
    throw new MaterializeProfileError('A valid profile name is required.');
  }
  if (paths === null || typeof paths !== 'object') {
    throw new MaterializeProfileError('Profile paths are required.');
  }
  if (runtime === null || typeof runtime !== 'object') {
    throw new MaterializeProfileError('A runtime install is required.');
  }
  if (slack === null || typeof slack !== 'object') {
    throw new MaterializeProfileError('Slack identifiers are required.');
  }
  if (runtime.profile !== profile) {
    throw new MaterializeProfileError(
      `The runtime install is for the "${String(runtime.profile)}" profile but "${profile}" was requested.`,
    );
  }
  if (typeof runtime.version !== 'string' || runtime.version.trim().length === 0) {
    throw new MaterializeProfileError('The runtime install must carry a version.');
  }

  const runtimeRoot = requireAbsolute(runtime.root, 'Runtime root');
  const configDir = requireAbsolute(paths.configDir, 'Profile config directory');
  const dataDir = requireAbsolute(paths.dataDir, 'Profile data directory');
  const stateDir = requireAbsolute(paths.stateDir, 'Profile state directory');
  const secretsFile = requireAbsolute(paths.secretsFile, 'Profile secrets file');
  const baseDirectory = requireAbsolute(input.baseDirectory, 'Base directory');
  const runtimeDataDir = path.join(configDir, RUNTIME_DATA_DIRNAME);

  for (const [target, label] of [
    [configDir, 'Profile config directory'],
    [dataDir, 'Profile data directory'],
    [stateDir, 'Profile state directory'],
    [baseDirectory, 'Base directory'],
  ] as const) {
    assertNotPackagedLocation(target, runtimeRoot, label);
  }
  if (!isWithin(secretsFile, configDir)) {
    throw new MaterializeProfileError('The profile secrets file must live inside the profile config directory.');
  }

  // Identifiers are operator-visible data, not credentials — but this is the
  // one place a token could be smuggled into a persisted receipt, so it is
  // checked with the same gate the setup state uses instead of by eye.
  const { appId, teamId } = slack;
  if (typeof appId !== 'string' || appId.length === 0 || typeof teamId !== 'string' || teamId.length === 0) {
    throw new MaterializeProfileError('Slack app and team identifiers are required.');
  }
  try {
    assertSecretFree({ appId, teamId }, 'slack');
  } catch (err) {
    if (err instanceof SecretInStateError) {
      throw new MaterializeProfileError(
        'A Slack identifier is credential-shaped; setup will not record it. Credentials belong in secrets.env.',
      );
    }
    throw err;
  }

  const llmuxBaseUrl = requireLlmuxBaseUrl(input.llmuxBaseUrl);

  // Bodies first: every failure mode above and below this line happens before
  // a single byte is written.
  const envBody = buildRuntimeEnv(baseDirectory, llmuxBaseUrl);
  const configBody = parseDefaultConfig(readAsset(input.defaultConfig, 'The packaged default config'));
  const promptBody = normalizeSystemPrompt(readAsset(input.systemPrompt, 'The packaged system prompt'));

  for (const dir of [configDir, dataDir, stateDir, runtimeDataDir]) {
    assertNoSymlinkPath(dir);
  }

  const runtimeEnvFile = path.join(configDir, RUNTIME_ENV_FILENAME);
  const configFile = path.join(configDir, RUNTIME_CONFIG_FILENAME);
  const promptFile = path.join(configDir, RUNTIME_PROMPT_FILENAME);

  for (const dir of [configDir, dataDir, stateDir, runtimeDataDir]) {
    ensureDirectory(dir, PROFILE_DIR_MODE);
  }

  const writeOpts = { mode: PROFILE_FILE_MODE, dirMode: PROFILE_DIR_MODE, backup: true } as const;
  atomicWriteFile(runtimeEnvFile, envBody, writeOpts);
  atomicWriteJson(configFile, configBody, writeOpts);
  atomicWriteFile(promptFile, promptBody, writeOpts);

  const receipt: ProfileReceipt = {
    profile,
    runtimeVersion: runtime.version,
    runtimeRoot,
    configDir,
    runtimeEnvFile,
    configFile,
    promptFile,
    runtimeDataDir,
    dataDir,
    stateDir,
    baseDirectory,
    appId,
    teamId,
    serviceEnvFiles: [runtimeEnvFile, secretsFile],
  };

  // Defense in depth: the receipt is designed to clear this gate, and a future
  // field that does not must fail here rather than in a caller's state write.
  assertSecretFree(receipt, 'profileReceipt');
  return receipt;
}
