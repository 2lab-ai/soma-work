import { CommandHandler, CommandContext, CommandResult } from './types';
import { SUMMARY_PROMPT } from '../summary-service.js';

/**
 * Handles the `es` command — triggers immediate executive summary.
 * Trace: docs/turn-summary-lifecycle/trace.md, S4
 */
export class EsHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return /^\/?es$/i.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    return {
      handled: true,
      continueWithPrompt: SUMMARY_PROMPT,
    };
  }
}
