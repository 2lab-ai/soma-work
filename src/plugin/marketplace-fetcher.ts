/**
 * Downloads plugin contents from a GitHub marketplace repository
 * using the tarball API, extracts only the relevant plugin path.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MarketplaceEntry, MarketplaceManifest, CacheMeta } from './types';
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
 * Read marketplace.json from an extracted tarball root.
 */
function readManifest(extractedRoot: string): MarketplaceManifest | null {
  const manifestPath = path.join(extractedRoot, 'marketplace.json');
  try {
    if (!fs.existsSync(manifestPath)) {
      logger.warn('marketplace.json not found in repo', { path: manifestPath });
      return null;
    }
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as MarketplaceManifest;
  } catch (error) {
    logger.error('Failed to parse marketplace.json', { error: (error as Error).message });
    return null;
  }
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
    return {
      pluginPath: path.join(pluginsDir, pluginName),
      sha: remoteSha,
      cached: true,
    };
  }

  // Network failure but we have cache — use stale cache
  if (!remoteSha && hasCachedPlugin(pluginsDir, pluginName)) {
    logger.warn('Cannot reach remote, using stale cache', {
      pluginName,
      cachedSha: cached?.sha?.slice(0, 8),
    });
    return {
      pluginPath: path.join(pluginsDir, pluginName),
      sha: cached?.sha || 'unknown',
      cached: true,
    };
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
      return {
        pluginPath: path.join(pluginsDir, pluginName),
        sha: cached?.sha || 'unknown',
        cached: true,
      };
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

    // Install plugin
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
