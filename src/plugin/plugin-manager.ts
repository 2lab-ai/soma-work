/**
 * PluginManager — Facade for the plugin marketplace system.
 *
 * Coordinates config parsing, marketplace fetching, caching,
 * and provides SDK-ready plugin paths.
 */

import * as path from 'path';
import { PluginConfig, MarketplaceEntry, ResolvedPlugin, SdkPluginPath, PluginRef } from './types';
import { parsePluginRef } from './config-parser';
import { fetchPlugin } from './marketplace-fetcher';
import { Logger } from '../logger';

const logger = new Logger('PluginManager');

export class PluginManager {
  private readonly pluginConfig: PluginConfig;
  private readonly pluginsDir: string;
  private resolved: readonly ResolvedPlugin[] = [];
  private initialized = false;

  constructor(pluginConfig: PluginConfig, pluginsDir: string) {
    this.pluginConfig = pluginConfig;
    this.pluginsDir = path.resolve(pluginsDir);
  }

  /**
   * Download/verify all plugins from marketplaces.
   * Should be called once during service startup.
   */
  async initialize(): Promise<void> {
    const results: ResolvedPlugin[] = [];
    const marketplaceMap = this.buildMarketplaceMap();

    // Resolve marketplace plugins
    const refs = this.parsePluginRefs();
    for (const ref of refs) {
      const marketplace = marketplaceMap.get(ref.marketplaceName);
      if (!marketplace) {
        logger.error('Marketplace not found for plugin', {
          pluginName: ref.pluginName,
          marketplaceName: ref.marketplaceName,
          available: [...marketplaceMap.keys()],
        });
        continue;
      }

      try {
        const result = await fetchPlugin(marketplace, ref.pluginName, this.pluginsDir);
        if (result) {
          results.push({
            name: `${ref.pluginName}@${ref.marketplaceName}`,
            localPath: result.pluginPath,
            source: 'marketplace',
          });
        }
      } catch (error) {
        logger.error('Failed to fetch plugin', {
          pluginName: ref.pluginName,
          error: (error as Error).message,
        });
      }
    }

    // Resolve local overrides
    const overrides = this.pluginConfig.localOverrides || [];
    for (const overridePath of overrides) {
      const absPath = path.resolve(overridePath);
      results.push({
        name: `local:${overridePath}`,
        localPath: absPath,
        source: 'local-override',
      });
      logger.info('Local override registered', { path: absPath });
    }

    this.resolved = Object.freeze(results);
    this.initialized = true;

    logger.info('Plugin initialization complete', {
      total: results.length,
      marketplace: results.filter(r => r.source === 'marketplace').length,
      localOverrides: results.filter(r => r.source === 'local-override').length,
    });
  }

  /**
   * Returns SDK-compatible plugin path objects.
   * Must be called after initialize().
   */
  getPluginPaths(): SdkPluginPath[] {
    if (!this.initialized) {
      logger.warn('getPluginPaths called before initialize — returning empty');
      return [];
    }
    return this.resolved.map(r => ({ type: 'local' as const, path: r.localPath }));
  }

  /**
   * Re-fetch all plugins (for `mcp reload` command).
   * On failure, restores the previous plugin set.
   */
  async refresh(): Promise<void> {
    const previous = this.resolved;
    this.initialized = false;
    this.resolved = [];
    try {
      await this.initialize();
    } catch (error) {
      this.resolved = previous;
      this.initialized = true;
      throw error;
    }
  }

  /**
   * Get read-only list of resolved plugins (for debugging/logging).
   */
  getResolvedPlugins(): readonly ResolvedPlugin[] {
    return this.resolved;
  }

  private buildMarketplaceMap(): Map<string, MarketplaceEntry> {
    const map = new Map<string, MarketplaceEntry>();
    for (const entry of this.pluginConfig.marketplace || []) {
      if (map.has(entry.name)) {
        logger.warn('Duplicate marketplace name — later entry wins', { name: entry.name });
      }
      map.set(entry.name, entry);
    }
    return map;
  }

  private parsePluginRefs(): PluginRef[] {
    const refs: PluginRef[] = [];
    for (const raw of this.pluginConfig.plugins || []) {
      const ref = parsePluginRef(raw);
      if (ref) refs.push(ref);
    }
    return refs;
  }
}
