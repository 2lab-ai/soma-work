import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupPlugin, listBackups, pruneBackups, restorePlugin } from '../plugin-backup';
import type { CacheMeta } from '../types';

describe('PluginBackup', () => {
  let pluginsDir: string;
  const pluginName = 'test-plugin';

  beforeEach(() => {
    pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));

    // Create a plugin directory with content
    const pluginDir = path.join(pluginsDir, pluginName);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = {}');
    fs.writeFileSync(path.join(pluginDir, 'package.json'), '{"name":"test"}');

    // Create cache meta
    const cacheDir = path.join(pluginsDir, '.cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const meta: CacheMeta = {
      sha: 'abc123def456',
      fetchedAt: '2026-04-01T00:00:00Z',
      marketplace: 'test-market',
      ref: 'main',
    };
    fs.writeFileSync(path.join(cacheDir, `${pluginName}.meta.json`), JSON.stringify(meta));
  });

  afterEach(() => {
    try {
      fs.rmSync(pluginsDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // -------------------------------------------------------------------------
  // backupPlugin
  // -------------------------------------------------------------------------
  describe('backupPlugin', () => {
    it('creates backup with plugin dir and meta file', () => {
      const entry = backupPlugin(pluginsDir, pluginName);
      expect(entry).not.toBeNull();
      expect(entry!.pluginName).toBe(pluginName);
      expect(entry!.sha).toBe('abc123def456');
      expect(entry!.marketplace).toBe('test-market');
      expect(fs.existsSync(entry!.pluginDirBackup)).toBe(true);
      expect(entry!.metaFileBackup).not.toBeNull();
      expect(fs.existsSync(entry!.metaFileBackup!)).toBe(true);

      // Verify backup contains correct files
      expect(fs.existsSync(path.join(entry!.pluginDirBackup, 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(entry!.pluginDirBackup, 'package.json'))).toBe(true);
    });

    it('returns null when plugin dir does not exist', () => {
      const entry = backupPlugin(pluginsDir, 'nonexistent');
      expect(entry).toBeNull();
    });

    it('handles missing meta file gracefully', () => {
      // Remove meta file
      fs.unlinkSync(path.join(pluginsDir, '.cache', `${pluginName}.meta.json`));

      const entry = backupPlugin(pluginsDir, pluginName);
      expect(entry).not.toBeNull();
      expect(entry!.sha).toBe('unknown');
      expect(entry!.metaFileBackup).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // restorePlugin
  // -------------------------------------------------------------------------
  describe('restorePlugin', () => {
    it('restores plugin from latest backup', () => {
      const backup = backupPlugin(pluginsDir, pluginName);
      expect(backup).not.toBeNull();

      // Simulate update: modify the plugin
      const pluginDir = path.join(pluginsDir, pluginName);
      fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = { v2: true }');

      // Restore
      const restored = restorePlugin(pluginsDir, pluginName);
      expect(restored).not.toBeNull();
      expect(restored!.sha).toBe('abc123def456');

      // Verify original content restored
      const content = fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf-8');
      expect(content).toBe('module.exports = {}');
    });

    it('restores specific backup by timestamp', () => {
      const backup = backupPlugin(pluginsDir, pluginName);
      expect(backup).not.toBeNull();

      const restored = restorePlugin(pluginsDir, pluginName, backup!.timestamp);
      expect(restored).not.toBeNull();
      expect(restored!.timestamp).toBe(backup!.timestamp);
    });

    it('returns null when no backups exist', () => {
      const restored = restorePlugin(pluginsDir, 'no-backups');
      expect(restored).toBeNull();
    });

    it('returns null for invalid timestamp', () => {
      backupPlugin(pluginsDir, pluginName);
      const restored = restorePlugin(pluginsDir, pluginName, 'invalid-timestamp');
      expect(restored).toBeNull();
    });

    it('restores meta file along with plugin dir', () => {
      const backup = backupPlugin(pluginsDir, pluginName);

      // Overwrite meta
      const metaPath = path.join(pluginsDir, '.cache', `${pluginName}.meta.json`);
      fs.writeFileSync(metaPath, JSON.stringify({ sha: 'new-sha', fetchedAt: 'now', marketplace: 'x', ref: 'y' }));

      restorePlugin(pluginsDir, pluginName, backup!.timestamp);

      // Verify meta restored
      const restoredMeta: CacheMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      expect(restoredMeta.sha).toBe('abc123def456');
    });
  });

  // -------------------------------------------------------------------------
  // listBackups
  // -------------------------------------------------------------------------
  describe('listBackups', () => {
    it('returns empty array when no backups exist', () => {
      expect(listBackups(pluginsDir, 'nonexistent')).toEqual([]);
    });

    it('returns backups sorted newest first', async () => {
      // Create two backups with slight delay
      const first = backupPlugin(pluginsDir, pluginName);
      // Ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));

      // Modify plugin slightly to make a different version
      fs.writeFileSync(path.join(pluginsDir, pluginName, 'v2.js'), 'v2');
      const second = backupPlugin(pluginsDir, pluginName);

      const backups = listBackups(pluginsDir, pluginName);
      expect(backups).toHaveLength(2);
      // Newest first
      expect(backups[0].timestamp).toBe(second!.timestamp);
      expect(backups[1].timestamp).toBe(first!.timestamp);
    });
  });

  // -------------------------------------------------------------------------
  // pruneBackups
  // -------------------------------------------------------------------------
  describe('pruneBackups', () => {
    it('removes old backups beyond keep limit', async () => {
      backupPlugin(pluginsDir, pluginName);
      await new Promise((r) => setTimeout(r, 10));
      backupPlugin(pluginsDir, pluginName);
      await new Promise((r) => setTimeout(r, 10));
      backupPlugin(pluginsDir, pluginName);
      await new Promise((r) => setTimeout(r, 10));
      backupPlugin(pluginsDir, pluginName);

      expect(listBackups(pluginsDir, pluginName)).toHaveLength(4);

      const removed = pruneBackups(pluginsDir, pluginName, 2);
      expect(removed).toBe(2);
      expect(listBackups(pluginsDir, pluginName)).toHaveLength(2);
    });

    it('does nothing when under limit', () => {
      backupPlugin(pluginsDir, pluginName);
      const removed = pruneBackups(pluginsDir, pluginName, 5);
      expect(removed).toBe(0);
      expect(listBackups(pluginsDir, pluginName)).toHaveLength(1);
    });
  });
});
