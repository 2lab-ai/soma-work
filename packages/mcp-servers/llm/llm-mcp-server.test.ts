/**
 * Unit tests — llm-mcp-server routeModel (routing is a pure function).
 * Handler tests live in llm-mcp-server-handler.test.ts with mocked deps.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class MockServer {
    constructor() {}
    setRequestHandler() {}
    connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));

// Prevent child_process / network imports from side effects at module load.
vi.mock('./runtime/codex-runtime.js', () => ({
  CodexRuntime: class {
    name = 'codex';
    capabilities = {
      supportsReview: false,
      supportsInterrupt: false,
      supportsResume: true,
      supportsEventStream: false,
    };
    ensureReady = vi.fn();
    startSession = vi.fn();
    resumeSession = vi.fn();
    shutdown = vi.fn();
  },
}));
describe('routeModel', () => {
  it('routes "codex" alias to codex backend with default model', async () => {
    const { routeModel } = await import('./llm-mcp-server.js');
    const route = routeModel('codex');
    expect(route.backend).toBe('codex');
    expect(route.model).toBe('gpt-5.5');
  });

  it('falls legacy "gemini" alias back to codex (gemini backend removed)', async () => {
    const { routeModel } = await import('./llm-mcp-server.js');
    const route = routeModel('gemini');
    expect(route.backend).toBe('codex');
    expect(route.unknownAlias).toBe(true);
  });

  it('routes gpt-* models to codex', async () => {
    const { routeModel } = await import('./llm-mcp-server.js');
    const route = routeModel('gpt-5.4');
    expect(route.backend).toBe('codex');
    expect(route.model).toBe('gpt-5.4');
  });

  it('falls legacy gemini-* models back to codex (gemini backend removed)', async () => {
    const { routeModel } = await import('./llm-mcp-server.js');
    const route = routeModel('gemini-3.1-pro');
    expect(route.backend).toBe('codex');
    expect(route.unknownAlias).toBe(true);
  });

  it('routes o-series models to codex', async () => {
    const { routeModel } = await import('./llm-mcp-server.js');
    const route = routeModel('o3-pro');
    expect(route.backend).toBe('codex');
    expect(route.model).toBe('o3-pro');
  });

  it('defaults unknown models to codex', async () => {
    const { routeModel } = await import('./llm-mcp-server.js');
    const route = routeModel('some-unknown-model');
    expect(route.backend).toBe('codex');
  });
});
