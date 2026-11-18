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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  inject = { ...nextActionSeams(fns, inject), ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
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
    load<Min>(
      ['cardPrefList', 'cardPrefPut', 'cardMinList', 'cardMinSave', 'cardUnfoldList'],
      ['CARD_MIN_MAX', '_cardPrefs'],
      { localStorage: ls },
    );

  it('reads storage each time: a fold another dashboard tab saved is kept, not overwritten (review)', () => {
    const ls = storage();
    const tabA = min(ls);
    const tabB = min(ls);
    expect(tabA.cardMinList()).toEqual([]);
    expect(tabB.cardMinList()).toEqual([]);
    tabA.cardMinSave('A', true);
    tabB.cardMinSave('B', true);
    expect(JSON.parse(ls.items['soma-card-min'])).toEqual(['A', 'B']);
    expect(tabA.cardMinList()).toEqual(['A', 'B']);
  });

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

describe('a starred card a day old starts on one line (SSOT_2 T11)', () => {
  const H = 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 10, 18, 4, 0, 0);
  type Seeds = { cardMinSeeds(cols: unknown): string[]; cardMinSave(k: string, on: boolean): void };
  const page = (ls: ReturnType<typeof storage>, cache: Record<string, unknown>, col: Record<string, string>) =>
    load<Seeds>(
      [
        'cardPrefList',
        'cardPrefPut',
        'cardMinList',
        'cardMinSave',
        'cardUnfoldList',
        'cardStarDefaultFolded',
        'cardMinSeeds',
      ],
      ['CARD_MIN_MAX', '_cardPrefs', 'STAR_FOLD_MS'],
      { localStorage: ls, _sessionCache: cache, _cardCol: col, Date: { now: () => NOW, parse: Date.parse } },
    );
  const at = (h: number) => new Date(NOW - h * H).toISOString();
  const cache = {
    OLD: { starred: true, activityState: 'idle', lastActivity: at(25) },
    FRESH: { starred: true, activityState: 'idle', lastActivity: at(23) },
    PLAIN: { starred: false, activityState: 'idle', lastActivity: at(100) },
    WAITS: { starred: true, activityState: 'idle', lastActivity: at(30) },
    RUNS: { starred: true, activityState: 'working', lastActivity: at(30) },
    DAY: { starred: true, activityState: 'idle', lastActivity: at(48) },
  };
  const col = { OLD: 'idle', FRESH: 'idle', PLAIN: 'idle', WAITS: 'waiting', RUNS: 'working', DAY: 'done' };
  const cols = [{ keys: ['OLD', 'FRESH', 'PLAIN', 'WAITS', 'RUNS'] }, { keys: [], groups: [{ keys: ['DAY'] }] }];

  it('only starred cards past 24 h that neither work nor wait — in a column or a DONE day', () => {
    expect(page(storage(), cache, col).cardMinSeeds(cols)).toEqual(['OLD', 'DAY']);
  });

  it('the reader’s + keeps it open (saved); their − folds it again; their own folds come first', () => {
    const ls = storage({ 'soma-card-min': '["PLAIN"]' });
    const m = page(ls, cache, col);
    expect(m.cardMinSeeds(cols)).toEqual(['PLAIN', 'OLD', 'DAY']);
    m.cardMinSave('OLD', false); // +
    expect(JSON.parse(ls.items['soma-card-unfold'])).toEqual(['OLD']);
    expect(page(ls, cache, col).cardMinSeeds(cols)).toEqual(['PLAIN', 'DAY']);
    m.cardMinSave('OLD', true); // −
    expect(JSON.parse(ls.items['soma-card-unfold'])).toEqual([]);
    expect(page(ls, cache, col).cardMinSeeds(cols)).toEqual(['PLAIN', 'OLD', 'DAY']);
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
      cardMinSeeds: () => ['A'],
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
      ['_detailUnfolded'],
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

  it('a repaint keeps the deck’s folds on the element that now draws them, except a card the reader brought back (review)', () => {
    const calls: unknown[][] = [];
    const board = { setMinimized: (...a: unknown[]) => calls.push(['board', ...a]) };
    const lane = { setMinimized: (...a: unknown[]) => calls.push(['lane', ...a]) };
    const cardHost: Record<string, unknown> = { A: board, B: board, C: lane };
    type Api = {
      boardFoldDeck(h: unknown): void;
      boardNoteReaderFold(k: string, on: boolean): void;
      boardRestoreFromDetail(k: string): void;
    };
    const m = load<Api>(
      ['boardFoldForDetail', 'boardFoldDeck', 'boardNoteReaderFold', 'boardRestoreFromDetail'],
      ['_detailUnfolded'],
      { _cardHost: cardHost, _deck: ['A', 'B', 'C'] },
    );
    m.boardNoteReaderFold('B', false); // the reader's + on B while its detail card waits
    m.boardNoteReaderFold('Z', false); // not in the deck: nothing to note
    m.boardFoldDeck(board);
    expect(calls).toEqual([['board', 'A', true, { untilRestore: true }]]);
    m.boardFoldDeck(lane); // C moved to a CRON lane: folded there
    expect(calls[1]).toEqual(['lane', 'C', true, { untilRestore: true }]);
    m.boardNoteReaderFold('B', true); // − again: the deck's fold applies once more
    calls.length = 0;
    m.boardFoldDeck(board);
    expect(calls).toEqual([
      ['board', 'A', true, { untilRestore: true }],
      ['board', 'B', true, { untilRestore: true }],
    ]);
    // Leaving the deck forgets the note.
    m.boardNoteReaderFold('B', false);
    m.boardRestoreFromDetail('B');
    calls.length = 0;
    m.boardFoldDeck(board);
    expect(calls.map((c) => c[1])).toEqual(['A', 'B']);
  });

  // The real autoOpenDecisions with the real fold helpers (review: execute the transition, not the source text).
  const decisions = (o: { folded: string[]; expanded: string[]; deck: string[]; front: string | null }) => {
    const calls: unknown[][] = [];
    const folded = new Set(o.folded);
    const el = {
      isMinimized: (k: string) => folded.has(k),
      setMinimized: (k: string, on: boolean) => {
        calls.push(['setMinimized', k, on]);
        if (on) folded.add(k);
        else folded.delete(k);
      },
      reveal: (k: string, opts: unknown) => calls.push(['reveal', k, opts]),
    };
    const cache: Record<string, unknown> = { A: { key: 'A', sig: 'q2' }, B: { key: 'B', sig: 'q1' } };
    const m = load<{ autoOpenDecisions(): void }>(
      ['boardDetailInFront', 'boardDecisionHidden', 'boardUnfoldForDecision', 'autoOpenDecisions'],
      ['_detailUnfolded'],
      {
        _sessionCache: cache,
        decisionSigOf: (s: { sig: string }) => s.sig,
        _autoOpened: { A: 'q1' }, // A's earlier decision was opened; q2 is new
        _expanded: new Set(o.expanded),
        viewerOwns: () => true,
        isSiblingSession: () => false,
        _cardHost: { A: el, B: el },
        _cardCol: { A: 'waiting', B: 'waiting' },
        autoOpenWhenDefined: () => {},
        _deck: o.deck,
        panelOpen: o.front !== null,
        panelSessionKey: o.front,
        cardMinForget: (...a: unknown[]) => calls.push(['cardMinForget', ...a]),
      },
    );
    return { m, calls, folded };
  };

  it('a new decision on a card the reader folded unfolds it, clears the saved fold and reveals once (D9, review)', () => {
    const d = decisions({ folded: ['A'], expanded: ['A'], deck: [], front: null });
    d.m.autoOpenDecisions();
    expect(d.calls.filter((c) => c[1] === 'A')).toEqual([
      ['setMinimized', 'A', false],
      ['cardMinForget', 'A'],
      ['reveal', 'A', { open: true, scroll: false }],
    ]);
    // The same decision on the next poll: nothing again.
    const before = d.calls.length;
    d.m.autoOpenDecisions();
    expect(d.calls.filter((c) => c[1] === 'A')).toHaveLength(3);
    expect(d.calls.length).toBe(before);
  });

  it('a decision on a card whose detail card waits behind another unfolds it; one in front is left (review P1)', () => {
    const behind = decisions({ folded: ['A'], expanded: ['A'], deck: ['A', 'B'], front: 'B' });
    behind.m.autoOpenDecisions();
    expect(behind.calls.filter((c) => c[1] === 'A')).toEqual([
      ['setMinimized', 'A', false],
      ['cardMinForget', 'A'],
      ['reveal', 'A', { open: true, scroll: false }],
    ]);
    expect(behind.folded.has('A')).toBe(false);
    const front = decisions({ folded: ['A'], expanded: ['A'], deck: ['A'], front: 'A' });
    front.m.autoOpenDecisions();
    // Its detail card shows the decision: the board card stays as it is.
    expect(front.calls.filter((c) => c[1] === 'A')).toEqual([]);
    expect(front.folded.has('A')).toBe(true);
    // Opened by its title only (not open in place): still left as it is — no reveal under the fold (review P1).
    const titleOnly = decisions({ folded: ['A'], expanded: [], deck: ['A'], front: 'A' });
    titleOnly.m.autoOpenDecisions();
    expect(titleOnly.calls.filter((c) => c[1] === 'A')).toEqual([]);
    titleOnly.m.autoOpenDecisions(); // recorded: the next poll does nothing either
    expect(titleOnly.calls.filter((c) => c[1] === 'A')).toEqual([]);
  });

  it('a deck card the reader had folded loses its saved fold when a decision unfolds it — a redraw seeds it open (review P1)', () => {
    const ls = storage({ 'soma-card-min': '["A"]' });
    const el = { isMinimized: () => true, setMinimized: () => {} };
    const m = load<{ boardUnfoldForDecision(k: string): void; cardMinSeeds(cols: unknown): string[] }>(
      [
        'cardPrefList',
        'cardPrefPut',
        'cardMinList',
        'cardUnfoldList',
        'cardMinSave',
        'cardMinForget',
        'cardStarDefaultFolded',
        'cardMinSeeds',
        'boardUnfoldForDecision',
      ],
      ['CARD_MIN_MAX', '_cardPrefs', 'STAR_FOLD_MS', '_detailUnfolded'],
      { localStorage: ls, _cardHost: { A: el }, _deck: ['A', 'B'], _sessionCache: {}, _cardCol: {} },
    );
    expect(m.cardMinSeeds([{ keys: ['A'] }])).toEqual(['A']);
    m.boardUnfoldForDecision('A');
    expect(m.cardMinSeeds([{ keys: ['A'] }])).toEqual([]);
    expect(JSON.parse(ls.items['soma-card-min'])).toEqual([]);
    // Not recorded as the reader's + (review): nothing in the unfold list.
    expect(ls.items['soma-card-unfold']).toBeUndefined();
  });

  it('a decision that unfolds a starred card a day old is not a +: the next paint a day later starts it folded again (review)', () => {
    const NOW = Date.UTC(2026, 10, 18, 4, 0, 0);
    const ls = storage();
    const el = { isMinimized: () => true, setMinimized: () => {} };
    const cache = {
      S: { starred: true, activityState: 'idle', lastActivity: new Date(NOW - 30 * 3_600_000).toISOString() },
    };
    const m = load<{ boardUnfoldForDecision(k: string): void; cardMinSeeds(cols: unknown): string[] }>(
      [
        'cardPrefList',
        'cardPrefPut',
        'cardMinList',
        'cardUnfoldList',
        'cardMinForget',
        'cardStarDefaultFolded',
        'cardMinSeeds',
        'boardUnfoldForDecision',
      ],
      ['CARD_MIN_MAX', '_cardPrefs', 'STAR_FOLD_MS', '_detailUnfolded'],
      {
        localStorage: ls,
        _cardHost: { S: el },
        _deck: [],
        _sessionCache: cache,
        _cardCol: { S: 'idle' },
        Date: { now: () => NOW, parse: Date.parse },
      },
    );
    expect(m.cardMinSeeds([{ keys: ['S'] }])).toEqual(['S']);
    m.boardUnfoldForDecision('S');
    expect(m.cardMinSeeds([{ keys: ['S'] }])).toEqual(['S']);
  });

  it('every way a detail card opens folds its card; every way it leaves the deck undoes it; a decision opened in place opens none', () => {
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
