import { applyEpicTasks, renderEpicTasksCard } from '../z/topics/epictasks-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/** `epictasks`, `epictasks status`, `epictasks on|off` (and `set on|off`, as `/z` translates it). */
const EPIC_TASKS_COMMAND = /^\/?epictasks(?:\s+(?:set\s+)?(\S+))?\s*$/i;

/**
 * E4 ④a-2 — the per-user switch for making epic tasks (.prd/19 D12).
 *
 *   - bare `epictasks` / `epictasks status` → the `/z epictasks` card
 *   - `epictasks on|off` → applyEpicTasks + a text ack
 */
export class EpicTasksHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return EPIC_TASKS_COMMAND.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const arg = text.trim().match(EPIC_TASKS_COMMAND)?.[1];
    if (!arg || arg.toLowerCase() === 'status') {
      const { text: fallback, blocks } = await renderEpicTasksCard({ userId: user, issuedAt: Date.now() });
      await say({ text: fallback ?? '🧭 에픽 작업', blocks, thread_ts: threadTs });
      return { handled: true };
    }
    const result = await applyEpicTasks({ userId: user, value: arg });
    await say({
      text: result.ok
        ? `✅ ${result.summary}\n\n${result.description ?? ''}`.trim()
        : `${result.summary}\n\n${result.description ?? ''}`.trim(),
      thread_ts: threadTs,
    });
    return { handled: true };
  }
}
