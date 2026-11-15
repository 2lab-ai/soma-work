/**
 * One checkout's two local layers (.prd/27 §4): what is not committed, and what is committed but in no pull request of
 * the session yet — plus the commits the session made there (HEAD's reflog), for the metrics.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { githubRemoteOf } from '../session-pr-reconciler';
import { joinDiff, looksBinary, MAX_PATCH_BYTES, newFilePatch, parseNumstatZ, splitPatch } from './git-diff-parse';
import { type GitRun, runGit, worktreeSafe } from './git-runner';
import type { ChangedFile, CheckoutChanges, CommitRef, LayerFiles } from './types';

/** git's empty tree: the base of a checkout with no commit, and of a root commit's range. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const MAX_LAYER_FILES = 1000;
const MAX_UNTRACKED_PATCHES = 200;
const MAX_COMMITS_LISTED = 50;
const DIFF_FLAGS = ['-M', '--no-color', '--no-ext-diff', '--no-textconv'];
const SHA = /^[0-9a-f]{40,64}$/;

export interface PrHead {
  headRef?: string;
  headSha?: string;
  createdAt?: number;
}

export interface CheckoutInput {
  dir: string;
  /** The session's own folder: the checkout's `dir` label is relative to it. */
  sessionRoot?: string;
  sessionStartedAt?: number;
  /** The session's PRs in this checkout's repository: one whose head is this branch bounds the committed layer. */
  prHeads?: PrHead[];
  git?: GitRun;
}

const trim = (s: string | undefined) => (s === undefined ? undefined : s.trim());

export function checkoutId(dir: string): string {
  return createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 10);
}

function labelOf(dir: string, root?: string): string {
  if (root) {
    const rel = path.relative(path.resolve(root), path.resolve(dir));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    if (rel === '') return '.';
  }
  return path.basename(dir);
}

function totals(files: ChangedFile[]): Pick<LayerFiles, 'additions' | 'deletions'> {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions };
}

function layer(files: ChangedFile[], truncated: boolean): LayerFiles {
  const kept = files.slice(0, MAX_LAYER_FILES);
  const out: LayerFiles = { files: kept, ...totals(kept) };
  if (truncated || files.length > MAX_LAYER_FILES) out.truncated = true;
  return out;
}

/** The files `git diff <from> [<to>]` reports — the working tree when `to` is absent. */
async function diffFiles(git: GitRun, dir: string, from: string, to?: string): Promise<ChangedFile[] | undefined> {
  const range = to ? [from, to] : [from];
  const numstat = await git(dir, ['diff', ...DIFF_FLAGS, '--numstat', '-z', ...range, '--']);
  if (numstat === undefined) return undefined;
  const entries = parseNumstatZ(numstat);
  if (entries.length === 0) return [];
  const patch = entries.length > MAX_LAYER_FILES ? '' : await git(dir, ['diff', ...DIFF_FLAGS, '-U3', ...range, '--']);
  return joinDiff(entries, splitPatch(patch ?? ''));
}

/** A new untracked file as a change: a regular file inside the checkout, read up to the patch budget. */
async function untrackedFile(dir: string, rel: string, withPatch: boolean): Promise<ChangedFile | undefined> {
  const abs = path.join(dir, rel);
  let st: import('node:fs').Stats;
  try {
    st = await fs.lstat(abs);
  } catch {
    return undefined;
  }
  // Never through a symlink: its target can be any file the daemon can read.
  if (!st.isFile()) return undefined;
  const file: ChangedFile = { path: rel, status: 'added', additions: 0, deletions: 0 };
  if (st.size > MAX_PATCH_BYTES) {
    file.patchTruncated = true;
    return file;
  }
  if (!withPatch) return file;
  try {
    const [realDir, realFile] = await Promise.all([fs.realpath(dir), fs.realpath(abs)]);
    if (!realFile.startsWith(`${realDir}${path.sep}`)) return undefined;
    const buf = await fs.readFile(realFile);
    if (looksBinary(buf)) {
      file.binary = true;
      return file;
    }
    const { patch, additions } = newFilePatch(buf.toString('utf8'));
    file.additions = additions;
    if (patch) file.patch = patch;
  } catch {
    return file;
  }
  return file;
}

async function uncommittedLayer(
  git: GitRun,
  dir: string,
  head: string | undefined,
): Promise<CheckoutChanges['uncommitted']> {
  const gate = await worktreeSafe(dir, git);
  if (!gate.safe) return { files: [], additions: 0, deletions: 0, skipped: gate.reason };
  const tracked = await diffFiles(git, dir, head ?? EMPTY_TREE);
  if (tracked === undefined) return { files: [], additions: 0, deletions: 0, skipped: 'git-diff-failed' };
  const others = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
  const names = (others ?? '').split('\0').filter(Boolean);
  const room = Math.max(0, MAX_LAYER_FILES - tracked.length);
  const files = [...tracked];
  for (let i = 0; i < Math.min(names.length, room); i++) {
    const f = await untrackedFile(dir, names[i], i < MAX_UNTRACKED_PATCHES);
    if (f) files.push(f);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return layer(files, names.length > room);
}

async function isAncestor(git: GitRun, dir: string, sha: string, head: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  return (await git(dir, ['merge-base', '--is-ancestor', sha, head])) !== undefined;
}

/**
 * Where the committed layer starts: the newest session PR head on this branch that HEAD contains, else the merge-base with
 * the remote's default branch, else (no remote refs) the parent of the oldest commit since the session started. Then a
 * commit made before the session started inside that range moves the base up to it — earlier branch work is not this
 * session's.
 */
export async function committedBase(
  git: GitRun,
  dir: string,
  head: string,
  branch: string | undefined,
  prHeads: PrHead[],
  startedAt?: number,
): Promise<string | undefined> {
  let base: string | undefined;
  const own = prHeads
    .filter((p) => branch && p.headRef === branch && p.headSha)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  for (const p of own) {
    if (await isAncestor(git, dir, p.headSha!, head)) {
      base = p.headSha!;
      break;
    }
  }
  if (!base) {
    for (const ref of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
      const sha = trim(await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
      if (!sha) continue;
      base = trim(await git(dir, ['merge-base', head, sha]));
      if (base) break;
    }
  }
  const since = startedAt !== undefined ? Math.floor(startedAt / 1000) : undefined;
  if (!base) {
    if (since === undefined) return undefined;
    const list = trim(await git(dir, ['rev-list', `--since=${since}`, '--max-count=500', head]));
    const shas = (list ?? '').split('\n').filter(Boolean);
    if (shas.length === 0) return head;
    const oldest = shas[shas.length - 1];
    base = trim(await git(dir, ['rev-parse', '--verify', '--quiet', `${oldest}^`])) || EMPTY_TREE;
  }
  if (since !== undefined && base !== head) {
    const range = base === EMPTY_TREE ? [head] : [`${base}..${head}`];
    const before = trim(await git(dir, ['rev-list', `--before=${since}`, '--max-count=1', ...range]));
    if (before && SHA.test(before) && (await isAncestor(git, dir, before, head))) base = before;
  }
  return base;
}

async function commitsOf(git: GitRun, dir: string, base: string, head: string): Promise<CommitRef[]> {
  const range = base === EMPTY_TREE ? [head] : [`${base}..${head}`];
  const out = await git(dir, ['log', `--max-count=${MAX_COMMITS_LISTED}`, '--format=%H%x1f%s%x1f%ct', ...range, '--']);
  const commits: CommitRef[] = [];
  for (const line of (out ?? '').split('\n')) {
    const [sha, subject, ct] = line.split('\x1f');
    if (!sha || !SHA.test(sha)) continue;
    commits.push({ sha, subject: (subject ?? '').slice(0, 200), at: Number(ct) * 1000 || 0 });
  }
  return commits;
}

async function committedLayer(
  git: GitRun,
  dir: string,
  head: string | undefined,
  branch: string | undefined,
  prHeads: PrHead[],
  startedAt?: number,
): Promise<CheckoutChanges['committed']> {
  const empty = { files: [], additions: 0, deletions: 0, commits: [] };
  if (!head) return empty;
  const base = await committedBase(git, dir, head, branch, prHeads, startedAt);
  if (!base || base === head) return base ? { ...empty, base } : empty;
  const files = await diffFiles(git, dir, base, head);
  if (!files) return { ...empty, base };
  return { ...layer(files, false), base, commits: await commitsOf(git, dir, base, head) };
}

/** The checkout at `dir`: its repository, branch, and two local layers; undefined when it is not a git checkout. */
export async function checkoutChanges(input: CheckoutInput): Promise<CheckoutChanges | undefined> {
  const git = input.git ?? runGit;
  const dir = input.dir;
  const top = trim(await git(dir, ['rev-parse', '--show-toplevel']));
  if (!top) return undefined;
  const head = trim(await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) || undefined;
  const branch = trim(await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || undefined;
  const remote = githubRemoteOf(trim(await git(dir, ['config', '--get', 'remote.origin.url'])));
  const repo = remote ? `${remote.owner}/${remote.name}`.toLowerCase() : `local:${path.basename(dir)}`;
  const uncommitted = await uncommittedLayer(git, dir, head);
  const committed = await committedLayer(git, dir, head, branch, input.prHeads ?? [], input.sessionStartedAt);
  const out: CheckoutChanges = {
    id: checkoutId(dir),
    repo,
    dir: labelOf(dir, input.sessionRoot),
    uncommitted,
    committed,
  };
  if (branch) out.branch = branch;
  if (head) out.head = head;
  return out;
}

export interface SessionCommit {
  sha: string;
  /** When the commit was made here (its reflog entry), epoch ms. */
  at: number;
  additions: number;
  deletions: number;
}

const COMMIT_REFLOG = /^commit(?: \((?:amend|initial|merge)\))?:/;

/**
 * The commits made in this checkout since `sinceMs` — HEAD's reflog entries of the `commit` kind (a rebase, a
 * cherry-pick, a pull or a reset rewrites or moves, it does not author) — with their line counts. `skip` are the shas
 * already counted.
 */
export async function sessionCommits(
  dir: string,
  sinceMs: number,
  skip: ReadonlySet<string>,
  git: GitRun = runGit,
  max = 100,
): Promise<SessionCommit[]> {
  const out = await git(dir, [
    'log',
    '-g',
    '--date=unix',
    '--format=%H%x1f%gs%x1f%gd',
    '--max-count=300',
    'HEAD',
    '--',
  ]);
  const found: Array<{ sha: string; at: number }> = [];
  const seen = new Set<string>();
  for (const line of (out ?? '').split('\n')) {
    const [sha, subject, selector] = line.split('\x1f');
    if (!sha || !SHA.test(sha) || !COMMIT_REFLOG.test(subject ?? '')) continue;
    const at = Number(/@\{(\d+)\}/.exec(selector ?? '')?.[1]) * 1000;
    if (!Number.isFinite(at) || at < sinceMs || seen.has(sha) || skip.has(sha)) continue;
    seen.add(sha);
    found.push({ sha, at });
    if (found.length >= max) break;
  }
  const commits: SessionCommit[] = [];
  for (const c of found) {
    const stat = await git(dir, [
      'show',
      '--numstat',
      '--format=',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      c.sha,
    ]);
    if (stat === undefined) continue;
    let additions = 0;
    let deletions = 0;
    for (const line of stat.split('\n')) {
      const m = /^(\d+)\t(\d+)\t/.exec(line);
      if (!m) continue;
      additions += Number(m[1]);
      deletions += Number(m[2]);
    }
    commits.push({ ...c, additions, deletions });
  }
  return commits;
}
