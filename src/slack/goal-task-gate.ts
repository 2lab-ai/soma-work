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

/** Opens every gap the gate records (text only — the goal's `lastEvalGateOpen` marks a gate gap). */
const TASK_GATE_REASON_START = 'The evaluator judged the objective met, but the goal is not complete:';

/**
 * #968 — what the owner is offered when the gate held the goal on the same open
 * tasks twice in a row (a stall): the two task-list ways out, then a report.
 */
export const TASK_GATE_STALL_ACTIONS: readonly string[] = [
  '남은 작업을 끝내고 작업 목록에서 완료로 표시해',
  'goal에서 빠진 작업은 작업 목록(TodoWrite)에서 지워',
  '여기까지 한 것과 남은 작업을 정리해서 보고해',
];

/** How far the latest list is from done, when the gate held the goal open. */
export interface GoalTaskGateHold {
  open: number;
  total: number;
  /** The open tasks' ids, in list order — kept on the goal as `lastEvalGateOpen`. */
  openIds: string[];
  /** The previous verdict was a hold on exactly these tasks: the loop stops as a stall. */
  repeated: boolean;
  /** The evaluator's own reason for calling the objective met. */
  evalReason: string;
}

function taskLine(t: TaskView): string {
  // By code point, so the cut never splits a surrogate pair (emoji).
  const chars = Array.from(t.content.replace(/\s+/g, ' ').trim());
  const shown = chars.length > TASK_LINE_MAX ? `${chars.slice(0, TASK_LINE_MAX - 1).join('')}…` : chars.join('');
  return `${t.id} [${t.status}] ${shown}`;
}

function bounded(lines: string[]): string[] {
  if (lines.length <= TASK_LINES_MAX) return lines;
  return [...lines.slice(0, TASK_LINES_MAX), `… and ${lines.length - TASK_LINES_MAX} more`];
}

/**
 * The latest list without the tasks of a paused goal (`exclude`, see
 * {@link heldByWaitingGoals}): those are the paused goal's own work, so they
 * hold no other goal.
 */
function goalTasks(ledger: TaskLedger, exclude?: ReadonlySet<string>): TaskView[] {
  const current = ledgerTasks(ledger).current;
  return exclude?.size ? current.filter((t) => !exclude.has(t.id)) : current;
}

/**
 * What a goal paused now leaves behind as its own: the open tasks of the
 * latest list, and which list that is (`updatedAt`) — see `heldListAt`.
 */
export function heldTasksOf(ledger: TaskLedger | undefined): { heldTaskIds: string[]; heldListAt?: number } {
  if (!ledger) return { heldTaskIds: [] };
  return {
    heldTaskIds: ledgerTasks(ledger)
      .current.filter((t) => t.status !== 'completed')
      .map((t) => t.id),
    heldListAt: ledger.updatedAt,
  };
}

/**
 * SSOT 2026-11-06 (review P1): the tasks a goal left open when it was paused,
 * for every goal that still waits — paused, or resumed into the queue behind
 * the running goal. A waiting goal's unfinished work must not hold the goal
 * that runs in its place: B would otherwise be told to finish or drop A's tasks.
 *
 * Only while the list they came from is still the latest (review r3 P1): once
 * the running goal writes its own list, every task on it is its own. The ledger
 * matches a new task onto an old id by its text, so an old id on a new list may
 * be the running goal's new task.
 */
export function heldByWaitingGoals(session: {
  goalPaused?: Array<{ heldTaskIds?: string[]; heldListAt?: number }>;
  goalQueue?: Array<{ heldTaskIds?: string[]; heldListAt?: number }>;
  taskLedger?: TaskLedger;
}): Set<string> {
  const held = new Set<string>();
  const listAt = session.taskLedger?.updatedAt;
  for (const g of [...(session.goalPaused ?? []), ...(session.goalQueue ?? [])]) {
    if (g.heldListAt !== listAt) continue;
    for (const id of g.heldTaskIds ?? []) held.add(id);
  }
  return held;
}

/** The latest list, one `T<n> [status] text` line per task (bounded) — the evaluator's evidence. */
export function goalTaskListLines(ledger: TaskLedger | undefined, exclude?: ReadonlySet<string>): string[] {
  if (!ledger) return [];
  return bounded(goalTasks(ledger, exclude).map(taskLine));
}

function openTaskLines(ledger: TaskLedger | undefined, exclude?: ReadonlySet<string>): string[] {
  if (!ledger) return [];
  return bounded(
    goalTasks(ledger, exclude)
      .filter((t) => t.status !== 'completed')
      .map(taskLine),
  );
}

/**
 * The recorded gap is the gate's, and no task on the latest list is open now —
 * the one state in which the goal can complete. The loop must judge again
 * rather than reuse that gap (a turn cut short, or a kick, reuses the last
 * gap), or a goal whose tasks are all done would stay open on a stale list.
 * Anything less (a status flip, some tasks closed) keeps the reuse: an
 * evaluation over a turn that left no text is the one the reuse exists to
 * avoid (2026-11-02 — the evaluator called the silence "the same failure" and
 * stopped the goal).
 */
export function taskGateGapClosed(
  goal: { lastEvalGateOpen?: string[] },
  ledger: TaskLedger | undefined,
  exclude?: ReadonlySet<string>,
): boolean {
  if (!goal.lastEvalGateOpen?.length) return false;
  return !ledger || goalTasks(ledger, exclude).every((t) => t.status === 'completed');
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Gate an evaluator verdict on the latest task list. A `completed` verdict
 * with an open task becomes a gap that names the open tasks and tells the
 * model to finish them or take them off the list; anything else passes as is.
 *
 * `previousOpen` is the goal's `lastEvalGateOpen`: the tasks the previous
 * verdict was held on. The same tasks held again is the same failure — the
 * turn between closed none of them — so the gap carries the stall fields and
 * the loop stops to ask the owner instead of spending its budget (#968).
 */
export function gateGoalVerdictOnTasks(
  verdict: GoalEvalVerdict,
  ledger: TaskLedger | undefined,
  previousOpen?: readonly string[],
  /** Tasks a paused goal left open ({@link heldByWaitingGoals}) — not this goal's. */
  exclude?: ReadonlySet<string>,
): { verdict: GoalEvalVerdict; tasks?: GoalTaskGateHold } {
  if (!verdict.completed || !ledger) return { verdict };
  const current = goalTasks(ledger, exclude);
  const open = current.filter((t) => t.status !== 'completed');
  if (!open.length) return { verdict };
  const remaining = openTaskLines(ledger, exclude);
  const reason = [
    `${TASK_GATE_REASON_START} ${open.length} of ${current.length} tasks on your task list (TodoWrite) are not completed.`,
    'The goal completes only when the evaluator says so AND every task on the list is completed.',
    'Open tasks:',
    ...remaining.map((r) => `- ${r}`),
    'For each open task: finish it and mark it completed, or — if it is no longer part of this goal — remove it from (or update it on) the task list with TodoWrite.',
    // Kept in the recorded gap, so the next evaluation carries the acceptance forward
    // and only the task list is left to close.
    `Evaluator's reason for calling the objective met: ${verdict.reason}`,
  ].join('\n');
  const openIds = open.map((t) => t.id);
  const repeated = !!previousOpen?.length && sameIds(openIds, previousOpen);
  return {
    // The evaluator compared nothing — the host's own list held the goal open, so
    // the host says whether it is the same hold again.
    verdict: repeated
      ? {
          completed: false,
          reason,
          remaining,
          sameAsPrevious: true,
          sameConfidence: 1,
          // The evaluator's own word on the turn's work: a turn that did real work
          // (but left the list alone) must not be offered for rollback (#745).
          // Unknown is not "no work": without an explicit `false`, no rollback offer.
          progressed: verdict.progressed ?? true,
          userActions: [...TASK_GATE_STALL_ACTIONS],
        }
      : { completed: false, reason, remaining },
    tasks: { open: open.length, total: current.length, openIds, repeated, evalReason: verdict.reason },
  };
}
