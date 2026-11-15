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
 * Every call is bounded (10 s, 16 MiB of output) and answers undefined on any failure — never throws.
 */

import { execFile } from 'node:child_process';

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
 * Config keys that make git run a command while it reads or converts working-tree files. `core.fsmonitor` is turned off
 * on every call but still refuses the working tree (a repository that asks for it is not one to read blindly).
 */
const RUNS_COMMANDS = [
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
 * Whether the working tree of the checkout at `dir` may be read: its config (repository, worktree, includes — no global or
 * system) names no command. Unknown (git failed) is not safe.
 */
export async function worktreeSafe(dir: string, git: GitRun = runGit): Promise<{ safe: boolean; reason?: string }> {
  const names = await git(dir, ['config', '--list', '--name-only', '--show-scope']);
  if (names === undefined) return { safe: false, reason: 'git-config-unreadable' };
  const keys = commandKeys(names);
  return keys.length ? { safe: false, reason: 'repo-config-runs-commands' } : { safe: true };
}
