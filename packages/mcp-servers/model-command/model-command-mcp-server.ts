#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from '@soma/process-shared/mcp/base-mcp-server.js';
import { BaseMcpServer } from '@soma/process-shared/mcp/base-mcp-server.js';
import type { WorkflowType } from '@soma/process-shared/mcp/types.js';
import {
  getDefaultSessionSnapshot,
  listModelCommands,
  normalizeSessionSnapshot,
  registerHierarchicalMemoryStore,
  registerMemoryStore,
  registerRatingStore,
  registerSkillStore,
  runModelCommand,
  surfaceRefusal,
} from '@soma/process-shared/model-commands/catalog.js';
import { HierarchicalMemoryFileStore } from '@soma/process-shared/model-commands/hierarchical-memory-store.js';
import { readHostReceipt } from '@soma/process-shared/model-commands/host-receipt.js';
import { MemoryFileStore } from '@soma/process-shared/model-commands/memory-file-store.js';
import { SkillFileStore } from '@soma/process-shared/model-commands/skill-file-store.js';
import type {
  ModelCommandContext,
  ModelCommandListResponse,
  ModelCommandRunResponse,
} from '@soma/process-shared/model-commands/types.js';
import { validateModelCommandRunArgs } from '@soma/process-shared/model-commands/validator.js';
import { StderrLogger } from '@soma/process-shared/stderr-logger.js';

const logger = new StderrLogger('ModelCommandMCP');

function createDefaultContext(): ModelCommandContext {
  return {
    session: getDefaultSessionSnapshot(),
    renewState: null,
  };
}

export function parseModelCommandContext(rawContext: string | undefined): ModelCommandContext {
  if (!rawContext) {
    return createDefaultContext();
  }

  try {
    const parsed = JSON.parse(rawContext);
    if (!isRecord(parsed)) {
      return createDefaultContext();
    }

    return {
      channel: typeof parsed.channel === 'string' ? parsed.channel : undefined,
      threadTs: typeof parsed.threadTs === 'string' ? parsed.threadTs : undefined,
      user: typeof parsed.user === 'string' ? parsed.user : undefined,
      // A dashboard task (no Slack thread) — anything else reads as Slack.
      ...(parsed.surface === 'task' ? { surface: 'task' as const } : {}),
      workflow: parseWorkflowType(parsed.workflow),
      renewState:
        parsed.renewState === 'pending_save' || parsed.renewState === 'pending_load' ? parsed.renewState : null,
      session: normalizeSessionSnapshot(isRecord(parsed.session) ? (parsed.session as any) : undefined),
      ...(typeof parsed.receiptFile === 'string' && parsed.receiptFile ? { receiptFile: parsed.receiptFile } : {}),
    };
  } catch (error) {
    logger.warn('Failed to parse SOMA_COMMAND_CONTEXT, using default context', {
      error: (error as Error).message,
    });
    return createDefaultContext();
  }
}

export function buildModelCommandListResponse(context: ModelCommandContext): ModelCommandListResponse {
  return {
    type: 'model_command_list',
    commands: listModelCommands(context),
  };
}

let receiptCounter = 0;

export function buildModelCommandRunResponse(args: unknown, context: ModelCommandContext): ModelCommandRunResponse {
  const validated = validateModelCommandRunArgs(args);
  if (!validated.ok) {
    return {
      type: 'model_command_result',
      commandId: 'UNKNOWN',
      ok: false,
      error: validated.error,
    };
  }

  // A dashboard task has no Slack thread: say so before any thread-only check.
  const refused = surfaceRefusal(validated.request.commandId, context);
  if (refused) return refused;

  if (validated.request.commandId === 'SAVE_CONTEXT_RESULT' && context.renewState !== 'pending_save') {
    return {
      type: 'model_command_result',
      commandId: 'SAVE_CONTEXT_RESULT',
      ok: false,
      error: {
        code: 'CONTEXT_ERROR',
        message: 'SAVE_CONTEXT_RESULT is only available while renewState is pending_save',
        details: { renewState: context.renewState ?? null },
      },
    };
  }

  const result = runModelCommand(validated.request, context);
  if (result.ok && result.commandId === 'UPDATE_SESSION') {
    context.session = result.payload.session;
    // #846 — name the write so GET_SESSION can tell whether the host has handled it.
    // Unique across servers (each turn spawns its own process): time, a counter and a random tail.
    const receiptId = `r_${Date.now().toString(36)}_${(++receiptCounter).toString(36)}_${randomBytes(4).toString('hex')}`;
    context.lastReceiptId = receiptId;
    result.payload.receiptId = receiptId;
  }
  if (result.ok && result.commandId === 'GET_SESSION' && context.receiptFile) {
    // #846 — the host's word, not this server's copy: what it applied, the card TL;DR and NEEDS YOU reason.
    const host = readHostReceipt(context.receiptFile);
    if (host) {
      // This server's own write, from the per-write ledger (never the single latest `lastWrite`, which another
      // server's write or a superseded turn's late callback can replace).
      const own = context.lastReceiptId ? host.acks?.[context.lastReceiptId] : undefined;
      const caughtUp = own !== undefined;
      // `lastWrite` is only ever this server's own write — the file's latest may be another turn's.
      const { acks: _acks, lastWrite: _latest, ...hostView } = host;
      result.payload.host = own ? { ...hostView, lastWrite: own } : hostView;
      result.payload.hostPending = !!context.lastReceiptId && !caughtUp;
      if (caughtUp) {
        // The host handled THIS server's last write: its snapshot is the truth, and later writes lock against its
        // sequence. A receipt for no write of ours (turn start, another turn) stays advisory — the spawned snapshot
        // remains the lock.
        context.session = normalizeSessionSnapshot(host.session);
        result.payload.session = context.session;
      }
    }
  }
  if (result.ok && result.commandId === 'SAVE_CONTEXT_RESULT') {
    context.renewState = 'pending_load';
  }
  return result;
}

/** #881 A — how often a waiting GET_SESSION re-reads the receipt file. */
const HOST_ACK_POLL_MS = 500;

/**
 * Whether to stop waiting for the host's ack of `receiptId`: it is there, or there is no receipt to read at all (the
 * host could not write the file — waiting cannot change that; fable R1 P2).
 */
function hostAckSettled(receiptFile: string, receiptId: string): boolean {
  const receipt = readHostReceipt(receiptFile);
  return receipt === undefined || receipt.acks?.[receiptId] !== undefined;
}

/**
 * {@link buildModelCommandRunResponse}, except GET_SESSION `{ waitForAckMs }` first waits — up to that long — for the
 * host to handle this server's last UPDATE_SESSION (#881 A). The host applies a write about 20 s after the model got
 * its result when its stream is busy, so an immediate re-read reports an applied write as pending. It waits only for
 * its own write: no write yet, no receipt path, or no receipt file on disk answers at once. `hostWaitedMs` says how
 * long it waited.
 */
export async function runModelCommandAwaitingHost(
  args: unknown,
  context: ModelCommandContext,
  // A monotonic clock: a wall-clock step back must not stretch the wait past its bound (astra · fable R1 P3).
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<ModelCommandRunResponse> {
  const validated = validateModelCommandRunArgs(args);
  const waitMs =
    validated.ok && validated.request.commandId === 'GET_SESSION' ? (validated.request.params?.waitForAckMs ?? 0) : 0;
  let waited: number | undefined;
  // It waits for this server's LATEST write, read on every poll: the answer (`hostPending`, `host.lastWrite`, the
  // resync) is about that same write, so a write made while it waits moves the wait with it instead of leaving the
  // answer about a different write than the one waited for (astra R2 P2). The bound is still `waitMs` in total.
  const receiptFile = context.receiptFile;
  if (waitMs > 0 && receiptFile && context.lastReceiptId) {
    const started = clock.now();
    while (!hostAckSettled(receiptFile, context.lastReceiptId)) {
      const left = waitMs - (clock.now() - started);
      if (left <= 0) break;
      await clock.sleep(Math.min(HOST_ACK_POLL_MS, left));
    }
    waited = clock.now() - started;
  }
  const result = buildModelCommandRunResponse(args, context);
  if (waited !== undefined && result.ok && result.commandId === 'GET_SESSION') result.payload.hostWaitedMs = waited;
  return result;
}

class ModelCommandMcpServer extends BaseMcpServer {
  private context: ModelCommandContext;

  constructor() {
    super('model-command');
    this.context = parseModelCommandContext(process.env.SOMA_COMMAND_CONTEXT);

    // Register memory + skill stores so commands work in this process
    if (process.env.SOMA_DATA_DIR) {
      registerMemoryStore(new MemoryFileStore(process.env.SOMA_DATA_DIR));
      registerHierarchicalMemoryStore(new HierarchicalMemoryFileStore(process.env.SOMA_DATA_DIR));
      registerSkillStore(new SkillFileStore(process.env.SOMA_DATA_DIR));

      // Register rating store so RATE command works in this process
      const dataDir = process.env.SOMA_DATA_DIR;
      registerRatingStore({
        getUserRating(userId: string): number {
          try {
            const settingsPath = path.join(dataDir, 'user-settings.json');
            const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const rating = data[userId]?.rating;
            return typeof rating === 'number' ? Math.max(0, Math.min(10, rating)) : 5;
          } catch {
            return 5;
          }
        },
      });
    }
  }

  defineTools(): ToolDefinition[] {
    return [
      {
        name: 'list',
        description: 'List available model commands for current session context',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'run',
        description: 'Run a model command with typed params',
        inputSchema: {
          type: 'object',
          properties: {
            commandId: {
              type: 'string',
              enum: [
                'GET_SESSION',
                'UPDATE_SESSION',
                'ASK_USER_QUESTION',
                'CONTINUE_SESSION',
                'SAVE_CONTEXT_RESULT',
                'SAVE_MEMORY',
                'GET_MEMORY',
                'MEMORY',
                'MANAGE_SKILL',
                'RATE',
                // Issue #1082 T2: model-initiated session goal (set-only).
                'SET_GOAL',
              ],
            },
            params: { type: 'object', description: 'Command params object' },
          },
          required: ['commandId'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === 'list') {
      const payload = buildModelCommandListResponse(this.context);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }

    if (name === 'run') {
      const payload = await runModelCommandAwaitingHost(args, this.context);
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: !payload.ok,
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  }
}

let serverInstance: ModelCommandMcpServer | null = null;

function getModelCommandServer(): ModelCommandMcpServer {
  if (!serverInstance) {
    serverInstance = new ModelCommandMcpServer();
  }
  return serverInstance;
}

const invokedDirectly =
  require.main === module ||
  ['model-command-mcp-server.ts', 'model-command-mcp-server.js'].includes(path.basename(process.argv[1] ?? ''));

async function main(): Promise<void> {
  await getModelCommandServer().run();
}

if (invokedDirectly) {
  main().catch((error) => {
    logger.error('Model-command MCP server error', error);
    process.stderr.write('', () => process.exit(1));
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkflowType(raw: unknown): WorkflowType | undefined {
  if (
    raw === 'onboarding' ||
    raw === 'jira-executive-summary' ||
    raw === 'jira-brainstorming' ||
    raw === 'jira-planning' ||
    raw === 'jira-create-pr' ||
    raw === 'pr-review' ||
    raw === 'pr-fix-and-update' ||
    raw === 'pr-docs-confluence' ||
    raw === 'deploy' ||
    raw === 'default'
  ) {
    return raw;
  }
  return undefined;
}
