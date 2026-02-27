import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PluginManager } from './plugin-manager';
import { PluginConfig } from './types';

// Mock marketplace-fetcher
vi.mock('./marketplace-fetcher', () => ({
  fetchPlugin: vi.fn(),
}));

import { fetchPlugin } from './marketplace-fetcher';
const mockFetchPlugin = vi.mocked(fetchPlugin);

describe('PluginManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mgr-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty plugin paths before initialization', () => {
    const mgr = new PluginManager({}, tmpDir);
    expect(mgr.getPluginPaths()).toEqual([]);
  });

  it('resolves marketplace plugins via fetchPlugin', async () => {
    const config: PluginConfig = {
      marketplace: [{ name: 'soma-work', repo: '2lab-ai/soma-work', ref: 'main' }],
      plugins: ['omc@soma-work'],
    };

    const installedPath = path.join(tmpDir, 'omc');
    mockFetchPlugin.mockResolvedValueOnce({
      pluginPath: installedPath,
      sha: 'abc123',
      cached: false,
    });

    const mgr = new PluginManager(config, tmpDir);
    await mgr.initialize();

    expect(mockFetchPlugin).toHaveBeenCalledWith(
      { name: 'soma-work', repo: '2lab-ai/soma-work', ref: 'main' },
      'omc',
      expect.any(String)
    );

    const paths = mgr.getPluginPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual({ type: 'local', path: installedPath });

    const resolved = mgr.getResolvedPlugins();
    expect(resolved[0].name).toBe('omc@soma-work');
    expect(resolved[0].source).toBe('marketplace');
  });

  it('adds local overrides without fetching', async () => {
    const overridePath = path.join(tmpDir, 'src', 'local');
    fs.mkdirSync(overridePath, { recursive: true });

    const config: PluginConfig = {
      localOverrides: [overridePath],
    };

    const mgr = new PluginManager(config, tmpDir);
    await mgr.initialize();

    expect(mockFetchPlugin).not.toHaveBeenCalled();

    const paths = mgr.getPluginPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0].type).toBe('local');
    expect(paths[0].path).toBe(overridePath);

    const resolved = mgr.getResolvedPlugins();
    expect(resolved[0].source).toBe('local-override');
  });

  it('combines marketplace plugins and local overrides', async () => {
    const overridePath = path.join(tmpDir, 'local');
    fs.mkdirSync(overridePath, { recursive: true });

    const config: PluginConfig = {
      marketplace: [{ name: 'official', repo: 'org/plugins' }],
      plugins: ['superpowers@official'],
      localOverrides: [overridePath],
    };

    const installedPath = path.join(tmpDir, 'superpowers');
    mockFetchPlugin.mockResolvedValueOnce({
      pluginPath: installedPath,
      sha: 'def456',
      cached: true,
    });

    const mgr = new PluginManager(config, tmpDir);
    await mgr.initialize();

    const paths = mgr.getPluginPaths();
    expect(paths).toHaveLength(2);
    expect(paths[0].path).toBe(installedPath);
    expect(paths[1].path).toBe(overridePath);
  });

  it('skips plugins with unknown marketplace', async () => {
    const config: PluginConfig = {
      marketplace: [{ name: 'soma-work', repo: '2lab-ai/soma-work' }],
      plugins: ['omc@unknown-marketplace'],
    };

    const mgr = new PluginManager(config, tmpDir);
    await mgr.initialize();

    expect(mockFetchPlugin).not.toHaveBeenCalled();
    expect(mgr.getPluginPaths()).toHaveLength(0);
  });

  it('continues when fetchPlugin returns null', async () => {
    const config: PluginConfig = {
      marketplace: [{ name: 'soma-work', repo: '2lab-ai/soma-work' }],
      plugins: ['omc@soma-work'],
      localOverrides: [path.join(tmpDir, 'local')],
    };

    mockFetchPlugin.mockResolvedValueOnce(null);
    fs.mkdirSync(path.join(tmpDir, 'local'), { recursive: true });

    const mgr = new PluginManager(config, tmpDir);
    await mgr.initialize();

    // Should still have the local override
    expect(mgr.getPluginPaths()).toHaveLength(1);
  });

  it('continues when fetchPlugin throws', async () => {
    const config: PluginConfig = {
      marketplace: [{ name: 'soma-work', repo: '2lab-ai/soma-work' }],
      plugins: ['omc@soma-work'],
    };

    mockFetchPlugin.mockRejectedValueOnce(new Error('network error'));

    const mgr = new PluginManager(config, tmpDir);
    await mgr.initialize();

    expect(mgr.getPluginPaths()).toHaveLength(0);
  });

  it('refresh re-fetches all plugins', async () => {
    const config: PluginConfig = {
      marketplace: [{ name: 'soma-work', repo: '2lab-ai/soma-work' }],
      plugins: ['omc@soma-work'],
    };

    const installedPath = path.join(tmpDir, 'omc');
    mockFetchPlugin.mockResolvedValue({
      pluginPath: installedPath,
      sha: 'abc123',
      cached: false,
    });

    const mgr = new PluginManager(config, tmpDir);
    await mgr.initialize();
    expect(mockFetchPlugin).toHaveBeenCalledTimes(1);

    await mgr.refresh();
    expect(mockFetchPlugin).toHaveBeenCalledTimes(2);
  });

  it('handles empty plugin config', async () => {
    const mgr = new PluginManager({}, tmpDir);
    await mgr.initialize();

    expect(mgr.getPluginPaths()).toEqual([]);
    expect(mgr.getResolvedPlugins()).toEqual([]);
  });
});
