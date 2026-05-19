/**
 * RED → GREEN Contract Tests — Agent MCP Server
 * Scenarios: S4 (agent_chat), S5 (agent_reply)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock MCP SDK (same pattern as base-mcp-server.test.ts)
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

// Set agent configs via env before import
process.env.SOMA_AGENT_CONFIGS = JSON.stringify({
  jangbi: { promptDir: 'src/prompt/jangbi', persona: 'default', description: 'Code reviewer', model: 'claude-sonnet-4' },
  gwanu: { promptDir: 'src/prompt/gwanu', persona: 'default', description: 'Infra agent' },
});

import { AgentMCPServer } from './agent-mcp-server.js';

// ─── S4: agent_chat MCP Tool ────────────────────────────────────────────────

describe('S4 — agent_chat MCP Tool', () => {
  let server: AgentMCPServer;

  beforeEach(() => {
    server = new AgentMCPServer();
  });

  // Trace: S4, Section 3 — full flow
  it('AgentChat_HappyPath — routes chat to correct agent and returns result', async () => {
    const result = await server.handleTool('chat', {
      agent: 'jangbi',
      prompt: 'Hello from main bot',
    });

    expect(result).toBeDefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessionId).toBeDefined();
    expect(parsed.content).toBeDefined();
    expect(parsed.agentName).toBe('jangbi');
  });

  // Trace: S4, Section 5, Row 1 — unknown agent
  it('AgentChat_UnknownAgent — throws error for non-existent agent', async () => {
    await expect(
      server.handleTool('chat', { agent: 'nonexistent', prompt: 'hello' })
    ).rejects.toThrow(/unknown agent/i);
  });

  // Trace: S4, Section 5, Row 2 — empty prompt
  it('AgentChat_EmptyPrompt — throws error for empty prompt', async () => {
    await expect(
      server.handleTool('chat', { agent: 'jangbi', prompt: '' })
    ).rejects.toThrow(/prompt.*required/i);
  });

  // Trace: S4, Section 4 — session creation (verified via chat-reply)
  it('AgentChat_SessionCreated — stored session is reachable via chat-reply', async () => {
    const result = await server.handleTool('chat', {
      agent: 'jangbi',
      prompt: 'test prompt',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessionId).toBeTruthy();
    expect(typeof parsed.sessionId).toBe('string');

    // Prove session was actually stored by successfully replying to it
    const reply = await server.handleTool('chat-reply', {
      sessionId: parsed.sessionId,
      prompt: 'follow up',
    });
    expect(reply).toBeDefined();
  });

  // Trace: S4, Section 6 — response format contract
  it('AgentChat_ResponseFormat — response matches contract schema', async () => {
    const result = await server.handleTool('chat', {
      agent: 'jangbi',
      prompt: 'test',
    });

    expect(result.content).toBeInstanceOf(Array);
    expect(result.content[0]).toHaveProperty('type', 'text');
    expect(result.content[0]).toHaveProperty('text');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('sessionId');
    expect(parsed).toHaveProperty('content');
    expect(parsed).toHaveProperty('agentName');
    expect(typeof parsed.sessionId).toBe('string');
    expect(typeof parsed.content).toBe('string');
    expect(typeof parsed.agentName).toBe('string');
  });
});

// ─── S5: agent_reply MCP Tool ───────────────────────────────────────────────

describe('S5 — agent_reply MCP Tool', () => {
  let server: AgentMCPServer;

  beforeEach(() => {
    server = new AgentMCPServer();
  });

  // Trace: S5, Section 3 — full reply flow
  it('AgentReply_HappyPath — continues existing agent session', async () => {
    // First, create a session
    const chatResult = await server.handleTool('chat', {
      agent: 'jangbi',
      prompt: 'initial prompt',
    });
    const chatParsed = JSON.parse(chatResult.content[0].text);
    const sessionId = chatParsed.sessionId;

    // Then reply
    const replyResult = await server.handleTool('chat-reply', {
      sessionId,
      prompt: 'follow up',
    });

    expect(replyResult).toBeDefined();
    const replyParsed = JSON.parse(replyResult.content[0].text);
    expect(replyParsed.content).toBeDefined();
    expect(replyParsed.agentName).toBe('jangbi');
  });

  // Trace: S5, Section 5, Row 1 — unknown session
  it('AgentReply_UnknownSession — throws error for non-existent session', async () => {
    await expect(
      server.handleTool('chat-reply', {
        sessionId: 'nonexistent-session-id',
        prompt: 'hello',
      })
    ).rejects.toThrow(/unknown session/i);
  });

  // Trace: S5, Section 3b — session continuity
  it('AgentReply_SessionContinuity — preserves session context across replies', async () => {
    // Create session
    const chat = await server.handleTool('chat', {
      agent: 'jangbi',
      prompt: 'first',
    });
    const sid = JSON.parse(chat.content[0].text).sessionId;

    // Reply MUST preserve the same sessionId
    const reply = await server.handleTool('chat-reply', {
      sessionId: sid,
      prompt: 'second',
    });
    const replySid = JSON.parse(reply.content[0].text).sessionId;

    expect(replySid).toBe(sid);
  });

  // Codex review: empty/whitespace prompt on chat-reply
  it('AgentReply_EmptyPrompt — throws error for empty prompt', async () => {
    const chatResult = await server.handleTool('chat', {
      agent: 'jangbi',
      prompt: 'initial',
    });
    const sid = JSON.parse(chatResult.content[0].text).sessionId;

    await expect(
      server.handleTool('chat-reply', { sessionId: sid, prompt: '   ' })
    ).rejects.toThrow(/prompt.*required/i);
  });
});

// ─── Edge Cases (from codex review) ─────────────────────────────────────────

describe('Agent MCP Server — Edge Cases', () => {
  let server: AgentMCPServer;

  beforeEach(() => {
    server = new AgentMCPServer();
  });

  // Codex review: unknown tool name
  it('UnknownTool — throws for unregistered tool name', async () => {
    await expect(
      server.handleTool('nonexistent', { prompt: 'hello' })
    ).rejects.toThrow(/unknown tool/i);
  });

  // Codex review: whitespace-only prompt on chat
  it('AgentChat_WhitespacePrompt — rejects whitespace-only prompt', async () => {
    await expect(
      server.handleTool('chat', { agent: 'jangbi', prompt: '   \t\n  ' })
    ).rejects.toThrow(/prompt.*required/i);
  });

  // Codex review: default model fallback
  it('AgentChat_DefaultModel — uses default model when agent has no model', async () => {
    const result = await server.handleTool('chat', {
      agent: 'gwanu',
      prompt: 'test default model',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.model).toBe('claude-sonnet-4-20250514');
  });

  // Codex review: multi-session uniqueness
  it('AgentChat_UniqueSessionIds — parallel chats create distinct sessions', async () => {
    const [r1, r2, r3] = await Promise.all([
      server.handleTool('chat', { agent: 'jangbi', prompt: 'a' }),
      server.handleTool('chat', { agent: 'jangbi', prompt: 'b' }),
      server.handleTool('chat', { agent: 'gwanu', prompt: 'c' }),
    ]);
    const ids = [r1, r2, r3].map(r => JSON.parse(r.content[0].text).sessionId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });
});

// ─── Tool Definition Contract ───────────────────────────────────────────────

describe('Agent MCP Server — Tool Definitions', () => {
  it('defineTools — exposes chat and chat-reply tools', () => {
    const server = new AgentMCPServer();
    const tools = server.defineTools();

    expect(tools).toHaveLength(2);

    const chatTool = tools.find(t => t.name === 'chat');
    expect(chatTool).toBeDefined();
    expect(chatTool!.inputSchema).toHaveProperty('properties');
    expect((chatTool!.inputSchema as any).properties).toHaveProperty('agent');
    expect((chatTool!.inputSchema as any).properties).toHaveProperty('prompt');
    expect((chatTool!.inputSchema as any).required).toContain('agent');
    expect((chatTool!.inputSchema as any).required).toContain('prompt');

    const replyTool = tools.find(t => t.name === 'chat-reply');
    expect(replyTool).toBeDefined();
    expect((replyTool!.inputSchema as any).properties).toHaveProperty('sessionId');
    expect((replyTool!.inputSchema as any).properties).toHaveProperty('prompt');
    expect((replyTool!.inputSchema as any).required).toContain('sessionId');
    expect((replyTool!.inputSchema as any).required).toContain('prompt');
  });
});
