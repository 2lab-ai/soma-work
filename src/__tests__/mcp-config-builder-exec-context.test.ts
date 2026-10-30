/**
 * McpConfigBuilder under an execution context (#597, .prd/17 D2 · D3).
 *
 * - With no context at all the config is never `bypass` and opens no gated
 *   MCP server — "no user" used to mean full access on both.
 * - A Slack-less task's mode, gating and filesystem scope come from its
 *   context's user. Slack-only servers and the Slack permission prompt stay
 *   Slack-only; terminal-interactive and SDK cron tools are disallowed as in a
 *   Slack turn.
 */
import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => {
  const fsMod = require('fs');
  const osMod = require('os');
  const pathMod = require('path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mcp-exec-ctx-'));
  const dataDir = pathMod.join(dir, 'data');
  fsMod.mkdirSync(dataDir, { recursive: true });
  return { CONFIG_FILE: pathMod.join(dir, 'config.json'), DATA_DIR: dataDir, MCP_SERVERS_FILE: '' };
});

vi.mock('../admin-utils', () => ({
  isAdminUser: vi.fn((userId: string) => userId === 'U_ADMIN'),
  getAdminUsers: vi.fn(() => new Set(['U_ADMIN'])),
  resetAdminUsersCache: vi.fn(),
}));

const { modeMock } = vi.hoisted(() => ({ modeMock: vi.fn().mockReturnValue('auto') }));
vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserPermissionMode: modeMock,
    getUserDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514'),
  },
}));

import type { ExecutionContext } from '../agent-runtime/execution-context';
import { CONFIG_FILE } from '../env-paths';
import { NATIVE_BYPASS_TOOLS } from '../hooks/bypass-permission-guard';
import { McpConfigBuilder } from '../mcp-config-builder';

function mcpManager(servers: Record<string, unknown> = {}) {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue(servers),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  } as any;
}

// A hand-built context: only a test may forge one (the type is branded so production code cannot).
function taskCtx(overrides: Record<string, unknown> = {}): ExecutionContext {
  return {
    origin: 'task',
    userId: 'U_TASK',
    isAdmin: false,
    permissionMode: 'auto',
    sessionKey: 'task:11111111-2222-4333-8444-555555555555',
    taskId: '11111111-2222-4333-8444-555555555555',
    workingDirectory: '/tmp/U_TASK/session_x',
    ...overrides,
  } as unknown as ExecutionContext;
}

describe('McpConfigBuilder — execution context (#597)', () => {
  beforeEach(() => {
    modeMock.mockReset().mockReturnValue('auto');
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': { permission: { db_query: 'write', logs: 'read' }, dev2: { ssh: { host: 'x' } } },
      }),
    );
  });

  it('no context at all → never bypass', async () => {
    const config = await new McpConfigBuilder(mcpManager()).buildConfig();
    expect(config.permissionMode).toBe('default');
    expect(config.allowDangerouslySkipPermissions).toBeUndefined();
    expect(config.userBypass).toBe(false);
    expect(config.somaPermissionMode).not.toBe('bypass');
  });

  it('no context at all → a permission-gated MCP server is not opened', async () => {
    const config = await new McpConfigBuilder(mcpManager()).buildConfig();
    expect(config.allowedTools).not.toContain('mcp__server-tools');
  });

  it('a task’s mode comes from its context, not from a Slack user', async () => {
    const config = await new McpConfigBuilder(mcpManager()).buildConfig(undefined, undefined, taskCtx());
    expect(config.somaPermissionMode).toBe('auto');
    expect(config.permissionMode).toBe('bypassPermissions'); // the policy hook decides, as for a Slack auto user
    expect(modeMock).not.toHaveBeenCalled(); // the context already carries the mode
  });

  it('a legacy-mode task gets the SDK’s own permission checks (no skip)', async () => {
    const config = await new McpConfigBuilder(mcpManager()).buildConfig(
      undefined,
      undefined,
      taskCtx({ permissionMode: 'legacy' }),
    );
    expect(config.permissionMode).toBe('default');
    expect(config.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('a task gets no Slack-only server and no Slack permission prompt', async () => {
    const config = await new McpConfigBuilder(mcpManager()).buildConfig(undefined, undefined, taskCtx());
    const servers = Object.keys(config.mcpServers ?? {});
    for (const slackOnly of ['model-command', 'slack-mcp', 'cron', 'mcp-tool-permission', 'permission-prompt']) {
      expect(servers).not.toContain(slackOnly);
    }
    expect(config.permissionPromptToolName).toBeUndefined();
  });

  it('a task disallows terminal-interactive and SDK cron tools, as a Slack turn does', async () => {
    const config = await new McpConfigBuilder(mcpManager()).buildConfig(undefined, undefined, taskCtx());
    expect(config.disallowedTools).toEqual(expect.arrayContaining(['AskUserQuestion', 'CronCreate']));
  });

  it('a task in auto/bypass mode lists the native non-Bash tools, as a Slack turn does', async () => {
    const config = await new McpConfigBuilder(mcpManager()).buildConfig(undefined, undefined, taskCtx());
    for (const tool of NATIVE_BYPASS_TOOLS) expect(config.allowedTools).toContain(tool);
    expect(config.allowedTools).not.toContain('Bash');
  });

  it('gating reads the task’s user: no grant → blocked, admin → allowed', async () => {
    const plain = await new McpConfigBuilder(mcpManager()).buildConfig(undefined, undefined, taskCtx());
    expect(plain.allowedTools).not.toContain('mcp__server-tools');
    const admin = await new McpConfigBuilder(mcpManager()).buildConfig(
      undefined,
      undefined,
      taskCtx({ userId: 'U_ADMIN', isAdmin: true }),
    );
    expect(admin.allowedTools).toContain('mcp__server-tools');
  });

  it('the filesystem MCP is confined to the task user’s /tmp directory', async () => {
    const config = await new McpConfigBuilder(
      mcpManager({ filesystem: { command: 'npx', args: ['-y', 'fs-server', '/tmp'] } }),
    ).buildConfig(undefined, undefined, taskCtx());
    const args = (config.mcpServers?.filesystem as { args: string[] }).args;
    expect(args[args.length - 1]).toBe('/tmp/U_TASK');
  });
});
