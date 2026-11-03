import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDefaultSessionSnapshot, runModelCommand } from 'somalib/model-commands/catalog';
import type { SessionResourceSnapshot } from 'somalib/model-commands/session-types';
import { validateModelCommandRunArgs } from 'somalib/model-commands/validator';
import { describe, expect, it } from 'vitest';

/**
 * #836 (epic #831, L3) — the closing contract, moved by #857 from zworkflow's using-ssot Hook 4 to the harness skill
 * `local:auto-es` §Card check: it calls the session task card through the model-command MCP, which only soma-work has.
 *
 *  - C1: a required card check — GET_SESSION, compare the report's artifacts with the recorded links (by URL, repeats
 *        once), add a missing one with the exact UPDATE_SESSION shape §Card sync sends plus set_active, re-check, say
 *        it in one line, and keep the report open on a gap.
 *  - C3: the common prompt (every workflow, every turn) states the rule once and briefly, and routes every
 *        Executive Summary to `local:auto-es`.
 *  - C4: the re-read is not the host's receipt; a repair restores the active links; and the taught calls round-trip
 *        through the real validator and reducer.
 */

const ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const skill = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
const common = readFileSync(resolve(ROOT, 'src', 'prompt', 'common.prompt'), 'utf8');
const defaultPrompt = readFileSync(resolve(ROOT, 'src', 'prompt', 'default.prompt'), 'utf8');
const part = (title: string) => {
  const at = skill.indexOf(`## ${title}`);
  const next = skill.indexOf('\n## ', at + 3);
  return at < 0 ? '' : skill.slice(at, next < 0 ? undefined : next);
};
const check = part('Card check');
const sync = part('Card sync');

describe('C1 — the card check', () => {
  it('is required: reads the card, compares artifacts by URL, fixes a gap, re-checks and says it', () => {
    expect(check).toMatch(/required/i);
    expect(check).toMatch(/`GET_SESSION`[^\n]*payload\.session[^\n]*`issues` · `prs` · `docs`/);
    expect(check).toMatch(/URL로 대조/);
    expect(check).toMatch(/같은 링크는 한 번만/);
    expect(check).toMatch(/카드가 바뀌었는지가 아니라/);
  });

  it('teaches the exact UPDATE_SESSION shape §Card sync sends, with set_active after add', () => {
    expect(check).toContain(
      '{ action: "add", resourceType: "issue" | "pr" | "doc", link: { url, type, provider, label, title, status } }',
    );
    expect(check).toContain('{ action: "set_active", resourceType, url }');
    expect(check).not.toMatch(/operations: add/);
    expect(sync).toContain('{ action: "set_active", resourceType, url }');
    const syncAdd = sync.match(/\{ action: "add", resourceType: [^\n]*?status \} \}/)?.[0];
    expect(syncAdd).toBeDefined();
    expect(check).toContain((syncAdd ?? '').replace(/label: "[^"]*"/, 'label'));
  });

  it('re-reads the card, knows a host-side rejection, writes one line, and keeps the report open on a gap', () => {
    expect(check).toMatch(/`GET_SESSION`을 다시 읽어 확인/);
    expect(check).toContain('⚠️ Session update could not be applied on host');
    expect(check).toMatch(/빠진 것으로 센다/);
    expect(check).toContain('Card check: <카드에 있는 수>/<보고의 산출물 수> on the card');
    expect(check).toMatch(/보고를 완료로 닫지 않는다/);
  });

  it('the card sync of the same turn already is the check — not twice', () => {
    expect(check).toMatch(/두 번 하지 않는다/);
  });
});

describe('C4 — review round 3 (#836: astra-zhuge, fable-zhuge)', () => {
  it('the re-read is not the host’s receipt; a repair keeps the card’s active links', () => {
    expect(check).toMatch(/호스트의 수락 증거가 아니다/);
    expect(check).toMatch(/`active`를 기억/);
    expect(check).toContain('{ action: "set_active", resourceType }');
    expect(check).toMatch(/처음 읽은 `active`로 되돌린다/);
    expect(check).toMatch(/`GET_SESSION`이 돌려준 문자열 그대로/);
  });

  it('the taught calls round-trip through the real validator and reducer', () => {
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
      const v = validateModelCommandRunArgs({ commandId: 'UPDATE_SESSION', params: { operations } });
      expect(v.ok).toBe(true);
      if (!v.ok) throw new Error(v.error.message);
      const res = runModelCommand(v.request, { session });
      expect(res.ok).toBe(true);
      return (res as { payload: { session: SessionResourceSnapshot } }).payload.session;
    };
    let s = run(getDefaultSessionSnapshot(), [
      { action: 'add', resourceType: 'pr', link: link(P, 'pr') },
      { action: 'add', resourceType: 'issue', link: link(A, 'issue') },
    ]);
    s = run(s, [
      { action: 'add', resourceType: 'issue', link: link(B, 'issue') },
      { action: 'set_active', resourceType: 'issue', url: A },
    ]);
    expect(s.active.issue?.url).toBe(A);
    expect(s.active.pr?.url).toBe(P);
    expect(s.issues.map((l) => l.url)).toEqual([A, B]);
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

describe('C3 — the harness prompts route to local:auto-es', () => {
  it('common prompt: create, merge or close → on the card; the check is auto-es’s; full URLs; short', () => {
    const section = common.slice(common.indexOf('## Task card'), common.indexOf('## Slack Output Formatting'));
    expect(common.split('## Task card').length).toBe(2);
    expect(section).toContain('create, merge or close');
    expect(section).toContain('`local:auto-es` §Card check');
    expect(section).toContain('full URL');
    expect(section).not.toContain('operations');
    expect(section.length).toBeLessThan(700);
  });

  it('common prompt: every Executive Summary request runs local:auto-es instead of es', () => {
    const section = common.slice(common.indexOf('## Task card'), common.indexOf('## Slack Output Formatting'));
    expect(section).toMatch(/Executive Summary/);
    expect(section).toMatch(/`local:auto-es`[^\n]*instead of|instead of[^\n]*`local:auto-es`/);
    expect(section).toMatch(/`es`|`local:es`|`zworkflow:es`/);
  });

  it('default prompt names local:auto-es for the terminal report', () => {
    expect(defaultPrompt).toContain('`local:auto-es`');
    expect(defaultPrompt).not.toMatch(/`local:es` renders/);
  });
});
