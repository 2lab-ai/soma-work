import { execFileSync } from 'child_process';
import { McpClient } from '../../_shared/mcp-client.js';
import type { McpClientConfig } from '../../_shared/mcp-client.js';
import type { LlmRuntime, RuntimeCapabilities, SessionOptions, SessionResult } from './types.js';

// ── Session ID Extraction ─────────────────────────────────

function extractSessionId(parsed: any, rawResult?: any): string {
  const key = 'sessionId';

  if (rawResult?.structuredContent?.[key]) return rawResult.structuredContent[key];
  if (parsed[key]) return parsed[key];
  if (rawResult?.[key]) return rawResult[key];
  if (rawResult?._meta?.[key]) return rawResult._meta[key];

  const text = rawResult?.content?.find((c: any) => c.type === 'text')?.text || '';
  const match = text.match(/Session ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (match) return match[1];

  return '';
}

// ── Response Parsing ──────────────────────────────────────

function parseResponse(result: any): { parsed: any; text: string } {
  const text = result?.content?.find((c: any) => c.type === 'text')?.text || '';
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = { content: text }; }
  return { parsed, text };
}

function extractContent(result: any, parsed: any, text: string): string {
  let content = result?.structuredContent?.content || parsed.content || text;
  if (typeof content === 'string') {
    content = content.replace(/\n*Session ID:\s*[0-9a-f-]+\s*$/i, '').trimEnd();
  }
  return content;
}

// ── GeminiRuntime ─────────────────────────────────────────

const GEMINI_TIMEOUT = 600_000;

export class GeminiRuntime implements LlmRuntime {
  readonly name = 'gemini' as const;
  readonly capabilities: RuntimeCapabilities = {
    supportsReview: false,
    supportsInterrupt: false,
    supportsResume: true,
    supportsEventStream: false,
  };

  private client: McpClient | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly clientConfig: McpClientConfig;

  constructor(clientConfig?: McpClientConfig) {
    this.clientConfig = clientConfig ?? { command: 'npx', args: ['@2lab.ai/gemini-mcp-server'] };
  }

  async ensureReady(): Promise<void> {
    if (this.client?.isReady()) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doInitialize().finally(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  async startSession(prompt: string, options: SessionOptions): Promise<SessionResult> {
    await this.ensureReady();

    const backendArgs: Record<string, unknown> = { prompt, model: options.model };
    const result = await this.client!.callTool('chat', backendArgs, GEMINI_TIMEOUT);
    const { parsed, text } = parseResponse(result);
    const backendSessionId = extractSessionId(parsed, result);
    const content = extractContent(result, parsed, text);

    return { backendSessionId, content, backend: 'gemini', model: options.model };
  }

  async resumeSession(backendSessionId: string, prompt: string): Promise<SessionResult> {
    await this.ensureReady();

    const backendArgs: Record<string, unknown> = { prompt, sessionId: backendSessionId };
    const result = await this.client!.callTool('chat-reply', backendArgs, GEMINI_TIMEOUT);
    const { parsed, text } = parseResponse(result);
    const newSessionId = extractSessionId(parsed, result) || backendSessionId;
    const content = extractContent(result, parsed, text);

    return { backendSessionId: newSessionId, content, backend: 'gemini', model: '' };
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      try { await this.client.stop(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  // ── Private ─────────────────────────────────────────────

  private async doInitialize(): Promise<void> {
    if (!this.cliExists('gemini')) {
      throw new Error('Gemini CLI not installed. Run: brew install gemini-cli');
    }

    if (this.client) {
      try { await this.client.stop(); } catch { /* ignore */ }
    }

    this.client = new McpClient(this.clientConfig, 'LlmMCP:gemini');
    await this.client.start();
  }

  private cliExists(command: string): boolean {
    try {
      execFileSync('which', [command], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}
