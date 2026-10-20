import type { ConversationSession, SessionGoal } from '../types';

export const MAX_SESSION_GOAL_OBJECTIVE_CHARS = 4_000;

// NOTE: there is no completion sentinel. An earlier design instructed the
// model to emit `<goal-complete-request .../>` as a pseudo-`update_goal`
// signal, but the host never parsed it — `GoalLoopController` runs an
// independent eval after EVERY active-goal turn regardless (N10,
// docs/goal-command/spec.md §Completion). The prompts now ask only for a
// plain-language completion self-assessment, which the eval reads as one
// piece of work-summary evidence; the host (or the user) decides.

export function countGoalObjectiveChars(value: string): number {
  return Array.from(value).length;
}

export function validateSessionGoalObjective(objective: string): string | null {
  if (!objective.trim()) return 'goal objective must not be empty';
  if (countGoalObjectiveChars(objective) > MAX_SESSION_GOAL_OBJECTIVE_CHARS) {
    return `goal objective must be at most ${MAX_SESSION_GOAL_OBJECTIVE_CHARS} characters`;
  }
  return null;
}

/**
 * Escape only the tag delimiters so user text cannot open or close a tag
 * (`</objective>`, `</previous-eval-reason>`). `&` is left alone on purpose:
 * Slack already delivers `<`/`>`/`&` as `&lt;`/`&gt;`/`&amp;`, and
 * re-escaping `&` turned every `&gt;` into `&amp;gt;`.
 */
export function escapeSessionGoalText(input: string): string {
  return input.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * System-prompt block: the ONLY place the objective and the goal rules
 * reach the model. The opening turn of a goal sends the user's raw text, and
 * continuation turns send a one-line nudge that points back here.
 */
export function buildSessionGoalBlock(session?: ConversationSession): string {
  const goal = session?.goal;
  if (!goal || goal.status !== 'active') return '';

  return [
    '<session-goal status="active">',
    '<objective>',
    escapeSessionGoalText(goal.objective),
    '</objective>',
    'This goal persists across turns. After every turn a host evaluator checks it against your output; you cannot mark it complete yourself.',
    '- Pursue the full objective; do not shrink it to an easier task.',
    '- End each turn with a short summary of what you did and the evidence (files, commands, test/PR results).',
    '- Say the goal is done only when every requirement has concrete evidence.',
    '</session-goal>',
  ].join('\n');
}

/**
 * Text of the synthetic turn GoalLoopController injects after the host
 * evaluator judged the goal unfinished (prefixed with `[goal-continuation]`
 * by the caller). One line: the objective and the rules already sit in the
 * `<session-goal>` system block, so repeating them here only burned context.
 * The first sentence doubles as the memory-capture filter marker
 * (`memory-auto-capture.ts`) — keep it verbatim.
 *
 * When the evaluator left a gap reason, it is appended so the next turn
 * targets that specific gap instead of repeating the same claim.
 */
export function buildGoalContinuationPrompt(goal: SessionGoal): string {
  const line = `Continue working toward the active session goal (objective in <session-goal>). Auto-continuation ${goal.continuationCount}/${goal.maxContinuations}.`;
  const reason = goal.lastEvalReason?.trim();
  if (!reason) return line;
  return [
    line,
    '',
    'Previous evaluation gap — close this before claiming completion:',
    '<previous-eval-reason>',
    escapeSessionGoalText(reason),
    '</previous-eval-reason>',
  ].join('\n');
}
