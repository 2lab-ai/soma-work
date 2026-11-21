import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock env-paths before any imports that use it
vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/mcp-config-fs-test',
  CONFIG_FILE: '/tmp/mcp-config-fs-test/config.json',
  SYSTEM_PROMPT_FILE: '/tmp/mcp-config-fs-test/.system.prompt',
  PLUGINS_DIR: '/tmp/mcp-config-fs-test/plugins',
  IS_DEV: false,
}));

vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserBypassPermission: vi.fn().mockReturnValue(false),
    getUserPermissionMode: vi.fn().mockReturnValue('auto'),
    getUserDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514'),
  },
}));

import { McpConfigBuilder } from '../mcp-config-builder';
import { McpManager } from '../mcp-manager';

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

    // Without slack context, the configured server is kept as it is, '/tmp' root included.
    expect((config.mcpServers?.filesystem as any).args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/tmp',
    ]);
  });

  // Fix: multiple /tmp args should ALL be replaced (not just first)
  it('replaces all /tmp-prefixed args when multiple dirs configured', async () => {
    const mcpManager = McpManager.fromParsedServers({
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp', '/tmp/shared'],
      },
    });
    const multiBuilder = new McpConfigBuilder(mcpManager);
    const config = await multiBuilder.buildConfig({
      channel: 'C001',
      user: 'U094E5L4A15',
    });

    // Both /tmp and /tmp/shared are replaced with the user-scoped path: no root is dropped or widened.
    expect((config.mcpServers?.filesystem as any).args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/tmp/U094E5L4A15',
      '/tmp/U094E5L4A15',
    ]);
  });

  // Trace: Scenario 2, Section 3a → 6 — path is normalized (no /private/tmp)
  // SSOT 2026-11-02 (trinity R1, astra P1) — another user's instruction runs a
  // task turn as them in the owner's task folder: the filesystem server gets
  // their own root and that one task folder, never the owner's whole root.

  it('uses normalized path (not /private/tmp)', async () => {
    const config = await builder.buildConfig({
      channel: 'C001',
      user: 'U094E5L4A15',
    });

    const fsArgs = (config.mcpServers?.filesystem as any).args;
    const lastArg = fsArgs[fsArgs.length - 1];
    expect(lastArg).not.toContain('/private/tmp');
    expect(lastArg).toMatch(/^\/tmp\//);
  });
});
