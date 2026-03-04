import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import {
  McpConfigBuilder,
  McpConfig,
  resolveInternalMcpServer,
  resolveModelCommandServerPath,
  resolvePermissionServerPath,
} from './mcp-config-builder';

describe('MCP server path resolver', () => {
  it('prefers runtime extension when present', () => {
    const baseDir = '/app/dist';
    const preferred = path.join(baseDir, 'permission-mcp-server.js');
    const fallback = path.join(baseDir, 'permission-mcp-server.ts');
    const existsSync = vi.fn((candidate: string) => candidate === preferred);

    const result = resolvePermissionServerPath(baseDir, '.js', existsSync);

    expect(result.resolvedPath).toBe(preferred);
    expect(result.fallbackUsed).toBe(false);
    expect(result.triedPaths).toEqual([preferred, fallback]);
  });

  it('falls back when runtime extension is missing', () => {
    const baseDir = '/app/src';
    const preferred = path.join(baseDir, 'model-command-mcp-server.js');
    const fallback = path.join(baseDir, 'model-command-mcp-server.ts');
    const existsSync = vi.fn((candidate: string) => candidate === fallback);

    const result = resolveModelCommandServerPath(baseDir, '.js', existsSync);

    expect(result.resolvedPath).toBe(fallback);
    expect(result.fallbackUsed).toBe(true);
    expect(result.triedPaths).toEqual([preferred, fallback]);
  });

  it('supports generic resolver utility', () => {
    const baseDir = '/tmp/internal';
    const preferred = path.join(baseDir, 'internal-server.ts');
    const fallback = path.join(baseDir, 'internal-server.js');
    const existsSync = vi.fn((candidate: string) => candidate === preferred);

    const result = resolveInternalMcpServer(baseDir, 'internal-server', '.ts', existsSync);

    expect(result.resolvedPath).toBe(preferred);
    expect(result.fallbackUsed).toBe(false);
    expect(result.triedPaths).toEqual([preferred, fallback]);
  });
});

describe('McpConfigBuilder disallowedTools', () => {
  function createMockMcpManager() {
    return {
      getServerConfiguration: vi.fn().mockResolvedValue({}),
      getDefaultAllowedTools: vi.fn().mockReturnValue([]),
    } as any;
  }

  it('McpConfig type includes disallowedTools field', () => {
    const config: McpConfig = {
      permissionMode: 'default',
      userBypass: false,
      disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
    };
    expect(config.disallowedTools).toEqual(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
  });

  it('populates disallowedTools when slackContext is provided', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C123', user: 'U123' });

    expect(config.disallowedTools).toBeDefined();
    expect(config.disallowedTools).toContain('AskUserQuestion');
    expect(config.disallowedTools).toContain('EnterPlanMode');
    expect(config.disallowedTools).toContain('ExitPlanMode');
  });

  it('does not set disallowedTools without slackContext', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig();

    expect(config.disallowedTools).toBeUndefined();
  });
});

describe('McpConfigBuilder', () => {
  it('injects model-command server and allowed tool when Slack context is provided', async () => {
    const mcpManager = {
      getServerConfiguration: vi.fn().mockResolvedValue({
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      }),
      getDefaultAllowedTools: vi.fn().mockReturnValue(['mcp__filesystem']),
    } as any;

    const builder = new McpConfigBuilder(mcpManager);
    const config = await builder.buildConfig(
      {
        channel: 'C123',
        threadTs: '171.001',
        user: 'U_model_command_test_user',
      },
      {
        channel: 'C123',
        threadTs: '171.001',
        user: 'U_model_command_test_user',
        session: {
          issues: [],
          prs: [],
          docs: [],
          active: {},
          sequence: 7,
        },
      }
    );

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers?.['model-command']).toBeDefined();
    expect(config.allowedTools).toContain('mcp__model-command');

    const rawContext = config.mcpServers?.['model-command']?.env?.SOMA_COMMAND_CONTEXT;
    const parsedContext = JSON.parse(rawContext || '{}');
    expect(parsedContext.channel).toBe('C123');
    expect(parsedContext.session?.sequence).toBe(7);
  });
});
