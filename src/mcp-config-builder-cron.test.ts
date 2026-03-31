/**
 * McpConfigBuilder — SDK Cron blocking tests
 * Trace: docs/cron-scheduler/trace.md, Scenario 1
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
    const { McpConfigBuilder } = await import('./mcp-config-builder');
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
    const { McpConfigBuilder } = await import('./mcp-config-builder');
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig();

    expect(config.disallowedTools).toBeUndefined();
  });
});
