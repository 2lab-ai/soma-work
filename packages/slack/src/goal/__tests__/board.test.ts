/**
 * .prd/39 S6 · D14 — the goal's part of a card's column, as a table (A17, X17). The dashboard asks it only when its
 * own rules said DONE (idle): rule 2 a turn or a restart resume → 진행 중; rule 3 a question or a stop the owner must
 * answer → 응답 필요; rule 4 a goal someone drives → 진행 중; rule 5 the rest stays DONE, with the slot's chip.
 */
import { describe, expect, it } from 'vitest';
import { type GoalBoardRuntime, goalBoardPlace, goalCardPhase } from '../board';
import type { SessionGoal } from '../model';

const goal = (over: Partial<SessionGoal> = {}): SessionGoal => ({
  goalId: 'g1',
  objective: 'ship',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'U1',
  continuationCount: 0,
  maxContinuations: 10,
  ...over,
});
const stall = { stallId: 's1', stalledAt: 7, reason: 'same', actions: ['a'], confidence: 0.99 };
const idle: GoalBoardRuntime = { turnHeld: false, driven: false, resumePending: false };
const driven: GoalBoardRuntime = { ...idle, driven: true };

describe('goalBoardPlace (S6 rules 2–5)', () => {
  it.each<[string, { goal?: SessionGoal }, GoalBoardRuntime, ReturnType<typeof goalBoardPlace>]>([
    // Rule 2 — a turn holds the session, or a restart cut it and its resume has not run: at work, goal or not.
    ['a held turn without a goal', {}, { ...idle, turnHeld: true }, { col: 'working', why: 'turn' }],
    ['a restart resume pending', { goal: goal() }, { ...idle, resumePending: true }, { col: 'working', why: 'resume' }],
    // Rule 3 — the owner must answer.
    [
      'an open cap question',
      { goal: goal({ capDmPendingAt: 5, capDecisionId: 'r' }) },
      driven,
      { col: 'waiting', why: 'cap', at: 5 },
    ],
    ['an open stall question', { goal: goal({ stall }) }, idle, { col: 'waiting', why: 'stall', at: 7 }],
    [
      'stopped: the judge failed',
      { goal: goal({ phase: { kind: 'stopped', why: 'judge-failed', at: 9 } }) },
      idle,
      { col: 'waiting', why: 'judge-failed', at: 9 },
    ],
    [
      'stopped: the continuation could not start',
      { goal: goal({ phase: { kind: 'stopped', why: 'start-failed', at: 9 } }) },
      idle,
      { col: 'waiting', why: 'start-failed', at: 9 },
    ],
    [
      'stopped: the resume failed',
      { goal: goal({ phase: { kind: 'stopped', why: 'resume-failed', at: 9 } }) },
      idle,
      { col: 'waiting', why: 'resume-failed', at: 9 },
    ],
    // Rule 4 — a goal the loop drives (a judge, an injection, a drive deferred until the slot frees).
    ['running and driven (A17)', { goal: goal() }, driven, { col: 'working', why: 'driven' }],
    ['the opening, driven', { goal: goal({ openingPending: true }) }, driven, { col: 'working', why: 'driven' }],
    ['retrying, driven', { goal: goal({ evalBackoffUntil: 99 }) }, driven, { col: 'working', why: 'driven' }],
    // Rule 5 — the rest is DONE.
    [
      'a person stopped it',
      { goal: goal({ phase: { kind: 'stopped', why: 'person-stopped', at: 9 } }) },
      driven,
      undefined,
    ],
    ['a hold in the slot', { goal: goal({ status: 'paused', holdWhy: 'cap-stop' }) }, driven, undefined],
    ['running, nobody drives it', { goal: goal() }, idle, undefined],
    ['no goal', {}, driven, undefined],
  ])('%s', (_name, session, runtime, expected) => {
    expect(goalBoardPlace(session, runtime)).toEqual(expected);
  });
});

describe('goalCardPhase — what the card names the slot goal', () => {
  it.each<[string, SessionGoal | undefined, ReturnType<typeof goalCardPhase>]>([
    ['running', goal(), { kind: 'running' }],
    ['opening', goal({ openingPending: true }), { kind: 'opening' }],
    ['retrying', goal({ evalBackoffUntil: 99 }), { kind: 'retrying' }],
    ['asking cap', goal({ capDmPendingAt: 5 }), { kind: 'asking', why: 'cap' }],
    ['asking stall', goal({ stall }), { kind: 'asking', why: 'stall' }],
    [
      'stopped',
      goal({ phase: { kind: 'stopped', why: 'person-stopped', at: 9 } }),
      { kind: 'stopped', why: 'person-stopped' },
    ],
    ['a hold', goal({ status: 'paused', holdWhy: 'dashboard-stop' }), { kind: 'hold', why: 'dashboard-stop' }],
    ['a legacy hold without a why', goal({ status: 'paused' }), { kind: 'hold' }],
    ['no goal', undefined, undefined],
    ['a complete goal', goal({ status: 'complete' }), undefined],
  ])('%s', (_name, g, expected) => {
    expect(goalCardPhase(g)).toEqual(expected);
  });
});
