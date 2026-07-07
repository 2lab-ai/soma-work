/**
 * McpConfigBuilder — SDK Cron blocking tests
 * Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 1
 */
import { describe, expect, it, vi } from 'vitest';

function createMockMcpManager() {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  } as any;
}

describe('McpConfigBuilder — SDK Cron Tool Blocking', () => {
  // Trace: S1, Section 3a — Happy Path
  it('blocks SDK cron tools when slackContext present', async () => {
    const { McpConfigBuilder } = await import('../mcp-config-builder');
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: 't123',
      user: 'U123',
    });

    expect(config.disallowedTools).toBeDefined();
    expect(config.disallowedTools).toContain('CronCreate');
    expect(config.disallowedTools).toContain('CronDelete');
    expect(config.disallowedTools).toContain('CronList');
    // Also still blocks AskUserQuestion
    expect(config.disallowedTools).toContain('AskUserQuestion');
  });

  // Trace: S1, Section 5 — Sad Path
  it('does not set disallowedTools without slackContext', async () => {
    const { McpConfigBuilder } = await import('../mcp-config-builder');
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig();

    expect(config.disallowedTools).toBeUndefined();
  });
});

// --- SOMA_CRON_CONTEXT isAdmin injection — cron manage UI admin scoping ---
describe('McpConfigBuilder — cron context isAdmin', () => {
  it('injects isAdmin=true for ADMIN_USERS member, false otherwise', async () => {
    const { McpConfigBuilder } = await import('../mcp-config-builder');
    const { resetAdminUsersCache } = await import('../admin-utils');
    const prev = process.env.ADMIN_USERS;
    try {
      process.env.ADMIN_USERS = 'U_ADMIN1,U_ADMIN2';
      resetAdminUsersCache();

      const builder = new McpConfigBuilder(createMockMcpManager());
      const adminConfig = await builder.buildConfig({ channel: 'C123', threadTs: 't1', user: 'U_ADMIN1' });
      const adminCtx = JSON.parse(adminConfig.mcpServers!.cron.env.SOMA_CRON_CONTEXT);
      expect(adminCtx.isAdmin).toBe(true);
      expect(adminCtx.user).toBe('U_ADMIN1');

      const userConfig = await builder.buildConfig({ channel: 'C123', threadTs: 't1', user: 'U_PLAIN' });
      const userCtx = JSON.parse(userConfig.mcpServers!.cron.env.SOMA_CRON_CONTEXT);
      expect(userCtx.isAdmin).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_USERS;
      else process.env.ADMIN_USERS = prev;
      resetAdminUsersCache();
    }
  });
});
