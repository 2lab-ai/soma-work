/**
 * Fix round 1 regressions for the setup host boundary.
 *
 * Every test here fails against 6a7ae7a and passes after the fix. They cover
 * the paths the first round's tests never reached: chunk boundaries, stdin
 * back-pressure, post-bind failure, symlinked ancestors, fake/real cancel
 * parity, spawn-flag observability, real process-group kill, and no-echo
 * secret input.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeHost, FakeHostUnexpectedCallError } from '../fake-host';
import { SecretPromptError, SocketAbortedError, UnsafePathError } from '../host';
import { RealHost } from '../real-host';

const SENTINEL_BOT_TOKEN = 'xoxb-1-2-SENTINELaaaabbbb';
const REPLACEMENT_CHAR = '�';
const CTRL_C = '';
const BACKSPACE = '';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-hardening-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// I-1 / M-3 — stream-safe redaction across chunk boundaries
// ---------------------------------------------------------------------------

describe('I-1 spawn() redaction is stream-safe', () => {
  // The fixture writes in separate write(2) calls with a pause between them, so
  // the credential and a multi-byte Korean character each straddle two `data`
  // events — exactly what a 64 KiB pipe read boundary does in production.
  const SPLIT_FIXTURE = [
    "printf 'xoxb-1-2-SENTIN'",
    'sleep 0.2',
    "printf 'ELaaaabbbb han='",
    // 한 = U+D55C = ED 95 9C, split after the second byte.
    "printf '\\355\\225'",
    'sleep 0.2',
    "printf '\\234\\n'",
  ].join('; ');

  it('never emits a credential tail when the token is split across two chunks', async () => {
    const host = new RealHost();
    const handle = host.spawn({ command: '/bin/sh', args: ['-c', SPLIT_FIXTURE] });
    const chunks: string[] = [];
    handle.onStdout((c) => chunks.push(c));
    await handle.exited;
    await settle(50);

    const joined = chunks.join('');
    expect(joined).not.toContain('SENTINELaaaabbbb');
    expect(joined).not.toContain('ELaaaabbbb');
    expect(joined).toContain('[REDACTED xoxb-...bbbb]');
  });

  it('does not corrupt a UTF-8 character split across two chunks', async () => {
    const host = new RealHost();
    const handle = host.spawn({ command: '/bin/sh', args: ['-c', SPLIT_FIXTURE] });
    const chunks: string[] = [];
    handle.onStdout((c) => chunks.push(c));
    await handle.exited;
    await settle(50);

    const joined = chunks.join('');
    expect(joined).toContain('han=한');
    expect(joined).not.toContain(REPLACEMENT_CHAR);
  });

  it('flushes an unterminated trailing line, redacted, when the child closes', async () => {
    const host = new RealHost();
    // No trailing newline: the remainder must still reach the listener.
    const handle = host.spawn({ command: '/bin/sh', args: ['-c', `printf 'tail ${SENTINEL_BOT_TOKEN}'`] });
    const chunks: string[] = [];
    handle.onStdout((c) => chunks.push(c));
    await handle.exited;
    await settle(50);

    const joined = chunks.join('');
    expect(joined).toContain('tail [REDACTED xoxb-...bbbb]');
    expect(joined).not.toContain('SENTINELaaaabbbb');
  });

  it('keeps command() stdout intact for a UTF-8 character split across chunks', async () => {
    const host = new RealHost();
    const result = await host.command({ command: '/bin/sh', args: ['-c', SPLIT_FIXTURE] });
    expect(result.unsafeRawStdout()).toContain('han=한');
    expect(result.unsafeRawStdout()).not.toContain(REPLACEMENT_CHAR);
  });
});

// ---------------------------------------------------------------------------
// I-2 / M-1 — stdin error handling
// ---------------------------------------------------------------------------

describe('I-2 stdin failures are data, not uncaught exceptions', () => {
  it('survives a child that exits before draining an oversized stdin', async () => {
    const host = new RealHost();
    const result = await host.command({
      command: '/usr/bin/head',
      args: ['-c', '1'],
      stdin: 'x'.repeat(1024 * 1024),
    });
    expect(result.code).toBe(0);
    await settle(50); // an uncaught EPIPE would surface here
  });

  it('reports a timeout (not a crash) when the child is killed mid-stdin-write', async () => {
    const host = new RealHost();
    const result = await host.command({
      command: '/bin/sleep',
      args: ['5'],
      stdin: 'y'.repeat(1024 * 1024),
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
    await settle(50);
  });

  it('does not mark a command that exited normally as timed out (close/timer race)', async () => {
    const host = new RealHost();
    for (let i = 0; i < 5; i++) {
      const result = await host.command({ command: '/bin/echo', args: ['fast'], timeoutMs: 1 });
      if (result.code === 0) expect(result.timedOut).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// I-3 — post-bind failure must not leak a listening server
// ---------------------------------------------------------------------------

describe('I-3 listen() cleans up when a post-bind step fails', () => {
  it('closes the server and unlinks the socket when chmod fails', async () => {
    const socketPath = path.join(tmpDir, 'chmod-fail.sock');
    const failing = new RealHost({
      socketChmod: async () => {
        throw new Error('simulated chmod failure');
      },
    });

    await expect(failing.listenUnixSocket(socketPath)).rejects.toThrow(/simulated chmod failure/);
    expect(fs.existsSync(socketPath)).toBe(false);

    // If the failed server were still listening, this bind would EADDRINUSE.
    const server = await new RealHost().listenUnixSocket(socketPath);
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// I-4 — ancestor symlink guard
// ---------------------------------------------------------------------------

describe('I-4 socket path is guarded along its whole ancestry', () => {
  it('refuses a symlinked ancestor and leaves the victim directory untouched', async () => {
    const victimParent = path.join(tmpDir, 'real');
    const victim = path.join(victimParent, 'victim');
    fs.mkdirSync(victim, { recursive: true });
    fs.chmodSync(victim, 0o755);

    const link = path.join(tmpDir, 'profile');
    fs.symlinkSync(victimParent, link);

    const socketPath = path.join(link, 'victim', 'capture.sock');
    const host = new RealHost();

    await expect(host.listenUnixSocket(socketPath)).rejects.toBeInstanceOf(UnsafePathError);
    expect(fs.statSync(victim).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I-5 — fake/real cancel parity
// ---------------------------------------------------------------------------

describe('I-5 FakeHost matches RealHost cancel semantics', () => {
  it('rejects an aborted socket receive with SocketAbortedError, like the real host', async () => {
    const host = new FakeHost();
    host.stubUnixSocket('/tmp/x.sock', { frames: [] });
    const server = await host.listenUnixSocket('/tmp/x.sock');

    await expect(
      server.receiveJson({ timeoutMs: 1000, validate: (v) => v, signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(SocketAbortedError);
  });

  it('short-circuits an already-aborted command without needing a stub', async () => {
    const host = new FakeHost();
    const result = await host.command({ command: 'slack', args: ['auth', 'login'], signal: AbortSignal.abort() });
    expect(result.aborted).toBe(true);
    expect(result.code).toBeNull();
    expect(result.ok).toBe(false);
  });

  it('still throws for an unstubbed command when the signal is live', async () => {
    const host = new FakeHost();
    await expect(
      host.command({ command: 'slack', args: ['auth'], signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(FakeHostUnexpectedCallError);
  });

  it('times out deterministically on the fake clock, not wall time', async () => {
    const host = new FakeHost({ now: 1000 });
    host.stubCommand('llmux restart', { delayMs: 5000, code: 0 });

    const result = await host.command({ command: 'llmux', args: ['restart'], timeoutMs: 1000 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(host.now()).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// I-6 — RecordedCall observability
// ---------------------------------------------------------------------------

describe('I-6 spawn flags and kills are observable', () => {
  it('records processGroup and inheritEnv on both call views', async () => {
    const host = new FakeHost();
    host.stubSpawn('slack run', { runUntilKilled: true });

    const handle = host.spawn({
      command: 'slack',
      args: ['run', '--team', 'T1'],
      processGroup: true,
      inheritEnv: false,
      env: { SLACK_BOT_TOKEN: SENTINEL_BOT_TOKEN },
    });

    const shown = host.calls.find((c) => c.kind === 'spawn');
    expect(shown).toMatchObject({ processGroup: true, inheritEnv: false });
    expect(JSON.stringify(shown)).not.toContain('SENTINELaaaabbbb');

    const raw = host.unsafeRawCalls().find((c) => c.kind === 'spawn');
    expect(raw).toMatchObject({ processGroup: true, inheritEnv: false });
    expect(JSON.stringify(raw)).toContain(SENTINEL_BOT_TOKEN);

    handle.kill('SIGTERM');
    await handle.exited;
    expect(host.calls).toContainEqual({ kind: 'kill', command: 'slack', signal: 'SIGTERM' });
  });

  it('records inheritEnv on commands too', async () => {
    const host = new FakeHost();
    host.stubCommand('llmux accounts', { stdout: '' });
    await host.command({ command: 'llmux', args: ['accounts'], inheritEnv: false });
    expect(host.calls[0]).toMatchObject({ kind: 'command', inheritEnv: false });
  });
});

// ---------------------------------------------------------------------------
// I-7 — process-group kill really reaps the tree
// ---------------------------------------------------------------------------

describe('I-7 processGroup kill takes down grandchildren', () => {
  it('leaves no orphaned grandchild after kill()', async () => {
    const host = new RealHost();
    const handle = host.spawn({
      command: '/bin/sh',
      args: ['-c', 'sleep 30 & echo $!; wait'],
      processGroup: true,
    });

    const chunks: string[] = [];
    handle.onStdout((c) => chunks.push(c));

    const deadline = Date.now() + 5000;
    while (chunks.join('').trim().length === 0 && Date.now() < deadline) await settle(20);
    const grandchild = Number.parseInt(chunks.join('').trim(), 10);
    expect(Number.isInteger(grandchild)).toBe(true);

    try {
      handle.kill('SIGTERM');
      await handle.exited;
      await settle(200);
      expect(() => process.kill(grandchild, 0)).toThrow(/ESRCH/);
    } finally {
      // Never leave a 30s sleep behind, even if the assertion above failed.
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {
        /* already gone — the expected case */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// I-8 — promptSecret
// ---------------------------------------------------------------------------

class FakeTtyInput extends PassThrough {
  isTTY = true;
  rawModeCalls: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.rawModeCalls.push(mode);
    return this;
  }
}

function ttyPair() {
  const input = new FakeTtyInput();
  const written: string[] = [];
  const output = new PassThrough();
  output.on('data', (b: Buffer) => written.push(b.toString('utf-8')));
  return { input, output, written };
}

describe('I-8 promptSecret reads a secret without echoing or recording it', () => {
  it('returns the typed line, echoes nothing, and restores the TTY', async () => {
    const { input, output, written } = ttyPair();
    const host = new RealHost({ promptStreams: { input, output } });

    const pending = host.promptSecret('Challenge: ');
    await settle(20);
    input.write('CHALLENGE-SENTINEL-9f3a\r');

    expect(await pending).toBe('CHALLENGE-SENTINEL-9f3a');
    expect(written.join('')).toContain('Challenge: ');
    expect(written.join('')).not.toContain('CHALLENGE-SENTINEL-9f3a');
    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('handles backspace', async () => {
    const { input, output } = ttyPair();
    const host = new RealHost({ promptStreams: { input, output } });
    const pending = host.promptSecret('Challenge: ');
    await settle(20);
    input.write(`abX${BACKSPACE}`);
    input.write('c\n');
    expect(await pending).toBe('abc');
  });

  it('rejects on abort and still restores the TTY', async () => {
    const { input, output } = ttyPair();
    const host = new RealHost({ promptStreams: { input, output } });
    const controller = new AbortController();

    const pending = host.promptSecret('Challenge: ', { signal: controller.signal });
    await settle(20);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SecretPromptError);
    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('rejects Ctrl-C as a cancellation and restores the TTY', async () => {
    const { input, output } = ttyPair();
    const host = new RealHost({ promptStreams: { input, output } });
    const pending = host.promptSecret('Challenge: ');
    await settle(20);
    input.write(CTRL_C);

    await expect(pending).rejects.toBeInstanceOf(SecretPromptError);
    expect(input.rawModeCalls).toEqual([true, false]);
  });

  it('fails loudly on a non-TTY instead of echoing the secret', async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    const host = new RealHost({ promptStreams: { input, output: new PassThrough() } });
    await expect(host.promptSecret('Challenge: ')).rejects.toBeInstanceOf(SecretPromptError);
  });

  it('FakeHost scripts the value but records only the prompt', async () => {
    const host = new FakeHost();
    host.stubPromptSecret('Challenge: ', 'CHALLENGE-SENTINEL-9f3a');

    expect(await host.promptSecret('Challenge: ')).toBe('CHALLENGE-SENTINEL-9f3a');
    expect(host.calls).toContainEqual({ kind: 'promptSecret', prompt: 'Challenge: ' });
    expect(JSON.stringify(host.calls)).not.toContain('CHALLENGE-SENTINEL-9f3a');
    expect(JSON.stringify(host.unsafeRawCalls())).not.toContain('CHALLENGE-SENTINEL-9f3a');
  });

  it('FakeHost throws on an unscripted prompt', async () => {
    const host = new FakeHost();
    await expect(host.promptSecret('Challenge: ')).rejects.toBeInstanceOf(FakeHostUnexpectedCallError);
  });
});

// ---------------------------------------------------------------------------
// Minors on the same paths (M-4, M-5, M-7, M-9)
// ---------------------------------------------------------------------------

describe('socket lifecycle minors', () => {
  it('close() is idempotent and drops queued frames', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'idem.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    client.write(`${JSON.stringify({ n: 1 })}\n`);
    await settle(60);

    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    // A frame queued before close must not be served afterwards.
    await expect(server.receiveJson({ timeoutMs: 50, validate: (v) => v })).rejects.toThrow();

    client.destroy();
  });

  it('routes replies to the client that sent each frame (two concurrent clients)', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'multi.sock');
    const server = await host.listenUnixSocket(socketPath);

    const mk = async (id: number) => {
      const c = net.createConnection(socketPath);
      await new Promise((r) => c.on('connect', r));
      const seen: string[] = [];
      c.on('data', (b: Buffer) => seen.push(b.toString('utf-8')));
      c.write(`${JSON.stringify({ id })}\n`);
      return { c, seen };
    };

    const a = await mk(1);
    await settle(40);
    const b = await mk(2);
    await settle(40);

    for (let i = 0; i < 2; i++) {
      const msg = await server.receiveJsonMessage({ timeoutMs: 2000, validate: (v) => v as { id: number } });
      await msg.reply({ ackFor: msg.value.id });
    }
    await settle(80);

    expect(a.seen.join('')).toContain('"ackFor":1');
    expect(a.seen.join('')).not.toContain('"ackFor":2');
    expect(b.seen.join('')).toContain('"ackFor":2');

    a.c.destroy();
    b.c.destroy();
    await server.close();
  });

  it('rejects reply(undefined) rather than writing the literal string undefined', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'undef.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    client.write(`${JSON.stringify({ n: 1 })}\n`);

    const msg = await server.receiveJsonMessage({ timeoutMs: 2000, validate: (v) => v });
    await expect(msg.reply(undefined)).rejects.toThrow();

    client.destroy();
    await server.close();
  });

  it('rejects a reply after the client disconnected', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'gone.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    client.write(`${JSON.stringify({ n: 1 })}\n`);

    const msg = await server.receiveJsonMessage({ timeoutMs: 2000, validate: (v) => v });
    client.destroy();
    await settle(80);

    await expect(msg.reply({ ack: true })).rejects.toThrow();
    await server.close();
  });
});

describe('FakeHost stub precedence (M-9)', () => {
  it('lets a once-stub win even when a general stub was registered first', async () => {
    const host = new FakeHost();
    host.stubCommand('llmux accounts --json', { code: 0, stdout: '{"accounts":[]}' });
    host.stubCommandOnce('llmux accounts --json', { code: 1, stderr: 'no daemon' });

    expect((await host.command({ command: 'llmux', args: ['accounts', '--json'] })).code).toBe(1);
    expect((await host.command({ command: 'llmux', args: ['accounts', '--json'] })).code).toBe(0);
  });
});
