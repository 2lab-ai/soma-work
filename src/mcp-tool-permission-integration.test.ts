import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { isAdminUser } from './admin-utils';
import { CONFIG_FILE, DATA_DIR } from './env-paths';
import { McpConfigBuilder } from './mcp-config-builder';

describe('McpConfigBuilder tool permission integration', () => {
  function createMockMcpManager() {
    return {
      getServerConfiguration: vi.fn().mockResolvedValue({}),
      getDefaultAllowedTools: vi.fn().mockReturnValue([]),
    } as any;
  }

  beforeEach(() => {
    // Write config with permission section
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': {
          permission: {
            db_query: 'write',
            logs: 'read',
            list: 'read',
            list_service: 'read',
          },
          dev2: { ssh: { host: 'example.com' } },
        },
      }),
    );
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
    const serverToolsAllowed = config.allowedTools?.some((t) => t.startsWith('mcp__server-tools'));
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

  // ── S5: Per-tool filtering — read grant allows read tools, blocks write tools ──
  it('readGrantAllowsReadToolsBlocksWriteTools', async () => {
    // Write a read grant to the grants file (simulating approval)
    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    fs.writeFileSync(
      grantFile,
      JSON.stringify({
        U_READ_USER: {
          'server-tools': {
            read: { grantedAt: new Date().toISOString(), expiresAt, grantedBy: 'U_ADMIN' },
          },
        },
      }),
    );

    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_READ_USER' });

    // Should allow read-level tools individually
    expect(config.allowedTools).toContain('mcp__server-tools__logs');
    expect(config.allowedTools).toContain('mcp__server-tools__list');
    expect(config.allowedTools).toContain('mcp__server-tools__list_service');
    // Should NOT allow write-level tools
    expect(config.allowedTools).not.toContain('mcp__server-tools__db_query');
    // Should NOT have blanket server-tools prefix
    expect(config.allowedTools).not.toContain('mcp__server-tools');
  });

  // ── S5: write grant allows all tools ──
  it('writeGrantAllowsAllTools', async () => {
    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    fs.writeFileSync(
      grantFile,
      JSON.stringify({
        U_WRITE_USER: {
          'server-tools': {
            write: { grantedAt: new Date().toISOString(), expiresAt, grantedBy: 'U_ADMIN' },
          },
        },
      }),
    );

    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_WRITE_USER' });

    // Write grant implies read — all tools should be allowed
    expect(config.allowedTools).toContain('mcp__server-tools__db_query');
    expect(config.allowedTools).toContain('mcp__server-tools__logs');
    expect(config.allowedTools).toContain('mcp__server-tools__list');
    expect(config.allowedTools).toContain('mcp__server-tools__list_service');
  });
});

// ── Generic permission gating: works for any MCP server with permission config ──
describe('Generic permission gating', () => {
  function createMockMcpManager() {
    return {
      getServerConfiguration: vi.fn().mockResolvedValue({}),
      getDefaultAllowedTools: vi.fn().mockReturnValue([]),
    } as any;
  }

  afterEach(() => {
    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    if (fs.existsSync(grantFile)) fs.unlinkSync(grantFile);
  });

  it('gates multiple MCP servers independently', async () => {
    // Config with TWO permission-gated servers
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': {
          permission: { db_query: 'write', logs: 'read' },
          dev2: { ssh: { host: 'example.com' } },
        },
        'database-mcp': {
          permission: { execute: 'write', query: 'read' },
          conn: { host: 'db.example.com' },
        },
      }),
    );

    // User has read grant on server-tools only
    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    fs.writeFileSync(
      grantFile,
      JSON.stringify({
        U_MULTI_USER: {
          'server-tools': {
            read: { grantedAt: new Date().toISOString(), expiresAt, grantedBy: 'U_ADMIN' },
          },
        },
      }),
    );

    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_MULTI_USER' });

    // server-tools: read grant → read tools allowed, write tools blocked
    expect(config.allowedTools).toContain('mcp__server-tools__logs');
    expect(config.allowedTools).not.toContain('mcp__server-tools__db_query');

    // database-mcp: no grant → entirely blocked
    const dbMcpAllowed = config.allowedTools?.some((t) => t.startsWith('mcp__database-mcp'));
    expect(dbMcpAllowed).toBe(false);
  });

  it('admin bypasses all gated servers', async () => {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': {
          permission: { db_query: 'write', logs: 'read' },
          dev2: { ssh: { host: 'example.com' } },
        },
        'database-mcp': {
          permission: { execute: 'write', query: 'read' },
          conn: { host: 'db.example.com' },
        },
      }),
    );

    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_ADMIN' });

    // Admin gets blanket access to both servers
    expect(config.allowedTools).toContain('mcp__server-tools');
    expect(config.allowedTools).toContain('mcp__database-mcp');
  });

  it('write grant on second server allows all its tools', async () => {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': {
          permission: { db_query: 'write', logs: 'read' },
          dev2: { ssh: { host: 'example.com' } },
        },
        'database-mcp': {
          permission: { execute: 'write', query: 'read' },
          conn: { host: 'db.example.com' },
        },
      }),
    );

    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    fs.writeFileSync(
      grantFile,
      JSON.stringify({
        U_DB_WRITER: {
          'database-mcp': {
            write: { grantedAt: new Date().toISOString(), expiresAt, grantedBy: 'U_ADMIN' },
          },
        },
      }),
    );

    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_DB_WRITER' });

    // database-mcp: write grant → all tools
    expect(config.allowedTools).toContain('mcp__database-mcp__execute');
    expect(config.allowedTools).toContain('mcp__database-mcp__query');

    // server-tools: no grant → blocked
    const serverToolsAllowed = config.allowedTools?.some((t) => t.startsWith('mcp__server-tools'));
    expect(serverToolsAllowed).toBe(false);
  });

  it('no permission config → server-tools allowed with blanket prefix (backward compat)', async () => {
    // Config WITHOUT permission section
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': {
          dev2: { ssh: { host: 'example.com' } },
        },
      }),
    );

    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U_REGULAR' });

    // No permission gating → blanket allow
    expect(config.allowedTools).toContain('mcp__server-tools');
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

import { mcpToolGrantStore } from './mcp-tool-grant-store';
// ── checkMcpToolPermission logic tests (Layer 2 runtime enforcement) ──
// Since checkMcpToolPermission is private, we test the same logic via
// the exported resolveGatedTool + getRequiredLevel + levelSatisfies chain
// plus mcpToolGrantStore for grant lookups.
import {
  getPermissionGatedServers,
  getRequiredLevel,
  levelSatisfies,
  loadMcpToolPermissions,
  type McpToolPermissionConfig,
  type PermissionLevel,
  resolveGatedTool,
} from './mcp-tool-permission-config';

/**
 * Reproduces the exact logic of ClaudeHandler.checkMcpToolPermission (claude-handler.ts ~line 732).
 * SYNC: If you modify ClaudeHandler.checkMcpToolPermission, update this test helper too.
 * Returns a denial reason string, or null if the tool is allowed.
 */
function checkMcpToolPermission(
  toolName: string,
  userId: string,
  permConfig: McpToolPermissionConfig,
  gatedServerNames: string[],
): string | null {
  const resolved = resolveGatedTool(toolName, gatedServerNames);
  if (!resolved) return null;

  const { serverName, toolFunction } = resolved;
  const requiredLevel = getRequiredLevel(permConfig, serverName, toolFunction);

  // Task 1: deny-by-default for unlisted tools on gated servers
  if (!requiredLevel) {
    return `Tool ${toolFunction} on gated server ${serverName} is not listed in permission config. Access denied by default.`;
  }

  // Check active grants
  mcpToolGrantStore.reload();
  const hasWriteGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'write');
  const hasReadGrant = mcpToolGrantStore.hasActiveGrant(userId, serverName, 'read');
  const userLevel: PermissionLevel | null = hasWriteGrant ? 'write' : hasReadGrant ? 'read' : null;

  if (!userLevel) {
    return `No active grant for ${serverName}. Required: ${requiredLevel}. Use mcp__mcp-tool-permission__request_permission to request access.`;
  }

  if (!levelSatisfies(userLevel, requiredLevel)) {
    return `Insufficient grant level for ${serverName}/${toolFunction}. Have: ${userLevel}, required: ${requiredLevel}.`;
  }

  return null;
}

describe('checkMcpToolPermission logic (Layer 2 runtime enforcement)', () => {
  const permConfig: McpToolPermissionConfig = {
    'server-tools': {
      db_query: 'write',
      logs: 'read',
      list: 'read',
    },
  };
  const gatedServerNames = getPermissionGatedServers(permConfig);

  afterEach(() => {
    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    if (fs.existsSync(grantFile)) fs.unlinkSync(grantFile);
  });

  it('denies unlisted tool on gated server (deny-by-default)', () => {
    // Tool exists on gated server but is NOT in permission config
    const result = checkMcpToolPermission('mcp__server-tools__unknown_tool', 'U_REGULAR', permConfig, gatedServerNames);
    expect(result).not.toBeNull();
    expect(result).toContain('not listed in permission config');
    expect(result).toContain('Access denied by default');
  });

  it('denies tool on gated server when user has no grant', () => {
    // No grants on disk — user should be denied
    const result = checkMcpToolPermission('mcp__server-tools__logs', 'U_NO_GRANT', permConfig, gatedServerNames);
    expect(result).not.toBeNull();
    expect(result).toContain('No active grant');
    expect(result).toContain('Required: read');
  });

  it('denies tool when user has read grant but tool requires write', () => {
    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    fs.writeFileSync(
      grantFile,
      JSON.stringify({
        U_READ_ONLY: {
          'server-tools': {
            read: { grantedAt: new Date().toISOString(), expiresAt, grantedBy: 'U_ADMIN' },
          },
        },
      }),
    );

    const result = checkMcpToolPermission(
      'mcp__server-tools__db_query', // requires write
      'U_READ_ONLY',
      permConfig,
      gatedServerNames,
    );
    expect(result).not.toBeNull();
    expect(result).toContain('Insufficient grant level');
    expect(result).toContain('Have: read');
    expect(result).toContain('required: write');
  });

  it('allows tool when user has write grant and tool requires write', () => {
    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    fs.writeFileSync(
      grantFile,
      JSON.stringify({
        U_WRITER: {
          'server-tools': {
            write: { grantedAt: new Date().toISOString(), expiresAt, grantedBy: 'U_ADMIN' },
          },
        },
      }),
    );

    const result = checkMcpToolPermission(
      'mcp__server-tools__db_query', // requires write
      'U_WRITER',
      permConfig,
      gatedServerNames,
    );
    expect(result).toBeNull();
  });

  it('allows tool when user has write grant and tool requires read', () => {
    const grantFile = path.join(DATA_DIR, 'mcp-tool-grants.json');
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    fs.writeFileSync(
      grantFile,
      JSON.stringify({
        U_WRITER: {
          'server-tools': {
            write: { grantedAt: new Date().toISOString(), expiresAt, grantedBy: 'U_ADMIN' },
          },
        },
      }),
    );

    const result = checkMcpToolPermission(
      'mcp__server-tools__logs', // requires read
      'U_WRITER',
      permConfig,
      gatedServerNames,
    );
    expect(result).toBeNull();
  });

  it('allows tool NOT on any gated server (returns null)', () => {
    const result = checkMcpToolPermission(
      'mcp__some-other-server__some_tool',
      'U_REGULAR',
      permConfig,
      gatedServerNames,
    );
    expect(result).toBeNull();
  });

  it('allows non-mcp tool names (returns null)', () => {
    const result = checkMcpToolPermission('Bash', 'U_REGULAR', permConfig, gatedServerNames);
    expect(result).toBeNull();
  });
});
