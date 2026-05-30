/**
 * `buildStreamOptions` behavior pinning (ADR 0002, pass 2 — epic #1023, P1).
 *
 * P1 extracts the ~530-line `Options` assembly that `ClaudeHandler.streamQuery`
 * historically inlined into a standalone builder. This is a *no-behavior-change*
 * refactor, so these are option-parity tests: for representative inputs they
 * assert the produced `Options` matches what the inline code produced across the
 * seven dimensions called out in the epic — auth env, MCP set, hooks, sandbox,
 * prompt, cwd, resume.
 *
 * The builder only takes a `deps` bag (the `this.*` members streamQuery used)
 * plus a small input. The module-level singletons it still touches
 * (`userSettingsStore`, `isAdminUser`, `CONFIG_FILE`) are exercised with their
 * real defaults — for an unknown test user they resolve deterministically
 * (non-admin, default settings), which is exactly the production path for a
 * fresh user.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import type { ConversationSession } from '../../types';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';

// A real, existing working directory so the cwd branch (which `fs.existsSync`
// gates) actually sets `options.cwd`.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'build-stream-opts-'));
afterAll(() => {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

const SAFE_USER = 'U0PARITY01'; // alphanumeric → passes isSafePathSegment

function makeMcpConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    permissionMode: 'bypassPermissions',
    userBypass: true,
    allowDangerouslySkipPermissions: true,
    mcpServers: { mcp__demo: { type: 'stdio', command: 'demo' } },
    allowedTools: ['Bash', 'Read'],
    disallowedTools: ['SomeNativeInteractiveTool'],
    permissionPromptToolName: 'mcp__permission-prompt__permission_prompt',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BuildStreamOptionsDeps> = {}): BuildStreamOptionsDeps {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    getEffectivePluginPaths: () => [{ type: 'local', path: '/plugins/demo' } as never],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig()) },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'BUILT-PROMPT') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => 'chan:thread'),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
    } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    checkMcpToolPermission: vi.fn(() => null),
    ...overrides,
  };
}

function makeSlackContext(overrides: Partial<SlackContext> = {}): SlackContext {
  return {
    user: SAFE_USER,
    channel: 'C123',
    threadTs: '1700000000.0001',
    channelDescription: 'demo channel',
    repos: ['2lab-ai/soma-work'],
    ...overrides,
  } as SlackContext;
}

describe('buildStreamOptions — option parity (epic #1023 P1)', () => {
  it('auth env: forwards queryEnv by reference and pins settingSources/plugins', async () => {
    const queryEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'lease-token-xyz', PATH: '/usr/bin' };
    const deps = makeDeps();
    const { options } = await buildStreamOptions({ queryEnv }, deps);

    // env passed by reference — matches inline behaviour (no clone).
    expect(options.env).toBe(queryEnv);
    expect(options.settingSources).toEqual(['project']);
    expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/demo' }]);
  });

  it('MCP set: copies permissionMode / servers / allowed / disallowed / promptTool / skipPerms', async () => {
    const deps = makeDeps();
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);

    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.mcpServers).toEqual({ mcp__demo: { type: 'stdio', command: 'demo' } });
    expect(options.allowedTools).toEqual(['Bash', 'Read']);
    expect(options.disallowedTools).toEqual(['SomeNativeInteractiveTool']);
    expect(options.permissionPromptToolName).toBe('mcp__permission-prompt__permission_prompt');
  });

  it('MCP set: omits empty allowed/disallowed arrays (inline guarded on length>0)', async () => {
    const deps = makeDeps({
      mcpConfigBuilder: {
        buildConfig: vi.fn(async () => makeMcpConfig({ allowedTools: [], disallowedTools: [] })),
      },
    });
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
  });

  it('hooks: composes a non-empty PreToolUse array for a non-admin slack user', async () => {
    const deps = makeDeps();
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);
    const preToolUse = options.hooks?.PreToolUse;
    expect(Array.isArray(preToolUse)).toBe(true);
    // ssh-ban + sensitive(4) + cross-user + bypass-bash + bypass-native + pr-issue
    expect((preToolUse ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it('hooks: registers PreCompact/PostCompact/SessionStart only when compactHookBuilder + session + threadTs', async () => {
    const compactHooks = { PreCompact: vi.fn(), PostCompact: vi.fn(), SessionStart: vi.fn() };
    const deps = makeDeps({ compactHookBuilder: vi.fn(() => compactHooks) });
    const session = { workflow: 'default', ownerId: SAFE_USER } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session, slackContext: makeSlackContext() }, deps);
    expect(options.hooks?.PreCompact).toBeDefined();
    expect(options.hooks?.PostCompact).toBeDefined();
    expect(options.hooks?.SessionStart).toBeDefined();
    expect(deps.compactHookBuilder).toHaveBeenCalledOnce();
  });

  it('hooks: no PreToolUse when slackContext is absent (non-slack caller)', async () => {
    const deps = makeDeps();
    const { options } = await buildStreamOptions({ queryEnv: {} }, deps);
    expect(options.hooks?.PreToolUse).toBeUndefined();
  });

  it('sandbox: enabled by default with per-user write mount + dev-domain network allowlist', async () => {
    const deps = makeDeps();
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);
    const sandbox = options.sandbox as Record<string, unknown> | undefined;
    expect(sandbox?.enabled).toBe(true);
    expect(sandbox?.autoAllowBashIfSandboxed).toBe(true);
    const filesystem = sandbox?.filesystem as { allowWrite?: string[] } | undefined;
    expect(filesystem?.allowWrite?.[0]).toContain(SAFE_USER);
    const network = sandbox?.network as { allowedDomains?: string[] } | undefined;
    expect(Array.isArray(network?.allowedDomains)).toBe(true);
    expect((network?.allowedDomains ?? []).length).toBeGreaterThan(0);
  });

  it('sandbox: network omitted when user disabled network', async () => {
    const spy = vi.spyOn(await import('../../user-settings-store'), 'userSettingsStore', 'get').mockReturnValue({
      getUserDefaultModel: () => 'm',
      getUserThinkingEnabled: () => true,
      getUserShowThinking: () => false,
      getUserSandboxDisabled: () => false,
      getUserNetworkDisabled: () => true,
    } as never);
    try {
      const deps = makeDeps();
      const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);
      const sandbox = options.sandbox as Record<string, unknown>;
      expect(sandbox.enabled).toBe(true);
      expect(sandbox.network).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('prompt: builds + injects channel-description and repo-context, caches on session', async () => {
    const deps = makeDeps();
    const session = { workflow: 'default', ownerId: SAFE_USER } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session, slackContext: makeSlackContext() }, deps);
    expect(deps.promptBuilder.buildSystemPrompt).toHaveBeenCalledOnce();
    expect(options.systemPrompt).toContain('BUILT-PROMPT');
    expect(options.systemPrompt).toContain('demo channel'); // channel-description injection
    expect(options.systemPrompt).toContain('2lab-ai/soma-work'); // repo-context injection
    expect(session.systemPrompt).toBe(options.systemPrompt); // cached back onto session
  });

  it('prompt: reuses cached session.systemPrompt without rebuilding (resume branch)', async () => {
    const deps = makeDeps();
    const session = {
      sessionId: 'sess-cached',
      systemPrompt: 'CACHED-SNAPSHOT',
      workflow: 'default',
      ownerId: SAFE_USER,
    } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session, slackContext: makeSlackContext() }, deps);
    expect(deps.promptBuilder.buildSystemPrompt).not.toHaveBeenCalled();
    expect(options.systemPrompt).toBe('CACHED-SNAPSHOT');
  });

  it('cwd: sets cwd to an existing working dir and expands additionalDirectories to the user root', async () => {
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: WORK_DIR, slackContext: makeSlackContext() },
      deps,
    );
    expect(options.cwd).toBe(WORK_DIR);
    expect(options.additionalDirectories?.some((d) => d.includes(SAFE_USER))).toBe(true);
  });

  it('resume: sets options.resume from session.sessionId', async () => {
    const deps = makeDeps();
    const session = { sessionId: 'resume-me-123', systemPrompt: 'x' } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, deps);
    expect(options.resume).toBe('resume-me-123');
  });

  it('resume: no resume for a fresh conversation (no sessionId)', async () => {
    const deps = makeDeps();
    const { options } = await buildStreamOptions({ queryEnv: {} }, deps);
    expect(options.resume).toBeUndefined();
  });

  it('abortController + stderr: wires the abort signal and accumulates stderr into the buffer', async () => {
    const deps = makeDeps();
    const abortController = new AbortController();
    const { options, getStderrBuffer } = await buildStreamOptions({ queryEnv: {}, abortController }, deps);
    expect(options.abortController).toBe(abortController);
    expect(getStderrBuffer()).toBe('');
    options.stderr?.('boom-1\n');
    options.stderr?.('boom-2\n');
    expect(getStderrBuffer()).toBe('boom-1\nboom-2\n');
  });
});
