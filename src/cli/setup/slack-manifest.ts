/**
 * The profile-persistent Slack CLI project that `somawork setup` drives.
 *
 * ## What this owns
 *
 * A directory that looks to the Slack CLI like an ordinary project — a
 * `manifest.json` and a `.slack/hooks.json` — but is owned by somawork and
 * lives under the profile's 0700 state directory rather than a temp dir. Two
 * things follow from "persistent, not temporary":
 *
 * 1. `.slack/apps.json` and `.slack/apps.dev.json` are the **only** local record
 *    that a Slack app was already created for this workspace. `slack run` reads
 *    them to reuse an app instead of creating a second one
 *    (`internal/app/app_client.go:364-427`). This module regenerates the
 *    manifest and the hooks file on every call and never writes, moves, or
 *    removes either mapping file — a wiped project after a cancelled run is how
 *    you end up with duplicate Slack apps.
 * 2. A capture that timed out is resumable: the caller re-materializes, gets the
 *    same paths and the same recorded app id back, and runs again.
 *
 * ## The canonical manifest is the single owner
 *
 * `infra/slack/slack-app-manifest.json` in the runtime payload defines every
 * scope, event, feature and slash command — including the deprecated
 * `/soma`, `/session`, `/new` rollback aliases. {@link buildProfileManifest}
 * deep-clones it and changes exactly two strings: the app display name and the
 * bot display name, so preview and production are visibly distinct in the
 * workspace. Nothing else may diverge, and the test suite asserts that by
 * diffing the built manifest against the real canonical file.
 *
 * ## The hook command grammar has no escape hatch
 *
 * Source-pinned, `slackapi/slack-cli` `internal/hooks/hooks.go:52-55`:
 *
 * ```go
 * // We're taking the script and separating it into individual fields to be compatible with Exec.Command,
 * cmdArgs := strings.Fields(cmdStr)
 * ```
 *
 * `strings.Fields` splits on whitespace. There is **no shell, no quoting and no
 * backslash escaping** — a quoted path would arrive with literal quote
 * characters in argv. So a socket path that contains whitespace cannot be
 * passed literally; {@link encodeHookArgument} percent-escapes exactly the
 * characters that would split it (and `%` itself, so the escape is reversible),
 * and the capture helper decodes it back. An ordinary path is byte-identical
 * after encoding, so the common hook line reads exactly as documented.
 *
 * The same trick is *not* available for `cmdArgs[0]`: the Slack CLI hands that
 * to `exec.Command` directly and nothing of ours decodes it. A controller
 * command containing whitespace is therefore refused rather than escaped.
 */

import { assertNoSymlinkPath, assertNotSymlink, atomicWriteJson } from '@soma/common/atomic-write';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isProfileName, type ProfileName } from '../profile';
import { redactForDisplay } from './host';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Project directory name inside the profile's state directory. */
export const SLACK_PROJECT_DIRNAME = 'slack-project';
/** Manifest file the Slack CLI reads at the project root. */
export const SLACK_PROJECT_MANIFEST_FILENAME = 'manifest.json';
/** Hook overrides directory/file (`internal/app/app_client.go:33-34` neighbours). */
export const SLACK_PROJECT_DOT_DIR = '.slack';
export const SLACK_HOOKS_FILENAME = 'hooks.json';
/** Local/dev app mapping (`internal/app/app_client.go:34`). */
export const SLACK_DEV_APPS_FILENAME = 'apps.dev.json';
/** Deployed app mapping (`internal/app/app_client.go:33`). */
export const SLACK_DEPLOYED_APPS_FILENAME = 'apps.json';
/** Canonical manifest, relative to the runtime payload root. */
export const CANONICAL_MANIFEST_RELATIVE_PATH = path.join('infra', 'slack', 'slack-app-manifest.json');
/** Capture socket file name, kept in `<profile state>/run/`. */
export const CAPTURE_SOCKET_FILENAME = 'slack-capture.sock';
/** Directory inside profile state that holds the capture socket. */
export const CAPTURE_SOCKET_DIRNAME = 'run';
/** Private controller subcommand the start hook invokes. */
export const CAPTURE_HOOK_SUBCOMMAND = '_capture-slack-auth';
/** Private controller subcommand the `get-manifest` hook invokes. */
export const MANIFEST_HOOK_SUBCOMMAND = '_print-slack-manifest';
/** Packaged controller name, resolved on the child's PATH by the Slack CLI. */
export const DEFAULT_CONTROLLER_COMMAND = 'somawork';

// ---------------------------------------------------------------------------
// Capture nonce (I-1)
// ---------------------------------------------------------------------------

/** Nonce size in bytes; rendered as {@link CAPTURE_NONCE_CHARS} hex characters. */
export const CAPTURE_NONCE_BYTES = 32;
/** Length of the hex rendering. Fixed, so the comparison is constant-length. */
export const CAPTURE_NONCE_CHARS = CAPTURE_NONCE_BYTES * 2;
/** Lowercase hex, exactly {@link CAPTURE_NONCE_CHARS} long. Nothing else. */
const CAPTURE_NONCE_RE = new RegExp(`^[0-9a-f]{${CAPTURE_NONCE_CHARS}}$`);

/**
 * Mint a one-time challenge for a single capture attempt.
 *
 * The socket path is derived from the profile state directory and is therefore
 * predictable, and a 0600 socket in a 0700 directory is a gate against other
 * *users*, not other processes of the same user. So the frame has to prove it
 * came from the child we started: the start hook carries this value in its
 * argv (see {@link buildSlackHooksFile}) and must echo it back.
 *
 * **Ephemeral by contract.** It is not a provider credential — it authorizes
 * nothing outside this one 180-second window and dies with the process — but it
 * must not become durable state: never write it to setup state, a profile
 * receipt, config, `secrets.env`, a log line, an error message, a plist, or any
 * generated public artifact. Its only two resting places are the profile's own
 * `.slack/hooks.json` (0600, rewritten on the next run) and the memory of the
 * two processes exchanging it.
 *
 * Hex rather than base64url so it survives {@link encodeHookArgument}
 * byte-identical and can never contain a character `strings.Fields` splits on.
 */
export function generateCaptureNonce(): string {
  return crypto.randomBytes(CAPTURE_NONCE_BYTES).toString('hex');
}

/** Is `value` a well-formed capture nonce? Shape only — never an identity. */
export function isCaptureNonce(value: unknown): value is string {
  return typeof value === 'string' && CAPTURE_NONCE_RE.test(value);
}

/**
 * Constant-time nonce comparison.
 *
 * Both sides are fixed-length hex by construction, so a length mismatch is
 * already a rejection and `timingSafeEqual` never sees ragged buffers. Over a
 * local socket a timing oracle is a stretch; refusing to write the one
 * comparison that obviously leaks is cheaper than arguing about it.
 */
export function captureNonceMatches(expected: string, received: unknown): boolean {
  if (!isCaptureNonce(expected) || !isCaptureNonce(received)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

/**
 * Longest usable Unix socket path.
 *
 * `sun_path` is 104 bytes on Darwin including the terminating NUL, so 103 bytes
 * of path. Checked up front because `bind(2)` failing deep inside `slack run`
 * would look like a Slack problem rather than a path-length problem.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/**
 * Largest manifest the `get-manifest` helper will read.
 *
 * A Slack manifest is a few kilobytes (`long_description` alone is capped at
 * 4000 characters), so this is three orders of magnitude of headroom and still
 * bounds a helper that writes its input straight to stdout.
 */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Slack manifest limits (docs.slack.dev/reference/app-manifest). */
const MAX_APP_NAME_CHARS = 35;
const MAX_BOT_DISPLAY_NAME_CHARS = 80;

/**
 * Values this module echoes back are not always ours — a Team ID typed by the
 * user (who may have pasted a token by mistake) and a mapping key read off
 * disk — and an error message goes to a terminal. Two gates, by kind:
 *
 * - {@link safeIdLabel} for a Slack workspace ID: alphanumerics only. Every
 *   real Team ID matches; every Slack token contains a `-`, so none can.
 * - {@link safeLabel} for a mapping key, which may legitimately be a team
 *   *domain* and so must allow `-`. Bounded charset **and** a pass through the
 *   project's single redactor, so a credential-shaped key is never printed.
 */
const SAFE_ID_LABEL_RE = /^[A-Za-z0-9]{1,24}$/;
const SAFE_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

const UNPRINTABLE = '<unprintable value>';

function safeIdLabel(value: unknown): string {
  return typeof value === 'string' && SAFE_ID_LABEL_RE.test(value) ? value : UNPRINTABLE;
}

function safeLabel(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_LABEL_RE.test(value)) return UNPRINTABLE;
  return redactForDisplay(value) === value ? value : UNPRINTABLE;
}

/** Standard (non-Enterprise-Grid) workspace id. */
const STANDARD_TEAM_ID_RE = /^T[A-Z0-9]{1,20}$/;
/** Enterprise Grid org id — recognised only so the refusal can be specific. */
const ENTERPRISE_TEAM_ID_RE = /^E[A-Z0-9]{1,20}$/;
/** Slack app id as persisted in the CLI's app mapping files. */
const APP_ID_RE = /^A[A-Z0-9]{1,24}$/;
/** Longest team domain accepted out of a mapping file. */
const MAX_TEAM_DOMAIN_CHARS = 255;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for every failure this module raises. */
export class SlackProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackProjectError';
  }
}

/** A caller-supplied argument was refused before anything touched the disk. */
export class SlackProjectOptionsError extends SlackProjectError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackProjectOptionsError';
  }
}

/** The workspace id is malformed, or is an Enterprise Grid org this v1 refuses. */
export class SlackTeamIdError extends SlackProjectError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackTeamIdError';
  }
}

/** The canonical manifest is missing, unparseable, or not shaped like a manifest. */
export class SlackManifestSourceError extends SlackProjectError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackManifestSourceError';
  }
}

/**
 * A Slack CLI app mapping file exists but does not say what we can act on.
 *
 * Always fatal, never "assume no app": a mapping we cannot read is exactly the
 * state in which guessing creates a duplicate Slack app in the user's
 * workspace. The file is left byte-for-byte alone so a human can look at it.
 */
export class SlackAppMappingError extends SlackProjectError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackAppMappingError';
  }
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The manifest we hand to the Slack CLI. Loose by design — canonical owns it. */
export interface SlackAppManifest {
  display_information: { name: string; [key: string]: unknown };
  features: { bot_user: { display_name: string; [key: string]: unknown }; [key: string]: unknown };
  oauth_config: unknown;
  settings: unknown;
  [key: string]: unknown;
}

/** `.slack/hooks.json`, holding only what somawork actually needs. */
export interface SlackHooksFile {
  hooks: {
    /** Prints the materialized manifest to stdout. Required by the CLI. */
    'get-manifest': string;
    /** The long-running capture child. Must print nothing. */
    start: string;
  };
  config: { 'sdk-managed-connection-enabled': true };
}

/** The safe subset of a Slack CLI app mapping entry. */
export interface SlackAppMapping {
  appId: string;
  teamId: string;
  teamDomain?: string;
  /** Which file it came from. `dev` wins, because `slack run` is the local flow. */
  source: 'dev' | 'deployed';
}

/** Everything a capture run needs to know about the materialized project. */
export interface SlackProject {
  profile: ProfileName;
  teamId: string;
  root: string;
  manifestPath: string;
  hooksPath: string;
  devAppsPath: string;
  deployedAppsPath: string;
  socketPath: string;
  /**
   * One-time challenge the start hook must echo in its capture frame (I-1).
   *
   * Minted per materialization, i.e. per setup run. In memory and in the
   * profile's 0600 `.slack/hooks.json`; nowhere else, ever — see
   * {@link generateCaptureNonce}.
   */
  captureNonce: string;
  /** App recorded for this workspace at materialization time, if any. */
  appMapping: SlackAppMapping | null;
}

export interface MaterializeSlackProjectOptions {
  /** Profile state directory, i.e. `profilePaths(home, profile).stateDir`. */
  stateDir: string;
  /** Command both hooks invoke. Defaults to {@link DEFAULT_CONTROLLER_COMMAND}. */
  controllerCommand?: string;
  /**
   * Where the canonical manifest lives, overriding the `runtimeRoot`-relative
   * default.
   *
   * Running from source, `<runtimeRoot>/infra/slack/slack-app-manifest.json` is
   * correct. A packaged runtime only has that file if packaging ships it as an
   * asset — **Task 11 owns that**, and this override is how a packaged build (or
   * a package test) points at wherever it actually lands.
   */
  canonicalManifestPath?: string;
}

/**
 * Per-profile Slack app naming.
 *
 * Deterministic, visibly distinct in a workspace member list, inside the
 * documented manifest limits, and carrying no company or private identifier —
 * these strings end up in someone else's Slack workspace.
 */
export const PROFILE_SLACK_APP_NAMES: Readonly<Record<ProfileName, { displayName: string; botDisplayName: string }>> = {
  production: { displayName: 'Somawork', botDisplayName: 'Somawork' },
  preview: { displayName: 'Somawork Preview', botDisplayName: 'Somawork Preview' },
};

// ---------------------------------------------------------------------------
// Team id
// ---------------------------------------------------------------------------

/**
 * Reject anything that is not a standard workspace id.
 *
 * Enterprise Grid (`E…`) is out of scope for the macOS v1: an org-level install
 * needs an admin approval flow this wizard does not implement, and finding that
 * out after `slack run` has already created an app is the expensive order to
 * discover it in.
 */
export function assertStandardTeamId(teamId: unknown): asserts teamId is string {
  if (typeof teamId !== 'string' || teamId.length === 0) {
    throw new SlackTeamIdError('A Slack Team ID is required (for example T024BE7LD).');
  }
  if (ENTERPRISE_TEAM_ID_RE.test(teamId)) {
    throw new SlackTeamIdError(
      `"${teamId}" is an Enterprise Grid organization ID. somawork setup supports standard workspaces (T…) only, ` +
        'because an org-level app install needs an admin approval flow this wizard does not implement. ' +
        'Run setup against a single workspace and pass its Team ID.',
    );
  }
  if (!STANDARD_TEAM_ID_RE.test(teamId)) {
    // Echoed through `safeIdLabel`: a user who pastes a token where a Team ID
    // belongs must not see it quoted back at them on the terminal.
    throw new SlackTeamIdError(
      `"${safeIdLabel(teamId)}" is not a Slack Team ID. Expected a workspace ID such as T024BE7LD.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Hook argument encoding
// ---------------------------------------------------------------------------

/** Whitespace (what `strings.Fields` splits on), control characters, and `%`. */
const HOOK_ESCAPE_RE = /[%\s]|\p{Cc}/gu;
/** A complete, well-formed percent escape. */
const PERCENT_ESCAPE_RE = /%[0-9A-Fa-f]{2}/g;

/**
 * Percent-escape only what would break `strings.Fields`, so an ordinary path
 * survives byte-identical and a path with spaces still arrives as one argv
 * element.
 */
export function encodeHookArgument(value: string): string {
  return value.replace(HOOK_ESCAPE_RE, (char) =>
    Array.from(Buffer.from(char, 'utf-8'))
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      .join(''),
  );
}

/**
 * Inverse of {@link encodeHookArgument}.
 *
 * Strict in three ways: a partial escape is an error, invalid percent-encoded
 * UTF-8 is an error, and — because a hand-edited `hooks.json` is the one input
 * this encoder did not produce — a *decoded* control character is an error too.
 * `%00` would otherwise reach `net.createConnection({ path })`.
 */
export function decodeHookArgument(value: string): string {
  const withoutEscapes = value.replace(PERCENT_ESCAPE_RE, '');
  if (withoutEscapes.includes('%')) {
    throw new SlackProjectOptionsError('Refusing a hook argument with a malformed percent escape.');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new SlackProjectOptionsError('Refusing a hook argument that is not valid percent-encoded UTF-8.');
  }
  if (DECODED_CONTROL_RE.test(decoded)) {
    throw new SlackProjectOptionsError('Refusing a hook argument that decodes to a control character.');
  }
  return decoded;
}

/** Unicode `Cc`, written without literal bytes. */
const DECODED_CONTROL_RE = /\p{Cc}/u;

/**
 * Read every `--flag <value>` / `--flag=<value>` pair a hook's argv must carry.
 *
 * Shared by both private routes so their grammar cannot drift. Extra `--…`
 * arguments are ignored rather than rejected, because the Slack CLI appends its
 * own: `get-manifest` receives `--source="<project dir>"` with **literal
 * quotes** (`internal/goutils/map.go:29-36`), appended as a whole argv element
 * rather than re-split. (`start` in SDK-managed mode appends nothing at all —
 * `internal/pkg/platform/localserver.go:306-309` uses `cmdArgs[1:]` verbatim —
 * but tolerating the generic form costs nothing and survives a CLI change.)
 */
export function parseHookFlagArguments<F extends string>(
  argv: readonly string[],
  flags: readonly F[],
  fail: (message: string) => Error,
): Record<F, string> {
  if (!Array.isArray(argv)) throw fail('Expected an argument vector.');

  // One pass over the whole vector, with ALL known flags in hand. Parsing one
  // flag at a time cannot work once a hook carries two of them: the second
  // flag's *value* looks like a stray positional to the first flag's pass.
  const raw = new Map<F, string>();
  const claim = (flag: F, value: string): void => {
    if (raw.has(flag)) throw fail(`--${flag} was given more than once.`);
    if (value.length === 0) throw fail(`--${flag} needs a value.`);
    raw.set(flag, value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const spaced = flags.find((flag) => arg === `--${flag}`);
    if (spaced !== undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw fail(`--${spaced} needs a value.`);
      claim(spaced, next);
      index += 1;
      continue;
    }
    const inline = flags.find((flag) => arg.startsWith(`--${flag}=`));
    if (inline !== undefined) {
      claim(inline, arg.slice(`--${inline}=`.length));
      continue;
    }
    if (arg.startsWith('--')) continue;
    // The offending argument is never quoted: argv reaches us from a file on
    // disk, and a hand-edited hook could put anything there.
    throw fail('Unexpected positional argument.');
  }

  const parsed = {} as Record<F, string>;
  for (const flag of flags) {
    const value = raw.get(flag);
    if (value === undefined) throw fail(`--${flag} <value> is required.`);
    parsed[flag] = decodeHookArgument(value);
  }
  return parsed;
}

/** Single-flag form of {@link parseHookFlagArguments}. */
export function parseHookFlagArgument(argv: readonly string[], flag: string, fail: (message: string) => Error): string {
  return parseHookFlagArguments(argv, [flag], fail)[flag];
}

/**
 * Build `.slack/hooks.json`.
 *
 * Two hooks, and both are load-bearing:
 *
 * - **`get-manifest`.** The Slack CLI does **not** read `manifest.json` off
 *   disk. `ManifestClient.GetManifestLocal` (`internal/app/manifest.go:72-78`)
 *   refuses outright when the hook is absent — "The `get-manifest` script was
 *   not found" — and `internal/pkg/apps/install.go:382-390` takes that branch on
 *   every run of a project with no `.slack/config.json`
 *   (`internal/config/project.go:170` reports `ManifestSourceLocal`). Without
 *   this hook `slack run` fails before it ever reaches `start`, so the whole
 *   capture flow is inert. `manifest.json` at the project root is a convention
 *   of the Node SDK's *implementation* of this hook, not a CLI-level one; here
 *   the file is real and the hook simply prints it.
 * - **`start`.** The long-running child that receives the runtime tokens.
 *
 * The two routes have **opposite output contracts**: `get-manifest` must write
 * the manifest JSON to stdout (the CLI parses it from the first `{` —
 * `manifest.go:103-113`), while `start` must write nothing at all (its stdout is
 * forwarded to the CLI's own, `localserver.go:310`).
 *
 * Every omission is also a decision:
 *
 * - **No `get-hooks`.** That is the CLI's *discovery* hook; declaring it would
 *   let an SDK in the project contribute hooks we did not write. Leaving it out
 *   is safe — `internal/shared/clients.go` only executes it when present.
 * - **No `protocol-version`.** Absent means protocol v1. The
 *   `message-boundaries` protocol exists to separate a hook's diagnostics from
 *   its structured stdout; our two routes each write either nothing or exactly
 *   one JSON document, so it would buy nothing.
 * - **No `watch`.** File watching restarts the app server and can reinstall the
 *   manifest. Both are actively harmful during a one-shot credential capture.
 * - **No `runtime`.** That field is for Slack-managed (Deno) deployment; this
 *   project is only ever run locally.
 */
export function buildSlackHooksFile(options: {
  socketPath: string;
  manifestPath: string;
  /** One-time challenge the start hook must echo back (I-1). */
  captureNonce: string;
  controllerCommand?: string;
}): SlackHooksFile {
  if (options === null || typeof options !== 'object') {
    throw new SlackProjectOptionsError('Building the Slack hooks file needs a socket path and a manifest path.');
  }
  const controllerCommand = options.controllerCommand ?? DEFAULT_CONTROLLER_COMMAND;

  if (typeof controllerCommand !== 'string' || controllerCommand.length === 0) {
    throw new SlackProjectOptionsError('The Slack hooks file needs a controller command.');
  }
  if (encodeHookArgument(controllerCommand) !== controllerCommand) {
    throw new SlackProjectOptionsError(
      `Refusing controller command "${controllerCommand}": the Slack CLI splits a hook on whitespace and ` +
        'cannot quote or unescape the command name. Install the controller at a whitespace-free path.',
    );
  }
  if (typeof options.socketPath !== 'string' || options.socketPath.length === 0) {
    throw new SlackProjectOptionsError('The Slack start hook needs a capture socket path.');
  }
  if (typeof options.manifestPath !== 'string' || options.manifestPath.length === 0) {
    throw new SlackProjectOptionsError('The Slack get-manifest hook needs a manifest path.');
  }
  // Shape-checked, never echoed: a malformed value here would end up in a file
  // on disk and then in an error message.
  if (!isCaptureNonce(options.captureNonce)) {
    throw new SlackProjectOptionsError(
      `The Slack start hook needs a ${CAPTURE_NONCE_CHARS}-character hex capture nonce; use generateCaptureNonce().`,
    );
  }

  return {
    hooks: {
      'get-manifest': `${controllerCommand} ${MANIFEST_HOOK_SUBCOMMAND} --path ${encodeHookArgument(options.manifestPath)}`,
      start: `${controllerCommand} ${CAPTURE_HOOK_SUBCOMMAND} --socket ${encodeHookArgument(options.socketPath)} --nonce ${options.captureNonce}`,
    },
    config: { 'sdk-managed-connection-enabled': true },
  };
}

// ---------------------------------------------------------------------------
// The `get-manifest` route
// ---------------------------------------------------------------------------

/** Parse the private manifest route's argv. */
export function parseManifestHelperArgv(argv: readonly string[]): { manifestPath: string } {
  return {
    manifestPath: parseHookFlagArgument(argv, 'path', (message) => new SlackProjectOptionsError(message)),
  };
}

export interface SlackManifestHelperOptions {
  /** Path handed over by the hook, already decoded by {@link parseManifestHelperArgv}. */
  manifestPath: string;
  /**
   * When known, the path must equal this exactly.
   *
   * **The controller deliberately does not pass it.** The `get-manifest` hook
   * command carries only `--path` (see {@link buildSlackHooksFile}) with no
   * profile hint, and the private route may not read profile state to invent
   * one — so there is nothing for the route to compare against. The shape gate
   * in {@link runSlackManifestHelper} is what bounds the primitive instead:
   * absolute, normalized, control-character-free, basename `manifest.json`,
   * parent directory `slack-project`, no symlink ancestry, a regular file,
   * size-bounded, and structurally an app manifest. It can therefore only ever
   * print a Slack app manifest, which carries no credential.
   *
   * The option remains for a caller that *does* already hold the expected path
   * (a packaging test, or a future in-process capture flow).
   */
  expectedManifestPath?: string;
  /**
   * Content seam for tests only.
   *
   * The default reader is also where the filesystem checks live (symlink,
   * regular file, size), so an injected reader tests JSON handling, **not**
   * path safety — the shape checks above it run either way.
   */
  readFile?: (path: string) => string;
  maxBytes?: number;
}

/**
 * The body of `somawork _print-slack-manifest`.
 *
 * Returns the materialized manifest as stable JSON ending in a newline; the CLI
 * route writes exactly that to stdout and nothing else, which is what
 * `GetManifestLocal` parses.
 *
 * This route prints a file, so the interesting part is everything it refuses.
 * The path must be absolute, free of `.` / `..` segments and control
 * characters, named `manifest.json`, and sit directly inside a directory called
 * `slack-project` — so it can only ever name a file somawork materialized, and
 * the route cannot be turned into "print any file on this machine". Beyond the
 * shape: no symlink anywhere in the ancestry, a regular file, within
 * {@link MAX_MANIFEST_BYTES}, parsing to a JSON object that actually looks like
 * an app manifest.
 */
export async function runSlackManifestHelper(options: SlackManifestHelperOptions): Promise<string> {
  if (options === null || typeof options !== 'object') {
    throw new SlackProjectOptionsError('The manifest helper needs a manifest path.');
  }
  const { manifestPath } = options;
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    throw new SlackProjectOptionsError('The manifest helper needs a manifest path.');
  }
  if (DECODED_CONTROL_RE.test(manifestPath)) {
    throw new SlackProjectOptionsError('Refusing a manifest path containing a control character.');
  }
  if (!path.isAbsolute(manifestPath)) {
    throw new SlackProjectOptionsError('Refusing a relative manifest path; the hook must pass an absolute one.');
  }
  // Compare against the *lexically normalized* form so `a/../b` and `a/./b`
  // cannot smuggle a different target past the shape checks below.
  if (path.normalize(manifestPath) !== manifestPath) {
    throw new SlackProjectOptionsError('Refusing a manifest path that is not already normalized.');
  }
  if (path.basename(manifestPath) !== SLACK_PROJECT_MANIFEST_FILENAME) {
    throw new SlackProjectOptionsError(`Refusing a manifest path that is not a "${SLACK_PROJECT_MANIFEST_FILENAME}".`);
  }
  if (path.basename(path.dirname(manifestPath)) !== SLACK_PROJECT_DIRNAME) {
    throw new SlackProjectOptionsError(
      `Refusing a manifest path outside a somawork "${SLACK_PROJECT_DIRNAME}" directory.`,
    );
  }
  if (options.expectedManifestPath !== undefined && options.expectedManifestPath !== manifestPath) {
    throw new SlackProjectOptionsError("Refusing a manifest path other than this profile's materialized manifest.");
  }

  const maxBytes = options.maxBytes ?? MAX_MANIFEST_BYTES;
  const raw = options.readFile ? options.readFile(manifestPath) : readManifestFile(manifestPath, maxBytes);

  if (Buffer.byteLength(raw, 'utf-8') > maxBytes) {
    throw new SlackManifestSourceError('Refusing a manifest larger than the supported size.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SlackManifestSourceError('The materialized Slack manifest is not valid JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new SlackManifestSourceError('The materialized Slack manifest is not a JSON object.');
  }
  for (const key of ['display_information', 'features', 'oauth_config', 'settings']) {
    if (!(key in parsed)) {
      throw new SlackManifestSourceError(`The materialized Slack manifest is missing the "${key}" section.`);
    }
  }

  // The materialized bytes are already stable JSON plus a trailing newline
  // (`atomicWriteJson`), and `GetManifestLocal` scans from the first `{`, so
  // handing them back verbatim parses directly.
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

function readManifestFile(manifestPath: string, maxBytes: number): string {
  assertNoSymlinkPath(manifestPath);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(manifestPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SlackManifestSourceError('The materialized Slack manifest does not exist; run somawork setup again.');
    }
    throw err;
  }
  if (!stats.isFile()) {
    throw new SlackProjectOptionsError('Refusing a manifest path that is not a regular file.');
  }
  if (stats.size > maxBytes) {
    throw new SlackManifestSourceError('Refusing a manifest larger than the supported size.');
  }
  return fs.readFileSync(manifestPath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Canonical manifest
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the canonical manifest out of a runtime payload root.
 *
 * `explicitPath` bypasses the `runtimeRoot` join for a packaged layout; see
 * {@link MaterializeSlackProjectOptions.canonicalManifestPath}.
 */
export function readCanonicalSlackManifest(runtimeRoot: string, explicitPath?: string): unknown {
  if (explicitPath === undefined && (typeof runtimeRoot !== 'string' || runtimeRoot.length === 0)) {
    throw new SlackProjectOptionsError('A runtime root is required to locate the canonical Slack app manifest.');
  }
  const source = explicitPath ?? path.join(runtimeRoot, CANONICAL_MANIFEST_RELATIVE_PATH);

  let raw: string;
  try {
    assertNotSymlink(source);
    raw = fs.readFileSync(source, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SlackManifestSourceError(`Canonical Slack app manifest not found at "${source}".`);
    }
    throw err;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new SlackManifestSourceError(
      `Canonical Slack app manifest at "${source}" is not valid JSON: ${(err as Error).message}`,
    );
  }
}

function requireSection(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const section = source[key];
  if (!isPlainObject(section)) {
    throw new SlackManifestSourceError(`Canonical Slack app manifest is missing the "${key}" section.`);
  }
  return section;
}

/**
 * Derive the profile-specific manifest from the canonical one.
 *
 * Deep-cloned first, so a caller that reads the canonical file once and
 * materializes both profiles cannot have the second call see the first one's
 * names.
 */
export function buildProfileManifest(canonical: unknown, profile: ProfileName): SlackAppManifest {
  if (!isProfileName(profile)) {
    throw new SlackProjectOptionsError(`Unknown profile "${String(profile)}".`);
  }
  if (!isPlainObject(canonical)) {
    throw new SlackManifestSourceError('Canonical Slack app manifest must be a JSON object.');
  }

  const clone = structuredClone(canonical) as Record<string, unknown>;

  const display = requireSection(clone, 'display_information');
  const features = requireSection(clone, 'features');
  const botUser = requireSection(features, 'bot_user');
  requireSection(clone, 'oauth_config');
  requireSection(clone, 'settings');

  if (typeof display.name !== 'string') {
    throw new SlackManifestSourceError('Canonical Slack app manifest needs a string "display_information.name".');
  }
  if (typeof botUser.display_name !== 'string') {
    throw new SlackManifestSourceError('Canonical Slack app manifest needs a string "features.bot_user.display_name".');
  }

  const names = PROFILE_SLACK_APP_NAMES[profile];
  if (names.displayName.length > MAX_APP_NAME_CHARS) {
    throw new SlackProjectOptionsError(
      `Slack app name for profile "${profile}" exceeds ${MAX_APP_NAME_CHARS} characters.`,
    );
  }
  if (names.botDisplayName.length > MAX_BOT_DISPLAY_NAME_CHARS) {
    throw new SlackProjectOptionsError(
      `Slack bot display name for profile "${profile}" exceeds ${MAX_BOT_DISPLAY_NAME_CHARS} characters.`,
    );
  }

  display.name = names.displayName;
  botUser.display_name = names.botDisplayName;

  return clone as unknown as SlackAppManifest;
}

// ---------------------------------------------------------------------------
// App mapping
// ---------------------------------------------------------------------------

function readMappingJson(file: string): unknown | null {
  assertNotSymlink(file);

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return null;
    }
    throw err;
  }

  // `readLocalApps` treats an empty/whitespace-only file as "nothing saved
  // yet" (`internal/app/app_client.go:390-399`); matching that keeps a
  // freshly-initialized project from looking corrupt.
  if (raw.trim().length === 0) return null;

  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new SlackAppMappingError(
      `Slack app mapping "${file}" is not valid JSON (${(err as Error).message}). ` +
        'Fix or move the file by hand; somawork will not overwrite it.',
    );
  }
}

function normalizeEntry(
  file: string,
  key: string,
  value: unknown,
): { appId?: string; teamId?: string; teamDomain?: string } {
  if (!isPlainObject(value)) {
    throw new SlackAppMappingError(`Slack app mapping "${file}" entry "${safeLabel(key)}" is not an object.`);
  }

  const entry: { appId?: string; teamId?: string; teamDomain?: string } = {};

  if (value.app_id !== undefined) {
    if (typeof value.app_id !== 'string' || !APP_ID_RE.test(value.app_id)) {
      throw new SlackAppMappingError(`Slack app mapping "${file}" entry "${safeLabel(key)}" has a malformed "app_id".`);
    }
    entry.appId = value.app_id;
  }
  if (value.team_id !== undefined) {
    if (typeof value.team_id !== 'string' || value.team_id.length === 0) {
      throw new SlackAppMappingError(
        `Slack app mapping "${file}" entry "${safeLabel(key)}" has a malformed "team_id".`,
      );
    }
    entry.teamId = value.team_id;
  }
  if (value.team_domain !== undefined) {
    if (typeof value.team_domain !== 'string' || value.team_domain.length > MAX_TEAM_DOMAIN_CHARS) {
      throw new SlackAppMappingError(
        `Slack app mapping "${file}" entry "${safeLabel(key)}" has a malformed "team_domain".`,
      );
    }
    if (value.team_domain.length > 0) entry.teamDomain = value.team_domain;
  }

  return entry;
}

/**
 * Find the app recorded for `teamId` in one mapping file.
 *
 * Historical files were keyed by team *domain* and migrated in place
 * (`internal/app/app_client.go:452-478`), so a match is "key is the Team ID" or
 * "the entry's own `team_id` is". Two matches, or a key that disagrees with the
 * entry it holds, are refused rather than resolved: picking a winner here is
 * picking which Slack app a workspace gets.
 */
function findMapping(
  file: string,
  entries: Record<string, unknown>,
  teamId: string,
  source: 'dev' | 'deployed',
): SlackAppMapping | null {
  const matches: Array<[string, { appId?: string; teamId?: string; teamDomain?: string }]> = [];

  for (const [key, value] of Object.entries(entries)) {
    const entry = normalizeEntry(file, key, value);
    if (key === teamId || entry.teamId === teamId) matches.push([key, entry]);
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new SlackAppMappingError(
      `Slack app mapping "${file}" holds ${matches.length} entries for team ${teamId}. ` +
        'Remove the stale one by hand; somawork will not choose between them.',
    );
  }

  const [key, entry] = matches[0];
  if (entry.teamId !== undefined && entry.teamId !== teamId) {
    throw new SlackAppMappingError(
      // NB-2: `entry.teamId` is arbitrary content read out of `.slack/apps*.json`
      // and validated only as a non-empty string, so it goes through the same
      // gate as every other untrusted identifier this module prints.
      `Slack app mapping "${file}" entry "${safeLabel(key)}" is keyed for team ${teamId} but records team ` +
        `${safeIdLabel(entry.teamId)}.`,
    );
  }
  if (entry.appId === undefined) {
    throw new SlackAppMappingError(`Slack app mapping "${file}" entry "${safeLabel(key)}" records no "app_id".`);
  }

  return {
    appId: entry.appId,
    teamId,
    ...(entry.teamDomain === undefined ? {} : { teamDomain: entry.teamDomain }),
    source,
  };
}

/**
 * Read the app recorded for `teamId`, dev mapping first.
 *
 * Both files are validated on every call even when the dev one already
 * answered, so a corrupt deployed mapping surfaces at setup time rather than
 * the first time somebody deploys.
 */
export function readSlackAppMapping(projectRoot: string, teamId: string): SlackAppMapping | null {
  assertStandardTeamId(teamId);

  const devFile = path.join(projectRoot, SLACK_PROJECT_DOT_DIR, SLACK_DEV_APPS_FILENAME);
  const deployedFile = path.join(projectRoot, SLACK_PROJECT_DOT_DIR, SLACK_DEPLOYED_APPS_FILENAME);

  // `saveLocalApps` writes `map[string]types.App` at the top level.
  const devRaw = readMappingJson(devFile);
  let dev: SlackAppMapping | null = null;
  if (devRaw !== null) {
    if (!isPlainObject(devRaw)) {
      throw new SlackAppMappingError(`Slack app mapping "${devFile}" must be a JSON object keyed by Team ID.`);
    }
    dev = findMapping(devFile, devRaw, teamId, 'dev');
  }

  // `saveDeployedApps` writes `{"apps": {...}, "default": "..."}`.
  const deployedRaw = readMappingJson(deployedFile);
  let deployed: SlackAppMapping | null = null;
  if (deployedRaw !== null) {
    if (!isPlainObject(deployedRaw)) {
      throw new SlackAppMappingError(`Slack app mapping "${deployedFile}" must be a JSON object.`);
    }
    const apps = deployedRaw.apps;
    if (apps !== undefined) {
      if (!isPlainObject(apps)) {
        throw new SlackAppMappingError(`Slack app mapping "${deployedFile}" has a malformed "apps" section.`);
      }
      deployed = findMapping(deployedFile, apps, teamId, 'deployed');
    }
  }

  return dev ?? deployed;
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

function assertUsableSocketPath(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath, 'utf-8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new SlackProjectOptionsError(
      `The Slack capture socket path is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte platform limit ` +
        `("${socketPath}"). Use a shorter profile state directory.`,
    );
  }
}

/**
 * Create or refresh the profile's Slack CLI project and report its paths.
 *
 * Idempotent: calling it twice writes an identical manifest, and a hooks file
 * identical except for the freshly minted capture nonce (I-1) — which is the
 * one field that MUST change per run, since it is what proves the frame came
 * from the child this run started. The app mapping files are read, never
 * written — see the module doc for why that is the whole point.
 *
 * `stateDir` is an explicit input rather than something recomputed here so this
 * module and the rest of setup cannot disagree about where a profile lives;
 * pass `profilePaths(home, profile).stateDir`.
 */
export function materializeSlackProject(
  profile: ProfileName,
  teamId: string,
  runtimeRoot: string,
  options: MaterializeSlackProjectOptions,
): SlackProject {
  // Every argument check happens before the first byte is read or written, so a
  // refusal leaves the machine exactly as it was.
  if (!isProfileName(profile)) {
    throw new SlackProjectOptionsError(`Unknown profile "${String(profile)}". Expected "preview" or "production".`);
  }
  assertStandardTeamId(teamId);
  if (
    options === null ||
    typeof options !== 'object' ||
    typeof options.stateDir !== 'string' ||
    options.stateDir.length === 0
  ) {
    throw new SlackProjectOptionsError('materializeSlackProject needs a profile `stateDir`.');
  }

  const controllerCommand = options.controllerCommand ?? DEFAULT_CONTROLLER_COMMAND;
  const stateDir = path.resolve(options.stateDir);
  const root = path.join(stateDir, SLACK_PROJECT_DIRNAME);
  const socketPath = path.join(stateDir, CAPTURE_SOCKET_DIRNAME, CAPTURE_SOCKET_FILENAME);

  assertUsableSocketPath(socketPath);

  const manifestPath = path.join(root, SLACK_PROJECT_MANIFEST_FILENAME);
  const hooksPath = path.join(root, SLACK_PROJECT_DOT_DIR, SLACK_HOOKS_FILENAME);
  const devAppsPath = path.join(root, SLACK_PROJECT_DOT_DIR, SLACK_DEV_APPS_FILENAME);
  const deployedAppsPath = path.join(root, SLACK_PROJECT_DOT_DIR, SLACK_DEPLOYED_APPS_FILENAME);

  // A fresh challenge per materialization, i.e. per setup run: the previous
  // run's nonce is worthless the moment this file is rewritten.
  const captureNonce = generateCaptureNonce();
  const hooksFile = buildSlackHooksFile({ socketPath, manifestPath, captureNonce, controllerCommand });
  const manifest = buildProfileManifest(
    readCanonicalSlackManifest(runtimeRoot, options.canonicalManifestPath),
    profile,
  );

  // Read the mapping before writing anything: an unreadable mapping must abort
  // the whole materialization, not leave a half-refreshed project behind.
  const appMapping = readSlackAppMapping(root, teamId);

  // Prove both destinations are ours before the first write, so a planted
  // symlink cannot let one file land and the other fail.
  assertNoSymlinkPath(manifestPath);
  assertNoSymlinkPath(hooksPath);

  atomicWriteJson(manifestPath, manifest, { mode: FILE_MODE, dirMode: DIR_MODE });
  atomicWriteJson(hooksPath, hooksFile, { mode: FILE_MODE, dirMode: DIR_MODE });

  return {
    profile,
    teamId,
    root,
    manifestPath,
    hooksPath,
    devAppsPath,
    deployedAppsPath,
    socketPath,
    captureNonce,
    appMapping,
  };
}
