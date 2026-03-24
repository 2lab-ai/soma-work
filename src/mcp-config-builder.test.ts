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
      disallowedTools: ['AskUserQuestion'],
    };
    expect(config.disallowedTools).toEqual(['AskUserQuestion']);
  });

  it('populates disallowedTools with AskUserQuestion when slackContext is provided', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C123', user: 'U123' });

    expect(config.disallowedTools).toEqual(['AskUserQuestion']);
  });

  it('adds EnterPlanMode and ExitPlanMode to allowedTools', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C123', user: 'U123' });

    expect(config.allowedTools).toContain('EnterPlanMode');
    expect(config.allowedTools).toContain('ExitPlanMode');
  });

  it('does not set disallowedTools without slackContext', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig();

    expect(config.disallowedTools).toBeUndefined();
  });
});

describe('McpConfigBuilder slack-thread server', () => {
  function createMockMcpManager() {
    return {
      getServerConfiguration: vi.fn().mockResolvedValue({}),
      getDefaultAllowedTools: vi.fn().mockReturnValue([]),
    } as any;
  }

  it('registers slack-thread server when mentionTs differs from threadTs (mid-thread)', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      user: 'U123',
    });

    expect(config.mcpServers?.['slack-thread']).toBeDefined();
    expect(config.allowedTools).toContain('mcp__slack-thread');

    // Verify SLACK_THREAD_CONTEXT env is set with correct structure
    const contextStr = config.mcpServers?.['slack-thread']?.env?.SLACK_THREAD_CONTEXT;
    const ctx = JSON.parse(contextStr || '{}');
    expect(ctx.channel).toBe('C123');
    expect(ctx.threadTs).toBe('1700000000.000000');
    expect(ctx.mentionTs).toBe('1700000010.000000');
  });

  it('does NOT register slack-thread server when mentionTs === threadTs (thread root)', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000000.000000',
      user: 'U123',
    });

    expect(config.mcpServers?.['slack-thread']).toBeUndefined();
    expect(config.allowedTools).not.toContain('mcp__slack-thread');
  });

  it('does NOT register slack-thread server when mentionTs is absent', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      user: 'U123',
    });

    expect(config.mcpServers?.['slack-thread']).toBeUndefined();
  });

  it('sets SLACK_BOT_TOKEN in slack-thread server env (empty string fallback)', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      user: 'U123',
    });

    const env = config.mcpServers?.['slack-thread']?.env;
    expect(env).toHaveProperty('SLACK_BOT_TOKEN');
    // Should be empty string fallback when env var is not set, not undefined
    expect(typeof env?.SLACK_BOT_TOKEN).toBe('string');
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
