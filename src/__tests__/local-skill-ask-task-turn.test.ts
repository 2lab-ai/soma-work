/**
 * E2 ⑨ dev run (#661) — a dashboard task turn has no `mcp__model-command__run`
 * (a task turn carries no Slack context, so McpConfigBuilder adds no model-command
 * server). It asks by writing a fenced ```json `user_choice` block in its reply,
 * which the stream registers as the card's question (onQuestionAsked). On dev the
 * model tried the skill's MCP call, gave up, and asked in plain text — which the
 * thread got as a result notice, not an "input needed" one. The skill must say so.
 *
 *   A1 the skill names the task-turn case and the fenced form.
 *   A2 the skill's task-turn example parses with the real extractor as a user_choice.
 *   A3 it says not to fall back to plain text.
 */
import * as fs from 'fs';
import * as path from 'path';
import { UserChoiceExtractor } from '@soma/slack/user-choice-extractor';
import { describe, expect, it } from 'vitest';

const SKILL = fs.readFileSync(path.join(__dirname, '..', 'local', 'skills', 'UIAskUserQuestion', 'SKILL.md'), 'utf-8');
const section = (() => {
  const start = SKILL.indexOf('## Dashboard task turns');
  if (start < 0) return '';
  const next = SKILL.indexOf('\n## ', start + 1);
  return SKILL.slice(start, next < 0 ? undefined : next);
})();

describe('UIAskUserQuestion — dashboard task turns (#661)', () => {
  it('A1 names the task-turn case: no mcp__model-command__run, ask with a fenced json block', () => {
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
    expect(choice?.choices.map((c) => c.id)).toEqual(['1', '2']);
    expect(choice?.question).toBeTruthy();
  });

  it('A3 says the question must not be plain text (a plain-text ask reaches the thread as a result)', () => {
    expect(section).toMatch(/plain text/i);
    expect(section).toMatch(/end (your|the) turn/i);
  });
});
