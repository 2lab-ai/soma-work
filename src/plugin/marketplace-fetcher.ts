/**
 * Downloads plugin contents from a GitHub marketplace repository
 * using the tarball API, extracts only the relevant plugin path.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../logger';
import { hasCachedPlugin, readCacheMeta, writeCacheMeta } from './plugin-cache';
import { formatScanReport, type ScanResult, scanPluginDirectory } from './security-scanner';
import {
  type CacheMeta,
  EXTERNAL_PLUGIN_PATH,
  type FetchFailure,
  type FetchFailureCode,
  type MarketplaceEntry,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type OfficialMarketplaceManifest,
  type OfficialPluginSource,
} from './types';

const logger = new Logger('MarketplaceFetcher');

/**
 * Run security scan on an installed plugin and enforce the gate policy.
 * Returns the ScanResult if the plugin is blocked, null if it passed.
 * When blocked, removes the installed plugin directory.
 */
function enforceSecurityGate(installedPath: string, pluginName: string): ScanResult | null {
  const scanResult = scanPluginDirectory(installedPath, pluginName);
  if (scanResult.blocked) {
    logger.error('Plugin BLOCKED by security scan', {
      pluginName,
      riskLevel: scanResult.riskLevel,
      findings: scanResult.findings.length,
    });
    logger.warn(formatScanReport(scanResult));
    try {
      fs.rmSync(installedPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return scanResult;
  }
  if (scanResult.findings.length > 0) {
    logger.warn(formatScanReport(scanResult));
  }
  return null;
}

export interface FetchResult {
  /** Absolute path to the extracted plugin directory */
  pluginPath: string;
  /** Commit SHA */
  sha: string;
  /** Whether the result came from cache */
  cached: boolean;
}

export interface FetchOptions {
  /** Skip security gate check (for force update) */
  skipSecurityGate?: boolean;
}

function failure(
  code: FetchFailureCode,
  message: string,
  extra?: Partial<Omit<FetchFailure, 'failed' | 'code' | 'message'>>,
): FetchFailure {
  return { failed: true, code, message, ...extra };
}

export function isFetchFailure(result: FetchResult | FetchFailure): result is FetchFailure {
  return 'failed' in result && result.failed === true;
}

/** Build a cached FetchResult for a given plugin. */
function cachedResult(pluginsDir: string, pluginName: string, sha: string): FetchResult {
  return { pluginPath: path.join(pluginsDir, pluginName), sha, cached: true };
}

/**
 * Resolve the HEAD SHA for a given repo/ref using `gh api`.
 * Returns null on failure.
 */
export function resolveRemoteSha(repo: string, ref: string): string | null {
  try {
    const result = execFileSync('gh', ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    }).trim();
    return result || null;
  } catch (error) {
    logger.warn('Failed to resolve remote SHA', { repo, ref, error: (error as Error).message });
    return null;
  }
}

/**
 * Download tarball from GitHub to a file using `gh api`.
 */
function downloadTarballFile(repo: string, ref: string, outPath: string): boolean {
  try {
    const data = execFileSync('gh', ['api', `repos/${repo}/tarball/${ref}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 100 * 1024 * 1024,
    });
    fs.writeFileSync(outPath, data);
    return true;
  } catch (error) {
    logger.error('Failed to download tarball', { repo, ref, error: (error as Error).message });
    return false;
  }
}

/**
 * Download and extract a tarball from GitHub, returning the extracted repo root.
 */
function downloadAndExtract(repo: string, ref: string): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-plugin-'));
  const tarPath = path.join(tmpDir, 'archive.tar.gz');

  try {
    if (!downloadTarballFile(repo, ref, tarPath)) {
      cleanupTmpDir(tmpDir);
      return null;
    }

    // Extract tarball
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['xzf', tarPath, '-C', extractDir, '--no-same-owner'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });

    // GitHub tarballs have a single top-level directory like "owner-repo-sha/"
    const entries = fs.readdirSync(extractDir);
    if (entries.length !== 1) {
      logger.warn('Unexpected tarball structure', { entries });
      cleanupTmpDir(tmpDir);
      return null;
    }

    return path.join(extractDir, entries[0]);
  } catch (error) {
    logger.error('Failed to extract tarball', { repo, ref, error: (error as Error).message });
    cleanupTmpDir(tmpDir);
    return null;
  }
}

/**
 * Read marketplace manifest from an extracted tarball root.
 *
 * Search order:
 * 1. `marketplace.json` (root) — soma-work internal format (Record-based)
 * 2. `.claude-plugin/marketplace.json` — official format (Array-based)
 *
 * If the official format is found, it is normalised to the internal format.
 */
function readManifest(extractedRoot: string): MarketplaceManifest | null {
  // Try soma-work internal format first
  const internalPath = path.join(extractedRoot, 'marketplace.json');
  if (fs.existsSync(internalPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(internalPath, 'utf-8'));
      // Distinguish: internal format has plugins as Record, official has plugins as Array
      if (raw.plugins && !Array.isArray(raw.plugins)) {
        // Minimal shape check: name must be a string
        if (typeof raw.name !== 'string') {
          logger.warn('Internal marketplace.json missing required "name" field', { path: internalPath });
          return null;
        }
        return raw as MarketplaceManifest;
      }
      // Array-based plugins at root — likely official format misplaced
      logger.debug('Root marketplace.json has array-based plugins, trying official format', { path: internalPath });
    } catch (error) {
      logger.error('Failed to parse marketplace.json', { error: (error as Error).message });
    }
  }

  // Try official format: .claude-plugin/marketplace.json
  const officialPath = path.join(extractedRoot, '.claude-plugin', 'marketplace.json');
  if (fs.existsSync(officialPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(officialPath, 'utf-8'));
      const validated = validateOfficialManifest(raw);
      if (!validated) {
        logger.error('Official manifest failed shape validation', { path: officialPath });
        return null;
      }
      return normaliseOfficialManifest(validated);
    } catch (error) {
      logger.error('Failed to parse .claude-plugin/marketplace.json', { error: (error as Error).message });
    }
  }

  logger.warn('No marketplace manifest found', { extractedRoot });
  return null;
}

/**
 * Validate that a parsed JSON object has the expected shape for an official marketplace manifest.
 * Returns a cleaned manifest with only valid plugin entries, or null if the top-level shape is wrong.
 */
export function validateOfficialManifest(raw: unknown): OfficialMarketplaceManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string') {
    logger.warn('Official manifest missing required "name" field');
    return null;
  }
  if (!Array.isArray(obj.plugins)) {
    logger.warn('Official manifest missing or invalid "plugins" array', { name: obj.name });
    return null;
  }

  const validPlugins = (obj.plugins as unknown[]).filter((p): p is OfficialMarketplaceManifest['plugins'][number] => {
    if (!p || typeof p !== 'object') return false;
    const entry = p as Record<string, unknown>;
    if (typeof entry.name !== 'string' || entry.source === undefined) return false;
    // Validate source shape — string is always valid; objects need discriminant checks
    const src = entry.source;
    if (typeof src !== 'string') {
      if (!src || typeof src !== 'object') return false;
      const srcObj = src as Record<string, unknown>;
      if (srcObj.source === 'url' && typeof srcObj.url !== 'string') return false;
      if (srcObj.source === 'git-subdir' && (typeof srcObj.url !== 'string' || typeof srcObj.path !== 'string'))
        return false;
    }
    return true;
  });

  if (validPlugins.length < (obj.plugins as unknown[]).length) {
    logger.warn('Some official manifest entries skipped (missing name or source)', {
      marketplace: obj.name,
      total: (obj.plugins as unknown[]).length,
      valid: validPlugins.length,
    });
  }

  return {
    name: obj.name as string,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    owner: obj.owner as OfficialMarketplaceManifest['owner'],
    metadata: obj.metadata as OfficialMarketplaceManifest['metadata'],
    plugins: validPlugins,
  };
}

/**
 * Normalise the official marketplace format (array of plugins with source field)
 * to the internal Record-based format used by fetchPlugin.
 *
 * Source mapping:
 * - string (local path, e.g. "./plugins/stv")     → { path: "plugins/stv" }
 * - { source: "url", url: "..." }                 → { path: "__external__", externalUrl: url }
 * - { source: "git-subdir", url, path, ref, sha } → { path: "__external__", externalUrl: url, externalSubdir: subpath }
 */
export function normaliseOfficialManifest(official: OfficialMarketplaceManifest): MarketplaceManifest {
  const plugins: Record<string, MarketplacePluginEntry> = {};

  for (const entry of official.plugins) {
    const normalised = normalisePluginSource(entry.source);
    if (normalised) {
      plugins[entry.name] = {
        ...normalised,
        description: entry.description,
      };
    } else {
      logger.warn('Skipping plugin with unsupported source type', {
        pluginName: entry.name,
        marketplace: official.name,
      });
    }
  }

  return {
    name: official.name,
    version: official.metadata?.version,
    plugins,
  };
}

/**
 * Convert an official plugin source to the internal MarketplacePluginEntry format.
 */
export function normalisePluginSource(
  source: OfficialPluginSource,
): Omit<MarketplacePluginEntry, 'description'> | null {
  if (typeof source === 'string') {
    // Local path: "./plugins/stv" → "plugins/stv"
    const cleaned = source.replace(/^\.\//, '');
    return { path: cleaned };
  }

  if (source.source === 'url') {
    // External git URL — needs separate clone/fetch
    return { path: EXTERNAL_PLUGIN_PATH, externalUrl: source.url, externalSha: source.sha };
  }

  if (source.source === 'git-subdir') {
    return {
      path: EXTERNAL_PLUGIN_PATH,
      externalUrl: source.url,
      externalSubdir: source.path,
      externalRef: source.ref,
      externalSha: source.sha,
    };
  }

  logger.warn('Unknown official plugin source type', { source });
  return null;
}

/**
 * Copy plugin files from extracted tarball to the plugins directory.
 * Uses atomic replace: write to temp, then rename.
 */
function installPlugin(
  extractedRoot: string,
  pluginPath: string,
  pluginsDir: string,
  pluginName: string,
): string | null {
  const sourcePath = path.join(extractedRoot, pluginPath);
  if (!fs.existsSync(sourcePath)) {
    logger.error('Plugin path not found in tarball', { pluginPath, extractedRoot });
    return null;
  }

  const targetPath = path.join(pluginsDir, pluginName);
  const tmpTarget = `${targetPath}.tmp.${Date.now()}`;

  try {
    // Copy to temp location
    fs.cpSync(sourcePath, tmpTarget, { recursive: true });

    // Atomic swap: remove old, rename new
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    fs.renameSync(tmpTarget, targetPath);

    return targetPath;
  } catch (error) {
    logger.error('Failed to install plugin', { pluginName, error: (error as Error).message });
    try {
      fs.rmSync(tmpTarget, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
}

function cleanupTmpDir(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Fetch a plugin from a marketplace repository.
 *
 * Flow:
 * 1. Check cache (SHA comparison)
 * 2. Download tarball if needed
 * 3. Read marketplace.json to find plugin path
 * 4. Extract only the plugin directory
 * 5. Update cache metadata
 */
export async function fetchPlugin(
  marketplace: MarketplaceEntry,
  pluginName: string,
  pluginsDir: string,
  options?: FetchOptions,
): Promise<FetchResult | FetchFailure> {
  const ref = marketplace.ref || 'main';
  const cached = readCacheMeta(pluginsDir, pluginName);

  // Check if cache is current
  const remoteSha = resolveRemoteSha(marketplace.repo, ref);
  if (remoteSha && cached?.sha === remoteSha && hasCachedPlugin(pluginsDir, pluginName)) {
    logger.info('Plugin cache is current', { pluginName, sha: remoteSha.slice(0, 8) });
    return cachedResult(pluginsDir, pluginName, remoteSha);
  }

  // Network failure but we have cache — use stale cache
  if (!remoteSha && hasCachedPlugin(pluginsDir, pluginName)) {
    logger.warn('Cannot reach remote, using stale cache', {
      pluginName,
      cachedSha: cached?.sha?.slice(0, 8),
    });
    return cachedResult(pluginsDir, pluginName, cached?.sha || 'unknown');
  }

  // Need to download
  logger.info('Downloading plugin from marketplace', {
    pluginName,
    repo: marketplace.repo,
    ref,
    remoteSha: remoteSha?.slice(0, 8),
  });

  const extractedRoot = downloadAndExtract(marketplace.repo, ref);
  if (!extractedRoot) {
    if (hasCachedPlugin(pluginsDir, pluginName)) {
      logger.warn('Download failed, falling back to stale cache', { pluginName });
      return cachedResult(pluginsDir, pluginName, cached?.sha || 'unknown');
    }
    return failure('DOWNLOAD_FAILED', 'Failed to download marketplace tarball and no cache available');
  }

  try {
    // Read marketplace.json from tarball
    const manifest = readManifest(extractedRoot);
    if (!manifest) {
      logger.error('No valid marketplace.json in repo', { repo: marketplace.repo });
      return failure('MANIFEST_NOT_FOUND', 'No valid marketplace.json found in repository');
    }

    const pluginEntry = manifest.plugins[pluginName];
    if (!pluginEntry) {
      logger.error('Plugin not found in marketplace.json', {
        pluginName,
        available: Object.keys(manifest.plugins),
      });
      return failure(
        'PLUGIN_NOT_IN_MANIFEST',
        `Plugin "${pluginName}" not found in marketplace.json. Available: ${Object.keys(manifest.plugins).join(', ')}`,
      );
    }

    // Ensure plugins dir exists
    fs.mkdirSync(pluginsDir, { recursive: true });

    // Handle external URL sources (plugin lives in a separate repo)
    if (pluginEntry.externalUrl) {
      const externalResult = await fetchExternalPlugin(
        pluginEntry.externalUrl,
        pluginName,
        pluginsDir,
        pluginEntry.externalSubdir,
        pluginEntry.externalRef,
        pluginEntry.externalSha,
        options,
      );
      if (isFetchFailure(externalResult)) {
        // Fall back to stale cache if external fetch fails
        if (hasCachedPlugin(pluginsDir, pluginName)) {
          logger.warn('External fetch failed, using stale cache', { pluginName });
          return cachedResult(pluginsDir, pluginName, cached?.sha || 'unknown');
        }
        return externalResult;
      }
      return externalResult;
    }

    // Install plugin from marketplace tarball
    const installedPath = installPlugin(extractedRoot, pluginEntry.path, pluginsDir, pluginName);
    if (!installedPath) return failure('INSTALL_FAILED', 'Failed to install plugin files');

    // Security gate — block CRITICAL risk plugins
    if (!options?.skipSecurityGate) {
      const securityBlock = enforceSecurityGate(installedPath, pluginName);
      if (securityBlock) {
        return failure('SECURITY_BLOCKED', `Plugin blocked by security scan: ${securityBlock.riskLevel} risk`, {
          riskLevel: securityBlock.riskLevel,
          securityFindings: securityBlock.findings.map((f) => ({
            rule: f.rule,
            description: f.description,
            severity: f.severity,
            file: f.file,
          })),
        });
      }
    }

    // Write cache metadata
    const sha = remoteSha || 'unknown';
    const meta: CacheMeta = {
      sha,
      fetchedAt: new Date().toISOString(),
      marketplace: marketplace.name,
      ref,
    };
    writeCacheMeta(pluginsDir, pluginName, meta);

    logger.info('Plugin installed successfully', {
      pluginName,
      sha: sha.slice(0, 8),
      path: installedPath,
    });

    return { pluginPath: installedPath, sha, cached: false };
  } finally {
    // Cleanup extracted tarball
    cleanupTmpDir(path.dirname(extractedRoot));
  }
}

// ---------------------------------------------------------------------------
// External plugin fetch (plugin source is a separate git repo)
// ---------------------------------------------------------------------------

/**
 * Convert a git URL to a GitHub owner/repo string.
 * Handles: "https://github.com/owner/repo.git", "owner/repo", etc.
 */
export function gitUrlToRepo(url: string): string | null {
  // Already owner/repo format
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(url)) {
    return url;
  }
  // GitHub URL
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return null;
}

/**
 * Fetch a plugin that lives in its own external git repo (not inside the marketplace repo).
 * Used when the official marketplace lists a plugin with source.source === "url" or "git-subdir".
 */
async function fetchExternalPlugin(
  externalUrl: string,
  pluginName: string,
  pluginsDir: string,
  subdir?: string,
  ref?: string,
  pinnedSha?: string,
  options?: FetchOptions,
): Promise<FetchResult | FetchFailure> {
  const repo = gitUrlToRepo(externalUrl);
  if (!repo) {
    logger.error('Cannot parse external URL as GitHub repo', { externalUrl, pluginName });
    return failure('EXTERNAL_URL_INVALID', `Cannot parse "${externalUrl}" as a GitHub repository URL`);
  }

  // Pinned SHA takes precedence over ref for deterministic installs
  const gitRef = pinnedSha || ref || 'main';
  const cached = readCacheMeta(pluginsDir, pluginName);

  // SHA check for caching — when pinned, compare directly against pinned SHA
  const remoteSha = pinnedSha || resolveRemoteSha(repo, gitRef);
  if (remoteSha && cached?.sha === remoteSha && hasCachedPlugin(pluginsDir, pluginName)) {
    logger.info('External plugin cache is current', { pluginName, sha: remoteSha.slice(0, 8) });
    return cachedResult(pluginsDir, pluginName, remoteSha);
  }

  if (!remoteSha && hasCachedPlugin(pluginsDir, pluginName)) {
    logger.warn('Cannot reach external repo, using stale cache', { pluginName, repo });
    return cachedResult(pluginsDir, pluginName, cached?.sha || 'unknown');
  }

  logger.info('Downloading external plugin', { pluginName, repo, ref: gitRef, subdir });

  const extractedRoot = downloadAndExtract(repo, gitRef);
  if (!extractedRoot) {
    logger.error('Failed to download external plugin', { pluginName, repo, ref: gitRef });
    if (hasCachedPlugin(pluginsDir, pluginName)) {
      logger.warn('External download failed, falling back to stale cache', { pluginName });
      return cachedResult(pluginsDir, pluginName, cached?.sha || 'unknown');
    }
    return failure('EXTERNAL_FETCH_FAILED', `Failed to download external plugin from ${repo} (ref: ${gitRef})`);
  }

  try {
    fs.mkdirSync(pluginsDir, { recursive: true });

    // Reuse installPlugin for atomic copy-and-swap (includes tmp cleanup on error)
    const installedPath = installPlugin(extractedRoot, subdir || '.', pluginsDir, pluginName);
    if (!installedPath) return failure('INSTALL_FAILED', 'Failed to install external plugin files');

    // Security gate — block CRITICAL risk external plugins
    if (!options?.skipSecurityGate) {
      const securityBlock = enforceSecurityGate(installedPath, pluginName);
      if (securityBlock) {
        return failure(
          'SECURITY_BLOCKED',
          `External plugin blocked by security scan: ${securityBlock.riskLevel} risk`,
          {
            riskLevel: securityBlock.riskLevel,
            securityFindings: securityBlock.findings.map((f) => ({
              rule: f.rule,
              description: f.description,
              severity: f.severity,
              file: f.file,
            })),
          },
        );
      }
    }

    const sha = remoteSha || 'unknown';
    writeCacheMeta(pluginsDir, pluginName, {
      sha,
      fetchedAt: new Date().toISOString(),
      marketplace: `external:${repo}`,
      ref: gitRef,
    });

    logger.info('External plugin installed', { pluginName, sha: sha.slice(0, 8), path: installedPath });
    return { pluginPath: installedPath, sha, cached: false };
  } finally {
    cleanupTmpDir(path.dirname(extractedRoot));
  }
}
