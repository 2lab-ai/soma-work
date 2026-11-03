import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #836 (epic #831, L3) — the closing contract: before a final report, the model checks that every PR, issue and
 * document it names is on the session's task card. The last line after the host's own capture (#832, #833).
 *
 *  - C1: using-ssot Hook 4 has a required card check — GET_SESSION, compare the report's artifacts with the recorded
 *        links (by URL, repeats once), add a missing one with UPDATE_SESSION, re-check, and say it in one line.
 *  - C2: Hook 4 closes leftovers — worktrees, running agents and background jobs are cleaned up or handed off.
 *  - C3: the common prompt (every workflow) states the rule once: what you create, merge or close belongs on the card;
 *        full URLs, not short refs.
 */

const ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const ssot = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
const common = readFileSync(resolve(ROOT, 'src', 'prompt', 'common.prompt'), 'utf8');
const hook4 = ssot.slice(ssot.indexOf('### Hook 4'), ssot.indexOf('## Output format'));

describe('C1 — Hook 4 card check', () => {
  it('is a required step that reads the card, compares artifacts, fixes a gap and re-checks', () => {
    expect(hook4).toMatch(/Card check \(required\)/);
    for (const token of ['GET_SESSION', 'UPDATE_SESSION', 'issues', 'prs', 'docs'])
      expect(hook4, token).toContain(token);
    expect(hook4).toMatch(/URL/);
    expect(hook4).toMatch(/Card check: \d+\/\d+|Card check: N\/N/);
  });
});

describe('C2 — Hook 4 leftovers', () => {
  it('names worktrees, running agents and background jobs', () => {
    for (const token of ['worktree', 'agent', 'background']) expect(hook4.toLowerCase(), token).toContain(token);
  });
});

describe('C3 — the common prompt states the card rule once', () => {
  it('create, merge or close → on the card; check with GET_SESSION; full URLs', () => {
    const section = common.slice(common.indexOf('## Task card'));
    expect(section.length).toBeGreaterThan(0);
    expect(section.indexOf('## Task card')).toBe(0);
    for (const token of ['create', 'merge', 'close', 'GET_SESSION', 'UPDATE_SESSION', 'full URL']) {
      expect(section, token).toContain(token);
    }
    expect(common.split('## Task card').length).toBe(2);
  });
});
