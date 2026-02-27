/**
 * PluginManager — Facade for the plugin marketplace system.
 *
 * Coordinates config parsing, marketplace fetching, caching,
 * and provides SDK-ready plugin paths.
 *
 * CRUD methods (addMarketplace, removeMarketplace, addPlugin, removePlugin)
 * mutate the in-memory config using immutable patterns (new objects),
 * then persist to config.json via saveUnifiedConfig.
 */

import * as path from 'path';
import { PluginConfig, MarketplaceEntry, ResolvedPlugin, SdkPluginPath, PluginRef } from './types';
import { parsePluginRef, validateMarketplaceEntry } from './config-parser';
import { fetchPlugin } from './marketplace-fetcher';
import { loadUnifiedConfig, saveUnifiedConfig } from '../unified-config-loader';
import { Logger } from '../logger';

const logger = new Logger('PluginManager');

/** Standardised result for CRUD operations. */
export interface CrudResult {
  success: boolean;
  error?: string;
}

export class PluginManager {
  private pluginConfig: PluginConfig;
  private readonly pluginsDir: string;
  private readonly configFile: string | undefined;
  private readonly mcpFallback: string | undefined;
  private resolved: readonly ResolvedPlugin[] = [];
  private initialized = false;

  constructor(
    pluginConfig: PluginConfig,
    pluginsDir: string,
    configFile?: string,
    mcpFallback?: string,
  ) {
    this.pluginConfig = pluginConfig;
    this.pluginsDir = path.resolve(pluginsDir);
    this.configFile = configFile;
    this.mcpFallback = mcpFallback;
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

  // =========================================================================
  // CRUD — Marketplace management
  // =========================================================================

  /** Get current marketplace list (returns a defensive copy). */
  getMarketplaces(): readonly MarketplaceEntry[] {
    return [...(this.pluginConfig.marketplace || [])];
  }

  /** Get current installed plugin refs (returns a defensive copy). */
  getInstalledPlugins(): readonly string[] {
    return [...(this.pluginConfig.plugins || [])];
  }

  /** Add a marketplace source. Persists to config.json when configFile is set. */
  addMarketplace(entry: MarketplaceEntry): CrudResult {
    if (!validateMarketplaceEntry(entry)) {
      return { success: false, error: `Marketplace entry is invalid (bad name or repo format)` };
    }

    const existing = this.pluginConfig.marketplace || [];
    if (existing.some(m => m.name === entry.name)) {
      return { success: false, error: `Marketplace "${entry.name}" already exists` };
    }

    this.pluginConfig = {
      ...this.pluginConfig,
      marketplace: [...existing, entry],
    };

    this.saveConfig();
    logger.info('Marketplace added', { name: entry.name, repo: entry.repo });
    return { success: true };
  }

  /** Remove a marketplace by name. Persists to config.json when configFile is set. */
  removeMarketplace(name: string): CrudResult {
    const existing = this.pluginConfig.marketplace || [];
    if (!existing.some(m => m.name === name)) {
      return { success: false, error: `Marketplace "${name}" not found` };
    }

    this.pluginConfig = {
      ...this.pluginConfig,
      marketplace: existing.filter(m => m.name !== name),
    };

    this.saveConfig();
    logger.info('Marketplace removed', { name });
    return { success: true };
  }

  /** Add a plugin ref (e.g., "omc@soma-work"). Persists to config.json when configFile is set. */
  addPlugin(pluginRef: string): CrudResult {
    const parsed = parsePluginRef(pluginRef);
    if (!parsed) {
      return { success: false, error: `Plugin ref "${pluginRef}" is invalid (expected "name@marketplace")` };
    }

    const existing = this.pluginConfig.plugins || [];
    if (existing.includes(pluginRef)) {
      return { success: false, error: `Plugin "${pluginRef}" is already installed` };
    }

    this.pluginConfig = {
      ...this.pluginConfig,
      plugins: [...existing, pluginRef],
    };

    this.saveConfig();
    logger.info('Plugin added', { pluginRef });
    return { success: true };
  }

  /** Remove a plugin ref. Persists to config.json when configFile is set. */
  removePlugin(pluginRef: string): CrudResult {
    const existing = this.pluginConfig.plugins || [];
    if (!existing.includes(pluginRef)) {
      return { success: false, error: `Plugin "${pluginRef}" not found` };
    }

    this.pluginConfig = {
      ...this.pluginConfig,
      plugins: existing.filter(p => p !== pluginRef),
    };

    this.saveConfig();
    logger.info('Plugin removed', { pluginRef });
    return { success: true };
  }

  // =========================================================================
  // Config persistence
  // =========================================================================

  /**
   * Reload the full unified config from disk, update the plugin section,
   * and write back atomically. Preserves the mcpServers section.
   */
  private saveConfig(): void {
    if (!this.configFile) return;

    const full = loadUnifiedConfig(this.configFile, this.mcpFallback || '');
    const updated = { ...full, plugin: this.pluginConfig };
    saveUnifiedConfig(this.configFile, updated);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

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
