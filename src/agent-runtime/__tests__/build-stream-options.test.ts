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
    somaPermissionMode: 'bypass',
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

  it('MCP set: preserves the five-minute Slack approval window for the in-process prompt tool', async () => {
    const deps = makeDeps();
    const queryEnv: Record<string, string | undefined> = {};
    const { options } = await buildStreamOptions({ queryEnv, slackContext: makeSlackContext() }, deps);

    expect(options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe('310000');
    expect(options.env).toBe(queryEnv);
  });

  it('MCP set: preserves an operator-provided stream-close timeout', async () => {
    const deps = makeDeps();
    const queryEnv: Record<string, string | undefined> = { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000' };
    const { options } = await buildStreamOptions({ queryEnv, slackContext: makeSlackContext() }, deps);

    expect(options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe('600000');
  });

  it('MCP set: does not change the stream-close timeout without Slack context', async () => {
    const deps = makeDeps();
    const queryEnv: Record<string, string | undefined> = {};
    const { options } = await buildStreamOptions({ queryEnv }, deps);

    expect(options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBeUndefined();
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

  it('hooks: registers the unified ToolPolicy hook across the governed matchers (epic #1023 P5)', async () => {
    const deps = makeDeps();
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);
    const preToolUse = options.hooks?.PreToolUse;
    expect(Array.isArray(preToolUse)).toBe(true);
    // P5 collapsed the per-concern hooks into one policy hook fanned out across
    // three matchers: Bash, the native-bypass tool union, and mcp__.
    const matchers = (preToolUse ?? []).map((e) => (e as { matcher: string }).matcher);
    expect(matchers).toHaveLength(3);
    expect(matchers).toContain('Bash');
    expect(matchers).toContain('mcp__');
    expect(matchers.some((m) => m.includes('Write') && m.includes('Read'))).toBe(true);
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

  describe('model-profile context env (harness compaction authority)', () => {
    // Ruling 2026-08-26: the HARNESS owns automatic compaction
    // (`checkAndSchedulePendingCompact`), so SDK-native autocompact is turned
    // off for every session. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` cannot be the
    // second authority: the pinned SDK clamps it to its own model window
    // (`Jn` → `Math.min(ff(model), configured)`, cli.js) and `ff` returns
    // 200,000 (`WR1`) for every id it does not know — so a 750k trigger on
    // `claude-fable-5[1m]` would still fire at ~167k. Only
    // `DISABLE_AUTO_COMPACT` (read by `z0()`, which gates the whole
    // autocompact path) removes that second authority.
    const EVERY_RESOLVED_MODEL = [
      'claude-fable-5',
      'claude-fable-5[1m]',
      'claude-opus-5',
      'claude-opus-5[1m]',
      'gpt-5.6-sol',
      'gpt-5.6-sol[1m]',
      'gpt-5.5',
      'grok-4.6',
      'claude-opus-4-7',
      'claude-opus-4-7[1m]',
    ];

    it('injects CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE for a native-1M session model', async () => {
      const queryEnv: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: 'lease-token' };
      const deps = makeDeps();
      const session = { model: 'claude-fable-5', systemPrompt: 'x', sessionId: 's1' } as ConversationSession;
      const { options } = await buildStreamOptions({ queryEnv, session }, deps);

      // In-place injection — env identity (auth contract) is preserved.
      expect(options.env).toBe(queryEnv);
      expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('977000');
      expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('lease-token'); // untouched
    });

    it('injects DISABLE_AUTO_COMPACT=1 for every resolved model profile', async () => {
      for (const model of EVERY_RESOLVED_MODEL) {
        const deps = makeDeps();
        const session = { model, systemPrompt: 'x', sessionId: `sd-${model}` } as ConversationSession;
        const { options } = await buildStreamOptions({ queryEnv: {}, session }, deps);
        expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
      }
    });

    it('never injects CLAUDE_CODE_AUTO_COMPACT_WINDOW for any profile', async () => {
      for (const model of EVERY_RESOLVED_MODEL) {
        const deps = makeDeps();
        const session = { model, systemPrompt: 'x', sessionId: `sw-${model}` } as ConversationSession;
        const { options } = await buildStreamOptions({ queryEnv: {}, session }, deps);
        expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      }
    });

    it('injects CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=<profile limit> for every resolved model', async () => {
      // Unconditional, profile-window-derived — there is no "does the SDK know
      // this id?" tier. For ids the SDK sizes correctly the value simply
      // equals its own computation (200k window → 177000).
      const limits: [model: string, limit: string][] = [
        ['claude-fable-5', '977000'],
        ['claude-fable-5[1m]', '977000'],
        ['claude-opus-5', '177000'],
        ['claude-opus-5[1m]', '977000'],
        ['gpt-5.6-sol', '349000'],
        ['gpt-5.6-sol[1m]', '977000'],
        ['gpt-5.5', '252000'],
        ['grok-4.6', '477000'],
        ['claude-opus-4-7', '177000'],
        ['claude-opus-4-7[1m]', '977000'],
      ];
      for (const [model, limit] of limits) {
        const deps = makeDeps();
        const session = { model, systemPrompt: 'x', sessionId: `sb-${model}` } as ConversationSession;
        const { options } = await buildStreamOptions({ queryEnv: {}, session }, deps);
        expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe(limit);
      }
    });

    it('injects the 200k-window limit for a bare claude model', async () => {
      const deps = makeDeps();
      const session = { model: 'claude-opus-4-7', systemPrompt: 'x', sessionId: 's2' } as ConversationSession;
      const { options } = await buildStreamOptions({ queryEnv: {}, session }, deps);
      expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
      expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('177000');
    });

    it('injects the 1M limit for the generic `[1m]` suffix opt-in', async () => {
      const deps = makeDeps();
      const session = { model: 'claude-opus-4-7[1m]', systemPrompt: 'x', sessionId: 's3' } as ConversationSession;
      const { options } = await buildStreamOptions({ queryEnv: {}, session }, deps);
      expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
      expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('977000');
    });

    it('does NOT inject when no model resolves', async () => {
      const deps = makeDeps();
      const { options } = await buildStreamOptions({ queryEnv: {} }, deps);
      expect(options.env?.DISABLE_AUTO_COMPACT).toBeUndefined();
      expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBeUndefined();
    });

    it('respects operator-provided values (no clobbering)', async () => {
      const deps = makeDeps();
      const session = { model: 'gpt-5.6-sol', systemPrompt: 'x', sessionId: 's4' } as ConversationSession;
      const queryEnv: Record<string, string | undefined> = {
        DISABLE_AUTO_COMPACT: '0',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '111111',
        CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: '500000',
      };
      const { options } = await buildStreamOptions({ queryEnv, session }, deps);
      // An operator who deliberately re-enables SDK autocompact keeps it.
      expect(options.env?.DISABLE_AUTO_COMPACT).toBe('0');
      expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('111111');
      expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('500000');
    });

    it('never writes CLAUDE_CODE_AUTO_COMPACT_WINDOW but never deletes an operator value either', async () => {
      // "We are not the author of this key" cuts both ways: the builder must
      // not set it (the SDK would clamp it to 200k for unknown ids) and must
      // not remove an operator's deliberate value.
      for (const model of EVERY_RESOLVED_MODEL) {
        const deps = makeDeps();
        const session = { model, systemPrompt: 'x', sessionId: `so-${model}` } as ConversationSession;
        const queryEnv: Record<string, string | undefined> = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123456' };
        const { options } = await buildStreamOptions({ queryEnv, session }, deps);
        expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('123456');
      }
    });

    it('leaves an operator-provided DISABLE_AUTO_COMPACT untouched for every resolved model', async () => {
      for (const model of EVERY_RESOLVED_MODEL) {
        const deps = makeDeps();
        const session = { model, systemPrompt: 'x', sessionId: `sk-${model}` } as ConversationSession;
        const queryEnv: Record<string, string | undefined> = { DISABLE_AUTO_COMPACT: '0' };
        const { options } = await buildStreamOptions({ queryEnv, session }, deps);
        expect(options.env?.DISABLE_AUTO_COMPACT).toBe('0');
      }
    });

    /** The env-injection info line, if the builder emitted one. */
    function injectionLog(deps: BuildStreamOptionsDeps): [string, { wrote?: string[] }] | undefined {
      const calls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls as [string, { wrote?: string[] }][];
      return calls.find(([message]) => message.includes('context-window env'));
    }

    it('logs only the env keys it actually wrote', async () => {
      const deps = makeDeps();
      const session = { model: 'gpt-5.6-sol', systemPrompt: 'x', sessionId: 'sl1' } as ConversationSession;
      const queryEnv: Record<string, string | undefined> = { DISABLE_AUTO_COMPACT: '0' };
      await buildStreamOptions({ queryEnv, session }, deps);

      expect(injectionLog(deps)?.[1].wrote).toEqual(['CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE']);
    });

    it('says nothing when the operator already set every key (no "Injected" line for a no-op)', async () => {
      const deps = makeDeps();
      const session = { model: 'gpt-5.6-sol', systemPrompt: 'x', sessionId: 'sl2' } as ConversationSession;
      const queryEnv: Record<string, string | undefined> = {
        DISABLE_AUTO_COMPACT: '0',
        CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: '500000',
      };
      await buildStreamOptions({ queryEnv, session }, deps);

      expect(injectionLog(deps)).toBeUndefined();
    });

    it('gpt-5.6-sol[1m] gets the 1M blocking limit (977000), NOT the bare family 349000', async () => {
      const deps = makeDeps();
      const session = { model: 'gpt-5.6-sol[1m]', systemPrompt: 'x', sessionId: 's1m' } as ConversationSession;
      const { options } = await buildStreamOptions({ queryEnv: {}, session }, deps);
      expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('977000');
    });

    it('bare gpt-5.6-sol keeps the family 349000 blocking limit', async () => {
      const deps = makeDeps();
      const session = { model: 'gpt-5.6-sol', systemPrompt: 'x', sessionId: 's1b' } as ConversationSession;
      const { options } = await buildStreamOptions({ queryEnv: {}, session }, deps);
      expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('349000');
    });

    it('claude-opus-5 gets its own window limit on both spellings (177000 / 977000)', async () => {
      for (const [model, limit] of [
        ['claude-opus-5[1m]', '977000'],
        ['claude-opus-5', '177000'],
      ]) {
        const deps = makeDeps();
        const session = { model, systemPrompt: 'x', sessionId: `s-${model}` } as ConversationSession;
        const { options } = await buildStreamOptions({ queryEnv: {}, session }, deps);
        expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
        expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe(limit);
      }
    });

    it('injects when the native-1M model comes from the user default (no session model)', async () => {
      const spy = vi.spyOn(await import('../../user-settings-store'), 'userSettingsStore', 'get').mockReturnValue({
        getUserDefaultModel: () => 'claude-fable-5',
        getUserThinkingEnabled: () => true,
        getUserShowThinking: () => false,
        getUserSandboxDisabled: () => false,
        getUserNetworkDisabled: () => false,
      } as never);
      try {
        const deps = makeDeps();
        const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);
        expect(options.model).toBe('claude-fable-5');
        expect(options.env?.DISABLE_AUTO_COMPACT).toBe('1');
        expect(options.env?.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe('977000');
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('abortController + stderr: wires the abort signal, tracked child spawn, and stderr buffer', async () => {
    const deps = makeDeps();
    const abortController = new AbortController();
    const { options, getStderrBuffer } = await buildStreamOptions({ queryEnv: {}, abortController }, deps);
    expect(options.abortController).toBe(abortController);
    expect(options.spawnClaudeCodeProcess).toBeTypeOf('function');
    expect(getStderrBuffer()).toBe('');
    options.stderr?.('boom-1\n');
    options.stderr?.('boom-2\n');
    expect(getStderrBuffer()).toBe('boom-1\nboom-2\n');
  });
});
