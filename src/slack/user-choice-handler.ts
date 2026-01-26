/**
 * User choice handling facade - combines extraction and UI building
 */
import { UserChoice, UserChoices } from '../types';
import { UserChoiceExtractor, ExtractedChoice } from './user-choice-extractor';
import { ChoiceMessageBuilder, SlackMessagePayload } from './choice-message-builder';

// Re-export types for backwards compatibility
export { ExtractedChoice } from './user-choice-extractor';
export { SlackMessagePayload } from './choice-message-builder';

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
   * Build Slack attachment for single user choice
   */
  static buildUserChoiceBlocks(choice: UserChoice, sessionKey: string): SlackMessagePayload {
    return ChoiceMessageBuilder.buildUserChoiceBlocks(choice, sessionKey);
  }

  /**
   * Build Slack attachment for multi-question choice form
   */
  static buildMultiChoiceFormBlocks(
    choices: UserChoices,
    formId: string,
    sessionKey: string,
    selections: Record<string, { choiceId: string; label: string }> = {}
  ): SlackMessagePayload {
    return ChoiceMessageBuilder.buildMultiChoiceFormBlocks(choices, formId, sessionKey, selections);
  }
}
