/**
 * #599 ⑤ — a dashboard answer to a Slack-less task's question becomes the next
 * instruction's text exactly as the Slack path builds it
 * (`choice-action-handler.ts`): a single choice is its id; a form is one
 * `question: id. label` line per question (custom input `question: (직접입력) text`).
 * Bad answers are refused before anything is cleared or run.
 */
import { describe, expect, it } from 'vitest';
import { buildTaskAnswerText } from '../task-answer';

const SINGLE = {
  type: 'user_choice',
  question: 'Which DB?',
  choices: [
    { id: 'pg', label: 'Postgres' },
    { id: 'my', label: 'MySQL' },
  ],
};
const FORM = {
  type: 'user_choices',
  title: 'Setup',
  questions: [
    {
      id: 'q1',
      question: 'Runtime?',
      choices: [
        { id: 'node', label: 'Node' },
        { id: 'bun', label: 'Bun' },
      ],
      recommendedChoiceId: 'node',
    },
    {
      id: 'q2',
      question: 'Tests?',
      choices: [
        { id: 'vitest', label: 'Vitest' },
        { id: 'jest', label: 'Jest' },
      ],
      recommendedChoiceId: 'vitest',
    },
  ],
};

describe('buildTaskAnswerText (#599 ⑤)', () => {
  it('a single choice answers with its id, as the Slack path sends it', () => {
    expect(buildTaskAnswerText(SINGLE, { kind: 'single', choiceId: 'pg' })).toEqual({ ok: true, text: 'pg' });
  });

  it('a choice that is not offered is 422', () => {
    expect(buildTaskAnswerText(SINGLE, { kind: 'single', choiceId: 'oracle' })).toMatchObject({
      ok: false,
      status: 422,
    });
  });

  it('a form answers every question on its own line, custom input included', () => {
    const r = buildTaskAnswerText(FORM, {
      kind: 'multi',
      selections: { q1: { choiceId: 'bun', label: 'Bun' }, q2: { choiceId: '직접입력', label: 'node:test' } },
    });
    expect(r).toEqual({ ok: true, text: 'Runtime?: bun. Bun\nTests?: (직접입력) node:test' });
  });

  it('a form with a missing answer or an unknown choice is 422', () => {
    expect(
      buildTaskAnswerText(FORM, { kind: 'multi', selections: { q1: { choiceId: 'node', label: 'Node' } } }),
    ).toMatchObject({ ok: false, status: 422 });
    expect(
      buildTaskAnswerText(FORM, {
        kind: 'multi',
        selections: { q1: { choiceId: 'deno', label: 'Deno' }, q2: { choiceId: 'jest', label: 'Jest' } },
      }),
    ).toMatchObject({ ok: false, status: 422 });
  });

  it('“submit all recommended” answers with each question’s recommendation', () => {
    expect(buildTaskAnswerText(FORM, { kind: 'recommended' })).toEqual({
      ok: true,
      text: 'Runtime?: node. Node\nTests?: vitest. Vitest',
    });
    const partial = {
      ...FORM,
      questions: [FORM.questions[0], { ...FORM.questions[1], recommendedChoiceId: undefined }],
    };
    expect(buildTaskAnswerText(partial, { kind: 'recommended' })).toMatchObject({ ok: false, status: 422 });
  });

  it('an answer of the wrong shape for the question is 409 (the question changed)', () => {
    expect(buildTaskAnswerText(SINGLE, { kind: 'recommended' })).toMatchObject({ ok: false, status: 409 });
    expect(buildTaskAnswerText(FORM, { kind: 'single', choiceId: 'node' })).toMatchObject({ ok: false, status: 409 });
  });
});
