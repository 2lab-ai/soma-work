/**
 * `buildStreamOptions` under an execution context (#597, .prd/17 D2 · D3, T6 · T7 · T8).
 *
 * - T6: with no context the options carry no tools and no bypass — the old
 *   `!slackContext → bypass` + no-policy-hook combination is gone.
 * - T7: the policy decides from the Slack turn's context: the hard denials are
 *   denials, an escalation asks the user in the thread.
 * - T8: the hook reads the context's user, never a user named in tool input.
 * (#855 — the Slack-less dashboard task's context and its dashboard approver are gone.)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import type { ConversationSession } from '../../types';
import { userSettingsStore } from '../../user-settings-store';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';
import type { ExecutionContext } from '../execution-context';

const USER = 'U0PARITY01';
const OTHER = 'U0OTHER001';
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

describe('T7 — the Slack turn’s context decides', () => {
  async function hook() {
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, slackContext },
      makeDeps(),
    );
    return policyHook(options);
  }

  it.each([
    ['ssh is banned', 'Bash', { command: 'ssh prod-host' }, 'deny'],
    ['another user’s /tmp is off limits', 'Write', { file_path: `/tmp/${OTHER}/x.txt`, content: 'x' }, 'deny'],
  ])('%s', async (_label, tool, input, expected) => {
    expect(decisionOf(await (await hook())(call(tool, input)))).toBe(expected);
  });

  it.each([
    ['reading inside the session directory', 'Read', { file_path: `${WORK_DIR}/a.txt` }],
    ['a plain command', 'Bash', { command: 'ls -la' }],
    ['a write inside the session directory', 'Write', { file_path: `${WORK_DIR}/b.txt`, content: 'y' }],
  ])('%s is not denied', async (_label, tool, input) => {
    expect(decisionOf(await (await hook())(call(tool, input)))).not.toBe('deny');
  });

  it('an escalation asks the user in the thread', async () => {
    expect(decisionOf(await (await hook())(call('Bash', { command: 'rm -rf /' })))).toBe('ask');
  });
});

describe('a Slack turn — the speaker decides, not the session owner (#613 R1)', () => {
  it('mode and admin come from the Slack event user, as before #597', async () => {
    const { userSettingsStore } = await import('../../user-settings-store');
    const spy = vi
      .spyOn(userSettingsStore, 'getUserPermissionMode')
      .mockImplementation((u: string) => (u === 'U0SPEAKER1' ? 'legacy' : 'bypass'));
    try {
      const deps = makeDeps();
      await buildStreamOptions(
        {
          queryEnv: {},
          workingDirectory: WORK_DIR,
          session: { ownerId: 'U0OWNER001', workflow: 'default' } as ConversationSession,
          slackContext: { ...slackContext, user: 'U0SPEAKER1' } as SlackContext,
        },
        deps,
      );
      const ctx = (deps.mcpConfigBuilder.buildConfig as ReturnType<typeof vi.fn>).mock.calls[0][2] as ExecutionContext;
      expect(ctx.userId).toBe('U0SPEAKER1');
      expect(ctx.permissionMode).toBe('legacy');
      expect(spy).not.toHaveBeenCalledWith('U0OWNER001');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('T8 — the context’s user decides, not tool input', () => {
  it('a turn cannot write into another user’s directory whatever the input claims', async () => {
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, slackContext },
      makeDeps(),
    );
    const out = await policyHook(options)(
      call('Write', { file_path: `/tmp/${OTHER}/x.txt`, content: 'x', user: OTHER, userId: OTHER }),
    );
    expect(decisionOf(out)).toBe('deny');
  });
});

describe('plan mode — a session whose plan is not started (SSOT 2026-11-02, step 6c)', () => {
  const planning = { ownerId: USER, workflow: 'default', taskPlan: { state: 'awaiting', revision: 1, updatedAt: 1 } };

  it('…with the sandbox turned off too, no skill shell (trinity R5, astra P1)', async () => {
    const off = vi.spyOn(userSettingsStore, 'getUserSandboxDisabled').mockReturnValue(true);
    try {
      const { options } = await buildStreamOptions(
        { queryEnv: {}, workingDirectory: WORK_DIR, session: planning as ConversationSession, slackContext },
        makeDeps(),
      );
      expect(options.sandbox).toBeUndefined();
      expect((options.settings as { disableSkillShellExecution?: boolean }).disableSkillShellExecution).toBe(true);
    } finally {
      off.mockRestore();
    }
  });

  it('a shell or agent tool outside the usual matchers is refused (one catch-all entry)', async () => {
    const deps = makeDeps({
      mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig({ somaPermissionMode: 'bypass' })) },
    });
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, session: planning as ConversationSession, slackContext },
      deps,
    );
    const entries = (options.hooks?.PreToolUse ?? []) as Array<{ matcher?: string }>;
    expect(entries).toHaveLength(1);
    const hook = policyHook(options as { hooks?: Record<string, unknown> });
    expect(decisionOf(await hook(call('Monitor', { command: 'rm -rf src', description: 'x' })))).toBe('deny');
    expect(decisionOf(await hook(call('Workflow', { script: 'x' })))).toBe('deny');
  });

  it('a session with no plan mode is not gated: Write runs under bypass as before', async () => {
    const deps = makeDeps({
      mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig({ somaPermissionMode: 'bypass' })) },
    });
    const { options } = await buildStreamOptions({ queryEnv: {}, workingDirectory: WORK_DIR, slackContext }, deps);
    const hook = policyHook(options as { hooks?: Record<string, unknown> });
    expect(decisionOf(await hook(call('Write', { file_path: `${WORK_DIR}/a.txt`, content: 'x' })))).toBe('allow');
  });
});

describe('#853 — a session in plan mode researches (step 6c)', () => {
  const planningSession = (state: 'drafting' | 'awaiting' | 'approved') =>
    ({ ownerId: USER, workflow: 'default', taskPlan: { state, revision: 1, updatedAt: 1 } }) as ConversationSession;

  it('its turn’s context is planning: the hook refuses the work, no skill shell, every tool reaches the hook', async () => {
    const deps = makeDeps({
      mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig({ somaPermissionMode: 'bypass' })) },
    });
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, session: planningSession('awaiting'), slackContext },
      deps,
    );
    const ctx = (deps.mcpConfigBuilder.buildConfig as ReturnType<typeof vi.fn>).mock.calls[0][2] as ExecutionContext;
    expect(ctx.origin).toBe('slack');
    expect((ctx as { planPending?: true }).planPending).toBe(true);
    const hook = policyHook(options as { hooks?: Record<string, unknown> });
    expect(decisionOf(await hook(call('Write', { file_path: `${WORK_DIR}/a.txt`, content: 'x' })))).toBe('deny');
    expect(decisionOf(await hook(call('Bash', { command: 'git log -3' })))).toBe('deny');
    expect(decisionOf(await hook(call('Read', { file_path: `${WORK_DIR}/a.txt` })))).toBe('allow');
    expect((options.settings as { disableSkillShellExecution?: boolean }).disableSkillShellExecution).toBe(true);
    const entries = (options.hooks?.PreToolUse ?? []) as Array<{ matcher?: string }>;
    expect(entries[0].matcher).toBeUndefined();
  });

  it('a started plan’s turn is not gated', async () => {
    const deps = makeDeps({
      mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig({ somaPermissionMode: 'bypass' })) },
    });
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, session: planningSession('approved'), slackContext },
      deps,
    );
    const ctx = (deps.mcpConfigBuilder.buildConfig as ReturnType<typeof vi.fn>).mock.calls[0][2] as ExecutionContext;
    expect((ctx as { planPending?: true }).planPending).toBeUndefined();
    expect(
      (options.settings as { disableSkillShellExecution?: boolean } | undefined)?.disableSkillShellExecution,
    ).toBeUndefined();
  });
});

describe('#854 — an epic’s tools ride its owner’s turns only (review #872 astra)', () => {
  const epicSession = { ownerId: USER, workflow: 'default', kind: 'epic', taskId: 'e1' } as ConversationSession;
  const ctxOf = async (session: ConversationSession, speaker: string) => {
    const deps = makeDeps();
    await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, session, slackContext: { ...slackContext, user: speaker } },
      deps,
    );
    return (deps.mcpConfigBuilder.buildConfig as ReturnType<typeof vi.fn>).mock.calls[0][2] as ExecutionContext & {
      epicTaskId?: string;
    };
  };

  it('E1 — the owner’s turn (and the epic’s wake, sent as the owner) carries the epic', async () => {
    expect((await ctxOf(epicSession, USER)).epicTaskId).toBe('e1');
  });

  it('E2 — another user’s word in the epic’s thread runs as them, without the epic’s owner-powered tools', async () => {
    const ctx = await ctxOf(epicSession, OTHER);
    expect(ctx.userId).toBe(OTHER);
    expect(ctx.epicTaskId).toBeUndefined();
  });

  it('E3 — a child’s turn never carries an epic', async () => {
    expect(
      (await ctxOf({ ...epicSession, kind: undefined, parentTaskId: 'e0' } as ConversationSession, USER)).epicTaskId,
    ).toBeUndefined();
  });
});
