import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readCacheMeta, writeCacheMeta, hasCachedPlugin, removeCachedPlugin } from './plugin-cache';
import { CacheMeta } from './types';

describe('plugin-cache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cache-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleMeta: CacheMeta = {
    sha: 'abc123def456',
    fetchedAt: '2026-01-01T00:00:00Z',
    marketplace: 'soma-work',
    ref: 'main',
  };

  describe('writeCacheMeta / readCacheMeta', () => {
    it('writes and reads back cache metadata', () => {
      writeCacheMeta(tmpDir, 'omc', sampleMeta);
      const result = readCacheMeta(tmpDir, 'omc');
      expect(result).toEqual(sampleMeta);
    });

    it('creates .cache directory if missing', () => {
      writeCacheMeta(tmpDir, 'test', sampleMeta);
      expect(fs.existsSync(path.join(tmpDir, '.cache'))).toBe(true);
    });

    it('returns null for missing plugin', () => {
      expect(readCacheMeta(tmpDir, 'nonexistent')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const cacheDir = path.join(tmpDir, '.cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'broken.meta.json'), 'not json');
      expect(readCacheMeta(tmpDir, 'broken')).toBeNull();
    });

    it('returns null for meta missing required fields', () => {
      const cacheDir = path.join(tmpDir, '.cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, 'partial.meta.json'),
        JSON.stringify({ sha: 'abc' }) // missing fetchedAt, marketplace, ref
      );
      expect(readCacheMeta(tmpDir, 'partial')).toBeNull();
    });
  });

  describe('hasCachedPlugin', () => {
    it('returns false for nonexistent directory', () => {
      expect(hasCachedPlugin(tmpDir, 'nodir')).toBe(false);
    });

    it('returns false for empty directory', () => {
      fs.mkdirSync(path.join(tmpDir, 'empty'));
      expect(hasCachedPlugin(tmpDir, 'empty')).toBe(false);
    });

    it('returns true for directory with content', () => {
      const pluginDir = path.join(tmpDir, 'omc');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'file.txt'), 'content');
      expect(hasCachedPlugin(tmpDir, 'omc')).toBe(true);
    });
  });

  describe('removeCachedPlugin', () => {
    it('removes an existing plugin directory', () => {
      const pluginDir = path.join(tmpDir, 'omc');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'file.txt'), 'content');

      removeCachedPlugin(tmpDir, 'omc');
      expect(fs.existsSync(pluginDir)).toBe(false);
    });

    it('does not throw for nonexistent directory', () => {
      expect(() => removeCachedPlugin(tmpDir, 'nodir')).not.toThrow();
    });
  });
});
