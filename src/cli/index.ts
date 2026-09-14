#!/usr/bin/env node
/**
 * `somawork` — the controller CLI.
 *
 * ## Three properties this router exists to hold
 *
 * **1. The private hook routes are reachable, silent, and isolated.** The Slack
 * CLI's `.slack/hooks.json` invokes `somawork _capture-slack-auth` and
 * `somawork _print-slack-manifest`. Neither is a product command: they are not
 * in {@link parseCli}'s grammar, never appear in an error message or help text,
 * and are dispatched *before* the public parser gets a chance to reject them as
 * unknown. `_print-slack-manifest`'s stdout is the Slack CLI's `get-manifest`
 * contract, so it must be the helper's JSON and nothing else;
 * `_capture-slack-auth` writes nothing at all on success and a fixed, redacted
 * line on failure. Both routes import their module lazily so an unrelated
 * command never pays for — or gets polluted by — the other's module graph.
 *
 * **2. `doctor --json` produces one JSON document, whatever the runtime says.**
 * `doctorReportToJson` serializes correctly, but correctness of the *string* is
 * not purity of the *stream*: the default doctor seams lazily import
 * `src/config`, `src/config-loader` and the llmux client, and those modules log
 * on import (`[env-paths] …`) and during use. A consumer running
 * `somawork doctor --json | jq` gets a parse error from output nobody wrote on
 * purpose. So the JSON path runs inside {@link captureAmbientOutput}, which
 * redirects `process.stdout`, `process.stderr` and every `console` method — the
 * sinks `Logger` writes through — for the *entire* command, restores them in
 * `finally`, and only then writes exactly one document to the real stdout. The
 * captured bytes are scanned and dropped; nothing from them reaches the report.
 *
 * **3. No arbitrary error's `.message` is ever printed.** Only errors this
 * repository authored with a documented fixed message are rendered verbatim
 * ({@link SAFE_MESSAGE_ERRORS}). Everything else — a rejected `launchctl`
 * spawn, a provider client's error, a thrown string — becomes fixed redacted
 * text plus a validated class name. This closes Task 9's documented minor
 * (a raw `launchctl print` rejection escaping untyped and carrying its path).
 */

import { redactSecrets } from '@soma/common/logger';
import { getSomaHome } from '@soma/common/soma-paths';
import * as fs from 'fs';
import * as path from 'path';
import { CliArgError, type CliCommand, parseCli, publicCommandSummaries } from './args';
import type { DoctorReport } from './doctor';
import {
  type ProfileName,
  type ProfilePaths,
  ProfileResolutionError,
  profilePaths,
  type RuntimeInstall,
} from './profile';
import { ServiceError, type ServiceStatus } from './service';
import type { ProfileReceipt } from './setup/materialize';
import { SETUP_PENDING_EXIT_CODE, type SetupDeps, SetupError, type SetupOutcome } from './setup/orchestrator';
import { CAPTURE_HOOK_SUBCOMMAND, MANIFEST_HOOK_SUBCOMMAND } from './setup/slack-manifest';

// ---------------------------------------------------------------------------
// Fixed output vocabulary
// ---------------------------------------------------------------------------

const GENERIC_FAILURE =
  'somawork: the command did not complete. Run `somawork doctor` for a secret-safe diagnosis, and `somawork setup` to repair the profile.';

/** Fixed refusal for either private hook route. Says nothing about the input. */
const HELPER_FAILURE = 'somawork: the Slack hook helper failed.';

/** A class name is the only fragment of a foreign error worth repeating. */
const SAFE_ERROR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Error classes whose `message` is written in this repository from fixed
 * strings and is documented to carry no path, credential, or provider text.
 *
 * `ServiceError` qualifies by construction (`service.ts`: "Nothing observed …
 * is ever interpolated into `message`"), and is additionally required to carry
 * a `code`, so an untyped rejection that merely *looks* like one is still
 * reduced.
 */
const SAFE_MESSAGE_ERRORS: readonly Function[] = [CliArgError, SetupError, ProfileResolutionError, ServiceError];

/**
 * Render any thrown value as one operator-facing line.
 *
 * The allowlist is positive: an error must be recognised to have its message
 * printed. Anything else contributes only its validated class name, which is
 * enough to route a bug report and cannot carry a token, a URL, or a path.
 */
export function describeCliError(error: unknown): string {
  if (error instanceof ServiceError && typeof error.code === 'string') {
    return `somawork: ${error.message}`;
  }
  for (const ctor of SAFE_MESSAGE_ERRORS) {
    if (error instanceof (ctor as new (...args: never[]) => Error)) {
      return `somawork: ${error.message}`;
    }
  }
  return `${GENERIC_FAILURE} (${safeErrorName(error)})`;
}

// ---------------------------------------------------------------------------
// Ambient output capture
// ---------------------------------------------------------------------------

/** Every sink `@soma/common`'s `Logger` and the runtime modules write through. */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

interface AmbientCapture {
  restore(): void;
  text(): string;
  /** Write to the REAL stdout, bypassing the capture. */
  writeThrough(text: string): void;
}

/**
 * Redirect every ambient output sink into a buffer.
 *
 * Deliberately not seven targeted logger edits: the noise comes from module
 * *import* side effects and from third-party code, so the only boundary that
 * actually holds is the process-local one. `restore()` is idempotent and is
 * always called from a `finally`.
 */
function captureAmbientOutput(): AmbientCapture {
  const chunks: string[] = [];
  const realStdoutWrite = process.stdout.write;
  const realStderrWrite = process.stderr.write;
  const realConsole = CONSOLE_METHODS.map((method) => [method, console[method]] as const);
  let restored = false;

  const patchedWrite = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') (done as () => void)();
    return true;
  };

  process.stdout.write = patchedWrite as typeof process.stdout.write;
  process.stderr.write = patchedWrite as typeof process.stderr.write;
  for (const method of CONSOLE_METHODS) {
    console[method] = ((...args: unknown[]) => {
      chunks.push(`${args.map((arg) => (typeof arg === 'string' ? arg : safeInspect(arg))).join(' ')}\n`);
    }) as (typeof console)[typeof method];
  }

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      process.stdout.write = realStdoutWrite;
      process.stderr.write = realStderrWrite;
      for (const [method, original] of realConsole) {
        console[method] = original;
      }
    },
    text: () => chunks.join(''),
    writeThrough: (text) => {
      realStdoutWrite.call(process.stdout, text);
    },
  };
}

function safeInspect(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Tail of the JSON-command queue.
 *
 * {@link captureAmbientOutput} patches **process-global** sinks, so two
 * overlapping captures nest: the inner one's saved "real" write *is the outer
 * one's patched write*, and on restore the inner command's document lands in the
 * outer buffer and is discarded. Both commands then report success while one
 * document silently vanishes.
 *
 * Serializing is preferred over a nesting/capture-stack design because a stack
 * still has to decide whose buffer an inner write belongs to; a queue removes
 * the overlap entirely, so each command captures, writes, and restores alone.
 * The shipped binary runs one command per process, but `runCli` is exported for
 * embedders and tests, and silent output loss is not an acceptable failure mode
 * for either.
 *
 * **Every** body that captures belongs here, including the private
 * `_print-slack-manifest` route: its stdout *is* a JSON document (the Slack
 * CLI's `get-manifest` contract), so leaving it outside the queue reproduced
 * exactly this defect at the one call site that did not look like a "JSON
 * command".
 *
 * **Known limit, deliberately not closed here.** The queue covers JSON bodies
 * only. An embedder that overlaps a *text* command with a JSON one still loses
 * the text output into the JSON command's capture buffer: text routes write
 * incrementally to a live terminal, and serializing them would either buffer a
 * long-running `setup`'s progress or make every command wait on every other.
 * The shipped binary runs one command per process, so this is an embedder-only
 * hazard; it is recorded rather than papered over.
 */
let jsonCommandQueue: Promise<void> = Promise.resolve();

/**
 * Run `body` with exclusive ownership of the process output sinks.
 *
 * The lock is released in `finally`, so a hostile error, a rejected body, or a
 * `process.stdout.write` that throws (EPIPE) cannot wedge every later command.
 *
 * The queue holds only `resolve`-able promises — `release` is a bare `resolve`
 * called from `finally` and the body's own rejection is re-thrown to the caller,
 * never attached to the queue — so awaiting a predecessor cannot itself reject.
 * That invariant is why there is no `.catch()` here to swallow: a guard on an
 * unreachable branch is a guard nothing can test.
 */
async function withJsonOutputLock<T>(body: () => Promise<T>): Promise<T> {
  const predecessor = jsonCommandQueue;
  let release: () => void = () => {};
  jsonCommandQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await body();
  } finally {
    release();
  }
}

/**
 * Redact the captured bytes and drop them.
 *
 * They are never returned, logged, or embedded. The redaction happens anyway so
 * that this is the one place a future change that *does* want to surface the
 * capture has to go through, rather than reaching a raw buffer.
 */
function scrubAndDiscard(captured: string): void {
  void redactSecrets(captured);
}

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

export interface CliOverrides {
  home?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  /** Replaces the orchestrator. Production passes nothing. */
  runSetup?: (deps: SetupDeps) => Promise<SetupOutcome>;
  /** Replaces the whole doctor computation for `doctor` / `status`. */
  computeDoctorReport?: (profile: ProfileName) => Promise<DoctorReport>;
  discoverRuntimes?: () => Promise<RuntimeInstall[]>;
  /** Replaces the `_capture-slack-auth` body. */
  captureHelper?: (socketPath: string) => Promise<void>;
  /** Replaces the `_print-slack-manifest` body; returns the JSON to print. */
  manifestHelper?: (manifestPath: string) => Promise<string>;
  /** Replaces the service manager factory for `somawork service …`. */
  serviceManager?: (profile: ProfileName) => Promise<{
    install(): Promise<ServiceStatus>;
    start(): Promise<ServiceStatus>;
    stop(): Promise<ServiceStatus>;
    restart(): Promise<ServiceStatus>;
    status(): Promise<ServiceStatus>;
  }>;
}

/**
 * The somawork home for this invocation.
 *
 * Delegates to `@soma/common/soma-paths`, which owns the
 * `SOMAWORK_HOME` → `SOMA_HOME` → OS-home precedence. Importing that module is
 * free of side effects, which matters here: `env-paths` next door spawns `git`
 * and prints a banner at load, and this function is on the path of every
 * command including `doctor --json`.
 */
function resolveHome(overrides: CliOverrides): string {
  if (overrides.home !== undefined) return overrides.home;
  return getSomaHome(overrides.env ?? process.env);
}

// ---------------------------------------------------------------------------
// Controller version
// ---------------------------------------------------------------------------

/** Printed when the controller's own `package.json` cannot be read. */
const UNKNOWN_VERSION = 'unknown';

/**
 * The controller version, from the package manifest beside the runtime root.
 *
 * `__dirname` is `<root>/dist/cli` in a packaged install and `<repo>/src/cli`
 * from source — the same depth in both, so one relative path answers in the
 * staged layout Task 11 smokes and in a checkout. Reads no profile, starts no
 * provider, and never throws: a version command that needs a working install is
 * useless exactly when it is needed.
 */
function readControllerVersion(): string {
  return readControllerVersionFrom(path.resolve(__dirname, '..', '..', 'package.json'));
}

/** Bounded, non-secret version shape. Anything else is reported as unknown. */
const CONTROLLER_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/**
 * Read a version out of one package manifest, or {@link UNKNOWN_VERSION}.
 *
 * Exported so the "never throws" half of the contract is testable against a
 * missing file, a directory, non-JSON bytes, and a manifest whose `version` is
 * absent or out of charset — none of which are reachable through the
 * `__dirname`-derived path a test actually runs under.
 */
export function readControllerVersionFrom(manifestPath: string): string {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return UNKNOWN_VERSION;
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' && CONTROLLER_VERSION_RE.test(version) ? version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run one CLI invocation and return its exit code.
 *
 * Exported (rather than executed at import) so the routing, the stream
 * boundaries and the error rendering are testable without spawning a process.
 */
export async function runCli(argv: string[], overrides: CliOverrides = {}): Promise<number> {
  // --- private hook routes, ahead of the public grammar -------------------
  if (argv[0] === CAPTURE_HOOK_SUBCOMMAND) return runCaptureRoute(argv.slice(1), overrides);
  if (argv[0] === MANIFEST_HOOK_SUBCOMMAND) return runManifestRoute(argv.slice(1), overrides);

  let command: CliCommand;
  try {
    command = parseCli(argv);
  } catch (error) {
    if (error instanceof CliArgError) {
      process.stderr.write(`somawork: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`${describeCliError(error)}\n`);
    return 1;
  }

  try {
    switch (command.command) {
      case 'setup':
        return await runSetupCommand(command, overrides);
      case 'doctor':
        return await runDoctorCommand(command.profile, command.json, overrides);
      case 'status':
        return await runStatusCommand(command.profile, command.json, overrides);
      case 'service':
        return await runServiceCommand(command, overrides);
      case 'profile':
        return await runProfileCommand(command, overrides);
      case 'sessions':
        return await runSessionsRoute(command, overrides);
      case 'help':
        return runHelpCommand();
      case 'version':
        return runVersionCommand();
    }
  } catch (error) {
    process.stderr.write(`${describeCliError(error)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// help / version
// ---------------------------------------------------------------------------

/**
 * `somawork help` — rendered from the parser's own grammar table.
 *
 * Generated rather than hand-written so it cannot drift from what `parseCli`
 * accepts, and so the two private hook subcommands — which are not in that
 * table — can never appear here. Nothing is discovered, loaded, or probed.
 */
function runHelpCommand(): number {
  const rows = publicCommandSummaries();
  const width = Math.max(...rows.map((row) => row.usage.length));
  process.stdout.write('somawork — set up and operate a soma-work profile.\n\n');
  for (const row of rows) {
    process.stdout.write(`  ${row.usage.padEnd(width)}  ${row.summary}\n`);
  }
  process.stdout.write('\nSOMAWORK_HOME overrides the profile root (SOMA_HOME is accepted as an alias).\n');
  return 0;
}

/** `somawork version` — package metadata only; no runtime, profile, or provider. */
function runVersionCommand(): number {
  process.stdout.write(`${readControllerVersion()}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Private hook routes
// ---------------------------------------------------------------------------

/**
 * `somawork _capture-slack-auth --socket <path>`.
 *
 * Runs as the Slack CLI's `start` hook with the runtime tokens in its
 * environment. Success is *silence*: the Slack CLI treats hook stdout as data,
 * and anything printed here is a token-adjacent byte on a stream somebody may
 * be logging. Failure is one fixed line that describes nothing it saw.
 */
async function runCaptureRoute(argv: string[], overrides: CliOverrides): Promise<number> {
  try {
    // Lazy: keeps `net`, the capture protocol, and their transitive graph out of
    // every other command's import cost — and keeps their module-load output out
    // of this route, which must print nothing.
    const { parseCaptureHelperArgv, runSlackAuthCaptureHelper, BOT_TOKEN_ENV_NAMES, APP_TOKEN_ENV_NAMES } =
      await import('./setup/slack-capture');
    const { socketPath, nonce } = parseCaptureHelperArgv(argv);

    if (overrides.captureHelper !== undefined) {
      await overrides.captureHelper(socketPath);
      return 0;
    }

    // The environment snapshot is the existing explicit allowlist — never
    // `process.env` wholesale, so nothing beyond the four documented names can
    // reach the helper.
    const env: Record<string, string | undefined> = {};
    for (const name of [...BOT_TOKEN_ENV_NAMES, ...APP_TOKEN_ENV_NAMES]) {
      env[name] = process.env[name];
    }

    await runSlackAuthCaptureHelper({ env, socketPath, nonce });
    return 0;
  } catch {
    // The caught value is never inspected: for this route it is the single most
    // likely object in the process to hold a token, a socket path, or a frame.
    process.stderr.write(`${HELPER_FAILURE}\n`);
    return 1;
  }
}

/**
 * `somawork _print-slack-manifest --manifest <path>`.
 *
 * The Slack CLI's `get-manifest` hook: its stdout **is** the manifest. Any other
 * byte on the stream is a manifest parse error at app-create time, so the whole
 * body runs inside the ambient capture and only the helper's own JSON is written
 * through afterwards. Reads no profile state and no secret.
 */
async function runManifestRoute(argv: string[], overrides: CliOverrides): Promise<number> {
  // Under the same lock as doctor/status/profile: this route captures the
  // process-global sinks and writes a JSON document, so overlapping it with one
  // of those nested the captures and silently dropped the other's document.
  // The whole capture → restore → scrub → write sequence is inside.
  return withJsonOutputLock(async () => {
    const capture = captureAmbientOutput();
    let document: string | null = null;
    try {
      const { parseManifestHelperArgv, runSlackManifestHelper } = await import('./setup/slack-manifest');
      const { manifestPath } = parseManifestHelperArgv(argv);
      document =
        overrides.manifestHelper !== undefined
          ? await overrides.manifestHelper(manifestPath)
          : await runSlackManifestHelper({ manifestPath });
    } catch {
      // Never inspected: for this route the caught value is the likeliest object
      // in the process to hold a token, a socket path, or a manifest fragment.
      document = null;
    } finally {
      capture.restore();
    }

    scrubAndDiscard(capture.text());

    if (document === null) {
      process.stderr.write(`${HELPER_FAILURE}\n`);
      return 1;
    }
    // The helper already newline-terminates its JSON; adding a second one would
    // put a blank line on a stream the Slack CLI parses.
    process.stdout.write(document.endsWith('\n') ? document : `${document}\n`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function runSetupCommand(
  command: Extract<CliCommand, { command: 'setup' }>,
  overrides: CliOverrides,
): Promise<number> {
  const deps = await buildSetupDeps(command, overrides);
  const run = overrides.runSetup ?? (await import('./setup/orchestrator')).runSetup;
  const outcome = await run(deps);

  if (outcome.status === 'pending-slack-approval') {
    process.stdout.write(
      `somawork: the "${outcome.profile}" Slack app (${outcome.appId ?? 'not yet created'}) is waiting for a workspace admin to approve its installation.\n` +
        'Once approved, run `somawork setup` again — it resumes here and will not create another app.\n',
    );
    return SETUP_PENDING_EXIT_CODE;
  }
  return 0;
}

async function buildSetupDeps(
  command: Extract<CliCommand, { command: 'setup' }>,
  overrides: CliOverrides,
): Promise<SetupDeps> {
  const home = resolveHome(overrides);
  const [orchestrator, host, llmux, slackAuth, slackCapture, slackManifest, materialize, secrets, state, prod] =
    await Promise.all([
      import('./setup/orchestrator'),
      import('./setup/real-host'),
      import('./setup/llmux'),
      import('./setup/slack-auth'),
      import('./setup/slack-capture'),
      import('./setup/slack-manifest'),
      import('./setup/materialize'),
      import('./setup/secrets'),
      import('./setup/state'),
      import('./production-seams'),
    ]);

  return {
    host: new host.RealHost(),
    home,
    uid: overrides.uid ?? prod.currentUid(),
    now: () => new Date().toISOString(),
    ...(command.profile === undefined ? {} : { requestedProfile: command.profile }),
    resume: command.resume,
    discoverRuntimes:
      overrides.discoverRuntimes ??
      (() => orchestrator.discoverRuntimes({ host: new host.RealHost(), fs: prod.createRuntimeDiscoveryFs() })),
    prompt: prod.createTerminalPrompt(),
    output: prod.createTerminalOutput(),
    workspaceFs: prod.createWorkspaceFs(),
    createStateStore: (profile, stateDir) => new state.SetupStateStore({ profile, stateDir }),
    ensureLlmux: llmux.ensureLlmux,
    ensureSlackCliAuth: slackAuth.ensureSlackCliAuth,
    materializeSlackProject: slackManifest.materializeSlackProject,
    captureSlackTokens: slackCapture.captureAndPersistSlackRuntimeTokens,
    secretSink: (secretsFile) => new secrets.SecretStore({ secretsFile }),
    readSlackAppMapping: slackManifest.readSlackAppMapping,
    readExistingBaseDirectory: prod.readExistingBaseDirectory,
    materializeProfile: materialize.materializeProfile,
    packagedAssets: prod.packagedAssets,
    runDoctor: (input) => prod.runProfileDoctor(input),
    createServiceManager: (input) =>
      prod.createServiceManager({ ...input, home, uid: overrides.uid ?? prod.currentUid() }),
  };
}

// ---------------------------------------------------------------------------
// doctor / status
// ---------------------------------------------------------------------------

async function computeReport(profile: ProfileName, overrides: CliOverrides): Promise<DoctorReport> {
  if (overrides.computeDoctorReport !== undefined) return overrides.computeDoctorReport(profile);
  const prod = await import('./production-seams');
  return prod.runDoctorForProfile({ profile, home: resolveHome(overrides), uid: overrides.uid ?? prod.currentUid() });
}

async function resolveCommandProfile(
  requested: ProfileName | undefined,
  overrides: CliOverrides,
): Promise<ProfileName> {
  if (requested !== undefined) return requested;
  const { resolveProfile } = await import('./profile');
  return resolveProfile({ installed: await discoverForCommand(overrides) });
}

/**
 * `somawork doctor [--json]`.
 *
 * The JSON branch is the whole reason {@link captureAmbientOutput} exists — see
 * the module doc. Text mode keeps ordinary progress: a human running `doctor`
 * benefits from the runtime's own chatter, a pipe does not.
 */
async function runDoctorCommand(
  requested: ProfileName | undefined,
  json: boolean,
  overrides: CliOverrides,
): Promise<number> {
  if (!json) {
    const profile = await resolveCommandProfile(requested, overrides);
    const report = await computeReport(profile, overrides);
    renderDoctorText(report);
    return report.ok ? 0 : 1;
  }

  return withJsonOutputLock(async () => {
    const capture = captureAmbientOutput();
    let outcome: JsonOutcome;
    try {
      const profile = await resolveCommandProfile(requested, overrides);
      const { doctorReportToJson } = await import('./doctor');
      const report = await computeReport(profile, overrides);
      outcome = serializeJsonOutcome({ profile, ok: report.ok, build: () => doctorReportToJson(report) });
    } catch (error) {
      // `requested`, not the resolved profile: this path can fail *before* one
      // was resolved, and inventing a name for a profile we never reached would
      // be worse than reporting `null`.
      outcome = { ok: false, document: failureDocument(requested ?? null, error) };
    } finally {
      // Always, and before anything is written: a throw between here and the
      // write would otherwise leave the process with no usable stdout.
      capture.restore();
    }

    scrubAndDiscard(capture.text());
    process.stdout.write(`${outcome.document}\n`);
    // The exit code is derived from the same value that produced the document,
    // so an emitted `ok:false` can never be paired with a zero exit.
    return outcome.ok ? 0 : 1;
  });
}

/**
 * The document emitted when even {@link failureDocument} cannot be built.
 *
 * Frozen and pre-serialized so producing it involves no property read, no
 * serializer, and nothing that can throw. `doctor --json` writing *zero bytes*
 * is the worst outcome available — `| jq` fails on empty input with no clue —
 * so there is always something to write.
 */
export const FALLBACK_FAILURE_DOCUMENT = JSON.stringify(
  { profile: null, ok: false, checks: [], error: 'Error' },
  null,
  2,
);

/**
 * A class name is the only fragment of a foreign error worth repeating — and
 * even reading it can throw.
 *
 * `name` may be a getter that throws, a Proxy trap that throws, an object whose
 * `toString` throws, or absent entirely (a thrown string, symbol, number,
 * `null`, `undefined`). Every one of those reduces to the constant `'Error'`
 * rather than propagating, because this function is called from inside a
 * `catch` whose whole job is to still produce a document.
 */
function safeErrorName(error: unknown): string {
  try {
    const name = (error as { name?: unknown } | null | undefined)?.name;
    return typeof name === 'string' && SAFE_ERROR_NAME_RE.test(name) ? name : 'Error';
  } catch {
    return 'Error';
  }
}

/** A serialized document plus the exit disposition that must accompany it. */
interface JsonOutcome {
  ok: boolean;
  document: string;
}

/**
 * Serialize a success shape, or degrade to a failure document — and make the
 * exit code agree with whichever one is emitted.
 *
 * The three JSON routes used to latch `ok` from the report *before* serializing
 * and leave it alone in the `catch`. A serializer failure therefore emitted
 * `{"ok": false, …}` and exited **0**: a document saying the command failed,
 * next to an exit code telling `set -e` it succeeded. Whatever the branch's
 * reachability, an emitted `ok:false` and a zero exit must never coexist, so the
 * decision is made in one place that owns both halves.
 */
function serializeJsonOutcome(input: { profile: ProfileName | null; ok: boolean; build: () => string }): JsonOutcome {
  try {
    const document = input.build();
    // `JSON.stringify` can return `undefined` without throwing.
    if (typeof document !== 'string' || document.length === 0) {
      return { ok: false, document: FALLBACK_FAILURE_DOCUMENT };
    }
    return { ok: input.ok, document };
  } catch (error) {
    return { ok: false, document: failureDocument(input.profile, error) };
  }
}

/**
 * The one JSON document emitted when the report could not be produced at all.
 *
 * Shaped like a report so a consumer's `.ok` check works, and carrying only a
 * validated class name — never the throw's message, which for the llmux and
 * Slack clients embeds the endpoint it was talking to.
 *
 * **Total for every JavaScript value.** The error object is never enumerated,
 * never serialized, and never stringified; only {@link safeErrorName}'s bounded
 * result reaches the document, and a serializer failure falls back to
 * {@link FALLBACK_FAILURE_DOCUMENT}.
 */
function failureDocument(profile: ProfileName | null, error: unknown): string {
  try {
    const document = JSON.stringify({ profile, ok: false, checks: [], error: safeErrorName(error) }, null, 2);
    // Postcondition, not decoration: `JSON.stringify` returns `undefined` for
    // some inputs rather than throwing, and writing "undefined" to a stream a
    // consumer pipes into `jq` is the same failure as writing nothing.
    return typeof document === 'string' && document.length > 0 ? document : FALLBACK_FAILURE_DOCUMENT;
  } catch {
    return FALLBACK_FAILURE_DOCUMENT;
  }
}

function renderDoctorText(report: DoctorReport): void {
  const symbol = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;
  process.stdout.write(`somawork doctor — profile ${report.profile}\n`);
  for (const check of report.checks) {
    process.stdout.write(`  [${symbol[check.status]}] ${check.id}: ${check.detail}\n`);
  }
  process.stdout.write(report.ok ? '\nAll mandatory checks passed.\n' : '\nOne or more checks failed.\n');
}

/**
 * `somawork status [--json]`.
 *
 * Surfaces Task 9's structured `ServiceStatus` alongside the doctor verdict.
 * Both are already secret-free receipts built from derived values — no plist
 * bytes, no environment, no readiness-file contents.
 */
async function runStatusCommand(
  requested: ProfileName | undefined,
  json: boolean,
  overrides: CliOverrides,
): Promise<number> {
  if (!json) {
    const profile = await resolveCommandProfile(requested, overrides);
    const report = await computeReport(profile, overrides);
    const service = await readServiceStatus(profile, overrides);
    renderDoctorText(report);
    if (service !== null) {
      process.stdout.write(`\nService: ${service.label} — ${service.state} (ready: ${service.ready})\n`);
    }
    return report.ok ? 0 : 1;
  }

  return withJsonOutputLock(async () => {
    const capture = captureAmbientOutput();
    let outcome: JsonOutcome;
    try {
      const profile = await resolveCommandProfile(requested, overrides);
      const report = await computeReport(profile, overrides);
      const service = await readServiceStatus(profile, overrides);
      outcome = serializeJsonOutcome({
        profile,
        ok: report.ok,
        build: () => JSON.stringify({ profile, ok: report.ok, checks: report.checks, service }, null, 2),
      });
    } catch (error) {
      outcome = { ok: false, document: failureDocument(requested ?? null, error) };
    } finally {
      capture.restore();
    }

    scrubAndDiscard(capture.text());
    process.stdout.write(`${outcome.document}\n`);
    return outcome.ok ? 0 : 1;
  });
}

async function readServiceStatus(profile: ProfileName, overrides: CliOverrides): Promise<ServiceStatus | null> {
  try {
    const manager = await buildServiceManager(profile, overrides);
    return await manager.status();
  } catch {
    // A profile that has never had a service installed is a normal state, not a
    // status failure. The doctor above already reports what is actually wrong.
    return null;
  }
}

// ---------------------------------------------------------------------------
// service / profile
// ---------------------------------------------------------------------------

async function buildServiceManager(profile: ProfileName, overrides: CliOverrides) {
  if (overrides.serviceManager !== undefined) return overrides.serviceManager(profile);
  const prod = await import('./production-seams');
  return prod.createProfileServiceManager({
    profile,
    home: resolveHome(overrides),
    uid: overrides.uid ?? prod.currentUid(),
  });
}

async function runServiceCommand(
  command: Extract<CliCommand, { command: 'service' }>,
  overrides: CliOverrides,
): Promise<number> {
  const profile = await resolveCommandProfile(command.profile, overrides);
  const manager = await buildServiceManager(profile, overrides);
  const status = await manager[command.action]();
  process.stdout.write(
    `somawork service ${command.action} — ${status.label}: ${status.state} (ready: ${status.ready})\n`,
  );
  return status.state === 'running-launchd' || status.state === 'running-headless' || command.action === 'stop' ? 0 : 1;
}

async function runProfileCommand(
  command: Extract<CliCommand, { command: 'profile' }>,
  overrides: CliOverrides,
): Promise<number> {
  if (command.json) {
    return withJsonOutputLock(async () => {
      const capture = captureAmbientOutput();
      let outcome: JsonOutcome;
      try {
        const result = await buildProfileDocument(command, overrides);
        outcome = serializeJsonOutcome({
          profile: command.profile ?? null,
          ok: result.ok,
          build: () => JSON.stringify(result.value, null, 2),
        });
      } catch (error) {
        outcome = { ok: false, document: failureDocument(command.profile ?? null, error) };
      } finally {
        capture.restore();
      }
      scrubAndDiscard(capture.text());
      process.stdout.write(`${outcome.document}\n`);
      return outcome.ok ? 0 : 1;
    });
  }

  if (command.action === 'remove') {
    process.stderr.write(`${PROFILE_REMOVE_REFUSAL}\n`);
    return 1;
  }

  const installed = await discoverForCommand(overrides);

  if (command.action === 'list') {
    // Exit 0 with an empty listing rather than 1: "no runtime is installed" is
    // a true answer to "what is installed", and a nonzero exit makes clean
    // install introspection unscriptable.
    if (installed.length === 0) {
      process.stdout.write('No somawork runtime is installed.\n');
      return 0;
    }
    for (const install of installed) {
      process.stdout.write(`${install.profile}\t${install.version}\t${install.root}\n`);
    }
    return 0;
  }

  const view = profileView(await resolveProfileForShow(command, overrides), resolveHome(overrides), installed);
  process.stdout.write(
    [
      `profile        ${view.profile}`,
      `runtime        ${view.runtime ? `${view.runtime.version} (${view.runtime.root})` : 'not installed'}`,
      `config         ${view.configDir}`,
      `data           ${view.dataDir}`,
      `state          ${view.stateDir}`,
      `service label  ${view.serviceLabel}`,
      '',
    ].join('\n'),
  );
  return 0;
}

/** Fixed refusal text for the one destructive profile action. */
const PROFILE_REMOVE_REFUSAL =
  'somawork: `profile remove` is not available in this release. Run `somawork service stop`, then delete the directories shown by `somawork profile show`.';

interface ProfileView {
  profile: ProfileName;
  runtime: { version: string; root: string } | null;
  configDir: string;
  dataDir: string;
  stateDir: string;
  serviceLabel: string;
}

function profileView(profile: ProfileName, home: string, installed: readonly RuntimeInstall[]): ProfileView {
  const paths: ProfilePaths = profilePaths(home, profile);
  const install = installed.find((candidate) => candidate.profile === profile);
  return {
    profile,
    runtime: install ? { version: install.version, root: install.root } : null,
    configDir: paths.configDir,
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    serviceLabel: paths.serviceLabel,
  };
}

/**
 * `show` needs a profile; an explicit `--profile` answers without discovery so
 * the command works on a machine whose runtime is not installed yet.
 */
async function resolveProfileForShow(
  command: Extract<CliCommand, { command: 'profile' }>,
  overrides: CliOverrides,
): Promise<ProfileName> {
  if (command.profile !== undefined) return command.profile;
  return resolveCommandProfile(undefined, overrides);
}

async function buildProfileDocument(
  command: Extract<CliCommand, { command: 'profile' }>,
  overrides: CliOverrides,
): Promise<{ ok: boolean; value: unknown }> {
  if (command.action === 'remove') {
    return { ok: false, value: { ok: false, error: 'NotImplemented', detail: PROFILE_REMOVE_REFUSAL } };
  }

  const home = resolveHome(overrides);
  const installed = await discoverForCommand(overrides);

  if (command.action === 'list') {
    return {
      ok: true,
      value: installed.map((install) => profileView(install.profile, home, installed)),
    };
  }

  return { ok: true, value: profileView(await resolveProfileForShow(command, overrides), home, installed) };
}

/** The discovery seam every non-setup command shares. */
async function discoverForCommand(overrides: CliOverrides): Promise<RuntimeInstall[]> {
  if (overrides.discoverRuntimes !== undefined) return overrides.discoverRuntimes();
  const [orchestrator, host, prod] = await Promise.all([
    import('./setup/orchestrator'),
    import('./setup/real-host'),
    import('./production-seams'),
  ]);
  return orchestrator.discoverRuntimes({ host: new host.RealHost(), fs: prod.createRuntimeDiscoveryFs() });
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

async function runSessionsRoute(
  command: Extract<CliCommand, { command: 'sessions' }>,
  overrides: CliOverrides,
): Promise<number> {
  const { resolvePinnedSessionsDataDir, resolveSessionsDataDir, runSessionsCommand, sessionDirs } = await import(
    './sessions'
  );

  const env = overrides.env ?? process.env;
  const home = resolveHome(overrides);

  // Resolve the pinned cases FIRST. `SOMA_DATA_DIR` or an explicit `--profile`
  // answers without a Homebrew runtime; resolving a profile up front made the
  // documented override unreachable on a machine with nothing installed.
  const dataDir =
    resolvePinnedSessionsDataDir({ env, home, profile: command.profile }) ??
    resolveSessionsDataDir({ env, home, profile: await resolveCommandProfile(undefined, overrides) });

  try {
    runSessionsCommand(command.action, command.rest, {
      ...sessionDirs(dataDir),
      write: (line) => process.stdout.write(`${line}\n`),
      writeErr: (line) => process.stderr.write(`${line}\n`),
      // The handler's historical contract is `exit(code)`. Here it unwinds
      // instead of killing the process, so `runCli` stays a pure function of its
      // argv — but the unwind must be caught HERE. Letting it reach the generic
      // renderer told an operator with a mistyped session key to run
      // `somawork doctor` and `somawork setup` to "repair the profile".
      exit: ((code: number) => {
        throw new SessionsExit(code);
      }) as (code: number) => never,
    });
  } catch (error) {
    if (error instanceof SessionsExit) return error.code;
    // A genuine throw from the handler is a real failure and still gets the
    // generic redacted rendering.
    throw error;
  }
  return 0;
}

/** Internal unwind signal for the sessions handler's `exit` contract. */
class SessionsExit extends Error {
  constructor(readonly code: number) {
    super('sessions-exit');
    this.name = 'SessionsExit';
  }
}

// ---------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let code: number;
  try {
    code = await runCli(process.argv.slice(2));
  } catch (error) {
    // `runCli` already renders everything it routes; this is the last resort for
    // a throw from the router itself. `SessionsExit` is caught inside its own
    // route and never reaches here.
    process.stderr.write(`${describeCliError(error)}\n`);
    code = 1;
  }
  process.exitCode = code;
}

if (require.main === module) {
  void main();
}

export type { ProfileReceipt };
