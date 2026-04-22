import type { WebClient } from '@slack/web-api';
import type { DangerousRule } from '../dangerous-command-filter';
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
   * Build permission request blocks for Slack message.
   *
   * When `overridableRules` is non-empty, a 4th "Approve & disable rule for
   * this session" button is appended. Clicking it approves the current tool
   * call AND silences those rule ids for the rest of the Slack-thread session,
   * so subsequent matching commands auto-allow under bypass mode.
   */
  buildRequestBlocks(
    toolName: string,
    input: any,
    approvalId: string,
    user?: string,
    overridableRules: ReadonlyArray<DangerousRule> = [],
  ): any[] {
    const userMention = user ? `<@${user}>` : 'Unknown';

    const actionElements: any[] = [
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
    ];

    const blocks: any[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🔐 Permission Request — ${toolName}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${userMention} Claude wants to use the tool: \`${toolName}\`\n\n*Tool Parameters:*\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
        },
      },
    ];

    if (overridableRules.length > 0) {
      const ruleLabels = overridableRules.map((r) => `• \`${r.id}\` — ${r.label}: ${r.description}`).join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Matched dangerous-command rule${overridableRules.length > 1 ? 's' : ''}:*\n${ruleLabels}`,
        },
      });

      actionElements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: '🔓 Approve & disable rule (this session)',
        },
        action_id: 'approve_disable_rule_session',
        value: approvalId,
      });
    }

    blocks.push({ type: 'actions', elements: actionElements });

    return blocks;
  }

  /**
   * Send permission request message to Slack
   */
  async sendPermissionRequest(
    context: PermissionMessageContext,
    blocks: any[],
    toolName: string,
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
