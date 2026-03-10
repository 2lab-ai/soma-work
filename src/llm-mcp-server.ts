#!/usr/bin/env node

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from './mcp-client.js';
import { StderrLogger } from './stderr-logger.js';

const logger = new StderrLogger('LlmMCP');

// ── Config File Reading (mtime-based reload) ─────────────

type Backend = 'codex' | 'gemini';

interface BackendConfig {
  backend: Backend;
  model: string;
  configOverride?: Record<string, unknown>;
}

type LlmChatFileConfig = Record<Backend, BackendConfig>;

const HARDCODED_DEFAULTS: LlmChatFileConfig = {
  codex: {
    backend: 'codex',
    model: 'gpt-5.3-codex',
    configOverride: { model_reasoning_effort: 'xhigh' },
  },
  gemini: {
    backend: 'gemini',
    model: 'gemini-3.1-pro-preview',
  },
};

/** Path to config.json — passed from parent via SOMA_CONFIG_FILE env */
const CONFIG_FILE = process.env.SOMA_CONFIG_FILE || '';

let cachedConfig: LlmChatFileConfig = HARDCODED_DEFAULTS;
let cachedMtimeMs = 0;
let cachedSize = 0;

/**
 * Read llmChat section from config.json with mtime-based caching.
 * Only re-reads the file when its mtime has changed.
 */
function loadConfig(): LlmChatFileConfig {
  if (!CONFIG_FILE) return cachedConfig;

  try {
    const stat = fs.statSync(CONFIG_FILE);
    if (stat.mtimeMs === cachedMtimeMs && stat.size === cachedSize) {
      return cachedConfig; // File unchanged — use cache
    }

    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const llmChat = raw?.llmChat;

    if (llmChat && llmChat.codex?.backend === 'codex' && llmChat.gemini?.backend === 'gemini') {
      cachedConfig = llmChat as LlmChatFileConfig;
      cachedMtimeMs = stat.mtimeMs;
      cachedSize = stat.size;
      logger.info('Reloaded llmChat config from config.json', {
        codexModel: cachedConfig.codex.model,
        geminiModel: cachedConfig.gemini.model,
      });
    }
  } catch {
    // File doesn't exist or is invalid — keep current cache
  }

  return cachedConfig;
}

// Initial load
loadConfig();

// ── Model Routing ──────────────────────────────────────────

interface RouteResult {
  backend: Backend;
  model: string;
  configOverride?: Record<string, unknown>;
}

function routeModel(model: string): RouteResult {
  // Reload config if file changed
  const config = loadConfig();

  // Check alias against current config backends
  if (model === 'codex' || model === 'gemini') {
    const backendConfig = config[model as Backend];
    return {
      backend: backendConfig.backend,
      model: backendConfig.model,
      configOverride: backendConfig.configOverride,
    };
  }

  // Prefix-based routing
  if (model.startsWith('gpt-') || model.startsWith('o')) {
    return { backend: 'codex', model };
  }
  if (model.startsWith('gemini-')) {
    return { backend: 'gemini', model };
  }

  // Default to codex
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

  // Check CLI availability before attempting to start
  if (backend === 'codex' && !cliExists('codex')) {
    throw new Error('Codex CLI not installed. Run: brew install --cask codex');
  }
  if (backend === 'gemini' && !cliExists('gemini')) {
    throw new Error('Gemini CLI not installed. Run: brew install gemini-cli');
  }

  // Clean up old client if exists
  if (clients[backend]) {
    try { await clients[backend]!.stop(); } catch { /* ignore */ }
  }

  const config = backend === 'codex'
    ? { command: 'codex', args: ['mcp-server'] }
    : { command: 'npx', args: ['@2lab.ai/gemini-mcp-server'] };

  const client = new McpClient(config, `LlmMCP:${backend}`);
  await client.start();
  clients[backend] = client;
  logger.info(`Started ${backend} backend`);
  return client;
}

// ── Session Tracking ───────────────────────────────────────

interface Session {
  backend: Backend;
  backendSessionId: string; // threadId (codex) or sessionId (gemini)
}

const sessions = new Map<string, Session>();

function extractBackendSessionId(backend: Backend, parsed: any, rawResult?: any): string {
  const key = backend === 'codex' ? 'threadId' : 'sessionId';

  // 1. Check structuredContent (Codex uses this for threadId)
  if (rawResult?.structuredContent?.[key]) return rawResult.structuredContent[key];

  // 2. Check parsed text content (JSON response body)
  if (parsed[key]) return parsed[key];

  // 3. Check raw MCP result object (top-level field)
  if (rawResult?.[key]) return rawResult[key];

  // 4. Check _meta in MCP result
  if (rawResult?._meta?.[key]) return rawResult._meta[key];

  // 5. Fallback: parse "Session ID: <uuid>" from text content (Gemini embeds it in text)
  const text = rawResult?.content?.find((c: any) => c.type === 'text')?.text || '';
  const match = text.match(/Session ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (match) return match[1];

  return '';
}

function storeSession(backend: Backend, parsed: any, rawResult?: any): string {
  const backendSessionId = extractBackendSessionId(backend, parsed, rawResult);

  if (!backendSessionId) {
    logger.warn(`No session ID found for ${backend}`, {
      parsedKeys: Object.keys(parsed),
      rawResultKeys: rawResult ? Object.keys(rawResult) : [],
    });
    return '';
  }

  sessions.set(backendSessionId, { backend, backendSessionId });
  return backendSessionId;
}

// ── Tool Handlers ──────────────────────────────────────────

async function handleChat(args: Record<string, unknown>) {
  const prompt = args.prompt as string;
  const model = (args.model as string) || 'codex';
  const cwd = args.cwd as string | undefined;
  const config = args.config as Record<string, unknown> | undefined;

  const route = routeModel(model);
  logger.info(`Routing chat to ${route.backend}`, { model, resolvedModel: route.model });

  const client = await getClient(route.backend);

  // Build backend-specific args
  const backendArgs: Record<string, unknown> = { prompt, model: route.model };

  if (route.backend === 'codex') {
    if (cwd) backendArgs.cwd = cwd;
    // Merge config: route override + user config
    const mergedConfig = { ...route.configOverride, ...config };
    if (Object.keys(mergedConfig).length > 0) {
      backendArgs.config = mergedConfig;
    }
  }
  // gemini: only prompt and model are supported

  const toolName = route.backend === 'codex' ? 'codex' : 'gemini';
  const result = await client.callTool(toolName, backendArgs, 600_000);

  // Extract text content and session ID
  const text = (result as any).content?.find((c: any) => c.type === 'text')?.text || '';
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = { content: text }; }

  logger.debug(`${route.backend} raw result keys`, { keys: Object.keys(result as any) });
  const sessionId = storeSession(route.backend, parsed, result);

  // Get response content, preferring structuredContent for codex
  let responseContent = (result as any).structuredContent?.content || parsed.content || text;

  // Strip "Session ID: <uuid>" line from Gemini text responses
  if (typeof responseContent === 'string') {
    responseContent = responseContent.replace(/\n*Session ID:\s*[0-9a-f-]+\s*$/i, '').trimEnd();
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          sessionId,
          content: responseContent,
          backend: route.backend,
          model: route.model,
        }),
      },
    ],
  };
}

async function handleChatReply(args: Record<string, unknown>) {
  const prompt = args.prompt as string;
  const sessionId = args.sessionId as string | undefined;

  // Look up session to find backend
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    throw new Error(
      `Unknown session: ${sessionId}. Use 'chat' first to start a session.`
    );
  }

  const client = await getClient(session.backend);

  const backendArgs: Record<string, unknown> = { prompt };
  if (session.backend === 'codex') {
    backendArgs.threadId = session.backendSessionId;
  } else {
    backendArgs.sessionId = session.backendSessionId;
  }

  const toolName = session.backend === 'codex' ? 'codex-reply' : 'gemini-reply';
  const result = await client.callTool(toolName, backendArgs, 600_000);

  const text = (result as any).content?.find((c: any) => c.type === 'text')?.text || '';
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = { content: text }; }

  // Update session ID if backend returned a new one
  const newBackendSessionId = extractBackendSessionId(session.backend, parsed, result);
  if (newBackendSessionId && newBackendSessionId !== session.backendSessionId) {
    sessions.delete(sessionId!);
    sessions.set(newBackendSessionId, { backend: session.backend, backendSessionId: newBackendSessionId });
  }

  // Get response content, preferring structuredContent for codex
  let responseContent = (result as any).structuredContent?.content || parsed.content || text;

  // Strip "Session ID: <uuid>" line from Gemini text responses
  if (typeof responseContent === 'string') {
    responseContent = responseContent.replace(/\n*Session ID:\s*[0-9a-f-]+\s*$/i, '').trimEnd();
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          sessionId: newBackendSessionId || sessionId,
          content: responseContent,
          backend: session.backend,
        }),
      },
    ],
  };
}

// ── MCP Server ─────────────────────────────────────────────

class LlmMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: 'llm-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'chat',
          description:
            'Start a new LLM chat session. Routes to codex or gemini backend based on model name.',
          inputSchema: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'The prompt to start the session with.',
              },
              model: {
                type: 'string',
                description:
                  'Model name or alias. Use "codex", "gemini" for latest of each model. ',
              },
              config: {
                type: 'object',
                description: 'Optional config overrides',
                additionalProperties: true,
              },
              cwd: {
                type: 'string',
                description: 'Working directory',
              },
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
              prompt: {
                type: 'string',
                description: 'The prompt to continue the conversation.',
              },
              sessionId: {
                type: 'string',
                description: 'The session ID from a previous chat call.',
              },
            },
            required: ['prompt', 'sessionId'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      logger.debug(`Tool call: ${name}`, args);

      try {
        switch (name) {
          case 'chat':
            return await handleChat(args as Record<string, unknown>);
          case 'chat-reply':
            return await handleChatReply(args as Record<string, unknown>);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Tool ${name} failed`, error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('LLM MCP Server started', {
      configFile: CONFIG_FILE || '(not set)',
      codexModel: cachedConfig.codex.model,
      geminiModel: cachedConfig.gemini.model,
    });

    // Cleanup on exit
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }

  private async cleanup() {
    logger.info('Shutting down...');
    for (const [backend, client] of Object.entries(clients)) {
      if (client) {
        try { await client.stop(); } catch { /* ignore */ }
        logger.info(`Stopped ${backend} backend`);
      }
    }
    process.exit(0);
  }
}

const server = new LlmMCPServer();
server.run().catch((error) => {
  logger.error('Failed to start LLM MCP Server', error);
  process.exit(1);
});
