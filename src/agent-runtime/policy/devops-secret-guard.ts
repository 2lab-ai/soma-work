/**
 * Devops-secret checks (.prd/16-devops-tools-architecture.md §1, §2): stored GitHub and keychain
 * credentials, and the devops broker's root-owned code and broker-owned data.
 *
 * Each check returns a short reason, or null. `evaluateToolPolicy` picks the check and its
 * arguments per tool (`checkDevopsSecretForTool`) and denies on any reason, in every permission
 * mode and for admins too. Lexical only, like the sensitive-path checks. Defense in depth: the real
 * boundary is the broker's separate OS user, not these checks.
 */

import { posix as posixPath } from 'node:path';

/** Root-owned code and broker-owned data of the devops broker (.prd/16-devops-tools-architecture.md §2, §8). */
const DEVOPS_BROKER_ROOTS = ['/usr/local/var/soma-devops', '/usr/local/libexec/soma-devops'];

const BROKER_PATH_REASON = 'devops broker path';

/**
 * A broker root not continued by another name character (so `soma-devops-other` is not one); the
 * leading `/` is optional to catch relative spellings. Case-insensitive: the default macOS volume is.
 */
const DEVOPS_BROKER_PATH_RE = new RegExp(
  `(?:${DEVOPS_BROKER_ROOTS.map((root) => root.slice(1)).join('|')})(?![\\w.-])`,
  'i',
);

const KEYCHAIN_SECRET_SUBCOMMANDS = ['find-generic-password', 'find-internet-password', 'dump-keychain', 'export'];

function isBrokerPath(p: string): boolean {
  return p !== '' && DEVOPS_BROKER_PATH_RE.test(posixPath.normalize(p));
}

/** True for a short-flag cluster or long flag that makes `gh auth status` print the token. */
function isShowTokenFlag(word: string): boolean {
  return word === '--show-token' || word.startsWith('--show-token=') || /^-[A-Za-z]*t[A-Za-z]*$/.test(word);
}

/** A shell string with quotes and backslashes dropped as the shell would, and `//`, `/./` collapsed. */
function unquoteShell(command: string): string {
  return command
    .replace(/['"\\]/g, '')
    .replace(/\/\.(?=\/)/g, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * The words of each simple command in an unquoted shell string, so `bash -c 'gh auth token'` and
 * `$(gh auth token)` yield `gh auth token`.
 */
function shellSegments(unquoted: string): string[][] {
  return unquoted.split(/[;&|\n\r()`{}<>]/).map((segment) => segment.split(/\s+/).filter(Boolean));
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** Bash: a command that prints a stored credential or names the broker's paths. */
export function checkDevopsSecretCommand(command: string): string | null {
  const unquoted = unquoteShell(command);
  if (DEVOPS_BROKER_PATH_RE.test(unquoted) || /soma-devops-broker/i.test(unquoted)) {
    return BROKER_PATH_REASON;
  }
  for (const words of shellSegments(unquoted)) {
    for (let i = 0; i < words.length; i++) {
      const name = basename(words[i]);
      const rest = words.slice(i + 1);
      if (name === 'gh') {
        // `gh auth …` only: `auth` must be the first non-flag word, so `gh pr list --search "auth token"` passes.
        const sub = rest.findIndex((w) => !w.startsWith('-'));
        if (sub === -1 || rest[sub] !== 'auth') continue;
        const authArgs = rest.slice(sub + 1);
        if (authArgs.includes('token')) return 'gh auth token';
        if (authArgs.includes('git-credential')) return 'gh auth git-credential';
        if (authArgs.includes('status') && authArgs.some(isShowTokenFlag)) return 'gh auth status --show-token';
      } else if (name === 'security' && rest.some((w) => KEYCHAIN_SECRET_SUBCOMMANDS.includes(w))) {
        return 'keychain secret read';
      }
    }
  }
  return null;
}

/** Read, Edit and Write `file_path`, Grep `path`: a path under a broker root. */
export function checkDevopsSecretPath(filePath: string): string | null {
  return isBrokerPath(filePath) ? BROKER_PATH_REASON : null;
}

/** Glob: the pattern, the base path, or both joined, under a broker root. */
export function checkDevopsSecretGlob(pattern: string, basePath: string): string | null {
  const joined = basePath && pattern ? posixPath.join(basePath, pattern) : '';
  return isBrokerPath(pattern) || isBrokerPath(basePath) || isBrokerPath(joined) ? BROKER_PATH_REASON : null;
}
