#!/usr/bin/env node

import { WebClient } from '@slack/web-api';
import { BaseMcpServer } from '../_shared/base-mcp-server.js';
import type { ToolDefinition, ToolResult } from '../_shared/base-mcp-server.js';
import { sharedStore, PendingApproval, PermissionResponse } from '../../src/shared-store.js';
import { SlackPermissionMessenger } from '../../src/permission/index.js';

interface PermissionRequest {
  tool_name: string;
  input: any;
  channel?: string;
  thread_ts?: string;
  user?: string;
}

class PermissionMCPServer extends BaseMcpServer {
  private slack: WebClient;
  private messenger: SlackPermissionMessenger;

  constructor() {
    super('permission-prompt');
    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    this.messenger = new SlackPermissionMessenger(this.slack);
  }

  defineTools(): ToolDefinition[] {
    return [
      {
        name: 'permission_prompt',
        description: 'Request user permission for tool execution via Slack button',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string', description: 'Name of the tool requesting permission' },
            input: { type: 'object', description: 'Input parameters for the tool' },
            channel: { type: 'string', description: 'Slack channel ID' },
            thread_ts: { type: 'string', description: 'Slack thread timestamp' },
            user: { type: 'string', description: 'User ID requesting permission' },
          },
          required: ['tool_name', 'input'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === 'permission_prompt') {
      return await this.handlePermissionPrompt(args as unknown as PermissionRequest);
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  private async handlePermissionPrompt(params: PermissionRequest): Promise<ToolResult> {
    const { tool_name, input } = params;

    this.logger.debug('Received permission prompt request', { tool_name, input });

    const slackContextStr = process.env.SLACK_CONTEXT;
    const slackContext = slackContextStr ? JSON.parse(slackContextStr) : {};
    const { channel, threadTs: thread_ts, user } = slackContext;

    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const blocks = this.messenger.buildRequestBlocks(tool_name, input, approvalId, user);

    try {
      const result = await this.messenger.sendPermissionRequest(
        { channel, threadTs: thread_ts, user },
        blocks,
        tool_name
      );

      const pendingApproval: PendingApproval = {
        tool_name, input, channel, thread_ts, user,
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000,
      };

      await sharedStore.storePendingApproval(approvalId, pendingApproval);

      const response = await this.waitForApproval(approvalId);

      if (result.ts && result.channel) {
        try {
          await this.slack.chat.delete({ channel: result.channel, ts: result.ts });
        } catch (deleteError) {
          this.logger.warn('Failed to delete permission message:', deleteError);
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    } catch (error) {
      this.logger.error('Error handling permission prompt:', error);

      const response: PermissionResponse = {
        behavior: 'deny',
        message: 'Error occurred while requesting permission',
      };

      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
  }

  private async waitForApproval(approvalId: string): Promise<PermissionResponse> {
    this.logger.debug('Waiting for approval using shared store', { approvalId });
    return await sharedStore.waitForPermissionResponse(approvalId, 5 * 60 * 1000);
  }

  public async resolveApproval(approvalId: string, approved: boolean, updatedInput?: any) {
    this.logger.debug('Resolving approval via shared store', { approvalId, approved });

    const response: PermissionResponse = {
      behavior: approved ? 'allow' : 'deny',
      updatedInput,
      message: approved ? 'Approved by user' : 'Denied by user',
    };

    await sharedStore.storePermissionResponse(approvalId, response);
    this.logger.debug('Permission resolved via shared store', { approvalId, behavior: response.behavior });
  }

  public async getPendingApprovalCount(): Promise<number> {
    return await sharedStore.getPendingCount();
  }

  public async clearExpiredApprovals(): Promise<number> {
    return await sharedStore.cleanupExpired();
  }
}

let serverInstance: PermissionMCPServer | null = null;

export function getPermissionServer(): PermissionMCPServer {
  if (!serverInstance) {
    serverInstance = new PermissionMCPServer();
  }
  return serverInstance;
}

export const permissionServer = getPermissionServer();

if (require.main === module) {
  getPermissionServer()
    .run()
    .catch((error) => {
      console.error('Permission MCP server error:', error);
      process.exit(1);
    });
}
