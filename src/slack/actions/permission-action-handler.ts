import type { PermissionAdvice } from 'somalib/permission/shared-store';
import { permissionAdviceDetailBlocks } from 'somalib/permission/slack-messenger';
import { Logger } from '../../logger';
import {
  answerPermissionPrompt,
  type PermissionPromptAnswer,
  type PermissionPromptDecision,
} from '../../permission-prompt-response';
import type { SessionRegistry } from '../../session-registry';
import type { RespondFn } from './types';

/**
 * 권한 승인/거부 액션 핸들러
 *
 * Requester-only: the prompt is an ordinary thread message, so anyone in the
 * channel can click its buttons. Every action goes through
 * `answerPermissionPrompt` — the same path the dashboard answers through — so
 * a click is stored only when the clicker is the user the prompt was raised
 * for (`PendingApproval.user`), the record is a permission prompt, and nobody
 * (Slack or dashboard) answered it first. An unknown requester, a missing
 * click user, or a missing/expired record fails closed: nothing is stored, so
 * the permission MCP server keeps waiting and times out to deny.
 *
 * `sessionRegistry` is optional so callers that don't need the session-scoped
 * rule-disable action (`handleApproveDisableRule`) can instantiate the handler
 * without it. The rule-disable path only works when it's provided — otherwise
 * it is a plain approve so the user's click isn't lost.
 */
export class PermissionActionHandler {
  private logger = new Logger('PermissionActionHandler');

  constructor(private readonly sessionRegistry?: SessionRegistry) {}

  async handleApprove(body: any, respond: RespondFn): Promise<void> {
    await this.run(body, respond, 'approve', 'approval');
  }

  async handleDeny(body: any, respond: RespondFn): Promise<void> {
    await this.run(body, respond, 'deny', 'denial');
  }

  async handleExplain(body: any, respond: RespondFn): Promise<void> {
    await this.run(body, respond, 'explain', 'request');
  }

  /**
   * SSOT 2026-11-02 T4 — the second question's button: the requester confirms
   * running a call the AI advised against. On success the question is replaced
   * by what happened.
   */
  async handleApproveConfirmed(body: any, respond: RespondFn): Promise<void> {
    const ok = await this.run(body, respond, 'approve_confirmed', 'approval');
    if (ok) {
      await respond({
        response_type: 'ephemeral',
        replace_original: true,
        text: '⚠️ 2차 확인 완료 — AI 권고와 달리 실행을 승인했습니다.',
      });
    }
  }

  /**
   * Approve the current tool call AND silence the matched overridable
   * dangerous-command rules for the remainder of this ConversationSession
   * (in-memory; evaluateToolPolicy reads the set through
   * `isDangerousRuleDisabled`). Without matched rules, a channel, or a
   * SessionRegistry it is a plain approve.
   */
  async handleApproveDisableRule(body: any, respond: RespondFn): Promise<void> {
    await this.run(body, respond, 'approve_disable_rule', 'approval');
  }

  /** Answer the prompt; true when the answer was stored. */
  private async run(
    body: any,
    respond: RespondFn,
    decision: PermissionPromptDecision,
    noun: 'approval' | 'denial' | 'request',
  ): Promise<boolean> {
    const approvalId = body?.actions?.[0]?.value;
    const user = body?.user?.id;
    if (!approvalId || typeof approvalId !== 'string') {
      this.logger.warn(`${decision}: missing approvalId`);
      await this.ephemeralError(respond, '❌ Missing approval id. The request may have already been handled.');
      return false;
    }
    try {
      const result = await answerPermissionPrompt({
        approvalId,
        actor: user,
        decision,
        sessions: this.sessionRegistry,
      });
      if (result.ok) {
        this.logger.info('Permission prompt answered from Slack', {
          approvalId,
          user,
          decision,
          disabledRuleIds: result.disabledRuleIds,
        });
        return true;
      }
      if (result.reason === 'confirm_required') {
        this.logger.info('Permission approve needs a second confirmation (AI advised against it)', {
          approvalId,
          user,
          decision,
        });
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: '🔴 AI가 실행하지 말라고 권고한 요청입니다. 정말 실행할까요?',
          blocks: buildSecondConfirmBlocks(approvalId, result.advice),
        });
        return false;
      }
      await this.explainRefusal(respond, result, approvalId, user, decision);
    } catch (error) {
      this.logger.error(`Error processing tool ${noun}`, error);
      await this.ephemeralError(respond, `❌ Error processing ${noun}. The request may have already been handled.`);
    }
    return false;
  }

  private async explainRefusal(
    respond: RespondFn,
    result: Exclude<Extract<PermissionPromptAnswer, { ok: false }>, { reason: 'confirm_required' }>,
    approvalId: string,
    clicker: string | undefined,
    decision: PermissionPromptDecision,
  ): Promise<void> {
    switch (result.reason) {
      case 'not_found':
        this.logger.warn(`${decision}: pending approval not found (may have expired)`, { approvalId, user: clicker });
        await this.ephemeralError(respond, '⚠️ The permission request expired before it could be handled.');
        return;
      case 'already_answered':
        this.logger.warn(`${decision}: permission request already answered`, { approvalId, user: clicker });
        await this.ephemeralError(respond, '⚠️ This permission request was already answered (Slack or dashboard).');
        return;
      case 'not_requester':
        this.logger.warn(`${decision}: click from a user other than the requester ignored`, {
          approvalId,
          clicker,
          requester: result.requester,
        });
        await this.ephemeralError(
          respond,
          result.requester
            ? `⚠️ Only <@${result.requester}>, who this permission request is for, can answer it.`
            : '⚠️ This permission request has no recorded requester, so it cannot be answered from Slack.',
        );
        return;
    }
  }

  private async ephemeralError(respond: RespondFn, text: string): Promise<void> {
    await respond({
      response_type: 'ephemeral',
      text,
      replace_original: false,
    });
  }
}

/**
 * SSOT 2026-11-02 T4 — the second question, shown only to the requester: the
 * AI's reasons in red, and one red button that runs the call. Denying stays on
 * the card itself.
 */
export function buildSecondConfirmBlocks(approvalId: string, advice: PermissionAdvice): any[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '🔴 *AI가 실행하지 말라고 권고한 요청입니다. 정말 실행할까요?*' },
    },
    // The model's words as plain_text (never mrkdwn).
    ...permissionAdviceDetailBlocks(advice),
    { type: 'section', text: { type: 'mrkdwn', text: '멈추려면 권한 카드의 ❌ Deny를 누르세요.' } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '⚠️ 네, 실행합니다 (2차 확인)' },
          style: 'danger',
          action_id: 'approve_tool_confirmed',
          value: approvalId,
        },
      ],
    },
  ];
}
