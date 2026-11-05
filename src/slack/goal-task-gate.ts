/**
 * The goal's task gate (2026-11-05). A goal completes only when BOTH hold:
 *
 *   1. the host evaluator reports the objective met, AND
 *   2. every task of the work model's latest task list (TodoWrite, kept on the
 *      session's task ledger) is completed.
 *
 * A task taken off the list no longer counts: that is how the model drops work
 * that left the goal. The evaluator reads the work model's text; the ledger is
 * the host's own record of the list, so the gate needs no model judgement.
 *
 * Live case: the dashboard read "목표 2/2 · 작업 1/6" — the evaluator closed the
 * goal while five of the model's six tasks were still open.
 *
 * Pure — the loop controller applies the gated verdict.
 */

import { ledgerTasks, type TaskLedger, type TaskView } from '../session/task-ledger';
import type { GoalEvalVerdict } from './goal-completion-evaluator';

/** Longest task text one line carries (the ledger keeps the full text). */
const TASK_LINE_MAX = 200;
/** Most tasks listed in the evaluator's evidence and in the gap (the count is always exact). */
const TASK_LINES_MAX = 30;

/** How far the latest list is from done, when the gate held the goal open. */
export interface GoalTaskGateHold {
  open: number;
  total: number;
  /** The evaluator's own reason for calling the objective met. */
  evalReason: string;
}

function taskLine(t: TaskView): string {
  const text = t.content.replace(/\s+/g, ' ').trim();
  const shown = text.length > TASK_LINE_MAX ? `${text.slice(0, TASK_LINE_MAX - 1)}…` : text;
  return `${t.id} [${t.status}] ${shown}`;
}

function bounded(lines: string[]): string[] {
  if (lines.length <= TASK_LINES_MAX) return lines;
  return [...lines.slice(0, TASK_LINES_MAX), `… and ${lines.length - TASK_LINES_MAX} more`];
}

/** The latest list, one `T<n> [status] text` line per task (bounded) — the evaluator's evidence. */
export function goalTaskListLines(ledger: TaskLedger | undefined): string[] {
  if (!ledger) return [];
  return bounded(ledgerTasks(ledger).current.map(taskLine));
}

/**
 * Gate an evaluator verdict on the latest task list. A `completed` verdict
 * with an open task becomes a gap that names the open tasks and tells the
 * model to finish them or take them off the list; anything else passes as is.
 */
export function gateGoalVerdictOnTasks(
  verdict: GoalEvalVerdict,
  ledger: TaskLedger | undefined,
): { verdict: GoalEvalVerdict; tasks?: GoalTaskGateHold } {
  if (!verdict.completed || !ledger) return { verdict };
  const current = ledgerTasks(ledger).current;
  const open = current.filter((t) => t.status !== 'completed');
  if (!open.length) return { verdict };
  const remaining = bounded(open.map(taskLine));
  const reason = [
    `The evaluator judged the objective met, but the goal is not complete: ${open.length} of ${current.length} tasks on your task list (TodoWrite) are not completed.`,
    'The goal completes only when the evaluator says so AND every task on the list is completed.',
    'Open tasks:',
    ...remaining.map((r) => `- ${r}`),
    'For each open task: finish it and mark it completed, or — if it is no longer part of this goal — remove it from (or update it on) the task list with TodoWrite.',
  ].join('\n');
  return {
    // No stall fields: the evaluator compared nothing — the host's own list held the goal open.
    verdict: { completed: false, reason, remaining },
    tasks: { open: open.length, total: current.length, evalReason: verdict.reason },
  };
}
