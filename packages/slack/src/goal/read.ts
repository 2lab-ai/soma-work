/**
 * .prd/39 S2 · S3 · 40 §2 — the one place that reads a goal's place and phase. Control flow asks `phaseOf` and
 * `placeOf`; it does not test the fields they are computed from (`capDmPendingAt`, `stall`, `openingPending`,
 * `evalBackoffUntil`, `status`). Until the stored shape carries `phase` (PR7), both are computed from those fields.
 */
import type { SessionGoal, SessionGoalStall } from './model';

/** The cap question's round: open since `openedAt`; `dmRef` once its DM landed. A legacy round may have no id. */
export interface GoalCapAsk {
  kind: 'cap';
  roundId?: string;
  openedAt: number;
  dmRef?: { channel: string; ts: string };
}

/** The stall question: the same failure twice, the owner picks the next step. */
export interface GoalStallAsk {
  kind: 'stall';
  stall: SessionGoalStall;
}

/**
 * The phase of the active goal (S3). `stopped` has no legacy form yet — PR8 stores it; until then it is never
 * computed here.
 */
export type GoalPhase =
  | { kind: 'opening' }
  | { kind: 'running' }
  | { kind: 'retrying'; until: number; attempt: number; reason?: string }
  | { kind: 'asking'; ask: GoalCapAsk | GoalStallAsk };

/** Where a goal sits (S2). A goal out of the session (deleted) has no place. */
export type GoalPlace = 'slot-active' | 'slot-hold' | 'slot-complete' | 'queue' | 'shelf' | 'history';

/** The fields a phase is computed from — structural, so a surface that carries a partial goal can ask too. */
export interface GoalPhaseFields {
  status?: string;
  openingPending?: boolean;
  capDmPendingAt?: number;
  capDecisionId?: string;
  capDmRef?: { channel: string; ts: string };
  stall?: unknown;
  evalBackoffUntil?: number;
  evalDispatchRetryCount?: number;
  evalRetryReason?: string;
}

/**
 * The phase of a goal in the slot that is `active`; undefined for any other goal (queued, paused, complete — they
 * have no phase, I2). Precedence follows the transitions: the opening comes before any judge; a question waits
 * before a retry; a retry before running.
 */
export function phaseOf(goal: GoalPhaseFields | undefined): GoalPhase | undefined {
  if (!goal || goal.status !== 'active') return undefined;
  if (goal.openingPending === true) return { kind: 'opening' };
  if (goal.capDmPendingAt !== undefined) {
    return {
      kind: 'asking',
      ask: { kind: 'cap', roundId: goal.capDecisionId, openedAt: goal.capDmPendingAt, dmRef: goal.capDmRef },
    };
  }
  if (goal.stall) return { kind: 'asking', ask: { kind: 'stall', stall: goal.stall as SessionGoalStall } };
  if (goal.evalBackoffUntil !== undefined) {
    return {
      kind: 'retrying',
      until: goal.evalBackoffUntil,
      attempt: goal.evalDispatchRetryCount ?? 0,
      reason: goal.evalRetryReason,
    };
  }
  return { kind: 'running' };
}

/** The open cap question of the active goal, if any. */
export function capAskOf(goal: GoalPhaseFields | undefined): GoalCapAsk | undefined {
  const phase = phaseOf(goal);
  return phase?.kind === 'asking' && phase.ask.kind === 'cap' ? phase.ask : undefined;
}

/** The open stall question of the active goal, if any. */
export function stallAskOf(goal: GoalPhaseFields | undefined): GoalStallAsk | undefined {
  const phase = phaseOf(goal);
  return phase?.kind === 'asking' && phase.ask.kind === 'stall' ? phase.ask : undefined;
}

/** The phases the loop drives (D2): it judges a running goal, and a retrying one once its window has passed. */
export function loopDrives(phase: GoalPhase | undefined): phase is Extract<GoalPhase, { kind: 'running' | 'retrying' }> {
  return phase?.kind === 'running' || phase?.kind === 'retrying';
}

/** The session fields that hold goals. */
export interface GoalPlaces {
  goal?: SessionGoal;
  goalQueue?: SessionGoal[];
  goalPaused?: SessionGoal[];
  goalHistory?: SessionGoal[];
}

/**
 * Where `goal` sits in `session` (S2), by identity first and then by `goalId`. The slot holds one goal: `active`,
 * a hold (`paused` in the slot — a cap stop, a dashboard stop with a queue, a cancelled opening) or, until PR7 takes
 * completed goals out of the slot, `complete`.
 */
export function placeOf(session: GoalPlaces, goal: SessionGoal): GoalPlace | undefined {
  const same = (g: SessionGoal | undefined) => !!g && (g === goal || g.goalId === goal.goalId);
  if (same(session.goal)) {
    const status = session.goal?.status;
    if (status === 'active') return 'slot-active';
    if (status === 'paused') return 'slot-hold';
    if (status === 'complete') return 'slot-complete';
  }
  if (session.goalQueue?.some(same)) return 'queue';
  if (session.goalPaused?.some(same)) return 'shelf';
  if (session.goalHistory?.some(same)) return 'history';
  return undefined;
}

/** The slot's goal while it holds a place a person or the loop still acts on: `active` or a hold. */
export function slotGoalInFlight(session: GoalPlaces): SessionGoal | undefined {
  const g = session.goal;
  if (!g) return undefined;
  const place = placeOf(session, g);
  return place === 'slot-active' || place === 'slot-hold' ? g : undefined;
}

/** The slot's goal while it is a hold (`paused` in the slot — a cap stop, a dashboard stop with a queue, a cancelled opening). */
export function slotHoldOf(session: GoalPlaces): SessionGoal | undefined {
  const g = session.goal;
  return g && placeOf(session, g) === 'slot-hold' ? g : undefined;
}
