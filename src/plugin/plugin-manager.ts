/**
 * PluginManager — Facade for the plugin marketplace system.
 *
 * Coordinates config parsing, marketplace fetching, caching,
 * and provides SDK-ready plugin paths.
 *
 * CRUD methods (addMarketplace, removeMarketplace, addPlugin, removePlugin)
 * mutate the in-memory config using immutable patterns (new objects),
 * then persist to config.json via saveConfig.
 */

import { UnsafePathError } from '@soma/common/atomic-write';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, saveConfig } from '../config-loader';
import { Logger } from '../logger';
import { setAdmittedPluginNames } from './admitted-plugin-names';
import { parsePluginRef, validateMarketplaceEntry } from './config-parser';
import { DEFAULT_MARKETPLACES, DEFAULT_PLUGINS, isDefaultMarketplace, isDefaultPlugin } from './defaults';
import {
  type FetchOptions,
  fetchPlugin,
  gateCachedPlugin,
  isCacheAdmissible,
  isFetchFailure,
  resolveRemoteSha,
  type SecurityMode,
  securityBlockedFailure,
} from './marketplace-fetcher';
import { backupPlugin, listBackups, pruneBackups, restorePlugin } from './plugin-backup';
import { hasCachedPlugin, readCacheMeta } from './plugin-cache';
import type {
  BackupEntry,
  CacheMeta,
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

/**
 * Operator-facing text for a refused `config.json` write.
 *
 * Deliberately path-free: the underlying `UnsafePathError` names the refused
 * path and, when the refusal is a symlink, effectively points at its target.
 * Neither is something a plugin CRUD result should carry into a UI or a log.
 */
const PERSIST_REFUSED_ERROR =
  'Plugin configuration could not be saved: somawork refuses to write through a symlinked config path. Replace the link with a real file or directory and retry.';

/** Standardised result for CRUD operations. */
export interface CrudResult {
  success: boolean;
  error?: string;
}

export class PluginManager {
  private pluginConfig: PluginConfig;
  private readonly pluginsDir: string;
  private readonly configFile: string | undefined;
  private readonly bundledPlugins: Record<string, string>;
  private resolved: readonly ResolvedPlugin[] = [];
  private initialized = false;

  /**
   * @param bundledPlugins Map of plugin name → absolute local path for first-party
   *   plugins shipped inside the bundle (e.g. `{ zworkflow: dist/local }`). Any
   *   plugin ref whose name is a key here resolves to that path with no fetch.
   */
  constructor(
    pluginConfig: PluginConfig,
    pluginsDir: string,
    configFile?: string,
    bundledPlugins: Record<string, string> = {},
  ) {
    this.pluginConfig = pluginConfig;
    this.pluginsDir = path.resolve(pluginsDir);
    this.configFile = configFile;
    this.bundledPlugins = bundledPlugins;
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
    const refused = this.refuseNameCollisions(refs);
    for (const ref of refs) {
      // First-party bundled plugins resolve to the local bundle — never fetched.
      const bundled = this.resolveBundled(ref);
      if (bundled) {
        results.push(bundled);
        continue;
      }
      if (refused.has(ref.pluginName)) continue;

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
        const result = await fetchPlugin(marketplace, ref.pluginName, this.pluginsDir, this.fetchOptionsFor(ref));
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

    this.setResolved(results);

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
      this.setResolved(previous);
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
    const refused = this.refuseNameCollisions(refs);
    for (const msg of new Set(refused.values())) errors.push(msg);

    // Phase 1: Per-plugin smart update check
    for (const ref of refs) {
      // Refused (name collision): no fetch. No failureCode — Force Update cannot fix a config error.
      const refusal = refused.get(ref.pluginName);
      if (refusal) {
        details.push({
          name: `${ref.pluginName}@${ref.marketplaceName}`,
          status: 'error',
          oldSha: null,
          oldDate: null,
          oldVersion: null,
          newSha: null,
          newDate: null,
          newVersion: null,
          error: refusal,
        });
        continue;
      }

      // Bundled first-party plugins have no remote to check — always current.
      const bundled = this.resolveBundled(ref);
      if (bundled) {
        details.push({
          name: bundled.name,
          status: 'unchanged',
          oldSha: null,
          oldDate: null,
          oldVersion: null,
          newSha: null,
          newDate: null,
          newVersion: null,
        });
        continue;
      }

      const marketplace = marketplaceMap.get(ref.marketplaceName);
      if (!marketplace) {
        const msg = `Marketplace "${ref.marketplaceName}" not found for plugin "${ref.pluginName}"`;
        errors.push(msg);
        details.push({
          name: `${ref.pluginName}@${ref.marketplaceName}`,
          status: 'error',
          oldSha: null,
          oldDate: null,
          oldVersion: null,
          newSha: null,
          newDate: null,
          newVersion: null,
          error: msg,
        });
        continue;
      }

      const pluginDisplayName = `${ref.pluginName}@${ref.marketplaceName}`;
      const gitRef = marketplace.ref || 'main';
      const mode = this.securityModeFor(ref);

      // Read existing cache meta BEFORE any changes
      const oldMeta = readCacheMeta(this.pluginsDir, ref.pluginName);
      const hadCache = hasCachedPlugin(this.pluginsDir, ref.pluginName);

      // Resolve remote SHA
      const remoteSha = resolveRemoteSha(marketplace.repo, gitRef);

      if (!remoteSha) {
        // Can't reach remote — keep existing if available, once it passes the gate for this ref
        const blocked =
          hadCache && oldMeta ? gateCachedPlugin(this.pluginsDir, ref.pluginName, pluginDisplayName, mode) : null;
        if (blocked) {
          const result = securityBlockedFailure('Cached plugin', blocked);
          const msg = `[${result.code}] ${result.message}`;
          errors.push(msg);
          details.push({
            name: pluginDisplayName,
            status: 'error',
            oldSha: oldMeta?.sha?.slice(0, 8) ?? null,
            oldDate: oldMeta?.fetchedAt ?? null,
            oldVersion: oldMeta?.version ?? null,
            newSha: null,
            newDate: null,
            newVersion: null,
            error: msg,
            failureCode: result.code,
            securityFindings: result.securityFindings,
            riskLevel: result.riskLevel,
          });
        } else if (hadCache && oldMeta) {
          details.push({
            name: pluginDisplayName,
            status: 'unchanged',
            oldSha: oldMeta.sha.slice(0, 8),
            oldDate: oldMeta.fetchedAt,
            oldVersion: oldMeta.version ?? null,
            newSha: oldMeta.sha.slice(0, 8),
            newDate: oldMeta.fetchedAt,
            newVersion: oldMeta.version ?? null,
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
            oldVersion: null,
            newSha: null,
            newDate: null,
            newVersion: null,
            error: msg,
          });
        }
        continue;
      }

      // Compare SHA — if identical, skip download entirely
      // But if caller provided explicit options (e.g. force update), always re-fetch,
      // and so does a cache not admitted for this ref and mode (e.g. recorded for a former env plugin)
      const hasExplicitOptions = pluginOptions?.[pluginDisplayName] != null;
      if (
        !hasExplicitOptions &&
        oldMeta?.sha === remoteSha &&
        hadCache &&
        isCacheAdmissible(oldMeta, pluginDisplayName, mode)
      ) {
        logger.info('Plugin already up-to-date, skipping', {
          pluginName: ref.pluginName,
          sha: remoteSha.slice(0, 8),
        });
        details.push({
          name: pluginDisplayName,
          status: 'unchanged',
          oldSha: oldMeta.sha.slice(0, 8),
          oldDate: oldMeta.fetchedAt,
          oldVersion: oldMeta.version ?? null,
          newSha: remoteSha.slice(0, 8),
          newDate: oldMeta.fetchedAt,
          newVersion: oldMeta.version ?? null,
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
        const opts = this.fetchOptionsFor(ref, pluginOptions?.[pluginDisplayName]);
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
            oldVersion: oldMeta?.version ?? null,
            newSha: null,
            newDate: null,
            newVersion: null,
            error: msg,
            failureCode: result.code,
            securityFindings: result.securityFindings,
            riskLevel: result.riskLevel,
          });
        } else {
          // Success — keep backup for rollback, prune old ones (keep last 3)
          pruneBackups(this.pluginsDir, ref.pluginName, 3);

          // Read new cache meta written by fetchPlugin for version info
          const newMeta = readCacheMeta(this.pluginsDir, ref.pluginName);
          details.push({
            name: pluginDisplayName,
            status: oldMeta ? 'updated' : 'new',
            oldSha: oldMeta?.sha?.slice(0, 8) ?? null,
            oldDate: oldMeta?.fetchedAt ?? null,
            oldVersion: oldMeta?.version ?? null,
            newSha: result.sha.slice(0, 8),
            newDate: new Date().toISOString(),
            newVersion: newMeta?.version ?? null,
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
          oldVersion: oldMeta?.version ?? null,
          newSha: null,
          newDate: null,
          newVersion: null,
          error: msg,
        });
      }
    }

    // Phase 2: Rebuild resolved list from local cache only.
    // We do NOT call initialize() here because Phase 1 already handled per-plugin
    // fetch/update. Re-running initialize() would re-download plugins whose backups
    // were just restored on failure, undoing the recovery.
    this.rebuildResolved();

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
    const colliding = this.nameCollisions(refs);

    for (const ref of refs) {
      const bundled = this.resolveBundled(ref);
      if (bundled) {
        results.push(bundled);
        continue;
      }
      // Refused by initialize/forceRefresh (name collision): never resolved from disk either.
      if (colliding.has(ref.pluginName)) continue;

      const refStr = `${ref.pluginName}@${ref.marketplaceName}`;
      if (hasCachedPlugin(this.pluginsDir, ref.pluginName)) {
        // Served without a fresh install (kept, restored, rolled back): only through the gate.
        if (gateCachedPlugin(this.pluginsDir, ref.pluginName, refStr, this.securityModeFor(ref))) {
          logger.warn('Plugin on disk not served: blocked by security scan and removed', { pluginRef: refStr });
          continue;
        }
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

    this.setResolved(results);

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

    // Verify the plugin is still in the active config — rolling back an unconfigured
    // plugin would restore files to disk but rebuildResolved() would not include it,
    // leaving the user with a misleading "success" message.
    const effectiveConfig = this.mergeDefaults();
    const configRefs = this.parsePluginRefs(effectiveConfig);
    const collision = this.nameCollisions(configRefs).get(pluginName);
    if (collision) {
      // Restoring would put bytes back under a name two refs share — refused like the refs themselves.
      return {
        success: false,
        pluginRef,
        previousSha: null,
        restoredSha: null,
        restoredDate: null,
        error: this.collisionMessage(pluginName, collision),
      };
    }
    const isConfigured = configRefs.some((r) => r.pluginName === pluginName);
    if (!isConfigured) {
      return {
        success: false,
        pluginRef,
        previousSha: null,
        restoredSha: null,
        restoredDate: null,
        error: `Plugin "${pluginName}" is not in the current config. Add it back before rolling back.`,
      };
    }

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

    // Step 3: Rebuild resolved list without fetching (gates the restored content for this ref).
    // Success = the restored directory resolved, not that it exists: a blocked restore whose
    // removal failed stays on disk but is not resolved (so not admitted, so not served).
    this.rebuildResolved();
    const restoredPath = path.join(this.pluginsDir, pluginName);
    if (!this.resolved.some((r) => r.localPath === restoredPath)) {
      return {
        success: false,
        pluginRef,
        previousSha,
        restoredSha: null,
        restoredDate: null,
        error: `Restored backup of ${pluginRef} was blocked by the security scan and is not served`,
      };
    }

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
   * Get cache metadata for a specific plugin (SHA, fetchedAt, marketplace).
   * Returns null if no cache metadata exists.
   */
  getPluginMeta(pluginName: string): CacheMeta | null {
    return readCacheMeta(this.pluginsDir, pluginName);
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

  /**
   * Plugin names (`name` of `name@marketplace`) the fleet deploy installed as
   * environment plugins (`plugin.envPlugins`). Their skills run for non-admins
   * only on an admin's grant (`src/env-skill-registry.ts`).
   */
  getEnvPluginNames(): ReadonlySet<string> {
    const names = new Set<string>();
    for (const raw of this.pluginConfig.envPlugins || []) {
      const ref = parsePluginRef(raw);
      if (ref) names.add(ref.pluginName);
    }
    return names;
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

    return this.commit({ ...this.pluginConfig, marketplace: [...existing, entry] }, () =>
      logger.info('Marketplace added', { name: entry.name, repo: entry.repo }),
    );
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

    return this.commit({ ...this.pluginConfig, marketplace: existing.filter((m) => m.name !== name) }, () =>
      logger.info('Marketplace removed', { name }),
    );
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

    return this.commit({ ...this.pluginConfig, plugins: [...existing, pluginRef] }, () =>
      logger.info('Plugin added', { pluginRef }),
    );
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

    return this.commit({ ...this.pluginConfig, plugins: existing.filter((p) => p !== pluginRef) }, () =>
      logger.info('Plugin removed', { pluginRef }),
    );
  }

  // =========================================================================
  // Config persistence
  // =========================================================================

  /**
   * Apply an in-memory plugin-config mutation and persist it, as one unit.
   *
   * The four CRUD methods declare `CrudResult`, so a persistence failure has to
   * come back as `{success:false}` rather than as a throw — and the in-memory
   * config must not be left carrying a change that never reached disk. Both
   * halves live here rather than in four copies, so the rollback cannot drift
   * between the plugin and marketplace paths.
   *
   * Only {@link UnsafePathError} is converted. `config.json` is written through
   * the hardened atomic helper, which refuses a symlinked target or ancestor —
   * a real operator configuration (`~/.config` symlinked into a dotfiles repo)
   * and therefore a legitimate `CrudResult` failure. Anything else is a bug or
   * a disk fault and keeps propagating; a catch-all here would turn a
   * programmer error into a polite red message.
   */
  private commit(next: PluginConfig, onSuccess: () => void): CrudResult {
    const previous = this.pluginConfig;
    this.pluginConfig = next;
    try {
      this.saveConfig();
    } catch (err) {
      this.pluginConfig = previous;
      if (err instanceof UnsafePathError) {
        // Fixed text: the error names the refused path and, for a symlink,
        // points at its target. Neither belongs in a UI string.
        return { success: false, error: PERSIST_REFUSED_ERROR };
      }
      throw err;
    }
    onSuccess();
    return { success: true };
  }

  /**
   * Reload the full unified config from disk, update the plugin section,
   * and write back atomically. Preserves the mcpServers section.
   */
  private saveConfig(): void {
    if (!this.configFile) return;

    const full = loadConfig(this.configFile);
    const updated = { ...full, plugin: this.pluginConfig };
    saveConfig(this.configFile, updated);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Resolve a first-party bundled plugin to its local path without any
   * marketplace fetch.
   *
   * Bundled plugins (e.g. `zworkflow` = src/local) ship inside the soma-work
   * bundle and are listed in DEFAULT_PLUGINS for symmetry/discoverability, but
   * must never trigger a network download. Returns null for non-bundled refs.
   */
  private resolveBundled(ref: PluginRef): ResolvedPlugin | null {
    const bundledPath = this.bundledPlugins[ref.pluginName];
    if (!bundledPath) return null;
    return {
      name: `${ref.pluginName}@${ref.marketplaceName}`,
      localPath: bundledPath,
      source: 'default',
    };
  }

  /**
   * Configured refs that share a plugin name with another ref, by name. The plugin
   * directory, its cache meta and its backups are keyed by name only, so two refs of
   * one name rewrite each other's bytes under each other's identity — an ordinary ref
   * could serve an environment plugin's record-only content, or the reverse. Bundled
   * plugins never use that directory and are left out.
   */
  private nameCollisions(refs: readonly PluginRef[]): Map<string, PluginRef[]> {
    const byName = new Map<string, PluginRef[]>();
    for (const ref of refs) {
      if (this.bundledPlugins[ref.pluginName]) continue;
      const same = byName.get(ref.pluginName) ?? [];
      if (!same.some((r) => r.marketplaceName === ref.marketplaceName)) same.push(ref);
      byName.set(ref.pluginName, same);
    }
    return new Map([...byName].filter(([, same]) => same.length > 1));
  }

  private collisionMessage(pluginName: string, refs: readonly PluginRef[]): string {
    const names = refs.map((r) => `${r.pluginName}@${r.marketplaceName}`);
    const env = refs.filter((r) => this.isEnvPluginRef(r)).map((r) => `${r.pluginName}@${r.marketplaceName}`);
    return (
      `Plugin name collision: ${names.join(', ')} share the plugin directory "${pluginName}", so none of them is loaded` +
      `${env.length > 0 ? ` (${env.join(', ')} is an environment plugin)` : ''}. Rename one.`
    );
  }

  /**
   * Fail closed on a name collision (a config error): every ref of that name is
   * refused — not fetched, not resolved, so never admitted ({@link setResolved}) —
   * with one error per name. What an earlier run left under the name (directory and
   * cache meta) is removed, best effort: a failed removal is logged, and the
   * leftover is still not served, since PLUGINS_DIR readers serve admitted names
   * only. Backups stay; rollback refuses the name. Returns refused name → message.
   */
  private refuseNameCollisions(refs: readonly PluginRef[]): Map<string, string> {
    const collisions = this.nameCollisions(refs);
    const refused = new Map<string, string>();
    for (const [pluginName, colliding] of collisions) {
      refused.set(pluginName, this.collisionMessage(pluginName, colliding));
    }

    for (const [pluginName, colliding] of collisions) {
      logger.error(refused.get(pluginName) as string, {
        pluginName,
        refs: colliding.map((r) => `${r.pluginName}@${r.marketplaceName}`),
      });
      for (const target of [
        path.join(this.pluginsDir, pluginName),
        path.join(this.pluginsDir, '.cache', `${pluginName}.meta.json`),
      ]) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
        } catch (err) {
          logger.error('Could not remove a refused plugin name from disk; it is not served (not admitted)', {
            pluginName,
            path: target,
            error: (err as Error).message,
          });
        }
      }
    }
    return refused;
  }

  /**
   * End of every pass (initialize / refresh, forceRefresh, rollback, rebuildResolved):
   * the resolved list, and the PLUGINS_DIR names in it published as the admitted set
   * (`admitted-plugin-names`) — the only PLUGINS_DIR names that direct readers
   * (skill-locator, SkillForceHandler) serve. Bundled plugins and local overrides
   * resolve outside PLUGINS_DIR and are not in it.
   */
  private setResolved(results: readonly ResolvedPlugin[]): void {
    this.resolved = Object.freeze([...results]);
    this.initialized = true;
    setAdmittedPluginNames(
      this.resolved
        .filter((r) => path.dirname(path.resolve(r.localPath)) === this.pluginsDir)
        .map((r) => path.basename(r.localPath)),
    );
  }

  /**
   * Options for fetching one configured ref: the caller's (e.g. the admin Force
   * Update button's `skipSecurityGate`) plus the security mode, which is decided
   * here and nowhere else — `record` for a ref listed in `plugin.envPlugins`,
   * `block` for every other ref, overriding any mode the caller passed.
   */
  private fetchOptionsFor(ref: PluginRef, callerOptions?: FetchOptions): FetchOptions {
    return { ...callerOptions, securityMode: this.securityModeFor(ref) };
  }

  /** `record` for a ref listed in `plugin.envPlugins`, `block` for every other ref. */
  private securityModeFor(ref: PluginRef): SecurityMode {
    return this.isEnvPluginRef(ref) ? 'record' : 'block';
  }

  /**
   * Whether `ref` is an environment plugin: some `plugin.envPlugins` entry parses
   * (`parsePluginRef`) to the same plugin name AND marketplace. Name alone is not
   * enough — `acme-env@other` is not the deploy's `acme-env@acme-skills`.
   */
  private isEnvPluginRef(ref: PluginRef): boolean {
    return (this.pluginConfig.envPlugins || []).some((raw) => {
      const env = parsePluginRef(raw);
      return env !== null && env.pluginName === ref.pluginName && env.marketplaceName === ref.marketplaceName;
    });
  }

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
