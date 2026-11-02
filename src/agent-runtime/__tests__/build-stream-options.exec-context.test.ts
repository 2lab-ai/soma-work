/**
 * `buildStreamOptions` under an execution context (#597, .prd/17 D2 · D3, T6 · T7 · T8).
 *
 * - T6: with no context the options carry no tools and no bypass — the old
 *   `!slackContext → bypass` + no-policy-hook combination is gone.
 * - T7: a Slack session and a Slack-less task with the same user, mode and
 *   directory get the same policy decision for the same tool input. The one
 *   difference is delivery of an escalation: a Slack turn can ask the user
 *   (permission prompt in the thread); a task waits for its owner's dashboard
 *   approval (#599 ⑤b), and with no approver wired the same `classify → ask`
 *   is a deny — explicitly, never a bypass.
 * - T8: the hook reads the context's user, never a user named in tool input.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import type { ConversationSession } from '../../types';
import { userSettingsStore } from '../../user-settings-store';
import {
  type BuildStreamOptionsDeps,
  buildStreamOptions,
  TASK_APPROVAL_HOOK_MARGIN_MS,
  TASK_APPROVAL_HOOK_TIMEOUT_S,
} from '../claude-code/build-stream-options';
import { type ExecutionContext, ExecutionContextMissingError, executionContextForTask } from '../execution-context';

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

describe('a task runs in the directory its context validated (#613 R1, D6/T8)', () => {
  it('a caller’s different working directory is refused, not used', async () => {
    const ctx = taskContext();
    await expect(
      buildStreamOptions({ queryEnv: {}, workingDirectory: `/tmp/${OTHER}/x`, executionContext: ctx }, makeDeps()),
    ).rejects.toBeInstanceOf(ExecutionContextMissingError);
  });

  it('with no directory argument the task’s own directory becomes the cwd', async () => {
    const ctx = taskContext();
    const { options } = await buildStreamOptions({ queryEnv: {}, executionContext: ctx }, makeDeps());
    expect(options.cwd).toBe(ctx.workingDirectory);
  });

  it('a task directory that does not exist yet is refused, not created — the run entry point makes it (#613 R3)', async () => {
    const missing = `/tmp/${USER}/session_exec_ctx_not_made_yet`;
    fs.rmSync(missing, { recursive: true, force: true });
    const ctx = executionContextForTask({
      ownerId: USER,
      slackless: true,
      taskId: TASK_ID,
      channelId: '',
      workingDirectory: missing,
    } as ConversationSession);
    await expect(buildStreamOptions({ queryEnv: {}, executionContext: ctx }, makeDeps())).rejects.toBeInstanceOf(
      ExecutionContextMissingError,
    );
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('a task whose directory cannot be made is refused — never run in the server’s directory (#613 R2)', async () => {
    const blocked = `/tmp/${USER}/session_exec_ctx_blocked`;
    fs.rmSync(blocked, { recursive: true, force: true });
    const ctx = executionContextForTask({
      ownerId: USER,
      slackless: true,
      taskId: TASK_ID,
      channelId: '',
      workingDirectory: `${blocked}/sub`,
    } as ConversationSession);
    fs.writeFileSync(blocked, 'a file where the directory should be');
    try {
      await expect(buildStreamOptions({ queryEnv: {}, executionContext: ctx }, makeDeps())).rejects.toBeInstanceOf(
        ExecutionContextMissingError,
      );
    } finally {
      fs.rmSync(blocked, { force: true });
    }
  });

  it('a task context with a Slack context — even the same user’s — is refused (#613 R2)', async () => {
    const ctx = taskContext();
    await expect(
      buildStreamOptions({ queryEnv: {}, executionContext: ctx, slackContext }, makeDeps()),
    ).rejects.toBeInstanceOf(ExecutionContextMissingError);
  });

  it('a task directory swapped for a link out of the root after the context was built is refused at build time (#613 R2)', async () => {
    const swapped = `/tmp/${USER}/session_exec_ctx_swap`;
    const outside = `/tmp/${OTHER}/exec_ctx_swap_target`;
    fs.rmSync(swapped, { recursive: true, force: true });
    fs.mkdirSync(swapped, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const ctx = executionContextForTask({
      ownerId: USER,
      slackless: true,
      taskId: TASK_ID,
      channelId: '',
      workingDirectory: swapped,
    } as ConversationSession);
    fs.rmSync(swapped, { recursive: true, force: true });
    fs.symlinkSync(outside, swapped);
    try {
      await expect(buildStreamOptions({ queryEnv: {}, executionContext: ctx }, makeDeps())).rejects.toBeInstanceOf(
        ExecutionContextMissingError,
      );
    } finally {
      fs.rmSync(swapped, { force: true });
      fs.rmSync(`/tmp/${OTHER}`, { recursive: true, force: true });
    }
  });

  it('a context and a Slack event naming different users is refused', async () => {
    const ctx = taskContext();
    await expect(
      buildStreamOptions(
        { queryEnv: {}, executionContext: ctx, slackContext: { ...slackContext, user: OTHER } as SlackContext },
        makeDeps(),
      ),
    ).rejects.toBeInstanceOf(ExecutionContextMissingError);
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

// SSOT 2026-11-02 (trinity R1, fable P1) — another user's instruction runs as
// them in the owner's task folder. The cross-user Bash guard is held to the
// task's owner root (the root the task lives in), so the folder the model is
// told it works in is not "another user's directory" to it; writes stay held
// to the task folder and the sender's own root (sandbox + native boundary).
describe('a task turn run by someone other than its owner (SSOT 2026-11-02)', () => {
  const ACTOR = 'U0ACTOR001';
  async function hook() {
    const ctx = executionContextForTask(
      {
        ownerId: USER,
        slackless: true,
        taskId: TASK_ID,
        channelId: '',
        workingDirectory: WORK_DIR,
      } as ConversationSession,
      ACTOR,
    );
    expect(ctx.userId).toBe(ACTOR);
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      makeDeps(),
    );
    return policyHook(options);
  }

  it('Bash naming the task folder by its absolute path is not a cross-user denial', async () => {
    const h = await hook();
    const out = await h(call('Bash', { command: `cd ${WORK_DIR} && ls -la` }));
    expect(decisionOf(out)).not.toBe('deny');
  });

  it('a third user’s /tmp stays off limits, and writes stay in the task folder', async () => {
    const h = await hook();
    expect(decisionOf(await h(call('Bash', { command: `cat /tmp/${OTHER}/secret` })))).toBe('deny');
    expect(decisionOf(await h(call('Write', { file_path: `/tmp/${USER}/other_task/x.txt`, content: 'x' })))).toBe(
      'deny',
    );
    expect(decisionOf(await h(call('Write', { file_path: `${WORK_DIR}/ok.txt`, content: 'y' })))).not.toBe('deny');
  });

  // Trinity R2 (fable P2) — the owner-root exemption leans on the OS sandbox holding Bash's writes.
  it('never runs unsandboxed: the sandbox fails closed for it, and with the sender’s sandbox off the guard is theirs', async () => {
    const ctx = executionContextForTask(
      {
        ownerId: USER,
        slackless: true,
        taskId: TASK_ID,
        channelId: '',
        workingDirectory: WORK_DIR,
      } as ConversationSession,
      ACTOR,
    );
    const on = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      makeDeps(),
    );
    expect(on.options.sandbox?.failIfUnavailable).toBe(true);
    const own = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, executionContext: taskContext() },
      makeDeps(),
    );
    expect(own.options.sandbox?.failIfUnavailable).toBe(false); // the owner's own turn: as before
    const off = vi.spyOn(userSettingsStore, 'getUserSandboxDisabled').mockReturnValue(true);
    try {
      const { options } = await buildStreamOptions(
        { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
        makeDeps(),
      );
      expect(options.sandbox).toBeUndefined();
      expect(decisionOf(await policyHook(options)(call('Bash', { command: `cd ${WORK_DIR} && ls` })))).toBe('deny');
    } finally {
      off.mockRestore();
    }
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

describe('#599 ⑤ — a task’s escalation waits for the dashboard approval', () => {
  async function taskHook(taskApprover?: BuildStreamOptionsDeps['taskApprover']) {
    const ctx = taskContext();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      makeDeps(taskApprover ? { taskApprover } : {}),
    );
    return { hook: policyHook(options), options, ctx };
  }
  const escalation = call('Bash', { command: 'rm -rf /' });

  it('approved on the dashboard → allowed; the request is bound to the task, its owner, the tool and the rules', async () => {
    const request = vi.fn(async () => ({ behavior: 'allow' as const }));
    const { hook, ctx } = await taskHook({ request });
    const out = await hook(escalation);
    expect(decisionOf(out)).toBe('allow');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: ctx.sessionKey,
        userId: USER,
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
      }),
    );
  });

  // #637 R1 (fable P2) — the approver is told when the SDK will cancel this hook.
  it('the request carries the hook’s deadline: entry time + the SDK timeout − the margin', async () => {
    const request = vi.fn(async (_r: { deadlineAt?: number }) => ({ behavior: 'allow' as const }));
    const { hook } = await taskHook({ request });
    const before = Date.now();
    await hook(escalation);
    const after = Date.now();
    const deadlineAt = request.mock.calls[0][0].deadlineAt as number;
    const budget = TASK_APPROVAL_HOOK_TIMEOUT_S * 1000 - TASK_APPROVAL_HOOK_MARGIN_MS;
    expect(deadlineAt).toBeGreaterThanOrEqual(before + budget);
    expect(deadlineAt).toBeLessThanOrEqual(after + budget);
  });

  it('refused on the dashboard → denied, with the answer as the reason', async () => {
    const { hook } = await taskHook({ request: async () => ({ behavior: 'deny', message: 'not on prod' }) });
    const out = await hook(escalation);
    expect(decisionOf(out)).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/not on prod/);
  });

  it('an approver that fails (store error, expiry, abort) → denied — never run unapproved', async () => {
    const { hook } = await taskHook({
      request: async () => {
        throw new Error('ENOSPC');
      },
    });
    expect(decisionOf(await hook(escalation))).toBe('deny');
  });

  it('the hook may wait for the approval: a task turn’s PreToolUse matchers carry a timeout above the approval window', async () => {
    const { options } = await taskHook({ request: async () => ({ behavior: 'allow' as const }) });
    const matchers = (options.hooks?.PreToolUse ?? []) as Array<{ timeout?: number }>;
    expect(matchers.length).toBeGreaterThan(0);
    for (const m of matchers) expect(m.timeout).toBeGreaterThanOrEqual(330);
  });

  it('a call that needs no approval never reaches the approver', async () => {
    const request = vi.fn(async () => ({ behavior: 'allow' as const }));
    const { hook } = await taskHook({ request });
    await hook(call('Bash', { command: 'ls -la' }));
    await hook(call('Bash', { command: 'ssh prod-host' }));
    expect(request).not.toHaveBeenCalled();
  });
});

describe('plan mode — a task whose plan is not started researches (SSOT 2026-11-02, step 6c)', () => {
  function planningContext(): ExecutionContext {
    return executionContextForTask({
      ownerId: USER,
      slackless: true,
      taskId: TASK_ID,
      channelId: '',
      workingDirectory: WORK_DIR,
      taskPlan: { state: 'awaiting', revision: 1, updatedAt: 1 },
    } as ConversationSession);
  }

  it('the hook refuses the work (Write, a changing command) and lets reading through', async () => {
    const ctx = planningContext();
    expect((ctx as { planPending?: true }).planPending).toBe(true);
    const deps = makeDeps({
      mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig({ somaPermissionMode: 'bypass' })) },
    });
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      deps,
    );
    const hook = policyHook(options as { hooks?: Record<string, unknown> });
    const write = await hook(call('Write', { file_path: `${WORK_DIR}/a.txt`, content: 'x' }));
    expect(decisionOf(write)).toBe('deny');
    expect(String(write.hookSpecificOutput.permissionDecisionReason)).toContain('plan is not started');
    expect(decisionOf(await hook(call('Bash', { command: 'git commit -am wip' })))).toBe('deny');
    expect(decisionOf(await hook(call('Bash', { command: 'git log -3' })))).toBe('allow');
    expect(decisionOf(await hook(call('Read', { file_path: `${WORK_DIR}/a.txt` })))).toBe('allow');
  });

  it('every tool reaches the hook (one catch-all entry): a shell or agent tool outside the usual matchers is refused', async () => {
    const ctx = planningContext();
    const deps = makeDeps({
      mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig({ somaPermissionMode: 'bypass' })) },
    });
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      deps,
    );
    const entries = (options.hooks?.PreToolUse ?? []) as Array<{ matcher?: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBeUndefined();
    const hook = policyHook(options as { hooks?: Record<string, unknown> });
    expect(decisionOf(await hook(call('Monitor', { command: 'rm -rf src', description: 'x' })))).toBe('deny');
    expect(decisionOf(await hook(call('Workflow', { script: 'x' })))).toBe('deny');
  });

  it('a started plan (or no plan mode) is not gated: Write runs under bypass as before', async () => {
    const deps = makeDeps({
      mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig({ somaPermissionMode: 'bypass' })) },
    });
    const ctx = taskContext();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      deps,
    );
    const hook = policyHook(options as { hooks?: Record<string, unknown> });
    expect(decisionOf(await hook(call('Write', { file_path: `${WORK_DIR}/a.txt`, content: 'x' })))).toBe('allow');
  });
});
