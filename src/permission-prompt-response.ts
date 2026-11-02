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
 *   before any side effect, and outlives the MCP server's cleanup;
 * - twice when the AI advised against the call (SSOT 2026-11-02 T4): a plain
 *   approve is refused with `confirm_required` and stores nothing; only the
 *   explicit second answer, `approve_confirmed`, runs it. Both surfaces ask
 *   the second question; this check makes neither able to skip it.
 *
 * Every stored answer is recorded in the session's work log as a `permission`
 * entry (SSOT 2026-11-02 T1) — the Slack card is deleted once answered, so the
 * log is where the decision stays visible.
 */

import { recordConversationWorkLog } from '@soma/slack/pipeline/stream-executor';
import {
  PERMISSION_PROMPT_KIND,
  type PendingApproval,
  type PermissionAdvice,
  type PermissionResponse,
  sharedStore,
} from 'somalib/permission/shared-store';

export type PermissionPromptDecision = 'approve' | 'deny' | 'explain' | 'approve_disable_rule' | 'approve_confirmed';

export const PERMISSION_PROMPT_DECISIONS: readonly PermissionPromptDecision[] = [
  'approve',
  'deny',
  'explain',
  'approve_disable_rule',
  'approve_confirmed',
];

export function isPermissionPromptDecision(value: unknown): value is PermissionPromptDecision {
  return typeof value === 'string' && (PERMISSION_PROMPT_DECISIONS as readonly string[]).includes(value);
}

export const PERMISSION_EXPLAIN_MESSAGE =
  'User requested explanation: Before retrying this tool, explain in the conversation why you need to use this tool, what it will do, and what the expected outcome is. Then request permission again.';

/** The part of `SessionRegistry` an answer needs: the disable-rule answer, and the work log entry. */
export interface DangerousRuleSessions {
  getSessionKey(channel: string, threadTs?: string): string;
  disableDangerousRules(sessionKey: string, ruleIds: string[]): void;
  /**
   * A Slack-less task's live record — its running turn (#637 R1) and its
   * conversation (the work log). Without it a task's rules are never disabled
   * (fail-closed) and its answers are not recorded.
   */
  getSessionByKey?(sessionKey: string): { activeTaskTurnId?: string; conversationId?: string } | undefined;
  /** A Slack session's record — its conversation, where the answer is recorded. */
  getSession?(channel: string, threadTs?: string): { conversationId?: string } | undefined;
}

/**
 * A task prompt's turn is still the task's running turn — read live, after the
 * caller's awaits. A Slack prompt has no turn to check.
 */
function taskTurnStillRunning(pending: PendingApproval, sessions: DangerousRuleSessions | undefined): boolean {
  if (!pending.task_key) return true;
  const live = sessions?.getSessionByKey?.(pending.task_key)?.activeTaskTurnId;
  return !!pending.turn_id && live === pending.turn_id;
}

export interface AnswerPermissionPromptArgs {
  approvalId: string;
  /** Slack user id of whoever answers; undefined is never the requester. */
  actor: string | undefined;
  decision: PermissionPromptDecision;
  /** Needed for `approve_disable_rule`; without it that decision is a plain approve. */
  sessions?: DangerousRuleSessions;
  /** When set, the prompt must belong to this session thread. */
  thread?: PermissionPromptTarget;
}

export type PermissionPromptAnswer =
  | { ok: true; pending: PendingApproval; disabledRuleIds: string[] }
  | { ok: false; reason: 'not_found' | 'already_answered' }
  | { ok: false; reason: 'not_requester'; requester?: string }
  /** The AI advised against the call: ask the requester again, then answer `approve_confirmed`. */
  | { ok: false; reason: 'confirm_required'; advice: PermissionAdvice };

/** An approve of a prompt the AI advised against must be confirmed a second time. */
function needsSecondConfirmation(pending: PendingApproval, decision: PermissionPromptDecision): boolean {
  return pending.advice?.recommendation === 'deny' && (decision === 'approve' || decision === 'approve_disable_rule');
}

/** A permission prompt record that is still pending, or null. */
export async function loadPermissionPrompt(approvalId: string): Promise<PendingApproval | null> {
  const pending = await sharedStore.getPendingApproval(approvalId);
  return pending && pending.kind === PERMISSION_PROMPT_KIND ? pending : null;
}

/**
 * Where a prompt is answered: a Slack session's thread, or a Slack-less task's
 * key and the turn it is running now (#599 ⑤) — only that turn waits for it.
 */
export type PermissionPromptTarget = { channel: string; threadTs?: string } | { taskKey: string; turnId: string };

/** True when `pending` was raised in the given session thread — or, for a task, by that task's running turn. */
export function promptBelongsToThread(
  pending: Pick<PendingApproval, 'channel' | 'thread_ts' | 'task_key' | 'turn_id'>,
  thread: PermissionPromptTarget,
): boolean {
  if ('taskKey' in thread) {
    return (
      !!pending.task_key &&
      pending.task_key === thread.taskKey &&
      !!pending.turn_id &&
      pending.turn_id === thread.turnId
    );
  }
  if (pending.task_key) return false;
  return pending.channel === thread.channel && (pending.thread_ts ?? '') === (thread.threadTs ?? '');
}

/** The session whose dangerous rules an approve-and-disable silences, if any. */
function ruleScopeKey(pending: PendingApproval, sessions: DangerousRuleSessions): string | undefined {
  if (pending.task_key) return pending.task_key;
  return pending.channel ? sessions.getSessionKey(pending.channel, pending.thread_ts) : undefined;
}

export async function answerPermissionPrompt(args: AnswerPermissionPromptArgs): Promise<PermissionPromptAnswer> {
  const { approvalId, actor, decision, sessions, thread } = args;

  const pending = await loadPermissionPrompt(approvalId);
  if (!pending) return { ok: false, reason: 'not_found' };
  if (thread && !promptBelongsToThread(pending, thread)) return { ok: false, reason: 'not_found' };
  if (!actor || !pending.user || actor !== pending.user) {
    return { ok: false, reason: 'not_requester', requester: pending.user };
  }
  // Before the claim: the prompt stays open for the confirmed answer.
  if (needsSecondConfirmation(pending, decision) && pending.advice) {
    return { ok: false, reason: 'confirm_required', advice: pending.advice };
  }

  if (!(await sharedStore.claimPermissionResponse(approvalId))) return { ok: false, reason: 'already_answered' };
  // The MCP server may have timed out between the load and the claim. The
  // claim stays, so nobody else answers it either.
  if (!(await sharedStore.getPendingApproval(approvalId))) return { ok: false, reason: 'not_found' };
  // A task's turn may have ended during those awaits (#637 R1): its hook was
  // the only waiter, so the answer is stale. The claim stays.
  if (pending.task_key && sessions?.getSessionByKey && !taskTurnStillRunning(pending, sessions)) {
    return { ok: false, reason: 'not_found' };
  }

  const { response, disabledRuleIds } = responseFor(decision, pending, sessions);
  try {
    await sharedStore.storePermissionResponse(approvalId, response);
  } catch (error) {
    // Nothing reached the MCP server and nothing was changed: give the claim
    // back so the prompt can still be answered before it expires.
    await sharedStore.releasePermissionClaim(approvalId);
    throw error;
  }
  // The stored answer goes into the session's work log (SSOT 2026-11-02 T1). An
  // approve-and-disable that silences nothing reads as the plain approve it was.
  recordAnswer(
    pending,
    decision === 'approve_disable_rule' && disabledRuleIds.length === 0 ? 'approve' : decision,
    actor,
    sessions,
  );
  // Only the winner, and only once its answer is stored: silence the rules —
  // for a task, only while the turn that asked is still running (read again
  // after the store's await, with no await before the change).
  if (sessions && disabledRuleIds.length > 0) {
    if (!taskTurnStillRunning(pending, sessions)) return { ok: true, pending, disabledRuleIds: [] };
    const scope = ruleScopeKey(pending, sessions);
    if (scope) sessions.disableDangerousRules(scope, disabledRuleIds);
  }
  return { ok: true, pending, disabledRuleIds };
}

/** How each answer reads in the work log: the line's head and whether the call runs. */
const ANSWER_LINES: Record<PermissionPromptDecision, { head: string; ok: boolean }> = {
  approve: { head: '✅ 권한 승인', ok: true },
  approve_disable_rule: { head: '🔓 권한 승인 · 규칙 끔', ok: true },
  approve_confirmed: { head: '⚠️ 권한 승인 (2차 확인)', ok: true },
  deny: { head: '❌ 권한 거부', ok: false },
  explain: { head: '💡 설명 요청 (실행 안 함)', ok: false },
};
const ADVICE_WORDS = { approve: 'AI 🟢 승인 추천', deny: 'AI 🔴 실행 말 것' } as const;
/** Longest call summary in the work log line (the full input is the tool entry's raw). */
const CALL_SUMMARY_MAX = 200;

/** One line for the call a prompt was about: a Bash command, a file path, else the input as JSON. */
function callSummary(input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = [o.command, o.file_path, o.path, o.url].find((v) => typeof v === 'string' && v.trim());
  let text: string;
  if (typeof pick === 'string') text = pick;
  else {
    try {
      text = JSON.stringify(input ?? {}) ?? '';
    } catch {
      text = '';
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > CALL_SUMMARY_MAX ? `${text.slice(0, CALL_SUMMARY_MAX - 1)}…` : text;
}

/**
 * Record a stored answer in the session's work log (SSOT 2026-11-02 T1): a
 * `permission` entry — the decision, the tool and call, the AI's advice, who
 * answered. A Slack prompt is conversation-level; a task prompt is filed on
 * the turn that asked. Never throws: the answer is already stored.
 */
function recordAnswer(
  pending: PendingApproval,
  decision: PermissionPromptDecision,
  actor: string,
  sessions: DangerousRuleSessions | undefined,
): void {
  try {
    const session = pending.task_key
      ? sessions?.getSessionByKey?.(pending.task_key)
      : pending.channel
        ? sessions?.getSession?.(pending.channel, pending.thread_ts)
        : undefined;
    const conversationId = session?.conversationId;
    if (!conversationId) return;
    const line = ANSWER_LINES[decision];
    const tool = String(pending.tool_name ?? '');
    const ai = pending.advice?.recommendation;
    const call = callSummary(pending.input);
    const text = [line.head, tool, call, ai ? ADVICE_WORDS[ai] : ''].filter(Boolean).join(' · ');
    recordConversationWorkLog(
      conversationId,
      {
        kind: 'permission',
        text,
        tool,
        ok: line.ok,
        ...(pending.task_key && pending.turn_id ? { turnId: pending.turn_id } : {}),
        permission: { decision, by: actor, ...(ai ? { ai } : {}) },
      },
      { sessionKey: pending.task_key ?? sessions?.getSessionKey(pending.channel ?? '', pending.thread_ts) },
    );
  } catch {
    // The work log is a record, never a reason to lose an answer that is stored.
  }
}

/** The response the decision stores, and the rules it silences (pure). */
function responseFor(
  decision: PermissionPromptDecision,
  pending: PendingApproval,
  sessions: DangerousRuleSessions | undefined,
): { response: PermissionResponse; disabledRuleIds: string[] } {
  switch (decision) {
    case 'approve':
      return { response: { behavior: 'allow', message: 'Approved by user' }, disabledRuleIds: [] };
    case 'approve_confirmed':
      return {
        response: {
          behavior: 'allow',
          message:
            pending.advice?.recommendation === 'deny'
              ? 'Approved by user after a second confirmation (the AI advised against it)'
              : 'Approved by user',
        },
        disabledRuleIds: [],
      };
    case 'deny':
      return { response: { behavior: 'deny', message: 'Denied by user' }, disabledRuleIds: [] };
    case 'explain':
      return { response: { behavior: 'deny', message: PERMISSION_EXPLAIN_MESSAGE }, disabledRuleIds: [] };
    case 'approve_disable_rule': {
      const ruleIds = pending.rule_ids ?? [];
      if (!sessions || ruleIds.length === 0 || (!pending.channel && !pending.task_key)) {
        return { response: { behavior: 'allow', message: 'Approved by user' }, disabledRuleIds: [] };
      }
      return {
        response: {
          behavior: 'allow',
          message: `Approved by user; rule(s) disabled for this session: ${ruleIds.join(', ')}`,
        },
        disabledRuleIds: ruleIds,
      };
    }
  }
}
