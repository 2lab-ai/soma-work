/**
 * GeminiRuntime — LlmRuntime adapter for the Gemini MCP server.
 *
 * Same architecture as CodexRuntime: shared long-lived McpClient child,
 * watchdog-controlled kill on timeout/abort.
 */

import { execFileSync } from 'child_process';
import { McpClient } from '../../_shared/mcp-client.js';
import type { McpClientConfig } from '../../_shared/mcp-client.js';
import type {
  LlmRuntime,
  RuntimeCallOptions,
  StartSessionResult,
  ResumeSessionResult,
} from './types.js';
import { runWithWatchdog } from './watchdog.js';
import { ErrorCode, LlmChatError } from './errors.js';

// ── Session ID / response helpers ─────────────────────────

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

// ── Runtime ───────────────────────────────────────────────

const GEMINI_DEFAULT_TIMEOUT = 600_000;

export interface GeminiRuntimeOptions {
  clientConfig?: McpClientConfig;
}

export class GeminiRuntime implements LlmRuntime {
  readonly name = 'gemini' as const;

  private client: McpClient | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly clientConfig: McpClientConfig;

  constructor(opts: GeminiRuntimeOptions = {}) {
    this.clientConfig = opts.clientConfig ?? { command: 'npx', args: ['@2lab.ai/gemini-mcp-server'] };
  }

  async ensureReady(): Promise<void> {
    if (this.client?.isReady()) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doInitialize().finally(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  async startSession(
    model: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<StartSessionResult> {
    await this.ensureReady();

    const backendArgs: Record<string, unknown> = { prompt, model };
    if (opts.cwd) backendArgs.cwd = opts.cwd;

    const result = await this.invoke('chat', backendArgs, opts);
    const { parsed, text } = parseResponse(result);
    const backendSessionId = extractSessionId(parsed, result);
    const content = extractContent(result, parsed, text);

    return { backendSessionId, content };
  }

  async resumeSession(
    backendSessionId: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<ResumeSessionResult> {
    await this.ensureReady();

    const backendArgs: Record<string, unknown> = { prompt, sessionId: backendSessionId };
    const result = await this.invoke('chat-reply', backendArgs, opts);
    const { parsed, text } = parseResponse(result);
    const newSessionId = extractSessionId(parsed, result) || backendSessionId;
    const content = extractContent(result, parsed, text);

    return { backendSessionId: newSessionId, content };
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;
    try { await this.client.stop(); } catch { /* ignore */ }
    this.client = null;
  }

  // ── Internal ────────────────────────────────────────────

  private async invoke(
    tool: string,
    args: Record<string, unknown>,
    opts: RuntimeCallOptions,
  ): Promise<any> {
    const client = this.client;
    if (!client) throw new LlmChatError(ErrorCode.BACKEND_FAILED, 'Gemini client not initialized');

    const timeoutMs = opts.timeoutMs ?? GEMINI_DEFAULT_TIMEOUT;
    const work = client.callTool(tool, args, timeoutMs).catch((err) => {
      if (err instanceof LlmChatError) throw err;
      throw new LlmChatError(ErrorCode.BACKEND_FAILED, err?.message ?? String(err), err);
    });

    return runWithWatchdog(work, {
      timeoutMs,
      signal: opts.signal,
      killChild: (sig) => { client.killProcess(sig); },
    });
  }

  private async doInitialize(): Promise<void> {
    if (!this.cliExists('gemini')) {
      throw new Error('Gemini CLI not installed. Run: brew install gemini-cli');
    }

    if (this.client) {
      try { await this.client.stop(); } catch { /* ignore */ }
      this.client = null;
    }

    const client = new McpClient(this.clientConfig, 'LlmMCP:gemini');
    await client.start();
    this.client = client;
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
