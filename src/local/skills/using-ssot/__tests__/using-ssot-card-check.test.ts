import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDefaultSessionSnapshot, runModelCommand } from 'somalib/model-commands/catalog';
import type { SessionResourceSnapshot } from 'somalib/model-commands/session-types';
import { validateModelCommandRunArgs } from 'somalib/model-commands/validator';
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
 *  - C4: the re-read is not the host's receipt; a repair restores the active links; leftovers are removed only when
 *        safe; and the taught calls round-trip through the real validator and reducer.
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

  it('the add object is the one es sends, field for field (only the example label differs)', () => {
    const esAdd = es.match(/\{ action: "add", resourceType: [^\n]*?status \} \}/)?.[0];
    expect(esAdd).toBeDefined();
    expect(hook4).toContain((esAdd ?? '').replace(/label: "[^"]*"/, 'label'));
  });

  it('re-reads the card, knows a host-side rejection, writes one line, and keeps the report open on a gap', () => {
    expect(hook4).toMatch(/`GET_SESSION`을 다시 읽어 확인/);
    // GET_SESSION answers from the model-command copy: a write the host refused is visible only in the thread.
    expect(hook4).toContain('⚠️ Session update could not be applied on host');
    expect(hook4).toMatch(/빠진 것으로 센다/);
    expect(hook4).toContain('Card check: <카드에 있는 수>/<보고의 산출물 수> on the card');
    expect(hook4).toMatch(/보고를 완료로 닫지 않는다/);
  });
});

describe('C2 — Hook 4 leftovers', () => {
  it('names worktrees, running agents and background jobs', () => {
    for (const token of ['worktree', 'agent', 'background']) expect(hook4.toLowerCase(), token).toContain(token);
  });
});

describe('C4 — review round 3 (astra-zhuge, fable-zhuge)', () => {
  it('the re-read is not the host’s receipt; a host-side rejection counts the link missing (astra P1)', () => {
    expect(hook4).toMatch(/호스트의 수락 증거가 아니다/);
    expect(hook4).toContain('⚠️ Session update could not be applied on host');
    expect(hook4).toMatch(/빠진 것으로 센다/);
  });

  it('a repair keeps the card’s active links: each added kind is set back, an empty one cleared (astra P2)', () => {
    expect(hook4).toMatch(/`active`를 기억/);
    expect(hook4).toContain('{ action: "set_active", resourceType }');
    expect(hook4).toMatch(/처음 읽은 `active`로 되돌린다/);
    // set_active compares raw strings: the url is GET_SESSION's own string (fable P2).
    expect(hook4).toMatch(/`GET_SESSION`이 돌려준 문자열 그대로/);
  });

  it('leftovers: only a clean checkout whose commits are pushed or merged is removed; the rest is handed off (astra P1)', () => {
    expect(hook4).toMatch(/깨끗하고[^\n]*원격에 올라갔거나 머지된 것만 지운다/);
    expect(hook4).toMatch(/지우지 않고[^\n]*보고에 적어 넘긴다/);
  });

  it('epic-neutral, and es Path A already covers it — not twice (fable P3)', () => {
    expect(hook4).not.toMatch(/턴 끝 GitHub 대조/);
    expect(hook4).toMatch(/두 번 하지 않는다/);
  });

  it('the taught calls round-trip through the real validator and reducer (fable P2)', () => {
    const P = 'https://github.com/o/r/pull/1';
    const A = 'https://github.com/o/r/issues/2';
    const B = 'https://github.com/o/r/issues/3';
    const link = (url: string, type: 'pr' | 'issue') => ({
      url,
      type,
      provider: 'github',
      label: '#x',
      title: 't',
      status: 'open',
    });
    const run = (session: SessionResourceSnapshot, operations: unknown[]) => {
      const args = { commandId: 'UPDATE_SESSION', params: { operations } };
      const v = validateModelCommandRunArgs(args);
      expect(v.ok).toBe(true);
      if (!v.ok) throw new Error(v.error.message);
      const res = runModelCommand(v.request, { session });
      expect(res.ok).toBe(true);
      return (res as { payload: { session: SessionResourceSnapshot } }).payload.session;
    };
    // The card: PR P and issue A, both active.
    let s = run(getDefaultSessionSnapshot(), [
      { action: 'add', resourceType: 'pr', link: link(P, 'pr') },
      { action: 'add', resourceType: 'issue', link: link(A, 'issue') },
    ]);
    // The repair Hook 4 teaches: add the missing issue B, then set the issue kind back to A.
    s = run(s, [
      { action: 'add', resourceType: 'issue', link: link(B, 'issue') },
      { action: 'set_active', resourceType: 'issue', url: A },
    ]);
    expect(s.active.issue?.url).toBe(A);
    expect(s.active.pr?.url).toBe(P);
    expect(s.issues.map((l) => l.url)).toEqual([A, B]);
    // A repeat add is one entry; clearing a kind that started empty leaves it empty.
    s = run(s, [
      { action: 'add', resourceType: 'issue', link: link(B, 'issue') },
      { action: 'add', resourceType: 'doc', link: { ...link('https://example.com/d', 'issue'), type: 'doc' } },
      { action: 'set_active', resourceType: 'issue', url: A },
      { action: 'set_active', resourceType: 'doc' },
    ]);
    expect(s.issues).toHaveLength(2);
    expect(s.active.doc).toBeUndefined();
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
