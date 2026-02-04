import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpHealthMonitor } from './mcp-health-monitor';

describe('McpHealthMonitor', () => {
  let slackApi: { postSystemMessage: ReturnType<typeof vi.fn> };
  let mcpManager: { reloadConfiguration: ReturnType<typeof vi.fn> };
  let monitor: McpHealthMonitor;

  beforeEach(() => {
    slackApi = { postSystemMessage: vi.fn().mockResolvedValue({}) };
    mcpManager = { reloadConfiguration: vi.fn().mockReturnValue({}) };
    monitor = new McpHealthMonitor(
      slackApi as any,
      mcpManager as any,
      { errorThreshold: 2, errorWindowMs: 1000, alertCooldownMs: 1000 }
    );
  });

  it('alerts and reloads after threshold is reached', async () => {
    await monitor.recordResult({
      toolName: 'mcp__jira__search_issues',
      isError: true,
      channel: 'C1',
      threadTs: 'T1',
    });

    await monitor.recordResult({
      toolName: 'mcp__jira__search_issues',
      isError: true,
      channel: 'C1',
      threadTs: 'T1',
    });

    expect(mcpManager.reloadConfiguration).toHaveBeenCalledTimes(1);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('resets error count on success', async () => {
    await monitor.recordResult({
      toolName: 'mcp__github__list_repos',
      isError: true,
      channel: 'C1',
      threadTs: 'T1',
    });

    await monitor.recordResult({
      toolName: 'mcp__github__list_repos',
      isError: false,
      channel: 'C1',
      threadTs: 'T1',
    });

    await monitor.recordResult({
      toolName: 'mcp__github__list_repos',
      isError: true,
      channel: 'C1',
      threadTs: 'T1',
    });

    expect(mcpManager.reloadConfiguration).not.toHaveBeenCalled();
    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
  });
});
