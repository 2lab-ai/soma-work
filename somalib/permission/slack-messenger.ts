import type { WebClient } from '@slack/web-api';
import { StderrLogger } from '../stderr-logger';
import type { PermissionAdvice } from './shared-store';

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

/**
 * SSOT 2026-11-02 T3/T4 — the colour bar of an advised card: Slack's own green
 * when the AI recommends approving, its red when it says not to run the call.
 */
export const PERMISSION_ADVICE_COLORS = { approve: '#2EB67D', deny: '#E01E5A' } as const;

/** The card's colour bar for this advice; none without advice. */
export function permissionAdviceColor(advice: PermissionAdvice | null | undefined): string | undefined {
  return advice ? PERMISSION_ADVICE_COLORS[advice.recommendation] : undefined;
}

/**
 * Model text in mrkdwn: `&`, `<`, `>` escaped, so it can never mention a
 * person or channel (`<!channel>`, `<@U…>`) or carry a link.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The AI's advice as the card's mrkdwn section. */
export function permissionAdviceText(advice: PermissionAdvice | null | undefined): string {
  if (!advice) return '⚪ *AI 추천 없음* — AI 검토를 받지 못했습니다. 아래 내용을 직접 확인하세요.';
  const lines =
    advice.recommendation === 'deny' ? ['🔴 *AI 권고: 실행하지 마세요*'] : ['🟢 *AI 추천: 승인해도 됩니다*'];
  if (advice.summary) lines.push(`*무엇을 하나:* ${escapeMrkdwn(advice.summary)}`);
  if (advice.risk) lines.push(`*왜 위험한가:* ${escapeMrkdwn(advice.risk)}`);
  if (advice.recommendation === 'deny') lines.push('⚠️ 그래도 승인하면 실행 전에 한 번 더 묻습니다.');
  return lines.join('\n');
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
    advice: PermissionAdvice | null = null,
  ): any[] {
    const userMention = user ? `<@${user}>` : 'Unknown';
    // T4: the AI said not to run it — Deny is the green (recommended) button,
    // Approve the red one, and no shortcut silences the rule for the session.
    const red = advice?.recommendation === 'deny';

    const actionElements: any[] = [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: red ? '⚠️ 그래도 승인' : '✅ Approve',
        },
        style: red ? 'danger' : 'primary',
        action_id: 'approve_tool',
        value: approvalId,
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '❌ Deny',
        },
        style: red ? 'primary' : 'danger',
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
        text: { type: 'mrkdwn', text: permissionAdviceText(advice) },
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

      if (!red) {
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
    advice: PermissionAdvice | null = null,
  ): Promise<PermissionMessageResult> {
    // An advised card goes inside an attachment: Slack's only coloured edge
    // (green = AI recommends, red = AI says do not run).
    const color = permissionAdviceColor(advice);
    const text = `Permission request for ${toolName}`;
    try {
      const result = await this.slack.chat.postMessage({
        channel: context.channel || context.user || 'general',
        thread_ts: context.threadTs,
        ...(color ? { attachments: [{ color, blocks, fallback: text }] } : { blocks }),
        text,
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
