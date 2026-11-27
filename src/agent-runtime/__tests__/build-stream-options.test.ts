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
import { LAUNCH_SCRIPT } from '../../sandbox/mcp-launch-dir';
import type { ConversationSession } from '../../types';
import { addThreadGrant, ENV_SKILL_GRANT_OWNER, grantEnvironment } from '../../user-skill-grants-store';
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

// Non-admin CLI temp directories go under a scratch parent, not the host's.
const CLAUDE_TMP_SCRATCH = path.join(WORK_DIR, 'soma-ct');

/** The write roots without the non-admin CLI temp directory, which every non-admin turn now gets. */
function withoutClaudeTmp(list: string[] | undefined): string[] {
  return (list ?? []).filter((p) => !p.startsWith(`${CLAUDE_TMP_SCRATCH}/`));
}

function makeDeps(overrides: Partial<BuildStreamOptionsDeps> = {}): BuildStreamOptionsDeps {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    claudeTmpRoot: CLAUDE_TMP_SCRATCH,
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
    // Started from /, not the working directory (#1241).
    expect(options.mcpServers).toEqual({
      mcp__demo: {
        type: 'stdio',
        command: '/bin/sh',
        args: ['-c', LAUNCH_SCRIPT, 'mcp-launch', '/', 'demo'],
      },
    });
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
      return (toolName: string, toolInput: Record<string, unknown> = {}) =>
        entry.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput } as never);
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

    // env-access WU4 (#1212): the tools of an environment's server follow that environment's grant.
    it("lets a non-admin use an environment's server-tools tools on its grant, admin-only ones included", async () => {
      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ 'server-tools': { dev2: { envUser: 'env:acme-dev2', skills: ['acme-env:post-deploy'] } } }),
        'utf8',
      );
      const checkMcpToolPermission = vi.fn(() => null);
      const run = await mcpHook(makeDeps({ checkMcpToolPermission }));
      const ask = (tool: string, server: string) =>
        run(tool, { server }).then((o: any) => o.hookSpecificOutput?.permissionDecision ?? 'continue');
      expect(await ask('mcp__server-tools__ssh_exec', 'dev2')).toBe('deny');
      grantEnvironment('env:acme-dev2', SAFE_USER);
      expect(await ask('mcp__server-tools__ssh_exec', 'dev2')).toBe('continue');
      expect(await ask('mcp__server-tools__gh_pr', 'dev2')).toBe('continue');
      expect(await ask('mcp__server-tools__login', 'dev2')).toBe('continue');
      expect(await ask('mcp__server-tools__gh_read', 'dev2')).toBe('continue');
      expect(await ask('mcp__server-tools__cf_api', 'dev2')).toBe('continue');
      // A server that is no environment's stays admin-only.
      expect(await ask('mcp__server-tools__login', 'other')).toBe('deny');
      expect(await ask('mcp__server-tools__gh_read', 'other')).toBe('deny');
      expect(await ask('mcp__server-tools__cf_api', 'other')).toBe('deny');
      expect(await ask('mcp__server-tools__ssh_exec', 'other')).toBe('deny');
      expect(checkMcpToolPermission).not.toHaveBeenCalled();
    });

    // trinity R1 (fable): without an environment grant, the ordinary tools of an environment's server keep
    // following the server-tools grants they followed before.
    it("keeps the existing grants for an environment server's ordinary tools", async () => {
      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify({
          // An environment nobody holds a grant for (the test above granted acme-dev2).
          'server-tools': { permission: { logs: 'read', db_query: 'write' }, dev2: { envUser: 'env:acme-dev9' } },
        }),
        'utf8',
      );
      const checkMcpToolPermission = vi.fn((name: string) => (name.endsWith('__db_query') ? 'no write grant' : null));
      const run = await mcpHook(makeDeps({ checkMcpToolPermission }), '1700000000.0777');
      const decide = (tool: string) =>
        run(tool, { server: 'dev2' }).then((o: any) => o.hookSpecificOutput?.permissionDecision ?? 'continue');
      expect(await decide('mcp__server-tools__logs')).toBe('continue');
      expect(await decide('mcp__server-tools__db_query')).toBe('deny');
      expect(await decide('mcp__server-tools__ssh_exec')).toBe('deny');
    });

    // env-access WU3 (#1211): an environment user's PR approvals and merges are an admin's until per-environment
    // grants exist (WU4, #1212).
    it('denies a non-admin gh_pr whatever the grants say', async () => {
      const checkMcpToolPermission = vi.fn(() => null);
      const run = await mcpHook(makeDeps({ checkMcpToolPermission }));
      const out = await run('mcp__server-tools__gh_pr');
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(checkMcpToolPermission).not.toHaveBeenCalled();
    });

    // env-access WU3b (#1211): an environment account's web session is an admin's, or a user's the environment's
    // admin approved (see the environment grant test above).
    // env-access WU5 (#1213): an environment's repository reads use its token (maybe an org admin's).
    it('denies a non-admin gh_read whatever the grants say, an ordinary grant included', async () => {
      const checkMcpToolPermission = vi.fn(() => null);
      const run = await mcpHook(makeDeps({ checkMcpToolPermission }));
      expect((await run('mcp__server-tools__gh_read')).hookSpecificOutput?.permissionDecision).toBe('deny');
      // env-access WU6 (#1214): the same for an environment's Cloudflare calls.
      expect((await run('mcp__server-tools__cf_api')).hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(checkMcpToolPermission).not.toHaveBeenCalled();
    });

    // .prd/30 D7: a phone call reaches a real person and costs money — an admin's, whatever the grants say.
    it('denies a non-admin phone_call whatever the grants say; reading calls stays with the grants', async () => {
      const checkMcpToolPermission = vi.fn(() => null);
      const run = await mcpHook(makeDeps({ checkMcpToolPermission }));
      const out = await run('mcp__server-tools__phone_call', {
        server: '2lab-ai-dev',
        to: '010-1234-5678',
        purpose: 'p',
      });
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(checkMcpToolPermission).not.toHaveBeenCalled();
      expect(await run('mcp__server-tools__phone_calls', { server: '2lab-ai-dev' })).toEqual({ continue: true });
    });

    it('denies a non-admin login whatever the grants say', async () => {
      const checkMcpToolPermission = vi.fn(() => null);
      const run = await mcpHook(makeDeps({ checkMcpToolPermission }));
      const out = await run('mcp__server-tools__login');
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(checkMcpToolPermission).not.toHaveBeenCalled();
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
      // The denies set on purpose come first; the read boundary's data roots follow them.
      const onPurpose = [
        SECRETS_DIR,
        ...credentialPaths(os.homedir()),
        '/srv/soma/plugins/acme-env',
        '/srv/soma/plugins/.backups/acme-env',
      ];
      expect(denyRead?.slice(0, onPurpose.length)).toEqual(onPurpose);
      // The write mount is kept (beside it at most the CLI temp directory, once the user's root exists).
      const allowWrite = (options.sandbox as { filesystem?: { allowWrite?: string[] } }).filesystem?.allowWrite ?? [];
      expect(allowWrite[0]).toContain(SAFE_USER);
      expect(allowWrite.slice(1).every((p) => p.startsWith(`${CLAUDE_TMP_SCRATCH}/`))).toBe(true);
    });

    it('on a host without environment plugins, the denies set on purpose are the secret store and the credential files', async () => {
      const { options } = await buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext() }, makeDeps());
      const denyRead = (options.sandbox as { filesystem?: { denyRead?: string[] } } | undefined)?.filesystem?.denyRead;
      const onPurpose = [SECRETS_DIR, ...credentialPaths(os.homedir())];
      expect(denyRead?.slice(0, onPurpose.length)).toEqual(onPurpose);
      expect(denyRead).not.toContain('/srv/soma/plugins/acme-env');
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

  it('sandbox: every domain when the user turned the allowlist off, as the setting promises', async () => {
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
      // Every domain for sandboxed commands; without network settings the CLI would ask per domain instead
      // (measured). Native WebFetch keeps its own approvals.
      expect(sandbox.network).toEqual({ allowedDomains: ['*'] });
      expect((options.settings as { permissions?: { allow?: string[] } }).permissions?.allow ?? []).not.toContain(
        'WebFetch(domain:*)',
      );
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
      'gpt-6-astra',
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
        ['gpt-6-astra', '249000'],
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

  it.skipIf(process.platform === 'win32')(
    'processOwner: the spawned Claude Code child is tracked under the session (the process monitor groups it)',
    async () => {
      const { getClaudeChildProcessRegistry } = await import('../claude-child-process-registry');
      const deps = makeDeps();
      const { options } = await buildStreamOptions(
        { queryEnv: {}, abortController: new AbortController(), processOwner: { sessionKey: 'C1-111.222' } },
        deps,
      );
      const child = options.spawnClaudeCodeProcess?.({
        command: '/bin/sleep',
        args: ['5'],
        cwd: '/',
        env: { PATH: '/bin:/usr/bin' },
        signal: new AbortController().signal,
      } as never) as unknown as import('node:child_process').ChildProcess;
      try {
        expect(getClaudeChildProcessRegistry().roots()).toContainEqual({
          pid: child.pid,
          sessionKey: 'C1-111.222',
          turnId: expect.any(Number),
        });
      } finally {
        child.kill('SIGKILL');
        getClaudeChildProcessRegistry().resetForTests();
      }
    },
  );
});

// env-access WU2 (#1210): an admin's session is sandboxed too, with the admin profile; only a host
// that allows it lets an admin turn the sandbox off. Every session write-protects the deployment and
// the files that run outside the sandbox.
describe('sandbox: admin profile and write protection (env-access WU2, #1210)', () => {
  const ADMIN = 'U0ADMIN001';
  const savedAdmins = process.env.ADMIN_USERS;
  const savedOffAllowed = process.env.SOMA_SANDBOX_OFF_ALLOWED;

  async function withSettings<T>(sandboxDisabled: boolean, run: () => Promise<T>, networkDisabled = false): Promise<T> {
    const spy = vi.spyOn(await import('../../user-settings-store'), 'userSettingsStore', 'get').mockReturnValue({
      getUserDefaultModel: () => 'm',
      getUserPermissionMode: () => 'bypass',
      getUserThinkingEnabled: () => true,
      getUserShowThinking: () => false,
      getUserSandboxDisabled: () => sandboxDisabled,
      getUserNetworkDisabled: () => networkDisabled,
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

  describe("reads: a non-admin session reads its own work area, not the host's data", () => {
    type ReadSettings = {
      permissions?: { blockReadsOutsideWorkingDirectories?: boolean; blockReadsExemptPaths?: string[] };
    };
    type ReadSandbox = { filesystem?: { denyRead?: string[]; allowRead?: string[] } };

    it('the file tools refuse reads outside the working directories, in every mode', async () => {
      const { options } = await withSettings(false, () => build(SAFE_USER));
      const permissions = (options.settings as ReadSettings).permissions;
      expect(permissions?.blockReadsOutsideWorkingDirectories).toBe(true);
      // The working directories are the session folder and the user's root.
      expect(options.cwd).toBe(WORK_DIR);
      expect(options.additionalDirectories).toContain(path.join('/tmp', SAFE_USER));
      // The service data is not let through; the user's own part of it is when it exists.
      expect(permissions?.blockReadsExemptPaths).not.toContain(DATA_DIR);
    });

    it("the shell cannot read the deployment, its data, the CLI config or the service user's home", async () => {
      const { options } = await withSettings(false, () => build(SAFE_USER));
      const filesystem = (options.sandbox as ReadSandbox).filesystem;
      const real = (p: string) => fs.realpathSync(p);
      expect(filesystem?.denyRead).toEqual(
        expect.arrayContaining([real(path.dirname(CONFIG_FILE)), real(DATA_DIR), real(os.homedir())]),
      );
      // The session folder is re-opened, as the OS resolves it.
      expect(filesystem?.allowRead).toContain(real(WORK_DIR));
      expect(filesystem?.allowRead).not.toContain(real(DATA_DIR));
      expect(filesystem?.allowRead).not.toContain(real(os.homedir()));
      // Nothing re-opens the secret store.
      for (const entry of filesystem?.allowRead ?? []) {
        expect(SECRETS_DIR === entry || SECRETS_DIR.startsWith(`${entry}${path.sep}`), entry).toBe(false);
      }
    });

    it("the user's own data directory (memory, own skills, uploads) is made first and readable", async () => {
      const own = path.join(DATA_DIR, SAFE_USER);
      fs.rmSync(own, { recursive: true, force: true });
      try {
        const { options } = await withSettings(false, () => build(SAFE_USER));
        // Made before the lists are built, so a thread file downloaded mid-turn is readable.
        expect(fs.statSync(path.join(own, 'uploads')).mode & 0o777).toBe(0o700);
        expect((options.settings as ReadSettings).permissions?.blockReadsExemptPaths).toContain(own);
        expect((options.sandbox as ReadSandbox).filesystem?.allowRead).toContain(fs.realpathSync(own));
      } finally {
        fs.rmSync(own, { recursive: true, force: true });
      }
    });

    it('a session folder reached through a link does not start', async () => {
      const elsewhere = fs.mkdtempSync(path.join(WORK_DIR, 'elsewhere-'));
      const link = path.join(WORK_DIR, `linked-session-${process.pid}`);
      fs.symlinkSync(elsewhere, link);
      try {
        await expect(
          withSettings(false, () =>
            buildStreamOptions(
              { queryEnv: {}, slackContext: makeSlackContext({ user: SAFE_USER }), workingDirectory: link },
              makeDeps(),
            ),
          ),
        ).rejects.toThrow(/reached through a link/);
      } finally {
        fs.unlinkSync(link);
      }
    });

    it("the CLI's temp directory is the user's own, under a parent only the bot writes", async () => {
      // A user whose root exists: the host makes /tmp/{userId} with the first session folder.
      const user = `U0RDTMP${process.pid}`;
      const root = path.join('/tmp', user);
      const tmp = path.join(CLAUDE_TMP_SCRATCH, user);
      fs.mkdirSync(root, { recursive: true });
      try {
        const { options } = await withSettings(false, () => build(user));
        expect(options.env?.CLAUDE_CODE_TMPDIR).toBe(tmp);
        expect(fs.statSync(tmp).mode & 0o777).toBe(0o700);
        const filesystem = (options.sandbox as ReadSandbox & { filesystem?: { allowWrite?: string[] } }).filesystem;
        // The session writes inside it, reads it, but cannot write its parent (so cannot swap it).
        expect(filesystem?.allowWrite).toContain(tmp);
        expect(filesystem?.allowWrite).not.toContain(CLAUDE_TMP_SCRATCH);
        expect(filesystem?.allowRead).toContain(fs.realpathSync(tmp));
        expect(filesystem?.allowRead).toContain(fs.realpathSync(root));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('a session folder that could not be made does not start (the CLI would run in the daemon directory)', async () => {
      const blocker = path.join(WORK_DIR, `not-a-dir-${process.pid}`);
      fs.writeFileSync(blocker, 'x');
      try {
        await expect(
          withSettings(false, () =>
            buildStreamOptions(
              {
                queryEnv: {},
                slackContext: makeSlackContext({ user: SAFE_USER }),
                workingDirectory: path.join(blocker, 'session'),
              },
              makeDeps(),
            ),
          ),
        ).rejects.toThrow(/could not be made/);
      } finally {
        fs.rmSync(blocker, { force: true });
      }
    });

    it('in a shared thread the speaker may attach files from the session folder it works in', async () => {
      const deps = makeDeps({
        mcpConfigBuilder: {
          buildConfig: vi.fn(async () =>
            makeMcpConfig({
              mcpServers: {
                'slack-mcp': {
                  type: 'stdio',
                  command: 'slack-mcp',
                  env: { SOMA_UPLOAD_ROOTS: JSON.stringify([path.join('/tmp', SAFE_USER)]) },
                },
              },
            }),
          ),
        },
      });
      const { options } = await withSettings(false, () => build(SAFE_USER, deps));
      const env = (options.mcpServers?.['slack-mcp'] as { env?: Record<string, string> }).env;
      const roots = JSON.parse(env?.SOMA_UPLOAD_ROOTS ?? '[]') as string[];
      // The roots built for the speaker, then the session folder (and the CLI temp directory once the user's root
      // exists on this host).
      expect(roots.slice(0, 2)).toEqual([path.join('/tmp', SAFE_USER), WORK_DIR]);
      expect(roots.slice(2).every((p) => p.startsWith(`${CLAUDE_TMP_SCRATCH}/`))).toBe(true);
    });

    it("a speaker new to someone else's thread (no root of its own yet) still gets its temp directory", async () => {
      const user = 'U0RDNOROOT1';
      const { options } = await withSettings(false, () => build(user));
      expect(options.env?.CLAUDE_CODE_TMPDIR).toBe(path.join(CLAUDE_TMP_SCRATCH, user));
      expect(fs.statSync(path.join(CLAUDE_TMP_SCRATCH, user)).mode & 0o777).toBe(0o700);
    });

    it("a turn without a session folder reads an empty directory, never the daemon's", async () => {
      const { options } = await withSettings(false, () =>
        buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext({ user: SAFE_USER }) }, makeDeps()),
      );
      expect(options.cwd).toBeDefined();
      expect(options.cwd).not.toBe(process.cwd());
      expect(fs.readdirSync(options.cwd as string)).toEqual([]);
    });

    // The sandbox audit of 27 November 2026: a sandboxed admin read the deployment's .env, the subscription store,
    // 15 other users' data and the shared CLI temp directory. A sandbox reads the work area, whoever runs in it.
    it('a sandboxed admin reads its own work area too: the read block, the read lists, its own temp directory', async () => {
      await asAdmin();
      const { options } = await withSettings(false, () => build(ADMIN));
      expect((options.settings as ReadSettings).permissions?.blockReadsOutsideWorkingDirectories).toBe(true);
      const filesystem = (options.sandbox as ReadSandbox).filesystem;
      const real = (p: string) => fs.realpathSync(p);
      expect(filesystem?.denyRead).toEqual(expect.arrayContaining([real(DATA_DIR), real(path.dirname(CONFIG_FILE))]));
      expect(filesystem?.allowRead).toContain(real(WORK_DIR));
      expect(filesystem?.allowRead).not.toContain(real(DATA_DIR));
      expect(options.env?.CLAUDE_CODE_TMPDIR).toBe(path.join(CLAUDE_TMP_SCRATCH, ADMIN));
    });

    it('an admin running without the sandbox has no read boundary', async () => {
      await asAdmin();
      process.env.SOMA_SANDBOX_OFF_ALLOWED = 'true';
      const { options } = await withSettings(true, () => build(ADMIN));
      expect(options.sandbox).toBeUndefined();
      expect((options.settings as ReadSettings).permissions?.blockReadsOutsideWorkingDirectories).toBeUndefined();
      expect(options.env?.CLAUDE_CODE_TMPDIR).toBeUndefined();
    });
  });

  it('a host that allows it lets an admin run without the sandbox', async () => {
    await asAdmin();
    process.env.SOMA_SANDBOX_OFF_ALLOWED = 'true';
    const { options } = await withSettings(true, () => build(ADMIN));
    expect(options.sandbox).toBeUndefined();
  });

  it('an admin gets the admin profile: every domain, gh TLS, local binding, its own temp directory writable', async () => {
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
    // The user's root and its own CLI temp directory — not the bot's temp directory, which every admin shared and
    // where the bot keeps its own files; no home cache (astra R1).
    expect(sandbox.filesystem?.allowWrite).toEqual([path.join('/tmp', ADMIN), path.join(CLAUDE_TMP_SCRATCH, ADMIN)]);
    expect(sandbox.filesystem?.allowWrite).not.toContain(fs.realpathSync(os.tmpdir()));
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

  // Measured with the CLI: in bypass mode a domain off the allowlist is asked for and allowed, so the allowlist held
  // nothing; and the allowlist turned off (no network settings) asked per domain, while every screen promised all.
  describe('network', () => {
    type NetSandbox = { network?: { allowedDomains?: string[]; strictAllowlist?: boolean } };
    const allowRules = (options: { settings?: unknown }) =>
      (options.settings as { permissions?: { allow?: string[] } }).permissions?.allow ?? [];

    it("a non-admin's dev allowlist is strict: a domain off it is refused, not asked for", async () => {
      const { options } = await withSettings(false, () => build(SAFE_USER));
      const network = (options.sandbox as NetSandbox).network;
      expect(network?.strictAllowlist).toBe(true);
      expect(network?.allowedDomains).toEqual([...DEV_DOMAIN_ALLOWLIST]);
      // The every-domain rule would put every domain back on the list — also after the allowlist was off and is on
      // again.
      expect(allowRules(options)).not.toContain('WebFetch(domain:*)');
      await withSettings(false, () => build(SAFE_USER), true);
      const { options: again } = await withSettings(false, () => build(SAFE_USER), false);
      expect((again.sandbox as NetSandbox).network?.strictAllowlist).toBe(true);
      expect(allowRules(again)).not.toContain('WebFetch(domain:*)');
    });

    it("the allowlist turned off opens every domain to sandboxed commands, and leaves WebFetch's approvals alone", async () => {
      const { options } = await withSettings(false, () => build(SAFE_USER), true);
      expect((options.sandbox as NetSandbox).network).toEqual({ allowedDomains: ['*'] });
      expect(allowRules(options)).not.toContain('WebFetch(domain:*)');
    });

    it('an admin keeps every domain, the toggle either way', async () => {
      await asAdmin();
      for (const networkDisabled of [false, true]) {
        const { options } = await withSettings(false, () => build(ADMIN), networkDisabled);
        expect((options.sandbox as NetSandbox).network?.strictAllowlist, `${networkDisabled}`).toBeUndefined();
        expect(allowRules(options), `${networkDisabled}`).toContain('WebFetch(domain:*)');
      }
    });
  });

  it("a sandboxed admin's native writes reach its own CLI temp directory, where its commands write", async () => {
    await asAdmin();
    // A temp root outside the working directory, as in production (`/tmp/.soma-ct`): the shared scratch root of
    // these tests lies inside it.
    const root = path.join(fs.mkdtempSync(path.join('/tmp', 'soma-ct-native-')), 'soma-ct');
    try {
      const { options } = await withSettings(false, () => build(ADMIN, makeDeps({ claudeTmpRoot: root })));
      const entry = (options.hooks?.PreToolUse ?? []).find((e) =>
        ((e as { matcher?: string }).matcher ?? '').split('|').includes('Write'),
      ) as { hooks: Array<(input: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>> };
      const tmp = options.env?.CLAUDE_CODE_TMPDIR as string;
      expect(tmp).toBe(path.join(root, ADMIN));
      const write = (file_path: string) =>
        entry.hooks[0]({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path, content: 'x' },
        } as never);
      expect((await write(path.join(tmp, 'notes.txt'))).hookSpecificOutput?.permissionDecision).not.toBe('deny');
      // Its own directory, not the parent: another user's CLI temp files stay out of reach.
      const other = path.join(root, 'U0OTHER001');
      fs.mkdirSync(other, { recursive: true });
      expect((await write(path.join(other, 'notes.txt'))).hookSpecificOutput?.permissionDecision).toBe('deny');
    } finally {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });

  it("a sandboxed session's shell reads the certificate bundle its environment names", async () => {
    const bundle = path.join(fs.mkdtempSync(path.join(DATA_DIR, 'tls-')), 'ca.pem');
    fs.writeFileSync(bundle, 'x');
    const { options } = await withSettings(false, () =>
      buildStreamOptions(
        {
          queryEnv: { CURL_CA_BUNDLE: bundle },
          slackContext: makeSlackContext({ user: SAFE_USER }),
          workingDirectory: WORK_DIR,
        },
        makeDeps(),
      ),
    );
    const allowRead = (options.sandbox as { filesystem?: { allowRead?: string[] } }).filesystem?.allowRead ?? [];
    expect(allowRead).toContain(fs.realpathSync(bundle));
    expect(allowRead).not.toContain(fs.realpathSync(path.dirname(bundle)));
  });

  it("a sandboxed admin's turn without a session folder writes natively in the empty cwd made for it, not beside it", async () => {
    await asAdmin();
    const { options } = await withSettings(false, () =>
      buildStreamOptions({ queryEnv: {}, slackContext: makeSlackContext({ user: ADMIN }) }, makeDeps()),
    );
    const cwd = options.cwd as string;
    expect(fs.readdirSync(cwd)).toEqual([]);
    const entry = (options.hooks?.PreToolUse ?? []).find((e) =>
      ((e as { matcher?: string }).matcher ?? '').split('|').includes('Write'),
    ) as { hooks: Array<(input: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>> };
    const write = (file_path: string) =>
      entry.hooks[0]({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path, content: 'x' },
      } as never);
    expect((await write(path.join(cwd, '.claude', 'plans', 'p.md'))).hookSpecificOutput?.permissionDecision).not.toBe(
      'deny',
    );
    expect((await write(path.join(path.dirname(cwd), 'beside.txt'))).hookSpecificOutput?.permissionDecision).toBe(
      'deny',
    );
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
    // The user's root, and at most the CLI temp directory once that root exists.
    expect(sandbox.filesystem?.allowWrite?.[0]).toBe(path.join('/tmp', SAFE_USER));
    expect((sandbox.filesystem?.allowWrite ?? []).slice(1).every((p) => p.startsWith(`${CLAUDE_TMP_SCRATCH}/`))).toBe(
      true,
    );
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
    expect(withoutClaudeTmp(sandbox?.filesystem?.allowWrite)).toEqual([
      path.join('/tmp', APPROVED),
      '/srv/qa/lock',
      '/srv/qa/runs',
    ]);
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
    expect(withoutClaudeTmp(sandbox?.filesystem?.allowWrite)).toEqual([path.join('/tmp', OTHER)]);
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

    expect(withoutClaudeTmp(sandboxOf(options)?.filesystem?.allowWrite)).toEqual([path.join('/tmp', APPROVED)]);
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

    expect(withoutClaudeTmp(sandboxOf(options)?.filesystem?.allowWrite)).toEqual([
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

    expect(withoutClaudeTmp(sandboxOf(options)?.filesystem?.allowWrite)).toEqual([path.join('/tmp', APPROVED)]);
  });

  it.each(['default', 'pr-review', undefined])('(c) workflow %j + listed sender: no grant', async (workflow) => {
    writeHostConfig({ deploySandbox: GRANT });
    const deps = makeDeps();
    const { options } = await buildStreamOptions(
      { queryEnv: {}, session: session(workflow), slackContext: makeSlackContext({ user: APPROVED }) },
      deps,
    );

    const sandbox = sandboxOf(options);
    expect(withoutClaudeTmp(sandbox?.filesystem?.allowWrite)).toEqual([path.join('/tmp', APPROVED)]);
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

    expect(withoutClaudeTmp(sandboxOf(options)?.filesystem?.allowWrite)).toEqual([path.join('/tmp', APPROVED)]);
  });

  it('(d) listed sender with networkDisabled: paths appended, every domain already open', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const spy = await mockUserSettings({ networkDisabled: true });
    try {
      const deps = makeDeps();
      const { options } = await buildStreamOptions(
        { queryEnv: {}, session: session('deploy'), slackContext: makeSlackContext({ user: APPROVED }) },
        deps,
      );

      const sandbox = sandboxOf(options);
      expect(withoutClaudeTmp(sandbox?.filesystem?.allowWrite)).toEqual([
        path.join('/tmp', APPROVED),
        '/srv/qa/lock',
        '/srv/qa/runs',
      ]);
      expect(sandbox?.network).toEqual({ allowedDomains: ['*'] });
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

    expect(withoutClaudeTmp(sandboxOf(options)?.filesystem?.allowWrite)).toEqual([path.join('/tmp', APPROVED)]);
    expect(grantLogs(deps)).toEqual([]);
  });

  it('a revoked grant (key removed by the next deploy) stops applying', async () => {
    writeHostConfig({ deploySandbox: GRANT });
    const input = { queryEnv: {}, session: session('deploy'), slackContext: makeSlackContext({ user: APPROVED }) };
    expect(sandboxOf((await buildStreamOptions(input, makeDeps())).options)?.filesystem?.allowWrite).toContain(
      '/srv/qa/lock',
    );

    writeHostConfig({ plugin: {} });
    expect(
      withoutClaudeTmp(sandboxOf((await buildStreamOptions(input, makeDeps())).options)?.filesystem?.allowWrite),
    ).toEqual([path.join('/tmp', APPROVED)]);
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

  it('fails closed: a session does not start when the root holds project config', async () => {
    fs.mkdirSync(path.join(ROOT, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, '.claude', 'settings.json'), '{}');
    await expect(build()).rejects.toThrow(/session was not started/);
  });

  // dev 2026-11-13: the first sandboxed session's CLI made `.claude/.cc-writes` in the root, and every later session
  // was refused.
  it('starts the next session after the CLI made its staging directory in the root', async () => {
    await build();
    fs.mkdirSync(path.join(ROOT, '.claude', '.cc-writes'), { recursive: true, mode: 0o700 });
    const { options } = await build();
    expect(options.projectConfigRoot).toBe(ROOT);
  });
});
