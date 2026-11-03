/**
 * Plan mode (SSOT 2026-11-02; every session since #853) — the dashboard's 시작 / 취소 on a
 * session's plan (`POST /api/dashboard/session/:key/plan`, `setDashboardTaskPlanHandler`).
 *
 *   시작 — the waiting plan, exactly the revision the owner saw: the gate is saved
 *          `approved`, then the plan is sent into the thread as the decider's
 *          instruction (`planApprovedText`). A plan that was not taken puts the
 *          waiting plan back, so 시작 can be pressed again.
 *   취소 — a waiting plan, or one still being written: saved `cancelled`; nothing is
 *          sent. A later instruction plans afresh.
 *
 * 직접 입력 has no route of its own: any message to the thread while its plan waits is
 * direct input. (The dashboard-task decider beside this one was removed in #855.)
 */
import type { ConversationSession } from '../types';
import { decidePlan, type PlanDecision, planApprovedText, type TaskPlanDoc, type TaskPlanGate } from './task-plan';

export interface TaskPlanDecisionRequest {
  sessionKey: string;
  decision: PlanDecision;
  /** The revision the owner was shown. */
  revision: number;
  /** The signed-in user deciding — the work runs as them (SSOT 2026-11-02, as an answer does). */
  actorUserId: string;
}

/** The route's answer: its status and body. */
export interface TaskPlanDecisionResponse {
  status: number;
  body: Record<string, unknown>;
}

export type TaskPlanDecider = (request: TaskPlanDecisionRequest) => Promise<TaskPlanDecisionResponse>;

const refuse = (status: number, error: string): TaskPlanDecisionResponse => ({ status, body: { error } });

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
  /**
   * May this user start or cancel the plan? (#777) Someone else's instruction waits for the owner's
   * approval; a plan decision by someone the owner has not approved would start the work around that
   * gate, so it is refused (403) — the owner decides. Unset: whoever the route lets through.
   */
  mayDecide?: (sessionKey: string, session: ConversationSession, actorUserId: string) => boolean;
  /**
   * 시작 opens the plan's goal (2026-11-03), and the thread's goal loop drives it to the
   * plan's end. Called once the gate is saved `approved`, before the plan is sent (its turn is the goal's
   * opening turn); the undo runs when the plan is not taken. Unset: no goal.
   */
  openGoal?: (session: ConversationSession, plan: TaskPlanDoc, actorUserId: string) => () => void;
  now?: () => number;
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

/**
 * #853 — 시작 / 취소 on a Slack session in plan mode. 시작 saves the gate approved first — so the instruction's turn is not a planning
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
      // Not on an epic (#854): its children's ends wake it — a goal loop would talk over its wakes.
      if (session.kind !== 'epic') undoGoal = deps.openGoal?.(session, previous.plan, actorUserId);
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
