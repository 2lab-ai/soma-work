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
 *  - T5: epic-drive.md opens with a `## 0. 진입` entry contract (its heading is
 *        followed by the marker line a calling wrapper checks for). Its table lets a
 *        handed-over existing epic skip creation and tier re-judging while a new
 *        request skips nothing; SKILL.md routes the handed-over epic to §0 in both
 *        전제 and Integration; restacking is limited to unpushed branches. Apart from
 *        the marker line, checks collapse whitespace so re-wrapping does not break them.
 */

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const DRIVE_MD = resolve(SKILL_ROOT, 'reference', 'epic-drive.md');

const STEPS = ['목표·계기판 고정', '스펙 먼저', '작업 단위 PR 루프', '실측·종결'];
const ROLES = ['디스패처', '작업자', '외부 리뷰 엔진', '머지 담당', '오너'];
const RULES = ['위임', '단위', '증거', '결정', '질문', '돈', '비밀', '범위', '글', '머지', '장애', '중복'];
const RECEIPT_ROWS = ['시험 먼저', '변이', '게이트', '기준선 분리', '외부 리뷰', 'PR 본문', '반영 후 확인'];
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

/** Cells of every data row of the first markdown table in `md`. */
function tableRows(md: string): string[][] {
  const lines = md.split('\n');
  const start = lines.findIndex((line) => line.startsWith('|'));
  if (start === -1) return [];
  const end = lines.findIndex((line, i) => i > start && !line.startsWith('|'));
  const table = lines.slice(start, end === -1 ? undefined : end);
  // table[0] = header, table[1] = separator.
  return table.slice(2).map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
}

/** First cell of every data row of the first markdown table in `md`. */
function firstCells(md: string): string[] {
  return tableRows(md).map((cells) => cells[0]);
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

  it('pins the per-PR receipt table in step 3: exact items, in order, each with evidence', () => {
    const step3 = section(drive(), /^## 3\. /m);
    const at = step3.search(/^### 리시트 표/m);
    expect(at).toBeGreaterThan(-1);
    // Scoped to the first table under the `### 리시트 표` heading.
    const rows = tableRows(step3.slice(at));
    expect(rows.map((cells) => cells[0])).toEqual(RECEIPT_ROWS);
    for (const [item, evidence] of rows) {
      expect(evidence ?? '', `empty evidence cell for ${item}`).not.toBe('');
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

const ENTRY_HEADING_LINE = '## 0. 진입';
const ENTRY_HEADING = /^## 0\. 진입$/m;
// A calling wrapper checks for this exact line under the heading — keep the bytes in sync.
const ENTRY_MARKER = '<!-- 이 제목은 호출하는 래퍼가 존재 확인에 쓴다 — 바꾸면 래퍼도 함께 바꾼다 -->';
const HANDED_OVER = '넘겨받은 기존 에픽';

/** `text` with every whitespace run collapsed to one space, so re-wrapping does not change a match. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Each `- ` list item in `md` (continuation lines included, up to a blank line), flattened. */
function listItems(md: string): string[] {
  return md
    .split(/^- /m)
    .slice(1)
    .map((chunk) => flat(chunk.split(/\n\s*\n/)[0]));
}

describe('local:using-epic-tasks — existing-epic entry and lifted rules (T5)', () => {
  it('epic-drive.md has `## 0. 진입` before step 1, with the wrapper marker on the next line', () => {
    const md = drive();
    expectAscending(md, [ENTRY_HEADING, /^## 1\. 목표·계기판 고정/m]);
    const lines = md.split('\n');
    const at = lines.indexOf(ENTRY_HEADING_LINE);
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(ENTRY_MARKER);
  });

  it('§0 table: a handed-over epic skips creation and tier re-judging, a new request skips nothing', () => {
    const rows = tableRows(section(drive(), ENTRY_HEADING)).map((cells) => cells.map(flat));
    const handedOver = rows.find((cells) => cells[0] === HANDED_OVER);
    const fresh = rows.find((cells) => cells[0] === '새 요청');
    expect(handedOver, `no §0 row for ${HANDED_OVER}`).toBeDefined();
    expect(fresh, 'no §0 row for 새 요청').toBeDefined();
    // Third cell = 건너뛰는 것.
    const skipped = handedOver?.[2] ?? '';
    expect(skipped).toContain('생성');
    expect(skipped).toContain('재판정');
    expect(fresh?.[2] ?? '').toMatch(/^없음/);
  });

  it('§0 bullets: a handed-over epic does not re-create existing issues or PRs', () => {
    expect(listItems(section(drive(), ENTRY_HEADING))).toEqual(
      expect.arrayContaining([expect.stringContaining('이미 있는 이슈·PR을 새로 만들지 않는다')]),
    );
  });

  it('SKILL.md 전제: the handed-over epic item enters at §0 without repeating tier re-judging', () => {
    const item = listItems(section(skill(), /^## 전제$/m)).find((line) => line.includes(HANDED_OVER)) ?? '';
    expect(item, `no 전제 item names ${HANDED_OVER}`).not.toBe('');
    for (const term of ['§0', '재판정', '반복하지 않']) {
      expect(item).toContain(term);
    }
  });

  it('SKILL.md Integration: the 2-hop entry item sends a handed-over epic to §0 instead', () => {
    const item =
      listItems(section(skill(), /^## Integration$/m)).find((line) => line.startsWith('**진입점 2-hop**')) ?? '';
    expect(item, 'no 진입점 2-hop item in Integration').not.toBe('');
    for (const term of [HANDED_OVER, '2-hop을 다시 타지 않', '§0']) {
      expect(item).toContain(term);
    }
  });

  it('limits restacking to branches not yet pushed', () => {
    expect(flat(drive())).toContain('아직 푸시하지 않은 브랜치');
  });
});
