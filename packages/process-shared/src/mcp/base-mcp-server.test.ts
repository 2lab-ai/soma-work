import { describe, expect, it, vi } from 'vitest';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  let listHandler: any = null;
  let callHandler: any = null;
  return {
    Server: class MockServer {
      name: string;
      constructor(info: { name: string }) {
        this.name = info.name;
      }
      setRequestHandler(schema: any, handler: any) {
        if (schema === 'ListToolsRequestSchema') listHandler = handler;
        if (schema === 'CallToolRequestSchema') callHandler = handler;
      }
      connect() {}
      // Expose handlers for testing
      static getListHandler() {
        return listHandler;
      }
      static getCallHandler() {
        return callHandler;
      }
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

vi.mock('@soma/process-shared/stderr-logger.js', () => ({
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
  it('answers ListTools with the tools the subclass defines', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');
    const { Server } = (await import('@modelcontextprotocol/sdk/server/index.js')) as any;

    class TestServer extends BaseMcpServer {
      defineTools() {
        return [{ name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }];
      }
      async handleTool(_name: string, _args: Record<string, unknown>) {
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      }
    }

    new TestServer('test-server');
    expect(await Server.getListHandler()()).toEqual({
      tools: [{ name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }],
    });
  });

  // Trace: Scenario 1, Section 3a — handleTool dispatches correctly
  it('answers CallTool with what handleTool returns for that name and arguments', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');
    const { Server } = (await import('@modelcontextprotocol/sdk/server/index.js')) as any;

    class TestServer extends BaseMcpServer {
      defineTools() {
        return [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];
      }
      async handleTool(name: string, args: Record<string, unknown>) {
        return { content: [{ type: 'text' as const, text: `${name}:${JSON.stringify(args)}` }] };
      }
    }

    new TestServer('test-server');
    const result = await Server.getCallHandler()({ params: { name: 'echo', arguments: { msg: 'hello' } } });
    expect(result).toEqual({ content: [{ type: 'text', text: 'echo:{"msg":"hello"}' }] });
  });

  // Trace: Scenario 1, Section 3a — formatError returns consistent shape
  it('formatError() returns { content: [{type: "text", text: "Error: ..."}], isError: true }', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');

    class TestServer extends BaseMcpServer {
      defineTools() {
        return [];
      }
      async handleTool() {
        return { content: [] };
      }
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
  it('turns a tool that throws (an unknown name) into an error result instead of a failed request', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');
    const { Server } = (await import('@modelcontextprotocol/sdk/server/index.js')) as any;

    class TestServer extends BaseMcpServer {
      defineTools() {
        return [{ name: 'known', description: 'Known tool', inputSchema: { type: 'object' } }];
      }
      async handleTool(name: string, _args: Record<string, unknown>) {
        if (name !== 'known') throw new Error(`Unknown tool: ${name}`);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      }
    }

    new TestServer('test-server');
    const result = await Server.getCallHandler()({ params: { name: 'nonexistent', arguments: {} } });
    expect(result).toEqual({ content: [{ type: 'text', text: 'Error: Unknown tool: nonexistent' }], isError: true });
  });
});

// ── Tests for formatError standardization ──────────────────
// Trace: Scenario 3 — Error handling standardization

describe('formatError standardization', () => {
  // Trace: Scenario 3, Section 3 — standard shape
  it('standard formatError produces { content: [{type:"text", text:"Error: msg"}], isError: true }', async () => {
    const { BaseMcpServer } = await import('./base-mcp-server.js');

    class TestServer extends BaseMcpServer {
      defineTools() {
        return [];
      }
      async handleTool() {
        return { content: [] };
      }
      testFormatError(tool: string, error: unknown) {
        return this.formatError(tool, error);
      }
    }

    const server = new TestServer('test');
    const result = server.testFormatError('tool', 'string error');
    expect(result.content[0].text).toBe('Error: string error');
    expect(result.isError).toBe(true);
  });
});
