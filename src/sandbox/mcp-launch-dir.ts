/**
 * Where stdio MCP servers start (env-access #1241).
 *
 * The CLI starts every stdio MCP server outside the sandbox, as the bot, in the session's working directory —
 * which the model writes. A launcher such as npx or uvx reads package-manager configuration and packages
 * (`.npmrc`, `package.json`, `node_modules/.bin`, `uv.toml` …) from its working directory and every directory
 * above it, so a file the model planted there would steer the next server start. The CLI ignores a `cwd` field on
 * the server config, so every stdio server is started through `sh -c 'cd / && exec …'`: the filesystem root has
 * no directory above it, and neither a session nor the bot can write it (measured on CLI 2.1.321:
 * `scripts/verification/probe-cli-mcp-launch-dir.mjs`). A directory of the bot's own would not do: a launcher
 * would still walk up into whatever lies above it.
 *
 * soma-work's own servers are wrapped in the options. A plugin's are wrapped where the CLI reads them — the
 * plugin's `.mcp.json` and manifest in the plugin cache, which no session writes — so the CLI still does
 * everything else itself (placeholders, `user_config`, plugin data, server names, transports). A plugin whose
 * stdio servers cannot be wrapped there has its MCP servers turned off.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig, McpStdioServerConfig, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { writeRootHolding } from './project-config-root';

/** The directory every stdio MCP server starts from. */
export const MCP_LAUNCH_DIR = '/';
/** `sh -c` script: `$1` is the directory, the rest is the server's own command and arguments. */
export const LAUNCH_SCRIPT = 'cd -- "$1" || exit 1; shift; exec "$@"';
const LAUNCH_NAME = 'mcp-launch';

export class McpLaunchDirError extends Error {
  constructor(message: string) {
    super(`${message}; the session was not started`);
    this.name = 'McpLaunchDirError';
  }
}

function writableByThisProcess(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The launch directory, after checking that no session and not the bot itself can write it. Throws
 * `McpLaunchDirError` otherwise (a bot running as root, a session given `/` to write).
 */
export function mcpLaunchDir(writeRoots: readonly string[], writable = writableByThisProcess): string {
  if (writable(MCP_LAUNCH_DIR)) {
    throw new McpLaunchDirError(
      `${MCP_LAUNCH_DIR} is writable by the bot, so a server could leave a launcher config there`,
    );
  }
  const holder = writeRootHolding(MCP_LAUNCH_DIR, writeRoots);
  if (holder !== undefined)
    throw new McpLaunchDirError(`${MCP_LAUNCH_DIR} lies inside ${holder}, which a session writes`);
  return MCP_LAUNCH_DIR;
}

function isStdio(config: unknown): config is McpStdioServerConfig {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return false;
  const c = config as { type?: unknown; command?: unknown };
  return (c.type === undefined || c.type === 'stdio') && typeof c.command === 'string';
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

class UnwrappableServer extends Error {}

interface Wrapped {
  servers: Json;
  /** Whether any server is stdio — one that needs the launch directory. */
  stdio: boolean;
  changed: boolean;
}

/** A servers map (server name → config) with its stdio servers started from `dir`. */
function wrapServers(dir: string, servers: Json): Wrapped {
  let changed = false;
  let stdio = false;
  const out: Json = {};
  for (const [name, config] of Object.entries(servers)) {
    if (isStdio(config)) {
      stdio = true;
      // Wrapping spreads `args`: anything but a list of strings would turn into a different command line.
      const args = (config as { args?: unknown }).args;
      if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === 'string'))) {
        throw new UnwrappableServer(`server ${name} has args that are not a list of strings`);
      }
      const wrapped = launchFrom(dir, config);
      if (JSON.stringify(wrapped) !== JSON.stringify(config)) changed = true;
      out[name] = wrapped;
    } else {
      out[name] = config;
    }
  }
  return { servers: out, stdio, changed };
}

/** A config file's servers live under `mcpServers`, or at its top level. */
function wrapConfigFile(dir: string, json: Json): { json: Json; stdio: boolean; changed: boolean } {
  if (isObject(json.mcpServers)) {
    const w = wrapServers(dir, json.mcpServers);
    return { json: { ...json, mcpServers: w.servers }, stdio: w.stdio, changed: w.changed };
  }
  const w = wrapServers(dir, json);
  return { json: w.servers, stdio: w.stdio, changed: w.changed };
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
  /** The plugins to load: unchanged, or with `skipMcpDiscovery` when their stdio servers could not be wrapped. */
  plugins: SdkPluginConfig[];
  /** Plugins whose MCP servers are off, with the reason. */
  turnedOff: string[];
}

/**
 * Point every stdio MCP server a plugin declares — in `.mcp.json` and in the manifest's `mcpServers` (an inline
 * server map, a JSON file, or a list of them) — at `dir`, by rewriting those files in place. Only plugins inside
 * `pluginsDir` (the plugin cache, which no session writes) are rewritten; one that declares only HTTP, SSE or
 * WebSocket servers needs nothing. A plugin whose stdio servers cannot be wrapped — outside the cache, an MCP
 * bundle (`.mcpb`), a file outside the plugin, a config that cannot be read or written, `args` that are not a
 * list of strings — is loaded with `skipMcpDiscovery`, so the CLI starts none of its servers.
 */
export function wrapPluginLaunchers(
  plugins: readonly SdkPluginConfig[],
  dir: string,
  pluginsDir: string,
): PluginLaunchers {
  let realCache: string;
  try {
    realCache = fs.realpathSync(pluginsDir);
  } catch {
    realCache = path.resolve(pluginsDir);
  }
  const turnedOff: string[] = [];
  const out = plugins.map((plugin) => {
    const reason = wrapPlugin(plugin, dir, realCache);
    if (reason === undefined) return plugin;
    turnedOff.push(`${plugin.path}: ${reason}`);
    return { ...plugin, skipMcpDiscovery: true };
  });
  return { plugins: out, turnedOff };
}

/** Undefined when the plugin's stdio servers now start from `dir` (or it has none); otherwise why they cannot. */
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

  // Every config is read and every rewrite worked out before any file is written.
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
  let stdio = false;
  let inlineChanged = false;
  const newSources: unknown[] = [];
  const writes: [string, Json][] = [];
  try {
    for (const source of sources) {
      if (typeof source === 'string') {
        if (!source.endsWith('.json')) return `${source} is not a JSON MCP config (an MCP bundle cannot be wrapped)`;
        const problem = read(path.resolve(root, source));
        if (problem) return problem;
        newSources.push(source);
      } else if (isObject(source)) {
        // An inline manifest entry is a server map: a server may even be named `mcpServers`.
        const w = wrapServers(dir, source);
        stdio ||= w.stdio;
        if (w.changed) inlineChanged = true;
        newSources.push(w.servers);
      } else {
        return 'its manifest mcpServers entry is not a path or an object';
      }
    }
    for (const [file, json] of files) {
      const w = wrapConfigFile(dir, json);
      stdio ||= w.stdio;
      if (w.changed) writes.push([file, w.json]);
    }
  } catch (err) {
    if (err instanceof UnwrappableServer) return err.message;
    throw err;
  }
  // No stdio server: nothing to wrap. (An HTTP server's `headersHelper` command is #1247's, with hooks and LSP.)
  if (!stdio) return undefined;
  if (!isInside(root, realCache) || root === realCache) return 'it is not in the plugin cache';
  if (inlineChanged) {
    const mcpServers = Array.isArray(declared) ? newSources : newSources[0];
    writes.push([fs.realpathSync(manifestFile), { ...manifest, mcpServers }]);
  }
  try {
    for (const [file, json] of writes) writeJsonAtomically(file, json);
  } catch (err) {
    return `its MCP config could not be rewritten (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  return undefined;
}
