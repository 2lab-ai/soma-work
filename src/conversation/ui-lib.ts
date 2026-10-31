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

interface UiIconTable {
  glyphs: Map<string, string>;
  aliases: Map<string, string>;
}

/** One `key: '…'` / `"key": '…'` / `key: "…"` entry of a flat object literal of string values. */
const TABLE_ENTRY = /^\s*(?:"([a-z][a-z0-9-]*)"|([a-z][a-z0-9]*))\s*:\s*(?:'([^'\\]*)'|"([^"\\]*)"),?\s*$/;

/** The entries of `const NAME = { … };` in `src`, or null when it is not a flat table of plain strings. */
function readStringTable(src: string, name: string): Map<string, string> | null {
  const head = src.indexOf(`const ${name} = {\n`);
  if (head < 0) return null;
  const from = head + `const ${name} = {\n`.length;
  const close = src.indexOf('\n};', from);
  if (close < 0) return null;
  const table = new Map<string, string>();
  for (const line of src.slice(from, close).split('\n')) {
    if (!line.trim()) continue;
    const m = TABLE_ENTRY.exec(line);
    if (!m) return null;
    table.set(m[1] ?? m[2], m[3] ?? m[4]);
  }
  return table;
}

let uiIconTable: UiIconTable | null | undefined;
/**
 * The glyph table of @2lab.ai/ui's icon set (`dist/icons.js`, the `./icons` export), READ as data — the
 * module is never run: `GLYPHS` (name → 16-grid SVG body) and `ICON_ALIASES` (name → name) are flat
 * literals of plain strings. Null (logged once) when the file is missing or not that shape, or when a
 * glyph carries markup that could close the page's <script> once filled into its string constants.
 */
function uiIconsTable(): UiIconTable | null {
  if (uiIconTable === undefined) {
    uiIconTable = null;
    const dir = uiLibDistDir();
    if (dir) {
      try {
        const src = readFileSync(join(dir, 'icons.js'), 'utf8');
        const glyphs = readStringTable(src, 'GLYPHS');
        const aliases = readStringTable(src, 'ICON_ALIASES') ?? new Map<string, string>();
        const unsafe = glyphs && [...glyphs.values()].some((g) => /<\/?script|<!--|<\/?style/i.test(g));
        if (!glyphs || glyphs.size === 0 || unsafe)
          logger.error('@2lab.ai/ui icons.js does not carry a plain glyph table — no icons');
        else uiIconTable = { glyphs, aliases };
      } catch (err) {
        logger.error('@2lab.ai/ui icons.js is missing — the pages have no icons', err);
      }
    }
  }
  return uiIconTable;
}

const escIconText = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * `icon()` of @2lab.ai/ui/icons, drawn on the server from the library's glyph table ('' without the
 * package or for an unknown name) — the same markup as the library's own `icon()` (pinned by a test that
 * compares the two for every glyph).
 */
export function uiIcon(name: string, opts: Parameters<UiIconFn>[1] = {}): string {
  const table = uiIconsTable();
  if (!table) return '';
  const key = table.glyphs.has(name) ? name : table.aliases.get(name);
  const body = key === undefined ? undefined : table.glyphs.get(key);
  if (key === undefined || body === undefined) return '';
  const size = Number.isFinite(opts.size) && (opts.size as number) > 0 ? Number(opts.size) : 16;
  const stroke = Number.isFinite(opts.stroke) && (opts.stroke as number) > 0 ? Number(opts.stroke) : 1.5;
  const a11y = opts.label ? `role="img" aria-label="${escIconText(opts.label)}"` : 'aria-hidden="true"';
  const cls = opts.class ? ` class="${escIconText(opts.class)}"` : '';
  const title = opts.label ? `<title>${escIconText(opts.label)}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" focusable="false" data-icon="${key}"${cls} ${a11y}>${title}${body}</svg>`;
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
