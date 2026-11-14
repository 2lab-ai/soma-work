/**
 * The project config root (env-access #1242): the CLI reads project settings and the project MCP config from a
 * host directory no model writes, never from the session's working directory.
 */

import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLI_STAGING_DIR, ProjectConfigRootError, projectConfigRoot } from '../project-config-root';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-root-')));
});

describe('projectConfigRoot', () => {
  it('is an empty directory under DATA_DIR, made on first use', () => {
    const root = projectConfigRoot(dataDir);
    expect(root.startsWith(dataDir + path.sep)).toBe(true);
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(projectConfigRoot(dataDir)).toBe(root);
  });

  it('refuses to start a session when the root holds project config: nothing may ever be read from it', () => {
    const root = projectConfigRoot(dataDir);
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
    expect(() => projectConfigRoot(dataDir)).toThrow(ProjectConfigRootError);
  });

  // dev 2026-11-13: the CLI makes `<root>/.claude/.cc-writes` whenever its sandbox starts. Refusing it refused every
  // session after the first sandboxed one.
  describe("the CLI's own staging directory", () => {
    const staging = (root: string) => path.join(root, '.claude', '.cc-writes');

    it('lets the next session start after the CLI made its staging directory', () => {
      const root = projectConfigRoot(dataDir);
      fs.mkdirSync(staging(root), { recursive: true, mode: 0o700 });
      expect(projectConfigRoot(dataDir)).toBe(root);
    });

    it('allows a .claude directory without the staging directory yet', () => {
      const root = projectConfigRoot(dataDir);
      fs.mkdirSync(path.join(root, '.claude'));
      expect(projectConfigRoot(dataDir)).toBe(root);
    });

    it('allows what the CLI stages inside it: the CLI reads no configuration from there', () => {
      const root = projectConfigRoot(dataDir);
      fs.mkdirSync(staging(root), { recursive: true });
      fs.writeFileSync(path.join(staging(root), 'settings.local.json.1a2b'), '{}');
      expect(projectConfigRoot(dataDir)).toBe(root);
    });

    it.each([
      ['.claude/settings.json', (root: string) => fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}')],
      [
        '.claude/settings.local.json',
        (root: string) => fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{}'),
      ],
      ['.claude/skills', (root: string) => fs.mkdirSync(path.join(root, '.claude', 'skills'))],
      ['.mcp.json', (root: string) => fs.writeFileSync(path.join(root, '.mcp.json'), '{}')],
      ['CLAUDE.md', (root: string) => fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'x')],
    ])('still refuses %s beside it, and names it', (name, plant) => {
      const root = projectConfigRoot(dataDir);
      fs.mkdirSync(staging(root), { recursive: true });
      plant(root);
      expect(() => projectConfigRoot(dataDir)).toThrow(ProjectConfigRootError);
      expect(() => projectConfigRoot(dataDir)).toThrow(`yet holds ${name};`);
    });

    it('refuses a staging directory that is a link', () => {
      const root = projectConfigRoot(dataDir);
      const elsewhere = path.join(dataDir, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.mkdirSync(path.join(root, '.claude'));
      fs.symlinkSync(elsewhere, staging(root));
      expect(() => projectConfigRoot(dataDir)).toThrow('yet holds .claude/.cc-writes;');
    });

    it('refuses a .claude that is a link or a file', () => {
      const root = projectConfigRoot(dataDir);
      const elsewhere = path.join(dataDir, 'elsewhere');
      fs.mkdirSync(path.join(elsewhere, '.cc-writes'), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(root, '.claude'));
      expect(() => projectConfigRoot(dataDir)).toThrow('yet holds .claude;');
      fs.unlinkSync(path.join(root, '.claude'));
      fs.writeFileSync(path.join(root, '.claude'), 'x');
      expect(() => projectConfigRoot(dataDir)).toThrow('yet holds .claude;');
    });
  });

  it('names the same staging directory as the probe that checks a real CLI run', () => {
    const probe = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'verification', 'probe-cli-project-config-root.mjs'),
      'utf8',
    );
    expect(probe).toContain(`const CLI_STAGING_DIR = '${CLI_STAGING_DIR.join('/')}';`);
  });

  it('refuses a root that is a link', () => {
    const elsewhere = path.join(dataDir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(dataDir, 'session-project-config'));
    expect(() => projectConfigRoot(dataDir)).toThrow(ProjectConfigRootError);
  });

  it('refuses a root that is not a directory', () => {
    fs.writeFileSync(path.join(dataDir, 'session-project-config'), 'x');
    expect(() => projectConfigRoot(dataDir)).toThrow(ProjectConfigRootError);
  });

  // The CLI also looks for .mcp.json in every directory above the root (astra R2, fable R2).
  it('refuses to start when a directory above the root holds a project MCP config', () => {
    fs.writeFileSync(path.join(dataDir, '.mcp.json'), '{}');
    expect(() => projectConfigRoot(dataDir)).toThrow(/above it.*\.mcp\.json|\.mcp\.json/);
  });

  it('refuses a root inside a directory a session writes: the CLI would read the files above it', () => {
    expect(() => projectConfigRoot(dataDir, [path.dirname(dataDir)])).toThrow(ProjectConfigRootError);
    expect(() => projectConfigRoot(dataDir, [path.join(os.tmpdir(), 'unrelated-root')])).not.toThrow();
  });

  it('turns a filesystem error into its own error, so the reply says why the session did not start', () => {
    const blocker = path.join(dataDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    expect(() => projectConfigRoot(blocker)).toThrow(ProjectConfigRootError);
  });
});
