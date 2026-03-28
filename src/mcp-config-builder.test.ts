import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  McpConfigBuilder,
  McpConfig,
  resolveInternalMcpServer,
  resolveModelCommandServerPath,
  resolvePermissionServerPath,
  isMidThreadMention,
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

    expect(config.disallowedTools).toEqual(['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList']);
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

describe('McpConfigBuilder slack-mcp server', () => {
  function createMockMcpManager() {
    return {
      getServerConfiguration: vi.fn().mockResolvedValue({}),
      getDefaultAllowedTools: vi.fn().mockReturnValue([]),
    } as any;
  }

  it('registers slack-mcp server when mentionTs differs from threadTs (mid-thread)', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      user: 'U123',
    });

    expect(config.mcpServers?.['slack-mcp']).toBeDefined();
    expect(config.allowedTools).toContain('mcp__slack-mcp');

    // Verify SLACK_MCP_CONTEXT env is set with correct structure
    const contextStr = config.mcpServers?.['slack-mcp']?.env?.SLACK_MCP_CONTEXT;
    const ctx = JSON.parse(contextStr || '{}');
    expect(ctx.channel).toBe('C123');
    expect(ctx.threadTs).toBe('1700000000.000000');
    expect(ctx.mentionTs).toBe('1700000010.000000');
  });

  it('uses sourceThreadTs/sourceChannel in SLACK_MCP_CONTEXT when bot migrates to new thread', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    // After bot-initiated thread migration:
    // - threadTs = NEW thread ts (where bot posts replies)
    // - sourceThreadTs = ORIGINAL thread ts (where mention occurred)
    const config = await builder.buildConfig({
      channel: 'C_NEW',
      threadTs: '1700000099.000000',   // NEW thread (empty)
      mentionTs: '1700000010.000000',  // original mention
      sourceThreadTs: '1700000000.000000',  // ORIGINAL thread (has messages)
      sourceChannel: 'C_ORIGINAL',
      user: 'U123',
    });

    expect(config.mcpServers?.['slack-mcp']).toBeDefined();

    const contextStr = config.mcpServers?.['slack-mcp']?.env?.SLACK_MCP_CONTEXT;
    const ctx = JSON.parse(contextStr || '{}');
    // Should use ORIGINAL thread, not NEW thread
    expect(ctx.channel).toBe('C_ORIGINAL');
    expect(ctx.threadTs).toBe('1700000000.000000');
    expect(ctx.mentionTs).toBe('1700000010.000000');
  });

  it('does NOT register slack-mcp server when mentionTs === threadTs (thread root)', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000000.000000',
      user: 'U123',
    });

    expect(config.mcpServers?.['slack-mcp']).toBeUndefined();
    expect(config.allowedTools).not.toContain('mcp__slack-mcp');
  });

  it('does NOT register slack-mcp server when mentionTs is absent', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      user: 'U123',
    });

    expect(config.mcpServers?.['slack-mcp']).toBeUndefined();
  });

  it('sets SLACK_BOT_TOKEN in slack-mcp server env (empty string fallback)', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({
      channel: 'C123',
      threadTs: '1700000000.000000',
      mentionTs: '1700000010.000000',
      user: 'U123',
    });

    const env = config.mcpServers?.['slack-mcp']?.env;
    expect(env).toHaveProperty('SLACK_BOT_TOKEN');
    // Should be empty string fallback when env var is not set, not undefined
    expect(typeof env?.SLACK_BOT_TOKEN).toBe('string');
  });
});

describe('McpConfigBuilder server-tools wiring', () => {
  // CONFIG_FILE is resolved at module load from env-paths.
  // hasServerToolsConfig() reads that file with fs.readFileSync.
  // We test by writing actual temp config files and overriding CONFIG_FILE via vi.mock.

  // Since CONFIG_FILE is a constant from env-paths, and hasServerToolsConfig catches errors,
  // we verify the conditional wiring indirectly: when hasServerToolsConfig returns false
  // (default — CONFIG_FILE points to non-existent or empty file), server-tools should not appear.

  function createMockMcpManager() {
    return {
      getServerConfiguration: vi.fn().mockResolvedValue({}),
      getDefaultAllowedTools: vi.fn().mockReturnValue([]),
    } as any;
  }

  it('does NOT include mcp__server-tools when config file has no server-tools section', async () => {
    // Default CONFIG_FILE either doesn't exist or has no server-tools section
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U1' });

    expect(config.mcpServers?.['server-tools']).toBeUndefined();
    expect(config.allowedTools).not.toContain('mcp__server-tools');
  });

  it('always includes Skill, EnterPlanMode, ExitPlanMode in allowedTools', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U1' });

    expect(config.allowedTools).toContain('Skill');
    expect(config.allowedTools).toContain('EnterPlanMode');
    expect(config.allowedTools).toContain('ExitPlanMode');
  });

  it('always includes mcp__llm in allowedTools', async () => {
    const builder = new McpConfigBuilder(createMockMcpManager());
    const config = await builder.buildConfig({ channel: 'C1', user: 'U1' });

    expect(config.allowedTools).toContain('mcp__llm');
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
