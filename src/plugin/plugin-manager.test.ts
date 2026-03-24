import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PluginManager } from './plugin-manager';
import { PluginConfig, MarketplaceEntry } from './types';

// Mock marketplace-fetcher
vi.mock('./marketplace-fetcher', () => ({
  fetchPlugin: vi.fn(),
}));

// Mock unified-config-loader
vi.mock('../unified-config-loader', () => ({
  loadUnifiedConfig: vi.fn(),
  saveUnifiedConfig: vi.fn(),
}));

// Mock defaults — disable auto-merge of default plugins in tests
vi.mock('./defaults', () => ({
  DEFAULT_MARKETPLACES: [],
  DEFAULT_PLUGINS: [],
  isDefaultPlugin: vi.fn(() => false),
  isDefaultMarketplace: vi.fn(() => false),
}));

import { fetchPlugin } from './marketplace-fetcher';
const mockFetchPlugin = vi.mocked(fetchPlugin);

import { loadUnifiedConfig, saveUnifiedConfig } from '../unified-config-loader';
const mockLoadUnifiedConfig = vi.mocked(loadUnifiedConfig);
const mockSaveUnifiedConfig = vi.mocked(saveUnifiedConfig);

import { isDefaultPlugin, isDefaultMarketplace } from './defaults';
const mockIsDefaultPlugin = vi.mocked(isDefaultPlugin);
const mockIsDefaultMarketplace = vi.mocked(isDefaultMarketplace);

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

  // =========================================================================
  // CRUD methods
  // =========================================================================
  describe('CRUD methods', () => {
    const configFile = '/tmp/test-config.json';
    const mcpFallback = '/tmp/test-mcp.json';
    const baseConfig: PluginConfig = {
      marketplace: [{ name: 'official', repo: 'org/plugins', ref: 'main' }],
      plugins: ['tool-a@official'],
      localOverrides: ['/some/local/path'],
    };

    let mgr: PluginManager;

    beforeEach(() => {
      mgr = new PluginManager(baseConfig, tmpDir, configFile, mcpFallback);
      // Mock loadUnifiedConfig to return a full config when saving
      mockLoadUnifiedConfig.mockReturnValue({
        mcpServers: { 'test-server': { command: 'node', args: ['server.js'] } },
        plugin: baseConfig,
      });
    });

    // --- getMarketplaces ---

    it('getMarketplaces returns the marketplace list', () => {
      const result = mgr.getMarketplaces();
      expect(result).toEqual([{ name: 'official', repo: 'org/plugins', ref: 'main' }]);
    });

    it('getMarketplaces returns empty array when no marketplaces configured', () => {
      const emptyMgr = new PluginManager({}, tmpDir, configFile, mcpFallback);
      expect(emptyMgr.getMarketplaces()).toEqual([]);
    });

    // --- getInstalledPlugins ---

    it('getInstalledPlugins returns the plugins list', () => {
      const result = mgr.getInstalledPlugins();
      expect(result).toEqual(['tool-a@official']);
    });

    it('getInstalledPlugins returns empty array when no plugins configured', () => {
      const emptyMgr = new PluginManager({}, tmpDir, configFile, mcpFallback);
      expect(emptyMgr.getInstalledPlugins()).toEqual([]);
    });

    // --- addMarketplace ---

    it('addMarketplace adds a new marketplace and saves config', () => {
      const entry: MarketplaceEntry = { name: 'community', repo: 'community/plugins' };
      const result = mgr.addMarketplace(entry);

      expect(result).toEqual({ success: true });
      expect(mgr.getMarketplaces()).toContainEqual(entry);
      expect(mockSaveUnifiedConfig).toHaveBeenCalledTimes(1);
      // Verify the saved config includes mcpServers (preserved)
      const savedConfig = mockSaveUnifiedConfig.mock.calls[0][1];
      expect(savedConfig.mcpServers).toBeDefined();
      expect(savedConfig.plugin?.marketplace).toContainEqual(entry);
    });

    it('addMarketplace rejects duplicate marketplace name', () => {
      const entry: MarketplaceEntry = { name: 'official', repo: 'other/repo' };
      const result = mgr.addMarketplace(entry);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    it('addMarketplace validates entry format', () => {
      // Missing repo slash (invalid owner/repo format)
      const result = mgr.addMarketplace({ name: 'bad', repo: 'noslash' } as MarketplaceEntry);
      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    it('addMarketplace validates unsafe marketplace name', () => {
      const result = mgr.addMarketplace({ name: '../evil', repo: 'org/repo' } as MarketplaceEntry);
      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    it('addMarketplace does not save when no configFile', () => {
      const noConfigMgr = new PluginManager(baseConfig, tmpDir);
      const entry: MarketplaceEntry = { name: 'community', repo: 'community/plugins' };
      const result = noConfigMgr.addMarketplace(entry);

      expect(result).toEqual({ success: true });
      expect(noConfigMgr.getMarketplaces()).toContainEqual(entry);
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    // --- removeMarketplace ---

    it('removeMarketplace removes an existing marketplace and saves config', () => {
      const result = mgr.removeMarketplace('official');

      expect(result).toEqual({ success: true });
      expect(mgr.getMarketplaces()).toEqual([]);
      expect(mockSaveUnifiedConfig).toHaveBeenCalledTimes(1);
    });

    it('removeMarketplace returns error for non-existent marketplace', () => {
      const result = mgr.removeMarketplace('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    // --- addPlugin ---

    it('addPlugin adds a new plugin ref and saves config', () => {
      const result = mgr.addPlugin('tool-b@official');

      expect(result).toEqual({ success: true });
      expect(mgr.getInstalledPlugins()).toContain('tool-b@official');
      expect(mockSaveUnifiedConfig).toHaveBeenCalledTimes(1);
    });

    it('addPlugin rejects duplicate plugin ref', () => {
      const result = mgr.addPlugin('tool-a@official');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already installed');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    it('addPlugin validates plugin ref format', () => {
      const result = mgr.addPlugin('invalid-no-at-sign');

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    it('addPlugin validates unsafe plugin name', () => {
      const result = mgr.addPlugin('../evil@official');

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    // --- removePlugin ---

    it('removePlugin removes an existing plugin ref and saves config', () => {
      const result = mgr.removePlugin('tool-a@official');

      expect(result).toEqual({ success: true });
      expect(mgr.getInstalledPlugins()).not.toContain('tool-a@official');
      expect(mockSaveUnifiedConfig).toHaveBeenCalledTimes(1);
    });

    it('removePlugin returns error for non-existent plugin ref', () => {
      const result = mgr.removePlugin('nonexistent@official');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    it('removePlugin rejects default plugin removal', () => {
      mockIsDefaultPlugin.mockReturnValueOnce(true);
      const result = mgr.removePlugin('superpowers@claude-plugins-official');

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be removed');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    // --- removeMarketplace default guard ---

    it('removeMarketplace rejects default marketplace removal', () => {
      mockIsDefaultMarketplace.mockReturnValueOnce(true);
      const result = mgr.removeMarketplace('claude-plugins-official');

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be removed');
      expect(mockSaveUnifiedConfig).not.toHaveBeenCalled();
    });

    // --- Immutability checks ---

    it('getMarketplaces returns a new array (not the internal reference)', () => {
      const a = mgr.getMarketplaces();
      const b = mgr.getMarketplaces();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('getInstalledPlugins returns a new array (not the internal reference)', () => {
      const a = mgr.getInstalledPlugins();
      const b = mgr.getInstalledPlugins();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    // --- Config persistence ---

    it('saves config preserving mcpServers section', () => {
      mgr.addPlugin('tool-b@official');

      const savedConfig = mockSaveUnifiedConfig.mock.calls[0][1];
      expect(savedConfig.mcpServers).toEqual({
        'test-server': { command: 'node', args: ['server.js'] },
      });
    });

    it('saves to the correct configFile path', () => {
      mgr.addPlugin('tool-b@official');

      expect(mockSaveUnifiedConfig.mock.calls[0][0]).toBe(configFile);
    });
  });
});
