/**
 * #661 — a turn without `mcp__model-command__run` asks by writing a fenced ```json
 * `user_choice` block in its reply, which the stream reads as the thread's question. On dev
 * the model tried the skill's MCP call, gave up, and asked in plain text. The skill must say
 * so. (#855: the dashboard task turn this was written for is gone; the fallback stays.)
 *
 *   A1 the skill names the missing-tool case and the fenced form.
 *   A2 its example parses with the real extractor as a user_choice.
 *   A3 it says not to fall back to plain text.
 *   A4 its several-decisions example is a user_choice_group: the extractor numbers the
 *      questions (q1, q2) (a hand-written user_choices without ids would not — fable #763 P1).
 */

import { UserChoiceExtractor } from '@soma/slack/user-choice-extractor';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const SKILL = fs.readFileSync(path.join(__dirname, '..', 'local', 'skills', 'UIAskUserQuestion', 'SKILL.md'), 'utf-8');
const section = (() => {
  const start = SKILL.indexOf('## When `mcp__model-command__run` is missing');
  if (start < 0) return '';
  const next = SKILL.indexOf('\n## ', start + 1);
  return SKILL.slice(start, next < 0 ? undefined : next);
})();

describe('UIAskUserQuestion — no mcp__model-command__run (#661)', () => {
  it('A1 names the missing-tool case: no mcp__model-command__run, ask with a fenced json block', () => {
    expect(section).not.toBe('');
    expect(section).toContain('mcp__model-command__run');
    expect(section).toMatch(/```json/);
    expect(section).toContain('"type": "user_choice"');
  });

  it('A2 its example parses with the real extractor as one user_choice with the same choices', () => {
    const fence = /```json\s*\n([\s\S]*?)\n```/.exec(section);
    expect(fence).not.toBeNull();
    const reply = `I need one decision before I write the file.\n\n${fence?.[0]}`;
    const { choice, choices } = UserChoiceExtractor.extractUserChoice(reply);
    expect(choices).toBeNull();
    expect(choice?.type).toBe('user_choice');
    expect(choice?.choices.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(choice?.question).toBeTruthy();
    expect(choice?.recommendedChoiceId).toBe('1');
  });

  it('A3 says the question must not be plain text (a plain-text ask reaches the thread as a result)', () => {
    expect(section).toMatch(/plain text/i);
    expect(section).toMatch(/end (your|the) turn/i);
  });

  it('A4 several decisions: a user_choice_group numbered per question, never a bare user_choices', () => {
    const fences = [...section.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    expect(fences.length).toBe(2);
    const { choice, choices } = UserChoiceExtractor.extractUserChoice(`Two things first.\n\n${fences[1][0]}`);
    expect(choice).toBeNull();
    expect(choices?.type).toBe('user_choices');
    expect(choices?.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    // #917 — the recommended option is the first of each question.
    expect(choices?.questions.map((q) => q.recommendedChoiceId)).toEqual(['1', '1']);
    expect(section).toContain('Do not hand-write `user_choices`');
  });
});
