/**
 * Task card window controls (.prd/34) — the page's side.
 *
 * The board element (@2lab.ai/ui <ui-agent-inbox> 0.43.0, `controls: 'window'`) draws − · title · ★ · ▽ on every
 * card and keeps each card's fold; its contract is pinned in the library (agent-inbox.test.ts, "window controls").
 * The page:
 *   - turns the controls on for every board element and hands it the reader's one-line cards and the card in front
 *     (inboxPaint → data.controls / minimized / current);
 *   - keeps the reader's − / ▢ in this browser (cardMinList / cardMinSave, localStorage soma-card-min);
 *   - rings the card whose detail card is in front on every element (syncBoardCurrent);
 *   - folds a card for its detail card and undoes only that fold (boardFoldForDetail / boardRestoreFromDetail).
 * The deck itself (title → openPanel, ✕ → deckDrop → restore) is in dashboard-three-surfaces-client.test.ts.
 *
 * Executes the shipped client code cut out of renderDashboardPage()'s template literal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextActionSeams } from '../__fixtures__/viewer-scope';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  if (TEMPLATE.indexOf(`\nfunction ${name}(`, start + 1) >= 0) throw new Error(`client ${name} is declared twice`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  inject = { ...nextActionSeams(fns, inject), ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
function storage(seed: Record<string, string> = {}, opts: { failWrite?: boolean } = {}) {
  const items: Record<string, string> = { ...seed };
  return {
    items,
    getItem: (k: string) => (k in items ? items[k] : null),
    setItem: (k: string, v: string) => {
      if (opts.failWrite) throw new Error('QuotaExceededError');
      items[k] = String(v);
    },
  };
}

describe('the reader’s one-line cards are kept in this browser (D8)', () => {
  type Min = { cardMinList(): string[]; cardMinSave(key: string, on: boolean): void };
  const min = (ls: ReturnType<typeof storage>) =>
    load<Min>(['cardMinList', 'cardMinSave'], ['CARD_MIN_KEY', 'CARD_MIN_MAX', '_cardMin'], { localStorage: ls });

  it('saves a fold, drops an unfold, newest last; a fresh page reads it back', () => {
    const ls = storage();
    const m = min(ls);
    expect(m.cardMinList()).toEqual([]);
    m.cardMinSave('A', true);
    m.cardMinSave('B', true);
    m.cardMinSave('A', true); // again: moves to the end, once
    expect(m.cardMinList()).toEqual(['B', 'A']);
    m.cardMinSave('B', false);
    expect(JSON.parse(ls.items['soma-card-min'])).toEqual(['A']);
    expect(min(ls).cardMinList()).toEqual(['A']);
    // The list handed out is a copy: the element never writes the page's list.
    const out = m.cardMinList();
    out.push('X');
    expect(m.cardMinList()).toEqual(['A']);
  });

  it('keeps at most CARD_MIN_MAX (the newest); a broken or foreign value reads as none; a full storage keeps the page’s copy', () => {
    const ls = storage();
    const m = min(ls);
    for (let i = 0; i < 305; i++) m.cardMinSave(`k${i}`, true);
    const kept = m.cardMinList();
    expect(kept).toHaveLength(300);
    expect(kept[0]).toBe('k5');
    expect(kept[299]).toBe('k304');
    expect(min(storage({ 'soma-card-min': '{not json' })).cardMinList()).toEqual([]);
    expect(min(storage({ 'soma-card-min': '{"a":1}' })).cardMinList()).toEqual([]);
    expect(min(storage({ 'soma-card-min': '["A", 3, "", null, "B"]' })).cardMinList()).toEqual(['A', 'B']);
    const full = min(storage({}, { failWrite: true }));
    full.cardMinSave('A', true);
    expect(full.cardMinList()).toEqual(['A']);
  });
});

describe('every board element gets the window controls, the one-line cards and the card in front', () => {
  it('inboxPaint hands controls: window, minimized and current with the columns', () => {
    const host: Record<string, unknown> = {
      _ibPlan: { cols: [{ id: 'running', label: '실행 중', keys: ['A', 'B'] }], load: 'ready', announce: false },
    };
    const m = load<{ inboxPaint(h: unknown): void }>(['inboxPaint'], [], {
      _expanded: new Set(['B']),
      _cardData: { A: { id: 'A', title: 'a', status: 'running' }, B: { id: 'B', title: 'b', status: 'running' } },
      BOARD_STRINGS: {},
      cardMinList: () => ['A'],
      boardCurrentKey: () => 'B',
      syncCardFinish: () => {},
    });
    m.inboxPaint(host);
    expect(host.data).toMatchObject({ controls: 'window', minimized: ['A'], current: 'B', expanded: ['B'] });
  });

  it('syncBoardCurrent rings the front card on each element (the board, each CRON lane) and leaves an unchanged one be', () => {
    const board: Record<string, unknown> = { _ibPlan: {}, data: { columns: [], current: '' } };
    const lane: Record<string, unknown> = { _ibPlan: {}, data: { columns: [1], current: 'K' } };
    const stray: Record<string, unknown> = { data: { current: 'K' } }; // an element the page did not plan (the docs)
    const document = { querySelectorAll: (sel: string) => (sel === 'ui-agent-inbox' ? [board, lane, stray] : []) };
    type Api = { syncBoardCurrent(): void; boardCurrentKey(): string };
    const page = (panelOpen: boolean, panelSessionKey: string | null) =>
      load<Api>(['boardCurrentKey', 'syncBoardCurrent'], [], { document, panelOpen, panelSessionKey });
    // The panel open on K: the board learns it; the lane already knew (its data object is left as it is).
    const laneData = lane.data;
    page(true, 'K').syncBoardCurrent();
    expect(board.data).toEqual({ columns: [], current: 'K' });
    expect(lane.data).toBe(laneData);
    // Closed (or nothing in front): no card is current anywhere — a new data object, nothing else in it changed.
    expect(page(false, 'K').boardCurrentKey()).toBe('');
    expect(page(true, null).boardCurrentKey()).toBe('');
    page(false, null).syncBoardCurrent();
    expect(board.data).toEqual({ columns: [], current: '' });
    expect(lane.data).toEqual({ columns: [1], current: '' });
    expect(lane.data).not.toBe(laneData);
    expect(stray.data).toEqual({ current: 'K' });
  });
});

describe('a detail card folds its board card and undoes only that fold (D7)', () => {
  it('boardFoldForDetail / boardRestoreFromDetail ask the card’s own element; a card on no element is skipped', () => {
    const calls: unknown[][] = [];
    const el = {
      setMinimized: (...a: unknown[]) => calls.push(['setMinimized', ...a]),
      restore: (...a: unknown[]) => calls.push(['restore', ...a]),
    };
    const m = load<{ boardFoldForDetail(k: string): void; boardRestoreFromDetail(k: string): void }>(
      ['boardFoldForDetail', 'boardRestoreFromDetail'],
      [],
      { _cardHost: { A: el, OLD: {} } },
    );
    m.boardFoldForDetail('A');
    m.boardRestoreFromDetail('A');
    m.boardFoldForDetail('GONE');
    m.boardFoldForDetail('OLD'); // an element from before 0.43.0: no fold method
    m.boardRestoreFromDetail('OLD');
    expect(calls).toEqual([
      ['setMinimized', 'A', true, { untilRestore: true }],
      ['restore', 'A'],
    ]);
  });

  it('every way a detail card opens folds its card; every way it leaves the deck undoes it; a decision opened in place opens none', () => {
    expect(clientFn('openPanel')).toContain('boardFoldForDetail(sessionKey);');
    expect(clientFn('deckRemove')).toContain('boardRestoreFromDetail(key);');
    const auto = clientFn('autoOpenDecisions');
    expect(auto).toContain('host.reveal(key, { open: true, scroll: false });');
    expect(auto).not.toContain('openPanel(');
    // Deep links and a new task's card show the detail card with the card on one line, not opened in place.
    expect(clientFn('openDeepLinkedSession')).toContain('host.reveal(key, { open: false });');
    expect(TEMPLATE).not.toMatch(
      /\n {2}host\.reveal\(key\);\n {2}if \(!panelOpen \|\| panelSessionKey !== key\) openPanel\(key\);/,
    );
  });
});
