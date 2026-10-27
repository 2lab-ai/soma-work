import type { WebClient } from '@slack/web-api';
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
 * Minimal rule shape this messenger needs to render the
 * "Approve & disable rule for this session" button. Defined locally as a
 * narrow structural contract — DangerousRule (in
 * somalib/permission/dangerous-rules.ts, re-exported by
 * src/dangerous-command-filter.ts) is a structural superset of this interface,
 * so callers can pass DangerousRule arrays directly without conversion.
 */
export interface PermissionRuleSummary {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** Slack caps a section text at 3000 chars; keep room for the fence and the label. */
const WARNING_TEXT_MAX = 2800;

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface PermissionWarningBlockArgs {
  toolName: string;
  input: unknown;
  user?: string;
  /** Rules the mechanical check matched after the model allowed the call. */
  rules: ReadonlyArray<PermissionRuleSummary>;
  /** The safety classifier's short reason for allowing it. */
  reason: string;
}

/**
 * The auto-mode permission WARNING card: the same shape as the permission
 * request card (header, tool parameters, matched rules) but nothing is asked —
 * no buttons, no approval id. Posted after the model allowed a call that the
 * mechanical check still flags.
 */
export function buildPermissionWarningBlocks(args: PermissionWarningBlockArgs): any[] {
  const { toolName, input, user, rules, reason } = args;
  const userMention = user ? `<@${user}> ` : '';
  let params: string;
  try {
    params = JSON.stringify(input, null, 2) ?? '';
  } catch {
    params = String(input);
  }
  const ruleLines = rules.map((r) => `• \`${r.id}\` — ${r.label}: ${r.description}`).join('\n');
  return [
    { type: 'header', text: { type: 'plain_text', text: `⚠️ Permission Warning — ${toolName}` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${userMention}Auto mode approved this \`${toolName}\` call, but the mechanical check flagged it.\n\n*Tool Parameters:*\n\`\`\`json\n${clipText(params, WARNING_TEXT_MAX)}\n\`\`\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: clipText(
          `*Matched dangerous-command rule${rules.length > 1 ? 's' : ''}:*\n${ruleLines}`,
          WARNING_TEXT_MAX,
        ),
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: clipText(
            `🤖 Classifier: ${reason || 'approved'} · No action needed — this is a warning, not a question.`,
            WARNING_TEXT_MAX,
          ),
        },
      ],
    },
  ];
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
    overridableRules: ReadonlyArray<PermissionRuleSummary> = [],
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
