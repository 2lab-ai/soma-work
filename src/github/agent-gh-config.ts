/**
 * The GitHub CLI credential of agent shells (#834, epic #831).
 *
 * The agent's env is a copy of the daemon's, taken once per turn, and the App installation token lives an hour. A `gh`
 * that reads `GITHUB_TOKEN` from that copy fails with 401 once it expires — `git` does not, because it re-reads its
 * config, which every refresh rewrites. So every refresh also writes a bot-owned `hosts.yml`, and agent shells get its
 * directory as `GH_CONFIG_DIR` instead of the frozen token (`buildQueryEnv`): `gh` re-reads `hosts.yml` on every call.
 *
 * Pure: no work at module load (src/auth imports it).
 */

import { atomicWriteFile } from '@soma/common/atomic-write';
import path from 'path';

let served: string | undefined;

/** The `GH_CONFIG_DIR` agent shells get — set only while its `hosts.yml` holds the live App token. */
export function getAgentGhConfigDir(): string | undefined {
  return served;
}

/** Stop serving the dir (its token can no longer be kept fresh). */
export function clearAgentGhConfigDir(): void {
  served = undefined;
}

/**
 * Write `<dir>/hosts.yml` for the App installation token — through the symlink-hardened atomic writer (unique temp file
 * opened `O_EXCL|O_NOFOLLOW`, no symlink at the file or its ancestors, owner-only modes) — and serve `dir`. A token that
 * is not one safe word is refused: it is written into YAML.
 */
export async function writeAgentGhHosts(dir: string, token: string): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('refusing to write a malformed GitHub token');
  // Absolute: an agent shell resolves GH_CONFIG_DIR from its own cwd, not the daemon's (a relative SOMA_CONFIG_DIR).
  const abs = path.resolve(dir);
  atomicWriteFile(
    path.join(abs, 'hosts.yml'),
    `github.com:\n    oauth_token: ${token}\n    user: x-access-token\n    git_protocol: https\n`,
    { mode: 0o600, dirMode: 0o700 },
  );
  served = abs;
}
