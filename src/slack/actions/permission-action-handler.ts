import { type PermissionResponse, sharedStore } from 'somalib/permission/shared-store';
import { Logger } from '../../logger';
import type { SessionRegistry } from '../../session-registry';
import type { RespondFn } from './types';

/**
 * 권한 승인/거부 액션 핸들러
 *
 * `sessionRegistry` is optional so callers that don't need the session-scoped
 * rule-disable action (`handleApproveDisableRule`) can instantiate the handler
 * without it. The rule-disable path only works when it's provided — otherwise
 * the handler falls back to a plain approve so the user's click isn't lost.
 */
export class PermissionActionHandler {
  private logger = new Logger('PermissionActionHandler');

  constructor(private readonly sessionRegistry?: SessionRegistry) {}

  async handleApprove(body: any, respond: RespondFn): Promise<void> {
    await this.runSimpleAction(body, respond, 'approval', 'Tool approval granted', {
      behavior: 'allow',
      message: 'Approved by user',
    });
  }

  async handleDeny(body: any, respond: RespondFn): Promise<void> {
    await this.runSimpleAction(body, respond, 'denial', 'Tool approval denied', {
      behavior: 'deny',
      message: 'Denied by user',
    });
  }

  async handleExplain(body: any, respond: RespondFn): Promise<void> {
    await this.runSimpleAction(body, respond, 'request', 'Tool explanation requested', {
      behavior: 'deny',
      message:
        'User requested explanation: Before retrying this tool, explain in the conversation why you need to use this tool, what it will do, and what the expected outcome is. Then request permission again.',
    });
  }

  /**
   * Approve the current tool call AND silence the matched overridable
   * dangerous-command rules for the remainder of this ConversationSession.
   *
   * Looks up the pending approval in the shared-store to recover the
   * (channel, thread_ts, rule_ids) triple the permission-mcp-server persisted,
   * maps the first two to a session key, and mutates the session's
   * `disabledDangerousRules` set so subsequent bypass-mode hook invocations
   * short-circuit to allow. The disable is in-memory only — restarting the
   * bot or ending the session drops it (intentional; re-enable UI is out of
   * scope for this PR).
   */
  async handleApproveDisableRule(body: any, respond: RespondFn): Promise<void> {
    const approvalId = body.actions?.[0]?.value;
    const user = body.user?.id;

    if (!approvalId) {
      this.logger.warn('approve_disable_rule_session: missing approvalId');
      await this.ephemeralError(respond, '❌ Missing approval id. The request may have already been handled.');
      return;
    }

    try {
      if (!this.sessionRegistry) {
        // Without a SessionRegistry we can't disable rules — but still honor
        // the approve intent so the request doesn't hang until timeout.
        this.logger.warn('approve_disable_rule_session: no sessionRegistry; falling back to plain approve', {
          approvalId,
          user,
        });
        await sharedStore.storePermissionResponse(approvalId, { behavior: 'allow', message: 'Approved by user' });
        return;
      }

      const pending = await sharedStore.getPendingApproval(approvalId);
      if (!pending) {
        this.logger.warn('approve_disable_rule_session: pending approval not found (may have expired)', {
          approvalId,
          user,
        });
        await this.ephemeralError(respond, '⚠️ The permission request expired before it could be handled.');
        return;
      }

      const ruleIds = pending.rule_ids ?? [];
      const { channel, thread_ts } = pending;

      if (ruleIds.length === 0 || !channel) {
        this.logger.warn('approve_disable_rule_session: no ruleIds or channel; falling back to plain approve', {
          approvalId,
          hasRuleIds: ruleIds.length > 0,
          hasChannel: Boolean(channel),
        });
        await sharedStore.storePermissionResponse(approvalId, { behavior: 'allow', message: 'Approved by user' });
        return;
      }

      const sessionKey = this.sessionRegistry.getSessionKey(channel, thread_ts);
      this.sessionRegistry.disableDangerousRules(sessionKey, ruleIds);

      this.logger.info('Tool approved and dangerous rules disabled for session', {
        approvalId,
        user,
        sessionKey,
        ruleIds,
      });

      await sharedStore.storePermissionResponse(approvalId, {
        behavior: 'allow',
        message: `Approved by user; rule(s) disabled for this session: ${ruleIds.join(', ')}`,
      });
    } catch (error) {
      this.logger.error('Error processing approve_disable_rule_session', error);
      await this.ephemeralError(respond, '❌ Error processing approval. The request may have already been handled.');
    }
  }

  /**
   * Shared path for the three simple handlers (approve/deny/explain). Wraps
   * everything including the `body.actions[0].value` access in a single
   * try/catch so a malformed payload surfaces as an ephemeral error rather
   * than an unhandled rejection.
   */
  private async runSimpleAction(
    body: any,
    respond: RespondFn,
    noun: 'approval' | 'denial' | 'request',
    logLabel: string,
    response: PermissionResponse,
  ): Promise<void> {
    try {
      const approvalId = body.actions[0].value;
      const user = body.user?.id;
      this.logger.info(logLabel, { approvalId, user });
      await sharedStore.storePermissionResponse(approvalId, response);
    } catch (error) {
      this.logger.error(`Error processing tool ${noun}`, error);
      await this.ephemeralError(respond, `❌ Error processing ${noun}. The request may have already been handled.`);
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
