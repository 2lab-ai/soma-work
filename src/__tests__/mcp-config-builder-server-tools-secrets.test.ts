import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// server-tools runs outside every model sandbox and resolves `{"$secret": name}` from the secret store
// (.prd/25-env-access-architecture.md §2, WU1): the bot tells it where the store is, and nothing else.

vi.mock('../env-paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../env-paths')>();
  const fsMod = require('node:fs');
  const osMod = require('node:os');
  const pathMod = require('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'server-tools-secrets-'));
  const dataDir = pathMod.join(dir, 'data');
  fsMod.mkdirSync(dataDir, { recursive: true });
  return {
    ...orig,
    CONFIG_FILE: pathMod.join(dir, 'config.json'),
    DATA_DIR: dataDir,
    SECRETS_DIR: pathMod.join(dir, 'secrets'),
  };
});

import path from 'node:path';
import { CONFIG_FILE, DATA_DIR, SECRETS_DIR } from '../env-paths';
import { McpConfigBuilder } from '../mcp-config-builder';
import type { McpManager } from '../mcp-manager';

function mcpManager(): McpManager {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  } as unknown as McpManager;
}

describe('server-tools wiring — secret store', () => {
  it('passes the config file and the secret store directory, and no secret value', async () => {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        'server-tools': {
          dev2: {
            ssh: { host: 'dev2' },
            databases: { app: { type: 'mysql', host: 'h', port: 1, user: 'u', password: { $secret: 'dev2-db-app' } } },
          },
        },
      }),
    );
    const config = await new McpConfigBuilder(mcpManager()).buildConfig({ channel: 'C1', user: 'U1' });
    const env = config.mcpServers?.['server-tools']?.env as Record<string, string> | undefined;
    expect(env).toEqual({
      SOMA_CONFIG_FILE: CONFIG_FILE,
      SOMA_SECRETS_DIR: SECRETS_DIR,
      // env-access WU3 (#1211): where environment users' writes are audited, and for whom the session runs.
      SOMA_AUDIT_DIR: path.join(DATA_DIR, 'env-audit'),
      SOMA_REQUESTER: 'U1',
    });
  });

  it('passes no requester that is not a Slack user ID', async () => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ 'server-tools': { dev2: { ssh: { host: 'dev2' } } } }));
    const config = await new McpConfigBuilder(mcpManager()).buildConfig({ channel: 'C1', user: 'U1\nforged' });
    const env = config.mcpServers?.['server-tools']?.env as Record<string, string> | undefined;
    expect(env?.SOMA_REQUESTER).toBeUndefined();
    expect(env?.SOMA_AUDIT_DIR).toBe(path.join(DATA_DIR, 'env-audit'));
  });
});
