/**
 * Zero-copy capture of the Slack runtime bot/app tokens.
 *
 * ## The problem this removes
 *
 * The old runbook had a human read `xoxb-…` and `xapp-…` off a web page and
 * paste them into a file. Every step of that — the page, the clipboard, the
 * terminal scrollback, the shell history — is a place a live workspace
 * credential comes to rest. This module deletes the human from the path.
 *
 * ## The path a token actually takes
 *
 * ```
 *   Slack CLI  --(child env: SLACK_CLI_XOXB / SLACK_CLI_XAPP)-->  start hook
 *   start hook --(one NDJSON frame over a 0600 Unix socket)----->  somawork setup
 *   somawork   --(SecretStore, atomic 0600 write)--------------->  secrets.env
 * ```
 *
 * Those three hops are the **complete** inventory of raw-token carriers. A
 * token never reaches argv (world-readable through `ps`), a URL, the Slack
 * CLI's own output, the setup-state JSON, a log line, or a report. The test
 * suite asserts that negatively with sentinel values.
 *
 * ## Why a socket and not a file
 *
 * Source-pinned, docs.slack.dev/tools/slack-cli/reference/hooks (2026-08-24):
 * in SDK-managed mode the start hook's **stdout is streamed to the CLI's
 * stdout**. So the hook cannot answer on stdout; it needs a private channel.
 * A Unix socket in a 0700 directory gives one that never becomes a file on
 * disk with a token in it, even briefly.
 *
 * ## Why the ACK exists
 *
 * The helper is a one-shot child that Slack's CLI will kill when the run ends.
 * If it exited as soon as it wrote the frame, a parent that then failed to
 * persist would have no way to tell the difference between "never captured"
 * and "captured and lost". So the parent persists **first** and acknowledges
 * **second**; the helper only exits successfully on a validated ACK. A missing
 * ACK is a loud failure on both sides.
 *
 * ## Two entry points
 *
 * - {@link captureSlackRuntimeTokens} is the low-level one and returns the
 *   tokens in memory. It takes a `persist` callback that must make them durable
 *   *before* the ACK; the ordering is the contract, not a suggestion.
 * - {@link captureAndPersistSlackRuntimeTokens} is what Task 10 should call: it
 *   wires `persist` to a {@link SecretStore} and returns non-secret ids only.
 */

import * as net from 'net';
import type { ProfileName } from '../profile';
import {
  type ChildProcessHandle,
  DEFAULT_SOCKET_MODE,
  MAX_SOCKET_FRAME_BYTES,
  type ProcessExit,
  type ReceivedMessage,
  type SetupHost,
  SocketAbortedError,
} from './host';
import {
  CAPTURE_NONCE_CHARS,
  captureNonceMatches,
  isCaptureNonce,
  parseHookFlagArguments,
  readSlackAppMapping,
  type SlackAppMapping,
  type SlackProject,
} from './slack-manifest';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** Frame schema version. Bump only for an incompatible change. */
export const CAPTURE_FRAME_VERSION = 1;
/** ACK schema version, kept separate so either side can move first. */
export const CAPTURE_ACK_VERSION = 1;

export const BOT_TOKEN_PREFIX = 'xoxb-';
export const APP_TOKEN_PREFIX = 'xapp-';

/**
 * Env names the start hook receives.
 *
 * `SLACK_CLI_*` is the documented primary form and `SLACK_*_TOKEN` the
 * documented alias; both are set by the CLI. Nothing else in that contract is
 * documented — in particular there is **no** app id or team id env — which is
 * why the frame carries tokens only and the parent gets ids from the app
 * mapping file instead.
 */
export const BOT_TOKEN_ENV_NAMES = ['SLACK_CLI_XOXB', 'SLACK_BOT_TOKEN'] as const;
export const APP_TOKEN_ENV_NAMES = ['SLACK_CLI_XAPP', 'SLACK_APP_TOKEN'] as const;

/** Shortest credible token body; anything shorter is a truncated value. */
const MIN_TOKEN_CHARS = 16;
/** Longest accepted token, so a hostile env cannot become a giant frame. */
const MAX_TOKEN_CHARS = 512;
/** Tokens are base62 plus `-`; this also excludes whitespace and controls. */
const TOKEN_BODY_RE = /^[A-Za-z0-9-]+$/;
/** Unicode `Cc` — C0/C1 controls, written without literal bytes. */
const CONTROL_CHAR_RE = /\p{Cc}/u;

const DEFAULT_CAPTURE_TIMEOUT_MS = 180_000;
const DEFAULT_TERMINATE_GRACE_MS = 5_000;
const DEFAULT_TERMINATE_POLL_MS = 100;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/** Global flags pinned on the Slack CLI so a developer machine cannot alter it. */
const SLACK_GLOBAL_FLAGS = ['--no-color', '--skip-update'] as const;
/** Trace output is opt-in through this variable (`internal/config/config.go:30`). */
const SLACK_CHILD_ENV: Readonly<Record<string, string>> = { SLACK_TEST_TRACE: 'false' };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Base class for every capture failure.
 *
 * `toJSON()` is the persistable projection. It is **not** a sanitizing step:
 * `summary` defaults to `message` because every message in this module is
 * already value-free by construction, and that is the property to preserve.
 * Concretely: no message here interpolates a token, a frame field, a frame
 * value, a foreign error's `message`, or an argv element. A capture failure is
 * about *which step* failed; no step needs to quote its input to explain
 * itself. {@link safeErrorName} bounds the one foreign fragment that is still
 * useful — a nested error's class name.
 */
export class SlackCaptureError extends Error {
  readonly summary: string;

  constructor(message: string, summary?: string) {
    super(message);
    this.name = 'SlackCaptureError';
    this.summary = summary ?? message;
  }

  toJSON(): { name: string; summary: string } {
    return { name: this.name, summary: this.summary };
  }
}

/** A caller argument was refused before anything was started. */
export class SlackCaptureOptionsError extends SlackCaptureError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackCaptureOptionsError';
  }
}

/** The hook's environment did not carry a usable pair of tokens. */
export class SlackCaptureEnvError extends SlackCaptureError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackCaptureEnvError';
  }
}

/** The frame or the ACK violated the protocol. */
export class SlackCaptureProtocolError extends SlackCaptureError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackCaptureProtocolError';
  }
}

/** No frame arrived before the capture deadline. */
export class SlackCaptureTimeoutError extends SlackCaptureError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackCaptureTimeoutError';
  }
}

/** The caller cancelled. Distinct from a timeout so a wizard can say so. */
export class SlackCaptureCancelledError extends SlackCaptureError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackCaptureCancelledError';
  }
}

/** `slack run` exited before it ever reached the start hook. */
export class SlackCaptureChildError extends SlackCaptureError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackCaptureChildError';
  }
}

/** The tokens arrived but could not be made durable. Nothing was acknowledged. */
export class SlackCapturePersistError extends SlackCaptureError {
  constructor(message: string) {
    super(message);
    this.name = 'SlackCapturePersistError';
  }
}

/**
 * The tokens are persisted, but no Slack app mapping materialized.
 *
 * The deliberate asymmetry: the credentials are safe on disk and the project's
 * `.slack/apps*.json` is intact, so a rerun resumes rather than creating a
 * second Slack app — but the call's return contract (which includes an app id)
 * cannot be honoured, so it fails rather than inventing one. `resume` says the
 * cheap thing to do is run again; the error carries no token.
 */
export class SlackCaptureIncompleteError extends SlackCaptureError {
  readonly resume = true;

  constructor(
    message: string,
    readonly teamId: string,
  ) {
    super(message);
    this.name = 'SlackCaptureIncompleteError';
  }

  toJSON(): { name: string; summary: string; teamId: string; resume: boolean } {
    return { name: this.name, summary: this.summary, teamId: this.teamId, resume: this.resume };
  }
}

/**
 * A class name is the only fragment of a foreign error worth repeating, and
 * even that is bounded: a caller-supplied `persist` may throw anything, and
 * `name` is a writable property.
 */
const SAFE_ERROR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function safeErrorName(err: unknown): string {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && SAFE_ERROR_NAME_RE.test(name) ? name : 'Error';
}

// ---------------------------------------------------------------------------
// Token validation (shared by both ends of the socket)
// ---------------------------------------------------------------------------

function describeTokenProblem(label: string, prefix: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return `${label} is missing.`;
  if (CONTROL_CHAR_RE.test(value)) return `${label} contains a control character.`;
  if (value.length < MIN_TOKEN_CHARS) return `${label} is shorter than ${MIN_TOKEN_CHARS} characters.`;
  if (value.length > MAX_TOKEN_CHARS) return `${label} is longer than ${MAX_TOKEN_CHARS} characters.`;
  if (!value.startsWith(prefix)) return `${label} does not start with "${prefix}".`;
  if (!TOKEN_BODY_RE.test(value.slice(prefix.length))) return `${label} contains characters a Slack token never has.`;
  return null;
}

/** Throw {@link SlackCaptureEnvError} unless `value` is a usable token. */
function assertToken(
  label: string,
  prefix: string,
  value: unknown,
  Err: typeof SlackCaptureError,
): asserts value is string {
  const problem = describeTokenProblem(label, prefix, value);
  // The offending value is never quoted: a wrong-prefix "token" is still a
  // secret from wherever it came from.
  if (problem !== null) throw new Err(problem);
}

// ---------------------------------------------------------------------------
// Helper side: env resolution
// ---------------------------------------------------------------------------

/** An explicit, caller-supplied environment snapshot. Never read ambiently. */
export type CaptureEnv = Readonly<Record<string, string | undefined>>;

function resolveAlias(env: CaptureEnv, names: readonly string[]): { name: string; value: string } | null {
  const present = names
    .map((name) => ({ name, value: env[name] }))
    .filter(
      (entry): entry is { name: string; value: string } => typeof entry.value === 'string' && entry.value.length > 0,
    );

  if (present.length === 0) return null;

  // Disagreeing aliases mean the environment is not the one the Slack CLI
  // built. Picking a winner could install a token from a stale shell export
  // into the runtime, which fails later and mysteriously.
  const distinct = new Set(present.map((entry) => entry.value));
  if (distinct.size > 1) {
    throw new SlackCaptureEnvError(
      `${names.join(' and ')} are both set to different values; refusing to guess which one the Slack CLI meant.`,
    );
  }
  return present[0];
}

/**
 * Pull the bot and app tokens out of an explicit environment snapshot.
 *
 * Exported so the private CLI route (Task 10) and the tests use exactly the
 * same resolution; the route passes an allowlisted snapshot rather than the
 * ambient environment, which is why this function takes `env` as an argument.
 */
export function readCaptureTokensFromEnv(env: CaptureEnv): { botToken: string; appToken: string } {
  if (env === null || typeof env !== 'object') {
    throw new SlackCaptureEnvError('An environment snapshot is required to read the Slack runtime tokens.');
  }

  const bot = resolveAlias(env, BOT_TOKEN_ENV_NAMES);
  const app = resolveAlias(env, APP_TOKEN_ENV_NAMES);

  if (bot === null) {
    throw new SlackCaptureEnvError(
      `No Slack bot token in the hook environment (looked at ${BOT_TOKEN_ENV_NAMES.join(', ')}).`,
    );
  }
  if (app === null) {
    throw new SlackCaptureEnvError(
      `No Slack app-level token in the hook environment (looked at ${APP_TOKEN_ENV_NAMES.join(', ')}).`,
    );
  }

  assertToken(bot.name, BOT_TOKEN_PREFIX, bot.value, SlackCaptureEnvError);
  assertToken(app.name, APP_TOKEN_PREFIX, app.value, SlackCaptureEnvError);

  return { botToken: bot.value, appToken: app.value };
}

// ---------------------------------------------------------------------------
// Helper side: argv
// ---------------------------------------------------------------------------

/**
 * Parse the private capture route's argv.
 *
 * Shares its grammar with the `get-manifest` route (see
 * {@link parseHookFlagArguments}) so the two private routes cannot drift, and
 * percent-decodes the socket path because the hook grammar cannot quote
 * whitespace.
 *
 * `--nonce` is required, not optional. It is the parent's proof that this
 * process is the child it started (I-1), and an optional challenge is not a
 * challenge: a helper that could be run without one would hand every same-uid
 * process a way to ask for the unauthenticated path.
 */
export function parseCaptureHelperArgv(argv: readonly string[]): { socketPath: string; nonce: string } {
  const fail = (message: string) => new SlackCaptureOptionsError(message);
  const { socket: socketPath, nonce } = parseHookFlagArguments(argv, ['socket', 'nonce'] as const, fail);
  // Never echoed. Shape only — the value is this run's challenge.
  if (!isCaptureNonce(nonce)) {
    throw new SlackCaptureOptionsError(`--nonce must be ${CAPTURE_NONCE_CHARS} lowercase hex characters.`);
  }
  return { socketPath, nonce };
}

// ---------------------------------------------------------------------------
// Helper side: the socket exchange
// ---------------------------------------------------------------------------

/** One NDJSON conversation with the parent. Deliberately tiny. */
export interface CaptureSocketClient {
  /** Write one already-newline-terminated frame. */
  send(line: string): Promise<void>;
  /** Read one newline-terminated frame, rejecting after `timeoutMs`. */
  receive(timeoutMs: number): Promise<string>;
  close(): void;
}

/** The one seam between this module and Node's `net`. */
export type CaptureConnector = (socketPath: string, timeoutMs: number) => Promise<CaptureSocketClient>;

export interface SlackAuthCaptureHelperOptions {
  socketPath: string;
  /** The one-time challenge from the hook argv; echoed in the frame (I-1). */
  nonce: string;
  /** Explicit snapshot; the reusable core never reaches for an ambient one. */
  env: CaptureEnv;
  /** Test/alternate transport seam. Defaults to a Unix-domain client. */
  connect?: CaptureConnector;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
}

/** The exact bytes the parent acknowledges with. */
export function buildCaptureAck(): { version: number; ok: true } {
  return { version: CAPTURE_ACK_VERSION, ok: true };
}

function assertValidAck(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SlackCaptureProtocolError('The setup process answered with something that is not JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SlackCaptureProtocolError('The setup process answered with a non-object acknowledgement.');
  }
  const ack = parsed as Record<string, unknown>;
  if (ack.version !== CAPTURE_ACK_VERSION) {
    throw new SlackCaptureProtocolError(
      `The setup process acknowledged with an unexpected protocol version; this build speaks version ${CAPTURE_ACK_VERSION}.`,
    );
  }
  if (ack.ok !== true) {
    throw new SlackCaptureProtocolError('The setup process refused the captured Slack credentials.');
  }
}

/**
 * The body of `somawork _capture-slack-auth`.
 *
 * Writes **nothing** to any standard stream — in SDK-managed mode the Slack CLI
 * forwards hook stdout to its own, so a single stray line would put a token in
 * a terminal. Failures are thrown; the CLI route turns them into an exit code.
 *
 * Owns no persistence: it hands the tokens over and forgets them.
 */
export async function runSlackAuthCaptureHelper(options: SlackAuthCaptureHelperOptions): Promise<void> {
  if (options === null || typeof options !== 'object') {
    throw new SlackCaptureOptionsError('Capture helper options are required.');
  }
  const { socketPath, nonce } = options;
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new SlackCaptureOptionsError('The capture helper needs a socket path.');
  }
  if (!isCaptureNonce(nonce)) {
    throw new SlackCaptureOptionsError(
      `The capture helper needs the ${CAPTURE_NONCE_CHARS}-character capture nonce from its argv.`,
    );
  }

  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  // Read and validate the environment *before* opening the socket, so a bad
  // environment never even announces itself to the parent.
  const { botToken, appToken } = readCaptureTokensFromEnv(options.env);

  const frame = `${JSON.stringify({ version: CAPTURE_FRAME_VERSION, nonce, botToken, appToken })}\n`;
  if (Buffer.byteLength(frame, 'utf-8') > MAX_SOCKET_FRAME_BYTES) {
    throw new SlackCaptureProtocolError('The captured credentials do not fit in one socket frame.');
  }

  const connect = options.connect ?? unixSocketConnector;
  const client = await connect(socketPath, connectTimeoutMs);

  try {
    await client.send(frame);
    // Exactly one frame, then wait: success is the ACK, not the write.
    assertValidAck(await client.receive(ackTimeoutMs));
  } catch (err) {
    if (err instanceof SlackCaptureError) throw err;
    throw new SlackCaptureProtocolError(
      `The setup process did not acknowledge the captured Slack credentials (${safeErrorName(err)}).`,
    );
  } finally {
    client.close();
  }
}

/** Default transport: a Unix-domain client speaking the same NDJSON framing. */
const unixSocketConnector: CaptureConnector = async (socketPath, timeoutMs) => {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const pending = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      pending.destroy();
      reject(new SlackCaptureProtocolError('Timed out connecting to the setup process.'));
    }, timeoutMs);
    pending.once('connect', () => {
      clearTimeout(timer);
      resolve(pending);
    });
    pending.once('error', () => {
      clearTimeout(timer);
      reject(new SlackCaptureProtocolError('Could not connect to the setup process.'));
    });
  });

  let buffered = '';
  let overflow: Error | null = null;
  socket.setEncoding('utf-8');
  socket.on('data', (chunk: string) => {
    // M-3: the parent caps frames it receives; cap what we accept too. The peer
    // is our own parent, so this is defence in depth — but "bound everything"
    // should not have an exception just because the other end is friendly.
    if (Buffer.byteLength(buffered, 'utf-8') + Buffer.byteLength(chunk, 'utf-8') > MAX_SOCKET_FRAME_BYTES) {
      overflow = new SlackCaptureProtocolError('The setup process sent an oversized acknowledgement.');
      buffered = '';
      socket.destroy();
      return;
    }
    buffered += chunk;
  });

  return {
    send: (line: string) =>
      new Promise<void>((resolve, reject) => {
        socket.write(line, (err) => (err ? reject(err) : resolve()));
      }),
    receive: (waitMs: number) =>
      new Promise<string>((resolve, reject) => {
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          socket.off('data', onData);
          socket.off('close', onClose);
          fn();
        };
        const take = (): boolean => {
          if (overflow) {
            const err = overflow;
            finish(() => reject(err));
            return true;
          }
          const newline = buffered.indexOf('\n');
          if (newline === -1) return false;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          // Exactly one ACK is expected. A second frame means the peer is not
          // the protocol we think it is, so refuse rather than pick the first.
          if (buffered.includes('\n')) {
            finish(() =>
              reject(new SlackCaptureProtocolError('The setup process sent more than one acknowledgement.')),
            );
            return true;
          }
          finish(() => resolve(line));
          return true;
        };
        const onData = () => {
          take();
        };
        const onClose = () => {
          if (take()) return;
          finish(() => reject(new SlackCaptureProtocolError('The setup process closed the socket without answering.')));
        };
        const timer = setTimeout(
          () => finish(() => reject(new SlackCaptureProtocolError('Timed out waiting for the setup acknowledgement.'))),
          waitMs,
        );
        socket.on('data', onData);
        socket.on('close', onClose);
        take();
      }),
    close: () => socket.destroy(),
  };
};

// ---------------------------------------------------------------------------
// Parent side
// ---------------------------------------------------------------------------

/** What one successful capture yields in memory. */
export interface SlackRuntimeAuth {
  botToken: string;
  appToken: string;
  appId: string;
  teamId: string;
}

/** The two secrets this flow is allowed to write. No signing secret (Task 7). */
export interface SlackRuntimeSecrets {
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
}

export interface SlackCaptureOptions {
  /** The materialized, persistent project. Its `socketPath` must match. */
  project: SlackProject;
  /** Absolute path to the Slack CLI, resolved by the caller (Task 5 / Task 10). */
  slackBin: string;
  /**
   * Make the tokens durable. Called **before** the helper is acknowledged, so a
   * throw here means the helper learns the capture failed and nothing is left
   * half-committed.
   */
  persist: (secrets: SlackRuntimeSecrets) => void | Promise<void>;
  /**
   * Re-read the app mapping. Defaults to reading the project's
   * `.slack/apps*.json` — injected so the flow stays testable without a disk.
   */
  readMapping?: () => SlackAppMapping | null;
  /**
   * Redacted child output, for a progress line. Never parsed, and called
   * best-effort: a throw or a rejected promise from this callback is swallowed
   * rather than allowed to abort the capture. May be sync or async.
   */
  onProgress?: (chunk: string) => void | Promise<void>;
  signal?: AbortSignal;
  captureTimeoutMs?: number;
  terminateGraceMs?: number;
  terminatePollMs?: number;
  socketMode?: number;
}

function assertPositiveInt(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new SlackCaptureOptionsError(`\`${label}\` must be a positive whole number of milliseconds.`);
  }
  return value as number;
}

/** Fields a valid frame may carry. Anything else is a contract violation. */
const FRAME_KEYS = new Set(['version', 'nonce', 'botToken', 'appToken', 'appId', 'teamId']);

/**
 * Does this frame come from the child we started?
 *
 * Runs **before** {@link validateCaptureFrame} and therefore before any token
 * is looked at, persisted, or acknowledged. A frame that fails here is not a
 * protocol error to report — it is a stranger, and the host drops the
 * connection and keeps waiting for the real helper (see `ReceiveJsonOptions.authenticate`).
 *
 * Returns a boolean and never throws: throwing would let one hostile frame end
 * a capture that the legitimate helper is still on its way to complete.
 */
function frameCarriesNonce(value: unknown, expected: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return captureNonceMatches(expected, (value as Record<string, unknown>).nonce);
}

function validateCaptureFrame(
  value: unknown,
  expected: { teamId: string; appId: string | null },
): {
  botToken: string;
  appToken: string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SlackCaptureProtocolError('The capture helper sent a non-object frame.');
  }
  const frame = value as Record<string, unknown>;

  for (const key of Object.keys(frame)) {
    if (!FRAME_KEYS.has(key)) {
      // The field *name* is not repeated: a version-skewed peer could put a
      // credential in a key, and this message reaches a terminal.
      throw new SlackCaptureProtocolError('The capture helper sent a frame with an unrecognized field.');
    }
  }
  if (frame.version !== CAPTURE_FRAME_VERSION) {
    // The received version is not echoed — it is attacker-controlled text from
    // a peer that has already proved it does not speak our protocol.
    throw new SlackCaptureProtocolError(
      `The capture helper spoke an unexpected protocol version; this build speaks version ${CAPTURE_FRAME_VERSION}.`,
    );
  }

  // Defence in depth: `authenticate` has already refused every frame whose
  // nonce does not match, so reaching here with a bad one means the two checks
  // disagree — which is a bug, not a peer, and must not persist a token.
  if (!isCaptureNonce(frame.nonce)) {
    throw new SlackCaptureProtocolError("The capture helper sent a frame without this run's challenge.");
  }

  assertToken('The captured bot token', BOT_TOKEN_PREFIX, frame.botToken, SlackCaptureProtocolError);
  assertToken('The captured app-level token', APP_TOKEN_PREFIX, frame.appToken, SlackCaptureProtocolError);

  // The ids are optional and unused — the hook contract guarantees tokens, not
  // ids — but if one shows up it must agree with the authoritative value, or we
  // are talking to a helper running against a different workspace.
  if (frame.teamId !== undefined && frame.teamId !== expected.teamId) {
    throw new SlackCaptureProtocolError('The capture helper reported a different Slack workspace.');
  }
  if (frame.appId !== undefined && expected.appId !== null && frame.appId !== expected.appId) {
    throw new SlackCaptureProtocolError('The capture helper reported a different Slack app.');
  }

  return { botToken: frame.botToken, appToken: frame.appToken };
}

/**
 * SIGTERM, wait, then SIGKILL — once each, both bounded.
 *
 * Polls a box the caller filled at spawn time rather than racing a sleep
 * against `exited`, so the happy path leaves no timer holding the event loop
 * open and the fake clock stays deterministic.
 *
 * **Bounded best-effort, deliberately.** If the grace after SIGKILL also
 * expires with no exit, this returns anyway rather than awaiting `exited`: an
 * unreapable child (uninterruptible I/O, a stopped process) must not hang the
 * wizard forever. So "terminate the group and wait" can, in that one case,
 * have stopped waiting. The caller's socket is still closed and its secrets are
 * still durable; what is left behind is a process, not a credential. A grace
 * shorter than one poll interval overshoots by at most `pollMs`.
 */
async function terminateChild(
  host: SetupHost,
  child: ChildProcessHandle,
  box: { exit: ProcessExit | null },
  graceMs: number,
  pollMs: number,
): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (box.exit !== null) return;
    child.kill(signal);
    const deadline = host.now() + graceMs;
    while (box.exit === null && host.now() < deadline) {
      await host.sleep(pollMs);
    }
  }
}

/**
 * Run `slack run` in the project and capture the runtime tokens it injects.
 *
 * `socketPath` is the required positional from the plan's interface; it must be
 * the same path the project's hooks file points at, and a mismatch is refused
 * rather than silently listened on (a listener nobody dials is a 180-second
 * timeout with no explanation).
 *
 * Returns the tokens in memory. Prefer {@link captureAndPersistSlackRuntimeTokens}
 * unless you genuinely need them.
 */
export async function captureSlackRuntimeTokens(
  host: SetupHost,
  socketPath: string,
  options: SlackCaptureOptions,
): Promise<SlackRuntimeAuth> {
  // ---- argument checks: nothing on the machine moves until these pass ------
  if (options === null || typeof options !== 'object') {
    throw new SlackCaptureOptionsError('Capture options are required.');
  }
  const { project, slackBin, persist } = options;
  if (project === null || typeof project !== 'object') {
    throw new SlackCaptureOptionsError('A materialized Slack project is required.');
  }
  if (typeof slackBin !== 'string' || slackBin.length === 0) {
    throw new SlackCaptureOptionsError('An absolute path to the Slack CLI is required.');
  }
  if (typeof persist !== 'function') {
    throw new SlackCaptureOptionsError('A `persist` callback is required; capture never writes secrets itself.');
  }
  if (socketPath !== project.socketPath) {
    throw new SlackCaptureOptionsError(
      'The capture socket path does not match the one the project hooks file points at; refusing to listen on a socket nothing will dial.',
    );
  }
  // The challenge the hooks file carries. Refused up front rather than at frame
  // time: listening on an authenticated socket with no challenge to check would
  // be a 180-second wait that can only ever time out.
  const captureNonce = project.captureNonce;
  if (!isCaptureNonce(captureNonce)) {
    throw new SlackCaptureOptionsError(
      'The materialized Slack project carries no capture nonce; re-materialize the project before capturing.',
    );
  }

  const captureTimeoutMs = assertPositiveInt(
    options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
    'captureTimeoutMs',
  );
  const terminateGraceMs = assertPositiveInt(
    options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    'terminateGraceMs',
  );
  const terminatePollMs = assertPositiveInt(options.terminatePollMs ?? DEFAULT_TERMINATE_POLL_MS, 'terminatePollMs');
  const socketMode = options.socketMode ?? DEFAULT_SOCKET_MODE;
  const readMapping = options.readMapping ?? (() => readSlackAppMapping(project.root, project.teamId));

  if (options.signal?.aborted) {
    throw new SlackCaptureCancelledError('Slack credential capture was cancelled before it started.');
  }

  // ---- listen first, spawn second: a fast hook must not find a closed door -
  const server = await host.listenUnixSocket(socketPath, socketMode);
  const controller = new AbortController();
  // B-2: every abort carries a reason — descriptive strings, not a
  // RequestAbortReason (that taxonomy belongs to the Slack request pipeline).
  const onOuterAbort = () => controller.abort('setup-cancelled');
  options.signal?.addEventListener('abort', onOuterAbort);

  const exitBox: { exit: ProcessExit | null } = { exit: null };
  let child: ChildProcessHandle | null = null;
  let captured: { botToken: string; appToken: string } | null = null;

  try {
    const knownAppId = project.appMapping?.appId ?? null;
    child = host.spawn({
      command: slackBin,
      args: [
        'run',
        '--team',
        project.teamId,
        ...(knownAppId === null ? [] : ['--app', knownAppId]),
        ...SLACK_GLOBAL_FLAGS,
      ],
      env: SLACK_CHILD_ENV,
      // The Slack CLI itself needs HOME and PATH to find its credentials and
      // our controller. The *captured* child is launched by the CLI with the
      // token env it injects, not by us.
      inheritEnv: true,
      cwd: project.root,
      processGroup: true,
    });

    // I-3: a progress renderer is best-effort and must never take the capture
    // down with it. The listener runs inside the host's `'data'` handler, so an
    // uncaught throw there would kill the process with no `finally` — leaving
    // the `slack run` group unsignalled, the socket file behind, and (if the
    // frame had already landed) tokens on disk that nothing recorded. Sync
    // throws are swallowed here; a rejected promise is swallowed too, so an
    // async renderer cannot become an unhandled rejection either.
    const progress = options.onProgress;
    if (progress) {
      const safeProgress = (chunk: string): void => {
        try {
          const result = progress(chunk) as unknown;
          if (
            result !== null &&
            typeof result === 'object' &&
            typeof (result as PromiseLike<void>).then === 'function'
          ) {
            void Promise.resolve(result).catch(() => undefined);
          }
        } catch {
          // Deliberately swallowed: see above.
        }
      };
      child.onStdout(safeProgress);
      child.onStderr(safeProgress);
    }
    child.exited.then(
      (exit) => {
        exitBox.exit = exit;
      },
      () => {
        exitBox.exit = { code: null, signal: null };
      },
    );

    const receive = server.receiveJsonMessage({
      timeoutMs: captureTimeoutMs,
      signal: controller.signal,
      // I-1: peer authentication first. Filesystem mode gates other users, not
      // other processes of this one, and the socket path is derivable from the
      // profile — so without this the first frame from any same-uid process is
      // persisted to `secrets.env` and ACKed, and setup completes green with
      // the daemon bound to someone else's Slack app.
      authenticate: (value) => frameCarriesNonce(value, captureNonce),
      validate: (value) => validateCaptureFrame(value, { teamId: project.teamId, appId: knownAppId }),
    });

    // A `slack run` that dies before the hook fires should not cost the user
    // the full capture timeout.
    const EARLY_EXIT = Symbol('early-exit');
    const winner = await Promise.race([receive, child.exited.then(() => EARLY_EXIT)]).catch((err: unknown) => {
      throw err;
    });

    if (winner === EARLY_EXIT) {
      controller.abort('slack-run-exited');
      await receive.catch(() => undefined);
      throw new SlackCaptureChildError(describeEarlyExit(exitBox.exit));
    }

    const message = winner as ReceivedMessage<{ botToken: string; appToken: string }>;
    captured = message.value;

    // Durable first, acknowledge second. The helper treats a missing ACK as a
    // failure, so this ordering is what makes "captured" and "saved" the same
    // event from both sides.
    try {
      await persist({ SLACK_BOT_TOKEN: captured.botToken, SLACK_APP_TOKEN: captured.appToken });
    } catch (err) {
      // Only the class name, never the message: `persist` is a caller-supplied
      // callback and its error text may quote the payload it was handed.
      throw new SlackCapturePersistError(
        `Captured the Slack runtime credentials but could not store them (${safeErrorName(err)}).`,
      );
    }

    await message.reply(buildCaptureAck());
  } catch (err) {
    throw mapCaptureFailure(err, exitBox.exit, captured !== null);
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort);
    // M-1: cleanup is best-effort and nested, not sequential-and-fatal.
    //
    // Two properties, both load-bearing. **Nested**: a throw from
    // `terminateChild` must not skip `close()` — a leaked listening fd keeps
    // the wizard's event loop alive forever and strands a 0600 socket file.
    // **Swallowed**: a `finally` that throws *replaces* the pending exception,
    // so an unreapable child would mask the real reason the capture failed —
    // and, on the success path, would turn a capture whose tokens are already
    // durable into a failure the caller cannot retry. Nothing here is
    // actionable to a caller: it cannot re-kill a process it has no handle on,
    // and it cannot re-close a server it never saw. So the outcome the caller
    // sees is always the capture's own.
    try {
      if (child !== null) await terminateChild(host, child, exitBox, terminateGraceMs, terminatePollMs);
    } catch {
      // Best-effort; see above. The bounded-wait contract is documented on
      // `terminateChild` itself.
    } finally {
      try {
        await server.close();
      } catch {
        // `close()` is documented idempotent and unlinks the socket; a failure
        // here leaves an ops artifact, never a credential.
      }
    }
  }

  // ---- ids come from the mapping the CLI wrote, never from its stdout ------
  const mapping = readMapping();
  if (mapping === null) {
    throw new SlackCaptureIncompleteError(
      'Stored the Slack runtime credentials, but the Slack CLI recorded no app for this workspace. ' +
        'Run setup again to finish; the saved project will reuse the same app rather than create a second one.',
      project.teamId,
    );
  }

  return { botToken: captured.botToken, appToken: captured.appToken, appId: mapping.appId, teamId: project.teamId };
}

function describeEarlyExit(exit: ProcessExit | null): string {
  const how =
    exit === null ? 'exited' : exit.signal !== null ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`;
  return `The Slack CLI ${how} before it produced runtime credentials. Check the output above for what it refused.`;
}

/** Turn a host/socket failure into the capture vocabulary a caller can branch on. */
function mapCaptureFailure(err: unknown, exit: ProcessExit | null, alreadyCaptured: boolean): Error {
  if (err instanceof SlackCaptureError) return err;

  // A child that already died explains a socket failure better than the socket
  // does — checked here as well as in the race so the classification does not
  // depend on which promise settled first.
  if (!alreadyCaptured && exit !== null) return new SlackCaptureChildError(describeEarlyExit(exit));

  const name = safeErrorName(err);
  if (name === 'SocketTimeoutError') {
    return new SlackCaptureTimeoutError(
      'The Slack CLI never delivered runtime credentials. Nothing was stored; run setup again when the workspace is ready.',
    );
  }
  if (err instanceof SocketAbortedError || name === 'SocketAbortedError') {
    return new SlackCaptureCancelledError('Slack credential capture was cancelled.');
  }
  return new SlackCaptureProtocolError(`Slack credential capture failed (${name}).`);
}

// ---------------------------------------------------------------------------
// Task 10 entry point
// ---------------------------------------------------------------------------

/**
 * The slice of Task 2's `SecretStore` this flow uses.
 *
 * Only `write` — this module never needs to know where the file is, and not
 * knowing is what keeps the path out of the receipt (see
 * {@link SlackCaptureReceipt}).
 */
export interface SlackSecretSink {
  write(values: SlackRuntimeSecrets): void;
}

export interface CaptureAndPersistOptions extends Omit<SlackCaptureOptions, 'persist'> {
  secretStore: SlackSecretSink;
}

/**
 * Non-secret evidence that a capture completed.
 *
 * Every field is safe to persist: the whole object clears `assertSecretFree`,
 * so `stateStore.update((s) => ({ ...s, slackAppId: receipt.appId, … }))` — or
 * even spreading the receipt into a state candidate — cannot trip the state
 * gate. The secrets *path* is deliberately absent: the caller constructed the
 * {@link SlackSecretSink} and already holds `filePath`, and returning it here
 * would hand Task 10 a field whose very name (`secrets`) `assertSecretFree`
 * rejects (`state.ts` `SECRET_KEY_WORDS`). Renaming does not help —
 * `credentialFile`, `secretsPath` and `tokenFile` all tokenize into the same
 * word set — so the field is simply not part of the contract.
 */
export interface SlackCaptureReceipt {
  appId: string;
  teamId: string;
  profile: ProfileName;
}

/**
 * Capture the Slack runtime tokens and write them straight into the profile's
 * secrets file, returning ids only.
 *
 * This is the call Task 10's setup step should make: the tokens exist as
 * locals inside {@link captureSlackRuntimeTokens} and in the store's atomic
 * write, and never become a value the wizard is holding.
 */
export async function captureAndPersistSlackRuntimeTokens(
  host: SetupHost,
  options: CaptureAndPersistOptions,
): Promise<SlackCaptureReceipt> {
  if (options === null || typeof options !== 'object') {
    throw new SlackCaptureOptionsError('Capture options are required.');
  }
  const { secretStore, ...rest } = options;
  if (secretStore === null || typeof secretStore !== 'object' || typeof secretStore.write !== 'function') {
    throw new SlackCaptureOptionsError('A secret store is required to persist the Slack runtime credentials.');
  }
  // M-4: validated here as well as downstream, because `rest.project.socketPath`
  // is dereferenced to build the call — a raw TypeError would be the one bad
  // argument in this module that does not speak the error vocabulary.
  if (rest.project === null || typeof rest.project !== 'object' || typeof rest.project.socketPath !== 'string') {
    throw new SlackCaptureOptionsError('A materialized Slack project is required.');
  }

  const auth = await captureSlackRuntimeTokens(host, rest.project.socketPath, {
    ...rest,
    persist: (secrets) => secretStore.write(secrets),
  });

  return { appId: auth.appId, teamId: auth.teamId, profile: rest.project.profile };
}
