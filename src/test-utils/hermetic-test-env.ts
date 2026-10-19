/**
 * Test-process environment isolation, applied to every vitest worker through
 * `setupFiles` (see `vitest-setup.ts` and `vitest.config.ts`).
 *
 * The suite runs on hosts that also run soma-work: fleet nodes, a developer's
 * `npm start` checkout, and agent sessions spawned by a live bot, whose shell
 * inherits `SOMA_CONFIG_DIR=/opt/soma-work/<env>`, `DATA_DIR`, `AUTH_MODE` and
 * credentials. `env-paths` loads `<SOMA_CONFIG_DIR>/.env` and binds `DATA_DIR`
 * at import time, so an un-isolated run read the live bot's credentials and
 * wrote fixture sessions into its data directory (2026-10-19, dev bot).
 *
 * Policy is an allowlist, not a denylist: a new deployment knob must not be
 * able to leak in just because nobody added it here. Only generic process and
 * tooling variables survive. Config and data resolution are then pinned to a
 * scratch directory with no `.env`, which is what CI already sees.
 */

/** Variables kept verbatim. */
const KEEP_EXACT = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'LANG',
  'TERM',
  'TZ',
  'CI',
  'GITHUB_ACTIONS',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'NODE_ENV',
  'NODE_OPTIONS',
  'TEST',
  // Process-context flag, not deployment config: the real-SDK integration
  // suite skips itself inside a Claude Code session (nested sessions crash).
  'CLAUDECODE',
  // Windows process basics, harmless elsewhere.
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
]);

/** Variable-name prefixes kept verbatim (locale, test runner, npm lifecycle). */
const KEEP_PREFIXES = ['LC_', 'VITEST', 'VITE_', 'npm_'];

/** Scratch-root handoff from `vitest-global-setup.ts` to each worker. */
export const SCRATCH_ROOT_ENV = 'SOMA_WORK_TEST_SCRATCH_ROOT';

function isKept(key: string): boolean {
  return KEEP_EXACT.has(key) || key === SCRATCH_ROOT_ENV || KEEP_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Strip `env` down to the allowlist, then point config/data resolution at
 * `scratchDir` (which must exist and must not contain a `.env`).
 *
 * Mutates `env` in place so it can be applied to `process.env` directly.
 */
export function isolateTestEnv(env: NodeJS.ProcessEnv, scratchDir: string): void {
  for (const key of Object.keys(env)) {
    if (!isKept(key)) delete env[key];
  }
  // `env-paths`: ENV_FILE = <dir>/.env (absent → dotenv loads nothing),
  // DATA_DIR = <dir>/data. `DATA_DIR` mirrors what `src/index.ts` does at boot
  // so the lazy legacy stores (cct-store, auth-runtime) converge on it too.
  env.SOMA_CONFIG_DIR = scratchDir;
  env.DATA_DIR = `${scratchDir}/data`;
}
