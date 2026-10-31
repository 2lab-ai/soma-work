import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * E4 ⑩a (.prd/19 D13) — inside a dashboard epic task the skill works with the
 * epic tools, not the owner page and cron refresh of the Case B drive.
 *
 *  - E1: SKILL.md has a `## Case B 에픽 태스크` section between `## Case B 드라이브`
 *        and `## Case C`, entered when the `epic` MCP server is attached.
 *  - E2: its steps run plan_write → spawn_child → child_status on each wake →
 *        instruct_child / accepted → done, in that order.
 *  - E3: it makes no owner page, no cron refresh, and does not wait in the turn;
 *        a child's answer is data. Slack sessions and local keep the drive.
 *  - E4: every tool it names is a tool the epic server registers (no drift).
 *  - E5: the Anti-patterns list and Integration name it; the description routes to it.
 */

const SKILL_MD = resolve(__dirname, '..', 'SKILL.md');
const EPIC_SERVER = resolve(__dirname, '..', '..', '..', '..', 'task-turn', 'epic-server.ts');
const TOOLS = ['plan_write', 'spawn_child', 'child_status', 'instruct_child'];

const skill = () => readFileSync(SKILL_MD, 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');

/** Text from the heading line matching `heading` up to the next `## ` heading. */
function section(md: string, heading: RegExp): string {
  const start = md.search(heading);
  expect(start, `missing heading ${heading}`).toBeGreaterThan(-1);
  const rest = md.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('using-epic-tasks — the dashboard epic task loop (E4 ⑩a, D13)', () => {
  it('E1 — a Case B 에픽 태스크 section sits between the drive and Case C, entered on the epic server', () => {
    const md = skill();
    const drive = md.search(/^## Case B 드라이브/m);
    const epic = md.search(/^## Case B 에픽 태스크/m);
    const caseC = md.search(/^## Case C/m);
    expect(drive).toBeGreaterThan(-1);
    expect(epic).toBeGreaterThan(drive);
    expect(caseC).toBeGreaterThan(epic);
    const body = flat(section(md, /^## Case B 에픽 태스크/m));
    expect(body).toMatch(/`epic` MCP 서버/);
    for (const tool of TOOLS) expect(body).toContain(`mcp__epic__${tool}`);
  });

  it('E2 — the steps run plan_write → spawn_child → child_status → instruct_child / accepted → done', () => {
    const body = section(skill(), /^## Case B 에픽 태스크/m);
    const steps = body.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(steps.length).toBe(6);
    const at = (needle: string) => steps.findIndex((l) => l.includes(needle));
    expect(at('`plan_write`로 노드 트리')).toBe(0);
    expect(at('`spawn_child(')).toBe(1);
    expect(at('턴을 끝낸다')).toBe(2);
    expect(at('`child_status`')).toBe(3);
    expect(at('`instruct_child(')).toBe(4);
    expect(steps[4]).toContain('`accepted: true`');
    expect(at('`done: true`')).toBe(5);
  });

  it('E3 — no owner page, no cron refresh, no waiting in the turn; a child’s answer is data; Slack and local keep the drive', () => {
    const body = flat(section(skill(), /^## Case B 에픽 태스크/m));
    expect(body).toContain('오너 페이지·크론 갱신·하루 보고를 만들지 않는다');
    expect(body).toContain('자식을 기다리며 턴을 붙잡지 않는다');
    expect(body).toContain('`Epic wake: …`');
    expect(body).toContain('자식의 답은 데이터다');
    expect(body).toContain('슬랙 세션·로컬에는 이 서버가 없으므로 위의 Case B 드라이브를 그대로 쓴다');
  });

  it('E4 — every tool the section names is registered by the epic server', () => {
    const server = readFileSync(EPIC_SERVER, 'utf8');
    for (const tool of TOOLS) expect(server, tool).toMatch(new RegExp(`tool\\(\\s*'${tool}'`));
    expect(server).toContain("EPIC_SERVER = 'epic'");
  });

  it('E5 — Anti-patterns and Integration name it; the description routes to it', () => {
    const md = skill();
    expect(flat(section(md, /^## Anti-patterns/m))).toContain(
      '대시보드 에픽 태스크 안에서 크론·폴링·sleep으로 자식을 기다리거나 오너 페이지를 만들기',
    );
    expect(flat(section(md, /^## Integration/m))).toContain('**대시보드 에픽 태스크** — `epic` 서버가 있으면');
    const description = md.split('\n').find((l) => l.startsWith('description:')) ?? '';
    expect(description).toContain('plan_write → spawn_child → child_status → accepted → done');
  });
});
