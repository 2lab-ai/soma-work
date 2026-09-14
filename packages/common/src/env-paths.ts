/**
 * Branch-aware config/data path resolution.
 *
 * Resolution modes (in priority order):
 *   1. SOMA_CONFIG_DIR env var → use that directory with standard names
 *      (.env, .system.prompt, config.json, data/)
 *   2. Git branch detection:
 *      main   → .env,     .system.prompt,     config.json,     data/
 *      other  → .env.dev, .system.prompt.dev, config.dev.json, data.dev/
 *
 * MUST be imported before any other module that reads process.env or data paths.
 * Calls dotenv.config() so config.ts no longer needs to.
 */

import { execSync } from 'child_process';
import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

/**
 * Re-exported from the side-effect-free `./soma-paths`.
 *
 * The implementation moved there because importing *this* module spawns a `git`
 * subprocess, calls `dotenv.config()`, and prints a banner — none of which the
 * controller CLI may do, and all of which used to be the price of reading one
 * environment variable. Consumers of `env-paths` are unchanged.
 */
import { resolveDataDirOverride, getSomaHome as resolveSomaHome } from './soma-paths';

export { resolveDataDirOverride };

function detectBranch(): string {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'main';
  }
}

const configDir = process.env.SOMA_CONFIG_DIR;
const branch = detectBranch();
const isMain = branch === 'main';
const root = process.cwd();

let envFile: string;
let systemPromptFile: string;
let configFile: string;
let pluginsDir: string;
let dataDir: string;
let mode: string;

if (configDir) {
  // Explicit config directory — use standard file names (directory provides isolation)
  envFile = path.join(configDir, '.env');
  systemPromptFile = path.join(configDir, '.system.prompt');
  configFile = path.join(configDir, 'config.json');
  pluginsDir = path.join(configDir, 'plugins');
  dataDir = path.join(configDir, 'data');
  mode = `config-dir=${configDir}`;
} else {
  // Branch-based resolution from project root
  envFile = path.join(root, isMain ? '.env' : '.env.dev');
  systemPromptFile = path.join(root, isMain ? '.system.prompt' : '.system.prompt.dev');
  configFile = path.join(root, isMain ? 'config.json' : 'config.dev.json');
  pluginsDir = path.join(root, 'plugins');
  dataDir = path.join(root, isMain ? 'data' : 'data.dev');
  mode = `branch=${branch}`;
}

// First priority, applied after both resolution modes so it beats either.
// `src/index.ts` mirrors the resulting value into `process.env.DATA_DIR`, which
// is what the lazy legacy stores (`cct-store`, `auth-runtime`) read, so all
// three converge on one canonical directory per profile.
const dataDirOverride = resolveDataDirOverride();
if (dataDirOverride !== null) {
  dataDir = dataDirOverride;
  mode = `${mode} data-dir=${dataDir}`;
}

export const IS_DEV = !!configDir || !isMain;
export const ENV_FILE = envFile;
export const SYSTEM_PROMPT_FILE = systemPromptFile;
export const CONFIG_FILE = configFile;
export const PLUGINS_DIR = pluginsDir;
export const DATA_DIR = dataDir;

// Load environment variables from the resolved .env file
dotenv.config({ path: ENV_FILE });

// Startup log
console.log(
  `[env-paths] ${mode} env=${ENV_FILE} data=${DATA_DIR} config=${CONFIG_FILE} plugins=${PLUGINS_DIR} prompt=${SYSTEM_PROMPT_FILE}`,
);

/**
 * Home directory for `somawork` profile-scoped state (config/secrets/data/state).
 *
 * Resolution:
 *   1. `SOMA_HOME` env var, if set and non-empty.
 *   2. OS home directory (`os.homedir()`).
 *
 * A plain function (not a module-load-time constant) so tests can stub
 * `process.env.SOMA_HOME` hermetically per-case.
 */
export function getSomaHome(): string {
  return resolveSomaHome(process.env);
}
