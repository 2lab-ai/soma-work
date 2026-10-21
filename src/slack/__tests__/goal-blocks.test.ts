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

describe('buildGoalStatusBlocks — Slack 3000-char section cap (goal-status invalid_blocks regression)', () => {
  /**
   * Live incident (2026-07-09, work-m64 dev): 6 completed goals whose
   * `completionReason` each carried a multi-hundred-char eval paragraph were
   * JOINED into one history section → 3000+ chars → chat.postMessage failed
   * with `invalid_blocks` → GoalHandler threw → CommandRouter fell through →
   * autogoal promoted the literal text `goal` to a session goal.
   *
   * Invariant pinned here: NO section emitted by the builder may exceed
   * Slack's 3000-char text limit, no matter how verbose the stored
   * objectives / completion reasons are.
   */
  const hugeReason = 'The objective is a question asking what the problem was and what was fixed. '.repeat(20); // ~1.5k chars
  const hugeObjective = '아 뭘 고친거야 진짜 잘못된거 많다고 했잖아 1. 6.845 TRX 안썼어 왜 썼다고 생각함? '.repeat(20); // ~1k chars

  const longMetrics = () => '2h 16m · 242 in / 167.5k out / 72.1M cache · $333.33';
  // Mirrors the production formatter (session-goal.ts formatGoalObjectiveForSlack):
  // ~900-char clip inside backticks.
  const prodLikeFmt = (o: string) => {
    const normalized = o.replace(/\s+/g, ' ').trim();
    const clipped = normalized.length > 900 ? `${normalized.slice(0, 897)}...` : normalized;
    return `\`${clipped.replace(/`/g, "'")}\``;
  };

  const sectionTexts = (blocks: any[]): string[] =>
    blocks.filter((b) => b.type === 'section').map((b) => b.text.text as string);

  it('history section stays under 3000 chars with 10 verbose completed goals', () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      makeGoal({
        goalId: `done-${i}`,
        objective: hugeObjective,
        status: 'complete',
        completionReason: hugeReason,
      }),
    );
    const blocks = buildGoalStatusBlocks({
      sessionKey: 'C1:T1',
      history,
      formatObjective: prodLikeFmt,
      formatMetrics: longMetrics,
    });
    for (const text of sectionTexts(blocks)) {
      expect(text.length).toBeLessThanOrEqual(3000);
    }
    // The overflow must be summarized, not silently dropped.
    const historySection = sectionTexts(blocks).find((t) => t.includes('Completed goals'));
    expect(historySection).toBeDefined();
    expect(historySection).toMatch(/older/);
  });

  it('current-goal section stays under 3000 chars with a huge completionReason', () => {
    const blocks = buildGoalStatusBlocks({
      sessionKey: 'C1:T1',
      goal: makeGoal({
        objective: hugeObjective,
        status: 'complete',
        completedAt: 1,
        completionReason: hugeReason.repeat(3), // ~4.5k chars alone
      }),
      formatObjective: prodLikeFmt,
      formatMetrics: longMetrics,
    });
    for (const text of sectionTexts(blocks)) {
      expect(text.length).toBeLessThanOrEqual(3000);
    }
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
