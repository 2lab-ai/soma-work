/**
 * env-access #1241: every stdio MCP server a session starts — soma-work's own and every plugin's — runs from
 * `<DATA_DIR>/mcp-launch`, not from the session's working directory. Plugins are loaded with `skipMcpDiscovery`
 * and their servers declared by soma-work under the CLI's names.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../../env-paths';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { LAUNCH_SCRIPT } from '../../sandbox/mcp-launch-dir';
import type { ConversationSession } from '../../types';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';

let pluginRoot: string;

beforeEach(() => {
  pluginRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-launch-plugin-')));
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'));
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pw' }));
  fs.writeFileSync(
    path.join(pluginRoot, '.mcp.json'),
    JSON.stringify({ mcpServers: { browser: { command: 'npx', args: ['-y', '@pw/mcp'] } } }),
  );
});

afterEach(() => {
  fs.rmSync(pluginRoot, { recursive: true, force: true });
});

function makeDeps(): BuildStreamOptionsDeps {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getEffectivePluginPaths: () => [{ type: 'local', path: pluginRoot }],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: {
      buildConfig: vi.fn(
        async (): Promise<McpConfig> => ({
          permissionMode: 'bypassPermissions',
          userBypass: true,
          somaPermissionMode: 'bypass',
          allowDangerouslySkipPermissions: true,
          mcpServers: {
            filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/U1'] },
            remote: { type: 'http', url: 'https://example.com/mcp' },
          },
          allowedTools: [],
          disallowedTools: [],
          permissionPromptToolName: 'mcp__permission-prompt__permission_prompt',
        }),
      ),
    },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'PROMPT') },
    sessionRegistry: {
      getSessionKey: vi.fn(() => 'chan:thread'),
      isDangerousRuleDisabled: vi.fn(() => false),
      getSession: vi.fn(() => undefined),
    } as unknown as BuildStreamOptionsDeps['sessionRegistry'],
    checkMcpToolPermission: vi.fn(() => null),
  };
}

describe('MCP launch directory (env-access #1241)', () => {
  it('starts every stdio server from <DATA_DIR>/mcp-launch, plugin servers included, and leaves HTTP alone', async () => {
    const { options } = await buildStreamOptions(
      {
        queryEnv: {},
        session: { ownerId: 'U1' } as ConversationSession,
        slackContext: { user: 'U1', channel: 'C1', threadTs: '1.1' } as SlackContext,
      },
      makeDeps(),
    );
    const dir = path.join(DATA_DIR, 'mcp-launch');
    const launched = (name: string) => options.mcpServers?.[name] as { command: string; args: string[] };

    expect(launched('filesystem').command).toBe('/bin/sh');
    expect(launched('filesystem').args).toEqual([
      '-c',
      LAUNCH_SCRIPT,
      'mcp-launch',
      dir,
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/tmp/U1',
    ]);
    expect(launched('plugin_pw_browser').args.slice(3)).toEqual([dir, 'npx', '-y', '@pw/mcp']);
    expect(options.mcpServers?.remote).toEqual({ type: 'http', url: 'https://example.com/mcp' });
    expect(options.plugins).toEqual([{ type: 'local', path: pluginRoot, skipMcpDiscovery: true }]);
  });

  it("fills plugin placeholders from the session's environment, never from the bot's own", async () => {
    fs.writeFileSync(
      path.join(pluginRoot, '.mcp.json'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a plugin config placeholder, not a template
      JSON.stringify({ mcpServers: { leak: { command: 'npx', args: ['${SOMA_TEST_BOT_SECRET}'] } } }),
    );
    process.env.SOMA_TEST_BOT_SECRET = 'bot-only';
    try {
      const deps = makeDeps();
      const { options } = await buildStreamOptions(
        {
          queryEnv: {},
          session: { ownerId: 'U1' } as ConversationSession,
          slackContext: { user: 'U1', channel: 'C1', threadTs: '1.1' } as SlackContext,
        },
        deps,
      );
      expect(options.mcpServers?.plugin_pw_leak).toBeUndefined();
      expect(JSON.stringify(options.mcpServers)).not.toContain('bot-only');
      expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Plugin MCP servers not started'), {
        servers: ['plugin_pw_leak'],
      });
    } finally {
      delete process.env.SOMA_TEST_BOT_SECRET;
    }
  });
});
