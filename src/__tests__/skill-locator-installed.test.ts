/**
 * #1079 — `listInstalledSkills`: every installed skill of the built-in plugin dirs and of
 * PLUGINS_DIR, as (source, name) pairs — the settings page's 시스템 스킬 list. Unlike
 * `listAvailableSkills` a name two plugins ship is listed twice, and the environment plugins the
 * caller names are left out (their skills are 환경 스킬, gated).
 *
 * Real files in a scratch directory: the listing is a directory walk, so the test walks one.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let pluginsDir: string;

vi.mock('../env-paths', () => ({
  DATA_DIR: '/nonexistent-data',
  get PLUGINS_DIR() {
    return pluginsDir;
  },
}));

let root: string;

function skill(dir: string, name: string, body = `---\nname: ${name}\ndescription: ${name} skill\n---\n`): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), body);
}

describe('listInstalledSkills (#1079)', () => {
  let localA: string;
  let localB: string;

  beforeEach(async () => {
    // PluginManager admits what PLUGINS_DIR may serve (plugin/admitted-plugin-names); `blocked` stays on disk unadmitted.
    const { setAdmittedPluginNames } = await import('../plugin/admitted-plugin-names');
    setAdmittedPluginNames(['stv', 'envx']);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-installed-skills-'));
    pluginsDir = path.join(root, 'plugins');
    localA = path.join(root, 'local', 'skills');
    localB = path.join(root, 'local-harness', 'skills');
    skill(localA, 'zcheck');
    skill(localA, 'explore');
    skill(localB, 'auto-es');
    skill(path.join(pluginsDir, 'stv', 'skills'), 'explore');
    skill(path.join(pluginsDir, 'stv', 'skills'), 'debug');
    skill(path.join(pluginsDir, 'envx', 'skills'), 'post-deploy');
    // a backup of the environment plugin, and a stray dir without SKILL.md
    skill(path.join(pluginsDir, '.backups', 'skills'), 'post-deploy');
    fs.mkdirSync(path.join(pluginsDir, 'stv', 'skills', 'no-skill-md'), { recursive: true });
    // a plugin PluginManager did not admit (refused, blocked, or dropped from config) whose files stayed behind
    skill(path.join(pluginsDir, 'blocked', 'skills'), 'evil');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists every (source, name) pair — a name two sources ship appears under each', async () => {
    const { listInstalledSkills } = await import('../skill-locator');
    const list = listInstalledSkills({ localDirs: [localA, localB] });
    expect(list.map((s) => `${s.source}:${s.name}`)).toEqual([
      'local:explore',
      'local:zcheck',
      'local:auto-es',
      'envx:post-deploy',
      'stv:debug',
      'stv:explore',
    ]);
    expect(list.find((s) => s.source === 'stv' && s.name === 'explore')?.file).toBe(
      path.join(pluginsDir, 'stv', 'skills', 'explore', 'SKILL.md'),
    );
  });

  it('leaves out the excluded plugins (environment plugins) and dot-directories such as .backups', async () => {
    const { listInstalledSkills } = await import('../skill-locator');
    const list = listInstalledSkills({ localDirs: [localA, localB], excludePlugins: new Set(['envx']) });
    expect(list.map((s) => s.source)).not.toContain('envx');
    expect(list.map((s) => s.source)).not.toContain('.backups');
    expect(list.some((s) => s.name === 'post-deploy')).toBe(false);
    expect(list.some((s) => s.name === 'no-skill-md')).toBe(false);
  });

  it('defaults to PLUGINS_DIR and the bundled local dirs; a missing directory lists nothing', async () => {
    const { listInstalledSkills } = await import('../skill-locator');
    const list = listInstalledSkills({ excludePlugins: ['envx'] });
    expect(list.filter((s) => s.source !== 'local').map((s) => `${s.source}:${s.name}`)).toEqual([
      'stv:debug',
      'stv:explore',
    ]);
    expect(listInstalledSkills({ pluginsDir: path.join(root, 'nope'), localDirs: [path.join(root, 'nope2')] })).toEqual(
      [],
    );
  });
});
