/**
 * Where stdio MCP servers start (env-access #1241).
 *
 * The CLI starts every stdio MCP server outside the sandbox, as the bot, in the session's working directory —
 * which the model writes. A launcher such as npx or uvx reads package-manager configuration (`.npmrc`,
 * `package.json`, `uv.toml` …) from its working directory and the directories above it, so a file the model
 * planted there would steer the next server start. The CLI ignores a `cwd` field on the server config, so every
 * stdio server is started through `sh -c 'cd <dir> && exec …'` from `<DATA_DIR>/mcp-launch`: read-only, empty,
 * outside every directory a session writes (measured on CLI 2.1.321:
 * `scripts/verification/probe-cli-mcp-launch-dir.mjs`).
 *
 * soma-work's own servers are wrapped in the options. A plugin's servers are wrapped where the CLI reads them —
 * the plugin's `.mcp.json` and manifest in the plugin cache, which no session writes — so the CLI still does
 * everything else itself (placeholders, `user_config`, plugin data, server names, transports). A plugin whose
 * servers cannot be wrapped there has its MCP servers turned off.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig, McpStdioServerConfig, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { writeRootHolding } from './project-config-root';

const DIR_NAME = 'mcp-launch';
const DIR_MODE = 0o555;
/** `sh -c` script: `$1` is the directory, the rest is the server's own command and arguments. */
export const LAUNCH_SCRIPT = 'cd -- "$1" || exit 1; shift; exec "$@"';
const LAUNCH_NAME = 'mcp-launch';

export class McpLaunchDirError extends Error {
  constructor(message: string) {
    super(`${message}; the session was not started`);
    this.name = 'McpLaunchDirError';
  }
}

/**
 * The directory stdio MCP servers start from: `<DATA_DIR>/mcp-launch`, created on first use and kept read-only
 * (0555) and empty, so neither a session nor a server can leave a launcher config in it. Throws
 * `McpLaunchDirError` when it is not a plain empty directory or lies inside one of `writeRoots`.
 */
export function mcpLaunchDir(dataDir: string, writeRoots: readonly string[]): string {
  const dir = path.join(dataDir, DIR_NAME);
  let stat: fs.Stats;
  let entries: string[];
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new McpLaunchDirError(`${dir} is not a plain directory`);
    if ((stat.mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE);
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err instanceof McpLaunchDirError) throw err;
    throw new McpLaunchDirError(`could not prepare ${dir} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (entries.length > 0) throw new McpLaunchDirError(`${dir} must stay empty but holds ${entries.join(', ')}`);
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

function isLaunched(config: McpStdioServerConfig): boolean {
  const args = config.args ?? [];
  return config.command === '/bin/sh' && args[0] === '-c' && args[1] === LAUNCH_SCRIPT && args[2] === LAUNCH_NAME;
}

/** The same server, started from `dir`. A server already wrapped is pointed at `dir`. */
export function launchFrom(dir: string, config: McpStdioServerConfig): McpStdioServerConfig {
  if (isLaunched(config)) {
    const args = config.args ?? [];
    return { ...config, args: [...args.slice(0, 3), dir, ...args.slice(4)] };
  }
  return {
    ...config,
    command: '/bin/sh',
    args: ['-c', LAUNCH_SCRIPT, LAUNCH_NAME, dir, config.command, ...(config.args ?? [])],
  };
}

/** Every stdio server started from `dir`; SDK, HTTP, SSE and WebSocket servers unchanged. */
export function launchAllFrom(dir: string, servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, isStdio(config) ? launchFrom(dir, config) : config]),
  );
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Wrap the stdio entries of a servers object; undefined when nothing changes. */
function wrapServers(dir: string, servers: Json): Json | undefined {
  let changed = false;
  const out: Json = {};
  for (const [name, config] of Object.entries(servers)) {
    if (isObject(config) && isStdio(config as McpServerConfig)) {
      const wrapped = launchFrom(dir, config as McpStdioServerConfig);
      if (JSON.stringify(wrapped) !== JSON.stringify(config)) changed = true;
      out[name] = wrapped;
    } else {
      out[name] = config;
    }
  }
  return changed ? out : undefined;
}

/** A config file's servers live under `mcpServers`, or at its top level. */
function wrapConfigFile(dir: string, json: Json): Json | undefined {
  if (isObject(json.mcpServers)) {
    const servers = wrapServers(dir, json.mcpServers);
    return servers ? { ...json, mcpServers: servers } : undefined;
  }
  return wrapServers(dir, json);
}

function writeJsonAtomically(file: string, json: Json): void {
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.mcp-launch.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

function isInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export interface PluginLaunchers {
  /** The plugins to load: unchanged, or with `skipMcpDiscovery` when their servers could not be wrapped. */
  plugins: SdkPluginConfig[];
  /** Plugins whose MCP servers are off, with the reason. */
  turnedOff: string[];
}

/**
 * Point every stdio MCP server a plugin declares — in `.mcp.json` and in the manifest's `mcpServers` (inline, a
 * JSON file, or a list) — at `dir`, by rewriting those files in place. Only plugins inside `pluginsDir` (the
 * plugin cache, which no session writes) are rewritten. A plugin that declares servers it cannot be made to
 * start from `dir` — outside the cache, an MCP bundle (`.mcpb`), a file outside the plugin, a file that cannot
 * be read or written — is loaded with `skipMcpDiscovery`, so the CLI starts none of its servers.
 */
export function wrapPluginLaunchers(
  plugins: readonly SdkPluginConfig[],
  dir: string,
  pluginsDir: string,
): PluginLaunchers {
  const realCache = (() => {
    try {
      return fs.realpathSync(pluginsDir);
    } catch {
      return path.resolve(pluginsDir);
    }
  })();
  const turnedOff: string[] = [];
  const out = plugins.map((plugin) => {
    const reason = wrapPlugin(plugin, dir, realCache);
    if (reason === undefined) return plugin;
    turnedOff.push(`${plugin.path}: ${reason}`);
    return { ...plugin, skipMcpDiscovery: true };
  });
  return { plugins: out, turnedOff };
}

/** Undefined when the plugin's servers now start from `dir` (or it has none); otherwise why they cannot. */
function wrapPlugin(plugin: SdkPluginConfig, dir: string, realCache: string): string | undefined {
  let root: string;
  try {
    root = fs.realpathSync(plugin.path);
  } catch {
    return undefined; // The CLI cannot load a plugin that is not there either.
  }
  const manifestFile = path.join(root, '.claude-plugin', 'plugin.json');
  const mcpFile = path.join(root, '.mcp.json');
  let manifest: Json | undefined;
  try {
    const parsed: unknown = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
    manifest = isObject(parsed) ? parsed : undefined;
  } catch {
    manifest = undefined;
  }
  const declared = manifest?.mcpServers;
  const sources = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
  const hasMcpFile = fs.existsSync(mcpFile);
  if (!hasMcpFile && sources.length === 0) return undefined;
  if (manifest === undefined) return 'its manifest cannot be read';
  if (!isInside(root, realCache) || root === realCache) return 'it is not in the plugin cache';

  // Every file to rewrite, read and checked before any is written.
  const files = new Map<string, Json>();
  const read = (file: string): string | undefined => {
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      return `${path.relative(root, file)} cannot be read`;
    }
    if (!isInside(real, root)) return `${path.relative(root, file)} lies outside the plugin`;
    if (files.has(real)) return undefined;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(real, 'utf8'));
      if (!isObject(parsed)) return `${path.relative(root, file)} is not a JSON object`;
      files.set(real, parsed);
      return undefined;
    } catch {
      return `${path.relative(root, file)} cannot be read`;
    }
  };
  if (hasMcpFile) {
    const problem = read(mcpFile);
    if (problem) return problem;
  }
  let inlineChanged = false;
  const newSources: unknown[] = [];
  for (const source of sources) {
    if (typeof source === 'string') {
      if (!source.endsWith('.json')) return `${source} is not a JSON MCP config (an MCP bundle cannot be wrapped)`;
      const problem = read(path.resolve(root, source));
      if (problem) return problem;
      newSources.push(source);
    } else if (isObject(source)) {
      const wrapped = wrapConfigFile(dir, source);
      if (wrapped) inlineChanged = true;
      newSources.push(wrapped ?? source);
    } else {
      return 'its manifest mcpServers entry is not a path or an object';
    }
  }

  try {
    for (const [file, json] of files) {
      const wrapped = wrapConfigFile(dir, json);
      if (wrapped) writeJsonAtomically(file, wrapped);
    }
    if (inlineChanged) {
      const mcpServers = Array.isArray(declared) ? newSources : newSources[0];
      writeJsonAtomically(fs.realpathSync(manifestFile), { ...manifest, mcpServers });
    }
  } catch (err) {
    return `its MCP config could not be rewritten (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  return undefined;
}
