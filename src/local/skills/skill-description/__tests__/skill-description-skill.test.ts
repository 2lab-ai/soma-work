import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script shipped with the skill, no type declarations
import { checkDescription, describedFiles, readDescription, sentences } from '../scripts/check-descriptions.mjs';

/**
 * Contract for local:skill-description and the plugin-wide rule it enforces.
 *
 * SSOT: "스킬 디스크립션 개선하는 스킬 만들고 적용해줘. 스킬 디스크립션에는 언제 사용하는지만 작성해주고
 *        뭘어떻게 하는지는 모두 뺴줘. 이거 모델이 병신처럼 행동하는 원인이랑 토큰 낭비되는 이유임."
 *
 *  - T1 the skill: when-only rule, format, the move-rules-to-the-body step, the checker it ships.
 *  - T2 the checker: accepts a when-only description, rejects what/how content.
 *  - T3 applied: every skill, command and agent description in zworkflow and the soma-work harness
 *        plugin passes the checker (the gate that keeps them when-only).
 */

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const CHECKER = resolve(SKILL_ROOT, 'scripts', 'check-descriptions.mjs');
const ZWORKFLOW = resolve(SKILL_ROOT, '..', '..');
const HARNESS = resolve(ZWORKFLOW, '..', 'local-harness');

describe('local:skill-description — the skill (T1)', () => {
  const md = () => readFileSync(SKILL_MD, 'utf8');

  it('ships with a when-only description of its own', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    expect(md()).toMatch(/^---\nname: skill-description\n/);
    expect(checkDescription(readDescription(md()))).toEqual([]);
  });

  it('states the rule, the format and why', () => {
    expect(md()).toMatch(/a description says when, never what or how/);
    expect(md()).toMatch(/Every sentence starts with `Use when`, `Also when`, `Triggers:` or `Not for`/);
    expect(md()).toMatch(/gets followed instead of the workflow/);
    expect(md()).toMatch(/push other skills' descriptions out of the listing/);
  });

  it('never loses a rule: it moves arguments and constraints into the body first', () => {
    expect(md()).toMatch(/moves into the body first/);
    expect(md()).toMatch(/a rule is never lost in the rewrite/);
  });

  it('carries the soma-work user-skill quote caveat', () => {
    expect(md()).toMatch(/no quote characters at all/);
  });
});

describe('check-descriptions.mjs (T2)', () => {
  it('accepts a when-only description', () => {
    expect(
      checkDescription(
        "Use when a UI must be tested against worst-case data. Triggers: 'break the ui', 'UI 깨뜨려'. Not for code review (review-pr).",
      ),
    ).toEqual([]);
  });

  it('rejects what/how content, argument lists, flags and arrows', () => {
    expect(checkDescription('Render Slack Block Kit JSON to PNG using Playwright.')).toContain(
      'does not start with "Use when "',
    );
    expect(checkDescription('Use when x. Runs the pipeline end to end.').join('\n')).toMatch(/not a situation/);
    expect(checkDescription('Use when x. Args — <repo>').join('\n')).toMatch(/argument list/);
    expect(checkDescription('Use when x with --dry-run.').join('\n')).toMatch(/flag/);
    expect(checkDescription('Use when a → b.').join('\n')).toMatch(/arrow/);
    expect(checkDescription(`Use when ${'x'.repeat(420)}.`).join('\n')).toMatch(/over 400/);
    expect(checkDescription(null)).toEqual(['no description']);
  });

  it('reads quoted, plain and folded descriptions and splits sentences', () => {
    expect(readDescription('---\nname: a\ndescription: "Use when x."\n---\n')).toBe('Use when x.');
    expect(readDescription('---\ndescription: >\n  Use when x\n  and y.\nname: a\n---\n')).toBe('Use when x and y.');
    expect(sentences("Use when x. Triggers: 'a', 'b'.")).toEqual(['Use when x.', "Triggers: 'a', 'b'."]);
  });

  it('lists only listed files: skills/<name>/SKILL.md, commands, agents — not nested templates', () => {
    const files: string[] = describedFiles(ZWORKFLOW);
    expect(files.some((f) => f.endsWith('/skills/skill-description/SKILL.md'))).toBe(true);
    expect(files.some((f) => f.includes('/commands/'))).toBe(true);
    expect(files.some((f) => f.includes('/agents/'))).toBe(true);
    expect(files.some((f) => f.includes('/templates/'))).toBe(false);
  });
});

describe('applied to every description (T3)', () => {
  it('every zworkflow and harness skill, command and agent description is when-only', () => {
    const violations: string[] = [];
    for (const file of [...describedFiles(ZWORKFLOW), ...describedFiles(HARNESS)] as string[]) {
      for (const v of checkDescription(readDescription(readFileSync(file, 'utf8')))) violations.push(`${file}: ${v}`);
    }
    expect(violations).toEqual([]);
  });

  it('the CLI exits 0 on the plugin', () => {
    expect(() => execFileSync(process.execPath, [CHECKER, ZWORKFLOW, HARNESS], { encoding: 'utf8' })).not.toThrow();
  });
});
