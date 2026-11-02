/**
 * SSOT 2026-11-02 T2 — the escalation hands the guardian's advice to the prompt.
 *
 * A Slack turn's `classify → ask` leaves the advice on the board for the
 * permission prompt of the same session, tool and input. A Slack-less task's
 * escalation passes it to the dashboard approval. A guardian with no advice
 * leaves that fact (null), so the prompt does not ask the guardian again.
 */
import * as fs from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import type { ConversationSession } from '../../types';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';
import { executionContextForTask } from '../execution-context';
import { permissionAdviceBoard } from '../policy/permission-advice';

const USER = 'U0ADVICE01';
const TASK_ID = '22222222-3333-4444-8555-666666666666';
const WORK_DIR = `/tmp/${USER}/session_permission_advice_test`;
const SESSION_KEY = 'work:C777:1700000000.0007';
fs.mkdirSync(WORK_DIR, { recursive: true });
afterAll(() => fs.rmSync(WORK_DIR, { recursive: true, force: true }));

const DENY = { recommendation: 'deny' as const, summary: '루트를 지웁니다', risk: '되돌릴 수 없습니다' };

function makeDeps(overrides: Partial<BuildStreamOptionsDeps> = {}): BuildStreamOptionsDeps {
  const mcp: McpConfig = {
    permissionMode: 'bypassPermissions',
    userBypass: true,
    somaPermissionMode: 'auto',
    allowDangerouslySkipPermissions: true,
    allowedTools: ['Bash'],
  };
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getEffectivePluginPaths: () => [],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: { buildConfig: vi.fn(async () => mcp) },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'PROMPT') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => SESSION_KEY),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
      getSessionByKey: vi.fn(() => undefined),
    } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    checkMcpToolPermission: vi.fn(() => null),
    ...overrides,
  };
}

type Hook = (input: unknown) => Promise<any>;
function hookOf(options: { hooks?: Record<string, unknown> }): Hook {
  return ((options.hooks?.PreToolUse ?? []) as Array<{ hooks: Hook[] }>)[0].hooks[0];
}
const call = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  cwd: WORK_DIR,
});

describe('the escalation leaves the advice for the prompt', () => {
  it('Slack turn: classify → ask puts the advice on the board under the session, tool and input', async () => {
    const classify = vi.fn(async () => ({ verdict: 'ask' as const, reason: 'broad', advice: DENY }));
    const { options } = await buildStreamOptions(
      {
        queryEnv: {},
        workingDirectory: WORK_DIR,
        slackContext: { user: USER, channel: 'C777', threadTs: '1700000000.0007' } as SlackContext,
      },
      makeDeps({ safetyClassifier: { classify } }),
    );
    const out = await hookOf(options)(call('rm -rf /'));
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(permissionAdviceBoard.take(SESSION_KEY, 'Bash', { command: 'rm -rf /' })).toEqual({ advice: DENY });
  });

  it('Slack turn: a guardian with no advice leaves null, so the prompt does not ask again', async () => {
    const classify = vi.fn(async () => ({ verdict: 'ask' as const, reason: 'unparseable' }));
    const { options } = await buildStreamOptions(
      {
        queryEnv: {},
        workingDirectory: WORK_DIR,
        slackContext: { user: USER, channel: 'C777', threadTs: '1700000000.0007' } as SlackContext,
      },
      makeDeps({ safetyClassifier: { classify } }),
    );
    await hookOf(options)(call('rm -rf /var'));
    expect(permissionAdviceBoard.take(SESSION_KEY, 'Bash', { command: 'rm -rf /var' })).toEqual({ advice: null });
  });

  it('task turn: the dashboard approval request carries the advice', async () => {
    const classify = vi.fn(async () => ({ verdict: 'ask' as const, reason: 'broad', advice: DENY }));
    const request = vi.fn(async (_req: unknown) => ({ behavior: 'deny' as const }));
    const ctx = executionContextForTask({
      ownerId: USER,
      slackless: true,
      taskId: TASK_ID,
      channelId: '',
      workingDirectory: WORK_DIR,
    } as ConversationSession);
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, executionContext: ctx },
      makeDeps({ safetyClassifier: { classify }, taskApprover: { request } }),
    );
    await hookOf(options)(call('rm -rf /'));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ advice: DENY }));
  });
});
