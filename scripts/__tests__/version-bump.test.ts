/**
 * scripts/version-bump.sh — a refused tag push (2026-11-16: the workflow token answered 403 on `git push origin <tag>`)
 * stops a production deploy, and lets a dev deploy go on with its dist/version.json.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(__dirname, '..', 'version-bump.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(BIN, { recursive: true, force: true }));

// node for the script's JSON, and nothing else from the developer's PATH (no `claude`: release notes come from git log).
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-bin-'));
fs.symlinkSync(process.execPath, path.join(BIN, 'node'));
const ENV = {
  PATH: `${BIN}:/usr/bin:/bin`,
  HOME: os.tmpdir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, stdio: 'pipe' });

/** A checkout with one tagged release, whose remote refuses every push (a pre-receive hook that exits 1). */
function checkout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vbump-'));
  dirs.push(root);
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote], { env: ENV });
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "denied" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'one']);
  git(work, ['tag', '-a', 'v0.3.1-dev', '-m', 'v0.3.1-dev']);
  git(work, ['tag', '-a', 'v0.3.1', '-m', 'v0.3.1']);
  fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'two']);
  git(work, ['remote', 'add', 'origin', remote]);
  return work;
}

const run = (cwd: string, ref: string) =>
  spawnSync('bash', [SCRIPT, ref], { cwd, env: ENV, encoding: 'utf8', timeout: 60_000 });

describe('version-bump.sh — a refused tag push', () => {
  it('a dev deploy goes on: version.json written, the local tag dropped, exit 0', () => {
    const work = checkout();
    const r = run(work, 'main');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('failed to push tag v0.3.2-dev — dev deploy continues');
    const version = JSON.parse(fs.readFileSync(path.join(work, 'dist', 'version.json'), 'utf8'));
    expect(version.version).toBe('0.3.2');
    expect(execFileSync('git', ['tag', '-l', 'v0.3.2-dev'], { cwd: work, env: ENV }).toString().trim()).toBe('');
  }, 60_000);

  it('a production deploy stops', () => {
    const work = checkout();
    const r = run(work, 'deploy/prod');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('ERROR: failed to push tag');
  }, 60_000);
});
