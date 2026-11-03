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
import fs from 'fs/promises';
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
 * Write `<dir>/hosts.yml` for the App installation token — atomically (temp file → rename), readable by its owner only
 * — and serve `dir`. A token that is not one safe word is refused: it is written into YAML.
 */
export async function writeAgentGhHosts(dir: string, token: string): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('refusing to write a malformed GitHub token');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const file = path.join(dir, 'hosts.yml');
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      tmp,
      `github.com:\n    oauth_token: ${token}\n    user: x-access-token\n    git_protocol: https\n`,
      {
        mode: 0o600,
      },
    );
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  served = dir;
}
