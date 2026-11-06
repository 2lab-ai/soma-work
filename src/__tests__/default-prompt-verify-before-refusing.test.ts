/**
 * default.prompt opens with a metacognition rule: a refusal of a user instruction must rest on a checked fact,
 * not on a premise the agent assumed (2026-11-06: an agent refused "ask the browser app on my machine to create it" twice,
 * assuming the app was an autonomous AI agent; one check showed a browser the user works in).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const DEFAULT_PROMPT = path.join(__dirname, '..', 'prompt', 'default.prompt');
const HEADING = '## Before Refusing or Narrowing an Instruction';

function sectionAfterTitle(md: string): { firstHeading: string; body: string } {
  const lines = md.split('\n');
  const title = lines.findIndex((line) => line.trim() === '# Default Workflow');
  const first = lines.findIndex((line, i) => i > title && line.startsWith('## '));
  const next = lines.findIndex((line, i) => i > first && line.startsWith('## '));
  return {
    firstHeading: first === -1 ? '' : lines[first].trim(),
    body: lines.slice(first, next === -1 ? undefined : next).join('\n'),
  };
}

describe('default.prompt: verify the premise before refusing an instruction', () => {
  const md = fs.readFileSync(DEFAULT_PROMPT, 'utf-8');
  const { firstHeading, body } = sectionAfterTitle(md);

  it('is the first section of the default workflow', () => {
    expect(firstHeading).toBe(HEADING);
  });

  it('requires the premise of a refusal to be checked now, and forbids presenting a guess as a fact', () => {
    expect(body).toMatch(/verified fact, not a belief/);
    expect(body).toMatch(/check it now/i);
    expect(body).toMatch(/do not present it as a fact/i);
  });

  it('scopes an observed block to exactly what it stopped', () => {
    expect(body).toMatch(/covers exactly the action it stopped/);
  });

  it('makes delivering a request to the recipient the user names the agent’s job, whoever the recipient is', () => {
    expect(body).toMatch(/recipient the user names/);
    expect(body).toMatch(/human or an AI/);
  });
});
