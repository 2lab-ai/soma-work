import { applyTaskEntry, renderTaskEntryCard } from '../z/topics/taskentry-topic';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/** `taskentry`, `taskentry status`, `taskentry on|off` (and `set on|off`, as `/z` translates it). */
const TASK_ENTRY_COMMAND = /^\/?taskentry(?:\s+(?:set\s+)?(\S+))?\s*$/i;

/**
 * E2 ⑧ — the Slack entry's per-user switch (.prd/18 D1).
 *
 *   - bare `taskentry` / `taskentry status` → the `/z taskentry` card
 *   - `taskentry on|off` → applyTaskEntry + a text ack
 */
export class TaskEntryHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return TASK_ENTRY_COMMAND.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const arg = text.trim().match(TASK_ENTRY_COMMAND)?.[1];
    if (!arg || arg.toLowerCase() === 'status') {
      const { text: fallback, blocks } = await renderTaskEntryCard({ userId: user, issuedAt: Date.now() });
      await say({ text: fallback ?? '🗂️ Slack → 대시보드 작업', blocks, thread_ts: threadTs });
      return { handled: true };
    }
    const result = await applyTaskEntry({ userId: user, value: arg });
    await say({
      text: result.ok
        ? `✅ ${result.summary}\n\n${result.description ?? ''}`.trim()
        : `${result.summary}\n\n${result.description ?? ''}`.trim(),
      thread_ts: threadTs,
    });
    return { handled: true };
  }
}
