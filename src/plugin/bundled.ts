/**
 * First-party plugins that ship *inside* the soma-work bundle.
 *
 * These are not fetched from a remote marketplace at startup — the code is
 * already present on disk (`plugin/local` + `plugin/core` in the source tree,
 * copied to `dist/local` + `dist/core` by the build; see package.json `build`).
 * They are still listed in DEFAULT_PLUGINS (see ./defaults) for
 * symmetry/discoverability and exposed via the official
 * `.claude-plugin/marketplace.json` so external Claude Code users can
 * `/plugin install local@soma-work` / `/plugin install core@soma-work`. Inside
 * the service, however, they resolve directly to the bundled directory — never
 * a network download.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolve a bundled plugin directory in BOTH run modes.
 *
 * - compiled bundle: this module is `dist/plugin/bundled.js`, so the plugin sits
 *   next to it at `dist/<name>` (`__dirname/../<name>`).
 * - source tree: this module is `src/plugin/bundled.ts` and the plugin content
 *   lives outside `src/` at `<repo>/plugin/<name>` (`__dirname/../../plugin/<name>`).
 *
 * The dist layout is probed first so the runtime never reaches outside the
 * bundle; the source layout is the fallback (tests, ts-node, dev server).
 */
function bundledDir(name: string): string {
  const distPath = path.join(__dirname, '..', name);
  try {
    if (fs.existsSync(distPath)) return distPath;
  } catch {
    // unreadable dist path — fall through to the source-tree layout
  }
  return path.join(__dirname, '..', '..', 'plugin', name);
}

/**
 * Absolute path to the bundled `local` plugin directory (the bot-bound half).
 *
 * Name kept as-is for existing importers (claude-handler, skill-locator,
 * plugins-handler) — it is the `local` plugin, not a generic "plugins dir".
 */
export const BUNDLED_PLUGINS_DIR = bundledDir('local');

/** Absolute path to the bundled `core` plugin directory (standalone half). */
export const CORE_PLUGIN_DIR = bundledDir('core');

/**
 * Map of bundled plugin name → absolute local path.
 *
 * Consumed by PluginManager: any plugin ref whose name is a key here is
 * resolved to the bundled path with `source: 'default'` and no fetch.
 */
export const BUNDLED_PLUGINS: Record<string, string> = {
  local: BUNDLED_PLUGINS_DIR,
  core: CORE_PLUGIN_DIR,
};
