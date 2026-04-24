/**
 * Safe-stop on dispatch failure (#698).
 *
 * Pure helper functions + error class used by `src/slack/pipeline/session-initializer.ts`
 * and `src/slack-handler.ts` to convert silent drift-to-default-workflow into
 * an explicit safe-stop when the session has declared workflow intent
 * (handoffContext from #695, or caller-passed forcedWorkflowHint).
 *
 * Spec: docs/dispatch-safe-stop/spec.md (v3)
 * Trace: docs/dispatch-safe-stop/trace.md (v3)
 *
 * Pattern parity:
 *   - `HandoffAbortError` (#695): structural failure at handoff entry; terminates.
 *   - `HandoffBudgetExhaustedError` (#697): soft ceiling; session stays alive.
 *   - `DispatchAbortError` (#698): structural failure at dispatch pipeline;
 *     terminates (hard stop, same as #695).
 */

import type { WorkflowType } from 'somalib/model-commands/session-types';
import type { HandoffContext } from '../types';

export type DispatchAbortReason =
  | 'classifier-failed' // dispatchService.dispatch threw (non-abort error)
  | 'classifier-timeout' // AbortController fired (DISPATCH_TIMEOUT_MS)
  | 'wait-timeout' // in-flight dispatch wait exceeded DISPATCH_TIMEOUT_MS
  | 'transition-failed'; // transitionToMain returned false (session missing or already-transitioned)

export interface DispatchAbortContext {
  reason: DispatchAbortReason;
  workflow: WorkflowType | undefined; // target workflow (forceWorkflow or undefined for classifier path)
  detail: string; // human-readable error message
  elapsedMs: number | undefined;
  handoffContext: HandoffContext | undefined; // from session.handoffContext
}

/**
 * Human-readable cause text by reason. Mapped in `formatDispatchAbortMessage`
 * so the Slack message carries context beyond the machine-readable reason code.
 */
function humanReadableCauseFor(reason: DispatchAbortReason): string {
  switch (reason) {
    case 'classifier-failed':
      return 'Dispatch 분류기 호출이 실패했습니다 (LLM / 네트워크 / credential 등). 단일 호출 기반 실패이므로 재시도가 유효할 수 있습니다.';
    case 'classifier-timeout':
      return 'Dispatch 분류기가 제한 시간 내에 응답하지 않았습니다. 네트워크 지연 또는 모델 과부하가 원인일 수 있습니다.';
    case 'wait-timeout':
      return '이전 dispatch가 진행 중이어서 대기했지만 설정된 시간을 초과했습니다. 이전 요청이 비정상 종료되었을 수 있습니다.';
    case 'transition-failed':
      return 'Forced workflow 전환이 실패했습니다 — 세션이 이미 다른 workflow로 전환됐거나 (race loss) 세션이 사라졌습니다.';
  }
}

/**
 * Format the user-facing Slack message for a DispatchAbortError.
 *
 * Mirrors the tone/structure of the #695 `HandoffAbortError` and #697
 * `formatBudgetExhaustedMessage` patterns.
 */
export function formatDispatchAbortMessage(ctx: DispatchAbortContext): string {
  const workflow = ctx.workflow ?? 'classifier';
  const sourceIssueUrl = ctx.handoffContext?.sourceIssueUrl ?? 'N/A';
  const parentEpicUrl = ctx.handoffContext?.parentEpicUrl ?? 'N/A';
  const chainId = ctx.handoffContext?.chainId ?? 'N/A — direct session';
  const elapsed = ctx.elapsedMs !== undefined ? `${ctx.elapsedMs}ms` : 'unknown';
  const cause = humanReadableCauseFor(ctx.reason);

  return [
    '🚫 Dispatch 실패 — safe-stop (host-enforced, #698)',
    '',
    '세션이 특정 workflow로 진입하려 했지만 dispatch가 실패했습니다.',
    'Default workflow로 드리프트하지 않고 명시적으로 중단합니다.',
    '',
    `Workflow: \`${workflow}\``,
    `Reason: \`${ctx.reason}\` — ${ctx.detail}`,
    `Elapsed: ${elapsed}`,
    `Issue: ${sourceIssueUrl}`,
    `Epic: ${parentEpicUrl}`,
    `Chain: ${chainId}`,
    '',
    `원인: ${cause}`,
    '수동 재시도: `$z <issue-url>` (새 세션, 예산 리셋)',
  ].join('\n');
}

/**
 * Thrown by `session-initializer` drift sites when the session has explicit
 * workflow intent (handoffContext set by #695, or forcedWorkflowHint passed)
 * and dispatch fails. Caught at slack-handler outer try/catch alongside
 * `HandoffAbortError` (#695) and `HandoffBudgetExhaustedError` (#697) —
 * posts formatted Slack message via `formatDispatchAbortMessage`, logs warn,
 * and calls `terminateSession` (hard stop; dispatch failure is structural,
 * not a soft ceiling like #697 budget).
 */
export class DispatchAbortError extends Error {
  public readonly name = 'DispatchAbortError';

  constructor(
    public readonly reason: DispatchAbortReason,
    public readonly detail: string,
    public readonly workflow: WorkflowType | undefined,
    public readonly elapsedMs: number | undefined,
    public readonly handoffContext: HandoffContext | undefined,
  ) {
    super(`Dispatch failed (reason=${reason}, workflow=${workflow ?? 'classifier'}): ${detail}`);
  }
}
