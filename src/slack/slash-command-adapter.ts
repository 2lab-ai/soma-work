import { SlashCommand, RespondFn } from '@slack/bolt';
import { CommandContext, SayFn } from './commands/types';
import { Logger } from '../logger';

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
   *   SlashCommand.channel_id → CommandContext.threadTs  (no thread_ts in slash commands)
   *   SlashCommand.text       → CommandContext.text
   *   respond()               → CommandContext.say       (wrapped as SayFn)
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
      threadTs: command.channel_id, // slash commands have no thread context
      text: command.text || '',
      say,
    };
  }

  /**
   * Wrap Slack's respond() function to match the SayFn signature.
   * All slash command responses are ephemeral by default.
   */
  static wrapRespondAsSay(respond: RespondFn): SayFn {
    return async (message: { text: string; thread_ts?: string; blocks?: any[] }) => {
      await respond({
        text: message.text,
        blocks: message.blocks,
        response_type: 'ephemeral',
      });
      return {};
    };
  }
}
