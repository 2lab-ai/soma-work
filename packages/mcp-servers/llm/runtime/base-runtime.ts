/**
 * BaseMcpLlmRuntime — shared implementation for MCP-backed LlmRuntime adapters.
 *
 * Codex and Gemini share the same architecture: a single long-lived McpClient
 * child shared across requests, each call wrapped in runWithWatchdog so a
 * timeout/abort kills the child and the next call re-spawns it via ensureReady.
 *
 * Concrete runtimes only declare a {@link BackendSpec} describing the
 * backend-specific tool names, session-ID key, CLI binary and default config.
 */

import type { McpClientConfig } from '@soma/process-shared/mcp/mcp-client.js';
import { McpClient } from '@soma/process-shared/mcp/mcp-client.js';
import { execFileSync } from 'child_process';
import { ErrorCode, LlmChatError } from './errors.js';
import type {
  Backend,
  LlmRuntime,
  ResumeSessionResult,
  RuntimeCallOptions,
  StartSessionResult,
} from './types.js';
import { runWithWatchdog } from './watchdog.js';

const DEFAULT_TIMEOUT = 600_000;

/** Backend-specific behavior that distinguishes one MCP runtime from another. */
export interface BackendSpec {
  /** Runtime identity (`LlmRuntime.name`). */
  readonly name: Backend;
  /** Response key carrying the backend session ID (Codex `threadId` / Gemini `sessionId`). */
  readonly sessionIdKey: string;
  /** CLI binary that must exist on PATH for the backend to initialize. */
  readonly cliCommand: string;
  /** Human-facing install hint thrown when {@link cliCommand} is missing. */
  readonly cliInstallHint: string;
  /** Label passed to the McpClient for log attribution. */
  readonly clientLabel: string;
  /** Default child-process spawn config when the caller supplies none. */
  readonly defaultClientConfig: McpClientConfig;
  /** Tool name for starting a new session. */
  readonly startTool: string;
  /** Tool name for continuing an existing session. */
  readonly resumeTool: string;
  /** Optional backend config object injected into every new session. */
  readonly startConfig?: Record<string, unknown>;
}

// ── Response helpers (backend-agnostic) ───────────────────

function parseResponse(result: any): { parsed: any; text: string } {
  const text = result?.content?.find((c: any) => c.type === 'text')?.text || '';
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { content: text };
  }
  return { parsed, text };
}

function extractContent(result: any, parsed: any, text: string): string {
  let content = result?.structuredContent?.content || parsed.content || text;
  if (typeof content === 'string') {
    content = content.replace(/\n*Session ID:\s*[0-9a-f-]+\s*$/i, '').trimEnd();
  }
  return content;
}

export abstract class BaseMcpLlmRuntime implements LlmRuntime {
  protected abstract readonly spec: BackendSpec;

  private client: McpClient | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly clientConfigOverride?: McpClientConfig;

  constructor(clientConfigOverride?: McpClientConfig) {
    this.clientConfigOverride = clientConfigOverride;
  }

  get name(): Backend {
    return this.spec.name;
  }

  private extractSessionId(parsed: any, rawResult?: any): string {
    const key = this.spec.sessionIdKey;
    if (rawResult?.structuredContent?.[key]) return rawResult.structuredContent[key];
    if (parsed[key]) return parsed[key];
    if (rawResult?.[key]) return rawResult[key];
    if (rawResult?._meta?.[key]) return rawResult._meta[key];
    const text = rawResult?.content?.find((c: any) => c.type === 'text')?.text || '';
    const match = text.match(
      /Session ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    if (match) return match[1];
    return '';
  }

  async ensureReady(): Promise<void> {
    if (this.client?.isReady()) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doInitialize().finally(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  async startSession(model: string, prompt: string, opts: RuntimeCallOptions): Promise<StartSessionResult> {
    await this.ensureReady();

    const backendArgs: Record<string, unknown> = { prompt, model };
    if (this.spec.startConfig) backendArgs.config = this.spec.startConfig;
    if (opts.cwd) backendArgs.cwd = opts.cwd;

    const result = await this.invoke(this.spec.startTool, backendArgs, opts);
    const { parsed, text } = parseResponse(result);
    const backendSessionId = this.extractSessionId(parsed, result);
    const content = extractContent(result, parsed, text);

    return { backendSessionId, content };
  }

  async resumeSession(
    backendSessionId: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<ResumeSessionResult> {
    await this.ensureReady();

    // The backend binds cwd/config to the original session, so the reply call
    // only carries the prompt plus the backend-native session key.
    const backendArgs: Record<string, unknown> = {
      prompt,
      [this.spec.sessionIdKey]: backendSessionId,
    };

    const result = await this.invoke(this.spec.resumeTool, backendArgs, opts);
    const { parsed, text } = parseResponse(result);
    const newSessionId = this.extractSessionId(parsed, result) || backendSessionId;
    const content = extractContent(result, parsed, text);

    return { backendSessionId: newSessionId, content };
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.stop();
    } catch {
      /* ignore */
    }
    this.client = null;
  }

  // ── Internal ────────────────────────────────────────────

  private async invoke(tool: string, args: Record<string, unknown>, opts: RuntimeCallOptions): Promise<any> {
    const client = this.client;
    if (!client) {
      throw new LlmChatError(ErrorCode.BACKEND_FAILED, `${this.spec.name} client not initialized`);
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const work = client.callTool(tool, args, timeoutMs).catch((err) => {
      if (err instanceof LlmChatError) throw err;
      throw new LlmChatError(ErrorCode.BACKEND_FAILED, err?.message ?? String(err), err);
    });

    return runWithWatchdog(work, {
      timeoutMs,
      signal: opts.signal,
      killChild: (sig) => {
        client.killProcess(sig);
      },
    });
  }

  private async doInitialize(): Promise<void> {
    if (!this.cliExists(this.spec.cliCommand)) {
      throw new Error(this.spec.cliInstallHint);
    }

    if (this.client) {
      try {
        await this.client.stop();
      } catch {
        /* ignore */
      }
      this.client = null;
    }

    const client = new McpClient(this.clientConfigOverride ?? this.spec.defaultClientConfig, this.spec.clientLabel);
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
