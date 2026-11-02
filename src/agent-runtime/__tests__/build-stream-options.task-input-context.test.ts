/**
 * E2 ② — a Slack-instructed task's input context (.prd/18 D4).
 *
 * A task made from a Slack instruction stores the channel's description and
 * repos with it, and its turn's system prompt carries the same channel blocks a
 * Slack session in that channel gets — byte for byte — without a Slack context
 * (the task-turn ban on `slackContext` stays) and without changing the prompt
 * a task with no input context gets.
 */
import * as fs from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import type { ConversationSession } from '../../types';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';
import { ExecutionContextMissingError, executionContextForTask } from '../execution-context';

const USER = 'U0INPUTCTX1';
const TASK_ID = '11111111-2222-4333-8444-666666666666';
const WORK_DIR = `/tmp/${USER}/session_input_ctx_test`;
fs.mkdirSync(WORK_DIR, { recursive: true });
afterAll(() => fs.rmSync(WORK_DIR, { recursive: true, force: true }));

const DESCRIPTION = '<https://github.com/2lab-ai/soma-work>';
const REPOS = ['2lab-ai/soma-work', 'https://github.com/2lab-ai/libsoma'];
const CONFLUENCE = 'https://wiki.example.com/x/PROJ';

function makeDeps(): BuildStreamOptionsDeps {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config: McpConfig = {
    permissionMode: 'bypassPermissions',
    userBypass: true,
    somaPermissionMode: 'auto',
    allowDangerouslySkipPermissions: true,
    allowedTools: ['Bash'],
  } as McpConfig;
  return {
    logger,
    getEffectivePluginPaths: () => [],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: { buildConfig: vi.fn(async () => config) },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'PROMPT') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => 'work:C123:1700000000.0001'),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
      getSessionByKey: vi.fn(() => undefined),
    } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    checkMcpToolPermission: vi.fn(() => null),
  };
}

function taskSession(extra: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: USER,
    userId: USER,
    ownerName: 'User',
    slackless: true,
    taskId: TASK_ID,
    channelId: '',
    workingDirectory: WORK_DIR,
    workflow: 'default',
    isActive: true,
    lastActivity: new Date(),
    ...extra,
  } as ConversationSession;
}

async function taskPrompt(session: ConversationSession): Promise<string | undefined> {
  const ctx = executionContextForTask(session);
  const { options } = await buildStreamOptions(
    { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx, session },
    makeDeps(),
  );
  return options.systemPrompt as string | undefined;
}

async function slackPrompt(context: Partial<SlackContext>): Promise<string | undefined> {
  const session = { ownerId: USER, workflow: 'default', channelId: 'C123' } as ConversationSession;
  const { options } = await buildStreamOptions(
    {
      queryEnv: {},
      workingDirectory: WORK_DIR,
      session,
      slackContext: { user: USER, channel: 'C123', threadTs: '1700000000.0001', ...context } as SlackContext,
    },
    makeDeps(),
  );
  return options.systemPrompt as string | undefined;
}

describe('buildStreamOptions — a Slack-instructed task’s input context (E2 ②)', () => {
  it('the task turn’s prompt carries the same channel description and repo blocks as a Slack session — byte for byte', async () => {
    const inputContext = {
      channelName: 'soma-work',
      channelDescription: DESCRIPTION,
      repos: REPOS,
      confluenceUrl: CONFLUENCE,
    };
    const task = await taskPrompt(taskSession({ inputContext }));
    const slack = await slackPrompt({ channelDescription: DESCRIPTION, repos: REPOS, confluenceUrl: CONFLUENCE });
    expect(task).toBe(slack);
    expect(task).toContain('<channel-description source="slack">');
    expect(task).toContain('<channel-repository>');
    expect(task).toContain('https://github.com/2lab-ai/soma-work');
    expect(task).toContain(`Project wiki: ${CONFLUENCE}`);
  });

  it('repos only, description only — each block exactly as a Slack session gets it', async () => {
    expect(await taskPrompt(taskSession({ inputContext: { repos: REPOS } }))).toBe(await slackPrompt({ repos: REPOS }));
    expect(await taskPrompt(taskSession({ inputContext: { channelDescription: DESCRIPTION } }))).toBe(
      await slackPrompt({ channelDescription: DESCRIPTION }),
    );
  });

  it('the start log reports the context the prompt was built from — the task’s snapshot on a task turn', async () => {
    const session = taskSession({ inputContext: { channelDescription: DESCRIPTION, repos: REPOS } });
    const ctx = executionContextForTask(session);
    const deps = makeDeps();
    await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx, session },
      deps,
    );
    const start = (deps.logger.info as any).mock.calls.find((c: unknown[]) => String(c[0]).includes('STARTING QUERY'));
    expect(start?.[1]).toMatchObject({ hasChannelDescription: true, repos: REPOS });
  });

  it('a task with no input context (a dashboard task) gets the prompt it gets today', async () => {
    expect(await taskPrompt(taskSession())).toBe('PROMPT');
  });

  it('the input context is prompt text only: the Slack-context ban and the MCP config are unchanged', async () => {
    const session = taskSession({ inputContext: { channelDescription: DESCRIPTION, repos: REPOS } });
    const ctx = executionContextForTask(session);
    const deps = makeDeps();
    await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx, session },
      deps,
    );
    // No Slack context reaches the MCP builder (so no slack-mcp / model-command / cron / permission prompt).
    expect(deps.mcpConfigBuilder.buildConfig).toHaveBeenCalledWith(undefined, undefined, ctx);
    // A task turn handed a Slack context is still refused.
    await expect(
      buildStreamOptions(
        {
          queryEnv: {},
          workingDirectory: ctx.workingDirectory,
          executionContext: ctx,
          session,
          slackContext: { user: USER, channel: 'C123' } as SlackContext,
        },
        makeDeps(),
      ),
    ).rejects.toBeInstanceOf(ExecutionContextMissingError);
  });

  it('a Slack session never reads a session input context (only a task turn does)', async () => {
    const session = {
      ownerId: USER,
      workflow: 'default',
      channelId: 'C123',
      inputContext: { channelDescription: 'SHOULD NOT APPEAR', repos: ['x/should-not-appear'] },
    } as ConversationSession;
    const { options } = await buildStreamOptions(
      {
        queryEnv: {},
        workingDirectory: WORK_DIR,
        session,
        slackContext: { user: USER, channel: 'C123' } as SlackContext,
      },
      makeDeps(),
    );
    expect(options.systemPrompt).toBe('PROMPT');
  });

  it('a turn that is not a task never falls back to a session input context — not even with no Slack context', async () => {
    const session = {
      ownerId: USER,
      workflow: 'default',
      channelId: 'C123',
      inputContext: { channelDescription: 'SHOULD NOT APPEAR', repos: ['x/should-not-appear'] },
    } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, workingDirectory: WORK_DIR, session }, makeDeps());
    expect(options.systemPrompt).toBe('PROMPT');
  });
});
