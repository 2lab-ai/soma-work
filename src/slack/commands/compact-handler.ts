import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles `/compact` — manual compaction trigger.
 *
 * Flow (user asked for confirmation on #617 followup v2):
 *   1. `/compact` (no `--yes`) → post a yes/no Block Kit prompt and return
 *      `{ handled: true }`. The SDK is NOT invoked; compaction waits for
 *      the confirm button.
 *   2. `compact_confirm` action handler re-dispatches `/compact --yes`
 *      through the message pipeline (EventRouter.dispatchPendingUserMessage).
 *   3. `/compact --yes` (this path) → post "🗜️ Triggering context compaction..."
 *      and return `{ continueWithPrompt: '/compact' }` so the SDK performs
 *      server-side compaction. (`continueWithPrompt` sends the literal
 *      `/compact` — a built-in SDK command — NOT `/compact --yes`.)
 *
 * `compactionCount` is NOT bumped here; `stream-executor`'s
 * `onCompactBoundary` callback owns the increment so a single logical
 * compaction is counted exactly once.
 */
export class CompactHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isCompactCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, text, say } = ctx;

    const sessionKey = this.deps.claudeHandler.getSessionKey(channel, threadTs);
    const session = this.deps.claudeHandler.getSession(channel, threadTs);

    if (!session?.sessionId) {
      await this.deps.slackApi.postSystemMessage(channel, '💡 No active session. Start a conversation first.', {
        threadTs,
      });
      return { handled: true };
    }

    if (this.deps.requestCoordinator.isRequestActive(sessionKey)) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '⚠️ Cannot compact while a request is in progress. Please wait.',
        { threadTs },
      );
      return { handled: true };
    }

    const { confirmed } = CommandParser.parseCompactCommand(text);

    // First invocation (no `--yes`) → show yes/no confirmation.
    // The confirm button re-dispatches `/compact --yes` through the pipeline.
    if (!confirmed) {
      await say({
        text: '🗜️ 컨텍스트 압축을 진행하시겠습니까?',
        thread_ts: threadTs,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '🗜️ *컨텍스트 압축 확인*\n\n현재 세션 컨텍스트를 압축하시겠습니까?',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '✅ 압축 진행', emoji: true },
                style: 'primary',
                value: sessionKey,
                action_id: 'compact_confirm',
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: '취소', emoji: true },
                value: sessionKey,
                action_id: 'compact_cancel',
              },
            ],
          },
        ],
      });
      return { handled: true };
    }

    // Confirmed (`--yes`) — announce and delegate to SDK's built-in /compact.
    await this.deps.slackApi.postSystemMessage(channel, '🗜️ Triggering context compaction...', { threadTs });

    return { handled: true, continueWithPrompt: '/compact' };
  }
}
