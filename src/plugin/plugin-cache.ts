/**
 * Manages the ./plugins/.cache/ directory for tracking
 * download metadata (SHA, ETag, timestamps).
 */

import * as fs from 'fs';
import * as path from 'path';
import { CacheMeta } from './types';
import { Logger } from '../logger';

const CACHE_DIR = '.cache';

const logger = new Logger('PluginCache');

function cacheDir(pluginsDir: string): string {
  return path.join(pluginsDir, CACHE_DIR);
}

function metaPath(pluginsDir: string, pluginName: string): string {
  return path.join(cacheDir(pluginsDir), `${pluginName}.meta.json`);
}

/** Read cache metadata for a plugin. Returns null if missing/invalid. */
export function readCacheMeta(pluginsDir: string, pluginName: string): CacheMeta | null {
  try {
    const filePath = metaPath(pluginsDir, pluginName);
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!raw.sha || !raw.fetchedAt || !raw.marketplace || !raw.ref) return null;
    return raw as CacheMeta;
  } catch (error) {
    logger.warn('Failed to read cache meta', { pluginName, error });
    return null;
  }
}

/** Write cache metadata for a plugin. Creates the .cache/ dir if needed. */
export function writeCacheMeta(pluginsDir: string, pluginName: string, meta: CacheMeta): void {
  const dir = cacheDir(pluginsDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath(pluginsDir, pluginName), JSON.stringify(meta, null, 2));
}

/** Check whether a cached plugin directory exists and has content. */
export function hasCachedPlugin(pluginsDir: string, pluginName: string): boolean {
  const pluginDir = path.join(pluginsDir, pluginName);
  try {
    return fs.existsSync(pluginDir) && fs.readdirSync(pluginDir).length > 0;
  } catch {
    return false;
  }
}

/** Remove a cached plugin directory entirely. */
export function removeCachedPlugin(pluginsDir: string, pluginName: string): void {
  const pluginDir = path.join(pluginsDir, pluginName);
  try {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Failed to remove cached plugin', { pluginName, error });
  }
}
