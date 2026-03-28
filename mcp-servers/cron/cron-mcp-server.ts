#!/usr/bin/env node

/**
 * Cron MCP Server — Exposes cron CRUD tools to the model.
 * Trace: docs/cron-scheduler/trace.md, Scenarios 2-3
 *
 * Pattern: mcp-servers/model-command/model-command-mcp-server.ts
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StderrLogger } from '../_shared/stderr-logger.js';
import {
  CronStorage,
  isValidCronExpression,
  isValidCronName,
} from '../../src/cron-storage.js';

const logger = new StderrLogger('CronMcpServer');

// --- Context parsing ---

interface CronContext {
  user: string;
  channel: string;
  threadTs?: string;
}

function parseCronContext(raw?: string): CronContext {
  if (!raw) {
    logger.warn('SOMA_CRON_CONTEXT not set, using defaults');
    return { user: 'unknown', channel: 'unknown' };
  }
  try {
    return JSON.parse(raw) as CronContext;
  } catch {
    logger.warn('Failed to parse SOMA_CRON_CONTEXT');
    return { user: 'unknown', channel: 'unknown' };
  }
}

// --- Tool handlers ---

function handleCreate(args: Record<string, any>, context: CronContext, storage: CronStorage): { text: string; isError: boolean } {
  const { name, expression, prompt, channel, threadTs } = args;

  // Validation
  if (!name || !expression || !prompt) {
    return { text: 'Error: name, expression, and prompt are required', isError: true };
  }

  if (!isValidCronName(name)) {
    return { text: `Error: Invalid cron name '${name}'. Use alphanumeric, hyphens, underscores (1-64 chars)`, isError: true };
  }

  if (!isValidCronExpression(expression)) {
    return { text: `Error: Invalid cron expression '${expression}'. Use 5-field format: min hour dom mon dow`, isError: true };
  }

  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 4000) {
    return { text: 'Error: prompt must be a non-empty string (max 4000 chars)', isError: true };
  }

  const targetChannel = channel || context.channel;
  if (!targetChannel || (!targetChannel.startsWith('C') && !targetChannel.startsWith('D'))) {
    return { text: `Error: Invalid channel '${targetChannel}'`, isError: true };
  }

  try {
    const job = storage.addJob({
      name,
      expression,
      prompt,
      owner: context.user,
      channel: targetChannel,
      threadTs: threadTs || null,
    });

    return {
      text: `Cron job '${job.name}' created.\nID: ${job.id}\nExpression: ${job.expression}\nChannel: ${job.channel}\nPrompt: ${job.prompt}`,
      isError: false,
    };
  } catch (error: any) {
    if (error.message?.startsWith('DUPLICATE_NAME')) {
      return { text: `Error: Cron job '${name}' already exists for this user`, isError: true };
    }
    return { text: `Error creating cron job: ${error.message}`, isError: true };
  }
}

function handleDelete(args: Record<string, any>, context: CronContext, storage: CronStorage): { text: string; isError: boolean } {
  const { name } = args;
  if (!name) {
    return { text: 'Error: name is required', isError: true };
  }

  const removed = storage.removeJob(context.user, name);
  if (!removed) {
    return { text: `Error: Cron job '${name}' not found`, isError: true };
  }

  return { text: `Cron job '${name}' deleted`, isError: false };
}

function handleList(context: CronContext, storage: CronStorage): { text: string; isError: boolean } {
  const jobs = storage.getJobsByOwner(context.user);

  if (jobs.length === 0) {
    return { text: 'No cron jobs registered.', isError: false };
  }

  const lines = jobs.map(j =>
    `- **${j.name}** | \`${j.expression}\` | ch:${j.channel} | last: ${j.lastRunDate || 'never'}\n  prompt: ${j.prompt.substring(0, 100)}`
  );

  return { text: `Registered cron jobs (${jobs.length}):\n${lines.join('\n')}`, isError: false };
}

// --- Server ---

class CronMcpServer {
  private server: Server;
  private context: CronContext;
  private storage: CronStorage;

  constructor() {
    this.context = parseCronContext(process.env.SOMA_CRON_CONTEXT);
    this.storage = new CronStorage();
    this.server = new Server(
      { name: 'cron', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'cron_create',
          description: 'Register a recurring cron job. When the cron fires, the prompt is injected as a user message into the target session.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Unique name for the cron job (alphanumeric, hyphens, underscores, 1-64 chars)' },
              expression: { type: 'string', description: '5-field cron expression: min hour dom mon dow. Example: "0 9 * * 1-5" (weekdays at 9am)' },
              prompt: { type: 'string', description: 'Message to inject when cron fires (max 4000 chars)' },
              channel: { type: 'string', description: 'Target Slack channel ID. Defaults to current channel.' },
              threadTs: { type: 'string', description: 'Target thread timestamp. If omitted, uses active session or creates new thread.' },
            },
            required: ['name', 'expression', 'prompt'],
          },
        },
        {
          name: 'cron_delete',
          description: 'Delete a registered cron job by name.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name of the cron job to delete' },
            },
            required: ['name'],
          },
        },
        {
          name: 'cron_list',
          description: 'List all registered cron jobs for the current user.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      const toolName = request.params.name;
      const args = request.params.arguments || {};

      let result: { text: string; isError: boolean };

      switch (toolName) {
        case 'cron_create':
          result = handleCreate(args, this.context, this.storage);
          break;
        case 'cron_delete':
          result = handleDelete(args, this.context, this.storage);
          break;
        case 'cron_list':
          result = handleList(this.context, this.storage);
          break;
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      return {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError,
      };
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.debug('Cron MCP server started');
  }
}

// Singleton pattern
let serverInstance: CronMcpServer | null = null;

export function getCronServer(): CronMcpServer {
  if (!serverInstance) {
    serverInstance = new CronMcpServer();
  }
  return serverInstance;
}

// Direct execution entry point
if (require.main === module) {
  getCronServer()
    .run()
    .catch((error) => {
      logger.error('Cron MCP server error', error);
      process.exit(1);
    });
}
