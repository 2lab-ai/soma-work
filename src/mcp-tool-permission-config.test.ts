import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadMcpToolPermissions,
  getRequiredLevel,
  levelSatisfies,
  getPermissionGatedServers,
  resolveGatedTool,
  type McpToolPermissionConfig,
} from './mcp-tool-permission-config';

function writeTempConfig(content: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-config-test-'));
  const filePath = path.join(dir, 'config.json');
  fs.writeFileSync(filePath, JSON.stringify(content));
  return filePath;
}

describe('loadMcpToolPermissions', () => {
  // ── S1: parses permission from config ──
  it('parsesPermissionFromConfig', () => {
    const configFile = writeTempConfig({
      'server-tools': {
        permission: {
          db_query: 'write',
          logs: 'read',
          list: 'read',
          list_service: 'read',
        },
        dev2: { ssh: { host: 'example.com' } },
      },
    });

    const result = loadMcpToolPermissions(configFile);
    expect(result['server-tools']).toBeDefined();
    expect(result['server-tools']['db_query']).toBe('write');
    expect(result['server-tools']['logs']).toBe('read');
  });

  // ── S1: ignores permission key as server config ──
  it('ignoresPermissionKeyAsServerConfig', () => {
    const configFile = writeTempConfig({
      'server-tools': {
        permission: { db_query: 'write' },
        dev2: { ssh: { host: 'example.com' } },
      },
    });

    const result = loadMcpToolPermissions(configFile);
    // permission should be extracted, not treated as a server entry
    expect(result['server-tools']).toBeDefined();
    expect(result['server-tools']['db_query']).toBe('write');
  });

  // ── S1: backward compatible when no permission ──
  it('backwardCompatibleWhenNoPermission', () => {
    const configFile = writeTempConfig({
      'server-tools': {
        dev2: { ssh: { host: 'example.com' } },
      },
    });

    const result = loadMcpToolPermissions(configFile);
    expect(result['server-tools']).toBeUndefined();
  });

  // ── S1: warns on invalid permission level ──
  it('warnsOnInvalidPermissionLevel', () => {
    const configFile = writeTempConfig({
      'server-tools': {
        permission: {
          db_query: 'admin', // invalid
          logs: 'read',
        },
      },
    });

    const result = loadMcpToolPermissions(configFile);
    // Invalid level should be excluded
    expect(result['server-tools']?.['db_query']).toBeUndefined();
    expect(result['server-tools']?.['logs']).toBe('read');
  });

  // ── S1: config file missing ──
  it('returns empty for nonexistent config', () => {
    const result = loadMcpToolPermissions('/nonexistent/config.json');
    expect(result).toEqual({});
  });
});

describe('getRequiredLevel', () => {
  const config: McpToolPermissionConfig = {
    'server-tools': {
      db_query: 'write',
      logs: 'read',
    },
  };

  it('returns correct level for configured tool', () => {
    expect(getRequiredLevel(config, 'server-tools', 'db_query')).toBe('write');
    expect(getRequiredLevel(config, 'server-tools', 'logs')).toBe('read');
  });

  it('returns null for unconfigured tool', () => {
    expect(getRequiredLevel(config, 'server-tools', 'list')).toBeNull();
  });

  it('returns null for unconfigured server', () => {
    expect(getRequiredLevel(config, 'unknown-server', 'db_query')).toBeNull();
  });
});

describe('levelSatisfies', () => {
  it('write satisfies write', () => {
    expect(levelSatisfies('write', 'write')).toBe(true);
  });

  it('write satisfies read', () => {
    expect(levelSatisfies('write', 'read')).toBe(true);
  });

  it('read satisfies read', () => {
    expect(levelSatisfies('read', 'read')).toBe(true);
  });

  it('read does NOT satisfy write', () => {
    expect(levelSatisfies('read', 'write')).toBe(false);
  });
});

describe('getPermissionGatedServers', () => {
  it('returns empty array for empty config', () => {
    expect(getPermissionGatedServers({})).toEqual([]);
  });

  it('returns all server names with permission config', () => {
    const config: McpToolPermissionConfig = {
      'server-tools': { db_query: 'write', logs: 'read' },
      'database-mcp': { execute: 'write' },
    };
    const result = getPermissionGatedServers(config);
    expect(result).toContain('server-tools');
    expect(result).toContain('database-mcp');
    expect(result).toHaveLength(2);
  });
});

describe('resolveGatedTool', () => {
  const gatedServers = ['server-tools', 'database-mcp'];

  it('resolves standard tool name correctly', () => {
    const result = resolveGatedTool('mcp__server-tools__db_query', gatedServers);
    expect(result).toEqual({ serverName: 'server-tools', toolFunction: 'db_query' });
  });

  it('resolves tool with __ in function name', () => {
    const result = resolveGatedTool('mcp__server-tools__complex__tool__name', gatedServers);
    expect(result).toEqual({ serverName: 'server-tools', toolFunction: 'complex__tool__name' });
  });

  it('returns null for non-mcp prefix', () => {
    expect(resolveGatedTool('Bash', gatedServers)).toBeNull();
    expect(resolveGatedTool('', gatedServers)).toBeNull();
  });

  it('returns null for mcp tool not in gated servers', () => {
    expect(resolveGatedTool('mcp__llm__chat', gatedServers)).toBeNull();
  });

  it('returns null for prefix-only match (no tool function)', () => {
    expect(resolveGatedTool('mcp__server-tools__', gatedServers)).toBeNull();
  });

  it('returns null for server prefix without tool separator', () => {
    // "mcp__server-tools" without trailing __toolName
    expect(resolveGatedTool('mcp__server-tools', gatedServers)).toBeNull();
  });

  it('handles empty gated servers list', () => {
    expect(resolveGatedTool('mcp__server-tools__db_query', [])).toBeNull();
  });

  it('matches correct server when names share prefix', () => {
    // "server" vs "server-tools" — must not confuse partial match
    const servers = ['server', 'server-tools'];
    const result = resolveGatedTool('mcp__server-tools__logs', servers);
    expect(result).toEqual({ serverName: 'server-tools', toolFunction: 'logs' });
  });
});
