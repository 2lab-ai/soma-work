import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INVALID_DOMAINS,
  INVALID_PATHS,
  INVALID_USERS,
  VALID_DOMAINS,
  VALID_PATHS,
  VALID_USERS,
} from '../../sandbox/__tests__/deploy-sandbox-cases';
import { loadDeploySandboxGrant } from '../../sandbox/deploy-sandbox-grant';
import {
  applyDeploySandbox,
  DeploySandboxError,
  mergeDeploySandbox,
  parseDeploySandbox,
  runCli,
} from '../apply-deploy-sandbox';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

const LINE_A = 'runner-a|UAPPROVED1|qa.example.test,admin.qa.example.test|/srv/qa/lock,/srv/qa/runs';
const LINE_B = 'runner-b|WAPPROVED2|qa-b.example.test|/srv/qa-b/lock';
const GRANT_A = {
  users: ['UAPPROVED1'],
  allowedDomains: ['qa.example.test', 'admin.qa.example.test'],
  allowWrite: ['/srv/qa/lock', '/srv/qa/runs'],
};

describe('apply-deploy-sandbox', () => {
  const tempDirs: string[] = [];

  function makeTarget(config?: unknown): { targetDir: string; configFile: string } {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-sandbox-target-'));
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

  describe('parse', () => {
    it('reads every line, comments and blanks ignored', () => {
      expect(parseDeploySandbox(`# header\n\n${LINE_A}\n  ${LINE_B}  \n`)).toEqual([
        { line: 3, runnerLabel: 'runner-a', ...GRANT_A },
        {
          line: 4,
          runnerLabel: 'runner-b',
          users: ['WAPPROVED2'],
          allowedDomains: ['qa-b.example.test'],
          allowWrite: ['/srv/qa-b/lock'],
        },
      ]);
    });

    it('allows the domain and path fields to be empty', () => {
      expect(parseDeploySandbox('runner-a|UAPPROVED1||')).toEqual([
        { line: 1, runnerLabel: 'runner-a', users: ['UAPPROVED1'], allowedDomains: [], allowWrite: [] },
      ]);
      expect(parseDeploySandbox('runner-a|UAPPROVED1,WAPPROVED2||/srv/qa/state')[0]).toMatchObject({
        users: ['UAPPROVED1', 'WAPPROVED2'],
        allowedDomains: [],
        allowWrite: ['/srv/qa/state'],
      });
    });

    it('trims items and drops in-line duplicates', () => {
      expect(
        parseDeploySandbox('runner-a| UAPPROVED1 , UAPPROVED1 |qa.example.test, qa.example.test|/srv/qa/state'),
      ).toEqual([
        {
          line: 1,
          runnerLabel: 'runner-a',
          users: ['UAPPROVED1'],
          allowedDomains: ['qa.example.test'],
          allowWrite: ['/srv/qa/state'],
        },
      ]);
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['comments and blanks only', '# runner-label|user[,user...]|domain[,domain...]|path[,path...]\n\n   \n'],
    ])('is empty when DEPLOY_SANDBOX is %s', (_label, raw) => {
      expect(parseDeploySandbox(raw)).toEqual([]);
    });
  });

  describe('malformed input', () => {
    it.each([
      ['too few fields', 'runner-a|UAPPROVED1|qa.example.test'],
      ['too many fields', 'runner-a|UAPPROVED1|qa.example.test|/srv/qa/state|extra'],
      ['an empty runner label', '|UAPPROVED1|qa.example.test|/srv/qa/state'],
      ['an unsafe runner label', 'runner a|UAPPROVED1|qa.example.test|/srv/qa/state'],
      ['an empty user field', 'runner-a||qa.example.test|/srv/qa/state'],
      ['an empty user item', 'runner-a|UAPPROVED1,,WAPPROVED2|qa.example.test|/srv/qa/state'],
      ['an empty domain item', 'runner-a|UAPPROVED1|qa.example.test,|/srv/qa/state'],
      ['an empty path item', 'runner-a|UAPPROVED1|qa.example.test|,/srv/qa/state'],
      ['a lowercase user', 'runner-a|uapproved1|qa.example.test|/srv/qa/state'],
      ['a URL for a domain', 'runner-a|UAPPROVED1|https://qa.example.test|/srv/qa/state'],
      ['an IP literal', 'runner-a|UAPPROVED1|10.0.0.1|/srv/qa/state'],
      ['a wildcard domain', 'runner-a|UAPPROVED1|*.qa.example.test|/srv/qa/state'],
      ['a two-component path', 'runner-a|UAPPROVED1|qa.example.test|/srv/qa'],
      ['a path above a forbidden root', 'runner-a|UAPPROVED1|qa.example.test|/private'],
      ['a home directory itself', 'runner-a|UAPPROVED1|qa.example.test|/Users/someone'],
      ['a relative path', 'runner-a|UAPPROVED1|qa.example.test|srv/qa'],
      ['a path under /tmp', 'runner-a|UAPPROVED1|qa.example.test|/tmp/qa'],
      ['a path that walks up', 'runner-a|UAPPROVED1|qa.example.test|/srv/qa/../etc'],
      ['the root path', 'runner-a|UAPPROVED1|qa.example.test|/'],
    ])('rejects %s and leaves config.json untouched', (_label, line) => {
      const { targetDir, configFile } = makeTarget({ deploySandbox: GRANT_A });
      const before = fs.readFileSync(configFile, 'utf8');

      expect(() =>
        applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: `# header\n${line}` }),
      ).toThrow(/line 2/);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('fails on a malformed line even when it belongs to another runner (a typo must be loud)', () => {
      const { targetDir } = makeTarget({});

      expect(() =>
        applyDeploySandbox({
          targetDir,
          runnerLabel: 'runner-a',
          deploySandbox: [LINE_A, 'runner-b|WAPPROVED2|https://qa-b.example.test|/srv/qa-b/state'].join('\n'),
        }),
      ).toThrow(/line 2/);
    });

    it('never echoes the line, user, domain, path, or runner in the error', () => {
      let message = '';
      try {
        parseDeploySandbox('runner-secret|UAPPROVED1|qa.example.test|/tmp/leaked-path');
      } catch (error) {
        // The class runCli prints verbatim; any other error is reduced to its code.
        expect(error).toBeInstanceOf(DeploySandboxError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/^line 1: field 4/);
      for (const leaked of ['runner-secret', 'UAPPROVED1', 'qa.example', '/tmp', 'leaked-path']) {
        expect(message).not.toContain(leaked);
      }
    });

    it.each([
      ['is not valid JSON', '{ "plugin": '],
      ['is not an object', '[]'],
    ])('refuses to touch a config.json that %s', (_label, raw) => {
      const { targetDir, configFile } = makeTarget();
      fs.writeFileSync(configFile, raw, 'utf8');

      expect(() => applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_A })).toThrow();
      expect(fs.readFileSync(configFile, 'utf8')).toBe(raw);
      expect(fs.readdirSync(targetDir)).toEqual(['config.json']);
    });
  });

  // The runtime loader drops what it cannot use; the deploy step must never
  // write a value the loader would then drop. Both run the same value tables.
  describe('agreement with the runtime loader', () => {
    function lineAccepted(line: string): boolean {
      try {
        parseDeploySandbox(line);
        return true;
      } catch {
        return false;
      }
    }

    it.each(VALID_USERS)('accepts the user %j', (value) => {
      expect(lineAccepted(`runner-a|${value}||/srv/qa/state`)).toBe(true);
    });
    it.each(INVALID_USERS.filter((value) => value !== '' && !value.includes(',')))('rejects the user %j', (value) => {
      expect(lineAccepted(`runner-a|${value}||/srv/qa/state`)).toBe(false);
    });
    it.each(VALID_DOMAINS)('accepts the domain %j', (value) => {
      expect(lineAccepted(`runner-a|UAPPROVED1|${value}|`)).toBe(true);
    });
    it.each(
      INVALID_DOMAINS.filter((value) => value !== '' && !value.includes('|')),
    )('rejects the domain %j', (value) => {
      expect(lineAccepted(`runner-a|UAPPROVED1|${value}|`)).toBe(false);
    });
    it.each(VALID_PATHS)('accepts the path %j', (value) => {
      expect(lineAccepted(`runner-a|UAPPROVED1||${value}`)).toBe(true);
    });
    it.each(
      INVALID_PATHS.filter((value) => value !== '' && !/[\n|]/.test(value) && value.trim() === value),
    )('rejects the path %j', (value) => {
      expect(lineAccepted(`runner-a|UAPPROVED1||${value}`)).toBe(false);
    });

    it('writes a grant the runtime loader keeps entry for entry, without a warning', () => {
      const { targetDir, configFile } = makeTarget({});
      applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_A });

      const logger = { warn: vi.fn() };
      expect(loadDeploySandboxGrant(configFile, logger)).toEqual(readJson(configFile).deploySandbox);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('loads with node built-ins only, through every relative import (the deploy step has no node_modules yet)', () => {
      const seen = new Set<string>();
      const bare: string[] = [];
      const visit = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        const source = fs.readFileSync(file, 'utf8');
        const specifiers = [
          ...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm),
          ...source.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g),
        ].map((match) => match[1]);
        for (const specifier of specifiers) {
          if (specifier.startsWith('.')) visit(`${path.resolve(path.dirname(file), specifier)}.ts`);
          else bare.push(specifier);
        }
      };
      visit(path.join(__dirname, '..', 'apply-deploy-sandbox.ts'));

      expect(seen.size).toBeGreaterThan(1);
      expect(bare.length).toBeGreaterThan(0);
      for (const specifier of bare) {
        expect(builtinModules, specifier).toContain(specifier.replace(/^node:/, ''));
      }
    });
  });

  describe('write into config.json', () => {
    it('sets deploySandbox from this runner only, keeping every other key and its order', () => {
      const original = {
        mcpServers: { tracker: { type: 'sse', url: '${TRACKER_URL}' } },
        plugin: { marketplace: [], plugins: [] },
        ui: { threadHeader: { blocks: [] } },
      };
      const { targetDir, configFile } = makeTarget(original);

      const result = applyDeploySandbox({
        targetDir,
        runnerLabel: 'runner-a',
        deploySandbox: [LINE_A, LINE_B].join('\n'),
      });

      expect(result).toEqual({ status: 'applied', users: 1, domains: 2, paths: 2 });
      const written = readJson(configFile);
      expect(written.deploySandbox).toEqual(GRANT_A);
      expect(Object.keys(written)).toEqual(['mcpServers', 'plugin', 'ui', 'deploySandbox']);
      for (const key of ['mcpServers', 'plugin', 'ui'] as const) expect(written[key]).toEqual(original[key]);
      // Serialized like saveConfig: two-space JSON, newline-terminated.
      expect(fs.readFileSync(configFile, 'utf8')).toBe(`${JSON.stringify(written, null, 2)}\n`);
      // Replaced in place: no backup, no temp file left behind.
      expect(fs.readdirSync(targetDir)).toEqual(['config.json']);
    });

    it('takes the union of every line for this runner', () => {
      const { targetDir, configFile } = makeTarget({});

      applyDeploySandbox({
        targetDir,
        runnerLabel: 'runner-a',
        deploySandbox: [
          'runner-a|UAPPROVED1|qa.example.test|/srv/qa/lock',
          LINE_B,
          'runner-a|WAPPROVED2,UAPPROVED1|qa.example.test,admin.qa.example.test|',
          'runner-a|UAPPROVED1||/srv/qa/runs,/srv/qa/lock',
        ].join('\n'),
      });

      expect(readJson(configFile).deploySandbox).toEqual({
        users: ['UAPPROVED1', 'WAPPROVED2'],
        allowedDomains: ['qa.example.test', 'admin.qa.example.test'],
        allowWrite: ['/srv/qa/lock', '/srv/qa/runs'],
      });
    });

    it('replaces a previous grant in place (a narrowed line narrows the grant)', () => {
      const { targetDir, configFile } = makeTarget({
        plugin: {},
        deploySandbox: { users: ['UAPPROVED1', 'WAPPROVED2'], allowedDomains: ['old.example.test'], allowWrite: [] },
        ui: {},
      });

      applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_A });

      const written = readJson(configFile);
      expect(written.deploySandbox).toEqual(GRANT_A);
      expect(Object.keys(written)).toEqual(['plugin', 'deploySandbox', 'ui']);
    });

    it('creates config.json with only the grant when the target has none', () => {
      const { targetDir, configFile } = makeTarget();

      expect(applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_A }).status).toBe('applied');
      expect(readJson(configFile)).toEqual({ deploySandbox: GRANT_A });
    });

    it('writes config.json owner-only (0600), like every other config writer', () => {
      const { targetDir, configFile } = makeTarget({});
      fs.chmodSync(configFile, 0o644);

      applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_A });

      expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    });

    it('does not rewrite a config that already carries the same grant', () => {
      const { targetDir, configFile } = makeTarget({});
      applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_A });
      const before = fs.readFileSync(configFile, 'utf8');
      const inode = fs.statSync(configFile).ino;

      const result = applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_A });

      expect(result.status).toBe('unchanged');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
      expect(fs.statSync(configFile).ino).toBe(inode);
    });

    it('merges in memory without touching anything it was not given', () => {
      const config = { plugin: { plugins: ['acme-env@acme-env'] }, deploySandbox: { users: [] } };

      const merged = mergeDeploySandbox(config, GRANT_A);

      expect(merged.changed).toBe(true);
      expect(merged.config.plugin).toBe(config.plugin);
      expect(config.deploySandbox).toEqual({ users: [] });
    });
  });

  // Removing a runner's lines from the secret must revoke its grant on the
  // next deploy, not leave the last one in place.
  describe('revoke', () => {
    it.each([
      ['no line names this runner', LINE_B],
      ['DEPLOY_SANDBOX is empty', ''],
      ['DEPLOY_SANDBOX is unset', undefined],
      ['DEPLOY_SANDBOX has comments only', `# ${LINE_A}`],
    ])('deletes the key when %s', (_label, deploySandbox) => {
      const { targetDir, configFile } = makeTarget({ plugin: {}, deploySandbox: GRANT_A, ui: {} });

      const result = applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox });

      expect(result).toEqual({ status: 'revoked', users: 0, domains: 0, paths: 0 });
      expect(readJson(configFile)).toEqual({ plugin: {}, ui: {} });
      expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    });

    it('needs no runner label to revoke when nothing is configured', () => {
      const { targetDir, configFile } = makeTarget({ deploySandbox: GRANT_A });

      expect(applyDeploySandbox({ targetDir, runnerLabel: undefined, deploySandbox: '' }).status).toBe('revoked');
      expect(readJson(configFile)).toEqual({});
    });
  });

  // A host that gets no line must not gain a failure mode: unless there is a
  // grant to set or a key to delete, the strict destination checks (symlink,
  // file kind, writable directory, valid JSON) do not run and nothing is written.
  describe('no line for this runner and no key to delete: nothing to apply', () => {
    type Arrange = (targetDir: string, configFile: string) => void;
    const cases: [string, Arrange][] = [
      ['(a) no config.json', () => {}],
      ['(b) a config.json without the key', (_targetDir, configFile) => writeJson(configFile, { plugin: {} })],
      [
        '(b) a symlinked config.json without the key',
        (targetDir, configFile) => {
          writeJson(path.join(targetDir, 'elsewhere.json'), { plugin: {} });
          fs.symlinkSync(path.join(targetDir, 'elsewhere.json'), configFile);
        },
      ],
      ['(b) a config.json that is a directory', (_targetDir, configFile) => fs.mkdirSync(configFile)],
      ['(b) a config.json that is not JSON', (_targetDir, configFile) => fs.writeFileSync(configFile, '{ "pl', 'utf8')],
      [
        '(b) an unreadable config.json',
        (_targetDir, configFile) => {
          writeJson(configFile, { deploySandbox: GRANT_A });
          fs.chmodSync(configFile, 0o000);
        },
      ],
      [
        '(b) a config.json without the key in a non-writable directory',
        (targetDir, configFile) => {
          writeJson(configFile, { plugin: {} });
          fs.chmodSync(targetDir, 0o555);
        },
      ],
    ];

    function snapshot(targetDir: string): string {
      return JSON.stringify(
        fs
          .readdirSync(targetDir)
          .sort()
          .map((name) => {
            const stat = fs.lstatSync(path.join(targetDir, name));
            return [name, stat.ino, stat.mode, stat.mtimeMs];
          }),
      );
    }

    it.each(cases)('%s: exits 0 untouched, --check and apply alike', (_label, arrange) => {
      const { targetDir, configFile } = makeTarget();
      arrange(targetDir, configFile);
      const before = snapshot(targetDir);
      try {
        for (const checkOnly of [true, false]) {
          for (const deploySandbox of [LINE_B, '', undefined]) {
            expect(applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox, checkOnly })).toEqual({
              status: 'none',
              users: 0,
              domains: 0,
              paths: 0,
            });
          }
        }
        expect(snapshot(targetDir)).toBe(before);
      } finally {
        fs.chmodSync(targetDir, 0o700);
        if (fs.existsSync(configFile) && !fs.lstatSync(configFile).isSymbolicLink()) fs.chmodSync(configFile, 0o700);
      }
    });

    it('(a) a target that does not exist yet', () => {
      const missing = path.join(os.tmpdir(), `deploy-sandbox-none-${process.pid}`);
      fs.rmSync(missing, { recursive: true, force: true });

      for (const checkOnly of [true, false]) {
        expect(
          applyDeploySandbox({ targetDir: missing, runnerLabel: 'runner-a', deploySandbox: '', checkOnly }).status,
        ).toBe('none');
      }
      expect(fs.existsSync(missing)).toBe(false);
    });

    it('(c) with the key present, deletes it (strict path)', () => {
      const { targetDir, configFile } = makeTarget({ plugin: {}, deploySandbox: GRANT_A });

      expect(applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_B }).status).toBe('revoked');
      expect(readJson(configFile)).toEqual({ plugin: {} });
    });

    it('still validates every line: a malformed line for another runner fails', () => {
      const { targetDir } = makeTarget();

      expect(() =>
        applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: 'runner-b|WAPPROVED2|10.0.0.1|' }),
      ).toThrow(/line 1/);
    });
  });

  describe('check only (--check)', () => {
    it('computes the grant and writes nothing', () => {
      const { targetDir, configFile } = makeTarget({ plugin: {} });
      fs.chmodSync(configFile, 0o644);
      const before = fs.readFileSync(configFile, 'utf8');

      const result = applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_A, checkOnly: true });

      expect(result).toEqual({ status: 'applied', users: 1, domains: 2, paths: 2 });
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
      expect(fs.statSync(configFile).mode & 0o777).toBe(0o644);
      expect(fs.readdirSync(targetDir)).toEqual(['config.json']);
    });

    it('reports a revoke it would make, and writes nothing', () => {
      const { targetDir, configFile } = makeTarget({ deploySandbox: GRANT_A });
      const before = fs.readFileSync(configFile, 'utf8');

      expect(
        applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: '', checkOnly: true }).status,
      ).toBe('revoked');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('accepts a target that does not exist yet (sync-bundle creates it)', () => {
      const missing = path.join(os.tmpdir(), `deploy-sandbox-not-yet-${process.pid}`);
      fs.rmSync(missing, { recursive: true, force: true });

      const result = applyDeploySandbox({
        targetDir: missing,
        runnerLabel: 'runner-a',
        deploySandbox: LINE_A,
        checkOnly: true,
      });

      expect(result.status).toBe('applied');
      expect(fs.existsSync(missing)).toBe(false);
    });

    it.each([
      ['a malformed line', LINE_A.replace('qa.example.test,', 'https://qa.example.test,'), '{}', 'runner-a'],
      ['a malformed line for another runner', `${LINE_A}\nrunner-b|WAPPROVED2|10.0.0.1|`, '{}', 'runner-a'],
      ['no runner label', LINE_A, '{}', undefined],
      ['a config.json that is not JSON', LINE_A, '{ "plugin": ', 'runner-a'],
      ['a config.json that is not an object', LINE_A, '[]', 'runner-a'],
    ])('fails on %s exactly like the real apply, writing nothing', (_label, deploySandbox, raw, runnerLabel) => {
      const { targetDir, configFile } = makeTarget();
      fs.writeFileSync(configFile, raw, 'utf8');
      const options = { targetDir, runnerLabel, deploySandbox };

      const failure = (checkOnly: boolean): string => {
        try {
          applyDeploySandbox({ ...options, checkOnly });
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      };
      const checkError = failure(true);
      const applyError = failure(false);

      expect(checkError).not.toBe('');
      expect(checkError).toBe(applyError);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(raw);
      expect(fs.readdirSync(targetDir)).toEqual(['config.json']);
    });
  });

  describe('destination checks: --check and apply agree', () => {
    it('a symlinked config.json fails both ways and is left alone', () => {
      const { targetDir, configFile } = makeTarget();
      fs.writeFileSync(path.join(targetDir, 'elsewhere.json'), '{}', 'utf8');
      fs.symlinkSync(path.join(targetDir, 'elsewhere.json'), configFile);
      const options = { targetDir, runnerLabel: 'runner-a', deploySandbox: LINE_A };

      expect(() => applyDeploySandbox({ ...options, checkOnly: true })).toThrow(/symlink/);
      expect(() => applyDeploySandbox(options)).toThrow(/symlink/);
      expect(fs.readFileSync(path.join(targetDir, 'elsewhere.json'), 'utf8')).toBe('{}');
    });

    it('a target that is a regular file fails both ways', () => {
      const { targetDir } = makeTarget();
      const notADir = path.join(targetDir, 'plain-file');
      fs.writeFileSync(notADir, 'x', 'utf8');
      const options = { targetDir: notADir, runnerLabel: 'runner-a', deploySandbox: LINE_A };

      expect(() => applyDeploySandbox({ ...options, checkOnly: true })).toThrow(/not a directory/);
      expect(() => applyDeploySandbox(options)).toThrow(/not a directory/);
    });

    it('a revoke also checks the destination', () => {
      const { targetDir, configFile } = makeTarget();
      fs.writeFileSync(path.join(targetDir, 'elsewhere.json'), JSON.stringify({ deploySandbox: GRANT_A }), 'utf8');
      fs.symlinkSync(path.join(targetDir, 'elsewhere.json'), configFile);

      expect(() => applyDeploySandbox({ targetDir, runnerLabel: 'runner-a', deploySandbox: '' })).toThrow(/symlink/);
    });
  });

  describe('channel runner labels', () => {
    const lines = [LINE_A, LINE_B].join('\n');

    it('accepts lines whose labels are all in the set, including runners not deployed this run', () => {
      const { targetDir } = makeTarget({});

      expect(
        applyDeploySandbox({
          targetDir,
          runnerLabel: 'runner-a',
          deploySandbox: lines,
          channelRunnerLabels: ['runner-a', 'runner-b'],
        }).status,
      ).toBe('applied');
    });

    it.each([true, false])('rejects a label outside the set by line number only (checkOnly=%s)', (checkOnly) => {
      const { targetDir, configFile } = makeTarget({});
      const before = fs.readFileSync(configFile, 'utf8');

      let message = '';
      try {
        applyDeploySandbox({
          targetDir,
          runnerLabel: 'runner-a',
          deploySandbox: lines,
          channelRunnerLabels: ['runner-a', 'runner-c'],
          checkOnly,
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/^line 2: /);
      for (const leaked of ['runner-b', 'runner-c', 'WAPPROVED2', 'qa-b']) expect(message).not.toContain(leaked);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });
  });

  describe('runCli', () => {
    const LABELS = { CHANNEL_RUNNER_LABELS: 'runner-a,runner-b' };

    function run(argv: string[], env: Record<string, string | undefined>): { code: number; out: string } {
      const lines: string[] = [];
      const code = runCli({ argv, env, log: (m) => lines.push(m), error: (m) => lines.push(m) });
      return { code, out: lines.join('\n') };
    }

    const NAMES = ['UAPPROVED1', 'WAPPROVED2', 'example.test', '/srv/qa', 'runner-a', 'runner-b'];

    it('reports counts only on success', () => {
      const { targetDir } = makeTarget({});

      const { code, out } = run([targetDir], {
        DEPLOY_SANDBOX: [LINE_A, LINE_B].join('\n'),
        RUNNER_LABEL: 'runner-a',
        ...LABELS,
      });

      expect(code).toBe(0);
      expect(out).toBe('deploy-sandbox: applied 1 user(s), 2 domain(s), 2 path(s) to config.json');
      for (const leaked of [...NAMES, targetDir]) expect(out).not.toContain(leaked);
    });

    it('reports a revoke without names', () => {
      const { targetDir, configFile } = makeTarget({ deploySandbox: GRANT_A });

      const { code, out } = run([targetDir], { DEPLOY_SANDBOX: LINE_B, RUNNER_LABEL: 'runner-a', ...LABELS });

      expect(code).toBe(0);
      expect(out).toBe('deploy-sandbox: removed the grant from config.json, no entries for this runner');
      expect(readJson(configFile)).toEqual({});
    });

    it('is a no-op success when nothing is configured and there is nothing to revoke', () => {
      const { targetDir } = makeTarget({});

      const { code, out } = run([targetDir], {});
      expect(code).toBe(0);
      expect(out).toBe('deploy-sandbox: nothing to apply, no grant for this runner');
      expect(run(['--check', targetDir], {}).out).toBe(
        'deploy-sandbox: check ok (nothing to apply, no grant for this runner)',
      );
    });

    it('exits 0 for a runner with no line even when config.json would fail the strict checks', () => {
      const { targetDir, configFile } = makeTarget();
      writeJson(path.join(targetDir, 'elsewhere.json'), { plugin: {} });
      fs.symlinkSync(path.join(targetDir, 'elsewhere.json'), configFile);

      for (const flags of [['--check'], []]) {
        const { code, out } = run([...flags, targetDir], {
          DEPLOY_SANDBOX: LINE_B,
          RUNNER_LABEL: 'runner-a',
          ...LABELS,
        });
        expect(code).toBe(0);
        expect(out).toContain('nothing to apply');
      }
      expect(fs.lstatSync(configFile).isSymbolicLink()).toBe(true);
    });

    it('fails without a target argument', () => {
      expect(run([], { DEPLOY_SANDBOX: LINE_A, RUNNER_LABEL: 'runner-a', ...LABELS }).code).toBe(1);
    });

    it('fails when entries exist but the runner label is unknown to the step', () => {
      const { targetDir } = makeTarget({});

      expect(run([targetDir], { DEPLOY_SANDBOX: LINE_A, ...LABELS }).code).toBe(1);
    });

    it('fails on a malformed line with a neutral message', () => {
      const { targetDir } = makeTarget({});

      const { code, out } = run([targetDir], {
        DEPLOY_SANDBOX: 'runner-a|UAPPROVED1|https://qa.example.test|/srv/qa/state',
        RUNNER_LABEL: 'runner-a',
        ...LABELS,
      });

      expect(code).toBe(1);
      expect(out).toMatch(/^deploy-sandbox: failed \(line 1: field 3/);
      for (const leaked of [...NAMES, targetDir]) expect(out).not.toContain(leaked);
    });

    it('fails without printing the path when the target directory is missing', () => {
      const missing = path.join(os.tmpdir(), 'deploy-sandbox-missing-target-dir');

      const { code, out } = run([missing], { DEPLOY_SANDBOX: LINE_A, RUNNER_LABEL: 'runner-a', ...LABELS });

      expect(code).toBe(1);
      expect(out).not.toContain(missing);
    });

    it('--check validates, prints counts, and leaves config.json alone', () => {
      const { targetDir, configFile } = makeTarget({});
      const before = fs.readFileSync(configFile, 'utf8');

      const { code, out } = run(['--check', targetDir], {
        DEPLOY_SANDBOX: LINE_A,
        RUNNER_LABEL: 'runner-a',
        ...LABELS,
      });

      expect(code).toBe(0);
      expect(out).toBe('deploy-sandbox: check ok (would apply 1 user(s), 2 domain(s), 2 path(s) to config.json)');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('--check exits non-zero on a malformed line', () => {
      const { targetDir } = makeTarget({});

      const { code, out } = run(['--check', targetDir], {
        DEPLOY_SANDBOX: 'runner-a|UAPPROVED1|qa.example.test|/tmp/qa',
        RUNNER_LABEL: 'runner-a',
        ...LABELS,
      });

      expect(code).toBe(1);
      expect(out).toMatch(/^deploy-sandbox: check failed \(line 1: field 4/);
      for (const leaked of [...NAMES, '/tmp']) expect(out).not.toContain(leaked);
    });

    it.each([
      ['unset', ['--check'], undefined],
      ['empty', ['--check'], ''],
      ['unset (apply)', [], undefined],
      ['blank (apply)', [], ' , '],
    ])('fails closed when the channel label set is %s but entries exist', (_label, flags, labels) => {
      const { targetDir, configFile } = makeTarget({});
      const before = fs.readFileSync(configFile, 'utf8');

      const { code, out } = run([...flags, targetDir], {
        DEPLOY_SANDBOX: LINE_A,
        RUNNER_LABEL: 'runner-a',
        CHANNEL_RUNNER_LABELS: labels,
      });

      expect(code).toBe(1);
      expect(out).toContain('runner label set missing');
      for (const leaked of [...NAMES, targetDir]) expect(out).not.toContain(leaked);
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    });

    it('--check fails on a line whose runner label is not one of the channel', () => {
      const { targetDir } = makeTarget({});

      const { code, out } = run(['--check', targetDir], {
        DEPLOY_SANDBOX: `${LINE_A}\nrunner-typo|UAPPROVED1|qa.example.test|/srv/qa/state`,
        RUNNER_LABEL: 'runner-a',
        CHANNEL_RUNNER_LABELS: 'runner-a,runner-b',
      });

      expect(code).toBe(1);
      expect(out).toMatch(/line 2/);
      for (const leaked of ['runner-typo', ...NAMES]) expect(out).not.toContain(leaked);
    });

    it.each([
      [['--check']],
      [['--bogus', '/srv/qa-state']],
      [['/srv/qa-state', 'extra']],
    ])('rejects the argument list %j with a usage error', (argv) => {
      const { code, out } = run(argv, { DEPLOY_SANDBOX: LINE_A, RUNNER_LABEL: 'runner-a' });

      expect(code).toBe(1);
      expect(out).toContain('usage');
    });
  });
});
