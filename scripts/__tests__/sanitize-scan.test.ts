/**
 * Behaviour test for `scripts/sanitize-scan.sh` — the Sanitize Gate's scanner.
 *
 * Incident (2026-10-27): PR #481's first pushes carried a private client ticket
 * key in a test fixture. The scanner read every ref in the runner's reused clone,
 * so from 06:27 to 12:17 UTC every PR and main's push run went red with
 * `objects=3` and nothing else. The red landed on whoever ran next — main's
 * #479 merge looked guilty and was not. Runs that tested #481's old commits kept
 * failing after the branch was cleaned, through leftover `refs/remotes/pull/N/merge`.
 *
 * Contract pinned here:
 *   - pull_request: a PR is judged on what it would merge (HEAD and its
 *     history), not on other branches.
 *   - push / local: every published branch and tag, not leftover PR refs.
 *   - a hit names the commit that carries it and the branch that reaches it.
 *   - the matching text never reaches the log (the repository is public).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each case spawns dozens of git processes; on a loaded host that outlasts the
// 5 s default, so the budget is explicit here rather than borrowed from the CLI.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_SH = path.join(REPO_ROOT, 'scripts', 'sanitize-scan.sh');

// Synthetic only. Real patterns live in a repository secret and never in a file.
const PATTERN = 'forbidden-token-[0-9]+';
const SECRET_TEXT = 'forbidden-token-123';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(file: string, content: string, message: string): string {
  writeFileSync(path.join(repo, file), content);
  git('add', file);
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

function scan(event: string, extraEnv: Record<string, string> = {}) {
  // The CI runner exports its own GITHUB_* values; each case sets only its own.
  const env: NodeJS.ProcessEnv = { ...process.env, SANITIZE_PATTERNS: PATTERN };
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_HEAD_REF;
  Object.assign(env, extraEnv);
  if (event) env.GITHUB_EVENT_NAME = event;
  const r = spawnSync('bash', [SCAN_SH], { cwd: repo, env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

let clean: string;
let dirty: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'sanitize-scan-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  clean = commit('a.txt', 'hello\n', 'clean base');
  dirty = commit('b.txt', `fixture ${SECRET_TEXT}\n`, 'add fixture');
  // Published state: main is clean; the dirty commit is somebody else's branch.
  git('update-ref', 'refs/remotes/origin/main', clean);
  git('checkout', '-q', '--detach', clean);
  git('branch', '-q', '-D', 'main');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('sanitize-scan.sh — pull_request scope', () => {
  it('passes a clean PR even when another branch is dirty', () => {
    git('update-ref', 'refs/remotes/origin/feature/dirty', dirty);
    const r = scan('pull_request');
    expect(r.out).toContain('sanitize-scan: clean');
    expect(r.status).toBe(0);
  });

  it('fails a PR whose own commits carry a hit, naming the commit', () => {
    git('checkout', '-q', '--detach', dirty);
    const r = scan('pull_request');
    expect(r.status).toBe(1);
    expect(r.out).toContain(dirty);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('fails a PR whose commit message carries a hit, naming the commit', () => {
    writeFileSync(path.join(repo, 'c.txt'), 'ok\n');
    git('add', 'c.txt');
    git('commit', '-q', '-m', `see ${SECRET_TEXT}`);
    const bad = git('rev-parse', 'HEAD');
    const r = scan('pull_request');
    expect(r.status).toBe(1);
    expect(r.out).toContain(bad);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('fails a PR whose head branch name is a hit, without printing it', () => {
    const r = scan('pull_request', { GITHUB_HEAD_REF: 'fix/forbidden-token-9' });
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });
});

describe('sanitize-scan.sh — push scope', () => {
  it('fails when any published branch is dirty and names that branch and commit', () => {
    git('update-ref', 'refs/remotes/origin/feature/dirty', dirty);
    const r = scan('push');
    expect(r.status).toBe(1);
    expect(r.out).toContain('origin/feature/dirty');
    expect(r.out).toContain(dirty);
    expect(r.out).toContain('no attributed hit is in HEAD');
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('says so when HEAD itself carries the hit', () => {
    git('update-ref', 'refs/remotes/origin/main', dirty);
    git('checkout', '-q', '--detach', dirty);
    const r = scan('push');
    expect(r.status).toBe(1);
    expect(r.out).toContain('HEAD itself carries a hit');
  });

  it('attributes a hit whatever its letter case', () => {
    writeFileSync(path.join(repo, 'd.txt'), 'FORBIDDEN-TOKEN-7\n');
    git('add', 'd.txt');
    git('commit', '-q', '-m', 'upper');
    const bad = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/feature/upper', bad);
    const r = scan('push');
    expect(r.status).toBe(1);
    expect(r.out).toContain(bad);
    expect(r.out).not.toMatch(/forbidden-token-\d/i);
  });

  it('ignores a leftover PR merge ref from an earlier run', () => {
    git('update-ref', 'refs/remotes/pull/9/merge', dirty);
    const r = scan('push');
    expect(r.out).toContain('sanitize-scan: clean');
    expect(r.status).toBe(0);
  });

  it('scans tags', () => {
    git('tag', 'v1', dirty);
    const r = scan('push');
    expect(r.status).toBe(1);
    expect(r.out).toContain(dirty);
  });

  it('redacts a branch whose name is itself a hit', () => {
    git('update-ref', 'refs/remotes/origin/forbidden-token-9', dirty);
    const r = scan('push');
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('treats a local run like a push', () => {
    git('update-ref', 'refs/remotes/origin/feature/dirty', dirty);
    expect(scan('').status).toBe(1);
  });
});

describe('sanitize-scan.sh — fails closed', () => {
  it('errors outside a repository instead of reporting clean', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'sanitize-scan-empty-'));
    try {
      const r = spawnSync('bash', [SCAN_SH], {
        cwd: empty,
        env: { ...process.env, SANITIZE_PATTERNS: PATTERN, GITHUB_EVENT_NAME: 'push' },
        encoding: 'utf8',
      });
      expect(r.stdout).not.toContain('sanitize-scan: clean');
      expect(r.status).toBe(2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('errors when history cannot be read instead of reporting clean', () => {
    // Remove the loose object behind a.txt: listing history now fails.
    const blob = git('rev-parse', `${clean}:a.txt`);
    rmSync(path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const r = scan('pull_request');
    expect(r.out).not.toContain('sanitize-scan: clean');
    expect(r.status).toBe(2);
  });
});

it('refuses to run without patterns', () => {
  const r = spawnSync('bash', [SCAN_SH], {
    cwd: repo,
    env: { ...process.env, SANITIZE_PATTERNS: '' },
    encoding: 'utf8',
  });
  expect(r.status).toBe(2);
});
