/**
 * Default plugins that are always loaded regardless of config.json.
 *
 * These are hardcoded and cannot be removed by users.
 * They are merged into the plugin config during PluginManager initialization.
 */

import type { MarketplaceEntry } from './types';

/** Default marketplace sources — merged with user config (user wins on name collision). */
export const DEFAULT_MARKETPLACES: MarketplaceEntry[] = [
  { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official', ref: 'main' },
  { name: 'oh-my-claude', repo: '2lab-ai/oh-my-claude', ref: 'main' },
  // soma-work hosts the first-party `local` (= plugin/local) and `core`
  // (= plugin/core) plugins. Registered as a default marketplace so
  // `/plugin install local@soma-work` resolves and so a remote fetch can serve
  // as a fallback if the bundled copy is ever missing.
  { name: 'soma-work', repo: '2lab-ai/soma-work', ref: 'main' },
];

/**
 * Default plugin refs — always loaded, cannot be removed.
 *
 * `local@soma-work` and `core@soma-work` are first-party BUNDLED plugins: they
 * are listed here for symmetry with `stv@oh-my-claude` (all are runtime-required
 * defaults), but at resolution time PluginManager short-circuits them to their
 * bundled dirs (see ./bundled) instead of fetching them from the network.
 */
export const DEFAULT_PLUGINS: string[] = [
  'superpowers@claude-plugins-official',
  'stv@oh-my-claude',
  'local@soma-work',
  'core@soma-work',
];

/** Check if a plugin ref is a default (protected from removal). */
export function isDefaultPlugin(pluginRef: string): boolean {
  return DEFAULT_PLUGINS.includes(pluginRef);
}

/** Check if a marketplace name is a default (protected from removal). */
export function isDefaultMarketplace(name: string): boolean {
  return DEFAULT_MARKETPLACES.some((m) => m.name === name);
}
