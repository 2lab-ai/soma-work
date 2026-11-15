/**
 * .prd/26 §3 · .prd/27 §4–§5 — one checkout's local layers, against real git repositories in a temp folder.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutChanges, sessionCommits } from '../checkout-changes';
import { capPatch, joinDiff, newFilePatch, parseNumstatZ, splitPatch } from '../git-diff-parse';
import { commandKeys, configSafe } from '../git-runner';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

const BASE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    env: { ...BASE_ENV, ...env },
    stdio: 'pipe',
  })
    .toString()
    .trim();
}
function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function commitAll(dir: string, msg: string, env: Record<string, string> = {}): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg], env);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** An "origin" with one commit on main, cloned into `<session>/<name>` with a GitHub-looking origin URL. */
function clone(session: string, name: string): string {
  const origin = path.join(session, '..', `${path.basename(session)}-${name}-origin`);
  roots.push(origin);
  fs.mkdirSync(origin, { recursive: true });
  git(origin, ['init', '-q', '-b', 'main']);
  write(origin, 'src/a.ts', 'one\ntwo\nthree\n');
  write(origin, 'README.md', '# r\n');
  commitAll(origin, 'init');
  const dir = path.join(session, name);
  git(session, ['clone', '-q', origin, dir]);
  git(dir, ['remote', 'set-url', 'origin', `https://github.com/acme/${name}.git`]);
  return dir;
}

describe('git-diff-parse', () => {
  it('numstat -z: plain, rename, binary', () => {
    const out = '3\t1\tsrc/a.ts\0' + '0\t0\t\0old.ts\0new.ts\0' + '-\t-\timg.png\0';
    expect(parseNumstatZ(out)).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1, binary: false },
      { path: 'new.ts', oldPath: 'old.ts', additions: 0, deletions: 0, binary: false },
      { path: 'img.png', additions: 0, deletions: 0, binary: true },
    ]);
  });

  it('splitPatch → status per file; joinDiff matches sections by the b/ path', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/x.ts',
      '@@ -0,0 +1 @@',
      '+hi',
      'diff --git a/y.ts b/y.ts',
      'deleted file mode 100644',
      '--- a/y.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '',
    ].join('\n');
    const sections = splitPatch(patch);
    expect(sections.map((s) => s.status)).toEqual(['added', 'deleted']);
    const files = joinDiff(
      [
        { path: 'x.ts', additions: 1, deletions: 0, binary: false },
        { path: 'y.ts', additions: 0, deletions: 1, binary: false },
      ],
      sections,
    );
    expect(files[0]).toMatchObject({ path: 'x.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+hi' });
    expect(files[1]).toMatchObject({ path: 'y.ts', status: 'deleted', patch: '@@ -1 +0,0 @@\n-bye' });
  });

  it('newFilePatch adds every line; a missing final newline is marked', () => {
    expect(newFilePatch('a\nb\n')).toEqual({ patch: '@@ -0,0 +1,2 @@\n+a\n+b', additions: 2 });
    expect(newFilePatch('a').patch).toBe('@@ -0,0 +1,1 @@\n+a\n\\ No newline at end of file');
    expect(newFilePatch('')).toEqual({ patch: '', additions: 0 });
  });

  it('capPatch cuts at a line boundary under the budget', () => {
    const { patch, truncated } = capPatch('aaaa\nbbbb\ncccc', 8);
    expect(truncated).toBe(true);
    expect(patch).toBe('aaaa');
  });
});

describe('git-runner gate', () => {
  it('commandKeys ignores the command scope (our own -c flags) and lists repository keys that run commands', () => {
    const listing = [
      'command\tcore.fsmonitor',
      'command\tdiff.external',
      'local\tcore.bare',
      'local\tfilter.lfs.clean',
      'worktree\tdiff.x.textconv',
    ].join('\n');
    expect(commandKeys(listing)).toEqual(['filter.lfs.clean', 'diff.x.textconv']);
  });

  it('A10 — a repository whose config names a clean filter is not read; the filter never runs', async () => {
    const session = tmp('cc-a10-');
    const dir = clone(session, 'svc');
    const marker = path.join(session, 'FILTER-RAN');
    git(dir, ['config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`]);
    write(dir, '.gitattributes', '*.ts filter=evil\n');
    write(dir, 'src/a.ts', 'changed\n');
    expect(await configSafe(dir)).toEqual({ safe: false, reason: 'repo-config-runs-commands' });
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c?.uncommitted).toMatchObject({ files: [], skipped: 'repo-config-runs-commands' });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('checkoutSafety — the doors the #1299 review found', () => {
  it('a signed-looking commit with gpg.program + log.showSignature: the program never runs, the checkout is not read', async () => {
    const session = tmp('cc-gpg-');
    const dir = clone(session, 'svc');
    const marker = path.join(session, 'GPG-RAN');
    const evil = path.join(session, 'evil.sh');
    fs.writeFileSync(evil, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
    const tree = git(dir, ['rev-parse', 'HEAD^{tree}']);
    const parent = git(dir, ['rev-parse', 'HEAD']);
    const body = [
      `tree ${tree}`,
      `parent ${parent}`,
      'author t <t@t> 1794756694 +0000',
      'committer t <t@t> 1794756694 +0000',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ' -----END PGP SIGNATURE-----',
      '',
      'signed',
      '',
    ].join('\n');
    const raw = path.join(session, 'commit.txt');
    fs.writeFileSync(raw, body);
    const sha = git(dir, ['hash-object', '-t', 'commit', '-w', raw]);
    git(dir, ['update-ref', 'HEAD', sha]);
    git(dir, ['config', 'log.showSignature', 'true']);
    git(dir, ['config', 'gpg.program', evil]);
    const c = await checkoutChanges({ dir, sessionRoot: session, sessionStartedAt: Date.now() - 3600_000 });
    expect(c?.uncommitted.skipped).toBe('repo-config-runs-commands');
    expect(c?.committed.files).toEqual([]);
    expect(await sessionCommits(dir, 0, new Set())).toBeDefined();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('core.worktree pointing outside the session: not this session’s checkout (nothing read)', async () => {
    const session = tmp('cc-wt-');
    const outside = tmp('cc-wt-outside-');
    fs.writeFileSync(path.join(outside, '.env'), 'SECRET_TOKEN=leak\n');
    const dir = clone(session, 'svc');
    git(dir, ['config', 'core.worktree', outside]);
    expect(await checkoutChanges({ dir, sessionRoot: session })).toBeUndefined();
  });

  it('core.worktree inside the session is refused by the gate', async () => {
    const session = tmp('cc-wt2-');
    const dir = clone(session, 'svc');
    const other = path.join(session, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'x.txt'), 'x\n');
    git(dir, ['config', 'core.worktree', other]);
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c?.uncommitted).toMatchObject({ files: [], skipped: 'repo-config-runs-commands' });
  });

  it('a .git file naming a repository outside the session: not read', async () => {
    const session = tmp('cc-gitfile-');
    const elsewhere = tmp('cc-gitfile-other-');
    const victim = clone(elsewhere, 'victim');
    write(victim, 'secret.txt', 'other user data\n');
    const dir = path.join(session, 'x');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(victim, '.git')}\n`);
    expect(await checkoutChanges({ dir, sessionRoot: session })).toBeUndefined();
  });

  it('objects/info/alternates (another object store) is refused', async () => {
    const session = tmp('cc-alt-');
    const dir = clone(session, 'svc');
    fs.mkdirSync(path.join(dir, '.git', 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'objects', 'info', 'alternates'), '/somewhere/objects\n');
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c?.uncommitted.skipped).toBe('repo-alternates');
  });
});

describe('checkoutChanges — the two local layers', () => {
  it('A1 — uncommitted: modified + new file (no symlink); committed: the branch commit past origin/main', async () => {
    const session = tmp('cc-a1-');
    const dir = clone(session, 'web');
    git(dir, ['checkout', '-q', '-b', 'feat/x']);
    write(dir, 'src/b.ts', 'b1\nb2\n');
    commitAll(dir, 'add b');
    write(dir, 'src/a.ts', 'one\nTWO\nthree\n');
    write(dir, 'notes/new.md', 'hello\nworld\n');
    const outside = path.join(session, 'secret.txt');
    fs.writeFileSync(outside, 'do not read\n');
    fs.symlinkSync(outside, path.join(dir, 'link.txt'));

    const c = await checkoutChanges({ dir, sessionRoot: session, sessionStartedAt: Date.now() - 3600_000 });
    expect(c).toMatchObject({ repo: 'acme/web', dir: 'web', branch: 'feat/x' });
    const un = c!.uncommitted;
    expect(un.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['notes/new.md', 'added', 2, 0],
      ['src/a.ts', 'modified', 1, 1],
    ]);
    expect(un.files[1].patch).toContain('-two');
    expect(un.files[1].patch).toContain('+TWO');
    expect(JSON.stringify(un)).not.toContain('do not read');
    expect(c!.committed.files.map((f) => [f.path, f.status, f.additions])).toEqual([['src/b.ts', 'added', 2]]);
    expect(c!.committed.commits.map((x) => x.subject)).toEqual(['add b']);
  });

  it('a session PR head on this branch bounds the committed layer: only the commits after it', async () => {
    const session = tmp('cc-pr-');
    const dir = clone(session, 'api');
    git(dir, ['checkout', '-q', '-b', 'feat/y']);
    write(dir, 'one.ts', '1\n');
    const prHead = commitAll(dir, 'in the PR');
    write(dir, 'two.ts', '2\n');
    commitAll(dir, 'after the PR');
    const c = await checkoutChanges({
      dir,
      sessionRoot: session,
      prHeads: [{ headRef: 'feat/y', headSha: prHead, createdAt: Date.now() }],
    });
    expect(c!.committed.base).toBe(prHead);
    expect(c!.committed.files.map((f) => f.path)).toEqual(['two.ts']);
  });

  it('stacked branches: a session PR head under HEAD on another branch is the base (committed ≠ that PR again)', async () => {
    const session = tmp('cc-stack-');
    const dir = clone(session, 'api');
    git(dir, ['checkout', '-q', '-b', 'feat/base']);
    write(dir, 'one.ts', '1\n');
    const prHead = commitAll(dir, 'in the first PR');
    git(dir, ['checkout', '-q', '-b', 'feat/next']);
    write(dir, 'two.ts', '2\n');
    commitAll(dir, 'on the next branch');
    const c = await checkoutChanges({
      dir,
      sessionRoot: session,
      prHeads: [
        { headRef: 'feat/base', headSha: prHead, createdAt: Date.now() },
        { headRef: 'feat/next', headSha: 'f'.repeat(40), createdAt: Date.now() },
      ],
    });
    expect(c!.committed.base).toBe(prHead);
    expect(c!.committed.files.map((f) => f.path)).toEqual(['two.ts']);
  });

  it('no remote: commits since the session started, not the earlier history', async () => {
    const session = tmp('cc-local-');
    const dir = path.join(session, 'scratch');
    fs.mkdirSync(dir);
    git(dir, ['init', '-q', '-b', 'main']);
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    write(dir, 'old.txt', 'old\n');
    commitAll(dir, 'before', { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
    write(dir, 'new.txt', 'new\n');
    commitAll(dir, 'during');
    const c = await checkoutChanges({ dir, sessionRoot: session, sessionStartedAt: Date.now() - 3600_000 });
    expect(c!.repo).toBe('local:scratch');
    expect(c!.committed.files.map((f) => f.path)).toEqual(['new.txt']);
    expect(c!.uncommitted.files).toEqual([]);
  });

  it('a clean checkout on main has no change; a folder that is not a checkout is undefined', async () => {
    const session = tmp('cc-clean-');
    const dir = clone(session, 'lib');
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files).toEqual([]);
    expect(c!.committed.files).toEqual([]);
    const plain = path.join(session, 'plain');
    fs.mkdirSync(plain);
    expect(await checkoutChanges({ dir: plain })).toBeUndefined();
  });
});

describe('sessionCommits — HEAD reflog commits since the session started', () => {
  it('counts commits and amends made here after `since`, not the clone, and skips counted shas', async () => {
    const session = tmp('cc-reflog-');
    const dir = clone(session, 'svc');
    const since = Date.now() - 1000;
    write(dir, 'a.txt', 'a\nb\n');
    const first = commitAll(dir, 'one');
    write(dir, 'c.txt', 'c\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '--amend', '-m', 'one, amended']);
    const amended = git(dir, ['rev-parse', 'HEAD']);
    const all = await sessionCommits(dir, since, new Set());
    expect(all.map((c) => c.sha).sort()).toEqual([first, amended].sort());
    expect(all.find((c) => c.sha === amended)).toMatchObject({ additions: 3, deletions: 0 });
    expect((await sessionCommits(dir, since, new Set([first]))).map((c) => c.sha)).toEqual([amended]);
    expect(await sessionCommits(dir, Date.now() + 60_000, new Set())).toEqual([]);
  });
});
