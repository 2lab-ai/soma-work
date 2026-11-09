/**
 * #1073 — what the model is taught about decision lines, and where the spec says it.
 *
 * SSOT (issue #1073 Done 4): "모델 지침이 '대부분의 질문은 필요 없다, 막히거나 되돌릴 수 없을 때만'을 가르친다."
 *
 *   G1 the UIAskUserQuestion skill names the four fields and says most questions need none — only when the answer
 *      blocks work or the choice cannot be undone (with its reason).
 *   G2 a template that blocks a merge carries the fields and still passes both gates; the rest stay without.
 *   G3 the spec (12-ui-ask-user-question.md) lists the fields, the order and the Slack/dashboard rendering.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkAskUserQuestionQuality, validateModelCommandRunArgs } from 'somalib/model-commands/validator';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SKILL = readFileSync(join(ROOT, 'src', 'local', 'skills', 'UIAskUserQuestion', 'SKILL.md'), 'utf-8');
const SPEC = readFileSync(join(ROOT, 'docs', 'current', 'spec', '12-ui-ask-user-question.md'), 'utf-8');
const template = (name: string) =>
  JSON.parse(
    readFileSync(join(ROOT, 'src', 'local', 'skills', 'UIAskUserQuestion', 'templates', `${name}.json`), 'utf-8'),
  );

const section = (doc: string, heading: string) => {
  const start = doc.indexOf(heading);
  if (start < 0) return '';
  const next = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, next < 0 ? undefined : next);
};

describe('G1 — the skill teaches when to use decision lines', () => {
  const s = section(SKILL, '## Decision lines');

  it('has the section and names the four fields', () => {
    expect(s).not.toBe('');
    for (const f of ['blockedWork', 'stakes', 'reversible', 'reversibleWhy']) expect(s).toContain(`\`${f}\``);
  });

  it('says most questions need none — only when blocked or irreversible', () => {
    expect(s).toMatch(/most questions need none/i);
    expect(s).toMatch(/only when/i);
    expect(s).toMatch(/cannot be undone|irreversible/i);
  });

  it('says an irreversible choice needs its reason (the quality warning)', () => {
    expect(s).toMatch(/`reversible: false`[^\n]*`reversibleWhy`/);
  });

  it('says the answer the model gets back does not change', () => {
    expect(s).toMatch(/answer[^\n]*(same|unchanged|does not change)/i);
  });
});

describe('G2 — templates: fields only where the answer blocks work', () => {
  it.each([
    'z-phase2.9-pr-approval',
    'zcheck-pr-approve',
  ])('%s blocks a merge: carries the lines and passes both gates', (name) => {
    const { $schema: _s, _comment: _c, ...payload } = template(name);
    expect(typeof payload.blockedWork).toBe('string');
    expect(typeof payload.reversible).toBe('boolean');
    const r = validateModelCommandRunArgs({ commandId: 'ASK_USER_QUESTION', params: { payload } });
    if (!r.ok) throw new Error(r.error.message);
    expect(checkAskUserQuestionQuality(r.request.params as any)).toEqual([]);
  });

  it.each([
    'z-phase1-plan-approval',
    'ztrace-ambiguous-scenario',
    'zexplore-research-scope',
    'decision-gate-tier-medium',
  ])('%s leaves them out', (name) => {
    const t = template(name);
    for (const f of ['blockedWork', 'stakes', 'reversible', 'reversibleWhy']) expect(f in t).toBe(false);
  });
});

describe('G3 — the spec', () => {
  const s = section(SPEC, '## 7.10');

  it('has a decision-lines section naming the fields and the order', () => {
    expect(s).not.toBe('');
    for (const f of ['blockedWork', 'stakes', 'reversible', 'reversibleWhy']) expect(s).toContain(f);
    expect(s).toContain('🚧 막힌 작업');
    expect(s).toContain('⚖️ 걸린 것');
    expect(s).toContain('되돌릴 수 없음');
  });

  it('names the shared helpers (Slack builder and dashboard client)', () => {
    expect(s).toContain('buildDecisionLinesBlock');
    expect(s).toContain('decisionLines');
  });
});
