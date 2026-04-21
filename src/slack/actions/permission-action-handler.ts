import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import { type PermissionResponse, sharedStore } from '../../shared-store';
import type { RespondFn } from './types';

/**
 * 권한 승인/거부 액션 핸들러
 *
 * `claudeHandler` is optional so callers that don't need the session-scoped
 * rule-disable action (`handleApproveDisableRule`) can instantiate the handler
 * without it. The rule-disable path only works when it's provided — otherwise
 * the handler falls back to a plain approve so the user's click isn't lost.
 */
export class PermissionActionHandler {
  private logger = new Logger('PermissionActionHandler');

  constructor(private readonly claudeHandler?: ClaudeHandler) {}

  async handleApprove(body: any, respond: RespondFn): Promise<void> {
    try {
      const approvalId = body.actions[0].value;
      const user = body.user?.id;

      this.logger.info('Tool approval granted', { approvalId, user });

      const response: PermissionResponse = {
        behavior: 'allow',
        message: 'Approved by user',
      };
      await sharedStore.storePermissionResponse(approvalId, response);
    } catch (error) {
      this.logger.error('Error processing tool approval', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing approval. The request may have already been handled.',
        replace_original: false,
      });
    }
  }

  async handleDeny(body: any, respond: RespondFn): Promise<void> {
    try {
      const approvalId = body.actions[0].value;
      const user = body.user?.id;

      this.logger.info('Tool approval denied', { approvalId, user });

      const response: PermissionResponse = {
        behavior: 'deny',
        message: 'Denied by user',
      };
      await sharedStore.storePermissionResponse(approvalId, response);
    } catch (error) {
      this.logger.error('Error processing tool denial', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing denial. The request may have already been handled.',
        replace_original: false,
      });
    }
  }

  async handleExplain(body: any, respond: RespondFn): Promise<void> {
    try {
      const approvalId = body.actions[0].value;
      const user = body.user?.id;

      this.logger.info('Tool explanation requested', { approvalId, user });

      const response: PermissionResponse = {
        behavior: 'deny',
        message:
          'User requested explanation: Before retrying this tool, explain in the conversation why you need to use this tool, what it will do, and what the expected outcome is. Then request permission again.',
      };
      await sharedStore.storePermissionResponse(approvalId, response);
    } catch (error) {
      this.logger.error('Error processing explanation request', error);
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing request. The request may have already been handled.',
        replace_original: false,
      });
    }
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
      await respond({
        response_type: 'ephemeral',
        text: '❌ Missing approval id. The request may have already been handled.',
        replace_original: false,
      });
      return;
    }

    try {
      if (!this.claudeHandler) {
        // Defensive fallback: if the handler was constructed without a
        // ClaudeHandler (e.g. a legacy test harness) we can't disable rules,
        // but we still honor the user's approve intent so the request doesn't
        // hang until timeout.
        this.logger.warn('approve_disable_rule_session: no claudeHandler; falling back to plain approve', {
          approvalId,
          user,
        });
        await sharedStore.storePermissionResponse(approvalId, {
          behavior: 'allow',
          message: 'Approved by user',
        });
        return;
      }

      const pending = await sharedStore.getPendingApproval(approvalId);
      if (!pending) {
        this.logger.warn('approve_disable_rule_session: pending approval not found (may have expired)', {
          approvalId,
          user,
        });
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ The permission request expired before it could be handled.',
          replace_original: false,
        });
        return;
      }

      const ruleIds = pending.rule_ids ?? [];
      const { channel, thread_ts } = pending;

      if (ruleIds.length === 0 || !channel) {
        // No overridable rules on this approval (shouldn't happen — the button
        // is only rendered when ruleIds is non-empty) or missing Slack
        // context. Fall back to plain approve.
        this.logger.warn('approve_disable_rule_session: no ruleIds or channel; falling back to plain approve', {
          approvalId,
          hasRuleIds: ruleIds.length > 0,
          hasChannel: Boolean(channel),
        });
        await sharedStore.storePermissionResponse(approvalId, {
          behavior: 'allow',
          message: 'Approved by user',
        });
        return;
      }

      const sessionRegistry = this.claudeHandler.getSessionRegistry();
      const sessionKey = sessionRegistry.getSessionKey(channel, thread_ts);
      sessionRegistry.disableDangerousRules(sessionKey, ruleIds);

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
      await respond({
        response_type: 'ephemeral',
        text: '❌ Error processing approval. The request may have already been handled.',
        replace_original: false,
      });
    }
  }
}
