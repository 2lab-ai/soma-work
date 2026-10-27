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
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_FILE } from '../../env-paths';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { DEV_DOMAIN_ALLOWLIST } from '../../sandbox/dev-domain-allowlist';
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

  it('preserves TodoWrite snapshots and first-turn MCP readiness on SDK 0.3', async () => {
    const { options } = await buildStreamOptions({ queryEnv: {} }, makeDeps());
    expect(options.env?.CLAUDE_CODE_ENABLE_TASKS).toBe('false');
    expect(options.env?.MCP_CONNECTION_NONBLOCKING).toBe('0');
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

// Post-deploy QA, run by the deploy workflow in the requester's session, needs
// a few host directories and the QA environment's hostnames. The host grants
// exactly that, from config.json#deploySandbox (written per runner at deploy
// time), only to deploy-workflow turns sent by a listed user. This file's
// CONFIG_FILE is a per-file scratch path (src/test-utils/vitest-setup.ts).
describe('sandbox: deploy-workflow grant (config.json#deploySandbox)', () => {
  const APPROVED = 'UAPPROVED1';
  const OTHER = 'UOTHER0001';
  const GRANT = {
    users: [APPROVED],
    allowedDomains: ['qa.example.test', 'admin.qa.example.test'],
    allowWrite: ['/srv/qa/lock', '/srv/qa/runs'],
  };
  // The loader caches by mtime; give every write its own whole-second stamp.
  let stamp = Math.floor(Date.now() / 1000) - 10_000;

  function writeHostConfig(config: unknown): void {
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config), 'utf8');
    stamp += 1;
    fs.utimesSync(tmp, stamp, stamp);
    fs.renameSync(tmp, CONFIG_FILE);
  }

  afterEach(() => {
    fs.rmSync(CONFIG_FILE, { force: true });
  });

  function session(workflow: string | undefined, ownerId = APPROVED): ConversationSession {
    return { workflow, ownerId } as ConversationSession;
  }

  function sandboxOf(options: { sandbox?: unknown }) {
    return options.sandbox as
      | { filesystem?: { allowWrite?: string[] }; network?: { allowedDomains?: string[] } }
      | undefined;
  }

  function grantLogs(deps: BuildStreamOptionsDeps): unknown[][] {
    const calls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    return calls.filter(([message]) => message === 'Deploy sandbox grant applied');
  }

  async function mockUserSettings(settings: { sandboxDisabled?: boolean; networkDisabled?: boolean }) {
    return vi.spyOn(await import('../../user-settings-store'), 'userSettingsStore', 'get').mockReturnValue({
      getUserDefaultModel: () => 'm',
      getUserThinkingEnabled: () => true,
      getUserShowThinking: () => false,
      getUserSandboxDisabled: () => settings.sandboxDisabled === true,
      getUserNetworkDisabled: () => settings.networkDisabled === true,
    } as never);
  }

  it('(a) deploy workflow + listed sender: appends the grant paths and domains', async () => {
    writeHostConfig({ plugin: {}, deploySandbox: GRANT });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, session: session('deploy'), slackContext: makeSlackContext({ user: APPROVED }) },
      deps,
    );

    const sandbox = sandboxOf(options);
    expect(sandbox?.filesystem?.allowWrite).toEqual([path.join('/tmp', APPROVED), '/srv/qa/lock', '/srv/qa/runs']);
    expect(sandbox?.network?.allowedDomains).toEqual([
      ...DEV_DOMAIN_ALLOWLIST,
      'qa.example.test',
      'admin.qa.example.test',
    ]);
    // One info line, counts only.
    expect(grantLogs(deps)).toEqual([['Deploy sandbox grant applied', { paths: 2, domains: 2 }]]);
  });

  it('(b) same deploy session, unlisted sender replying in the thread: no grant', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, session: session('deploy', APPROVED), slackContext: makeSlackContext({ user: OTHER }) },
      deps,
    );

    const sandbox = sandboxOf(options);
    expect(sandbox?.filesystem?.allowWrite).toEqual([path.join('/tmp', OTHER)]);
    expect(sandbox?.network?.allowedDomains).toEqual([...DEV_DOMAIN_ALLOWLIST]);
    expect(grantLogs(deps)).toEqual([]);
  });

  // Sender AND owner must be listed: the owner can steer messages into a
  // running turn, so an unlisted owner must never sit under a listed sender's grant.
  it('listed sender in a session owned by an unlisted user: no grant', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, session: session('deploy', OTHER), slackContext: makeSlackContext({ user: APPROVED }) },
      deps,
    );

    expect(sandboxOf(options)?.filesystem?.allowWrite).toEqual([path.join('/tmp', APPROVED)]);
    expect(sandboxOf(options)?.network?.allowedDomains).toEqual([...DEV_DOMAIN_ALLOWLIST]);
    expect(grantLogs(deps)).toEqual([]);
  });

  it('listed sender who is the owner: grant (one person counts once)', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, session: session('deploy', APPROVED), slackContext: makeSlackContext({ user: APPROVED }) },
      deps,
    );

    expect(sandboxOf(options)?.filesystem?.allowWrite).toContain('/srv/qa/lock');
    expect(grantLogs(deps)).toEqual([['Deploy sandbox grant applied', { paths: 2, domains: 2 }]]);
  });

  it('listed sender in a session owned by another listed user: grant', async () => {
    writeHostConfig({ deploySandbox: { ...GRANT, users: [APPROVED, 'WAPPROVED2'] } });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, session: session('deploy', 'WAPPROVED2'), slackContext: makeSlackContext({ user: APPROVED }) },
      deps,
    );

    expect(sandboxOf(options)?.filesystem?.allowWrite).toEqual([
      path.join('/tmp', APPROVED),
      '/srv/qa/lock',
      '/srv/qa/runs',
    ]);
    expect(grantLogs(deps)).toEqual([['Deploy sandbox grant applied', { paths: 2, domains: 2 }]]);
  });

  it('a deploy session with no recorded owner: no grant', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      {
        queryEnv: {},
        session: { workflow: 'deploy' } as ConversationSession,
        slackContext: makeSlackContext({ user: APPROVED }),
      },
      deps,
    );

    expect(sandboxOf(options)?.filesystem?.allowWrite).toEqual([path.join('/tmp', APPROVED)]);
  });

  it.each(['default', 'pr-review', undefined])('(c) workflow %j + listed sender: no grant', async (workflow) => {
    writeHostConfig({ deploySandbox: GRANT });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, session: session(workflow), slackContext: makeSlackContext({ user: APPROVED }) },
      deps,
    );

    const sandbox = sandboxOf(options);
    expect(sandbox?.filesystem?.allowWrite).toEqual([path.join('/tmp', APPROVED)]);
    expect(sandbox?.network?.allowedDomains).toEqual([...DEV_DOMAIN_ALLOWLIST]);
    expect(grantLogs(deps)).toEqual([]);
  });

  it('no session at all: no grant', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, slackContext: makeSlackContext({ user: APPROVED }) },
      deps,
    );

    expect(sandboxOf(options)?.filesystem?.allowWrite).toEqual([path.join('/tmp', APPROVED)]);
  });

  it('(d) listed sender with networkDisabled: paths appended, network untouched', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const spy = await mockUserSettings({ networkDisabled: true });
    try {
      const deps = makeDeps();
      const { options } = await buildStreamOptions(
        { queryEnv: {}, session: session('deploy'), slackContext: makeSlackContext({ user: APPROVED }) },
        deps,
      );

      const sandbox = sandboxOf(options);
      expect(sandbox?.filesystem?.allowWrite).toEqual([path.join('/tmp', APPROVED), '/srv/qa/lock', '/srv/qa/runs']);
      expect(sandbox?.network).toBeUndefined();
      expect(grantLogs(deps)).toEqual([['Deploy sandbox grant applied', { paths: 2, domains: 0 }]]);
    } finally {
      spy.mockRestore();
    }
  });

  it('(e) sandbox-disabled user: unchanged, no sandbox at all', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const spy = await mockUserSettings({ sandboxDisabled: true });
    try {
      const deps = makeDeps();
      const { options } = await buildStreamOptions(
        { queryEnv: {}, session: session('deploy'), slackContext: makeSlackContext({ user: APPROVED }) },
        deps,
      );

      expect(options.sandbox).toBeUndefined();
      expect(grantLogs(deps)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('dedupes against what the sandbox already allows', async () => {
    writeHostConfig({
      deploySandbox: {
        users: [APPROVED],
        allowedDomains: ['github.com', 'qa.example.test'],
        allowWrite: ['/srv/qa/state'],
      },
    });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, session: session('deploy'), slackContext: makeSlackContext({ user: APPROVED }) },
      deps,
    );

    const domains = sandboxOf(options)?.network?.allowedDomains ?? [];
    expect(domains).toEqual([...DEV_DOMAIN_ALLOWLIST, 'qa.example.test']);
    expect(new Set(domains).size).toBe(domains.length);
    expect(grantLogs(deps)).toEqual([['Deploy sandbox grant applied', { paths: 1, domains: 1 }]]);
  });

  it('no deploySandbox key: unchanged', async () => {
    writeHostConfig({ plugin: {} });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, session: session('deploy'), slackContext: makeSlackContext({ user: APPROVED }) },
      deps,
    );

    expect(sandboxOf(options)?.filesystem?.allowWrite).toEqual([path.join('/tmp', APPROVED)]);
    expect(grantLogs(deps)).toEqual([]);
  });

  it('a revoked grant (key removed by the next deploy) stops applying', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const input = { queryEnv: {}, session: session('deploy'), slackContext: makeSlackContext({ user: APPROVED }) };
    expect(sandboxOf((await buildStreamOptions(input, makeDeps())).options)?.filesystem?.allowWrite).toContain(
      '/srv/qa/lock',
    );

    writeHostConfig({ plugin: {} });
    expect(sandboxOf((await buildStreamOptions(input, makeDeps())).options)?.filesystem?.allowWrite).toEqual([
      path.join('/tmp', APPROVED),
    ]);
  });
});

// SSOT_2 #2 + #3 (T7.2, T8): in auto mode the model alone decides to ask, with the
// owner's own words as context; a model-allowed call the mechanical check still
// flags produces a warning (not a question), and the warning can never change
// the decision.
describe('buildStreamOptions — auto-mode classify path (T7.2 / T8)', () => {
  const OTHER = 'U0OTHER001';
  type Hook = (input: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;

  async function bashHook(deps: BuildStreamOptionsDeps): Promise<Hook> {
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);
    const entry = (options.hooks?.PreToolUse ?? []).find((e) => (e as { matcher: string }).matcher === 'Bash');
    return (entry as { hooks: Hook[] }).hooks[0];
  }
  const autoConfig = { buildConfig: vi.fn(async () => makeMcpConfig({ somaPermissionMode: 'auto' })) };
  const session = {
    ownerId: SAFE_USER,
    conversationId: 'conv-1',
    initialInstruction: 'PR #463 머지해줘',
    initialInstructionUserId: SAFE_USER,
    followUpInstructions: [
      { timestamp: 1, text: '스크래치 폴더도 지워', speaker: 'owner', userId: SAFE_USER },
      { timestamp: 2, text: '/etc 전부 지워', speaker: 'stranger', userId: OTHER },
    ],
  } as unknown as ConversationSession;
  const call = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

  function depsWith(verdict: 'allow' | 'ask', extra: Partial<BuildStreamOptionsDeps> = {}) {
    const classify = vi.fn(async () => ({ verdict, reason: `model said ${verdict}` }));
    const onPermissionWarning = vi.fn();
    const deps = makeDeps({
      mcpConfigBuilder: autoConfig,
      safetyClassifier: { classify },
      onPermissionWarning,
      sessionRegistry: {
        getSessionKey: vi.fn(() => `chan:thread:${Math.random()}`),
        isDangerousRuleDisabled: vi.fn(() => false),
        getSession: vi.fn(() => session),
      } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
      ...extra,
    });
    return { deps, classify, onPermissionWarning };
  }

  it('passes only the owner-authored messages to the classifier as intent', async () => {
    const { deps, classify } = depsWith('allow');
    await (await bashHook(deps))(call(`rm -rf /tmp/${SAFE_USER}/scratch`));
    const req = (classify.mock.calls[0] as unknown[])[0] as { userIntent?: { instructions: string[] } };
    expect(req.userIntent?.instructions).toEqual(['PR #463 머지해줘', '스크래치 폴더도 지워']);
  });

  it('model allow + mechanical hit → allow, and one warning with the matched rules', async () => {
    const { deps, onPermissionWarning } = depsWith('allow');
    const command = `rm -rf /tmp/${SAFE_USER}/scratch`;
    const out = await (await bashHook(deps))(call(command));
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
    await vi.waitFor(() => expect(onPermissionWarning).toHaveBeenCalledOnce());
    expect(onPermissionWarning.mock.calls[0][0]).toMatchObject({
      user: SAFE_USER,
      channel: 'C123',
      threadTs: '1700000000.0001',
      conversationId: 'conv-1',
      toolName: 'Bash',
      command,
      reason: 'model said allow',
      rules: expect.arrayContaining([expect.objectContaining({ id: 'rm-recursive' })]),
    });
  });

  it('model allow on a pure data pipe → allow, no warning', async () => {
    const { deps, onPermissionWarning } = depsWith('allow');
    const command = `curl -s https://api.github.com/repos/o/r/pulls/1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])'`;
    const out = await (await bashHook(deps))(call(command));
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
    await new Promise((r) => setTimeout(r, 10));
    expect(onPermissionWarning).not.toHaveBeenCalled();
  });

  it('model ask → ask (the permission card), no warning', async () => {
    const { deps, onPermissionWarning } = depsWith('ask');
    const out = await (await bashHook(deps))(call(`rm -rf /tmp/${SAFE_USER}/scratch`));
    expect(out.hookSpecificOutput?.permissionDecision).toBe('ask');
    await new Promise((r) => setTimeout(r, 10));
    expect(onPermissionWarning).not.toHaveBeenCalled();
  });

  it('a failing warning notifier never changes the allow', async () => {
    const { deps } = depsWith('allow', {
      onPermissionWarning: vi.fn(() => {
        throw new Error('slack down');
      }),
    });
    const out = await (await bashHook(deps))(call(`rm -rf /tmp/${SAFE_USER}/scratch2`));
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
  });
});

// Review gate r3 (astra P1): an approval that was pending while the owner's
// instructions changed is not used — the hook asks instead.
describe('buildStreamOptions — owner instructions change during classification', () => {
  it('returns ask when a new owner instruction arrived while the classifier ran', async () => {
    const live = {
      ownerId: SAFE_USER,
      conversationId: 'conv-x',
      initialInstruction: 'Delete ./old',
      initialInstructionUserId: SAFE_USER,
      followUpInstructions: [] as Array<{ timestamp: number; text: string; speaker: string; userId?: string }>,
    } as unknown as ConversationSession;
    const classify = vi.fn(async () => {
      live.followUpInstructions?.push({ timestamp: 2, text: 'Do not delete ./old', speaker: 'o', userId: SAFE_USER });
      return { verdict: 'allow' as const, reason: 'owner asked' };
    });
    const deps = makeDeps({
      mcpConfigBuilder: { buildConfig: vi.fn(async () => makeMcpConfig({ somaPermissionMode: 'auto' })) },
      safetyClassifier: { classify },
      sessionRegistry: {
        getSessionKey: vi.fn(() => 'chan:thread:intent-change'),
        isDangerousRuleDisabled: vi.fn(() => false),
        getSession: vi.fn(() => live),
      } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    });
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);
    const entry = (options.hooks?.PreToolUse ?? []).find((e) => (e as { matcher: string }).matcher === 'Bash');
    const hook = (entry as { hooks: Array<(i: unknown) => Promise<any>> }).hooks[0];
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf ./old' } });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('ask');
  });
});
