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

const HOME = os.homedir();

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

/** Service config files containing secrets. Only specific files are blocked, not the whole directory. */
const SENSITIVE_SERVICE_CONFIGS: ReadonlyArray<{ dir: string; files: ReadonlyArray<string> }> = [
  { dir: '/opt/soma-work', files: ['.env', 'config.json'] },
  { dir: '/opt/soma', files: ['.env', 'config.json'] },
];

// Regexes for extracting file paths from bash commands — hoisted to avoid per-call recompilation.
const RE_READ_COMMANDS =
  /\b(?:cat|head|tail|less|more|bat|xxd|hexdump|strings|base64|nano|vi|vim|code|open)\b[^|;&]*?((?:\/[\w.\-~]+)+(?:\/[\w.\-~*]+)?)/g;
const RE_INPUT_REDIRECT = /<\s*((?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)/g;
const RE_COPY_COMMANDS = /\b(?:cp|mv|rsync)\b[^|;&]*?\s+((?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)\s/g;
const RE_SOURCE_CMD = /\b(?:source|\.)\s+((?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)/g;

export interface SensitivePathResult {
  readonly isSensitive: boolean;
  readonly reason?: string;
}

/** Check if an absolute path points to a sensitive location. */
export function checkSensitivePath(filePath: string): SensitivePathResult {
  if (!filePath) return { isSensitive: false };

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

  for (const { dir, files } of SENSITIVE_SERVICE_CONFIGS) {
    for (const file of files) {
      if (normalized === path.join(dir, file)) {
        return { isSensitive: true, reason: `Service config ${normalized} is restricted` };
      }
      // Match subdirectories: /opt/soma-work/*/{file}
      if (normalized.startsWith(dir + '/') && normalized.endsWith('/' + file)) {
        const relative = normalized.slice(dir.length + 1);
        const parts = relative.split('/');
        if (parts.length === 2 && parts[1] === file) {
          return { isSensitive: true, reason: `Service config ${normalized} is restricted` };
        }
      }
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
  const paths: string[] = [];
  paths.push(...collectMatches(RE_READ_COMMANDS, command));
  paths.push(...collectMatches(RE_INPUT_REDIRECT, command));
  paths.push(...collectMatches(RE_COPY_COMMANDS, command));
  paths.push(...collectMatches(RE_SOURCE_CMD, command));
  return paths.map(normalizePath);
}

function normalizePath(filePath: string): string {
  let normalized = filePath;
  if (normalized.startsWith('~/')) {
    normalized = path.join(HOME, normalized.slice(2));
  } else if (normalized === '~') {
    normalized = HOME;
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
