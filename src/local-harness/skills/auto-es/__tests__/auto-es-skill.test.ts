import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #857 (drift of #829) — `local:auto-es`: es + the soma-work harness.
 *
 * SSOT_1 (Z, 2026-11-03): "이 스킬을 실행하면 자동으로 해당 작업 카드(해당 세션의)를 업데이트해줘 … 자신이 만든
 * 이슈나 pr의 상태가 완료가 아니면 그것에 대해서 완료 할수 없는 이유가 반드시 tl;dr에 포함되야 하고 그 내용은
 * 강조해서 맨 밑에 어떻게 그 걸 처리해야하는지 방법을 자세히 기술 … 작업 카드가 완료가 되면 안되고 유저의
 * 후속 작업을 입력 대기로 표기"
 * SSOT_2 (Z, 2026-11-03): "zworkflow:es는 그대로 두고 local:auto-es? 같이 es를 호출하고 지금 여기서 지시한 내용을
 * 포함한 하네스 mcp 내부 호출을 포함한 내용과 관계있는 스킬쪽에 추가해주고 그걸 턴 종료 es대신에 호출하도록"
 *
 *  - T7: auto-es runs zworkflow:es, then the harness rules (T1–T5 of #829), in that order.
 *  - T1: card sync through the model-command MCP — read, write (links + state, title, TL;DR), re-read.
 *  - T2: own issues/PRs/documents marked with their state.
 *  - T3: an unfinished own artifact puts a bold ⚠️ reason line in the TL;DR.
 *  - T4: the very last section is the user follow-up, with state, blocker, who, steps, verify, reply.
 *  - T5: the ⚠️ line keeps the card in NEEDS YOU until a later summary has none.
 *  - T9: the host's turn-end summary runs this skill's turn-end contract (reference/turn-end.md).
 */

const DIR = resolve(__dirname, '..');
const skill = readFileSync(resolve(DIR, 'SKILL.md'), 'utf8');
const turnEnd = readFileSync(resolve(DIR, 'reference', 'turn-end.md'), 'utf8');
const section = (title: string) => {
  const at = skill.indexOf(`## ${title}`);
  if (at < 0) return '';
  const next = skill.indexOf('\n## ', at + 3);
  return skill.slice(at, next < 0 ? undefined : next);
};

describe('T7 — auto-es is es plus the harness', () => {
  it('is named auto-es and says it is soma-work only', () => {
    expect(skill).toMatch(/^---\nname: auto-es\n/);
    expect(skill.slice(0, skill.indexOf('\n---', 4))).toMatch(/soma-work/);
  });

  it('runs zworkflow:es first, then the harness additions, the card sync and the card check', () => {
    const proc = section('Procedure');
    const es = proc.indexOf('`zworkflow:es`');
    const add = proc.indexOf('§Harness additions');
    const sync = proc.indexOf('§Card sync');
    const check = proc.indexOf('§Card check');
    expect(es).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(es);
    expect(sync).toBeGreaterThan(add);
    expect(check).toBeGreaterThan(sync);
  });

  it('is what soma-work runs wherever es is asked for', () => {
    expect(skill.slice(0, skill.indexOf('\n---', 4))).toMatch(/instead of `?es`?/i);
  });
});

describe('T1 — card sync through the model-command MCP', () => {
  it('reads, writes and re-reads the card', () => {
    const sync = section('Card sync');
    expect(sync).toContain('GET_SESSION');
    expect(sync).toContain('UPDATE_SESSION');
    for (const token of ['operations', 'resourceType', 'status', 'set_active', 'executiveSummary', 'tldr', 'title']) {
      expect(sync, token).toContain(token);
    }
    expect(sync).toMatch(/\bdoc\b/);
    expect(sync).toMatch(/GET_SESSION[\s\S]*verify|verify[\s\S]*GET_SESSION/i);
  });

  it('a Slack-less task works the same (the host writes by session key)', () => {
    expect(section('Card sync')).toMatch(/dashboard task|Slack-less/i);
  });
});

describe('T2–T4 — the document', () => {
  it('T2: Status marks what this session created, documents included, each with a state', () => {
    const add = section('Harness additions');
    expect(add).toMatch(/created this session/i);
    expect(add).toMatch(/document/i);
    expect(add).toMatch(/state/i);
  });

  it('T3: an unfinished own artifact is a bold ⚠️ reason line in the TL;DR', () => {
    const rule = section('Unfinished own artifacts');
    expect(rule).toContain('⚠️');
    expect(rule).toMatch(/Merged/);
    expect(rule).toMatch(/Closed/);
    expect(rule).toMatch(/TL;DR/);
    expect(rule).toMatch(/\*\*/);
    expect(rule).toMatch(/cannot be completed/i);
    expect(rule).toMatch(/reserved/i);
  });

  it('T4: the very last section is the user follow-up, with every field', () => {
    const add = section('Harness additions');
    expect(add).toMatch(/⚠️ User follow-up required/);
    expect(add).toMatch(/very last section/i);
    for (const field of [/state/i, /why/i, /steps?/i, /who/i, /verif/i, /reply|tell the agent/i]) {
      expect(add, String(field)).toMatch(field);
    }
  });
});

describe('T5 — the card waits for the user', () => {
  it('the ⚠️ line moves the card to NEEDS YOU and a later summary without one releases it', () => {
    const rule = section('Unfinished own artifacts');
    expect(rule).toMatch(/NEEDS YOU/);
    expect(rule).toMatch(/next (ES|Executive Summary)|later summary/i);
  });
});

describe('T9 — the turn-end summary runs this skill', () => {
  it('SKILL.md says the host runs reference/turn-end.md at turn end, without tools', () => {
    const te = section('Turn end');
    expect(te).toContain('reference/turn-end.md');
    expect(te).toMatch(/no tools|without tools/i);
  });

  it('turn-end.md carries the harness rules the fork must follow', () => {
    expect(turnEnd).toContain('local:auto-es');
    expect(turnEnd).toContain('⚠️');
    expect(turnEnd).toMatch(/why it cannot be completed/i);
    expect(turnEnd).toMatch(/User follow-up required/);
    expect(turnEnd).toMatch(/very last section/i);
    expect(turnEnd).toMatch(/created this session/i);
    expect(turnEnd).toMatch(/reserved/i);
    // The fork has no tools: the contract never asks it to call one.
    expect(turnEnd).not.toMatch(/\b(GET_SESSION|UPDATE_SESSION)\b/);
  });
});

/**
 * T10 (Z, 2026-11-03): "지금 이 세션 완료라고 했는데 입력 대기로 남는데 왜그런지 루크코즈 조사하고 픽스해줘"
 *
 * The session filed #873 to hand off the work outside its request, then the user ended it ("여기까지해").
 * The rule counted that open hand-off issue as an unfinished own artifact, so the TL;DR got a ⚠️ line, the host
 * saved it as the session's follow-up, and the finished session stayed in NEEDS YOU (입력 대기) for good.
 * A hand-off issue is complete once filed and linked; what the user ended or declined is no blocker.
 */
describe('T10 — a hand-off issue or what the user ended does not keep a finished session waiting', () => {
  const handOff = /hand-off issue/i;
  it('SKILL.md: a hand-off issue is complete once filed and linked — no ⚠️ line, no follow-up block', () => {
    const rule = section('Unfinished own artifacts');
    expect(rule).toMatch(handOff);
    expect(rule).toMatch(/complete once (it is )?filed/i);
    expect(rule).toMatch(/no ⚠️/);
  });
  it('SKILL.md: what the user ended or declined is not a blocker', () => {
    const rule = section('Unfinished own artifacts');
    expect(rule).toMatch(/user (ended|declined|stopped)/i);
    expect(rule).toMatch(/not a blocker|is no blocker/i);
  });
  it('a hand-off issue is not a way out: the request’s own deliverable stays unfinished until done', () => {
    const rule = section('Unfinished own artifacts');
    expect(rule).toMatch(/own deliverable|the request (asked|needs)/i);
  });
  it('turn-end.md (the host’s turn-end summary) carries the same two rules', () => {
    expect(turnEnd).toMatch(handOff);
    expect(turnEnd).toMatch(/complete once (it is )?filed/i);
    expect(turnEnd).toMatch(/user (ended|declined|stopped)/i);
  });
  it('both paths say the same: what waits only on the ended step, the quoted words, the own remaining work (trinity #878)', () => {
    const rule = section('Unfinished own artifacts');
    for (const text of [rule, turnEnd]) {
      expect(text).toMatch(/waits only on it/i);
      expect(text).toMatch(/quot(es|ing) their words/i);
      expect(text).toMatch(/own remaining work is not a hand-off issue/i);
      expect(text).toMatch(/state (you )?last s(aw|een)/i);
    }
  });
});

describe('Card sync — the host receipt (#846 item 2)', () => {
  const skill = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
  const sync = skill.slice(skill.indexOf('## Card sync'), skill.indexOf('## Card check'));
  it('verifies against payload.host: TL;DR, follow-up, pending, failed write', () => {
    expect(sync).toContain('`payload.host`');
    expect(sync).toContain('`host.tldr`');
    expect(sync).toContain('`host.followUp`');
    expect(sync).toMatch(/`hostPending: true`/);
    expect(sync).toMatch(/`host\.lastWrite\.ok === false`/);
  });
});
