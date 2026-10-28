import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Runs the vendored headless renderer against a stub `playwright` and a fake
// encoder, so the exit-code contract is checked without a browser or ffmpeg.
const ADAPTER = resolve(__dirname, '..', 'adapters', 'headless');

const PLAYWRIGHT_STUB = `
const page = {
  on() {},
  async setContent() {},
  async waitForFunction() {},
  async evaluate() {},
  async screenshot() { return Buffer.from('frame'); },
};
exports.chromium = { async launch() { return { async newPage() { return page; }, async close() {} }; } };
`;

const dirs: string[] = [];

function sandbox(encoderExit: number): { render: string; scene: string; encoder: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dd-motion-'));
  dirs.push(dir);
  copyFileSync(join(ADAPTER, 'render.mjs'), join(dir, 'render.mjs'));
  copyFileSync(join(ADAPTER, 'player.html'), join(dir, 'player.html'));
  const stub = join(dir, 'node_modules', 'playwright');
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, 'package.json'), '{"name":"playwright","main":"index.js"}');
  writeFileSync(join(stub, 'index.js'), PLAYWRIGHT_STUB);
  const out = join(dir, 'film.mp4');
  const encoder = join(dir, 'fake-ffmpeg.sh');
  // Drain the frames, then either write the film or fail without writing it.
  const body =
    encoderExit === 0 ? `cat >/dev/null\nprintf film > "${out}"\nexit 0\n` : `cat >/dev/null\nexit ${encoderExit}\n`;
  writeFileSync(encoder, `#!/bin/sh\n${body}`);
  chmodSync(encoder, 0o755);
  const scene = join(dir, 'scene.js');
  writeFileSync(scene, "kit.scene('drawing', { init() {}, render() {} });\n");
  return { render: join(dir, 'render.mjs'), scene, encoder, out };
}

function run(s: ReturnType<typeof sandbox>) {
  return spawnSync(
    process.execPath,
    [s.render, '--scene', s.scene, '--out', s.out, '--duration', '0.1', '--fps', '10', '--ffmpeg', s.encoder],
    { encoding: 'utf8', timeout: 20000 },
  );
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dimensional-drawing-motion headless renderer — encoder exit contract', () => {
  it('exits non-zero and says so when the encoder fails, instead of reporting a film it never wrote', () => {
    const s = sandbox(42);
    const result = run(s);
    expect(existsSync(s.out)).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ffmpeg/i);
    expect(result.stdout).not.toMatch(/frames →/);
  });

  it('still exits 0 and reports the film when the encoder succeeds', () => {
    const s = sandbox(0);
    const result = run(s);
    expect(result.status).toBe(0);
    expect(existsSync(s.out)).toBe(true);
    expect(result.stdout).toMatch(/1 frames →/);
  });
});
