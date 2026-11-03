import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #836 C2/C4 (kept in zworkflow by #857) — Hook 4 closes leftovers; the card check itself moved to the soma-work
 * harness skill (`local:auto-es` §Card check), so Hook 4 only points to it.
 */

const ssot = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
const hook4 = ssot.slice(ssot.indexOf('### Hook 4'), ssot.indexOf('## Output format'));

describe('Hook 4 leftovers', () => {
  it('names worktrees, running agents and background jobs', () => {
    for (const token of ['worktree', 'agent', 'background']) expect(hook4.toLowerCase(), token).toContain(token);
  });

  it('only a clean checkout whose commits are pushed or merged is removed; the rest is handed off', () => {
    expect(hook4).toMatch(/깨끗하고[^\n]*원격에 올라갔거나 머지된 것만 지운다/);
    expect(hook4).toMatch(/지우지 않고[^\n]*보고에 적어 넘긴다/);
  });
});

describe('Hook 4 card check — a pointer, portable', () => {
  it('runs the harness card check only where a task card exists', () => {
    expect(hook4).toContain('`local:auto-es` §Card check');
    expect(hook4).toMatch(/작업 카드가 없는 환경에서는 건너뛴다/);
  });
});
