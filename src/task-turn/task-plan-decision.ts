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
import { decidePlan, type PlanDecision, planApprovedText, type TaskPlanDoc, type TaskPlanGate } from './task-plan';
import type { TaskCommandResponse, TaskTurnController } from './task-turn-controller';

export interface TaskPlanDeciderDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  /** The registry's strict write (`setTaskPlanGate`): a failed save puts the gate back and throws. */
  setTaskPlanGate(taskId: string, gate: TaskPlanGate): void;
  controller: Pick<TaskTurnController, 'canStart' | 'start' | 'isRunning'>;
  /**
   * May this user start or cancel the plan? (#777) Someone else's instruction waits for the owner's
   * approval; a plan decision by someone the owner has not approved would start the work around that
   * gate, so it is refused (403) — the owner decides. Unset: whoever the route lets through.
   */
  mayDecide?: (sessionKey: string, session: ConversationSession, actorUserId: string) => boolean;
  /**
   * 시작 opens the plan's goal (2026-11-03): the goal loop then continues the task turn after
   * turn until the plan is done, and resumes it after a restart. Called once the gate is saved
   * `approved`, before the start; returns the undo a start that does not happen runs (the plan
   * waits again, and so does no goal). Unset: no goal (the host has no goal loop).
   */
  openGoal?: (session: ConversationSession, plan: TaskPlanDoc, actorUserId: string) => () => void;
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
    if (deps.mayDecide && !deps.mayDecide(sessionKey, task, actorUserId)) {
      return refuse(403, "the plan is the task owner's to start or cancel — send your changes as an instruction");
    }
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
    // The plan's goal: the approved plan's turn is its opening turn.
    let undoGoal: (() => void) | undefined;
    try {
      // Not an epic: its children's events drive it (the epic waker); a goal loop beside the waker would
      // start the root again while its children run (trinity R1, fable P1-2).
      if (task.kind !== 'epic') undoGoal = deps.openGoal?.(task, previous.plan, actorUserId);
    } catch (error) {
      // No goal is no worse than before plan goals: the plan still starts, one turn at a time.
      deps.logger.warn('The plan’s goal could not be opened — the plan starts without it', {
        sessionKey,
        error: (error as Error)?.message,
      });
    }
    // Not started: the plan waits again, as it was — 시작 can be pressed again (a start that
    // throws, too: an approved gate with no turn would leave nothing to press — review R1, fable P3).
    const putBack = () => {
      try {
        undoGoal?.();
      } catch (error) {
        deps.logger.warn('A plan goal that did not start could not be undone', {
          sessionKey,
          error: (error as Error)?.message,
        });
      }
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

/** #853 — what 시작 / 취소 on a Slack session needs from the host. */
export interface SlackPlanDeciderDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  /** The registry's strict write (`setSessionPlanGate`): a failed save puts the gate back and throws. */
  setPlanGate(sessionKey: string, gate: TaskPlanGate): void;
  /**
   * Send the approved plan into the session's thread as `actorUserId`'s instruction — the
   * normal Slack path. True once it is taken: its turn runs, or it waits in the follow-up queue
   * behind a turn in flight (as its own turn — never pushed into a running one). False when it
   * was not taken (the thread could not be reached, the pipeline refused or halted it).
   */
  sendPlan(sessionKey: string, text: string, actorUserId: string): Promise<boolean>;
  /** As for a task (#777): someone the owner has not approved does not decide the owner's plan. */
  mayDecide?: (sessionKey: string, session: ConversationSession, actorUserId: string) => boolean;
  /**
   * As for a task (2026-11-03): 시작 opens the plan's goal, and the thread's goal loop drives it to the
   * plan's end. Called once the gate is saved `approved`, before the plan is sent (its turn is the goal's
   * opening turn); the undo runs when the plan is not taken. Unset: no goal.
   */
  openGoal?: (session: ConversationSession, plan: TaskPlanDoc, actorUserId: string) => () => void;
  now?: () => number;
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

/**
 * #853 — 시작 / 취소 on a Slack session in plan mode (the same rules as a task's, on the
 * Slack path). 시작 saves the gate approved first — so the instruction's turn is not a planning
 * turn — then sends the plan into the thread as the decider's own instruction, and answers once
 * it is taken (it runs, or waits in the queue behind a turn in flight). A plan that was not taken
 * puts the waiting plan back, so 시작 can be pressed again; one taken and then failing is the
 * work's failure — the start stands. 취소 is saved; nothing is sent. Every refusal changes nothing.
 */
export function createSlackPlanDecider(deps: SlackPlanDeciderDeps): TaskPlanDecider {
  const now = deps.now ?? Date.now;
  return async ({ sessionKey, decision, revision, actorUserId }) => {
    const session = deps.getSession(sessionKey);
    if (!session) return refuse(409, 'no such session');
    if (!session.taskPlan) return refuse(409, 'this task was not made in plan mode');
    if (!actorUserId) return refuse(403, 'sign in to start or cancel a plan');
    if (deps.mayDecide && !deps.mayDecide(sessionKey, session, actorUserId)) {
      return refuse(403, "the plan is the task owner's to start or cancel — send your changes as an instruction");
    }
    if (session.terminated || session.closing) return refuse(409, 'the task is closed');
    // No "busy" refusal: a turn in flight (the plan turn still wrapping up) only queues the plan.
    const previous = session.taskPlan;
    const decided = decidePlan(previous, decision, revision, actorUserId, now());
    if (!decided.ok) return refuse(decided.status, decided.error);

    if (decision === 'cancel') {
      deps.setPlanGate(sessionKey, decided.gate);
      deps.logger.info('Session plan cancelled from the dashboard', { sessionKey, revision, by: actorUserId });
      return { status: 200, body: { ok: true, state: 'cancelled', revision: decided.gate.revision } };
    }

    if (!previous.plan) return refuse(409, 'no plan is waiting to start');
    const text = planApprovedText(previous.plan, actorUserId);
    deps.setPlanGate(sessionKey, decided.gate);
    let undoGoal: (() => void) | undefined;
    try {
      undoGoal = deps.openGoal?.(session, previous.plan, actorUserId);
    } catch (error) {
      deps.logger.warn('The plan’s goal could not be opened — the plan starts without it', {
        sessionKey,
        error: (error as Error)?.message,
      });
    }
    const putBack = () => {
      try {
        undoGoal?.();
      } catch (error) {
        deps.logger.warn('The goal of a plan start that did not happen could not be taken back', {
          sessionKey,
          error: (error as Error)?.message,
        });
      }
      try {
        if (deps.getSession(sessionKey)?.taskPlan === decided.gate) deps.setPlanGate(sessionKey, previous);
      } catch (error) {
        deps.logger.warn('A plan start that did not happen could not be put back', {
          sessionKey,
          error: (error as Error)?.message,
        });
      }
    };
    let sent: boolean;
    try {
      sent = await deps.sendPlan(sessionKey, text, actorUserId);
    } catch (error) {
      putBack();
      throw error;
    }
    if (!sent) {
      putBack();
      return refuse(502, 'the plan could not be sent into the thread — try again');
    }
    deps.logger.info('Session plan started from the dashboard', { sessionKey, revision, by: actorUserId });
    return { status: 200, body: { ok: true, state: 'approved', revision: decided.gate.revision, started: true } };
  };
}
