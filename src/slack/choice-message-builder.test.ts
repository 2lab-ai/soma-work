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
// recommendedChoiceId — single-choice scenarios
// -----------------------------------------------------------------------------

const findActionBlocks = (blocks: any[]): any[] => blocks.filter((b) => b.type === 'actions');
const findBannerSection = (blocks: any[]): any =>
  blocks.find(
    (b) => b.type === 'section' && typeof b.text?.text === 'string' && b.text.text.includes('⭐ *Recommended'),
  );

describe('ChoiceMessageBuilder.buildUserChoiceBlocks — recommendedChoiceId', () => {
  const baseChoice = (): UserChoice => ({
    type: 'user_choice',
    question: 'Pick one',
    choices: [
      { id: '1', label: 'Option A' },
      { id: '2', label: 'Option B' },
      { id: '3', label: 'Option C' },
    ],
  });

  it('no recommended → single actions row, no banner, no divider', () => {
    const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(baseChoice(), 'sk-1', 'default');
    const blocks = getBlocks(payload);
    expect(findBannerSection(blocks)).toBeUndefined();
    expect(findActionBlocks(blocks)).toHaveLength(1);
    expect(blocks.find((b) => b.type === 'divider' && blocks.indexOf(b) > 3)).toBeUndefined();
    // Custom input button present
    const actions = findActionBlocks(blocks)[0];
    const customBtn = actions.elements.find((e: any) => e.action_id === 'custom_input_single');
    expect(customBtn).toBeDefined();
  });

  it('explicit recommendedChoiceId → banner + primary solo actions + divider + others + custom_input', () => {
    const choice: UserChoice = { ...baseChoice(), recommendedChoiceId: '1' };
    const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', 'default');
    const blocks = getBlocks(payload);

    const banner = findBannerSection(blocks);
    expect(banner).toBeDefined();
    expect(banner.text.text).toContain('Option A');

    const actionBlocks = findActionBlocks(blocks);
    // One solo rec action + one others-with-custom-input
    expect(actionBlocks).toHaveLength(2);

    // Solo rec block has exactly one primary button
    expect(actionBlocks[0].elements).toHaveLength(1);
    expect(actionBlocks[0].elements[0].style).toBe('primary');
    expect(actionBlocks[0].elements[0].action_id).toBe('user_choice_1');

    // Others block has option_b, option_c + custom_input
    const otherActionIds = actionBlocks[1].elements.map((e: any) => e.action_id);
    expect(otherActionIds).toContain('user_choice_2');
    expect(otherActionIds).toContain('user_choice_3');
    expect(otherActionIds).toContain('custom_input_single');
  });

  it('legacy "(Recommended · 3/3)" label on option 2 → same layout, suffix stripped from button text & value', () => {
    const choice: UserChoice = {
      type: 'user_choice',
      question: 'Pick',
      choices: [
        { id: '1', label: 'Option A' },
        { id: '2', label: 'Option B (Recommended · 3/3)' },
      ],
    };
    const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', 'default');
    const blocks = getBlocks(payload);
    const banner = findBannerSection(blocks);
    expect(banner).toBeDefined();
    expect(banner.text.text).toContain('Option B');
    expect(banner.text.text).not.toContain('Recommended · 3/3');

    const actionBlocks = findActionBlocks(blocks);
    expect(actionBlocks).toHaveLength(2);
    const recBtn = actionBlocks[0].elements[0];
    expect(recBtn.style).toBe('primary');
    expect(recBtn.text.text).not.toContain('Recommended');
    const recValue = JSON.parse(recBtn.value);
    expect(recValue.label).toBe('Option B');
  });

  it('unknown explicit id + one option has legacy label → legacy fallback takes effect', () => {
    const choice: UserChoice = {
      type: 'user_choice',
      question: 'Pick',
      recommendedChoiceId: 'zzz',
      choices: [
        { id: '1', label: 'Option A (Recommended)' },
        { id: '2', label: 'Option B' },
      ],
    };
    const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', 'default');
    const blocks = getBlocks(payload);
    const actionBlocks = findActionBlocks(blocks);
    expect(actionBlocks).toHaveLength(2);
    // Rec is Option A (legacy id '1')
    const recBtn = actionBlocks[0].elements[0];
    expect(recBtn.action_id).toBe('user_choice_1');
    expect(recBtn.style).toBe('primary');
  });

  it('only one option and it is recommended → primary actions row + custom_input own row, no divider', () => {
    const choice: UserChoice = {
      type: 'user_choice',
      question: 'Pick',
      recommendedChoiceId: '1',
      choices: [{ id: '1', label: 'Only Option' }],
    };
    const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', 'default');
    const blocks = getBlocks(payload);
    const actionBlocks = findActionBlocks(blocks);
    expect(actionBlocks).toHaveLength(2);
    // First action block: primary rec
    expect(actionBlocks[0].elements).toHaveLength(1);
    expect(actionBlocks[0].elements[0].style).toBe('primary');
    // Second action block: just custom_input
    expect(actionBlocks[1].elements).toHaveLength(1);
    expect(actionBlocks[1].elements[0].action_id).toBe('custom_input_single');
    // No divider between these (only divider is the fixed one in default theme between context and fields)
    const dividersAfterBanner = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type === 'divider');
    // default theme always has one divider (between context/title area and fields)
    // but there should NOT be a divider between rec and custom_input action blocks.
    // Find banner position and assert no divider between it and first action block after it.
    const bannerIdx = blocks.findIndex((b) => b === findBannerSection(blocks));
    const firstActionIdx = blocks.findIndex((b, i) => i > bannerIdx && b.type === 'actions');
    const secondActionIdx = blocks.findIndex((b, i) => i > firstActionIdx && b.type === 'actions');
    const between = blocks.slice(firstActionIdx + 1, secondActionIdx);
    expect(between.find((b) => b.type === 'divider')).toBeUndefined();
    // Just for quiet unused warnings
    expect(dividersAfterBanner.length).toBeGreaterThanOrEqual(0);
  });

  it('compact theme: rec banner + primary + divider structure applies', () => {
    const choice: UserChoice = { ...baseChoice(), recommendedChoiceId: '2' };
    const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', 'compact');
    const blocks = getBlocks(payload);
    expect(findBannerSection(blocks)).toBeDefined();
    expect(findActionBlocks(blocks)).toHaveLength(2);
  });

  it('minimal theme: rec banner + primary + divider structure applies', () => {
    const choice: UserChoice = { ...baseChoice(), recommendedChoiceId: '3' };
    const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', 'minimal');
    const blocks = getBlocks(payload);
    expect(findBannerSection(blocks)).toBeDefined();
    const actionBlocks = findActionBlocks(blocks);
    expect(actionBlocks).toHaveLength(2);
    expect(actionBlocks[0].elements[0].action_id).toBe('user_choice_3');
  });
});

// -----------------------------------------------------------------------------
// recommendedChoiceId — multi-form scenarios
// -----------------------------------------------------------------------------

describe('ChoiceMessageBuilder.buildMultiChoiceFormBlocks — recommendedChoiceId', () => {
  it('reorders rec to front, marks style=primary + ⭐ prefix, keeps one actions block per question with custom_input', () => {
    const choices: UserChoices = {
      type: 'user_choices',
      title: 'Form',
      questions: [
        {
          id: 'q1',
          question: 'First?',
          recommendedChoiceId: '2',
          choices: [
            { id: '1', label: 'Option A' },
            { id: '2', label: 'Option B' },
            { id: '3', label: 'Option C' },
          ],
        },
        {
          id: 'q2',
          question: 'Second?',
          choices: [
            { id: 'x', label: 'X (Recommended · 2/3)' },
            { id: 'y', label: 'Y' },
          ],
        },
      ],
    };

    const payload = ChoiceMessageBuilder.buildMultiChoiceFormBlocks(choices, 'form-1', 'sk-1');
    const blocks = getBlocks(payload);
    const actionBlocks = blocks.filter((b) => b.type === 'actions');
    // One actions block per unanswered question
    expect(actionBlocks).toHaveLength(2);

    for (const block of actionBlocks) {
      // First button is the recommended one; every block ends with custom_input
      const customBtn = block.elements.find((e: any) => e.action_id.startsWith('custom_input_multi_'));
      expect(customBtn).toBeDefined();

      // First non-custom button should be the recommended one
      const firstBtn = block.elements[0];
      expect(firstBtn.style).toBe('primary');
      expect(firstBtn.text.text.startsWith('⭐')).toBe(true);
      // Ensure legacy suffix is stripped
      expect(firstBtn.text.text).not.toContain('Recommended');
    }

    // Q1 rec is id=2, Q2 rec is id=x (legacy fallback)
    expect(actionBlocks[0].elements[0].action_id).toBe('multi_choice_form-1_q1_2');
    expect(actionBlocks[1].elements[0].action_id).toBe('multi_choice_form-1_q2_x');
  });

  it('without recommendedChoiceId, preserves original order and no ⭐ prefix', () => {
    const choices: UserChoices = {
      type: 'user_choices',
      title: 'Form',
      questions: [
        {
          id: 'q1',
          question: 'Plain?',
          choices: [
            { id: '1', label: 'A' },
            { id: '2', label: 'B' },
          ],
        },
      ],
    };
    const payload = ChoiceMessageBuilder.buildMultiChoiceFormBlocks(choices, 'form-1', 'sk-1');
    const blocks = getBlocks(payload);
    const actionsBlock = blocks.find((b) => b.type === 'actions');
    expect(actionsBlock.elements[0].action_id).toBe('multi_choice_form-1_q1_1');
    expect(actionsBlock.elements[0].style).toBeUndefined();
    expect(actionsBlock.elements[0].text.text.startsWith('⭐')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Recommended banner — Slack mrkdwn escape (security regression)
// -----------------------------------------------------------------------------

describe('ChoiceMessageBuilder.buildUserChoiceBlocks — recommended banner mrkdwn escape', () => {
  it('escapes `<`, `>`, `&` in recommended label before embedding in banner mrkdwn', () => {
    const choice: UserChoice = {
      type: 'user_choice',
      question: 'Who deploys?',
      recommendedChoiceId: '1',
      choices: [
        { id: '1', label: '<@U123> & team' },
        { id: '2', label: 'Option B' },
      ],
    };
    const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', 'default');
    const blocks = getBlocks(payload);
    const banner = blocks.find(
      (b) => b.type === 'section' && typeof b.text?.text === 'string' && b.text.text.includes('⭐ *Recommended'),
    );
    expect(banner).toBeDefined();
    const bannerText: string = banner.text.text;
    // Escaped entities present
    expect(bannerText).toContain('&lt;@U123&gt;');
    expect(bannerText).toContain('&amp;');
    // Raw mention/token absent (would trigger Slack mention render)
    expect(bannerText).not.toContain('<@U123>');
  });

  it('escape applies across all three themes (default/compact/minimal)', () => {
    for (const theme of ['default', 'compact', 'minimal'] as const) {
      const choice: UserChoice = {
        type: 'user_choice',
        question: 'Pick',
        recommendedChoiceId: '1',
        choices: [
          { id: '1', label: '<!channel> fan-out' },
          { id: '2', label: 'Option B' },
        ],
      };
      const payload = ChoiceMessageBuilder.buildUserChoiceBlocks(choice, 'sk-1', theme);
      const blocks = getBlocks(payload);
      const banner = blocks.find(
        (b) => b.type === 'section' && typeof b.text?.text === 'string' && b.text.text.includes('⭐ *Recommended'),
      );
      expect(banner, `theme=${theme} banner missing`).toBeDefined();
      expect(banner.text.text).toContain('&lt;!channel&gt;');
      expect(banner.text.text).not.toContain('<!channel>');
    }
  });
});
