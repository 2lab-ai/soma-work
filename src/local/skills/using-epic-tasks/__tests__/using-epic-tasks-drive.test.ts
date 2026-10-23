import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RED contract for the Case B drive loop in the using-epic-tasks skill.
 *
 * SSOT: "여기서 작업하는 스타일을 /es로 정리해줘 … 재사용할수 있게 워크플로우 형태로 …
 *        그리고 그 내용을 /zworkflow:using-epic-tasks 에 업데이트해줘 이건 soma-work에
 *        업데이트해줘야함"
 *
 *  - T1: SKILL.md carries a `## Case B 드라이브` section between Case B and Case C
 *        that lists the four steps in order and points at reference/epic-drive.md.
 *  - T2: reference/epic-drive.md holds the detail contract — the same four steps,
 *        a 역할 section, the 12 공통 규칙 rows and the per-PR receipt table.
 *  - T3: the drive loop is a contract, not a session log — no absolute dates.
 *  - T4: the Anti-patterns list names "PR만 올리고 멈추기".
 */

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const DRIVE_MD = resolve(SKILL_ROOT, 'reference', 'epic-drive.md');

const STEPS = ['목표·계기판 고정', '스펙 먼저', '작업 단위 PR 루프', '실측·종결'];
const ROLES = ['디스패처', '작업자', '외부 리뷰 엔진', '머지 담당', '오너'];
const RULES = ['위임', '단위', '증거', '결정', '질문', '돈', '비밀', '범위', '글', '머지', '장애', '중복'];
const RECEIPT_ROWS = ['시험 먼저', '변이', '게이트', '기준선', '외부 리뷰', '반영 후 확인'];
const ABSOLUTE_DATE = /\d{4}-\d{2}-\d{2}/;

function skill(): string {
  return readFileSync(SKILL_MD, 'utf8');
}

function drive(): string {
  // A missing file reads as empty, so each check fails on its own assertion.
  return existsSync(DRIVE_MD) ? readFileSync(DRIVE_MD, 'utf8') : '';
}

/** Text from the heading line matching `heading` up to the next `## ` heading. */
function section(md: string, heading: RegExp): string {
  const start = md.search(heading);
  expect(start, `missing heading ${heading}`).toBeGreaterThan(-1);
  const rest = md.slice(start);
  // Skip the first character so the heading itself is not the "next" match.
  const next = rest.slice(1).search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** First cell of every data row of the first markdown table in `md`. */
function firstCells(md: string): string[] {
  const rows = md.split('\n').filter((line) => line.startsWith('|'));
  // rows[0] = header, rows[1] = separator.
  return rows.slice(2).map((line) => line.split('|')[1].trim());
}

function expectAscending(md: string, patterns: RegExp[]): void {
  const idx = patterns.map((p) => md.search(p));
  for (const [i, at] of idx.entries()) {
    expect(at, `missing ${patterns[i]}`).toBeGreaterThan(-1);
  }
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
}

const DRIVE_HEADING = /^## Case B 드라이브/m;

describe('local:using-epic-tasks — Case B drive section in SKILL.md (T1)', () => {
  it('sits after the Case B section and before Case C', () => {
    const md = skill();
    expectAscending(md, [/^## Case B — 에픽 \+ 서브이슈$/m, DRIVE_HEADING, /^## Case C/m]);
  });

  it('points at reference/epic-drive.md, and that file exists', () => {
    expect(section(skill(), DRIVE_HEADING)).toContain('reference/epic-drive.md');
    expect(existsSync(DRIVE_MD)).toBe(true);
  });

  it('lists the four steps as a numbered list, in order', () => {
    const sec = section(skill(), DRIVE_HEADING);
    expectAscending(
      sec,
      STEPS.map((name, i) => new RegExp(`^${i + 1}\\. \\*\\*${name}\\*\\*`, 'm')),
    );
  });

  it('frontmatter description routes to the drive reference', () => {
    const fm = skill().match(/^---\n([\s\S]*?)\n---/);
    expect(fm?.[1] ?? '').toMatch(/^description: ".*reference\/epic-drive\.md.*"$/m);
  });
});

describe('local:using-epic-tasks — reference/epic-drive.md detail contract (T2)', () => {
  it('has a heading per step, numbered and in the same order', () => {
    expectAscending(
      drive(),
      STEPS.map((name, i) => new RegExp(`^## ${i + 1}\\. ${name}`, 'm')),
    );
  });

  it('has a 역할 table naming every role', () => {
    expect(firstCells(section(drive(), /^## 역할$/m))).toEqual(ROLES);
  });

  it('has a 공통 규칙 table with exactly the 12 rules, in order', () => {
    expect(firstCells(section(drive(), /^## 공통 규칙$/m))).toEqual(RULES);
  });

  it('carries the per-PR receipt table inside step 3', () => {
    const step3 = section(drive(), /^## 3\. /m);
    const at = step3.search(/^### 리시트 표/m);
    expect(at).toBeGreaterThan(-1);
    const receipt = step3.slice(at);
    for (const row of RECEIPT_ROWS) {
      expect(receipt).toMatch(new RegExp(`^\\| ${row}`, 'm'));
    }
  });
});

describe('local:using-epic-tasks — contract, not a session log (T3)', () => {
  it('the SKILL.md drive section has no absolute date', () => {
    expect(section(skill(), DRIVE_HEADING)).not.toMatch(ABSOLUTE_DATE);
  });

  it('epic-drive.md has no absolute date', () => {
    const md = drive();
    expect(md.length).toBeGreaterThan(0);
    expect(md).not.toMatch(ABSOLUTE_DATE);
  });
});

describe('local:using-epic-tasks — Anti-patterns (T4)', () => {
  it('names PR-and-stop', () => {
    expect(section(skill(), /^## Anti-patterns$/m)).toMatch(/^- PR만 올리고 멈추기/m);
  });
});
