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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_FILE, DATA_DIR, SECRETS_DIR } from '../../env-paths';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { credentialPaths } from '../../sandbox/admin-sandbox-profile';
import { DEV_DOMAIN_ALLOWLIST } from '../../sandbox/dev-domain-allowlist';
import type { ConversationSession } from '../../types';
import { addThreadGrant, ENV_SKILL_GRANT_OWNER } from '../../user-skill-grants-store';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';
import { approvalRecordPaths, secretStoreDenyRules } from '../policy/devops-secret-guard';

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
    // its matchers: Bash, the native-bypass tool union, every MCP tool, Skill (step 6b),
    // and the native write tools outside that union (#389).
    const matchers = (preToolUse ?? []).map((e) => (e as { matcher: string }).matcher);
    expect(matchers).toHaveLength(5);
    expect(matchers).toContain('Artifact|EnterWorktree');
    expect(matchers).toContain('Bash');
    // A regular expression: the SDK compares a bare `mcp__` as an exact tool name (matches nothing).
    expect(matchers).toContain('^mcp__');
    expect(matchers).not.toContain('mcp__');
    expect(matchers).toContain('Skill');
    expect(matchers.some((m) => m.includes('Write') && m.includes('Read'))).toBe(true);
  });

  describe('environment plugin MCP gate (policy step 6d) in the hook', () => {
    const TOOL = 'mcp__plugin_acme-env_browser__probe';
    const envRegistry = () => ({ pluginNames: new Set(['acme-env']), pluginsDir: '/nonexistent-plugins' });

    async function mcpHook(deps: BuildStreamOptionsDeps, threadTs = '1700000000.0601') {
      const { options } = await buildStreamOptions(
        { queryEnv: {}, slackContext: makeSlackContext({ threadTs }) },
        deps,
      );
      const entry = (options.hooks?.PreToolUse ?? []).find((e) => (e as { matcher: string }).matcher === '^mcp__') as {
        hooks: Array<
          (input: unknown) => Promise<{
            continue?: boolean;
            hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
          }>
        >;
      };
      return (toolName: string) =>
        entry.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: {} } as never);
    }

    afterEach(() => {
      fs.rmSync(CONFIG_FILE, { force: true });
    });

    it('denies a non-admin an environment plugin MCP tool without a grant, and asks nobody', async () => {
      const onEnvSkillDenied = vi.fn(async () => undefined);
      const run = await mcpHook(makeDeps({ getEnvSkillRegistry: envRegistry, onEnvSkillDenied }));

      const out = await run(TOOL);

      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/environment plugin/);
      expect(onEnvSkillDenied).not.toHaveBeenCalled();
    });

    it('lets the tool run in the thread where an admin approved one of the plugin skills', async () => {
      const threadTs = '1700000000.0602';
      addThreadGrant(ENV_SKILL_GRANT_OWNER, 'acme-env:post-deploy', SAFE_USER, { channel: 'C123', threadTs });
      const run = await mcpHook(makeDeps({ getEnvSkillRegistry: envRegistry }), threadTs);
      expect(await run(TOOL)).toEqual({ continue: true });

      const elsewhere = await mcpHook(makeDeps({ getEnvSkillRegistry: envRegistry }), '1700000000.0603');
      expect((await elsewhere(TOOL)).hookSpecificOutput?.permissionDecision).toBe('deny');
    });

    it('passes the MCP tools of other plugins and servers untouched', async () => {
      const run = await mcpHook(makeDeps({ getEnvSkillRegistry: envRegistry }));
      expect(await run('mcp__plugin_stv_srv__t')).toEqual({ continue: true });
      expect(await run('mcp__plugin_acme-env-two_srv__t')).toEqual({ continue: true });
      expect(await run('mcp__github__get_issue')).toEqual({ continue: true });
    });

    it('without a registry, reads the environment plugins from config.json and still denies (fail closed)', async () => {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ plugin: { envPlugins: ['acme-env@acme-market'] } }), 'utf8');
      const run = await mcpHook(makeDeps());
      expect((await run(TOOL)).hookSpecificOutput?.permissionDecision).toBe('deny');
    });

    it('without a registry or environment plugins in config.json, gates nothing', async () => {
      const run = await mcpHook(makeDeps());
      expect(await run(TOOL)).toEqual({ continue: true });
    });

    // env-access WU2 (#1210): host commands are an admin's, whatever the server-tools grants say.
    it('denies a non-admin ssh_exec whatever the grants say, and leaves the other server-tools to them', async () => {
      const checkMcpToolPermission = vi.fn(() => null);
      const run = await mcpHook(makeDeps({ checkMcpToolPermission }));
      const out = await run('mcp__server-tools__ssh_exec');
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(checkMcpToolPermission).not.toHaveBeenCalled();
      expect(await run('mcp__server-tools__logs')).toEqual({ continue: true });
    });
  });

  describe('environment-skill gate (policy step 6b) in the hook', () => {
    const envRegistry = (dir: string) => ({ pluginNames: new Set(['acme-env']), pluginsDir: dir });

    async function skillHook(deps: BuildStreamOptionsDeps) {
      const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, deps);
      const entry = (options.hooks?.PreToolUse ?? []).find((e) => (e as { matcher: string }).matcher === 'Skill') as {
        hooks: Array<(input: unknown) => Promise<any>>;
      };
      return (skill: string) =>
        entry.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill } } as never);
    }

    it('denies an ungranted environment skill, tells the model why, and asks the admins for that thread', async () => {
      const onEnvSkillDenied = vi.fn(async () => undefined);
      const run = await skillHook(
        makeDeps({ getEnvSkillRegistry: () => envRegistry('/nonexistent-plugins'), onEnvSkillDenied }),
      );

      const out = await run('acme-env:post-deploy');

      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/environment skill/);
      expect(onEnvSkillDenied).toHaveBeenCalledWith({
        requesterId: SAFE_USER,
        skillKey: 'acme-env:post-deploy',
        channel: 'C123',
        threadTs: '1700000000.0001',
      });
    });

    it('passes every other skill through untouched, and asks nobody', async () => {
      const onEnvSkillDenied = vi.fn(async () => undefined);
      const run = await skillHook(
        makeDeps({ getEnvSkillRegistry: () => envRegistry('/nonexistent-plugins'), onEnvSkillDenied }),
      );

      expect(await run('zworkflow:deploy-qa')).toEqual({ continue: true });
      expect(onEnvSkillDenied).not.toHaveBeenCalled();
    });

    it('still denies when the admin ask fails (the request is enforcement, not the decision)', async () => {
      const onEnvSkillDenied = vi.fn(async () => {
        throw new Error('slack down');
      });
      const run = await skillHook(
        makeDeps({ getEnvSkillRegistry: () => envRegistry('/nonexistent-plugins'), onEnvSkillDenied }),
      );

      expect((await run('acme-env:staging-qa')).hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('a host without an environment-skill registry gates nothing', async () => {
      const run = await skillHook(makeDeps());
      expect(await run('acme-env:post-deploy')).toEqual({ continue: true });
    });

    it('a non-admin sandboxed Bash gets an OS-level read deny of the environment plugin directories', async () => {
      const { options } = await buildStreamOptions(
        { queryEnv: {}, slackContext: makeSlackContext() },
        makeDeps({ getEnvSkillRegistry: () => envRegistry('/srv/soma/plugins') }),
      );
      const denyRead = (options.sandbox as { filesystem?: { denyRead?: string[] } } | undefined)?.filesystem?.denyRead;
      expect(denyRead).toEqual([
        SECRETS_DIR,
        ...credentialPaths(os.homedir()),
        '/srv/soma/plugins/acme-env',
        '/srv/soma/plugins/.backups/acme-env',
      ]);
      // The write mount is kept.
      expect((options.sandbox as { filesystem?: { allowWrite?: string[] } }).filesystem?.allowWrite?.length).toBe(1);
    });

    it('only the secret store and the credential files are read-denied on a host without environment plugins', async () => {
      const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, makeDeps());
      expect((options.sandbox as { filesystem?: { denyRead?: string[] } } | undefined)?.filesystem?.denyRead).toEqual([
        SECRETS_DIR,
        ...credentialPaths(os.homedir()),
      ]);
    });
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

  it('sandbox: fails closed, and no model reads the secret store or writes an approval record', async () => {
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, makeDeps());
    const sandbox = options.sandbox as {
      failIfUnavailable?: boolean;
      filesystem?: { denyRead?: string[]; denyWrite?: string[] };
    };
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.filesystem?.denyRead).toContain(SECRETS_DIR);
    expect(sandbox.filesystem?.denyWrite).toEqual(expect.arrayContaining(approvalRecordPaths()));
    expect(sandbox.filesystem?.denyWrite).toContain(SECRETS_DIR);
  });

  it('settings: every session gets the secret-store and approval-record CLI deny rules', async () => {
    const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, makeDeps());
    const settings = options.settings as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toEqual(expect.arrayContaining(secretStoreDenyRules()));
  });

  it('sandbox: network omitted when user disabled network', async () => {
    const spy = vi.spyOn(await import('../../user-settings-store'), 'userSettingsStore', 'get').mockReturnValue({
      getUserDefaultModel: () => 'm',
      getUserPermissionMode: () => 'auto', // the execution context reads the mode (#597)
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
        getUserPermissionMode: () => 'auto', // the execution context reads the mode (#597)
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

// env-access WU2 (#1210): an admin's session is sandboxed too, with the admin profile; only a host
// that allows it lets an admin turn the sandbox off. Every session write-protects the deployment and
// the files that run outside the sandbox.
describe('sandbox: admin profile and write protection (env-access WU2, #1210)', () => {
  const ADMIN = 'U0ADMIN001';
  const savedAdmins = process.env.ADMIN_USERS;
  const savedOffAllowed = process.env.SOMA_SANDBOX_OFF_ALLOWED;

  async function withSettings<T>(sandboxDisabled: boolean, run: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(await import('../../user-settings-store'), 'userSettingsStore', 'get').mockReturnValue({
      getUserDefaultModel: () => 'm',
      getUserPermissionMode: () => 'bypass',
      getUserThinkingEnabled: () => true,
      getUserShowThinking: () => false,
      getUserSandboxDisabled: () => sandboxDisabled,
      getUserNetworkDisabled: () => false,
    } as never);
    try {
      return await run();
    } finally {
      spy.mockRestore();
    }
  }

  async function build(user: string, deps = makeDeps()) {
    return buildStreamOptions(
      { queryEnv: {}, slackContext: makeSlackContext({ user }), workingDirectory: WORK_DIR },
      deps,
    );
  }

  // An admin writes the temp directory, and the test DATA_DIR lies under it; the project config root (#1242) must
  // not, so these tests give the session a temp directory of its own.
  const savedTmpdir = process.env.TMPDIR;
  beforeEach(() => {
    process.env.TMPDIR = fs.mkdtempSync(path.join(WORK_DIR, 'admin-tmp-'));
  });

  afterEach(async () => {
    if (savedAdmins === undefined) delete process.env.ADMIN_USERS;
    else process.env.ADMIN_USERS = savedAdmins;
    if (savedOffAllowed === undefined) delete process.env.SOMA_SANDBOX_OFF_ALLOWED;
    else process.env.SOMA_SANDBOX_OFF_ALLOWED = savedOffAllowed;
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    (await import('../../admin-utils')).resetAdminUsersCache();
  });

  async function asAdmin() {
    process.env.ADMIN_USERS = ADMIN;
    (await import('../../admin-utils')).resetAdminUsersCache();
  }

  it('an admin who turned the sandbox off still runs sandboxed, and the host says why', async () => {
    await asAdmin();
    delete process.env.SOMA_SANDBOX_OFF_ALLOWED;
    const deps = makeDeps();
    const { options } = await withSettings(true, () => build(ADMIN, deps));
    const sandbox = options.sandbox as { enabled?: boolean; failIfUnavailable?: boolean } | undefined;
    expect(sandbox?.enabled).toBe(true);
    expect(sandbox?.failIfUnavailable).toBe(true);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('SOMA_SANDBOX_OFF_ALLOWED'),
      expect.objectContaining({ user: ADMIN }),
    );
  });

  it('a host that allows it lets an admin run without the sandbox', async () => {
    await asAdmin();
    process.env.SOMA_SANDBOX_OFF_ALLOWED = 'true';
    const { options } = await withSettings(true, () => build(ADMIN));
    expect(options.sandbox).toBeUndefined();
  });

  it('an admin gets the admin profile: every domain, gh TLS, local binding, the caches writable', async () => {
    await asAdmin();
    const { options } = await withSettings(false, () => build(ADMIN));
    const sandbox = options.sandbox as {
      enableWeakerNetworkIsolation?: boolean;
      network?: { allowedDomains?: string[]; allowLocalBinding?: boolean };
      filesystem?: { allowWrite?: string[]; denyRead?: string[]; denyWrite?: string[] };
    };
    expect(sandbox.enableWeakerNetworkIsolation).toBe(true);
    expect(sandbox.network?.allowLocalBinding).toBe(true);
    expect(sandbox.network?.allowedDomains).toEqual(expect.arrayContaining(['localhost', '127.0.0.1']));
    // The user's temp directory and the OS temp directory, no home cache (astra R1).
    expect(sandbox.filesystem?.allowWrite).toEqual(
      expect.arrayContaining([path.join('/tmp', ADMIN), fs.realpathSync(os.tmpdir())]),
    );
    expect(sandbox.filesystem?.allowWrite).not.toContain(path.join(os.homedir(), '.npm'));
    expect(sandbox.filesystem?.denyRead).toContain(SECRETS_DIR);
    expect(sandbox.filesystem?.denyWrite).toEqual(expect.arrayContaining(approvalRecordPaths()));
    const settings = options.settings as { permissions?: { allow?: string[] } };
    expect(settings.permissions?.allow).toContain('WebFetch(domain:*)');
  });

  it('an admin keeps plan files in the working directory, sandbox on or off (the deployment is write-protected)', async () => {
    await asAdmin();
    process.env.SOMA_SANDBOX_OFF_ALLOWED = 'true';
    for (const off of [false, true]) {
      const { options } = await withSettings(off, () => build(ADMIN));
      expect((options.settings as { plansDirectory?: string }).plansDirectory, `off=${off}`).toBe('.claude/plans');
    }
  });

  it('never write-protects / or a directory above the sandbox write roots, and says so (fable R2)', async () => {
    // A daemon started without a working directory runs in `/`.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/');
    try {
      const deps = makeDeps();
      const { options } = await withSettings(false, () => build(SAFE_USER, deps));
      const deny = (options.settings as { permissions?: { deny?: string[] } }).permissions?.deny ?? [];
      expect(deny).not.toContain('Edit(//)');
      expect(deny).not.toContain('Edit(///**)');
      expect(deny.some((rule) => rule === 'Edit(//tmp/**)' || rule === 'Edit(//private/**)')).toBe(false);
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('protected root'),
        expect.objectContaining({ root: '/' }),
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it('denies both spellings of the home directory and of a data directory not created yet (grok R1)', async () => {
    // On macOS the temp directory is under /var, which is /private/var: a home there has two spellings.
    const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), 'owner');
    fs.mkdirSync(home);
    const realHome = fs.realpathSync(home);
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const { options } = await withSettings(false, () => build(SAFE_USER));
      const denyRead = (options.sandbox as { filesystem?: { denyRead?: string[] } }).filesystem?.denyRead ?? [];
      const deny = (options.settings as { permissions?: { deny?: string[] } }).permissions?.deny ?? [];
      expect(denyRead).toEqual(expect.arrayContaining([path.join(home, '.ssh'), path.join(realHome, '.ssh')]));
      expect(deny).toEqual(
        expect.arrayContaining([`Read(/${path.join(realHome, '.ssh')}/**)`, `Edit(/${path.join(realHome, '.zshrc')})`]),
      );
      if (realHome !== home) expect(denyRead).toContain(path.join(home, '.ssh'));
    } finally {
      process.env.HOME = saved;
    }
  });

  it('sets no package cache in the CLI environment, which the MCP launchers inherit (astra R2)', async () => {
    // The CLI hands its environment to every stdio MCP server it starts (`npx -y …`, plugin servers). A
    // cache the model can write there would let it plant code those servers run outside the sandbox.
    await asAdmin();
    const CACHE_KEYS = [
      'npm_config_cache',
      'npm_config_store_dir',
      'XDG_CACHE_HOME',
      'YARN_CACHE_FOLDER',
      'BUN_INSTALL_CACHE_DIR',
      'PIP_CACHE_DIR',
      'UV_CACHE_DIR',
      'GOCACHE',
      'GOMODCACHE',
    ];
    for (const user of [SAFE_USER, ADMIN]) {
      const { options } = await withSettings(false, () => build(user));
      for (const key of CACHE_KEYS) expect(options.env?.[key], `${user} ${key}`).toBeUndefined();
    }
  });

  it('an admin native Write outside the sandbox roots is refused, as its Bash would be (astra R1)', async () => {
    await asAdmin();
    const { options } = await withSettings(false, () => build(ADMIN));
    const entry = (options.hooks?.PreToolUse ?? []).find((e) =>
      ((e as { matcher?: string }).matcher ?? '').split('|').includes('Write'),
    ) as { hooks: Array<(input: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>> };
    const write = (file_path: string) =>
      entry.hooks[0]({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path, content: 'x' },
      } as never);
    // A binary on the bot's PATH, which the bot later runs outside every sandbox.
    expect((await write(path.join(os.homedir(), '.local', 'bin', 'node'))).hookSpecificOutput?.permissionDecision).toBe(
      'deny',
    );
    expect((await write(path.join(WORK_DIR, 'notes.txt'))).hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect((await write(path.join('/tmp', ADMIN, 'x.txt'))).hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('a non-admin keeps the narrow profile', async () => {
    const { options } = await withSettings(false, () => build(SAFE_USER));
    const sandbox = options.sandbox as {
      enableWeakerNetworkIsolation?: boolean;
      network?: { allowLocalBinding?: boolean };
      filesystem?: { allowWrite?: string[] };
    };
    expect(sandbox.enableWeakerNetworkIsolation).toBeUndefined();
    expect(sandbox.network?.allowLocalBinding).toBeUndefined();
    expect(sandbox.filesystem?.allowWrite).toEqual([path.join('/tmp', SAFE_USER)]);
    const settings = options.settings as { permissions?: { allow?: string[] } };
    expect(settings.permissions?.allow ?? []).not.toContain('WebFetch(domain:*)');
  });

  it('every session, admin or not, sandbox on or off, write-denies the deployment and the startup files', async () => {
    await asAdmin();
    process.env.SOMA_SANDBOX_OFF_ALLOWED = 'true';
    const deployRoot = path.dirname(CONFIG_FILE);
    for (const [user, off] of [
      [SAFE_USER, false],
      [ADMIN, false],
      [ADMIN, true],
    ] as const) {
      const { options } = await withSettings(off, () => build(user));
      const deny = (options.settings as { permissions?: { deny?: string[] } }).permissions?.deny ?? [];
      expect(deny, `${user} off=${off}`).toEqual(
        expect.arrayContaining([
          `Edit(/${deployRoot}/**)`,
          // The running code's root and the bot's own directory, not only the config directory (astra R1).
          `Edit(/${process.cwd()}/**)`,
          `Edit(/${path.join(os.homedir(), 'Library', 'LaunchAgents')}/**)`,
          `Edit(/${path.join(os.homedir(), '.zshrc')})`,
        ]),
      );
      expect(deny).toEqual(expect.arrayContaining(secretStoreDenyRules()));
      expect(deny, `${user} off=${off}`).toEqual(
        expect.arrayContaining([`Read(/${path.join(os.homedir(), '.ssh')}/**)`]),
      );
    }
  });

  it('every sandboxed session, admin or not, read-denies the ssh keys and the logins (#1210)', async () => {
    await asAdmin();
    for (const user of [SAFE_USER, ADMIN]) {
      const { options } = await withSettings(false, () => build(user));
      const denyRead = (options.sandbox as { filesystem?: { denyRead?: string[] } }).filesystem?.denyRead ?? [];
      expect(denyRead, user).toEqual(
        expect.arrayContaining([path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.config', 'gh')]),
      );
    }
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
      getUserPermissionMode: () => 'auto', // the execution context reads the mode (#597)
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

  it('(e) sandbox-disabled admin on a host that allows it: no sandbox at all, so no grant', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const savedAdmins = process.env.ADMIN_USERS;
    process.env.ADMIN_USERS = APPROVED;
    process.env.SOMA_SANDBOX_OFF_ALLOWED = 'true';
    const { resetAdminUsersCache } = await import('../../admin-utils');
    resetAdminUsersCache();
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
      if (savedAdmins === undefined) delete process.env.ADMIN_USERS;
      else process.env.ADMIN_USERS = savedAdmins;
      delete process.env.SOMA_SANDBOX_OFF_ALLOWED;
      resetAdminUsersCache();
    }
  });

  it('(e2) a non-admin with a stored sandbox-off setting stays sandboxed (WU2, #1210)', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const spy = await mockUserSettings({ sandboxDisabled: true });
    try {
      const { options } = await buildStreamOptions(
        { queryEnv: {}, session: session('deploy'), slackContext: makeSlackContext({ user: APPROVED }) },
        makeDeps(),
      );
      expect((options.sandbox as { enabled?: boolean } | undefined)?.enabled).toBe(true);
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

// env-access #1242: the CLI reads project settings and the project MCP config from an empty host directory under
// DATA_DIR, never from the working directory a model session writes. CLAUDE.md and plan files stay in the cwd.
describe('project config root (env-access #1242)', () => {
  const ROOT = path.join(DATA_DIR, 'session-project-config');

  afterEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  async function build() {
    return buildStreamOptions(
      { queryEnv: {}, slackContext: makeSlackContext({ user: SAFE_USER }), workingDirectory: WORK_DIR },
      makeDeps(),
    );
  }

  it('points the CLI at an empty directory under DATA_DIR, not the working directory', async () => {
    const { options } = await build();
    expect(options.projectConfigRoot).toBe(ROOT);
    expect(options.cwd).toBe(WORK_DIR);
    expect(fs.readdirSync(ROOT)).toEqual([]);
    expect(options.settingSources).toEqual(['project']);
  });

  it('fails closed: a session does not start when the root lies inside a directory it writes', async () => {
    await expect(
      buildStreamOptions(
        {
          queryEnv: {},
          slackContext: makeSlackContext({ user: SAFE_USER }),
          workingDirectory: path.dirname(DATA_DIR),
        },
        makeDeps(),
      ),
    ).rejects.toThrow(/lies inside/);
  });

  it('fails closed: a session does not start when the root holds anything', async () => {
    fs.mkdirSync(path.join(ROOT, '.claude'), { recursive: true });
    await expect(build()).rejects.toThrow(/session was not started/);
  });
});
