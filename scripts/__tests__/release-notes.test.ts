/**
 * scripts/release-notes.mjs and the notes scripts/version-bump.sh writes with it. 2026-11-21: two hosts got one commit
 * as v0.3.102-dev and v0.3.103-dev; the second deploy's range (v0.3.102-dev..HEAD) was empty and its notes read
 * "Initial release".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script without types
import { entriesFromLog, formatNotes, titleOf } from '../release-notes.mjs';

const VERSION_BUMP = path.join(__dirname, '..', 'version-bump.sh');
const NOTES = path.join(__dirname, '..', 'release-notes.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'rnotes-bin-'));
fs.symlinkSync(process.execPath, path.join(BIN, 'node'));
afterAll(() => fs.rmSync(BIN, { recursive: true, force: true }));
const ENV = {
  PATH: `${BIN}:/usr/bin:/bin`,
  HOME: os.tmpdir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, stdio: 'pipe' })
    .toString()
    .trim();

/** A PR branch with two inner commits, merged the way GitHub does ("Merge pull request #N from …" + the title). */
function mergePr(work: string, n: number, title: string) {
  git(work, 'checkout', '-q', '-b', `pr${n}`);
  for (const part of ['a', 'b']) {
    fs.writeFileSync(path.join(work, `pr${n}${part}.txt`), part);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `wip ${n}${part}`);
  }
  git(work, 'checkout', '-q', 'main');
  git(
    work,
    'merge',
    '-q',
    '--no-ff',
    `pr${n}`,
    '-m',
    `Merge pull request #${n} from o/pr${n}`,
    '-m',
    title,
    '-m',
    'Co-Authored-By: Z <z@x>',
  );
}

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnotes-'));
  dirs.push(root);
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote], { env: ENV });
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'base.txt'), 'base');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'remote', 'add', 'origin', remote);
  return work;
}

const bump = (cwd: string) =>
  spawnSync('bash', [VERSION_BUMP, 'main'], { cwd, env: ENV, encoding: 'utf8', timeout: 60_000 });
const versionJson = (cwd: string) => JSON.parse(fs.readFileSync(path.join(cwd, 'dist', 'version.json'), 'utf8'));

describe('release-notes.mjs — one line per merged PR', () => {
  it('titles: a merge commit by its PR title, a squash by its subject, anything else as is', () => {
    expect(
      titleOf('Merge pull request #1403 from o/feat-x', 'feat(dashboard): chip\n\nCo-Authored-By: Z <z@x>'),
    ).toEqual({
      title: 'feat(dashboard): chip',
      pr: 1403,
    });
    expect(titleOf('Merge pull request #7 from o/branch', '')).toEqual({ title: 'o/branch', pr: 7 });
    expect(titleOf('fix(slack): no message (#1391)', '')).toEqual({ title: 'fix(slack): no message', pr: 1391 });
    expect(titleOf('chore: direct commit', '')).toEqual({ title: 'chore: direct commit', pr: null });
  });

  it('parses git log records and formats bullets with a cap', () => {
    const log = `aaa\x1fMerge pull request #2 from o/b\x1fTitle two\n\x1e\nbbb\x1fone (#1)\x1f\x1e`;
    const entries = entriesFromLog(log);
    expect(entries).toEqual([
      { sha: 'aaa', title: 'Title two', pr: 2 },
      { sha: 'bbb', title: 'one', pr: 1 },
    ]);
    expect(formatNotes(entries)).toBe('• Title two (#2)\n• one (#1)');
    expect(formatNotes(entries, 1)).toBe('• Title two (#2)\n… 외 1건');
  });
});

describe('version-bump.sh — release notes', () => {
  it('a commit another host already got under the newest tag: notes come from the tag before it, as PR titles', () => {
    const work = repo();
    git(work, 'tag', '-a', 'v0.3.1-dev', '-m', 'v0.3.1-dev');
    mergePr(work, 12, 'feat: first change');
    mergePr(work, 13, 'fix: second change');
    fs.writeFileSync(path.join(work, 'sq.txt'), 'sq');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'docs: squashed change (#14)');
    // Host A got this commit an hour ago; this run deploys the same commit to host B.
    git(work, 'tag', '-a', 'v0.3.2-dev', '-m', 'v0.3.2-dev');

    const r = bump(work);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const v = versionJson(work);
    expect(v.tag).toBe('v0.3.3-dev');
    expect(v.releaseNotes).toBe(
      ['• docs: squashed change (#14)', '• fix: second change (#13)', '• feat: first change (#12)'].join('\n'),
    );
    expect(v.releaseNotes).not.toContain('Initial release');
    expect(v.releaseNotes).not.toContain('wip');

    const history = JSON.parse(fs.readFileSync(path.join(work, 'dist', 'release-history.json'), 'utf8'));
    expect(history.head).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(history.entries.slice(0, 4).map((e: { title: string }) => e.title)).toEqual([
      'docs: squashed change',
      'fix: second change',
      'feat: first change',
      'base',
    ]);
  }, 60_000);

  it('every tag on this very commit: "no code change", never "Initial release"', () => {
    const work = repo();
    git(work, 'tag', '-a', 'v0.3.1-dev', '-m', 'v0.3.1-dev');
    const r = bump(work);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(versionJson(work).releaseNotes).toBe('• 코드 변경 없음 — v0.3.1-dev와 같은 커밋 재배포');
  }, 60_000);

  it('no tag at all: a first release', () => {
    const work = repo();
    const r = bump(work);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(versionJson(work).releaseNotes).toBe('• 첫 배포');
  }, 60_000);

  it('the CLI fails loudly outside a git checkout', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rnotes-empty-'));
    dirs.push(empty);
    const r = spawnSync(process.execPath, [NOTES, 'notes', 'HEAD~1'], { cwd: empty, env: ENV, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[release-notes]');
  });
});
