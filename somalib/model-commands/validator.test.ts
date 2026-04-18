import { describe, expect, it } from 'vitest';
import { runModelCommand } from './catalog';
import type { UserChoice, UserChoices } from './session-types';
import type { AskUserQuestionParams, ModelCommandRunRequest } from './types';
import { checkAskUserQuestionQuality, validateModelCommandRunArgs } from './validator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withLen(n: number): string {
  return 'x'.repeat(n);
}

function makeUserChoice(overrides: Partial<UserChoice> = {}): UserChoice {
  return {
    type: 'user_choice',
    question: '[small] Which approach?',
    context: withLen(80),
    choices: [
      { id: '1', label: 'Write tests first (Recommended · 1/2)' },
      { id: '2', label: 'Ship implementation now' },
    ],
    ...overrides,
  };
}

function makeUserChoices(overrides: Partial<UserChoices> = {}): UserChoices {
  return {
    type: 'user_choices',
    title: '[medium] Choose path',
    questions: [
      {
        id: 'q1',
        question: 'Which approach?',
        context: withLen(80),
        choices: [
          { id: '1', label: 'Option A (Recommended · 1/2)' },
          { id: '2', label: 'Option B' },
        ],
      },
    ],
    ...overrides,
  };
}

function warnings(question: UserChoice | UserChoices): string[] {
  return checkAskUserQuestionQuality({ question } as AskUserQuestionParams);
}

// ---------------------------------------------------------------------------
// Rule 1 — options count must be 2..4
// ---------------------------------------------------------------------------

describe('Rule 1 — option count bounds', () => {
  it('warns when user_choice has 1 option', () => {
    const q = makeUserChoice({
      choices: [{ id: '1', label: 'Only one (Recommended · 1/1)' }],
    });
    const w = warnings(q);
    expect(w).toContain('options count (1) below minimum 2 — provide at least 2 choices');
  });

  it('accepts user_choice with 2 options', () => {
    const q = makeUserChoice();
    const w = warnings(q);
    expect(w.some((s) => s.includes('below minimum'))).toBe(false);
    expect(w.some((s) => s.includes('exceeds maximum'))).toBe(false);
  });

  it('accepts user_choice with 4 options', () => {
    const q = makeUserChoice({
      choices: [
        { id: '1', label: 'Alpha (Recommended · 1/4)' },
        { id: '2', label: 'Bravo' },
        { id: '3', label: 'Charlie' },
        { id: '4', label: 'Delta' },
      ],
    });
    const w = warnings(q);
    expect(w.some((s) => s.includes('below minimum'))).toBe(false);
    expect(w.some((s) => s.includes('exceeds maximum'))).toBe(false);
  });

  it('warns when user_choice has 5 options', () => {
    const q = makeUserChoice({
      choices: [
        { id: '1', label: 'Alpha (Recommended · 1/5)' },
        { id: '2', label: 'Bravo' },
        { id: '3', label: 'Charlie' },
        { id: '4', label: 'Delta' },
        { id: '5', label: 'Echo' },
      ],
    });
    const w = warnings(q);
    expect(w).toContain('options count (5) exceeds maximum 4 — Slack button row readability');
  });

  it('user_choices: per-question count check with prefix', () => {
    const q = makeUserChoices({
      questions: [
        {
          id: 'q1',
          question: 'A?',
          context: withLen(80),
          choices: [{ id: '1', label: 'Only one' }],
        },
      ],
    });
    const w = warnings(q);
    expect(w.some((s) => s === 'question[q1]: options count (1) below minimum 2 — provide at least 2 choices')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — tier prefix required
// ---------------------------------------------------------------------------

describe('Rule 2 — tier prefix', () => {
  const prefixMissingMsg =
    'question missing tier prefix — expected [tiny|small|medium|large|xlarge] (optionally with ~N lines)';

  it('accepts [tiny] prefix', () => {
    const q = makeUserChoice({ question: '[tiny] Pick one' });
    expect(warnings(q)).not.toContain(prefixMissingMsg);
  });

  it('accepts [small ~30 lines] prefix', () => {
    const q = makeUserChoice({ question: '[small ~30 lines] Pick one' });
    expect(warnings(q)).not.toContain(prefixMissingMsg);
  });

  it('accepts [Medium ~50] case-insensitive', () => {
    const q = makeUserChoice({ question: '[Medium ~50] Pick one' });
    expect(warnings(q)).not.toContain(prefixMissingMsg);
  });

  it('accepts [XLARGE ~500 line] singular line', () => {
    const q = makeUserChoice({ question: '[XLARGE ~500 line] Pick one' });
    expect(warnings(q)).not.toContain(prefixMissingMsg);
  });

  it('warns when prefix absent', () => {
    const q = makeUserChoice({ question: 'Which approach?' });
    expect(warnings(q)).toContain(prefixMissingMsg);
  });

  it('warns when prefix is mid-sentence', () => {
    const q = makeUserChoice({ question: 'Pick: [small] Which one?' });
    expect(warnings(q)).toContain(prefixMissingMsg);
  });

  it('warns for unknown tier like [huge]', () => {
    const q = makeUserChoice({ question: '[huge] Pick one' });
    expect(warnings(q)).toContain(prefixMissingMsg);
  });

  it('user_choices title with prefix is accepted', () => {
    const q = makeUserChoices({ title: '[large ~100 lines] Choose path' });
    expect(warnings(q)).not.toContain(prefixMissingMsg);
  });

  it('user_choices title without prefix warns once', () => {
    const q = makeUserChoices({ title: 'Choose path' });
    const matches = warnings(q).filter((s) => s === prefixMissingMsg);
    expect(matches.length).toBe(1);
  });

  it('user_choices with undefined title still warns (no silent bypass)', () => {
    // Direct UserChoices construction with omitted title must not silently
    // skip Rule 2 — caller would otherwise sidestep tier annotation entirely.
    const q: UserChoices = {
      type: 'user_choices',
      questions: [
        {
          id: 'q1',
          question: '[small] Pick',
          context: withLen(80),
          choices: [
            { id: '1', label: 'A (Recommended · 1/2)' },
            { id: '2', label: 'B' },
          ],
        },
      ],
    };
    expect(warnings(q)).toContain(prefixMissingMsg);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — context required + trimmed length ≥ 80
// ---------------------------------------------------------------------------

describe('Rule 3 — context presence and length', () => {
  const missing = 'context missing — stakeholder needs decision rationale';

  it('warns when context undefined', () => {
    const q = makeUserChoice({ context: undefined });
    expect(warnings(q)).toContain(missing);
  });

  it('warns when context empty string', () => {
    const q = makeUserChoice({ context: '' });
    expect(warnings(q)).toContain(missing);
  });

  it('warns when context whitespace-only', () => {
    const q = makeUserChoice({ context: '     ' });
    expect(warnings(q)).toContain(missing);
  });

  it('warns when context trimmed is 79 chars', () => {
    const ctx79 = withLen(79);
    const q = makeUserChoice({ context: ctx79 });
    expect(warnings(q)).toContain('context too short (79 chars, min 80) — expand rationale');
  });

  it('accepts context trimmed at exactly 80 chars', () => {
    const q = makeUserChoice({ context: withLen(80) });
    const w = warnings(q);
    expect(w.some((s) => s.includes('context too short'))).toBe(false);
    expect(w).not.toContain(missing);
  });

  it('accepts context at 81 chars', () => {
    const q = makeUserChoice({ context: withLen(81) });
    expect(warnings(q).some((s) => s.includes('context too short'))).toBe(false);
  });

  it('user_choices: per-question context required when description is absent', () => {
    const q = makeUserChoices({
      description: undefined,
      questions: [
        {
          id: 'q1',
          question: '[small] Pick',
          context: undefined,
          choices: [
            { id: '1', label: 'Option A (Recommended · 1/2)' },
            { id: '2', label: 'Option B' },
          ],
        },
      ],
    });
    expect(warnings(q)).toContain('question[q1]: context missing — stakeholder needs decision rationale');
  });

  it('user_choices: per-question context required when description < 80 chars', () => {
    const q = makeUserChoices({
      description: withLen(79),
      questions: [
        {
          id: 'q1',
          question: '[small] Pick',
          context: undefined,
          choices: [
            { id: '1', label: 'Option A (Recommended · 1/2)' },
            { id: '2', label: 'Option B' },
          ],
        },
      ],
    });
    expect(warnings(q)).toContain('question[q1]: context missing — stakeholder needs decision rationale');
  });

  it('user_choices: group-level description ≥ 80 covers per-question context', () => {
    // After user_choice_group normalization the raw top-level context lands
    // in `description`. Accept that as a substitute for per-question context
    // so single-question approval templates don't have to duplicate text.
    const q = makeUserChoices({
      description: withLen(80),
      questions: [
        {
          id: 'q1',
          question: '[small] Pick',
          context: undefined,
          choices: [
            { id: '1', label: 'Option A (Recommended · 1/2)' },
            { id: '2', label: 'Option B' },
          ],
        },
      ],
    });
    const w = warnings(q);
    expect(w.some((s) => s.includes('context missing'))).toBe(false);
    expect(w.some((s) => s.includes('context too short'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — forbidden meta/approval labels
// ---------------------------------------------------------------------------

describe('Rule 4 — forbidden meta labels', () => {
  const SAMPLES = ['fix_now', 'approve', 'yes', 'no', 'confirm', 'ok'];
  for (const bad of SAMPLES) {
    it(`warns on forbidden label "${bad}"`, () => {
      const q = makeUserChoice({
        choices: [
          { id: '1', label: 'Proceed with refactor (Recommended · 1/2)' },
          { id: '2', label: bad },
        ],
      });
      const w = warnings(q);
      expect(w.some((s) => s.includes(`option [2] label '${bad}' is a meta/approval verb`))).toBe(true);
    });
  }

  it('warns on forbidden label even with surrounding punctuation', () => {
    const q = makeUserChoice({
      choices: [
        { id: '1', label: 'Do the hard thing (Recommended · 1/2)' },
        { id: '2', label: '  yes!  ' },
      ],
    });
    const w = warnings(q);
    expect(w.some((s) => s.includes("label '  yes!  ' is a meta/approval verb"))).toBe(true);
  });

  it('accepts domain-specific label containing forbidden word as substring', () => {
    // "Proceed to zwork" contains "proceed" but is a valid domain phrase.
    const q = makeUserChoice({
      choices: [
        { id: '1', label: 'Proceed to zwork (Recommended · 1/2)' },
        { id: '2', label: 'Revise plan' },
      ],
    });
    const w = warnings(q);
    expect(w.some((s) => s.includes('meta/approval verb'))).toBe(false);
  });

  it('strips Recommended marker before checking forbidden label', () => {
    const q = makeUserChoice({
      choices: [
        { id: '1', label: 'approve (Recommended · 1/2)' },
        { id: '2', label: 'Write tests first' },
      ],
    });
    const w = warnings(q);
    expect(
      w.some((s) => s.includes("option [1] label 'approve (Recommended · 1/2)' is a meta/approval verb")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — Recommended marker label-only exactly-one
// ---------------------------------------------------------------------------

describe('Rule 5 — Recommended marker', () => {
  it('warns when no Recommended marker among >=2 options', () => {
    const q = makeUserChoice({
      choices: [
        { id: '1', label: 'Write docs' },
        { id: '2', label: 'Write tests' },
      ],
    });
    expect(warnings(q)).toContain("no Recommended marker — mark one option as '(Recommended · N/M)'");
  });

  it('accepts exactly one Recommended marker', () => {
    const q = makeUserChoice({
      choices: [
        { id: '1', label: 'Write docs (Recommended · 1/2)' },
        { id: '2', label: 'Write tests' },
      ],
    });
    const w = warnings(q);
    expect(w.some((s) => s.includes('Recommended marker'))).toBe(false);
  });

  it('warns when two Recommended markers', () => {
    const q = makeUserChoice({
      choices: [
        { id: '1', label: 'Write docs (Recommended · 1/2)' },
        { id: '2', label: 'Write tests (Recommended · 2/2)' },
      ],
    });
    expect(warnings(q)).toContain('multiple Recommended markers (2) — exactly one expected');
  });

  it('warns when marker appears in description', () => {
    const q = makeUserChoice({
      choices: [
        {
          id: '1',
          label: 'Write docs (Recommended · 1/2)',
          description: 'Something (Recommended · 1/2)',
        },
        { id: '2', label: 'Write tests' },
      ],
    });
    const w = warnings(q);
    expect(w).toContain('Recommended marker in description (option [1]) — must be in label only');
  });

  it('tolerates whitespace inside marker (Recommended  ·  1/2)', () => {
    const q = makeUserChoice({
      choices: [
        { id: '1', label: 'Write docs (Recommended  ·  1/2)' },
        { id: '2', label: 'Write tests' },
      ],
    });
    const w = warnings(q);
    expect(w.some((s) => s.includes('no Recommended marker'))).toBe(false);
  });

  it('user_choices: per-question marker check', () => {
    const q = makeUserChoices({
      questions: [
        {
          id: 'q1',
          question: '[small] First?',
          context: withLen(80),
          choices: [
            { id: '1', label: 'A' },
            { id: '2', label: 'B' },
          ],
        },
      ],
    });
    expect(warnings(q)).toContain("question[q1]: no Recommended marker — mark one option as '(Recommended · N/M)'");
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — question non-empty
// ---------------------------------------------------------------------------

describe('Rule 6 — question non-empty', () => {
  it('warns when user_choice.question is empty', () => {
    const q = makeUserChoice({ question: '' });
    expect(warnings(q)).toContain('question is empty or whitespace-only');
  });

  it('warns when user_choice.question is whitespace-only', () => {
    const q = makeUserChoice({ question: '    ' });
    expect(warnings(q)).toContain('question is empty or whitespace-only');
  });

  it('warns when user_choices.title is empty string', () => {
    const q = makeUserChoices({ title: '' });
    expect(warnings(q)).toContain('question is empty or whitespace-only');
  });

  it('user_choices: per-question question.question empty', () => {
    const q = makeUserChoices({
      questions: [
        {
          id: 'q1',
          question: '',
          context: withLen(80),
          choices: [
            { id: '1', label: 'A (Recommended · 1/2)' },
            { id: '2', label: 'B' },
          ],
        },
      ],
    });
    expect(warnings(q)).toContain('question[q1]: question is empty or whitespace-only');
  });
});

// ---------------------------------------------------------------------------
// Integration — catalog handler + JSON round-trip
// ---------------------------------------------------------------------------

describe('Integration — catalog handler + JSON round-trip', () => {
  it('high-quality payload yields no warnings key (absent after round-trip)', () => {
    const req: ModelCommandRunRequest = {
      commandId: 'ASK_USER_QUESTION',
      params: { question: makeUserChoice() },
    };
    const result = runModelCommand(req, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = result.payload as Record<string, unknown>;
    expect('warnings' in payload).toBe(false);

    const roundTripped = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect(roundTripped.warnings).toBeUndefined();
  });

  it('low-quality payload emits warnings array preserved over JSON round-trip', () => {
    const req: ModelCommandRunRequest = {
      commandId: 'ASK_USER_QUESTION',
      params: {
        question: {
          type: 'user_choice',
          question: 'no prefix', // Rule 2 violation
          // context missing — Rule 3 violation
          choices: [
            { id: '1', label: 'yes' }, // Rule 4 + no marker + count=1 (Rule 1)
          ],
        },
      },
    };
    const result = runModelCommand(req, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = result.payload as { warnings?: string[] };
    expect(Array.isArray(payload.warnings)).toBe(true);
    expect((payload.warnings ?? []).length).toBeGreaterThan(0);

    const roundTripped = JSON.parse(JSON.stringify(payload)) as { warnings?: string[] };
    expect(Array.isArray(roundTripped.warnings)).toBe(true);
    expect(roundTripped.warnings).toEqual(payload.warnings);
  });

  it('validator schema still accepts a valid user_choice payload (no regression)', () => {
    const args = {
      commandId: 'ASK_USER_QUESTION',
      params: {
        payload: {
          type: 'user_choice',
          question: '[small] Which approach?',
          context: withLen(80),
          choices: [
            { id: '1', label: 'Write tests first (Recommended · 1/2)' },
            { id: '2', label: 'Ship implementation now' },
          ],
        },
      },
    };
    const result = validateModelCommandRunArgs(args);
    expect(result.ok).toBe(true);
  });

  it('validator schema still rejects a malformed payload (no regression)', () => {
    const args = {
      commandId: 'ASK_USER_QUESTION',
      params: {
        // missing "payload" wrapper — schema must still reject.
        question: 'hello',
      },
    };
    const result = validateModelCommandRunArgs(args);
    expect(result.ok).toBe(false);
  });

  it('user_choice_group with top-level context ≥ 80: normalized → 0 warnings', () => {
    // Raw user_choice_group lands in description after normalization.
    // This is the PR3 single-question approval template pattern.
    const args = {
      commandId: 'ASK_USER_QUESTION',
      params: {
        payload: {
          type: 'user_choice_group',
          question: '[small] Approve this merge?',
          context: withLen(80),
          choices: [
            {
              question: 'Approve this merge?',
              options: [
                { id: '1', label: 'Merge now (Recommended · 1/2)' },
                { id: '2', label: 'Request rework' },
              ],
            },
          ],
        },
      },
    };
    const validated = validateModelCommandRunArgs(args);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = runModelCommand(validated.request, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as { warnings?: string[] };
    expect(payload.warnings).toBeUndefined();
  });

  it('user_choice_group with short top-level context: per-question context still required', () => {
    const args = {
      commandId: 'ASK_USER_QUESTION',
      params: {
        payload: {
          type: 'user_choice_group',
          question: '[small] Approve this merge?',
          context: 'short',
          choices: [
            {
              question: 'Approve this merge?',
              options: [
                { id: '1', label: 'Merge now (Recommended · 1/2)' },
                { id: '2', label: 'Request rework' },
              ],
            },
          ],
        },
      },
    };
    const validated = validateModelCommandRunArgs(args);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = runModelCommand(validated.request, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as { warnings?: string[] };
    expect(payload.warnings).toBeDefined();
    // Normalized question id defaults to "q1" via normalizeUserChoiceQuestion.
    expect((payload.warnings ?? []).some((s) => s.startsWith('question[q1]: context missing'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sanity — empty/degenerate inputs don't throw
// ---------------------------------------------------------------------------

describe('defensive — degenerate inputs', () => {
  it('empty choices list does not double-warn about markers', () => {
    const q: UserChoice = {
      type: 'user_choice',
      question: '[small] Pick',
      context: withLen(80),
      choices: [],
    };
    const w = warnings(q);
    // Rule 1 fires, but Rule 5 should not add "no Recommended marker" on top
    // of it (degenerate count < 2 is already flagged by Rule 1).
    expect(w.some((s) => s.includes('below minimum 2'))).toBe(true);
    expect(w.some((s) => s.includes('no Recommended marker'))).toBe(false);
  });
});

function parsePayload(args: unknown): UserChoice | UserChoices | null {
  const result = validateModelCommandRunArgs(args);
  if (!result.ok) return null;
  if (result.request.commandId !== 'ASK_USER_QUESTION') return null;
  return result.request.params.question;
}

describe('validator — ASK_USER_QUESTION recommendedChoiceId', () => {
  describe('user_choice (single)', () => {
    it('preserves explicit recommendedChoiceId when it matches an option id', () => {
      const question = parsePayload({
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice',
            question: 'Choose',
            recommendedChoiceId: '2',
            choices: [
              { id: '1', label: 'A' },
              { id: '2', label: 'B' },
            ],
          },
        },
      }) as UserChoice | null;
      expect(question).not.toBeNull();
      expect(question?.type).toBe('user_choice');
      expect(question?.recommendedChoiceId).toBe('2');
    });

    it('drops explicit recommendedChoiceId silently when it does not match any option id', () => {
      const question = parsePayload({
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice',
            question: 'Choose',
            recommendedChoiceId: 'zzz',
            choices: [
              { id: '1', label: 'A' },
              { id: '2', label: 'B' },
            ],
          },
        },
      }) as UserChoice | null;
      expect(question).not.toBeNull();
      expect(question?.recommendedChoiceId).toBeUndefined();
    });

    it('infers recommendedChoiceId from legacy "(Recommended · 3/3)" label suffix when field is missing', () => {
      const question = parsePayload({
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice',
            question: 'Choose',
            choices: [
              { id: '1', label: 'A' },
              { id: '2', label: 'B (Recommended · 3/3)' },
            ],
          },
        },
      }) as UserChoice | null;
      expect(question).not.toBeNull();
      expect(question?.recommendedChoiceId).toBe('2');
    });

    it('falls back to legacy label scan when explicit id is unknown', () => {
      const question = parsePayload({
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice',
            question: 'Choose',
            recommendedChoiceId: 'zzz',
            choices: [
              { id: '1', label: 'A (Recommended)' },
              { id: '2', label: 'B' },
            ],
          },
        },
      }) as UserChoice | null;
      expect(question?.recommendedChoiceId).toBe('1');
    });

    it('leaves recommendedChoiceId undefined when neither explicit nor legacy marker is present', () => {
      const question = parsePayload({
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice',
            question: 'Choose',
            choices: [
              { id: '1', label: 'A' },
              { id: '2', label: 'B' },
            ],
          },
        },
      }) as UserChoice | null;
      expect(question).not.toBeNull();
      expect(question?.recommendedChoiceId).toBeUndefined();
    });
  });

  describe('user_choice_group (group → single/multi)', () => {
    it('preserves per-question recommendedChoiceId (single collapses path)', () => {
      const result = parsePayload({
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice_group',
            question: 'Pick',
            choices: [
              {
                question: 'Which?',
                recommendedChoiceId: '1',
                options: [
                  { id: '1', label: 'A' },
                  { id: '2', label: 'B' },
                ],
              },
            ],
          },
        },
      });
      // Single question collapses to a user_choices with 1 question
      expect(result).not.toBeNull();
      const choices = result as UserChoices;
      expect(choices.type).toBe('user_choices');
      expect(choices.questions[0].recommendedChoiceId).toBe('1');
    });

    it('preserves recommendedChoiceId on each question in a multi-question group', () => {
      const result = parsePayload({
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice_group',
            question: 'Two decisions',
            choices: [
              {
                question: 'First?',
                recommendedChoiceId: '2',
                options: [
                  { id: '1', label: 'A' },
                  { id: '2', label: 'B' },
                ],
              },
              {
                question: 'Second?',
                options: [
                  { id: 'x', label: 'X' },
                  { id: 'y', label: 'Y (Recommended · 2/3)' },
                ],
              },
            ],
          },
        },
      });
      expect(result).not.toBeNull();
      const choices = result as UserChoices;
      expect(choices.type).toBe('user_choices');
      expect(choices.questions).toHaveLength(2);
      expect(choices.questions[0].recommendedChoiceId).toBe('2');
      // Legacy label fallback on second question
      expect(choices.questions[1].recommendedChoiceId).toBe('y');
    });

    it('drops unknown per-question recommendedChoiceId silently', () => {
      const result = parsePayload({
        commandId: 'ASK_USER_QUESTION',
        params: {
          payload: {
            type: 'user_choice_group',
            question: 'Pick',
            choices: [
              {
                question: 'Which?',
                recommendedChoiceId: 'bogus',
                options: [
                  { id: '1', label: 'A' },
                  { id: '2', label: 'B' },
                ],
              },
            ],
          },
        },
      });
      expect(result).not.toBeNull();
      const choices = result as UserChoices;
      expect(choices.questions[0].recommendedChoiceId).toBeUndefined();
    });
  });
});
