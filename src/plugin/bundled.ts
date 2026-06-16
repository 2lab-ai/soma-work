/**
 * First-party plugins that ship *inside* the soma-work bundle.
 *
 * These are not fetched from a remote marketplace at startup — the code is
 * already present on disk (src/local in the source tree, copied to dist/local
 * by the build via `cp -r src/local dist/`). They are still listed in
 * DEFAULT_PLUGINS (see ./defaults) for symmetry/discoverability and exposed via
 * the official `.claude-plugin/marketplace.json` so external Claude Code users
 * can `/plugin install zworkflow@soma-work`. Inside the service, however, they
 * resolve directly to the bundled directory — never a network download.
 */

import * as path from 'node:path';

/**
 * Absolute path to the bundled local plugin directory.
 *
 * Resolves relative to this module's location so it is identical whether running
 * from source (src/plugin → src/local) or the compiled bundle (dist/plugin →
 * dist/local). `path.join` collapses the `..`, yielding the same string the
 * legacy LOCAL_PLUGINS_DIR fallback produced, so the de-dup check in
 * claude-handler keeps working.
 */
export const BUNDLED_PLUGINS_DIR = path.join(__dirname, '..', 'local');

/**
 * Map of bundled plugin name → absolute local path.
 *
 * Consumed by PluginManager: any plugin ref whose name is a key here is
 * resolved to the bundled path with `source: 'default'` and no fetch.
 */
export const BUNDLED_PLUGINS: Record<string, string> = {
  zworkflow: BUNDLED_PLUGINS_DIR,
};
