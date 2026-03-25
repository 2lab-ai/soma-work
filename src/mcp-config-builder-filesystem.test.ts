import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock env-paths before any imports that use it
vi.mock('./env-paths', () => ({
  DATA_DIR: '/tmp/mcp-config-fs-test',
  MCP_CONFIG_FILE: '/tmp/mcp-config-fs-test/mcp-servers.json',
  CONFIG_FILE: '/tmp/mcp-config-fs-test/config.json',
  SYSTEM_PROMPT_FILE: '/tmp/mcp-config-fs-test/.system.prompt',
  PLUGINS_DIR: '/tmp/mcp-config-fs-test/plugins',
  IS_DEV: false,
}));

vi.mock('./user-settings-store', () => ({
  userSettingsStore: {
    getUserBypassPermission: vi.fn().mockReturnValue(false),
    getUserDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514'),
  },
}));

import { McpConfigBuilder } from './mcp-config-builder';
import { McpManager } from './mcp-manager';

describe('McpConfigBuilder filesystem restriction', () => {
  let builder: McpConfigBuilder;

  beforeEach(() => {
    const mcpManager = McpManager.fromParsedServers({
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      },
    });
    builder = new McpConfigBuilder(mcpManager);
  });

  // Trace: Scenario 2, Section 3a — filesystem restricted to user dir
  it('restricts filesystem MCP to /tmp/{slackId} when slackContext present', async () => {
    const config = await builder.buildConfig({
      channel: 'C001',
      user: 'U094E5L4A15',
    });

    expect(config.mcpServers?.filesystem).toBeDefined();
    const fsArgs = (config.mcpServers?.filesystem as any)?.args;
    expect(fsArgs).toBeDefined();
    // Last arg should be user-scoped path
    expect(fsArgs[fsArgs.length - 1]).toBe('/tmp/U094E5L4A15');
  });

  // Trace: Scenario 2, Section 5 — no slackContext keeps default
  it('keeps default filesystem config without slackContext', async () => {
    const config = await builder.buildConfig();

    if (config.mcpServers?.filesystem) {
      const fsArgs = (config.mcpServers?.filesystem as any)?.args;
      // Without slack context, should retain original '/tmp'
      expect(fsArgs[fsArgs.length - 1]).toBe('/tmp');
    }
  });

  // Trace: Scenario 2, Section 3a → 6 — path is normalized (no /private/tmp)
  it('uses normalized path (not /private/tmp)', async () => {
    const config = await builder.buildConfig({
      channel: 'C001',
      user: 'U094E5L4A15',
    });

    const fsArgs = (config.mcpServers?.filesystem as any)?.args;
    if (fsArgs) {
      const lastArg = fsArgs[fsArgs.length - 1];
      expect(lastArg).not.toContain('/private/tmp');
      expect(lastArg).toMatch(/^\/tmp\//);
    }
  });
});
