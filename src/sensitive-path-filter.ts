/**
 * Sensitive Path Filter
 *
 * Blocks non-admin users from reading sensitive host files via Claude tools
 * (Read, Bash cat/head/tail, Glob, Grep).
 *
 * Background: Claude Code sandbox restricts file *writes* but has no read
 * restrictions. This means any user can read SSH keys, API tokens, DB
 * passwords, and other secrets from the host filesystem. This module
 * enforces read-side protection at the application layer.
 *
 * Admin users (isAdminUser) bypass all checks.
 */

import * as os from 'os';
import * as path from 'path';
import { normalizeTmpPath } from './path-utils';

// os.homedir() returns $HOME as it is set, so it is resolved to an absolute path, and written the
// way normalizePath writes checked paths (/private/tmp as /tmp), or the tables below could never
// match them.
const HOME = normalizeTmpPath(path.resolve(os.homedir()));

/** Directories where any path underneath is blocked. */
const SENSITIVE_DIRECTORIES: ReadonlyArray<string> = [
  path.join(HOME, '.ssh'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.config', 'gh'),
  path.join(HOME, '.aws'),
  path.join(HOME, '.docker'),
  path.join(HOME, 'Library', 'Keychains'),
  '/etc/shadow',
];

/** Specific files that are sensitive regardless of directory. */
const SENSITIVE_EXACT_FILES = new Set<string>([
  path.join(HOME, '.gitconfig'),
  path.join(HOME, '.netrc'),
  path.join(HOME, '.npmrc'),
  path.join(HOME, '.claude', 'credentials.json'),
]);

/** Regex patterns for sensitive basenames. */
const SENSITIVE_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(\..+)?$/,
  /^credentials\.json$/,
  /^secrets?\.(json|ya?ml|toml)$/,
];

/**
 * Service config files containing secrets. Only specific files are blocked, not the whole directory.
 * Their `.env` files are not listed: SENSITIVE_BASENAME_PATTERNS, checked first, blocks every `.env`.
 */
const SENSITIVE_SERVICE_CONFIGS: ReadonlyArray<{ dir: string; files: ReadonlyArray<string> }> = [
  { dir: '/opt/soma-work', files: ['config.json'] },
  { dir: '/opt/soma', files: ['config.json'] },
];

/** Shell spellings of the home directory; expandHome replaces each of them with HOME. */
const HOME_ALIASES: ReadonlyArray<string> = ['~', '$HOME', `\${HOME}`];

/**
 * What fold writes for each code point other than A-Z that it rewrites. APFS, the macOS default,
 * compares names with Unicode case folding, which folds these into ASCII letters: `.\u00DFh` opens
 * `.ssh` and `.gitcon\uFB01g` opens `.gitconfig`.
 */
const FOLDED_LETTERS: Readonly<Record<string, string>> = {
  '\u00DF': 'ss',
  '\u017F': 's',
  '\u1E9E': 'ss',
  '\u212A': 'k',
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
};

/** SENSITIVE_DIRECTORIES and SENSITIVE_EXACT_FILES as the rules compare them (foldKey). */
const DIRECTORY_KEYS: ReadonlyArray<string> = SENSITIVE_DIRECTORIES.map(foldKey);
const EXACT_FILE_KEYS: ReadonlySet<string> = new Set(Array.from(SENSITIVE_EXACT_FILES, foldKey));

// Regexes for extracting file paths from bash commands — hoisted to avoid per-call recompilation.
// A captured path may start with a HOME_ALIASES spelling, which expandHome replaces.
// Known limits of this text-level check. Relative paths, and a Glob with a relative base, resolve
// against a working directory this module never sees, so they are checked as written. `..` is
// resolved lexically, while after a symbolic link the OS climbs from the link's target: the check
// follows a walk into the sensitive directories, not through links outside them. `~user/...` is
// not expanded. A glob's partial segment is not matched against names (`~/.ss*/id_rsa` checks
// HOME). Names are compared case-folded, not Unicode-normalized (every sensitive name is ASCII).
// In Bash, HOME is the only variable expanded and quote removal the only other shell rule applied
// (`$'...'`, other variables, command substitution and paths with white space are not
// understood), and only the commands below are read. An OS-level read deny list would cover every
// spelling (getSensitiveReadDenyPaths builds one; nothing applies it).
// A read or copy command's arguments run to the next `|`, `;` or `&`; RE_PATH picks every path
// among them. `\/+`: the shell reads `//` as `/`.
const RE_READ_COMMANDS =
  /\b(?:cat|head|tail|less|more|bat|xxd|hexdump|strings|base64|nano|vi|vim|code|open|cp|mv|rsync)\b([^|;&]*)/g;
const RE_PATH = /(?:~|\$HOME|\$\{HOME\})?(?:\/+[\w.\-~]+)+(?:\/+[\w.\-~*]+)?/g;
const RE_INPUT_REDIRECT = /<\s*((?:~|\$HOME|\$\{HOME\})?(?:\/+[\w.\-~]+)+(?:\/+[\w.\-~]+)?)/g;
// `.` sources a file where a command starts: at the start, or after white space or a separator.
const RE_SOURCE_CMD =
  /(?:\bsource|(?<![^\w\s;&|(){}`])\.)\s+((?:~|\$HOME|\$\{HOME\})?(?:\/+[\w.\-~]+)+(?:\/+[\w.\-~]+)?)/g;
// Changing into a directory is an access to it.
const RE_CHANGE_DIR = /\b(?:cd|pushd)\b[^|;&]*?((?:~|\$HOME|\$\{HOME\})?(?:\/+[\w.\-~]+)+(?:\/+[\w.\-~]+)?)/g;

export interface SensitivePathResult {
  readonly isSensitive: boolean;
  readonly reason?: string;
}

/** Check if an absolute path points to a sensitive location. */
export function checkSensitivePath(filePath: string): SensitivePathResult {
  const normalized = normalizePath(filePath);

  // The path, then every directory its walk passes through: after a symbolic link, `..` climbs
  // from the link's target (`.aws/link/../../credentials` can read `.aws/credentials`), so a walk
  // that enters a sensitive directory may end anywhere inside it.
  for (const point of [normalized, ...walkPoints(filePath)]) {
    const key = foldKey(point);
    const index = DIRECTORY_KEYS.findIndex((dir) => key === dir || key.startsWith(dir + '/'));
    if (index >= 0) {
      return { isSensitive: true, reason: `Access to ${SENSITIVE_DIRECTORIES[index]}/ is restricted` };
    }
  }

  const key = foldKey(normalized);
  if (EXACT_FILE_KEYS.has(key)) {
    return { isSensitive: true, reason: `Access to ${normalized} is restricted` };
  }

  const basename = path.basename(normalized);
  for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
    if (pattern.test(fold(basename))) {
      return { isSensitive: true, reason: `File ${basename} matches sensitive pattern` };
    }
  }

  // A service config sits in its directory or one directory below it: /opt/soma-work/{,*/}{file}.
  // The table is written folded.
  for (const { dir, files } of SENSITIVE_SERVICE_CONFIGS) {
    if (!key.startsWith(dir + '/')) continue;
    const parts = key.slice(dir.length + 1).split('/');
    if (parts.length <= 2 && files.includes(parts[parts.length - 1])) {
      return { isSensitive: true, reason: `Service config ${normalized} is restricted` };
    }
  }

  return { isSensitive: false };
}

/** Check if a Bash command attempts to read sensitive files. */
export function checkBashSensitivePaths(command: string): SensitivePathResult {
  const paths = extractPathsFromCommand(command);
  for (const p of paths) {
    const result = checkSensitivePath(p);
    if (result.isSensitive) return result;
  }
  return { isSensitive: false };
}

/** Check if a glob pattern targets a sensitive directory. */
export function checkSensitiveGlob(pattern: string, basePath?: string): SensitivePathResult {
  // path.resolve resolves `..` lexically; written after its base, the pattern keeps its walk
  // through the base, where a symbolic link makes `..` climb from the link's target.
  const spellings = basePath
    ? [path.resolve(basePath, pattern), pattern.startsWith('/') ? pattern : `${basePath}/${pattern}`]
    : [pattern];
  for (const spelling of spellings) {
    // The text before the first glob metacharacter, and the directory the glob lists: that text
    // cut back to its last `/`, since a partial segment is a pattern (`.ssh/..*` lists .ssh).
    const concrete = spelling.split(/[*?{}[\]]/)[0];
    for (const dir of [concrete.replace(/\/+$/, ''), concrete.slice(0, concrete.lastIndexOf('/') + 1)]) {
      const result = checkSensitivePath(dir);
      if (result.isSensitive) return result;
    }
  }
  return { isSensitive: false };
}

function collectMatches(pattern: RegExp, text: string): string[] {
  return Array.from(text.matchAll(pattern), (m) => m[1]).filter(Boolean);
}

function extractPathsFromCommand(command: string): string[] {
  // The shell removes quotes and backslashes before it opens a file (`"$HOME/.env"`, `~/.s""sh`,
  // `~/.s\sh`). Removing them everywhere, even where the shell keeps them, only adds paths.
  const text = command.replace(/["'\\]/g, '');
  const paths: string[] = [];
  for (const args of collectMatches(RE_READ_COMMANDS, text)) {
    paths.push(...(args.match(RE_PATH) ?? []));
  }
  paths.push(...collectMatches(RE_INPUT_REDIRECT, text));
  paths.push(...collectMatches(RE_SOURCE_CMD, text));
  paths.push(...collectMatches(RE_CHANGE_DIR, text));
  return paths;
}

/** A path starting with a HOME_ALIASES spelling, alone or before `/`, with HOME in its place. */
function expandHome(filePath: string): string {
  for (const alias of HOME_ALIASES) {
    if (filePath === alias || filePath.startsWith(alias + '/')) return HOME + filePath.slice(alias.length);
  }
  return filePath;
}

function normalizePath(filePath: string): string {
  return resolvePath(expandHome(filePath));
}

function resolvePath(expanded: string): string {
  // Resolve `.`, `..` and empty segments of an absolute path (`..` at the root stays there), so
  // every spelling of a path is checked as that path. This runs before the /private/tmp mapping:
  // resolving after it would let `//private/tmp/x` through as `/private/tmp/x`, unmapped.
  const resolved = expanded.startsWith('/') ? path.posix.normalize(expanded) : expanded;
  return normalizeTmpPath(resolved).replace(/\/+$/, '');
}

/** Where the walk of a path is after each of its segments, normalized. */
function walkPoints(filePath: string): string[] {
  const segments = expandHome(filePath).split('/');
  return segments.map((_, i) => resolvePath(segments.slice(0, i + 1).join('/')));
}

/** A path with A-Z and the FOLDED_LETTERS code points written as the ASCII letters they fold to. */
function fold(text: string): string {
  return text.replace(/[A-Z\u00DF\u017F\u1E9E\u212A\uFB00-\uFB06]/g, (c) => FOLDED_LETTERS[c] ?? c.toLowerCase());
}

/**
 * A normalized path as the rules compare it: folded, since APFS compares names without regard to
 * case, and with /private/tmp written /tmp again, since folding can spell it (`/PRIVATE/tmp`).
 */
function foldKey(normalized: string): string {
  return normalizeTmpPath(fold(normalized));
}

/**
 * Sensitive paths for sandbox read.denyOnly configuration.
 * Concrete paths (not wildcards) for non-admin user sandbox restriction.
 */
export function getSensitiveReadDenyPaths(): string[] {
  return [
    ...SENSITIVE_DIRECTORIES,
    ...Array.from(SENSITIVE_EXACT_FILES),
    '/opt/soma-work/dev/.env',
    '/opt/soma-work/prod/.env',
    '/opt/soma-work/dev/config.json',
    '/opt/soma-work/prod/config.json',
    '/opt/soma/dev/.env',
    '/opt/soma/prod/.env',
  ];
}
