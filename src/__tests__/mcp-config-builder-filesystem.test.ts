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

    if (config.mcpServers?.filesystem) {
      const fsArgs = (config.mcpServers?.filesystem as any)?.args;
      // Without slack context, should retain original '/tmp'
      expect(fsArgs[fsArgs.length - 1]).toBe('/tmp');
    }
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

    const fsArgs = (config.mcpServers?.filesystem as any)?.args;
    // Both /tmp and /tmp/shared should be replaced with user-scoped path
    const tmpArgs = fsArgs.filter((a: string) => a.startsWith('/tmp'));
    for (const arg of tmpArgs) {
      expect(arg).toBe('/tmp/U094E5L4A15');
    }
  });

  // Trace: Scenario 2, Section 3a → 6 — path is normalized (no /private/tmp)
  // SSOT 2026-11-02 (trinity R1, astra P1) — another user's instruction runs a
  // task turn as them in the owner's task folder: the filesystem server gets
  // their own root and that one task folder, never the owner's whole root.
  it('a task turn run by someone else also reaches that task’s folder — and only it', async () => {
    const ctx = {
      origin: 'task',
      userId: 'U0ACTOR001',
      ownerId: 'U0OWNER001',
      isAdmin: false,
      permissionMode: 'auto',
      sessionKey: 'task:t1',
      taskId: 't1',
      workingDirectory: '/tmp/U0OWNER001/session_task_a',
    } as any;
    const config = await builder.buildConfig(undefined, undefined, ctx);
    const fsArgs = (config.mcpServers?.filesystem as any)?.args as string[];
    expect(fsArgs).toContain('/tmp/U0ACTOR001');
    expect(fsArgs).toContain('/tmp/U0OWNER001/session_task_a');
    expect(fsArgs).not.toContain('/tmp/U0OWNER001');
    // The owner's own turn: their root already holds the folder — one root, as before.
    const own = await builder.buildConfig(undefined, undefined, { ...ctx, userId: 'U0OWNER001' });
    expect((own.mcpServers?.filesystem as any)?.args.filter((a: string) => a.startsWith('/tmp'))).toEqual([
      '/tmp/U0OWNER001',
    ]);
  });

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
