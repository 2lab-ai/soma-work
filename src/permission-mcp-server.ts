#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';
import { StderrLogger } from './stderr-logger.js';
import { sharedStore, PendingApproval, PermissionResponse } from './shared-store.js';
import { SlackPermissionMessenger } from './permission/index.js';

const logger = new StderrLogger('PermissionMCP');

interface PermissionRequest {
  tool_name: string;
  input: any;
  channel?: string;
  thread_ts?: string;
  user?: string;
}

class PermissionMCPServer {
  private server: Server;
  private slack: WebClient;
  private messenger: SlackPermissionMessenger;

  constructor() {
    this.server = new Server(
      {
        name: 'permission-prompt',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    this.messenger = new SlackPermissionMessenger(this.slack);
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'permission_prompt',
            description: 'Request user permission for tool execution via Slack button',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: {
                  type: 'string',
                  description: 'Name of the tool requesting permission',
                },
                input: {
                  type: 'object',
                  description: 'Input parameters for the tool',
                },
                channel: {
                  type: 'string',
                  description: 'Slack channel ID',
                },
                thread_ts: {
                  type: 'string',
                  description: 'Slack thread timestamp',
                },
                user: {
                  type: 'string',
                  description: 'User ID requesting permission',
                },
              },
              required: ['tool_name', 'input'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      logger.debug('Received tool call request', { tool: request.params.name });
      if (request.params.name === 'permission_prompt') {
        return await this.handlePermissionPrompt(
          request.params.arguments as unknown as PermissionRequest
        );
      }
      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private async handlePermissionPrompt(params: PermissionRequest) {
    const { tool_name, input } = params;

    logger.debug('Received permission prompt request', { tool_name, input });

    // Get Slack context from environment (passed by Claude handler)
    const slackContextStr = process.env.SLACK_CONTEXT;
    const slackContext = slackContextStr ? JSON.parse(slackContextStr) : {};
    const { channel, threadTs: thread_ts, user } = slackContext;

    // Generate unique approval ID
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Build request blocks using messenger
    const blocks = this.messenger.buildRequestBlocks(tool_name, input, approvalId, user);

    try {
      // Send approval request to Slack
      const result = await this.messenger.sendPermissionRequest(
        { channel, threadTs: thread_ts, user },
        blocks,
        tool_name
      );

      // Store pending approval in shared store
      const pendingApproval: PendingApproval = {
        tool_name,
        input,
        channel,
        thread_ts,
        user,
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000, // 5 minutes
      };

      await sharedStore.storePendingApproval(approvalId, pendingApproval);

      // Wait for user response
      const response = await this.waitForApproval(approvalId);

      // Update the message to show the result
      if (result.ts && result.channel) {
        const resultBlocks = this.messenger.buildResultBlocks(
          tool_name,
          input,
          response.behavior === 'allow'
        );
        await this.messenger.updateWithResult(
          result.channel,
          result.ts,
          resultBlocks,
          tool_name,
          response.behavior === 'allow'
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response),
          },
        ],
      };
    } catch (error) {
      logger.error('Error handling permission prompt:', error);

      // Default to deny if there's an error
      const response: PermissionResponse = {
        behavior: 'deny',
        message: 'Error occurred while requesting permission',
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response),
          },
        ],
      };
    }
  }

  private async waitForApproval(approvalId: string): Promise<PermissionResponse> {
    logger.debug('Waiting for approval using shared store', { approvalId });

    // Use shared store to wait for response
    return await sharedStore.waitForPermissionResponse(approvalId, 5 * 60 * 1000);
  }

  // Method to be called by Slack handler when button is clicked
  // Note: This method is no longer used directly, but kept for backwards compatibility
  public async resolveApproval(approvalId: string, approved: boolean, updatedInput?: any) {
    logger.debug('Resolving approval via shared store', {
      approvalId,
      approved,
    });

    const response: PermissionResponse = {
      behavior: approved ? 'allow' : 'deny',
      updatedInput,
      message: approved ? 'Approved by user' : 'Denied by user',
    };

    await sharedStore.storePermissionResponse(approvalId, response);

    logger.debug('Permission resolved via shared store', {
      approvalId,
      behavior: response.behavior,
    });
  }

  // Method to get pending approval count for debugging
  public async getPendingApprovalCount(): Promise<number> {
    return await sharedStore.getPendingCount();
  }

  // Method to clear expired approvals manually
  public async clearExpiredApprovals(): Promise<number> {
    return await sharedStore.cleanupExpired();
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.debug('Permission MCP server started');
  }
}

// Global instance for both module export and CLI execution
let serverInstance: PermissionMCPServer | null = null;

// Create singleton accessor
export function getPermissionServer(): PermissionMCPServer {
  if (!serverInstance) {
    serverInstance = new PermissionMCPServer();
  }
  return serverInstance;
}

// Export singleton instance for use by Slack handler
export const permissionServer = getPermissionServer();

// Run if this file is executed directly
if (require.main === module) {
  getPermissionServer()
    .run()
    .catch((error) => {
      logger.error('Permission MCP server error:', error);
      process.exit(1);
    });
}
