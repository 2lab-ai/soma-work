import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isSafeName, parsePluginRef, validateMarketplaceEntry, validatePluginConfig } from '../../plugin/config-parser';
import { applyEnvPlugins, mergeEnvPlugins, parseEnvPlugins, runCli } from '../apply-env-plugins';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

const ENV_LINE = 'runner-a|acme-env|acme/env-plugins@v1|acme-env,acme-extra';

describe('apply-env-plugins', () => {
  const tempDirs: string[] = [];

  function makeTarget(config?: unknown): { targetDir: string; configFile: string } {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-plugins-target-'));
    tempDirs.push(targetDir);
    const configFile = path.join(targetDir, 'config.json');
    if (config !== undefined) writeJson(configFile, config);
    return { targetDir, configFile };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('merge into config.json', () => {
    it('adds the marketplace and plugin refs of this runner only', () => {
      const original = {
        mcpServers: { jira: { type: 'sse', url: 'https://app.example.com/sse' } },
        plugin: {
          marketplace: [{ name: 'soma-work', repo: 'acme/app', ref: 'main' }],
          plugins: ['zworkflow@soma-work'],
          localOverrides: [],
        },
      };
      const { targetDir, configFile } = makeTarget(original);

      const result = applyEnvPlugins({
        targetDir,
        runnerLabel: 'runner-a',
        envPlugins: [ENV_LINE, 'runner-b|acme-other|acme/other-plugins|acme-other'].join('\n'),
      });

      expect(result.status).toBe('applied');
      expect(result.marketplaces).toBe(1);
      expect(result.pluginRefs).toBe(2);
      const written = readJson(configFile);
      expect(written.plugin).toEqual({
        marketplace: [
          { name: 'soma-work', repo: 'acme/app', ref: 'main' },
          { name: 'acme-env', repo: 'acme/env-plugins', ref: 'v1' },
        ],
        plugins: ['zworkflow@soma-work', 'acme-env@acme-env', 'acme-extra@acme-env'],
        localOverrides: [],
      });
      expect(written.mcpServers).toEqual(original.mcpServers);
      // Replaced in place: no backup, no temp file left behind.
      expect(fs.readdirSync(targetDir)).toEqual(['config.json']);
    });

    it('defaults the ref to main when the line gives none', () => {
      const { targetDir, configFile } = makeTarget({ plugin: {} });

      applyEnvPlugins({
        targetDir,
        runnerLabel: 'runner-a',
        envPlugins: 'runner-a|acme-env|acme/env-plugins|acme-env',
      });

      expect((readJson(configFile).plugin as { marketplace: unknown[] }).marketplace).toEqual([
        { name: 'acme-env', repo: 'acme/env-plugins', ref: 'main' },
      ]);
    });

    it('replaces a marketplace entry with the same name, in place, collapsing duplicates', () => {
      const { targetDir, configFile } = makeTarget({
        plugin: {
          marketplace: [
            { name: 'acme-env', repo: 'acme/old-plugins', ref: 'main' },
            { name: 'soma-work', repo: 'acme/app' },
            // The loader lets a later same-name entry win, so a stale duplicate
            // left behind would shadow the replacement.
            { name: 'acme-env', repo: 'acme/older-plugins', ref: 'v0' },
          ],
          plugins: [],
        },
      });

      applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE });

      expect((readJson(configFile).plugin as { marketplace: unknown[] }).marketplace).toEqual([
        { name: 'acme-env', repo: 'acme/env-plugins', ref: 'v1' },
        { name: 'soma-work', repo: 'acme/app' },
      ]);
    });

    it('never duplicates a plugin ref', () => {
      const { targetDir, configFile } = makeTarget({
        plugin: { marketplace: [], plugins: ['acme-env@acme-env'] },
      });

      applyEnvPlugins({
        targetDir,
        runnerLabel: 'runner-a',
        envPlugins: [
          'runner-a|acme-env|acme/env-plugins@v1|acme-env,acme-env',
          'runner-a|acme-env|acme/env-plugins@v1|acme-extra,acme-env',
        ].join('\n'),
      });

      expect((readJson(configFile).plugin as { plugins: string[] }).plugins).toEqual([
        'acme-env@acme-env',
        'acme-extra@acme-env',
      ]);
    });

    it('keeps every other key untouched, placeholders and key order included', () => {
      const original = {
        mcpServers: { tracker: { type: 'sse', url: '${TRACKER_URL}', headers: { Authorization: '${TRACKER_TOKEN}' } } },
        'claude.env': { FEATURE_FLAG: '1' },
        plugin: { localOverrides: ['/srv/qa-state/plugin'], marketplace: [], plugins: [] },
        agents: { reviewer: { model: 'opus' } },
        ui: { threadHeader: { blocks: [] } },
      };
      const { targetDir, configFile } = makeTarget(original);

      applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE });

      const written = readJson(configFile);
      expect(Object.keys(written)).toEqual(Object.keys(original));
      expect(Object.keys(written.plugin as object)).toEqual(['localOverrides', 'marketplace', 'plugins']);
      for (const key of ['mcpServers', 'claude.env', 'agents', 'ui'] as const) {
        expect(written[key]).toEqual(original[key]);
      }
      expect((written.plugin as { localOverrides: string[] }).localOverrides).toEqual(['/srv/qa-state/plugin']);
      // Serialized like saveConfig: two-space JSON, newline-terminated.
      expect(fs.readFileSync(configFile, 'utf8')).toBe(`${JSON.stringify(written, null, 2)}\n`);
    });

    it('creates config.json with only the plugin section when the target has none', () => {
      const { targetDir, configFile } = makeTarget();

      const result = applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE });

      expect(result.status).toBe('applied');
      expect(Object.keys(readJson(configFile))).toEqual(['plugin']);
      expect(fs.readdirSync(targetDir)).toEqual(['config.json']);
    });

    it('writes config.json owner-only (0600), like every other config writer', () => {
      const { targetDir, configFile } = makeTarget({});
      fs.chmodSync(configFile, 0o644);

      applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE });

      expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    });
  });

  describe('no-op cases', () => {
    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['comments and blanks only', '# runner|marketplace|owner/repo[@ref]|plugin\n\n   \n'],
    ])('does nothing when ENV_PLUGINS is %s', (_label, envPlugins) => {
      const { targetDir, configFile } = makeTarget({ plugin: { plugins: [] } });
      const before = fs.readFileSync(configFile, 'utf8');

      const result = applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins });

      expect(result.status).toBe('none-configured');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('does nothing when no line names this runner', () => {
      const { targetDir, configFile } = makeTarget({ plugin: { plugins: [] } });
      const before = fs.readFileSync(configFile, 'utf8');

      const result = applyEnvPlugins({ targetDir, runnerLabel: 'runner-z', envPlugins: ENV_LINE });

      expect(result.status).toBe('no-entries');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('does not rewrite a config that already carries the entries', () => {
      const { targetDir, configFile } = makeTarget({ plugin: {} });
      applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE });
      const before = fs.readFileSync(configFile, 'utf8');
      const inode = fs.statSync(configFile).ino;

      const result = applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE });

      expect(result.status).toBe('unchanged');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
      // Same inode: not even an identical rename-over.
      expect(fs.statSync(configFile).ino).toBe(inode);
    });
  });

  describe('malformed input', () => {
    it.each([
      ['too few fields', 'runner-a|acme-env|acme/env-plugins'],
      ['too many fields', 'runner-a|acme-env|acme/env-plugins|acme-env|extra'],
      ['an unsafe runner label', 'runner a|acme-env|acme/env-plugins|acme-env'],
      ['an unsafe marketplace name', 'runner-a|acme.env|acme/env-plugins|acme-env'],
      ['a repo without owner', 'runner-a|acme-env|env-plugins|acme-env'],
      ['a repo with extra path segments', 'runner-a|acme-env|acme/env/plugins|acme-env'],
      ['an empty ref', 'runner-a|acme-env|acme/env-plugins@|acme-env'],
      ['a ref that walks up', 'runner-a|acme-env|acme/env-plugins@../main|acme-env'],
      ['an empty plugin item', 'runner-a|acme-env|acme/env-plugins|acme-env,,acme-extra'],
      ['an unsafe plugin name', 'runner-a|acme-env|acme/env-plugins|acme/env'],
      ['no plugin at all', 'runner-a|acme-env|acme/env-plugins|'],
    ])('rejects %s and leaves config.json untouched', (_label, line) => {
      const { targetDir, configFile } = makeTarget({ plugin: { plugins: [] } });
      const before = fs.readFileSync(configFile, 'utf8');

      expect(() => applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: `# header\n${line}` })).toThrow(
        /line 2/,
      );
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('fails on a malformed line even when it belongs to another runner (a typo must be loud)', () => {
      const { targetDir } = makeTarget({});

      expect(() =>
        applyEnvPlugins({
          targetDir,
          runnerLabel: 'runner-a',
          envPlugins: [ENV_LINE, 'runner-b|acme-env|not-a-repo|acme-env'].join('\n'),
        }),
      ).toThrow(/line 2/);
    });

    it('rejects two lines that give the same runner and marketplace different sources', () => {
      expect(() => parseEnvPlugins([ENV_LINE, 'runner-a|acme-env|acme/env-plugins@v2|acme-extra'].join('\n'))).toThrow(
        /line 2/,
      );
    });

    it('never echoes the line, repo, marketplace, or plugin names in the error', () => {
      let message = '';
      try {
        parseEnvPlugins('runner-a|acme-env|acme-secret-repo|acme-env');
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/line 1/);
      for (const leaked of ['acme-secret-repo', 'acme-env', 'runner-a']) expect(message).not.toContain(leaked);
    });

    it.each([
      ['is not valid JSON', '{ "plugin": '],
      ['is not an object', '[]'],
      ['has a non-object plugin section', '{ "plugin": [] }'],
      ['has a non-array marketplace list', '{ "plugin": { "marketplace": {} } }'],
      ['has a non-array plugins list', '{ "plugin": { "plugins": "acme-env@acme-env" } }'],
    ])('refuses to touch a config.json that %s', (_label, raw) => {
      const { targetDir, configFile } = makeTarget();
      fs.writeFileSync(configFile, raw, 'utf8');

      expect(() => applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE })).toThrow();
      expect(fs.readFileSync(configFile, 'utf8')).toBe(raw);
      expect(fs.readdirSync(targetDir)).toEqual(['config.json']);
    });
  });

  // The deploy step runs this before `npm ci` on the target (sync-bundle wipes
  // node_modules and the bundle carries none), so the module cannot load the
  // real validators in src/plugin/config-parser.ts (they pull in the logger
  // package). It mirrors their rules instead, and these tests hold the mirror
  // to the real thing — the same arrangement as main-env-bootstrap's model list.
  describe('agreement with the plugin config validators', () => {
    it('writes a plugin section the loader keeps entry for entry', () => {
      const { targetDir, configFile } = makeTarget({
        plugin: {
          marketplace: [{ name: 'soma-work', repo: 'acme/app', ref: 'main' }],
          plugins: ['zworkflow@soma-work'],
        },
      });

      applyEnvPlugins({
        targetDir,
        runnerLabel: 'runner-a',
        envPlugins: [ENV_LINE, 'runner-a|acme_tools|acme/tools.plugins@release/1.2|acme_tools'].join('\n'),
      });

      const written = readJson(configFile).plugin as Record<string, unknown>;
      const validated = validatePluginConfig(written);
      expect(validated.marketplace).toEqual(written.marketplace);
      expect(validated.plugins).toEqual(written.plugins);
    });

    it.each([
      'acme-env',
      'acme_env',
      'ACME9',
      'acme.env',
      'acme env',
      'acme/env',
      'acme@env',
      '..',
    ])('accepts the marketplace and plugin name %j exactly when config-parser does', (name) => {
      const line = `runner-a|${name}|acme/env-plugins|${name}`;
      const acceptedHere = (() => {
        try {
          parseEnvPlugins(line);
          return true;
        } catch {
          return false;
        }
      })();

      expect(acceptedHere).toBe(isSafeName(name));
      expect(acceptedHere).toBe(parsePluginRef(`${name}@acme-env`) !== null);
    });

    it.each([
      'acme/app',
      'acme/env.plugins',
      'acme-labs/env_plugins',
    ])('only accepts repos (%j) that the marketplace validator accepts', (repo) => {
      const [line] = parseEnvPlugins(`runner-a|acme-env|${repo}|acme-env`);

      expect(validateMarketplaceEntry(line.marketplace)).toBe(true);
    });

    it('merges in memory without touching anything it was not given', () => {
      const config = { plugin: { plugins: ['zworkflow@soma-work'] }, other: { keep: true } };

      const merged = mergeEnvPlugins(config, parseEnvPlugins(ENV_LINE));

      expect(merged.changed).toBe(true);
      expect(merged.config.other).toBe(config.other);
      expect(config.plugin.plugins).toEqual(['zworkflow@soma-work']);
    });

    it('loads with node built-ins only (the deploy step has no node_modules yet)', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'apply-env-plugins.ts'), 'utf8');
      const specifiers = [
        ...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm),
        ...source.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g),
      ].map((match) => match[1]);

      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(builtinModules, specifier).toContain(specifier.replace(/^node:/, ''));
      }
    });
  });

  // The deploy step runs a check BEFORE `service.sh stop`, so input the real
  // apply would reject fails the deploy while the old service is still up.
  describe('check only (--check)', () => {
    it('computes the merge and writes nothing', () => {
      const { targetDir, configFile } = makeTarget({ plugin: { marketplace: [], plugins: [] } });
      fs.chmodSync(configFile, 0o644);
      const before = fs.readFileSync(configFile, 'utf8');

      const result = applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE, checkOnly: true });

      expect(result).toEqual({ status: 'applied', marketplaces: 1, pluginRefs: 2 });
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
      expect(fs.statSync(configFile).mode & 0o777).toBe(0o644);
      expect(fs.readdirSync(targetDir)).toEqual(['config.json']);
    });

    it('says unchanged when the entries are already there', () => {
      const { targetDir } = makeTarget({});
      applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE });

      const result = applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE, checkOnly: true });

      expect(result.status).toBe('unchanged');
    });

    it('accepts a target that does not exist yet (sync-bundle creates it)', () => {
      const missing = path.join(os.tmpdir(), `env-plugins-not-yet-${process.pid}`);
      fs.rmSync(missing, { recursive: true, force: true });

      const result = applyEnvPlugins({
        targetDir: missing,
        runnerLabel: 'runner-a',
        envPlugins: ENV_LINE,
        checkOnly: true,
      });

      expect(result.status).toBe('applied');
      expect(fs.existsSync(missing)).toBe(false);
    });

    it.each([
      ['a malformed line', ENV_LINE.replace('acme/env-plugins', 'not-a-repo'), '{}', 'runner-a'],
      ['a malformed line for another runner', `${ENV_LINE}\nrunner-b|acme-env|not-a-repo|acme-env`, '{}', 'runner-a'],
      ['no runner label', ENV_LINE, '{}', undefined],
      ['a config.json that is not JSON', ENV_LINE, '{ "plugin": ', 'runner-a'],
      ['a non-object plugin section', ENV_LINE, '{ "plugin": [] }', 'runner-a'],
    ])('fails on %s exactly like the real apply, writing nothing', (_label, envPlugins, raw, runnerLabel) => {
      const { targetDir, configFile } = makeTarget();
      fs.writeFileSync(configFile, raw, 'utf8');
      const options = { targetDir, runnerLabel, envPlugins };

      let checkError = '';
      try {
        applyEnvPlugins({ ...options, checkOnly: true });
      } catch (error) {
        checkError = (error as Error).message;
      }
      let applyError = '';
      try {
        applyEnvPlugins(options);
      } catch (error) {
        applyError = (error as Error).message;
      }

      expect(checkError).not.toBe('');
      expect(checkError).toBe(applyError);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(raw);
      expect(fs.readdirSync(targetDir)).toEqual(['config.json']);
    });
  });

  // Every non-mutating check the real apply makes on the destination also runs
  // under --check, with the same failure — otherwise a deploy passes the check,
  // stops the service, and only then fails.
  describe('destination checks: --check and apply agree', () => {
    type Arrange = (targetDir: string, configFile: string) => void;
    const cases: [string, Arrange][] = [
      [
        'config.json is a symlink',
        (targetDir, configFile) => {
          fs.writeFileSync(path.join(targetDir, 'elsewhere.json'), '{}', 'utf8');
          fs.symlinkSync(path.join(targetDir, 'elsewhere.json'), configFile);
        },
      ],
      ['config.json is a directory', (_targetDir, configFile) => fs.mkdirSync(configFile)],
      [
        'config.json is unreadable',
        (_targetDir, configFile) => {
          fs.writeFileSync(configFile, '{}', 'utf8');
          fs.chmodSync(configFile, 0o000);
        },
      ],
      [
        'the target directory is not writable',
        (targetDir, configFile) => {
          fs.writeFileSync(configFile, '{}', 'utf8');
          fs.chmodSync(targetDir, 0o555);
        },
      ],
    ];

    it.each(cases)('%s: both fail with the same message and nothing changes', (_label, arrange) => {
      const { targetDir, configFile } = makeTarget();
      arrange(targetDir, configFile);
      const listing = fs.readdirSync(targetDir).sort();
      const options = { targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE };

      const failure = (checkOnly: boolean): string => {
        try {
          applyEnvPlugins({ ...options, checkOnly });
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      };
      try {
        const checkError = failure(true);
        const applyError = failure(false);

        expect(checkError).not.toBe('');
        expect(checkError).toBe(applyError);
        expect(fs.readdirSync(targetDir).sort()).toEqual(listing);
      } finally {
        fs.chmodSync(targetDir, 0o700);
        if (fs.existsSync(configFile) && !fs.lstatSync(configFile).isSymbolicLink()) fs.chmodSync(configFile, 0o700);
      }
    });

    it('a target that is a regular file fails both ways', () => {
      const { targetDir } = makeTarget();
      const notADir = path.join(targetDir, 'plain-file');
      fs.writeFileSync(notADir, 'x', 'utf8');
      const options = { targetDir: notADir, runnerLabel: 'runner-a', envPlugins: ENV_LINE };

      expect(() => applyEnvPlugins({ ...options, checkOnly: true })).toThrow(/not a directory/);
      expect(() => applyEnvPlugins(options)).toThrow(/not a directory/);
    });

    it('ignores a leftover config.json.bak, even a planted symlink (no backup is written)', () => {
      const { targetDir, configFile } = makeTarget({});
      const bak = `${configFile}.bak`;
      fs.symlinkSync(path.join(targetDir, 'nowhere'), bak);
      const options = { targetDir, runnerLabel: 'runner-a', envPlugins: ENV_LINE };

      expect(applyEnvPlugins({ ...options, checkOnly: true }).status).toBe('applied');
      expect(applyEnvPlugins(options).status).toBe('applied');
      expect(fs.lstatSync(bak).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'nowhere'))).toBe(false);
    });
  });

  // The deploy step passes the channel's whole runner-label set (before any
  // manual `targets` narrowing); a line naming a label outside it is a typo.
  describe('channel runner labels', () => {
    const lines = [ENV_LINE, 'runner-b|acme-other|acme/other-plugins|acme-other'].join('\n');

    it('accepts lines whose labels are all in the set, including runners not deployed this run', () => {
      const { targetDir } = makeTarget({});

      const result = applyEnvPlugins({
        targetDir,
        runnerLabel: 'runner-a',
        envPlugins: lines,
        channelRunnerLabels: ['runner-a', 'runner-b'],
      });

      expect(result.status).toBe('applied');
    });

    it.each([true, false])('rejects a label outside the set by line number only (checkOnly=%s)', (checkOnly) => {
      const { targetDir, configFile } = makeTarget({});
      const before = fs.readFileSync(configFile, 'utf8');

      let message = '';
      try {
        applyEnvPlugins({
          targetDir,
          runnerLabel: 'runner-a',
          envPlugins: lines,
          channelRunnerLabels: ['runner-a', 'runner-c'],
          checkOnly,
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/^line 2: /);
      for (const leaked of ['runner-b', 'runner-c', 'acme']) expect(message).not.toContain(leaked);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('skips the label check when no set is given', () => {
      const { targetDir } = makeTarget({});

      expect(applyEnvPlugins({ targetDir, runnerLabel: 'runner-a', envPlugins: lines }).status).toBe('applied');
    });
  });

  describe('runCli', () => {
    // What the deploy step passes alongside ENV_PLUGINS (the channel's labels).
    const LABELS = { CHANNEL_RUNNER_LABELS: 'runner-a,runner-b' };

    function run(argv: string[], env: Record<string, string | undefined>): { code: number; out: string } {
      const lines: string[] = [];
      const code = runCli({ argv, env, log: (m) => lines.push(m), error: (m) => lines.push(m) });
      return { code, out: lines.join('\n') };
    }

    it('reports counts only on success', () => {
      const { targetDir } = makeTarget({});

      const { code, out } = run([targetDir], { ENV_PLUGINS: ENV_LINE, RUNNER_LABEL: 'runner-a', ...LABELS });

      expect(code).toBe(0);
      expect(out).toContain('1 marketplace');
      expect(out).toContain('2 plugin ref');
      for (const leaked of ['acme', 'runner-a', targetDir]) expect(out).not.toContain(leaked);
    });

    it('is a no-op success when nothing is configured', () => {
      const { targetDir } = makeTarget({});

      expect(run([targetDir], {}).code).toBe(0);
    });

    it('fails without a target argument', () => {
      expect(run([], { ENV_PLUGINS: ENV_LINE, RUNNER_LABEL: 'runner-a' }).code).toBe(1);
    });

    it('fails when entries exist but the runner label is unknown to the step', () => {
      const { targetDir } = makeTarget({});

      expect(run([targetDir], { ENV_PLUGINS: ENV_LINE, ...LABELS }).code).toBe(1);
    });

    it('fails on a malformed line with a neutral message', () => {
      const { targetDir } = makeTarget({});

      const { code, out } = run([targetDir], {
        ENV_PLUGINS: 'runner-a|acme-env|acme-secret-repo|acme-env',
        RUNNER_LABEL: 'runner-a',
      });

      expect(code).toBe(1);
      expect(out).toMatch(/line 1/);
      for (const leaked of ['acme', 'runner-a', targetDir]) expect(out).not.toContain(leaked);
    });

    it('fails without printing the path when the target directory is missing', () => {
      const missing = path.join(os.tmpdir(), 'env-plugins-missing-target-dir');

      const { code, out } = run([missing], { ENV_PLUGINS: ENV_LINE, RUNNER_LABEL: 'runner-a', ...LABELS });

      expect(code).toBe(1);
      expect(out).not.toContain(missing);
    });

    it('--check validates, prints counts, and leaves config.json alone', () => {
      const { targetDir, configFile } = makeTarget({});
      const before = fs.readFileSync(configFile, 'utf8');

      const { code, out } = run(['--check', targetDir], {
        ENV_PLUGINS: ENV_LINE,
        RUNNER_LABEL: 'runner-a',
        ...LABELS,
      });

      expect(code).toBe(0);
      expect(out).toContain('check ok');
      expect(out).toContain('1 marketplace');
      for (const leaked of ['acme', 'runner-a', targetDir]) expect(out).not.toContain(leaked);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('--check exits non-zero on a malformed line', () => {
      const { targetDir } = makeTarget({});

      const { code, out } = run(['--check', targetDir], {
        ENV_PLUGINS: 'runner-a|acme-env|acme-secret-repo|acme-env',
        RUNNER_LABEL: 'runner-a',
      });

      expect(code).toBe(1);
      expect(out).toMatch(/line 1/);
      expect(out).not.toContain('acme');
    });

    // The library option stays optional for direct callers; the CLI is the deploy
    // step, where a missing label set is a wiring fault, not "skip the check".
    it.each([
      ['unset', ['--check'], undefined],
      ['empty', ['--check'], ''],
      ['unset (apply)', [], undefined],
      ['blank (apply)', [], ' , '],
    ])('fails closed when the channel label set is %s but entries exist', (_label, flags, labels) => {
      const { targetDir, configFile } = makeTarget({});
      const before = fs.readFileSync(configFile, 'utf8');

      const { code, out } = run([...flags, targetDir], {
        ENV_PLUGINS: ENV_LINE,
        RUNNER_LABEL: 'runner-a',
        CHANNEL_RUNNER_LABELS: labels,
      });

      expect(code).toBe(1);
      expect(out).toContain('runner label set missing');
      for (const leaked of ['acme', 'runner-a', targetDir]) expect(out).not.toContain(leaked);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('needs no label set when nothing is configured', () => {
      const { targetDir } = makeTarget({});

      expect(run(['--check', targetDir], { ENV_PLUGINS: '# nothing yet\n' }).code).toBe(0);
      expect(run([targetDir], {}).code).toBe(0);
    });

    it('--check fails on a line whose runner label is not one of the channel', () => {
      const { targetDir } = makeTarget({});

      const { code, out } = run(['--check', targetDir], {
        ENV_PLUGINS: `${ENV_LINE}\nrunner-typo|acme-env|acme/env-plugins|acme-env`,
        RUNNER_LABEL: 'runner-a',
        CHANNEL_RUNNER_LABELS: 'runner-a,runner-b',
      });

      expect(code).toBe(1);
      expect(out).toMatch(/line 2/);
      for (const leaked of ['runner-typo', 'runner-b', 'acme']) expect(out).not.toContain(leaked);
    });

    it.each([
      [['--check']],
      [['--bogus', '/srv/qa-state']],
      [['/srv/qa-state', 'extra']],
    ])('rejects the argument list %j with a usage error', (argv) => {
      const { code, out } = run(argv, { ENV_PLUGINS: ENV_LINE, RUNNER_LABEL: 'runner-a' });

      expect(code).toBe(1);
      expect(out).toContain('usage');
    });
  });
});
