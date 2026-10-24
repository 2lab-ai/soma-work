/**
 * The one way a user's answer to a permission prompt is recorded.
 *
 * The permission MCP server (`packages/mcp-servers/permission`) writes a
 * pending approval and waits for a response file. Two surfaces answer it:
 * the Slack buttons (`slack/actions/permission-action-handler.ts`) and the
 * dashboard (`POST /api/dashboard/session/:key/permission`). Both call
 * {@link answerPermissionPrompt}, which only enforces the user's decision
 * (rules/permission.md — enforcement, not a policy decision):
 *
 * - only records the permission MCP server wrote (`kind`) — the pending
 *   directory also holds admin-approved MCP tool grant requests, which their
 *   requester must never answer;
 * - only the user the prompt was raised for (`PendingApproval.user`);
 * - when the caller names a session thread, only a prompt of that thread;
 * - at most once, across surfaces and processes: the store claim is taken
 *   before any side effect, and outlives the MCP server's cleanup.
 */

import {
  PERMISSION_PROMPT_KIND,
  type PendingApproval,
  type PermissionResponse,
  sharedStore,
} from 'somalib/permission/shared-store';

export type PermissionPromptDecision = 'approve' | 'deny' | 'explain' | 'approve_disable_rule';

export const PERMISSION_PROMPT_DECISIONS: readonly PermissionPromptDecision[] = [
  'approve',
  'deny',
  'explain',
  'approve_disable_rule',
];

export function isPermissionPromptDecision(value: unknown): value is PermissionPromptDecision {
  return typeof value === 'string' && (PERMISSION_PROMPT_DECISIONS as readonly string[]).includes(value);
}

export const PERMISSION_EXPLAIN_MESSAGE =
  'User requested explanation: Before retrying this tool, explain in the conversation why you need to use this tool, what it will do, and what the expected outcome is. Then request permission again.';

/** The part of `SessionRegistry` the disable-rule answer needs. */
export interface DangerousRuleSessions {
  getSessionKey(channel: string, threadTs?: string): string;
  disableDangerousRules(sessionKey: string, ruleIds: string[]): void;
}

export interface AnswerPermissionPromptArgs {
  approvalId: string;
  /** Slack user id of whoever answers; undefined is never the requester. */
  actor: string | undefined;
  decision: PermissionPromptDecision;
  /** Needed for `approve_disable_rule`; without it that decision is a plain approve. */
  sessions?: DangerousRuleSessions;
  /** When set, the prompt must belong to this session thread. */
  thread?: { channel: string; threadTs?: string };
}

export type PermissionPromptAnswer =
  | { ok: true; pending: PendingApproval; disabledRuleIds: string[] }
  | { ok: false; reason: 'not_found' | 'already_answered' }
  | { ok: false; reason: 'not_requester'; requester?: string };

/** A permission prompt record that is still pending, or null. */
export async function loadPermissionPrompt(approvalId: string): Promise<PendingApproval | null> {
  const pending = await sharedStore.getPendingApproval(approvalId);
  return pending && pending.kind === PERMISSION_PROMPT_KIND ? pending : null;
}

/** True when `pending` was raised in the given session thread. */
export function promptBelongsToThread(
  pending: Pick<PendingApproval, 'channel' | 'thread_ts'>,
  thread: { channel: string; threadTs?: string },
): boolean {
  return pending.channel === thread.channel && (pending.thread_ts ?? '') === (thread.threadTs ?? '');
}

export async function answerPermissionPrompt(args: AnswerPermissionPromptArgs): Promise<PermissionPromptAnswer> {
  const { approvalId, actor, decision, sessions, thread } = args;

  const pending = await loadPermissionPrompt(approvalId);
  if (!pending) return { ok: false, reason: 'not_found' };
  if (thread && !promptBelongsToThread(pending, thread)) return { ok: false, reason: 'not_found' };
  if (!actor || !pending.user || actor !== pending.user) {
    return { ok: false, reason: 'not_requester', requester: pending.user };
  }

  if (!(await sharedStore.claimPermissionResponse(approvalId))) return { ok: false, reason: 'already_answered' };
  // The MCP server may have timed out between the load and the claim. The
  // claim stays, so nobody else answers it either.
  if (!(await sharedStore.getPendingApproval(approvalId))) return { ok: false, reason: 'not_found' };

  let disabledRuleIds: string[] = [];
  let response: PermissionResponse;
  switch (decision) {
    case 'approve':
      response = { behavior: 'allow', message: 'Approved by user' };
      break;
    case 'deny':
      response = { behavior: 'deny', message: 'Denied by user' };
      break;
    case 'explain':
      response = { behavior: 'deny', message: PERMISSION_EXPLAIN_MESSAGE };
      break;
    case 'approve_disable_rule': {
      const ruleIds = pending.rule_ids ?? [];
      if (sessions && ruleIds.length > 0 && pending.channel) {
        sessions.disableDangerousRules(sessions.getSessionKey(pending.channel, pending.thread_ts), ruleIds);
        disabledRuleIds = ruleIds;
        response = {
          behavior: 'allow',
          message: `Approved by user; rule(s) disabled for this session: ${ruleIds.join(', ')}`,
        };
      } else {
        response = { behavior: 'allow', message: 'Approved by user' };
      }
      break;
    }
  }

  await sharedStore.storePermissionResponse(approvalId, response);
  return { ok: true, pending, disabledRuleIds };
}
