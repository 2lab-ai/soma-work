/**
 * One checkout's two local layers (.prd/27 §4): what is not committed, and what is committed but in no pull request of
 * the session yet — plus the commits the session made there (HEAD's reflog), for the metrics.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { lineDiff } from '../conversation/artifact-diff';
import { githubRemoteOf } from '../session-pr-reconciler';
import {
  capPatch,
  joinDiff,
  looksBinary,
  MAX_PATCH_BYTES,
  newFilePatch,
  parseNumstatZ,
  splitPatch,
} from './git-diff-parse';
import { checkoutSafety, type GitRun, type GitRunBytes, pinGit, runGit, runGitBytes } from './git-runner';
import type { ChangedFile, CheckoutChanges, CommitRef, LayerFiles } from './types';

/** git's empty tree: the base of a checkout with no commit, and of a root commit's range. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const MAX_LAYER_FILES = 1000;
const MAX_UNTRACKED_PATCHES = 200;
const MAX_COMMITS_LISTED = 50;
const MAX_PR_HEADS = 20;
const DIFF_FLAGS = ['-M', '--no-color', '--no-ext-diff', '--no-textconv'];
const SHA = /^[0-9a-f]{40,64}$/;
/** The checkout is this session's but is not read at all: its config runs commands, or it borrows another object store. */
export const UNREAD_CHECKOUT = new Set(['repo-config-runs-commands', 'git-config-unreadable', 'repo-alternates']);

export interface PrHead {
  /** `owner/name` (lower case): a head of another repository never bounds this checkout. */
  repo?: string;
  headRef?: string;
  headSha?: string;
  createdAt?: number;
}

export interface CheckoutInput {
  dir: string;
  /** The session's own folder: the checkout's `dir` label is relative to it. */
  sessionRoot?: string;
  /** The session's folders: a checkout whose work tree or git dir is outside them is not read (default: the session root). */
  roots?: string[];
  sessionStartedAt?: number;
  /** The session's PRs in this checkout's repository: one whose head is this branch bounds the committed layer. */
  prHeads?: PrHead[];
  git?: GitRun;
  gitBytes?: GitRunBytes;
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

/** The files `git diff <from> <to>` reports between two commits (never the working tree — git-runner.ts). */
async function diffFiles(git: GitRun, dir: string, from: string, to: string): Promise<ChangedFile[] | undefined> {
  const numstat = await git(dir, ['diff', ...DIFF_FLAGS, '--numstat', '-z', from, to, '--']);
  if (numstat === undefined) return undefined;
  const entries = parseNumstatZ(numstat);
  if (entries.length === 0) return [];
  const patch = entries.length > MAX_LAYER_FILES ? '' : await git(dir, ['diff', ...DIFF_FLAGS, '-U3', from, to, '--']);
  return joinDiff(entries, splitPatch(patch ?? ''));
}

// ── The uncommitted layer, compared in this process ────────────────────────────────────────────────────────────────
// git never reads a working-tree file here (a clean filter or textconv would run then — git-runner.ts): the HEAD tree's
// blob ids are compared with the git hash of each file's bytes, and a changed file's patch is a line diff of the blob
// (`cat-file`, an object read) and the file. Files are read only through lstat'd, contained paths — never a symlink.

/** Files above this are compared by size only; above MAX_PATCH_SOURCE no patch is made. */
const MAX_HASH_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_SOURCE = 1024 * 1024;
const MAX_TRACKED = 50_000;
const MAX_PATCHES = 300;

interface TreeEntry {
  mode: string;
  sha: string;
  size: number;
  path: string;
}

/** `git ls-tree -r -z -l`: `<mode> blob <sha> <size>\t<path>\0` (submodules and trees skipped). */
export function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const rec of out.split('\0')) {
    const m = /^(\d{6}) blob ([0-9a-f]{40,64}) +(\d+)\t(.+)$/s.exec(rec);
    if (m) entries.push({ mode: m[1], sha: m[2], size: Number(m[3]), path: m[4] });
  }
  return entries;
}

/** git's object id of a blob with these bytes. */
export function blobId(bytes: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** A file known equal to its HEAD blob, by its stat — so an unchanged file is not read again next time. */
const sameAsHead = new Map<string, { size: number; mtimeMs: number; ino: number; sha: string }>();
const MAX_STAT_CACHE = 200_000;

async function contained(realTop: string, abs: string): Promise<boolean> {
  const real = await fs.realpath(abs).catch(() => '');
  return !!real && real.startsWith(`${realTop}${path.sep}`);
}

/** The line diff of two texts as a change; binary when either side looks binary. */
function textChange(
  rel: string,
  status: ChangedFile['status'],
  before: Buffer,
  after: Buffer,
): ChangedFile | undefined {
  const file: ChangedFile = { path: rel, status, additions: 0, deletions: 0 };
  if (looksBinary(before) || looksBinary(after)) {
    file.binary = true;
    return file;
  }
  const d = lineDiff(before.toString('utf8'), after.toString('utf8'));
  if (d.truncated) {
    file.patchTruncated = true;
    return file;
  }
  // Only line endings differ (lineDiff reads \r\n as \n): no change a reader can see.
  if (!d.text && status === 'modified') return undefined;
  file.additions = d.added;
  file.deletions = d.removed;
  if (d.text) {
    const capped = capPatch(d.text);
    file.patch = capped.patch;
    if (capped.truncated) file.patchTruncated = true;
  }
  return file;
}

async function readSmall(abs: string, size: number): Promise<Buffer | undefined> {
  if (size > MAX_PATCH_SOURCE) return undefined;
  return fs.readFile(abs).catch(() => undefined);
}

/** One HEAD entry against the working tree: undefined when unchanged (or not safely readable). */
async function trackedChange(
  gitBytes: GitRunBytes,
  dir: string,
  top: string,
  realTop: string,
  e: TreeEntry,
  format: 'sha1' | 'sha256',
  withPatch: boolean,
): Promise<ChangedFile | undefined> {
  const abs = path.join(top, e.path);
  const st = await fs.lstat(abs).catch(() => undefined);
  const before = async () =>
    withPatch && e.size <= MAX_PATCH_SOURCE ? gitBytes(dir, ['cat-file', 'blob', e.sha]) : undefined;
  const counted = (status: ChangedFile['status']): ChangedFile => ({
    path: e.path,
    status,
    additions: 0,
    deletions: 0,
    patchTruncated: true,
  });
  if (!st) {
    const old = await before();
    return old ? textChange(e.path, 'deleted', old, Buffer.alloc(0)) : counted('deleted');
  }
  if (!(await contained(realTop, abs)) && !st.isSymbolicLink()) return undefined;
  if (e.mode === '120000' || st.isSymbolicLink()) {
    // A link's blob is its target path; never follow it.
    const target = st.isSymbolicLink() ? await fs.readlink(abs).catch(() => undefined) : undefined;
    if (target !== undefined && e.mode === '120000' && blobId(Buffer.from(target), format) === e.sha) return undefined;
    const old = await before();
    return old && target !== undefined ? textChange(e.path, 'modified', old, Buffer.from(target)) : counted('modified');
  }
  if (!st.isFile()) return counted('modified');
  const hit = sameAsHead.get(abs);
  if (hit && hit.sha === e.sha && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino)
    return undefined;
  if (st.size === e.size) {
    if (st.size > MAX_HASH_BYTES) return undefined;
    const bytes = await fs.readFile(abs).catch(() => undefined);
    if (!bytes) return undefined;
    if (blobId(bytes, format) === e.sha) {
      if (sameAsHead.size > MAX_STAT_CACHE) sameAsHead.clear();
      sameAsHead.set(abs, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, sha: e.sha });
      return undefined;
    }
  }
  const [old, now] = await Promise.all([before(), withPatch ? readSmall(abs, st.size) : undefined]);
  return old && now ? textChange(e.path, 'modified', old, now) : counted('modified');
}

/** A new file (untracked, or added to the index only) as a change: a regular file inside the checkout. */
async function newFile(
  top: string,
  realTop: string,
  rel: string,
  withPatch: boolean,
): Promise<ChangedFile | undefined> {
  const abs = path.join(top, rel);
  const st = await fs.lstat(abs).catch(() => undefined);
  // Never through a symlink: its target can be any file the daemon can read.
  if (!st?.isFile() || !(await contained(realTop, abs))) return undefined;
  const file: ChangedFile = { path: rel, status: 'added', additions: 0, deletions: 0 };
  if (st.size > MAX_PATCH_BYTES || !withPatch) {
    if (st.size > MAX_PATCH_BYTES) file.patchTruncated = true;
    return file;
  }
  const buf = await fs.readFile(abs).catch(() => undefined);
  if (!buf) return file;
  if (looksBinary(buf)) {
    file.binary = true;
    return file;
  }
  const { patch, additions } = newFilePatch(buf.toString('utf8'));
  file.additions = additions;
  if (patch) {
    const capped = capPatch(patch);
    file.patch = capped.patch;
    if (capped.truncated) file.patchTruncated = true;
  }
  return file;
}

async function uncommittedLayer(
  git: GitRun,
  gitBytes: GitRunBytes,
  dir: string,
  top: string,
  head: string | undefined,
): Promise<CheckoutChanges['uncommitted']> {
  const failed = (skipped: string) => ({ files: [], additions: 0, deletions: 0, skipped });
  const format = trim(await git(dir, ['rev-parse', '--show-object-format'])) === 'sha256' ? 'sha256' : 'sha1';
  const listing = head ? await git(dir, ['ls-tree', '-r', '-z', '-l', '--full-tree', head]) : '';
  if (listing === undefined) return failed('git-diff-failed');
  const tree = parseLsTree(listing);
  if (tree.length > MAX_TRACKED) return failed('too-many-files');
  const realTop = await fs.realpath(top).catch(() => top);
  const files: ChangedFile[] = [];
  let patches = 0;
  for (const e of tree) {
    if (files.length >= MAX_LAYER_FILES) break;
    const f = await trackedChange(gitBytes, dir, top, realTop, e, format, patches < MAX_PATCHES);
    if (f) {
      files.push(f);
      if (f.patch) patches++;
    }
  }
  // New files: in the index only (git add, not committed), and untracked — names from git, bytes read here.
  const inTree = new Set(tree.map((e) => e.path));
  const indexed = (await git(dir, ['ls-files', '-z', '--cached'])) ?? '';
  const others = (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])) ?? '';
  const names = [...indexed.split('\0').filter((n) => n && !inTree.has(n)), ...others.split('\0').filter(Boolean)];
  let truncated = false;
  for (let i = 0; i < names.length; i++) {
    if (files.length >= MAX_LAYER_FILES) {
      truncated = true;
      break;
    }
    const f = await newFile(top, realTop, names[i], i < MAX_UNTRACKED_PATCHES);
    if (f) files.push(f);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return layer(files, truncated);
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
  // Every session PR head HEAD contains — this branch's own, or one under it (stacked branches) — and of those the one
  // fewest commits behind HEAD. A PR on this branch's name whose head is not in HEAD is not this work.
  let nearest = Number.POSITIVE_INFINITY;
  const heads = [...new Set(prHeads.map((p) => p.headSha).filter((h): h is string => !!h))].slice(0, MAX_PR_HEADS);
  // (prHeads are this checkout's repository's: checkoutChanges filters them.)
  for (const sha of heads) {
    if (!(await isAncestor(git, dir, sha, head))) continue;
    const behind = Number(trim(await git(dir, ['rev-list', '--count', `${sha}..${head}`])));
    if (Number.isFinite(behind) && behind < nearest) {
      nearest = behind;
      base = sha;
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
  const out = await git(dir, [
    'log',
    '--no-show-signature',
    `--max-count=${MAX_COMMITS_LISTED}`,
    '--format=%H%x1f%s%x1f%ct',
    ...range,
    '--',
  ]);
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

/**
 * The checkout at `dir`: its repository, branch, and two local layers. Undefined when it is not a git checkout or not
 * this session's (its work tree or git dir is outside the session's folders); a checkout the gate refuses to read
 * (git-runner `checkoutSafety`) comes back with both layers empty and the reason in `uncommitted.skipped`.
 */
export async function checkoutChanges(input: CheckoutInput): Promise<CheckoutChanges | undefined> {
  const dir = input.dir;
  const safety = await checkoutSafety(
    dir,
    input.roots ?? (input.sessionRoot ? [input.sessionRoot] : []),
    input.git ?? runGit,
  );
  if (!safety.ok && (safety.reason === 'not-a-checkout' || safety.reason === 'outside-session')) return undefined;
  // Every later call names the git dir and work tree resolved above, not whatever `.git` says by then.
  const git = safety.ok ? pinGit(input.git ?? runGit, safety) : (input.git ?? runGit);
  const gitBytes = safety.ok ? pinGit(input.gitBytes ?? runGitBytes, safety) : (input.gitBytes ?? runGitBytes);
  const head = trim(await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) || undefined;
  const branch = trim(await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || undefined;
  const remote = githubRemoteOf(trim(await git(dir, ['config', '--get', 'remote.origin.url'])));
  const repo = remote ? `${remote.owner}/${remote.name}`.toLowerCase() : `local:${path.basename(dir)}`;
  // A checkout the gate refuses is listed (its reason shows) and nothing else of it is read.
  const uncommitted: CheckoutChanges['uncommitted'] = !safety.ok
    ? { files: [], additions: 0, deletions: 0, skipped: safety.reason }
    : await uncommittedLayer(git, gitBytes, dir, safety.top, head);
  const unread = !safety.ok;
  const prHeads = (input.prHeads ?? []).filter((p) => !p.repo || p.repo === repo);
  const committed: CheckoutChanges['committed'] = unread
    ? { files: [], additions: 0, deletions: 0, commits: [] }
    : await committedLayer(git, dir, head, branch, prHeads, input.sessionStartedAt);
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
    '--no-show-signature',
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
      '--no-show-signature',
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
