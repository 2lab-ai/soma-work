import { WebClient } from '@slack/web-api';
import { StderrLogger } from '../stderr-logger';

const logger = new StderrLogger('SlackPermissionMessenger');

export interface PermissionMessageContext {
  channel: string;
  threadTs?: string;
  user?: string;
}

export interface PermissionMessageResult {
  ts?: string;
  channel?: string;
}

/**
 * Handles Slack message creation and updates for permission requests
 */
export class SlackPermissionMessenger {
  constructor(private slack: WebClient) {}

  /**
   * Build permission request blocks for Slack message
   */
  buildRequestBlocks(
    toolName: string,
    input: any,
    approvalId: string,
    user?: string
  ): any[] {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔐 *Permission Request*\n\nClaude wants to use the tool: \`${toolName}\`\n\n*Tool Parameters:*\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '✅ Approve',
            },
            style: 'primary',
            action_id: 'approve_tool',
            value: approvalId,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '❌ Deny',
            },
            style: 'danger',
            action_id: 'deny_tool',
            value: approvalId,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '💡 Explain',
            },
            action_id: 'explain_tool',
            value: approvalId,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Requested by: <@${user}> | Tool: ${toolName}`,
          },
        ],
      },
    ];
  }

  /**
   * Send permission request message to Slack
   */
  async sendPermissionRequest(
    context: PermissionMessageContext,
    blocks: any[],
    toolName: string
  ): Promise<PermissionMessageResult> {
    try {
      const result = await this.slack.chat.postMessage({
        channel: context.channel || context.user || 'general',
        thread_ts: context.threadTs,
        blocks,
        text: `Permission request for ${toolName}`,
      });

      return {
        ts: result.ts,
        channel: result.channel,
      };
    } catch (error) {
      logger.error('Failed to send permission request message:', error);
      throw error;
    }
  }

}
