#!/usr/bin/env node
/**
 * LLM MCP Server — single `chat` tool with optional `resumeSessionId`.
 *
 * Refactor (v8): the prior surface of {chat, chat-reply, status, result, cancel}
 * collapsed to one synchronous tool. `background` is gone. A caller passes
 * `resumeSessionId` to continue a prior session; model+config are derived from
 * the stored SessionRecord (and forbidden in the request to prevent silent
 * config drift between new and resume spawns).
 *
 * Response contract:
 *   Success → { content:[{type:'text',text: JSON.stringify({sessionId,backend,model,content})}],
 *               structuredContent: {sessionId, backend, model, content} }
 *   Error   → { isError:true, content:[{type:'text',text:`[${code}] ${message}`}],
 *               structuredContent: { error: { code, message } } }
 *
 * Startup order (D18, D19):
 *   1. acquirePidfile (exclusive wx)
 *   2. childRegistry.replayAndReap (orphans from prior crash)
 *   3. sessionStore migration happens on first ensureLoaded; no explicit call needed
 *   4. bind handlers, connect stdio
 *   5. install shutdown signal handlers (graceful drain → pidfile release → exit)
 */

import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import { ConfigCache } from '../_shared/config-cache.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';
import type { Backend, LlmRuntime, SessionRecord } from './runtime/types.js';
import { CodexRuntime } from './runtime/codex-runtime.js';
import { GeminiRuntime } from './runtime/gemini-runtime.js';
import { FileSessionStore } from './runtime/session-store.js';
import { ChildRegistry } from './runtime/child-registry.js';
import { SessionLocks } from './runtime/session-locks.js';
import { ErrorCode, LlmChatError } from './runtime/errors.js';
import { acquirePidfile } from './runtime/pidfile.js';
import { ShutdownCoordinator } from './runtime/shutdown.js';
import { randomUUID } from 'node:crypto';

// ── Backend config ─────────────────────────────────────────

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
    configOverride: {
      model_reasoning_effort: 'xhigh',
      'features.fast_mode': 'true',
      service_tier: 'fast',
    },
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

export function routeModel(model: string): BackendConfig {
  const config = configCache.get();
  if (model === 'codex' || model === 'gemini') return config[model];
  if (model.startsWith('gpt-') || model.startsWith('o')) {
    return { backend: 'codex', model };
  }
  if (model.startsWith('gemini-')) {
    return { backend: 'gemini', model };
  }
  return { backend: 'codex', model };
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
    // Cast to loosen the ToolResult typing; MCP SDK accepts extra fields.
    ...({ structuredContent: payload } as Record<string, unknown>),
  } as ToolResult;
}

function errorResult(err: LlmChatError): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: err.message }],
    ...({
      structuredContent: {
        error: {
          code: err.code,
          message: err.message,
        },
      },
    } as Record<string, unknown>),
  } as ToolResult;
}

// ── Wiring (constructed below by bootstrap) ────────────────

export interface LlmMcpDeps {
  runtimes: Record<Backend, LlmRuntime>;
  sessionStore: FileSessionStore;
  childRegistry: ChildRegistry;
  sessionLocks: SessionLocks;
  shutdownCoordinator: ShutdownCoordinator;
}

// ── Server ─────────────────────────────────────────────────

export class LlmMCPServer extends BaseMcpServer {
  constructor(private readonly deps: LlmMcpDeps) {
    super('llm-mcp-server');
  }

  defineTools(): ToolDefinition[] {
    return [
      {
        name: 'chat',
        description:
          'Send a prompt to an LLM backend (Codex or Gemini). Pass `resumeSessionId` ' +
          'to continue a previous session; `model` and `config` are then forbidden ' +
          '(they are reused from the stored session for a reproducible spawn). ' +
          'For a new session, provide `model`; `config` is optional.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', minLength: 1, description: 'Prompt text.' },
            resumeSessionId: {
              type: 'string',
              minLength: 1,
              description: 'Session ID returned by a prior chat call. Mutually exclusive with model/config.',
            },
            model: {
              type: 'string',
              minLength: 1,
              description: 'Model or alias. "codex" / "gemini" select a backend; gpt-*/o* → codex; gemini-* → gemini.',
            },
            config: {
              type: 'object',
              additionalProperties: true,
              description: 'Optional backend-specific config overrides. New sessions only.',
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
      // Unknown tool: surface as INVALID_ARGS so callers see a clean code.
      return errorResult(new LlmChatError(ErrorCode.INVALID_ARGS, `Unknown tool: ${name}`));
    }
    try {
      return await this.deps.shutdownCoordinator.track(() => this.handleChat(args));
    } catch (err) {
      if (err instanceof LlmChatError) return errorResult(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('llm.chat.unexpected', err);
      return errorResult(new LlmChatError(ErrorCode.BACKEND_FAILED, message, err));
    }
  }

  protected override async shutdown(): Promise<void> {
    await this.deps.shutdownCoordinator.graceful('programmatic');
    process.exit(0);
  }

  // ── Chat handler ────────────────────────────────────────

  private async handleChat(args: Record<string, unknown>): Promise<ToolResult> {
    // ── Runtime-enforced validation beyond JSON schema ──
    const promptRaw = args.prompt;
    if (typeof promptRaw !== 'string' || promptRaw.trim().length === 0) {
      throw new LlmChatError(ErrorCode.INVALID_ARGS, 'prompt is required and must be non-empty');
    }
    const prompt = promptRaw;

    const resumeSessionId = args.resumeSessionId as string | undefined;
    const model = args.model as string | undefined;
    const config = args.config as Record<string, unknown> | undefined;
    const cwd = args.cwd as string | undefined;
    const timeoutMs = args.timeoutMs as number | undefined;

    if (resumeSessionId && (model !== undefined || config !== undefined)) {
      throw new LlmChatError(
        ErrorCode.MUTUAL_EXCLUSION,
        'resumeSessionId cannot be combined with model or config',
      );
    }

    if (resumeSessionId) {
      return this.handleResume(resumeSessionId, prompt, { cwd, timeoutMs });
    }
    return this.handleNew(prompt, {
      model: model ?? 'codex',
      config,
      cwd,
      timeoutMs,
    });
  }

  // ── New session ─────────────────────────────────────────

  private async handleNew(
    prompt: string,
    opts: { model: string; config?: Record<string, unknown>; cwd?: string; timeoutMs?: number },
  ): Promise<ToolResult> {
    const route = routeModel(opts.model);
    const runtime = this.deps.runtimes[route.backend];

    // Merge server defaults + user config into the resolvedConfig sent to the backend.
    const mergedConfig: Record<string, unknown> = {
      ...(route.configOverride ?? {}),
      ...(opts.config ?? {}),
    };

    const publicId = randomUUID();
    const now = new Date().toISOString();
    const pending: SessionRecord = {
      publicId,
      backend: route.backend,
      backendSessionId: null,
      model: route.model,
      cwd: opts.cwd,
      resolvedConfig: mergedConfig,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    // Map placeholder-save failures to PERSISTENCE_FAILED (not BACKEND_FAILED);
    // the backend was never invoked, so the error is purely a durability issue.
    try {
      await this.deps.sessionStore.save(pending);
    } catch (persistErr) {
      this.logger.error('llm.session.placeholder-persist-failed', {
        publicId,
        err: String(persistErr),
      });
      throw new LlmChatError(
        ErrorCode.PERSISTENCE_FAILED,
        'Failed to persist session placeholder; backend was not invoked',
        persistErr,
      );
    }

    this.logger.info('llm.session.created', {
      publicId,
      backend: route.backend,
      model: route.model,
    });

    let startResult: { backendSessionId: string; content: string; resolvedConfig: Record<string, unknown> };
    try {
      startResult = await runtime.startSession(route.model, prompt, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        resolvedConfig: mergedConfig,
      });
    } catch (err) {
      // Backend never confirmed a session — purge the placeholder.
      try { await this.deps.sessionStore.delete(publicId); } catch { /* best-effort */ }
      this.logger.warn('llm.session.failed', { publicId, err: String(err) });
      if (err instanceof LlmChatError) throw err;
      throw new LlmChatError(
        ErrorCode.BACKEND_FAILED,
        err instanceof Error ? err.message : String(err),
        err,
      );
    }

    // D10 invariant defense: a blank `backendSessionId` means the extract
    // helper fell through every branch. Promoting to `ready` with '' would
    // be silently corrupt — resume would pass '' to the backend, and the
    // loader's tri-state rule (`ready ⇒ backendSessionId != null`) only
    // rejects null. Treat this as a backend failure; purge placeholder.
    const normalizedBsid =
      typeof startResult.backendSessionId === 'string'
        ? startResult.backendSessionId.trim()
        : '';
    if (!normalizedBsid) {
      try { await this.deps.sessionStore.delete(publicId); } catch { /* best-effort */ }
      this.logger.warn('llm.session.blank-backend-session-id', { publicId, backend: route.backend });
      throw new LlmChatError(
        ErrorCode.BACKEND_FAILED,
        'Backend returned empty session ID',
      );
    }

    // Promote pending → ready atomically. If persistence fails, mark corrupted
    // and surface PERSISTENCE_FAILED so the caller knows a backend session may
    // have leaked (we cannot revoke it).
    try {
      await this.deps.sessionStore.update(publicId, {
        backendSessionId: normalizedBsid,
        resolvedConfig: startResult.resolvedConfig,
        status: 'ready',
      });
    } catch (persistErr) {
      try {
        await this.deps.sessionStore.update(publicId, { status: 'corrupted' });
      } catch { /* best-effort */ }
      this.logger.error('llm.session.leaked', {
        publicId,
        backendSessionId: normalizedBsid,
        err: String(persistErr),
      });
      throw new LlmChatError(
        ErrorCode.PERSISTENCE_FAILED,
        'Session state not durable; backend session may leak',
        persistErr,
      );
    }

    return successResult({
      sessionId: publicId,
      backend: route.backend,
      model: route.model,
      content: startResult.content,
    });
  }

  // ── Resume ──────────────────────────────────────────────

  private async handleResume(
    resumeSessionId: string,
    prompt: string,
    opts: { cwd?: string; timeoutMs?: number },
  ): Promise<ToolResult> {
    const release = this.deps.sessionLocks.acquire(resumeSessionId);
    try {
      const session = this.deps.sessionStore.get(resumeSessionId);
      if (!session) {
        throw new LlmChatError(
          ErrorCode.SESSION_NOT_FOUND,
          `Session ${resumeSessionId} not found`,
        );
      }
      if (session.status !== 'ready') {
        throw new LlmChatError(
          ErrorCode.SESSION_CORRUPTED,
          `Session ${resumeSessionId} is in status '${session.status}' and cannot be resumed`,
        );
      }
      if (session.backendSessionId === null) {
        // Loader invariant should have converted this to 'corrupted', but defense-in-depth:
        throw new LlmChatError(
          ErrorCode.SESSION_CORRUPTED,
          `Session ${resumeSessionId} has no backendSessionId`,
        );
      }

      const runtime = this.deps.runtimes[session.backend];
      const effectiveCwd = opts.cwd ?? session.cwd;

      let resumeResult: { backendSessionId: string; content: string };
      try {
        resumeResult = await runtime.resumeSession(session.backendSessionId, prompt, {
          cwd: effectiveCwd,
          timeoutMs: opts.timeoutMs,
          resolvedConfig: session.resolvedConfig,
        });
      } catch (err) {
        this.logger.warn('llm.session.resume.failed', { publicId: resumeSessionId, err: String(err) });
        if (err instanceof LlmChatError) throw err;
        throw new LlmChatError(
          ErrorCode.BACKEND_FAILED,
          err instanceof Error ? err.message : String(err),
          err,
        );
      }

      try {
        // Normalize the backend's returned session ID: a whitespace-only
        // value would pass a truthy check yet silently corrupt future
        // resumes (the store's `ready` invariant now also rejects blank).
        const trimmedBsid =
          typeof resumeResult.backendSessionId === 'string'
            ? resumeResult.backendSessionId.trim()
            : '';
        if (trimmedBsid && trimmedBsid !== session.backendSessionId) {
          await this.deps.sessionStore.updateBackendSessionId(
            resumeSessionId,
            trimmedBsid,
          );
        } else {
          // Either the backend did not rotate the ID, or it returned a blank
          // value — in both cases we keep the existing stored ID and just
          // bump updatedAt via touch().
          await this.deps.sessionStore.touch(resumeSessionId);
        }
      } catch (persistErr) {
        try {
          await this.deps.sessionStore.update(resumeSessionId, { status: 'corrupted' });
        } catch { /* best-effort */ }
        this.logger.error('llm.session.resume.persist-failed', {
          publicId: resumeSessionId,
          err: String(persistErr),
        });
        throw new LlmChatError(
          ErrorCode.PERSISTENCE_FAILED,
          'Session state not durable after resume',
          persistErr,
        );
      }

      this.logger.info('llm.session.resumed', {
        publicId: resumeSessionId,
        backend: session.backend,
      });

      return successResult({
        sessionId: resumeSessionId,
        backend: session.backend,
        model: session.model,
        content: resumeResult.content,
      });
    } finally {
      release();
    }
  }
}

// ── Bootstrap ──────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  // 1. pidfile
  const pidfile = acquirePidfile();

  // 2. stores & registry
  const sessionStore = new FileSessionStore();
  const childRegistry = new ChildRegistry();

  // 3. reap orphans (AFTER pidfile lock)
  try {
    await childRegistry.replayAndReap();
  } catch (err) {
    // Best-effort: even if reap fails, continue. Logs surfaced by child-registry.
    // eslint-disable-next-line no-console
    console.error('llm.orphan.reap.error', err);
  }

  // 4. runtimes
  const runtimes: Record<Backend, LlmRuntime> = {
    codex: new CodexRuntime({ childRegistry }),
    gemini: new GeminiRuntime({ childRegistry }),
  };

  const sessionLocks = new SessionLocks();
  const shutdownCoordinator = new ShutdownCoordinator({
    pidfile,
    sessionStore,
    childRegistry,
    runtimes,
  });

  const server = new LlmMCPServer({
    runtimes,
    sessionStore,
    childRegistry,
    sessionLocks,
    shutdownCoordinator,
  });

  shutdownCoordinator.installSignalHandlers();

  await server.run();
}

// ── Main ──────────────────────────────────────────────────

// Only auto-run when invoked as the entry point, not when imported for tests.
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
