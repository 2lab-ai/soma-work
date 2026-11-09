import { describe, expect, it } from 'vitest';
import { listModelCommands } from './catalog';
import type { UserChoice, UserChoices } from './session-types';
import { checkAskUserQuestionQuality, validateModelCommandRunArgs } from './validator';

/**
 * #1073 — decision lines on ASK_USER_QUESTION (Plannotator Inbox P2, epic #1076).
 *
 * SSOT (issue #1073): three optional lines — the work this answer blocks, what is at stake, whether the choice can be
 * undone and why — on a single question and on each question of a group. The schema names them, the validator's
 * normalization (whitelist 1) keeps them, one line each with a 160-char cap, and the soft quality check warns when a
 * choice is said to be irreversible without saying why.
 *
 *   V1 schema: single + group question carry blockedWork / stakes / reversible / reversibleWhy.
 *   V2 normalization keeps them (single, group), collapses each to one line, caps it at 160 chars.
 *   V3 reversible is a boolean (true/false/yes/no strings are read as one); a why without a verdict is dropped.
 *   V4 without the fields the normalized question is exactly as before (no new keys).
 *   V5 quality: reversible:false without a why warns; with a why, or with no fields, nothing new.
 */

function ask(payload: Record<string, unknown>) {
  return validateModelCommandRunArgs({ commandId: 'ASK_USER_QUESTION', params: { payload } });
}
const CHOICES = [
  { id: '1', label: 'Run it now' },
  { id: '2', label: 'Run it tomorrow' },
  { id: '3', label: 'Do not run it' },
];
function single(payload: Record<string, unknown>): UserChoice {
  const r = ask({ type: 'user_choice', question: '[small] Run the migration?', choices: CHOICES, ...payload });
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message}`);
  return (r.request.params as { question: UserChoice }).question;
}
function group(items: Record<string, unknown>[]): UserChoices {
  const r = ask({
    type: 'user_choice_group',
    question: '[medium] Two decisions',
    choices: items.map((extra, i) => ({ question: `Q${i + 1}?`, options: CHOICES, ...extra })),
  });
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message}`);
  return (r.request.params as { question: UserChoices }).question;
}

describe('V1 — the schema names the decision fields', () => {
  const schema = listModelCommands({} as any).find((c) => c.id === 'ASK_USER_QUESTION')?.paramsSchema as any;
  const [singleSchema, groupSchema] = schema.properties.payload.oneOf;
  const groupItem = groupSchema.properties.choices.items;

  it.each([
    ['single', singleSchema],
    ['group question', groupItem],
  ])('%s carries blockedWork, stakes, reversible, reversibleWhy (all optional)', (_name, s) => {
    expect(s.properties.blockedWork.type).toBe('string');
    expect(s.properties.stakes.type).toBe('string');
    expect(s.properties.reversible.type).toBe('boolean');
    expect(s.properties.reversibleWhy.type).toBe('string');
    for (const f of ['blockedWork', 'stakes', 'reversible', 'reversibleWhy']) expect(s.required).not.toContain(f);
  });

  it('the description says most questions need none', () => {
    expect(singleSchema.properties.blockedWork.description).toMatch(/most questions/i);
  });
});

describe('V2 — normalization keeps the fields, one line each, capped', () => {
  it('single question keeps all four', () => {
    const q = single({
      blockedWork: 'Deploy of PR #42',
      stakes: '20k user rows',
      reversible: false,
      reversibleWhy: 'a dropped column comes back only from backup',
    });
    expect(q).toMatchObject({
      blockedWork: 'Deploy of PR #42',
      stakes: '20k user rows',
      reversible: false,
      reversibleWhy: 'a dropped column comes back only from backup',
    });
  });

  it('each question of a group keeps its own', () => {
    const g = group([{ blockedWork: 'release build', reversible: true }, { stakes: 'changelog' }]);
    expect(g.questions[0]).toMatchObject({ blockedWork: 'release build', reversible: true });
    expect(g.questions[1]).toMatchObject({ stakes: 'changelog' });
    expect(g.questions[1].blockedWork).toBeUndefined();
  });

  it('line breaks and runs of spaces collapse to one space; ends are trimmed', () => {
    const q = single({ blockedWork: '  deploy\n\n  of   PR #42 \t', stakes: 'a\r\nb' });
    expect(q.blockedWork).toBe('deploy of PR #42');
    expect(q.stakes).toBe('a b');
  });

  it('a line longer than 160 chars is cut to 160 with an ellipsis', () => {
    const q = single({ stakes: 'x'.repeat(500), reversible: false, reversibleWhy: 'y'.repeat(161) });
    expect(q.stakes).toHaveLength(160);
    expect(q.stakes?.endsWith('…')).toBe(true);
    expect(q.reversibleWhy).toHaveLength(160);
    expect(single({ stakes: 'z'.repeat(160) }).stakes).toBe('z'.repeat(160));
  });

  it('blank or non-string text is dropped', () => {
    const q = single({ blockedWork: '   ', stakes: 42 });
    expect('blockedWork' in q).toBe(false);
    expect('stakes' in q).toBe(false);
  });
});

describe('V3 — reversible is a boolean; a why needs a verdict', () => {
  it('true / false are kept, and the strings true / false / yes / no read as them', () => {
    expect(single({ reversible: true }).reversible).toBe(true);
    expect(single({ reversible: false }).reversible).toBe(false);
    expect(single({ reversible: 'false' }).reversible).toBe(false);
    expect(single({ reversible: 'TRUE' }).reversible).toBe(true);
    expect(single({ reversible: ' no ', reversibleWhy: 'drops data' })).toMatchObject({
      reversible: false,
      reversibleWhy: 'drops data',
    });
    expect(single({ reversible: 'Yes' }).reversible).toBe(true);
  });

  it('anything else is dropped, and its why with it', () => {
    const q = single({ reversible: 'maybe', reversibleWhy: 'because' });
    expect('reversible' in q).toBe(false);
    expect('reversibleWhy' in q).toBe(false);
    expect('reversibleWhy' in single({ reversibleWhy: 'only a why' })).toBe(false);
  });
});

describe('V4 — no fields: the question is exactly as before', () => {
  it('single', () => {
    expect(single({ context: 'c' })).toEqual({
      type: 'user_choice',
      question: '[small] Run the migration?',
      context: 'c',
      choices: CHOICES,
      recommendedChoiceId: '1',
    });
  });

  it('group', () => {
    const g = group([{}]);
    expect(Object.keys(g.questions[0]).sort()).toEqual(['choices', 'context', 'id', 'question', 'recommendedChoiceId']);
  });
});

describe('V5 — quality: an irreversible choice says why', () => {
  const IRREV = /reversible is false.*reversibleWhy/i;
  const warningsOf = (question: UserChoice | UserChoices) => checkAskUserQuestionQuality({ question });

  it('single: reversible:false without a why warns', () => {
    expect(warningsOf(single({ reversible: false })).some((w) => IRREV.test(w))).toBe(true);
  });

  it('single: with a why, reversible:true, or no fields — no such warning', () => {
    for (const extra of [{ reversible: false, reversibleWhy: 'drops data' }, { reversible: true }, {}]) {
      expect(warningsOf(single(extra)).some((w) => IRREV.test(w))).toBe(false);
    }
  });

  it('group: the warning names the question', () => {
    const w = warningsOf(group([{}, { reversible: false }])).filter((x) => IRREV.test(x));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^question\[q2\]: /);
  });

  it('the run result carries the warning back to the model', async () => {
    const { runModelCommand } = await import('./catalog');
    const r = ask({ type: 'user_choice', question: '[small] Drop it?', choices: CHOICES, reversible: false });
    if (!r.ok) throw new Error(r.error.message);
    const out = await runModelCommand(r.request, {} as any);
    expect(out.ok).toBe(true);
    expect(((out as any).payload.warnings as string[]).some((x) => IRREV.test(x))).toBe(true);
  });
});
