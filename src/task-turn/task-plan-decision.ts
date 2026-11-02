/**
 * Plan mode (SSOT 2026-11-02) — the dashboard's 시작 / 취소 on a task's plan
 * (`POST /api/dashboard/session/:key/plan`, `setDashboardTaskPlanHandler`).
 *
 *   시작 — the waiting plan, exactly the revision the owner saw: a dry run of
 *          admission first (a refusal changes nothing), then the gate is saved
 *          `approved`, then the work starts with the plan in its instruction
 *          (`planApprovedText`). A start that does not happen puts the waiting
 *          plan back, so 시작 can be pressed again.
 *   취소 — a waiting plan, or one still being written while nothing runs: saved
 *          `cancelled`; no turn. A later instruction plans afresh.
 *
 * 직접 입력 has no route of its own: any instruction to the task while its
 * plan waits is direct input (the controller's `planGateTurn`).
 */
import type { ConversationSession } from '../types';
import { decidePlan, type PlanDecision, planApprovedText, type TaskPlanGate } from './task-plan';
import type { TaskCommandResponse, TaskTurnController } from './task-turn-controller';

export interface TaskPlanDeciderDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  /** The registry's strict write (`setTaskPlanGate`): a failed save puts the gate back and throws. */
  setTaskPlanGate(taskId: string, gate: TaskPlanGate): void;
  controller: Pick<TaskTurnController, 'canStart' | 'start' | 'isRunning'>;
  now?: () => number;
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export interface TaskPlanDecisionRequest {
  sessionKey: string;
  decision: PlanDecision;
  /** The revision the owner was shown. */
  revision: number;
  /** The signed-in user deciding — the work runs as them (SSOT 2026-11-02, as an answer does). */
  actorUserId: string;
}

export type TaskPlanDecider = (request: TaskPlanDecisionRequest) => Promise<TaskCommandResponse>;

const refuse = (status: number, error: string): TaskCommandResponse => ({ status, body: { error } });

export function createTaskPlanDecider(deps: TaskPlanDeciderDeps): TaskPlanDecider {
  const now = deps.now ?? Date.now;
  return async ({ sessionKey, decision, revision, actorUserId }) => {
    const task = deps.getSession(sessionKey);
    if (!task || task.slackless !== true || !task.taskId) return refuse(409, 'not a dashboard task');
    if (!task.taskPlan) return refuse(409, 'this task was not made in plan mode');
    if (!actorUserId) return refuse(403, 'sign in to start or cancel a plan');
    if (task.terminated || task.closing) return refuse(409, 'the task is closed');
    // A turn in flight is still writing (or revising) the plan: Stop it first.
    if (deps.controller.isRunning(sessionKey)) {
      return refuse(409, 'the task is still working on its plan — wait for it, or stop it first');
    }
    const decided = decidePlan(task.taskPlan, decision, revision, actorUserId, now());
    if (!decided.ok) return refuse(decided.status, decided.error);
    const previous = task.taskPlan;
    const taskId = task.taskId;

    if (decision === 'cancel') {
      deps.setTaskPlanGate(taskId, decided.gate);
      deps.logger.info('Task plan cancelled from the dashboard', { sessionKey, revision, by: actorUserId });
      return { status: 200, body: { ok: true, state: 'cancelled', revision: decided.gate.revision } };
    }

    // decidePlan starts only a waiting plan, so it has one; the check keeps the type honest.
    if (!previous.plan) return refuse(409, 'no plan is waiting to start');
    const text = planApprovedText(previous.plan, actorUserId);
    // A dry run first: a refusal (another task of the owner runs, the window) changes nothing.
    // An epic starts in its own tree's slot (E4 ③), as the controller's start will place it.
    const refused =
      task.kind === 'epic'
        ? deps.controller.canStart(task.ownerId, text, { root: sessionKey, role: 'root' })
        : deps.controller.canStart(task.ownerId, text);
    if (refused) return refused;
    deps.setTaskPlanGate(taskId, decided.gate);
    // Not started: the plan waits again, as it was — 시작 can be pressed again (a start that
    // throws, too: an approved gate with no turn would leave nothing to press — review R1, fable P3).
    const putBack = () => {
      try {
        if (deps.getSession(sessionKey)?.taskPlan === decided.gate) deps.setTaskPlanGate(taskId, previous);
      } catch (error) {
        deps.logger.warn('A plan start that did not happen could not be put back', {
          sessionKey,
          error: (error as Error)?.message,
        });
      }
    };
    let started: TaskCommandResponse;
    try {
      started = await deps.controller.start({ sessionKey, text, actorUserId });
    } catch (error) {
      putBack();
      throw error;
    }
    if (started.status === 202) {
      deps.logger.info('Task plan started from the dashboard', { sessionKey, revision, by: actorUserId });
      return {
        status: 200,
        body: { ok: true, state: 'approved', revision: decided.gate.revision, started: true },
        ...(started.done ? { done: started.done } : {}),
      };
    }
    putBack();
    return started;
  };
}
