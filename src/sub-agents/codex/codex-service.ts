/**
 * CodexService - Core service for the Codex sub-agent.
 *
 * Wraps McpClient → codex mcp-server for LLM chat functionality.
 * Manages sessions, handles task execution, and provides health info.
 *
 * This is the brain of the codex sub-agent. The HTTP API layer
 * delegates all work to this service.
 */

import { McpClient, createCodexClient } from '../../mcp-client';
import { Logger } from '../../logger';
import {
  AgentTaskPayload,
  AgentExecuteResponse,
  AgentHealthResponse,
} from '../../agent/types';

interface CodexSession {
  sessionId: string;
  model: string;
  createdAt: number;
  lastActivityAt: number;
}

export class CodexService {
  private logger = new Logger('CodexService');
  private client: McpClient | null = null;
  private startPromise: Promise<void> | null = null;
  private sessions = new Map<string, CodexSession>();
  private startedAt = Date.now();
  private defaultModel: string;

  constructor(defaultModel: string = 'gpt-5.3-codex') {
    this.defaultModel = defaultModel;
  }

  /**
   * Start the codex MCP backend.
   * Guarded against concurrent calls — subsequent callers await the same promise.
   */
  async start(): Promise<void> {
    if (this.client?.isReady()) {
      this.logger.warn('Codex client already running');
      return;
    }

    // Guard concurrent start() calls: second caller awaits the first
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    this.logger.info('Starting codex MCP backend', { defaultModel: this.defaultModel });

    try {
      this.client = createCodexClient({ model: this.defaultModel });
      await this.client.start();
      this.logger.info('Codex MCP backend started');
    } catch (error) {
      this.logger.error('Failed to start codex backend', error);
      this.client = null;
      throw error;
    }
  }

  /**
   * Stop the codex MCP backend
   */
  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.stop();
      } catch (error) {
        this.logger.warn('Error during codex client shutdown', { error: String(error) });
      }
      this.client = null;
    }
    this.sessions.clear();
    this.logger.info('Codex service stopped');
  }

  /**
   * Check if the service is ready
   */
  isReady(): boolean {
    return this.client?.isReady() ?? false;
  }

  /**
   * Execute a task
   */
  async execute(requestId: string, task: AgentTaskPayload): Promise<AgentExecuteResponse> {
    if (!this.client?.isReady()) {
      // Try to auto-start
      try {
        await this.start();
      } catch (error) {
        return {
          requestId,
          ok: false,
          error: {
            code: 'BACKEND_UNAVAILABLE',
            message: 'Codex backend is not available. Is codex CLI installed?',
            retriable: true,
          },
        };
      }
    }

    switch (task.type) {
      case 'llm_chat':
        return this.handleChat(requestId, task);
      case 'llm_chat_reply':
        return this.handleChatReply(requestId, task);
      case 'health_check':
        return { requestId, ok: true, content: 'healthy' };
      default:
        return {
          requestId,
          ok: false,
          error: {
            code: 'UNSUPPORTED_TASK',
            message: `Task type '${task.type}' is not supported by codex agent`,
            retriable: false,
          },
        };
    }
  }

  /**
   * Handle new chat session
   */
  private async handleChat(requestId: string, task: AgentTaskPayload): Promise<AgentExecuteResponse> {
    if (!task.prompt) {
      return {
        requestId,
        ok: false,
        error: { code: 'MISSING_PROMPT', message: 'Prompt is required', retriable: false },
      };
    }

    const model = task.model || this.defaultModel;
    const start = Date.now();

    try {
      const args: Record<string, unknown> = {
        prompt: task.prompt,
        model,
      };

      if (task.cwd) args.cwd = task.cwd;
      args.config = { model_reasoning_effort: 'xhigh', ...task.config };

      this.logger.info('Executing chat', { requestId, model, promptLength: task.prompt.length });

      const client = this.client;
      if (!client) {
        throw new Error('Codex client became unavailable after start()');
      }

      const result = await client.callTool('codex', args, 600_000);
      const durationMs = Date.now() - start;

      const { threadId, content } = this.parseToolResult(result, requestId);

      // Store session
      if (threadId) {
        this.sessions.set(threadId, {
          sessionId: threadId,
          model,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        });
      }

      this.logger.info('Chat completed', { requestId, durationMs, sessionId: threadId });

      return {
        requestId,
        ok: true,
        content,
        sessionId: threadId,
        model,
        backend: 'codex',
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Chat failed', { requestId, durationMs, error: message });

      return {
        requestId,
        ok: false,
        durationMs,
        error: {
          code: 'CHAT_FAILED',
          message,
          retriable: true,
        },
      };
    }
  }

  /**
   * Handle chat reply (continue session)
   */
  private async handleChatReply(requestId: string, task: AgentTaskPayload): Promise<AgentExecuteResponse> {
    if (!task.prompt) {
      return {
        requestId,
        ok: false,
        error: { code: 'MISSING_PROMPT', message: 'Prompt is required', retriable: false },
      };
    }

    if (!task.sessionId) {
      return {
        requestId,
        ok: false,
        error: { code: 'MISSING_SESSION', message: 'Session ID is required for chat reply', retriable: false },
      };
    }

    const start = Date.now();

    try {
      const args: Record<string, unknown> = {
        prompt: task.prompt,
        threadId: task.sessionId,
      };

      this.logger.info('Executing chat reply', { requestId, sessionId: task.sessionId });

      const client = this.client;
      if (!client) {
        throw new Error('Codex client became unavailable after start()');
      }

      const result = await client.callTool('codex-reply', args, 600_000);
      const durationMs = Date.now() - start;

      const { threadId: newThreadId, content } = this.parseToolResult(result, requestId, task.sessionId);

      // Update session
      const session = this.sessions.get(task.sessionId);
      if (session) {
        session.lastActivityAt = Date.now();
        if (newThreadId !== task.sessionId) {
          this.sessions.delete(task.sessionId);
          this.sessions.set(newThreadId, { ...session, sessionId: newThreadId });
        }
      }

      this.logger.info('Chat reply completed', { requestId, durationMs });

      return {
        requestId,
        ok: true,
        content,
        sessionId: newThreadId,
        backend: 'codex',
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Chat reply failed', { requestId, durationMs, error: message });

      return {
        requestId,
        ok: false,
        durationMs,
        error: {
          code: 'CHAT_REPLY_FAILED',
          message,
          retriable: true,
        },
      };
    }
  }

  /**
   * Get health information
   */
  getHealth(): AgentHealthResponse {
    return {
      agentId: 'codex',
      status: this.isReady() ? 'healthy' : 'unhealthy',
      uptime: Date.now() - this.startedAt,
      activeSessions: this.sessions.size,
      version: '1.0.0',
    };
  }

  /**
   * Get active session count
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Parse MCP tool result into threadId + content.
   * Centralizes the untyped access to MCP response shape.
   */
  private parseToolResult(
    result: unknown,
    requestId: string,
    fallbackThreadId?: string,
  ): { threadId: string; content: string } {
    const r = result as any;
    const text = r.content?.find((c: any) => c.type === 'text')?.text || '';
    let parsed: any = {};
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      this.logger.debug('Failed to parse MCP response as JSON, using raw text', { requestId, error: String(parseErr) });
      parsed = { content: text };
    }
    const threadId = r.structuredContent?.threadId || parsed.threadId || fallbackThreadId || '';
    const content = r.structuredContent?.content || parsed.content || text;
    return {
      threadId,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    };
  }

  /**
   * Clean up stale sessions (older than maxAge ms)
   */
  cleanupStaleSessions(maxAgeMs: number = 3600_000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > maxAgeMs) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info('Cleaned up stale sessions', { cleaned });
    }
    return cleaned;
  }
}
