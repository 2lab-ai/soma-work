/**
 * Pure, side-effect-free path resolution for somawork profiles.
 *
 * ## Why this is a separate module
 *
 * `./env-paths` owns the same two functions' *behaviour*, but importing it is
 * not free: at module load it runs `execSync('git branch --show-current')`,
 * calls `dotenv.config()`, and prints an `[env-paths] …` banner. That is correct
 * for the daemon, which wants branch-aware paths in a source checkout — and
 * completely wrong for the controller CLI, whose contract is the opposite:
 *
 * - `somawork sessions list --json` and `somawork doctor --json` must put one
 *   parseable document on stdout, and a banner printed at *import* time lands
 *   there before any command code runs;
 * - the packaged controller must not shell out or depend on the directory the
 *   operator happens to be standing in.
 *
 * So the pure half lives here, `env-paths` re-exports it (every existing
 * consumer is unchanged and there is still exactly one implementation), and the
 * CLI imports this module instead.
 *
 * Nothing in this file reads `process` at load time, spawns anything, or writes
 * to any stream.
 */

import * as os from 'os';
import * as path from 'path';

/**
 * First-priority explicit override for the mutable data root.
 *
 * `SOMA_CONFIG_DIR` binds `DATA_DIR` to `<configDir>/data`, which is fine for a
 * source checkout but wrong for an installed profile: design §4.2 puts mutable
 * data at `~/.local/share/somawork/<profile>`, deliberately outside the config
 * directory so a config reset never eats the daemon's state. The service
 * manager therefore exports `SOMA_DATA_DIR=<ProfileReceipt.dataDir>` and this
 * override wins over both of `env-paths`' resolution modes.
 *
 * A plain function (not a module-load constant) so it is testable without
 * re-importing the module, and so a relative override is normalised to an
 * absolute path exactly once, here.
 */
export function resolveDataDirOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.SOMA_DATA_DIR;
  if (typeof override !== 'string') return null;
  const trimmed = override.trim();
  if (trimmed === '') return null;
  return path.resolve(trimmed);
}

/**
 * Canonical env var naming the somawork home directory.
 *
 * The design doc and the packaging plan both say `SOMAWORK_HOME`; Tasks 1-2
 * shipped `SOMA_HOME` under the global `SOMA_` prefix constraint. Both are
 * honoured rather than one being broken, because Task 11's hermetic
 * clean-machine smoke sets the canonical name and a silent miss there would let
 * the receipt read the operator's real `~`.
 */
export const SOMA_HOME_ENV = 'SOMAWORK_HOME';

/** Backwards-compatible alias, shipped by Tasks 1-2. Second priority. */
export const SOMA_HOME_ENV_ALIAS = 'SOMA_HOME';

/**
 * Home directory for `somawork` profile-scoped state (config/secrets/data/state).
 *
 * Resolution:
 *   1. `SOMAWORK_HOME`, if set and non-empty.
 *   2. `SOMA_HOME`, if set and non-empty.
 *   3. The OS home directory.
 *
 * A whitespace-only value is treated as unset at every level, so a shell that
 * exported an empty variable falls through instead of resolving the profile
 * root to `""`.
 */
export function getSomaHome(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of [SOMA_HOME_ENV, SOMA_HOME_ENV_ALIAS]) {
    const declared = env[name];
    if (typeof declared === 'string' && declared.trim() !== '') return declared;
  }
  return os.homedir();
}
