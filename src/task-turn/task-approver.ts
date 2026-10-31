/**
 * #599 ⑤ — the dashboard approver of a Slack-less task's escalations.
 *
 * A task turn's policy hook hands an escalation (a `classify` call the safety
 * classifier did not allow) here. The approver writes a permission prompt to
 * the shared approval store — the same store, claim tombstones and answer path
 * (`answerPermissionPrompt`) the Slack buttons and the dashboard already use —
 * bound to the task (`task_key`), the turn that raised it (`turn_id`) and its
 * owner (the only requester who may answer), then waits for the answer.
 *
 * Expiry resolves a deny (the store's own timeout answer); an abort (the turn
 * stopped) or a store error rejects, and the hook turns a rejection into a
 * deny. Nothing in here can produce an allow without a stored answer.
 */
import { randomBytes } from 'node:crypto';
import { PERMISSION_PROMPT_KIND, type PermissionResponse, type sharedStore } from 'somalib/permission/shared-store';
import type { TaskApprovalRequest, TaskApprover } from '../agent-runtime/claude-code/build-stream-options';

/** How long a task's approval stays open. The hook's SDK timeout sits above it. */
export const TASK_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
/** Less time than this before the hook's deadline: deny without raising a prompt. */
const MIN_APPROVAL_WINDOW_MS = 1_000;

export interface TaskApproverDeps {
  store: Pick<typeof sharedStore, 'storePendingApproval' | 'waitForPermissionResponse' | 'cleanup'>;
  /** The turn the task is running (its saved `activeTaskTurnId`). */
  getActiveTurnId(sessionKey: string): string | undefined;
  timeoutMs?: number;
  now?: () => number;
  newId?: () => string;
}

export function createTaskApprover(deps: TaskApproverDeps): TaskApprover {
  const timeoutMs = deps.timeoutMs ?? TASK_APPROVAL_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => `approval_${Date.now()}_${randomBytes(6).toString('hex')}`);
  return {
    async request(req: TaskApprovalRequest): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
      const createdAt = now();
      // The wait ends before the hook's SDK deadline (#637 R1): a prompt the
      // owner could answer only after the SDK cancelled the hook is never raised.
      const left = (req.deadlineAt ?? Number.POSITIVE_INFINITY) - createdAt;
      if (left < MIN_APPROVAL_WINDOW_MS) {
        return { behavior: 'deny', message: 'No time was left to ask for approval — it was not run.' };
      }
      const expiresAt = createdAt + Math.min(timeoutMs, left);
      const approvalId = newId();
      const turnId = deps.getActiveTurnId(req.sessionKey);
      await deps.store.storePendingApproval(approvalId, {
        kind: PERMISSION_PROMPT_KIND,
        tool_name: req.toolName,
        input: req.toolInput,
        user: req.userId,
        task_key: req.sessionKey,
        ...(turnId ? { turn_id: turnId } : {}),
        created_at: createdAt,
        expires_at: expiresAt,
        ...(req.ruleIds.length > 0 ? { rule_ids: req.ruleIds } : {}),
      });
      // The write took time (#637 R2): wait only until the recorded expiry, so the
      // store's own timeout still lands before the SDK cancels the hook.
      const remaining = expiresAt - now();
      if (remaining <= 0) {
        await deps.store.cleanup(approvalId);
        return { behavior: 'deny', message: 'The approval window closed before it could be asked — it was not run.' };
      }
      const response: PermissionResponse = await deps.store.waitForPermissionResponse(
        approvalId,
        remaining,
        req.signal,
      );
      return response.behavior === 'allow'
        ? { behavior: 'allow', ...(response.message ? { message: response.message } : {}) }
        : { behavior: 'deny', ...(response.message ? { message: response.message } : {}) };
    },
  };
}
