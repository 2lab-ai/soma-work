import type { WebClient } from '@slack/web-api';
import { StderrLogger } from '../stderr-logger';
import { type IrreversibleAction, irreversibleAction } from './irreversible';
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

/** Longest model text one advice block carries (the guardian's text is already capped well below this). */
const ADVICE_BLOCK_TEXT_MAX = 600;

/**
 * What the call does and why it is risky, as `plain_text` blocks: model text never goes through mrkdwn, so it
 * cannot bold, strike out, link or mention anything (review R1, astra P1). Shared by the card and the second
 * question.
 */
export function permissionAdviceDetailBlocks(advice: PermissionAdvice): any[] {
  const row = (label: string, text: string) => ({
    type: 'section',
    // emoji: false — no shortcodes either: a red card cannot carry a model-written ✅.
    text: { type: 'plain_text', emoji: false, text: `${label}: ${text}`.slice(0, ADVICE_BLOCK_TEXT_MAX) },
  });
  const blocks: any[] = [];
  if (advice.summary) blocks.push(row('무엇을 하나', advice.summary));
  if (advice.risk) blocks.push(row('왜 위험한가', advice.risk));
  return blocks;
}

/**
 * The AI's advice as the card's blocks: a fixed mrkdwn head (🟢 / 🔴 / ⚪), the model's text as plain_text, and
 * on red the note that approving asks again.
 */
export function permissionAdviceBlocks(advice: PermissionAdvice | null | undefined): any[] {
  const head = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  if (!advice) return [head('⚪ *AI 추천 없음* — AI 검토를 받지 못했습니다. 아래 내용을 직접 확인하세요.')];
  const blocks = [
    head(advice.recommendation === 'deny' ? '🔴 *AI 권고: 실행하지 마세요*' : '🟢 *AI 추천: 승인해도 됩니다*'),
    ...permissionAdviceDetailBlocks(advice),
  ];
  if (advice.recommendation === 'deny') blocks.push(head('⚠️ 그래도 승인하면 실행 전에 한 번 더 묻습니다.'));
  return blocks;
}

/**
 * The confirm dialog Slack shows before an Approve on an irreversible call
 * runs (the dashboard's card asks for a slide instead). The prompt was already
 * raised; this adds no gate, only a second look at what cannot be undone. The
 * label is static catalog text, safe in mrkdwn.
 */
export function irreversibleConfirm(action: IrreversibleAction): Record<string, unknown> {
  return {
    title: { type: 'plain_text', text: '되돌릴 수 없는 작업' },
    text: { type: 'mrkdwn', text: `*${action.label}* — 승인하면 바로 실행되고 되돌릴 수 없습니다. 승인할까요?` },
    confirm: { type: 'plain_text', text: '승인' },
    deny: { type: 'plain_text', text: '취소' },
    style: 'danger',
  };
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
   *
   * When the call is irreversible ({@link irreversibleAction} — a deploy, a
   * publish, a destructive command), a line under the header says what cannot
   * be undone and both approve buttons open a confirm dialog first — except on
   * a red card, whose Approve already asks a second time.
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
    const irreversible = irreversibleAction(toolName, input);
    // A red card's Approve already asks a second time (buildSecondConfirmBlocks): no dialog on top of it.
    const confirm = irreversible && !red ? { confirm: irreversibleConfirm(irreversible) } : {};

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
        ...confirm,
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
      ...(irreversible
        ? [
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `⚠️ *되돌릴 수 없는 작업: ${irreversible.label}* — 승인 전에 한 번 더 확인합니다.`,
                },
              ],
            },
          ]
        : []),
      ...permissionAdviceBlocks(advice),
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
          ...confirm,
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
