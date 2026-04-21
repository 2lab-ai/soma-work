#!/usr/bin/env node
/**
 * LLM MCP Server — single `chat` tool with optional `resumeSessionId`.
 *
 * Surface:
 *   chat({ prompt, model?, resumeSessionId?, cwd?, timeoutMs? })
 *     → { sessionId, backend, model, content }
 *     | { error: { code, message } }
 *
 * Sessions live in memory. Process restart discards them — callers treat
 * resume as best-effort. There is no persistence, pidfile, orphan-reap or
 * graceful-drain machinery here: the MCP runtime owns the process lifecycle.
 */

import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';
import type { Backend, LlmRuntime } from './runtime/types.js';
import { CodexRuntime } from './runtime/codex-runtime.js';
import { GeminiRuntime } from './runtime/gemini-runtime.js';
import { ErrorCode, LlmChatError } from './runtime/errors.js';
import { randomUUID } from 'node:crypto';

// ── Model Routing ──────────────────────────────────────────

export interface RouteResult {
  backend: Backend;
  model: string;
  /** True when the caller passed an unrecognized alias that fell through to the codex default. */
  unknownAlias?: boolean;
}

const DEFAULT_CODEX_MODEL = 'gpt-5.4';
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';

export function routeModel(model: string): RouteResult {
  if (model === 'codex') return { backend: 'codex', model: DEFAULT_CODEX_MODEL };
  if (model === 'gemini') return { backend: 'gemini', model: DEFAULT_GEMINI_MODEL };
  if (model.startsWith('gemini-')) return { backend: 'gemini', model };
  if (model.startsWith('gpt-') || model.startsWith('o')) return { backend: 'codex', model };
  // Unknown alias: pass through to codex as a last-resort default. Surfaced via
  // `unknownAlias` so the server can emit a one-shot log — dropping silently
  // would hide typos in caller-supplied `model` values.
  return { backend: 'codex', model, unknownAlias: true };
}

// ── Session state (in-memory) ──────────────────────────────

interface Session {
  publicId: string;
  backend: Backend;
  backendSessionId: string;
  model: string;
  cwd?: string;
}

// ── Response shaping ───────────────────────────────────────

interface ChatSuccess {
  sessionId: string;
  backend: Backend;
  model: string;
  content: string;
}

function successResult(payload: ChatSuccess): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...({ structuredContent: payload } as Record<string, unknown>),
  } as ToolResult;
}

function errorResult(err: LlmChatError): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: err.message }],
    ...({
      structuredContent: {
        error: { code: err.code, message: err.message },
      },
    } as Record<string, unknown>),
  } as ToolResult;
}

// ── Dependencies ───────────────────────────────────────────

export interface LlmMcpDeps {
  runtimes: Record<Backend, LlmRuntime>;
  /**
   * When true (default in `bootstrap()`), `shutdown()` calls `process.exit(0)`
   * after draining runtimes. Tests disable this so they can await `shutdown()`
   * and assert child cleanup without terminating the test runner.
   */
  exitOnShutdown?: boolean;
}

// ── Server ─────────────────────────────────────────────────

export class LlmMCPServer extends BaseMcpServer {
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Set<string>();

  constructor(private readonly deps: LlmMcpDeps) {
    super('llm-mcp-server');
  }

  defineTools(): ToolDefinition[] {
    return [
      {
        name: 'chat',
        description:
          'Send a prompt to an LLM backend (Codex or Gemini). Pass `resumeSessionId` ' +
          'to continue a previous session; `model` is then forbidden.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', minLength: 1, description: 'Prompt text.' },
            resumeSessionId: {
              type: 'string',
              minLength: 1,
              description: 'Session ID returned by a prior chat call. Mutually exclusive with model.',
            },
            model: {
              type: 'string',
              minLength: 1,
              description: '"codex" / "gemini" select a backend; gpt-*/o* → codex; gemini-* → gemini.',
            },
            cwd: { type: 'string', minLength: 1, description: 'Working directory for the backend child.' },
            timeoutMs: {
              type: 'integer',
              minimum: 1000,
              maximum: 1800000,
              description: 'Watchdog timeout (default 300000ms).',
            },
          },
          required: ['prompt'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name !== 'chat') {
      return errorResult(new LlmChatError(ErrorCode.INVALID_ARGS, `Unknown tool: ${name}`));
    }
    try {
      return await this.handleChat(args);
    } catch (err) {
      if (err instanceof LlmChatError) {
        // Typed errors are caller-facing codes. Log at error so ops can correlate
        // BACKEND_TIMEOUT / SESSION_BUSY / SESSION_NOT_FOUND / MUTUAL_EXCLUSION
        // / INVALID_ARGS on the server side — callers only see the structured result.
        this.logger.error('llm.chat.typed-error', { code: err.code, message: err.message });
        return errorResult(err);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('llm.chat.unexpected', err);
      return errorResult(new LlmChatError(ErrorCode.BACKEND_FAILED, message, err));
    }
  }

  protected override async shutdown(): Promise<void> {
    await Promise.all(
      Object.values(this.deps.runtimes).map(async (rt) => {
        try {
          await rt.shutdown();
        } catch (err) {
          // Swallowing shutdown errors silently hides hung-child bugs. Warn
          // with context so long-lived MCP processes leave a trace when
          // teardown fails, without blocking exit.
          this.logger.warn('llm.runtime.shutdown-failed', {
            runtime: (rt as { name?: string }).name,
            err,
          });
        }
      }),
    );
    // Process lifecycle belongs to the bootstrap wrapper; tests construct the
    // server with `exitOnShutdown: false` so they can assert runtime teardown
    // without terminating the runner.
    if (this.deps.exitOnShutdown !== false) {
      process.exit(0);
    }
  }

  // ── Chat handler ────────────────────────────────────────

  private async handleChat(args: Record<string, unknown>): Promise<ToolResult> {
    const promptRaw = args.prompt;
    if (typeof promptRaw !== 'string' || promptRaw.trim().length === 0) {
      throw new LlmChatError(ErrorCode.INVALID_ARGS, 'prompt is required and must be non-empty');
    }
    const prompt = promptRaw;

    const resumeSessionId = args.resumeSessionId as string | undefined;
    const model = args.model as string | undefined;
    const cwd = args.cwd as string | undefined;
    const timeoutMs = args.timeoutMs as number | undefined;

    if (resumeSessionId && model !== undefined) {
      throw new LlmChatError(
        ErrorCode.MUTUAL_EXCLUSION,
        'resumeSessionId cannot be combined with model',
      );
    }

    if (resumeSessionId) {
      return this.handleResume(resumeSessionId, prompt, { cwd, timeoutMs });
    }
    return this.handleNew(prompt, { model: model ?? 'codex', cwd, timeoutMs });
  }

  // ── New session ─────────────────────────────────────────

  private async handleNew(
    prompt: string,
    opts: { model: string; cwd?: string; timeoutMs?: number },
  ): Promise<ToolResult> {
    const route = routeModel(opts.model);
    if (route.unknownAlias) {
      // Caller likely typo'd the alias; default-to-codex is a fallback, not a
      // guarantee. Warn once per call so typos are discoverable without forcing
      // INVALID_ARGS (which would break every existing `llm_chat(model: 'x')` caller).
      this.logger.warn('llm.route.unknown-alias', {
        alias: opts.model,
        fallbackBackend: route.backend,
        fallbackModel: route.model,
      });
    }
    const runtime = this.deps.runtimes[route.backend];

    const result = await runtime.startSession(route.model, prompt, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });

    const backendSessionId =
      typeof result.backendSessionId === 'string' ? result.backendSessionId.trim() : '';
    if (!backendSessionId) {
      // Ops-facing context: which backend+model silently returned nothing.
      // The caller only sees `BACKEND_FAILED`; without this log, routing bugs
      // that regress one backend would be indistinguishable from the other.
      this.logger.error('llm.chat.empty-session-id', {
        backend: route.backend,
        model: route.model,
      });
      throw new LlmChatError(ErrorCode.BACKEND_FAILED, 'Backend returned empty session ID');
    }

    const publicId = randomUUID();
    this.sessions.set(publicId, {
      publicId,
      backend: route.backend,
      backendSessionId,
      model: route.model,
      cwd: opts.cwd,
    });

    return successResult({
      sessionId: publicId,
      backend: route.backend,
      model: route.model,
      content: result.content,
    });
  }

  // ── Resume ──────────────────────────────────────────────

  private async handleResume(
    resumeSessionId: string,
    prompt: string,
    opts: { cwd?: string; timeoutMs?: number },
  ): Promise<ToolResult> {
    const session = this.sessions.get(resumeSessionId);
    if (!session) {
      throw new LlmChatError(
        ErrorCode.SESSION_NOT_FOUND,
        `Session ${resumeSessionId} not found`,
      );
    }

    if (this.inflight.has(resumeSessionId)) {
      throw new LlmChatError(ErrorCode.SESSION_BUSY, `Session ${resumeSessionId} is busy`);
    }
    this.inflight.add(resumeSessionId);
    try {
      const runtime = this.deps.runtimes[session.backend];
      const effectiveCwd = opts.cwd ?? session.cwd;

      const result = await runtime.resumeSession(session.backendSessionId, prompt, {
        cwd: effectiveCwd,
        timeoutMs: opts.timeoutMs,
      });

      const raw = result.backendSessionId;
      const rotated = typeof raw === 'string' ? raw.trim() : '';
      if (rotated && rotated !== session.backendSessionId) {
        session.backendSessionId = rotated;
      } else if (typeof raw !== 'string' || (raw.length > 0 && rotated.length === 0)) {
        // Mirror handleNew's `llm.chat.empty-session-id` log. If the runtime returned
        // a non-string or a whitespace-only string, we silently keep the existing
        // backendSessionId — record it so regressions in a specific backend are
        // distinguishable from normal "no rotation needed" responses.
        this.logger.warn('llm.chat.resume.blank-rotated-id', {
          publicId: resumeSessionId,
          backend: session.backend,
          rawType: typeof raw,
        });
      }

      return successResult({
        sessionId: resumeSessionId,
        backend: session.backend,
        model: session.model,
        content: result.content,
      });
    } finally {
      this.inflight.delete(resumeSessionId);
    }
  }
}

// ── Bootstrap ──────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const runtimes: Record<Backend, LlmRuntime> = {
    codex: new CodexRuntime(),
    gemini: new GeminiRuntime(),
  };

  const server = new LlmMCPServer({ runtimes, exitOnShutdown: true });
  await server.run();
}

// ── Main ──────────────────────────────────────────────────

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('llm-mcp-server.ts') ||
  process.argv[1]?.endsWith('llm-mcp-server.js');

if (invokedDirectly) {
  bootstrap().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start LLM MCP Server', error);
    process.exit(1);
  });
}
