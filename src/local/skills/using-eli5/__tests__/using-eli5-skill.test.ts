import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RED contract for the using-eli5 skill.
 *
 * SSOT_1: "다음을 이용하여 using-eli5 스킬 만들어주고 추가해줘. 대충 다음의
 *          문맥을 추가해줘. using-govuk
 *
 *          항상 eli5 스타일의 먼저 넣고 그 다음에 실제 디테일한 내용을 추가"
 *
 *  - T1: src/local/skills/using-eli5/SKILL.md exists as a plugin skill, so the
 *        zworkflow plugin (directory-discovered by skill-locator) ships it.
 *  - T2: the skill inherits the using-govuk writing context for its detail layer.
 *  - T3: the skill's core contract is ELI5 first, then the full detail — with the
 *        detail layer losing nothing.
 */

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const SKILLS_DIR = resolve(SKILL_ROOT, '..');
const GOVUK_MD = resolve(SKILLS_DIR, 'using-govuk', 'SKILL.md');
const PLUGIN_JSON = resolve(SKILL_ROOT, '..', '..', '.claude-plugin', 'plugin.json');

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (key) out[key] = value;
  }
  return out;
}

function body(): string {
  return readFileSync(SKILL_MD, 'utf8');
}

describe('local:using-eli5 skill — plugin registration (T1)', () => {
  it('SKILL.md exists under src/local/skills so skill-locator discovers it', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    // Same parent directory as the sibling skill it is derived from.
    expect(existsSync(GOVUK_MD)).toBe(true);
  });

  it('sits under the manifest of the zworkflow plugin that ships src/local', () => {
    const plugin = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
    expect(plugin.name).toBe('zworkflow');
  });

  it('frontmatter name is using-eli5 with an ELI5-first description', () => {
    const fm = parseFrontmatter(body());
    expect(fm.name).toBe('using-eli5');
    const desc = (fm.description ?? '').toLowerCase();
    expect(desc).toMatch(/eli5|explain like/);
    expect(desc).toMatch(/first|먼저/);
  });

  it('description carries triggers in both languages', () => {
    const desc = (parseFrontmatter(body()).description ?? '').toLowerCase();
    expect(desc).toMatch(/eli5/);
    expect(desc).toMatch(/쉽게|초등학생|어린애/);
  });
});

describe('local:using-eli5 skill — doc contract: inherits using-govuk (T2)', () => {
  it('names using-govuk as the style it builds on', () => {
    expect(body()).toMatch(/using-govuk/);
  });

  it('carries the plain-English discipline for the detail layer', () => {
    const md = body().toLowerCase();
    expect(md).toMatch(/plain english/);
    expect(md).toMatch(/active voice/);
    expect(md).toMatch(/front-load/);
    expect(md).toMatch(/sentence case/);
  });

  it('states that opening up is not dumbing down', () => {
    expect(body().toLowerCase()).toMatch(/not.{0,30}dumb(ing)? (it )?down|open it up, do not dumb/);
  });
});

describe('local:using-eli5 skill — doc contract: ELI5 first (T3)', () => {
  it('mandates the ELI5 layer before the detail layer', () => {
    const md = body().toLowerCase();
    expect(md).toMatch(/eli5 (layer )?first|always.{0,40}eli5.{0,40}first/);
    expect(md).toMatch(/then the detail|detail layer/);
  });

  it('puts the ELI5 heading physically above the detail heading in the layer spec', () => {
    const md = body();
    const eli5Idx = md.search(/##.*eli5 layer/i);
    const detailIdx = md.search(/##.*detail layer/i);
    expect(eli5Idx).toBeGreaterThan(-1);
    expect(detailIdx).toBeGreaterThan(-1);
    expect(eli5Idx).toBeLessThan(detailIdx);
  });

  it('forbids the ELI5 layer from replacing or shrinking the detail', () => {
    const md = body().toLowerCase();
    expect(md).toMatch(/never.{0,60}replace|not a replacement|대체하지/);
    expect(md).toMatch(/lose|lost|nothing is removed|무손실|생략/);
  });

  it('forbids the two layers from contradicting each other', () => {
    // Anchored on the prohibition, so a permissive sentence cannot satisfy it.
    expect(body().toLowerCase()).toMatch(/must never contradict/);
  });

  it('gives a hard length budget for the ELI5 layer', () => {
    // A soft number is a mood, not a contract.
    expect(body()).toMatch(/\b\d{2,3}\s*words maximum/);
  });

  it('closes the exception list — no self-judged skipping', () => {
    const md = body().toLowerCase();
    // Trivial content shrinks the layer; it never removes it.
    expect(md).toMatch(/shrinks to one sentence/);
    expect(md).toMatch(/complete list of exceptions|this is the complete list/);
    // Only an explicit user request, never the agent's own read of the audience.
    expect(md).toMatch(/explicitly asked/);
    expect(md).toMatch(/own (reading|belief|judgement).{0,40}(audience|expert)/);
  });

  it('resolves the analogy conflict with using-govuk, with a counted unit', () => {
    const md = body().toLowerCase();
    expect(md).toMatch(/metaphor|clich/);
    // "one analogy" with no unit means one per section, per document or per whim.
    expect(md).toMatch(/one analogy per eli5 layer/);
  });

  it('defers to using-govuk for the banned word list instead of copying it', () => {
    const md = body().toLowerCase();
    expect(md).toMatch(/full using-govuk banned list/);
    // A partial copy silently permits whatever it left out.
    expect(md).not.toMatch(/ring-fence/);
  });

  it('yields the first PR-body position to the calldiff block', () => {
    const md = body().toLowerCase();
    expect(md).toMatch(/calldiff/);
    expect(md).toMatch(/first position|stays first/);
  });

  it('says when NOT to add an ELI5 layer', () => {
    const md = body().toLowerCase();
    expect(md).toMatch(/when not to|do not add an eli5|skip the eli5/);
  });

  it('has a before-you-finish self-check', () => {
    expect(body().toLowerCase()).toMatch(/self-check|before you finish/);
  });

  it('dogfoods its own labelling rule', () => {
    // The skill demands both layers be labelled; this file is prose too.
    const md = body();
    expect(md).toMatch(/^## In short$/m);
    expect(md).toMatch(/^Detail: /m);
  });

  it('shows a worked before/after example', () => {
    const md = body().toLowerCase();
    expect(md).toMatch(/example/);
    expect(md).toMatch(/in short|쉽게 말하면/);
  });
});
