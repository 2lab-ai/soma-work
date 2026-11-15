/**
 * The git the daemon runs in a session's folder (.prd/27 §5). The folder's repositories are the model's to write — their
 * config can name commands (a clean filter, an fsmonitor hook, a textconv, a signature program, a lazy-fetch transport)
 * that git would run as the daemon, outside the sandbox, and pointers (`core.worktree`, a `.git` file, alternates) that
 * send git outside the checkout. The model can change that config at any moment, so no defence may rest on a check made
 * before the call (the #1299 review's check/use race). What holds on every call, whatever the config says then:
 *
 *   - git never reads a working-tree file's content: the uncommitted layer is compared in this process
 *     (checkout-changes.ts), so no clean filter or textconv ever runs. `ls-files --others` lists names only;
 *   - command-line `-c` wins over the repository's config: fsmonitor, hooks, external diff and signature checks are off;
 *     every transport is refused, by name too (a repository's `protocol.<name>.allow` outranks a general
 *     `protocol.allow`), and lazy fetching is off (`GIT_NO_LAZY_FETCH`); submodules are never entered; no pager; no gc;
 *   - no global or system config, no tokens in the environment, no optional index writes;
 *   - diffs are between two commits only, with `--no-ext-diff --no-textconv`, and logs with `--no-show-signature`.
 *
 * `checkoutSafety` adds what a check can give: the work tree, git dir and common dir inside the session's folders, no
 * alternates, no link anywhere in the git dirs, and no command-running key in the config (a repository that asks for one
 * is listed, not read). The paths it resolves are pinned on every later call (`pinGit`), so a `.git` file rewritten
 * meanwhile is not followed; and the folders it walked are noted (`PathWitness`), so a git dir swapped for a link to
 * another repository while git reads it is seen afterwards and the read is thrown away (checkout-changes.ts).
 *
 * Every call is bounded (10 s, 16 MiB of output) and answers undefined on any failure — never throws.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PathWitness } from './path-witness';

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
};

/** The transports git knows by name. */
const TRANSPORTS = ['ext', 'file', 'git', 'ssh', 'http', 'https'];

const SAFE_FLAGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.relative=false',
  '-c',
  'protocol.allow=never',
  // A repository's `protocol.<name>.allow=always` outranks the general key: each transport is refused by name too.
  ...TRANSPORTS.flatMap((name) => ['-c', `protocol.${name}.allow=never`]),
  '-c',
  'diff.submodule=short',
  '-c',
  'submodule.recurse=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '--no-pager',
];

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export type GitRun = (dir: string, args: string[]) => Promise<string | undefined>;

export type GitRunBytes = (dir: string, args: string[]) => Promise<Buffer | undefined>;

/** Run git in `dir` with the hardened flags; the raw stdout bytes, or undefined on failure. */
export const runGitBytes: GitRunBytes = (dir, args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...SAFE_FLAGS, '-C', dir, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: GIT_ENV, encoding: 'buffer' },
      (error, stdout) => resolve(error ? undefined : (stdout as Buffer)),
    );
  });

/** {@link runGitBytes} as text (not trimmed). */
export const runGit: GitRun = (dir, args) => runGitBytes(dir, args).then((out) => out?.toString('utf8'));

/**
 * A runner whose every call starts in the work tree and names the git dir `checkoutSafety` resolved (not whatever `.git`
 * says now). The `dir` a caller passes is ignored: every path git prints is relative to the work tree's top.
 */
export function pinGit<T>(
  git: (dir: string, args: string[]) => Promise<T>,
  pin: { gitDir: string; top: string },
): (dir: string, args: string[]) => Promise<T> {
  return (_dir, args) => git(pin.top, [`--git-dir=${pin.gitDir}`, `--work-tree=${pin.top}`, ...args]);
}

/**
 * Config keys that make git run a command (or read outside the checkout) while it reads a repository: filters and diff
 * drivers on working-tree files, signature checks on commits, pagers, a relocated work tree. The ones every call already
 * turns off (`core.fsmonitor`, `log.showSignature`, external diff) still refuse the repository: one that asks for them is
 * not one to read blindly.
 */
const RUNS_COMMANDS = [
  /^gpg\./,
  /^log\.showsignature$/,
  /^core\.worktree$/,
  /^pager\./,
  /^filter\./,
  /\.textconv$/,
  /\.command$/,
  /\.process$/,
  /^core\.fsmonitor$/,
  /^core\.sshcommand$/,
  /^core\.pager$/,
  /^core\.askpass$/,
  /^diff\.external$/,
  // Transports and what fetches through them (a partial clone's promisor remote, a custom upload-pack).
  /^protocol\./,
  /^remote\..*\.promisor$/,
  /^remote\..*\.(?:uploadpack|receivepack|vcs)$/,
  /^extensions\.partialclone$/,
  /^core\.alternaterefscommand$/,
  /^uploadpack\./,
];

/**
 * The config keys of a `git config --list --name-only --show-scope` answer (`<scope>\t<key>` per line) that run a
 * command. The `command` scope is this module's own `-c` flags, never the repository's.
 */
export function commandKeys(listing: string): string[] {
  const keys: string[] = [];
  for (const line of listing.split('\n')) {
    const tab = line.indexOf('\t');
    const scope = tab >= 0 ? line.slice(0, tab) : '';
    const key = (tab >= 0 ? line.slice(tab + 1) : line).trim().toLowerCase();
    if (!key || scope === 'command') continue;
    if (RUNS_COMMANDS.some((re) => re.test(key))) keys.push(key);
  }
  return keys;
}

/**
 * Whether the checkout's config (repository, worktree, includes — no global or system) names no command. Unknown (git
 * failed) is not safe.
 */
export async function configSafe(dir: string, git: GitRun = runGit): Promise<{ safe: boolean; reason?: string }> {
  const names = await git(dir, ['config', '--list', '--name-only', '--show-scope']);
  if (names === undefined) return { safe: false, reason: 'git-config-unreadable' };
  const keys = commandKeys(names);
  return keys.length ? { safe: false, reason: 'repo-config-runs-commands' } : { safe: true };
}

export type CheckoutSafety =
  | {
      ok: true;
      top: string;
      gitDir: string;
      /** The work tree's and git dirs' folders (from the session folder down, and all inside the git dirs) as checked. */
      witness: PathWitness;
    }
  | { ok: false; reason: 'not-a-checkout' | 'outside-session' }
  /** git did not answer for a folder that has a `.git` (a timeout, a lock): not "no checkout" — try again later. */
  | { ok: false; reason: 'git-failed' }
  | {
      ok: false;
      reason: 'repo-config-runs-commands' | 'git-config-unreadable' | 'repo-alternates' | 'repo-links-outside';
      top: string;
    };

const real = (p: string) => fs.realpath(p).catch(() => path.resolve(p));

/** How many entries of a git dir `noLinksIn` reads before it gives up (and refuses the checkout). */
export const MAX_GIT_ENTRIES = 100_000;

/** Files of a git dir whose content sends git elsewhere: noted, so one rewritten during a read is seen. */
const POINTER_FILES = ['commondir', 'config', 'config.worktree', path.join('objects', 'info', 'alternates')];

/**
 * Whether the tree under `dir` holds no symlink (lstat only — nothing is followed or read). A git dir whose objects,
 * refs, index or logs are links can point git at another repository the daemon can read (#1299 review). Every folder is
 * noted on `witness` before it is listed, so one swapped later is seen. Gives up past MAX_GIT_ENTRIES — a repository
 * that large is not read.
 */
export async function noLinksIn(dir: string, max = MAX_GIT_ENTRIES, witness = new PathWitness()): Promise<boolean> {
  const stack = [dir];
  let seen = 0;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if ((await witness.note(cur)) !== 'dir') return false;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (++seen > max) return false;
      if (e.isSymbolicLink()) return false;
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
    }
  }
  return true;
}
const inside = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(`${r}${path.sep}`));

/**
 * The session's folders as real paths, anchored where the model cannot move them (#1299 review): only the outermost
 * folders count — one inside another (the turn's folder inside the session's) adds nothing to the containment but a
 * path the model can swap for a link to another session's checkout, so it is dropped — and an outermost folder that is
 * itself a link is no root. What is above an outermost folder is the daemon's, not the model's.
 */
export async function trustedRoots(roots: string[]): Promise<string[]> {
  const lexical = [...new Set(roots.map((r) => path.resolve(r)))];
  const outermost = lexical.filter((r) => !lexical.some((o) => o !== r && inside(r, [o])));
  const out: string[] = [];
  for (const r of outermost) {
    const st = await fs.lstat(r).catch(() => undefined);
    if (!st?.isDirectory()) continue;
    const realRoot = await fs.realpath(r).catch(() => undefined);
    if (realRoot) out.push(realRoot);
  }
  return out;
}

/**
 * Whether the daemon may read the checkout at `dir` at all (.prd/27 §5): its work tree, git dir and common dir are inside
 * `roots` (the session's folders), it borrows no other object store, and its config runs no command. `outside-session`
 * and `not-a-checkout` mean it is not this session's checkout; the config reasons mean it is, but is not read.
 */
export async function checkoutSafety(dir: string, roots: string[], git: GitRun = runGit): Promise<CheckoutSafety> {
  const out = await git(dir, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir',
  ]);
  if (out === undefined) {
    // git failed: a folder with a `.git` is still a checkout — its last read stands; one without is none.
    const dotGit = await fs.lstat(path.join(dir, '.git')).catch(() => undefined);
    return dotGit ? { ok: false, reason: 'git-failed' } : { ok: false, reason: 'not-a-checkout' };
  }
  const lines = out.split('\n').map((l) => l.trim());
  if (lines.length < 3 || !lines[0] || !lines[1] || !lines[2]) return { ok: false, reason: 'not-a-checkout' };
  const realRoots = await trustedRoots(roots.length ? roots : [dir]);
  const [top, gitDir, common] = await Promise.all(lines.slice(0, 3).map(real));
  if (!inside(top, realRoots) || !inside(gitDir, realRoots) || !inside(common, realRoots)) {
    return { ok: false, reason: 'outside-session' };
  }
  // The folders from the session folder down to each git dir, then everything in the git dirs (a symlink anywhere in
  // them — objects, refs, index, logs pointed at another repository — would make git read outside): a link on the way
  // refuses the checkout now, and a swap after this is seen when the read is checked (PathWitness). The session folder
  // itself is noted (renaming it away and back changes its own ctime); what is above it the sandbox does not write.
  const witness = new PathWitness();
  const rootOf = (p: string) => realRoots.find((r) => inside(p, [r]))!;
  // The work tree's own path too (a linked worktree's lies apart from its git dirs): files are read under `top`.
  if (!(await witness.noteChain(rootOf(top), top))) return { ok: false, reason: 'repo-links-outside', top };
  for (const d of new Set([gitDir, common])) {
    if (!(await witness.noteChain(rootOf(d), d))) return { ok: false, reason: 'repo-links-outside', top };
    if (!(await noLinksIn(d, MAX_GIT_ENTRIES, witness))) return { ok: false, reason: 'repo-links-outside', top };
    for (const f of POINTER_FILES) {
      if ((await witness.note(path.join(d, f))) === 'link') return { ok: false, reason: 'repo-links-outside', top };
    }
  }
  // Another object store (alternates — any entry, even one that cannot be read) would make git read outside the session.
  // Checked only now, after its folder and the file itself are noted: one created between a check and the notes would
  // otherwise be noted as it is, and pass (#1299 review). After this, the witness sees it appear or change.
  const alt = await fs.lstat(path.join(common, 'objects', 'info', 'alternates')).catch(() => undefined);
  if (alt && (!alt.isFile() || alt.size > 0)) return { ok: false, reason: 'repo-alternates', top };
  // What git resolved before the folders were noted could have been rewritten meanwhile (a `commondir` pointing at
  // another repository): ask again, pinned the way every later call is, now that a rewrite after this is witnessed.
  const again = await git(top, [
    `--git-dir=${gitDir}`,
    `--work-tree=${top}`,
    'rev-parse',
    '--path-format=absolute',
    '--absolute-git-dir',
    '--git-common-dir',
  ]);
  const [gitDir2, common2] = await Promise.all(
    (again ?? '')
      .split('\n')
      .map((l) => l.trim())
      .slice(0, 2)
      .map(real),
  );
  if (again === undefined) return { ok: false, reason: 'git-failed' };
  if (gitDir2 !== gitDir || common2 !== common) return { ok: false, reason: 'repo-links-outside', top };
  const config = await configSafe(dir, git);
  if (!config.safe) return { ok: false, reason: config.reason as 'repo-config-runs-commands', top };
  return { ok: true, top, gitDir, witness };
}
