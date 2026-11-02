/**
 * A Slack-less task turn's `say` (#598 ④b, design 598b §3).
 *
 * Bound to one turn (session, conversation, turn id) so concurrent task turns
 * never share a destination. It writes to the work log instead of Slack,
 * never throws (so the processor's Slack fallback rendering is unreachable),
 * and returns no message ts. A rendered form — empty text with only blocks or
 * attachments — writes nothing: the structured question is registered by the
 * task question path, not by this text.
 */
import type { SayFn } from '../pipeline/types';
import type { WorkLogInput } from '../work-log';

export interface TaskTurnBinding {
  sessionKey: string;
  conversationId: string;
  turnId: string;
}

export type TaskWorkLogWrite = (binding: TaskTurnBinding, entry: WorkLogInput) => Promise<void>;

export function createTaskSay(binding: TaskTurnBinding, write: TaskWorkLogWrite): SayFn {
  return async (args) => {
    const text = args.text ?? '';
    if (!text.trim()) return {};
    // The writer's own receipt carries any failure; `say` never throws.
    await write(binding, { kind: 'notice', text, turnId: binding.turnId }).catch(() => {});
    return {};
  };
}
