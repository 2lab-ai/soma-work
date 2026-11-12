/**
 * Where the CLI reads project configuration from (env-access #1242).
 *
 * Sessions run with `settingSources: ['project']` so the CLI reads CLAUDE.md in the working directory. By default
 * it also reads the project settings (whose hooks it runs itself, outside the sandbox) and the project MCP config
 * (whose servers it starts) from there, and a model session can write its working directory. The SDK's
 * `projectConfigRoot` moves project settings, the project MCP config and the `.claude` config trees to another
 * directory, while CLAUDE.md, plan files and the working directory itself stay where they are (measured on CLI
 * 2.1.321: `scripts/verification/probe-cli-project-config-root.mjs`).
 *
 * That directory is this one: empty, under `DATA_DIR`, which no model writes (`protectedWriteDenyRules`). The CLI
 * also looks for `.mcp.json` in every directory above the root, so the root must not lie inside a directory a
 * session writes, and no directory above it may hold a `.mcp.json`. Anything else stops the session from starting.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT_NAME = 'session-project-config';
const MCP_FILE = '.mcp.json';

export class ProjectConfigRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectConfigRootError';
  }
}

function fail(message: string): never {
  throw new ProjectConfigRootError(`${message}; the session was not started`);
}

/** The real location of `p`, through its deepest existing ancestor. */
function real(p: string): string {
  const rest: string[] = [];
  let existing = path.resolve(p);
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try {
    return path.join(fs.realpathSync(existing), ...rest);
  } catch {
    return path.resolve(p);
  }
}

function isWithin(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The project config root for every session: `<DATA_DIR>/session-project-config`, created on first use.
 * `writeRoots` are the directories this session may write; the root must be outside all of them.
 */
export function projectConfigRoot(dataDir: string, writeRoots: readonly string[] = []): string {
  const root = path.join(dataDir, ROOT_NAME);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') fail(`could not make ${root}`);
  }
  let stat: fs.Stats;
  let entries: string[];
  try {
    stat = fs.lstatSync(root);
    entries = stat.isDirectory() ? fs.readdirSync(root) : [];
  } catch (err) {
    fail(`could not read ${root} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${root} is not a plain directory`);
  if (entries.length > 0) fail(`${root} must stay empty but holds ${entries.join(', ')}`);

  const realRoot = real(root);
  for (const writeRoot of writeRoots) {
    const realWrite = real(writeRoot);
    if (isWithin(realRoot, realWrite) || isWithin(root, path.resolve(writeRoot))) {
      fail(`${root} lies inside ${writeRoot}, which a session writes`);
    }
  }
  // The CLI looks for a project MCP config in every directory above the root, up to /.
  for (const start of new Set([path.dirname(root), path.dirname(realRoot)])) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      const mcp = path.join(dir, MCP_FILE);
      try {
        fs.lstatSync(mcp);
        fail(`${mcp} is above ${root}, and the CLI would start its servers`);
      } catch (err) {
        if (err instanceof ProjectConfigRootError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') fail(`could not check ${mcp} (${code ?? 'error'})`);
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  return root;
}
