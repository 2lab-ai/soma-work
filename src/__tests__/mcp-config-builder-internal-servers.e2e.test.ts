import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpManager } from '../mcp-manager';

vi.mock('../env-paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../env-paths')>();
  return {
    ...orig,
    CONFIG_FILE: '/tmp/__nonexistent_packages_srp_e2e_config__.json',
    DATA_DIR: '/tmp/packages-srp-e2e-data',
  };
});

import { McpConfigBuilder } from '../mcp-config-builder';

function createMockMcpManager(): McpManager {
  return {
    getServerConfiguration: vi.fn().mockResolvedValue({}),
    getDefaultAllowedTools: vi.fn().mockReturnValue([]),
  } as unknown as McpManager;
}

function executablePath(server: { args?: string[] }): string {
  const args = server.args ?? [];
  return args[args.length - 1] ?? '';
}

describe('McpConfigBuilder internal MCP servers e2e', () => {
  it('wires the main Slack-context MCP capabilities with stable env and allowed-tool contracts', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    builder.setAgentConfigs({
      reviewer: {
        promptDir: '/tmp/prompts',
        persona: 'reviewer',
        description: 'Review agent',
        model: 'sonnet',
        token: 'must-not-leak',
      },
    });

    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      sourceThreadTs: '1699999999.000000',
      sourceChannel: 'C999',
      user: 'U123',
    });

    expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual([
      'agent',
      'cron',
      'llm',
      'mcp-tool-permission',
      'model-command',
      'permission-prompt',
      'slack-mcp',
    ]);

    expect(config.allowedTools).toEqual(
      expect.arrayContaining([
        'Skill',
        'mcp__agent',
        'mcp__cron',
        'mcp__llm',
        'mcp__mcp-tool-permission',
        'mcp__model-command',
        'mcp__permission-prompt__permission_prompt',
        'mcp__slack-mcp',
        'EnterPlanMode',
        'ExitPlanMode',
      ]),
    );
    expect(config.disallowedTools).toEqual(['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList']);

    const servers = config.mcpServers;
    if (!servers) {
      throw new Error('Expected internal MCP servers to be configured');
    }
    expect(path.basename(executablePath(servers.llm))).toMatch(/^llm-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers.agent))).toMatch(/^agent-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers.cron))).toMatch(/^cron-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers['model-command']))).toMatch(/^model-command-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers['slack-mcp']))).toMatch(/^slack-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers['permission-prompt']))).toMatch(/^permission-mcp-server\.(ts|js)$/);
    expect(path.basename(executablePath(servers['mcp-tool-permission']))).toMatch(
      /^mcp-tool-permission-mcp-server\.(ts|js)$/,
    );

    expect(JSON.parse(servers['model-command'].env.SOMA_COMMAND_CONTEXT)).toEqual({
      channel: 'C123',
      threadTs: '1700000000.000000',
      user: 'U123',
    });
    expect(JSON.parse(servers.cron.env.SOMA_CRON_CONTEXT)).toEqual({
      channel: 'C123',
      threadTs: '1700000000.000000',
      user: 'U123',
    });
    expect(JSON.parse(servers['slack-mcp'].env.SLACK_MCP_CONTEXT)).toEqual({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      sourceThreadTs: '1699999999.000000',
      sourceChannel: 'C999',
    });
    expect(JSON.parse(servers.agent.env.SOMA_AGENT_CONFIGS)).toEqual({
      reviewer: {
        promptDir: '/tmp/prompts',
        persona: 'reviewer',
        description: 'Review agent',
        model: 'sonnet',
      },
    });
    expect(servers.agent.env.SOMA_AGENT_CONFIGS).not.toContain('must-not-leak');
  });
});
