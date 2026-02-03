/**
 * Branch-aware config/data path resolution.
 *
 * Resolution modes (in priority order):
 *   1. SOMA_CONFIG_DIR env var → use that directory with standard names
 *      (.env, .system.prompt, mcp-servers.json, data/)
 *   2. Git branch detection:
 *      main   → .env,     .system.prompt,     mcp-servers.json,     data/
 *      other  → .env.dev, .system.prompt.dev, mcp-servers.dev.json, data.dev/
 *
 * MUST be imported before any other module that reads process.env or data paths.
 * Calls dotenv.config() so config.ts no longer needs to.
 */

import { execSync } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';

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
let mcpConfigFile: string;
let dataDir: string;
let mode: string;

if (configDir) {
  // Explicit config directory — use standard file names (directory provides isolation)
  envFile = path.join(configDir, '.env');
  systemPromptFile = path.join(configDir, '.system.prompt');
  mcpConfigFile = path.join(configDir, 'mcp-servers.json');
  dataDir = path.join(configDir, 'data');
  mode = `config-dir=${configDir}`;
} else {
  // Branch-based resolution from project root
  envFile = path.join(root, isMain ? '.env' : '.env.dev');
  systemPromptFile = path.join(root, isMain ? '.system.prompt' : '.system.prompt.dev');
  mcpConfigFile = path.join(root, isMain ? 'mcp-servers.json' : 'mcp-servers.dev.json');
  dataDir = path.join(root, isMain ? 'data' : 'data.dev');
  mode = `branch=${branch}`;
}

export const IS_DEV = !!configDir || !isMain;
export const ENV_FILE = envFile;
export const SYSTEM_PROMPT_FILE = systemPromptFile;
export const MCP_CONFIG_FILE = mcpConfigFile;
export const DATA_DIR = dataDir;

// Load environment variables from the resolved .env file
dotenv.config({ path: ENV_FILE });

// Startup log
console.log(`[env-paths] ${mode} env=${ENV_FILE} data=${DATA_DIR} mcp=${MCP_CONFIG_FILE} prompt=${SYSTEM_PROMPT_FILE}`);
