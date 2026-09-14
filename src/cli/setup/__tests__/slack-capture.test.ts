/**
 * Task 6 — zero-token-copy Slack runtime auth capture.
 *
 * The whole point of this module is that a Slack bot/app token travels
 * **child env → Unix socket frame → 0600 secrets file** and touches nothing
 * else. These tests assert that negatively as well as positively: the last
 * describe block scans every public surface the flow produces — recorded host
 * calls (redacted *and* raw), progress lines, error messages, error `toJSON()`,
 * setup state and the returned receipt — for sentinel token values, and
 * requires zero hits.
 *
 * Source-pinned facts encoded here (docs.slack.dev/tools/slack-cli/reference/hooks
 * and `slackapi/slack-cli`, verified 2026-08-24):
 *
 * - The start hook's child env carries `SLACK_CLI_XOXB` / `SLACK_CLI_XAPP` and
 *   the aliases `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`. Nothing else — in
 *   particular no app id and no team id — is documented, so the helper sends
 *   tokens only and the parent takes ids from the CLI's own app mapping file.
 * - In SDK-managed mode the hook's stdout is streamed to the CLI's stdout, so
 *   the helper must write nothing there. The socket is the only carrier.
 * - `internal/hooks/hooks.go:56-57` appends `--key=value` pairs after the hook's
 *   own arguments, so the helper's argv parser has to tolerate extras.
 *
 * Nothing here uses a production-code test hook: where a test needs to see an
 * ACK or make one fail, it wraps the {@link FakeHost} seam instead.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { FakeHost, type RecordedCall } from '../fake-host';
import {
  type ChildProcessHandle,
  MAX_SOCKET_FRAME_BYTES,
  type ProcessExit,
  type ReceivedMessage,
  type ReceiveJsonOptions,
  SocketAbortedError,
  SocketFrameError,
  SocketTimeoutError,
  type SpawnSpec,
  type UnixSocketServer,
} from '../host';
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  buildCaptureAck,
  CAPTURE_FRAME_VERSION,
  type CaptureSocketClient,
  captureAndPersistSlackRuntimeTokens,
  captureSlackRuntimeTokens,
  parseCaptureHelperArgv,
  readCaptureTokensFromEnv,
  runSlackAuthCaptureHelper,
  SlackCaptureCancelledError,
  SlackCaptureChildError,
  SlackCaptureEnvError,
  SlackCaptureError,
  SlackCaptureIncompleteError,
  type SlackCaptureOptions,
  SlackCaptureOptionsError,
  SlackCapturePersistError,
  SlackCaptureProtocolError,
  SlackCaptureTimeoutError,
} from '../slack-capture';
import { CAPTURE_NONCE_CHARS, generateCaptureNonce, type SlackProject } from '../slack-manifest';
import { assertSecretFree, createDefaultSetupState } from '../state';

// ---------------------------------------------------------------------------
// Sentinels — fictional, but shaped exactly like the real thing
// ---------------------------------------------------------------------------

const BOT_TOKEN = `${BOT_TOKEN_PREFIX}2222222222-3333333333-SENTINELBOTVALUE0001`;
const APP_TOKEN = `${APP_TOKEN_PREFIX}1-A0SENTINEL-4444444444-SENTINELAPPVALUE0001`;
const TEAM_ID = 'T024BE7LD';
const APP_ID = 'A0SOMAWORK1';
const SLACK_BIN = '/opt/homebrew/bin/slack';
const SOCKET_PATH = '/tmp/somawork-test/run/slack-capture.sock';
const PROJECT_ROOT = '/tmp/somawork-test/slack-project';

/**
 * This run's challenge (I-1) and an attacker's guess at it. Fixed values rather
 * than `generateCaptureNonce()` so a failure names the two strings that
 * disagreed; both are the real shape, so the real comparison runs.
 */
const NONCE = 'a'.repeat(CAPTURE_NONCE_CHARS);
const WRONG_NONCE = 'b'.repeat(CAPTURE_NONCE_CHARS);

const MAPPING = { appId: APP_ID, teamId: TEAM_ID, source: 'dev' as const };

function project(overrides: Partial<SlackProject> = {}): SlackProject {
  return {
    profile: 'preview',
    teamId: TEAM_ID,
    root: PROJECT_ROOT,
    manifestPath: path.join(PROJECT_ROOT, 'manifest.json'),
    hooksPath: path.join(PROJECT_ROOT, '.slack', 'hooks.json'),
    devAppsPath: path.join(PROJECT_ROOT, '.slack', 'apps.dev.json'),
    deployedAppsPath: path.join(PROJECT_ROOT, '.slack', 'apps.json'),
    socketPath: SOCKET_PATH,
    captureNonce: NONCE,
    appMapping: null,
    ...overrides,
  };
}

function frame(overrides: Record<string, unknown> = {}): unknown {
  return { version: CAPTURE_FRAME_VERSION, nonce: NONCE, botToken: BOT_TOKEN, appToken: APP_TOKEN, ...overrides };
}

/** A FakeHost primed for a normal capture: long-running child, one good frame. */
function primedHost(frames: readonly unknown[] = [frame()]): FakeHost {
  return new FakeHost()
    .stubSpawn(SLACK_BIN, { runUntilKilled: true, stdout: 'Connected, awaiting events\n' })
    .stubUnixSocket(SOCKET_PATH, { frames });
}

// ---------------------------------------------------------------------------
// Test seams — wrappers around FakeHost, never hooks in production code
// ---------------------------------------------------------------------------

interface SocketSpy {
  /** Payloads the code under test acknowledged with. */
  replies: unknown[];
  closes: number;
}

/**
 * Wrap `host.listenUnixSocket` so a test can watch (or break) the ACK and the
 * close. `events` records interleaving with other observed steps.
 */
function spySocket(
  host: FakeHost,
  opts: { failReply?: boolean; failReceiveWith?: Error; events?: string[] } = {},
): SocketSpy {
  const spy: SocketSpy = { replies: [], closes: 0 };
  const original = host.listenUnixSocket.bind(host);

  (host as unknown as { listenUnixSocket: unknown }).listenUnixSocket = async (
    socketPath: string,
    mode?: number,
  ): Promise<UnixSocketServer> => {
    const server = await original(socketPath, mode);
    const wrapped: UnixSocketServer = {
      path: server.path,
      receiveJson<T>(options: ReceiveJsonOptions<T>): Promise<T> {
        return server.receiveJson(options);
      },
      async receiveJsonMessage<T>(options: ReceiveJsonOptions<T>): Promise<ReceivedMessage<T>> {
        if (opts.failReceiveWith) throw opts.failReceiveWith;
        const message = await server.receiveJsonMessage(options);
        return {
          value: message.value,
          reply: async (payload: unknown) => {
            if (opts.failReply) throw new SocketFrameError('the client disconnected before the ACK');
            opts.events?.push('ack');
            spy.replies.push(payload);
            await message.reply(payload);
          },
        };
      },
      close: async () => {
        spy.closes += 1;
        await server.close();
      },
    };
    return wrapped;
  };

  return spy;
}

/** Wrap `host.spawn` with a child whose `kill` throws, to break cleanup. */
function unkillableChild(host: FakeHost): void {
  const original = host.spawn.bind(host);
  (host as unknown as { spawn: unknown }).spawn = (spec: SpawnSpec): ChildProcessHandle => {
    const handle = original(spec);
    return {
      pid: handle.pid,
      onStdout: (listener) => handle.onStdout(listener),
      onStderr: (listener) => handle.onStderr(listener),
      kill: () => {
        throw new Error('ESRCH: no such process group');
      },
      exited: handle.exited,
    };
  };
}

/** Wrap `host.spawn` with a child that survives SIGTERM and dies on SIGKILL. */
function stubbornChild(host: FakeHost): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = [];
  const original = host.spawn.bind(host);

  (host as unknown as { spawn: unknown }).spawn = (spec: SpawnSpec): ChildProcessHandle => {
    const handle = original(spec);
    let settle: (exit: ProcessExit) => void = () => {};
    const exited = new Promise<ProcessExit>((resolve) => {
      settle = resolve;
    });
    return {
      pid: handle.pid,
      onStdout: (listener) => handle.onStdout(listener),
      onStderr: (listener) => handle.onStderr(listener),
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        signals.push(signal);
        if (signal === 'SIGKILL') settle({ code: null, signal: 'SIGKILL' });
      },
      exited,
    };
  };

  return signals;
}

interface Recorder {
  events: string[];
  persisted: Array<Record<string, string>>;
  persist: (values: { SLACK_BOT_TOKEN: string; SLACK_APP_TOKEN: string }) => void;
}

function recorder(events: string[] = []): Recorder {
  const persisted: Array<Record<string, string>> = [];
  return {
    events,
    persisted,
    persist: (values) => {
      events.push('persist');
      persisted.push({ ...values });
    },
  };
}

function baseOptions(rec: Recorder, over: Partial<SlackCaptureOptions> = {}): SlackCaptureOptions {
  return {
    project: project({ appMapping: MAPPING }),
    slackBin: SLACK_BIN,
    persist: rec.persist,
    readMapping: () => MAPPING,
    ...over,
  };
}

function spawnCalls(host: FakeHost): Extract<RecordedCall, { kind: 'spawn' }>[] {
  return host
    .unsafeRawCalls()
    .filter((call): call is Extract<RecordedCall, { kind: 'spawn' }> => call.kind === 'spawn');
}

// ---------------------------------------------------------------------------
// Helper: env resolution
// ---------------------------------------------------------------------------

describe('readCaptureTokensFromEnv', () => {
  it('prefers the SLACK_CLI_* forms', () => {
    expect(
      readCaptureTokensFromEnv({
        SLACK_CLI_XOXB: BOT_TOKEN,
        SLACK_CLI_XAPP: APP_TOKEN,
        SLACK_BOT_TOKEN: BOT_TOKEN,
        SLACK_APP_TOKEN: APP_TOKEN,
      }),
    ).toEqual({ botToken: BOT_TOKEN, appToken: APP_TOKEN });
  });

  it('falls back to the standard alias names', () => {
    expect(readCaptureTokensFromEnv({ SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN })).toEqual({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
    });
  });

  it('treats an empty value as absent', () => {
    expect(
      readCaptureTokensFromEnv({ SLACK_CLI_XOXB: '', SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_CLI_XAPP: APP_TOKEN }),
    ).toEqual({ botToken: BOT_TOKEN, appToken: APP_TOKEN });
  });

  it('refuses when the bot token aliases disagree', () => {
    expect(() =>
      readCaptureTokensFromEnv({
        SLACK_CLI_XOXB: BOT_TOKEN,
        SLACK_BOT_TOKEN: `${BOT_TOKEN_PREFIX}9999999999-OTHERVALUE00000`,
        SLACK_CLI_XAPP: APP_TOKEN,
      }),
    ).toThrow(SlackCaptureEnvError);
  });

  it('refuses when the app token aliases disagree', () => {
    expect(() =>
      readCaptureTokensFromEnv({
        SLACK_CLI_XOXB: BOT_TOKEN,
        SLACK_CLI_XAPP: APP_TOKEN,
        SLACK_APP_TOKEN: `${APP_TOKEN_PREFIX}1-A0OTHER-1-OTHERVALUE00000000`,
      }),
    ).toThrow(SlackCaptureEnvError);
  });

  it.each([
    ['bot token is missing', { SLACK_CLI_XAPP: APP_TOKEN }],
    ['app token is missing', { SLACK_CLI_XOXB: BOT_TOKEN }],
    ['bot prefix is wrong', { SLACK_CLI_XOXB: `xoxp-${'a'.repeat(30)}`, SLACK_CLI_XAPP: APP_TOKEN }],
    ['app prefix is wrong', { SLACK_CLI_XOXB: BOT_TOKEN, SLACK_CLI_XAPP: `xoxb-${'a'.repeat(30)}` }],
    ['bot token is too short', { SLACK_CLI_XOXB: `${BOT_TOKEN_PREFIX}a`, SLACK_CLI_XAPP: APP_TOKEN }],
    ['bot token is too long', { SLACK_CLI_XOXB: `${BOT_TOKEN_PREFIX}${'a'.repeat(9000)}`, SLACK_CLI_XAPP: APP_TOKEN }],
    ['bot token has a newline', { SLACK_CLI_XOXB: `${BOT_TOKEN}\nextra`, SLACK_CLI_XAPP: APP_TOKEN }],
    ['bot token has a NUL', { SLACK_CLI_XOXB: `${BOT_TOKEN}\u0000`, SLACK_CLI_XAPP: APP_TOKEN }],
    ['bot token has a bell', { SLACK_CLI_XOXB: `${BOT_TOKEN}\u0007`, SLACK_CLI_XAPP: APP_TOKEN }],
    ['bot token has a space', { SLACK_CLI_XOXB: `${BOT_TOKEN} `, SLACK_CLI_XAPP: APP_TOKEN }],
    ['app token has a control byte', { SLACK_CLI_XOXB: BOT_TOKEN, SLACK_CLI_XAPP: `${APP_TOKEN}\u0001` }],
    ['app token has a quote', { SLACK_CLI_XOXB: BOT_TOKEN, SLACK_CLI_XAPP: `${APP_TOKEN}"` }],
  ])('refuses when the %s', (_label, env) => {
    expect(() => readCaptureTokensFromEnv(env as Record<string, string>)).toThrow(SlackCaptureEnvError);
  });

  it('never puts the offending token value in the error', () => {
    try {
      readCaptureTokensFromEnv({ SLACK_CLI_XOXB: 'xoxp-SENTINELWRONGPREFIXVALUE', SLACK_CLI_XAPP: APP_TOKEN });
      expect.unreachable('a wrong prefix must be refused');
    } catch (err) {
      expect((err as Error).message).not.toContain('SENTINELWRONGPREFIXVALUE');
      expect((err as Error).message).toContain('SLACK_CLI_XOXB');
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: argv
// ---------------------------------------------------------------------------

describe('parseCaptureHelperArgv', () => {
  it('reads --socket PATH --nonce HEX', () => {
    expect(parseCaptureHelperArgv(['--socket', SOCKET_PATH, '--nonce', NONCE])).toEqual({
      socketPath: SOCKET_PATH,
      nonce: NONCE,
    });
  });

  it('reads --socket=PATH --nonce=HEX', () => {
    expect(parseCaptureHelperArgv([`--socket=${SOCKET_PATH}`, `--nonce=${NONCE}`])).toEqual({
      socketPath: SOCKET_PATH,
      nonce: NONCE,
    });
  });

  it('decodes an escaped path, because the hook grammar cannot quote one', () => {
    expect(parseCaptureHelperArgv(['--socket', '/tmp/a%20b/c.sock', '--nonce', NONCE])).toEqual({
      socketPath: '/tmp/a b/c.sock',
      nonce: NONCE,
    });
  });

  it('requires the challenge, and requires it to be well formed (I-1)', () => {
    // An optional challenge is not a challenge: it would hand any same-uid
    // caller a documented way to ask for the unauthenticated path.
    expect(() => parseCaptureHelperArgv(['--socket', SOCKET_PATH])).toThrow(SlackCaptureOptionsError);
    for (const bad of ['', 'short', NONCE.toUpperCase(), `${NONCE}0`, NONCE.slice(0, -1)]) {
      expect(() => parseCaptureHelperArgv(['--socket', SOCKET_PATH, `--nonce=${bad}`])).toThrow(
        SlackCaptureOptionsError,
      );
    }
  });

  it('never quotes the challenge back at the terminal', () => {
    try {
      parseCaptureHelperArgv(['--socket', SOCKET_PATH, '--nonce', 'f'.repeat(10)]);
      expect.unreachable('a malformed challenge must be refused');
    } catch (err) {
      expect((err as Error).message).not.toContain('f'.repeat(10));
    }
  });

  it('tolerates the --name="value" form the Slack CLI appends to generic hooks', () => {
    // M-5: the real appended form carries LITERAL quotes
    // (internal/goutils/map.go:29-36), appended as whole argv elements. The
    // SDK-managed `start` hook appends nothing at all
    // (internal/pkg/platform/localserver.go:306-309) — this tolerance is for
    // the generic hook path and for surviving a CLI change.
    expect(
      parseCaptureHelperArgv([
        '--socket',
        SOCKET_PATH,
        '--nonce',
        NONCE,
        '--source="/tmp/soma work"',
        '--protocol="v1"',
      ]),
    ).toEqual({ socketPath: SOCKET_PATH, nonce: NONCE });
  });

  it('never quotes an unexpected argument back at the terminal', () => {
    try {
      parseCaptureHelperArgv(['xoxb-SENTINELARGVLEAK0002']);
      expect.unreachable('a positional argument must be refused');
    } catch (err) {
      expect((err as Error).message).not.toContain('SENTINELARGVLEAK0002');
    }
  });

  it.each([
    [[]],
    [['--socket']],
    [['--socket', SOCKET_PATH, '--socket', SOCKET_PATH]],
    [['positional']],
  ])('refuses the malformed argv %j', (argv) => {
    expect(() => parseCaptureHelperArgv(argv as string[])).toThrow(SlackCaptureOptionsError);
  });
});

// ---------------------------------------------------------------------------
// Helper: the socket exchange
// ---------------------------------------------------------------------------

function fakeConnector(script: { ack?: unknown; ackError?: Error } = {}) {
  const sent: string[] = [];
  const state = { connects: 0, closes: 0 };
  const connect = async (socketPath: string): Promise<CaptureSocketClient> => {
    state.connects += 1;
    void socketPath;
    return {
      send: async (line: string) => {
        sent.push(line);
      },
      receive: async () => {
        if (script.ackError) throw script.ackError;
        return JSON.stringify('ack' in script ? script.ack : buildCaptureAck());
      },
      close: () => {
        state.closes += 1;
      },
    };
  };
  return { connect, sent, state };
}

describe('runSlackAuthCaptureHelper', () => {
  const env = { SLACK_CLI_XOXB: BOT_TOKEN, SLACK_CLI_XAPP: APP_TOKEN };

  it('sends exactly one NDJSON frame carrying both tokens', async () => {
    const conn = fakeConnector();
    await runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env, connect: conn.connect });

    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].endsWith('\n')).toBe(true);
    expect(conn.sent[0].slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(conn.sent[0])).toEqual({
      version: CAPTURE_FRAME_VERSION,
      nonce: NONCE,
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
    });
  });

  it('omits appId and teamId, which the hook contract does not guarantee', async () => {
    const conn = fakeConnector();
    await runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env, connect: conn.connect });
    expect(Object.keys(JSON.parse(conn.sent[0])).sort()).toEqual(['appToken', 'botToken', 'nonce', 'version']);
  });

  it('refuses to speak at all without a well-formed challenge', async () => {
    const conn = fakeConnector();
    for (const bad of [undefined, '', 'short', NONCE.toUpperCase()]) {
      await expect(
        runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: bad as string, env, connect: conn.connect }),
      ).rejects.toBeInstanceOf(SlackCaptureOptionsError);
    }
    // Nothing was dialled and no token left the process.
    expect(conn.sent).toHaveLength(0);
  });

  it('bounds the frame well under the socket frame cap', async () => {
    const conn = fakeConnector();
    await runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env, connect: conn.connect });
    expect(Buffer.byteLength(conn.sent[0], 'utf-8')).toBeLessThan(MAX_SOCKET_FRAME_BYTES);
  });

  it('closes the connection on success', async () => {
    const conn = fakeConnector();
    await runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env, connect: conn.connect });
    expect(conn.state.closes).toBe(1);
  });

  it('closes the connection when the ACK never comes', async () => {
    const conn = fakeConnector({ ackError: new SocketTimeoutError('no ack') });
    await expect(
      runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env, connect: conn.connect }),
    ).rejects.toThrow(SlackCaptureProtocolError);
    expect(conn.state.closes).toBe(1);
  });

  it.each([
    ['ok is false', { version: 1, ok: false }],
    ['the version is wrong', { version: 2, ok: true }],
    ['the body is not an object', 'ok'],
    ['ok is missing', { version: 1 }],
    ['it is null', null],
  ])('rejects an ACK where %s', async (_label, ack) => {
    const conn = fakeConnector({ ack });
    await expect(
      runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env, connect: conn.connect }),
    ).rejects.toThrow(SlackCaptureProtocolError);
  });

  it('rejects an unparseable ACK', async () => {
    const connect = async (): Promise<CaptureSocketClient> => ({
      send: async () => {},
      receive: async () => 'not json',
      close: () => {},
    });
    await expect(runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env, connect })).rejects.toThrow(
      SlackCaptureProtocolError,
    );
  });

  it('surfaces a server disconnect rather than exiting successfully', async () => {
    const conn = fakeConnector({ ackError: new SocketFrameError('client disconnected') });
    await expect(
      runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env, connect: conn.connect }),
    ).rejects.toThrow(SlackCaptureProtocolError);
  });

  it('never opens the socket when the env is invalid', async () => {
    const conn = fakeConnector();
    await expect(
      runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env: {}, connect: conn.connect }),
    ).rejects.toThrow(SlackCaptureEnvError);
    expect(conn.sent).toHaveLength(0);
    expect(conn.state.connects).toBe(0);
  });

  it('writes nothing to stdout, stderr or the console', async () => {
    const conn = fakeConnector();
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    try {
      await runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env, connect: conn.connect });
      await runSlackAuthCaptureHelper({ socketPath: SOCKET_PATH, nonce: NONCE, env: {}, connect: conn.connect }).catch(
        () => {},
      );
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Parent: the slack run child
// ---------------------------------------------------------------------------

describe('captureSlackRuntimeTokens', () => {
  it('runs slack run in the persistent project with a killable process group', async () => {
    const host = primedHost();
    await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()));

    const spawns = spawnCalls(host);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].command).toBe(SLACK_BIN);
    expect(spawns[0].args).toEqual(['run', '--team', TEAM_ID, '--app', APP_ID, '--no-color', '--skip-update']);
    expect(spawns[0].cwd).toBe(PROJECT_ROOT);
    expect(spawns[0].processGroup).toBe(true);
    expect(spawns[0].inheritEnv).toBe(true);
  });

  it('omits the --app selector on a first run with no recorded app', async () => {
    const host = primedHost();
    await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder(), { project: project() }));
    expect(spawnCalls(host)[0].args).toEqual(['run', '--team', TEAM_ID, '--no-color', '--skip-update']);
  });

  it('reuses the recorded app id on resume, so no duplicate app is created', async () => {
    const host = primedHost();
    const result = await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()));
    expect(spawnCalls(host)[0].args).toContain('--app');
    expect(result.appId).toBe(APP_ID);
  });

  it('starts listening before spawning, so a fast hook cannot race', async () => {
    const host = primedHost();
    await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()));
    const kinds = host.unsafeRawCalls().map((call) => call.kind);
    expect(kinds.indexOf('listenUnixSocket')).toBeLessThan(kinds.indexOf('spawn'));
  });

  it('listens at mode 0600', async () => {
    const host = primedHost();
    await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()));
    expect(host.unsafeRawCalls().find((call) => call.kind === 'listenUnixSocket')).toMatchObject({
      path: SOCKET_PATH,
      mode: 0o600,
    });
  });

  it('streams redacted child output to the progress sink without parsing it', async () => {
    const host = primedHost();
    const progress: string[] = [];
    await captureSlackRuntimeTokens(
      host,
      SOCKET_PATH,
      baseOptions(recorder(), {
        onProgress: (chunk) => {
          progress.push(chunk);
        },
      }),
    );
    expect(progress.join('')).toContain('Connected, awaiting events');
  });

  it('persists both tokens before it acknowledges the helper', async () => {
    const host = primedHost();
    const events: string[] = [];
    const spy = spySocket(host, { events });
    const rec = recorder(events);

    await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec));

    expect(events).toEqual(['persist', 'ack']);
    expect(rec.persisted).toEqual([{ SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN }]);
    expect(spy.replies).toEqual([buildCaptureAck()]);
  });

  it('never writes a signing secret', async () => {
    const host = primedHost();
    const rec = recorder();
    await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec));
    expect(Object.keys(rec.persisted[0]).sort()).toEqual(['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN']);
  });

  it('does not acknowledge when the secret write throws', async () => {
    const host = primedHost();
    const spy = spySocket(host);
    await expect(
      captureSlackRuntimeTokens(
        host,
        SOCKET_PATH,
        baseOptions(recorder(), {
          persist: () => {
            throw new Error('no space left on device');
          },
        }),
      ),
    ).rejects.toThrow(SlackCapturePersistError);
    expect(spy.replies).toHaveLength(0);
    expect(spy.closes).toBe(1);
  });

  it('terminates the child once and waits for it to exit', async () => {
    const host = primedHost();
    await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()));
    const kills = host.unsafeRawCalls().filter((call) => call.kind === 'kill');
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ command: SLACK_BIN, signal: 'SIGTERM' });
  });

  it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const host = primedHost();
    const signals = stubbornChild(host);
    await captureSlackRuntimeTokens(
      host,
      SOCKET_PATH,
      baseOptions(recorder(), { terminateGraceMs: 200, terminatePollMs: 100 }),
    );
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('spawns slack run exactly once — never an automatic retry', async () => {
    const host = primedHost([]);
    await expect(captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()))).rejects.toThrow(
      SlackCaptureTimeoutError,
    );
    expect(spawnCalls(host)).toHaveLength(1);
  });

  it('refuses when the socket path disagrees with the project', async () => {
    const host = primedHost();
    await expect(captureSlackRuntimeTokens(host, '/tmp/other.sock', baseOptions(recorder()))).rejects.toThrow(
      SlackCaptureOptionsError,
    );
    expect(host.unsafeRawCalls()).toHaveLength(0);
  });

  it.each([
    ['captureTimeoutMs', 0],
    ['captureTimeoutMs', -1],
    ['terminateGraceMs', 1.5],
  ])('refuses a non-positive %s of %s before any side effect', async (key, value) => {
    const host = primedHost();
    const options = baseOptions(recorder(), { [key]: value } as Partial<SlackCaptureOptions>);
    await expect(captureSlackRuntimeTokens(host, SOCKET_PATH, options)).rejects.toThrow(SlackCaptureOptionsError);
    expect(host.unsafeRawCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Parent: failure paths
// ---------------------------------------------------------------------------

describe('capture failure paths', () => {
  it('times out, kills the child and persists nothing', async () => {
    const host = primedHost([]);
    const rec = recorder();
    await expect(captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec))).rejects.toThrow(
      SlackCaptureTimeoutError,
    );
    expect(rec.persisted).toHaveLength(0);
    expect(host.unsafeRawCalls().some((call) => call.kind === 'kill')).toBe(true);
  });

  it('does nothing at all when the signal is already aborted', async () => {
    const host = primedHost();
    const controller = new AbortController();
    controller.abort();
    await expect(
      captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder(), { signal: controller.signal })),
    ).rejects.toThrow(SlackCaptureCancelledError);
    expect(host.unsafeRawCalls()).toHaveLength(0);
  });

  it('reports a cancelled receive as cancellation, not as a timeout', async () => {
    const host = primedHost();
    const spy = spySocket(host, { failReceiveWith: new SocketAbortedError('receive aborted') });
    const rec = recorder();
    await expect(captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec))).rejects.toThrow(
      SlackCaptureCancelledError,
    );
    expect(rec.persisted).toHaveLength(0);
    expect(spy.closes).toBe(1);
  });

  // Frames that DO authenticate (they carry this run's challenge) but violate
  // the protocol. An unauthenticated frame is a different outcome entirely —
  // it is dropped rather than reported; see the I-1 block below.
  it.each([
    ['a wrong version', { version: 2, nonce: NONCE, botToken: BOT_TOKEN, appToken: APP_TOKEN }],
    ['a missing bot token', { version: 1, nonce: NONCE, appToken: APP_TOKEN }],
    ['a bad bot prefix', { version: 1, nonce: NONCE, botToken: `xoxp-${'a'.repeat(30)}`, appToken: APP_TOKEN }],
    ['a bad app prefix', { version: 1, nonce: NONCE, botToken: BOT_TOKEN, appToken: `xoxb-${'a'.repeat(30)}` }],
    ['an unknown field', { version: 1, nonce: NONCE, botToken: BOT_TOKEN, appToken: APP_TOKEN, signingSecret: 'x' }],
    [
      'a mismatched team id',
      { version: 1, nonce: NONCE, botToken: BOT_TOKEN, appToken: APP_TOKEN, teamId: 'T0999XYZ1' },
    ],
    [
      'a mismatched app id',
      { version: 1, nonce: NONCE, botToken: BOT_TOKEN, appToken: APP_TOKEN, appId: 'A0DIFFERENT' },
    ],
  ])('rejects %s and persists nothing', async (_label, bad) => {
    const host = primedHost([bad]);
    const rec = recorder();
    await expect(captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec))).rejects.toThrow(
      SlackCaptureProtocolError,
    );
    expect(rec.persisted).toHaveLength(0);
  });

  it('accepts a frame whose optional ids agree with the authoritative values', async () => {
    const host = primedHost([frame({ teamId: TEAM_ID, appId: APP_ID })]);
    await expect(captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()))).resolves.toMatchObject({
      appId: APP_ID,
      teamId: TEAM_ID,
    });
  });

  it('reports an early child exit instead of waiting out the capture timeout', async () => {
    const host = new FakeHost()
      .stubSpawn(SLACK_BIN, { code: 1, stderr: 'app install failed\n' })
      .stubUnixSocket(SOCKET_PATH, { frames: [] });
    const rec = recorder();
    await expect(captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec))).rejects.toThrow(
      SlackCaptureChildError,
    );
    expect(rec.persisted).toHaveLength(0);
  });

  it('keeps the persisted tokens when the ACK itself fails', async () => {
    const host = primedHost();
    spySocket(host, { failReply: true });
    const rec = recorder();
    await expect(captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec))).rejects.toThrow(SlackCaptureError);
    expect(rec.persisted).toHaveLength(1);
  });

  it('still closes the socket when terminating the child throws', async () => {
    // M-1: cleanup used to run sequentially, so a throwing kill skipped
    // close() — leaking a listening fd that keeps the event loop alive forever.
    const host = primedHost();
    const spy = spySocket(host);
    unkillableChild(host);
    const rec = recorder();

    const result = await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec, { terminateGraceMs: 100 }));

    expect(spy.closes).toBe(1);
    expect(rec.persisted).toHaveLength(1);
    // A capture whose tokens are already durable must not be reported as failed
    // just because a process could not be reaped.
    expect(result.appId).toBe(APP_ID);
  });

  it('preserves the original failure when cleanup also fails', async () => {
    const host = primedHost([]);
    const spy = spySocket(host);
    unkillableChild(host);

    await expect(
      captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder(), { terminateGraceMs: 100 })),
    ).rejects.toThrow(SlackCaptureTimeoutError);
    expect(spy.closes).toBe(1);
  });

  it('closes the socket exactly once on every path', async () => {
    for (const frames of [[frame()], [], [{ version: 9 }]]) {
      const host = primedHost(frames);
      const spy = spySocket(host);
      await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder())).catch(() => undefined);
      expect(spy.closes).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Parent: resume contract when the mapping has not materialized
// ---------------------------------------------------------------------------

describe('incomplete capture (no app mapping)', () => {
  it('persists the tokens, keeps the mapping, and reports resume without tokens', async () => {
    const host = primedHost();
    const rec = recorder();

    let caught: SlackCaptureIncompleteError | undefined;
    try {
      await captureSlackRuntimeTokens(
        host,
        SOCKET_PATH,
        baseOptions(rec, { project: project(), readMapping: () => null }),
      );
      expect.unreachable('a missing app mapping must be reported');
    } catch (err) {
      caught = err as SlackCaptureIncompleteError;
    }

    expect(caught).toBeInstanceOf(SlackCaptureIncompleteError);
    expect(caught?.teamId).toBe(TEAM_ID);
    expect(caught?.resume).toBe(true);
    expect(rec.persisted).toHaveLength(1);

    const serialized = JSON.stringify(caught?.toJSON());
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain(APP_TOKEN);
    expect(serialized).toContain(TEAM_ID);
  });
});

// ---------------------------------------------------------------------------
// The Task 10 entry point
// ---------------------------------------------------------------------------

describe('captureAndPersistSlackRuntimeTokens', () => {
  it('writes through the secret store and returns non-secret ids only', async () => {
    const host = primedHost();
    const written: Array<Record<string, string>> = [];
    const result = await captureAndPersistSlackRuntimeTokens(host, {
      project: project({ appMapping: MAPPING }),
      slackBin: SLACK_BIN,
      readMapping: () => MAPPING,
      secretStore: {
        write: (values) => {
          written.push({ ...values });
        },
      },
    });

    expect(written).toEqual([{ SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN }]);
    expect(result).toEqual({ appId: APP_ID, teamId: TEAM_ID, profile: 'preview' });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(result)).not.toContain(APP_TOKEN);
  });

  it('returns a receipt the state gate accepts whole', async () => {
    // I-2: the recommended call must not hand Task 10 a value the recommended
    // next step rejects. The entire receipt clears assertSecretFree, so
    // spreading it into a state candidate is safe.
    const host = primedHost();
    const receipt = await captureAndPersistSlackRuntimeTokens(host, {
      project: project({ appMapping: MAPPING }),
      slackBin: SLACK_BIN,
      readMapping: () => MAPPING,
      secretStore: { write: () => {} },
    });

    expect(() => assertSecretFree(receipt)).not.toThrow();
    expect(receipt).not.toHaveProperty('secretsFile');
    const candidate = { ...createDefaultSetupState('preview'), ...receipt, slackAppId: receipt.appId };
    expect(() => assertSecretFree(candidate)).not.toThrow();
  });

  it.each([
    ['no options', undefined],
    ['no secret store', { project: project(), slackBin: SLACK_BIN }],
    ['no project', { slackBin: SLACK_BIN, secretStore: { write: () => {} } }],
  ])('refuses %s with a typed error, never a TypeError', async (_label, options) => {
    // M-4: `rest.project.socketPath` used to be dereferenced before validation.
    const host = primedHost();
    await expect(captureAndPersistSlackRuntimeTokens(host, options as never)).rejects.toThrow(SlackCaptureOptionsError);
  });

  it('produces ids that setup state accepts', async () => {
    const host = primedHost();
    const result = await captureAndPersistSlackRuntimeTokens(host, {
      project: project({ appMapping: MAPPING }),
      slackBin: SLACK_BIN,
      readMapping: () => MAPPING,
      secretStore: { write: () => {} },
    });

    const state = { ...createDefaultSetupState('preview'), slackAppId: result.appId, slackTeamId: result.teamId };
    expect(() => assertSecretFree(state)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// I-1 — adversarial input must never reach an error message
// ---------------------------------------------------------------------------

describe('error safety against a hostile peer', () => {
  const LEAKS = ['SENTINELVERSIONLEAK', 'SENTINELFIELDLEAK', 'SENTINELPERSISTLEAK'];

  function expectNoLeak(err: unknown): void {
    const message = (err as Error).message;
    const json = JSON.stringify((err as { toJSON?: () => unknown }).toJSON?.() ?? {});
    for (const leak of LEAKS) {
      expect(message).not.toContain(leak);
      expect(json).not.toContain(leak);
    }
    expect(message).not.toContain(BOT_TOKEN);
    expect(json).not.toContain(BOT_TOKEN);
  }

  it('never echoes a credential-shaped protocol version', async () => {
    // A version-skewed peer (an old somawork-preview binary dialing this
    // profile's socket) putting a token where an integer belongs must not get
    // it printed back on the terminal.
    const host = primedHost([
      {
        version: `${BOT_TOKEN_PREFIX}SENTINELVERSIONLEAK-0001`,
        nonce: NONCE,
        botToken: BOT_TOKEN,
        appToken: APP_TOKEN,
      },
    ]);
    try {
      await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()));
      expect.unreachable('a foreign protocol version must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(SlackCaptureProtocolError);
      expectNoLeak(err);
    }
  });

  it('never echoes a credential-shaped unknown field name', async () => {
    const host = primedHost([
      {
        version: 1,
        nonce: NONCE,
        botToken: BOT_TOKEN,
        appToken: APP_TOKEN,
        [`${BOT_TOKEN_PREFIX}SENTINELFIELDLEAK`]: 1,
      },
    ]);
    try {
      await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()));
      expect.unreachable('an unknown frame field must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(SlackCaptureProtocolError);
      expectNoLeak(err);
    }
  });

  it('never echoes a persist callback error message', async () => {
    // `persist` is caller-supplied. A Task 10 wrapper that stringifies its
    // payload into its own error text must not put that text on the terminal.
    const host = primedHost();
    try {
      await captureSlackRuntimeTokens(
        host,
        SOCKET_PATH,
        baseOptions(recorder(), {
          persist: () => {
            throw new Error(`failed writing ${BOT_TOKEN} / SENTINELPERSISTLEAK`);
          },
        }),
      );
      expect.unreachable('a failing persist must be reported');
    } catch (err) {
      expect(err).toBeInstanceOf(SlackCapturePersistError);
      expectNoLeak(err);
    }
  });

  it('bounds a hostile error name rather than repeating it', async () => {
    const host = primedHost();
    const hostile = new Error('nope');
    hostile.name = `${BOT_TOKEN_PREFIX}SENTINELPERSISTLEAK-name`;
    try {
      await captureSlackRuntimeTokens(
        host,
        SOCKET_PATH,
        baseOptions(recorder(), {
          persist: () => {
            throw hostile;
          },
        }),
      );
      expect.unreachable('a failing persist must be reported');
    } catch (err) {
      expectNoLeak(err);
      expect((err as Error).message).toContain('Error');
    }
  });

  it('keeps every error toJSON a value-free projection', async () => {
    const cases: Array<readonly unknown[]> = [
      [],
      [{ version: 2, botToken: BOT_TOKEN, appToken: APP_TOKEN }],
      [{ version: 1, botToken: BOT_TOKEN, appToken: 'xoxp-not-an-app-token-000000' }],
    ];
    for (const frames of cases) {
      const host = primedHost(frames);
      try {
        await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()));
      } catch (err) {
        const json = (err as { toJSON: () => { name: string; summary: string } }).toJSON();
        expect(typeof json.name).toBe('string');
        expect(typeof json.summary).toBe('string');
        expect(() => assertSecretFree(json)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// I-3 — a throwing progress renderer must not take the capture down
// ---------------------------------------------------------------------------

describe('progress is best-effort', () => {
  it('completes the capture when the renderer throws on every chunk', async () => {
    const host = primedHost();
    const events: string[] = [];
    const spy = spySocket(host, { events });
    const rec = recorder(events);

    const result = await captureSlackRuntimeTokens(
      host,
      SOCKET_PATH,
      baseOptions(rec, {
        onProgress: () => {
          throw new Error('EPIPE: the terminal went away');
        },
      }),
    );

    // Everything downstream of the renderer still happened.
    expect(events).toEqual(['persist', 'ack']);
    expect(rec.persisted).toHaveLength(1);
    expect(spy.replies).toHaveLength(1);
    expect(spy.closes).toBe(1);
    expect(host.unsafeRawCalls().some((call) => call.kind === 'kill')).toBe(true);
    expect(result.appId).toBe(APP_ID);
  });

  it('swallows a rejected promise from an async renderer', async () => {
    const host = primedHost();
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await captureSlackRuntimeTokens(
        host,
        SOCKET_PATH,
        baseOptions(recorder(), { onProgress: async () => Promise.reject(new Error('render failed')) }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// The default mapping reader (M-10)
// ---------------------------------------------------------------------------

describe('default readMapping', () => {
  it('reads the real project mapping off disk when none is injected', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swcap-'));
    try {
      const root = path.join(tmp, 'slack-project');
      fs.mkdirSync(path.join(root, '.slack'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(root, '.slack', 'apps.dev.json'),
        JSON.stringify({ [TEAM_ID]: { app_id: APP_ID, team_id: TEAM_ID, team_domain: 'acme' } }),
        { mode: 0o600 },
      );

      const host = primedHost();
      // No `readMapping`: the production default must find the app on disk.
      const result = await captureSlackRuntimeTokens(host, SOCKET_PATH, {
        project: project({ root }),
        slackBin: SLACK_BIN,
        persist: recorder().persist,
      });
      expect(result.appId).toBe(APP_ID);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports resume when the real project has no mapping on disk', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swcap-'));
    try {
      const host = primedHost();
      await expect(
        captureSlackRuntimeTokens(host, SOCKET_PATH, {
          project: project({ root: path.join(tmp, 'slack-project') }),
          slackBin: SLACK_BIN,
          persist: recorder().persist,
        }),
      ).rejects.toBeInstanceOf(SlackCaptureIncompleteError);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// M-2 — the production Unix client, against a real socket
// ---------------------------------------------------------------------------

describe('the real Unix transport', () => {
  interface Harness {
    socketPath: string;
    received: string[];
    disconnects: number;
    close: () => Promise<void>;
  }

  async function realServer(onFrame: (line: string, socket: net.Socket) => void): Promise<Harness> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swsock-'));
    const socketPath = path.join(dir, 'c.sock');
    const received: string[] = [];
    const state = { disconnects: 0 };

    const server = net.createServer((socket) => {
      let buffered = '';
      socket.setEncoding('utf-8');
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          received.push(line);
          onFrame(line, socket);
          newline = buffered.indexOf('\n');
        }
      });
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        state.disconnects += 1;
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    return {
      socketPath,
      received,
      get disconnects() {
        return state.disconnects;
      },
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            fs.rmSync(dir, { recursive: true, force: true });
            resolve();
          });
        }),
    } as Harness;
  }

  const env = { SLACK_CLI_XOXB: BOT_TOKEN, SLACK_CLI_XAPP: APP_TOKEN };

  it('completes a real round trip and hangs up afterwards', async () => {
    const harness = await realServer((_line, socket) => {
      socket.write(`${JSON.stringify(buildCaptureAck())}\n`);
    });
    try {
      // No `connect` override: this exercises the production net client.
      await runSlackAuthCaptureHelper({ socketPath: harness.socketPath, nonce: NONCE, env });
      expect(harness.received).toHaveLength(1);
      expect(JSON.parse(harness.received[0])).toEqual({
        version: CAPTURE_FRAME_VERSION,
        nonce: NONCE,
        botToken: BOT_TOKEN,
        appToken: APP_TOKEN,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.disconnects).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('accepts an ACK that arrives before the helper starts reading', async () => {
    // The parent may reply within the same tick as the frame; the client
    // buffers continuously, so the ACK must not be lost.
    const harness = await realServer((_line, socket) => {
      socket.write(`${JSON.stringify(buildCaptureAck())}\n`);
      socket.write('');
    });
    try {
      await expect(
        runSlackAuthCaptureHelper({ socketPath: harness.socketPath, nonce: NONCE, env }),
      ).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('reassembles an ACK split mid-UTF-8 across two writes', async () => {
    const ack = `${JSON.stringify({ ...buildCaptureAck(), note: 'café ☕' })}\n`;
    const bytes = Buffer.from(ack, 'utf-8');
    // Split inside the multi-byte "é" so a naive per-chunk decode would corrupt.
    const cut = bytes.indexOf(Buffer.from('é', 'utf-8')[0]) + 1;
    const harness = await realServer((_line, socket) => {
      socket.write(bytes.subarray(0, cut));
      setTimeout(() => socket.write(bytes.subarray(cut)), 5);
    });
    try {
      await expect(
        runSlackAuthCaptureHelper({ socketPath: harness.socketPath, nonce: NONCE, env }),
      ).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('fails loudly when the parent hangs up without answering', async () => {
    const harness = await realServer((_line, socket) => socket.destroy());
    try {
      await expect(runSlackAuthCaptureHelper({ socketPath: harness.socketPath, nonce: NONCE, env })).rejects.toThrow(
        SlackCaptureProtocolError,
      );
    } finally {
      await harness.close();
    }
  });

  it('times out rather than waiting forever for a silent parent', async () => {
    const harness = await realServer(() => {});
    try {
      await expect(
        runSlackAuthCaptureHelper({ socketPath: harness.socketPath, nonce: NONCE, env, ackTimeoutMs: 60 }),
      ).rejects.toThrow(SlackCaptureProtocolError);
    } finally {
      await harness.close();
    }
  });

  it('refuses an oversized ACK instead of buffering it', async () => {
    // M-3: the child side used to accumulate whatever the peer sent.
    const harness = await realServer((_line, socket) => {
      socket.write(`{"version":1,"ok":true,"pad":"${'x'.repeat(MAX_SOCKET_FRAME_BYTES + 64)}"}\n`);
    });
    try {
      await expect(
        runSlackAuthCaptureHelper({ socketPath: harness.socketPath, nonce: NONCE, env, ackTimeoutMs: 500 }),
      ).rejects.toThrow(SlackCaptureProtocolError);
    } finally {
      await harness.close();
    }
  });

  it('refuses a second acknowledgement frame', async () => {
    const harness = await realServer((_line, socket) => {
      const ack = `${JSON.stringify(buildCaptureAck())}\n`;
      socket.write(ack + ack);
    });
    try {
      await expect(
        runSlackAuthCaptureHelper({ socketPath: harness.socketPath, nonce: NONCE, env, ackTimeoutMs: 500 }),
      ).rejects.toThrow(SlackCaptureProtocolError);
    } finally {
      await harness.close();
    }
  });

  it('fails loudly when nothing is listening', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swsock-'));
    try {
      await expect(
        runSlackAuthCaptureHelper({
          socketPath: path.join(dir, 'absent.sock'),
          nonce: NONCE,
          env,
          connectTimeoutMs: 200,
        }),
      ).rejects.toThrow(SlackCaptureProtocolError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Sentinel scan — the whole point of the module
// ---------------------------------------------------------------------------

describe('token carriers', () => {
  const SENTINELS = [BOT_TOKEN, APP_TOKEN, 'SENTINELBOTVALUE0001', 'SENTINELAPPVALUE0001'];

  function expectClean(label: string, value: unknown): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const sentinel of SENTINELS) {
      expect(`${label}: ${text ?? ''}`).not.toContain(sentinel);
    }
  }

  it('keeps tokens out of every host surface on the success path', async () => {
    const host = primedHost();
    const progress: string[] = [];
    const rec = recorder();
    const result = await captureSlackRuntimeTokens(
      host,
      SOCKET_PATH,
      baseOptions(rec, {
        onProgress: (chunk) => {
          progress.push(chunk);
        },
      }),
    );

    expectClean('redacted calls', host.calls);
    // Stronger than redaction: nothing ever put a token in argv or child env.
    expectClean('raw calls', host.unsafeRawCalls());
    expectClean('progress', progress.join(''));

    // The documented in-memory carriers, and only those.
    expect(result.botToken).toBe(BOT_TOKEN);
    expect(result.appToken).toBe(APP_TOKEN);
    expect(rec.persisted[0].SLACK_BOT_TOKEN).toBe(BOT_TOKEN);
  });

  it('keeps tokens out of errors and call records on every failure path', async () => {
    const cases: Array<readonly unknown[]> = [
      [],
      [{ version: 1, botToken: BOT_TOKEN, appToken: 'xoxb-wrong-kind-of-token-000000' }],
      [{ version: 9, botToken: BOT_TOKEN, appToken: APP_TOKEN }],
    ];

    for (const frames of cases) {
      const host = primedHost(frames);
      try {
        await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder()));
      } catch (err) {
        expectClean('error message', (err as Error).message);
        expectClean('error json', (err as { toJSON?: () => unknown }).toJSON?.() ?? {});
      }
      expectClean('calls', host.calls);
      expectClean('raw calls', host.unsafeRawCalls());
    }
  });

  it('is honest about where a raw token does live', () => {
    // Enumerated deliberately: the helper's env input, the single socket frame,
    // and the SecretStore write. FakeHost's scripted frames carry the sentinel
    // because they stand in for the helper's write; nothing else may.
    const source = fs.readFileSync(path.join(__dirname, '..', 'slack-capture.ts'), 'utf-8');
    expect(source).not.toMatch(/sensitiveValues/); // no argv exception is needed here
    expect(source).not.toMatch(/console\.(log|warn|error|info|debug|trace)/);
    expect(source).not.toMatch(/process\.stdout|process\.stderr/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/openUrl|copyToClipboard/);
    expect(source).not.toMatch(/\bwriteFileSync\(|atomicWrite/); // persistence is injected
  });
});

// ---------------------------------------------------------------------------
// I-1 — the capture socket authenticates its peer
// ---------------------------------------------------------------------------

describe('capture peer authentication', () => {
  /** What an attacker sends: real-shaped tokens, someone else's workspace. */
  const ATTACKER_BOT = `${BOT_TOKEN_PREFIX}9999999999-8888888888-ATTACKERBOTVALUE0001`;
  const ATTACKER_APP = `${APP_TOKEN_PREFIX}1-A0ATTACKER-7777777777-ATTACKERAPPVALUE0001`;
  const attackerFrame = (over: Record<string, unknown> = {}) => ({
    version: CAPTURE_FRAME_VERSION,
    botToken: ATTACKER_BOT,
    appToken: ATTACKER_APP,
    ...over,
  });

  it("accepts the frame that echoes this run's challenge", async () => {
    const host = primedHost([frame()]);
    const rec = recorder();

    const auth = await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec));

    expect(auth.botToken).toBe(BOT_TOKEN);
    expect(rec.persisted).toEqual([{ SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN }]);
  });

  it.each([
    ['no nonce at all', attackerFrame()],
    ['a wrong nonce', attackerFrame({ nonce: WRONG_NONCE })],
    ['a nonce of the wrong shape', attackerFrame({ nonce: 'not-hex' })],
    ['a non-string nonce', attackerFrame({ nonce: 42 })],
    ['a nonce that is a prefix of the real one', attackerFrame({ nonce: NONCE.slice(0, -1) })],
    ['an uppercased nonce', attackerFrame({ nonce: NONCE.toUpperCase() })],
    ['a non-object body', 'nope'],
  ])('persists nothing and ACKs nothing for a frame with %s', async (_label, hostile) => {
    const host = primedHost([hostile]);
    const spy = spySocket(host);
    const rec = recorder();

    // Nothing authenticates, so the capture can only ever time out. That is the
    // correct outcome: the real helper never showed up.
    await expect(captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec))).rejects.toBeInstanceOf(
      SlackCaptureTimeoutError,
    );

    expect(rec.persisted).toHaveLength(0);
    expect(spy.replies).toHaveLength(0);
    expect(rec.events).not.toContain('persist');
    expect(rec.events).not.toContain('ack');
  });

  it('serves the legitimate helper even when a hostile peer got there first', async () => {
    // The demonstrated I-1 scenario, in order: attacker frame queued ahead of
    // the helper's. First-frame-wins used to make this an attacker takeover.
    const host = primedHost([attackerFrame(), attackerFrame({ nonce: WRONG_NONCE }), frame()]);
    const rec = recorder();

    const auth = await captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(rec));

    expect(auth.botToken).toBe(BOT_TOKEN);
    expect(auth.appToken).toBe(APP_TOKEN);
    expect(rec.persisted).toEqual([{ SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN }]);
    // Nothing of the attacker's was persisted, echoed, or acknowledged.
    for (const sentinel of [ATTACKER_BOT, ATTACKER_APP]) {
      expect(JSON.stringify(rec.persisted)).not.toContain(sentinel);
      expect(JSON.stringify(host.calls)).not.toContain(sentinel);
      expect(JSON.stringify(host.unsafeRawCalls())).not.toContain(sentinel);
    }
  });

  it('refuses to listen at all when the project carries no usable challenge', async () => {
    for (const captureNonce of ['', 'short', NONCE.toUpperCase(), undefined as unknown as string]) {
      const host = primedHost();
      await expect(
        captureSlackRuntimeTokens(host, SOCKET_PATH, baseOptions(recorder(), { project: project({ captureNonce }) })),
      ).rejects.toBeInstanceOf(SlackCaptureOptionsError);
      // Refused before anything on the machine moved.
      expect(host.unsafeRawCalls()).toHaveLength(0);
    }
  });

  it('keeps the challenge out of the receipt, the state, the errors and the logs', async () => {
    const host = primedHost();
    const progress: string[] = [];
    const rec = recorder();

    const receipt = await captureAndPersistSlackRuntimeTokens(host, {
      project: project({ appMapping: MAPPING }),
      slackBin: SLACK_BIN,
      secretStore: { write: rec.persist },
      readMapping: () => MAPPING,
      onProgress: (chunk) => {
        progress.push(chunk);
      },
    });

    const surfaces: Array<[string, unknown]> = [
      ['receipt', receipt],
      ['persisted secrets', rec.persisted],
      ['progress', progress],
      ['redacted calls', host.calls],
      ['raw calls', host.unsafeRawCalls()],
      ['setup state', { ...createDefaultSetupState('preview'), slackAppId: receipt.appId }],
    ];
    for (const [label, value] of surfaces) {
      expect(`${label}: ${JSON.stringify(value)}`).not.toContain(NONCE);
    }
    // …and it is not smuggled through the error path either.
    const failing = primedHost([attackerFrame()]);
    const error = await captureSlackRuntimeTokens(failing, SOCKET_PATH, baseOptions(recorder())).catch((e) => e);
    expect(
      `${(error as Error).message}|${JSON.stringify((error as { toJSON: () => unknown }).toJSON())}`,
    ).not.toContain(NONCE);
  });

  it('mints a challenge that is never reused between runs', () => {
    // The generator is `slack-manifest`'s, and materialization is per setup
    // run — so "one-time" is a property of where it is minted, pinned here.
    expect(generateCaptureNonce()).not.toBe(generateCaptureNonce());
  });
});
