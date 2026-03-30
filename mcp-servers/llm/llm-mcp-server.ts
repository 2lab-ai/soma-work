#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import { ConfigCache } from '../_shared/config-cache.js';
import { McpClient } from '../_shared/mcp-client.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';

// ── Config ─────────────────────────────────────────────────

type Backend = 'codex' | 'gemini';

interface BackendConfig {
  backend: Backend;
  model: string;
  configOverride?: Record<string, string>;
}

type LlmChatFileConfig = Record<Backend, BackendConfig>;

const HARDCODED_DEFAULTS: LlmChatFileConfig = {
  codex: {
    backend: 'codex',
    model: 'gpt-5.4',
    configOverride: { model_reasoning_effort: 'xhigh', 'features.fast_mode': 'true', service_tier: 'fast' },
  },
  gemini: {
    backend: 'gemini',
    model: 'gemini-3.1-pro-preview',
  },
};

const configCache = new ConfigCache<LlmChatFileConfig>(HARDCODED_DEFAULTS, {
  section: 'llmChat',
  loader: (raw: any) => {
    if (
      raw &&
      raw.codex?.backend === 'codex' && typeof raw.codex?.model === 'string' &&
      raw.gemini?.backend === 'gemini' && typeof raw.gemini?.model === 'string'
    ) {
      return raw as LlmChatFileConfig;
    }
    return null;
  },
});

// ── Model Routing ──────────────────────────────────────────

function routeModel(model: string): BackendConfig {
  const config = configCache.get();

  if (model === 'codex' || model === 'gemini') {
    return config[model];
  }

  if (model.startsWith('gpt-') || model.startsWith('o')) {
    return { backend: 'codex', model };
  }
  if (model.startsWith('gemini-')) {
    return { backend: 'gemini', model };
  }

  return { backend: 'codex', model };
}

// ── Backend Client Management ──────────────────────────────

const clients: Record<Backend, McpClient | null> = {
  codex: null,
  gemini: null,
};

function cliExists(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function getClient(backend: Backend): Promise<McpClient> {
  if (clients[backend]?.isReady()) {
    return clients[backend]!;
  }

  if (backend === 'codex' && !cliExists('codex')) {
    throw new Error('Codex CLI not installed. Run: brew install --cask codex');
  }
  if (backend === 'gemini' && !cliExists('gemini')) {
    throw new Error('Gemini CLI not installed. Run: brew install gemini-cli');
  }

  if (clients[backend]) {
    try { await clients[backend]!.stop(); } catch { /* ignore */ }
  }

  const config = backend === 'codex'
    ? { command: 'codex', args: ['mcp-server'] }
    : { command: 'npx', args: ['@2lab.ai/gemini-mcp-server'] };

  const client = new McpClient(config, `LlmMCP:${backend}`);
  await client.start();
  clients[backend] = client;
  return client;
}

// ── Session Tracking ───────────────────────────────────────

interface Session {
  backend: Backend;
  backendSessionId: string;
}

const sessions = new Map<string, Session>();

function extractBackendSessionId(backend: Backend, parsed: any, rawResult?: any): string {
  const key = backend === 'codex' ? 'threadId' : 'sessionId';

  if (rawResult?.structuredContent?.[key]) return rawResult.structuredContent[key];
  if (parsed[key]) return parsed[key];
  if (rawResult?.[key]) return rawResult[key];
  if (rawResult?._meta?.[key]) return rawResult._meta[key];

  const text = rawResult?.content?.find((c: any) => c.type === 'text')?.text || '';
  const match = text.match(/Session ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (match) return match[1];

  return '';
}

function storeSession(backend: Backend, parsed: any, rawResult?: any): string {
  const backendSessionId = extractBackendSessionId(backend, parsed, rawResult);
  if (!backendSessionId) return '';
  sessions.set(backendSessionId, { backend, backendSessionId });
  return backendSessionId;
}

// ── Server ─────────────────────────────────────────────────

class LlmMCPServer extends BaseMcpServer {
  constructor() {
    super('llm-mcp-server');
  }

  defineTools(): ToolDefinition[] {
    return [
      {
        name: 'chat',
        description: 'Start a new LLM chat session. Routes to codex or gemini backend based on model name.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The prompt to start the session with.' },
            model: { type: 'string', description: 'Model name or alias. Use "codex", "gemini" for latest of each model. ' },
            config: { type: 'object', description: 'Optional config overrides', additionalProperties: true },
            cwd: { type: 'string', description: 'Working directory' },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'chat-reply',
        description: 'Continue an existing LLM chat session.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The prompt to continue the conversation.' },
            sessionId: { type: 'string', description: 'The session ID from a previous chat call.' },
          },
          required: ['prompt', 'sessionId'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'chat':
        return await this.handleChat(args);
      case 'chat-reply':
        return await this.handleChatReply(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  protected override async shutdown(): Promise<void> {
    this.logger.info('Shutting down...');
    for (const [backend, client] of Object.entries(clients)) {
      if (client) {
        try { await client.stop(); } catch { /* ignore */ }
        this.logger.info(`Stopped ${backend} backend`);
      }
    }
    process.exit(0);
  }

  private async handleChat(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = args.prompt as string;
    const model = (args.model as string) || 'codex';
    const cwd = args.cwd as string | undefined;
    const config = args.config as Record<string, unknown> | undefined;

    const route = routeModel(model);
    this.logger.info(`Routing chat to ${route.backend}`, { model, resolvedModel: route.model });

    const client = await getClient(route.backend);
    const backendArgs: Record<string, unknown> = { prompt, model: route.model };

    if (route.backend === 'codex') {
      if (cwd) backendArgs.cwd = cwd;
      const mergedConfig = { ...route.configOverride, ...config };
      if (Object.keys(mergedConfig).length > 0) {
        backendArgs.config = mergedConfig;
      }
    }

    // codex MCP exposes 'codex' tool, gemini MCP exposes 'chat' tool
    const toolName = route.backend === 'codex' ? 'codex' : 'chat';
    const result = await client.callTool(toolName, backendArgs, 600_000);

    const text = (result as any).content?.find((c: any) => c.type === 'text')?.text || '';
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { parsed = { content: text }; }

    const sessionId = storeSession(route.backend, parsed, result);

    let responseContent = (result as any).structuredContent?.content || parsed.content || text;
    if (typeof responseContent === 'string') {
      responseContent = responseContent.replace(/\n*Session ID:\s*[0-9a-f-]+\s*$/i, '').trimEnd();
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ sessionId, content: responseContent, backend: route.backend, model: route.model }),
      }],
    };
  }

  private async handleChatReply(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = args.prompt as string;
    const sessionId = args.sessionId as string | undefined;

    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}. Use 'chat' first to start a session.`);
    }

    const client = await getClient(session.backend);
    const backendArgs: Record<string, unknown> = { prompt };
    if (session.backend === 'codex') {
      backendArgs.threadId = session.backendSessionId;
    } else {
      backendArgs.sessionId = session.backendSessionId;
    }

    // codex MCP exposes 'codex-reply' tool, gemini MCP exposes 'chat-reply' tool
    const toolName = session.backend === 'codex' ? 'codex-reply' : 'chat-reply';
    const result = await client.callTool(toolName, backendArgs, 600_000);

    const text = (result as any).content?.find((c: any) => c.type === 'text')?.text || '';
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { parsed = { content: text }; }

    const newBackendSessionId = extractBackendSessionId(session.backend, parsed, result);
    if (newBackendSessionId && newBackendSessionId !== session.backendSessionId) {
      sessions.delete(sessionId!);
      sessions.set(newBackendSessionId, { backend: session.backend, backendSessionId: newBackendSessionId });
    }

    let responseContent = (result as any).structuredContent?.content || parsed.content || text;
    if (typeof responseContent === 'string') {
      responseContent = responseContent.replace(/\n*Session ID:\s*[0-9a-f-]+\s*$/i, '').trimEnd();
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ sessionId: newBackendSessionId || sessionId, content: responseContent, backend: session.backend }),
      }],
    };
  }
}

// ── Main ───────────────────────────────────────────────────

const server = new LlmMCPServer();
server.run().catch((error) => {
  console.error('Failed to start LLM MCP Server', error);
  process.exit(1);
});
