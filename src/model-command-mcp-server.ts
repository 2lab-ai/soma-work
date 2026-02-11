#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StderrLogger } from './stderr-logger.js';
import {
  getDefaultSessionSnapshot,
  listModelCommands,
  normalizeSessionSnapshot,
  runModelCommand,
} from './model-commands/catalog.js';
import { validateModelCommandRunArgs } from './model-commands/validator.js';
import {
  ModelCommandContext,
  ModelCommandListResponse,
  ModelCommandRunResponse,
} from './model-commands/types.js';
import { WorkflowType } from './types.js';

const logger = new StderrLogger('ModelCommandMCP');

function createDefaultContext(): ModelCommandContext {
  return {
    session: getDefaultSessionSnapshot(),
    renewState: null,
  };
}

export function parseModelCommandContext(
  rawContext: string | undefined
): ModelCommandContext {
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
      workflow: parseWorkflowType(parsed.workflow),
      renewState: parsed.renewState === 'pending_save' || parsed.renewState === 'pending_load'
        ? parsed.renewState
        : null,
      session: normalizeSessionSnapshot(
        isRecord(parsed.session) ? parsed.session as any : undefined
      ),
    };
  } catch (error) {
    logger.warn('Failed to parse SOMA_COMMAND_CONTEXT, using default context', {
      error: (error as Error).message,
    });
    return createDefaultContext();
  }
}

export function buildModelCommandListResponse(
  context: ModelCommandContext
): ModelCommandListResponse {
  return {
    type: 'model_command_list',
    commands: listModelCommands(context),
  };
}

export function buildModelCommandRunResponse(
  args: unknown,
  context: ModelCommandContext
): ModelCommandRunResponse {
  const validated = validateModelCommandRunArgs(args);
  if (!validated.ok) {
    return {
      type: 'model_command_result',
      commandId: 'UNKNOWN',
      ok: false,
      error: validated.error,
    };
  }

  if (
    validated.request.commandId === 'SAVE_CONTEXT_RESULT'
    && context.renewState !== 'pending_save'
  ) {
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
  }
  if (result.ok && result.commandId === 'SAVE_CONTEXT_RESULT') {
    context.renewState = 'pending_load';
  }
  return result;
}

class ModelCommandMcpServer {
  private server: Server;
  private context: ModelCommandContext;

  constructor() {
    this.context = parseModelCommandContext(process.env.SOMA_COMMAND_CONTEXT);
    this.server = new Server(
      {
        name: 'model-command',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'list',
            description: 'List available model commands for current session context',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: 'run',
            description: 'Run a model command with typed params',
            inputSchema: {
              type: 'object',
              properties: {
                commandId: {
                  type: 'string',
                  enum: ['GET_SESSION', 'UPDATE_SESSION', 'ASK_USER_QUESTION', 'SAVE_CONTEXT_RESULT'],
                },
                params: {
                  type: 'object',
                  description: 'Command params object',
                },
              },
              required: ['commandId'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      if (request.params.name === 'list') {
        const payload = buildModelCommandListResponse(this.context);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload),
            },
          ],
        };
      }

      if (request.params.name === 'run') {
        const payload = buildModelCommandRunResponse(request.params.arguments, this.context);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload),
            },
          ],
          isError: !payload.ok,
        };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.debug('Model-command MCP server started');
  }
}

let serverInstance: ModelCommandMcpServer | null = null;

export function getModelCommandServer(): ModelCommandMcpServer {
  if (!serverInstance) {
    serverInstance = new ModelCommandMcpServer();
  }
  return serverInstance;
}

if (require.main === module) {
  getModelCommandServer()
    .run()
    .catch((error) => {
      logger.error('Model-command MCP server error', error);
      process.exit(1);
    });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkflowType(raw: unknown): WorkflowType | undefined {
  if (
    raw === 'onboarding'
    || raw === 'jira-executive-summary'
    || raw === 'jira-brainstorming'
    || raw === 'jira-planning'
    || raw === 'jira-create-pr'
    || raw === 'pr-review'
    || raw === 'pr-fix-and-update'
    || raw === 'pr-docs-confluence'
    || raw === 'deploy'
    || raw === 'default'
  ) {
    return raw;
  }
  return undefined;
}
