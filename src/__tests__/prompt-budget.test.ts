/**
 * #931 (epic #935) — the fixed text sent with every turn has a size budget.
 *
 * The system prompt of each workflow, the one-off prompts (dispatch classifier, goal evaluation, restart resume)
 * and the skill and agent descriptions the SDK lists on every turn go to the model with every turn of every session.
 * A rule added one line at a time raises that cost unnoticed. Each part has a budget here (measured size + about
 * 10%, in characters). A change that goes over fails and names the parts that are largest; raising a budget is an
 * edit to the numbers below, made in the same PR on purpose.
 *
 * Measured without the host's `.system.prompt` (not in the repo) and without a user (persona, memory and personal
 * skills are per user, not fixed). Source: dsh-superagent tests/model-surface.spec.ts (docs/007-architecture.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  SYSTEM_PROMPT_FILE: '/nonexistent/soma-work-prompt-budget/.system.prompt',
}));

import { PromptBuilder } from '../prompt-builder';
import type { WorkflowType } from '../types';

const SRC = path.join(__dirname, '..');
const PROMPT_DIR = path.join(SRC, 'prompt');
const WORKFLOWS_DIR = path.join(PROMPT_DIR, 'workflows');

/** System prompt per workflow: 'default' plus every src/prompt/workflows/*.prompt. */
const WORKFLOW_BUDGET: Record<string, number> = {
  // 2026-11-06: + 'Before Refusing or Narrowing an Instruction' (verify the premise of a refusal; incident in the section).
  default: 11_400,
  deploy: 30_900,
  'jira-brainstorming': 8_000,
  'jira-create-pr': 9_900,
  'jira-executive-summary': 6_500,
  'jira-planning': 6_900,
  onboarding: 12_400,
  'pr-docs-confluence': 10_400,
  'pr-fix-and-update': 14_200,
  'pr-review': 28_900,
  'z-epic-update': 6_300,
  'z-plan-to-work': 7_000,
  zwork: 5_200,
};

/** Prompts sent whole on their own call: the dispatch classifier, goal evaluation, the restart resume turn. */
const ONE_OFF_BUDGET: Record<string, number> = {
  'dispatch.prompt': 5_800,
  'goal-eval.prompt': 2_500,
  'restart.prompt': 1_850,
};

/** Descriptions the SDK lists on every turn: skills (zworkflow + harness plugins) and commands; subagents. */
const LISTING_BUDGET = {
  skills: { total: 28_200, each: 1_400 },
  agents: { total: 11_400, each: 2_200 },
};

/**
 * Characters (UTF-16 units), not tokens: a proxy. Korean costs more tokens per character than English, so a Korean
 * line uses more of a budget's real cost than its character count shows (#931 review, fable).
 */
const chars = (text: string): number => text.length;

/** What makes up a prompt file: its own text and each `{{include:…}}` (resolved from src/prompt, like PromptBuilder). */
function partsOf(file: string): Array<{ part: string; chars: number }> {
  const raw = fs.readFileSync(file, 'utf-8');
  const parts: Array<{ part: string; chars: number }> = [];
  const own = raw.replace(/\{\{include:([^}]+)\}\}/g, (_m, name: string) => {
    const included = path.resolve(PROMPT_DIR, name.trim());
    if (fs.existsSync(included)) parts.push(...partsOf(included));
    return '';
  });
  parts.unshift({ part: path.relative(SRC, file), chars: chars(own) });
  return parts;
}

/** Every part, largest first — the one that grew is in the list whatever its size (#931 review, astra). */
function largest(parts: Array<{ part: string; chars: number }>, n = Number.POSITIVE_INFINITY): string {
  return [...parts]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, n)
    .map((p) => `  ${String(p.chars).padStart(6)}  ${p.part}`)
    .join('\n');
}

/**
 * The `description` of a markdown file's front matter. The value runs on over every indented or blank line up to the
 * next key, so a `>`/`|` block (blank lines included), a plain scalar and a quoted scalar are all counted whole — a
 * budget must not undercount (#931 review, astra).
 */
function frontmatterDescription(md: string): string | undefined {
  const lines = md.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const m = /^description:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== '---'; j++) {
      if (lines[j].trim() !== '' && !/^\s/.test(lines[j])) break;
      rest.push(lines[j].trim());
    }
    while (rest.length > 0 && rest[rest.length - 1] === '') rest.pop();
    const first = m[1].trim();
    const value = [...(/^[>|][-+]?\d*$/.test(first) ? [] : [first]), ...rest].join(' ').trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        return JSON.parse(value) as string;
      } catch {
        return value.slice(1, -1);
      }
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    return value;
  }
  return undefined;
}

/** A listed file the parser reads no description from has size -1: the budget never silently skips one. */
function listing(files: string[]): Array<{ part: string; chars: number }> {
  return files.map((file) => {
    const description = frontmatterDescription(fs.readFileSync(file, 'utf-8'));
    return { part: path.relative(SRC, file), chars: description === undefined ? -1 : chars(description) };
  });
}

const skillFiles = (): string[] => [
  ...['local/skills', 'local-harness/skills'].flatMap((dir) =>
    fs
      .readdirSync(path.join(SRC, dir))
      .map((name) => path.join(SRC, dir, name, 'SKILL.md'))
      .filter((file) => fs.existsSync(file)),
  ),
  ...fs
    .readdirSync(path.join(SRC, 'local/commands'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(SRC, 'local/commands', name)),
];

const agentFiles = (): string[] =>
  fs
    .readdirSync(path.join(SRC, 'local/agents'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(SRC, 'local/agents', name));

describe('per-turn fixed text budget (#931)', () => {
  const workflows = [
    'default',
    ...fs
      .readdirSync(WORKFLOWS_DIR)
      .filter((name) => name.endsWith('.prompt'))
      .map((name) => name.replace(/\.prompt$/, '')),
  ];

  it('every workflow has a budget, and every budget names a workflow that exists', () => {
    expect(workflows.filter((w) => !(w in WORKFLOW_BUDGET))).toEqual([]);
    expect(Object.keys(WORKFLOW_BUDGET).filter((w) => !workflows.includes(w))).toEqual([]);
  });

  it.each(workflows)('workflow %s stays within its system prompt budget', (workflow) => {
    const prompt = new PromptBuilder().loadWorkflowPrompt(workflow as WorkflowType) ?? '';
    const budget = WORKFLOW_BUDGET[workflow] ?? 0;
    const file =
      workflow === 'default' ? path.join(PROMPT_DIR, 'default.prompt') : path.join(WORKFLOWS_DIR, `${workflow}.prompt`);
    expect(
      chars(prompt),
      `workflow '${workflow}' system prompt is ${chars(prompt)} chars, budget ${budget}. Parts, largest first:\n${largest(partsOf(file))}\nCut it, or raise WORKFLOW_BUDGET['${workflow}'] in this test on purpose.`,
    ).toBeLessThanOrEqual(budget);
  });

  it.each(Object.keys(ONE_OFF_BUDGET))('%s stays within its budget', (name) => {
    const size = chars(fs.readFileSync(path.join(PROMPT_DIR, name), 'utf-8'));
    expect(
      size,
      `${name} is ${size} chars, budget ${ONE_OFF_BUDGET[name]}. Raise ONE_OFF_BUDGET on purpose.`,
    ).toBeLessThanOrEqual(ONE_OFF_BUDGET[name]);
  });

  it.each([
    ['skills', skillFiles],
    ['agents', agentFiles],
  ] as const)('%s descriptions stay within the listing budget, in total and each', (group, files) => {
    const parts = listing(files());
    const budget = LISTING_BUDGET[group];
    const total = parts.reduce((sum, p) => sum + p.chars, 0);
    expect(parts.length).toBeGreaterThan(0);
    // A description the parser cannot read would count as 0 — fail instead (#931 review, fable).
    expect(
      parts.filter((p) => p.chars < 0).map((p) => p.part),
      'no description read from these',
    ).toEqual([]);
    expect(
      total,
      `${group} descriptions total ${total} chars, budget ${budget.total}. All, largest first:\n${largest(parts)}\nShorten them, or raise LISTING_BUDGET.${group}.total on purpose.`,
    ).toBeLessThanOrEqual(budget.total);
    const over = parts.filter((p) => p.chars > budget.each);
    expect(
      over,
      `${group} descriptions over ${budget.each} chars each:\n${largest(over)}\nShorten them, or raise LISTING_BUDGET.${group}.each on purpose.`,
    ).toEqual([]);
  });
});

describe('frontmatterDescription', () => {
  it('reads a description that runs over several lines — a block with a blank line, a plain or a quoted scalar (#931 review)', () => {
    expect(frontmatterDescription('---\ndescription: >\n  one\n\n  two\nname: x\n---')).toMatch(/^one\s+two$/);
    expect(frontmatterDescription('---\ndescription: first\n  second\nname: x\n---')).toBe('first second');
    expect(frontmatterDescription('---\ndescription: "a\n  b"\n---')).toBe('a b');
    const long = 'x'.repeat(3000);
    expect(frontmatterDescription(`---\ndescription: >\n  short\n\n  ${long}\n---`)?.length).toBeGreaterThan(3000);
  });

  it('reads plain, quoted and block descriptions', () => {
    expect(frontmatterDescription('---\nname: a\ndescription: plain text\n---\nbody')).toBe('plain text');
    expect(frontmatterDescription('---\ndescription: "say \\"hi\\""\n---')).toBe('say "hi"');
    expect(frontmatterDescription("---\ndescription: 'it''s'\n---")).toBe("it's");
    expect(frontmatterDescription('---\ndescription: >\n  one\n  two\nname: x\n---')).toBe('one two');
    expect(frontmatterDescription('no front matter')).toBeUndefined();
  });
});
