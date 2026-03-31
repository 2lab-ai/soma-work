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
];

/** Default plugin refs — always loaded, cannot be removed. */
export const DEFAULT_PLUGINS: string[] = ['superpowers@claude-plugins-official', 'stv@oh-my-claude'];

/** Check if a plugin ref is a default (protected from removal). */
export function isDefaultPlugin(pluginRef: string): boolean {
  return DEFAULT_PLUGINS.includes(pluginRef);
}

/** Check if a marketplace name is a default (protected from removal). */
export function isDefaultMarketplace(name: string): boolean {
  return DEFAULT_MARKETPLACES.some((m) => m.name === name);
}
