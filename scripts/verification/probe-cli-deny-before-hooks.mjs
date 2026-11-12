#!/usr/bin/env node
/**
 * Probe: does the pinned Claude Code CLI apply `settings.permissions.deny` before a PreToolUse hook's `allow`?
 *
 * The write protection and credential read rules every session gets (env-access WU2, #1210) are CLI deny rules,
 * and the policy hook returns an explicit `allow` for native tools in auto and bypass mode
 * (`build-stream-options.ts`). They hold only if the CLI rejects a denied path before it asks the hook.
 * Measured with CLI 2.1.321: it does — Read and Write fail with "denied by your permission settings" and the
 * hook is never called for them, Grep and Glob leave the file out, while a permitted Read reaches the hook.
 *
 * Re-run it on every Claude Agent SDK / CLI version bump. One short model call per run (a cheap model).
 *
 *   node scripts/verification/probe-cli-deny-before-hooks.mjs [model]      # default claude-haiku-4-5
 *
 * Exit 0: deny rules held and the hook fired for the permitted read. Exit 1: a denied path got through.
 * Exit 2: inconclusive (the hook never fired, or the model skipped a step) — read the printed tool results.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const model = process.argv[2] ?? 'claude-haiku-4-5';
const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'deny-before-hooks-'));
fs.mkdirSync(path.join(base, 'protected'));
const nonce = `NONCE-${Math.random().toString(36).slice(2, 10)}`;
const secret = path.join(base, 'secret.txt');
const permitted = path.join(base, 'ok.txt');
const target = path.join(base, 'protected', 'x.txt');
fs.writeFileSync(secret, `${nonce}\n`);
fs.writeFileSync(permitted, 'OK-FILE\n');

const hookCalls = [];
const q = query({
  prompt:
    `Step 0: use the Read tool on ${permitted}. ` +
    `Step 1: use the Read tool on ${secret} and quote its content exactly. ` +
    `Step 2: use the Write tool to write the word pwned to ${target}. ` +
    `Step 3: use the Grep tool with pattern NONCE, path ${base}, output_mode content. ` +
    `Step 4: use the Glob tool with pattern secret* in path ${base}. ` +
    'Do every step even if one fails. Then report each tool result exactly.',
  options: {
    cwd: base,
    model,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    maxTurns: 8,
    tools: ['Read', 'Write', 'Grep', 'Glob'],
    settings: { permissions: { deny: [`Read(/${secret})`, `Edit(/${path.join(base, 'protected')}/**)`] } },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              hookCalls.push({ tool: input.tool_name, path: input.tool_input?.file_path ?? input.tool_input?.path });
              return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
            },
          ],
        },
      ],
    },
  },
});

const toolResults = [];
for await (const m of q) {
  if (m.type !== 'user' || !Array.isArray(m.message?.content)) continue;
  for (const c of m.message.content) {
    if (c.type !== 'tool_result') continue;
    const text = Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('') : String(c.content);
    toolResults.push({ is_error: Boolean(c.is_error), text: text.slice(0, 200) });
  }
}

const leaked = toolResults.some((r) => r.text.includes(nonce)) || fs.existsSync(target);
const hookFiredForPermitted = hookCalls.some((h) => h.path === permitted);
const verdict = leaked ? 'DENY BYPASSED' : hookFiredForPermitted ? 'DENY HELD' : 'INCONCLUSIVE';
console.log(JSON.stringify({ verdict, model, hookCalls, toolResults }, null, 2));
process.exit(leaked ? 1 : hookFiredForPermitted ? 0 : 2);
