/**
 * ssot-task: T2/T3 — the permission guardian blocked by Anthropic's safeguards
 * halts the session; it never becomes a prompt the requester may approve
 * (review R5, astra P1).
 *
 * The guardian is a Claude API call about this session's tool call. When the
 * safeguards block it, the work stops like a blocked turn does: the tool call
 * is denied, the session is locked and the running turn stops — only an admin
 * may retry.
 */
import * as fs from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';
import { PermissionAdviceBoard, permissionAdviceBoard, resolvePermissionAdvice } from '../policy/permission-advice';
import { LlmSafetyClassifier, type SafetyClassifier } from '../policy/safety-classifier';

const BLOCK =
  "API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup). " +
  "This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with " +
  'Opus 5.5 (1M context). Try rephrasing the request in a new session or change your model. ' +
  'Learn more: https://support.claude.com/en/articles/8106465\n' +
  'Details: `[reasoning_extraction]`\nRequest ID: req_011CggxYZxQ7TEBU95XW3X19\nMessage ID: msg_011CggxYckLHkHA9sUKftEWG';

const FLAG = {
  model: 'Opus 5.5 (1M context)',
  detail: 'reasoning_extraction',
  requestId: 'req_011CggxYZxQ7TEBU95XW3X19',
  messageId: 'msg_011CggxYckLHkHA9sUKftEWG',
};

describe('LlmSafetyClassifier: a guardian call the safeguards blocked', () => {
  const req = { toolName: 'Bash', command: 'rm -rf /', toolInput: {}, matchedRuleIds: [], user: 'U1' };

  it('reports the flag when the block comes back as the reply', async () => {
    const verdict = await new LlmSafetyClassifier(async () => BLOCK).classify(req);
    expect(verdict.verdict).not.toBe('allow');
    expect(verdict.safeguardFlag).toMatchObject(FLAG);
  });

  it('reports the flag when the call throws the block', async () => {
    const verdict = await new LlmSafetyClassifier(async () => {
      throw new Error(BLOCK);
    }).classify(req);
    expect(verdict.verdict).not.toBe('allow');
    expect(verdict.safeguardFlag).toMatchObject(FLAG);
  });

  it('reports nothing for an ordinary reply', async () => {
    const verdict = await new LlmSafetyClassifier(async () => '{"verdict":"ask","reason":"broad"}').classify(req);
    expect(verdict.safeguardFlag).toBeUndefined();
  });
});

const USER = 'U0GUARDSG1';
const WORK_DIR = `/tmp/${USER}/session_safeguard_guardian_test`;
const SESSION_KEY = 'work:C905:1700000000.0905';
fs.mkdirSync(WORK_DIR, { recursive: true });
afterAll(() => fs.rmSync(WORK_DIR, { recursive: true, force: true }));

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

async function hookWith(classifier: SafetyClassifier, overrides: Partial<BuildStreamOptionsDeps> = {}) {
  const abortController = new AbortController();
  const { options } = await buildStreamOptions(
    {
      queryEnv: {},
      workingDirectory: WORK_DIR,
      abortController,
      slackContext: { user: USER, channel: 'C905', threadTs: '1700000000.0905' } as SlackContext,
    },
    makeDeps({ safetyClassifier: classifier, ...overrides }),
  );
  return { hook: hookOf(options), abortController };
}

describe('policy hook: the guardian blocked by the safeguards', () => {
  it('denies the call, halts the session and stops the turn — no prompt for the requester', async () => {
    const onSafeguardFlag = vi.fn();
    const { hook, abortController } = await hookWith(
      { classify: vi.fn(async () => ({ verdict: 'ask' as const, reason: 'blocked', safeguardFlag: FLAG })) },
      { onSafeguardFlag },
    );
    const out = await hook(call('rm -rf /srv'));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('세이프가드 에러');
    expect(onSafeguardFlag).toHaveBeenCalledWith(SESSION_KEY, expect.objectContaining(FLAG));
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe('safeguard');
    // No advice left for a prompt: there is no prompt.
    expect(permissionAdviceBoard.take(SESSION_KEY, 'Bash', { command: 'rm -rf /srv' })).toBeUndefined();
  });

  it('treats a guardian that throws the block the same way', async () => {
    const onSafeguardFlag = vi.fn();
    const { hook } = await hookWith(
      {
        classify: vi.fn(async () => {
          throw new Error(BLOCK);
        }),
      },
      { onSafeguardFlag },
    );
    const out = await hook(call('rm -rf /data'));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(onSafeguardFlag).toHaveBeenCalledWith(SESSION_KEY, expect.objectContaining(FLAG));
  });

  it('an ordinary escalation still asks', async () => {
    const onSafeguardFlag = vi.fn();
    const { hook, abortController } = await hookWith(
      { classify: vi.fn(async () => ({ verdict: 'ask' as const, reason: 'broad' })) },
      { onSafeguardFlag },
    );
    const out = await hook(call('rm -rf /tmp/x'));
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(onSafeguardFlag).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
    permissionAdviceBoard.take(SESSION_KEY, 'Bash', { command: 'rm -rf /tmp/x' });
  });
});

describe('permission advice: the guardian blocked by the safeguards', () => {
  it('reports the flag for the session and leaves the prompt without advice', async () => {
    const onSafeguardFlag = vi.fn();
    const advice = await resolvePermissionAdvice({
      board: new PermissionAdviceBoard(),
      scope: 'S1',
      toolName: 'Bash',
      input: { command: 'rm -rf ./build' },
      user: 'U1',
      classifier: {
        classify: vi.fn(async () => ({ verdict: 'ask' as const, reason: 'blocked', safeguardFlag: FLAG })),
      },
      onSafeguardFlag,
    });
    expect(advice).toBeNull();
    expect(onSafeguardFlag).toHaveBeenCalledWith(expect.objectContaining(FLAG));
  });
});
