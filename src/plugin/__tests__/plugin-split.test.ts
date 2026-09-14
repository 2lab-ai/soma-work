/**
 * RED→GREEN contract for the local/core plugin split.
 *
 * Requirements under test (SSOT):
 *  - T1: `plugin/local` and `plugin/core` are proper Claude Code plugins named
 *        "local" and "core" (each with `.claude-plugin/plugin.json`).
 *  - T2: both installable via `/plugin marketplace add 2lab-ai/soma-work`
 *        + `/plugin install <name>@soma-work` (official
 *        `.claude-plugin/marketplace.json`, marketplace "soma-work", sources
 *        "./plugin/local" and "./plugin/core").
 *  - T3: local + core + stv are defaults; local and core are the first-party
 *        BUNDLED defaults (resolved to their bundled dirs, never remote-fetched).
 *        The retired `zworkflow` name must not come back.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('local/core plugin manifests (T1/T2)', () => {
  it('exposes an official marketplace manifest listing both plugins', () => {
    const manifestPath = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    // Marketplace name must be "soma-work" so `/plugin install local@soma-work` resolves.
    expect(manifest.name).toBe('soma-work');
    // Official format = plugins is an Array.
    expect(Array.isArray(manifest.plugins)).toBe(true);

    const local = manifest.plugins.find((p: { name: string }) => p.name === 'local');
    expect(local).toBeTruthy();
    expect(local.source).toBe('./plugin/local');

    const core = manifest.plugins.find((p: { name: string }) => p.name === 'core');
    expect(core).toBeTruthy();
    expect(core.source).toBe('./plugin/core');

    // The old single-plugin name is retired entirely.
    const names = manifest.plugins.map((p: { name: string }) => p.name);
    expect(names).not.toContain('zworkflow');
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

  it.each([
    ['local', 'local'],
    ['core', 'core'],
  ])('ships plugin/%s/.claude-plugin/plugin.json declaring the name "%s"', (dir, name) => {
    const pluginJsonPath = path.join(REPO_ROOT, 'plugin', dir, '.claude-plugin', 'plugin.json');
    expect(fs.existsSync(pluginJsonPath)).toBe(true);

    const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
    expect(plugin.name).toBe(name);
    expect(typeof plugin.description).toBe('string');
    expect(plugin.description.length).toBeGreaterThan(0);
  });
});

describe('default plugin wiring (T3)', () => {
  it('lists local, core and stv as default plugins', async () => {
    // Bypass the file-wide vi.mock('../defaults') below — assert the REAL defaults.
    const { DEFAULT_PLUGINS, DEFAULT_MARKETPLACES } =
      await vi.importActual<typeof import('../defaults')>('../defaults');
    expect(DEFAULT_PLUGINS).toContain('local@soma-work');
    expect(DEFAULT_PLUGINS).toContain('core@soma-work');
    expect(DEFAULT_PLUGINS).toContain('stv@oh-my-claude');
    // The retired plugin name must never reappear in the defaults.
    expect(DEFAULT_PLUGINS).not.toContain('zworkflow@soma-work');
    // soma-work marketplace must be a default so external installs + fallback fetch resolve.
    expect(DEFAULT_MARKETPLACES.some((m) => m.name === 'soma-work')).toBe(true);
  });

  it('registers local and core as first-party bundled plugins that exist on disk', async () => {
    const { BUNDLED_PLUGINS } = await import('../bundled');
    expect(BUNDLED_PLUGINS.local).toBeTruthy();
    expect(BUNDLED_PLUGINS.core).toBeTruthy();
    // Bundled paths must point at the real plugin dirs (plugin/{local,core} in
    // the source tree, dist/{local,core} in the compiled bundle).
    expect(BUNDLED_PLUGINS.local.endsWith(`${path.sep}local`)).toBe(true);
    expect(BUNDLED_PLUGINS.core.endsWith(`${path.sep}core`)).toBe(true);
    expect(fs.existsSync(BUNDLED_PLUGINS.local)).toBe(true);
    expect(fs.existsSync(BUNDLED_PLUGINS.core)).toBe(true);
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-split-bundled-'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves BOTH bundled plugins to their local paths WITHOUT calling fetchPlugin', async () => {
    const localPath = path.join(tmpDir, 'bundled-local');
    const corePath = path.join(tmpDir, 'bundled-core');
    fs.mkdirSync(localPath, { recursive: true });
    fs.mkdirSync(corePath, { recursive: true });

    const config: PluginConfig = {
      marketplace: [{ name: 'soma-work', repo: '2lab-ai/soma-work', ref: 'main' }],
      plugins: ['local@soma-work', 'core@soma-work'],
    };

    const mgr = new PluginManager(config, tmpDir, undefined, { local: localPath, core: corePath });
    await mgr.initialize();

    expect(mockFetchPlugin).not.toHaveBeenCalled();

    const resolved = mgr.getResolvedPlugins();

    const local = resolved.find((r) => r.name === 'local@soma-work');
    expect(local).toBeTruthy();
    expect(local?.localPath).toBe(localPath);
    expect(local?.source).toBe('default');

    const core = resolved.find((r) => r.name === 'core@soma-work');
    expect(core).toBeTruthy();
    expect(core?.localPath).toBe(corePath);
    expect(core?.source).toBe('default');

    expect(mgr.getPluginPaths()).toContainEqual({ type: 'local', path: localPath });
    expect(mgr.getPluginPaths()).toContainEqual({ type: 'local', path: corePath });
  });
});
