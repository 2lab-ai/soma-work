/**
 * `buildStreamOptions` under an execution context (#597, .prd/17 D2 · D3, T6 · T7 · T8).
 *
 * - T6: with no context the options carry no tools and no bypass — the old
 *   `!slackContext → bypass` + no-policy-hook combination is gone.
 * - T7: a Slack session and a Slack-less task with the same user, mode and
 *   directory get the same policy decision for the same tool input. The one
 *   difference is delivery of an escalation: a Slack turn can ask the user
 *   (permission prompt in the thread), a task has no approver yet (#599), so
 *   the same `classify → ask` is a deny there — explicitly, never a bypass.
 * - T8: the hook reads the context's user, never a user named in tool input.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import type { ConversationSession } from '../../types';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';
import { type ExecutionContext, executionContextForTask } from '../execution-context';

const USER = 'U0PARITY01';
const OTHER = 'U0OTHER001';
const TASK_ID = '11111111-2222-4333-8444-555555555555';
const WORK_DIR = `/tmp/${USER}/session_exec_ctx_test`;
fs.mkdirSync(WORK_DIR, { recursive: true });
afterAll(() => fs.rmSync(WORK_DIR, { recursive: true, force: true }));

function makeMcpConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    permissionMode: 'bypassPermissions',
    userBypass: true,
    somaPermissionMode: 'auto',
    allowDangerouslySkipPermissions: true,
    allowedTools: ['Bash', 'Read'],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BuildStreamOptionsDeps> = {}): BuildStreamOptionsDeps {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    getEffectivePluginPaths: () => [],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig()) },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'PROMPT') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => 'work:C123:1700000000.0001'),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
      getSessionByKey: vi.fn(() => undefined),
    } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    checkMcpToolPermission: vi.fn(() => null),
    ...overrides,
  };
}

const slackContext = { user: USER, channel: 'C123', threadTs: '1700000000.0001' } as SlackContext;

function taskContext(): ExecutionContext {
  return executionContextForTask({
    ownerId: USER,
    slackless: true,
    taskId: TASK_ID,
    channelId: '',
    workingDirectory: WORK_DIR,
  } as ConversationSession);
}

type Hook = (input: unknown) => Promise<any>;
function policyHook(options: { hooks?: Record<string, unknown> }): Hook {
  const entries = (options.hooks?.PreToolUse ?? []) as Array<{ hooks: Hook[] }>;
  expect(entries.length).toBeGreaterThan(0);
  return entries[0].hooks[0];
}

function decisionOf(out: any): string {
  return out?.hookSpecificOutput?.permissionDecision ?? (out?.continue ? 'pass' : 'none');
}

const call = (tool_name: string, tool_input: Record<string, unknown>) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  cwd: WORK_DIR,
});

describe('buildStreamOptions — no execution context (T6)', () => {
  it('no Slack context and no execution context → no tools, no bypass, no MCP, no hook', async () => {
    const deps = makeDeps();
    const { options } = await buildStreamOptions({ queryEnv: {}, workingDirectory: WORK_DIR }, deps);
    expect(options.tools).toEqual([]);
    expect(options.permissionMode).toBe('default');
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.hooks?.PreToolUse).toBeUndefined();
    expect(deps.mcpConfigBuilder.buildConfig).not.toHaveBeenCalled();
  });

  it('a Slack context with an empty user is no context — it used to select bypass', async () => {
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, slackContext: { ...slackContext, user: '' } as SlackContext },
      deps,
    );
    expect(options.tools).toEqual([]);
    expect(options.permissionMode).toBe('default');
    expect(deps.mcpConfigBuilder.buildConfig).not.toHaveBeenCalled();
  });
});

describe('buildStreamOptions — a Slack-less task (D2 · D3)', () => {
  it('builds MCP config from the task context and registers the same policy hook', async () => {
    const deps = makeDeps();
    const ctx = taskContext();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      deps,
    );
    expect(deps.mcpConfigBuilder.buildConfig).toHaveBeenCalledWith(undefined, undefined, ctx);
    expect(options.tools).toBeUndefined();
    const matchers = ((options.hooks?.PreToolUse ?? []) as Array<{ matcher: string }>).map((e) => e.matcher);
    expect(matchers).toHaveLength(5);
  });

  it('no Slack-only extras: no compaction thread hooks, no Slack approval window', async () => {
    const compactHooks = { PreCompact: vi.fn(), PostCompact: vi.fn(), SessionStart: vi.fn() };
    const deps = makeDeps({
      compactHookBuilder: vi.fn(() => compactHooks),
      mcpConfigBuilder: {
        buildConfig: vi.fn(async () => makeMcpConfig({ permissionPromptToolName: 'mcp__permission-prompt__x' })),
      },
    });
    const ctx = taskContext();
    const queryEnv: Record<string, string | undefined> = {};
    const { options } = await buildStreamOptions(
      {
        queryEnv,
        workingDirectory: ctx.workingDirectory,
        executionContext: ctx,
        session: { ownerId: USER, workflow: 'default' } as ConversationSession,
      },
      deps,
    );
    expect(options.hooks?.PreCompact).toBeUndefined();
    expect(deps.compactHookBuilder).not.toHaveBeenCalled();
    expect(queryEnv.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBeUndefined();
  });

  it('the task’s handoff context is read by its task key, not by an empty channel', async () => {
    const deps = makeDeps();
    const ctx = taskContext();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      deps,
    );
    await policyHook(options)(call('Bash', { command: 'ls' }));
    expect(deps.sessionRegistry.getSessionByKey).toHaveBeenCalledWith(`task:${TASK_ID}`);
    expect(deps.sessionRegistry.getSession).not.toHaveBeenCalled();
  });
});

describe('T7 — same input, same decision: Slack session vs Slack-less task', () => {
  async function hooks() {
    const slack = await buildStreamOptions({ queryEnv: {}, workingDirectory: WORK_DIR, slackContext }, makeDeps());
    const ctx = taskContext();
    const task = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      makeDeps(),
    );
    return { slack: policyHook(slack.options), task: policyHook(task.options) };
  }

  it.each([
    ['ssh is banned', 'Bash', { command: 'ssh prod-host' }],
    ['another user’s /tmp is off limits', 'Write', { file_path: `/tmp/${OTHER}/x.txt`, content: 'x' }],
    ['reading inside the task directory', 'Read', { file_path: `${WORK_DIR}/a.txt` }],
    ['a plain command', 'Bash', { command: 'ls -la' }],
    ['a write inside the task directory', 'Write', { file_path: `${WORK_DIR}/b.txt`, content: 'y' }],
  ])('%s', async (_label, tool, input) => {
    const h = await hooks();
    const slackDecision = decisionOf(await h.slack(call(tool, input)));
    const taskDecision = decisionOf(await h.task(call(tool, input)));
    expect(taskDecision).toBe(slackDecision);
  });

  it('the denials really are denials (the table is not all-pass)', async () => {
    const h = await hooks();
    expect(decisionOf(await h.task(call('Bash', { command: 'ssh prod-host' })))).toBe('deny');
    expect(decisionOf(await h.task(call('Write', { file_path: `/tmp/${OTHER}/x.txt`, content: 'x' })))).toBe('deny');
  });

  it('an escalation the Slack turn would ask about is a deny for a task — it has no approver yet (#599)', async () => {
    const h = await hooks();
    const input = call('Bash', { command: 'rm -rf /' });
    expect(decisionOf(await h.slack(input))).toBe('ask');
    const out = await h.task(input);
    expect(decisionOf(out)).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/approv/i);
  });
});

describe('T8 — the context’s user decides, not tool input', () => {
  it('a task cannot write into another user’s directory whatever the input claims', async () => {
    const ctx = taskContext();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      makeDeps(),
    );
    const out = await policyHook(options)(
      call('Write', { file_path: `/tmp/${OTHER}/x.txt`, content: 'x', user: OTHER, userId: OTHER }),
    );
    expect(decisionOf(out)).toBe('deny');
  });

  it('a denied environment skill does not ask Slack admins for a task (no thread to ask in), and stays denied', async () => {
    const onEnvSkillDenied = vi.fn(async () => undefined);
    const ctx = taskContext();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      makeDeps({
        getEnvSkillRegistry: () => ({ pluginNames: new Set(['acme-env']), pluginsDir: '/nonexistent-plugins' }),
        onEnvSkillDenied,
      }),
    );
    const out = await policyHook(options)({
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_input: { skill: 'acme-env:post-deploy' },
      cwd: WORK_DIR,
    });
    expect(decisionOf(out)).toBe('deny');
    expect(onEnvSkillDenied).not.toHaveBeenCalled();
  });
});
