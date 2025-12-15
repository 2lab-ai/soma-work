import { describe, it, expect } from 'vitest';
import { UserChoiceHandler } from './user-choice-handler';
import { UserChoice, UserChoices } from '../types';

describe('UserChoiceHandler', () => {
  describe('extractUserChoice', () => {
    it('should return null for text without JSON blocks', () => {
      const result = UserChoiceHandler.extractUserChoice('Hello world');
      expect(result.choice).toBe(null);
      expect(result.choices).toBe(null);
      expect(result.textWithoutChoice).toBe('Hello world');
    });

    it('should extract single user_choice', () => {
      const text = `Some intro text

\`\`\`json
{
  "type": "user_choice",
  "question": "Which database?",
  "choices": [
    {"id": "1", "label": "PostgreSQL"},
    {"id": "2", "label": "MySQL"}
  ]
}
\`\`\`

Some outro text`;

      const result = UserChoiceHandler.extractUserChoice(text);
      expect(result.choice).not.toBe(null);
      expect(result.choice?.type).toBe('user_choice');
      expect(result.choice?.question).toBe('Which database?');
      expect(result.choice?.choices).toHaveLength(2);
      expect(result.choices).toBe(null);
      expect(result.textWithoutChoice).toContain('Some intro text');
      expect(result.textWithoutChoice).toContain('Some outro text');
      expect(result.textWithoutChoice).not.toContain('user_choice');
    });

    it('should extract user_choices (multi-question)', () => {
      const text = `Here are some questions:

\`\`\`json
{
  "type": "user_choices",
  "title": "Project Setup",
  "questions": [
    {
      "id": "db",
      "question": "Database?",
      "choices": [{"id": "1", "label": "Postgres"}]
    },
    {
      "id": "auth",
      "question": "Auth method?",
      "choices": [{"id": "1", "label": "JWT"}]
    }
  ]
}
\`\`\``;

      const result = UserChoiceHandler.extractUserChoice(text);
      expect(result.choices).not.toBe(null);
      expect(result.choices?.type).toBe('user_choices');
      expect(result.choices?.title).toBe('Project Setup');
      expect(result.choices?.questions).toHaveLength(2);
      expect(result.choice).toBe(null);
    });

    it('should ignore invalid JSON blocks', () => {
      const text = `\`\`\`json
this is not valid json
\`\`\``;

      const result = UserChoiceHandler.extractUserChoice(text);
      expect(result.choice).toBe(null);
      expect(result.choices).toBe(null);
    });

    it('should ignore JSON without user_choice type', () => {
      const text = `\`\`\`json
{"key": "value", "array": [1, 2, 3]}
\`\`\``;

      const result = UserChoiceHandler.extractUserChoice(text);
      expect(result.choice).toBe(null);
      expect(result.choices).toBe(null);
    });

    it('should prefer user_choices over user_choice when both present', () => {
      const text = `\`\`\`json
{
  "type": "user_choices",
  "questions": [{"id": "q1", "question": "Q1", "choices": []}]
}
\`\`\`

\`\`\`json
{
  "type": "user_choice",
  "question": "Q2",
  "choices": []
}
\`\`\``;

      const result = UserChoiceHandler.extractUserChoice(text);
      // The first match should be used
      expect(result.choices).not.toBe(null);
      expect(result.choice).toBe(null);
    });

    it('should handle choice with context', () => {
      const text = `\`\`\`json
{
  "type": "user_choice",
  "question": "Framework?",
  "choices": [{"id": "1", "label": "React"}],
  "context": "This affects the entire project structure"
}
\`\`\``;

      const result = UserChoiceHandler.extractUserChoice(text);
      expect(result.choice?.context).toBe('This affects the entire project structure');
    });
  });

  describe('buildUserChoiceBlocks', () => {
    const sampleChoice: UserChoice = {
      type: 'user_choice',
      question: 'Which option?',
      choices: [
        { id: '1', label: 'Option A', description: 'First option' },
        { id: '2', label: 'Option B', description: 'Second option' },
      ],
    };

    it('should create blocks with question', () => {
      const blocks = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'session-key');
      const questionBlock = blocks.find(b => b.type === 'section' && b.text?.text?.includes('Which option?'));
      expect(questionBlock).toBeDefined();
    });

    it('should include context block when context is provided', () => {
      const choiceWithContext: UserChoice = {
        ...sampleChoice,
        context: 'Important context',
      };
      const blocks = UserChoiceHandler.buildUserChoiceBlocks(choiceWithContext, 'session-key');
      const contextBlock = blocks.find(b => b.type === 'context' && b.elements?.[0]?.text === 'Important context');
      expect(contextBlock).toBeDefined();
    });

    it('should not include context block when no context', () => {
      const choiceWithoutContext: UserChoice = {
        type: 'user_choice',
        question: 'Question',
        choices: [{ id: '1', label: 'A' }],
      };
      const blocks = UserChoiceHandler.buildUserChoiceBlocks(choiceWithoutContext, 'session-key');
      // Should only have section, actions, no context from question context
      expect(blocks).toHaveLength(2); // section + actions
    });

    it('should create action buttons for each choice', () => {
      const blocks = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'session-key');
      const actionsBlock = blocks.find(b => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      // 2 choices + 1 custom input button = 3 buttons
      expect(actionsBlock.elements).toHaveLength(3);
    });

    it('should include custom input button', () => {
      const blocks = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'session-key');
      const actionsBlock = blocks.find(b => b.type === 'actions');
      const customButton = actionsBlock.elements.find((e: any) => e.action_id === 'custom_input_single');
      expect(customButton).toBeDefined();
      expect(customButton.text.text).toContain('직접 입력');
    });

    it('should include descriptions context when choices have descriptions', () => {
      const blocks = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'session-key');
      const descriptionBlock = blocks.find(b =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('First option')
      );
      expect(descriptionBlock).toBeDefined();
      expect(descriptionBlock.elements[0].text).toContain('Second option');
    });

    it('should limit choices to 4 buttons', () => {
      const manyChoices: UserChoice = {
        type: 'user_choice',
        question: 'Question',
        choices: [
          { id: '1', label: 'A' },
          { id: '2', label: 'B' },
          { id: '3', label: 'C' },
          { id: '4', label: 'D' },
          { id: '5', label: 'E' },
        ],
      };
      const blocks = UserChoiceHandler.buildUserChoiceBlocks(manyChoices, 'session-key');
      const actionsBlock = blocks.find(b => b.type === 'actions');
      // 4 choices + 1 custom input = 5 max
      expect(actionsBlock.elements).toHaveLength(5);
    });

    it('should truncate long button labels', () => {
      const longLabel: UserChoice = {
        type: 'user_choice',
        question: 'Question',
        choices: [{ id: '1', label: 'A'.repeat(100) }],
      };
      const blocks = UserChoiceHandler.buildUserChoiceBlocks(longLabel, 'session-key');
      const actionsBlock = blocks.find(b => b.type === 'actions');
      const buttonText = actionsBlock.elements[0].text.text;
      expect(buttonText.length).toBeLessThanOrEqual(75);
    });

    it('should store sessionKey in button values', () => {
      const blocks = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'test-session');
      const actionsBlock = blocks.find(b => b.type === 'actions');
      const buttonValue = JSON.parse(actionsBlock.elements[0].value);
      expect(buttonValue.sessionKey).toBe('test-session');
    });
  });

  describe('buildMultiChoiceFormBlocks', () => {
    const sampleChoices: UserChoices = {
      type: 'user_choices',
      title: 'Setup Form',
      description: 'Please answer these questions',
      questions: [
        {
          id: 'q1',
          question: 'First question?',
          choices: [{ id: '1', label: 'Yes' }, { id: '2', label: 'No' }],
        },
        {
          id: 'q2',
          question: 'Second question?',
          choices: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
          context: 'This is important',
        },
      ],
    };

    it('should create header with title', () => {
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key');
      const header = blocks.find(b => b.type === 'header');
      expect(header).toBeDefined();
      expect(header.text.text).toBe('Setup Form');
    });

    it('should use default title when not provided', () => {
      const choicesNoTitle: UserChoices = {
        type: 'user_choices',
        questions: sampleChoices.questions,
      };
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(choicesNoTitle, 'form-1', 'session-key');
      const header = blocks.find(b => b.type === 'header');
      expect(header.text.text).toContain('선택이 필요합니다');
    });

    it('should include description when provided', () => {
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key');
      const descBlock = blocks.find(b =>
        b.type === 'section' && b.text?.text === 'Please answer these questions'
      );
      expect(descBlock).toBeDefined();
    });

    it('should create buttons for each question', () => {
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key');
      const actionBlocks = blocks.filter(b => b.type === 'actions');
      expect(actionBlocks).toHaveLength(2); // One per question
    });

    it('should show selected state for answered questions', () => {
      const selections = { q1: { choiceId: '1', label: 'Yes' } };
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key', selections);

      // First question should show selected
      const q1Section = blocks.find(b =>
        b.type === 'section' && b.text?.text?.includes('First question')
      );
      expect(q1Section.text.text).toContain('✅');
      expect(q1Section.text.text).toContain('Yes');

      // Should only have 1 actions block (for q2)
      const actionBlocks = blocks.filter(b => b.type === 'actions');
      expect(actionBlocks).toHaveLength(1);
    });

    it('should hide context for selected questions', () => {
      const selections = { q2: { choiceId: 'a', label: 'Option A' } };
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key', selections);

      // Context for q2 should not be shown since it's selected
      const contextBlocks = blocks.filter(b =>
        b.type === 'context' && b.elements?.[0]?.text === 'This is important'
      );
      expect(contextBlocks).toHaveLength(0);
    });

    it('should show progress indicator', () => {
      const selections = { q1: { choiceId: '1', label: 'Yes' } };
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key', selections);

      const progressBlock = blocks.find(b =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('진행: 1/2')
      );
      expect(progressBlock).toBeDefined();
    });

    it('should show completion message when all answered', () => {
      const selections = {
        q1: { choiceId: '1', label: 'Yes' },
        q2: { choiceId: 'a', label: 'Option A' },
      };
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key', selections);

      const completionBlock = blocks.find(b =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('모든 선택 완료')
      );
      expect(completionBlock).toBeDefined();
    });

    it('should include formId in button values', () => {
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'test-form', 'session-key');
      const actionsBlock = blocks.find(b => b.type === 'actions');
      const buttonValue = JSON.parse(actionsBlock.elements[0].value);
      expect(buttonValue.formId).toBe('test-form');
    });

    it('should include custom input buttons for each question', () => {
      const blocks = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key');
      const actionBlocks = blocks.filter(b => b.type === 'actions');

      for (const actionBlock of actionBlocks) {
        const customButton = actionBlock.elements.find((e: any) =>
          e.action_id.startsWith('custom_input_multi_')
        );
        expect(customButton).toBeDefined();
      }
    });
  });
});
