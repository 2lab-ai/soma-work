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
import * as path from 'node:path';

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
  // npm lifecycle basics (not npm_config_*, which can carry arbitrary config).
  'npm_execpath',
  'npm_node_execpath',
  'npm_command',
  // Windows process basics, harmless elsewhere.
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
]);

/** Variable-name prefixes kept verbatim (locale, test runner, npm script metadata). */
const KEEP_PREFIXES = ['LC_', 'VITEST', 'VITE_', 'npm_lifecycle_', 'npm_package_'];

/** Scratch-root handoff from `vitest-global-setup.ts` to each worker. */
export const SCRATCH_ROOT_ENV = 'SOMA_WORK_TEST_SCRATCH_ROOT';

/**
 * Explicit opt-in for the real-SDK integration suite
 * (`src/__tests__/claude-handler.integration.test.ts`). Only with
 * `SOMA_TEST_REAL_SDK=1` are the credential variables below passed through;
 * config/data resolution stays pinned to scratch either way.
 */
export const REAL_SDK_OPT_IN_ENV = 'SOMA_TEST_REAL_SDK';
const REAL_SDK_CREDENTIAL_KEYS = new Set([
  'AUTH_MODE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
]);

function isKept(key: string, realSdkOptIn: boolean): boolean {
  if (KEEP_EXACT.has(key) || key === SCRATCH_ROOT_ENV || key === REAL_SDK_OPT_IN_ENV) return true;
  if (KEEP_PREFIXES.some((p) => key.startsWith(p))) return true;
  return realSdkOptIn && REAL_SDK_CREDENTIAL_KEYS.has(key);
}

/**
 * Strip `env` down to the allowlist, then point config/data resolution at
 * `scratchDir` (which must exist and must not contain a `.env`).
 *
 * Mutates `env` in place so it can be applied to `process.env` directly.
 */
export function isolateTestEnv(env: NodeJS.ProcessEnv, scratchDir: string): void {
  const realSdkOptIn = env[REAL_SDK_OPT_IN_ENV] === '1';
  for (const key of Object.keys(env)) {
    if (!isKept(key, realSdkOptIn)) delete env[key];
  }
  // `env-paths`: ENV_FILE = <dir>/.env (absent → dotenv loads nothing),
  // DATA_DIR = <dir>/data. `DATA_DIR` mirrors what `src/index.ts` does at boot
  // so the lazy legacy stores (cct-store, auth-runtime) converge on it too.
  // SOMA_DATA_DIR (which would outrank both) was removed above.
  env.SOMA_CONFIG_DIR = scratchDir;
  env.DATA_DIR = path.join(scratchDir, 'data');
}
