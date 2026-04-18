/**
 * CodexRuntime — LlmRuntime adapter for the Codex MCP server.
 *
 * Design:
 *   - A single long-lived McpClient child process is shared across all requests
 *     (same as the pre-refactor architecture; spawning per request would add
 *     seconds of handshake overhead per prompt).
 *   - The child's PID is registered with the injected ChildRegistry on the
 *     first successful ensureReady and removed on shutdown, so an orphaned
 *     child from a prior crash can be reaped at next boot.
 *   - Every startSession/resumeSession call is wrapped in runWithWatchdog.
 *     On timeout or abort, the watchdog invokes killChild() — implemented here
 *     as client.killProcess(sig) — which terminates the MCP child. The next
 *     request will trigger ensureReady to spawn a fresh child.
 *   - resolvedConfig is the merged dictionary of (server defaults ∪ caller config)
 *     with flat dot-notation keys expanded to the nested shape Codex expects.
 *     The merged (pre-expansion) object is echoed back from startSession so the
 *     router can persist it for reproducible resume spawns.
 */

import { execFileSync } from 'child_process';
import { McpClient } from '../../_shared/mcp-client.js';
import type { McpClientConfig } from '../../_shared/mcp-client.js';
import type {
  LlmRuntime,
  RuntimeCapabilities,
  RuntimeCallOptions,
  StartSessionResult,
  ResumeSessionResult,
} from './types.js';
import type { ChildRegistry } from './child-registry.js';
import { runWithWatchdog } from './watchdog.js';
import { ErrorCode, LlmChatError } from './errors.js';

// ── Config Expansion ──────────────────────────────────────

/**
 * Expand flat dot-notation config keys into nested objects and coerce types.
 * e.g. { "features.fast_mode": "true" } → { features: { fast_mode: true } }
 */
export function expandConfigForCodex(flat: Record<string, unknown>): Record<string, unknown> {
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

// ── Session ID / response helpers ─────────────────────────

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

const CODEX_DEFAULT_TIMEOUT = 600_000;

export interface CodexRuntimeOptions {
  clientConfig?: McpClientConfig;
  childRegistry?: ChildRegistry;
}

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
  private registeredPid: number | null = null;
  private readonly clientConfig: McpClientConfig;
  private readonly childRegistry?: ChildRegistry;

  constructor(opts: CodexRuntimeOptions = {}) {
    this.clientConfig = opts.clientConfig ?? { command: 'codex', args: ['mcp-server'] };
    this.childRegistry = opts.childRegistry;
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

    const mergedConfig: Record<string, unknown> = { ...(opts.resolvedConfig ?? {}) };
    const expandedConfig = expandConfigForCodex(mergedConfig);

    const backendArgs: Record<string, unknown> = { prompt, model };
    if (opts.cwd) backendArgs.cwd = opts.cwd;
    if (Object.keys(expandedConfig).length > 0) backendArgs.config = expandedConfig;

    const result = await this.invoke('codex', backendArgs, opts);
    const { parsed, text } = parseResponse(result);
    const backendSessionId = extractThreadId(parsed, result);
    const content = extractContent(result, parsed, text);

    return { backendSessionId, content, resolvedConfig: mergedConfig };
  }

  async resumeSession(
    backendSessionId: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<ResumeSessionResult> {
    await this.ensureReady();

    // Codex's codex-reply tool takes only prompt + threadId; cwd/config are bound
    // to the original thread by the Codex server. resolvedConfig is accepted in
    // the signature for symmetry but not re-sent here.
    const backendArgs: Record<string, unknown> = { prompt, threadId: backendSessionId };

    const result = await this.invoke('codex-reply', backendArgs, opts);
    const { parsed, text } = parseResponse(result);
    const newSessionId = extractThreadId(parsed, result) || backendSessionId;
    const content = extractContent(result, parsed, text);

    return { backendSessionId: newSessionId, content };
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      const pid = this.client.getPid();
      try { await this.client.stop(); } catch { /* ignore */ }
      this.client = null;
      if (pid !== undefined && this.registeredPid === pid) {
        try { await this.childRegistry?.remove(pid); } catch { /* ignore */ }
        this.registeredPid = null;
      }
    }
  }

  // ── Internal ────────────────────────────────────────────

  private async invoke(
    tool: string,
    args: Record<string, unknown>,
    opts: RuntimeCallOptions,
  ): Promise<any> {
    const client = this.client;
    if (!client) throw new LlmChatError(ErrorCode.BACKEND_FAILED, 'Codex client not initialized');

    const timeoutMs = opts.timeoutMs ?? CODEX_DEFAULT_TIMEOUT;
    const work = client.callTool(tool, args, timeoutMs).catch((err) => {
      // Don't wrap LlmChatErrors that bubble up from watchdog.
      if (err instanceof LlmChatError) throw err;
      throw new LlmChatError(ErrorCode.BACKEND_FAILED, err?.message ?? String(err), err);
    });

    return runWithWatchdog(work, {
      timeoutMs,
      signal: opts.signal,
      killChild: (sig) => {
        // Terminate the shared client child. Next call triggers ensureReady.
        client.killProcess(sig);
      },
    });
  }

  private async doInitialize(): Promise<void> {
    if (!this.cliExists('codex')) {
      throw new Error('Codex CLI not installed. Run: brew install --cask codex');
    }

    // If we have a stale client, de-register its PID first.
    if (this.client) {
      const oldPid = this.registeredPid;
      try { await this.client.stop(); } catch { /* ignore */ }
      this.client = null;
      if (oldPid !== null) {
        try { await this.childRegistry?.remove(oldPid); } catch { /* ignore */ }
        this.registeredPid = null;
      }
    }

    const client = new McpClient(this.clientConfig, 'LlmMCP:codex');
    await client.start();
    this.client = client;

    const pid = client.getPid();
    if (pid !== undefined && this.childRegistry) {
      try {
        await this.childRegistry.append(pid, 'codex');
        this.registeredPid = pid;
      } catch {
        // Registry write failure does NOT block startup.
      }
    }
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
