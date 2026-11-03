/**
 * E4 ④a — the `epic` server in the turn's MCP config (.prd/19 D3, §5 ④a).
 *
 *   B1 an epic's own Slack turn (its context names the epic, #854) gets the `epic` server, and
 *      its tools are in `allowedTools`, so a `legacy` turn never asks.
 *   B2 a turn that names no epic (a child's, an ordinary session's) and a dashboard task's turn
 *      never get it (depth 1: a child cannot make children).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => {
  const fsMod = require('fs');
  const osMod = require('os');
  const pathMod = require('path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mcp-epic-'));
  const dataDir = pathMod.join(dir, 'data');
  fsMod.mkdirSync(dataDir, { recursive: true });
  return { CONFIG_FILE: pathMod.join(dir, 'config.json'), DATA_DIR: dataDir, MCP_SERVERS_FILE: '' };
});

vi.mock('../admin-utils', () => ({
  isAdminUser: vi.fn(() => false),
  getAdminUsers: vi.fn(() => new Set()),
  resetAdminUsersCache: vi.fn(),
}));

const { modeMock } = vi.hoisted(() => ({ modeMock: vi.fn().mockReturnValue('legacy') }));
vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserPermissionMode: modeMock,
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

function taskCtx(overrides: Record<string, unknown> = {}): ExecutionContext {
  return {
    origin: 'task',
    userId: 'U_TASK',
    isAdmin: false,
    permissionMode: 'legacy',
    sessionKey: 'task:e1',
    taskId: 'e1',
    workingDirectory: '/tmp/U_TASK/session_x',
    ...overrides,
  } as unknown as ExecutionContext;
}

describe('McpConfigBuilder — the epic server (E4 ④a)', () => {
  beforeEach(() => modeMock.mockReset().mockReturnValue('legacy'));

  const slackEpicCtx = (overrides: Record<string, unknown> = {}) =>
    ({
      origin: 'slack',
      userId: 'U1',
      isAdmin: false,
      permissionMode: 'legacy',
      sessionKey: 'work:C1:1.1',
      epicTaskId: 'e1',
      ...overrides,
    }) as unknown as ExecutionContext;

  it('B1 — an epic’s own Slack turn gets the epic server, allowed so a legacy turn never asks', async () => {
    const config = await new McpConfigBuilder(manager()).buildConfig(undefined, undefined, slackEpicCtx());
    expect(Object.keys(config.mcpServers ?? {})).toContain('epic');
    expect((config.mcpServers as any).epic.type).toBe('sdk');
    expect(config.allowedTools).toContain('mcp__epic');
  });

  it.each([
    ['a child’s turn', taskCtx({ parentTaskId: 'e0' })],
    ['a child claiming to be an epic', taskCtx({ kind: 'epic', parentTaskId: 'e0' })],
    ['an ordinary task’s turn', taskCtx()],
    ['a dashboard task’s epic (#854: archived with its stack)', taskCtx({ kind: 'epic' })],
    [
      'a Slack turn',
      {
        origin: 'slack',
        userId: 'U1',
        isAdmin: false,
        permissionMode: 'legacy',
        sessionKey: 'work:C1:1.1',
      } as unknown as ExecutionContext,
    ],
  ])('B2 — %s never gets the epic server', async (_label, ctx) => {
    const config = await new McpConfigBuilder(manager()).buildConfig(undefined, undefined, ctx);
    expect(config.mcpServers ?? {}).not.toHaveProperty('epic');
    expect(config.allowedTools ?? []).not.toContain('mcp__epic');
  });
});
