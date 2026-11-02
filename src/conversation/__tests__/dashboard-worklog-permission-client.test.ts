/**
 * SSOT 2026-11-02 T1 — the 작업 로그 shows a permission answer as its own row:
 * a badge naming the decision (권한 승인 / 권한 거부 / 설명 요청 / 2차 확인 승인)
 * and the line the server wrote (the decision, the tool, the command, the AI's
 * advice). Runs the shipped client code, cut out of renderDashboardPage().
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const at = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (at < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(at + 1, TEMPLATE.indexOf('\n}\n', at) + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}

type Row = { id: string; kind: string; text?: string; system?: { kind: string; label?: string }; hasRaw?: boolean };
const { wlEntryOf } = new Function(
  `${clientVar('WL_LABELS')}\n${clientVar('WL_PERMISSION_LABELS')}\n${clientFn('wlEntryOf')}\nreturn { wlEntryOf };`,
)() as { wlEntryOf(st: unknown, e: unknown): Row };

describe('작업 로그 — a permission answer', () => {
  it.each([
    ['approve', '권한 승인'],
    ['approve_disable_rule', '권한 승인 · 규칙 끔'],
    ['approve_confirmed', '2차 확인 승인'],
    ['deny', '권한 거부'],
    ['explain', '설명 요청'],
  ])('%s → a badge row "%s" with the server line', (decision, label) => {
    const row = wlEntryOf(
      { open: new Set() },
      { seq: 7, ts: 1, kind: 'permission', text: '✅ 권한 승인 · Bash · ls', tool: 'Bash', permission: { decision } },
    );
    expect(row).toMatchObject({
      id: '7',
      kind: 'system',
      system: { kind: 'permission', label },
      text: '✅ 권한 승인 · Bash · ls',
    });
    // Nothing behind the line to open.
    expect(row.hasRaw).toBeFalsy();
  });

  it('a permission entry with no readable decision is still a 권한 row', () => {
    const row = wlEntryOf({ open: new Set() }, { seq: 8, kind: 'permission', text: 'x' });
    expect(row.system).toEqual({ kind: 'permission', label: '권한' });
  });
});
