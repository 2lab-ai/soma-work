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
  delete env.GITHUB_BASE_REF;
  delete env.GITHUB_EVENT_PATH;
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
 * Incident #610 (2026-10-30): commit 9d7422e1 (#586) carried a hit into main, deploy/dev and two dev
 * tags, and from then on every PR failed `scan` on that one commit — a PR is judged on what it would
 * merge, and that includes main. The owner's decision: record the already-published commit as a known
 * leak. What it added stays tolerated wherever it persists; anything else still fails — a different
 * hit, another commit adding the same text again (in a binary file or a merge's own resolution too),
 * any path name, a branch or tag name, an annotated tag message, and a commit that lists itself.
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

  // A pull_request run as GitHub sets it up: the PR targets main.
  function prScan(extraEnv: Record<string, string> = {}) {
    return scan('pull_request', { GITHUB_BASE_REF: 'main', ...extraEnv });
  }

  // A push run as GitHub sets it up: the event file names main as it was before the push.
  function pushScan(before: string) {
    const event = path.join(repo, '.git', 'event.json');
    const after = git('rev-parse', 'HEAD');
    writeFileSync(event, JSON.stringify({ ref: 'refs/heads/main', before, after }, null, 2));
    return scan('push', { GITHUB_EVENT_PATH: event });
  }

  // Each failure below must fail with the listed commit exempted — not because nothing was.
  function expectNewHit(r: { status: number | null; out: string }, bad: string) {
    expect(r.out).toContain(`known leak ${dirty} — exempted`);
    expect(r.out).toContain(`hit in commit ${bad}`);
    expect(r.out).not.toContain(`hit in commit ${dirty}`);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
    expect(r.status).toBe(1);
  }

  it('passes push and PR scans once the published commit is listed, naming it as exempted', () => {
    const next = publishDirtyMain();
    listKnown('# known leaks', `${dirty}  #610 already published`);
    for (const r of [pushScan(next), prScan()]) {
      expect(r.out).toContain('sanitize-scan: clean');
      expect(r.out).toContain(`known leak ${dirty} — exempted`);
      expect(r.out).not.toMatch(/forbidden-token-\d/);
      expect(r.status).toBe(0);
    }
  });

  it('fails without the entry — the same history is red until it is listed', () => {
    publishDirtyMain();
    const r = prScan();
    expect(r.status).toBe(1);
    expect(r.out).toContain(`hit in commit ${dirty}`);
  });

  it('reads an entry on a last line without a newline', () => {
    publishDirtyMain();
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, 'scripts', 'sanitize-known-leaks.txt'), dirty);
    expect(prScan().status).toBe(0);
  });

  it('still fails a different hit next to the known leak, naming only the new commit as a hit', () => {
    publishDirtyMain();
    listKnown(dirty);
    const bad = commit('d.txt', 'fixture forbidden-token-456\n', 'another fixture');
    expectNewHit(prScan(), bad);
  });

  it('fails another commit that adds the known text again', () => {
    publishDirtyMain();
    listKnown(dirty);
    const bad = commit('e.txt', `copied ${SECRET_TEXT}\n`, 'copy');
    expectNewHit(prScan(), bad);
  });

  it('fails a commit that adds the known text again in a binary file', () => {
    publishDirtyMain();
    listKnown(dirty);
    const bad = commit('dump.bin', `\u0000${SECRET_TEXT}\n`, 'binary');
    expectNewHit(prScan(), bad);
  });

  it('fails a commit that adds the known text again in a file marked -diff', () => {
    publishDirtyMain();
    listKnown(dirty);
    writeFileSync(path.join(repo, '.gitattributes'), '*.dat -diff\n');
    writeFileSync(path.join(repo, 'd.dat'), `${SECRET_TEXT}\n`);
    git('add', '.gitattributes', 'd.dat');
    git('commit', '-q', '-m', 'opaque');
    expectNewHit(prScan(), git('rev-parse', 'HEAD'));
  });

  it('fails a merge whose own resolution adds the known text again, and passes a clean merge', () => {
    const next = publishDirtyMain();
    listKnown(dirty);
    // A side branch from before the leak, merged with main: nothing of its own.
    git('checkout', '-q', '--detach', clean);
    commit('side.txt', 'side work\n', 'side work');
    git('merge', '-q', '--no-ff', '-m', 'merge main', next);
    const r = prScan();
    expect(r.out).toContain('sanitize-scan: clean');
    expect(r.status).toBe(0);
    // An evil merge: the resolution adds a file nobody committed.
    git('checkout', '-q', '--detach', clean);
    commit('side2.txt', 'more side work\n', 'side work 2');
    git('merge', '-q', '--no-ff', '--no-commit', next);
    writeFileSync(path.join(repo, 'evil.txt'), `${SECRET_TEXT}\n`);
    git('add', 'evil.txt');
    git('commit', '-q', '-m', 'merge main');
    expectNewHit(prScan(), git('rev-parse', 'HEAD'));
  });

  it('fails a commit message that repeats the known text', () => {
    publishDirtyMain();
    listKnown(dirty);
    writeFileSync(path.join(repo, 'f.txt'), 'ok\n');
    git('add', 'f.txt');
    git('commit', '-q', '-m', `follow-up to ${SECRET_TEXT}`);
    expectNewHit(prScan(), git('rev-parse', 'HEAD'));
  });

  it('fails a commit whose author or committer carries the known text', () => {
    publishDirtyMain();
    listKnown(dirty);
    writeFileSync(path.join(repo, 'g.txt'), 'ok\n');
    git('add', 'g.txt');
    git('-c', `user.name=${SECRET_TEXT}`, 'commit', '-q', '-m', 'ordinary message');
    expectNewHit(prScan(), git('rev-parse', 'HEAD'));
  });

  it('never exempts an annotated tag, even one nested under another tag', () => {
    const next = publishDirtyMain();
    listKnown(dirty);
    git('tag', '-a', 'inner', '-m', `note ${SECRET_TEXT}`, dirty);
    git('-c', 'advice.nestedTag=false', 'tag', '-a', 'outer', '-m', 'ok', 'inner');
    git('tag', '-d', 'inner');
    const r = pushScan(next);
    expect(r.out).toContain(`known leak ${dirty} — exempted`);
    expect(r.out).toContain('an annotated tag message is a hit');
    expect(r.out).not.toMatch(/forbidden-token-\d/);
    expect(r.status).toBe(1);
  });

  it("never lets git's own warnings print the matching text", () => {
    // An invalid attribute name in a tracked .gitattributes makes `git show` warn, quoting the name.
    publishDirtyMain();
    listKnown(dirty);
    const bad = commit('.gitattributes', `* ${SECRET_TEXT}!\n`, 'attributes');
    expectNewHit(prScan(), bad);
  });

  it('never exempts a path name, even one equal to the known text', () => {
    publishDirtyMain();
    listKnown(dirty);
    commit(`${SECRET_TEXT}.txt`, 'nothing here\n', 'add file');
    const r = prScan();
    expect(r.out).not.toContain('sanitize-scan: clean');
    expect(r.out).not.toMatch(/forbidden-token-\d/);
    expect(r.status).toBe(1);
  });

  it('passes a later commit that removes the known leak', () => {
    publishDirtyMain();
    listKnown(dirty);
    git('rm', '-q', 'b.txt');
    git('commit', '-q', '-m', 'drop fixture');
    const r = prScan();
    expect(r.out).toContain('sanitize-scan: clean');
    expect(r.status).toBe(0);
  });

  it('never exempts a branch name, a tag name or an annotated tag message', () => {
    const next = publishDirtyMain();
    listKnown(dirty);
    expect(pushScan(next).status).toBe(0);
    git('update-ref', `refs/remotes/origin/${SECRET_TEXT}`, dirty);
    expect(pushScan(next).status).toBe(1);
    git('update-ref', '-d', `refs/remotes/origin/${SECRET_TEXT}`);
    git('tag', SECRET_TEXT, dirty);
    expect(pushScan(next).status).toBe(1);
    git('tag', '-d', SECRET_TEXT);
    git('tag', '-a', 'v3', '-m', `note ${SECRET_TEXT}`, dirty);
    const r = pushScan(next);
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
  });

  it('exempts nothing for a commit that is not on the PR base yet — a change cannot list itself', () => {
    // main stays clean; the PR's own commit carries the hit and lists itself.
    git('checkout', '-q', '--detach', dirty);
    listKnown(dirty);
    const r = prScan();
    expect(r.out).toContain(`known leak ${dirty} is not on the published base`);
    expect(r.out).toContain(`hit in commit ${dirty}`);
    expect(r.status).toBe(1);
    // …and a PR run that does not know its base exempts nothing either.
    publishDirtyMain();
    expect(scan('pull_request').status).toBe(1);
  });

  it('on push, exempts only a commit main already had before the push', () => {
    const next = publishDirtyMain();
    listKnown(dirty);
    const pushed = pushScan(clean);
    expect(pushed.out).toContain('is not on the published base');
    expect(pushed.status).toBe(1);
    expect(pushScan(next).status).toBe(0);
    // A push run without its event file has no base: nothing exempted.
    const bare = scan('push');
    expect(bare.out).toContain('is not on the published base');
    expect(bare.status).toBe(1);
  });

  it('fails a tag that points straight at a blob carrying the known text', () => {
    const next = publishDirtyMain();
    listKnown(dirty);
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      input: `copy ${SECRET_TEXT}\n`,
      encoding: 'utf8',
    }).trim();
    git('tag', 'loose', blob);
    const r = pushScan(next);
    expect(r.out).toContain(`known leak ${dirty} — exempted`);
    expect(r.out).not.toMatch(/forbidden-token-\d/);
    expect(r.status).toBe(1);
  });

  // A merge built from a chosen tree and parents: what a resolution leaves behind.
  function mergeOf(files: Record<string, string>, ...parents: string[]): string {
    git('checkout', '-q', '--detach', parents[0]);
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(path.join(repo, file), content);
      git('add', file);
    }
    const tree = git('write-tree');
    const merge = git('commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', 'merge');
    git('checkout', '-q', '--detach', merge);
    return merge;
  }

  it('fails a merge that creates the known text, even for a pattern anchored at the line start', () => {
    // Line-start known text, published and listed.
    git('checkout', '-q', '--detach', clean);
    const leak = commit('k.txt', `${SECRET_TEXT}\n`, 'leak at line start');
    git('update-ref', 'refs/remotes/origin/main', leak);
    listKnown(leak);
    const anchored = { SANITIZE_PATTERNS: '^forbidden-token-[0-9]+' };
    git('checkout', '-q', '--detach', clean);
    const side = commit('side.txt', 'side\n', 'side');
    // The merge keeps main's file and its own resolution adds a new one starting with the known text:
    // `++` in its combined diff. (Identical content under a new name would be a rename of main's file.)
    const merge = mergeOf({ 'k.txt': `${SECRET_TEXT}\n`, 'evil.txt': `${SECRET_TEXT} again\n` }, side, leak);
    const r = prScan(anchored);
    expect(r.out).toContain(`known leak ${leak} — exempted`);
    expect(r.out).toContain(`hit in commit ${merge}`);
    expect(r.status).toBe(1);
  });

  it('passes a merge that keeps the known line from one parent while resolving the line next to it, in either parent order', () => {
    git('checkout', '-q', '--detach', clean);
    const base = commit('k.txt', 'one\ntwo\n', 'base');
    const leak = commit('k.txt', `one\nfixture ${SECRET_TEXT}\ntwo\n`, 'leak');
    git('update-ref', 'refs/remotes/origin/main', leak);
    listKnown(leak);
    git('checkout', '-q', '--detach', base);
    const feature = commit('k.txt', 'one\nfeature line\ntwo\n', 'feature');
    const resolved = { 'k.txt': `one\nfixture ${SECRET_TEXT}\nfeature line\ntwo\n` };
    for (const parents of [
      [feature, leak],
      [leak, feature],
    ]) {
      const merge = mergeOf(resolved, ...parents);
      git('update-ref', 'refs/remotes/origin/feature/x', merge);
      const r = pushScan(leak);
      expect(r.out, parents.join(' ')).toContain('sanitize-scan: clean');
      expect(r.status, parents.join(' ')).toBe(0);
    }
  });

  it('refuses an abbreviated or malformed entry instead of guessing', () => {
    publishDirtyMain();
    listKnown(dirty.slice(0, 8));
    const r = prScan();
    expect(r.out).not.toContain('sanitize-scan: clean');
    expect(r.status).toBe(2);
  });

  it('exempts nothing for an entry that is not in the clone, and says so', () => {
    publishDirtyMain();
    listKnown('0123456789abcdef0123456789abcdef01234567');
    const r = prScan();
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
