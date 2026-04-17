#!/usr/bin/env node

import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import { ConfigCache } from '../_shared/config-cache.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';
import type { Backend, Job, LlmRuntime } from './runtime/types.js';
import { CodexRuntime } from './runtime/codex-runtime.js';
import { GeminiRuntime } from './runtime/gemini-runtime.js';
import { FileSessionStore } from './runtime/session-store.js';
import { FileJobStore } from './runtime/job-store.js';
import { JobRunner } from './runtime/job-runner.js';
import { randomUUID } from 'node:crypto';

// ── Config ─────────────────────────────────────────────────

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

export function routeModel(model: string): BackendConfig {
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

// ── Runtimes & Stores ────────────────────────────────────

const runtimes: Record<Backend, LlmRuntime> = {
  codex: new CodexRuntime(),
  gemini: new GeminiRuntime(),
};

const sessionStore = new FileSessionStore();
const jobStore = new FileJobStore();
const jobRunner = new JobRunner({ jobStore, runtimes });

/**
 * Persist session for a completed job exactly once.
 * Uses the sessionSaved flag on the Job to prevent duplicate saves
 * across status/result polling calls.
 */
function ensureSessionSaved(job: Job): void {
  if (job.sessionSaved) return;
  if (job.status !== 'completed' || !job.sessionId || !job.backendSessionId) return;

  sessionStore.save({
    publicId: job.sessionId,
    backend: job.backend,
    backendSessionId: job.backendSessionId,
    model: job.model,
    createdAt: job.startedAt,
    updatedAt: job.completedAt ?? job.startedAt,
  });

  job.sessionSaved = true;
  jobStore.save(job);
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
        description: 'Start a new LLM chat session. Routes to codex or gemini backend based on model name. Always synchronous — background execution is currently DISABLED due to upstream Claude Code harness bug (anthropics/claude-code#47936) that causes parent agents to end their turn prematurely. Call this tool and await the result inline.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The prompt to start the session with.' },
            model: { type: 'string', description: 'Model name or alias. Use "codex", "gemini" for latest of each model.' },
            config: { type: 'object', description: 'Optional config overrides', additionalProperties: true },
            cwd: { type: 'string', description: 'Working directory' },
            background: { type: 'boolean', description: 'DISABLED. Setting this to true will throw an error. Background execution is blocked because it triggers upstream Claude Code bug (anthropics/claude-code#47936) where the parent agent ends its turn instead of polling status. Always call this tool synchronously.' },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'chat-reply',
        description: 'Continue an existing LLM chat session. Always synchronous — background execution is currently DISABLED (see `chat` tool description).',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The prompt to continue the conversation.' },
            sessionId: { type: 'string', description: 'The session ID from a previous chat call.' },
            background: { type: 'boolean', description: 'DISABLED. Setting this to true will throw an error. See `chat` tool for details.' },
          },
          required: ['prompt', 'sessionId'],
        },
      },
      {
        name: 'status',
        description: 'Get the status of a running or recent job, or list all active jobs.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Specific job ID. Omit to list all active jobs.' },
          },
        },
      },
      {
        name: 'result',
        description: 'Get the full result of a completed job.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'The job ID to get the result for.' },
          },
          required: ['jobId'],
        },
      },
      {
        name: 'cancel',
        description: 'Cancel a running or queued job.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'The job ID to cancel.' },
          },
          required: ['jobId'],
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
      case 'status':
        return this.handleStatus(args);
      case 'result':
        return this.handleResult(args);
      case 'cancel':
        return this.handleCancel(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  protected override async shutdown(): Promise<void> {
    this.logger.info('Shutting down...');

    // Cancel in-flight jobs gracefully
    for (const jobId of jobRunner.getInflightIds()) {
      jobRunner.cancel(jobId);
    }

    await Promise.all(
      Object.entries(runtimes).map(async ([name, runtime]) => {
        try { await runtime.shutdown(); } catch { /* ignore */ }
        this.logger.info(`Stopped ${name} runtime`);
      }),
    );
    process.exit(0);
  }

  // ── Chat ──────────────────────────────────────────────────

  private async handleChat(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = args.prompt as string;
    const model = (args.model as string) || 'codex';
    const cwd = args.cwd as string | undefined;
    const config = args.config as Record<string, unknown> | undefined;
    const background = args.background === true;

    // Block background=true: upstream Claude Code bug (anthropics/claude-code#47936)
    // causes parent agents to terminate the turn instead of polling status/result.
    // Force synchronous execution until upstream is fixed.
    if (background) {
      throw new Error(
        'llm chat background=true is DISABLED. ' +
        'Background execution triggers an upstream Claude Code harness bug ' +
        '(anthropics/claude-code#47936) that makes the parent agent end its turn ' +
        'instead of polling status/result. Call this tool synchronously (omit `background` ' +
        'or set it to false) and await the result inline.'
      );
    }

    const route = routeModel(model);
    this.logger.info(`Routing chat to ${route.backend}`, { model, resolvedModel: route.model, background });

    const sessionOptions = {
      model: route.model,
      cwd,
      config,
      configOverride: route.configOverride,
    };

    // Create session upfront (so sessionId is available in the job)
    const publicId = randomUUID();

    const job = await jobRunner.startJob({
      kind: 'chat',
      prompt,
      backend: route.backend,
      model: route.model,
      sessionOptions,
      sessionId: publicId,
      background,
    });

    // If synchronous (not background) and completed, save session
    if (!background) {
      ensureSessionSaved(job);
    }

    if (background) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            jobId: job.id,
            status: job.status,
            sessionId: publicId,
            message: 'Job started in background. Use status tool to poll.',
          }),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          jobId: job.id,
          sessionId: job.backendSessionId ? publicId : undefined,
          content: job.result ?? job.error ?? '',
          backend: job.backend,
          model: job.model,
        }),
      }],
    };
  }

  // ── Chat Reply ────────────────────────────────────────────

  private async handleChatReply(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = args.prompt as string;
    const sessionId = args.sessionId as string | undefined;
    const background = args.background === true;

    // Block background=true: see handleChat for rationale (anthropics/claude-code#47936).
    if (background) {
      throw new Error(
        'llm chat-reply background=true is DISABLED. ' +
        'Background execution triggers an upstream Claude Code harness bug ' +
        '(anthropics/claude-code#47936) that makes the parent agent end its turn ' +
        'instead of polling status/result. Call this tool synchronously (omit `background` ' +
        'or set it to false) and await the result inline.'
      );
    }

    const session = sessionId ? sessionStore.get(sessionId) : undefined;
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}. Use 'chat' first to start a session.`);
    }

    const job = await jobRunner.startJob({
      kind: 'chat',
      prompt,
      backend: session.backend,
      model: session.model,
      sessionOptions: { model: session.model },
      sessionId: session.publicId,
      backendSessionId: session.backendSessionId,
      background,
    });

    // If synchronous and completed, update session
    if (!background && job.status === 'completed') {
      if (job.backendSessionId && job.backendSessionId !== session.backendSessionId) {
        sessionStore.updateBackendSessionId(session.publicId, job.backendSessionId);
      } else {
        sessionStore.touch(session.publicId);
      }
    }

    if (background) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            jobId: job.id,
            status: job.status,
            sessionId: session.publicId,
            message: 'Job started in background. Use status tool to poll.',
          }),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          jobId: job.id,
          sessionId: session.publicId,
          content: job.result ?? job.error ?? '',
          backend: session.backend,
        }),
      }],
    };
  }

  // ── Status ────────────────────────────────────────────────

  private handleStatus(args: Record<string, unknown>): ToolResult {
    const jobId = args.jobId as string | undefined;

    if (jobId) {
      const job = jobStore.get(jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);

      // If completed in background, save session now (idempotent via sessionSaved flag)
      ensureSessionSaved(job);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: job.id,
            kind: job.kind,
            status: job.status,
            phase: job.phase,
            backend: job.backend,
            model: job.model,
            sessionId: job.sessionId,
            promptSummary: job.promptSummary,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            hasResult: job.status === 'completed',
            error: job.error,
          }),
        }],
      };
    }

    // List all active + recent jobs
    const jobs = jobStore.getAll()
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 20)
      .map(j => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        phase: j.phase,
        backend: j.backend,
        promptSummary: j.promptSummary,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
      }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ jobs, total: jobStore.getAll().length }),
      }],
    };
  }

  // ── Result ────────────────────────────────────────────────

  private handleResult(args: Record<string, unknown>): ToolResult {
    const jobId = args.jobId as string;
    const job = jobStore.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);

    if (job.status === 'running' || job.status === 'queued') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            jobId: job.id,
            status: job.status,
            phase: job.phase,
            message: 'Job is still running. Use status to check progress.',
          }),
        }],
      };
    }

    // Save session on first result retrieval for background jobs (idempotent)
    ensureSessionSaved(job);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          jobId: job.id,
          status: job.status,
          sessionId: job.sessionId,
          content: job.result ?? null,
          error: job.error ?? null,
          backend: job.backend,
          model: job.model,
        }),
      }],
    };
  }

  // ── Cancel ────────────────────────────────────────────────

  private handleCancel(args: Record<string, unknown>): ToolResult {
    const jobId = args.jobId as string;
    const job = jobRunner.cancel(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          jobId: job.id,
          status: job.status,
          message: job.status === 'cancelled' ? 'Job cancelled.' : `Job already ${job.status}.`,
        }),
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
