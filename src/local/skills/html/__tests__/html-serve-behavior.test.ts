import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
});
