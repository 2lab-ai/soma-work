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

let uiTokens: string | undefined;
/**
 * @2lab.ai/ui's page tokens (`dist/tokens.css`, the package's `./tokens.css` export): every
 * `--ui-*` on `:root` / `[data-theme="light|dark"]`. The dashboard and the settings page emit it
 * as their single colour, geometry, type and motion source and alias their own names to it
 * (pageTokenAliases), so the pages and the elements cannot drift. Empty (logged once) when the
 * package is missing or the file is not plain CSS.
 */
export function uiLibTokensCss(): string {
  if (uiTokens === undefined) {
    uiTokens = '';
    const dir = uiLibDistDir();
    if (dir) {
      try {
        const css = readFileSync(join(dir, 'tokens.css'), 'utf8');
        // Inlined into a <style> element: anything that could close it is refused.
        if (/<\/?\s*style|<!--|<script/i.test(css)) logger.error('@2lab.ai/ui tokens.css is not plain CSS — not inlined');
        else uiTokens = css.trim();
      } catch (err) {
        logger.error('@2lab.ai/ui tokens.css is missing — the pages have no colour tokens', err);
      }
    }
  }
  return uiTokens;
}

/**
 * `:root { --name: var(--ui-name); … }` for every token the library defines — the page keeps its
 * own names (`--bg`, `--ib-muted`, `--st-run` …) as aliases of the library's. Declared on :root only:
 * a descendant inherits the resolved value, so a wrapper that maps `--ui-x: var(--x)` (.ui-tok) is
 * never a cycle.
 */
export function pageTokenAliases(tokensCss: string = uiLibTokensCss()): string {
  const names = [...new Set(Array.from(tokensCss.matchAll(/--ui-([a-z0-9-]+)\s*:/g), (m) => m[1]))];
  return `:root { ${names.map((n) => `--${n}: var(--ui-${n});`).join(' ')} }`;
}
