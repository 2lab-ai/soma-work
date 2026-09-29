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

// Written the way normalizePath writes checked paths (/private/tmp as /tmp), or the tables below
// could never match them.
const HOME = normalizeTmpPath(os.homedir());

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

/** Shell spellings of the home directory; normalizePath expands each of them like `~`. */
const HOME_ALIASES: ReadonlyArray<string> = ['~', '$HOME', `\${HOME}`];

// Regexes for extracting file paths from bash commands — hoisted to avoid per-call recompilation.
// A captured path may start with a HOME_ALIASES spelling, which normalizePath expands.
// Known limits of this text-level check: `~user/...` is not expanded; a glob in a Bash path
// (`cat ~/.ss*/id_rsa`) is checked as written; checkSensitiveGlob checks the text before the first
// glob metacharacter, which need not end at a segment boundary (`~/.ss*`); relative paths and a
// relative Glob base resolve against a working directory this module never sees. Only an OS-level
// read deny list covers every shell spelling (getSensitiveReadDenyPaths builds one; nothing applies it).
// A read command's arguments run to the next `|`, `;` or `&`; RE_PATH picks every path among them.
const RE_READ_COMMANDS =
  /\b(?:cat|head|tail|less|more|bat|xxd|hexdump|strings|base64|nano|vi|vim|code|open)\b([^|;&]*)/g;
const RE_PATH = /(?:~|\$HOME|\$\{HOME\})?(?:\/[\w.\-~]+)+(?:\/[\w.\-~*]+)?/g;
const RE_INPUT_REDIRECT = /<\s*((?:~|\$HOME|\$\{HOME\})?(?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)/g;
const RE_COPY_COMMANDS = /\b(?:cp|mv|rsync)\b[^|;&]*?\s+((?:~|\$HOME|\$\{HOME\})?(?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)\s/g;
// `.` sources a file where a command starts: at the start, or after white space or a separator.
const RE_SOURCE_CMD =
  /(?:\bsource|(?<![^\w\s;&|(){}`])\.)\s+((?:~|\$HOME|\$\{HOME\})?(?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)/g;
// Changing into a directory is an access to it.
const RE_CHANGE_DIR = /\b(?:cd|pushd)\b[^|;&]*?((?:~|\$HOME|\$\{HOME\})?(?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)/g;

export interface SensitivePathResult {
  readonly isSensitive: boolean;
  readonly reason?: string;
}

/** Check if an absolute path points to a sensitive location. */
export function checkSensitivePath(filePath: string): SensitivePathResult {
  const normalized = normalizePath(filePath);

  for (const dir of SENSITIVE_DIRECTORIES) {
    if (normalized === dir || normalized.startsWith(dir + '/')) {
      return { isSensitive: true, reason: `Access to ${dir}/ is restricted` };
    }
  }

  if (SENSITIVE_EXACT_FILES.has(normalized)) {
    return { isSensitive: true, reason: `Access to ${normalized} is restricted` };
  }

  const basename = path.basename(normalized);
  for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
    if (pattern.test(basename)) {
      return { isSensitive: true, reason: `File ${basename} matches sensitive pattern` };
    }
  }

  // A service config sits in its directory or one directory below it: /opt/soma-work/{,*/}{file}
  for (const { dir, files } of SENSITIVE_SERVICE_CONFIGS) {
    if (!normalized.startsWith(dir + '/')) continue;
    const parts = normalized.slice(dir.length + 1).split('/');
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
  const resolved = basePath ? path.resolve(basePath, pattern) : pattern;
  // Split on first glob metacharacter to extract the concrete prefix
  const baseDir = resolved.split(/[*?{}[\]]/)[0].replace(/\/+$/, '');
  return checkSensitivePath(baseDir);
}

function collectMatches(pattern: RegExp, text: string): string[] {
  return Array.from(text.matchAll(pattern), (m) => m[1]).filter(Boolean);
}

function extractPathsFromCommand(command: string): string[] {
  // The shell reads `"$HOME"/x` as `$HOME/x`; without the quotes the regexes see one path.
  const text = command.replace(/"(\$HOME|\$\{HOME\})"/g, '$1');
  const paths: string[] = [];
  for (const args of collectMatches(RE_READ_COMMANDS, text)) {
    paths.push(...(args.match(RE_PATH) ?? []));
  }
  paths.push(...collectMatches(RE_INPUT_REDIRECT, text));
  paths.push(...collectMatches(RE_COPY_COMMANDS, text));
  paths.push(...collectMatches(RE_SOURCE_CMD, text));
  paths.push(...collectMatches(RE_CHANGE_DIR, text));
  return paths.map(normalizePath);
}

function normalizePath(filePath: string): string {
  let normalized = filePath;
  for (const alias of HOME_ALIASES) {
    if (normalized.startsWith(alias + '/')) {
      normalized = path.join(HOME, normalized.slice(alias.length + 1));
      break;
    }
    if (normalized === alias) {
      normalized = HOME;
      break;
    }
  }
  // Resolve `.`, `..` and empty segments of an absolute path (`..` at the root stays there), so
  // every spelling of a path is checked as that path. This runs before the /private/tmp mapping:
  // resolving after it would let `//private/tmp/x` through as `/private/tmp/x`, unmapped.
  if (normalized.startsWith('/')) {
    normalized = path.posix.normalize(normalized);
  }
  normalized = normalizeTmpPath(normalized);
  return normalized.replace(/\/+$/, '');
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
