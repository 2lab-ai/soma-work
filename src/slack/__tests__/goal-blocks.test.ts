/**
 * Goal interactive Block Kit builders (S1 + S3).
 *
 * Pins:
 *   - the goal-list blocks carry a Delete + Update button per live goal,
 *   - the button value codec round-trips,
 *   - the Update modal pre-fills the current objective + a stable callback_id,
 *   - the cap-decision DM carries Continue + Cancel buttons.
 */

import { describe, expect, it } from 'vitest';
import type { SessionGoal } from '../../types';
import {
  buildCapDecisionDmBlocks,
  buildGoalStatusBlocks,
  buildGoalUpdateModal,
  decodeGoalActionValue,
  encodeGoalActionValue,
  extractGoalUpdateObjective,
  GOAL_CANCEL_DM_ACTION_ID,
  GOAL_CONTINUE_DM_ACTION_ID,
  GOAL_DELETE_ACTION_PREFIX,
  GOAL_UPDATE_ACTION_PREFIX,
  GOAL_UPDATE_MODAL_BLOCK_ID,
  GOAL_UPDATE_MODAL_CALLBACK_ID,
  GOAL_UPDATE_MODAL_INPUT_ACTION_ID,
} from '../goal-blocks';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-1',
    objective: 'ship the feature',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U1',
    continuationCount: 2,
    maxContinuations: 10,
    ...overrides,
  };
}

const fmt = (o: string) => `\`${o}\``;
const metrics = () => '1m';

describe('buildGoalStatusBlocks (S1)', () => {
  it('renders Delete + Update buttons for the active goal and each queued goal', () => {
    const blocks = buildGoalStatusBlocks({
      sessionKey: 'C1:T1',
      channel: 'C1',
      threadTs: 'T1',
      goal: makeGoal(),
      queue: [makeGoal({ goalId: 'goal-2', objective: 'next one', status: 'queued' })],
      history: [],
      formatObjective: fmt,
      formatMetrics: metrics,
    });

    const actionRows = blocks.filter((b) => b.type === 'actions');
    // one row for the active goal, one for the queued goal
    expect(actionRows).toHaveLength(2);

    const ids = actionRows.flatMap((r) => r.elements.map((e: any) => e.action_id));
    expect(ids).toContain(`${GOAL_DELETE_ACTION_PREFIX}goal-1`);
    expect(ids).toContain(`${GOAL_UPDATE_ACTION_PREFIX}goal-1`);
    expect(ids).toContain(`${GOAL_DELETE_ACTION_PREFIX}goal-2`);
    expect(ids).toContain(`${GOAL_UPDATE_ACTION_PREFIX}goal-2`);

    // each button's value decodes to the goal it controls
    const firstDelete = actionRows[0].elements.find((e: any) => e.action_id.startsWith(GOAL_DELETE_ACTION_PREFIX));
    expect(decodeGoalActionValue(firstDelete.value)).toEqual({
      sessionKey: 'C1:T1',
      goalId: 'goal-1',
      channel: 'C1',
      threadTs: 'T1',
    });
  });

  it('does NOT render buttons for completed history rows', () => {
    const blocks = buildGoalStatusBlocks({
      sessionKey: 'C1:T1',
      goal: undefined,
      queue: [],
      history: [makeGoal({ goalId: 'goal-done', status: 'complete', completionReason: 'done' })],
      formatObjective: fmt,
      formatMetrics: metrics,
    });
    expect(blocks.filter((b) => b.type === 'actions')).toHaveLength(0);
  });
});

describe('goal action value codec', () => {
  it('round-trips and rejects garbage', () => {
    const v = { sessionKey: 'C1:T1', goalId: 'g1', channel: 'C1', threadTs: 'T1' };
    expect(decodeGoalActionValue(encodeGoalActionValue(v))).toEqual(v);
    expect(decodeGoalActionValue('not json')).toBeNull();
    expect(decodeGoalActionValue(JSON.stringify({ goalId: 'g1' }))).toBeNull();
    expect(decodeGoalActionValue(undefined)).toBeNull();
  });
});

describe('buildGoalUpdateModal (S1)', () => {
  it('pre-fills the current objective and uses the stable callback id', () => {
    const modal = buildGoalUpdateModal({
      value: { sessionKey: 'C1:T1', goalId: 'g1' },
      currentObjective: 'old objective',
    });
    expect(modal.callback_id).toBe(GOAL_UPDATE_MODAL_CALLBACK_ID);
    expect(decodeGoalActionValue(modal.private_metadata)).toMatchObject({ goalId: 'g1' });
    const input = modal.blocks[0];
    expect(input.block_id).toBe(GOAL_UPDATE_MODAL_BLOCK_ID);
    expect(input.element.action_id).toBe(GOAL_UPDATE_MODAL_INPUT_ACTION_ID);
    expect(input.element.initial_value).toBe('old objective');
  });

  it('extractGoalUpdateObjective reads the submitted value', () => {
    const view = {
      state: { values: { [GOAL_UPDATE_MODAL_BLOCK_ID]: { [GOAL_UPDATE_MODAL_INPUT_ACTION_ID]: { value: 'new!' } } } },
    };
    expect(extractGoalUpdateObjective(view)).toBe('new!');
    expect(extractGoalUpdateObjective({})).toBeNull();
  });
});

describe('buildCapDecisionDmBlocks (S3)', () => {
  it('renders Continue + Cancel buttons carrying the goal value', () => {
    const blocks = buildCapDecisionDmBlocks({
      value: { sessionKey: 'C1:T1', goalId: 'g1' },
      objective: 'ship it',
      maxContinuations: 10,
      reason: 'still going',
      formatObjective: fmt,
    });
    const actions = blocks.find((b) => b.type === 'actions');
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toContain(GOAL_CONTINUE_DM_ACTION_ID);
    expect(ids).toContain(GOAL_CANCEL_DM_ACTION_ID);
    expect(decodeGoalActionValue(actions.elements[0].value)).toMatchObject({ goalId: 'g1' });
  });
});
