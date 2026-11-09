/**
 * PLUGINS_DIR is served only for plugin names admitted by the latest PluginManager pass.
 *
 * `skill-locator` and `SkillForceHandler` read PLUGINS_DIR directly, not PluginManager's resolved
 * list. A directory on disk is therefore not proof of admission: a refused name whose deletion
 * failed, a plugin blocked by the scan whose deletion failed, a plugin removed from config — each
 * leaves a directory no configured ref admitted, and it must not come back once the collision is
 * gone or after a restart. They serve a PLUGINS_DIR name only when it is in the admitted set
 * PluginManager writes at the end of every pass; before the first pass the set is empty.
 *
 * Real disk, fake GitHub (./fake-marketplace). Deletions are made to fail by a read-only skill dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => ({ plugins: '', data: '' }));
const logs = vi.hoisted(() => ({ error: [] as string[] }));
const defaults = vi.hoisted(() => ({
  marketplaces: [] as { name: string; repo: string; ref: string }[],
  plugins: [] as string[],
}));

vi.mock('../../env-paths', () => ({
  get PLUGINS_DIR() {
    return roots.plugins;
  },
  get DATA_DIR() {
    return roots.data;
  },
  CONFIG_FILE: '',
  ENV_FILE: '',
  IS_DEV: false,
  SYSTEM_PROMPT_FILE: '',
}));

vi.mock('../../logger', () => ({
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
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

// The default marketplaces and plugins of this test (mergeDefaults reads them on every pass).
vi.mock('../defaults', () => ({
  DEFAULT_MARKETPLACES: defaults.marketplaces,
  DEFAULT_PLUGINS: defaults.plugins,
  isDefaultPlugin: (ref: string) => defaults.plugins.includes(ref),
  isDefaultMarketplace: (name: string) => defaults.marketplaces.some((m) => m.name === name),
}));

import { listAvailableSkills, resolveAutoskillContent, skillMdFile } from '../../skill-locator';
import { SkillForceHandler } from '../../slack/commands/skill-force-handler';
import { isAdmittedPluginName } from '../admitted-plugin-names';
import { PluginManager } from '../plugin-manager';
import type { PluginConfig } from '../types';
import { CRITICAL_PLUGIN, publishMarketplace, resetRemote } from './fake-marketplace';

const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const ACME = { name: 'acme-skills', repo: 'acme/acme-skills', ref: 'main' };
const OTHER = { name: 'other-skills', repo: 'acme/other-skills', ref: 'main' };
const ENV_REF = 'acme-env@acme-skills';
const ORDINARY_REF = 'acme-env@other-skills';

const WITH_ENV: PluginConfig = { marketplace: [ACME, OTHER], plugins: [ENV_REF], envPlugins: [ENV_REF] };
const COLLIDING: PluginConfig = { marketplace: [ACME, OTHER], plugins: [ENV_REF, ORDINARY_REF], envPlugins: [ENV_REF] };
const NOTHING: PluginConfig = { marketplace: [ACME, OTHER] };

/** A bundled zworkflow skill: served from the bundle (`local`), never from PLUGINS_DIR. */
const BUNDLED_SKILL = 'UIAskUserQuestion';

function skillFile(plugin: string, skill: string): string {
  return path.join(roots.plugins, plugin, 'skills', skill, 'SKILL.md');
}

/** Make removing `<plugin>/skills/<skill>` fail: its directory is read-only. */
function lockSkillDir(plugin: string, skill: string): void {
  fs.chmodSync(path.dirname(skillFile(plugin, skill)), 0o555);
}

function chmodTree(dir: string, mode: number): void {
  if (!fs.existsSync(dir)) return;
  fs.chmodSync(dir, mode);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodTree(path.join(dir, entry.name), mode);
  }
}

function listed(locator: { listAvailableSkills: typeof listAvailableSkills } = { listAvailableSkills }): string[] {
  return locator.listAvailableSkills('U1').map((s) => `${s.source}:${s.name}`);
}

async function pass(config: PluginConfig): Promise<PluginManager> {
  const mgr = new PluginManager(config, roots.plugins);
  await mgr.initialize();
  return mgr;
}

describe.skipIf(RUNNING_AS_ROOT)('PLUGINS_DIR is served only for admitted plugin names', () => {
  let tmp: string;
  const say = vi.fn().mockResolvedValue({ ts: '1' });
  const handler = new SkillForceHandler(() => null, {});
  const ctx = (text: string) => ({ user: 'U1', channel: 'C1', threadTs: '171.1', text, say });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admitted-names-'));
    roots.plugins = path.join(tmp, 'plugins');
    roots.data = path.join(tmp, 'data');
    fs.mkdirSync(roots.data, { recursive: true });
    logs.error.length = 0;
    say.mockClear();
    defaults.marketplaces.length = 0;
    defaults.plugins.length = 0;
    resetRemote();
    publishMarketplace(ACME.repo, 'a'.repeat(40), {
      'acme-env': { ...CRITICAL_PLUGIN, 'skills/post-deploy/SKILL.md': '# RECORDED acme-env post-deploy\n' },
    });
    publishMarketplace(OTHER.repo, 'd'.repeat(40), {
      'acme-env': { 'skills/post-deploy/SKILL.md': '# clean acme-env post-deploy\n' },
      'acme-tools': { 'skills/greet/SKILL.md': '# acme-tools greet\n' },
      stv: { 'skills/new-task/SKILL.md': '# stv new-task\n' },
    });
    await pass(NOTHING); // every test starts from a pass that admits nothing
  });

  afterEach(() => {
    chmodTree(tmp, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('control: resolved plugins are served — configured, default and priority-slot (stv)', async () => {
    defaults.marketplaces.push(OTHER);
    defaults.plugins.push('stv@other-skills'); // a default plugin in a priority slot, via mergeDefaults

    await pass({ marketplace: [OTHER], plugins: ['acme-tools@other-skills'] });

    expect(listed()).toEqual(expect.arrayContaining(['acme-tools:greet', 'stv:new-task']));
    expect(resolveAutoskillContent('new-task', 'U1')).toMatchObject({ key: 'stv:new-task' });
    expect(resolveAutoskillContent('greet', 'U1')).toMatchObject({ key: 'acme-tools:greet' });
    expect(skillMdFile({ name: 'greet', source: 'acme-tools' }, 'U1')).toBe(skillFile('acme-tools', 'greet'));
    expect(handler.canHandle('$new-task', 'U1')).toBe(true);
    expect(handler.canHandle('$greet', 'U1')).toBe(true);
    expect((await handler.execute(ctx('$acme-tools:greet'))).continueWithPrompt).toContain('# acme-tools greet');
  });

  it('forceRefresh and rollback publish their own pass (both end in rebuildResolved)', async () => {
    const tools: PluginConfig = { marketplace: [OTHER], plugins: ['acme-tools@other-skills'] };
    await pass(tools);
    expect(listed()).toContain('acme-tools:greet');

    await new PluginManager(NOTHING, roots.plugins).forceRefresh(); // the ref is gone from config
    expect(listed()).not.toContain('acme-tools:greet');

    publishMarketplace(OTHER.repo, 'f'.repeat(40), { 'acme-tools': { 'skills/greet/SKILL.md': '# greet v2\n' } });
    const mgr = new PluginManager(tools, roots.plugins);
    await mgr.forceRefresh(); // updates to v2, backing up v1
    expect(resolveAutoskillContent('greet', 'U1')?.content).toBe('# greet v2\n');
    await new PluginManager(NOTHING, roots.plugins).forceRefresh();
    expect(listed()).not.toContain('acme-tools:greet');

    expect((await mgr.rollback('acme-tools@other-skills')).success).toBe(true);
    expect(resolveAutoskillContent('greet', 'U1')?.content).toBe('# acme-tools greet\n');
  });

  it('bundled plugins (zworkflow, local) are served from the bundle with nothing admitted', async () => {
    expect(listed()).toContain(`local:${BUNDLED_SKILL}`);
    expect(resolveAutoskillContent(BUNDLED_SKILL, 'U1')).toMatchObject({ key: `local:${BUNDLED_SKILL}` });
    expect(handler.canHandle(`$${BUNDLED_SKILL}`, 'U1')).toBe(true);
  });

  it('(a) collision cleared after a successful deletion: reinstalled through admission, then served', async () => {
    await pass(WITH_ENV);
    await pass(COLLIDING); // deletion succeeds
    expect(fs.existsSync(path.join(roots.plugins, 'acme-env'))).toBe(false);
    expect(listed()).not.toContain('acme-env:post-deploy');

    await pass({ marketplace: [ACME, OTHER], plugins: [ORDINARY_REF] }); // env ref and marker removed

    expect(listed()).toContain('acme-env:post-deploy');
    expect(resolveAutoskillContent('post-deploy', 'U1')?.content).toBe('# clean acme-env post-deploy\n');
  });

  it('(b) collision cleared while the leftover remains and no ref is configured: not served', async () => {
    await pass(WITH_ENV);
    lockSkillDir('acme-env', 'post-deploy');
    await pass(COLLIDING); // deletion fails
    expect(fs.existsSync(skillFile('acme-env', 'post-deploy'))).toBe(true);
    expect(
      logs.error.some(
        (l) => l.startsWith('Could not remove') && l.includes(JSON.stringify(path.join(roots.plugins, 'acme-env'))),
      ),
    ).toBe(true);
    expect(listed()).not.toContain('acme-env:post-deploy');

    await pass(NOTHING); // the collision is gone from config, and so is every ref of the name

    expect(fs.existsSync(skillFile('acme-env', 'post-deploy'))).toBe(true);
    expect(listed()).not.toContain('acme-env:post-deploy');
    expect(resolveAutoskillContent('post-deploy', 'U1')).toBeNull();
    expect(handler.canHandle('$post-deploy', 'U1')).toBe(false);
    const result = await handler.execute(ctx('$acme-env:post-deploy'));
    expect(JSON.stringify([result, say.mock.calls])).not.toContain('RECORDED');
  });

  it('(c) restart with leftovers on disk: nothing from PLUGINS_DIR is served until a pass admits it', async () => {
    // Leftovers an earlier process left: a non-priority plugin and a priority-slot one, no meta.
    for (const [plugin, skill] of [
      ['acme-tools', 'greet'],
      ['stv', 'new-task'],
    ]) {
      fs.mkdirSync(path.dirname(skillFile(plugin, skill)), { recursive: true });
      fs.writeFileSync(skillFile(plugin, skill), `# STALE ${plugin} ${skill}\n`);
    }
    vi.resetModules(); // a new process: every module, the admitted set included, starts fresh
    const locator = await import('../../skill-locator');
    const { SkillForceHandler: FreshHandler } = await import('../../slack/commands/skill-force-handler');
    const { PluginManager: FreshManager } = await import('../plugin-manager');
    const fresh = new FreshHandler(() => null, {});

    expect(listed(locator)).not.toEqual(expect.arrayContaining(['acme-tools:greet']));
    expect(listed(locator)).not.toContain('stv:new-task');
    expect(locator.resolveAutoskillContent('greet', 'U1')).toBeNull();
    expect(locator.resolveAutoskillContent('new-task', 'U1')).toBeNull();
    expect(locator.skillMdFile({ name: 'greet', source: 'acme-tools' }, 'U1')).toBeNull();
    expect(locator.skillMdFile({ name: 'new-task', source: 'stv' }, 'U1')).toBeNull();
    expect(fresh.canHandle('$greet', 'U1')).toBe(false);
    expect(fresh.canHandle('$new-task', 'U1')).toBe(false);
    const refused = await fresh.execute(ctx('$acme-tools:greet'));
    expect(JSON.stringify([refused, say.mock.calls])).not.toContain('STALE');

    await new FreshManager({ marketplace: [OTHER], plugins: ['acme-tools@other-skills'] }, roots.plugins).initialize();

    expect(listed(locator)).toContain('acme-tools:greet');
    expect(locator.resolveAutoskillContent('greet', 'U1')?.content).toBe('# acme-tools greet\n'); // reinstalled
    expect(listed(locator)).not.toContain('stv:new-task'); // still not configured
  });

  it('(d) a recorded env install whose cleanup failed, then both refs and the env marker removed: not served', async () => {
    await pass(WITH_ENV);
    expect(listed()).toContain('acme-env:post-deploy');
    lockSkillDir('acme-env', 'post-deploy');

    // The env marker goes: the recorded content is gated in block mode, blocked, and its removal fails.
    await pass({ marketplace: [ACME, OTHER], plugins: [ENV_REF] });
    expect(fs.existsSync(skillFile('acme-env', 'post-deploy'))).toBe(true);
    expect(
      logs.error.some(
        (l) =>
          l.startsWith('Could not remove a plugin blocked by the security scan') &&
          l.includes(JSON.stringify(path.join(roots.plugins, 'acme-env'))),
      ),
    ).toBe(true);
    expect(listed()).not.toContain('acme-env:post-deploy');

    await pass(NOTHING); // and both refs go
    expect(listed()).not.toContain('acme-env:post-deploy');

    vi.resetModules(); // and the host restarts
    const locator = await import('../../skill-locator');
    expect(listed(locator)).not.toContain('acme-env:post-deploy');
    expect(locator.resolveAutoskillContent('post-deploy', 'U1')).toBeNull();
  });

  it('rollback to a recorded backup outside record mode fails when the blocked restore cannot be removed', async () => {
    await pass(WITH_ENV); // v1: CRITICAL, recorded
    publishMarketplace(ACME.repo, 'b'.repeat(40), {
      'acme-env': { ...CRITICAL_PLUGIN, 'skills/post-deploy/SKILL.md': '# RECORDED v2\n' },
    });
    await new PluginManager(WITH_ENV, roots.plugins).forceRefresh(); // v2 installed, v1 backed up
    const backups = path.join(roots.plugins, '.backups', 'acme-env');
    const [v1] = fs.readdirSync(backups);
    // The restored copy of v1 will hold a read-only skill dir: the gate's removal of it fails.
    fs.chmodSync(path.join(backups, v1, 'plugin', 'skills', 'post-deploy'), 0o555);

    const plain = new PluginManager({ marketplace: [ACME, OTHER], plugins: [ENV_REF] }, roots.plugins); // marker gone
    const result = await plain.rollback(ENV_REF);

    expect(fs.existsSync(skillFile('acme-env', 'post-deploy'))).toBe(true); // the blocked restore survived on disk
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/security scan/i);
    expect(plain.getResolvedPlugins()).toEqual([]);
    expect(isAdmittedPluginName('acme-env')).toBe(false);
    expect(listed()).not.toContain('acme-env:post-deploy');
    expect(resolveAutoskillContent('post-deploy', 'U1')).toBeNull();
  });
});
