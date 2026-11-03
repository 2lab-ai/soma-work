import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #836 (epic #831, L3) — the closing contract: before a final report, the model checks that every PR, issue and
 * document it names is on the session's task card. The last line after the host's own capture (#832, #833).
 *
 *  - C1: using-ssot Hook 4 has a required card check — GET_SESSION, compare the report's artifacts with the recorded
 *        links (by URL, repeats once), add a missing one with es's exact UPDATE_SESSION shape plus set_active,
 *        re-check, say it in one line, and keep the report open on a gap.
 *  - C2: Hook 4 closes leftovers — worktrees, running agents and background jobs are cleaned up or handed off.
 *  - C3: the common prompt (every workflow, every turn) states the rule once and briefly: what you create, merge or
 *        close belongs on the card; the check is Hook 4's; full URLs, not short refs.
 */

const ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const ssot = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
const common = readFileSync(resolve(ROOT, 'src', 'prompt', 'common.prompt'), 'utf8');
const es = readFileSync(resolve(__dirname, '..', '..', 'es', 'SKILL.md'), 'utf8');
const hook4 = ssot.slice(ssot.indexOf('### Hook 4'), ssot.indexOf('## Output format'));

describe('C1 — Hook 4 card check', () => {
  it('is a required step that reads the card, compares artifacts by URL, fixes a gap, re-checks and says it', () => {
    expect(hook4).toMatch(/Card check \(required\)/);
    expect(hook4).toContain('`local:es` §Card sync');
    expect(hook4).toMatch(/`GET_SESSION`[^\n]*payload\.session[^\n]*`issues` · `prs` · `docs`/);
    expect(hook4).toMatch(/URL로 대조/);
    expect(hook4).toMatch(/같은 링크는 한 번만/);
    expect(hook4).toMatch(/카드가 바뀌었는지가 아니라/);
  });

  it('teaches the exact UPDATE_SESSION shape es ships, with set_active after add', () => {
    expect(hook4).toContain(
      '{ action: "add", resourceType: "issue" | "pr" | "doc", link: { url, type, provider, label, title, status } }',
    );
    expect(hook4).toContain('{ action: "set_active", resourceType, url }');
    // Same shape as es — never a shorthand such as `operations: add`.
    expect(hook4).not.toMatch(/operations: add/);
    expect(es).toContain('{ action: "set_active", resourceType, url }');
  });

  it('re-reads the card, writes one line, and keeps the report open on a gap', () => {
    expect(hook4).toMatch(/`GET_SESSION`을 다시 읽어 확인/);
    expect(hook4).toContain('Card check: <카드에 있는 수>/<보고의 산출물 수> on the card');
    expect(hook4).toMatch(/보고를 완료로 닫지 않는다/);
  });
});

describe('C2 — Hook 4 leftovers', () => {
  it('names worktrees, running agents and background jobs', () => {
    for (const token of ['worktree', 'agent', 'background']) expect(hook4.toLowerCase(), token).toContain(token);
  });
});

describe('C3 — the common prompt states the card rule once, briefly', () => {
  it('create, merge or close → on the card; the check lives in Hook 4; full URLs', () => {
    const section = common.slice(common.indexOf('## Task card'), common.indexOf('## Slack Output Formatting'));
    expect(common.split('## Task card').length).toBe(2);
    expect(section).toContain('create, merge or close');
    expect(section).toContain('`local:using-ssot` Hook 4');
    expect(section).toContain('full URL');
    // Every turn carries it: the recipe stays in the skill, the common prompt stays short.
    expect(section).not.toContain('operations');
    expect(section.length).toBeLessThan(400);
  });
});
