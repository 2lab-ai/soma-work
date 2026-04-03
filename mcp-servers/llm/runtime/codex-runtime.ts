import { execFileSync } from 'child_process';
import { McpClient } from '../../_shared/mcp-client.js';
import type { McpClientConfig } from '../../_shared/mcp-client.js';
import type { LlmRuntime, RuntimeCapabilities, SessionOptions, SessionResult } from './types.js';

// ── Config Expansion ──────────────────────────────────────

/**
 * Expand flat dot-notation config keys into nested objects and coerce types.
 * e.g. { "features.fast_mode": "true" } → { features: { fast_mode: true } }
 */
function expandConfigForCodex(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const coerced = value === 'true' ? true : value === 'false' ? false : value;

    if (key.includes('.')) {
      const parts = key.split('.');
      let target: Record<string, unknown> = result;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in target) || typeof target[parts[i]] !== 'object' || target[parts[i]] === null) {
          target[parts[i]] = {};
        }
        target = target[parts[i]] as Record<string, unknown>;
      }
      target[parts[parts.length - 1]] = coerced;
    } else {
      result[key] = coerced;
    }
  }
  return result;
}

// ── Session ID Extraction ─────────────────────────────────

function extractThreadId(parsed: any, rawResult?: any): string {
  const key = 'threadId';

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

// ── CodexRuntime ──────────────────────────────────────────

const CODEX_TIMEOUT = 600_000;

export class CodexRuntime implements LlmRuntime {
  readonly name = 'codex' as const;
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
    this.clientConfig = clientConfig ?? { command: 'codex', args: ['mcp-server'] };
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
    if (options.cwd) backendArgs.cwd = options.cwd;

    const expandedDefaults = expandConfigForCodex(options.configOverride || {});
    const mergedConfig = { ...expandedDefaults, ...(options.config || {}) };
    if (Object.keys(mergedConfig).length > 0) {
      backendArgs.config = mergedConfig;
    }

    const result = await this.client!.callTool('codex', backendArgs, CODEX_TIMEOUT);
    const { parsed, text } = parseResponse(result);
    const backendSessionId = extractThreadId(parsed, result);
    const content = extractContent(result, parsed, text);

    return { backendSessionId, content, backend: 'codex', model: options.model };
  }

  async resumeSession(backendSessionId: string, prompt: string): Promise<SessionResult> {
    await this.ensureReady();

    const backendArgs: Record<string, unknown> = { prompt, threadId: backendSessionId };
    const result = await this.client!.callTool('codex-reply', backendArgs, CODEX_TIMEOUT);
    const { parsed, text } = parseResponse(result);
    const newSessionId = extractThreadId(parsed, result) || backendSessionId;
    const content = extractContent(result, parsed, text);

    return { backendSessionId: newSessionId, content, backend: 'codex', model: '' };
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      try { await this.client.stop(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  // ── Private ─────────────────────────────────────────────

  private async doInitialize(): Promise<void> {
    if (!this.cliExists('codex')) {
      throw new Error('Codex CLI not installed. Run: brew install --cask codex');
    }

    if (this.client) {
      try { await this.client.stop(); } catch { /* ignore */ }
    }

    this.client = new McpClient(this.clientConfig, 'LlmMCP:codex');
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
