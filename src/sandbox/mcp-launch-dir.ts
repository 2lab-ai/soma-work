/**
 * Where stdio MCP servers start (env-access #1241).
 *
 * The CLI starts every stdio MCP server outside the sandbox, as the bot, in the session's working directory —
 * which the model writes. A launcher such as npx or uvx reads package-manager configuration (`.npmrc`,
 * `package.json`, `uv.toml` …) from its working directory and the directories above it, so a file the model
 * planted there would steer the next server start. The CLI ignores a `cwd` field on the server config, so every
 * stdio server is started through `sh -c 'cd <dir> && exec …'` from `<DATA_DIR>/mcp-launch`, which no model
 * writes (measured on CLI 2.1.321: `scripts/verification/probe-cli-mcp-launch-dir.mjs`).
 *
 * Plugin servers are started by the CLI itself from the plugin's own config, so the CLI is told to leave them
 * (`skipMcpDiscovery`) and soma-work declares them here under the CLI's own names (`plugin_<plugin>_<server>`, so
 * tool names do not change), wrapped the same way.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig, McpStdioServerConfig, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { writeRootHolding } from './project-config-root';

const DIR_NAME = 'mcp-launch';
/** `sh -c` script: `$1` is the directory, the rest is the server's own command and arguments. */
export const LAUNCH_SCRIPT = 'cd -- "$1" || exit 1; shift; exec "$@"';

export class McpLaunchDirError extends Error {
  constructor(message: string) {
    super(`${message}; the session was not started`);
    this.name = 'McpLaunchDirError';
  }
}

/**
 * The directory stdio MCP servers start from: `<DATA_DIR>/mcp-launch`, created on first use. Servers may write
 * in it; no session may. Throws `McpLaunchDirError` when it is not a plain directory or lies inside one of
 * `writeRoots`.
 */
export function mcpLaunchDir(dataDir: string, writeRoots: readonly string[]): string {
  const dir = path.join(dataDir, DIR_NAME);
  let stat: fs.Stats;
  try {
    fs.mkdirSync(dir, { recursive: true });
    stat = fs.lstatSync(dir);
  } catch (err) {
    throw new McpLaunchDirError(`could not make ${dir} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new McpLaunchDirError(`${dir} is not a plain directory`);
  const holder = writeRootHolding(dir, writeRoots);
  if (holder !== undefined) throw new McpLaunchDirError(`${dir} lies inside ${holder}, which a session writes`);
  return dir;
}

function isStdio(config: McpServerConfig): config is McpStdioServerConfig {
  return (
    (config.type === undefined || config.type === 'stdio') &&
    typeof (config as { command?: unknown }).command === 'string'
  );
}

/** The same server, started from `dir`. */
export function launchFrom(dir: string, config: McpStdioServerConfig): McpStdioServerConfig {
  return {
    ...config,
    command: '/bin/sh',
    args: ['-c', LAUNCH_SCRIPT, 'mcp-launch', dir, config.command, ...(config.args ?? [])],
  };
}

/** Every stdio server started from `dir`; SDK, HTTP and SSE servers unchanged. */
export function launchAllFrom(dir: string, servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, isStdio(config) ? launchFrom(dir, config) : config]),
  );
}

export interface PluginMcpServers {
  servers: Record<string, McpServerConfig>;
  /** Servers not declared, with the reason: a placeholder that cannot be filled, or an unreadable config. */
  skipped: string[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A config file's servers: `{ "mcpServers": { … } }` or the servers at the top level. */
function serversIn(json: Json | undefined): Json {
  if (!json) return {};
  return isObject(json.mcpServers) ? json.mcpServers : json;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Fill `${CLAUDE_PLUGIN_ROOT}` and `${VAR}` / `${VAR:-default}` the way the CLI does; undefined if one is left. */
function fill(text: string, root: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  let unfilled = false;
  const out = text.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => {
    if (name === 'CLAUDE_PLUGIN_ROOT') return root;
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    unfilled = true;
    return '';
  });
  return unfilled ? undefined : out;
}

function fillServer(
  config: Json,
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): McpServerConfig | undefined {
  const fillAll = (value: unknown): unknown => {
    if (typeof value === 'string') return fill(value, root, env);
    if (Array.isArray(value)) {
      const items = value.map(fillAll);
      return items.includes(undefined) ? undefined : items;
    }
    if (isObject(value)) {
      const entries = Object.entries(value).map(([k, v]) => [k, fillAll(v)] as const);
      return entries.some(([, v]) => v === undefined) ? undefined : Object.fromEntries(entries);
    }
    return value;
  };
  const filled = fillAll(config);
  if (!isObject(filled)) return undefined;
  if (typeof filled.command === 'string') {
    const env = isObject(filled.env) ? (filled.env as Record<string, string>) : {};
    return { ...(filled as McpStdioServerConfig), env: { CLAUDE_PLUGIN_ROOT: root, ...env } };
  }
  if (typeof filled.url === 'string' && (filled.type === 'http' || filled.type === 'sse')) {
    return filled as McpServerConfig;
  }
  return undefined;
}

/**
 * The MCP servers the given plugins declare — in `.mcp.json` at the plugin root and in the manifest's
 * `mcpServers` (inline, a path, or a list of either) — under the CLI's names for them, placeholders filled.
 */
export function pluginMcpServers(
  plugins: readonly SdkPluginConfig[],
  env: Readonly<Record<string, string | undefined>>,
): PluginMcpServers {
  const servers: Record<string, McpServerConfig> = {};
  const skipped: string[] = [];
  for (const plugin of plugins) {
    const root = path.resolve(plugin.path);
    const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json')) ?? {};
    const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : path.basename(root);
    const declared: Json = { ...serversIn(readJson(path.join(root, '.mcp.json'))) };
    const fromManifest = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers];
    for (const source of fromManifest) {
      if (typeof source === 'string') Object.assign(declared, serversIn(readJson(path.resolve(root, source))));
      else if (isObject(source)) Object.assign(declared, serversIn(source));
    }
    for (const [server, config] of Object.entries(declared)) {
      const key = `plugin_${name}_${server}`;
      const filled = isObject(config) ? fillServer(config, root, env) : undefined;
      if (filled) servers[key] = filled;
      else skipped.push(key);
    }
  }
  return { servers, skipped };
}
