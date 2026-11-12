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
 * Exit 0: with the root set, the project hook and project MCP server did not run, the plugin hook did, and
 *         CLAUDE.md applied; without it (the control) the project hook and server did run.
 * Exit 1: with the root set, the project hook or the project MCP server ran.
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
  const cwd = path.join(base, 'session');
  const configRoot = path.join(base, 'config-root');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(configRoot);
  const marker = (name) => path.join(base, `marker-${name}`);
  fs.writeFileSync(
    path.join(cwd, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker('project-hook')}` }] }] } }),
  );
  fs.writeFileSync(
    path.join(cwd, '.mcp.json'),
    JSON.stringify({ mcpServers: { probe: { command: 'sh', args: ['-c', `touch ${marker('project-mcp')}; sleep 2`] } } }),
  );
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
    projectMcp: ran('project-mcp'),
    pluginHook: ran('plugin-hook'),
    claudeMd: /PINEAPPLE/.test(reply),
  };
}

const control = await run(false);
const withRoot = await run(true);
const leaked = withRoot.projectHook || withRoot.projectMcp;
const conclusive =
  control.projectHook && control.projectMcp && withRoot.pluginHook && withRoot.claudeMd;
const verdict = leaked ? 'PROJECT CONFIG RAN' : conclusive ? 'ROOT HOLDS' : 'INCONCLUSIVE';
console.log(JSON.stringify({ verdict, model, control, withRoot }, null, 2));
process.exit(leaked ? 1 : conclusive ? 0 : 2);
