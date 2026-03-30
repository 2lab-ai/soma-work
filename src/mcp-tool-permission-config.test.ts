import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadMcpToolPermissions,
  getRequiredLevel,
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
