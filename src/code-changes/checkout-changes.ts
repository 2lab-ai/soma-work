/**
 * One checkout's two local layers (.prd/27 §4): what is not committed, and what is committed but in no pull request of
 * the session yet — plus the commits the session made there (HEAD's reflog), for the metrics.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { lineDiff } from '../conversation/artifact-diff';
import { githubRemoteOf } from '../session-pr-reconciler';
import {
  capPatch,
  joinDiff,
  lineCounts,
  looksBinary,
  MAX_PATCH_BYTES,
  newFilePatch,
  parseNameStatusZ,
  parseNumstatZ,
  splitPatch,
} from './git-diff-parse';
import { checkoutSafety, type GitRun, type GitRunBytes, pinGit, runGit, runGitBytes } from './git-runner';
import type { ChangedFile, CheckoutChanges, CommitRef, LayerFiles } from './types';

/** A git read whose answer the layer needs did not come (a timeout, a lock): the layer is marked, not emptied. */
class GitReadFailed extends Error {}

/** git's empty tree (sha1): the base of a checkout with no commit, and of a root commit's range. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** The same in a sha256 repository. */
export const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';
const emptyTreeOf = (format: 'sha1' | 'sha256') => (format === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE);
export const MAX_LAYER_FILES = 1000;
const MAX_UNTRACKED_PATCHES = 200;
const MAX_COMMITS_LISTED = 50;
const MAX_PR_HEADS = 20;
const DIFF_FLAGS = [
  '-M',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--ignore-submodules=all',
  '--submodule=short',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];
const SHA = /^[0-9a-f]{40,64}$/;
/** The git dirs changed while they were read (a folder swapped, a pointer rewritten): the read is thrown away. */
export const CHANGED_DURING_READ = 'repo-changed-during-read';
/** git did not answer for a folder that has a `.git`: nothing read this time, the last read stands. */
export const GIT_FAILED = 'git-failed';
/** The checkout is this session's but is not read at all: its config runs commands, or it borrows another object store. */
export const UNREAD_CHECKOUT = new Set([
  'repo-config-runs-commands',
  'git-config-unreadable',
  'repo-alternates',
  'repo-links-outside',
  CHANGED_DURING_READ,
  GIT_FAILED,
]);

export interface PrHead {
  /** `owner/name` (lower case) the PR is in: a head of an unrelated repository never bounds this checkout. */
  repo?: string;
  /** The head's own repository when it is a fork's branch: a checkout of the fork matches it. */
  headRepo?: string;
  headSha?: string;
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
  /** The commits made here since `since` (epoch ms), past the `skip` shas, are read too (`sessionCommits`). */
  commits?: { since: number; skip: ReadonlySet<string> };
  git?: GitRun;
  gitBytes?: GitRunBytes;
}

/** A checkout read: its changes (stored) and the commits the session made in it (handed to the metrics). */
export interface CheckoutRead extends CheckoutChanges {
  sessionCommits?: SessionCommit[];
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

function totals(
  files: Array<Pick<ChangedFile, 'additions' | 'deletions'>>,
): Pick<LayerFiles, 'additions' | 'deletions'> {
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

/**
 * The files `git diff <from> <to>` reports between two commits (never the working tree — git-runner.ts). Undefined when
 * the file list could not be read. Each file's status comes from `--name-status`, not from its patch, so a file whose
 * patch is not kept — past MAX_LAYER_FILES, or the patch command failed or outgrew its output cap — keeps its status and
 * is marked `patchTruncated`.
 */
async function diffFiles(git: GitRun, dir: string, from: string, to: string): Promise<ChangedFile[] | undefined> {
  const numstat = await git(dir, ['diff', ...DIFF_FLAGS, '--numstat', '-z', from, to, '--']);
  if (numstat === undefined) return undefined;
  const entries = parseNumstatZ(numstat);
  if (entries.length === 0) return [];
  const names = await git(dir, ['diff', ...DIFF_FLAGS, '--name-status', '-z', from, to, '--']);
  if (names === undefined) return undefined;
  const statuses = parseNameStatusZ(names);
  const patch =
    entries.length > MAX_LAYER_FILES ? undefined : await git(dir, ['diff', ...DIFF_FLAGS, '-U3', from, to, '--']);
  const files = joinDiff(entries, splitPatch(patch ?? ''));
  for (const f of files) {
    const status = statuses.get(f.path);
    if (status) f.status = status;
    if (!f.patch && !f.binary && f.additions + f.deletions > 0) f.patchTruncated = true;
  }
  return files;
}

// ── The uncommitted layer, compared in this process ────────────────────────────────────────────────────────────────
// git never reads a working-tree file here (a clean filter or textconv would run then — git-runner.ts): the HEAD tree's
// blob ids are compared with the git hash of each file's bytes, and a changed file's patch is a line diff of the blob
// (`cat-file`, an object read) and the file. A file is read only through `readInside` — never through a symlink.

/** Files above this are compared by size only, and their lines are not counted. */
const MAX_HASH_BYTES = 8 * 1024 * 1024;
/** Files above this get no patch (their lines are still counted). */
const MAX_PATCH_SOURCE = 1024 * 1024;
const MAX_TRACKED = 50_000;
const MAX_PATCHES = 300;
/** The bytes one layer reads to count the lines of files it keeps no patch for. */
const MAX_COUNT_BYTES = 64 * 1024 * 1024;

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
const sameAsHead = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; ino: number; sha: string }>();
const MAX_STAT_CACHE = 200_000;

/** macOS 11+: the open fails on a symlink anywhere in the path, the kernel checking each folder as it walks it. */
export const O_NOFOLLOW_ANY = 0x20000000;

/**
 * A working-tree file's bytes, only if what is opened is a regular file of at most `max` bytes with this one name,
 * reached from `realTop` (a real path) without a symlink anywhere on the way. A check on the path before the open would
 * not do: a folder of it can be swapped for a link to anywhere between the check and the open (#1299 review). So the
 * kernel refuses a link on every component (macOS, O_NOFOLLOW_ANY), or the path it opened is read back from the open
 * handle and must be inside `realTop` (Linux, /proc/self/fd); elsewhere nothing is read. One name only (a hard link
 * to a file outside is that file), and opened without blocking (a FIFO swapped in cannot hang the collect).
 */
export async function readInside(
  realTop: string,
  rel: string,
  max: number,
  platform: NodeJS.Platform = process.platform,
): Promise<Buffer | undefined> {
  if (!rel || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return undefined;
  const abs = path.join(realTop, rel);
  let fh: import('node:fs/promises').FileHandle | undefined;
  try {
    if (platform === 'darwin') {
      fh = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | O_NOFOLLOW_ANY);
    } else if (platform === 'linux') {
      fh = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
      const opened = await fs.readlink(`/proc/self/fd/${fh.fd}`);
      if (!opened.startsWith(`${realTop}${path.sep}`)) return undefined;
    } else {
      return undefined;
    }
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

const countLines = (buf: Buffer) => {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
};

/** What one layer may still read: patches to keep, and bytes to read for counting lines. */
interface Budget {
  patches: number;
  countBytes: number;
}

/** Two texts equal once every \r before a \n is dropped (a checkout with CRLF line endings, its blob with LF). */
function sameIgnoringCr(a: Buffer, b: Buffer): boolean {
  const strip = (buf: Buffer) => buf.toString('latin1').replace(/\r\n/g, '\n');
  return strip(a) === strip(b);
}

/** A change whose lines could not be counted (a side unreadable or too large). */
const uncounted = (rel: string, status: ChangedFile['status']): ChangedFile => ({
  path: rel,
  status,
  additions: 0,
  deletions: 0,
  patchTruncated: true,
});

/**
 * Two versions of a file as a change: lines counted whether or not the patch is kept (a 1.5 MiB lockfile is still
 * +N −M), the patch only within the budget. Undefined when only line endings differ.
 */
function change(
  rel: string,
  status: ChangedFile['status'],
  before: Buffer | undefined,
  after: Buffer | undefined,
  budget: Budget,
): ChangedFile | undefined {
  if (!before || !after) return uncounted(rel, status);
  const file: ChangedFile = { path: rel, status, additions: 0, deletions: 0 };
  if (looksBinary(before) || looksBinary(after)) {
    file.binary = true;
    return file;
  }
  if (before.length <= MAX_PATCH_SOURCE && after.length <= MAX_PATCH_SOURCE) {
    const d = lineDiff(before.toString('utf8'), after.toString('utf8'));
    if (!d.truncated) {
      // Only line endings differ (lineDiff reads \r\n as \n): no change a reader can see.
      if (!d.text && status === 'modified') return undefined;
      file.additions = d.added;
      file.deletions = d.removed;
      if (d.text && budget.patches > 0) {
        budget.patches--;
        const capped = capPatch(d.text);
        file.patch = capped.patch;
        if (capped.truncated) file.patchTruncated = true;
      } else if (d.text) {
        file.patchTruncated = true;
      }
      return file;
    }
  }
  // Too large or too changed to diff here: counted as multisets, no patch. Only line endings differing is no change.
  if (status === 'modified' && sameIgnoringCr(before, after)) return undefined;
  const counts = lineCounts(before, after);
  file.additions = counts.additions;
  file.deletions = counts.deletions;
  file.patchTruncated = true;
  return file;
}

/** One HEAD entry against the working tree: undefined when unchanged (or not safely readable). */
async function trackedChange(
  gitBytes: GitRunBytes,
  realTop: string,
  e: TreeEntry,
  format: 'sha1' | 'sha256',
  budget: Budget,
  filemode = true,
): Promise<ChangedFile | undefined> {
  // Gone (ENOENT, ENOTDIR) is a deletion; any other error (EACCES, EIO) is not known — shown, without counts.
  const looked = await fs.lstat(path.join(realTop, e.path)).catch((err: NodeJS.ErrnoException) => err);
  if (looked instanceof Error && looked.code !== 'ENOENT' && looked.code !== 'ENOTDIR')
    return uncounted(e.path, 'modified');
  const st = looked instanceof Error ? undefined : looked;
  const file = await contentChange(gitBytes, realTop, e, format, budget, st);
  if (!filemode || (e.mode !== '100644' && e.mode !== '100755')) return file;
  // An executable bit flipped on a file git tracks the mode of is a change, with or without a content change.
  if (!st?.isFile()) return file;
  const now = st.mode & 0o111 ? '100755' : '100644';
  if (now === e.mode) return file;
  return {
    ...(file ?? { path: e.path, status: 'modified', additions: 0, deletions: 0 }),
    modeChange: `${e.mode} → ${now}`,
  };
}

async function contentChange(
  gitBytes: GitRunBytes,
  realTop: string,
  e: TreeEntry,
  format: 'sha1' | 'sha256',
  budget: Budget,
  st: import('node:fs').Stats | undefined,
): Promise<ChangedFile | undefined> {
  const abs = path.join(realTop, e.path);
  // A side is read when it fits the patch source, or the counting budget still holds it.
  const affordable = (size: number) => {
    if (size <= MAX_PATCH_SOURCE) return true;
    if (size > MAX_HASH_BYTES || budget.countBytes < size) return false;
    budget.countBytes -= size;
    return true;
  };
  const blob = async () => (affordable(e.size) ? gitBytes(realTop, ['cat-file', 'blob', e.sha]) : undefined);
  if (!st) return change(e.path, 'deleted', await blob(), Buffer.alloc(0), budget);
  if (e.mode === '120000' || st.isSymbolicLink()) {
    // A link's blob is its target path; never followed. Whether it changed is all that is told: a target read here
    // would be read through folders the model can swap.
    const target = st.isSymbolicLink() ? await fs.readlink(abs).catch(() => undefined) : undefined;
    if (target !== undefined && e.mode === '120000' && blobId(Buffer.from(target), format) === e.sha) return undefined;
    return uncounted(e.path, 'modified');
  }
  if (!st.isFile()) return uncounted(e.path, 'modified');
  // The ctime too: a write that keeps size and mtime (mtime set back) still moves the ctime.
  const hit = sameAsHead.get(abs);
  if (
    hit &&
    hit.sha === e.sha &&
    hit.size === st.size &&
    hit.mtimeMs === st.mtimeMs &&
    hit.ctimeMs === st.ctimeMs &&
    hit.ino === st.ino
  )
    return undefined;
  if (st.size === e.size) {
    if (st.size > MAX_HASH_BYTES) return undefined;
    const bytes = await readInside(realTop, e.path, MAX_HASH_BYTES);
    // Not readable (a second name, a link on the way): not known to be unchanged — shown, without counts.
    if (!bytes) return uncounted(e.path, 'modified');
    if (blobId(bytes, format) === e.sha) {
      if (sameAsHead.size > MAX_STAT_CACHE) sameAsHead.clear();
      sameAsHead.set(abs, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, sha: e.sha });
      return undefined;
    }
    return change(e.path, 'modified', affordable(e.size) ? await blob() : undefined, bytes, budget);
  }
  const now = affordable(st.size) ? await readInside(realTop, e.path, MAX_HASH_BYTES) : undefined;
  return change(e.path, 'modified', now ? await blob() : undefined, now, budget);
}

/** A new file (untracked, or added to the index only) as a change: a regular file inside the checkout. */
async function newFile(realTop: string, rel: string, budget: Budget): Promise<ChangedFile | undefined> {
  const st = await fs.lstat(path.join(realTop, rel)).catch(() => undefined);
  // Never a symlink: its target can be any file the daemon can read.
  if (!st?.isFile()) return undefined;
  const file: ChangedFile = { path: rel, status: 'added', additions: 0, deletions: 0 };
  // Its lines count whether or not its patch is kept (a large lockfile is still +N lines).
  const fits = st.size <= MAX_PATCH_SOURCE || (st.size <= MAX_HASH_BYTES && budget.countBytes >= st.size);
  if (fits && st.size > MAX_PATCH_SOURCE) budget.countBytes -= st.size;
  const buf = fits ? await readInside(realTop, rel, MAX_HASH_BYTES) : undefined;
  if (!buf) {
    file.patchTruncated = true;
    return file;
  }
  if (looksBinary(buf)) {
    file.binary = true;
    return file;
  }
  file.additions = countLines(buf);
  if (buf.length > MAX_PATCH_BYTES || budget.patches <= 0) {
    file.patchTruncated = true;
    return file;
  }
  const { patch } = newFilePatch(buf.toString('utf8'));
  if (patch) {
    budget.patches--;
    const capped = capPatch(patch);
    file.patch = capped.patch;
    if (capped.truncated) file.patchTruncated = true;
  }
  return file;
}

/** A HEAD file the index no longer has: a deletion, its lines counted from the blob. */
async function stagedDeletion(
  gitBytes: GitRunBytes,
  realTop: string,
  e: TreeEntry,
  budget: Budget,
): Promise<ChangedFile | undefined> {
  if (e.mode === '120000') return uncounted(e.path, 'deleted');
  const fits = e.size <= MAX_PATCH_SOURCE || (e.size <= MAX_HASH_BYTES && budget.countBytes >= e.size);
  if (fits && e.size > MAX_PATCH_SOURCE) budget.countBytes -= e.size;
  const blob = fits ? await gitBytes(realTop, ['cat-file', 'blob', e.sha]) : undefined;
  return change(e.path, 'deleted', blob, Buffer.alloc(0), budget);
}

/**
 * Whether HEAD names a branch with no commit yet. `for-each-ref` answers an empty list (and succeeds) for a ref that does
 * not exist, so a failed git (undefined) is told apart from a branch not born yet.
 */
async function unborn(git: GitRun, top: string): Promise<boolean> {
  const ref = trim(await git(top, ['symbolic-ref', '--quiet', 'HEAD']));
  if (!ref) return false;
  const tip = await git(top, ['for-each-ref', '--format=%(objectname)', ref]);
  return tip !== undefined && tip.trim() === '';
}

async function uncommittedLayer(
  git: GitRun,
  gitBytes: GitRunBytes,
  top: string,
  head: string | undefined,
  format: 'sha1' | 'sha256',
): Promise<CheckoutChanges['uncommitted']> {
  const failed = (skipped: string) => ({ files: [], additions: 0, deletions: 0, skipped });
  const listing = head ? await git(top, ['ls-tree', '-r', '-z', '-l', '--full-tree', head]) : '';
  // git's own default is true; a checkout on a filesystem without modes says false.
  const filemode = trim(await git(top, ['config', '--bool', 'core.filemode'])) !== 'false';
  if (listing === undefined) return failed('git-diff-failed');
  const tree = parseLsTree(listing);
  if (tree.length > MAX_TRACKED) return failed('too-many-files');
  // New files: in the index only (git add, not committed), and untracked — names from git, bytes read here.
  // `-v` tags each index entry: a skip-worktree one (sparse checkout, `S`/`s`) or an assume-unchanged one (lowercase)
  // is not in the work tree on purpose — git does not report it, nor does this.
  const indexed = await git(top, ['ls-files', '-z', '-v', '--cached']);
  const others = await git(top, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (indexed === undefined || others === undefined) return failed('git-diff-failed');
  // One name per path: a conflicted path is listed once per stage.
  const inIndex = new Set<string>();
  const notInTree = new Set<string>();
  for (const rec of indexed.split('\0')) {
    const m = /^(\S) (.+)$/s.exec(rec);
    if (!m) continue;
    inIndex.add(m[2]);
    if (m[1] === 'S' || m[1] !== m[1].toUpperCase()) notInTree.add(m[2]);
  }
  // `top` is the gate's real path, witnessed: files are read under it as checked, never under a fresh resolve.
  const realTop = top;
  const budget: Budget = { patches: MAX_PATCHES, countBytes: MAX_COUNT_BYTES };
  const files: ChangedFile[] = [];
  let truncated = false;
  for (const e of tree) {
    if (files.length >= MAX_LAYER_FILES) {
      truncated = true;
      break;
    }
    if (notInTree.has(e.path)) continue;
    // Removed from the index only (`git rm --cached`): committing now deletes it, whatever the work tree holds.
    const f = inIndex.has(e.path)
      ? await trackedChange(gitBytes, realTop, e, format, budget, filemode)
      : await stagedDeletion(gitBytes, realTop, e, budget);
    if (f) files.push(f);
  }
  const inTree = new Set(tree.map((e) => e.path));
  // A HEAD path is reported once, above — not again as untracked when only the index lost it.
  const names = [
    ...new Set(
      [...inIndex].filter((n) => !inTree.has(n)).concat(others.split('\0').filter((n) => n && !inTree.has(n))),
    ),
  ];
  const newBudget: Budget = { patches: Math.min(budget.patches, MAX_UNTRACKED_PATCHES), countBytes: budget.countBytes };
  for (const name of names) {
    if (truncated) break;
    if (files.length >= MAX_LAYER_FILES) {
      truncated = true;
      break;
    }
    const f = await newFile(realTop, name, newBudget);
    if (f) files.push(f);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return layer(files, truncated);
}

/**
 * Whether `sha` is in `head`'s history. A commit this checkout does not have is not; a git that fails to answer throws
 * (GitReadFailed) — a failed answer is not "no", which would pick a wrong base (#1299 review). `rev-list` answers both
 * questions with a plain success: `--ignore-missing` lists nothing for an unknown object, and `<sha> --not <head>` lists
 * nothing exactly when `head` contains it.
 */
async function isAncestor(git: GitRun, dir: string, sha: string, head: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  const known = await git(dir, ['rev-list', '--ignore-missing', '--no-walk', sha, '--']);
  if (known === undefined) throw new GitReadFailed('rev-list');
  if (!known.trim()) return false;
  const outside = await git(dir, ['rev-list', '--max-count=1', sha, '--not', head, '--']);
  if (outside === undefined) throw new GitReadFailed('rev-list');
  return outside.trim() === '';
}

/**
 * Where the committed layer starts: the newest session PR head on this branch that HEAD contains, else the merge-base with
 * the remote's default branch, else (no remote refs) the parent of the oldest commit since the session started. When the
 * merge-base contains that PR head, the merge-base wins — it is the nearer of the two. Then a
 * commit made before the session started inside that range moves the base up to it — earlier branch work is not this
 * session's.
 */
export async function committedBase(
  git: GitRun,
  dir: string,
  head: string,
  prHeads: PrHead[],
  startedAt?: number,
  emptyTree: string = EMPTY_TREE,
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
  let fromPr = base !== undefined;
  let mergeBase: string | undefined;
  for (const ref of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    const sha = trim(await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
    if (!sha) continue;
    mergeBase = trim(await git(dir, ['merge-base', head, sha])) || undefined;
    if (mergeBase) break;
  }
  if (!base) base = mergeBase;
  else if (mergeBase && mergeBase !== base && (await isAncestor(git, dir, base, mergeBase))) {
    // The default branch went past the PR head and this branch has it — a branch cut from main after the PR merged, or
    // main merged in. What lies between is other merged work, not this session's commits (dev, 2026-11-16).
    base = mergeBase;
    fromPr = false;
  }
  const since = startedAt !== undefined ? Math.floor(startedAt / 1000) : undefined;
  // An answer git failed to give is not "no commits": the layer is marked failed, not read as empty (#1299 review).
  const must = async (args: string[]) => {
    const out = await git(dir, args);
    if (out === undefined) throw new GitReadFailed(args[0]);
    return out.trim();
  };
  if (!base) {
    if (since === undefined) return undefined;
    const shas = (await must(['rev-list', `--since=${since}`, '--max-count=500', head])).split('\n').filter(Boolean);
    if (shas.length === 0) return head;
    const oldest = shas[shas.length - 1];
    // `<sha> <parent>…`: a root commit lists no parent, and its range starts at the empty tree.
    const parents = (await must(['rev-list', '--parents', '--max-count=1', oldest])).split(/\s+/).slice(1);
    base = parents[0] && SHA.test(parents[0]) ? parents[0] : emptyTree;
  }
  // Only for a base that is not a session PR head (that one is the session's own baseline), and only along the base's
  // own line: a pre-session commit merged in from elsewhere (a second parent) never becomes the base (#1299 review).
  if (since !== undefined && base !== head && !fromPr) {
    const range = base === emptyTree ? [head] : [`${base}..${head}`];
    const before = await must(['rev-list', '--first-parent', `--before=${since}`, '--max-count=1', ...range]);
    const onLine = base === emptyTree || (!!before && (await isAncestor(git, dir, base, before)));
    if (before && SHA.test(before) && onLine && (await isAncestor(git, dir, before, head))) base = before;
  }
  return base;
}

async function commitsOf(
  git: GitRun,
  dir: string,
  base: string,
  head: string,
  emptyTree: string,
): Promise<CommitRef[]> {
  const range = base === emptyTree ? [head] : [`${base}..${head}`];
  const out = await git(dir, [
    'log',
    '--no-show-signature',
    `--max-count=${MAX_COMMITS_LISTED}`,
    '--format=%H%x1f%s%x1f%ct',
    ...range,
    '--',
  ]);
  if (out === undefined) throw new GitReadFailed('log');
  const commits: CommitRef[] = [];
  for (const line of out.split('\n')) {
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
  prHeads: PrHead[],
  emptyTree: string,
  startedAt?: number,
): Promise<CheckoutChanges['committed']> {
  const empty = { files: [], additions: 0, deletions: 0, commits: [] };
  if (!head) return empty;
  let base: string | undefined;
  try {
    base = await committedBase(git, dir, head, prHeads, startedAt, emptyTree);
  } catch (error) {
    if (error instanceof GitReadFailed) return { ...empty, skipped: 'git-diff-failed' };
    throw error;
  }
  if (!base || base === head) return base ? { ...empty, base } : empty;
  const files = await diffFiles(git, dir, base, head);
  // A failed diff is not "nothing committed": the collector keeps the last layer read, with the reason.
  if (!files) return { ...empty, base, skipped: 'git-diff-failed' };
  try {
    return { ...layer(files, false), base, commits: await commitsOf(git, dir, base, head, emptyTree) };
  } catch (error) {
    if (error instanceof GitReadFailed) return { ...empty, base, skipped: 'git-diff-failed' };
    throw error;
  }
}

/**
 * The checkout at `dir`: its repository, branch, and two local layers. Undefined when it is not a git checkout or not
 * this session's (its work tree or git dir is outside the session's folders). A checkout the gate refuses to read
 * (git-runner `checkoutSafety`), or whose git dirs changed while they were read, comes back with both layers empty and
 * the reason in `skipped` — and nothing read from it.
 */
export async function checkoutChanges(input: CheckoutInput): Promise<CheckoutRead | undefined> {
  const dir = input.dir;
  const safety = await checkoutSafety(
    dir,
    input.roots ?? (input.sessionRoot ? [input.sessionRoot] : []),
    input.git ?? runGit,
  );
  if (!safety.ok && (safety.reason === 'not-a-checkout' || safety.reason === 'outside-session')) return undefined;
  // (`git-failed` falls through to `unread`: the collector keeps the checkout's last read, whole.)
  const unread = (skipped: string): CheckoutRead => ({
    id: checkoutId(dir),
    // Not even the remote is read from a checkout that is not read.
    repo: `local:${path.basename(dir)}`,
    dir: labelOf(dir, input.sessionRoot),
    uncommitted: { files: [], additions: 0, deletions: 0, skipped },
    committed: { files: [], additions: 0, deletions: 0, commits: [], skipped },
  });
  if (!safety.ok) return unread(safety.reason);
  // Every later call names the git dir and work tree resolved above, not whatever `.git` says by then.
  const git = pinGit(input.git ?? runGit, safety);
  const gitBytes = pinGit(input.gitBytes ?? runGitBytes, safety);
  const top = safety.top;
  const head = trim(await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) || undefined;
  const branch = trim(await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || undefined;
  // No HEAD commit: a branch with no commit yet — or git failed, which must not read every file as new.
  if (!head && !(await unborn(git, top))) return unread(GIT_FAILED);
  const format = trim(await git(top, ['rev-parse', '--show-object-format'])) === 'sha256' ? 'sha256' : 'sha1';
  const remote = githubRemoteOf(trim(await git(top, ['config', '--get', 'remote.origin.url'])));
  const repo = remote ? `${remote.owner}/${remote.name}`.toLowerCase() : `local:${path.basename(dir)}`;
  const uncommitted = await uncommittedLayer(git, gitBytes, top, head, format);
  // A PR bounds this checkout when it is this repository's, or its head is (a fork's branch, the PR upstream).
  const prHeads = (input.prHeads ?? []).filter((p) => !p.repo || p.repo === repo || p.headRepo === repo);
  const committed = await committedLayer(git, top, head, prHeads, emptyTreeOf(format), input.sessionStartedAt);
  const made = input.commits ? await sessionCommits(top, input.commits.since, input.commits.skip, git) : undefined;
  // Everything above came from the git dirs as checked — or they changed meanwhile, and none of it is kept.
  if (!(await safety.witness.intact())) return unread(CHANGED_DURING_READ);
  const out: CheckoutRead = {
    id: checkoutId(dir),
    repo,
    dir: labelOf(dir, input.sessionRoot),
    uncommitted,
    committed,
  };
  if (branch) out.branch = branch;
  if (head) out.head = head;
  if (made) out.sessionCommits = made;
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
    // The reflog keeps whole seconds: a commit in the session's first second is not before it.
    if (!Number.isFinite(at) || at < Math.floor(sinceMs / 1000) * 1000 || seen.has(sha) || skip.has(sha)) continue;
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
      '-z',
      '--format=',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--ignore-submodules=all',
      c.sha,
      '--',
    ]);
    if (stat === undefined) continue;
    commits.push({ ...c, ...totals(parseNumstatZ(stat)) });
  }
  return commits;
}
