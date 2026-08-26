/**
 * The production {@link SetupHost}: the one place in `somawork setup` that is
 * allowed to touch `child_process`, `net`, `fs`, and the clock.
 *
 * Design rules held here so no adapter has to re-derive them:
 * - argv only, never a shell string — nothing is quoted, so nothing is injectable;
 * - child output is redacted on the way to every public field, and raw bytes are
 *   reachable only through the `unsafeRaw*` methods;
 * - timeout and abort both terminate the child and surface as flags on the
 *   result rather than as thrown control flow, so adapters branch on data;
 * - the Unix socket listener never escapes as a `net.Server`.
 */

import { assertNoSymlinkPath, UnsafePathError } from '@soma/common/atomic-write';
import { type ChildProcess, spawn as nodeSpawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import {
  assertBareBinaryName,
  assertOpenableUrl,
  type ChildProcessHandle,
  type ClipboardOptions,
  type CommandResult,
  CommandSpawnError,
  type CommandSpec,
  DEFAULT_SOCKET_DIR_MODE,
  DEFAULT_SOCKET_MODE,
  type LaunchctlOperation,
  launchctlCommandSpec,
  MAX_SOCKET_FRAME_BYTES,
  type ProcessExit,
  type ReceivedMessage,
  type ReceiveJsonOptions,
  redactForDisplay,
  SecretPromptError,
  type SecretPromptOptions,
  type SecretPromptStreams,
  type SetupHost,
  SocketAbortedError,
  SocketFrameError,
  SocketTimeoutError,
  type SpawnSpec,
  type UnixSocketServer,
} from './host';

const redactText = (value: string, sensitive: readonly string[]): string => redactForDisplay(value, sensitive);

/** Broken-pipe style errors: the child closed its end, which is not our failure. */
const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

function isBrokenPipe(err: NodeJS.ErrnoException): boolean {
  return BROKEN_PIPE_CODES.has(err.code ?? '');
}

/**
 * Line-buffered, redacted fan-out for a child's stdout/stderr.
 *
 * Redacting each `data` chunk independently is unsafe: a pipe read boundary can
 * fall in the middle of a token, and each half then fails the pattern, so the
 * tail reaches the terminal in the clear. This holds the trailing partial line
 * until its newline arrives, so the redactor always sees the same unit
 * `command()` gives it. `StringDecoder` does the same job for multi-byte UTF-8
 * (a Korean workspace name split across reads would otherwise become U+FFFD).
 *
 * Emitted lines produced before anyone subscribes are queued and replayed to
 * the first listener, so `spawn()` can start reading immediately without a
 * race against the caller's `onStdout` call.
 */
class RedactedLineSink {
  #decoder = new StringDecoder('utf8');
  #buffer = '';
  #listeners: Array<(chunk: string) => void> = [];
  #pending: string[] = [];

  constructor(private readonly sensitive: readonly string[]) {}

  subscribe(listener: (chunk: string) => void): void {
    this.#listeners.push(listener);
    if (this.#listeners.length === 1 && this.#pending.length > 0) {
      for (const chunk of this.#pending.splice(0)) listener(chunk);
    }
  }

  push(chunk: Buffer): void {
    this.#buffer += this.#decoder.write(chunk);
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline + 1);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#emit(redactText(line, this.sensitive));
      newline = this.#buffer.indexOf('\n');
    }
  }

  /** Emit the unterminated remainder — redacted — when the stream ends. */
  flush(): void {
    this.#buffer += this.#decoder.end();
    if (this.#buffer.length === 0) return;
    const rest = this.#buffer;
    this.#buffer = '';
    this.#emit(redactText(rest, this.sensitive));
  }

  #emit(chunk: string): void {
    if (this.#listeners.length === 0) {
      this.#pending.push(chunk);
      return;
    }
    for (const listener of this.#listeners) listener(chunk);
  }
}

/**
 * A finished command. Raw stdout/stderr live in `#private` fields so they are
 * invisible to spreads, `Object.keys`, `Object.values`, and `JSON.stringify` —
 * reaching them requires typing `unsafeRaw…` at the call site, which is the
 * point.
 */
export class CommandOutcome implements CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdout: string;
  readonly stderr: string;

  #rawStdout: string;
  #rawStderr: string;

  constructor(input: {
    command: string;
    args: readonly string[];
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    aborted: boolean;
    rawStdout: string;
    rawStderr: string;
    sensitiveValues: readonly string[];
  }) {
    const sensitive = input.sensitiveValues;
    this.command = redactText(input.command, sensitive);
    this.args = input.args.map((a) => redactText(a, sensitive));
    this.code = input.code;
    this.signal = input.signal;
    this.timedOut = input.timedOut;
    this.aborted = input.aborted;
    this.stdout = redactText(input.rawStdout, sensitive);
    this.stderr = redactText(input.rawStderr, sensitive);
    this.#rawStdout = input.rawStdout;
    this.#rawStderr = input.rawStderr;
  }

  get ok(): boolean {
    return this.code === 0 && !this.timedOut && !this.aborted;
  }

  /** Un-redacted stdout, for machine parsing only. Never print the result. */
  unsafeRawStdout(): string {
    return this.#rawStdout;
  }

  /** Un-redacted stderr, for machine parsing only. Never print the result. */
  unsafeRawStderr(): string {
    return this.#rawStderr;
  }

  /** Redacted, structured view — this is what `JSON.stringify` serializes. */
  toJSON(): Record<string, unknown> {
    return {
      command: this.command,
      args: this.args,
      code: this.code,
      signal: this.signal,
      timedOut: this.timedOut,
      aborted: this.aborted,
      ok: this.ok,
      stdout: this.stdout,
      stderr: this.stderr,
    };
  }

  toString(): string {
    return `${this.command} ${this.args.join(' ')} → code=${this.code}${this.timedOut ? ' (timed out)' : ''}${
      this.aborted ? ' (aborted)' : ''
    }`;
  }
}

function childEnv(spec: { env?: Readonly<Record<string, string>>; inheritEnv?: boolean }): NodeJS.ProcessEnv {
  const base = spec.inheritEnv === false ? {} : process.env;
  return { ...base, ...(spec.env ?? {}) };
}

/** Options that make the two macOS system utilities injectable for tests. */
export interface RealHostOptions {
  /** Browser opener. Default `/usr/bin/open`. */
  openCommand?: string;
  /** Clipboard writer, fed over stdin. Default `/usr/bin/pbcopy`. */
  clipboardCommand?: string;
  clipboardArgs?: readonly string[];
  /** PATH lookup helper. Default `/usr/bin/which`. */
  whichCommand?: string;
  /**
   * Seam for the socket-file `chmod`. Exists only so a test can prove the
   * listen path cleans up when a post-bind step fails; production uses `fs`.
   */
  socketChmod?: (path: string, mode: number) => Promise<void>;
  /** Terminal streams for {@link RealHost.promptSecret}. Default stdin/stderr. */
  promptStreams?: SecretPromptStreams;
}

export class RealHost implements SetupHost {
  private readonly openCommand: string;
  private readonly clipboardCommand: string;
  private readonly clipboardArgs: readonly string[];
  private readonly whichCommand: string;
  private readonly socketChmod: (path: string, mode: number) => Promise<void>;
  private readonly promptStreams: SecretPromptStreams;

  constructor(options: RealHostOptions = {}) {
    this.openCommand = options.openCommand ?? '/usr/bin/open';
    this.clipboardCommand = options.clipboardCommand ?? '/usr/bin/pbcopy';
    this.clipboardArgs = options.clipboardArgs ?? [];
    this.whichCommand = options.whichCommand ?? '/usr/bin/which';
    this.socketChmod = options.socketChmod ?? ((target, mode) => fs.promises.chmod(target, mode));
    // stderr, not stdout: stdout stays machine-parseable for piped invocations.
    this.promptStreams = options.promptStreams ?? { input: process.stdin, output: process.stderr };
  }

  command(spec: CommandSpec): Promise<CommandResult> {
    const args = spec.args ?? [];
    const sensitive = spec.sensitiveValues ?? [];

    const finish = (input: {
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      aborted: boolean;
      rawStdout: string;
      rawStderr: string;
    }): CommandResult => new CommandOutcome({ command: spec.command, args, sensitiveValues: sensitive, ...input });

    // An already-aborted signal must not start a process at all.
    if (spec.signal?.aborted) {
      return Promise.resolve(
        finish({ code: null, signal: null, timedOut: false, aborted: true, rawStdout: '', rawStderr: '' }),
      );
    }

    return new Promise<CommandResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = nodeSpawn(spec.command, [...args], {
          cwd: spec.cwd,
          env: childEnv(spec),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(new CommandSpawnError(`Failed to start "${spec.command}": ${String(err)}`, err));
        return;
      }

      let stdout = '';
      let stderr = '';
      // "we fired the timer / the signal", not "the command timed out": whether
      // it actually did is decided at close, because Node populates
      // child.exitCode only when it processes the exit event, which can lag the
      // real exit. Firing the timer against an already-dead child would
      // otherwise report `timedOut: true` on a successful `code: 0` run.
      let timeoutFired = false;
      let abortFired = false;
      let settled = false;
      let stdinError: NodeJS.ErrnoException | null = null;

      // StringDecoder, not chunk.toString(): a multi-byte character split
      // across two reads would otherwise decode as U+FFFD on both sides.
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += outDecoder.write(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += errDecoder.write(chunk);
      });

      // Attach the stdin error handler BEFORE writing. Node does not forward
      // stdio-stream errors to the ChildProcess 'error' event, so an unhandled
      // EPIPE here (child exits before draining >64 KiB) crashes the process —
      // including on the timeout path, where SIGKILL kills the reader mid-write.
      const stdinStream = child.stdin;
      if (stdinStream) {
        stdinStream.on('error', (err: NodeJS.ErrnoException) => {
          stdinError = err;
        });
      }

      const timer =
        spec.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              // The child may have exited in this same tick; marking a
              // successful run as timed out would make `ok` false for code 0.
              if (child.exitCode !== null || child.signalCode !== null) return;
              timeoutFired = true;
              child.kill('SIGKILL');
            }, spec.timeoutMs);

      const onAbort = () => {
        abortFired = true;
        child.kill('SIGKILL');
      };
      spec.signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        spec.signal?.removeEventListener('abort', onAbort);
      };

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new CommandSpawnError(`Failed to start "${spec.command}": ${err.message}`, err));
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        stdout += outDecoder.end();
        stderr += errDecoder.end();

        // A child we SIGKILLed reports `code: null` with a signal; one that ran
        // to completion reports a number. So the kill only "took" — and the run
        // only really timed out or was cancelled — when there is no exit code.
        const killedByUs = code === null;
        const timedOut = timeoutFired && killedByUs;
        const aborted = abortFired && killedByUs;

        // A broken pipe means the child stopped reading — its exit code is the
        // answer, not our failure. Any other stdin error means we did not
        // deliver the input we promised, so the call must not look successful.
        const failure: NodeJS.ErrnoException | null = stdinError;
        if (failure !== null && !isBrokenPipe(failure) && !timeoutFired && !abortFired) {
          reject(new CommandSpawnError(`Failed to write stdin to "${spec.command}": ${failure.message}`, failure));
          return;
        }
        resolve(finish({ code, signal, timedOut, aborted, rawStdout: stdout, rawStderr: stderr }));
      });

      if (stdinStream) {
        if (spec.stdin !== undefined) stdinStream.end(spec.stdin);
        else stdinStream.end();
      }
    });
  }

  spawn(spec: SpawnSpec): ChildProcessHandle {
    const sensitive = spec.sensitiveValues ?? [];
    // Fire-and-forget mode: no pipes to hold the child to this process, and the
    // handle is unref'd below so the CLI may exit while the daemon keeps
    // running. `ignore` (rather than inheriting) is the point — an inherited
    // fd would keep the child bound to a terminal that is about to disappear,
    // and a pipe nobody drains eventually blocks the child on a full buffer.
    const detach = spec.detached === true;
    let child: ChildProcess;
    try {
      child = nodeSpawn(spec.command, [...(spec.args ?? [])], {
        cwd: spec.cwd,
        env: childEnv(spec),
        stdio: detach ? 'ignore' : ['ignore', 'pipe', 'pipe'],
        detached: detach || spec.processGroup === true,
      });
    } catch (err) {
      throw new CommandSpawnError(`Failed to start "${spec.command}": ${String(err)}`, err);
    }
    if (detach) child.unref();

    const exited = new Promise<ProcessExit>((resolve, reject) => {
      let settled = false;
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(new CommandSpawnError(`"${spec.command}" failed: ${err.message}`, err));
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal });
      });
    });

    // A detached child is fire-and-forget by design, so callers routinely drop
    // the handle — and `exited` REJECTS on the child's asynchronous `error`
    // event (a bad interpreter path fails after spawn() returns, not during
    // it). An unobserved rejection takes the whole process down, which for the
    // service manager means the failure never reaches its rollback. The host
    // owns the promise, so the host observes it; `exited` itself is still
    // handed to the caller, so an explicit consumer can still await or catch.
    if (detach) exited.catch(() => {});

    const pid = child.pid ?? null;
    const usesGroup = (detach || spec.processGroup === true) && pid !== null;

    // Read immediately (not on first subscribe) so the sinks can line-buffer
    // and flush their remainder when the stream ends; queued lines are replayed
    // to the first listener.
    const stdoutSink = new RedactedLineSink(sensitive);
    const stderrSink = new RedactedLineSink(sensitive);
    child.stdout?.on('data', (chunk: Buffer) => stdoutSink.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrSink.push(chunk));
    child.stdout?.on('end', () => stdoutSink.flush());
    child.stderr?.on('end', () => stderrSink.flush());
    child.on('close', () => {
      stdoutSink.flush();
      stderrSink.flush();
    });

    return {
      pid,
      onStdout(listener) {
        stdoutSink.subscribe(listener);
      },
      onStderr(listener) {
        stderrSink.subscribe(listener);
      },
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        // Never signal a pgid for an exited child: the id can be reused, and a
        // long-lived handle would then signal an unrelated process group.
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (usesGroup && pid !== null) {
          try {
            // Negative pid targets the whole process group created by `detached`.
            process.kill(-pid, signal);
            return;
          } catch {
            // Group already gone (or never formed) — fall through to the child.
          }
        }
        child.kill(signal);
      },
      exited,
    };
  }

  async openUrl(url: string): Promise<void> {
    assertOpenableUrl(url);
    const result = await this.command({ command: this.openCommand, args: [url] });
    if (!result.ok) {
      throw new CommandSpawnError(`Failed to open a browser for the setup URL (${result.toString()}).`);
    }
  }

  async copyToClipboard(text: string, opts: ClipboardOptions = {}): Promise<void> {
    // stdin, never argv: argv is world-readable through `ps`.
    const result = await this.command({
      command: this.clipboardCommand,
      args: [...this.clipboardArgs],
      stdin: text,
      ...(opts.sensitiveValues === undefined ? {} : { sensitiveValues: opts.sensitiveValues }),
      // Both forwarded so the pasteboard is bounded and cancellable like every
      // other child; `command` only arms its kill timer when `timeoutMs` is set.
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    if (!result.ok) {
      throw new CommandSpawnError(`Failed to write to the clipboard (${result.toString()}).`);
    }
  }

  async which(bin: string): Promise<string | null> {
    assertBareBinaryName(bin);
    const result = await this.command({ command: this.whichCommand, args: [bin] });
    if (!result.ok) return null;
    const first = result.unsafeRawStdout().split('\n')[0]?.trim() ?? '';
    return first.length > 0 ? first : null;
  }

  async chmod(target: string, mode: number): Promise<void> {
    await fs.promises.chmod(target, mode);
  }

  launchctl(op: LaunchctlOperation): Promise<CommandResult> {
    // Single execution path: launchctl is argv construction plus `command`.
    return this.command(launchctlCommandSpec(op));
  }

  async listenUnixSocket(socketPath: string, mode: number = DEFAULT_SOCKET_MODE): Promise<UnixSocketServer> {
    return NdjsonUnixSocketServer.listen(socketPath, mode, this.socketChmod);
  }

  /**
   * Read one line from the terminal with echo disabled.
   *
   * The value is returned to the caller and stored nowhere: no field on `this`,
   * no result object, no log. Raw mode and the `data` listener are restored on
   * every exit path — resolve, Ctrl-C, abort, and error — because a terminal
   * left in raw mode makes the rest of the wizard unusable.
   */
  promptSecret(prompt: string, opts: SecretPromptOptions = {}): Promise<string> {
    const { input, output } = this.promptStreams;

    if (input.isTTY !== true || typeof input.setRawMode !== 'function') {
      // Fail loudly rather than fall back to an echoing read: a challenge code
      // echoed into a scrollback or a CI log is a leaked credential.
      return Promise.reject(
        new SecretPromptError(
          'Cannot read a secret without a TTY. Run this command in an interactive terminal (no pipe or CI runner).',
          'unavailable',
        ),
      );
    }
    if (opts.signal?.aborted) {
      return Promise.reject(new SecretPromptError('Secret entry aborted before it began.', 'aborted'));
    }

    const setRawMode = input.setRawMode.bind(input);

    return new Promise<string>((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let value = '';
      let done = false;

      const finish = (settle: () => void): void => {
        if (done) return;
        done = true;
        input.off('data', onData);
        opts.signal?.removeEventListener('abort', onAbort);
        try {
          setRawMode(false);
        } catch {
          // Best effort: a closed TTY cannot be restored, and the caller's
          // outcome matters more than the restore.
        }
        input.pause?.();
        output.write('\n');
        settle();
      };

      function onData(chunk: Buffer): void {
        for (const ch of decoder.write(chunk)) {
          if (ch === '\n' || ch === '\r') {
            const entered = value;
            value = '';
            finish(() => resolve(entered));
            return;
          }
          if (ch === '\u0003') {
            value = '';
            finish(() => reject(new SecretPromptError('Secret entry cancelled.', 'cancelled')));
            return;
          }
          if (ch === '\u007f' || ch === '\b') {
            value = value.slice(0, -1);
            continue;
          }
          value += ch;
        }
      }

      const onAbort = (): void => {
        value = '';
        finish(() => reject(new SecretPromptError('Secret entry aborted.', 'aborted')));
      };

      output.write(prompt);
      setRawMode(true);
      input.resume?.();
      input.on('data', onData);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Unix socket server — newline-delimited JSON
// ---------------------------------------------------------------------------

/**
 * Force the socket's own directory to 0700 — but only if we own it.
 *
 * A 0600 socket inside a traversable directory is not private, so the tighten
 * is required; chmod'ing a directory belonging to someone else is not ours to
 * do, so foreign ownership is refused rather than silently modified.
 */
async function tightenOwnedDirectory(dir: string): Promise<void> {
  const stats = await fs.promises.lstat(dir);
  if (!stats.isDirectory()) {
    throw new UnsafePathError(`Refusing to use "${dir}": not a directory.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new UnsafePathError(`Refusing to use "${dir}": owned by uid ${stats.uid}, not the current user (${uid}).`);
  }
  if ((stats.mode & 0o777) !== DEFAULT_SOCKET_DIR_MODE) {
    await fs.promises.chmod(dir, DEFAULT_SOCKET_DIR_MODE);
  }
}

interface QueuedFrame {
  raw: string;
  socket: net.Socket;
}

/**
 * NDJSON listener on a Unix domain socket.
 *
 * Not exported: consumers only ever see the {@link UnixSocketServer} interface
 * returned by `listenUnixSocket`, so the underlying `net.Server` cannot be
 * reached from an adapter.
 */
class NdjsonUnixSocketServer implements UnixSocketServer {
  readonly path: string;

  #server: net.Server;
  #sockets = new Set<net.Socket>();
  #frames: QueuedFrame[] = [];
  #waiters: Array<{ resolve: (f: QueuedFrame) => void; reject: (e: Error) => void }> = [];
  #closed = false;
  #fatal: Error | null = null;

  private constructor(socketPath: string, server: net.Server) {
    this.path = socketPath;
    this.#server = server;
    server.on('connection', (socket) => this.#attach(socket));
  }

  static async listen(
    socketPath: string,
    mode: number,
    chmodFile: (path: string, mode: number) => Promise<void>,
  ): Promise<UnixSocketServer> {
    const target = path.resolve(socketPath);
    const dir = path.dirname(target);

    // Guard the WHOLE ancestry, not just the leaf: `fs.chmod` follows symlinks,
    // so a symlinked ancestor would let us tighten (and bind inside) a
    // directory that is not ours. Task 2's stores were hardened the same way.
    assertNoSymlinkPath(target);
    await fs.promises.mkdir(dir, { recursive: true, mode: DEFAULT_SOCKET_DIR_MODE });
    // Re-assert: mkdir ran after the first check, so the window is only closed
    // by checking again on the path we are about to use.
    assertNoSymlinkPath(target);
    await tightenOwnedDirectory(dir);

    // Remove a stale node so bind() cannot fail with EADDRINUSE.
    await fs.promises.rm(target, { force: true });

    const server = net.createServer();
    // Attach connection handling before listen(): a client that connects
    // between bind and construction would otherwise get an unattached socket
    // that is never read and never destroyed.
    const instance = new NdjsonUnixSocketServer(target, server);

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(target, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      // net.Server honours umask, so the mode is applied explicitly afterwards.
      await chmodFile(target, mode);
    } catch (err) {
      // Anything after a successful bind must not leave a listening server
      // behind: it holds an fd, keeps the event loop alive so the wizard never
      // exits, and leaves a socket file carrying the umask mode instead of 0600.
      await instance.close();
      throw err;
    }

    return instance;
  }

  #attach(socket: net.Socket): void {
    this.#sockets.add(socket);
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    socket.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);

      // Split first, *then* bound: the cap is on one unterminated frame, not on
      // how much a client happened to put in a single write(). Checking the
      // whole buffer would reject a legitimate batch of small frames.
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(raw, 'utf-8') > MAX_SOCKET_FRAME_BYTES) {
          this.#fail(
            new SocketFrameError(`Socket frame exceeded ${MAX_SOCKET_FRAME_BYTES} bytes; refusing to accept it.`),
          );
          socket.destroy();
          return;
        }
        if (raw.trim().length > 0) this.#push({ raw, socket });
        newline = buffer.indexOf('\n');
      }

      if (Buffer.byteLength(buffer, 'utf-8') > MAX_SOCKET_FRAME_BYTES) {
        this.#fail(
          new SocketFrameError(
            `Unterminated socket frame exceeded ${MAX_SOCKET_FRAME_BYTES} bytes; refusing to buffer.`,
          ),
        );
        socket.destroy();
      }
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.#sockets.delete(socket));
  }

  #push(frame: QueuedFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(frame);
    else this.#frames.push(frame);
  }

  /** A protocol violation fails the pending receive *and* every later one. */
  #fail(error: Error): void {
    this.#fatal = error;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w.reject(error);
  }

  async receiveJson<T>(opts: ReceiveJsonOptions<T>): Promise<T> {
    return (await this.receiveJsonMessage(opts)).value;
  }

  async receiveJsonMessage<T>(opts: ReceiveJsonOptions<T>): Promise<ReceivedMessage<T>> {
    // One deadline for the whole call, not one per frame. `opts.authenticate`
    // can reject any number of frames, and a fresh timer per rejection would
    // let an unauthenticated peer hold the receive open forever.
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SocketTimeoutError(`No socket frame arrived within ${opts.timeoutMs}ms.`);
      }
      const frame = await this.#nextFrame(remaining, opts.signal, opts.timeoutMs);

      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.raw);
      } catch (err) {
        // With authentication on, a frame we cannot even parse is by definition
        // a frame we cannot authenticate: drop the peer and keep waiting, so
        // one hostile write cannot end the legitimate helper's window. Without
        // it, the single expected writer is our own child and unparseable bytes
        // are a loud contract failure.
        if (opts.authenticate !== undefined) {
          frame.socket.destroy();
          continue;
        }
        throw new SocketFrameError(`Socket frame is not valid JSON: ${(err as Error).message}`);
      }

      if (opts.authenticate !== undefined && !opts.authenticate(parsed)) {
        frame.socket.destroy();
        continue;
      }

      // A validator throwing is a loud, caller-defined rejection — propagate it
      // unwrapped so the adapter sees its own error type and message.
      const value = opts.validate(parsed);

      const socket = frame.socket;
      return this.#message(value, socket);
    }
  }

  #message<T>(value: T, socket: net.Socket): ReceivedMessage<T> {
    return {
      value,
      reply: (payload: unknown) =>
        new Promise<void>((resolve, reject) => {
          // JSON.stringify(undefined) is `undefined`, which would put the bare
          // token `undefined` on the wire — not a JSON value the peer can parse.
          const encoded = JSON.stringify(payload);
          if (encoded === undefined) {
            reject(new SocketFrameError('Cannot reply with a value that is not JSON-serializable.'));
            return;
          }
          if (socket.destroyed || this.#closed) {
            reject(new SocketFrameError('Cannot reply: the client disconnected before the ACK.'));
            return;
          }
          socket.write(`${encoded}\n`, (err) => (err ? reject(err) : resolve()));
        }),
    };
  }

  #nextFrame(timeoutMs: number, signal?: AbortSignal, reportedTimeoutMs = timeoutMs): Promise<QueuedFrame> {
    if (this.#closed) return Promise.reject(new SocketFrameError('Socket server is closed.'));

    const queued = this.#frames.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#fatal) return Promise.reject(this.#fatal);
    if (signal?.aborted) return Promise.reject(new SocketAbortedError('Socket receive aborted before it began.'));

    return new Promise<QueuedFrame>((resolve, reject) => {
      const entry = {
        resolve: (f: QueuedFrame) => {
          cleanup();
          resolve(f);
        },
        reject: (e: Error) => {
          cleanup();
          reject(e);
        },
      };

      const drop = () => {
        const i = this.#waiters.indexOf(entry);
        if (i >= 0) this.#waiters.splice(i, 1);
      };

      const timer = setTimeout(() => {
        drop();
        cleanup();
        reject(new SocketTimeoutError(`No socket frame arrived within ${reportedTimeoutMs}ms.`));
      }, timeoutMs);

      const onAbort = () => {
        drop();
        cleanup();
        reject(new SocketAbortedError('Socket receive aborted by caller.'));
      };

      function cleanup() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(entry);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    this.#fail(new SocketFrameError('Socket server closed while a receive was pending.'));
    // Queued frames hold live net.Socket references; a frame accepted before
    // close must not be served afterwards either.
    this.#frames = [];
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();

    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    // The socket file survives close(); leaving it behind would poison the next run.
    await fs.promises.rm(this.path, { force: true });
  }
}
