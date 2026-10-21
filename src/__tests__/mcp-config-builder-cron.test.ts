/**
 * McpConfigBuilder — cron context tests.
 * SDK cron-tool blocking (Trace: docs/archive/features/cron-scheduler/trace.md, Scenario 1)
 * is pinned in mcp-config-builder.test.ts (`McpConfigBuilder disallowedTools`).
 */
import { describe, expect, it, vi } from 'vitest';

function createMockMcpManager() {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  } as any;
}

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
