import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #829 — es skill contract: task-card sync, own-artifact status, unfinished-work follow-up.
 *
 * SSOT_1 (Z, 2026-11-03): "이 스킬을 실행하면 자동으로 해당 작업 카드(해당 세션의)를 업데이트해줘. 모델에게
 * mcp로 해당 작업 카드에 데이터 설정하는 걸 제공하고 있음. / 그리고 es가 생성한 이슈, pr, 문서와 해당 이슈 pr의
 * 상태도 출력하는데 자신이 만든 이슈나 pr의 상태가 완료가 아니면 그것에 대해서 완료 할수 없는 이유가 반드시
 * tl;dr에 포함되야 하고 그 내용은 강조해서 맨 밑에 어떻게 그 걸 처리해야하는지 방법을 자세히 기술하도록 개선해줘.
 * / 가능하면 그럴 경우에 작업 카드가 완료가 되면 안되고 유저의 후속 작업을 입력 대기로 표기해여함"
 *
 *  - T1: running es updates this session's task card through UPDATE_SESSION (links + state, TL;DR) and checks it.
 *  - T2: every mode lists the issues, PRs and documents this session created, each with its state.
 *  - T3: an own issue/PR that is not complete puts an emphasized ⚠️ reason line in the TL;DR.
 *  - T4: the document ends with a detailed user follow-up section.
 *  - T5: the ⚠️ line is what keeps the card in NEEDS YOU (waiting for the user's follow-up input).
 */

const ES = resolve(__dirname, '..');
const skill = readFileSync(resolve(ES, 'SKILL.md'), 'utf8');
const template = (mode: string) => readFileSync(resolve(ES, 'reference', 'templates', `${mode}.md`), 'utf8');
const MODES = ['brief', 'issue', 'epic'] as const;

describe('T1 — es syncs the task card through UPDATE_SESSION', () => {
  it('the writing procedure has a card-sync step that reads, writes and re-reads the card', () => {
    const procedure = skill.slice(skill.indexOf('## Writing procedure'));
    expect(procedure).toMatch(/card sync/i);
    expect(procedure).toContain('GET_SESSION');
    expect(procedure).toContain('UPDATE_SESSION');
  });

  it('the card-sync section names every field it writes: links with state, set_active, title and the TL;DR', () => {
    const sync = skill.slice(skill.indexOf('## Card sync'));
    expect(sync.length).toBeGreaterThan(0);
    for (const token of ['operations', 'resourceType', 'status', 'set_active', 'executiveSummary', 'tldr', 'title']) {
      expect(sync, token).toContain(token);
    }
    // Documents are cards' artifacts too (resourceType doc).
    expect(sync).toMatch(/\bdoc\b/);
    // The write is checked: an empty prs/issues list after creating one is an alarm.
    expect(sync).toMatch(/GET_SESSION[\s\S]*verify|verify[\s\S]*GET_SESSION/i);
  });

  it('the host-run path (no tools) gets the card update from the host, not from a tool call', () => {
    const sync = skill.slice(skill.indexOf('## Card sync'));
    expect(sync).toMatch(/Path B/);
    expect(sync).toMatch(/no tool/i);
  });
});

describe('T2 — own issues, PRs and documents with their state', () => {
  it.each(MODES)('%s: Status lists what this session created, documents included, each with a state', (mode) => {
    const md = template(mode);
    expect(md).toMatch(/created this session/i);
    expect(md).toMatch(/document/i);
  });
});

describe('T3 — an unfinished own issue/PR is an emphasized reason in the TL;DR', () => {
  it('SKILL.md defines own artifact, complete states and the ⚠️ TL;DR line', () => {
    const rule = skill.slice(skill.indexOf('## Unfinished own artifacts'));
    expect(rule.length).toBeGreaterThan(0);
    expect(rule).toContain('⚠️');
    expect(rule).toMatch(/Merged/);
    expect(rule).toMatch(/Closed/);
    expect(rule).toMatch(/TL;DR/);
    expect(rule).toMatch(/\*\*/); // the reason is bold
    expect(rule).toMatch(/why it cannot be completed|cannot be completed/i);
  });

  it.each(
    MODES,
  )('%s: the template opens with a TL;DR that carries the ⚠️ line when an own artifact is unfinished', (mode) => {
    const md = template(mode);
    const tldr = md.indexOf('TL;DR');
    const ssot = md.indexOf('### 0. SSOT');
    expect(tldr, 'TL;DR section exists').toBeGreaterThan(-1);
    expect(tldr, 'TL;DR comes before SSOT').toBeLessThan(ssot);
    expect(md).toContain('⚠️');
  });
});

describe('T4 — the document ends with how to handle each unfinished item', () => {
  it.each(MODES)('%s: the last section is the user follow-up, with state, blocker and steps per item', (mode) => {
    const md = template(mode);
    const headings = [...md.matchAll(/^### .+$/gm)].map((m) => m[0]);
    const last = headings[headings.length - 1];
    expect(last).toMatch(/⚠️/);
    expect(last).toMatch(/follow-up/i);
    const section = md.slice(md.lastIndexOf(last));
    for (const field of [/state/i, /why/i, /steps?/i, /who/i, /verif/i]) {
      expect(section, String(field)).toMatch(field);
    }
  });
});

describe('T5 — the ⚠️ line keeps the card waiting for the user', () => {
  it('SKILL.md says the card goes to NEEDS YOU on a ⚠️ line and leaves it when the next ES has none', () => {
    const rule = skill.slice(skill.indexOf('## Unfinished own artifacts'));
    expect(rule).toMatch(/NEEDS YOU/);
    expect(rule).toMatch(/next (ES|Executive Summary)/i);
  });
});
