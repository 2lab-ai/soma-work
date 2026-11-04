import { describe, expect, it } from 'vitest';
import type { UserChoice, UserChoices } from './session-types';
import { validateModelCommandRunArgs } from './validator';

/**
 * #917 — every question to the user has one shape.
 *
 * SSOT_1 (Z, 2026-11-04): "유저 입력대기는 반드시 최소한 질문 하나에 해당 질문에 1번은 추천 행동 2번 3번은
 * 대안행동 그리고 맨 마지막에는 직접입력하는 유저에게 질문이 있어야함."
 *
 * ASK_USER_QUESTION takes 3–4 choices per question: choice 1 is the recommended action, the rest are
 * alternatives. The host adds 직접 입력 (direct input) as the last option on every surface, so a model-written
 * "direct input" choice is dropped instead of shown twice.
 */

function ask(payload: Record<string, unknown>) {
  return validateModelCommandRunArgs({ commandId: 'ASK_USER_QUESTION', params: { payload } });
}
function choices(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: String(i + 1), label: `Action ${i + 1}` }));
}
function single(result: ReturnType<typeof ask>): UserChoice {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
  return (result.request.params as { question: UserChoice }).question;
}
function group(result: ReturnType<typeof ask>): UserChoices {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
  return (result.request.params as { question: UserChoices }).question;
}

describe('ASK_USER_QUESTION — 1 recommended, 2–3 alternatives, direct input last (#917)', () => {
  it('refuses a question with fewer than 3 choices, and says the rule', () => {
    for (const n of [1, 2]) {
      const r = ask({ type: 'user_choice', question: 'Next?', recommendedChoiceId: '1', choices: choices(n) });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.code).toBe('INVALID_ARGS');
      expect(r.error.message).toContain('at least 3 choices');
      expect(r.error.message).toContain('recommended');
      expect(r.error.message).toContain('직접 입력');
    }
  });

  it('refuses more than 4 choices (Slack shows 4; direct input is the host’s last)', () => {
    const r = ask({ type: 'user_choice', question: 'Next?', recommendedChoiceId: '1', choices: choices(5) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('at most 4 choices');
  });

  it('accepts 3 and 4 choices', () => {
    expect(
      single(ask({ type: 'user_choice', question: 'Next?', recommendedChoiceId: '1', choices: choices(3) })).choices,
    ).toHaveLength(3);
    expect(
      single(ask({ type: 'user_choice', question: 'Next?', recommendedChoiceId: '1', choices: choices(4) })).choices,
    ).toHaveLength(4);
  });

  it('a question with no recommended choice gets choice 1 as the recommended one', () => {
    const q = single(ask({ type: 'user_choice', question: 'Next?', choices: choices(3) }));
    expect(q.recommendedChoiceId).toBe('1');
  });

  it('refuses a recommended choice that is not the first', () => {
    const r = ask({ type: 'user_choice', question: 'Next?', recommendedChoiceId: '2', choices: choices(3) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('recommended choice must be the first');
  });

  it('drops a model-written direct-input choice — the host adds it last — and counts what is left', () => {
    const q = single(
      ask({
        type: 'user_choice',
        question: 'Next?',
        recommendedChoiceId: '1',
        choices: [...choices(3), { id: '4', label: '✏️ 직접 입력' }],
      }),
    );
    expect(q.choices.map((c) => c.label)).toEqual(['Action 1', 'Action 2', 'Action 3']);
    for (const label of ['직접 입력', '직접입력', '기타', 'Other', 'Custom input', 'Type your own']) {
      const r = ask({
        type: 'user_choice',
        question: 'Next?',
        recommendedChoiceId: '1',
        choices: [...choices(2), { id: '9', label }],
      });
      expect(r.ok, label).toBe(false);
    }
  });

  it('keeps real actions that only start like a direct-input word (trinity R1 fable P3)', () => {
    const q = single(
      ask({
        type: 'user_choice',
        question: 'Next?',
        recommendedChoiceId: '1',
        choices: [
          { id: '1', label: 'Custom: 5 workers' },
          { id: '2', label: 'Other region first' },
          { id: '3', label: 'Default: 2 workers' },
        ],
      }),
    );
    expect(q.choices.map((c) => c.label)).toEqual(['Custom: 5 workers', 'Other region first', 'Default: 2 workers']);
  });

  it('applies to every item of a user_choice_group', () => {
    const r = ask({
      type: 'user_choice_group',
      question: 'Two decisions',
      choices: [
        { question: 'First?', recommendedChoiceId: '1', options: choices(3) },
        { question: 'Second?', recommendedChoiceId: '1', options: choices(2) },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('Second?');
    const ok = group(
      ask({
        type: 'user_choice_group',
        question: 'Two decisions',
        choices: [
          { question: 'First?', options: choices(3) },
          { question: 'Second?', options: choices(4) },
        ],
      }),
    );
    expect(ok.questions.map((q) => q.recommendedChoiceId)).toEqual(['1', '1']);
  });
});
