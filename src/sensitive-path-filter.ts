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

const HOME = os.homedir();

/**
 * Directories that are always sensitive — any path under these is blocked.
 * Normalized to absolute paths at module load time.
 */
const SENSITIVE_DIRECTORIES: ReadonlyArray<string> = [
  path.join(HOME, '.ssh'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.config', 'gh'),
  path.join(HOME, '.aws'),
  path.join(HOME, '.docker'),
  path.join(HOME, 'Library', 'Keychains'),
  '/etc/shadow',
];

/**
 * Specific files that are sensitive regardless of directory.
 */
const SENSITIVE_EXACT_FILES: ReadonlyArray<string> = [
  path.join(HOME, '.gitconfig'),
  path.join(HOME, '.netrc'),
  path.join(HOME, '.npmrc'),
  path.join(HOME, '.claude', 'credentials.json'),
];

/**
 * Filename patterns that are sensitive in any directory.
 * Matched against the basename of the path.
 */
const SENSITIVE_BASENAMES: ReadonlyArray<string> = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.staging',
  '.env.test',
];

/**
 * Regex patterns for sensitive basenames (covers .env.* variants).
 */
const SENSITIVE_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(\..+)?$/, // .env, .env.local, .env.production, etc.
  /^credentials\.json$/,
  /^secrets?\.(json|ya?ml|toml)$/,
];

/**
 * Path prefixes for service config files containing secrets.
 * Only the config files in these service directories are blocked, not the entire directory.
 */
const SENSITIVE_SERVICE_CONFIGS: ReadonlyArray<{ dir: string; files: ReadonlyArray<string> }> = [
  {
    dir: '/opt/soma-work',
    files: ['.env', 'config.json'],
  },
  {
    dir: '/opt/soma',
    files: ['.env', 'config.json'],
  },
];

export interface SensitivePathResult {
  readonly isSensitive: boolean;
  readonly reason?: string;
}

/**
 * Check if an absolute path points to a sensitive location.
 * Returns the reason if sensitive, null otherwise.
 */
export function checkSensitivePath(filePath: string): SensitivePathResult {
  if (!filePath) return { isSensitive: false };

  // Normalize: resolve ~, remove trailing slashes, resolve . and ..
  const normalized = normalizePath(filePath);

  // 1. Check sensitive directories (any path under them)
  for (const dir of SENSITIVE_DIRECTORIES) {
    if (normalized === dir || normalized.startsWith(dir + '/')) {
      return { isSensitive: true, reason: `Access to ${dir}/ is restricted` };
    }
  }

  // 2. Check exact sensitive files
  for (const file of SENSITIVE_EXACT_FILES) {
    if (normalized === file) {
      return { isSensitive: true, reason: `Access to ${file} is restricted` };
    }
  }

  // 3. Check sensitive basenames
  const basename = path.basename(normalized);

  for (const name of SENSITIVE_BASENAMES) {
    if (basename === name) {
      return { isSensitive: true, reason: `Files named ${name} are restricted` };
    }
  }

  for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
    if (pattern.test(basename)) {
      return { isSensitive: true, reason: `File ${basename} matches sensitive pattern` };
    }
  }

  // 4. Check service config files
  for (const { dir, files } of SENSITIVE_SERVICE_CONFIGS) {
    for (const file of files) {
      const fullPath = path.join(dir, file);
      // Match the exact file OR the file under any subdirectory of the service dir
      // e.g. /opt/soma-work/dev/.env, /opt/soma-work/prod/config.json
      if (normalized === fullPath) {
        return { isSensitive: true, reason: `Service config ${fullPath} is restricted` };
      }
      // Check subdirectories: /opt/soma-work/*/{file}
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

/**
 * Check if a Bash command attempts to read sensitive files.
 * Detects: cat, head, tail, less, more, bat, xxd, hexdump, strings, base64, open, nano, vi/vim, code
 * Also detects: redirections like `< /path/to/file`, cp/mv from sensitive sources
 */
export function checkBashSensitivePaths(command: string): SensitivePathResult {
  // Extract potential file paths from the command
  const paths = extractPathsFromCommand(command);

  for (const p of paths) {
    const result = checkSensitivePath(p);
    if (result.isSensitive) {
      return result;
    }
  }

  return { isSensitive: false };
}

/**
 * Check if a glob pattern targets a sensitive directory.
 */
export function checkSensitiveGlob(pattern: string, basePath?: string): SensitivePathResult {
  // Resolve the pattern against the base path
  const resolved = basePath ? path.resolve(basePath, pattern) : pattern;

  // For glob patterns, check if the base directory is sensitive
  // Remove glob characters to get the base directory
  const baseDir = resolved.replace(/[*?{}\[\]]/g, '').replace(/\/+$/, '');

  return checkSensitivePath(baseDir);
}

/**
 * Collect all regex match groups[1] from a global pattern.
 */
function collectMatches(pattern: RegExp, text: string): string[] {
  return Array.from(text.matchAll(pattern), (m) => m[1]).filter(Boolean);
}

/**
 * Extract file paths from a bash command string.
 * Handles common file-reading commands and redirections.
 */
function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = [];

  // File reading commands: cat, head, tail, less, more, bat, xxd, hexdump, strings, base64, open
  // Also editors: nano, vi, vim, code
  // Pattern: command [flags] /path/to/file
  const readCommands =
    /\b(?:cat|head|tail|less|more|bat|xxd|hexdump|strings|base64|nano|vi|vim|code|open)\b[^|;&]*?((?:\/[\w.\-~]+)+(?:\/[\w.\-~*]+)?)/g;
  paths.push(...collectMatches(readCommands, command));

  // Input redirections: < /path/to/file
  const inputRedirect = /<\s*((?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)/g;
  paths.push(...collectMatches(inputRedirect, command));

  // cp/mv from sensitive source: cp /sensitive/path /dest
  const copyCommands = /\b(?:cp|mv|rsync)\b[^|;&]*?\s+((?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)\s/g;
  paths.push(...collectMatches(copyCommands, command));

  // source/dot command: source /path or . /path
  const sourceCmd = /\b(?:source|\.)\s+((?:\/[\w.\-~]+)+(?:\/[\w.\-~]+)?)/g;
  paths.push(...collectMatches(sourceCmd, command));

  // Tilde expansion
  return paths.map(normalizePath);
}

/**
 * Normalize a file path: expand ~, resolve relative components.
 */
function normalizePath(filePath: string): string {
  let normalized = filePath;

  // Expand ~ to home directory
  if (normalized.startsWith('~/')) {
    normalized = path.join(HOME, normalized.slice(2));
  } else if (normalized === '~') {
    normalized = HOME;
  }

  // Resolve /private/tmp to /tmp (macOS)
  if (normalized.startsWith('/private/tmp')) {
    normalized = '/tmp' + normalized.slice('/private/tmp'.length);
  }

  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, '');

  return normalized;
}

/**
 * Get the list of sensitive directory paths for sandbox read denyOnly configuration.
 * These paths should be added to the sandbox's read.denyOnly list for non-admin users.
 */
export function getSensitiveReadDenyPaths(): string[] {
  return [
    ...SENSITIVE_DIRECTORIES,
    ...SENSITIVE_EXACT_FILES,
    // Add common service directories containing secrets
    '/opt/soma-work/dev/.env',
    '/opt/soma-work/prod/.env',
    '/opt/soma-work/dev/config.json',
    '/opt/soma-work/prod/config.json',
    '/opt/soma/dev/.env',
    '/opt/soma/prod/.env',
  ];
}
