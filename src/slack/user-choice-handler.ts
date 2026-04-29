/**
 * User choice handling facade - combines extraction and UI building
 */
import type { UserChoice, UserChoices } from '../types';
import type { SessionTheme } from '../user-settings-store';
import { ChoiceMessageBuilder, type SlackMessagePayload } from './choice-message-builder';
import { type ExtractedChoice, UserChoiceExtractor } from './user-choice-extractor';

export { SlackMessagePayload } from './choice-message-builder';
// Re-export types for backwards compatibility

/**
 * Facade class that combines extraction and UI building functionality
 * Maintains backwards compatibility with existing code
 */
export class UserChoiceHandler {
  /**
   * Extract UserChoice, UserChoices, or UserChoiceGroup JSON from message text
   */
  static extractUserChoice(text: string): ExtractedChoice {
    return UserChoiceExtractor.extractUserChoice(text);
  }

  /**
   * Build Slack attachment for single user choice.
   *
   * Optional `turnId` threads through to per-button JSON `value` so P3
   * (PHASE>=3) click handlers can classify stale vs live clicks. PHASE<3
   * callers omit `turnId` to preserve byte-identical legacy output.
   */
  static buildUserChoiceBlocks(
    choice: UserChoice,
    sessionKey: string,
    theme?: SessionTheme,
    turnId?: string,
  ): SlackMessagePayload {
    return ChoiceMessageBuilder.buildUserChoiceBlocks(choice, sessionKey, theme, turnId);
  }

  /**
   * Build Slack attachment for multi-question choice form
   */
  static buildMultiChoiceFormBlocks(
    choices: UserChoices,
    formId: string,
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }> = {},
  ): SlackMessagePayload {
    return ChoiceMessageBuilder.buildMultiChoiceFormBlocks(choices, formId, sessionKey, selections);
  }
}
