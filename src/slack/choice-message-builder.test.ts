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

// -----------------------------------------------------------------------------
// Recommended choice (Issue #563)
// -----------------------------------------------------------------------------

const countBlockType = (blocks: any[], type: string): number => blocks.filter((b) => b.type === type).length;

const findRecommendedBanner = (blocks: any[]): any | undefined =>
  blocks.find(
    (b) =>
      b.type === 'section' &&
      b.text?.type === 'mrkdwn' &&
      typeof b.text.text === 'string' &&
      b.text.text.includes('⭐ *Recommended*'),
  );

const findActionsBlocks = (blocks: any[]): any[] => blocks.filter((b) => b.type === 'actions');

describe('ChoiceMessageBuilder recommendedChoiceId — single user_choice', () => {
  const baseChoice = (recommendedChoiceId?: string): UserChoice => ({
    type: 'user_choice',
    question: 'Pick an option',
    choices: [
      { id: 'a', label: 'Option A' },
      { id: 'b', label: 'Option B' },
      { id: 'c', label: 'Option C' },
    ],
    recommendedChoiceId,
  });

  for (const theme of themes) {
    describe(`theme: ${theme}`, () => {
      it('renders recommended banner + solo primary actions + divider when recommendedChoiceId matches', () => {
        const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(baseChoice('a'), 'sk-rec', theme);
        const blocks = getBlocks(payload);

        const banner = findRecommendedBanner(blocks);
        expect(banner).toBeDefined();
        expect(banner!.text.text).toContain('*Option A*');

        const actionsBlocks = findActionsBlocks(blocks);
        expect(actionsBlocks.length).toBe(2);
        expect(actionsBlocks[0].elements.length).toBe(1);
        expect(actionsBlocks[0].elements[0].style).toBe('primary');
        expect(actionsBlocks[0].elements[0].action_id).toBe('user_choice_a');

        const bannerIdx = blocks.indexOf(banner);
        const firstActionsIdx = blocks.indexOf(actionsBlocks[0]);
        const hasDividerBetweenActions = blocks
          .slice(bannerIdx, blocks.indexOf(actionsBlocks[1]))
          .some((b) => b.type === 'divider');
        expect(firstActionsIdx).toBeGreaterThan(bannerIdx);
        expect(hasDividerBetweenActions).toBe(true);
      });

      it('preserves original ordinal — recommended at index 2 keeps 3️⃣ prefix', () => {
        const choice: UserChoice = {
          type: 'user_choice',
          question: 'Pick',
          choices: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
            { id: 'd', label: 'D' },
          ],
          recommendedChoiceId: 'c',
        };
        const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk', theme);
        const blocks = getBlocks(payload);
        const actionsBlocks = findActionsBlocks(blocks);
        const recButton = actionsBlocks[0].elements[0];
        expect(recButton.text.text.startsWith('3️⃣ ')).toBe(true);
      });

      it('falls back to original layout when recommendedChoiceId is unknown', () => {
        const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(baseChoice('nonexistent'), 'sk', theme);
        const blocks = getBlocks(payload);
        expect(findRecommendedBanner(blocks)).toBeUndefined();
        const actionsBlocks = findActionsBlocks(blocks);
        expect(actionsBlocks.length).toBe(1);
        for (const el of actionsBlocks[0].elements) {
          expect(el.style).not.toBe('primary');
        }
      });

      it('behaves identically to baseline when recommendedChoiceId is absent', () => {
        const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(baseChoice(undefined), 'sk', theme);
        const blocks = getBlocks(payload);
        expect(findRecommendedBanner(blocks)).toBeUndefined();
        expect(findActionsBlocks(blocks).length).toBe(1);
      });
    });
  }
});

describe('ChoiceMessageBuilder recommendedChoiceId — multi-form sub-question', () => {
  it('renders banner + solo primary actions + divider for a sub-question with recommendedChoiceId', () => {
    const choices: UserChoices = {
      type: 'user_choices',
      title: 'Decisions',
      questions: [
        {
          id: 'q1',
          question: 'Pick one',
          choices: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
          ],
          recommendedChoiceId: 'b',
        },
      ],
    };
    const payload = ChoiceMessageBuilder.buildMultiChoiceFormBlocks(choices, 'form-rec', 'sk');
    const blocks = getBlocks(payload);

    const banner = findRecommendedBanner(blocks);
    expect(banner).toBeDefined();
    expect(banner!.text.text).toContain('*B*');

    const actionsBlocks = findActionsBlocks(blocks);
    // Two actions blocks: [solo primary, rest+custom]
    expect(actionsBlocks.length).toBe(2);
    expect(actionsBlocks[0].elements.length).toBe(1);
    expect(actionsBlocks[0].elements[0].style).toBe('primary');
    expect(actionsBlocks[0].elements[0].action_id).toBe('multi_choice_form-rec_q1_b');
    // Original ordinal preserved (b is index 1 → 2️⃣)
    expect(actionsBlocks[0].elements[0].text.text.startsWith('2️⃣ ')).toBe(true);
  });

  it('unknown recommendedChoiceId in sub-question falls back to original layout', () => {
    const choices: UserChoices = {
      type: 'user_choices',
      title: 'Decisions',
      questions: [
        {
          id: 'q1',
          question: 'Pick one',
          choices: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          recommendedChoiceId: 'nope',
        },
      ],
    };
    const payload = ChoiceMessageBuilder.buildMultiChoiceFormBlocks(choices, 'form-norec', 'sk');
    const blocks = getBlocks(payload);
    expect(findRecommendedBanner(blocks)).toBeUndefined();
    expect(countBlockType(blocks, 'actions')).toBe(1);
  });
});
