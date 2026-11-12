#!/usr/bin/env node
/**
 * Probe: where does the pinned Claude Code CLI start stdio MCP servers, and does soma-work's launch wrapper move
 * them to a directory no model writes (env-access #1241, `src/sandbox/mcp-launch-dir.ts`)?
 *
 * A stdio MCP server runs outside the sandbox. Its launcher (npx, uvx …) reads package-manager config from its
 * working directory and the directories above it, and the CLI starts it in the session's working directory,
 * which the model writes. The CLI ignores a `cwd` field on the server config. soma-work therefore starts every
 * stdio server through `sh -c 'cd <dir> && exec …'`, and starts plugin servers itself under the CLI's own names,
 * with `skipMcpDiscovery` on the plugin so the CLI does not start its own copy.
 *
 * Measured with CLI 2.1.321. Re-run on every Claude Agent SDK / CLI bump. Two short model sessions (cheap model).
 *
 *   node scripts/verification/probe-cli-mcp-launch-dir.mjs [model]     # default claude-haiku-4-5
 *   PROBE_ISOLATED_CONFIG=1 node …   # a fresh CLAUDE_CONFIG_DIR (needed inside a sandboxed session)
 *
 * Exit 0: control — a direct server and a plugin server start in the working directory, the `cwd` field is
 *         ignored; with the wrapper — both start in the launch directory, the plugin's own copy does not start,
 *         and the tool names are the same as in the control.
 * Exit 1: with the wrapper, a server started in the working directory, or the plugin's own copy started.
 * Exit 2: inconclusive (the control did not show the problem, or tool names differ).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const model = process.argv[2] ?? 'claude-haiku-4-5';
const tmp = fs.realpathSync(os.tmpdir());

/** A minimal stdio MCP server: records its working directory, offers one tool. */
const SERVER = `
import * as fs from 'node:fs';
fs.writeFileSync(process.argv[2], process.cwd());
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result = {};
    if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0' } };
    else if (m.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
`;

/** The wrapper soma-work applies (see mcp-launch-dir.ts). */
function wrap(config, dir) {
  return {
    ...config,
    command: '/bin/sh',
    args: ['-c', 'cd -- "$1" || exit 1; shift; exec "$@"', 'mcp-launch', dir, config.command, ...(config.args ?? [])],
  };
}

async function run(withWrapper) {
  const base = fs.mkdtempSync(path.join(tmp, 'mcp-launch-'));
  const cwd = path.join(base, 'user', 'session');
  const launch = path.join(base, 'host', 'launch');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(launch, { recursive: true });
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'probeplugin', version: '0.0.1' }));
  fs.writeFileSync(path.join(plugin, 'server.mjs'), SERVER);
  const marker = (name) => path.join(base, `cwd-${name}`);
  const pluginServer = { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs', marker('plugin-own')] };
  fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { srv: pluginServer } }));
  const direct = { type: 'stdio', command: 'node', args: [path.join(plugin, 'server.mjs'), marker('direct')] };
  const mcpServers = withWrapper
    ? {
        direct: wrap(direct, launch),
        // The plugin's server, started by soma-work under the CLI's name for it.
        plugin_probeplugin_srv: wrap(
          { type: 'stdio', command: 'node', args: [path.join(plugin, 'server.mjs'), marker('plugin-wrapped')] },
          launch,
        ),
      }
    : { direct: { ...direct, cwd: launch } };
  const env = process.env.PROBE_ISOLATED_CONFIG
    ? { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(tmp, 'probe-config-')) }
    : undefined;
  let tools = [];
  for await (const m of query({
    prompt: 'Say hi.',
    options: {
      ...(env ? { env } : {}),
      cwd,
      model,
      maxTurns: 1,
      settingSources: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      plugins: [{ type: 'local', path: plugin, ...(withWrapper ? { skipMcpDiscovery: true } : {}) }],
      mcpServers,
    },
  })) {
    if (m.type === 'system' && m.subtype === 'init') tools = m.tools.filter((t) => t.startsWith('mcp__')).sort();
    if (m.type === 'result') break;
  }
  await new Promise((r) => setTimeout(r, 1000));
  const where = (name) => (fs.existsSync(marker(name)) ? fs.readFileSync(marker(name), 'utf8') : null);
  return { cwd, launch, tools, direct: where('direct'), pluginOwn: where('plugin-own'), pluginWrapped: where('plugin-wrapped') };
}

const control = await run(false);
const wrapped = await run(true);
const shown = control.direct === control.cwd && control.pluginOwn === control.cwd;
const leaked = wrapped.direct !== wrapped.launch || wrapped.pluginWrapped !== wrapped.launch || wrapped.pluginOwn !== null;
const sameTools = JSON.stringify(control.tools) === JSON.stringify(wrapped.tools);
const verdict = leaked ? 'STARTED IN THE WORKING DIRECTORY' : shown && sameTools ? 'LAUNCH DIR HOLDS' : 'INCONCLUSIVE';
console.log(JSON.stringify({ verdict, model, control, wrapped }, null, 2));
process.exit(leaked ? 1 : shown && sameTools ? 0 : 2);
