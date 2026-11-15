/**
 * The git the daemon runs in a session's folder (.prd/27 §5). The folder's repositories are the model's to write — their
 * config can name commands (a clean filter, an fsmonitor hook, a textconv) that git would then run as the daemon, outside
 * the sandbox. So:
 *
 *   - no global or system config, no tokens in the environment, no pager, no optional index writes;
 *   - every call turns off the fsmonitor hook, the hooks path, external diff and the untracked cache;
 *   - a command that reads the working tree (status, diff against it) runs only after `worktreeSafe` found no key in the
 *     repository's own config (includes and worktree config expanded) that runs a command. Diffs between two commits never
 *     convert working-tree files and run with `--no-ext-diff --no-textconv`.
 *
 * Two more doors the review of #1299 found and this module now shuts:
 *
 *   - a commit's signature check runs `gpg.program` (`log.showSignature`): every call turns it off, and the gate refuses
 *     any `gpg.*` key or `log.showSignature`;
 *   - a pointer can send git outside the checkout — `core.worktree` (the gate refuses it), a `.git` file naming another
 *     repository, or `objects/info/alternates` borrowing another store: `checkoutSafety` requires the work tree, the git
 *     dir and the common dir to be inside the session's folders, and no alternates.
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
  | { ok: true; top: string }
  | { ok: false; reason: 'not-a-checkout' | 'outside-session' }
  | { ok: false; reason: 'repo-config-runs-commands' | 'git-config-unreadable' | 'repo-alternates'; top: string };

const real = (p: string) => fs.realpath(p).catch(() => path.resolve(p));
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
  const alternates = await fs.readFile(path.join(common, 'objects', 'info', 'alternates'), 'utf8').catch(() => '');
  if (alternates.trim()) return { ok: false, reason: 'repo-alternates', top };
  const config = await configSafe(dir, git);
  if (!config.safe) return { ok: false, reason: config.reason as 'repo-config-runs-commands', top };
  return { ok: true, top };
}
