#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from '@slack/web-api';
import { StderrLogger } from './stderr-logger.js';
import { sharedStore, PendingApproval, PermissionResponse } from './shared-store.js';

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

  constructor() {
    this.server = new Server(
      {
        name: "permission-prompt",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "permission_prompt",
            description: "Request user permission for tool execution via Slack button",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: {
                  type: "string",
                  description: "Name of the tool requesting permission",
                },
                input: {
                  type: "object",
                  description: "Input parameters for the tool",
                },
                channel: {
                  type: "string",
                  description: "Slack channel ID",
                },
                thread_ts: {
                  type: "string",
                  description: "Slack thread timestamp",
                },
                user: {
                  type: "string",
                  description: "User ID requesting permission",
                },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      logger.debug('Received tool call request', { tool: request.params.name });
      if (request.params.name === "permission_prompt") {
        return await this.handlePermissionPrompt(request.params.arguments as unknown as PermissionRequest);
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
    
    // Create approval message with buttons
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔐 *Permission Request*\n\nClaude wants to use the tool: \`${tool_name}\`\n\n*Tool Parameters:*\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✅ Approve"
            },
            style: "primary",
            action_id: "approve_tool",
            value: approvalId
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "❌ Deny"
            },
            style: "danger",
            action_id: "deny_tool",
            value: approvalId
          }
        ]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Requested by: <@${user}> | Tool: ${tool_name}`
          }
        ]
      }
    ];

    try {
      // Send approval request to Slack
      const result = await this.slack.chat.postMessage({
        channel: channel || user || 'general',
        thread_ts: thread_ts,
        blocks,
        text: `Permission request for ${tool_name}` // Fallback text
      });

      // Store pending approval in shared store
      const pendingApproval: PendingApproval = {
        tool_name,
        input,
        channel,
        thread_ts,
        user,
        created_at: Date.now(),
        expires_at: Date.now() + (5 * 60 * 1000) // 5 minutes
      };
      
      await sharedStore.storePendingApproval(approvalId, pendingApproval);
      
      // Wait for user response
      const response = await this.waitForApproval(approvalId);
      
      // Update the message to show the result
      if (result.ts) {
        await this.slack.chat.update({
          channel: result.channel!,
          ts: result.ts,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `🔐 *Permission Request* - ${response.behavior === 'allow' ? '✅ Approved' : '❌ Denied'}\n\nTool: \`${tool_name}\`\n\n*Tool Parameters:*\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``
              }
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `${response.behavior === 'allow' ? 'Approved' : 'Denied'} by user | Tool: ${tool_name}`
                }
              ]
            }
          ],
          text: `Permission ${response.behavior === 'allow' ? 'approved' : 'denied'} for ${tool_name}`
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response)
          }
        ]
      };
    } catch (error) {
      logger.error('Error handling permission prompt:', error);
      
      // Default to deny if there's an error
      const response: PermissionResponse = {
        behavior: 'deny',
        message: 'Error occurred while requesting permission'
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response)
          }
        ]
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
      approved
    });
    
    const response: PermissionResponse = {
      behavior: approved ? 'allow' : 'deny',
      updatedInput,
      message: approved ? 'Approved by user' : 'Denied by user'
    };
    
    await sharedStore.storePermissionResponse(approvalId, response);
    
    logger.info('Permission resolved via shared store', { 
      approvalId, 
      behavior: response.behavior
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
    logger.info('Permission MCP server started');
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
  getPermissionServer().run().catch((error) => {
    logger.error('Permission MCP server error:', error);
    process.exit(1);
  });
}