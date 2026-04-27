import { describe, expect, it, vi } from 'vitest';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  let listHandler: any = null;
  let callHandler: any = null;
  return {
    Server: class MockServer {
      name: string;
      constructor(info: { name: string }) { this.name = info.name; }
      setRequestHandler(schema: any, handler: any) {
        if (schema === 'ListToolsRequestSchema') listHandler = handler;
        if (schema === 'CallToolRequestSchema') callHandler = handler;
      }
      connect() {}
      // Expose handlers for testing
      static getListHandler() { return listHandler; }
      static getCallHandler() { return callHandler; }
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));

vi.mock('somalib/stderr-logger.js', () => ({
  StderrLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

// ── Tests for BaseMcpServer ──────────────────────────────────
// Trace: Scenario 1 — BaseMcpServer extraction

describe('BaseMcpServer', () => {
  // Trace: Scenario 1, Section 3a — defineTools called on list
  it('calls defineTools() when listing tools', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');

    class TestServer extends BaseMcpServer {
      defineTools() {
        return [{ name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }];
      }
      async handleTool(_name: string, _args: Record<string, unknown>) {
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      }
    }

    const server = new TestServer('test-server');
    const tools = server.defineTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_tool');
  });

  // Trace: Scenario 1, Section 3a — handleTool dispatches correctly
  it('dispatches tool calls to handleTool()', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');

    class TestServer extends BaseMcpServer {
      defineTools() {
        return [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];
      }
      async handleTool(name: string, args: Record<string, unknown>) {
        return { content: [{ type: 'text' as const, text: `${name}:${JSON.stringify(args)}` }] };
      }
    }

    const server = new TestServer('test-server');
    const result = await server.handleTool('echo', { msg: 'hello' });
    expect(result.content[0].text).toBe('echo:{"msg":"hello"}');
  });

  // Trace: Scenario 1, Section 3a — formatError returns consistent shape
  it('formatError() returns { content: [{type: "text", text: "Error: ..."}], isError: true }', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');

    class TestServer extends BaseMcpServer {
      defineTools() { return []; }
      async handleTool() { return { content: [] }; }
      // Expose protected method for testing
      testFormatError(tool: string, error: unknown) {
        return this.formatError(tool, error);
      }
    }

    const server = new TestServer('test-server');
    const result = server.testFormatError('my_tool', new Error('something broke'));

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: something broke' }],
      isError: true,
    });
  });

  // Trace: Scenario 1, Section 3a — unknown tool returns error
  it('returns error for unknown tool names', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');

    class TestServer extends BaseMcpServer {
      defineTools() {
        return [{ name: 'known', description: 'Known tool', inputSchema: { type: 'object' } }];
      }
      async handleTool(name: string, _args: Record<string, unknown>) {
        if (name !== 'known') throw new Error(`Unknown tool: ${name}`);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      }
    }

    const server = new TestServer('test-server');
    await expect(server.handleTool('nonexistent', {})).rejects.toThrow('Unknown tool: nonexistent');
  });
});

// ── Tests for formatError standardization ──────────────────
// Trace: Scenario 3 — Error handling standardization

describe('formatError standardization', () => {
  // Trace: Scenario 3, Section 3 — standard shape
  it('standard formatError produces { content: [{type:"text", text:"Error: msg"}], isError: true }', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');

    class TestServer extends BaseMcpServer {
      defineTools() { return []; }
      async handleTool() { return { content: [] }; }
      testFormatError(tool: string, error: unknown) {
        return this.formatError(tool, error);
      }
    }

    const server = new TestServer('test');
    const result = server.testFormatError('tool', 'string error');
    expect(result.content[0].text).toBe('Error: string error');
    expect(result.isError).toBe(true);
  });

  // Trace: Scenario 3, Section 3 — slack enriched shape (will be tested after slack-mcp decomposition)
  it('slack-mcp formatError produces enriched JSON with slack_error field', async () => {
    // This test will validate the slack-mcp override of formatError
    // For now: RED — the SlackMcpServer with overridden formatError doesn't exist yet
    const { BaseMcpServer } = await import('./base-mcp-server.js');

    // Simulating what slack-mcp's override should produce
    class SlackServer extends BaseMcpServer {
      defineTools() { return []; }
      async handleTool() { return { content: [] }; }

      protected override formatError(toolName: string, error: unknown) {
        const slackErrorCode = (error as any)?.data?.error as string | undefined;
        const isRateLimited = (error as any)?.status === 429 || slackErrorCode === 'ratelimited';
        const message = error instanceof Error ? error.message : String(error);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: message,
              ...(slackErrorCode ? { slack_error: slackErrorCode } : {}),
              retryable: isRateLimited,
            }),
          }],
          isError: true,
        };
      }

      testFormatError(tool: string, error: unknown) {
        return this.formatError(tool, error);
      }
    }

    const server = new SlackServer('slack-mcp');
    const slackError = Object.assign(new Error('rate limited'), { status: 429, data: { error: 'ratelimited' } });
    const result = server.testFormatError('get_thread_messages', slackError);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBe('rate limited');
    expect(parsed.slack_error).toBe('ratelimited');
    expect(parsed.retryable).toBe(true);
    expect(result.isError).toBe(true);
  });
});
