/**
 * Downloads plugin contents from a GitHub marketplace repository
 * using the tarball API, extracts only the relevant plugin path.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MarketplaceEntry, MarketplaceManifest, MarketplacePluginEntry,
  CacheMeta,
  OfficialMarketplaceManifest, OfficialPluginSource,
} from './types';
import { readCacheMeta, writeCacheMeta, hasCachedPlugin } from './plugin-cache';
import { Logger } from '../logger';

const logger = new Logger('MarketplaceFetcher');

export interface FetchResult {
  /** Absolute path to the extracted plugin directory */
  pluginPath: string;
  /** Commit SHA */
  sha: string;
  /** Whether the result came from cache */
  cached: boolean;
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
    const result = execFileSync(
      'gh',
      ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }
    ).trim();
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
    const data = execFileSync(
      'gh',
      ['api', `repos/${repo}/tarball/${ref}`],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 100 * 1024 * 1024 }
    );
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
        return raw as MarketplaceManifest;
      }
    } catch (error) {
      logger.error('Failed to parse marketplace.json', { error: (error as Error).message });
    }
  }

  // Try official format: .claude-plugin/marketplace.json
  const officialPath = path.join(extractedRoot, '.claude-plugin', 'marketplace.json');
  if (fs.existsSync(officialPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(officialPath, 'utf-8')) as OfficialMarketplaceManifest;
      return normaliseOfficialManifest(raw);
    } catch (error) {
      logger.error('Failed to parse .claude-plugin/marketplace.json', { error: (error as Error).message });
    }
  }

  logger.warn('No marketplace manifest found', { extractedRoot });
  return null;
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
function normaliseOfficialManifest(official: OfficialMarketplaceManifest): MarketplaceManifest {
  const plugins: Record<string, MarketplacePluginEntry> = {};

  for (const entry of official.plugins) {
    const normalised = normalisePluginSource(entry.source);
    if (normalised) {
      plugins[entry.name] = {
        ...normalised,
        description: entry.description,
      };
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
function normalisePluginSource(source: OfficialPluginSource): Omit<MarketplacePluginEntry, 'description'> | null {
  if (typeof source === 'string') {
    // Local path: "./plugins/stv" → "plugins/stv"
    const cleaned = source.replace(/^\.\//, '');
    return { path: cleaned };
  }

  if (source.source === 'url') {
    // External git URL — needs separate clone/fetch
    return { path: '__external__', externalUrl: source.url, externalSha: source.sha };
  }

  if (source.source === 'git-subdir') {
    return {
      path: '__external__',
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
  pluginName: string
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
    try { fs.rmSync(tmpTarget, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

function cleanupTmpDir(tmpDir: string): void {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
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
  pluginsDir: string
): Promise<FetchResult | null> {
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
    return null;
  }

  try {
    // Read marketplace.json from tarball
    const manifest = readManifest(extractedRoot);
    if (!manifest) {
      logger.error('No valid marketplace.json in repo', { repo: marketplace.repo });
      return null;
    }

    const pluginEntry = manifest.plugins[pluginName];
    if (!pluginEntry) {
      logger.error('Plugin not found in marketplace.json', {
        pluginName,
        available: Object.keys(manifest.plugins),
      });
      return null;
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
      );
      if (externalResult) return externalResult;

      // Fall back to stale cache if external fetch fails
      if (hasCachedPlugin(pluginsDir, pluginName)) {
        logger.warn('External fetch failed, using stale cache', { pluginName });
        return cachedResult(pluginsDir, pluginName, cached?.sha || 'unknown');
      }
      return null;
    }

    // Install plugin from marketplace tarball
    const installedPath = installPlugin(extractedRoot, pluginEntry.path, pluginsDir, pluginName);
    if (!installedPath) return null;

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
function gitUrlToRepo(url: string): string | null {
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
): Promise<FetchResult | null> {
  const repo = gitUrlToRepo(externalUrl);
  if (!repo) {
    logger.error('Cannot parse external URL as GitHub repo', { externalUrl, pluginName });
    return null;
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
  if (!extractedRoot) return null;

  try {
    fs.mkdirSync(pluginsDir, { recursive: true });

    // Reuse installPlugin for atomic copy-and-swap (includes tmp cleanup on error)
    const installedPath = installPlugin(extractedRoot, subdir || '.', pluginsDir, pluginName);
    if (!installedPath) return null;

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
