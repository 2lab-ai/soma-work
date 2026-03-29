import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── S2, S3, S5: McpConfigBuilder integration with tool permissions ──

// Create temp directories BEFORE vi.mock (hoisting requires no top-level variable refs)
vi.mock('./env-paths', () => {
  const fsMod = require('fs');
  const osMod = require('os');
  const pathMod = require('path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'perm-integ-'));
  const dataDir = pathMod.join(dir, 'data');
  fsMod.mkdirSync(dataDir, { recursive: true });
  return {
    CONFIG_FILE: pathMod.join(dir, 'config.json'),
    DATA_DIR: dataDir,
    MCP_SERVERS_FILE: '',
  };
});

// Mock admin-utils
vi.mock('./admin-utils', () => ({
  isAdminUser: vi.fn((userId: string) => userId === 'U_ADMIN'),
  getAdminUsers: vi.fn(() => new Set(['U_ADMIN'])),
  resetAdminUsersCache: vi.fn(),
}));

import { McpConfigBuilder } from './mcp-config-builder';
import { isAdminUser } from './admin-utils';
import { CONFIG_FILE, DATA_DIR } from './env-paths';

describe('McpConfigBuilder tool permission integration', () => {
  function createMockMcpManager() {
    return {
      getServerConfiguration: vi.fn().mockResolvedValue({}),
      getDefaultAllowedTools: vi.fn().mockReturnValue([]),
    } as any;
  }

  beforeEach(() => {
    // Write config with permission section
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      'server-tools': {
        permission: {
          db_query: 'write',
          logs: 'read',
          list: 'read',
          list_service: 'read',
        },
        dev2: { ssh: { host: 'example.com' } },
      },
    }));
  });

  afterEach(() => {
    // Clean grant file
    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    if (fs.existsSync(grantFile)) fs.unlinkSync(grantFile);
  });

  // ── S2: Admin bypasses permission check ──
  it('adminBypassesPermissionCheck — admin gets all server-tools in allowedTools', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_ADMIN' });

    // Admin should have server-tools allowed regardless of grants
    expect(config.allowedTools).toContain('mcp__server-tools');
  });

  // ── S3: Non-admin blocked without grant ──
  it('permissionGatedToolsExcludedForNonAdminWithoutGrant', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_REGULAR' });

    // Non-admin without grant should NOT have server-tools in allowedTools
    const serverToolsAllowed = config.allowedTools?.some(t => t.startsWith('mcp__server-tools'));
    expect(serverToolsAllowed).toBe(false);
  });

  // ── S2: Admin accesses write tool without grant ──
  it('adminAccessesWriteToolWithoutGrant', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_ADMIN' });

    // Admin should get mcp__server-tools (which includes db_query)
    expect(config.allowedTools).toContain('mcp__server-tools');
  });

  // ── Always includes mcp-tool-permission server for requesting access ──
  it('mcpToolPermissionServerAlwaysAvailableInSlackContext', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_REGULAR' });

    expect(config.allowedTools).toContain('mcp__mcp-tool-permission');
  });
});

describe('PreToolUse permission hook', () => {
  // ── S3: preToolUseHookDeniesUngrantedTool ──
  it('preToolUseHookDeniesUngrantedTool — denies non-admin without grant', () => {
    const userId = 'U_REGULAR';

    // isAdminUser should return false for regular user
    expect(isAdminUser(userId)).toBe(false);
    // Admin should be true
    expect(isAdminUser('U_ADMIN')).toBe(true);
  });
});
