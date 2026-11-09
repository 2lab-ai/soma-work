/**
 * The install-time security gate, end to end on disk: `fetchPlugin` (marketplace and external
 * sources) and the PluginManager paths that serve a plugin without a fresh install.
 *
 * An environment plugin (`plugin.envPlugins`) is installed by the fleet deploy and admin-gated at
 * runtime, so its CRITICAL scan is recorded, not enforced: the plugin stays installed and the full
 * report is logged. Every other plugin keeps the auto-block — removed from disk, fetch failed.
 * (Incident: an environment plugin whose MCP server imports `node:child_process` to start a local
 * CLI was blocked and its directory deleted; the host ran without it.)
 *
 * Content admitted in record mode belongs to that ref in record mode only. Its cache meta says so
 * (`pluginRef`, `admission: 'recorded'`), and every path that serves a plugin without a fresh
 * install — cache hit, stale cache, restored backup, rebuilt plugin list — runs the gate again when
 * the ref is no longer an environment plugin, or is another ref that shares the directory.
 *
 * `gh` and `tar` are faked (./fake-marketplace): each "tarball" is a file tree written straight into the extract dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ error: [] as string[], warn: [] as string[] }));

vi.mock('../../logger', () => ({
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = (message: string, data?: unknown) => {
      logs.warn.push(data === undefined ? message : `${message} ${JSON.stringify(data)}`);
    };
    error = (message: string, data?: unknown) => {
      logs.error.push(data === undefined ? message : `${message} ${JSON.stringify(data)}`);
    };
  },
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { fakeExecFileSync } = await import('./fake-marketplace');
  return { ...real, default: { ...real, execFileSync: fakeExecFileSync }, execFileSync: fakeExecFileSync };
});

vi.mock('../defaults', () => ({
  DEFAULT_MARKETPLACES: [],
  DEFAULT_PLUGINS: [],
  isDefaultPlugin: () => false,
  isDefaultMarketplace: () => false,
}));

import { type FetchOptions, type FetchResult, fetchPlugin, isFetchFailure } from '../marketplace-fetcher';
import { readCacheMeta, writeCacheMeta } from '../plugin-cache';
import { PluginManager } from '../plugin-manager';
import type { FetchFailure, MarketplaceEntry, PluginConfig } from '../types';
import {
  CLEAN_PLUGIN,
  CRITICAL_PLUGIN,
  publishMarketplace,
  publishRepo,
  resetRemote,
  unreachable,
} from './fake-marketplace';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'c'.repeat(40);
const OTHER_SHA = 'd'.repeat(40);
const EXT_SHA = 'e'.repeat(40);

const ACME: MarketplaceEntry = { name: 'acme-skills', repo: 'acme/acme-skills', ref: 'main' };
/** A second marketplace name served from the same repo — same SHA, same tree. */
const ACME_MIRROR: MarketplaceEntry = { name: 'other-skills', repo: 'acme/acme-skills', ref: 'main' };
const OTHER: MarketplaceEntry = { name: 'other-skills', repo: 'acme/other-skills', ref: 'main' };

function expectBlockedAndRemoved(result: FetchResult | FetchFailure, name: string): void {
  expect(isFetchFailure(result)).toBe(true);
  if (!isFetchFailure(result)) return;
  expect(result.code).toBe('SECURITY_BLOCKED');
  expect(result.riskLevel).toBe('CRITICAL');
  expect(fs.existsSync(path.join(pluginsDir, name))).toBe(false);
}

let pluginsDir: string;

beforeEach(() => {
  pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetcher-security-mode-'));
  logs.error.length = 0;
  logs.warn.length = 0;
  resetRemote();
  publishMarketplace(ACME.repo, SHA1, { 'acme-env': CRITICAL_PLUGIN });
});

afterEach(() => {
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

describe('fetchPlugin security gate — securityMode', () => {
  it('record: a CRITICAL scan keeps the plugin installed, logs the report and one error line, and caches it', async () => {
    const result = await fetchPlugin(ACME, 'acme-env', pluginsDir, { securityMode: 'record' });

    expect(isFetchFailure(result)).toBe(false);
    const installed = path.join(pluginsDir, 'acme-env');
    expect(result).toEqual({ pluginPath: installed, sha: SHA1, cached: false });
    expect(fs.existsSync(path.join(installed, 'mcp', 'server.js'))).toBe(true);
    // Cached for this ref in record mode: the next boot with the same remote SHA does not re-download.
    expect(readCacheMeta(pluginsDir, 'acme-env')).toMatchObject({
      sha: SHA1,
      pluginRef: 'acme-env@acme-skills',
      admission: 'recorded',
    });

    // The scan ran: the full report (with the finding) is at warn level, and says what happened.
    const report = logs.warn.find((l) => l.includes('Security Scan: acme-env'));
    expect(report).toContain('EXEC_CHILD_PROCESS');
    expect(report).toContain('Recorded, not blocked');
    expect(report).not.toContain('BLOCKED');
    // Exactly one error line, naming the plugin, its risk level, and why it was kept.
    const errorLines = logs.error.filter((l) => l.includes('acme-env'));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('CRITICAL');
    expect(errorLines[0]).toMatch(/environment plugin/i);
    expect(errorLines[0]).not.toContain('Plugin BLOCKED');

    // Same ref, still record mode, same remote SHA: served from cache.
    const again = await fetchPlugin(ACME, 'acme-env', pluginsDir, { securityMode: 'record' });
    expect(again).toEqual({ pluginPath: installed, sha: SHA1, cached: true });
  });

  it.each<[string, FetchOptions | undefined]>([
    ['no options (default)', undefined],
    ['empty options', {}],
    ["securityMode 'block'", { securityMode: 'block' }],
  ])('%s: a CRITICAL scan blocks the plugin and removes it from disk', async (_label, options) => {
    const result = await fetchPlugin(ACME, 'acme-env', pluginsDir, options);

    expectBlockedAndRemoved(result, 'acme-env');
    if (!isFetchFailure(result)) return;
    expect(result.securityFindings?.some((f) => f.rule === 'EXEC_CHILD_PROCESS')).toBe(true);
    expect(readCacheMeta(pluginsDir, 'acme-env')).toBeNull();
    expect(logs.error.some((l) => l.startsWith('Plugin BLOCKED by security scan'))).toBe(true);
    expect(logs.warn.find((l) => l.includes('Security Scan: acme-env'))).toContain('Installation BLOCKED');
  });

  describe('external source (plugin in its own repo)', () => {
    beforeEach(() => {
      publishMarketplace(ACME.repo, SHA1, {}, { 'acme-ext': 'acme/acme-ext' });
      publishRepo('acme/acme-ext', EXT_SHA, CRITICAL_PLUGIN);
    });

    it('record keeps a CRITICAL external plugin installed and cached for this ref', async () => {
      const result = await fetchPlugin(ACME, 'acme-ext', pluginsDir, { securityMode: 'record' });

      expect(result).toEqual({ pluginPath: path.join(pluginsDir, 'acme-ext'), sha: EXT_SHA, cached: false });
      expect(fs.existsSync(path.join(pluginsDir, 'acme-ext', 'mcp', 'server.js'))).toBe(true);
      expect(readCacheMeta(pluginsDir, 'acme-ext')).toMatchObject({
        pluginRef: 'acme-ext@acme-skills',
        admission: 'recorded',
      });
      expect(logs.error.filter((l) => l.includes('acme-ext'))).toHaveLength(1);
    });

    it('block removes a CRITICAL external plugin', async () => {
      const result = await fetchPlugin(ACME, 'acme-ext', pluginsDir, { securityMode: 'block' });

      expectBlockedAndRemoved(result, 'acme-ext');
      if (isFetchFailure(result)) expect(result.message).toMatch(/^External plugin blocked/);
    });

    it('a record-admitted external plugin is gated again when fetched in block mode at the same SHAs', async () => {
      await fetchPlugin(ACME, 'acme-ext', pluginsDir, { securityMode: 'record' });

      const result = await fetchPlugin(ACME, 'acme-ext', pluginsDir, { securityMode: 'block' });

      expectBlockedAndRemoved(result, 'acme-ext');
    });
  });
});

describe('fetchPlugin — record-admitted content is never served to block mode or another ref ungated', () => {
  async function installAsEnvPlugin(): Promise<void> {
    const installed = await fetchPlugin(ACME, 'acme-env', pluginsDir, { securityMode: 'record' });
    expect(isFetchFailure(installed)).toBe(false);
  }

  it('transition 1: same ref, envPlugins entry removed, same remote SHA → re-gated, blocked, removed', async () => {
    await installAsEnvPlugin();

    const result = await fetchPlugin(ACME, 'acme-env', pluginsDir, { securityMode: 'block' });

    expectBlockedAndRemoved(result, 'acme-env');
  });

  it('transition 1, remote unreachable: the stale cache is gated before it is served', async () => {
    await installAsEnvPlugin();
    unreachable(ACME.repo);

    const result = await fetchPlugin(ACME, 'acme-env', pluginsDir, { securityMode: 'block' });

    expectBlockedAndRemoved(result, 'acme-env');
  });

  it('transition 1, then a non-security fetch failure: the record content is still gated off the disk', async () => {
    // `skill-locator` reads PLUGINS_DIR directly, so a directory left on disk is still reachable.
    await installAsEnvPlugin();
    publishMarketplace(ACME.repo, SHA2, { 'acme-other': CLEAN_PLUGIN }); // acme-env dropped upstream

    const result = await fetchPlugin(ACME, 'acme-env', pluginsDir, { securityMode: 'block' });

    expect(isFetchFailure(result) && result.code).toBe('PLUGIN_NOT_IN_MANIFEST');
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env'))).toBe(false);
  });

  it('transition 2: same name from another marketplace on the same repo (same SHA) is not a cache hit', async () => {
    await installAsEnvPlugin();

    const result = await fetchPlugin(ACME_MIRROR, 'acme-env', pluginsDir, { securityMode: 'block' });

    expectBlockedAndRemoved(result, 'acme-env');
  });

  it('transition 2, identity alone: an admin Force Update of one ref does not carry over to a same-name ref', async () => {
    // Force Update (skipSecurityGate) admits CRITICAL content unscanned, for that ref only.
    const forced = await fetchPlugin(ACME, 'acme-env', pluginsDir, { skipSecurityGate: true, securityMode: 'block' });
    expect(isFetchFailure(forced)).toBe(false);
    expect(readCacheMeta(pluginsDir, 'acme-env')).toMatchObject({
      pluginRef: 'acme-env@acme-skills',
      admission: 'forced',
    });
    // Same ref, same SHA: the admin's override stands until the SHA changes, as before.
    expect(await fetchPlugin(ACME, 'acme-env', pluginsDir, { securityMode: 'block' })).toMatchObject({ cached: true });

    const result = await fetchPlugin(ACME_MIRROR, 'acme-env', pluginsDir, { securityMode: 'block' });

    expectBlockedAndRemoved(result, 'acme-env');
  });

  it('transition 2: same name from another marketplace, unreachable → the stale record content is gated', async () => {
    await installAsEnvPlugin();

    const result = await fetchPlugin(OTHER, 'acme-env', pluginsDir, { securityMode: 'block' });

    expectBlockedAndRemoved(result, 'acme-env');
  });

  it('transition 2: same name from another marketplace with its own clean content → installs that content', async () => {
    await installAsEnvPlugin();
    publishMarketplace(OTHER.repo, OTHER_SHA, { 'acme-env': CLEAN_PLUGIN });

    const result = await fetchPlugin(OTHER, 'acme-env', pluginsDir, { securityMode: 'block' });

    expect(result).toEqual({ pluginPath: path.join(pluginsDir, 'acme-env'), sha: OTHER_SHA, cached: false });
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env', 'mcp', 'server.js'))).toBe(false);
    expect(readCacheMeta(pluginsDir, 'acme-env')).toMatchObject({
      pluginRef: 'acme-env@other-skills',
      admission: 'passed',
    });
  });

  it('a cache without admission metadata (written before this change) is not trusted: re-downloaded and re-scanned', async () => {
    publishMarketplace(ACME.repo, SHA1, { 'acme-tools': CLEAN_PLUGIN });
    fs.mkdirSync(path.join(pluginsDir, 'acme-tools'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'acme-tools', 'leftover.js'), 'export {};\n');
    writeCacheMeta(pluginsDir, 'acme-tools', {
      sha: SHA1,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      marketplace: 'acme-skills',
      ref: 'main',
    });

    const result = await fetchPlugin(ACME, 'acme-tools', pluginsDir, { securityMode: 'block' });

    expect(result).toEqual({ pluginPath: path.join(pluginsDir, 'acme-tools'), sha: SHA1, cached: false });
    expect(fs.existsSync(path.join(pluginsDir, 'acme-tools', 'leftover.js'))).toBe(false);
    expect(readCacheMeta(pluginsDir, 'acme-tools')).toMatchObject({
      pluginRef: 'acme-tools@acme-skills',
      admission: 'passed',
    });
  });
});

describe('PluginManager — a record-admitted plugin after its envPlugins entry is removed', () => {
  const ENV_REF = 'acme-env@acme-skills';
  const withEnv: PluginConfig = { marketplace: [ACME], plugins: [ENV_REF], envPlugins: [ENV_REF] };
  const withoutEnv: PluginConfig = { marketplace: [ACME], plugins: [ENV_REF] };

  function resolvedNames(mgr: PluginManager): string[] {
    return mgr.getResolvedPlugins().map((r) => r.name);
  }

  async function installAsEnvPlugin(): Promise<void> {
    const env = new PluginManager(withEnv, pluginsDir);
    await env.initialize();
    expect(resolvedNames(env)).toEqual([ENV_REF]);
  }

  it('control: still an environment plugin → served from cache by initialize and forceRefresh', async () => {
    await installAsEnvPlugin();

    const env = new PluginManager(withEnv, pluginsDir);
    await env.initialize();
    expect(resolvedNames(env)).toEqual([ENV_REF]);
    const result = await env.forceRefresh();
    expect(result.details).toEqual([expect.objectContaining({ name: ENV_REF, status: 'unchanged' })]);
    expect(resolvedNames(env)).toEqual([ENV_REF]);
  });

  it('transition 1: initialize at the same remote SHA does not serve it, and removes it', async () => {
    await installAsEnvPlugin();

    const plain = new PluginManager(withoutEnv, pluginsDir);
    await plain.initialize();

    expect(resolvedNames(plain)).toEqual([]);
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env'))).toBe(false);
  });

  it('forceRefresh at the same remote SHA reports SECURITY_BLOCKED instead of "unchanged"', async () => {
    await installAsEnvPlugin();

    const plain = new PluginManager(withoutEnv, pluginsDir);
    const result = await plain.forceRefresh();

    expect(result.details).toEqual([
      expect.objectContaining({ name: ENV_REF, status: 'error', failureCode: 'SECURITY_BLOCKED' }),
    ]);
    expect(resolvedNames(plain)).toEqual([]);
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env'))).toBe(false);
  });

  it('transition 3: forceRefresh to a blocked new SHA does not restore the record-admitted backup as ordinary', async () => {
    await installAsEnvPlugin();
    publishMarketplace(ACME.repo, SHA2, { 'acme-env': CRITICAL_PLUGIN });

    const plain = new PluginManager(withoutEnv, pluginsDir);
    const result = await plain.forceRefresh();

    expect(result.details).toEqual([
      expect.objectContaining({ name: ENV_REF, status: 'error', failureCode: 'SECURITY_BLOCKED' }),
    ]);
    expect(resolvedNames(plain)).toEqual([]);
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env'))).toBe(false);
  });

  it('forceRefresh with the remote unreachable does not keep the record-admitted cache', async () => {
    await installAsEnvPlugin();
    unreachable(ACME.repo);

    const plain = new PluginManager(withoutEnv, pluginsDir);
    const result = await plain.forceRefresh();

    expect(result.details).toEqual([
      expect.objectContaining({ name: ENV_REF, status: 'error', failureCode: 'SECURITY_BLOCKED' }),
    ]);
    expect(resolvedNames(plain)).toEqual([]);
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env'))).toBe(false);
  });

  it('rollback to a record-admitted backup fails instead of serving it as ordinary', async () => {
    await installAsEnvPlugin();
    publishMarketplace(ACME.repo, SHA2, { 'acme-env': CRITICAL_PLUGIN });
    await new PluginManager(withEnv, pluginsDir).forceRefresh(); // backs up the SHA1 install

    const plain = new PluginManager(withoutEnv, pluginsDir);
    const result = await plain.rollback(ENV_REF);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/security scan/i);
    expect(resolvedNames(plain)).toEqual([]);
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env'))).toBe(false);
  });
});

/**
 * Two configured refs with one plugin name share `plugins/<name>` (and its cache meta and
 * backups): whichever installs second rewrites the bytes under the identity that already
 * resolved, so an ordinary ref could serve an environment plugin's record-only content, or the
 * reverse. A config error — every ref of that name is refused: nothing fetched, nothing resolved,
 * and what an earlier run left under the name is removed (PLUGINS_DIR readers would reach it).
 */
describe('PluginManager — two configured refs with one plugin name', () => {
  const ENV_REF = 'acme-env@acme-skills';
  const ORDINARY_REF = 'acme-env@other-skills';
  const ORDERS: [string, string[]][] = [
    ['env ref first', [ENV_REF, ORDINARY_REF]],
    ['ordinary ref first', [ORDINARY_REF, ENV_REF]],
  ];

  beforeEach(() => {
    publishMarketplace(OTHER.repo, OTHER_SHA, { 'acme-env': CLEAN_PLUGIN, 'acme-tools': CLEAN_PLUGIN });
  });

  function colliding(plugins: string[]): PluginManager {
    return new PluginManager({ marketplace: [ACME, OTHER], plugins, envPlugins: [ENV_REF] }, pluginsDir);
  }

  /** An earlier run installed the env plugin alone: CRITICAL content, recorded, on disk. */
  async function earlierEnvInstall(): Promise<void> {
    const env = new PluginManager({ marketplace: [ACME], plugins: [ENV_REF], envPlugins: [ENV_REF] }, pluginsDir);
    await env.initialize();
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env', 'mcp', 'server.js'))).toBe(true);
  }

  function collisionErrors(): string[] {
    return logs.error.filter((l) => l.includes(ENV_REF) && l.includes(ORDINARY_REF));
  }

  function expectNothingUnderTheName(mgr: PluginManager): void {
    expect(mgr.getResolvedPlugins()).toEqual([]);
    expect(mgr.getPluginPaths()).toEqual([]);
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env'))).toBe(false);
    expect(readCacheMeta(pluginsDir, 'acme-env')).toBeNull();
  }

  it.each(ORDERS)('%s: initialize refuses both and removes the earlier install', async (_label, plugins) => {
    await earlierEnvInstall();
    logs.error.length = 0;

    const mgr = colliding(plugins);
    await mgr.initialize();

    expectNothingUnderTheName(mgr);
    expect(collisionErrors()).toHaveLength(1);
    expect(collisionErrors()[0]).toMatch(/rename one/i);
    expect(collisionErrors()[0]).toMatch(/environment plugin/i);
  });

  it.each(ORDERS)('%s: initialize on a fresh host fetches neither', async (_label, plugins) => {
    const mgr = colliding(plugins);
    await mgr.initialize();

    expectNothingUnderTheName(mgr);
    expect(collisionErrors()).toHaveLength(1);
  });

  it.each(ORDERS)('%s: forceRefresh refuses both, one error detail each', async (_label, plugins) => {
    await earlierEnvInstall();
    logs.error.length = 0;

    const mgr = colliding(plugins);
    const result = await mgr.forceRefresh();

    expect(result.details.map((d) => [d.name, d.status])).toEqual(plugins.map((p) => [p, 'error']));
    for (const detail of result.details) {
      expect(detail.error).toMatch(/rename one/i);
      // No failure code: the Force Update button cannot fix a config error.
      expect(detail.failureCode).toBeUndefined();
    }
    expectNothingUnderTheName(mgr);
    expect(collisionErrors()).toHaveLength(1);
  });

  it('rollback of a colliding ref is refused and restores nothing', async () => {
    await earlierEnvInstall();
    publishMarketplace(ACME.repo, SHA2, { 'acme-env': CRITICAL_PLUGIN });
    await new PluginManager(
      { marketplace: [ACME], plugins: [ENV_REF], envPlugins: [ENV_REF] },
      pluginsDir,
    ).forceRefresh();
    const mgr = colliding([ENV_REF, ORDINARY_REF]);
    await mgr.initialize();

    const result = await mgr.rollback(ENV_REF);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/rename one/i);
    expectNothingUnderTheName(mgr);
  });

  it('control: two different names, one env and one ordinary, both resolve', async () => {
    const mgr = new PluginManager(
      { marketplace: [ACME, OTHER], plugins: [ENV_REF, 'acme-tools@other-skills'], envPlugins: [ENV_REF] },
      pluginsDir,
    );
    await mgr.initialize();

    expect(mgr.getResolvedPlugins().map((r) => r.name)).toEqual([ENV_REF, 'acme-tools@other-skills']);
    expect(fs.existsSync(path.join(pluginsDir, 'acme-env', 'mcp', 'server.js'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, 'acme-tools', 'skills', 'hello', 'SKILL.md'))).toBe(true);
    expect(logs.error.some((l) => /collision/i.test(l))).toBe(false);
  });
});
