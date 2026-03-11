/**
 * AgentClient - HTTP client for communicating with sub-agents.
 *
 * Handles typed RPC (request/response) with timeout, retry, and error handling.
 * Each sub-agent exposes a standard HTTP API (health, execute, sessions).
 */

import { Logger } from '../logger';
import {
  AgentDescriptor,
  AgentHealthResponse,
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentTaskPayload,
  AgentTaskResult,
} from './types';

export class AgentClient {
  private logger: Logger;
  private descriptor: AgentDescriptor;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor;
    this.baseUrl = descriptor.transport.baseUrl.replace(/\/$/, '');
    this.timeoutMs = descriptor.transport.timeoutMs;
    this.logger = new Logger(`AgentClient:${descriptor.id}`);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<AgentHealthResponse> {
    return this.request<AgentHealthResponse>('GET', '/health', undefined, 5_000);
  }

  /**
   * Execute a task on the sub-agent
   */
  async execute(
    requestId: string,
    task: AgentTaskPayload,
    source?: { channel: string; threadTs?: string; userId: string },
  ): Promise<AgentTaskResult> {
    const body: AgentExecuteRequest = {
      requestId,
      task,
      source,
    };

    const start = Date.now();

    try {
      const response = await this.request<AgentExecuteResponse>(
        'POST',
        '/execute',
        body,
        this.timeoutMs,
      );

      const durationMs = Date.now() - start;

      return {
        requestId: response.requestId,
        agentId: this.descriptor.id,
        ok: response.ok,
        content: response.content,
        sessionId: response.sessionId,
        model: response.model,
        backend: response.backend,
        durationMs,
        error: response.error,
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);

      // Classify error code based on root cause
      let code: string;
      let retriable: boolean;
      if (error instanceof DOMException && error.name === 'AbortError') {
        code = 'AGENT_TIMEOUT';
        retriable = true;
      } else if (error instanceof TypeError || message.includes('fetch')) {
        code = 'AGENT_UNREACHABLE';
        retriable = true;
      } else if (message.startsWith('HTTP 4')) {
        code = 'AGENT_CLIENT_ERROR';
        retriable = false;
      } else if (message.startsWith('HTTP 5')) {
        code = 'AGENT_SERVER_ERROR';
        retriable = true;
      } else {
        code = 'AGENT_ERROR';
        retriable = false;
      }

      this.logger.error('Task execution failed', {
        requestId,
        taskType: task.type,
        durationMs,
        error: message,
        errorCode: code,
      });

      return {
        requestId,
        agentId: this.descriptor.id,
        ok: false,
        durationMs,
        error: {
          code,
          message,
          retriable,
        },
      };
    }
  }

  /**
   * Generic HTTP request with timeout
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeout?: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const effectiveTimeout = timeout ?? this.timeoutMs;

    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      let serializedBody: string | undefined;
      if (body && method !== 'GET') {
        serializedBody = JSON.stringify(body);
        options.body = serializedBody;
      }

      this.logger.debug(`${method} ${path}`, {
        timeout: effectiveTimeout,
        bodySize: serializedBody?.length ?? 0,
      });

      const response = await fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
      }

      // Use text() + JSON.parse() for better error context on non-JSON responses
      const responseText = await response.text();
      try {
        return JSON.parse(responseText) as T;
      } catch (parseError) {
        throw new Error(
          `Invalid JSON from ${url}: ${parseError instanceof Error ? parseError.message : String(parseError)} ` +
          `(body preview: ${responseText.slice(0, 200)})`,
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${effectiveTimeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get agent descriptor
   */
  getDescriptor(): AgentDescriptor {
    return this.descriptor;
  }
}
