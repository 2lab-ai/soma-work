/**
 * `scripts/sanitize-scan.sh` — the scan behind the Sanitize Gate workflow.
 *
 * The scan accepts one fixed baseline commit: everything reachable from it is
 * published history that cannot be rewritten, so it is not re-judged on every
 * run. What the scan must still catch is anything that enters history after
 * that commit, and anything in the tree being shipped. Each case below builds a
 * small synthetic repository and runs the real script against it, so every rule
 * is pinned by the scan's exit code rather than by reading the script:
 *
 * - baseline content carried forward unchanged is accepted — on HEAD's
 *   ancestry, on side refs, and through a pull-request merge commit;
 * - HEAD's tree is scanned in full, baseline content included;
 * - on HEAD's ancestry a blob is judged by what each commit introduces against
 *   each of its parents, not by the blob's age: a baseline blob that is
 *   re-added, copied, renamed or kept by a merge is scanned, even when a later
 *   commit removes it again;
 * - every object new since the baseline is scanned, on every ref;
 * - path names and ref names are still checked across the full history;
 * - a match is counted in the runner's UTF-8 locale even when its line holds a
 *   byte that is not valid UTF-8, and content is matched exactly as stored, so
 *   no transform can splice fragments or move line boundaries into a match;
 * - a non-ASCII letter folds case in path and ref names but not in object
 *   content, where a pattern has to spell both cases as an alternation;
 * - a git command that fails is an error (exit 2), never a short input that
 *   counts as zero matches.
 *
 * The pattern is a dummy that only these repositories contain. The real pattern
 * set is a CI secret and never appears in the repository. The strings that do
 * match the dummy are assembled at runtime, so this file does not match its own
 * pattern.
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const SCAN_SCRIPT = path.join(repoRoot, 'scripts', 'sanitize-scan.sh');

const PATTERN = 'TESTLEAK_[0-9a-f]{8}';

/** A string the dummy pattern matches — never written out whole in this file. */
function leak(hex: string): string {
  return ['TESTLEAK', hex].join('_');
}

/** Present in the baseline commit's own tree. */
const FIXTURE = 'fixture.txt';
const FIXTURE_BODY = `host = ${leak('0badc0de')}\n`;

/** Present earlier in the baseline's history, deleted before the baseline commit. */
const RETIRED = 'retired.txt';
const RETIRED_BODY = `host = ${leak('00c0ffee')}\n`;

/** Pinned so commit IDs do not depend on the wall clock. */
const FIXED_DATE = '2001-02-03T04:05:06Z';

/**
 * The locale the self-hosted runner's environment sets for every job. Scans run
 * in it, so locale-dependent matching is exercised the way CI exercises it.
 */
const RUNNER_LOCALE = 'C.UTF-8';

/**
 * Longer, with room to spare, than the stretch of input (32 KiB) that BSD grep
 * inspects for a NUL byte before deciding to read the input as text.
 */
const NO_NUL_SPAN = 40 * 1024;

/** `text` behind a byte that is not valid UTF-8 (a lone Latin-1 e-acute). */
function notUtf8(text: string): Buffer {
  return Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(text)]);
}

/**
 * `head` + a fixed-width nonce + `tail`, with the nonce chosen so that the blob's
 * object ID begins with `idPrefix`. Only the nonce varies, so `head` is hashed
 * once.
 */
function blobWithIdPrefix(head: Buffer, tail: Buffer, idPrefix: string): Buffer {
  const nonceLength = 'nonce 00000000\n'.length;
  const hashed = crypto
    .createHash('sha1')
    .update(`blob ${head.length + nonceLength + tail.length}\0`)
    .update(head);
  for (let n = 0; n < 100_000_000; n++) {
    const nonce = Buffer.from(`nonce ${String(n).padStart(8, '0')}\n`);
    if (hashed.copy().update(nonce).update(tail).digest('hex').startsWith(idPrefix)) {
      return Buffer.concat([head, nonce, tail]);
    }
  }
  throw new Error(`no nonce gives an object ID starting ${idPrefix}`);
}

/**
 * A NUL-free blob longer than NO_NUL_SPAN whose object ID begins with four zero
 * hex digits, so that it sorts ahead of every other object in these small
 * repositories — the scan hands objects to grep in ID order.
 */
function leadingBlob(): Buffer {
  const body = Buffer.from('filler line of plain ascii text\n'.repeat(NO_NUL_SPAN / 32 + 64));
  return blobWithIdPrefix(body, Buffer.alloc(0), '0000');
}

/** Total content bytes of every object in the repository. */
function objectBytes(repo: FixtureRepo): number {
  return repo
    .git('cat-file', '--batch-all-objects', '--batch-check=%(objectsize)')
    .split('\n')
    .reduce((sum, size) => sum + Number(size), 0);
}

let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-scan-'));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

interface ScanResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Only what git and the script need. The caller's environment is not inherited:
 * a `GIT_DIR` or a global config (signing, hooks, default branch) leaking in
 * from the machine running the suite would change what these repositories are.
 */
function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: scratch,
    TMPDIR: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Sanitize Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_NAME: 'Sanitize Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_DATE: FIXED_DATE,
  };
}

class FixtureRepo {
  /** The commit the scan accepts as already published; set by the seeding helper. */
  baseline = '';

  constructor(readonly dir: string) {}

  git(...args: string[]): string {
    return this.run(args);
  }

  /** As `git`, with `input` on stdin. */
  gitWithInput(input: string | Buffer, ...args: string[]): string {
    return this.run(args, input);
  }

  private run(args: string[], input?: string | Buffer): string {
    const result = spawnSync('git', args, { cwd: this.dir, env: baseEnv(), encoding: 'utf8', input });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  /** Writes each path (string or bytes) or deletes it (null), stages everything, commits, and returns the commit ID. */
  commit(message: string, changes: Record<string, string | Buffer | null> = {}): string {
    for (const [file, content] of Object.entries(changes)) {
      const target = path.join(this.dir, file);
      if (content === null) {
        fs.rmSync(target);
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    }
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  /** Runs the real script. An `undefined` override removes that variable. */
  scan(overrides: Record<string, string | undefined> = {}): ScanResult {
    const env: Record<string, string> = {
      ...baseEnv(),
      LANG: RUNNER_LOCALE,
      SANITIZE_PATTERNS: PATTERN,
      SANITIZE_BASELINE: this.baseline,
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const result = spawnSync('bash', [SCAN_SCRIPT], { cwd: this.dir, env, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }
}

function emptyRepo(): FixtureRepo {
  const repo = new FixtureRepo(fs.mkdtempSync(path.join(scratch, 'repo-')));
  repo.git('init', '-q', '-b', 'main');
  return repo;
}

/**
 * Baseline history with three kinds of accepted contamination: a file still in
 * the baseline commit's tree, a file deleted before the baseline, and a commit
 * message.
 */
function seededRepo(): FixtureRepo {
  const repo = emptyRepo();
  repo.commit(`seed ${leak('5eed5eed')}`, {
    'README.md': 'seed\n',
    [FIXTURE]: FIXTURE_BODY,
    [RETIRED]: RETIRED_BODY,
  });
  repo.baseline = repo.commit('retire one file', { 'README.md': 'baseline\n', [RETIRED]: null });
  return repo;
}

function removeFixture(repo: FixtureRepo): string {
  return repo.commit('remove fixture', { [FIXTURE]: null });
}

/**
 * Merges `branch` into the checked-out commit, then puts `file` back as `keepFrom`
 * has it (default: the merged branch; `HEAD` is the first parent) before committing.
 */
function mergeKeeping(repo: FixtureRepo, branch: string, file: string, message: string, keepFrom = branch): string {
  repo.git('merge', '-q', '--no-ff', '--no-commit', branch);
  repo.git('checkout', keepFrom, '--', file);
  repo.git('commit', '-q', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

function expectClean(result: ScanResult): void {
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('sanitize-scan: objects=0 paths=0 refs=0\n');
  expect(result.stdout).toContain('sanitize-scan: clean\n');
  expect(result.status).toBe(0);
}

function expectFound(result: ScanResult, counts: RegExp): void {
  expect(result.stdout).toMatch(counts);
  expect(result.stderr).toContain('sanitize-scan: FORBIDDEN PATTERN FOUND');
  expect(result.status).toBe(1);
}

function expectRefused(result: ScanResult, subcommand: string): void {
  expect(result.stderr).toContain(`sanitize-scan: git ${subcommand} failed`);
  expect(result.stdout).not.toContain('sanitize-scan: objects=');
  expect(result.stdout).not.toContain('sanitize-scan: clean');
  expect(result.status).toBe(2);
}

/**
 * A directory holding a stand-in `tool` for the scan's PATH. It passes every
 * call through to the real tool, except a call whose arguments match the glob in
 * FAIL_ARGS: that one writes the first line of the real output and then exits
 * 128, the way a process dying mid-stream would.
 */
function failingToolDir(tool: string): string {
  const which = spawnSync('sh', ['-c', `command -v ${tool}`], { env: baseEnv(), encoding: 'utf8' });
  const real = which.stdout.trim();
  expect(path.isAbsolute(real), `${tool} resolved to '${real}'`).toBe(true);
  const dir = fs.mkdtempSync(path.join(scratch, `${tool}-shim-`));
  const shim = [
    '#!/bin/sh',
    'case "$*" in',
    '  $FAIL_ARGS)',
    `    '${real}' "$@" | head -n 1`,
    '    exit 128 ;;',
    'esac',
    `exec '${real}' "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, tool), shim, { mode: 0o755 });
  return dir;
}

/** Scan overrides that make the `tool` call matching `args` fail mid-stream. */
function failing(args: string, tool = 'git'): Record<string, string> {
  return { PATH: `${failingToolDir(tool)}:${baseEnv().PATH}`, FAIL_ARGS: args };
}

describe('sanitize scan — baseline content that is only inherited is accepted', () => {
  it('(a) passes once HEAD is clean, when later commits carry baseline content forward unchanged', () => {
    const repo = seededRepo();
    // Side refs on baseline history: a branch at the pre-baseline commit (whose
    // tree and message both match) and an annotated tag on the baseline itself.
    repo.git('branch', 'archived', 'HEAD~1');
    repo.git('tag', '-a', 'v-baseline', '-m', 'baseline release', repo.baseline);
    repo.commit('add docs', { 'docs.txt': 'docs\n' });
    repo.commit('edit readme', { 'README.md': 'edited\n' });
    removeFixture(repo);
    repo.commit('edit docs', { 'docs.txt': 'docs, edited\n' });

    expectClean(repo.scan());
  });

  it('(h) passes when a ref outside HEAD ancestry re-adds baseline content through a merge', () => {
    const repo = seededRepo();
    const cleaned = removeFixture(repo);
    repo.git('checkout', '-q', '-b', 'legacy', repo.baseline);
    repo.commit('legacy work', { 'legacy.txt': 'legacy\n' });
    repo.git('checkout', '-q', '-b', 'deploy', cleaned);
    mergeKeeping(repo, 'legacy', FIXTURE, 'merge legacy into deploy');
    repo.git('checkout', '-q', 'main');
    repo.commit('main work', { 'docs.txt': 'docs\n' });

    expectClean(repo.scan());
  });

  it('(h2) passes when a ref outside HEAD ancestry re-adds a blob from deeper baseline history', () => {
    // The blob is reachable from the baseline but sits in no tree the walk from
    // that ref meets at its boundary. Acceptance is by reachability from the
    // baseline, not by whatever the boundary trees happen to contain.
    const repo = seededRepo();
    const cleaned = removeFixture(repo);
    repo.git('checkout', '-q', '-b', 'deploy', cleaned);
    repo.commit('restore retired file', { [RETIRED]: RETIRED_BODY });
    repo.git('checkout', '-q', 'main');

    expectClean(repo.scan());
  });

  it('(j) passes for a pull-request merge commit whose branch started on the baseline and never touched its content', () => {
    const repo = seededRepo();
    const cleanedMain = removeFixture(repo);
    repo.git('checkout', '-q', '-b', 'feature', repo.baseline);
    repo.commit('feature', { 'feature.txt': 'one\n' });
    repo.commit('feature, continued', { 'feature.txt': 'two\n', 'README.md': 'feature readme\n' });
    // The pull_request event checks out the merge ref detached: base first, head second.
    repo.git('checkout', '-q', '--detach', cleanedMain);
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge feature into main', 'feature');

    expectClean(repo.scan());
  });
});

describe('sanitize scan — HEAD and what its ancestry introduces are scanned', () => {
  it('(b) fails while HEAD still contains baseline content', () => {
    const repo = seededRepo();
    repo.commit('add docs', { 'docs.txt': 'docs\n' });

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(c) fails when a blob deleted before the baseline is re-added with the same content', () => {
    const repo = seededRepo();
    removeFixture(repo);
    repo.commit('restore retired file', { [RETIRED]: RETIRED_BODY });

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(d) fails when baseline content is re-added in one commit and deleted in a later one', () => {
    const repo = seededRepo();
    removeFixture(repo);
    repo.commit('restore retired file', { [RETIRED]: RETIRED_BODY });
    repo.commit('delete it again', { [RETIRED]: null });

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(e) fails when a baseline blob is renamed to a new path, even after the new path is deleted', () => {
    const repo = seededRepo();
    repo.git('mv', FIXTURE, 'renamed.txt');
    repo.commit('rename fixture');
    repo.commit('drop renamed fixture', { 'renamed.txt': null });

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(e2) fails when a baseline blob is copied to a new path, even after both paths are deleted', () => {
    const repo = seededRepo();
    repo.commit('copy fixture', { 'copy/fixture.txt': FIXTURE_BODY });
    repo.commit('drop both', { [FIXTURE]: null, 'copy/fixture.txt': null });

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(f) fails for a brand-new matching blob, even after it is deleted', () => {
    const repo = seededRepo();
    removeFixture(repo);
    repo.commit('add notes', { 'notes.txt': `host = ${leak('feedf00d')}\n` });
    repo.commit('drop notes', { 'notes.txt': null });

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(f2) fails for a matching commit message after the baseline', () => {
    const repo = seededRepo();
    removeFixture(repo);
    repo.commit(`note ${leak('c0ffee11')}`, { 'docs.txt': 'docs\n' });

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(g) fails for a merge that keeps baseline content one parent had dropped, even after a later removal', () => {
    const repo = seededRepo();
    removeFixture(repo);
    repo.git('checkout', '-q', '-b', 'topic', repo.baseline);
    repo.commit('topic work', { 'topic.txt': 'topic\n' });
    repo.git('checkout', '-q', 'main');
    mergeKeeping(repo, 'topic', FIXTURE, 'merge topic');
    repo.git('branch', '-D', 'topic');
    removeFixture(repo);

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(g3) fails when only the diff against a second parent shows the reintroduction', () => {
    // The merge is made on the branch that still has the file, so against its
    // first parent nothing changes; against the cleaned parent the file is added.
    // main then fast-forwards onto it, and a later commit removes the file.
    const repo = seededRepo();
    const cleaned = removeFixture(repo);
    repo.git('checkout', '-q', '-b', 'topic', repo.baseline);
    repo.commit('topic work', { 'topic.txt': 'topic\n' });
    mergeKeeping(repo, cleaned, FIXTURE, 'merge main into topic', 'HEAD');
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--ff-only', 'topic');
    repo.git('branch', '-D', 'topic');
    removeFixture(repo);

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(g2) fails for baseline content introduced by a root commit merged in from unrelated history', () => {
    // The root commit's content is compared against the empty tree; nothing
    // after it still holds the blob, so only that comparison can see it.
    const repo = seededRepo();
    removeFixture(repo);
    repo.git('checkout', '-q', '--orphan', 'imported');
    repo.git('rm', '-rfq', '.');
    repo.commit('imported root', { [FIXTURE]: FIXTURE_BODY });
    repo.commit('imported cleanup', { [FIXTURE]: null, 'imported.txt': 'imported\n' });
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--allow-unrelated-histories', '-m', 'merge imported history', 'imported');
    repo.git('branch', '-D', 'imported');

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(n) fails when a clean file is rewritten to baseline content, even after a later deletion', () => {
    const repo = seededRepo();
    removeFixture(repo);
    repo.commit('rewrite readme', { 'README.md': FIXTURE_BODY });
    repo.commit('drop readme', { 'README.md': null });

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(o) fails when a file becomes a symlink whose target is baseline content, even after a later deletion', () => {
    // A symlink is a blob holding its target. Index only: no link is created on
    // disk, and the baseline blob itself becomes the link.
    const repo = seededRepo();
    const fixtureBlob = repo.git('rev-parse', `${repo.baseline}:${FIXTURE}`);
    removeFixture(repo);
    repo.git('update-index', '--cacheinfo', `120000,${fixtureBlob},README.md`);
    repo.git('commit', '-q', '-m', 'readme becomes a link');
    expect(repo.git('diff-tree', '-r', '--no-commit-id', 'HEAD~1', 'HEAD')).toMatch(
      /^:100644 120000 [0-9a-f]{40} [0-9a-f]{40} T\tREADME\.md$/,
    );
    repo.commit('drop readme', { 'README.md': null });

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(o2) fails when a symlink becomes a file holding baseline content, even after a later deletion', () => {
    const repo = seededRepo();
    const fixtureBlob = repo.git('rev-parse', `${repo.baseline}:${FIXTURE}`);
    removeFixture(repo);
    const target = repo.gitWithInput('docs.txt', 'hash-object', '-w', '--stdin');
    repo.git('update-index', '--add', '--cacheinfo', `120000,${target},link`);
    repo.git('commit', '-q', '-m', 'add link');
    repo.git('update-index', '--cacheinfo', `100644,${fixtureBlob},link`);
    repo.git('commit', '-q', '-m', 'link becomes a file');
    expect(repo.git('diff-tree', '-r', '--no-commit-id', 'HEAD~1', 'HEAD')).toMatch(
      /^:120000 100644 [0-9a-f]{40} [0-9a-f]{40} T\tlink$/,
    );
    repo.git('rm', '-q', '--cached', 'link');
    repo.git('commit', '-q', '-m', 'drop link');

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });
});

describe('sanitize scan — new objects on every ref are scanned', () => {
  it('(i) fails when a ref outside HEAD ancestry holds a new matching blob', () => {
    const repo = seededRepo();
    removeFixture(repo);
    repo.git('checkout', '-q', '-b', 'side');
    repo.commit('side notes', { 'notes.txt': `host = ${leak('feedf00d')}\n` });
    repo.git('checkout', '-q', 'main');

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(m) fails for an annotated tag whose message matches, even on the baseline commit', () => {
    const repo = seededRepo();
    removeFixture(repo);
    repo.git('tag', '-a', 'v1', '-m', `release ${leak('7a6a7a6a')}`, repo.baseline);

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });
});

describe('sanitize scan — path names and ref names keep their full-history check', () => {
  it('(l) fails for a matching path name added after the baseline and deleted again', () => {
    const repo = seededRepo();
    removeFixture(repo);
    const name = `${leak('cafebabe')}.txt`;
    repo.commit('add file', { [name]: 'clean\n' });
    repo.commit('delete file', { [name]: null });

    expectFound(repo.scan(), /sanitize-scan: objects=\d+ paths=1 refs=0\n/);
  });

  it('(l2) fails for a matching path name that exists only before the baseline', () => {
    const repo = emptyRepo();
    const name = `${leak('cafebabe')}.txt`;
    repo.commit('add file', { 'README.md': 'seed\n', [name]: 'clean\n' });
    repo.baseline = repo.commit('delete file', { [name]: null });

    expectFound(repo.scan(), /sanitize-scan: objects=0 paths=1 refs=0\n/);
  });

  it('(l3) fails for a matching ref name', () => {
    const repo = seededRepo();
    removeFixture(repo);
    repo.git('branch', leak('abcdef12'));

    expectFound(repo.scan(), /sanitize-scan: objects=0 paths=0 refs=1\n/);
  });
});

describe('sanitize scan — refuses to run without its inputs', () => {
  it('(k) exits 2 when the pattern set is missing or empty', () => {
    const repo = seededRepo();
    for (const value of [undefined, '']) {
      const result = repo.scan({ SANITIZE_PATTERNS: value });
      expect(result.stderr).toContain('SANITIZE_PATTERNS env var required');
      expect(result.stdout).toBe('');
      expect(result.status).toBe(2);
    }
  });

  it('(k2) exits 2 when the baseline commit is not in the clone', () => {
    const repo = seededRepo();
    removeFixture(repo);
    const blob = repo.git('rev-parse', `${repo.baseline}:README.md`);
    const cases: (string | undefined)[] = [
      // Unset: the default is the real repository's baseline, absent from a synthetic repository.
      undefined,
      '0123456789abcdef0123456789abcdef01234567',
      // A full commit ID is required; a ref name or an abbreviation is not one.
      'HEAD',
      repo.baseline.slice(0, 12),
      // Present, but not a commit.
      blob,
    ];
    for (const baseline of cases) {
      const result = repo.scan({ SANITIZE_BASELINE: baseline });
      expect(result.stderr, `baseline ${baseline}`).toContain('sanitize-scan: baseline');
      expect(result.stdout, `baseline ${baseline}`).toBe('');
      expect(result.status, `baseline ${baseline}`).toBe(2);
    }
  });

  it('defaults the baseline to one full commit ID, overridable from the environment only', () => {
    const script = fs.readFileSync(SCAN_SCRIPT, 'utf8');
    // Regex, not a string literal: the literal form reads as an unterminated
    // JS template placeholder to Biome.
    expect(script).toMatch(/^BASELINE="\$\{SANITIZE_BASELINE:-[0-9a-f]{40}\}"$/m);
    expect(script).toContain('0477d8f12d8f643e7d5fe756d14d2e19e7321ccd');
  });
});

describe('sanitize scan — a byte that is not UTF-8 does not hide a match', () => {
  // Scans run in RUNNER_LOCALE. There, BSD grep reads its input as text unless a
  // NUL byte turns up in the first 32 KiB, and read as text, a line holding a
  // byte that is not valid UTF-8 never matches — with or without -a. Each case
  // puts the only match on such a line, where exactly one count can see it.

  it('(p) counts it in object content, with no NUL early in the scanned content', () => {
    // Tree objects always contain NUL bytes, so a leading blob is what keeps
    // them out of the window grep inspects.
    const repo = seededRepo();
    removeFixture(repo);
    const leading = leadingBlob();
    repo.commit('add docs', { 'filler.txt': leading, 'notes.txt': notUtf8(` host = ${leak('feedf00d')}\n`) });

    // The leading blob is the first object grep sees, and it is NUL-free past the window.
    const ids = repo.git('cat-file', '--batch-all-objects', '--batch-check=%(objectname)').split('\n').sort();
    expect(ids[0]).toBe(repo.git('rev-parse', 'HEAD:filler.txt'));
    expect(leading.length).toBeGreaterThan(NO_NUL_SPAN);
    expect(leading.includes(0)).toBe(false);

    expectFound(repo.scan(), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });

  it('(p2) counts it in a path name', () => {
    // Index only: the path is never created on disk, where the filesystem could
    // refuse the name. It exists only before the baseline, so only the path
    // listing holds it.
    const repo = emptyRepo();
    const seed = repo.commit('seed', { 'README.md': 'seed\n' });
    const blob = repo.gitWithInput('clean\n', 'hash-object', '-w', '--stdin');
    const entry = Buffer.concat([Buffer.from(`100644 ${blob}\t`), notUtf8(`-${leak('cafebabe')}.txt\n`)]);
    repo.gitWithInput(entry, 'update-index', '--add', '--index-info');
    repo.git('commit', '-q', '-m', 'add file');
    repo.git('read-tree', seed);
    repo.git('commit', '-q', '-m', 'delete file');
    repo.baseline = repo.git('rev-parse', 'HEAD');

    expectFound(repo.scan(), /sanitize-scan: objects=0 paths=1 refs=0\n/);
  });

  it('(p3) counts it in a ref name', () => {
    // packed-refs rather than a loose ref, so the name never becomes a file name.
    const repo = seededRepo();
    const head = removeFixture(repo);
    const packed = Buffer.concat([
      Buffer.from(`# pack-refs with: peeled fully-peeled sorted \n${head} refs/tags/`),
      notUtf8(`-${leak('abcdef12')}\n`),
    ]);
    fs.writeFileSync(path.join(repo.dir, '.git', 'packed-refs'), packed);
    expect(repo.git('for-each-ref', '--format=%(refname)')).toContain(leak('abcdef12'));

    expectFound(repo.scan(), /sanitize-scan: objects=0 paths=0 refs=1\n/);
  });
});

describe('sanitize scan — non-ASCII case folding', () => {
  it('(p4) folds the case of a non-ASCII pattern the way the runner locale does', () => {
    // The byte-wise count cannot fold e-acute to E-acute; the count in the
    // inherited locale can, on text input. A ref name is text input that only
    // the ref count sees. Counting byte-wise only would lose it.
    const repo = seededRepo();
    const head = removeFixture(repo);
    const name = ['TESTLEAK', '\u00c90badc0de'].join('_');
    fs.writeFileSync(
      path.join(repo.dir, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted \n${head} refs/tags/${name}\n`,
    );
    expect(repo.git('for-each-ref', '--format=%(refname)')).toContain(name);

    const pattern = ['TESTLEAK', '\u00e9[0-9a-f]{8}'].join('_');
    expectFound(repo.scan({ SANITIZE_PATTERNS: pattern }), /sanitize-scan: objects=0 paths=0 refs=1\n/);
  });

  it('(r) does not fold one in object content, where both cases must be spelled as an alternation', () => {
    // Object content nearly always has a NUL in the first 32 KiB grep inspects
    // (tree objects hold NUL bytes). From there BSD grep in a UTF-8 locale
    // matches no non-ASCII pattern letter, and the byte-wise count matches one
    // only as written. This pins the limitation the script documents and the
    // spelling it prescribes.
    const repo = seededRepo();
    removeFixture(repo);
    repo.commit('add notes', {
      'notes.txt': Buffer.concat([
        Buffer.from([0, 0x0a]),
        Buffer.from(`host = ${['TESTLEAK', '\u00c90badc0de'].join('_')}\n`),
      ]),
    });
    // All of the scan input fits in the window, so that NUL is inside it.
    expect(objectBytes(repo)).toBeLessThan(32 * 1024);

    const withLetter = (letter: string) => ['TESTLEAK', `${letter}[0-9a-f]{8}`].join('_');
    // The other case only: not folded.
    expectClean(repo.scan({ SANITIZE_PATTERNS: withLetter('\u00e9') }));
    // A bracket expression: matches in neither count.
    expectClean(repo.scan({ SANITIZE_PATTERNS: withLetter('[\u00e9\u00c9]') }));
    // An alternation: the byte-wise count matches it.
    expectFound(
      repo.scan({ SANITIZE_PATTERNS: withLetter('(\u00e9|\u00c9)') }),
      /sanitize-scan: objects=1 paths=0 refs=0\n/,
    );
  });
});

describe('sanitize scan — content is matched as stored, never transformed', () => {
  // Guards against rewriting content before matching. A false hit in published
  // history could not be cleared without rewriting that history.

  it('(q) does not match fragments split by a NUL byte or by a byte that is not UTF-8', () => {
    // Deleting the separating byte would splice the fragments into one.
    const repo = seededRepo();
    removeFixture(repo);
    repo.commit('add fragments', {
      'fragments.bin': Buffer.concat([
        Buffer.from('TESTLE'),
        Buffer.from([0]),
        Buffer.from('AK_deadbeef\n'),
        Buffer.from('TESTLE'),
        Buffer.from([0xff]),
        Buffer.from('AK_deadbeef\n'),
        Buffer.from('TESTLE'),
        Buffer.from([0xf8, 0x88, 0x80, 0x80, 0x80]),
        Buffer.from('AK_deadbeef\n'),
      ]),
    });

    expectClean(repo.scan());
  });

  it('(q2) does not match an anchored pattern against a fragment between separating bytes', () => {
    // Turning the separators into line breaks would make the fragment a line
    // of its own, and ^...$ would match it.
    const repo = seededRepo();
    removeFixture(repo);
    const fragment = Buffer.from(leak('deadbeef'));
    repo.commit('add fragments', {
      'fragments.bin': Buffer.concat([
        Buffer.from('prefix'),
        Buffer.from([0]),
        fragment,
        Buffer.from([0]),
        Buffer.from('suffix\n'),
        Buffer.from('prefix'),
        Buffer.from([0xff]),
        fragment,
        Buffer.from([0xff]),
        Buffer.from('suffix\n'),
      ]),
    });
    const anchored = `^${PATTERN}$`;
    expectClean(repo.scan({ SANITIZE_PATTERNS: anchored }));

    // The anchored pattern does match the same text on a line of its own.
    repo.commit('add line', { 'line.txt': `${leak('deadbeef')}\n` });
    expectFound(repo.scan({ SANITIZE_PATTERNS: anchored }), /sanitize-scan: objects=1 paths=0 refs=0\n/);
  });
});

describe('sanitize scan — a failed command is never a clean result', () => {
  // Each state is caught by exactly one of the three counts. If the git command
  // feeding that count died after one line, grep would see a short input with
  // no match, and the other two counts are zero anyway: a green result for a
  // scan that never ran.
  const counted: { args: string; subcommand: string; state: () => FixtureRepo }[] = [
    {
      // HEAD still holds baseline content: only the content scan sees it.
      args: 'cat-file --batch',
      subcommand: 'cat-file',
      state: () => {
        const repo = seededRepo();
        repo.commit('add docs', { 'docs.txt': 'docs\n' });
        return repo;
      },
    },
    {
      // A path name from before the baseline: only the path listing sees it.
      args: 'rev-list --all --objects',
      subcommand: 'rev-list',
      state: () => {
        const repo = emptyRepo();
        const name = `${leak('cafebabe')}.txt`;
        repo.commit('add file', { 'README.md': 'seed\n', [name]: 'clean\n' });
        repo.baseline = repo.commit('delete file', { [name]: null });
        return repo;
      },
    },
    {
      // A tag name, listed after refs/heads/main: only the ref listing sees it.
      args: 'for-each-ref --format=%(refname)',
      subcommand: 'for-each-ref',
      state: () => {
        const repo = seededRepo();
        removeFixture(repo);
        repo.git('tag', leak('abcdef12'));
        return repo;
      },
    },
  ];

  for (const { args, subcommand, state } of counted) {
    it(`exits 2 when \`git ${args}\` fails mid-stream`, () => {
      const repo = state();
      expect(repo.scan().status).toBe(1);

      expectRefused(repo.scan(failing(args)), subcommand);
    });
  }

  it('exits 2 when the baseline lookup fails, even after printing the expected type', () => {
    const repo = seededRepo();
    removeFixture(repo);
    const result = repo.scan(failing('cat-file -t *'));
    expect(result.stderr).toContain('sanitize-scan: baseline');
    expect(result.stdout).toBe('');
    expect(result.status).toBe(2);
  });

  it('exits 2 when resolving HEAD fails, even after printing a commit ID', () => {
    const repo = seededRepo();
    removeFixture(repo);
    const result = repo.scan(failing('rev-parse --verify *'));
    expect(result.stderr).toContain('sanitize-scan: HEAD');
    expect(result.stdout).toBe('');
    expect(result.status).toBe(2);
  });

  it('exits 2 when grep cannot evaluate the pattern', () => {
    // grep's exit 1 means "no match"; a malformed pattern is exit 2 and must not
    // be read as a count.
    const repo = seededRepo();
    removeFixture(repo);
    const result = repo.scan({ SANITIZE_PATTERNS: '(' });
    expect(result.stderr).toContain('sanitize-scan: grep failed');
    expect(result.stdout).not.toContain('sanitize-scan: objects=');
    expect(result.status).toBe(2);
  });

  it('exits 2 when any git command building the scan sets fails', () => {
    const repo = seededRepo();
    removeFixture(repo);
    // The stand-in itself changes nothing when no call matches.
    expectClean(repo.scan(failing('no-such-call')));

    const producers: [string, string][] = [
      ['rev-list --objects [0-9a-f]*', 'rev-list'],
      ['rev-list --objects --all --not *', 'rev-list'],
      ['for-each-ref --format=%(objectname)', 'for-each-ref'],
      ['rev-list --parents *', 'rev-list'],
      ['diff-tree --stdin *', 'diff-tree'],
      ['ls-tree -r *', 'ls-tree'],
    ];
    for (const [args, subcommand] of producers) {
      const result = repo.scan(failing(args));
      expect(result.status, args).toBe(2);
      expectRefused(result, subcommand);
    }
  });
});

describe('sanitize scan — debug output', () => {
  it('reports the size of each scan set on stderr, and nothing else', () => {
    const repo = seededRepo();
    repo.commit('add docs', { 'docs.txt': 'docs\n' });

    const result = repo.scan({ SANITIZE_DEBUG: '1' });
    // New since the baseline: the commit, its tree, the docs blob. Introduced on
    // HEAD's ancestry: the docs blob. HEAD's tree: README, fixture, docs.
    expect(result.stderr).toContain('sanitize-scan: debug A=3 B=1 C=3 scanned=5\n');
    expect(result.stderr).not.toContain('TESTLEAK');
    expect(result.stdout).toContain('sanitize-scan: objects=1 paths=0 refs=0\n');
    expect(result.status).toBe(1);

    const quiet = repo.scan();
    expect(quiet.stderr).not.toContain('debug');
  });
});
