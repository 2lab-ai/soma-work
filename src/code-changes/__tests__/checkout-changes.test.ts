/**
 * .prd/26 §3 · .prd/27 §4–§5 — one checkout's local layers, against real git repositories in a temp folder.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutChanges, readInside, sessionCommits } from '../checkout-changes';
import { capPatch, joinDiff, lineCounts, newFilePatch, parseNumstatZ, splitPatch } from '../git-diff-parse';
import { commandKeys, configSafe, type GitRun, runGit, trustedRoots } from '../git-runner';
import { PathWitness } from '../path-witness';
import type { PullAsk } from '../pr-changes';

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

describe('the check/use race (#1299 review): no defence rests on the gate alone', () => {
  it('a clean filter installed right after the gate passed never runs, and the read it raced is thrown away', async () => {
    const session = tmp('cc-race-');
    const dir = clone(session, 'svc');
    const marker = path.join(session, 'FILTER-RAN');
    write(dir, 'src/a.ts', 'changed by the model\n');
    write(dir, 'src/new.ts', 'new\n');
    git(dir, ['add', 'src/new.ts']);
    let armed = false;
    // The model wins the race: the config and attributes appear between the gate and every later call.
    const racing: GitRun = async (d, args) => {
      const out = await runGit(d, args);
      if (!armed && args.includes('--show-scope')) {
        armed = true;
        git(dir, ['config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`]);
        git(dir, ['config', 'filter.evil.smudge', `sh -c 'touch ${marker}; cat'`]);
        write(dir, '.gitattributes', '* filter=evil\n');
      }
      return out;
    };
    const c = await checkoutChanges({ dir, sessionRoot: session, git: racing });
    expect(armed).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    // The config was rewritten during the read: nothing of it is kept.
    expect(c!.uncommitted).toMatchObject({ files: [], skipped: 'repo-changed-during-read' });
    expect(c!.committed).toMatchObject({ files: [], skipped: 'repo-changed-during-read' });
    expect(c!.repo).toBe('local:svc');
  });

  it('attributes naming a filter git knows nothing of: the change is read by this process, not by git', async () => {
    const session = tmp('cc-attr-');
    const dir = clone(session, 'svc');
    write(dir, 'src/a.ts', 'changed by the model\n');
    write(dir, '.gitattributes', '* filter=evil diff=evil\n');
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files.map((f) => [f.path, f.status])).toEqual([
      ['.gitattributes', 'added'],
      ['src/a.ts', 'modified'],
    ]);
    expect(c!.uncommitted.files[1].patch).toContain('+changed by the model');
  });

  it('a tracked file behind a symlinked parent folder is not read', async () => {
    const session = tmp('cc-parent-link-');
    const outside = tmp('cc-parent-link-out-');
    fs.writeFileSync(path.join(outside, 'a.ts'), 'secret\n');
    const dir = clone(session, 'svc');
    fs.rmSync(path.join(dir, 'src'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(dir, 'src'));
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(JSON.stringify(c)).not.toContain('secret');
  });

  it('an untracked file whose patch outgrows the per-file budget is cut and marked', async () => {
    const session = tmp('cc-big-');
    const dir = clone(session, 'svc');
    write(dir, 'many.txt', 'a\n'.repeat(100_000));
    const c = await checkoutChanges({ dir, sessionRoot: session });
    const f = c!.uncommitted.files.find((x) => x.path === 'many.txt')!;
    expect(f.patchTruncated).toBe(true);
    expect(Buffer.byteLength(f.patch ?? '', 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect(f.additions).toBe(100_000);
  });

  it('a PR head of another repository never bounds this checkout', async () => {
    const session = tmp('cc-fork-');
    const dir = clone(session, 'api');
    git(dir, ['checkout', '-q', '-b', 'feat/z']);
    write(dir, 'one.ts', '1\n');
    const sha = commitAll(dir, 'shared history');
    const c = await checkoutChanges({
      dir,
      sessionRoot: session,
      prHeads: [{ repo: 'someone/fork', headSha: sha }],
    });
    expect(c!.committed.base).not.toBe(sha);
    expect(c!.committed.files.map((f) => f.path)).toEqual(['one.ts']);
  });
});

describe('the third review round (#1299)', () => {
  it('a symlink inside the git dir (objects or refs pointed elsewhere) refuses the checkout', async () => {
    const session = tmp('cc-gitlink-');
    const elsewhere = tmp('cc-gitlink-other-');
    const victim = clone(elsewhere, 'victim');
    const dir = clone(session, 'svc');
    fs.symlinkSync(path.join(victim, '.git', 'refs', 'heads'), path.join(dir, '.git', 'refs', 'stolen'));
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c?.uncommitted.skipped).toBe('repo-links-outside');
    expect(c?.committed.files).toEqual([]);
  });

  it('a FIFO in the working tree does not hang the collect', async () => {
    const session = tmp('cc-fifo-');
    const dir = clone(session, 'svc');
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    write(dir, 'real.txt', 'r\n');
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files.map((f) => f.path)).toEqual(['real.txt']);
  }, 15_000);

  it('a pre-session commit merged in from a side line never replaces the session PR head as the base', async () => {
    const session = tmp('cc-cutoff-');
    const dir = clone(session, 'api');
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    git(dir, ['checkout', '-q', '-b', 'side']);
    write(dir, 'side.ts', 'old side work\n');
    commitAll(dir, 'side, before the session', { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['checkout', '-q', '-b', 'feat/pr']);
    write(dir, 'pr.ts', 'in the PR\n');
    const prHead = commitAll(dir, 'the PR');
    git(dir, ['merge', '-q', '--no-edit', 'side']);
    const c = await checkoutChanges({
      dir,
      sessionRoot: session,
      sessionStartedAt: Date.now() - 3600_000,
      prHeads: [{ headSha: prHead }],
    });
    expect(c!.committed.base).toBe(prHead);
    expect(c!.committed.files.map((f) => f.path)).toEqual(['side.ts']);
  });

  it('diff.noprefix in the repository does not lose the committed patches', async () => {
    const session = tmp('cc-noprefix-');
    const dir = clone(session, 'svc');
    git(dir, ['config', 'diff.noprefix', 'true']);
    git(dir, ['checkout', '-q', '-b', 'feat/n']);
    write(dir, 'src/a.ts', 'one\nTWO\nthree\n');
    commitAll(dir, 'edit');
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.committed.files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified' });
    expect(c!.committed.files[0].patch).toContain('+TWO');
  });

  it('staged-only changes (working tree equal to the index) are in the uncommitted layer', async () => {
    const session = tmp('cc-staged-');
    const dir = clone(session, 'svc');
    write(dir, 'src/a.ts', 'one\nstaged\nthree\n');
    git(dir, ['add', 'src/a.ts']);
    git(dir, ['rm', '-q', 'README.md']);
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['README.md', 'deleted', 0, 1],
      ['src/a.ts', 'modified', 1, 1],
    ]);
  });

  it('a large new file keeps its line count when its patch is not kept', async () => {
    const session = tmp('cc-lock-');
    const dir = clone(session, 'svc');
    write(dir, 'package-lock.json', 'x'.repeat(39) + '\n'.repeat(1) + 'y\n'.repeat(150_000));
    const c = await checkoutChanges({ dir, sessionRoot: session });
    const f = c!.uncommitted.files.find((x) => x.path === 'package-lock.json')!;
    expect(f).toMatchObject({ additions: 150_001, patchTruncated: true });
    expect(f.patch).toBeUndefined();
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
      prHeads: [{ headSha: prHead }],
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
      prHeads: [{ headSha: prHead }, { headSha: 'f'.repeat(40) }],
    });
    expect(c!.committed.base).toBe(prHead);
    expect(c!.committed.files.map((f) => f.path)).toEqual(['two.ts']);
  });

  it('a branch cut from main after the session PR merged: the merge-base is the base, not that PR head (others’ merges are not committed here)', async () => {
    const session = tmp('cc-after-merge-');
    const dir = clone(session, 'api');
    git(dir, ['checkout', '-q', '-b', 'feat/x']);
    write(dir, 'one.ts', '1\n');
    const prHead = commitAll(dir, 'in the PR');
    // On the default branch: the PR merges, then someone else's change merges after it.
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge the PR', 'feat/x']);
    write(dir, 'other.ts', 'not this session\n');
    const mainTip = commitAll(dir, "someone else's PR");
    git(dir, ['update-ref', 'refs/remotes/origin/main', mainTip]);
    git(dir, ['checkout', '-q', '-b', 'docs/y', mainTip]);
    write(dir, 'docs.md', 'the session\n');
    commitAll(dir, 'docs');
    const c = await checkoutChanges({ dir, sessionRoot: session, prHeads: [{ headSha: prHead }] });
    expect(c!.committed.base).toBe(mainTip);
    expect(c!.committed.files.map((f) => f.path)).toEqual(['docs.md']);
    expect(c!.committed.commits.map((x) => x.subject)).toEqual(['docs']);
  });

  it('that merge-base is not a session PR head: branch work from before the session started still moves the base up', async () => {
    const session = tmp('cc-after-merge-start-');
    const dir = clone(session, 'api');
    git(dir, ['checkout', '-q', '-b', 'feat/x']);
    write(dir, 'one.ts', '1\n');
    const prHead = commitAll(dir, 'in the PR');
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge the PR', 'feat/x']);
    const mainTip = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['update-ref', 'refs/remotes/origin/main', mainTip]);
    git(dir, ['checkout', '-q', '-b', 'docs/y', mainTip]);
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    write(dir, 'before.md', 'earlier branch work\n');
    const before = commitAll(dir, 'before', { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
    write(dir, 'during.md', 'the session\n');
    commitAll(dir, 'during');
    const c = await checkoutChanges({
      dir,
      sessionRoot: session,
      prHeads: [{ headSha: prHead }],
      sessionStartedAt: Date.now() - 3600_000,
    });
    expect(c!.committed.base).toBe(before);
    expect(c!.committed.files.map((f) => f.path)).toEqual(['during.md']);
    expect(c!.committed.commits.map((x) => x.subject)).toEqual(['during']);
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

describe('the fourth review round (#1299)', () => {
  it('readInside: a file reached through a linked folder, a second name, or on another platform is not read', async () => {
    const top = tmp('cc-inside-');
    const outside = tmp('cc-inside-out-');
    fs.writeFileSync(path.join(outside, 'a.ts'), 'secret\n');
    fs.mkdirSync(path.join(top, 'src'));
    fs.writeFileSync(path.join(top, 'src', 'a.ts'), 'mine\n');
    expect((await readInside(top, 'src/a.ts', 1024))?.toString()).toBe('mine\n');
    // A folder on the way swapped for a link: the open itself refuses it (no check before it to race).
    fs.renameSync(path.join(top, 'src'), path.join(top, 'src.real'));
    fs.symlinkSync(outside, path.join(top, 'src'));
    expect(await readInside(top, 'src/a.ts', 1024)).toBeUndefined();
    // A hard link into the checkout is the outside file under a second name.
    fs.unlinkSync(path.join(top, 'src'));
    fs.renameSync(path.join(top, 'src.real'), path.join(top, 'src'));
    fs.linkSync(path.join(outside, 'a.ts'), path.join(top, 'src', 'b.ts'));
    expect(await readInside(top, 'src/b.ts', 1024)).toBeUndefined();
    expect(await readInside(top, '../x', 1024)).toBeUndefined();
    expect(await readInside(top, 'src/a.ts', 1024, 'win32')).toBeUndefined();
  });

  it('the git dir swapped for another repository during the read, then put back: nothing read is kept', async () => {
    const session = tmp('cc-swap-');
    const elsewhere = tmp('cc-swap-victim-');
    const dir = clone(session, 'svc');
    // Another checkout the daemon can read, with a private file at a HEAD of its own.
    const victim = clone(elsewhere, 'victim');
    write(victim, 'private/keys.txt', 'TOP-SECRET\n');
    commitAll(victim, 'private');
    let swapped = false;
    let restored = false;
    const racing: GitRun = async (d, args) => {
      if (!swapped && args.includes('HEAD^{commit}')) {
        swapped = true;
        fs.renameSync(path.join(dir, '.git'), path.join(dir, '.git-real'));
        fs.symlinkSync(path.join(victim, '.git'), path.join(dir, '.git'));
      }
      const out = await runGit(d, args);
      if (swapped && !restored && args.includes('-g')) {
        restored = true;
        fs.unlinkSync(path.join(dir, '.git'));
        fs.renameSync(path.join(dir, '.git-real'), path.join(dir, '.git'));
      }
      return out;
    };
    const c = await checkoutChanges({
      dir,
      sessionRoot: session,
      commits: { since: 0, skip: new Set() },
      git: racing,
    });
    expect(swapped && restored).toBe(true);
    expect(JSON.stringify(c)).not.toContain('TOP-SECRET');
    expect(JSON.stringify(c)).not.toContain('keys.txt');
    expect(c).toMatchObject({
      repo: 'local:svc',
      uncommitted: { files: [], skipped: 'repo-changed-during-read' },
      committed: { files: [], skipped: 'repo-changed-during-read' },
    });
    expect(c!.sessionCommits).toBeUndefined();
  });

  it('PathWitness: a folder renamed away and back, or a file rewritten in place, is seen', async () => {
    const root = tmp('cc-witness-');
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'config'), 'x');
    const w = new PathWitness();
    expect(await w.noteChain(root, path.join(root, 'a', 'b'))).toBe(true);
    expect(await w.note(path.join(root, 'a', 'config'))).toBe('file');
    expect(await w.intact()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    fs.renameSync(path.join(root, 'a', 'b'), path.join(root, 'a', 'b2'));
    fs.renameSync(path.join(root, 'a', 'b2'), path.join(root, 'a', 'b'));
    expect(await w.intact()).toBe(false);
    const w2 = new PathWitness();
    await w2.note(path.join(root, 'a', 'config'));
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(path.join(root, 'a', 'config'), 'y');
    expect(await w2.intact()).toBe(false);
    fs.symlinkSync(root, path.join(root, 'link'));
    expect(await new PathWitness().noteChain(root, path.join(root, 'link'))).toBe(false);
  });

  it('a tracked file too large for a patch keeps its line counts; a link change tells no target', async () => {
    const session = tmp('cc-count-');
    const dir = clone(session, 'svc');
    const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
    write(dir, 'lock.json', lines(150_000, 'v1-'));
    fs.symlinkSync('README.md', path.join(dir, 'link'));
    commitAll(dir, 'big');
    // Same line count, 10 lines edited, 5 added: larger than the patch source, so no patch — the counts still hold.
    const next = lines(150_000, 'v1-').split('\n');
    for (let i = 0; i < 10; i++) next[i * 1000] = `edited${i}`;
    write(dir, 'lock.json', `${next.join('\n')}${lines(5, 'new-')}`);
    fs.unlinkSync(path.join(dir, 'link'));
    fs.symlinkSync('../../somewhere/private', path.join(dir, 'link'));
    const c = await checkoutChanges({ dir, sessionRoot: session });
    const lock = c!.uncommitted.files.find((f) => f.path === 'lock.json')!;
    expect(lock).toMatchObject({ additions: 15, deletions: 10, patchTruncated: true });
    expect(lock.patch).toBeUndefined();
    const link = c!.uncommitted.files.find((f) => f.path === 'link')!;
    expect(link).toMatchObject({ status: 'modified', patchTruncated: true });
    expect(JSON.stringify(c)).not.toContain('somewhere/private');
  });

  it('lineCounts: an edit is one removed and one added; a moved line is unchanged; CRLF is LF', () => {
    const b = (s: string) => Buffer.from(s);
    expect(lineCounts(b('a\nb\nc\n'), b('a\nB\nc\nd\n'))).toEqual({ additions: 2, deletions: 1 });
    expect(lineCounts(b('a\nb\n'), b('b\na\n'))).toEqual({ additions: 0, deletions: 0 });
    expect(lineCounts(b('a\r\nb\r\n'), b('a\nb\n'))).toEqual({ additions: 0, deletions: 0 });
    expect(lineCounts(b(''), b('x'))).toEqual({ additions: 1, deletions: 0 });
    // Multisets, not sets: two fewer copies of a repeated line are two deletions.
    expect(lineCounts(b('a\na\na\nb\n'), b('a\nb\n'))).toEqual({ additions: 0, deletions: 2 });
  });

  it('more tracked changes than the layer keeps is marked truncated', async () => {
    const session = tmp('cc-many-');
    const dir = clone(session, 'svc');
    for (let i = 0; i < 1005; i++) write(dir, `m/${i}.txt`, `${i}\n`);
    commitAll(dir, 'many');
    for (let i = 0; i < 1005; i++) write(dir, `m/${i}.txt`, `${i} changed\n`);
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files).toHaveLength(1000);
    expect(c!.uncommitted.truncated).toBe(true);
  }, 60_000);

  it('a committed diff that fails is marked, not read as "nothing committed"', async () => {
    const session = tmp('cc-difffail-');
    const dir = clone(session, 'svc');
    git(dir, ['checkout', '-q', '-b', 'feat/x']);
    write(dir, 'one.ts', '1\n');
    commitAll(dir, 'one');
    const failing: GitRun = async (d, args) => (args.includes('--numstat') ? undefined : runGit(d, args));
    const c = await checkoutChanges({ dir, sessionRoot: session, git: failing });
    expect(c!.committed).toMatchObject({ files: [], skipped: 'git-diff-failed' });
  });

  it("a fork's PR head bounds the fork's checkout (the PR is upstream's)", async () => {
    const session = tmp('cc-forkhead-');
    const dir = clone(session, 'project');
    git(dir, ['remote', 'set-url', 'origin', 'https://github.com/contributor/project.git']);
    git(dir, ['checkout', '-q', '-b', 'feat/z']);
    write(dir, 'one.ts', '1\n');
    const sha = commitAll(dir, 'in the PR');
    write(dir, 'two.ts', '2\n');
    commitAll(dir, 'after the PR');
    const c = await checkoutChanges({
      dir,
      sessionRoot: session,
      prHeads: [{ repo: 'org/project', headRepo: 'contributor/project', headSha: sha }],
    });
    expect(c!.committed.base).toBe(sha);
    expect(c!.committed.files.map((f) => f.path)).toEqual(['two.ts']);
  });

  it('commandKeys refuses transports and what fetches through them', () => {
    const listing = [
      'local\tprotocol.ext.allow',
      'local\tremote.origin.promisor',
      'local\tremote.origin.uploadpack',
      'local\textensions.partialclone',
      'local\tremote.origin.url',
    ].join('\n');
    expect(commandKeys(listing)).toEqual([
      'protocol.ext.allow',
      'remote.origin.promisor',
      'remote.origin.uploadpack',
      'extensions.partialclone',
    ]);
  });

  it('sessionCommits counts a commit whose file name has a tab in it', async () => {
    const session = tmp('cc-tabname-');
    const dir = clone(session, 'svc');
    const since = Date.now() - 1000;
    write(dir, 'a\tb.txt', '1\n2\n3\n');
    const sha = commitAll(dir, 'tab');
    expect(await sessionCommits(dir, since, new Set())).toEqual([
      expect.objectContaining({ sha, additions: 3, deletions: 0 }),
    ]);
  });
});

describe('the fifth review round (#1299)', () => {
  it('trustedRoots: a folder inside another adds nothing; an outermost folder that is a link is no root', async () => {
    const session = tmp('cc-roots-');
    const other = tmp('cc-roots-other-');
    fs.mkdirSync(path.join(session, 'repo'));
    fs.symlinkSync(other, path.join(session, 'turn'));
    fs.symlinkSync(other, path.join(session, '..', `${path.basename(session)}-alias`));
    roots.push(path.join(session, '..', `${path.basename(session)}-alias`));
    expect(await trustedRoots([session, path.join(session, 'turn'), path.join(session, 'repo')])).toEqual([session]);
    expect(await trustedRoots([path.join(session, '..', `${path.basename(session)}-alias`)])).toEqual([]);
  });

  it("the turn's folder swapped for a link to another session's checkout: that checkout is not this session's", async () => {
    const session = tmp('cc-turnlink-');
    const elsewhere = tmp('cc-turnlink-victim-');
    const victim = clone(elsewhere, 'victim');
    write(victim, 'private.txt', 'TOP-SECRET\n');
    fs.symlinkSync(victim, path.join(session, 'turn'));
    const c = await checkoutChanges({
      dir: path.join(session, 'turn'),
      sessionRoot: session,
      roots: [session, path.join(session, 'turn')],
    });
    expect(c).toBeUndefined();
  });

  it('a linked worktree swapped for a link during the read: nothing read is kept, not even names', async () => {
    const session = tmp('cc-wt-');
    const elsewhere = tmp('cc-wt-victim-');
    const dir = clone(session, 'svc');
    git(dir, ['branch', 'side']);
    // Under a folder of its own, off the git dirs' path: only the work tree's own chain sees a swap there.
    fs.mkdirSync(path.join(session, 'trees'));
    const wt = path.join(session, 'trees', 'wt');
    git(dir, ['worktree', 'add', '-q', wt, 'side']);
    write(wt, 'src/a.ts', 'mine\n');
    const victim = clone(elsewhere, 'victim');
    write(victim, 'private-name.txt', 'TOP-SECRET\n');
    let swapped = false;
    let restored = false;
    const racing: GitRun = async (d, args) => {
      if (!swapped && args.includes('HEAD^{commit}')) {
        swapped = true;
        fs.renameSync(wt, `${wt}.real`);
        fs.symlinkSync(victim, wt);
      }
      const out = await runGit(d, args);
      if (swapped && !restored && args.includes('-g')) {
        restored = true;
        fs.unlinkSync(wt);
        fs.renameSync(`${wt}.real`, wt);
      }
      return out;
    };
    const c = await checkoutChanges({
      dir: wt,
      sessionRoot: session,
      commits: { since: 0, skip: new Set() },
      git: racing,
    });
    expect(swapped && restored).toBe(true);
    expect(JSON.stringify(c)).not.toContain('private-name');
    expect(JSON.stringify(c)).not.toContain('TOP-SECRET');
    expect(c).toMatchObject({ uncommitted: { files: [], skipped: 'repo-changed-during-read' } });
  });

  it('git not answering for a folder with a .git is git-failed, not "no checkout"', async () => {
    const session = tmp('cc-gitfail-');
    const dir = clone(session, 'svc');
    const failing: GitRun = async (d, args) => (args[0] === 'rev-parse' ? undefined : runGit(d, args));
    const c = await checkoutChanges({ dir, sessionRoot: session, git: failing });
    expect(c).toMatchObject({ uncommitted: { skipped: 'git-failed' }, committed: { skipped: 'git-failed' } });
    const plain = path.join(session, 'plain');
    fs.mkdirSync(plain);
    expect(await checkoutChanges({ dir: plain, sessionRoot: session, git: failing })).toBeUndefined();
  });

  it('committed files keep their status when no patch is kept: past the file limit, or the patch command failed', async () => {
    const session = tmp('cc-status-');
    const dir = clone(session, 'svc');
    git(dir, ['checkout', '-q', '-b', 'feat/many']);
    for (let i = 0; i < 1001; i++) write(dir, `n/${i}.txt`, `${i}\n`);
    fs.rmSync(path.join(dir, 'README.md'));
    commitAll(dir, 'many new');
    const c = await checkoutChanges({ dir, sessionRoot: session });
    const files = c!.committed.files;
    expect(c!.committed.truncated).toBe(true);
    expect(files.filter((f) => f.status === 'added').length).toBeGreaterThan(990);
    expect(files.every((f) => !f.patch && f.patchTruncated)).toBe(true);

    const small = tmp('cc-status-small-');
    const d2 = clone(small, 'svc');
    git(d2, ['checkout', '-q', '-b', 'feat/x']);
    write(d2, 'new.ts', 'n\n');
    fs.rmSync(path.join(d2, 'README.md'));
    commitAll(d2, 'add and delete');
    const noPatch: GitRun = async (d, args) => (args.includes('-U3') ? undefined : runGit(d, args));
    const c2 = await checkoutChanges({ dir: d2, sessionRoot: small, git: noPatch });
    expect(c2!.committed.files.map((f) => [f.path, f.status, !!f.patchTruncated, f.patch])).toEqual([
      ['README.md', 'deleted', true, undefined],
      ['new.ts', 'added', true, undefined],
    ]);
  }, 60_000);

  it('an executable bit flipped on a tracked file is an uncommitted change', async () => {
    const session = tmp('cc-mode-');
    const dir = clone(session, 'svc');
    fs.chmodSync(path.join(dir, 'src', 'a.ts'), 0o755);
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0, modeChange: '100644 → 100755' },
    ]);
    git(dir, ['config', 'core.filemode', 'false']);
    expect((await checkoutChanges({ dir, sessionRoot: session }))!.uncommitted.files).toEqual([]);
  });
});

describe('the sixth review round (#1299)', () => {
  it("a linked worktree's commondir rewritten right after the gate first asked: the re-check refuses it", async () => {
    const session = tmp('cc-commondir-');
    const elsewhere = tmp('cc-commondir-victim-');
    const dir = clone(session, 'svc');
    git(dir, ['branch', 'side']);
    const wt = path.join(session, 'wt');
    git(dir, ['worktree', 'add', '-q', wt, 'side']);
    // Another repository the daemon can read, with a private file on a branch of the same name.
    const victim = clone(elsewhere, 'victim');
    git(victim, ['checkout', '-q', '-b', 'side']);
    write(victim, 'private/keys.txt', 'TOP-SECRET\n');
    commitAll(victim, 'private');
    const commondir = path.join(dir, '.git', 'worktrees', 'wt', 'commondir');
    let rewritten = false;
    const racing: GitRun = async (d, args) => {
      const out = await runGit(d, args);
      if (!rewritten && args.includes('--show-toplevel')) {
        rewritten = true;
        fs.writeFileSync(commondir, `${path.join(victim, '.git')}\n`);
      }
      return out;
    };
    const c = await checkoutChanges({ dir: wt, sessionRoot: session, git: racing });
    expect(rewritten).toBe(true);
    expect(JSON.stringify(c)).not.toContain('TOP-SECRET');
    expect(JSON.stringify(c)).not.toContain('keys.txt');
    expect(c!.uncommitted.skipped).toBe('repo-links-outside');
  });

  it('a file removed from the index only is one deletion, not a deletion and a new file', async () => {
    const session = tmp('cc-rmcached-');
    const dir = clone(session, 'svc');
    git(dir, ['rm', '-q', '--cached', 'src/a.ts']);
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files.map((f) => [f.path, f.status, f.deletions])).toEqual([['src/a.ts', 'deleted', 3]]);
  });

  it('a conflicted path with several index stages is listed once', async () => {
    const session = tmp('cc-stages-');
    const dir = clone(session, 'svc');
    git(dir, ['checkout', '-q', '-b', 'feat']);
    write(dir, 'src/a.ts', 'one\ntwo\nthree\nfour\n');
    commitAll(dir, 'modify on feat');
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['rm', '-q', 'src/a.ts']);
    git(dir, ['commit', '-q', '-m', 'delete on main']);
    try {
      git(dir, ['merge', '-q', 'feat']);
    } catch {
      // modify/delete conflict: src/a.ts is in the index at stages 1 and 3, not in HEAD.
    }
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files.filter((f) => f.path === 'src/a.ts')).toHaveLength(1);
  });

  it('HEAD that git fails to read is git-failed; a branch with no commit yet is read as one', async () => {
    const session = tmp('cc-head-');
    const dir = clone(session, 'svc');
    const failing: GitRun = async (d, args) => (args.includes('HEAD^{commit}') ? undefined : runGit(d, args));
    const c = await checkoutChanges({ dir, sessionRoot: session, git: failing });
    expect(c).toMatchObject({ uncommitted: { files: [], skipped: 'git-failed' } });
    const fresh = path.join(session, 'fresh');
    fs.mkdirSync(fresh);
    git(fresh, ['init', '-q', '-b', 'main']);
    write(fresh, 'new.ts', 'n\n');
    const f = await checkoutChanges({ dir: fresh, sessionRoot: session });
    expect(f!.uncommitted.files.map((x) => [x.path, x.status])).toEqual([['new.ts', 'added']]);
  });

  it('a sha256 repository: the root commit range uses its own empty tree', async () => {
    const session = tmp('cc-sha256-');
    const dir = path.join(session, 'repo');
    fs.mkdirSync(dir);
    git(dir, ['init', '-q', '--object-format=sha256', '-b', 'main']);
    write(dir, 'a.ts', '1\n2\n');
    commitAll(dir, 'root');
    const c = await checkoutChanges({ dir, sessionRoot: session, sessionStartedAt: Date.now() - 3600_000 });
    expect(c!.committed.base).toBe('6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321');
    expect(c!.committed.files.map((f) => [f.path, f.status, f.additions])).toEqual([['a.ts', 'added', 2]]);
  });

  it('a large file whose only change is CRLF line endings is unchanged', async () => {
    const session = tmp('cc-crlf-');
    const dir = clone(session, 'svc');
    const body = Array.from({ length: 120_000 }, (_, i) => `line ${i}`);
    write(dir, 'big.txt', `${body.join('\n')}\n`);
    commitAll(dir, 'big');
    write(dir, 'big.txt', `${body.join('\r\n')}\r\n`);
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files).toEqual([]);
  });

  it('the nearest of several session PR heads under HEAD is the base', async () => {
    const session = tmp('cc-nearest-');
    const dir = clone(session, 'svc');
    git(dir, ['checkout', '-q', '-b', 'feat/stack']);
    write(dir, 'one.ts', '1\n');
    const first = commitAll(dir, 'first PR');
    write(dir, 'two.ts', '2\n');
    const second = commitAll(dir, 'second PR');
    write(dir, 'three.ts', '3\n');
    commitAll(dir, 'after both');
    const c = await checkoutChanges({
      dir,
      sessionRoot: session,
      prHeads: [{ headSha: first }, { headSha: second }],
    });
    expect(c!.committed.base).toBe(second);
    expect(c!.committed.files.map((f) => f.path)).toEqual(['three.ts']);
  });
});

describe('the seventh review round (#1299)', () => {
  it('an alternates file that appears during the read: the read is thrown away, no borrowed object kept', async () => {
    const session = tmp('cc-alt-race-');
    const elsewhere = tmp('cc-alt-race-victim-');
    const dir = clone(session, 'svc');
    const victim = clone(elsewhere, 'victim');
    write(victim, 'private/keys.txt', 'TOP-SECRET\n');
    commitAll(victim, 'private');
    let planted = false;
    const racing: GitRun = async (d, args) => {
      if (!planted && args.includes('HEAD^{commit}')) {
        planted = true;
        fs.writeFileSync(
          path.join(dir, '.git', 'objects', 'info', 'alternates'),
          `${path.join(victim, '.git', 'objects')}\n`,
        );
      }
      return runGit(d, args);
    };
    const c = await checkoutChanges({ dir, sessionRoot: session, git: racing });
    expect(planted).toBe(true);
    expect(JSON.stringify(c)).not.toContain('TOP-SECRET');
    expect(c!.uncommitted.skipped).toBe('repo-changed-during-read');
  });

  it('a base git fails to find is marked git-diff-failed, not read as no commits', async () => {
    const session = tmp('cc-basefail-');
    const dir = path.join(session, 'repo');
    fs.mkdirSync(dir);
    git(dir, ['init', '-q', '-b', 'main']);
    write(dir, 'a.ts', '1\n');
    commitAll(dir, 'one');
    const failing: GitRun = async (d, args) =>
      args.includes('rev-list') && args.some((a) => a.startsWith('--since=')) ? undefined : runGit(d, args);
    const c = await checkoutChanges({
      dir,
      sessionRoot: session,
      sessionStartedAt: Date.now() - 3600_000,
      git: failing,
    });
    expect(c!.committed).toMatchObject({ files: [], skipped: 'git-diff-failed' });
  });

  it('a sparse-checkout or assume-unchanged entry is not reported (git does not either)', async () => {
    const session = tmp('cc-sparse-');
    const dir = clone(session, 'svc');
    git(dir, ['update-index', '--skip-worktree', 'src/a.ts']);
    fs.rmSync(path.join(dir, 'src', 'a.ts'));
    git(dir, ['update-index', '--assume-unchanged', 'README.md']);
    write(dir, 'README.md', '# changed but assumed unchanged\n');
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files).toEqual([]);
  });

  it('a same-size edit with the mtime set back is still seen on the next read (the ctime moved)', async () => {
    const session = tmp('cc-ctime-');
    const dir = clone(session, 'svc');
    const file = path.join(dir, 'src', 'a.ts');
    expect((await checkoutChanges({ dir, sessionRoot: session }))!.uncommitted.files).toEqual([]);
    const { atime, mtime } = fs.statSync(file);
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, 'ONE\ntwo\nthree\n');
    fs.utimesSync(file, atime, mtime);
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files.map((f) => [f.path, f.status])).toEqual([['src/a.ts', 'modified']]);
  });

  it('a same-size tracked file that cannot be read safely is shown as changed, without counts', async () => {
    const session = tmp('cc-unread-');
    const dir = clone(session, 'svc');
    const other = path.join(session, 'other.txt');
    fs.writeFileSync(other, 'ONE\nTWO\nTHREE\n');
    fs.rmSync(path.join(dir, 'src', 'a.ts'));
    fs.linkSync(other, path.join(dir, 'src', 'a.ts'));
    const c = await checkoutChanges({ dir, sessionRoot: session });
    expect(c!.uncommitted.files).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0, patchTruncated: true },
    ]);
  });

  it('a committed file whose name git quotes keeps its patch', async () => {
    const session = tmp('cc-quoted-');
    const dir = clone(session, 'svc');
    git(dir, ['checkout', '-q', '-b', 'feat/q']);
    write(dir, 'say "hi".txt', 'hello\n');
    write(dir, 'tab\there.txt', 'tab\n');
    commitAll(dir, 'quoted names');
    const c = await checkoutChanges({ dir, sessionRoot: session });
    const byPath = Object.fromEntries(c!.committed.files.map((f) => [f.path, f]));
    expect(byPath['say "hi".txt'].patch).toContain('+hello');
    expect(byPath['tab\there.txt'].patch).toContain('+tab');
  });
});

describe('the eighth review round (#1299)', () => {
  it('an ancestry check git fails to answer marks the committed layer, not a wrong base', async () => {
    const session = tmp('cc-anc-');
    const dir = clone(session, 'svc');
    git(dir, ['checkout', '-q', '-b', 'feat/x']);
    write(dir, 'one.ts', '1\n');
    const pr = commitAll(dir, 'in the PR');
    write(dir, 'two.ts', '2\n');
    commitAll(dir, 'after');
    const failing: GitRun = async (d, args) => (args.includes('--not') ? undefined : runGit(d, args));
    const c = await checkoutChanges({ dir, sessionRoot: session, prHeads: [{ headSha: pr }], git: failing });
    expect(c!.committed).toMatchObject({ files: [], skipped: 'git-diff-failed' });
    // A PR head this checkout does not have is simply not its base.
    const other = await checkoutChanges({ dir, sessionRoot: session, prHeads: [{ headSha: 'e'.repeat(40) }] });
    expect(other!.committed.skipped).toBeUndefined();
    expect(other!.committed.files.map((f) => f.path)).toEqual(['one.ts', 'two.ts']);
  });

  it('a commit log git fails to read marks the committed layer', async () => {
    const session = tmp('cc-logfail-');
    const dir = clone(session, 'svc');
    git(dir, ['checkout', '-q', '-b', 'feat/x']);
    write(dir, 'one.ts', '1\n');
    commitAll(dir, 'one');
    const failing: GitRun = async (d, args) =>
      args.includes('log') && args.includes('--format=%H%x1f%s%x1f%ct') ? undefined : runGit(d, args);
    const c = await checkoutChanges({ dir, sessionRoot: session, git: failing });
    expect(c!.committed).toMatchObject({ files: [], skipped: 'git-diff-failed' });
  });

  it('a tracked file whose stat fails (not ENOENT) is shown, not read as deleted', async () => {
    if (process.getuid?.() === 0) return; // root reads through a 000 folder
    const session = tmp('cc-eacces-');
    const dir = clone(session, 'svc');
    fs.chmodSync(path.join(dir, 'src'), 0o000);
    try {
      const c = await checkoutChanges({ dir, sessionRoot: session });
      expect(c!.uncommitted.files).toEqual([
        { path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0, patchTruncated: true },
      ]);
    } finally {
      fs.chmodSync(path.join(dir, 'src'), 0o755);
    }
  });

  it("a commit in the session's first second counts (the reflog keeps whole seconds)", async () => {
    const session = tmp('cc-second-');
    const dir = clone(session, 'svc');
    write(dir, 'a.txt', 'a\n');
    const sha = commitAll(dir, 'now');
    const at = Number(/@\{(\d+)\}/.exec(git(dir, ['log', '-g', '-1', '--date=unix', '--format=%gd']))?.[1]) * 1000;
    expect((await sessionCommits(dir, at + 999, new Set())).map((c) => c.sha)).toEqual([sha]);
  });
});

describe('PRs GitHub did not answer for, read from the checkout’s default branch', () => {
  const ask = (n: number, repo = 'acme/web'): PullAsk => ({
    id: `${repo}#${n}`,
    url: `https://github.com/${repo}/pull/${n}`,
    repo,
    number: n,
  });

  it('a merge commit (head against where it left main) and a squash of the clone’s own branches; not: merged before the session, not merged, not this clone’s work, a number only mentioned', () => {
    const session = tmp('cc-local-pr-');
    const origin = path.join(session, '..', `${path.basename(session)}-origin`);
    roots.push(origin);
    fs.mkdirSync(origin, { recursive: true });
    git(origin, ['init', '-q', '-b', 'main']);
    write(origin, 'src/a.ts', 'one\ntwo\nthree\n');
    write(origin, 'README.md', '# r\n');
    const old = '2020-01-01T00:00:00Z';
    commitAll(origin, 'init', { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
    // #4 merged long before the session started.
    git(origin, ['checkout', '-q', '-b', 'feat/four']);
    write(origin, 'four.txt', '4\n');
    commitAll(origin, 'four', { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
    git(origin, ['checkout', '-q', 'main']);
    git(
      origin,
      ['merge', '-q', '--no-ff', '-m', 'Merge pull request #4 from acme/feat/four', '-m', 'Four', 'feat/four'],
      {
        GIT_COMMITTER_DATE: old,
        GIT_AUTHOR_DATE: old,
      },
    );
    const start = Date.now() - 3600_000;
    // #5: a branch off main, while main moves on by itself — the PR's files are the branch's only.
    git(origin, ['checkout', '-q', '-b', 'feat/five']);
    write(origin, 'src/a.ts', 'one\nTWO\nthree\n');
    write(origin, 'src/b.ts', 'bee\n');
    commitAll(origin, 'five');
    git(origin, ['checkout', '-q', 'main']);
    write(origin, 'main-only.txt', 'main\n');
    commitAll(origin, 'main moves on');
    git(origin, [
      'merge',
      '-q',
      '--no-ff',
      '-m',
      'Merge pull request #5 from acme/feat/five',
      '-m',
      'Five: b.ts and a line of a.ts',
      'feat/five',
    ]);
    // #6: a squash — the commit is the PR (the branch was up to date with main: same tree).
    git(origin, ['checkout', '-q', '-b', 'feat/six']);
    write(origin, 'README.md', '# r\nsix\n');
    commitAll(origin, 'six');
    git(origin, ['checkout', '-q', 'main']);
    git(origin, ['merge', '-q', '--squash', 'feat/six']);
    commitAll(origin, 'six: a README line (#6)');
    // #8: merged on main, but its branch was never in the session's clone — upstream's history a fork synced, say.
    git(origin, ['checkout', '-q', '-b', 'other/eight']);
    write(origin, 'eight.txt', '8\n');
    commitAll(origin, 'eight');
    git(origin, ['checkout', '-q', 'main']);
    git(origin, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #8 from someone/other/eight', 'other/eight']);
    // A commit whose subject only mentions #9 in passing names no PR.
    write(origin, 'notes.txt', 'n\n');
    commitAll(origin, 'notes about #9 and (#9) later');
    const dir = path.join(session, 'web');
    git(session, ['clone', '-q', origin, dir]);
    git(dir, ['remote', 'set-url', 'origin', 'git@github.com:acme/web.git']);
    // The session's own PR branches are in its clone (it pushed them from there).
    git(dir, ['branch', '-q', 'feat/five', 'origin/feat/five']);
    git(dir, ['branch', '-q', 'feat/six', 'origin/feat/six']);
    return checkoutChanges({
      dir,
      sessionRoot: session,
      roots: [session],
      sessionStartedAt: start,
      pulls: [ask(4), ask(5), ask(6), ask(7), ask(8), ask(9), ask(5, 'acme/other')],
    }).then((read) => {
      const pulls = read?.pulls ?? [];
      expect(pulls.map((p) => p.number)).toEqual([6, 5]);
      const five = pulls.find((p) => p.number === 5);
      expect(five).toMatchObject({
        id: 'acme/web#5',
        url: 'https://github.com/acme/web/pull/5',
        repo: 'acme/web',
        state: 'merged',
        source: 'local',
        title: 'Five: b.ts and a line of a.ts',
        headRef: 'feat/five',
        additions: 2,
        deletions: 1,
        changedFiles: 2,
      });
      expect(five?.files.map((f) => [f.path, f.status])).toEqual([
        ['src/a.ts', 'modified'],
        ['src/b.ts', 'added'],
      ]);
      expect(five?.files[0].patch).toContain('+TWO');
      expect(typeof five?.mergedAt).toBe('number');
      const six = pulls.find((p) => p.number === 6);
      expect(six).toMatchObject({ title: 'six: a README line', additions: 1, deletions: 0, changedFiles: 1 });
      expect(six?.files.map((f) => f.path)).toEqual(['README.md']);
      expect(six).not.toHaveProperty('headRef');
      // Each read whole: nothing to ask again.
      expect(five).not.toHaveProperty('filesStale');
    });
  });

  it('a range whose whole patch does not come in one answer: each file’s own, code before data, smallest first; a huge file gets none', async () => {
    const session = tmp('cc-local-pr3-');
    const dir = clone(session, 'web');
    write(dir, 'small.txt', 'a\n');
    write(dir, 'mid.txt', Array.from({ length: 40 }, (_, i) => `m${i}`).join('\n') + '\n');
    write(dir, 'huge.json', Array.from({ length: 5001 }, (_, i) => `h${i}`).join('\n') + '\n');
    // Data (generated more often than written) comes after code, however small.
    write(dir, 'tiny.json', '{}\n');
    // A name git would read as a magic pathspec unless told the paths are literal.
    write(dir, ':(top)odd.txt', 'odd\n');
    git(dir, ['checkout', '-q', '-b', 'feat/three']);
    commitAll(dir, 'three');
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '-q', '--squash', 'feat/three']);
    commitAll(dir, 'a big squash (#3)');
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const calls: string[][] = [];
    // git's output cap, as seen from here: the range's whole patch does not come back.
    const capped: GitRun = (d, args) => {
      calls.push(args);
      if (args.includes('-U3') && args[args.length - 1] === '--') return Promise.resolve(undefined);
      return runGit(d, args);
    };
    const read = await checkoutChanges({
      dir,
      sessionRoot: session,
      roots: [session],
      git: capped,
      pulls: [{ id: 'acme/web#3', url: 'https://github.com/acme/web/pull/3', repo: 'acme/web', number: 3 }],
    });
    const files = Object.fromEntries((read?.pulls?.[0]?.files ?? []).map((f) => [f.path, f]));
    expect(Object.keys(files).sort()).toEqual([':(top)odd.txt', 'huge.json', 'mid.txt', 'small.txt', 'tiny.json']);
    expect(files['tiny.json'].patch).toContain('+{}');
    // Every file asked came whole: nothing to read again.
    expect(read?.pulls?.[0]).not.toHaveProperty('filesStale');
    expect(files['small.txt'].patch).toContain('+a');
    expect(files['mid.txt'].patch).toContain('+m39');
    expect(files[':(top)odd.txt'].patch).toContain('+odd');
    expect(files['huge.json'].patch).toBeUndefined();
    expect(files['huge.json'].patchTruncated).toBe(true);
    const each = calls.filter((a) => a.includes('-U3') && a[a.length - 1] !== '--').map((a) => a[a.length - 1]);
    // Smallest change first (the huge one is never asked).
    expect(each.slice(0, 1)).toEqual([expect.stringMatching(/^(small\.txt|:\(top\)odd\.txt)$/)]);
    expect(each).not.toContain('huge.json');
    expect(each.slice(-2)).toEqual(['mid.txt', 'tiny.json']);
  });

  it('the per-file reads of one range stop at its budget: later files are not asked and say so', async () => {
    const session = tmp('cc-local-pr5-');
    const dir = clone(session, 'web');
    git(dir, ['checkout', '-q', '-b', 'feat/five']);
    // Twelve files of 300 KB each (each patch keeps 256 KB): more than the 2 MiB a range reads file by file.
    for (let i = 10; i < 22; i++) {
      write(dir, `p${i}.txt`, `${Array.from({ length: 1200 }, (_, k) => `${i}-${k}-`.padEnd(250, 'x')).join('\n')}\n`);
    }
    commitAll(dir, 'five');
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '-q', '--squash', 'feat/five']);
    commitAll(dir, 'five (#5)');
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const asked: string[] = [];
    const capped: GitRun = (d, args) => {
      if (args.includes('-U3') && args[args.length - 1] === '--') return Promise.resolve(undefined);
      if (args.includes('-U3')) asked.push(args[args.length - 1]);
      return runGit(d, args);
    };
    const read = await checkoutChanges({
      dir,
      sessionRoot: session,
      roots: [session],
      git: capped,
      pulls: [{ id: 'acme/web#5', url: 'https://github.com/acme/web/pull/5', repo: 'acme/web', number: 5 }],
    });
    const files = read?.pulls?.[0]?.files ?? [];
    expect(files).toHaveLength(12);
    const withPatch = files.filter((f) => f.patch);
    const without = files.filter((f) => !f.patch);
    expect(withPatch.length).toBeGreaterThanOrEqual(8);
    expect(without.length).toBeGreaterThanOrEqual(1);
    const bytes = withPatch.reduce((n, f) => n + Buffer.byteLength(f.patch ?? ''), 0);
    expect(bytes).toBeGreaterThanOrEqual(2 * 1024 * 1024 - 256 * 1024);
    expect(bytes).toBeLessThan(2 * 1024 * 1024 + 256 * 1024);
    for (const f of without) {
      expect(f.patchTruncated).toBe(true);
      expect(asked).not.toContain(f.path);
    }
    // A cut for size is not a failed read.
    expect(read?.pulls?.[0]).not.toHaveProperty('filesStale');
  });

  it('a file whose own patch read failed marks the PR to be read again (not a size cut)', async () => {
    const session = tmp('cc-local-pr4-');
    const dir = clone(session, 'web');
    git(dir, ['checkout', '-q', '-b', 'feat/four']);
    write(dir, 'one.txt', 'a\n');
    write(dir, 'two.txt', 'b\n');
    commitAll(dir, 'four');
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '-q', '--squash', 'feat/four']);
    commitAll(dir, 'four (#4)');
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const flaky: GitRun = (d, args) => {
      if (args.includes('-U3') && args[args.length - 1] === '--') return Promise.resolve(undefined);
      if (args.includes('-U3') && args[args.length - 1] === 'two.txt') return Promise.resolve(undefined);
      return runGit(d, args);
    };
    const read = await checkoutChanges({
      dir,
      sessionRoot: session,
      roots: [session],
      git: flaky,
      pulls: [{ id: 'acme/web#4', url: 'https://github.com/acme/web/pull/4', repo: 'acme/web', number: 4 }],
    });
    const pr = read?.pulls?.[0];
    expect(pr?.files.find((f) => f.path === 'one.txt')?.patch).toContain('+a');
    expect(pr?.files.find((f) => f.path === 'two.txt')?.patchTruncated).toBe(true);
    expect(pr?.filesStale).toBe(true);
  });

  it('nothing is asked of a checkout of another repository, or with no remote default branch', async () => {
    const session = tmp('cc-local-pr2-');
    const dir = clone(session, 'web');
    const read = await checkoutChanges({ dir, sessionRoot: session, roots: [session], pulls: [ask(1, 'acme/other')] });
    expect(read?.pulls).toBeUndefined();
    const lone = path.join(session, 'lone');
    fs.mkdirSync(lone);
    git(lone, ['init', '-q', '-b', 'main']);
    write(lone, 'x', '1\n');
    commitAll(lone, 'x (#1)');
    git(lone, ['remote', 'add', 'origin', 'https://github.com/acme/lone.git']);
    const none = await checkoutChanges({
      dir: lone,
      sessionRoot: session,
      roots: [session],
      pulls: [ask(1, 'acme/lone')],
    });
    expect(none?.pulls).toBeUndefined();
  });
});
