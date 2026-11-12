#!/usr/bin/env node
/**
 * Probe: with `projectConfigRoot` at an empty directory, does the pinned Claude Code CLI ignore the project
 * settings and project MCP config in the working directory, while still reading its CLAUDE.md and running plugin
 * hooks? Sessions rely on it (env-access #1242, `src/sandbox/project-config-root.ts`): a model writes its working
 * directory, and the CLI runs project hooks and project MCP servers outside the sandbox.
 * Measured with CLI 2.1.321: yes.
 *
 * Re-run it on every Claude Agent SDK / CLI version bump. Two short model sessions per run (a cheap model).
 *
 *   node scripts/verification/probe-cli-project-config-root.mjs [model]     # default claude-haiku-4-5
 *   PROBE_ISOLATED_CONFIG=1 node …   # use a fresh CLAUDE_CONFIG_DIR (needed inside a sandboxed session, where the
 *                                    # CLI cannot write its usual config directory and so runs no hooks at all)
 *
 * Exit 0: with the root set, no project or local hook and no project MCP server (in the working directory or
 *         above it) ran, the plugin hook did, and
 *         CLAUDE.md applied; without it (the control) the project hook and server did run.
 * Exit 1: with the root set, a project or local hook, or a project MCP server (working directory or above), ran.
 * Exit 2: inconclusive — the control did not run them, the plugin hook did not run, or CLAUDE.md was not applied.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const model = process.argv[2] ?? 'claude-haiku-4-5';
const tmp = fs.realpathSync(os.tmpdir());

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
  const env = process.env.PROBE_ISOLATED_CONFIG
    ? { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(tmp, 'probe-config-')) }
    : undefined;
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

const control = await run(false);
const withRoot = await run(true);
const leaked = withRoot.projectHook || withRoot.localHook || withRoot.projectMcp || withRoot.parentMcp;
// The control shows the planted files are live without the root (local settings are not a source: not required).
const conclusive =
  control.projectHook && control.projectMcp && control.parentMcp && withRoot.pluginHook && withRoot.claudeMd;
const verdict = leaked ? 'PROJECT CONFIG RAN' : conclusive ? 'ROOT HOLDS' : 'INCONCLUSIVE';
console.log(JSON.stringify({ verdict, model, control, withRoot }, null, 2));
process.exit(leaked ? 1 : conclusive ? 0 : 2);
