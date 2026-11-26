/**
 * .prd/39 S6 · D14 — the goal's part of a card's column: a projection, never stored.
 *
 * The dashboard places a card by its own rules first (epic, the per-user task queue, sleep, an open question or
 * permission, an armed resume or a host wait). Only when those say DONE (idle) does it ask {@link goalBoardPlace}:
 *
 *   2. a turn holds the session (S1 `turnHeld`), or a restart cut it and its resume has not run (S5) → 진행 중
 *   3. the slot's active goal asks the owner (cap · stall), or the loop stopped it on its own
 *      (judge-failed · start-failed · resume-failed)                                                → 응답 필요
 *   4. the slot's active goal is opening · retrying · running and someone drives it (S1 `driven`: a run on the slot,
 *      the loop judging or injecting, a drive deferred until the slot frees)                        → 진행 중
 *   5. anything else stays DONE — a hold reads as 일시정지, a person's stop as 멈춤 ({@link goalCardPhase}).
 *
 * Before this the board read only the display `activityState`: a goal the loop held sat in DONE with a "진행 중"
 * chip (X17), and a goal stopped by a failed judge or an unanswered cap question sat there too.
 */
import type { GoalHoldWhy, GoalStopWhy, SessionGoal } from './model';
import { type GoalPlaces, phaseOf, slotHoldOf } from './read';

/** What the host knows about the session right now (memory only — S1 · S5). */
export interface GoalBoardRuntime {
  /** A turn runs: its dispatcher run is preparing or running (S1). */
  turnHeld: boolean;
  /** Someone will act: a run holds the slot, the goal loop acts, or a goal drive waits for the slot to free (S1 · S4). */
  driven: boolean;
  /** A restart cut the session's turn and the resume it was given has not run yet (S5). */
  resumePending: boolean;
}

/** Why the goal moved the card out of DONE. */
export type GoalBoardWhy = 'turn' | 'resume' | 'driven' | 'cap' | 'stall' | Exclude<GoalStopWhy, 'person-stopped'>;

export type GoalBoardPlace =
  | { col: 'working'; why: 'turn' | 'resume' | 'driven' }
  | { col: 'waiting'; why: Exclude<GoalBoardWhy, 'turn' | 'resume' | 'driven'>; at: number };

/** The column the goal gives a card the dashboard's own rules left in DONE; undefined = it stays DONE. */
export function goalBoardPlace(session: GoalPlaces, runtime: GoalBoardRuntime): GoalBoardPlace | undefined {
  if (runtime.turnHeld) return { col: 'working', why: 'turn' };
  if (runtime.resumePending) return { col: 'working', why: 'resume' };
  const phase = phaseOf(session.goal);
  if (!phase) return undefined;
  switch (phase.kind) {
    case 'asking':
      return phase.ask.kind === 'cap'
        ? { col: 'waiting', why: 'cap', at: phase.ask.openedAt }
        : { col: 'waiting', why: 'stall', at: phase.ask.stall.stalledAt };
    case 'stopped':
      // A person's stop is theirs: nothing to answer, the card rests in DONE with its 멈춤 chip.
      return phase.why === 'person-stopped' ? undefined : { col: 'waiting', why: phase.why, at: phase.at };
    case 'opening':
    case 'retrying':
    case 'running':
      return runtime.driven ? { col: 'working', why: 'driven' } : undefined;
  }
}

/** What the card's goal line names the slot goal: its phase, or a hold with its why. */
export type GoalCardPhase =
  | { kind: 'opening' | 'running' | 'retrying' }
  | { kind: 'asking'; why: 'cap' | 'stall' }
  | { kind: 'stopped'; why: GoalStopWhy }
  | { kind: 'hold'; why?: GoalHoldWhy };

export function goalCardPhase(goal: SessionGoal | undefined): GoalCardPhase | undefined {
  if (!goal) return undefined;
  const hold = slotHoldOf({ goal });
  if (hold) return hold.holdWhy ? { kind: 'hold', why: hold.holdWhy } : { kind: 'hold' };
  const phase = phaseOf(goal);
  if (!phase) return undefined;
  if (phase.kind === 'asking') return { kind: 'asking', why: phase.ask.kind };
  if (phase.kind === 'stopped') return { kind: 'stopped', why: phase.why };
  return { kind: phase.kind };
}
