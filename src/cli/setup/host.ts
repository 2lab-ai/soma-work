/**
 * The injectable host boundary for `somawork setup`.
 *
 * Every side effect the wizard performs — running a provider CLI, opening a
 * browser, touching the clipboard, listening on a Unix socket, asking the
 * clock — goes through {@link SetupHost}. Adapters (llmux, Slack CLI, Slack
 * capture, service manager) never reach for `child_process`, `net`, `fs`, or
 * `Date` directly, so every one of them is testable against {@link FakeHost}
 * with no real process, socket, or wall clock involved.
 *
 * ## Two invariants this module exists to enforce
 *
 * 1. **argv and env are separate channels.** {@link CommandSpec} and
 *    {@link SpawnSpec} take `args: string[]` and `env: Record<string,string>`;
 *    there is no shell-string form anywhere in the API, so there is nothing to
 *    quote and nothing to inject.
 * 2. **Raw child output is not the public surface.** `CommandResult.stdout` /
 *    `.stderr` / `.args` and `toJSON()` / `toString()` are redacted through the
 *    single redactor in `@soma/common/logger`. Raw bytes exist only behind
 *    `unsafeRawStdout()` / `unsafeRawStderr()` — methods, so they never land in
 *    a spread, an `Object.values`, or `JSON.stringify`. A parser may call them;
 *    nothing may print what they return without redacting first.
 *
 * Sensitive argv (the Slack CLI `--ticket`/`--challenge` exception, which the
 * provider CLI contract forces) is registered per call via
 * `sensitiveValues`, and the host feeds those to the redactor as ephemeral
 * values so both the display surface and the recorded call are masked.
 */

import { UnsafePathError } from '@soma/common/atomic-write';
import { redactSecrets } from '@soma/common/logger';

// Re-exported so adapters can catch an unsafe-path refusal without importing
// the storage package directly (see the module invariant above).
export { UnsafePathError };

/** One command to run to completion, argv-only, env kept out of argv. */
export interface CommandSpec {
  /** Absolute path or bare binary name. Never a shell string. */
  command: string;
  /** Argument vector. Each element is passed through verbatim. */
  args?: readonly string[];
  /** Extra environment for the child. Values here never enter argv. */
  env?: Readonly<Record<string, string>>;
  /** Merge `env` over the parent environment (default) or run with `env` only. */
  inheritEnv?: boolean;
  cwd?: string;
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string;
  /** Kill the child and return `timedOut: true` after this many ms. */
  timeoutMs?: number;
  /** Kill the child and return `aborted: true` when this fires. */
  signal?: AbortSignal;
  /**
   * Values that are secret for this call only — a Slack auth ticket, a
   * challenge, a one-time provider code. Registered explicitly because they
   * have no recognisable shape; the host masks them in every display and in
   * the recorded call.
   */
  sensitiveValues?: readonly string[];
}

/** Long-running child process, streamed rather than collected. */
export interface SpawnSpec {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  inheritEnv?: boolean;
  cwd?: string;
  sensitiveValues?: readonly string[];
  /**
   * Start the child as a process-group leader so {@link ChildProcessHandle.kill}
   * takes the whole tree down. Needed for provider CLIs that fork workers
   * (`slack run`), which otherwise survive a plain SIGTERM to the parent.
   */
  processGroup?: boolean;
  /**
   * Fire-and-forget: the child becomes a process-group leader, its stdio is
   * `ignore`d, and the handle is unref'd so this process may exit while the
   * child keeps running.
   *
   * Distinct from {@link SpawnSpec.processGroup}, which keeps piped stdio and
   * therefore ties the child's lifetime to a parent that is still reading it.
   * The service manager's headless fallback needs a supervisor that *outlives*
   * the CLI invocation, and it must get that through this boundary rather than
   * by reaching for `child_process` directly — a direct call would leave the
   * one place where argv/env separation and redaction are enforced.
   *
   * Consequences a caller must accept: `onStdout`/`onStderr` deliver nothing
   * (there is no pipe), and `exited` only settles while this process is still
   * alive to observe it. Liveness of a detached child is therefore proven by
   * its own artifacts — for the daemon, its PID lock file — never by the
   * handle.
   */
  detached?: boolean;
}

/** How a child process ended. */
export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Result of a completed {@link SetupHost.command}.
 *
 * Everything enumerable on this object is safe to print. The two `unsafeRaw*`
 * methods are the only way to reach un-redacted bytes and exist solely so a
 * parser can read machine output (`llmux accounts --json`, `slack auth list`)
 * that a redactor would otherwise mangle.
 */
export interface CommandResult {
  /** Redacted command name. */
  readonly command: string;
  /** Redacted argv — registered sensitive values are masked. */
  readonly args: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** True when `timeoutMs` elapsed and the child was killed. */
  readonly timedOut: boolean;
  /** True when the caller's `AbortSignal` fired. */
  readonly aborted: boolean;
  /** `code === 0` and neither timed out nor aborted. */
  readonly ok: boolean;
  /** Redacted stdout — safe for terminal, log, and report sinks. */
  readonly stdout: string;
  /** Redacted stderr — safe for terminal, log, and report sinks. */
  readonly stderr: string;
  /** Un-redacted stdout. Machine parsing only; never display the return value. */
  unsafeRawStdout(): string;
  /** Un-redacted stderr. Machine parsing only; never display the return value. */
  unsafeRawStderr(): string;
}

/**
 * Options for {@link SetupHost.copyToClipboard}.
 *
 * The clipboard is a display surface like any other: the *call* is recorded,
 * and a recorded call is printed in diagnostics. Task 5 puts a full
 * `/slackauthticket <ticket>` line on the clipboard because the user has to
 * paste it into Slack, so the ticket is registered here for exactly the same
 * reason sensitive argv is registered on {@link CommandSpec} — the text still
 * has to reach the pasteboard verbatim, but no display or call record may
 * carry it.
 */
export interface ClipboardOptions {
  /** Values to mask in the recorded call and in any diagnostic built from it. */
  sensitiveValues?: readonly string[];
  /**
   * Kill the pasteboard writer after this many ms.
   *
   * The clipboard is the one child a caller may reasonably treat as
   * best-effort, which makes an *unbounded* one the worst kind: `pbcopy`
   * against a wedged pasteboard server never exits, and a caller that is
   * holding a live credential while it waits has no way out. Bound it.
   */
  timeoutMs?: number;
  /** Cancel the pasteboard write when this fires. */
  signal?: AbortSignal;
}

/** Options for {@link SetupHost.promptSecret}. */
export interface SecretPromptOptions {
  /** Cancel a pending prompt; the host restores the terminal before rejecting. */
  signal?: AbortSignal;
}

/** The subset of a TTY input stream {@link SetupHost.promptSecret} needs. */
export interface SecretPromptInput extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  pause?(): unknown;
  resume?(): unknown;
}

/** Terminal streams used for no-echo secret entry. Injectable for tests. */
export interface SecretPromptStreams {
  input: SecretPromptInput;
  output: { write(chunk: string): unknown };
}

/** Handle on a running child started by {@link SetupHost.spawn}. */
export interface ChildProcessHandle {
  readonly pid: number | null;
  /** Subscribe to redacted stdout chunks. */
  onStdout(listener: (chunk: string) => void): void;
  /** Subscribe to redacted stderr chunks. */
  onStderr(listener: (chunk: string) => void): void;
  /** Signal the child (its whole group when `processGroup` was set). */
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<ProcessExit>;
}

/** Options for a single framed-JSON receive. */
export interface ReceiveJsonOptions<T> {
  timeoutMs: number;
  /** Throw to reject the frame; the thrown error propagates to the caller. */
  validate: (value: unknown) => T;
  /**
   * Peer authentication, applied **before** {@link validate}.
   *
   * A Unix socket in a 0700 directory is a gate against other users, not
   * against other processes of the *same* user, and the capture socket path is
   * predictable. Without this, the first frame from any same-uid process wins
   * the receive — which is an injection, not a race (I-1).
   *
   * Returning `false` destroys that one connection and keeps waiting on the
   * original deadline, so a wrong peer arriving first neither consumes the
   * receive nor extends the window. A frame that is not even JSON is treated
   * the same way when this is set: an unauthenticated peer is not entitled to
   * end the wait. Never throw from here — throwing is `validate`'s job, and it
   * would let one hostile frame abort the capture.
   */
  authenticate?: (value: unknown) => boolean;
  signal?: AbortSignal;
}

/** A received frame plus the ability to answer the client that sent it. */
export interface ReceivedMessage<T> {
  readonly value: T;
  /** Write exactly one framed JSON reply back to the sending client. */
  reply(value: unknown): Promise<void>;
}

/**
 * A Unix-domain socket listener, deliberately narrower than Node's
 * `net.Server`.
 *
 * ## Frame contract
 *
 * **Newline-delimited JSON.** One UTF-8 JSON value per line, terminated by a
 * single `\n`; no embedded raw newlines. Chosen over a length prefix because
 * the only writer is a one-shot child CLI (`somawork _capture-slack-auth`) —
 * NDJSON needs no header agreement, is trivially producible from any language,
 * and is readable in a hexless `nc` session while debugging. Frames are capped
 * at {@link MAX_SOCKET_FRAME_BYTES}; a longer line is a {@link SocketFrameError},
 * not a growing buffer.
 *
 * Each `receiveJson` call consumes exactly one frame. Frames that arrive while
 * no receive is pending are queued, so a client that writes two frames in one
 * `write()` is served by two sequential receives.
 */
export interface UnixSocketServer {
  readonly path: string;
  /** Wait for the next validated frame. Rejects on timeout, abort, bad frame. */
  receiveJson<T>(opts: ReceiveJsonOptions<T>): Promise<T>;
  /** Same, but keeps the sending connection addressable so you can ACK it. */
  receiveJsonMessage<T>(opts: ReceiveJsonOptions<T>): Promise<ReceivedMessage<T>>;
  /** Stop listening, drop clients, and unlink the socket file. Idempotent. */
  close(): Promise<void>;
}

/** Largest accepted NDJSON frame, in bytes. */
export const MAX_SOCKET_FRAME_BYTES = 64 * 1024;

/** Mode applied to the socket file when the caller does not choose one. */
export const DEFAULT_SOCKET_MODE = 0o600;

/** Mode applied to a socket's parent directory when the host has to create it. */
export const DEFAULT_SOCKET_DIR_MODE = 0o700;

/**
 * Typed `launchctl` operations.
 *
 * This is an argv builder, not a second execution path: both hosts implement
 * `launchctl` as `command(launchctlCommandSpec(op))`, so a launchctl call is
 * recorded and redacted exactly like any other command and Task 9 keeps the
 * single injection boundary it needs.
 */
export type LaunchctlOperation =
  | { kind: 'bootstrap'; domain: string; plistPath: string }
  | { kind: 'bootout'; target: string }
  | { kind: 'kickstart'; target: string; restart?: boolean }
  | { kind: 'print'; target: string }
  | { kind: 'enable'; target: string };

/** Absolute path of the system launchctl. */
export const LAUNCHCTL_BIN = '/bin/launchctl';

/** Build the argv for a {@link LaunchctlOperation}. */
export function launchctlCommandSpec(op: LaunchctlOperation): CommandSpec {
  switch (op.kind) {
    case 'bootstrap':
      return { command: LAUNCHCTL_BIN, args: ['bootstrap', op.domain, op.plistPath] };
    case 'bootout':
      return { command: LAUNCHCTL_BIN, args: ['bootout', op.target] };
    case 'kickstart':
      return { command: LAUNCHCTL_BIN, args: op.restart ? ['kickstart', '-k', op.target] : ['kickstart', op.target] };
    case 'print':
      return { command: LAUNCHCTL_BIN, args: ['print', op.target] };
    case 'enable':
      return { command: LAUNCHCTL_BIN, args: ['enable', op.target] };
  }
}

/**
 * Everything `somawork setup` is allowed to do to the machine.
 *
 * Adapters take a `SetupHost` and nothing else; that is what makes Tasks 4-6
 * testable without a Slack workspace, an llmux daemon, or a browser.
 */
export interface SetupHost {
  /** Run to completion and collect output. */
  command(spec: CommandSpec): Promise<CommandResult>;
  /** Start a long-running child and stream its output. */
  spawn(spec: SpawnSpec): ChildProcessHandle;
  /** Open an http(s) URL in the user's browser. Other schemes are refused. */
  openUrl(url: string): Promise<void>;
  /** Put text on the system clipboard (over stdin — never argv). */
  copyToClipboard(text: string, opts?: ClipboardOptions): Promise<void>;
  /** Listen for framed JSON on a Unix socket. */
  listenUnixSocket(path: string, mode?: number): Promise<UnixSocketServer>;
  /** Absolute path of `bin` on PATH, or `null` when it is not installed. */
  which(bin: string): Promise<string | null>;
  chmod(path: string, mode: number): Promise<void>;
  /** Typed launchctl operation; routed through {@link SetupHost.command}. */
  launchctl(op: LaunchctlOperation): Promise<CommandResult>;
  /**
   * Read one secret line from the terminal without echoing it.
   *
   * The Slack challenge (`task-5-context.md` step 2) is "secret-like ephemeral
   * input; never echo/persist/log". Without this seam Task 5 would reach
   * `process.stdin` directly and break the no-Node-globals invariant this
   * module exists to hold. The returned value is deliberately *not* part of any
   * result object: it is handed to the caller and to nobody else — hosts record
   * the prompt, never the answer.
   */
  promptSecret(prompt: string, opts?: SecretPromptOptions): Promise<string>;
  /** Milliseconds since the epoch. Fakeable clock. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The child could not be started at all (missing binary, bad cwd, EACCES). */
export class CommandSpawnError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CommandSpawnError';
  }
}

/** A URL was refused before anything was spawned. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** A binary name was refused before anything was spawned. */
export class UnsafeBinaryNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeBinaryNameError';
  }
}

/**
 * Why secret entry could not complete.
 *
 * A discriminant rather than a message match: `cancelled` (the user pressed
 * Ctrl-C) and `aborted` (the caller cancelled) both mean "the human walked
 * away", while `unavailable` means "this is not an interactive terminal" —
 * three different remedies for a caller, and matching on prose to tell them
 * apart would break the first time a message is reworded.
 */
export type SecretPromptReason = 'unavailable' | 'cancelled' | 'aborted';

/**
 * Secret entry could not complete: no TTY, the user pressed Ctrl-C, or the
 * caller aborted. One error type for all three because the caller's immediate
 * response is the same — stop, do not retry silently — and because the *reason*
 * must never carry the partially-typed value. {@link SecretPromptError.reason}
 * lets a caller that needs to branch do so without reading `message`.
 */
export class SecretPromptError extends Error {
  constructor(
    message: string,
    /** Defaults to `unavailable` so existing constructions keep compiling. */
    readonly reason: SecretPromptReason = 'unavailable',
  ) {
    super(message);
    this.name = 'SecretPromptError';
  }
}

/** A socket frame was unparseable, oversized, or otherwise malformed. */
export class SocketFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketFrameError';
  }
}

/** No frame arrived before the receive deadline. */
export class SocketTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketTimeoutError';
  }
}

/** A pending receive was cancelled by its caller's `AbortSignal`. */
export class SocketAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketAbortedError';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (used by both hosts so redaction cannot drift between them)
// ---------------------------------------------------------------------------

/**
 * The one redaction call both hosts make.
 *
 * Shared on purpose: if `RealHost` and `FakeHost` each built their own
 * redaction options, a test could pass against a fake that masks more (or
 * less) than production does. Deep-clones, so structured call records are safe
 * to hand out.
 */
export function redactForDisplay<T>(value: T, sensitiveValues: readonly string[] = []): T {
  return redactSecrets(value, { ephemeralValues: sensitiveValues }) as T;
}

/** Reject `-flags` and path-ish inputs where a bare binary name is expected. */
export function assertBareBinaryName(bin: string): void {
  if (bin.length === 0 || bin.startsWith('-') || bin.includes('/') || bin.includes('\0')) {
    throw new UnsafeBinaryNameError(`Refusing to look up "${bin}": expected a bare binary name.`);
  }
}

/** Reject anything that is not an http(s) URL (and anything argv could eat). */
export function assertOpenableUrl(url: string): void {
  if (url.startsWith('-')) {
    throw new UnsafeUrlError(`Refusing to open "${url}": leading "-" would be read as a flag.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(`Refusing to open "${url}": not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`Refusing to open "${url}": only http(s) URLs may be opened.`);
  }
  // "No credential may enter argv or a URL" (global constraints). Opening a URL
  // puts it in `open`'s argv, where `ps` can read it, so a URL the redactor
  // recognises as credential-bearing is refused rather than masked — masking a
  // URL you are about to open would just break the URL.
  if (redactForDisplay(url) !== url) {
    throw new UnsafeUrlError('Refusing to open a URL that carries a credential; strip it before opening.');
  }
}
