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
 *     transports are refused (`protocol.allow=never`) and lazy fetching is off (`GIT_NO_LAZY_FETCH`), so a partial clone
 *     cannot fetch through a configured remote; no pager; no auto gc;
 *   - no global or system config, no tokens in the environment, no optional index writes;
 *   - diffs are between two commits only, with `--no-ext-diff --no-textconv`, and logs with `--no-show-signature`.
 *
 * `checkoutSafety` adds what a check can give: the work tree, git dir and common dir inside the session's folders, no
 * alternates, and no command-running key in the config (a repository that asks for one is listed, not read). The paths
 * it resolves are then pinned on every later call (`pinGit`), so a `.git` file rewritten meanwhile is not followed.
 *
 * Every call is bounded (10 s, 16 MiB of output) and answers undefined on any failure — never throws.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '--no-pager',
];

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export type GitRun = (dir: string, args: string[]) => Promise<string | undefined>;

/** Run git in `dir` with the hardened flags; the raw stdout (not trimmed), or undefined on failure. */
export const runGit: GitRun = (dir, args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...SAFE_FLAGS, '-C', dir, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: GIT_ENV, encoding: 'utf8' },
      (error, stdout) => resolve(error ? undefined : String(stdout)),
    );
  });

export type GitRunBytes = (dir: string, args: string[]) => Promise<Buffer | undefined>;

/** {@link runGit} for output that may not be text (a blob's bytes). */
export const runGitBytes: GitRunBytes = (dir, args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...SAFE_FLAGS, '-C', dir, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: GIT_ENV, encoding: 'buffer' },
      (error, stdout) => resolve(error ? undefined : (stdout as Buffer)),
    );
  });

/** A runner whose every call names the git dir and work tree `checkoutSafety` resolved (not whatever `.git` says now). */
export function pinGit<T>(
  git: (dir: string, args: string[]) => Promise<T>,
  pin: { gitDir: string; top: string },
): (dir: string, args: string[]) => Promise<T> {
  return (dir, args) => git(dir, [`--git-dir=${pin.gitDir}`, `--work-tree=${pin.top}`, ...args]);
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
  | { ok: true; top: string; gitDir: string }
  | { ok: false; reason: 'not-a-checkout' | 'outside-session' }
  | {
      ok: false;
      reason: 'repo-config-runs-commands' | 'git-config-unreadable' | 'repo-alternates' | 'repo-links-outside';
      top: string;
    };

const real = (p: string) => fs.realpath(p).catch(() => path.resolve(p));

/** How many entries of a git dir `noLinksIn` reads before it gives up (and refuses the checkout). */
export const MAX_GIT_ENTRIES = 100_000;

/**
 * Whether the tree under `dir` holds no symlink (lstat only — nothing is followed or read). A git dir whose objects,
 * refs, index or logs are links can point git at another repository the daemon can read (#1299 review). Gives up past
 * MAX_GIT_ENTRIES — a repository that large is not read.
 */
export async function noLinksIn(dir: string, max = MAX_GIT_ENTRIES): Promise<boolean> {
  const stack = [dir];
  let seen = 0;
  while (stack.length > 0) {
    const cur = stack.pop()!;
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
  const lines = (out ?? '').split('\n').map((l) => l.trim());
  if (lines.length < 3 || !lines[0] || !lines[1] || !lines[2]) return { ok: false, reason: 'not-a-checkout' };
  const realRoots = await Promise.all((roots.length ? roots : [dir]).map(real));
  const [top, gitDir, common] = await Promise.all(lines.slice(0, 3).map(real));
  if (!inside(top, realRoots) || !inside(gitDir, realRoots) || !inside(common, realRoots)) {
    return { ok: false, reason: 'outside-session' };
  }
  // Another object store (alternates — any entry, even one that cannot be read) or a symlink anywhere in the git dirs
  // (objects, refs, index, logs pointed at another repository) would make git read outside the session.
  const alt = await fs.lstat(path.join(common, 'objects', 'info', 'alternates')).catch(() => undefined);
  if (alt && (!alt.isFile() || alt.size > 0)) return { ok: false, reason: 'repo-alternates', top };
  for (const d of new Set([gitDir, common])) {
    if (!(await noLinksIn(d))) return { ok: false, reason: 'repo-links-outside', top };
  }
  const config = await configSafe(dir, git);
  if (!config.safe) return { ok: false, reason: config.reason as 'repo-config-runs-commands', top };
  return { ok: true, top, gitDir };
}
