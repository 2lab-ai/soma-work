import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

interface ServerCase {
  target: 'permission' | 'cron' | 'model-command';
  tool: string;
  env?: Record<string, string>;
}

const wrapper = path.resolve(__dirname, '../fixtures/mcp-server-wrapper.cjs');
const transports: StdioClientTransport[] = [];
const cases: ServerCase[] = [
  {
    target: 'permission',
    tool: 'permission_prompt',
    env: { SLACK_BOT_TOKEN: 'xoxb-process-boundary-test' },
  },
  { target: 'cron', tool: 'cron_list' },
  { target: 'model-command', tool: 'list' },
];

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((transport) => transport.close()));
});

describe('MCP server process entrypoints', () => {
  it.each(cases)('starts $target through a wrapper and lists $tool over real MCP stdio', async ({
    target,
    tool,
    env,
  }) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', wrapper],
      cwd: path.resolve(__dirname, '../../..'),
      env: {
        ...process.env,
        ...env,
        MCP_ENTRYPOINT_TARGET: target,
      } as Record<string, string>,
      stderr: 'pipe',
    });
    transports.push(transport);

    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const client = new Client({ name: `${target}-entrypoint-test`, version: '1.0.0' });
    const timeoutMs = 5_000;

    try {
      await client.connect(transport, { timeout: timeoutMs });
      const result = await client.listTools(undefined, { timeout: timeoutMs });
      expect(result.tools.map((listedTool) => listedTool.name)).toContain(tool);
    } catch (error) {
      throw new Error(`${target} MCP handshake/listTools failed: ${String(error)}\nstderr: ${stderr}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 10_000);
});
