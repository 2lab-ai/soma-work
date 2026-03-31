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
   * ⚠️ threadTs is set to channel_id as a placeholder. Session-dependent commands
   * must be filtered out BEFORE reaching CommandRouter (see EventRouter.SESSION_DEPENDENT_COMMANDS).
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
