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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('catches a hit that is only a path name, without printing it', () => {
    writeFileSync(path.join(repo, 'forbidden-token-5.txt'), 'nothing here\n');
    git('add', 'forbidden-token-5.txt');
    git('commit', '-q', '-m', 'add file');
    git('update-ref', 'refs/remotes/origin/feature/path', git('rev-parse', 'HEAD'));
    git('checkout', '-q', '--detach', clean);
    const r = scan('push');
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('catches an annotated tag message on push, and leaves it out of a PR verdict', () => {
    git('tag', '-a', 'v2', '-m', `note ${SECRET_TEXT}`, clean);
    const push = scan('push');
    expect(push.status).toBe(1);
    expect(push.out).not.toMatch(/forbidden-token-\d/);
    expect(scan('pull_request').status).toBe(0);
  });

  it('catches a tag whose name is a hit, without printing it', () => {
    git('tag', 'forbidden-token-3', clean);
    const r = scan('push');
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('never prints the pattern itself, even one git cannot compile', () => {
    // BSD grep accepts a lazy quantifier that git's regcomp rejects; git's error
    // message quotes the whole pattern — the secret — into a public log.
    git('update-ref', 'refs/remotes/origin/feature/dirty', dirty);
    const r = scan('push', { SANITIZE_PATTERNS: 'forbidden-token-[0-9]+?' });
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain('[0-9]+?');
  });

  it('treats a local run like a push', () => {
    git('update-ref', 'refs/remotes/origin/feature/dirty', dirty);
    expect(scan('').status).toBe(1);
  });
});

/**
 * Incident #610 (2026-10-30): commit 9d7422e1 (#586) carried a hit into main, deploy/dev and a dev
 * tag, and from then on every PR failed `scan` on that one commit — a PR is judged on what it would
 * merge, and that includes main. The owner's decision: record the already-published commit as a known
 * leak. What it added stays tolerated wherever it persists; anything else still fails — a different
 * hit, another commit adding the same text again, a branch or tag name, an annotated tag message.
 */
describe('sanitize-scan.sh — known leaks', () => {
  function listKnown(...lines: string[]) {
    // Untracked, like the checkout CI scans: the list file itself is not part of the synthetic history.
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, 'scripts', 'sanitize-known-leaks.txt'), `${lines.join('\n')}\n`);
  }

  // The leak is published: main carries the dirty commit, and work continues on top of it.
  function publishDirtyMain(): string {
    git('checkout', '-q', '--detach', dirty);
    const next = commit('c.txt', 'later work\n', 'later work');
    git('update-ref', 'refs/remotes/origin/main', next);
    return next;
  }

  it('passes push and PR scans once the published commit is listed, naming it as exempted', () => {
    publishDirtyMain();
    listKnown('# known leaks', `${dirty}  #610 already published`);
    for (const event of ['push', 'pull_request']) {
      const r = scan(event);
      expect(r.out, event).toContain('sanitize-scan: clean');
      expect(r.out, event).toContain(`known leak ${dirty}`);
      expect(r.out, event).not.toMatch(/forbidden-token-\d/);
      expect(r.status, event).toBe(0);
    }
  });

  it('fails without the entry — the same history is red until it is listed', () => {
    publishDirtyMain();
    const r = scan('pull_request');
    expect(r.status).toBe(1);
    expect(r.out).toContain(dirty);
  });

  it('still fails a different hit next to the known leak, naming only the new commit as a hit', () => {
    publishDirtyMain();
    listKnown(dirty);
    const bad = commit('d.txt', 'fixture forbidden-token-456\n', 'another fixture');
    const r = scan('pull_request');
    expect(r.status).toBe(1);
    expect(r.out).toContain(`hit in commit ${bad}`);
    expect(r.out).not.toContain(`hit in commit ${dirty}`);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('fails another commit that adds the known text again', () => {
    publishDirtyMain();
    listKnown(dirty);
    const copy = commit('e.txt', `copied ${SECRET_TEXT}\n`, 'copy');
    const r = scan('pull_request');
    expect(r.status).toBe(1);
    expect(r.out).toContain(`hit in commit ${copy}`);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('fails a commit message that repeats the known text', () => {
    publishDirtyMain();
    listKnown(dirty);
    writeFileSync(path.join(repo, 'f.txt'), 'ok\n');
    git('add', 'f.txt');
    git('commit', '-q', '-m', `follow-up to ${SECRET_TEXT}`);
    const bad = git('rev-parse', 'HEAD');
    const r = scan('pull_request');
    expect(r.status).toBe(1);
    expect(r.out).toContain(`hit in commit ${bad}`);
  });

  it('passes a later commit that removes the known leak', () => {
    publishDirtyMain();
    listKnown(dirty);
    git('rm', '-q', 'b.txt');
    git('commit', '-q', '-m', 'drop fixture');
    const r = scan('pull_request');
    expect(r.out).toContain('sanitize-scan: clean');
    expect(r.status).toBe(0);
  });

  it('never exempts a branch name, a tag name or an annotated tag message', () => {
    publishDirtyMain();
    listKnown(dirty);
    git('update-ref', `refs/remotes/origin/${SECRET_TEXT}`, dirty);
    expect(scan('push').status).toBe(1);
    git('update-ref', '-d', `refs/remotes/origin/${SECRET_TEXT}`);
    git('tag', SECRET_TEXT, dirty);
    expect(scan('push').status).toBe(1);
    git('tag', '-d', SECRET_TEXT);
    git('tag', '-a', 'v3', '-m', `note ${SECRET_TEXT}`, dirty);
    const r = scan('push');
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('refuses an abbreviated or malformed entry instead of guessing', () => {
    publishDirtyMain();
    listKnown(dirty.slice(0, 8));
    const r = scan('pull_request');
    expect(r.out).not.toContain('sanitize-scan: clean');
    expect(r.status).toBe(2);
  });

  it('exempts nothing for an entry that is not in the clone, and says so', () => {
    publishDirtyMain();
    listKnown('0123456789abcdef0123456789abcdef01234567');
    const r = scan('pull_request');
    expect(r.status).toBe(1);
    expect(r.out).toContain('0123456789abcdef0123456789abcdef01234567');
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
