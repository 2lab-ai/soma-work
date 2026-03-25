/**
 * Path utilities for /tmp path normalization.
 *
 * On macOS, /tmp is a symlink to /private/tmp. This causes mismatches between
 * bash commands (which use /tmp) and MCP filesystem / fs.realpathSync (which
 * resolve to /private/tmp). We normalize to /tmp for consistency.
 */

const PRIVATE_TMP_PREFIX = '/private/tmp/';
const PRIVATE_TMP_EXACT = '/private/tmp';

/**
 * Normalize /private/tmp paths to /tmp.
 *
 * On macOS, /tmp → /private/tmp is a symlink. We standardize on the shorter
 * /tmp form because:
 * - bash commands use /tmp
 * - system prompts and directives use /tmp
 * - /private/tmp is a macOS implementation detail
 *
 * Non-/tmp paths are returned unchanged.
 */
export function normalizeTmpPath(inputPath: string): string {
  if (inputPath.startsWith(PRIVATE_TMP_PREFIX)) {
    return '/tmp/' + inputPath.slice(PRIVATE_TMP_PREFIX.length);
  }
  if (inputPath === PRIVATE_TMP_EXACT) {
    return '/tmp';
  }
  return inputPath;
}
