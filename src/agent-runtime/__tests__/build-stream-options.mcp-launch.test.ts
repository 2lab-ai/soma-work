/**
 * env-access #1241: every stdio MCP server a session starts — soma-work's own and every plugin's — runs from
 * `<DATA_DIR>/mcp-launch`, not from the session's working directory. soma-work's servers are wrapped in the
 * options; a cached plugin's are wrapped in its own config, which the CLI still reads and resolves.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_DIR, PLUGINS_DIR } from '../../env-paths';
import type { McpConfig, SlackContext } from '../../mcp-config-builder';
import { LAUNCH_SCRIPT } from '../../sandbox/mcp-launch-dir';
import type { ConversationSession } from '../../types';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';

const launchDir = path.join(DATA_DIR, 'mcp-launch');
let pluginRoot: string;

beforeEach(() => {
  pluginRoot = path.join(PLUGINS_DIR, 'pw');
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pw' }));
  fs.writeFileSync(
    path.join(pluginRoot, '.mcp.json'),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a plugin config placeholder, left for the CLI
    JSON.stringify({ mcpServers: { browser: { command: 'npx', args: ['-y', '@pw/mcp', '${user_config.key}'] } } }),
  );
});

afterEach(() => {
  fs.rmSync(pluginRoot, { recursive: true, force: true });
  if (fs.existsSync(launchDir)) fs.chmodSync(launchDir, 0o755);
});

function makeDeps(plugins = [{ type: 'local' as const, path: pluginRoot }]): BuildStreamOptionsDeps {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getEffectivePluginPaths: () => plugins,
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

const input = {
  queryEnv: {},
  session: { ownerId: 'U1' } as ConversationSession,
  slackContext: { user: 'U1', channel: 'C1', threadTs: '1.1' } as SlackContext,
};

describe('MCP launch directory (env-access #1241)', () => {
  it("starts soma-work's stdio servers from <DATA_DIR>/mcp-launch and leaves HTTP alone", async () => {
    const { options } = await buildStreamOptions(input, makeDeps());
    expect(options.mcpServers?.filesystem).toEqual({
      command: '/bin/sh',
      args: [
        '-c',
        LAUNCH_SCRIPT,
        'mcp-launch',
        launchDir,
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '/tmp/U1',
      ],
    });
    expect(options.mcpServers?.remote).toEqual({ type: 'http', url: 'https://example.com/mcp' });
    expect(fs.statSync(launchDir).mode & 0o777).toBe(0o555);
  });

  it("wraps a cached plugin's server in its own config and leaves the plugin to the CLI", async () => {
    const { options } = await buildStreamOptions(input, makeDeps());
    expect(options.plugins).toEqual([{ type: 'local', path: pluginRoot }]);
    const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
    expect(config.mcpServers.browser).toEqual({
      command: '/bin/sh',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a plugin config placeholder, left for the CLI
      args: ['-c', LAUNCH_SCRIPT, 'mcp-launch', launchDir, 'npx', '-y', '@pw/mcp', '${user_config.key}'],
    });
  });

  it('turns off the MCP servers of a plugin outside the plugin cache, and says so', async () => {
    const outside = fs.mkdtempSync(path.join(path.dirname(DATA_DIR), 'outside-plugin-'));
    fs.writeFileSync(path.join(outside, '.mcp.json'), JSON.stringify({ s: { command: 'npx' } }));
    try {
      const deps = makeDeps([{ type: 'local', path: outside }]);
      const { options } = await buildStreamOptions(input, deps);
      expect(options.plugins).toEqual([{ type: 'local', path: outside, skipMcpDiscovery: true }]);
      expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Plugin MCP servers turned off'), {
        plugins: [`${outside}: it is not in the plugin cache`],
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
