/**
 * Block Kit builders + action-id constants for the interactive `goal` UI.
 *
 * Shared by:
 *   - `GoalHandler.showStatus` (renders the goal list with per-goal Delete /
 *     Update buttons — S1),
 *   - `GoalActionHandler` (services those buttons + the cap-reached owner-DM
 *     Continue / Cancel buttons — S1 + S3),
 *   - `GoalLoopController` (builds the cap-decision DM blocks — S3).
 *
 * Keeping the action-ids and value codec in one module is what guarantees the
 * builder and the handler agree on the wire format.
 */

import type { SessionGoal } from '../types';

// ── action_id prefixes (regex-registered in packages/slack/actions) ─────────
/** `goal_delete:<goalId>` — delete one goal from the list. */
export const GOAL_DELETE_ACTION_PREFIX = 'goal_delete:';
/** `goal_update:<goalId>` — open the edit modal for one goal. */
export const GOAL_UPDATE_ACTION_PREFIX = 'goal_update:';
/** Owner-DM "keep going" button (S3). */
export const GOAL_CONTINUE_DM_ACTION_ID = 'goal_continue_dm';
/** Owner-DM "stop" button (S3). */
export const GOAL_CANCEL_DM_ACTION_ID = 'goal_cancel_dm';

// ── modal (Update edit box) ─────────────────────────────────────────────────
export const GOAL_UPDATE_MODAL_CALLBACK_ID = 'goal_update_modal_submit';
export const GOAL_UPDATE_MODAL_BLOCK_ID = 'goal_update_block';
export const GOAL_UPDATE_MODAL_INPUT_ACTION_ID = 'goal_update_input';

/** Button-value / modal-metadata payload shared by every interactive surface. */
export interface GoalActionValue {
  sessionKey: string;
  goalId: string;
  channel?: string;
  threadTs?: string;
}

export function encodeGoalActionValue(value: GoalActionValue): string {
  return JSON.stringify(value);
}

export function decodeGoalActionValue(raw: unknown): GoalActionValue | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.sessionKey === 'string' && typeof parsed.goalId === 'string') {
      return {
        sessionKey: parsed.sessionKey,
        goalId: parsed.goalId,
        channel: typeof parsed.channel === 'string' ? parsed.channel : undefined,
        threadTs: typeof parsed.threadTs === 'string' ? parsed.threadTs : undefined,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Trim an objective for a one-line Block Kit row. */
function objectiveLine(objective: string, max = 280): string {
  const normalized = objective.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function actionButtons(value: GoalActionValue): any {
  const encoded = encodeGoalActionValue(value);
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✏️ 업데이트', emoji: true },
        action_id: `${GOAL_UPDATE_ACTION_PREFIX}${value.goalId}`,
        value: encoded,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🗑️ 삭제', emoji: true },
        style: 'danger',
        action_id: `${GOAL_DELETE_ACTION_PREFIX}${value.goalId}`,
        value: encoded,
      },
    ],
  };
}

export interface GoalStatusBlocksInput {
  sessionKey: string;
  channel?: string;
  threadTs?: string;
  goal?: SessionGoal;
  queue?: SessionGoal[];
  history?: SessionGoal[];
  /** Render a backstop section so the rows never truncate past this count. */
  listLimit?: number;
  /** Pre-rendered objective formatter (kept in sync with text status). */
  formatObjective: (objective: string) => string;
  formatMetrics: (goal: SessionGoal) => string;
}

/**
 * Build the interactive goal-list blocks (S1). The current goal and every
 * queued goal each get a Delete + Update button row; completed history is
 * text-only (a finished goal cannot be deleted/updated).
 */
export function buildGoalStatusBlocks(input: GoalStatusBlocksInput): any[] {
  const { sessionKey, channel, threadTs, goal, formatObjective, formatMetrics } = input;
  const queue = input.queue ?? [];
  const history = input.history ?? [];
  const limit = input.listLimit ?? 10;
  const blocks: any[] = [];

  const valueFor = (g: SessionGoal): GoalActionValue => ({ sessionKey, goalId: g.goalId, channel, threadTs });

  if (goal) {
    const lines = [`🎯 *Current goal* — _${goal.status}_`, `*Objective:* ${formatObjective(goal.objective)}`];
    lines.push(`*Spent:* ${formatMetrics(goal)}`);
    if (goal.status === 'active') {
      lines.push(`*Auto-continuations:* ${goal.continuationCount}/${goal.maxContinuations}`);
    }
    if (goal.completedAt) {
      lines.push(
        `*Completed:* ${new Date(goal.completedAt).toISOString()} (${goal.completionReason ?? goal.completedVia ?? 'done'})`,
      );
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
    // Buttons make sense only while the goal is still live (active/paused).
    if (goal.status === 'active' || goal.status === 'paused') {
      blocks.push(actionButtons(valueFor(goal)));
    }
  }

  if (queue.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `📋 *Queued goals (${queue.length})* — start automatically in order:` },
    });
    for (const q of queue.slice(0, limit)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `• ${formatObjective(q.objective)}` } });
      blocks.push(actionButtons(valueFor(q)));
    }
    if (queue.length > limit) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${queue.length - limit} more` }] });
    }
  }

  if (history.length > 0) {
    blocks.push({ type: 'divider' });
    const recent = [...history].reverse().slice(0, limit);
    const lines = [`✅ *Completed goals (${history.length})* — most recent first:`];
    for (const h of recent) {
      const reason = h.completionReason ?? h.completedVia ?? 'done';
      // codex review #4: history rows are JOINED into a single section, and
      // `formatObjective` can emit ~900 chars each — `limit` (10) of those would
      // blow past Slack's 3000-char section cap and fail the whole message with
      // `invalid_blocks`. Use a tight per-row trim so the joined block stays
      // well under the limit (≤ ~10×200 + overhead).
      lines.push(`• \`${objectiveLine(h.objective, 160).replace(/`/g, "'")}\` — _${reason}_ · ${formatMetrics(h)}`);
    }
    if (history.length > recent.length) lines.push(`…and ${history.length - recent.length} older`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
  }

  return blocks;
}

/** Build the `views.open` modal for the Update button (S1). */
export function buildGoalUpdateModal(args: { value: GoalActionValue; currentObjective: string }): any {
  return {
    type: 'modal',
    callback_id: GOAL_UPDATE_MODAL_CALLBACK_ID,
    private_metadata: encodeGoalActionValue(args.value),
    title: { type: 'plain_text', text: '🎯 goal 업데이트'.slice(0, 24) },
    submit: { type: 'plain_text', text: '저장' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: GOAL_UPDATE_MODAL_BLOCK_ID,
        label: { type: 'plain_text', text: 'Objective' },
        element: {
          type: 'plain_text_input',
          action_id: GOAL_UPDATE_MODAL_INPUT_ACTION_ID,
          multiline: true,
          initial_value: args.currentObjective.slice(0, 3000),
        },
      },
    ],
  };
}

/** Extract the new objective from a goal-update modal view-submission. */
export function extractGoalUpdateObjective(view: any): string | null {
  const v = view?.state?.values?.[GOAL_UPDATE_MODAL_BLOCK_ID]?.[GOAL_UPDATE_MODAL_INPUT_ACTION_ID]?.value;
  return typeof v === 'string' ? v : null;
}

/**
 * Build the cap-reached owner-DM blocks with Continue / Cancel buttons (S3).
 * Posted to the goal owner's DM when the auto-continuation budget is exhausted.
 */
export function buildCapDecisionDmBlocks(args: {
  value: GoalActionValue;
  objective: string;
  maxContinuations: number;
  reason: string;
  formatObjective: (objective: string) => string;
}): any[] {
  const encoded = encodeGoalActionValue(args.value);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `⏳ *Goal auto-continuation reached its ${args.maxContinuations}-turn budget.*`,
          `*Objective:* ${args.formatObjective(args.objective)}`,
          `*Latest reason:* ${objectiveLine(args.reason, 600)}`,
          '',
          '계속 진행할까요?',
        ].join('\n'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ 계속', emoji: true },
          style: 'primary',
          action_id: GOAL_CONTINUE_DM_ACTION_ID,
          value: encoded,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🛑 취소', emoji: true },
          style: 'danger',
          action_id: GOAL_CANCEL_DM_ACTION_ID,
          value: encoded,
        },
      ],
    },
  ];
}
