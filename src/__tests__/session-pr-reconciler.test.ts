/**
 * #833 (epic #831) — at turn end, the host asks GitHub which PRs the session's own branches have, and puts them on the
 * card. How the PR was made does not matter (REST, the web UI, another machine): this is the one layer that does not
 * depend on how a command was spelled.
 *
 *   R1  a PR on a checkout's branch, created after the session started, becomes the current link ('always')
 *   R2  an older PR (an inherited branch) goes to history only; so does any PR when the session's start is unknown
 *   R3  a branch two sessions both check out is ambiguous: history only, for both
 *   R4  an empty answer is asked again next turn; a found answer for the same head sha is not re-asked
 *   R5  a failed query records nothing and is asked again; a PR already on the card is never made current again
 *   R6  the PR's closing issues ("Closes #12", "fixes owner/repo#3") go to history
 *   R7  one reconcile per session at a time, a minimum interval between them, and it never throws
 *   R8  the real checkout finder: branch from `git symbolic-ref` (detached, main, deploy/* skipped), repo from the raw
 *       remote URL (a token in it never leaks into the result)
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Checkout,
  createSessionPrReconciler,
  findGitCheckouts,
  type PullSummary,
  type ReconcilerDeps,
} from '../session-pr-reconciler';
import type { SessionLink } from '../types';

const START = Date.parse('2026-11-03T02:00:00Z');
const SESSION_DIR = `/tmp/U1/session_${START}_abcd1234`;
const checkout = (over: Partial<Checkout> = {}): Checkout => ({
  dir: `${SESSION_DIR}/app`,
  owner: 'a',
  name: 'b',
  branch: 'feat/x',
  sha: 'sha1',
  ...over,
});
const pull = (n: number, over: Partial<PullSummary> = {}): PullSummary => ({
  html_url: `https://github.com/a/b/pull/${n}`,
  number: n,
  title: `PR ${n}`,
  state: 'open',
  draft: false,
  merged_at: null,
  created_at: '2026-11-03T03:00:00Z',
  body: '',
  ...over,
});

function harness(over: Partial<ReconcilerDeps> = {}) {
  const noted: Array<[string, string, string[]]> = [];
  const pushed: string[] = [];
  let clock = START + 3 * 3600_000;
  const deps: ReconcilerDeps = {
    findCheckouts: vi.fn(async () => [checkout()]),
    fetchPulls: vi.fn(async () => [pull(12)]),
    noteLinks: vi.fn((key, links, mode) => {
      noted.push([key, mode, links.map((l: SessionLink) => (l.status ? `${l.url} ${l.status}` : l.url))]);
      return true;
    }),
    pushCard: vi.fn((key) => pushed.push(key)),
    now: () => clock,
    minIntervalMs: 0,
    ...over,
  };
  const reconcile = createSessionPrReconciler(deps);
  const run = async (sessionKey: string, session: Record<string, unknown> = { sessionWorkingDir: SESSION_DIR }) => {
    reconcile({ sessionKey, session, workingDirectory: (session.sessionWorkingDir as string) ?? '/tmp/x' });
    await reconcile.idle();
  };
  return { deps, noted, pushed, run, tick: (ms: number) => (clock += ms) };
}

describe('createSessionPrReconciler (#833)', () => {
  it('R1 — a PR created after the session started is the current link, with its title and state', async () => {
    const h = harness({ fetchPulls: vi.fn(async () => [pull(12, { draft: true })]) });
    await h.run('S1');
    expect(h.deps.fetchPulls).toHaveBeenCalledWith('a', 'b', 'feat/x');
    expect(h.noted).toEqual([['S1', 'always', ['https://github.com/a/b/pull/12 draft']]]);
    expect(h.pushed).toEqual(['S1']);
  });

  it('R2 — an older PR, or any PR when the start is unknown, goes to history only', async () => {
    const h = harness({
      fetchPulls: vi.fn(async () => [
        pull(7, { created_at: '2026-11-01T00:00:00Z', merged_at: '2026-11-02T00:00:00Z' }),
      ]),
    });
    await h.run('S1');
    expect(h.noted).toEqual([['S1', 'history', ['https://github.com/a/b/pull/7 merged']]]);
    const h2 = harness();
    await h2.run('S2', { workingDirectory: '/tmp/U1/somewhere' });
    expect(h2.noted).toEqual([['S2', 'history', ['https://github.com/a/b/pull/12 open']]]);
  });

  it('R3 — a branch two sessions check out is ambiguous: history only', async () => {
    const h = harness();
    await h.run('S1');
    await h.run('S2', { sessionWorkingDir: `/tmp/U2/session_${START}_ffff0000` });
    expect(h.noted.map(([k, m]) => [k, m])).toEqual([
      ['S1', 'always'],
      ['S2', 'history'],
    ]);
    // S1's next turn now sees the branch as ambiguous too.
    h.tick(60_000);
    await h.run('S1', { sessionWorkingDir: SESSION_DIR, links: {} });
    expect(h.noted[h.noted.length - 1]?.slice(0, 2)).toEqual(['S1', 'history']);
  });

  it('R4 — an empty answer is asked again next turn; a found answer for the same sha is not', async () => {
    const fetchPulls = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([pull(12)]);
    const h = harness({ fetchPulls });
    await h.run('S1');
    expect(h.noted).toEqual([]);
    await h.run('S1');
    expect(fetchPulls).toHaveBeenCalledTimes(2);
    expect(h.noted).toHaveLength(1);
    await h.run('S1');
    expect(fetchPulls).toHaveBeenCalledTimes(2);
    // A new commit on the branch: asked again.
    (h.deps.findCheckouts as any).mockResolvedValue([checkout({ sha: 'sha2' })]);
    await h.run('S1');
    expect(fetchPulls).toHaveBeenCalledTimes(3);
  });

  it('R5 — a failed query records nothing; a PR already on the card is never made current again', async () => {
    const fetchPulls = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue([pull(12)]);
    const h = harness({ fetchPulls });
    await h.run('S1');
    expect(h.noted).toEqual([]);
    await h.run('S1', {
      sessionWorkingDir: SESSION_DIR,
      linkHistory: { prs: [{ url: 'https://github.com/a/b/pull/12/files' }] },
      links: { pr: { url: 'https://github.com/a/b/pull/99' } },
    });
    expect(h.noted).toEqual([['S1', 'history', ['https://github.com/a/b/pull/12 open']]]);
  });

  it('R6 — the closing issues of a PR go to history', async () => {
    const h = harness({
      fetchPulls: vi.fn(async () => [pull(12, { body: 'Closes #832. Also fixes acme/other#3 and resolves #832.' })]),
    });
    await h.run('S1');
    expect(h.noted).toEqual([
      ['S1', 'always', ['https://github.com/a/b/pull/12 open']],
      ['S1', 'history', ['https://github.com/a/b/issues/832', 'https://github.com/acme/other/issues/3']],
    ]);
  });

  it('R7 — one at a time per session, a minimum interval, and it never throws', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const findCheckouts = vi.fn(async () => {
      await gate;
      return [checkout()];
    });
    const h = harness({ findCheckouts, minIntervalMs: 30_000 });
    const reconcile = createSessionPrReconciler(h.deps);
    reconcile({ sessionKey: 'S1', session: { sessionWorkingDir: SESSION_DIR }, workingDirectory: SESSION_DIR });
    reconcile({ sessionKey: 'S1', session: { sessionWorkingDir: SESSION_DIR }, workingDirectory: SESSION_DIR });
    release();
    await reconcile.idle();
    expect(findCheckouts).toHaveBeenCalledTimes(1);
    // Within the interval: skipped.
    reconcile({ sessionKey: 'S1', session: { sessionWorkingDir: SESSION_DIR }, workingDirectory: SESSION_DIR });
    await reconcile.idle();
    expect(findCheckouts).toHaveBeenCalledTimes(1);

    const boom = createSessionPrReconciler({
      ...h.deps,
      minIntervalMs: 0,
      findCheckouts: async () => {
        throw new Error('disk gone');
      },
    });
    expect(() => boom({ sessionKey: 'S9', session: {}, workingDirectory: '/tmp/x' })).not.toThrow();
    await boom.idle();
    expect(() =>
      boom({ sessionKey: 'S9', session: null as unknown as Record<string, unknown>, workingDirectory: '' }),
    ).not.toThrow();
  });
});

describe('findGitCheckouts — the real git reader (#833 R8)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'pipe',
    })
      .toString()
      .trim();
  function repo(root: string, name: string, remote: string, branch: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
    git(dir, 'remote', 'add', 'origin', remote);
    if (branch !== 'main') git(dir, 'checkout', '-q', '-b', branch);
    return dir;
  }

  it('R8 — child checkouts and the root itself; skips main, deploy/*, detached, non-GitHub; no token leaks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r8-'));
    roots.push(root);
    const a = repo(root, 'app', 'https://x-access-token:ghs_SECRET@github.com/acme/app.git', 'feat/x');
    repo(root, 'mainline', 'https://github.com/acme/main.git', 'main');
    repo(root, 'deploy', 'git@github.com:acme/dep.git', 'deploy/dev');
    const d = repo(root, 'detached', 'https://github.com/acme/det', 'feat/y');
    git(d, 'checkout', '-q', '--detach');
    repo(root, 'gitlab', 'https://gitlab.com/acme/x.git', 'feat/z');
    const ssh = repo(root, 'ssh', 'git@github.com:Acme/Tool', 'fix/1');
    fs.mkdirSync(path.join(root, 'not-a-repo'));

    const found = await findGitCheckouts([root, root, path.join(root, 'missing')]);
    const sha = git(a, 'rev-parse', 'HEAD');
    expect(found.sort((x, y) => x.dir.localeCompare(y.dir))).toEqual([
      { dir: a, owner: 'acme', name: 'app', branch: 'feat/x', sha },
      { dir: ssh, owner: 'Acme', name: 'Tool', branch: 'fix/1', sha: git(ssh, 'rev-parse', 'HEAD') },
    ]);
    expect(JSON.stringify(found)).not.toContain('SECRET');
    // The root itself as a checkout.
    expect((await findGitCheckouts([a])).map((c) => c.dir)).toEqual([a]);
  });
});
