/**
 * RED→GREEN contract for the zworkflow plugin refactor.
 *
 * Requirements under test (SSOT):
 *  - T1: src/local is a proper Claude Code plugin named "zworkflow"
 *        (src/local/.claude-plugin/plugin.json + official root marketplace manifest).
 *  - T2: installable via `/plugin marketplace add 2lab-ai/soma-work`
 *        + `/plugin install zworkflow@soma-work` (official .claude-plugin/marketplace.json,
 *        marketplace "soma-work", plugin "zworkflow", source "./src/local").
 *  - T3: zworkflow + stv both installed by default; zworkflow is the first-party
 *        BUNDLED default (resolved to the local dir, never remote-fetched).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('zworkflow plugin manifests (T1/T2)', () => {
  it('exposes an official marketplace manifest at .claude-plugin/marketplace.json', () => {
    const manifestPath = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    // Marketplace name must be "soma-work" so `/plugin install zworkflow@soma-work` resolves.
    expect(manifest.name).toBe('soma-work');
    // Official format = plugins is an Array.
    expect(Array.isArray(manifest.plugins)).toBe(true);

    const zworkflow = manifest.plugins.find((p: { name: string }) => p.name === 'zworkflow');
    expect(zworkflow).toBeTruthy();
    expect(zworkflow.source).toBe('./src/local');
  });

  it('does not keep the legacy internal marketplace.json with the old "omc" plugin', () => {
    const legacyPath = path.join(REPO_ROOT, 'marketplace.json');
    if (fs.existsSync(legacyPath)) {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
      // If a root marketplace.json still exists it must not advertise the old "omc" name.
      const names = Array.isArray(legacy.plugins)
        ? legacy.plugins.map((p: { name: string }) => p.name)
        : Object.keys(legacy.plugins ?? {});
      expect(names).not.toContain('omc');
    }
  });

  it('ships a plugin.json declaring the plugin name "zworkflow"', () => {
    const pluginJsonPath = path.join(REPO_ROOT, 'src', 'local', '.claude-plugin', 'plugin.json');
    expect(fs.existsSync(pluginJsonPath)).toBe(true);

    const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
    expect(plugin.name).toBe('zworkflow');
    expect(typeof plugin.description).toBe('string');
    expect(plugin.description.length).toBeGreaterThan(0);
  });
});

describe('default plugin wiring (T3)', () => {
  it('lists both zworkflow and stv as default plugins', async () => {
    // Bypass the file-wide vi.mock('../defaults') below — assert the REAL defaults.
    const { DEFAULT_PLUGINS, DEFAULT_MARKETPLACES } =
      await vi.importActual<typeof import('../defaults')>('../defaults');
    expect(DEFAULT_PLUGINS).toContain('zworkflow@soma-work');
    expect(DEFAULT_PLUGINS).toContain('stv@oh-my-claude');
    // soma-work marketplace must be a default so external installs + fallback fetch resolve.
    expect(DEFAULT_MARKETPLACES.some((m) => m.name === 'soma-work')).toBe(true);
  });

  it('registers zworkflow as a first-party bundled plugin', async () => {
    const { BUNDLED_PLUGINS } = await import('../bundled');
    expect(BUNDLED_PLUGINS.zworkflow).toBeTruthy();
    // Bundled path must point at the local plugin dir (src/local in source tree).
    expect(BUNDLED_PLUGINS.zworkflow.endsWith(path.join('local'))).toBe(true);
  });
});

// Mock collaborators for the resolution-behavior test.
vi.mock('../marketplace-fetcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../marketplace-fetcher')>();
  return { ...actual, fetchPlugin: vi.fn(), resolveRemoteSha: vi.fn() };
});
vi.mock('../../config-loader', () => ({ loadConfig: vi.fn(), saveConfig: vi.fn() }));
vi.mock('../defaults', () => ({
  DEFAULT_MARKETPLACES: [],
  DEFAULT_PLUGINS: [],
  isDefaultPlugin: vi.fn(() => false),
  isDefaultMarketplace: vi.fn(() => false),
}));

import { fetchPlugin } from '../marketplace-fetcher';
import { PluginManager } from '../plugin-manager';
import type { PluginConfig } from '../types';

const mockFetchPlugin = vi.mocked(fetchPlugin);

describe('PluginManager bundled-plugin resolution (T3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwf-bundled-'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a bundled plugin to its local path WITHOUT calling fetchPlugin', async () => {
    const bundledPath = path.join(tmpDir, 'bundled-local');
    fs.mkdirSync(bundledPath, { recursive: true });

    const config: PluginConfig = {
      marketplace: [{ name: 'soma-work', repo: '2lab-ai/soma-work', ref: 'main' }],
      plugins: ['zworkflow@soma-work'],
    };

    const mgr = new PluginManager(config, tmpDir, undefined, { zworkflow: bundledPath });
    await mgr.initialize();

    expect(mockFetchPlugin).not.toHaveBeenCalled();

    const resolved = mgr.getResolvedPlugins();
    const zwf = resolved.find((r) => r.name === 'zworkflow@soma-work');
    expect(zwf).toBeTruthy();
    expect(zwf?.localPath).toBe(bundledPath);
    expect(zwf?.source).toBe('default');

    expect(mgr.getPluginPaths()).toContainEqual({ type: 'local', path: bundledPath });
  });
});
