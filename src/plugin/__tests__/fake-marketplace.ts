/**
 * A fake GitHub for plugin tests on a real disk: `gh api repos/<repo>/commits|tarball/<ref>` and
 * `tar` are answered from an in-memory repo map, and the "tarball" is written straight into the
 * extract dir as real files. Wire it in a test file with
 *
 *   vi.mock('child_process', async (importOriginal) => {
 *     const real = await importOriginal<typeof import('child_process')>();
 *     const { fakeExecFileSync } = await import('./fake-marketplace');
 *     return { ...real, default: { ...real, execFileSync: fakeExecFileSync }, execFileSync: fakeExecFileSync };
 *   });
 *
 * and call {@link resetRemote} in `beforeEach`. Not a test file itself (no `.test.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const remote = {
  /** repo → HEAD sha. A repo that is not listed is unreachable. */
  sha: {} as Record<string, string>,
  /** repo → its tarball's files (relative path → content). */
  files: {} as Record<string, Record<string, string>>,
};

/** A local MCP server that starts a CLI: EXEC_CHILD_PROCESS is CRITICAL. */
export const CRITICAL_PLUGIN = {
  'mcp/server.js':
    "import { spawn } from 'node:child_process';\nexport const start = () => spawn('acme-cli', ['serve']);\n",
};
export const CLEAN_PLUGIN = { 'skills/hello/SKILL.md': 'Say hello.\n' };

export function resetRemote(): void {
  for (const key of Object.keys(remote.sha)) delete remote.sha[key];
  for (const key of Object.keys(remote.files)) delete remote.files[key];
}

export function fakeExecFileSync(cmd: string, args: string[]): string | Buffer {
  if (cmd === 'gh' && args[0] === 'api') {
    // `repos/<owner>/<repo>/commits/<ref>` → `<owner>/<repo>`
    const repo = args[1].split('/').slice(1, 3).join('/');
    if (!remote.sha[repo]) throw new Error(`unreachable: ${repo}`);
    if (args[1].includes('/commits/')) return `${remote.sha[repo]}\n`;
    if (args[1].includes('/tarball/')) return Buffer.from(repo);
  }
  if (cmd === 'tar') {
    // The "tarball" names its repo; write that repo's tree under one top-level dir, like GitHub.
    const repo = fs.readFileSync(args[1], 'utf-8');
    const root = path.join(args[args.indexOf('-C') + 1], `${repo.replace('/', '-')}-top`);
    fs.mkdirSync(root, { recursive: true });
    for (const [rel, content] of Object.entries(remote.files[repo] ?? {})) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return Buffer.alloc(0);
  }
  throw new Error(`unexpected execFileSync: ${cmd} ${args.join(' ')}`);
}

/** A marketplace repo: `plugins` live under `plugins/<name>/`, `externals` in their own repos. */
export function publishMarketplace(
  repo: string,
  sha: string,
  plugins: Record<string, Record<string, string>>,
  externals: Record<string, string> = {},
): void {
  const files: Record<string, string> = {};
  const entries: Record<string, { path: string; externalUrl?: string }> = {};
  for (const [name, pluginFiles] of Object.entries(plugins)) {
    entries[name] = { path: `plugins/${name}` };
    for (const [rel, content] of Object.entries(pluginFiles)) files[`plugins/${name}/${rel}`] = content;
  }
  for (const [name, externalRepo] of Object.entries(externals)) {
    entries[name] = { path: '__external__', externalUrl: externalRepo };
  }
  files['marketplace.json'] = JSON.stringify({ name: repo.split('/')[1], plugins: entries });
  remote.sha[repo] = sha;
  remote.files[repo] = files;
}

/** A plugin that lives at the root of its own repo (an external source). */
export function publishRepo(repo: string, sha: string, files: Record<string, string>): void {
  remote.sha[repo] = sha;
  remote.files[repo] = { ...files };
}

export function unreachable(repo: string): void {
  delete remote.sha[repo];
}
