/**
 * Integration Tests — LlmMCPServer (Router)
 * Issue #332: Backend Runtime Adapter Layer
 */
import { describe, expect, it, vi } from 'vitest';

// Mock MCP SDK
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

// ── routeModel Tests ──────────────────────────────────────

describe('routeModel', () => {
  // Dynamic import to avoid side effects from module-level code
  let routeModel: (model: string) => { backend: string; model: string; configOverride?: Record<string, string> };

  // We need to mock the runtime imports to avoid child_process issues
  vi.mock('./runtime/codex-runtime.js', () => ({
    CodexRuntime: class MockCodexRuntime {
      name = 'codex';
      capabilities = { supportsReview: false, supportsInterrupt: false, supportsResume: true, supportsEventStream: false };
      ensureReady = vi.fn();
      startSession = vi.fn();
      resumeSession = vi.fn();
      shutdown = vi.fn();
    },
  }));
  vi.mock('./runtime/gemini-runtime.js', () => ({
    GeminiRuntime: class MockGeminiRuntime {
      name = 'gemini';
      capabilities = { supportsReview: false, supportsInterrupt: false, supportsResume: true, supportsEventStream: false };
      ensureReady = vi.fn();
      startSession = vi.fn();
      resumeSession = vi.fn();
      shutdown = vi.fn();
    },
  }));

  it('routes "codex" alias to codex backend with defaults', async () => {
    const mod = await import('./llm-mcp-server.js');
    routeModel = mod.routeModel;

    const route = routeModel('codex');
    expect(route.backend).toBe('codex');
    expect(route.model).toBe('gpt-5.4');
    expect(route.configOverride).toBeDefined();
  });

  it('routes "gemini" alias to gemini backend with defaults', async () => {
    const mod = await import('./llm-mcp-server.js');
    routeModel = mod.routeModel;

    const route = routeModel('gemini');
    expect(route.backend).toBe('gemini');
    expect(route.model).toBe('gemini-3.1-pro-preview');
  });

  it('routes gpt-* models to codex', async () => {
    const mod = await import('./llm-mcp-server.js');
    routeModel = mod.routeModel;

    const route = routeModel('gpt-5.4');
    expect(route.backend).toBe('codex');
    expect(route.model).toBe('gpt-5.4');
  });

  it('routes gemini-* models to gemini', async () => {
    const mod = await import('./llm-mcp-server.js');
    routeModel = mod.routeModel;

    const route = routeModel('gemini-3.1-pro');
    expect(route.backend).toBe('gemini');
    expect(route.model).toBe('gemini-3.1-pro');
  });

  it('routes o-series models to codex', async () => {
    const mod = await import('./llm-mcp-server.js');
    routeModel = mod.routeModel;

    const route = routeModel('o3-pro');
    expect(route.backend).toBe('codex');
    expect(route.model).toBe('o3-pro');
  });

  it('defaults unknown models to codex', async () => {
    const mod = await import('./llm-mcp-server.js');
    routeModel = mod.routeModel;

    const route = routeModel('some-unknown-model');
    expect(route.backend).toBe('codex');
  });
});
