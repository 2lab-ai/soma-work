import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loggableOptions } from '../claude-code/loggable-options';

describe('loggableOptions — query options as they may be logged', () => {
  const options = {
    model: 'claude-x',
    cwd: '/work/session',
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'lmk-fixture-secret', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fixture' },
    mcpServers: {
      'slack-mcp': {
        command: 'node',
        args: ['x.js'],
        env: { SLACK_BOT_TOKEN: 'bot-fixture', SLACK_MCP_CONTEXT: '{}' },
      },
      remote: { type: 'http', url: 'https://mcp.example', headers: { Authorization: 'Bearer header-fixture' } },
      inproc: { type: 'sdk', name: 'inproc' },
    },
  };

  it("names the environment variables, the CLI's and each MCP server's, and holds none of their values", () => {
    const logged = loggableOptions(options as never);
    const text = JSON.stringify(logged);
    for (const secret of ['lmk-fixture-secret', 'oauth-fixture', 'bot-fixture', 'header-fixture', '/usr/bin']) {
      expect(text).not.toContain(secret);
    }
    expect(logged.env).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'PATH']);
    const servers = logged.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers['slack-mcp'].env).toEqual(['SLACK_BOT_TOKEN', 'SLACK_MCP_CONTEXT']);
    expect(servers.remote.headers).toEqual(['Authorization']);
    expect(servers.remote.url).toBe('https://mcp.example');
  });

  it('keeps everything else as it was, and does not touch the options it is given', () => {
    const logged = loggableOptions(options as never);
    expect(logged.model).toBe('claude-x');
    expect(logged.cwd).toBe('/work/session');
    expect((logged.mcpServers as Record<string, unknown>).inproc).toEqual({ type: 'sdk', name: 'inproc' });
    expect(options.env.ANTHROPIC_API_KEY).toBe('lmk-fixture-secret');
    expect(options.mcpServers['slack-mcp'].env.SLACK_BOT_TOKEN).toBe('bot-fixture');
  });

  it('is what the turn logs: the handler never logs the options object itself', () => {
    const handler = fs.readFileSync(path.join(__dirname, '..', '..', 'claude-handler.ts'), 'utf8');
    expect(handler).toContain("this.logger.debug('Claude query options', loggableOptions(options))");
    expect(handler).not.toMatch(/['"]Claude query options['"],\s*options\s*\)/);
  });
});
