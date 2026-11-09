/**
 * Worst-case data (2026-11-10): the local `break-ui` skill, run against the dashboard with 40–130 worst-case sessions at
 * 320–1440px. The page-side fixes. The card face (title clamp, repo chip shrink, `dir="auto"`, the day clock) lives in
 * <ui-agent-inbox> and goes to @2lab.ai/ui.
 * - The phone dock's badge: the page's Korean `overflow-wrap: anywhere` broke "22" into "2" over "2".
 * - The open card's title: one line, so a long title could not be read anywhere on a touch screen.
 * - The repo chip: a 100-character repo name ran out of the card.
 * - The phone chip row: it opened scrolled to its end.
 * - The DONE day labels: two shapes. A card with no time was filed under 1970.
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
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const STRINGS = { today: '오늘', yesterday: '어제' };

describe('the phone dock badge never breaks its digits', () => {
  it('the dock stops the page\'s Korean "overflow-wrap: anywhere" at its host (inherited into its shadow DOM)', () => {
    expect(TEMPLATE).toMatch(/^\.phone-dock \{ overflow-wrap: normal; \}$/m);
    expect(TEMPLATE).toMatch(/html:lang\(ko\) body \{[^}]*overflow-wrap: anywhere;/);
  });
});

describe('the open card shows the whole title', () => {
  it('the title wraps to 3 lines and breaks an unbroken URL; the owner pill gives way first', () => {
    const rule = TEMPLATE.slice(
      TEMPLATE.indexOf('.panel-header h3 {'),
      TEMPLATE.indexOf('}', TEMPLATE.indexOf('.panel-header h3 {')),
    );
    expect(rule).toContain('-webkit-line-clamp: 3;');
    expect(rule).toContain('overflow-wrap: anywhere;');
    expect(rule).not.toContain('white-space: nowrap');
    expect(TEMPLATE).toContain(
      '.panel-header > .panel-owner { flex: 0 1 auto; min-width: 0; max-inline-size: min(28%, 120px);',
    );
  });

  it('while reading on a phone the title bar is one line again (T6); the whole title is back with the head', () => {
    expect(TEMPLATE).toContain('.slide-panel[data-read] .panel-header h3 { -webkit-line-clamp: 1; line-clamp: 1; }');
  });

  it('a right-to-left title reads from its start (dir="auto")', () => {
    expect(TEMPLATE).toContain('<h3 id="panel-title" tabindex="-1" dir="auto">');
  });
});

describe('the repo chip stays inside the card', () => {
  const m = load<{ cardRepoOf(s: unknown): { key: string; text: string; title: string } | null }>(['cardRepoOf']);

  it('a name over 28 characters is cut in the middle; the key and the title keep the whole repo', () => {
    const repo = 'northwind-industries-holdings/platform-infrastructure-notifications-service-legacy-migration-2026';
    const chip = m.cardRepoOf({ repo });
    expect(chip?.text).toBe('platform-infr…migration-2026');
    expect(chip?.text.length).toBe(28);
    expect(chip?.key).toBe(repo);
    expect(chip?.title).toBe(`레포: ${repo}`);
  });

  it('a name of 28 characters or fewer is shown whole', () => {
    expect(m.cardRepoOf({ repo: '2lab-ai/soma-work' })?.text).toBe('soma-work');
    const exact = 'a'.repeat(28);
    expect(m.cardRepoOf({ repo: `o/${exact}` })?.text).toBe(exact);
    expect(m.cardRepoOf({ repo: '  ' })).toBeNull();
  });
});

describe('the phone chip row opens at its first chip', () => {
  function rig(alreadyIn: boolean) {
    const tools: { scrollLeft: number; firstChild: unknown; inserted: number; insertBefore(n: unknown): void } = {
      scrollLeft: 27,
      firstChild: {},
      inserted: 0,
      insertBefore(n: unknown) {
        tools.inserted++;
        scope.parentNode = tools;
        void n;
      },
    };
    const bar = { appendChild() {} };
    const scope: { parentNode: unknown } = { parentNode: bar };
    if (alreadyIn) scope.parentNode = tools;
    const els: Record<string, unknown> = { 'topbar-scope': scope, 'app-bar': bar, 'inbox-chips': tools };
    const m = load<{ syncPhoneScope(): void }>(['syncPhoneScope'], {
      document: { getElementById: (id: string) => els[id] ?? null },
      isPhone: () => true,
    });
    return { m, tools };
  }

  it('moving the scope group into the snapping row scrolls the row back to 0', () => {
    const r = rig(false);
    r.m.syncPhoneScope();
    expect(r.tools.inserted).toBe(1);
    expect(r.tools.scrollLeft).toBe(0);
  });

  it("a row the scope is already in keeps the reader's scroll", () => {
    const r = rig(true);
    r.m.syncPhoneScope();
    expect(r.tools.inserted).toBe(0);
    expect(r.tools.scrollLeft).toBe(27);
  });
});

describe('DONE day groups: one label shape; a card with no time is not filed under 1970', () => {
  const m = load<{
    doneDayLabel(key: string, now: number): string;
    planDoneGroups(
      done: Array<{ s: unknown; col: string }>,
      now: number,
      opened: Record<string, boolean>,
      order?: { sort: string; dir: string },
    ): Array<{ key: string; label: string; items: Array<{ s: { key: string } }> }>;
  }>(['toNum', 'doneTimeOf', 'dayKeyOf', 'doneDayLabel', 'cardProgressAt', 'planDoneGroups'], { STRINGS });
  const NOW = new Date(2026, 10, 10, 12, 0).getTime();

  it('this year: "M월 D일 (요일)"; an earlier year adds "YYYY년 " in front of the same shape', () => {
    expect(m.doneDayLabel('2026-10-29', NOW)).toBe('10월 29일 (목)');
    expect(m.doneDayLabel('2025-12-15', NOW)).toBe('2025년 12월 15일 (월)');
    expect(m.doneDayLabel('2026-11-10', NOW)).toBe('오늘');
    expect(m.doneDayLabel('2026-11-09', NOW)).toBe('어제');
    expect(m.doneDayLabel('undated', NOW)).toBe('날짜 없음');
  });

  it('no time (0, missing, not a date) → 날짜 없음, last; a time ahead of this clock → today', () => {
    const item = (key: string, s: Record<string, unknown>) => ({ s: { key, ...s }, col: 'idle' });
    const g = m.planDoneGroups(
      [
        item('none', {}),
        item('bad', { lastActivity: 'undefined' }),
        item('epoch', { doneAt: 0, lastActivity: new Date(0).toISOString() }),
        item('future', { doneAt: NOW + 3 * 86_400_000 }),
        item('old', { doneAt: new Date(2026, 9, 1, 9).getTime() }),
      ],
      NOW,
      {},
    );
    expect(g.map((x) => [x.key, x.items.map((i) => i.s.key)])).toEqual([
      ['2026-11-10', ['future']],
      ['2026-10-01', ['old']],
      ['undated', ['none', 'bad', 'epoch']],
    ]);
    expect(g[2].label).toBe('날짜 없음');
    expect(g.some((x) => x.key.startsWith('1970'))).toBe(false);
    // Oldest first (the board's sort, ascending): the days turn around, 날짜 없음 stays last.
    const asc = m.planDoneGroups(
      [
        item('none', {}),
        item('old', { doneAt: new Date(2026, 9, 1, 9).getTime() }),
        item('now', { doneAt: NOW - 1000 }),
      ],
      NOW,
      {},
      { sort: 'progress', dir: 'asc' },
    );
    expect(asc.map((x) => x.key)).toEqual(['2026-10-01', '2026-11-10', 'undated']);
  });
});
