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
import * as path from 'path';
import { StderrLogger } from '../_shared/stderr-logger.js';
import {
  CronStorage,
  isValidCronExpression,
  isValidCronName,
} from '../_shared/cron-storage.js';

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
  const { name, expression, prompt, channel, threadTs, mode, model_type, model_name, reasoning_effort, fast_mode, target } = args;

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

  // Validate mode
  const effectiveMode = mode || 'default';
  if (effectiveMode !== 'default' && effectiveMode !== 'fastlane') {
    return { text: `Error: Invalid mode '${mode}'. Use 'default' or 'fastlane'`, isError: true };
  }

  // Validate target
  const effectiveTarget = target || 'channel';
  if (!['channel', 'thread', 'dm'].includes(effectiveTarget)) {
    return { text: `Error: Invalid target '${target}'. Use 'channel', 'thread', or 'dm'`, isError: true };
  }
  if (effectiveTarget === 'thread' && !threadTs) {
    return { text: 'Error: threadTs is required when target is "thread"', isError: true };
  }

  // Build model config
  const effectiveModelType = model_type || 'default';
  let modelConfig: import('../_shared/cron-storage.js').CronModelConfig | undefined;
  if (effectiveModelType !== 'default') {
    if (effectiveModelType === 'fast') {
      modelConfig = { type: 'fast' };
    } else if (effectiveModelType === 'custom') {
      if (!model_name) {
        return { text: 'Error: model_name is required when model_type is "custom"', isError: true };
      }
      modelConfig = {
        type: 'custom',
        model: model_name,
        reasoningEffort: reasoning_effort || undefined,
        fastMode: fast_mode ?? undefined,
      };
    } else {
      return { text: `Error: Invalid model_type '${model_type}'. Use 'default', 'fast', or 'custom'`, isError: true };
    }
  }

  try {
    const job = storage.addJob({
      name,
      expression,
      prompt,
      owner: context.user,
      channel: targetChannel,
      threadTs: threadTs || null,
      mode: effectiveMode === 'default' ? undefined : effectiveMode,
      modelConfig,
      target: effectiveTarget === 'channel' ? undefined : effectiveTarget as 'thread' | 'dm',
    });

    const modeStr = effectiveMode === 'fastlane' ? ' | mode: fastlane' : '';
    const modelStr = modelConfig ? ` | model: ${modelConfig.type}${modelConfig.model ? `(${modelConfig.model})` : ''}` : '';
    const targetStr = effectiveTarget !== 'channel' ? ` | target: ${effectiveTarget}` : '';
    return {
      text: `Cron job '${job.name}' created.\nID: ${job.id}\nExpression: ${job.expression}\nChannel: ${job.channel}${modeStr}${modelStr}${targetStr}\nPrompt: ${job.prompt}`,
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

function handleHistory(args: Record<string, any>, context: CronContext, storage: CronStorage): { text: string; isError: boolean } {
  const { name, limit } = args;
  const effectiveLimit = typeof limit === 'number' && limit > 0 ? limit : 10;

  const history = storage.getExecutionHistory(
    name || undefined,
    context.user,
    effectiveLimit,
  );

  if (history.length === 0) {
    return { text: name ? `No execution history for '${name}'.` : 'No cron execution history.', isError: false };
  }

  const lines = history.map(r => {
    const status = r.status === 'success' ? '✅' : r.status === 'failed' ? '❌' : '⏳';
    const time = r.executedAt.slice(0, 19).replace('T', ' ');
    const errPart = r.error ? ` | err: ${r.error.substring(0, 80)}` : '';
    return `${status} ${time} | **${r.jobName}** | ${r.executionPath}${errPart}`;
  });

  const header = name ? `Execution history for '${name}'` : 'Cron execution history';
  return { text: `${header} (${history.length}):\n${lines.join('\n')}`, isError: false };
}

function handleList(context: CronContext, storage: CronStorage): { text: string; isError: boolean } {
  const jobs = storage.getJobsByOwner(context.user);

  if (jobs.length === 0) {
    return { text: 'No cron jobs registered.', isError: false };
  }

  const lines = jobs.map(j => {
    const modeStr = j.mode === 'fastlane' ? ' | ⚡fastlane' : '';
    const modelStr = j.modelConfig ? ` | model:${j.modelConfig.type}${j.modelConfig.model ? `(${j.modelConfig.model})` : ''}` : '';
    const targetStr = j.target ? ` | 🎯${j.target}` : '';
    return `- **${j.name}** | \`${j.expression}\` | ch:${j.channel}${modeStr}${modelStr}${targetStr} | last: ${j.lastRunMinute || 'never'}\n  prompt: ${j.prompt.substring(0, 100)}`;
  });

  return { text: `Registered cron jobs (${jobs.length}):\n${lines.join('\n')}`, isError: false };
}

// --- Server ---

class CronMcpServer {
  private server: Server;
  private context: CronContext;
  private storage: CronStorage;

  constructor() {
    this.context = parseCronContext(process.env.SOMA_CRON_CONTEXT);
    // Use SOMA_DATA_DIR from parent process to align with CronScheduler's storage path.
    // Without this, MCP subprocess uses process.cwd() which may differ from the app's DATA_DIR.
    const dataDir = process.env.SOMA_DATA_DIR;
    const cronFilePath = dataDir
      ? path.join(dataDir, 'cron-jobs.json')
      : undefined;
    this.storage = new CronStorage(cronFilePath);
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
              mode: { type: 'string', enum: ['default', 'fastlane'], description: 'Execution mode. default: queue behind busy sessions. fastlane: always create new thread immediately.' },
              target: { type: 'string', enum: ['channel', 'thread', 'dm'], description: 'Delivery target. channel: new message in channel (default). thread: reply in existing thread (requires threadTs). dm: direct message to cron owner.' },
              model_type: { type: 'string', enum: ['default', 'fast', 'custom'], description: 'Model selection. default: use session model. fast: use sonnet. custom: specify model_name.' },
              model_name: { type: 'string', description: 'Model identifier when model_type=custom (e.g. "claude-sonnet-4-20250514")' },
              reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Reasoning effort for custom model' },
              fast_mode: { type: 'boolean', description: 'Enable fast mode for custom model' },
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
        {
          name: 'cron_history',
          description: 'Show execution history for cron jobs. Shows when jobs ran, whether they succeeded or failed, and the execution path (idle inject, busy queue, new thread).',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Filter by cron job name. Omit for all jobs.' },
              limit: { type: 'number', description: 'Max records to return (default: 10)' },
            },
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
        case 'cron_history':
          result = handleHistory(args, this.context, this.storage);
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
