import { describe, expect, it } from 'vitest';
import type { UserChoice, UserChoices } from '../types';
import { ChoiceMessageBuilder, type SlackMessagePayload } from './choice-message-builder';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const makeChoice = (context: string | undefined): UserChoice => ({
  type: 'user_choice',
  question: 'Proceed?',
  context,
  choices: [
    { id: 'a', label: 'Option A' },
    { id: 'b', label: 'Option B' },
  ],
});

/** Extract blocks from an attachment payload (both single-user_choice themes wrap in attachments[0].blocks). */
const getBlocks = (payload: SlackMessagePayload): any[] => {
  expect(payload.attachments).toBeDefined();
  expect(payload.attachments!.length).toBe(1);
  return payload.attachments![0].blocks as any[];
};

/** Count context blocks whose first mrkdwn element starts with the 💡 prefix. */
const countLightbulbContextBlocks = (blocks: any[]): number =>
  blocks.filter(
    (b) =>
      b.type === 'context' &&
      Array.isArray(b.elements) &&
      b.elements.length > 0 &&
      b.elements[0].type === 'mrkdwn' &&
      typeof b.elements[0].text === 'string' &&
      b.elements[0].text.startsWith('💡 '),
  ).length;

/** Find the 💡 context block's rendered text (first match), or undefined. */
const getLightbulbText = (blocks: any[]): string | undefined => {
  for (const b of blocks) {
    if (
      b.type === 'context' &&
      Array.isArray(b.elements) &&
      b.elements.length > 0 &&
      b.elements[0].type === 'mrkdwn' &&
      typeof b.elements[0].text === 'string' &&
      b.elements[0].text.startsWith('💡 ')
    ) {
      return b.elements[0].text as string;
    }
  }
  return undefined;
};

// -----------------------------------------------------------------------------
// Matrix: 3 themes × 4 scenarios = 12 tests
// -----------------------------------------------------------------------------

const themes: Array<'default' | 'compact' | 'minimal'> = ['default', 'compact', 'minimal'];

describe('ChoiceMessageBuilder.buildUserChoiceBlocks — single user_choice context render', () => {
  for (const theme of themes) {
    describe(`theme: ${theme}`, () => {
      it('renders 💡 context block when context has real content', () => {
        const choice = makeChoice('This clarifies why the decision matters.');
        const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', theme);
        const blocks = getBlocks(payload);

        expect(countLightbulbContextBlocks(blocks)).toBe(1);
        expect(getLightbulbText(blocks)).toBe('💡 This clarifies why the decision matters.');
      });

      it('omits 💡 context block when context is undefined', () => {
        const choice = makeChoice(undefined);
        const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', theme);
        const blocks = getBlocks(payload);

        expect(countLightbulbContextBlocks(blocks)).toBe(0);
      });

      it('omits 💡 context block when context is an empty string', () => {
        const choice = makeChoice('');
        const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', theme);
        const blocks = getBlocks(payload);

        expect(countLightbulbContextBlocks(blocks)).toBe(0);
      });

      it('omits 💡 context block when context is whitespace-only (trim defense)', () => {
        const choice = makeChoice('   \n\n  ');
        const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', theme);
        const blocks = getBlocks(payload);

        expect(countLightbulbContextBlocks(blocks)).toBe(0);
      });
    });
  }
});

// -----------------------------------------------------------------------------
// Regression: user_choice_group (multi) path — existing 💡 render at L339-349 unchanged
// -----------------------------------------------------------------------------

describe('ChoiceMessageBuilder.buildMultiChoiceFormBlocks — user_choice_group regression', () => {
  it('still renders 💡 context block for unselected questions with context', () => {
    const choices: UserChoices = {
      type: 'user_choices',
      title: 'Form',
      questions: [
        {
          id: 'q1',
          question: 'Pick one',
          context: 'Existing multi-path context should still render.',
          choices: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
    };

    const payload = ChoiceMessageBuilder.buildMultiChoiceFormBlocks(choices, 'form-1', 'sk-1');
    const blocks = getBlocks(payload);

    // Exactly one 💡 block from the unselected-question path at L339-349
    expect(countLightbulbContextBlocks(blocks)).toBe(1);
    expect(getLightbulbText(blocks)).toBe('💡 Existing multi-path context should still render.');
  });
});
