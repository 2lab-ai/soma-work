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

    it('should extract single user_choice with choices field', () => {
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

    it('should extract single user_choice with options field (system.prompt format)', () => {
      const text = `Here is a choice:

\`\`\`json
{
  "type": "user_choice",
  "question": "Which database?",
  "options": [
    {"id": "1", "label": "PostgreSQL", "description": "Robust and reliable"},
    {"id": "2", "label": "MySQL", "description": "Simple and fast"}
  ],
  "context": "Database choice affects performance"
}
\`\`\``;

      const result = UserChoiceHandler.extractUserChoice(text);
      expect(result.choice).not.toBe(null);
      expect(result.choice?.type).toBe('user_choice');
      expect(result.choice?.question).toBe('Which database?');
      expect(result.choice?.choices).toHaveLength(2);
      expect(result.choice?.choices[0].description).toBe('Robust and reliable');
      expect(result.choice?.context).toBe('Database choice affects performance');
    });

    it('should extract UserChoiceGroup format (single question)', () => {
      const text = `Decision needed:

\`\`\`json
{
  "question": "PTN-1895 작업 진행 방식",
  "choices": [
    {
      "type": "user_choice",
      "question": "어떤 작업을 진행할까요?",
      "options": [
        {"id": "1", "label": "구현 시작", "description": "바로 코딩 시작"},
        {"id": "2", "label": "코드 분석", "description": "먼저 분석"}
      ],
      "context": "Spec이 확정되어 있음"
    }
  ],
  "context": "작업 진행 방식 결정"
}
\`\`\``;

      const result = UserChoiceHandler.extractUserChoice(text);
      // Single question in UserChoiceGroup should be converted to UserChoice
      expect(result.choice).not.toBe(null);
      expect(result.choice?.question).toBe('어떤 작업을 진행할까요?');
      expect(result.choice?.choices).toHaveLength(2);
      expect(result.choice?.choices[0].label).toBe('구현 시작');
      expect(result.choices).toBe(null);
    });

    it('should extract UserChoiceGroup format (multiple questions)', () => {
      const text = `Multiple decisions:

\`\`\`json
{
  "question": "프로젝트 설정",
  "choices": [
    {
      "type": "user_choice",
      "question": "DB 선택?",
      "options": [{"id": "1", "label": "Postgres"}]
    },
    {
      "type": "user_choice",
      "question": "Auth 방식?",
      "options": [{"id": "1", "label": "JWT"}]
    }
  ]
}
\`\`\``;

      const result = UserChoiceHandler.extractUserChoice(text);
      // Multiple questions should be converted to UserChoices
      expect(result.choices).not.toBe(null);
      expect(result.choices?.type).toBe('user_choices');
      expect(result.choices?.title).toBe('프로젝트 설정');
      expect(result.choices?.questions).toHaveLength(2);
      expect(result.choice).toBe(null);
    });

    it('should extract UserChoiceGroup with explicit type field', () => {
      const text = `Task options:

\`\`\`json
{
  "type": "user_choice_group",
  "question": "어떤 작업을 진행할까요?",
  "choices": [
    {
      "type": "user_choice",
      "question": "가장 급한 버그부터 해결할까요?",
      "options": [
        {"id": "1", "label": "PTN-1913 출금 거절 버그 분석", "description": "Gucci 백엔드 소스를 분석하여 출금 거절 API 버그 원인 파악"},
        {"id": "2", "label": "PTN-1654 홀덤 행 추가", "description": "PradaBo + Gucci에서 게임별 성과분석에 홀덤 추가"}
      ],
      "context": "Highest/High 우선순위 이슈 처리"
    },
    {
      "type": "user_choice",
      "question": "암호화폐 관련 작업을 묶어서 진행할까요?",
      "options": [
        {"id": "3", "label": "PTN-1895 입금 처리 개선 구현", "description": "crypto_wallet_transaction 검출 시점에 user_wallet_transaction 선행 생성"}
      ],
      "context": "현재 In Progress인 암호화폐 작업들"
    }
  ],
  "context": "현재 7개의 In Progress 이슈와 8개의 To Do 이슈가 있습니다"
}
\`\`\``;

      const result = UserChoiceHandler.extractUserChoice(text);
      // Multiple questions should be converted to UserChoices
      expect(result.choices).not.toBe(null);
      expect(result.choices?.type).toBe('user_choices');
      expect(result.choices?.title).toBe('어떤 작업을 진행할까요?');
      expect(result.choices?.description).toBe('현재 7개의 In Progress 이슈와 8개의 To Do 이슈가 있습니다');
      expect(result.choices?.questions).toHaveLength(2);
      expect(result.choices?.questions[0].question).toBe('가장 급한 버그부터 해결할까요?');
      expect(result.choices?.questions[0].context).toBe('Highest/High 우선순위 이슈 처리');
      expect(result.choice).toBe(null);
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

    it('should extract raw JSON without code blocks', () => {
      const text = `Here is the decision:
---
{
  "type": "user_choice",
  "question": "Which option?",
  "options": [
    {"id": "1", "label": "Option A"},
    {"id": "2", "label": "Option B"}
  ]
}`;

      const result = UserChoiceHandler.extractUserChoice(text);
      expect(result.choice).not.toBe(null);
      expect(result.choice?.question).toBe('Which option?');
      expect(result.textWithoutChoice).toContain('Here is the decision:');
    });

    it('should extract raw JSON with trailing content after it', () => {
      const text = `{
  "type": "user_choice_group",
  "question": "다음 작업 선택",
  "choices": [
    {
      "type": "user_choice",
      "question": "어떤 작업부터 진행할까요?",
      "options": [
        { "id": "1", "label": "PTN-1913 상세 확인", "description": "출금 거절 버그" },
        { "id": "2", "label": "PTN-1977 구현 시작", "description": "수수료 비율 처리" }
      ],
      "context": "Implementation Spec이 있습니다"
    }
  ]
}

---

이거 왜 raw json으로 나왔을지 추리해줘`;

      const result = UserChoiceHandler.extractUserChoice(text);
      expect(result.choice).not.toBe(null);
      expect(result.choice?.question).toBe('어떤 작업부터 진행할까요?');
      expect(result.choice?.choices).toHaveLength(2);
      expect(result.textWithoutChoice).toBe('');
    });

    it('should extract raw JSON with separator line after it', () => {
      const text = `Some intro text

{
  "type": "user_choice",
  "question": "선택하세요",
  "options": [
    {"id": "1", "label": "옵션 A"}
  ]
}
---`;

      const result = UserChoiceHandler.extractUserChoice(text);
      expect(result.choice).not.toBe(null);
      expect(result.choice?.question).toBe('선택하세요');
      expect(result.textWithoutChoice).toBe('Some intro text');
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

    // Helper to get blocks from payload
    const getBlocks = (payload: any) => payload.attachments?.[0]?.blocks || [];

    it('should return attachment format with color', () => {
      const payload = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'session-key');
      expect(payload.attachments).toBeDefined();
      expect(payload.attachments).toHaveLength(1);
      expect(payload.attachments![0].color).toBe('#0052CC');
    });

    it('should create blocks with question', () => {
      const payload = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'session-key');
      const blocks = getBlocks(payload);
      const questionBlock = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('Which option?'));
      expect(questionBlock).toBeDefined();
    });

    it('should include context block when context is provided', () => {
      const choiceWithContext: UserChoice = {
        ...sampleChoice,
        context: 'Important context',
      };
      const payload = UserChoiceHandler.buildUserChoiceBlocks(choiceWithContext, 'session-key');
      const blocks = getBlocks(payload);
      const contextBlock = blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Important context'));
      expect(contextBlock).toBeDefined();
    });

    it('should include custom input button', () => {
      const payload = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'session-key');
      const blocks = getBlocks(payload);
      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      const customButton = actionsBlock?.elements?.find((e: any) => e.action_id === 'custom_input_single');
      expect(customButton).toBeDefined();
      expect(customButton.text.text).toContain('직접 입력');
    });

    it('should include descriptions in fields', () => {
      const payload = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'session-key');
      const blocks = getBlocks(payload);
      // New UI: options displayed as fields in section
      const fieldsSection = blocks.find((b: any) =>
        b.type === 'section' && b.fields?.some((f: any) => f.text?.includes('Option A'))
      );
      expect(fieldsSection).toBeDefined();
    });

    it('should limit to 4 options in action buttons', () => {
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
      const payload = UserChoiceHandler.buildUserChoiceBlocks(manyChoices, 'session-key');
      const blocks = getBlocks(payload);
      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      // 4 choice buttons + 1 custom input = 5
      expect(actionsBlock.elements).toHaveLength(5);
    });

    it('should store sessionKey in button values', () => {
      const payload = UserChoiceHandler.buildUserChoiceBlocks(sampleChoice, 'test-session');
      const blocks = getBlocks(payload);
      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
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

    // Helper to get blocks from payload
    const getBlocks = (payload: any) => payload.attachments?.[0]?.blocks || [];

    it('should return attachment format with color', () => {
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key');
      expect(payload.attachments).toBeDefined();
      expect(payload.attachments).toHaveLength(1);
      expect(payload.attachments![0].color).toBe('#0052CC');
    });

    it('should create section with title', () => {
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key');
      const blocks = getBlocks(payload);
      const titleBlock = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('Setup Form'));
      expect(titleBlock).toBeDefined();
    });

    it('should use default title when not provided', () => {
      const choicesNoTitle: UserChoices = {
        type: 'user_choices',
        questions: sampleChoices.questions,
      };
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(choicesNoTitle, 'form-1', 'session-key');
      const blocks = getBlocks(payload);
      const titleBlock = blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('선택이 필요합니다'));
      expect(titleBlock).toBeDefined();
    });

    it('should include description in context when provided', () => {
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key');
      const blocks = getBlocks(payload);
      const descBlock = blocks.find((b: any) =>
        b.type === 'context' && b.elements?.some((e: any) => e.text?.includes('Please answer these questions'))
      );
      expect(descBlock).toBeDefined();
    });

    it('should create action buttons for each question', () => {
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key');
      const blocks = getBlocks(payload);
      const actionBlocks = blocks.filter((b: any) => b.type === 'actions');
      expect(actionBlocks).toHaveLength(2); // One per question
    });

    it('should show selected state for answered questions', () => {
      const selections = { q1: { choiceId: '1', label: 'Yes' } };
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key', selections);
      const blocks = getBlocks(payload);

      // First question should show with checkmark and edit button (accessory)
      const q1Section = blocks.find((b: any) =>
        b.type === 'section' && b.text?.text?.includes('First question') && b.accessory
      );
      expect(q1Section).toBeDefined();

      // Should have 1 actions block for q2 (unanswered question)
      const actionBlocks = blocks.filter((b: any) => b.type === 'actions');
      expect(actionBlocks).toHaveLength(1);
    });

    it('should hide context for selected questions', () => {
      const selections = { q2: { choiceId: 'a', label: 'Option A' } };
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key', selections);
      const blocks = getBlocks(payload);

      // Context for q2 should not be shown since it's selected
      const contextBlocks = blocks.filter((b: any) =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('This is important')
      );
      expect(contextBlocks).toHaveLength(0);
    });

    it('should show progress bar', () => {
      const selections = { q1: { choiceId: '1', label: 'Yes' } };
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key', selections);
      const blocks = getBlocks(payload);

      // Progress bar with dots (●○) and count
      const progressBlock = blocks.find((b: any) =>
        b.type === 'context' && b.elements?.[0]?.text?.includes('1/2')
      );
      expect(progressBlock).toBeDefined();
    });

    it('should show completion message when all answered', () => {
      const selections = {
        q1: { choiceId: '1', label: 'Yes' },
        q2: { choiceId: 'a', label: 'Option A' },
      };
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key', selections);
      const blocks = getBlocks(payload);

      // Now shows completion section with submit/reset buttons
      const completionBlock = blocks.find((b: any) =>
        b.type === 'section' && b.text?.text?.includes('모든 선택이 완료')
      );
      expect(completionBlock).toBeDefined();

      // Should have submit and reset buttons
      const submitActions = blocks.find((b: any) =>
        b.type === 'actions' && b.elements?.some((e: any) => e.action_id?.startsWith('submit_form_'))
      );
      expect(submitActions).toBeDefined();
    });

    it('should change color to green when complete', () => {
      const selections = {
        q1: { choiceId: '1', label: 'Yes' },
        q2: { choiceId: 'a', label: 'Option A' },
      };
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key', selections);
      expect(payload.attachments![0].color).toBe('#36a64f');
    });

    it('should include formId in button values', () => {
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'test-form', 'session-key');
      const blocks = getBlocks(payload);
      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      const buttonValue = JSON.parse(actionsBlock.elements[0].value);
      expect(buttonValue.formId).toBe('test-form');
    });

    it('should include custom input buttons for each question', () => {
      const payload = UserChoiceHandler.buildMultiChoiceFormBlocks(sampleChoices, 'form-1', 'session-key');
      const blocks = getBlocks(payload);
      const actionBlocks = blocks.filter((b: any) => b.type === 'actions');

      for (const actionBlock of actionBlocks) {
        const customButton = actionBlock.elements.find((e: any) =>
          e.action_id.startsWith('custom_input_multi_')
        );
        expect(customButton).toBeDefined();
      }
    });
  });
});
