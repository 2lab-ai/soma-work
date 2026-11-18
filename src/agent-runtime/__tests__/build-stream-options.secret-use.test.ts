/**
 * secret-access WU2 (#1338, .prd/33 §3.2): the policy hook's server-tools gate gains one way in — every secret the
 * call uses is granted to the requester. It only adds: a call the environment grant or the tool grant already opens
 * stays open with no card. A call it still denies that uses an ungranted secret asks the admins (the 3-answer card)
 * and tells the model which secret waits — never its value. A call that uses no secret is denied as before.
 */

import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_FILE, DATA_DIR } from '../../env-paths';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { addSecretThreadGrant, grantEnvironment, grantSecret } from '../../user-skill-grants-store';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';

const USER = 'U0SECRETUSE1';
const THREAD = '1700000000.0701';

function mcpConfig(): McpConfig {
  return {
    permissionMode: 'bypassPermissions',
    userBypass: true,
    somaPermissionMode: 'bypass',
    allowDangerouslySkipPermissions: true,
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
  } as unknown as McpConfig;
}

function deps(overrides: Partial<BuildStreamOptionsDeps> = {}): BuildStreamOptionsDeps {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getEffectivePluginPaths: () => [],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: { buildConfig: vi.fn(async () => mcpConfig()) },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'P') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => 'chan:thread'),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
    } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    // No server-tools grant for this user: the tool grant does not open the call.
    checkMcpToolPermission: vi.fn(() => 'No active read grant for server-tools — use request_permission'),
    ...overrides,
  };
}

async function hook(d: BuildStreamOptionsDeps, threadTs = THREAD) {
  const slackContext = { user: USER, channel: 'C777', threadTs, repos: [] } as unknown as SlackContext;
  const { options } = await buildStreamOptions({ queryEnv: {}, slackContext }, d);
  const entry = (options.hooks?.PreToolUse ?? []).find((e) => (e as { matcher: string }).matcher === '^mcp__') as {
    hooks: Array<
      (
        input: unknown,
      ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>
    >;
  };
  return (tool: string, input: Record<string, unknown>) =>
    entry.hooks[0]({
      hook_event_name: 'PreToolUse',
      tool_name: `mcp__server-tools__${tool}`,
      tool_input: input,
    } as never);
}

describe('server-tools calls and secret grants in the policy hook', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': {
          permission: { db_query: 'read', logs: 'read' },
          plain: {
            ssh: { host: 'plain' },
            databases: { app: { type: 'mysql', password: { $secret: 'plain-db' } } },
          },
          dev2: {
            envUser: 'env:acme-dev2',
            ssh: { host: 'dev2' },
            github: { repos: ['acme/app'], token: { $secret: 'gh-org-admin' } },
          },
        },
      }),
    );
  });
  afterEach(() => {
    fs.rmSync(CONFIG_FILE, { force: true });
  });

  it('denies a call whose secret is not granted, asks the admins once, and names only the secret', async () => {
    const onSecretUseDenied = vi.fn(async () => undefined);
    const run = await hook(deps({ onSecretUseDenied }));
    const out = await run('db_query', { server: 'plain', database: 'app', query: 'select 1' });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('plain-db');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/admin/i);
    expect(onSecretUseDenied).toHaveBeenCalledTimes(1);
    expect(onSecretUseDenied).toHaveBeenCalledWith({
      requesterId: USER,
      names: ['plain-db'],
      tool: 'db_query',
      server: 'plain',
      adminOnlyTool: false,
      channel: 'C777',
      threadTs: THREAD,
    });
  });

  it('an always grant opens the call in any thread; a thread grant only in its thread', async () => {
    addSecretThreadGrant('plain-db', USER, { channel: 'C777', threadTs: THREAD });
    const here = await hook(deps());
    expect(
      (await here('db_query', { server: 'plain', database: 'app' })).hookSpecificOutput?.permissionDecision,
    ).not.toBe('deny');
    const elsewhere = await hook(deps(), '1700000000.0799');
    expect(
      (await elsewhere('db_query', { server: 'plain', database: 'app' })).hookSpecificOutput?.permissionDecision,
    ).toBe('deny');
    grantSecret('plain-db', USER);
    expect(
      (await elsewhere('db_query', { server: 'plain', database: 'app' })).hookSpecificOutput?.permissionDecision,
    ).not.toBe('deny');
  });

  it('an admin-only tool on an environment server opens with its secret granted, and asks for it without', async () => {
    const onSecretUseDenied = vi.fn(async () => undefined);
    const run = await hook(deps({ onSecretUseDenied }));
    expect(
      (await run('gh_pr', { server: 'dev2', action: 'view', number: 1 })).hookSpecificOutput?.permissionDecision,
    ).toBe('deny');
    expect(onSecretUseDenied).toHaveBeenCalledWith(
      expect.objectContaining({ names: ['gh-org-admin'], tool: 'gh_pr', adminOnlyTool: true }),
    );
    grantSecret('gh-org-admin', USER);
    expect(
      (await run('gh_pr', { server: 'dev2', action: 'view', number: 1 })).hookSpecificOutput?.permissionDecision,
    ).not.toBe('deny');
  });

  it('a call that uses no secret is denied as before and asks nobody', async () => {
    const onSecretUseDenied = vi.fn(async () => undefined);
    const run = await hook(deps({ onSecretUseDenied }));
    const out = await run('logs', { server: 'plain', service: 'web' });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(onSecretUseDenied).not.toHaveBeenCalled();
    // A host command never opens through a secret grant.
    grantSecret('plain-db', USER);
    expect((await run('ssh_exec', { server: 'plain', command: 'id' })).hookSpecificOutput?.permissionDecision).toBe(
      'deny',
    );
  });

  it('only adds: the tool grant or the environment grant opens the call with no card', async () => {
    const onSecretUseDenied = vi.fn(async () => undefined);
    const withToolGrant = await hook(deps({ onSecretUseDenied, checkMcpToolPermission: vi.fn(() => null) }));
    expect(
      (await withToolGrant('db_query', { server: 'plain', database: 'app' })).hookSpecificOutput?.permissionDecision,
    ).not.toBe('deny');
    grantEnvironment('env:acme-dev2', USER);
    const withEnvGrant = await hook(deps({ onSecretUseDenied }));
    expect(
      (await withEnvGrant('gh_pr', { server: 'dev2', action: 'view', number: 1 })).hookSpecificOutput
        ?.permissionDecision,
    ).not.toBe('deny');
    expect(onSecretUseDenied).not.toHaveBeenCalled();
  });
});
