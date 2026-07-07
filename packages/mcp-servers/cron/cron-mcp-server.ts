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
import { CronStorage, isValidCronExpression, isValidCronName } from '@soma/process-shared/cron/cron-storage.js';
import { StderrLogger } from '@soma/process-shared/stderr-logger.js';
import * as path from 'path';

const logger = new StderrLogger('CronMcpServer');

// --- Context parsing ---

interface CronContext {
  user: string;
  channel: string;
  threadTs?: string;
  /** Computed by the parent process (ADMIN_USERS) — cannot be forged by the model. */
  isAdmin?: boolean;
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

type CronModelConfig = import('@soma/process-shared/cron/cron-storage.js').CronModelConfig;
type CronJobPatch = import('@soma/process-shared/cron/cron-storage.js').CronJobPatch;
type CronJob = import('@soma/process-shared/cron/cron-storage.js').CronJob;

interface ValidatedCreateInput {
  name: string;
  expression: string;
  prompt: string;
  targetChannel: string;
  threadTs: string | undefined;
  effectiveMode: 'default' | 'fastlane';
  effectiveTarget: 'channel' | 'thread' | 'dm';
}

type ValidationResult = { ok: true; parsed: ValidatedCreateInput } | { ok: false; errorText: string };

type ModelConfigResult = { ok: true; modelConfig: CronModelConfig | undefined } | { ok: false; errorText: string };

function validateRequiredArgs(args: Record<string, any>): string | null {
  const { name, expression, prompt } = args;
  if (!name || !expression || !prompt) {
    return 'Error: name, expression, and prompt are required';
  }
  if (!isValidCronName(name)) {
    return `Error: Invalid cron name '${name}'. Use alphanumeric, hyphens, underscores (1-64 chars)`;
  }
  if (!isValidCronExpression(expression)) {
    return `Error: Invalid cron expression '${expression}'. Use 5-field format: min hour dom mon dow`;
  }
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 4000) {
    return 'Error: prompt must be a non-empty string (max 4000 chars)';
  }
  return null;
}

function validateModeAndTarget(
  args: Record<string, any>,
):
  | { ok: true; effectiveMode: 'default' | 'fastlane'; effectiveTarget: 'channel' | 'thread' | 'dm' }
  | { ok: false; errorText: string } {
  const { threadTs, mode, target } = args;

  const effectiveMode = mode || 'default';
  if (effectiveMode !== 'default' && effectiveMode !== 'fastlane') {
    return { ok: false, errorText: `Error: Invalid mode '${mode}'. Use 'default' or 'fastlane'` };
  }

  const effectiveTarget = target || 'channel';
  if (!['channel', 'thread', 'dm'].includes(effectiveTarget)) {
    return { ok: false, errorText: `Error: Invalid target '${target}'. Use 'channel', 'thread', or 'dm'` };
  }
  if (effectiveTarget === 'thread' && !threadTs) {
    return { ok: false, errorText: 'Error: threadTs is required when target is "thread"' };
  }
  return { ok: true, effectiveMode, effectiveTarget };
}

function validateCreateInput(args: Record<string, any>, context: CronContext): ValidationResult {
  const requiredErr = validateRequiredArgs(args);
  if (requiredErr) return { ok: false, errorText: requiredErr };

  const targetChannel = args.channel || context.channel;
  if (!targetChannel || (!targetChannel.startsWith('C') && !targetChannel.startsWith('D'))) {
    return { ok: false, errorText: `Error: Invalid channel '${targetChannel}'` };
  }

  const modeTarget = validateModeAndTarget(args);
  if (!modeTarget.ok) return { ok: false, errorText: modeTarget.errorText };

  return {
    ok: true,
    parsed: {
      name: args.name,
      expression: args.expression,
      prompt: args.prompt,
      targetChannel,
      threadTs: args.threadTs || undefined,
      effectiveMode: modeTarget.effectiveMode,
      effectiveTarget: modeTarget.effectiveTarget,
    },
  };
}

function buildModelConfig(args: Record<string, any>): ModelConfigResult {
  const { model_type, model_name, reasoning_effort, fast_mode } = args;
  const effectiveModelType = model_type || 'default';

  if (effectiveModelType === 'default') {
    return { ok: true, modelConfig: undefined };
  }
  if (effectiveModelType === 'fast') {
    return { ok: true, modelConfig: { type: 'fast' } };
  }
  if (effectiveModelType === 'custom') {
    if (!model_name) {
      return { ok: false, errorText: 'Error: model_name is required when model_type is "custom"' };
    }
    return {
      ok: true,
      modelConfig: {
        type: 'custom',
        model: model_name,
        reasoningEffort: reasoning_effort || undefined,
        fastMode: fast_mode ?? undefined,
      },
    };
  }
  return { ok: false, errorText: `Error: Invalid model_type '${model_type}'. Use 'default', 'fast', or 'custom'` };
}

function formatCreateSuccess(
  job: { name: string; id: string; expression: string; channel: string; prompt: string },
  effectiveMode: 'default' | 'fastlane',
  modelConfig: CronModelConfig | undefined,
  effectiveTarget: 'channel' | 'thread' | 'dm',
): string {
  const modeStr = effectiveMode === 'fastlane' ? ' | mode: fastlane' : '';
  const modelStr = modelConfig
    ? ` | model: ${modelConfig.type}${modelConfig.model ? `(${modelConfig.model})` : ''}`
    : '';
  const targetStr = effectiveTarget !== 'channel' ? ` | target: ${effectiveTarget}` : '';
  return `Cron job '${job.name}' created.\nID: ${job.id}\nExpression: ${job.expression}\nChannel: ${job.channel}${modeStr}${modelStr}${targetStr}\nPrompt: ${job.prompt}`;
}

export function handleCreate(
  args: Record<string, any>,
  context: CronContext,
  storage: CronStorage,
): { text: string; isError: boolean } {
  const validation = validateCreateInput(args, context);
  if (!validation.ok) {
    return { text: validation.errorText, isError: true };
  }
  const { name, expression, prompt, targetChannel, threadTs, effectiveMode, effectiveTarget } = validation.parsed;

  const modelResult = buildModelConfig(args);
  if (!modelResult.ok) {
    return { text: modelResult.errorText, isError: true };
  }
  const { modelConfig } = modelResult;

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
      target: effectiveTarget === 'channel' ? undefined : effectiveTarget,
    });
    return { text: formatCreateSuccess(job, effectiveMode, modelConfig, effectiveTarget), isError: false };
  } catch (error: any) {
    if (error.message?.startsWith('DUPLICATE_NAME')) {
      return { text: `Error: Cron job '${name}' already exists for this user`, isError: true };
    }
    return { text: `Error creating cron job: ${error.message}`, isError: true };
  }
}

/**
 * Resolve which owner's job the call addresses. Non-admins are always scoped
 * to themselves; admins may pass `owner` to address another user's job.
 */
function resolveTargetOwner(
  args: Record<string, any>,
  context: CronContext,
): { ok: true; owner: string } | { ok: false; errorText: string } {
  const requested = args.owner;
  if (requested && requested !== context.user) {
    if (context.isAdmin !== true) {
      return { ok: false, errorText: 'Error: owner parameter requires admin privileges' };
    }
    return { ok: true, owner: requested };
  }
  return { ok: true, owner: context.user };
}

export function handleDelete(
  args: Record<string, any>,
  context: CronContext,
  storage: CronStorage,
): { text: string; isError: boolean } {
  const { name } = args;
  if (!name) {
    return { text: 'Error: name is required', isError: true };
  }

  const ownerResult = resolveTargetOwner(args, context);
  if (!ownerResult.ok) {
    return { text: ownerResult.errorText, isError: true };
  }

  const removed = storage.removeJob(ownerResult.owner, name);
  if (!removed) {
    return { text: notFoundText(name, ownerResult.owner, context, storage), isError: true };
  }

  const ownerNote = ownerResult.owner !== context.user ? ` (owner: ${ownerResult.owner})` : '';
  return { text: `Cron job '${name}' deleted${ownerNote}`, isError: false };
}

/**
 * Not-found message. For admins addressing without `owner`, surface which
 * owner(s) hold a job with that name instead of silently failing —
 * admin cross-user edits must be explicit (owner param), never implicit.
 */
function notFoundText(name: string, resolvedOwner: string, context: CronContext, storage: CronStorage): string {
  if (context.isAdmin === true && resolvedOwner === context.user) {
    const owners = storage
      .getAll()
      .filter((j) => j.name === name)
      .map((j) => j.owner);
    if (owners.length > 0) {
      return `Error: Cron job '${name}' not found for you. Found under owner(s): ${owners.join(', ')} — pass the owner parameter to address it.`;
    }
  }
  return `Error: Cron job '${name}' not found`;
}

// --- cron_update ---

function buildUpdatePatch(
  args: Record<string, any>,
  job: CronJob,
): { ok: true; patch: CronJobPatch } | { ok: false; errorText: string } {
  const patch: CronJobPatch = {};

  if (args.expression !== undefined) {
    if (!isValidCronExpression(args.expression)) {
      return {
        ok: false,
        errorText: `Error: Invalid cron expression '${args.expression}'. Use 5-field format: min hour dom mon dow`,
      };
    }
    patch.expression = args.expression;
  }

  if (args.prompt !== undefined) {
    if (typeof args.prompt !== 'string' || args.prompt.length === 0 || args.prompt.length > 4000) {
      return { ok: false, errorText: 'Error: prompt must be a non-empty string (max 4000 chars)' };
    }
    patch.prompt = args.prompt;
  }

  if (args.channel !== undefined) {
    if (!args.channel.startsWith('C') && !args.channel.startsWith('D')) {
      return { ok: false, errorText: `Error: Invalid channel '${args.channel}'` };
    }
    patch.channel = args.channel;
  }

  if (args.mode !== undefined) {
    if (args.mode !== 'default' && args.mode !== 'fastlane') {
      return { ok: false, errorText: `Error: Invalid mode '${args.mode}'. Use 'default' or 'fastlane'` };
    }
    patch.mode = args.mode === 'default' ? null : args.mode;
  }

  if (args.model_type !== undefined) {
    const modelResult = buildModelConfig(args);
    if (!modelResult.ok) {
      return { ok: false, errorText: modelResult.errorText };
    }
    // 'default' → clear override: fire-time model = creator's current default model.
    patch.modelConfig = modelResult.modelConfig ?? null;
  }

  if (args.threadTs !== undefined) {
    patch.threadTs = args.threadTs;
  }
  if (args.clear_threadTs === true) {
    patch.threadTs = null;
  }

  if (args.target !== undefined) {
    if (!['channel', 'thread', 'dm'].includes(args.target)) {
      return { ok: false, errorText: `Error: Invalid target '${args.target}'. Use 'channel', 'thread', or 'dm'` };
    }
    if (args.target === 'channel') {
      // New-channel-message delivery: drop the target override and the thread anchor.
      patch.target = null;
      patch.threadTs = null;
    } else if (args.target === 'dm') {
      patch.target = 'dm';
      patch.threadTs = null;
    } else {
      patch.target = 'thread';
    }
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, errorText: 'Error: nothing to update — provide at least one field to change' };
  }

  // Invariant: thread delivery always has a thread anchor.
  const finalTarget = patch.target !== undefined ? patch.target : job.target;
  const finalThreadTs = patch.threadTs !== undefined ? patch.threadTs : job.threadTs;
  if (finalTarget === 'thread' && !finalThreadTs) {
    return { ok: false, errorText: 'Error: threadTs is required when target is "thread"' };
  }

  return { ok: true, patch };
}

function describeModel(modelConfig: CronModelConfig | undefined): string {
  if (!modelConfig || modelConfig.type === 'default') return 'default(creator current model)';
  if (modelConfig.type === 'fast') return 'fast';
  return `custom(${modelConfig.model ?? '?'})`;
}

function describeTarget(job: CronJob): string {
  const target = job.target ?? 'channel';
  return job.threadTs ? `${target}(ts:${job.threadTs})` : target;
}

export function handleUpdate(
  args: Record<string, any>,
  context: CronContext,
  storage: CronStorage,
): { text: string; isError: boolean } {
  const { name } = args;
  if (!name) {
    return { text: 'Error: name is required', isError: true };
  }

  const ownerResult = resolveTargetOwner(args, context);
  if (!ownerResult.ok) {
    return { text: ownerResult.errorText, isError: true };
  }

  const jobs = storage.getJobsByOwner(ownerResult.owner);
  const job = jobs.find((j) => j.name === name);
  if (!job) {
    return { text: notFoundText(name, ownerResult.owner, context, storage), isError: true };
  }

  const patchResult = buildUpdatePatch(args, job);
  if (!patchResult.ok) {
    return { text: patchResult.errorText, isError: true };
  }

  const updated = storage.updateJob(ownerResult.owner, name, patchResult.patch);
  if (!updated) {
    return { text: `Error: Cron job '${name}' not found`, isError: true };
  }

  const ownerNote = ownerResult.owner !== context.user ? ` (owner: ${ownerResult.owner})` : '';
  const modeLine = updated.mode === 'fastlane' ? '\nMode: fastlane' : '';
  return {
    text:
      `Cron job '${updated.name}' updated${ownerNote}.\n` +
      `Expression: ${updated.expression}\n` +
      `Channel: ${updated.channel}${modeLine}\n` +
      `Model: ${describeModel(updated.modelConfig)}\n` +
      `Target: ${describeTarget(updated)}\n` +
      `Prompt: ${updated.prompt.substring(0, 200)}`,
    isError: false,
  };
}

function handleHistory(
  args: Record<string, any>,
  context: CronContext,
  storage: CronStorage,
): { text: string; isError: boolean } {
  const { name, limit } = args;
  const effectiveLimit = typeof limit === 'number' && limit > 0 ? limit : 10;

  const history = storage.getExecutionHistory(name || undefined, context.user, effectiveLimit);

  if (history.length === 0) {
    return { text: name ? `No execution history for '${name}'.` : 'No cron execution history.', isError: false };
  }

  const lines = history.map((r) => {
    const status = r.status === 'success' ? '✅' : r.status === 'failed' ? '❌' : '⏳';
    const time = r.executedAt.slice(0, 19).replace('T', ' ');
    const errPart = r.error ? ` | err: ${r.error.substring(0, 80)}` : '';
    return `${status} ${time} | **${r.jobName}** | ${r.executionPath}${errPart}`;
  });

  const header = name ? `Execution history for '${name}'` : 'Cron execution history';
  return { text: `${header} (${history.length}):\n${lines.join('\n')}`, isError: false };
}

export function handleList(context: CronContext, storage: CronStorage): { text: string; isError: boolean } {
  const isAdmin = context.isAdmin === true;
  const jobs = isAdmin ? storage.getAll() : storage.getJobsByOwner(context.user);

  if (jobs.length === 0) {
    return { text: 'No cron jobs registered.', isError: false };
  }

  const lines = jobs.map((j) => {
    const ownerStr = isAdmin ? ` | owner:<@${j.owner}>` : '';
    const modeStr = j.mode === 'fastlane' ? ' | ⚡fastlane' : '';
    // Model and output target are always rendered — defaults made explicit so
    // the current setting is visible without reading the schema docs.
    const modelStr = ` | model:${describeModel(j.modelConfig)}`;
    const targetStr = ` | target:${describeTarget(j)}`;
    return `- **${j.name}**${ownerStr} | \`${j.expression}\` | ch:${j.channel}${modeStr}${modelStr}${targetStr} | last: ${j.lastRunMinute || 'never'}\n  prompt: ${j.prompt.substring(0, 100)}`;
  });

  const header = isAdmin
    ? `Registered cron jobs (${jobs.length}) — admin view, all users`
    : `Registered cron jobs (${jobs.length})`;
  return { text: `${header}:\n${lines.join('\n')}`, isError: false };
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
      : path.join(process.cwd(), 'data', 'cron-jobs.json');
    this.storage = new CronStorage(cronFilePath);
    this.server = new Server({ name: 'cron', version: '1.0.0' }, { capabilities: { tools: {} } });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'cron_create',
          description:
            'Register a recurring cron job. When the cron fires, the prompt is injected as a user message into the target session.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Unique name for the cron job (alphanumeric, hyphens, underscores, 1-64 chars)',
              },
              expression: {
                type: 'string',
                description: '5-field cron expression: min hour dom mon dow. Example: "0 9 * * 1-5" (weekdays at 9am)',
              },
              prompt: { type: 'string', description: 'Message to inject when cron fires (max 4000 chars)' },
              channel: { type: 'string', description: 'Target Slack channel ID. Defaults to current channel.' },
              threadTs: {
                type: 'string',
                description: 'Target thread timestamp. If omitted, uses active session or creates new thread.',
              },
              mode: {
                type: 'string',
                enum: ['default', 'fastlane'],
                description:
                  'Execution mode. default: queue behind busy sessions. fastlane: always create new thread immediately.',
              },
              target: {
                type: 'string',
                enum: ['channel', 'thread', 'dm'],
                description:
                  'Delivery target. channel: new message in channel (default). thread: reply in existing thread (requires threadTs). dm: direct message to cron owner.',
              },
              model_type: {
                type: 'string',
                enum: ['default', 'fast', 'custom'],
                description:
                  "Model selection. default: use the creator's current default model at fire time. fast: use sonnet. custom: specify model_name.",
              },
              model_name: {
                type: 'string',
                description: 'Model identifier when model_type=custom (e.g. "claude-sonnet-4-20250514")',
              },
              reasoning_effort: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'Reasoning effort for custom model',
              },
              fast_mode: { type: 'boolean', description: 'Enable fast mode for custom model' },
            },
            required: ['name', 'expression', 'prompt'],
          },
        },
        {
          name: 'cron_update',
          description:
            'Update fields of an existing cron job (partial update — omitted fields stay unchanged). ' +
            "Model: model_type 'default' clears the override so the job uses the creator's current default model at fire time; 'fast' uses sonnet; 'custom' requires model_name. " +
            "Output: target 'channel' posts a new channel message (clears thread anchor); 'thread' replies in a thread (requires threadTs); 'dm' messages the job owner. " +
            "Admins may pass owner to update another user's job.",
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name of the cron job to update' },
              owner: {
                type: 'string',
                description: "Job owner's Slack user ID. Admin only — required to update another user's job.",
              },
              expression: { type: 'string', description: 'New 5-field cron expression: min hour dom mon dow' },
              prompt: { type: 'string', description: 'New prompt (max 4000 chars)' },
              channel: { type: 'string', description: 'New target Slack channel ID' },
              threadTs: { type: 'string', description: 'New thread timestamp (for target=thread)' },
              clear_threadTs: { type: 'boolean', description: 'Clear the stored thread anchor' },
              mode: {
                type: 'string',
                enum: ['default', 'fastlane'],
                description: 'Execution mode. default clears the fastlane override.',
              },
              target: {
                type: 'string',
                enum: ['channel', 'thread', 'dm'],
                description:
                  'Delivery target. channel: new message in channel. thread: reply in thread (requires threadTs). dm: direct message to job owner.',
              },
              model_type: {
                type: 'string',
                enum: ['default', 'fast', 'custom'],
                description:
                  "Model selection. default: use the creator's current default model at fire time. fast: use sonnet. custom: specify model_name.",
              },
              model_name: {
                type: 'string',
                description: 'Model identifier when model_type=custom (e.g. "claude-sonnet-4-20250514")',
              },
              reasoning_effort: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'Reasoning effort for custom model',
              },
              fast_mode: { type: 'boolean', description: 'Enable fast mode for custom model' },
            },
            required: ['name'],
          },
        },
        {
          name: 'cron_delete',
          description: "Delete a registered cron job by name. Admins may pass owner to delete another user's job.",
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name of the cron job to delete' },
              owner: {
                type: 'string',
                description: "Job owner's Slack user ID. Admin only — required to delete another user's job.",
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'cron_list',
          description:
            "List registered cron jobs with schedule, model, and output target. Non-admins see their own jobs; admins see all users' jobs with the owner shown.",
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'cron_history',
          description:
            'Show execution history for cron jobs. Shows when jobs ran, whether they succeeded or failed, and the execution path (idle inject, busy queue, new thread).',
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
        case 'cron_update':
          result = handleUpdate(args, this.context, this.storage);
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
