import type { RespondFn, SlashCommand } from '@slack/bolt';
import { Logger } from '../logger';
import type { CommandContext, SayFn } from './commands/types';

const logger = new Logger('SlashCommandAdapter');

/**
 * Adapts Slack slash command payloads to the existing CommandContext interface.
 * This allows slash commands to reuse the same CommandRouter and CommandHandlers
 * that currently process text-based commands.
 *
 * Trace: docs/slash-commands/trace.md, Scenario 1, Section 3c
 */
export class SlashCommandAdapter {
  /**
   * Transform a Slack SlashCommand payload into a CommandContext.
   *
   * Transformation arrows:
   *   SlashCommand.user_id    → CommandContext.user
   *   SlashCommand.channel_id → CommandContext.channel
   *   SlashCommand.channel_id → CommandContext.threadTs  (placeholder — no thread_ts in slash commands)
   *   SlashCommand.text       → CommandContext.text
   *   respond()               → CommandContext.say       (wrapped as SayFn)
   *
   * ⚠️ threadTs placeholder — Slack slash commands carry no thread context,
   * so we set `threadTs = channel_id` purely as a non-null filler. This ONLY
   * works because session-dependent commands (`new`, `close`, `renew`,
   * `context`, `restore`, `link`, `compact`, `session:set:*`) are gated
   * upstream before reaching this adapter.
   *
   * See:
   *  - `src/slack/z/capability.ts` `SLASH_FORBIDDEN` — the authoritative list
   *    of topics/verbs the slash path rejects with `SLASH_FORBIDDEN_MESSAGE`.
   *  - `src/slack/event-router.ts` `blockedLegacyCommand()` — the
   *    `SOMA_ENABLE_LEGACY_SLASH=true` rollback path, which also defers to
   *    `isSlashForbidden()` so the blocked set stays in sync.
   *
   * If a future command needs a real thread_ts, it MUST also be added to
   * `SLASH_FORBIDDEN`, or routed via `@bot /z <topic>` / DM instead of slash.
   */
  static adapt(command: SlashCommand, respond: RespondFn): CommandContext {
    const say = SlashCommandAdapter.wrapRespondAsSay(respond);

    logger.debug('Adapted slash command to CommandContext', {
      command: command.command,
      text: command.text?.substring(0, 50),
      user: command.user_id,
      channel: command.channel_id,
    });

    return {
      user: command.user_id,
      channel: command.channel_id,
      threadTs: command.channel_id, // placeholder — session-dependent commands are filtered in EventRouter
      text: command.text || '',
      say,
      // Slash commands carry trigger_id for opening modals (views.open). The
      // field is optional on CommandContext so DM/mention paths without one
      // remain valid.
      triggerId: command.trigger_id,
    };
  }

  /**
   * Wrap Slack's respond() function to match the SayFn signature.
   * All slash command responses are ephemeral by default.
   *
   * ⚠️ Limitations:
   * - Returns stub `{}` — handlers that rely on `say()` return value (e.g., `ts`, `channel`)
   *   will get `undefined`. Only stateless commands should be routed through slash commands.
   * - Errors from respond() are re-thrown so callers can handle them.
   */
  static wrapRespondAsSay(respond: RespondFn): SayFn {
    return async (message: { text: string; thread_ts?: string; blocks?: any[] }) => {
      try {
        await respond({
          text: message.text,
          blocks: message.blocks,
          response_type: 'ephemeral',
        });
      } catch (error: any) {
        logger.error('Failed to send slash command response via respond()', {
          error: error?.message,
          text: message.text?.substring(0, 50),
        });
        throw error;
      }
      // Stub return — slash command respond() does not return message metadata.
      return {};
    };
  }
}
