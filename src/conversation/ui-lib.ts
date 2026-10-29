/**
 * @2lab.ai/ui — the installed library's build, as the pages load it: the
 * dashboard and the settings page take each element from the flat `dist/*.js`
 * files the dashboard's `/dashboard/ui/:file` route serves (same origin).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Logger } from '../logger';

const logger = new Logger('UiLib');

/** A file the /dashboard/ui route serves: a flat `dist/*.js` name of @2lab.ai/ui (no dirs, no dots-only names). */
export const UI_LIB_FILE = /^[A-Za-z0-9_][A-Za-z0-9_-]*\.js$/;
let uiLibDir: string | null | undefined;
// The package is located with require.resolve (a path, not a load) and its
// manifest read as a file: the import graph (scripts/verification) follows
// every module load, and createRequire / node:module are loads it cannot follow.
function uiLibPackageJson(): string {
  return require.resolve('@2lab.ai/ui/package.json');
}
function uiLibVersion(): string {
  try {
    return String(JSON.parse(readFileSync(uiLibPackageJson(), 'utf8')).version || '0');
  } catch {
    return '0';
  }
}
/** Installed @2lab.ai/ui version — busts the browser cache of the entry file (served for an hour) on upgrade. */
export const UI_LIB_VERSION = encodeURIComponent(uiLibVersion());
/** `dist/` of the installed @2lab.ai/ui, or null (logged once) when the package is missing. */
export function uiLibDistDir(): string | null {
  if (uiLibDir === undefined) {
    try {
      uiLibDir = join(dirname(uiLibPackageJson()), 'dist');
    } catch (err) {
      uiLibDir = null;
      logger.error('@2lab.ai/ui is not installed — the dashboard and settings elements cannot load', err);
    }
  }
  return uiLibDir;
}
