import { resolve } from 'node:path';

/**
 * Resolve a path inside a package's assets directory from a stable package-root anchor.
 *
 * Callers should pass a package root such as `resolve(__dirname, '..')`, not a
 * nested module directory, so compiled files under dist/subdirs resolve assets
 * consistently.
 */
export function assetPath(packageRoot: string, ...segments: string[]): string {
  return resolve(packageRoot, 'assets', ...segments);
}
