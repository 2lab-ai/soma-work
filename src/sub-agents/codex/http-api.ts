/**
 * Codex Sub-Agent HTTP API
 *
 * Exposes a Fastify HTTP server with standard endpoints:
 *   GET  /health   - Health check
 *   POST /execute  - Execute a task
 *
 * This is the ingress layer for the codex sub-agent.
 * All actual work is delegated to CodexService.
 */

import Fastify, { FastifyInstance } from 'fastify';
import { Logger } from '../../logger';
import { CodexService } from './codex-service';
import { AgentExecuteRequest, AgentExecuteResponse, AgentHealthResponse } from '../../agent/types';

const DEFAULT_PORT = 9100;
const DEFAULT_HOST = '127.0.0.1';

export interface CodexHttpApiOptions {
  port?: number;
  host?: string;
}

function invalidRequestError(requestId: string, message: string): AgentExecuteResponse {
  return {
    requestId,
    ok: false,
    error: { code: 'INVALID_REQUEST', message, retriable: false },
  };
}

export class CodexHttpApi {
  private logger = new Logger('CodexHttpApi');
  private server: FastifyInstance;
  private service: CodexService;
  private port: number;
  private host: string;

  constructor(service: CodexService, options?: CodexHttpApiOptions) {
    this.service = service;
    this.port = options?.port ?? (Number(process.env.CODEX_AGENT_PORT) || DEFAULT_PORT);
    this.host = options?.host ?? process.env.CODEX_AGENT_HOST ?? DEFAULT_HOST;

    this.server = Fastify({
      logger: false, // We use our own logger
      bodyLimit: 1_048_576, // 1 MB — prevents oversized payloads
    });

    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.server.get('/health', async (): Promise<AgentHealthResponse> => {
      return this.service.getHealth();
    });

    this.server.post<{ Body: AgentExecuteRequest }>('/execute', async (request, reply): Promise<AgentExecuteResponse> => {
      const body = request.body;
      if (!body || typeof body !== 'object') {
        return reply.code(400).send(invalidRequestError('unknown', 'Request body must be a JSON object'));
      }

      const { requestId, task, source } = body;

      if (!requestId || !task?.type) {
        return reply.code(400).send(invalidRequestError(requestId || 'unknown', 'Missing requestId or task.type'));
      }

      this.logger.info('Task received', {
        requestId,
        taskType: task.type,
        source: source ? `${source.channel}/${source.threadTs}` : 'none',
      });

      const result = await this.service.execute(requestId, task);

      this.logger.info('Task completed', {
        requestId,
        ok: result.ok,
        durationMs: result.durationMs,
      });

      return result;
    });

    this.server.get('/', async () => ({
      agent: 'codex',
      version: '1.0.0',
      status: this.service.isReady() ? 'ready' : 'starting',
      endpoints: [
        'GET  /health  - Health check',
        'POST /execute - Execute task',
      ],
    }));
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    try {
      await this.server.listen({ port: this.port, host: this.host });
      this.logger.info(`Codex sub-agent HTTP API listening on ${this.host}:${this.port}`);
    } catch (error) {
      this.logger.error('Failed to start HTTP API', error);
      throw error;
    }
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    await this.server.close();
    this.logger.info('Codex sub-agent HTTP API stopped');
  }

  /**
   * Get the server address
   */
  getAddress(): string {
    return `http://${this.host}:${this.port}`;
  }
}
