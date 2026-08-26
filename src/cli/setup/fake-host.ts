/**
 * The test double for {@link SetupHost}.
 *
 * `FakeHost` runs no process, opens no socket, and reads no clock. It records
 * every call and answers from stubs the test registered, so Tasks 4-6 can
 * assert *exact* command sequences (`llmux accounts` → `llmux login` →
 * `llmux restart` → `llmux accounts --json`) without an llmux daemon or a
 * Slack workspace.
 *
 * Two deliberate choices:
 *
 * - **Unstubbed calls throw.** A fake that silently returns `code: 0` turns a
 *   missing step into a passing test. {@link FakeHostUnexpectedCallError} names
 *   the command line that was not expected.
 * - **`calls` is redacted; `unsafeRawCalls()` is not.** A test that dumps
 *   `host.calls` on failure must not print a token, and a test that asserts a
 *   secret really did reach argv/env needs the raw view. The raw view is a
 *   method with `unsafeRaw` in its name for the same reason as on
 *   `CommandResult`: it cannot be reached by accident.
 */

import {
  assertBareBinaryName,
  assertOpenableUrl,
  type ChildProcessHandle,
  type ClipboardOptions,
  type CommandResult,
  CommandSpawnError,
  type CommandSpec,
  DEFAULT_SOCKET_MODE,
  type LaunchctlOperation,
  launchctlCommandSpec,
  type ProcessExit,
  type ReceivedMessage,
  type ReceiveJsonOptions,
  redactForDisplay,
  SecretPromptError,
  type SecretPromptOptions,
  type SetupHost,
  SocketAbortedError,
  SocketFrameError,
  SocketTimeoutError,
  type SpawnSpec,
  type UnixSocketServer,
} from './host';
import { CommandOutcome } from './real-host';

/** A call the fake host recorded, in the order it happened. */
export type RecordedCall =
  | {
      kind: 'command';
      command: string;
      args: readonly string[];
      env: Record<string, string>;
      /** Present only when the caller set it, so exact-match assertions stay terse. */
      inheritEnv?: boolean;
      cwd?: string;
      stdin?: string;
      timeoutMs?: number;
    }
  | {
      kind: 'spawn';
      command: string;
      args: readonly string[];
      env: Record<string, string>;
      /** Task 6 must be able to prove it asked for a killable process group. */
      processGroup?: boolean;
      /** Task 9 must be able to prove the headless fallback was fire-and-forget. */
      detached?: boolean;
      /** …and that it did not hand the controller's environment to the child. */
      inheritEnv?: boolean;
      cwd?: string;
    }
  | { kind: 'kill'; command: string; signal: NodeJS.Signals }
  | { kind: 'promptSecret'; prompt: string }
  | { kind: 'openUrl'; url: string }
  | {
      kind: 'copyToClipboard';
      text: string;
      /** Present when the caller bounded the write, so a test can prove it did. */
      timeoutMs?: number;
      /** Whether the caller handed the pasteboard a cancellation signal. */
      cancellable?: boolean;
    }
  | { kind: 'listenUnixSocket'; path: string; mode: number }
  | { kind: 'which'; bin: string }
  | { kind: 'chmod'; path: string; mode: number }
  | { kind: 'sleep'; ms: number };

/** What a stubbed command produced. */
export interface FakeCommandResponse {
  code?: number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  aborted?: boolean;
  /** Advance the fake clock by this much before returning. */
  delayMs?: number;
  /** Reject with this error instead of returning a result. */
  throws?: Error;
}

/** What a stubbed spawn produced. */
export interface FakeSpawnBehavior {
  stdout?: string;
  stderr?: string;
  code?: number;
  signal?: NodeJS.Signals | null;
  /** Stay running until `kill()` is called (default: exit immediately). */
  runUntilKilled?: boolean;
  pid?: number | null;
  /**
   * Reject `exited` with this error instead of resolving.
   *
   * `RealHost` reports a spawn that fails AFTER `spawn()` returns — the ENOENT
   * of a bad interpreter path — through the child's asynchronous `error` event,
   * which rejects `exited`. A fake that can only model a clean exit cannot
   * express that case, which is exactly the case that used to crash the CLI.
   */
  failsAsync?: Error;
}

/** Frames a stubbed Unix socket will hand out, in order. */
export interface FakeSocketScript {
  frames?: readonly unknown[];
}

/**
 * A command matcher. A string matches the full command line
 * (`[command, ...args].join(' ')`) either exactly or as a prefix ending on an
 * argument boundary, so `'llmux accounts'` matches `llmux accounts --json`
 * while `'llmux acc'` matches nothing.
 */
export type CommandMatcher = string | ((spec: CommandSpec) => boolean);

/** Raised when the code under test ran a command the test never stubbed. */
export class FakeHostUnexpectedCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeHostUnexpectedCallError';
  }
}

function commandLine(spec: { command: string; args?: readonly string[] }): string {
  return [spec.command, ...(spec.args ?? [])].join(' ');
}

function matches(matcher: CommandMatcher, spec: CommandSpec | SpawnSpec): boolean {
  if (typeof matcher === 'function') return matcher(spec as CommandSpec);
  const line = commandLine(spec);
  return line === matcher || line.startsWith(`${matcher} `);
}

interface Stub<TResponse, TSpec> {
  matcher: CommandMatcher;
  respond: TResponse | ((spec: TSpec) => TResponse);
  remaining: number;
  /** One-shot stubs are matched before general ones regardless of order. */
  once: boolean;
}

export interface FakeHostOptions {
  /** Starting value for the fake clock (ms since epoch). Default 0. */
  now?: number;
}

export class FakeHost implements SetupHost {
  #clock: number;
  #rawCalls: RecordedCall[] = [];
  #commandStubs: Array<Stub<FakeCommandResponse, CommandSpec>> = [];
  #spawnStubs: Array<Stub<FakeSpawnBehavior, SpawnSpec>> = [];
  #which = new Map<string, string | null>();
  #sockets = new Map<string, FakeSocketScript>();
  #prompts = new Map<string, string[]>();

  constructor(options: FakeHostOptions = {}) {
    this.#clock = options.now ?? 0;
  }

  // -- stubbing -------------------------------------------------------------

  /** Answer every matching command with `respond`. */
  stubCommand(matcher: CommandMatcher, respond: FakeCommandResponse | ((spec: CommandSpec) => FakeCommandResponse)) {
    this.#commandStubs.push({ matcher, respond, remaining: Number.POSITIVE_INFINITY, once: false });
    return this;
  }

  /** Answer the *next* matching command with `respond`, then fall through. */
  stubCommandOnce(
    matcher: CommandMatcher,
    respond: FakeCommandResponse | ((spec: CommandSpec) => FakeCommandResponse),
  ) {
    this.#commandStubs.push({ matcher, respond, remaining: 1, once: true });
    return this;
  }

  stubSpawn(matcher: CommandMatcher, behavior: FakeSpawnBehavior | ((spec: SpawnSpec) => FakeSpawnBehavior)) {
    this.#spawnStubs.push({ matcher, respond: behavior, remaining: Number.POSITIVE_INFINITY, once: false });
    return this;
  }

  /** `which(bin)` resolves to `resolved` (`null` = not installed). */
  stubWhich(bin: string, resolved: string | null) {
    this.#which.set(bin, resolved);
    return this;
  }

  stubUnixSocket(socketPath: string, script: FakeSocketScript) {
    this.#sockets.set(socketPath, script);
    return this;
  }

  /**
   * Script the value {@link FakeHost.promptSecret} returns for `prompt`.
   *
   * The value is held here and handed to the caller; it never enters the call
   * record, redacted or otherwise, because a scripted secret in a test log is
   * still a secret in a test log.
   */
  stubPromptSecret(prompt: string, value: string) {
    const queue = this.#prompts.get(prompt) ?? [];
    queue.push(value);
    this.#prompts.set(prompt, queue);
    return this;
  }

  // -- inspection -----------------------------------------------------------

  /** Redacted call log — safe to print in a test failure message. */
  get calls(): readonly RecordedCall[] {
    return this.#rawCalls.map((call) => {
      return redactForDisplay(call, this.#sensitiveFor(call));
    });
  }

  /**
   * Un-redacted call log. Tests only — use it to prove a secret *did* reach
   * child env (or *did not* reach argv); never print the result.
   */
  unsafeRawCalls(): readonly RecordedCall[] {
    return this.#rawCalls;
  }

  /** Move the fake clock forward without awaiting anything. */
  advanceTime(ms: number): void {
    this.#clock += ms;
  }

  #sensitive = new WeakMap<RecordedCall, readonly string[]>();

  #sensitiveFor(call: RecordedCall): readonly string[] {
    return this.#sensitive.get(call) ?? [];
  }

  #record(call: RecordedCall, sensitiveValues: readonly string[] = []): void {
    if (sensitiveValues.length > 0) this.#sensitive.set(call, sensitiveValues);
    this.#rawCalls.push(call);
  }

  #take<TResponse, TSpec extends CommandSpec | SpawnSpec>(
    stubs: Array<Stub<TResponse, TSpec>>,
    spec: TSpec,
  ): TResponse | undefined {
    // Once-stubs first: registering a general stub before a one-shot one would
    // otherwise shadow it forever, which is exactly the "no daemon, then
    // healthy" sequence Task 4 needs.
    for (const oncePass of [true, false]) {
      for (const stub of stubs) {
        if (stub.once !== oncePass || stub.remaining <= 0 || !matches(stub.matcher, spec)) continue;
        stub.remaining -= 1;
        return typeof stub.respond === 'function' ? (stub.respond as (s: TSpec) => TResponse)(spec) : stub.respond;
      }
    }
    return undefined;
  }

  // -- SetupHost ------------------------------------------------------------

  async command(spec: CommandSpec): Promise<CommandResult> {
    const sensitive = spec.sensitiveValues ?? [];
    const args = [...(spec.args ?? [])];
    this.#record(
      {
        kind: 'command',
        command: spec.command,
        args,
        env: { ...(spec.env ?? {}) },
        ...(spec.inheritEnv === undefined ? {} : { inheritEnv: spec.inheritEnv }),
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      },
      sensitive,
    );

    const outcome = (input: {
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      aborted: boolean;
      stdout?: string;
      stderr?: string;
    }): CommandResult =>
      new CommandOutcome({
        command: spec.command,
        args,
        code: input.code,
        signal: input.signal,
        timedOut: input.timedOut,
        aborted: input.aborted,
        rawStdout: input.stdout ?? '',
        rawStderr: input.stderr ?? '',
        sensitiveValues: sensitive,
      });

    // Parity with RealHost: an already-aborted signal produces an aborted
    // result without running anything, so it needs no stub either. Without
    // this, an adapter's real cancel path cannot be tested against the fake.
    if (spec.signal?.aborted) {
      return outcome({ code: null, signal: null, timedOut: false, aborted: true });
    }

    const response = this.#take(this.#commandStubs, spec);
    if (response === undefined) {
      throw new FakeHostUnexpectedCallError(`FakeHost has no stub for command: ${commandLine(spec)}`);
    }
    if (response.throws) throw response.throws;

    // Deterministic timeout on the fake clock — never wall time.
    const delayMs = response.delayMs ?? 0;
    if (spec.timeoutMs !== undefined && delayMs > spec.timeoutMs) {
      this.#clock += spec.timeoutMs;
      // A killed child keeps whatever it already flushed: `RealHost` collects
      // stdout/stderr up to the SIGKILL and hands them back on the timed-out
      // result. A fake that blanked them would make every "does a timeout leak
      // partial output?" test pass vacuously.
      return outcome({
        code: null,
        signal: 'SIGKILL',
        timedOut: true,
        aborted: false,
        stdout: response.stdout,
        stderr: response.stderr,
      });
    }
    this.#clock += delayMs;

    return outcome({
      code: response.code ?? 0,
      signal: response.signal ?? null,
      timedOut: response.timedOut ?? false,
      aborted: response.aborted ?? false,
      stdout: response.stdout,
      stderr: response.stderr,
    });
  }

  spawn(spec: SpawnSpec): ChildProcessHandle {
    const sensitive = spec.sensitiveValues ?? [];
    this.#record(
      {
        kind: 'spawn',
        command: spec.command,
        args: [...(spec.args ?? [])],
        env: { ...(spec.env ?? {}) },
        ...(spec.processGroup === undefined ? {} : { processGroup: spec.processGroup }),
        ...(spec.detached === undefined ? {} : { detached: spec.detached }),
        ...(spec.inheritEnv === undefined ? {} : { inheritEnv: spec.inheritEnv }),
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      },
      sensitive,
    );

    const behavior = this.#take(this.#spawnStubs, spec);
    if (behavior === undefined) {
      throw new FakeHostUnexpectedCallError(`FakeHost has no stub for spawn: ${commandLine(spec)}`);
    }

    const redact = (text: string) => redactForDisplay(text, sensitive);
    const stdoutListeners: Array<(chunk: string) => void> = [];
    const stderrListeners: Array<(chunk: string) => void> = [];

    let settle: (exit: ProcessExit) => void = () => {};
    let fail: (err: Error) => void = () => {};
    const exited = new Promise<ProcessExit>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // Mirrors RealHost: a detached child's handle is routinely discarded, so
    // the fake must not turn a scripted async failure into an unhandled
    // rejection that fails an unrelated test.
    if (spec.detached === true) exited.catch(() => {});

    const flush = () => {
      if (behavior.stdout) for (const l of stdoutListeners) l(redact(behavior.stdout));
      if (behavior.stderr) for (const l of stderrListeners) l(redact(behavior.stderr));
    };

    // Deliver on a microtask so a caller can subscribe after spawn() returns,
    // exactly as it must with a real child.
    queueMicrotask(() => {
      flush();
      if (behavior.failsAsync !== undefined) {
        fail(behavior.failsAsync);
        return;
      }
      if (!behavior.runUntilKilled) settle({ code: behavior.code ?? 0, signal: behavior.signal ?? null });
    });

    return {
      pid: behavior.pid === undefined ? 4242 : behavior.pid,
      onStdout(listener) {
        stdoutListeners.push(listener);
      },
      onStderr(listener) {
        stderrListeners.push(listener);
      },
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        // Recorded so Task 6 can assert the capture child was terminated,
        // rather than inferring it from `exited` alone.
        this.#record({ kind: 'kill', command: spec.command, signal });
        settle({ code: null, signal });
      },
      exited,
    };
  }

  async promptSecret(prompt: string, opts: SecretPromptOptions = {}): Promise<string> {
    // The prompt is metadata; the answer is not recorded on either view.
    this.#record({ kind: 'promptSecret', prompt });
    if (opts.signal?.aborted) {
      throw new SecretPromptError('Secret entry aborted before it began.', 'aborted');
    }
    const queue = this.#prompts.get(prompt);
    if (queue === undefined || queue.length === 0) {
      throw new FakeHostUnexpectedCallError(`FakeHost has no scripted secret for prompt: ${prompt}`);
    }
    return queue.length === 1 ? queue[0] : (queue.shift() as string);
  }

  async openUrl(url: string): Promise<void> {
    assertOpenableUrl(url);
    this.#record({ kind: 'openUrl', url });
  }

  async copyToClipboard(text: string, opts: ClipboardOptions = {}): Promise<void> {
    // The options are modelled, not merely accepted: the bound and the signal
    // are recorded so a test can prove the pasteboard write is bounded, and an
    // already-fired signal rejects here exactly as it does in `RealHost` (where
    // an aborted result is `!ok` and throws).
    this.#record(
      {
        kind: 'copyToClipboard',
        text,
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        ...(opts.signal === undefined ? {} : { cancellable: true }),
      },
      opts.sensitiveValues ?? [],
    );
    if (opts.signal?.aborted) {
      throw new CommandSpawnError('Clipboard write aborted before it began.');
    }
  }

  async listenUnixSocket(socketPath: string, mode: number = DEFAULT_SOCKET_MODE): Promise<UnixSocketServer> {
    this.#record({ kind: 'listenUnixSocket', path: socketPath, mode });
    const script = this.#sockets.get(socketPath);
    if (script === undefined) {
      throw new FakeHostUnexpectedCallError(`FakeHost has no stubbed unix socket at: ${socketPath}`);
    }
    return new FakeUnixSocketServer(socketPath, [...(script.frames ?? [])]);
  }

  async which(bin: string): Promise<string | null> {
    assertBareBinaryName(bin);
    this.#record({ kind: 'which', bin });
    return this.#which.get(bin) ?? null;
  }

  async chmod(target: string, mode: number): Promise<void> {
    this.#record({ kind: 'chmod', path: target, mode });
  }

  launchctl(op: LaunchctlOperation): Promise<CommandResult> {
    // Same single execution path as RealHost: recorded as a `command` call.
    return this.command(launchctlCommandSpec(op));
  }

  now(): number {
    return this.#clock;
  }

  async sleep(ms: number): Promise<void> {
    this.#record({ kind: 'sleep', ms });
    this.#clock += ms;
  }
}

/** Scripted {@link UnixSocketServer}: hands out queued frames, then times out. */
class FakeUnixSocketServer implements UnixSocketServer {
  readonly path: string;
  #frames: unknown[];
  #replies: unknown[] = [];
  #rejected: unknown[] = [];
  #closed = false;

  constructor(socketPath: string, frames: unknown[]) {
    this.path = socketPath;
    this.#frames = frames;
  }

  /** Payloads the code under test ACKed back to the client. */
  unsafeRawReplies(): readonly unknown[] {
    return this.#replies;
  }

  /** Frames `opts.authenticate` refused, in arrival order. */
  unsafeRawRejectedFrames(): readonly unknown[] {
    return this.#rejected;
  }

  async receiveJson<T>(opts: ReceiveJsonOptions<T>): Promise<T> {
    return (await this.receiveJsonMessage(opts)).value;
  }

  async receiveJsonMessage<T>(opts: ReceiveJsonOptions<T>): Promise<ReceivedMessage<T>> {
    if (this.#closed) throw new SocketFrameError('Socket server is closed.');
    // Same error class as RealHost: Task 6 branches on "cancelled" vs
    // "protocol violation", and a fake that reports the wrong one makes the
    // fake-based test green while the real path takes the other branch.
    if (opts.signal?.aborted) throw new SocketAbortedError('Socket receive aborted before it began.');
    // Same semantics as `RealHost`: a frame that does not authenticate is
    // dropped and the wait continues, so a wrong peer arriving first neither
    // consumes the receive nor blocks the legitimate one. Running out of
    // frames is this fake's expression of the deadline expiring.
    let candidate: { value: unknown } | null = null;
    while (this.#frames.length > 0) {
      const next = this.#frames.shift();
      if (opts.authenticate !== undefined && !opts.authenticate(next)) {
        this.#rejected.push(next);
        continue;
      }
      candidate = { value: next };
      break;
    }
    if (candidate === null) {
      throw new SocketTimeoutError(`No socket frame arrived within ${opts.timeoutMs}ms.`);
    }
    const value = opts.validate(candidate.value);
    return {
      value,
      reply: async (payload: unknown) => {
        this.#replies.push(payload);
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
