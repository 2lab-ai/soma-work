/**
 * Plan mode (SSOT 2026-11-02) — the `plan` server in the turn's MCP config.
 *
 *   B1 a task turn whose plan is not started gets the `plan` server, allowed (a legacy turn never asks).
 *   B2 while a plan is not started an epic gets no `epic` server — no child before the owner starts it.
 *   B3 a started plan's turn, an ordinary task and a Slack turn get no `plan` server.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => {
  const fsMod = require('fs');
  const osMod = require('os');
  const pathMod = require('path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mcp-plan-'));
  const dataDir = pathMod.join(dir, 'data');
  fsMod.mkdirSync(dataDir, { recursive: true });
  return { CONFIG_FILE: pathMod.join(dir, 'config.json'), DATA_DIR: dataDir, MCP_SERVERS_FILE: '' };
});
vi.mock('../admin-utils', () => ({
  isAdminUser: vi.fn(() => false),
  getAdminUsers: vi.fn(() => new Set()),
  resetAdminUsersCache: vi.fn(),
}));
vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserPermissionMode: vi.fn().mockReturnValue('legacy'),
    getUserDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514'),
  },
}));

import type { ExecutionContext } from '../agent-runtime/execution-context';
import { McpConfigBuilder } from '../mcp-config-builder';

const manager = () =>
  ({
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  }) as any;
const taskCtx = (overrides: Record<string, unknown> = {}) =>
  ({
    origin: 'task',
    userId: 'U_TASK',
    isAdmin: false,
    permissionMode: 'legacy',
    sessionKey: 'task:t1',
    taskId: 't1',
    workingDirectory: '/tmp/U_TASK/session_x',
    ...overrides,
  }) as unknown as ExecutionContext;
const build = (ctx: ExecutionContext) => new McpConfigBuilder(manager()).buildConfig(undefined, undefined, ctx);

describe('McpConfigBuilder — the plan server (plan mode)', () => {
  it('B1 — a pending plan’s turn gets the plan server, allowed', async () => {
    const config = await build(taskCtx({ planPending: true }));
    expect(Object.keys(config.mcpServers ?? {})).toContain('plan');
    expect(config.allowedTools).toContain('mcp__plan');
  });

  it('B2 — an epic waits for its owner: no epic server while its plan is not started', async () => {
    const pending = await build(taskCtx({ kind: 'epic', planPending: true }));
    expect(pending.mcpServers ?? {}).not.toHaveProperty('epic');
    expect(pending.allowedTools ?? []).not.toContain('mcp__epic');
    expect(Object.keys(pending.mcpServers ?? {})).toContain('plan');
    const started = await build(taskCtx({ kind: 'epic' }));
    expect(Object.keys(started.mcpServers ?? {})).toContain('epic');
    expect(started.mcpServers ?? {}).not.toHaveProperty('plan');
  });

  it.each([
    ['an ordinary task', taskCtx()],
    [
      'a Slack turn',
      {
        origin: 'slack',
        userId: 'U1',
        isAdmin: false,
        permissionMode: 'legacy',
        sessionKey: 'work:C1:1.1',
        planPending: true,
      } as unknown as ExecutionContext,
    ],
  ])('B3 — %s gets no plan server', async (_label, ctx) => {
    const config = await build(ctx);
    expect(config.mcpServers ?? {}).not.toHaveProperty('plan');
    expect(config.allowedTools ?? []).not.toContain('mcp__plan');
  });
});
