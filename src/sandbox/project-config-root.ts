/**
 * Where the CLI reads project configuration from (env-access #1242).
 *
 * Sessions run with `settingSources: ['project']` so the CLI reads CLAUDE.md in the working directory. By default
 * it also reads the project settings (whose hooks it runs itself, outside the sandbox) and the project MCP config
 * (whose servers it starts, from the working directory and the directories above it) from there — and a model
 * session can write its working directory. The SDK's `projectConfigRoot` moves project settings, the project MCP
 * config and the `.claude` config trees to another directory, while CLAUDE.md, plan files and the working
 * directory itself stay where they are (measured on CLI 2.1.321:
 * `scripts/verification/probe-cli-project-config-root.mjs`).
 *
 * That directory is this one: empty, under `DATA_DIR`, which no model writes (`protectedWriteDenyRules`), and
 * whose parents no model writes either. The host never puts anything in it; a root that is not an empty real
 * directory stops the session from starting.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT_NAME = 'session-project-config';

export class ProjectConfigRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectConfigRootError';
  }
}

/** The project config root for every session: `<DATA_DIR>/session-project-config`, created on first use. */
export function projectConfigRoot(dataDir: string): string {
  const root = path.join(dataDir, ROOT_NAME);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new ProjectConfigRootError(`could not make ${root}; the session was not started`);
    }
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProjectConfigRootError(`${root} is not a plain directory; the session was not started`);
  }
  const entries = fs.readdirSync(root);
  if (entries.length > 0) {
    throw new ProjectConfigRootError(
      `${root} must stay empty but holds ${entries.join(', ')}; the session was not started`,
    );
  }
  return root;
}
