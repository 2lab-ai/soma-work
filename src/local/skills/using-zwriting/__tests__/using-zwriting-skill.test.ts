import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for local:using-zwriting — the one writing skill that replaced
 * using-govuk, using-eli5, using-ha-thinking and structurize.
 *
 * SSOT: "using-govuk는 여러가지 스킬이랑 중복이거든? … 사람이 이해할수 있는 언어로 작성하는 스킬 …
 *        이걸 종합해서 하나의 스킬로 만들어줘. using-zwriting 정도로 … 계층적 추상화로 여러 단계로
 *        항상 설명해주도록" + "using-govuk 수정 — 시간 표기(콜론)·문장 시작 숫자·원문 빈틈 표시 규칙".
 *
 *  - T1 registration: the skill ships in the zworkflow plugin; the four old skills are gone.
 *  - T2 layered explanation: always a ladder, top first, each rung closes in its own words.
 *  - T3 research fixes: colon times, sentence-start numbers, visible source gaps, no added facts.
 *  - T4 structure engine: structurize's lossless engine and renderers survive as references.
 */

const SKILL_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = resolve(SKILL_ROOT, '..');
const PLUGIN_ROOT = resolve(SKILLS_DIR, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const PLAIN_MD = resolve(SKILL_ROOT, 'references', 'plain-language.md');
const ENGINE_MD = resolve(SKILL_ROOT, 'references', 'structure-engine.md');
const RENDERERS_MD = resolve(SKILL_ROOT, 'references', 'renderers.md');
const RETIRED = ['using-govuk', 'using-eli5', 'using-ha-thinking', 'structurize'];

const read = (p: string) => readFileSync(p, 'utf8');

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('local:using-zwriting — registration (T1)', () => {
  it('ships under the zworkflow plugin with name using-zwriting', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    expect(JSON.parse(read(resolve(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))).name).toBe('zworkflow');
    expect(frontmatter(read(SKILL_MD)).name).toBe('using-zwriting');
  });

  it('the description says only when to use it, with triggers in both languages', () => {
    const desc = frontmatter(read(SKILL_MD)).description ?? '';
    expect(desc).toMatch(/^Use when /);
    expect(desc).not.toMatch(/Args/);
    expect(desc).toMatch(/eli5/);
    expect(desc).toMatch(/쉽게 설명해줘/);
    expect(desc).toMatch(/구조화해줘/);
  });

  it('the four skills it replaces are gone from the plugin', () => {
    for (const name of RETIRED) expect(existsSync(resolve(SKILLS_DIR, name))).toBe(false);
  });

  it('no other plugin file still points at a retired skill', () => {
    const offenders = walk(PLUGIN_ROOT)
      .filter((p) => /\.(md|ts|json)$/.test(p) && !p.startsWith(SKILL_ROOT))
      .filter((p) => RETIRED.some((name) => new RegExp(`\\b${name}\\b`).test(read(p))));
    expect(offenders).toEqual([]);
  });

  it('SKILL.md stays lean — detail lives in references', () => {
    expect(Buffer.byteLength(read(SKILL_MD))).toBeLessThanOrEqual(10_240);
    for (const ref of ['plain-language.md', 'structure-engine.md', 'renderers.md']) {
      expect(read(SKILL_MD)).toContain(`references/${ref}`);
    }
  });
});

describe('local:using-zwriting — layered explanation (T2)', () => {
  const md = () => read(SKILL_MD);

  it('always a ladder of at least 2 rungs, top first', () => {
    expect(md()).toMatch(/Always a ladder, never one flat layer\. At least 2 rungs/);
    expect(md()).toMatch(/Top first/);
    expect(md()).toMatch(/Nothing is exempt for looking easy/);
  });

  it('each rung closes in its own words and is true at its depth', () => {
    expect(md()).toMatch(/Each rung closes in its own words/);
    expect(md()).toMatch(/Every rung is true at its depth/);
  });

  it('nothing lost, nothing added, nothing said twice', () => {
    expect(md()).toMatch(/Nothing is lost/);
    expect(md()).toMatch(/Nothing is added/);
    expect(md()).toMatch(/Say each fact in full once/);
    expect(md()).toMatch(/within about 1\.2 times the length of its source/);
  });

  it('keeps the planning-artifact layer rule (epic → issue → PR) the callers rely on', () => {
    expect(md()).toMatch(/## Planning artifacts: one artifact, one rung/);
    expect(md()).toMatch(/no file paths, function names, environment variables or code blocks/);
  });

  it('keeps the calldiff-first rule for PR bodies and the 2 closed exceptions', () => {
    expect(md()).toMatch(/calldiff block keeps the first position/);
    expect(md()).toMatch(/do not invent a third case/);
  });
});

describe('local:using-zwriting — research fixes (T3)', () => {
  it('times use a colon, never a dot', () => {
    const plain = read(PLAIN_MD);
    expect(plain).toMatch(/10am to 11:30am/);
    expect(plain).toMatch(/never a dot/);
    expect(plain).not.toMatch(/11\.30am"?\)?;/);
  });

  it('a number that starts a sentence is written out', () => {
    expect(read(PLAIN_MD)).toMatch(/A number that starts a sentence is written out/);
  });

  it('gaps in the source stay visible and no fact is added', () => {
    const md = read(SKILL_MD);
    expect(md).toMatch(/Do not guess at gaps/);
    expect(md).toMatch(/For the writer — not stated in the source/);
    expect(md).toMatch(/작성자 확인 — 원문에 없음/);
    expect(md).toMatch(/add no remarks about the source/);
    expect(md).toMatch(/No fact that is not in the source/);
  });

  it('substance wins over plainness; terms explained at first use; key facts repeated for skimmers', () => {
    const md = read(SKILL_MD);
    expect(md).toMatch(/Substance wins over plainness/);
    expect(md).toMatch(/Explain a necessary term or acronym the first time it appears/);
    expect(md).toMatch(/Repeat a key date, amount or deadline/);
  });

  it('links use the destination page title; plain-language rules cover Korean too', () => {
    const plain = read(PLAIN_MD);
    expect(plain).toMatch(/destination page's own title/);
    expect(plain).toMatch(/## Korean/);
  });
});

describe('local:using-zwriting — structure engine (T4)', () => {
  it('carries the 7-stage lossless engine and its failure checklist', () => {
    const md = read(ENGINE_MD);
    for (const heading of [
      /### 0\. 진단/,
      /### 1\. 분해/,
      /### 2\. 핵-위성 판정/,
      /### 3\. 관계 부여/,
      /### 4\. 계층 조립/,
      /### 5\. 암묵 구조 승격/,
      /### 6\. 무손실 검증/,
    ]) {
      expect(md).toMatch(heading);
    }
    expect(md).toMatch(/역방향[^\n]*금지/);
    expect(md).toMatch(/## 실패 모드 체크리스트/);
  });

  it('renderers cover the four non-default formats', () => {
    const md = read(RENDERERS_MD);
    expect(md).toMatch(/<details/);
    expect(md).toMatch(/flowchart TD/);
    expect(md).toMatch(/graph LR/);
    expect(md).toMatch(/갈리는 조건/);
  });
});
