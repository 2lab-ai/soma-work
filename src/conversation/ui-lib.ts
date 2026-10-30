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
        if (/<\/?\s*style|<!--|<script/i.test(css))
          logger.error('@2lab.ai/ui tokens.css is not plain CSS — not inlined');
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

let uiKit: string | undefined;
/**
 * @2lab.ai/ui's light-DOM classes (`dist/ui-kit.css`, the package's `./ui-kit.css` export): the
 * button family (`.ui-btn` with one ink primary, `.ui-icon-btn`, `.ui-fab`), `.ui-chip`, the tone-dot
 * `.ui-status`, `.ui-kbd`, `.ui-dl`, `.ui-skeleton`, `.ui-empty`, `.ui-status-line`, `.ui-avatar`,
 * `.ui-sr-only`, `.ui-expand` / `.ui-chev` — every value read from the `--ui-*` tokens the page puts on
 * :root (uiLibTokensCss). The pages inline it before their own sheet, so a page rule that places a kit
 * button (margins, a row's width) wins at equal specificity. Empty (logged once) when missing or not
 * plain CSS.
 */
export function uiLibKitCss(): string {
  if (uiKit === undefined) {
    uiKit = '';
    const dir = uiLibDistDir();
    if (dir) {
      try {
        const css = readFileSync(join(dir, 'ui-kit.css'), 'utf8');
        if (/<\/?\s*style|<!--|<script/i.test(css))
          logger.error('@2lab.ai/ui ui-kit.css is not plain CSS — not inlined');
        else uiKit = css.trim();
      } catch (err) {
        logger.error('@2lab.ai/ui ui-kit.css is missing — the pages have no kit classes', err);
      }
    }
  }
  return uiKit;
}

/** `icon(name, opts)` of @2lab.ai/ui/icons: an SVG string, '' for an unknown name. */
export type UiIconFn = (
  name: string,
  opts?: { size?: number; label?: string; class?: string; stroke?: number },
) => string;

let uiIconsBody: string | null | undefined;
/**
 * The body of @2lab.ai/ui's icon set (`dist/icons.js`, the `./icons` export) without its `export { … }`
 * statement — a self-contained module (no imports) that defines `icon()` over the 16-grid glyph table.
 * Null (logged once) when the file is missing or is not that shape (an import, or markup that could
 * close the page's <script> once its SVG strings are filled in).
 */
function uiIconsModuleBody(): string | null {
  if (uiIconsBody === undefined) {
    uiIconsBody = null;
    const dir = uiLibDistDir();
    if (dir) {
      try {
        const src = readFileSync(join(dir, 'icons.js'), 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '');
        const exp = src.lastIndexOf('\nexport {');
        const body = exp >= 0 ? src.slice(0, exp) : '';
        if (!body || /^\s*import[\s{*]/m.test(body) || /<\/script|<!--/i.test(body) || !/\bfunction icon\(/.test(body))
          logger.error('@2lab.ai/ui icons.js is not the self-contained icon module — no icons');
        else uiIconsBody = body.trim();
      } catch (err) {
        logger.error('@2lab.ai/ui icons.js is missing — the pages have no icons', err);
      }
    }
  }
  return uiIconsBody;
}

let uiIconFn: UiIconFn | undefined;
/** `icon()` of @2lab.ai/ui/icons, run on the server ('' without the package or for an unknown name). */
export function uiIcon(name: string, opts?: Parameters<UiIconFn>[1]): string {
  if (!uiIconFn) {
    const body = uiIconsModuleBody();
    let fn: UiIconFn = () => '';
    if (body) {
      try {
        fn = new Function(`'use strict';\n${body}\nreturn icon;`)() as UiIconFn;
      } catch (err) {
        logger.error('@2lab.ai/ui icons.js did not evaluate — no icons', err);
      }
    }
    uiIconFn = fn;
  }
  return uiIconFn(name, opts);
}

/** `<i data-ui-icon="name"></i>` or `<i data-ui-icon="name" class="a b"></i>` — an icon slot in a page template. */
const UI_ICON_SLOT = /<i data-ui-icon="([a-z][a-z0-9-]*)"(?: class="([A-Za-z0-9 _-]+)")?><\/i>/g;
const missingIcons = new Set<string>();
/**
 * Fills every icon slot of a rendered page with @2lab.ai/ui's glyph (uiIcon) — in the markup and in
 * the client script's string constants alike (the SVG has no quote, backslash or newline a
 * single-quoted JS string could trip on). The page templates name glyphs instead of copying them, so
 * the dashboard draws the library's set. An unknown name fills nothing and is logged once.
 */
export function fillUiIcons(html: string): string {
  return html.replace(UI_ICON_SLOT, (_slot, name: string, cls?: string) => {
    const svg = uiIcon(name, cls ? { class: cls } : undefined);
    if (!svg && !missingIcons.has(name)) {
      missingIcons.add(name);
      logger.error(`@2lab.ai/ui has no icon "${name}" — the slot stays empty`);
    }
    return svg;
  });
}
