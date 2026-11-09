import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_DIR } from '../env-paths';
import {
  checkEnvPluginMcpAccess,
  checkEnvSkillAccess,
  checkEnvSkillPermission,
  ENV_SKILL_UNNAMED,
  type EnvSkillRegistry,
  envPluginDirectories,
  envPluginNamesFromConfig,
  envPluginsOfMcpTool,
  envSkillExists,
  envSkillRegistry,
  envSkillSandboxDenyRead,
  resolveEnvSkillKey,
} from '../env-skill-registry';
import {
  addThreadGrant,
  ENV_SKILL_GRANT_OWNER,
  grantAllSkills,
  grantSkill,
  isEnvSkillUseAllowed,
  isSkillUseAllowed,
  loadGrants,
} from '../user-skill-grants-store';

/**
 * Environment skills: which skill ids count, and which grants let a non-admin run one. The
 * grants come from the single skill-grant store under the reserved `ENV_SKILL_GRANT_OWNER`.
 */
describe('env-skill-registry', () => {
  let pluginsDir: string;
  let registry: EnvSkillRegistry;
  const thread = { channel: 'C1', threadTs: '171.1' };

  function writeSkill(plugin: string, skill: string): void {
    const dir = path.join(pluginsDir, plugin, 'skills', skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${skill}`);
  }

  beforeEach(() => {
    pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-skill-plugins-'));
    writeSkill('acme-env', 'post-deploy');
    writeSkill('acme-env', 'staging-qa');
    writeSkill('stv', 'new-task');
    registry = { pluginNames: new Set(['acme-env']), pluginsDir };
    fs.rmSync(path.join(DATA_DIR, 'env-skill-grants.json'), { force: true });
  });

  afterEach(() => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
  });

  describe('resolveEnvSkillKey', () => {
    it('keys a qualified skill of an environment plugin, even one with no file (fail closed)', () => {
      expect(resolveEnvSkillKey('acme-env:post-deploy', registry)).toBe('acme-env:post-deploy');
      expect(resolveEnvSkillKey('acme-env:no-such-skill', registry)).toBe('acme-env:no-such-skill');
      expect(resolveEnvSkillKey('  acme-env:staging-qa ', registry)).toBe('acme-env:staging-qa');
    });

    it('keys a bare skill name an environment plugin ships', () => {
      expect(resolveEnvSkillKey('post-deploy', registry)).toBe('acme-env:post-deploy');
    });

    it('leaves every other skill alone', () => {
      expect(resolveEnvSkillKey('stv:new-task', registry)).toBeNull();
      expect(resolveEnvSkillKey('new-task', registry)).toBeNull();
      expect(resolveEnvSkillKey('zworkflow:deploy-qa', registry)).toBeNull();
      expect(resolveEnvSkillKey('', registry)).toBeNull();
      expect(resolveEnvSkillKey('../acme-env', registry)).toBeNull();
    });

    it('keys nothing on a host without environment plugins', () => {
      expect(resolveEnvSkillKey('acme-env:post-deploy', { pluginNames: new Set(), pluginsDir })).toBeNull();
      expect(envSkillRegistry(undefined, pluginsDir, path.join(pluginsDir, 'no-config.json')).pluginNames.size).toBe(0);
      expect(
        envSkillRegistry({ getEnvPluginNames: () => new Set(['acme-env']) }, pluginsDir).pluginNames.has('acme-env'),
      ).toBe(true);
    });
  });

  it('envSkillExists checks the skill file of an environment plugin', () => {
    expect(envSkillExists('acme-env:post-deploy', registry)).toBe(true);
    expect(envSkillExists('acme-env:gone', registry)).toBe(false);
    expect(envSkillExists('stv:new-task', registry)).toBe(false);
    expect(envSkillExists('no-colon', registry)).toBe(false);
  });

  describe('checkEnvSkillPermission', () => {
    it('denies an ungranted environment skill with its key, and passes everything else', () => {
      expect(checkEnvSkillPermission('acme-env:post-deploy', 'U1', thread, registry)).toBe('acme-env:post-deploy');
      expect(checkEnvSkillPermission('post-deploy', 'U1', thread, registry)).toBe('acme-env:post-deploy');
      expect(checkEnvSkillPermission('stv:new-task', 'U1', thread, registry)).toBeNull();
    });

    it('a per-skill grant ("항상 허용") lets that requester run that skill anywhere, nothing more', () => {
      grantSkill(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', 'U1');
      expect(checkEnvSkillPermission('acme-env:post-deploy', 'U1', { channel: 'C9' }, registry)).toBeNull();
      expect(checkEnvSkillPermission('acme-env:staging-qa', 'U1', thread, registry)).toBe('acme-env:staging-qa');
      expect(checkEnvSkillPermission('acme-env:post-deploy', 'U2', thread, registry)).toBe('acme-env:post-deploy');
    });

    it('an all-skills grant covers every environment skill for that requester', () => {
      grantAllSkills(ENV_SKILL_GRANT_OWNER, 'U1');
      expect(checkEnvSkillPermission('acme-env:post-deploy', 'U1', thread, registry)).toBeNull();
      expect(checkEnvSkillPermission('acme-env:staging-qa', 'U1', thread, registry)).toBeNull();
      expect(checkEnvSkillPermission('acme-env:staging-qa', 'U2', thread, registry)).toBe('acme-env:staging-qa');
    });

    it('a thread grant ("1회") holds in its thread only, for any number of calls, until it expires', () => {
      addThreadGrant(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', 'U1', thread);
      expect(checkEnvSkillPermission('acme-env:post-deploy', 'U1', thread, registry)).toBeNull();
      expect(checkEnvSkillPermission('acme-env:post-deploy', 'U1', thread, registry)).toBeNull();
      expect(
        checkEnvSkillPermission('acme-env:post-deploy', 'U1', { channel: 'C1', threadTs: '999.9' }, registry),
      ).toBe('acme-env:post-deploy');
      expect(checkEnvSkillPermission('acme-env:post-deploy', 'U2', thread, registry)).toBe('acme-env:post-deploy');

      addThreadGrant(ENV_SKILL_GRANT_OWNER, 'acme-env:staging-qa', 'U1', thread, Date.now() - 1);
      expect(checkEnvSkillPermission('acme-env:staging-qa', 'U1', thread, registry)).toBe('acme-env:staging-qa');
    });
  });

  // The SDK starts a plugin's MCP servers for every session and names their tools
  // `mcp__plugin_<plugin>_<server>__<tool>`, the plugin name as is (hyphens kept).
  describe('envPluginsOfMcpTool', () => {
    it('names the environment plugin an MCP tool belongs to', () => {
      expect(envPluginsOfMcpTool('mcp__plugin_acme-env_browser__probe', registry)).toEqual(['acme-env']);
      expect(envPluginsOfMcpTool('mcp__plugin_acme-env_a_b__c', registry)).toEqual(['acme-env']);
    });

    it('leaves the tools of other plugins, other MCP servers and native tools alone', () => {
      expect(envPluginsOfMcpTool('mcp__plugin_stv_srv__t', registry)).toEqual([]);
      expect(envPluginsOfMcpTool('mcp__github__create_pull_request', registry)).toEqual([]);
      expect(envPluginsOfMcpTool('mcp__acme-env__probe', registry)).toEqual([]);
      expect(envPluginsOfMcpTool('Read', registry)).toEqual([]);
      expect(envPluginsOfMcpTool('', registry)).toEqual([]);
      expect(
        envPluginsOfMcpTool('mcp__plugin_acme-env_browser__probe', { pluginNames: new Set(), pluginsDir }),
      ).toEqual([]);
    });

    it('matches the whole plugin name up to its `_` separator, never a shorter look-alike', () => {
      // `abc` is the environment plugin; `abc-def` is another plugin whose tools must stay open.
      const reg = { pluginNames: new Set(['abc']), pluginsDir };
      expect(envPluginsOfMcpTool('mcp__plugin_abc-def_srv__t', reg)).toEqual([]);
      expect(envPluginsOfMcpTool('mcp__plugin_abcdef_srv__t', reg)).toEqual([]);
      expect(envPluginsOfMcpTool('mcp__plugin_abc_srv__t', reg)).toEqual(['abc']);
      // Without a server segment there is no `_` after the name: not a tool of `abc`.
      expect(envPluginsOfMcpTool('mcp__plugin_abc', reg)).toEqual([]);
      // Names compare exactly, case included (the SDK keeps the name as is).
      expect(envPluginsOfMcpTool('mcp__plugin_ABC_srv__t', reg)).toEqual([]);
    });

    it('an ambiguous `_` split names every environment plugin it could be (fail closed)', () => {
      // `mcp__plugin_abc_def_srv__t` is plugin `abc` (server `def_srv`) or plugin `abc_def`
      // (server `srv`): both are named, and the caller needs a grant for each.
      const both = { pluginNames: new Set(['abc_def', 'abc']), pluginsDir };
      expect(envPluginsOfMcpTool('mcp__plugin_abc_def_srv__t', both)).toEqual(['abc', 'abc_def']);
      // A non-environment plugin `abc_def` next to the environment plugin `abc` cannot be told
      // apart from a tool of `abc`: its tools are gated with `abc`'s grant.
      const one = { pluginNames: new Set(['abc']), pluginsDir };
      expect(envPluginsOfMcpTool('mcp__plugin_abc_def_srv__t', one)).toEqual(['abc']);
    });
  });

  describe('checkEnvPluginMcpAccess (policy step 6d)', () => {
    const tool = 'mcp__plugin_acme-env_browser__probe';

    it('denies a tool of an environment plugin without a grant, with the plugin name; passes the rest', () => {
      expect(checkEnvPluginMcpAccess(tool, 'UMCP1', thread, registry)).toBe('acme-env');
      expect(checkEnvPluginMcpAccess('mcp__plugin_stv_srv__t', 'UMCP1', thread, registry)).toBeNull();
      expect(checkEnvPluginMcpAccess('mcp__github__get_issue', 'UMCP1', thread, registry)).toBeNull();
    });

    it('opens on a thread grant of any skill of that plugin, in that thread only', () => {
      addThreadGrant(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', 'UMCP2', thread);
      expect(checkEnvPluginMcpAccess(tool, 'UMCP2', thread, registry)).toBeNull();
      expect(checkEnvPluginMcpAccess(tool, 'UMCP2', { channel: 'C1', threadTs: '999.9' }, registry)).toBe('acme-env');
      expect(checkEnvPluginMcpAccess(tool, 'UMCP3', thread, registry)).toBe('acme-env');
    });

    it('an expired thread grant does not open it', () => {
      addThreadGrant(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', 'UMCP4', thread, Date.now() - 1);
      expect(checkEnvPluginMcpAccess(tool, 'UMCP4', thread, registry)).toBe('acme-env');
    });

    it('opens on a standing grant of one of its skills, or of all environment skills', () => {
      grantSkill(ENV_SKILL_GRANT_OWNER, 'acme-env:staging-qa', 'UMCP5');
      expect(checkEnvPluginMcpAccess(tool, 'UMCP5', { channel: 'C9' }, registry)).toBeNull();
      grantAllSkills(ENV_SKILL_GRANT_OWNER, 'UMCP6');
      expect(checkEnvPluginMcpAccess(tool, 'UMCP6', thread, registry)).toBeNull();
    });

    it('a grant of another plugin, or of a look-alike plugin name, does not open it', () => {
      const reg = { pluginNames: new Set(['abc', 'abc-def']), pluginsDir };
      addThreadGrant(ENV_SKILL_GRANT_OWNER, 'abc-def:qa', 'UMCP7', thread);
      expect(checkEnvPluginMcpAccess('mcp__plugin_abc_srv__t', 'UMCP7', thread, reg)).toBe('abc');
      expect(checkEnvPluginMcpAccess('mcp__plugin_abc-def_srv__t', 'UMCP7', thread, reg)).toBeNull();
    });

    it('an ambiguous name needs a grant for every environment plugin it could be', () => {
      const reg = { pluginNames: new Set(['abc', 'abc_def']), pluginsDir };
      addThreadGrant(ENV_SKILL_GRANT_OWNER, 'abc_def:qa', 'UMCP8', thread);
      expect(checkEnvPluginMcpAccess('mcp__plugin_abc_def_srv__t', 'UMCP8', thread, reg)).toBe('abc');
      addThreadGrant(ENV_SKILL_GRANT_OWNER, 'abc:qa', 'UMCP8', thread);
      expect(checkEnvPluginMcpAccess('mcp__plugin_abc_def_srv__t', 'UMCP8', thread, reg)).toBeNull();
    });
  });

  describe('checkEnvSkillAccess (policy step 6b)', () => {
    const skillDir = () => path.join(pluginsDir, 'acme-env', 'skills', 'post-deploy');
    const skillFile = () => path.join(skillDir(), 'SKILL.md');
    const otherSkillFile = () => path.join(pluginsDir, 'acme-env', 'skills', 'staging-qa', 'SKILL.md');
    const manifest = () => path.join(pluginsDir, 'acme-env', 'manifest-file');

    it('Skill: the named skill; a missing or non-string skill input fails closed', () => {
      expect(checkEnvSkillAccess('Skill', { skill: 'acme-env:post-deploy' }, 'UACCESS1', thread, registry)).toBe(
        'acme-env:post-deploy',
      );
      expect(checkEnvSkillAccess('Skill', { skill: 'stv:new-task' }, 'UACCESS1', thread, registry)).toBeNull();
      expect(checkEnvSkillAccess('Skill', {}, 'UACCESS1', thread, registry)).toBe(ENV_SKILL_UNNAMED);
      expect(checkEnvSkillAccess('Skill', { skill: 42 }, 'UACCESS1', thread, registry)).toBe(ENV_SKILL_UNNAMED);
      expect(checkEnvSkillAccess('Skill', { skill: '  ' }, 'UACCESS1', thread, registry)).toBe(ENV_SKILL_UNNAMED);
      // A host without environment plugins has nothing to protect.
      expect(checkEnvSkillAccess('Skill', {}, 'UACCESS1', thread, { pluginNames: new Set(), pluginsDir })).toBeNull();
    });

    it('Read/Grep/Glob of a skill directory need that skill grant; other plugin files need the all grant', () => {
      expect(checkEnvSkillAccess('Read', { file_path: skillFile() }, 'UACCESS2', thread, registry)).toBe(
        'acme-env:post-deploy',
      );
      expect(checkEnvSkillAccess('Grep', { pattern: 'x', path: skillDir() }, 'UACCESS2', thread, registry)).toBe(
        'acme-env:post-deploy',
      );
      expect(
        checkEnvSkillAccess(
          'Glob',
          { pattern: 'skills/*', path: path.join(pluginsDir, 'acme-env') },
          'UACCESS2',
          thread,
          registry,
        ),
      ).toBe('acme-env');
      expect(checkEnvSkillAccess('Glob', { pattern: `${skillDir()}/*` }, 'UACCESS2', thread, registry)).toBe(
        'acme-env:post-deploy',
      );

      addThreadGrant(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', 'UACCESS2', thread);
      expect(checkEnvSkillAccess('Read', { file_path: skillFile() }, 'UACCESS2', thread, registry)).toBeNull();
      expect(checkEnvSkillAccess('Read', { file_path: otherSkillFile() }, 'UACCESS2', thread, registry)).toBe(
        'acme-env:staging-qa',
      );
      expect(checkEnvSkillAccess('Read', { file_path: manifest() }, 'UACCESS2', thread, registry)).toBe('acme-env');
    });

    it('backups of an environment plugin count as the plugin itself', () => {
      const backup = path.join(
        pluginsDir,
        '.backups',
        'acme-env',
        'stamp',
        'plugin',
        'skills',
        'post-deploy',
        'SKILL.md',
      );
      expect(checkEnvSkillAccess('Read', { file_path: backup }, 'UACCESS3', thread, registry)).toBe('acme-env');
    });

    it('Bash: a command naming a path inside an environment plugin', () => {
      expect(checkEnvSkillAccess('Bash', { command: `cat ${skillFile()}` }, 'UACCESS4', thread, registry)).toBe(
        'acme-env:post-deploy',
      );
      expect(checkEnvSkillAccess('Bash', { command: 'ls /srv/x/plugins/acme-env' }, 'UACCESS4', thread, registry)).toBe(
        'acme-env',
      );
      expect(
        checkEnvSkillAccess('Bash', { command: 'cat /srv/x/plugins/acme-env2/a' }, 'UACCESS4', thread, registry),
      ).toBeNull();
      expect(checkEnvSkillAccess('Bash', { command: 'echo acme-env' }, 'UACCESS4', thread, registry)).toBeNull();
    });

    it('the all-environment-skills grant opens every file of every environment plugin', () => {
      grantAllSkills(ENV_SKILL_GRANT_OWNER, 'UACCESS5');
      expect(checkEnvSkillAccess('Read', { file_path: manifest() }, 'UACCESS5', thread, registry)).toBeNull();
      expect(checkEnvSkillAccess('Bash', { command: `cat ${skillFile()}` }, 'UACCESS5', thread, registry)).toBeNull();
    });

    it('everything outside the environment plugins passes', () => {
      const stvFile = path.join(pluginsDir, 'stv', 'skills', 'new-task', 'SKILL.md');
      expect(checkEnvSkillAccess('Read', { file_path: stvFile }, 'UACCESS6', thread, registry)).toBeNull();
      expect(checkEnvSkillAccess('Read', { file_path: '/tmp/U1/notes.txt' }, 'UACCESS6', thread, registry)).toBeNull();
      expect(checkEnvSkillAccess('Write', { file_path: '/tmp/U1/notes.txt' }, 'UACCESS6', thread, registry)).toBeNull();
      expect(
        checkEnvSkillAccess('Grep', { pattern: 'x', path: path.join(pluginsDir, 'stv') }, 'UACCESS6', thread, registry),
      ).toBeNull();
    });

    it('writing an environment plugin file is never granted (a grant runs a skill, it does not rewrite it)', () => {
      grantAllSkills(ENV_SKILL_GRANT_OWNER, 'UACCESS7');
      for (const tool of ['Write', 'Edit']) {
        expect(checkEnvSkillAccess(tool, { file_path: skillFile() }, 'UACCESS7', thread, registry)).toBe('acme-env');
      }
      expect(
        checkEnvSkillAccess(
          'NotebookEdit',
          { notebook_path: path.join(skillDir(), 'n.ipynb') },
          'UACCESS7',
          thread,
          registry,
        ),
      ).toBe('acme-env');
    });

    it('a scan of PLUGINS_DIR itself or a directory above it reaches every plugin', () => {
      expect(checkEnvSkillAccess('Grep', { pattern: '.', path: pluginsDir }, 'UACCESS8', thread, registry)).toBe(
        'acme-env',
      );
      expect(
        checkEnvSkillAccess('Grep', { pattern: '.', path: path.dirname(pluginsDir) }, 'UACCESS8', thread, registry),
      ).toBe('acme-env');
      expect(checkEnvSkillAccess('Grep', { pattern: '.', path: '/' }, 'UACCESS8', thread, registry)).toBe('acme-env');
      expect(
        checkEnvSkillAccess('Glob', { pattern: '*/skills/*/SKILL.md', path: pluginsDir }, 'UACCESS8', thread, registry),
      ).toBe('acme-env');
      // Without a path, Grep searches the working directory.
      expect(checkEnvSkillAccess('Grep', { pattern: '.' }, 'UACCESS8', thread, registry, pluginsDir)).toBe('acme-env');
      expect(checkEnvSkillAccess('Grep', { pattern: '.' }, 'UACCESS8', thread, registry, '/tmp/U1')).toBeNull();
    });

    it('a relative path resolves against the session working directory', () => {
      expect(
        checkEnvSkillAccess(
          'Read',
          { file_path: 'acme-env/skills/post-deploy/SKILL.md' },
          'UACCESS9',
          thread,
          registry,
          pluginsDir,
        ),
      ).toBe('acme-env:post-deploy');
    });

    it('a symbolic link from elsewhere into a plugin is caught as the OS resolves it', () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'env-skill-link-'));
      try {
        fs.symlinkSync(pluginsDir, path.join(elsewhere, 'p'));
        const viaLink = path.join(elsewhere, 'p', 'acme-env', 'skills', 'post-deploy', 'SKILL.md');
        expect(checkEnvSkillAccess('Read', { file_path: viaLink }, 'UACCESS10', thread, registry)).toBe(
          'acme-env:post-deploy',
        );
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });

  describe('OS-level read deny for a non-admin sandboxed Bash', () => {
    it('lists every environment plugin directory and its backups', () => {
      const dirs = envPluginDirectories(registry);
      expect(dirs).toContain(path.join(path.resolve(pluginsDir), 'acme-env'));
      expect(dirs).toContain(path.join(path.resolve(pluginsDir), '.backups', 'acme-env'));
      expect(dirs.some((d) => d.includes(`${path.sep}stv`))).toBe(false);
      expect(envSkillSandboxDenyRead(registry, 'USANDBOX1')).toEqual(dirs);
    });

    it('the all-environment-skills grant lifts it; a host without environment plugins has none', () => {
      grantAllSkills(ENV_SKILL_GRANT_OWNER, 'USANDBOX2');
      expect(envSkillSandboxDenyRead(registry, 'USANDBOX2')).toEqual([]);
      expect(envSkillSandboxDenyRead({ pluginNames: new Set(), pluginsDir }, 'USANDBOX1')).toEqual([]);
    });
  });

  it('falls back to the config file plugin.envPlugins list when there is no plugin manager', () => {
    const configFile = path.join(pluginsDir, 'host-config.json');
    fs.writeFileSync(configFile, JSON.stringify({ plugin: { envPlugins: ['acme-env@acme-env', 'bad ref', 7] } }));
    expect([...envPluginNamesFromConfig(configFile)]).toEqual(['acme-env']);
    expect(envSkillRegistry(undefined, pluginsDir, configFile).pluginNames.has('acme-env')).toBe(true);
    fs.writeFileSync(configFile, 'not json');
    expect(envPluginNamesFromConfig(configFile).size).toBe(0);
    expect(envPluginNamesFromConfig(path.join(pluginsDir, 'missing.json')).size).toBe(0);
  });

  describe('grant store under the reserved owner', () => {
    it('persists environment grants in DATA_DIR/env-skill-grants.json, apart from every user', () => {
      grantSkill(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', 'U1');
      const file = path.join(DATA_DIR, 'env-skill-grants.json');
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
        allowAll: [],
        perSkill: { 'acme-env:post-deploy': ['U1'] },
      });
      expect(loadGrants(ENV_SKILL_GRANT_OWNER).perSkill['acme-env:post-deploy']).toEqual(['U1']);
      expect(fs.existsSync(path.join(DATA_DIR, ENV_SKILL_GRANT_OWNER))).toBe(false);
    });

    it('the reserved owner can never be a requester, so the "own skill" shortcut never opens it', () => {
      expect(isSkillUseAllowed(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', 'U1')).toBe(false);
      expect(isEnvSkillUseAllowed('acme-env:post-deploy', 'U1')).toBe(false);
    });
  });
});
