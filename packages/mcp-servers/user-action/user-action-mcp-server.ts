#!/usr/bin/env node

/**
 * user-action MCP server — the one way the agent hands the human a task.
 *
 * A question (decision, input) goes through ASK_USER_QUESTION. A task — the
 * human has to DO something the agent cannot — comes here: a short script, the
 * machine it runs on, why, and what success looks like. The server checks the
 * script the way the agent's own Bash is checked and returns the record; the
 * host (stream-executor) shows it in its own Slack card and dashboard section.
 */

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@soma/process-shared/mcp/base-mcp-server.js';
import { BaseMcpServer } from '@soma/process-shared/mcp/base-mcp-server.js';
import { StderrLogger } from '@soma/process-shared/stderr-logger.js';
import {
  inspectUserActionScript,
  USER_ACTION_LIMITS,
  USER_ACTION_SHELLS,
  type UserActionRecord,
  type UserActionShell,
  type UserActionSyntaxCheck,
  validateInstructUserArgs,
} from '@soma/process-shared/user-action/user-action.js';

const logger = new StderrLogger('UserActionMCP');

export const INSTRUCT_USER_TOOL: ToolDefinition & { inputSchema: { type: 'object'; required: string[] } & Record<string, unknown> } = {
  name: 'instruct_user',
  description:
    'Hand the human a task they must do themselves — anything you cannot do: an owner-only verification, a login, ' +
    'a hardware or phone step, a command on a machine you cannot reach. ALWAYS use this instead of writing the ' +
    'instruction in your reply, and never bury it in a report. This is not a question: for a decision or input use ' +
    'ASK_USER_QUESTION. Every task is a short script (at most ' +
    `${USER_ACTION_LIMITS.scriptLines} lines / ${USER_ACTION_LIMITS.scriptChars} chars) plus the exact machine to ` +
    'run it on — a step that happens in a browser or on a phone still starts from a command (e.g. ' +
    "open 'https://…' on the owner's Mac). The server checks the script the way your own Bash is checked (syntax, " +
    'the dangerous-command rules, irreversible actions, sudo, network, file writes); the host shows the script and ' +
    'that check in a separate card in Slack and a "사용자 할 일" section on the dashboard. The human marks it done ' +
    'or failed and you get a message when they do. Do not repeat the script in your reply.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: `One line: what the human does (max ${USER_ACTION_LIMITS.titleChars} chars).`,
      },
      host: {
        type: 'string',
        description:
          'The machine or device to run it on, by the name the human knows (e.g. their Mac\'s host name). ' +
          'Never "your computer".',
      },
      why: { type: 'string', description: 'Why the human has to do it and you cannot.' },
      script: {
        type: 'string',
        description:
          'The short script to paste and run. One line when possible. No secrets — read them from where the human ' +
          'keeps them.',
      },
      shell: { type: 'string', enum: [...USER_ACTION_SHELLS], description: 'Default bash.' },
      expect: { type: 'string', description: 'What the human sees when it worked.' },
      effects: {
        type: 'string',
        description: 'What the script changes, in plain words (like a Bash description). Say so when it changes nothing.',
      },
      optional: { type: 'boolean', description: 'True when the work goes on fine without it.' },
    },
    required: ['title', 'host', 'why', 'script', 'expect', 'effects'],
    additionalProperties: false,
  },
};

const SYNTAX_CHECKERS: Partial<Record<UserActionShell, string>> = { bash: 'bash', zsh: 'zsh', sh: 'sh' };

/**
 * Parse the script with `<shell> -n` (read from stdin): the shell reads every
 * command and runs none. A missing shell is reported as unchecked, not passed.
 */
export function checkScriptSyntax(script: string, shell: UserActionShell): UserActionSyntaxCheck {
  const bin = SYNTAX_CHECKERS[shell];
  if (!bin) return { checked: false, ok: false, message: `${shell} 구문 검사기가 없다` };
  const tool = `${bin} -n`;
  const r = spawnSync(bin, ['-n'], { input: script, encoding: 'utf8', timeout: 3000, cwd: '/' });
  if (r.error) {
    return { checked: false, ok: false, tool, message: `${bin}을 실행하지 못했다` };
  }
  if (r.status === 0) return { checked: true, ok: true, tool };
  const message = (r.stderr || '').trim().split('\n').slice(0, 3).join('\n').slice(0, 300) || `exit ${r.status}`;
  return { checked: true, ok: false, tool, message };
}

export interface InstructUserDeps {
  checkSyntax: (script: string, shell: UserActionShell) => UserActionSyntaxCheck;
  now: () => number;
  newId: () => string;
}

export type InstructUserResponse =
  | { type: 'user_action'; ok: true; action: UserActionRecord; note: string }
  | { type: 'user_action'; ok: false; error: { code: string; message: string } };

const defaultDeps: InstructUserDeps = {
  checkSyntax: checkScriptSyntax,
  now: () => Date.now(),
  newId: () => `ua_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
};

export function buildInstructUserResponse(args: unknown, deps: InstructUserDeps = defaultDeps): InstructUserResponse {
  const v = validateInstructUserArgs(args);
  if (!v.ok) return { type: 'user_action', ok: false, error: v.error };
  const { request } = v;
  const syntax = deps.checkSyntax(request.script, request.shell);
  if (syntax.checked && !syntax.ok) {
    return {
      type: 'user_action',
      ok: false,
      error: {
        code: 'SYNTAX_ERROR',
        message: `${syntax.tool ?? 'syntax check'} rejected the script — fix it before handing it over: ${syntax.message ?? ''}`,
      },
    };
  }
  const inspection = inspectUserActionScript(request.script, request.shell, syntax);
  return {
    type: 'user_action',
    ok: true,
    action: { ...request, id: deps.newId(), createdAt: deps.now(), status: 'pending', inspection },
    note:
      'Shown to the human as its own card (Slack) and section (dashboard), with this inspection. ' +
      'Do not repeat the script in your reply; refer to the task by its title.',
  };
}

class UserActionMcpServer extends BaseMcpServer {
  constructor() {
    super('user-action');
  }

  defineTools(): ToolDefinition[] {
    return [INSTRUCT_USER_TOOL];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name !== INSTRUCT_USER_TOOL.name) throw new Error(`Unknown tool: ${name}`);
    const payload = buildInstructUserResponse(args);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: !payload.ok };
  }
}

const invokedDirectly =
  require.main === module ||
  ['user-action-mcp-server.ts', 'user-action-mcp-server.js'].includes(path.basename(process.argv[1] ?? ''));

if (invokedDirectly) {
  new UserActionMcpServer().run().catch((error) => {
    logger.error('user-action MCP server error', error);
    process.stderr.write('', () => process.exit(1));
  });
}
