/**
 * Review gate r1 (grok P2): the warning step runs inside the PreToolUse hook,
 * after the model said allow. Any synchronous throw there — not only a rejected
 * publish — must leave the decision at `allow`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../policy/permission-warning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../policy/permission-warning')>();
  return {
    ...actual,
    permissionWarningRuleIds: () => {
      throw new Error('warning check exploded');
    },
  };
});

import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';

describe('buildStreamOptions — a warning failure never changes the allow', () => {
  it('a throwing warning check still returns allow', async () => {
    const mcp = {
      permissionMode: 'bypassPermissions',
      userBypass: true,
      somaPermissionMode: 'auto',
      allowDangerouslySkipPermissions: true,
    } as McpConfig;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = {
      logger,
      getEffectivePluginPaths: () => [],
      buildModelCommandContext: () => undefined,
      mcpConfigBuilder: { buildConfig: vi.fn(async () => mcp) },
      promptBuilder: { buildSystemPrompt: vi.fn(() => 'P') },
      sessionRegistry: {
        getSessionKey: vi.fn(() => 'c:t'),
        isDangerousRuleDisabled: vi.fn(() => false),
        getSession: vi.fn(() => undefined),
      },
      checkMcpToolPermission: vi.fn(() => null),
      safetyClassifier: { classify: vi.fn(async () => ({ verdict: 'allow' as const, reason: 'ok' })) },
      onPermissionWarning: vi.fn(),
    } as unknown as BuildStreamOptionsDeps;
    const slackContext = { user: 'U0WARNFAIL', channel: 'C1', threadTs: '1.1' } as SlackContext;
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext }, deps);
    const entry = (options.hooks?.PreToolUse ?? []).find((e) => (e as { matcher: string }).matcher === 'Bash');
    const hook = (entry as { hooks: Array<(i: unknown) => Promise<any>> }).hooks[0];
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf ./scratch-x' } });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(deps.onPermissionWarning).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Permission warning could not be published', expect.any(Object));
  });
});
