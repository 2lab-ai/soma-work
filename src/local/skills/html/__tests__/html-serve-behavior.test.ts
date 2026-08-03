import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Process-level receipts for the durable-root serve contract: a real daemon,
// a real publish, a real GET. The static regex tests pin the source shape;
// these pin the behavior (env resolution, migration hygiene, verified link).

const SERVER = resolve(__dirname, '..', 'server', 'serve.mjs');
// Off the production 8763 range so a developer's real daemon is never touched.
const PORT = 18963 + (process.pid % 400);

let durableRoot: string;
let legacyRoot: string;
let outsideDir: string;
let artifactDir: string;
let env: NodeJS.ProcessEnv;
let daemon: ChildProcess;

function health(): Promise<string | null> {
  return fetch(`http://127.0.0.1:${PORT}/__soma-serve-health`)
    .then((r) => r.text())
    .catch(() => null);
}

beforeAll(async () => {
  durableRoot = mkdtempSync(join(tmpdir(), 'soma-serve-durable-'));
  legacyRoot = mkdtempSync(join(tmpdir(), 'soma-serve-legacy-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'soma-serve-outside-'));
  artifactDir = mkdtempSync(join(tmpdir(), 'soma-serve-artifact-'));

  // Legacy root: one legitimate survivor + one symlink pointing at a
  // "secret" outside the root. The sweep must rescue the file and refuse
  // the symlink.
  writeFileSync(join(legacyRoot, 'survivor.html'), '<!doctype html><title>survivor</title>');
  writeFileSync(join(outsideDir, 'secret.txt'), 'MUST-NOT-LEAK');
  symlinkSync(join(outsideDir, 'secret.txt'), join(legacyRoot, 'leak.html'));

  env = {
    ...process.env,
    SOMA_HTML_SERVE_ROOT: durableRoot,
    SOMA_HTML_LEGACY_ROOT: legacyRoot,
    SOMA_HTML_SERVE_BIND: '127.0.0.1',
  };

  daemon = spawn(process.execPath, [SERVER, '--daemon', '--port', String(PORT)], {
    env,
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    if ((await health()) !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}, 15_000);

afterAll(() => {
  daemon?.kill();
  for (const dir of [durableRoot, legacyRoot, outsideDir, artifactDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('local:html serve.mjs — behavioral contract (real daemon, real GET)', () => {
  it('health advertises ownership and the served root to loopback callers', async () => {
    const body = await health();
    expect(body).not.toBeNull();
    const lines = (body as string).trim().split('\n');
    expect(lines[0]).toBe('soma-html-serve');
    expect(lines[1]).toBe(`root=${durableRoot}`);
  });

  it('publish archives into the durable root and prints a verified, working link', async () => {
    const artifact = join(artifactDir, 'behavior-receipt.html');
    writeFileSync(artifact, '<!doctype html><title>behavior receipt</title>');
    const out = JSON.parse(
      execFileSync(process.execPath, [SERVER, '--file', artifact, '--port', String(PORT)], {
        env,
        encoding: 'utf8',
      }),
    );
    expect(out.port).toBe(PORT);
    expect(out.file).toBe(join(durableRoot, 'behavior-receipt.html'));
    expect(existsSync(out.file)).toBe(true);
    const res = await fetch(out.localUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('behavior receipt');
  });

  it('migrates legacy regular files forward but never follows symlinks', () => {
    // Migration ran during daemon start and again during the publish above.
    expect(existsSync(join(durableRoot, 'survivor.html'))).toBe(true);
    expect(readFileSync(join(durableRoot, 'survivor.html'), 'utf8')).toContain('survivor');
    expect(existsSync(join(durableRoot, 'leak.html'))).toBe(false);
    // The legacy originals are untouched (non-destructive sweep).
    expect(existsSync(join(legacyRoot, 'survivor.html'))).toBe(true);
  });

  it('a destination symlink planted in the archive is replaced, never followed', async () => {
    const victim = join(outsideDir, 'victim.txt');
    writeFileSync(victim, 'VICTIM-ORIGINAL');
    symlinkSync(victim, join(durableRoot, 'planted.html'));
    const artifact = join(artifactDir, 'planted.html');
    writeFileSync(artifact, '<!doctype html><title>planted replacement</title>');
    execFileSync(process.execPath, [SERVER, '--file', artifact, '--port', String(PORT)], {
      env,
      encoding: 'utf8',
    });
    // The write must have replaced the symlink itself, not its target.
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM-ORIGINAL');
    expect(lstatSync(join(durableRoot, 'planted.html')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(durableRoot, 'planted.html'), 'utf8')).toContain('planted replacement');
  });

  it('refuses a symlinked legacy root (world-writable /tmp trust gate)', () => {
    const realDir = mkdtempSync(join(tmpdir(), 'soma-serve-reallegacy-'));
    writeFileSync(join(realDir, 'juicy.html'), 'SHOULD-NOT-MIGRATE');
    const linkPath = join(mkdtempSync(join(tmpdir(), 'soma-serve-linkparent-')), 'legacy-link');
    symlinkSync(realDir, linkPath);
    const artifact = join(artifactDir, 'symlink-root-check.html');
    writeFileSync(artifact, '<!doctype html><title>symlink root check</title>');
    const raw = execFileSync(process.execPath, [SERVER, '--file', artifact, '--port', String(PORT)], {
      env: { ...env, SOMA_HTML_LEGACY_ROOT: linkPath },
      encoding: 'utf8',
    });
    const out = JSON.parse(raw);
    // Publish still succeeds, but the sweep refused the symlinked root loudly
    // and nothing behind the link entered the LAN-served archive.
    expect(out.migrationErrors).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(durableRoot, 'juicy.html'))).toBe(false);
    rmSync(realDir, { recursive: true, force: true });
  });

  it('migration never replaces an existing (possibly fresher) archive file', () => {
    writeFileSync(join(legacyRoot, 'collide.html'), 'STALE-LEGACY-BYTES');
    writeFileSync(join(durableRoot, 'collide.html'), 'FRESH-ARCHIVE-BYTES');
    const artifact = join(artifactDir, 'collide-trigger.html');
    writeFileSync(artifact, '<!doctype html><title>collide trigger</title>');
    execFileSync(process.execPath, [SERVER, '--file', artifact, '--port', String(PORT)], {
      env,
      encoding: 'utf8',
    });
    expect(readFileSync(join(durableRoot, 'collide.html'), 'utf8')).toBe('FRESH-ARCHIVE-BYTES');
  });

  it('rejects an unknown-root daemon serving a stale same-name file (no silent 404/stale link)', async () => {
    // Emulate a pre-durable-root daemon with a custom root: bare health body
    // (no root line) + a stale artifact under the requested name.
    const stalePort = PORT + 1;
    const staleServer = http.createServer((req, res) => {
      if (req.url === '/__soma-serve-health') return res.end('soma-html-serve');
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>STALE ARTIFACT</title>');
    });
    await new Promise<void>((r) => staleServer.listen(stalePort, '127.0.0.1', () => r()));
    try {
      const artifact = join(artifactDir, 'stale-check.html');
      writeFileSync(artifact, '<!doctype html><title>fresh artifact</title>');
      let exitCode = 0;
      try {
        execFileSync(process.execPath, [SERVER, '--file', artifact, '--port', String(stalePort)], {
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        exitCode = (err as { status?: number }).status ?? -1;
      }
      // Byte-verification must reject the stale 200 → explicit port fails loudly.
      expect(exitCode).toBe(2);
    } finally {
      staleServer.close();
    }
  });
});
