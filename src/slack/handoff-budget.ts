/**
 * Per-session auto-handoff budget enforcement (#697).
 *
 * Pure helper functions + error class used by `src/slack-handler.ts` to
 * enforce the one-auto-handoff-per-session ceiling documented in
 * `src/local/skills/using-z/SKILL.md` §Session Handoff Protocol Rule #3.
 *
 * Spec: docs/handoff-budget/spec.md (v4)
 * Trace: docs/handoff-budget/trace.md (v4)
 *
 * Invariants:
 *   - Budget is stored on `ConversationSession.autoHandoffBudget` (default 1).
 *   - `HandoffContext.hopBudget` (#695) remains as parser-seed info only;
 *     authoritative state is the `ConversationSession` field.
 *   - Check-AND-consume is atomic within a single synchronous call
 *     (Node event-loop guarantee — no `await` between read and write).
 *   - Missing session at the enforcement seam is an invariant break:
 *     fail CLOSED with reason `'no-session'`.
 */

import type { WorkflowType } from 'somalib/model-commands/session-types';
import type { ConversationSession, HandoffContext } from '../types';

/** Default budget assigned to every freshly-created / reset session. */
export const DEFAULT_AUTO_HANDOFF_BUDGET = 1;

export type BudgetRejectionReason = 'exhausted' | 'no-session';

export interface BudgetCheckResult {
  /** True when the hop is permitted (pre-check budget > 0 AND session present). */
  allowed: boolean;
  /** Budget value observed BEFORE the decrement (or rejection). */
  budgetBefore: number;
  /** Budget value AFTER the operation: allowed → budgetBefore-1; rejected → budgetBefore. */
  budgetAfter: number;
  /** When `allowed === false`, explains which branch. */
  reason?: BudgetRejectionReason;
}

/**
 * Check the auto-handoff budget on `session` and consume one hop if available.
 *
 * Mutates `session.autoHandoffBudget` ONLY on the allowed path. Rejection
 * paths leave the session untouched.
 *
 * @returns Structured decision for the caller to act on.
 */
export function checkAndConsumeBudget(session: ConversationSession | undefined): BudgetCheckResult {
  if (session === undefined) {
    // Fail CLOSED: at the onResetSession seam, a missing session is an invariant
    // break (the collector collected a continuation for this channel/thread, so
    // a session MUST have existed). Reject the hop and surface the condition.
    return {
      allowed: false,
      budgetBefore: 0,
      budgetAfter: 0,
      reason: 'no-session',
    };
  }

  const before = session.autoHandoffBudget ?? DEFAULT_AUTO_HANDOFF_BUDGET;

  if (before <= 0) {
    return {
      allowed: false,
      budgetBefore: before,
      budgetAfter: before,
      reason: 'exhausted',
    };
  }

  session.autoHandoffBudget = before - 1;
  return {
    allowed: true,
    budgetBefore: before,
    budgetAfter: before - 1,
  };
}

export interface BudgetRejectionContext {
  reason: BudgetRejectionReason;
  attemptedWorkflow: WorkflowType | undefined;
  handoffContext: HandoffContext | undefined;
  budgetBefore: number;
}

/**
 * Format the user-facing Slack message shown when `checkAndConsumeBudget`
 * returns `allowed: false`.
 *
 * Mirrors the tone/structure of the `HandoffAbortError` message at
 * `slack-handler.ts:572-587`. Branches on `reason`:
 *   - `'exhausted'`: legitimate budget exhaustion (the common case)
 *   - `'no-session'`: invariant break (should not happen in normal operation)
 */
export function formatBudgetExhaustedMessage(ctx: BudgetRejectionContext): string {
  const workflow = ctx.attemptedWorkflow ?? 'default';

  if (ctx.reason === 'no-session') {
    return [
      '🚫 자동 세션 핸드오프 거부 (host-enforced, #697) — session 상태 불일치',
      '',
      'CONTINUE_SESSION이 캡처됐지만 해당 채널/스레드의 세션을 찾을 수 없습니다',
      '(invariant break). dispatch 루프를 안전하게 중단합니다.',
      '',
      `Attempted workflow: \`${workflow}\``,
      '',
      '원인: 이 경로는 정상적으로 발생하지 않아야 합니다 — host 로그를 확인하세요.',
      '',
      '수동 재시도: `$z <issue-url>` (fresh 세션 시작)',
    ].join('\n');
  }

  // reason === 'exhausted' (default / canonical case)
  const chainId = ctx.handoffContext?.chainId ?? 'N/A — direct session';

  return [
    '🚫 자동 세션 핸드오프 예산 초과 (host-enforced, #697)',
    '',
    '이 세션은 이미 1회의 자동 핸드오프를 사용했습니다.',
    '두 번째 `CONTINUE_SESSION` 발행이 거부되었습니다 — 무한 루프 방지.',
    '',
    `Budget: ${ctx.budgetBefore} / ${DEFAULT_AUTO_HANDOFF_BUDGET} (exhausted)`,
    `Attempted workflow: \`${workflow}\``,
    `Chain: \`${chainId}\``,
    '',
    '원인: z-controller 세션은 세션당 1회의 auto-handoff만 허용됩니다.',
    '정상적으로 다음 단계로 넘어가려면 유저가 수동으로 새 세션을 시작해야 합니다.',
    '',
    '수동 재시도: `$z <issue-url>` (새 세션, 독립 예산 1회)',
  ].join('\n');
}

/**
 * Thrown by `slack-handler.onResetSession` when `checkAndConsumeBudget`
 * returns `allowed: false`. Caught at the outer try/catch alongside
 * `HandoffAbortError` (slack-handler.ts:555-595) — posts the formatted
 * Slack message via `formatBudgetExhaustedMessage`, logs `warn`, and does
 * NOT terminate the session (budget is a soft ceiling — session stays
 * alive for manual user re-entry via `$z <url>`).
 *
 * Distinction from `HandoffAbortError` (#695):
 *   - `HandoffAbortError`: structural failure (missing/malformed sentinel);
 *     session is terminated.
 *   - `HandoffBudgetExhaustedError`: soft ceiling; session stays alive.
 */
export class HandoffBudgetExhaustedError extends Error {
  public readonly name = 'HandoffBudgetExhaustedError';

  constructor(
    public readonly reason: BudgetRejectionReason,
    public readonly budgetBefore: number,
    public readonly attemptedWorkflow: WorkflowType | undefined,
    public readonly chainId: string | undefined,
  ) {
    super(`Auto-handoff budget exhausted (reason=${reason}, budget=${budgetBefore})`);
  }
}
