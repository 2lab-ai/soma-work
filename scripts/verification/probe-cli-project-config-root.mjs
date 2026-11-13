#!/usr/bin/env node
/**
 * Probe: with `projectConfigRoot` at an empty directory, does the pinned Claude Code CLI ignore the project
 * settings and project MCP config in the working directory, while still reading its CLAUDE.md and running plugin
 * hooks? Sessions rely on it (env-access #1242, `src/sandbox/project-config-root.ts`): a model writes its working
 * directory, and the CLI runs project hooks and project MCP servers outside the sandbox.
 * Measured with CLI 2.1.321: yes.
 *
 * It also checks what the CLI itself leaves in the root, which `projectConfigRoot()` must accept or no session after
 * the first one starts. The CLI writes there only when its sandbox starts (its staging directory for atomic writes,
 * `CLI_STAGING_DIR`), so a third session runs one Bash command with the sandbox on.
 *
 * Re-run it on every Claude Agent SDK / CLI version bump. Three short model sessions per run (a cheap model). Run it
 * from a host shell: inside a sandboxed session the CLI's own sandbox cannot start (it cannot listen on its socket
 * under /tmp/claude-<uid>), so the third session measures nothing and the run is inconclusive.
 *
 *   node scripts/verification/probe-cli-project-config-root.mjs [model]     # default claude-haiku-4-5
 *   PROBE_ISOLATED_CONFIG=1 node …   # use a fresh CLAUDE_CONFIG_DIR (needed inside a sandboxed session, where the
 *                                    # CLI cannot write its usual config directory and so runs no hooks at all)
 *
 * Exit 0: with the root set, no project or local hook and no project MCP server (in the working directory or
 *         above it) ran, the plugin hook did, and
 *         CLAUDE.md applied; without it (the control) the project hook and server did run; the sandboxed Bash
 *         command ran and the CLI left nothing in the root but its staging directory.
 * Exit 1: with the root set, a project or local hook, or a project MCP server (working directory or above), ran.
 * Exit 2: inconclusive — the control did not run them, the plugin hook did not run, CLAUDE.md was not applied, or
 *         the sandboxed Bash command did not run.
 * Exit 3: the CLI left something else in the root (`rootForeign`). `projectConfigRoot()` refuses it, so every
 *         session after the first would not start: teach the guard what the new CLI writes before shipping it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const model = process.argv[2] ?? 'claude-haiku-4-5';
const tmp = fs.realpathSync(os.tmpdir());
// The only thing the CLI may leave in the root (src/sandbox/project-config-root.ts CLI_STAGING_DIR; a test keeps the
// two equal).
const CLI_STAGING_DIR = '.claude/.cc-writes';

const isolatedEnv = () =>
  process.env.PROBE_ISOLATED_CONFIG
    ? { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(tmp, 'probe-config-')) }
    : undefined;

/** Paths in the root, relative to it, other than the CLI's staging directory and what it stages inside it. */
function foreignInRoot(root) {
  const allowed = CLI_STAGING_DIR.split('/');
  const foreign = [];
  let dir = root;
  for (const [depth, name] of allowed.entries()) {
    const prefix = allowed.slice(0, depth);
    for (const entry of fs.readdirSync(dir)) if (entry !== name) foreign.push(path.join(...prefix, entry));
    const next = path.join(dir, name);
    if (!fs.existsSync(next) && !isLink(next)) break;
    if (isLink(next) || !fs.lstatSync(next).isDirectory()) {
      foreign.push(path.join(...prefix, name));
      break;
    }
    dir = next;
  }
  return foreign;
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

async function run(withRoot) {
  const base = fs.mkdtempSync(path.join(tmp, 'project-config-root-'));
  // As in production, the working directory and the root are in separate trees: the CLI also looks for .mcp.json
  // above the root, which is why soma-work refuses to start when one is there (project-config-root.ts).
  const cwd = path.join(base, 'user', 'session');
  const configRoot = path.join(base, 'host', 'config-root');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  const marker = (name) => path.join(base, `marker-${name}`);
  const startHook = (name) =>
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker(name)}` }] }] } });
  const mcpServer = (name) =>
    JSON.stringify({ mcpServers: { [name]: { command: 'sh', args: ['-c', `touch ${marker(name)}; sleep 2`] } } });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), startHook('project-hook'));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), startHook('local-hook'));
  fs.writeFileSync(path.join(cwd, '.mcp.json'), mcpServer('project-mcp'));
  // Above the working directory (the user's temp root in production), not above the root.
  fs.writeFileSync(path.join(base, 'user', '.mcp.json'), mcpServer('parent-mcp'));
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Project rule: end every reply with the exact word PINEAPPLE.\n');
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'hooks'));
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'probe-plugin', version: '0.0.1' }));
  fs.writeFileSync(
    path.join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker('plugin-hook')}` }] }] } }),
  );
  const env = isolatedEnv();
  let reply = '';
  for await (const m of query({
    prompt: 'Say hello.',
    options: {
      ...(env ? { env } : {}),
      cwd,
      model,
      maxTurns: 1,
      tools: [],
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      plugins: [{ type: 'local', path: plugin }],
      ...(withRoot ? { projectConfigRoot: configRoot } : {}),
    },
  })) {
    if (m.type === 'result') reply = String(m.result ?? '');
  }
  const ran = (name) => fs.existsSync(marker(name));
  return {
    projectHook: ran('project-hook'),
    localHook: ran('local-hook'),
    projectMcp: ran('project-mcp'),
    parentMcp: ran('parent-mcp'),
    pluginHook: ran('plugin-hook'),
    claudeMd: /PINEAPPLE/.test(reply),
  };
}

/** One sandboxed Bash command with the root set, so the CLI starts its sandbox; then what it left in the root. */
async function runSandboxedBash() {
  const base = fs.mkdtempSync(path.join(tmp, 'project-config-root-'));
  const cwd = path.join(base, 'user', 'session');
  const configRoot = path.join(base, 'host', 'config-root');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  const env = isolatedEnv();
  for await (const m of query({
    prompt: 'Use the Bash tool once to run exactly this command: touch bash-ran. Then say done.',
    options: {
      ...(env ? { env } : {}),
      cwd,
      model,
      maxTurns: 3,
      tools: ['Bash'],
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
      projectConfigRoot: configRoot,
    },
  })) {
    if (m.type === 'result') break;
  }
  return {
    bashRan: fs.existsSync(path.join(cwd, 'bash-ran')),
    stagingMade: fs.existsSync(path.join(configRoot, ...CLI_STAGING_DIR.split('/'))),
    rootForeign: foreignInRoot(configRoot),
  };
}

const control = await run(false);
const withRoot = await run(true);
const sandboxed = await runSandboxedBash();
const leaked = withRoot.projectHook || withRoot.localHook || withRoot.projectMcp || withRoot.parentMcp;
// The control shows the planted files are live without the root (local settings are not a source: not required).
const conclusive =
  control.projectHook &&
  control.projectMcp &&
  control.parentMcp &&
  withRoot.pluginHook &&
  withRoot.claudeMd &&
  sandboxed.bashRan;
const dirtied = sandboxed.rootForeign.length > 0;
const verdict = leaked ? 'PROJECT CONFIG RAN' : dirtied ? 'ROOT DIRTIED' : conclusive ? 'ROOT HOLDS' : 'INCONCLUSIVE';
console.log(JSON.stringify({ verdict, model, control, withRoot, sandboxed }, null, 2));
process.exit(leaked ? 1 : dirtied ? 3 : conclusive ? 0 : 2);
