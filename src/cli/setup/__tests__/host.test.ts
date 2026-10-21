import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { inspect } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeHost, FakeHostUnexpectedCallError } from '../fake-host';
import { CommandSpawnError, launchctlCommandSpec, SocketFrameError, SocketTimeoutError, UnsafeUrlError } from '../host';
import { RealHost } from '../real-host';

const SENTINEL_BOT_TOKEN = 'xoxb-1-2-SENTINELaaaabbbb';
const SENTINEL_TICKET = 'TICKET-SENTINEL-abcdef123456';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'somawork-host-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// RealHost — command()
// ---------------------------------------------------------------------------

describe('RealHost.command — argv/env separation', () => {
  it('passes argv literally, with no shell interpretation', async () => {
    const host = new RealHost();
    const result = await host.command({ command: '/bin/echo', args: ['$HOME; rm -rf /', '*'] });
    expect(result.code).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.unsafeRawStdout().trim()).toBe('$HOME; rm -rf / *');
  });

  it('puts env values in the child environment, never in argv', async () => {
    const host = new RealHost();
    const result = await host.command({
      command: '/usr/bin/env',
      args: [],
      env: { SOMA_HOST_TEST_VAR: 'from-env' },
    });
    expect(result.unsafeRawStdout()).toContain('SOMA_HOST_TEST_VAR=from-env');
    expect(result.args).toEqual([]);
  });

  it('can run with a replaced (non-inherited) environment', async () => {
    const host = new RealHost();
    const result = await host.command({
      command: '/usr/bin/env',
      args: [],
      env: { SOMA_ONLY: '1' },
      inheritEnv: false,
    });
    const lines = result.unsafeRawStdout().trim().split('\n').filter(Boolean);
    expect(lines).toContain('SOMA_ONLY=1');
    expect(lines.some((l) => l.startsWith('PATH='))).toBe(false);
  });

  it('feeds stdin when provided', async () => {
    const host = new RealHost();
    const result = await host.command({ command: '/bin/cat', args: [], stdin: 'piped-input' });
    expect(result.unsafeRawStdout()).toBe('piped-input');
  });

  it('reports a non-zero exit code without throwing', async () => {
    const host = new RealHost();
    const result = await host.command({ command: '/bin/ls', args: [path.join(tmpDir, 'nope')] });
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('throws a typed error when the binary does not exist', async () => {
    const host = new RealHost();
    await expect(host.command({ command: path.join(tmpDir, 'missing-bin'), args: [] })).rejects.toThrow(/missing-bin/);
  });
});

describe('RealHost.command — raw vs display boundary', () => {
  it('redacts secret-shaped child stdout on the public surface but keeps raw for parsing', async () => {
    const host = new RealHost();
    const result = await host.command({ command: '/bin/echo', args: [SENTINEL_BOT_TOKEN] });

    expect(result.stdout).toContain('[REDACTED xoxb-');
    expect(result.stdout).not.toContain('SENTINELaaaabbbb');
    expect(result.unsafeRawStdout()).toContain(SENTINEL_BOT_TOKEN);
  });

  it('never serializes raw output through JSON.stringify or toString', async () => {
    const host = new RealHost();
    const result = await host.command({ command: '/bin/echo', args: [SENTINEL_BOT_TOKEN] });

    expect(JSON.stringify(result)).not.toContain('SENTINELaaaabbbb');
    expect(String(result)).not.toContain('SENTINELaaaabbbb');
    expect(Object.values(result as unknown as Record<string, unknown>).join(' ')).not.toContain('SENTINELaaaabbbb');
    // console.log(result) is the likeliest accident of all.
    expect(inspect(result, { depth: 5 })).not.toContain('SENTINELaaaabbbb');
  });

  it('redacts registered ephemeral argv (the Slack ticket exception) in the display surface', async () => {
    const host = new RealHost();
    const result = await host.command({
      command: '/bin/echo',
      args: ['--ticket', SENTINEL_TICKET],
      sensitiveValues: [SENTINEL_TICKET],
    });

    expect(result.args).toEqual(['--ticket', '[REDACTED ephemeral]']);
    expect(result.stdout).not.toContain(SENTINEL_TICKET);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_TICKET);
    expect(result.unsafeRawStdout()).toContain(SENTINEL_TICKET);
  });
});

describe('RealHost.command — timeout and cancel propagation', () => {
  it('kills the child and reports timedOut when timeoutMs elapses', async () => {
    const host = new RealHost();
    const started = Date.now();
    const result = await host.command({ command: '/bin/sleep', args: ['5'], timeoutMs: 150 });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('kills the child and reports aborted when the AbortSignal fires', async () => {
    const host = new RealHost();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await host.command({ command: '/bin/sleep', args: ['5'], signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('does not spawn at all when the signal is already aborted', async () => {
    const host = new RealHost();
    const result = await host.command({
      command: '/bin/sleep',
      args: ['5'],
      signal: AbortSignal.abort(),
    });
    expect(result.aborted).toBe(true);
    expect(result.code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RealHost — spawn()
// ---------------------------------------------------------------------------

describe('RealHost.spawn', () => {
  it('streams redacted stdout and resolves exited on completion', async () => {
    const host = new RealHost();
    const handle = host.spawn({ command: '/bin/echo', args: [SENTINEL_BOT_TOKEN] });
    const chunks: string[] = [];
    handle.onStdout((c) => chunks.push(c));
    const exit = await handle.exited;

    expect(exit.code).toBe(0);
    const joined = chunks.join('');
    expect(joined).toContain('[REDACTED xoxb-');
    expect(joined).not.toContain('SENTINELaaaabbbb');
  });

  it('kills a long-running child and resolves exited', async () => {
    // Process-GROUP semantics are proven in host-hardening.test.ts with a real
    // grandchild; /bin/sleep has no children, so it cannot distinguish
    // process.kill(-pid) from child.kill().
    const host = new RealHost();
    const handle = host.spawn({ command: '/bin/sleep', args: ['30'] });
    expect(handle.pid).toBeGreaterThan(0);
    handle.kill('SIGTERM');
    const exit = await handle.exited;
    expect(exit.code === null || exit.code !== 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RealHost — which / chmod / openUrl / clipboard / time
// ---------------------------------------------------------------------------

describe('RealHost.which', () => {
  it('resolves an existing binary to an absolute path', async () => {
    const host = new RealHost();
    const resolved = await host.which('node');
    expect(resolved).toMatch(/^\/.+node$/);
  });

  it('returns null for a missing binary instead of throwing', async () => {
    const host = new RealHost();
    expect(await host.which('somawork-definitely-not-a-binary-xyz')).toBeNull();
  });

  it('rejects a binary name that could be read as a flag or a path', async () => {
    const host = new RealHost();
    await expect(host.which('-rf')).rejects.toThrow();
    await expect(host.which('../bin/sh')).rejects.toThrow();
  });
});

describe('RealHost.chmod', () => {
  it('applies the requested mode', async () => {
    const host = new RealHost();
    const file = path.join(tmpDir, 'modeme');
    fs.writeFileSync(file, 'x');
    await host.chmod(file, 0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('RealHost.openUrl', () => {
  it('refuses non-http(s) schemes without spawning anything', async () => {
    const host = new RealHost({ openCommand: '/usr/bin/false' });
    await expect(host.openUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(host.openUrl('javascript:alert(1)')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(host.openUrl('-oProxyCommand=x')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a URL that carries a credential (argv is world-readable via ps)', async () => {
    const host = new RealHost({ openCommand: '/usr/bin/false' });
    await expect(host.openUrl('https://example.com/cb?access_token=abcdefghijkl')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(host.openUrl('https://example.com/x?t=xoxb-1-2-aaaabbbbcccc')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('opens an https URL through the configured opener', async () => {
    const host = new RealHost({ openCommand: '/usr/bin/true' });
    await expect(host.openUrl('https://api.slack.com/apps')).resolves.toBeUndefined();
  });
});

describe('RealHost.copyToClipboard', () => {
  it('writes the text to the clipboard command over stdin, not argv', async () => {
    const sink = path.join(tmpDir, 'clip.txt');
    const host = new RealHost({ clipboardCommand: '/usr/bin/tee', clipboardArgs: [sink] });
    await host.copyToClipboard('/slackauthticket ABC123');
    expect(fs.readFileSync(sink, 'utf-8')).toBe('/slackauthticket ABC123');
  });
});

describe('RealHost time', () => {
  it('now() advances and sleep() waits', async () => {
    const host = new RealHost();
    const before = host.now();
    await host.sleep(20);
    expect(host.now() - before).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// launchctl adapter
// ---------------------------------------------------------------------------

describe('launchctl adapter', () => {
  it('builds a typed argv-only CommandSpec', () => {
    const spec = launchctlCommandSpec({ kind: 'bootstrap', domain: 'gui/501', plistPath: '/tmp/x.plist' });
    expect(spec.command).toBe('/bin/launchctl');
    expect(spec.args).toEqual(['bootstrap', 'gui/501', '/tmp/x.plist']);

    expect(launchctlCommandSpec({ kind: 'bootout', target: 'gui/501/ai.2lab.somawork.preview' }).args).toEqual([
      'bootout',
      'gui/501/ai.2lab.somawork.preview',
    ]);
    expect(
      launchctlCommandSpec({ kind: 'kickstart', target: 'gui/501/ai.2lab.somawork.preview', restart: true }).args,
    ).toEqual(['kickstart', '-k', 'gui/501/ai.2lab.somawork.preview']);
    expect(launchctlCommandSpec({ kind: 'print', target: 'gui/501/ai.2lab.somawork.production' }).args).toEqual([
      'print',
      'gui/501/ai.2lab.somawork.production',
    ]);
  });

  it('goes through the single command() execution path on the fake host', async () => {
    const host = new FakeHost();
    host.stubCommand('/bin/launchctl print gui/501/ai.2lab.somawork.preview', { code: 0, stdout: 'state = running' });
    const result = await host.launchctl({ kind: 'print', target: 'gui/501/ai.2lab.somawork.preview' });

    expect(result.unsafeRawStdout()).toContain('state = running');
    expect(host.calls.map((c) => c.kind)).toEqual(['command']);
  });
});

// ---------------------------------------------------------------------------
// RealHost — listenUnixSocket
// ---------------------------------------------------------------------------

function sendFrame(socketPath: string, payload: unknown): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(`${JSON.stringify(payload)}\n`);
      resolve(client);
    });
    client.on('error', reject);
  });
}

describe('RealHost.listenUnixSocket — framed JSON contract', () => {
  it('creates the socket 0600 inside a 0700 directory and cleans it up on close', async () => {
    const host = new RealHost();
    const dir = path.join(tmpDir, 'sockdir');
    const socketPath = path.join(dir, 'capture.sock');

    const server = await host.listenUnixSocket(socketPath);
    expect(server.path).toBe(socketPath);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);

    await server.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('removes a stale path before binding', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'stale.sock');
    fs.writeFileSync(socketPath, 'stale');

    const server = await host.listenUnixSocket(socketPath);
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
    await server.close();
  });

  it('receives exactly one validated payload per receiveJson call', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'one.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    client.write(`${JSON.stringify({ version: 1, n: 1 })}\n${JSON.stringify({ version: 1, n: 2 })}\n`);

    const validate = (v: unknown) => v as { version: number; n: number };
    expect((await server.receiveJson({ timeoutMs: 2000, validate })).n).toBe(1);
    expect((await server.receiveJson({ timeoutMs: 2000, validate })).n).toBe(2);

    client.destroy();
    await server.close();
  });

  it('rejects loudly when validation fails and keeps the socket usable', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'bad.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = await sendFrame(socketPath, { version: 1, botToken: 'not-a-token' });
    await expect(
      server.receiveJson({
        timeoutMs: 2000,
        validate: () => {
          throw new Error('bad token prefix');
        },
      }),
    ).rejects.toThrow(/bad token prefix/);

    client.destroy();
    await server.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('rejects malformed JSON with a typed frame error', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'malformed.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    client.write('{not json}\n');

    await expect(server.receiveJson({ timeoutMs: 2000, validate: (v) => v })).rejects.toBeInstanceOf(SocketFrameError);

    client.destroy();
    await server.close();
  });

  it('rejects an oversized frame even when it is perfectly valid JSON', async () => {
    // Deliberately valid JSON: an invalid-JSON payload would be rejected by the
    // parser whether or not a size cap exists, so it could not prove the cap.
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'big.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    client.write(`${JSON.stringify({ pad: 'a'.repeat(70 * 1024) })}\n`);

    await expect(server.receiveJson({ timeoutMs: 2000, validate: (v) => v })).rejects.toBeInstanceOf(SocketFrameError);

    client.destroy();
    await server.close();
  });

  it('rejects an unterminated stream that grows past the frame cap', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'unterminated.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    // No newline, ever: the parser must bound the buffer instead of growing it.
    for (let i = 0; i < 10; i++) client.write('a'.repeat(16 * 1024));

    await expect(server.receiveJson({ timeoutMs: 2000, validate: (v) => v })).rejects.toBeInstanceOf(SocketFrameError);

    client.destroy();
    await server.close();
  });

  it('accepts a batch of frames whose combined size exceeds one frame cap', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'batch.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    // 3 x ~30KB frames = ~90KB in one write: legal, because the cap is per frame.
    const pad = 'x'.repeat(30 * 1024);
    client.write([1, 2, 3].map((n) => `${JSON.stringify({ n, pad })}\n`).join(''));

    const validate = (v: unknown) => v as { n: number };
    expect((await server.receiveJson({ timeoutMs: 2000, validate })).n).toBe(1);
    expect((await server.receiveJson({ timeoutMs: 2000, validate })).n).toBe(2);
    expect((await server.receiveJson({ timeoutMs: 2000, validate })).n).toBe(3);

    client.destroy();
    await server.close();
  });

  it('times out when no client sends a frame, and still cleans up', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'timeout.sock');
    const server = await host.listenUnixSocket(socketPath);

    await expect(server.receiveJson({ timeoutMs: 80, validate: (v) => v })).rejects.toBeInstanceOf(SocketTimeoutError);

    await server.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('aborts a pending receive when the caller signals cancel', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'abort.sock');
    const server = await host.listenUnixSocket(socketPath);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(
      server.receiveJson({ timeoutMs: 5000, validate: (v) => v, signal: controller.signal }),
    ).rejects.toThrow();

    await server.close();
  });

  it('supports a one-frame ACK back to the sending client', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'ack.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    const received: string[] = [];
    client.on('data', (b) => received.push(b.toString('utf-8')));
    client.write(`${JSON.stringify({ version: 1, ok: true })}\n`);

    const message = await server.receiveJsonMessage({ timeoutMs: 2000, validate: (v) => v as { version: number } });
    expect(message.value.version).toBe(1);
    await message.reply({ ack: true });

    await new Promise((r) => setTimeout(r, 80));
    expect(received.join('')).toContain('"ack":true');

    client.destroy();
    await server.close();
  });

  it('does not leak a Node net.Server to consumers', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'shape.sock');
    const server = await host.listenUnixSocket(socketPath);

    const surface = new Set<string>();
    for (let proto: object | null = server; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) surface.add(key);
    }
    expect(surface.has('listen')).toBe(false);
    expect(surface.has('address')).toBe(false);
    expect([...surface].some((k) => k.toLowerCase().includes('server'))).toBe(false);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// FakeHost
// ---------------------------------------------------------------------------

describe('FakeHost — deterministic call capture', () => {
  it('records commands in order with argv and env separated', async () => {
    const host = new FakeHost();
    host.stubCommand('llmux accounts', { stdout: 'z (oauth)\n' });
    host.stubCommand('llmux restart', { stdout: 'ok' });

    await host.command({ command: 'llmux', args: ['accounts'], env: { SOMA_X: '1' } });
    await host.command({ command: 'llmux', args: ['restart'] });

    expect(host.calls).toEqual([
      { kind: 'command', command: 'llmux', args: ['accounts'], env: { SOMA_X: '1' } },
      { kind: 'command', command: 'llmux', args: ['restart'], env: {} },
    ]);
  });

  it('throws loudly on an unstubbed command instead of silently succeeding', async () => {
    const host = new FakeHost();
    await expect(host.command({ command: 'slack', args: ['auth', 'list'] })).rejects.toBeInstanceOf(
      FakeHostUnexpectedCallError,
    );
  });

  it('consumes one-shot stubs in registration order, then falls back', async () => {
    const host = new FakeHost();
    host.stubCommandOnce('llmux accounts --json', { code: 1, stderr: 'no daemon' });
    host.stubCommand('llmux accounts --json', { code: 0, stdout: '{"accounts":[]}' });

    expect((await host.command({ command: 'llmux', args: ['accounts', '--json'] })).code).toBe(1);
    expect((await host.command({ command: 'llmux', args: ['accounts', '--json'] })).code).toBe(0);
    expect((await host.command({ command: 'llmux', args: ['accounts', '--json'] })).code).toBe(0);
  });

  it('redacts the public calls view but keeps raw calls behind the unsafe accessor', async () => {
    const host = new FakeHost();
    host.stubCommand('slack auth login', { stdout: 'ok' });

    await host.command({
      command: 'slack',
      args: ['auth', 'login', '--ticket', SENTINEL_TICKET],
      env: { SLACK_BOT_TOKEN: SENTINEL_BOT_TOKEN },
      sensitiveValues: [SENTINEL_TICKET],
    });

    const shown = JSON.stringify(host.calls);
    expect(shown).not.toContain(SENTINEL_TICKET);
    expect(shown).not.toContain('SENTINELaaaabbbb');
    expect(shown).toContain('[REDACTED ephemeral]');

    const raw = JSON.stringify(host.unsafeRawCalls());
    expect(raw).toContain(SENTINEL_TICKET);
    expect(raw).toContain(SENTINEL_BOT_TOKEN);
  });

  it('redacts stubbed stdout on the display surface only', async () => {
    const host = new FakeHost();
    host.stubCommand('slack auth list', { stdout: `token ${SENTINEL_BOT_TOKEN}` });
    const result = await host.command({ command: 'slack', args: ['auth', 'list'] });

    expect(result.stdout).toContain('[REDACTED xoxb-');
    expect(result.unsafeRawStdout()).toContain(SENTINEL_BOT_TOKEN);
  });

  it('records which/chmod/openUrl/clipboard/sleep and controls the clock', async () => {
    const host = new FakeHost({ now: 1000 });
    host.stubWhich('llmux', '/opt/homebrew/bin/llmux');

    expect(await host.which('llmux')).toBe('/opt/homebrew/bin/llmux');
    expect(await host.which('missing')).toBeNull();
    await host.openUrl('https://api.slack.com/apps');
    await host.copyToClipboard('/slackauthticket ABC');
    await host.chmod('/tmp/x', 0o600);
    await host.sleep(500);

    expect(host.now()).toBe(1500);
    expect(host.calls.map((c) => c.kind)).toEqual(['which', 'which', 'openUrl', 'copyToClipboard', 'chmod', 'sleep']);
  });

  it('serves scripted unix-socket frames and a timeout', async () => {
    const host = new FakeHost();
    host.stubUnixSocket('/tmp/capture.sock', { frames: [{ version: 1, botToken: 'xoxb-1-2-aaaabbbbcccc' }] });

    const server = await host.listenUnixSocket('/tmp/capture.sock', 0o600);
    const frame = await server.receiveJson({ timeoutMs: 1000, validate: (v) => v as { version: number } });
    expect(frame.version).toBe(1);
    await expect(server.receiveJson({ timeoutMs: 10, validate: (v) => v })).rejects.toBeInstanceOf(SocketTimeoutError);
    await server.close();

    expect(host.calls[0]).toEqual({ kind: 'listenUnixSocket', path: '/tmp/capture.sock', mode: 0o600 });
  });

  it('scripts spawn exit and records the spawn call', async () => {
    const host = new FakeHost();
    host.stubSpawn('slack run', { stdout: `bot ${SENTINEL_BOT_TOKEN}`, code: 0 });

    const handle = host.spawn({ command: 'slack', args: ['run', '--team', 'T1'] });
    const chunks: string[] = [];
    handle.onStdout((c) => chunks.push(c));
    const exit = await handle.exited;

    expect(exit.code).toBe(0);
    expect(chunks.join('')).not.toContain('SENTINELaaaabbbb');
    expect(host.calls.some((c) => c.kind === 'spawn')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 9 — detached (fire-and-forget) spawn mode
// ---------------------------------------------------------------------------

/**
 * The headless service fallback needs a child that OUTLIVES the controller: a
 * new session/process-group leader with no inherited pipes. `processGroup`
 * alone is not that — it keeps piped stdio, so the child dies (or blocks) with
 * the parent's pipe. Rather than let the service manager reach for
 * `child_process` and lose the single injection boundary, the mode is part of
 * the host contract and the fake records it.
 */
describe('SetupHost.spawn — detached mode', () => {
  it('FakeHost records the detached mode so a service test can prove it was requested', () => {
    const host = new FakeHost();
    host.stubSpawn('/bin/node', { runUntilKilled: true, pid: 9911 });
    const handle = host.spawn({
      command: '/bin/node',
      args: ['/opt/rt/dist/run-with-rotating-logs.js', '/opt/rt/dist/index.js'],
      env: { SOMA_CONFIG_DIR: '/cfg' },
      inheritEnv: false,
      cwd: '/data',
      detached: true,
    });
    expect(handle.pid).toBe(9911);
    const call = host.calls.find((c) => c.kind === 'spawn');
    expect(call).toMatchObject({ kind: 'spawn', detached: true, inheritEnv: false, cwd: '/data' });
  });

  it('RealHost ignores stdio and unrefs, so the child survives and streams nothing', async () => {
    const marker = path.join(tmpDir, 'detached.marker');
    const host = new RealHost();
    const chunks: string[] = [];
    const handle = host.spawn({
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok'); process.stdout.write('leaked');`],
      detached: true,
    });
    handle.onStdout((chunk) => chunks.push(chunk));
    await handle.exited;
    expect(fs.existsSync(marker)).toBe(true);
    // stdio is `ignore`, so there is no pipe to read and nothing to leak.
    expect(chunks).toEqual([]);
  });
});

/**
 * A detached child is fire-and-forget by design, so its handle is routinely
 * discarded. `RealHost` still builds an `exited` promise that REJECTS on the
 * child's asynchronous `error` event — and an unobserved rejection takes the
 * whole CLI down with it, skipping the service manager's rollback entirely.
 * The host owns the observer because the host owns the promise.
 */
describe('RealHost.spawn — detached rejection is observed (I3)', () => {
  it('does not crash the process when a discarded detached spawn fails asynchronously', () => {
    const script = [
      `const { RealHost } = require(${JSON.stringify(path.join(__dirname, '..', 'real-host.ts'))});`,
      'const host = new RealHost();',
      // Exactly what `spawnDetachedSupervisor` does: spawn, discard the handle.
      'host.spawn({ command: "/nonexistent/node-does-not-exist", args: [], detached: true });',
      'setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 750);',
    ].join('\n');
    const file = path.join(tmpDir, 'detached-reject.ts');
    fs.writeFileSync(file, script);

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx'), file],
      {
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );

    expect(result.stdout).toContain('SURVIVED');
    expect(result.status).toBe(0);
  });

  it('still lets an explicit consumer observe the failure', async () => {
    const host = new RealHost();
    const handle = host.spawn({ command: '/nonexistent/node-does-not-exist', args: [], detached: true });
    await expect(handle.exited).rejects.toBeInstanceOf(CommandSpawnError);
  });
});

// ---------------------------------------------------------------------------
// I-1 — peer authentication on the capture socket, over REAL sockets
// ---------------------------------------------------------------------------

describe('RealHost.listenUnixSocket — authenticate', () => {
  const NONCE = 'a'.repeat(64);
  const WRONG = 'b'.repeat(64);
  const authenticate = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && (value as { nonce?: unknown }).nonce === NONCE;

  it('refuses a frame from a peer that cannot echo the challenge, and never validates it', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'auth-wrong.sock');
    const server = await host.listenUnixSocket(socketPath);

    const attacker = await sendFrame(socketPath, { nonce: WRONG, botToken: 'xoxb-ATTACKER-000000000000' });
    let validated = 0;

    await expect(
      server.receiveJson({
        timeoutMs: 250,
        authenticate,
        validate: (v) => {
          validated += 1;
          return v;
        },
      }),
    ).rejects.toBeInstanceOf(SocketTimeoutError);
    // The whole point: the attacker's frame never reached the code that would
    // have persisted it, and the attacker was hung up on.
    expect(validated).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(attacker.destroyed).toBe(true);

    attacker.destroy();
    await server.close();
  });

  it('serves the legitimate peer even when a wrong peer connected first', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'auth-race.sock');
    const server = await host.listenUnixSocket(socketPath);

    // Attacker wins the race to the socket, exactly as in the demonstrated I-1
    // scenario: it polls for the file and writes before the real helper is up.
    const attacker = await sendFrame(socketPath, { nonce: WRONG, botToken: 'xoxb-ATTACKER-000000000000' });
    const receive = server.receiveJsonMessage<{ nonce: string; botToken: string }>({
      timeoutMs: 2000,
      authenticate,
      validate: (v) => v as { nonce: string; botToken: string },
    });
    const helper = await sendFrame(socketPath, { nonce: NONCE, botToken: 'xoxb-REAL-111111111111' });

    const message = await receive;
    expect(message.value.botToken).toBe('xoxb-REAL-111111111111');
    // And the ACK goes to the helper's connection, not the attacker's.
    await message.reply({ version: 1, ok: true });
    const acked = await new Promise<string>((resolve) => helper.once('data', (d: Buffer) => resolve(d.toString())));
    expect(JSON.parse(acked)).toEqual({ version: 1, ok: true });

    attacker.destroy();
    helper.destroy();
    await server.close();
  });

  it('does not let an unauthenticated peer extend the deadline by spamming frames', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'auth-spam.sock');
    const server = await host.listenUnixSocket(socketPath);

    const client = net.createConnection(socketPath);
    await new Promise((r) => client.on('connect', r));
    const spam = setInterval(() => {
      if (!client.destroyed) client.write(`${JSON.stringify({ nonce: WRONG })}\n`);
    }, 5);

    const started = Date.now();
    await expect(server.receiveJson({ timeoutMs: 300, authenticate, validate: (v) => v })).rejects.toBeInstanceOf(
      SocketTimeoutError,
    );
    // The deadline is the caller's, not one-per-frame.
    expect(Date.now() - started).toBeLessThan(2000);

    clearInterval(spam);
    client.destroy();
    await server.close();
  });

  it('drops an unparseable frame instead of failing the receive, when authenticating', async () => {
    const host = new RealHost();
    const socketPath = path.join(tmpDir, 'auth-garbage.sock');
    const server = await host.listenUnixSocket(socketPath);

    const noise = net.createConnection(socketPath);
    await new Promise((r) => noise.on('connect', r));
    noise.write('{not json}\n');

    const receive = server.receiveJson({ timeoutMs: 2000, authenticate, validate: (v) => v });
    const helper = await sendFrame(socketPath, { nonce: NONCE, ok: true });
    expect(await receive).toMatchObject({ ok: true });

    noise.destroy();
    helper.destroy();
    await server.close();
  });
});
