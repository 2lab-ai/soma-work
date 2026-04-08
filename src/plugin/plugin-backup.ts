/**
 * BackupManager — Manages plugin backup and restore operations.
 *
 * Backup layout:
 *   {pluginsDir}/.backups/{pluginName}/{timestamp}/
 *     ├── plugin/          (copy of the plugin directory)
 *     ├── meta.json         (copy of .cache/{pluginName}.meta.json)
 *     └── backup-info.json  (BackupEntry metadata)
 *
 * Each backup is a complete snapshot of both the plugin files and cache meta,
 * so restoring a backup fully reverts the plugin to its previous state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';
import type { BackupEntry, CacheMeta } from './types';

const logger = new Logger('PluginBackup');

const BACKUPS_DIR = '.backups';
const BACKUP_INFO_FILE = 'backup-info.json';
const PLUGIN_SUBDIR = 'plugin';
const META_FILE = 'meta.json';

function backupsRoot(pluginsDir: string): string {
  return path.join(pluginsDir, BACKUPS_DIR);
}

function pluginBackupsDir(pluginsDir: string, pluginName: string): string {
  return path.join(backupsRoot(pluginsDir), pluginName);
}

function metaFilePath(pluginsDir: string, pluginName: string): string {
  return path.join(pluginsDir, '.cache', `${pluginName}.meta.json`);
}

/**
 * Create a backup of the current plugin installation.
 * Returns the BackupEntry on success, null on failure.
 */
export function backupPlugin(pluginsDir: string, pluginName: string): BackupEntry | null {
  const pluginDir = path.join(pluginsDir, pluginName);
  if (!fs.existsSync(pluginDir)) {
    logger.warn('Cannot backup: plugin directory does not exist', { pluginName });
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(pluginBackupsDir(pluginsDir, pluginName), timestamp);

  try {
    fs.mkdirSync(backupDir, { recursive: true });

    // Copy plugin directory
    const pluginBackupPath = path.join(backupDir, PLUGIN_SUBDIR);
    fs.cpSync(pluginDir, pluginBackupPath, { recursive: true });

    // Copy meta file if it exists
    const metaSrc = metaFilePath(pluginsDir, pluginName);
    let metaBackupPath: string | null = null;
    let sha = 'unknown';
    let marketplace = 'unknown';

    if (fs.existsSync(metaSrc)) {
      metaBackupPath = path.join(backupDir, META_FILE);
      fs.copyFileSync(metaSrc, metaBackupPath);

      // Read SHA and marketplace from meta
      try {
        const meta: CacheMeta = JSON.parse(fs.readFileSync(metaSrc, 'utf-8'));
        sha = meta.sha || 'unknown';
        marketplace = meta.marketplace || 'unknown';
      } catch {
        /* ignore parse errors */
      }
    }

    const entry: BackupEntry = {
      pluginName,
      marketplace,
      timestamp,
      sha,
      pluginDirBackup: pluginBackupPath,
      metaFileBackup: metaBackupPath,
    };

    // Write backup-info.json for later enumeration
    fs.writeFileSync(path.join(backupDir, BACKUP_INFO_FILE), JSON.stringify(entry, null, 2));

    logger.info('Plugin backed up', { pluginName, timestamp, sha: sha.slice(0, 8) });
    return entry;
  } catch (error) {
    logger.error('Failed to backup plugin', { pluginName, error: (error as Error).message });
    // Cleanup partial backup
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Restore a plugin from its most recent backup (or a specific timestamp).
 * Returns the restored BackupEntry on success, null on failure.
 */
export function restorePlugin(pluginsDir: string, pluginName: string, timestamp?: string): BackupEntry | null {
  const backups = listBackups(pluginsDir, pluginName);
  if (backups.length === 0) {
    logger.warn('No backups available for restore', { pluginName });
    return null;
  }

  // Find the target backup
  let target: BackupEntry | undefined;
  if (timestamp) {
    target = backups.find((b) => b.timestamp === timestamp);
    if (!target) {
      logger.warn('Backup with specified timestamp not found', { pluginName, timestamp });
      return null;
    }
  } else {
    // Latest backup
    target = backups[0];
  }

  const pluginDir = path.join(pluginsDir, pluginName);

  try {
    // Remove current installation
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }

    // Restore plugin directory
    fs.cpSync(target.pluginDirBackup, pluginDir, { recursive: true });

    // Restore meta file
    if (target.metaFileBackup && fs.existsSync(target.metaFileBackup)) {
      const metaDst = metaFilePath(pluginsDir, pluginName);
      const cacheDir = path.dirname(metaDst);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.copyFileSync(target.metaFileBackup, metaDst);
    }

    logger.info('Plugin restored from backup', {
      pluginName,
      timestamp: target.timestamp,
      sha: target.sha.slice(0, 8),
    });
    return target;
  } catch (error) {
    logger.error('Failed to restore plugin', { pluginName, error: (error as Error).message });
    return null;
  }
}

/**
 * List all available backups for a plugin, sorted newest-first.
 */
export function listBackups(pluginsDir: string, pluginName: string): BackupEntry[] {
  const dir = pluginBackupsDir(pluginsDir, pluginName);
  if (!fs.existsSync(dir)) return [];

  const entries: BackupEntry[] = [];
  try {
    const timestamps = fs.readdirSync(dir).filter((name) => {
      const fullPath = path.join(dir, name);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const ts of timestamps) {
      const infoPath = path.join(dir, ts, BACKUP_INFO_FILE);
      if (!fs.existsSync(infoPath)) continue;
      try {
        const entry: BackupEntry = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
        entries.push(entry);
      } catch {
        logger.warn('Skipping corrupt backup-info.json', { pluginName, timestamp: ts });
      }
    }
  } catch (error) {
    logger.warn('Failed to list backups', { pluginName, error: (error as Error).message });
  }

  // Sort newest first
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Remove old backups, keeping the most recent `keep` entries.
 */
export function pruneBackups(pluginsDir: string, pluginName: string, keep: number): number {
  const backups = listBackups(pluginsDir, pluginName);
  if (backups.length <= keep) return 0;

  const toRemove = backups.slice(keep);
  let removed = 0;

  for (const entry of toRemove) {
    // Derive the backup directory from pluginDirBackup (parent of "plugin" subdir)
    const backupDir = path.dirname(entry.pluginDirBackup);
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
      removed++;
    } catch (error) {
      logger.warn('Failed to prune backup', {
        pluginName,
        timestamp: entry.timestamp,
        error: (error as Error).message,
      });
    }
  }

  if (removed > 0) {
    logger.info('Pruned old backups', { pluginName, removed, remaining: keep });
  }
  return removed;
}
