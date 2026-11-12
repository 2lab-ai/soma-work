/**
 * The project config root (env-access #1242): the CLI reads project settings and the project MCP config from a
 * host directory no model writes, never from the session's working directory.
 */

import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectConfigRootError, projectConfigRoot } from '../project-config-root';

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
