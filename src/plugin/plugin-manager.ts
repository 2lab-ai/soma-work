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

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';
import { loadUnifiedConfig, saveUnifiedConfig } from '../unified-config-loader';
import { parsePluginRef, validateMarketplaceEntry } from './config-parser';
import { DEFAULT_MARKETPLACES, DEFAULT_PLUGINS, isDefaultMarketplace, isDefaultPlugin } from './defaults';
import { type FetchOptions, fetchPlugin, isFetchFailure, resolveRemoteSha } from './marketplace-fetcher';
import { backupPlugin, listBackups, pruneBackups, restorePlugin } from './plugin-backup';
import { hasCachedPlugin, readCacheMeta } from './plugin-cache';
import type {
  BackupEntry,
  ForceRefreshResult,
  MarketplaceEntry,
  PluginConfig,
  PluginRef,
  PluginUpdateDetail,
  ResolvedPlugin,
  RollbackResult,
  SdkPluginPath,
} from './types';

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

  constructor(pluginConfig: PluginConfig, pluginsDir: string, configFile?: string, mcpFallback?: string) {
    this.pluginConfig = pluginConfig;
    this.pluginsDir = path.resolve(pluginsDir);
    this.configFile = configFile;
    this.mcpFallback = mcpFallback;
  }

  /**
   * Download/verify all plugins from marketplaces.
   * Should be called once during service startup.
   *
   * Default plugins (superpowers, stv) are always merged into the config
   * before resolution — they cannot be disabled via config.json.
   */
  async initialize(): Promise<void> {
    const results: ResolvedPlugin[] = [];

    // Merge default marketplaces and plugins into the effective config
    const effectiveConfig = this.mergeDefaults();
    const marketplaceMap = this.buildMarketplaceMap(effectiveConfig);

    // Resolve marketplace plugins (user + default combined)
    const refs = this.parsePluginRefs(effectiveConfig);
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
        if (isFetchFailure(result)) {
          logger.error('Failed to fetch plugin', {
            pluginName: ref.pluginName,
            code: result.code,
            message: result.message,
          });
        } else {
          const refStr = `${ref.pluginName}@${ref.marketplaceName}`;
          results.push({
            name: refStr,
            localPath: result.pluginPath,
            source: isDefaultPlugin(refStr) ? 'default' : 'marketplace',
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
      defaults: results.filter((r) => r.source === 'default').length,
      marketplace: results.filter((r) => r.source === 'marketplace').length,
      localOverrides: results.filter((r) => r.source === 'local-override').length,
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
    return this.resolved.map((r) => ({ type: 'local' as const, path: r.localPath }));
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
   * Smart update: check remote SHA per plugin, only re-download when changed.
   * Used by the `plugins update` admin command.
   *
   * Returns per-plugin detail including old/new SHA, old/new date, and status.
   */
  async forceRefresh(pluginOptions?: Record<string, FetchOptions>): Promise<ForceRefreshResult> {
    const details: PluginUpdateDetail[] = [];
    const errors: string[] = [];

    const effectiveConfig = this.mergeDefaults();
    const marketplaceMap = this.buildMarketplaceMap(effectiveConfig);
    const refs = this.parsePluginRefs(effectiveConfig);

    // Phase 1: Per-plugin smart update check
    for (const ref of refs) {
      const marketplace = marketplaceMap.get(ref.marketplaceName);
      if (!marketplace) {
        const msg = `Marketplace "${ref.marketplaceName}" not found for plugin "${ref.pluginName}"`;
        errors.push(msg);
        details.push({
          name: `${ref.pluginName}@${ref.marketplaceName}`,
          status: 'error',
          oldSha: null,
          oldDate: null,
          newSha: null,
          newDate: null,
          error: msg,
        });
        continue;
      }

      const pluginDisplayName = `${ref.pluginName}@${ref.marketplaceName}`;
      const gitRef = marketplace.ref || 'main';

      // Read existing cache meta BEFORE any changes
      const oldMeta = readCacheMeta(this.pluginsDir, ref.pluginName);
      const hadCache = hasCachedPlugin(this.pluginsDir, ref.pluginName);

      // Resolve remote SHA
      const remoteSha = resolveRemoteSha(marketplace.repo, gitRef);

      if (!remoteSha) {
        // Can't reach remote — keep existing if available
        if (hadCache && oldMeta) {
          details.push({
            name: pluginDisplayName,
            status: 'unchanged',
            oldSha: oldMeta.sha.slice(0, 8),
            oldDate: oldMeta.fetchedAt,
            newSha: oldMeta.sha.slice(0, 8),
            newDate: oldMeta.fetchedAt,
            error: 'Cannot reach remote, keeping cached version',
          });
        } else {
          const msg = `Cannot reach remote for ${pluginDisplayName} and no cache available`;
          errors.push(msg);
          details.push({
            name: pluginDisplayName,
            status: 'error',
            oldSha: null,
            oldDate: null,
            newSha: null,
            newDate: null,
            error: msg,
          });
        }
        continue;
      }

      // Compare SHA — if identical, skip download entirely
      // But if caller provided explicit options (e.g. force update), always re-fetch
      const hasExplicitOptions = pluginOptions?.[pluginDisplayName] != null;
      if (!hasExplicitOptions && oldMeta?.sha === remoteSha && hadCache) {
        logger.info('Plugin already up-to-date, skipping', {
          pluginName: ref.pluginName,
          sha: remoteSha.slice(0, 8),
        });
        details.push({
          name: pluginDisplayName,
          status: 'unchanged',
          oldSha: oldMeta.sha.slice(0, 8),
          oldDate: oldMeta.fetchedAt,
          newSha: remoteSha.slice(0, 8),
          newDate: oldMeta.fetchedAt,
        });
        continue;
      }

      // SHA differs or no cache — need to re-download
      // Create a persistent backup before update (plugin dir + meta file)
      const pluginDir = path.join(this.pluginsDir, ref.pluginName);
      const backup = hadCache ? backupPlugin(this.pluginsDir, ref.pluginName) : null;

      // Clear existing installation so fetchPlugin writes fresh
      try {
        if (fs.existsSync(pluginDir)) {
          fs.rmSync(pluginDir, { recursive: true, force: true });
        }
        const metaFile = path.join(this.pluginsDir, '.cache', `${ref.pluginName}.meta.json`);
        if (fs.existsSync(metaFile)) {
          fs.unlinkSync(metaFile);
        }
      } catch (err) {
        errors.push(`Failed to prepare cache for ${ref.pluginName}: ${(err as Error).message}`);
      }

      try {
        const opts = pluginOptions?.[pluginDisplayName];
        const result = await fetchPlugin(marketplace, ref.pluginName, this.pluginsDir, opts);
        if (isFetchFailure(result)) {
          // fetchPlugin failed — restore from persistent backup
          if (backup) {
            restorePlugin(this.pluginsDir, ref.pluginName, backup.timestamp);
          }
          const msg = `[${result.code}] ${result.message}`;
          errors.push(msg);
          details.push({
            name: pluginDisplayName,
            status: 'error',
            oldSha: oldMeta?.sha?.slice(0, 8) ?? null,
            oldDate: oldMeta?.fetchedAt ?? null,
            newSha: null,
            newDate: null,
            error: msg,
            failureCode: result.code,
            securityFindings: result.securityFindings,
            riskLevel: result.riskLevel,
          });
        } else {
          // Success — keep backup for rollback, prune old ones (keep last 3)
          pruneBackups(this.pluginsDir, ref.pluginName, 3);

          details.push({
            name: pluginDisplayName,
            status: oldMeta ? 'updated' : 'new',
            oldSha: oldMeta?.sha?.slice(0, 8) ?? null,
            oldDate: oldMeta?.fetchedAt ?? null,
            newSha: result.sha.slice(0, 8),
            newDate: new Date().toISOString(),
          });
        }
      } catch (error) {
        // Fetch threw — restore from persistent backup
        if (backup) {
          restorePlugin(this.pluginsDir, ref.pluginName, backup.timestamp);
        }
        const msg = `Failed to fetch ${pluginDisplayName}: ${(error as Error).message}`;
        errors.push(msg);
        details.push({
          name: pluginDisplayName,
          status: 'error',
          oldSha: oldMeta?.sha?.slice(0, 8) ?? null,
          oldDate: oldMeta?.fetchedAt ?? null,
          newSha: null,
          newDate: null,
          error: msg,
        });
      }
    }

    // Phase 2: Re-initialize to rebuild the resolved plugin list
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

    const updated = details.filter((d) => d.status === 'updated' || d.status === 'new').length;
    const unchanged = details.filter((d) => d.status === 'unchanged').length;

    return {
      total: this.resolved.length,
      updated,
      unchanged,
      errors,
      details,
    };
  }

  /**
   * Rebuild the resolved plugin list from local cache only (no remote fetch).
   * Used after rollback to avoid re-downloading the version we just rolled back from.
   *
   * Iterates config refs (same order as initialize) but only includes plugins
   * that exist on disk with valid cache meta.
   */
  rebuildResolved(): void {
    const results: ResolvedPlugin[] = [];

    const effectiveConfig = this.mergeDefaults();
    const refs = this.parsePluginRefs(effectiveConfig);

    for (const ref of refs) {
      const refStr = `${ref.pluginName}@${ref.marketplaceName}`;
      if (hasCachedPlugin(this.pluginsDir, ref.pluginName)) {
        results.push({
          name: refStr,
          localPath: path.join(this.pluginsDir, ref.pluginName),
          source: isDefaultPlugin(refStr) ? 'default' : 'marketplace',
        });
      } else {
        logger.debug('Plugin not found on disk during rebuild, skipping', { pluginName: ref.pluginName });
      }
    }

    // Local overrides
    const overrides = this.pluginConfig.localOverrides || [];
    for (const overridePath of overrides) {
      results.push({
        name: `local:${overridePath}`,
        localPath: path.resolve(overridePath),
        source: 'local-override',
      });
    }

    this.resolved = Object.freeze(results);
    this.initialized = true;

    logger.info('Plugin resolved list rebuilt from local cache', { total: results.length });
  }

  /**
   * Rollback a plugin to its most recent backup.
   *
   * Flow: backup current → restore previous → rebuildResolved (no fetch)
   */
  async rollback(pluginRef: string): Promise<RollbackResult> {
    const parsed = parsePluginRef(pluginRef);
    if (!parsed) {
      return {
        success: false,
        pluginRef,
        previousSha: null,
        restoredSha: null,
        restoredDate: null,
        error: `Invalid plugin ref: ${pluginRef}`,
      };
    }

    const { pluginName } = parsed;

    // Check available backups
    const backups = listBackups(this.pluginsDir, pluginName);
    if (backups.length === 0) {
      return {
        success: false,
        pluginRef,
        previousSha: null,
        restoredSha: null,
        restoredDate: null,
        error: `No backups available for ${pluginRef}`,
      };
    }

    // Validate marketplace consistency
    const targetBackup = backups[0];
    if (targetBackup.marketplace !== 'unknown' && !targetBackup.marketplace.startsWith('external:')) {
      if (targetBackup.marketplace !== parsed.marketplaceName) {
        return {
          success: false,
          pluginRef,
          previousSha: null,
          restoredSha: null,
          restoredDate: null,
          error: `Backup marketplace "${targetBackup.marketplace}" does not match requested "${parsed.marketplaceName}"`,
        };
      }
    }

    // Read current state before rollback
    const currentMeta = readCacheMeta(this.pluginsDir, pluginName);
    const previousSha = currentMeta?.sha?.slice(0, 8) ?? null;

    // Step 1: Backup current installation (so we can undo the rollback)
    if (hasCachedPlugin(this.pluginsDir, pluginName)) {
      backupPlugin(this.pluginsDir, pluginName);
    }

    // Step 2: Restore from the most recent backup
    const restored = restorePlugin(this.pluginsDir, pluginName, targetBackup.timestamp);
    if (!restored) {
      return {
        success: false,
        pluginRef,
        previousSha,
        restoredSha: null,
        restoredDate: null,
        error: 'Failed to restore backup',
      };
    }

    // Step 3: Rebuild resolved list without fetching
    this.rebuildResolved();

    // Step 4: Prune old backups (keep 3)
    pruneBackups(this.pluginsDir, pluginName, 3);

    logger.info('Plugin rolled back', {
      pluginRef,
      from: previousSha,
      to: restored.sha.slice(0, 8),
    });

    return {
      success: true,
      pluginRef,
      previousSha,
      restoredSha: restored.sha.slice(0, 8),
      restoredDate: restored.timestamp,
    };
  }

  /**
   * List available backups for a plugin.
   */
  getBackups(pluginName: string): BackupEntry[] {
    return listBackups(this.pluginsDir, pluginName);
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
    if (existing.some((m) => m.name === entry.name)) {
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
    if (isDefaultMarketplace(name)) {
      return { success: false, error: `Default marketplace "${name}" cannot be removed` };
    }
    const existing = this.pluginConfig.marketplace || [];
    if (!existing.some((m) => m.name === name)) {
      return { success: false, error: `Marketplace "${name}" not found` };
    }

    this.pluginConfig = {
      ...this.pluginConfig,
      marketplace: existing.filter((m) => m.name !== name),
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
    if (isDefaultPlugin(pluginRef)) {
      return { success: false, error: `Default plugin "${pluginRef}" cannot be removed` };
    }
    const existing = this.pluginConfig.plugins || [];
    if (!existing.includes(pluginRef)) {
      return { success: false, error: `Plugin "${pluginRef}" not found` };
    }

    this.pluginConfig = {
      ...this.pluginConfig,
      plugins: existing.filter((p) => p !== pluginRef),
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

  /**
   * Merge DEFAULT_MARKETPLACES and DEFAULT_PLUGINS into the user config.
   * User config takes precedence on name collisions.
   */
  private mergeDefaults(): PluginConfig {
    const userMarketplaces = this.pluginConfig.marketplace || [];
    const userPlugins = this.pluginConfig.plugins || [];
    const userNames = new Set(userMarketplaces.map((m) => m.name));

    // Add default marketplaces that aren't already defined by user
    const mergedMarketplaces = [...userMarketplaces, ...DEFAULT_MARKETPLACES.filter((d) => !userNames.has(d.name))];

    // Add default plugins that aren't already in user list
    const userPluginSet = new Set(userPlugins);
    const mergedPlugins = [...userPlugins, ...DEFAULT_PLUGINS.filter((d) => !userPluginSet.has(d))];

    return {
      ...this.pluginConfig,
      marketplace: mergedMarketplaces,
      plugins: mergedPlugins,
    };
  }

  private buildMarketplaceMap(config: PluginConfig): Map<string, MarketplaceEntry> {
    const map = new Map<string, MarketplaceEntry>();
    for (const entry of config.marketplace || []) {
      if (map.has(entry.name)) {
        logger.warn('Duplicate marketplace name — later entry wins', { name: entry.name });
      }
      map.set(entry.name, entry);
    }
    return map;
  }

  private parsePluginRefs(config: PluginConfig): PluginRef[] {
    const refs: PluginRef[] = [];
    for (const raw of config.plugins || []) {
      const ref = parsePluginRef(raw);
      if (ref) refs.push(ref);
    }
    return refs;
  }
}
