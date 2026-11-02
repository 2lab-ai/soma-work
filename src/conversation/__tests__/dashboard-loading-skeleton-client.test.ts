/**
 * Dashboard loading states — skeletons instead of a false empty board.
 *
 * Before the first board answer the page used to say "0 · Nothing here" in all
 * three columns and "-" in the stats strip, then cards popped in. These tests
 * pin the loading contract (ssot-task IDs in brackets):
 *
 *   [T2] the board is handed load 'loading' until the first board paints; the
 *        stats strip shows skeleton bars, not "-"
 *   [T2] the loading state is first-load only — a background poll never brings it back
 *   [T2] stats start in parallel with the board, not after it
 *   [T3] a failed first load hands the board load 'failed' and offers 다시 시도
 *   [T3] the session panel shows turn-shaped skeleton rows, not "Loading..."
 *   [T3] reduced motion: a still skeleton; skeleton nodes are aria-hidden
 *
 * The board is @2lab.ai/ui <ui-agent-inbox>: the page hands it a load state
 * (kb._ibPlan.load → inboxPaint → data.load) and the element draws what that
 * means — skeleton cards and aria-busy while loading, no counts, no empty hints
 * and no announcement until ready (library src/components/agent-inbox/agent-inbox.test.ts,
 * 'load: loading draws skeletons with no counts or empty hints; failed keeps cards
 * and makes no claims'). The #board-error bar with 다시 시도 stays the page's.
 *
 * Executes the shipped client code cut out of renderDashboardPage()'s template
 * literal (the harness of dashboard-three-surfaces-client.test.ts).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { uiLibKitCss } from '../ui-lib';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
function clientFn(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/** The page's chrome words (STRINGS), as served: the board's Korean words live there (D2 group 6). */
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  inject = { STRINGS: PAGE_STRINGS, ...inject };
  const names = Object.keys(inject);
  const extraNames = extra.map((src) => /^function (\w+)/.exec(src)?.[1] ?? '').filter(Boolean);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${[...fns, ...extraNames].join(', ')}, get _state() { return { ${vars.join(', ')} }; } };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The page markup as served (between <body> and the first <script>). */
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
/** The page CSS as served (the first <style> block). */
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);

function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`marker not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`marker not found: ${to}`);
  return src.slice(a, b);
}
// ── Fake DOM ──
type Plan = { cols: Array<{ id: string; label: string; keys: string[] }>; load: string; announce: unknown };
type BoardData = {
  columns: Array<{ id: string; label: string; cards: Array<{ id: string }> }>;
  load: string;
  announce: unknown;
  expanded: string[];
};
type FakeEl = {
  id?: string;
  _ibPlan?: Plan;
  data?: BoardData;
  hidden: boolean;
  textContent: string;
  innerHTML: string;
  attrs: Record<string, string>;
  classes: Set<string>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, on?: boolean): void;
    contains(c: string): boolean;
  };
};
function el(id?: string, classes: string[] = []): FakeEl {
  const e: FakeEl = {
    id,
    hidden: false,
    textContent: '',
    innerHTML: '',
    attrs: {},
    classes: new Set(classes),
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    classList: {
      add: (c) => e.classes.add(c),
      remove: (c) => e.classes.delete(c),
      toggle: (c, on) => {
        const want = on === undefined ? !e.classes.has(c) : on;
        if (want) e.classes.add(c);
        else e.classes.delete(c);
      },
      contains: (c) => e.classes.has(c),
    },
  };
  return e;
}
/** What inboxPaint reads besides the plan: the open cards, the cards, the board's wording. */
const paintEnv = () => ({ _expanded: new Set<string>(), _cardData: {}, BOARD_STRINGS: {} });
/** The board as served: initBoardInteractions (an IIFE of the page) run on a fake #kanban. */
const INIT_BOARD = (() => {
  const start = TEMPLATE.indexOf('(function initBoardInteractions() {');
  if (start < 0) throw new Error('initBoardInteractions not found');
  return cook(TEMPLATE.slice(start, TEMPLATE.indexOf('\n})();', start) + 6));
})();
function serve(kanban: FakeEl, wired: unknown[] = []): void {
  const env: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === 'kanban' ? kanban : null) },
    wireInbox: (host: unknown) => wired.push(host),
    setBoardView: () => {},
    defaultBoardView: () => 'board',
    savedBoardView: () => null,
    applySectionState: () => {},
    window: { innerWidth: 1280 },
    STRINGS: PAGE_STRINGS,
    ...paintEnv(),
  };
  const names = Object.keys(env);
  new Function(...names, `${clientVar('BOARD_LABELS')}\n${clientFn('inboxPaint')}\n${INIT_BOARD}`)(
    ...names.map((n) => env[n]),
  );
}
function fakeDocument(ids: string[]) {
  const byId: Record<string, FakeEl> = {};
  for (const id of ids) byId[id] = el(id);
  if (byId.kanban) serve(byId.kanban);
  return {
    byId,
    document: {
      getElementById: (id: string) => byId[id] ?? null,
      querySelectorAll: () => [],
    },
  };
}

// setBoardLoad repaints the board element through the page's inboxPaint.
const BOARD_FNS = ['inboxPaint', 'setBoardLoad', 'retryBoardLoad'];
const LOAD_VARS = ['_boardLoad', '_heldWsBoard', '_sessionsInflight', 'BOARD_LOAD_TIMEOUT_MS'];

// renderBoard with the load state it reads (_boardLoad) and writes through setBoardLoad,
// on the served board: the plan it hands the element, its columns and its load.
function boardFlow(cardOf?: (s: { key: string }, col: string) => unknown, over: Record<string, unknown> = {}) {
  const d = fakeDocument(['kanban', 'board-error', 'inbox']);
  const loads: number[] = [];
  const m = load<{
    renderBoard(board: unknown, partial?: boolean): void;
    setBoardLoad(s: string): void;
    retryBoardLoad(): void;
    _state: { _boardLoad: string };
  }>(
    [
      'toNum',
      'planDoneColumn',
      'doneTimeOf',
      'dayKeyOf',
      'doneDayLabel',
      'planDoneGroups',
      'isCronCard',
      'cronGroupKey',
      'cronCardTime',
      'planCronLane',
      'cardBodyShown',
      'epicChildCol',
      'epicChildrenOf',
      'epicKidsShown',
      'epicKidsSig',
      'epicKidsCounts',
      'withEpicChildren',
      'placeCard',
      'viewCardOf',
      'syncHasCards',
      'renderBoard',
      ...BOARD_FNS,
    ],
    [
      'BOARD_LABELS',
      '_epicKidsDrawn',
      '_cardHost',
      '_cardCol',
      '_cardData',
      '_cardDrawn',
      '_cardClosing',
      '_boardRenders',
      '_boardLoad',
    ],
    {
      document: d.document,
      loadSessions: () => loads.push(1),
      _sessionCache: Object.create(null),
      _acState: {},
      acEvict: () => {},
      _envIndex: null,
      _buildEnvIndex: () => ({}),
      _ownerIndex: null,
      assignOwnerHues: () => ({}),
      _lastBoardData: null,
      _cronJobs: [],
      _cronPlan: null,
      _cronRevealKey: null,
      syncCronLane: () => {},
      cronLaneSlots: () => [],
      paintCronLaneCards: () => {},
      showArchives: false,
      showSleeping: true,
      _revealedKey: null,
      _doneGroupOpen: Object.create(null),
      _expanded: new Set<string>(),
      BOARD_STRINGS: {},
      cardOf:
        cardOf ?? ((s: { key: string }, col: string) => ({ id: s.key, title: s.key, status: col, bodyMode: 'slot' })),
      // View mode (SSOT 2026-11-01): the board maps each card through the mode — this harness is 어드밴스드.
      isAdvanced: () => true,
      // The view plan (.prd/20): advanced 2안 원본 — no spec, the open card and the face as they were.
      viewSpec: () => ({
        detail: {
          show: ['subtitle', 'info', 'goal', 'artifacts', 'agenthead', 'agenttabs', 'sections', 'controls'],
          tasks: 'runs',
          open: true,
        },
      }),
      detailShows: () => true,
      faceOf: (c: unknown) => c,
      cardStarOf: () => undefined, // the face's star toggle (SSOT 2026-11-01) — none in this harness
      acPrefetch: () => {},
      releaseCardIoTimer: () => {},
      syncCardBodies: () => {},
      ensureCardIo: () => {},
      renderArchivesToggle: () => {},
      renderSleepingToggle: () => {},
      paintCronDrawer: () => {},
      updateTokenBreakdown: () => {},
      scheduleLayoutRefresh: () => {},
      MOTION: { move: 320 },
      openDeepLinkedSession: () => {},
      ...over,
    },
  );
  const kanban = d.byId.kanban;
  return { d, m, kanban, loads, ids: (col: number) => (kanban.data?.columns[col].cards ?? []).map((c) => c.id) };
}
const flowBoard = () => {
  const at = new Date().toISOString();
  const s = (key: string) => ({ key, lastActivity: at });
  return { waiting: [s('w1')], working: [s('r1'), s('r2')], idle: [], closed: [] };
};

describe('[T2] board — skeleton until the first board paints', () => {
  it('the served board starts loading: the element is handed load "loading", three empty columns, no announcement', () => {
    const inbox = between(PAGE, '<section class="inbox ui-tok" id="inbox"', '</section>');
    expect(inbox).toContain('<ui-agent-inbox id="kanban" class="kanban" view="board" lang="ko"></ui-agent-inbox>');
    // Skeleton cards, counts and empty hints are the element's: the page serves none of its own.
    for (const gone of ['class="col-skel"', 'class="sk-card"', 'id="count-', 'class="col-empty"']) {
      expect(inbox, gone).not.toContain(gone);
    }
    const kanban = el('kanban');
    const wired: unknown[] = [];
    serve(kanban, wired);
    expect(wired).toEqual([kanban]);
    expect(kanban._ibPlan?.load).toBe('loading');
    expect(kanban.data?.load).toBe('loading');
    expect(kanban.data?.announce).toBe(false);
    expect(kanban.data?.columns.map((c) => [c.id, c.label, c.cards])).toEqual([
      ['waiting', '응답 필요', []],
      ['working', '실행 중', []],
      ['done', '완료', []],
    ]);
  });

  // Deleted: 'each column carries card-shaped skeletons, hidden from assistive tech' — library 'load: loading draws skeletons with no counts or empty hints; failed keeps cards and makes no claims'.
  // Deleted: 'no false empty state: no "0" count and no "Nothing here" before data' — library 'load: loading draws skeletons with no counts or empty hints; failed keeps cards and makes no claims'.

  it('a board-wide error with 다시 시도 exists, hidden until a first load fails', () => {
    // D7 (D-06): the kit's fail notice (.ui-notice[data-tone="fail"]) with a kit button for 다시 시도.
    const err = between(PAGE, '<div class="ui-notice board-error" id="board-error"', '</div>');
    expect(err).toContain('data-tone="fail"');
    expect(err).toContain('role="alert"');
    expect(err).toContain('hidden');
    expect(err).toContain('<button type="button" class="ui-btn is-sm" onclick="retryBoardLoad()">다시 시도</button>');
    expect(CSS).toContain('.board-error[hidden] { display: none; }');
    expect(CSS).not.toMatch(/\.board-error \{[^}]*background/);
    // Inside the inbox, right before the board element.
    expect(PAGE.indexOf('id="board-error"')).toBeGreaterThan(PAGE.indexOf('<section class="inbox ui-tok" id="inbox"'));
    expect(PAGE.indexOf('id="board-error"')).toBeLessThan(PAGE.indexOf('<ui-agent-inbox id="kanban"'));
  });

  it('setBoardLoad("ready") ends the loading state on the element and hides the error', () => {
    const d = fakeDocument(['kanban', 'board-error']);
    const m = load<{ setBoardLoad(s: string): void; _state: { _boardLoad: string } }>(BOARD_FNS, ['_boardLoad'], {
      document: d.document,
      loadSessions: () => {},
      ...paintEnv(),
    });
    expect(m._state._boardLoad).toBe('loading');
    m.setBoardLoad('failed');
    expect(d.byId.kanban.data?.load).toBe('failed');
    expect(d.byId['board-error'].hidden).toBe(false);
    m.setBoardLoad('ready');
    expect(m._state._boardLoad).toBe('ready');
    expect(d.byId.kanban._ibPlan?.load).toBe('ready');
    expect(d.byId.kanban.data?.load).toBe('ready');
    expect(d.byId['board-error'].hidden).toBe(true);
  });

  it('first load only: once ready, nothing brings the loading state or the error back', () => {
    const d = fakeDocument(['kanban', 'board-error']);
    const m = load<{ setBoardLoad(s: string): void; _state: { _boardLoad: string } }>(BOARD_FNS, ['_boardLoad'], {
      document: d.document,
      loadSessions: () => {},
      ...paintEnv(),
    });
    m.setBoardLoad('ready');
    m.setBoardLoad('loading');
    m.setBoardLoad('failed');
    expect(m._state._boardLoad).toBe('ready');
    expect(d.byId.kanban.data?.load).toBe('ready');
    expect(d.byId['board-error'].hidden).toBe(true);
  });

  it('renderBoard hands the element the load state; only a poll answer latches ready', () => {
    const h = boardFlow();
    // Partial data under the error (a held push after a failed first load): its cards, load failed.
    h.m.setBoardLoad('failed');
    h.m.renderBoard(flowBoard());
    expect(h.kanban.data?.load).toBe('failed');
    expect(h.ids(1)).toEqual(['r1', 'r2']);
    // 다시 시도: loading again (the element draws skeletons only where no card is drawn).
    h.m.retryBoardLoad();
    expect(h.loads).toHaveLength(1);
    expect(h.kanban.data?.load).toBe('loading');
    expect(h.d.byId['board-error'].hidden).toBe(true);
    // A re-render meanwhile (cron poll, visibility, toggles) of partial data stays partial.
    h.m.renderBoard(flowBoard());
    expect(h.kanban.data?.load).toBe('loading');
    // The poll answer is a certified paint; renderBoard itself never latches the load state.
    h.m.renderBoard(flowBoard(), false);
    expect(h.kanban.data?.load).toBe('ready');
    expect(h.m._state._boardLoad).toBe('loading');
    expect(clientFn('renderBoard')).not.toContain('setBoardLoad(');
    // loadSessions latches it right after the certified paint.
    const ls = clientFn('loadSessions');
    expect(ls.indexOf("setBoardLoad('ready');")).toBeGreaterThan(ls.indexOf('renderBoard(data.board, false);'));
    h.m.setBoardLoad('ready');
    h.m.renderBoard(flowBoard());
    expect(h.kanban.data?.load).toBe('ready');
  });

  it('a render that throws before the element gets its data leaves it loading; loadSessions then shows 다시 시도', () => {
    const h = boardFlow(() => {
      throw new Error('bad card');
    });
    expect(() => h.m.renderBoard(flowBoard(), false)).toThrow('bad card');
    expect(h.kanban.data?.load).toBe('loading');
    expect(h.kanban.data?.columns.every((c) => c.cards.length === 0)).toBe(true);
    const ls = clientFn('loadSessions');
    expect(ls.indexOf("setBoardLoad('failed');")).toBeGreaterThan(ls.indexOf('} catch (e) {'));
  });
});

// #560 review P3: a closed DONE day's cards are placed as stubs (counted, not drawn) — they are in
// _cardHost, but nothing of theirs is on the page.
describe('a closed DONE day’s cards are stubs: no clearance, no 지시/응답 fetch for one left open', () => {
  it('the phone clearance and the open cards’ fetches follow the drawn cards, not every placed one', () => {
    const io: string[] = [];
    const expanded = new Set<string>(['old']); // opened, then its day closed
    const h = boardFlow(undefined, { _expanded: expanded, ensureCardIo: (k: string) => io.push(k) });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const onlyClosedDay = { waiting: [], working: [], idle: [{ key: 'old', lastActivity: tenDaysAgo }], closed: [] };
    h.m.renderBoard(onlyClosedDay, false);
    const done = h.kanban.data?.columns[2] as unknown as { groups: Array<{ open: boolean; cards: unknown[] }> };
    expect(done.groups.map((g) => g.open)).toEqual([false]);
    expect(h.d.byId.inbox.classes.has('has-cards')).toBe(false);
    expect(io).toEqual([]);
    // A drawn card: the clearance, and its fetch when it is open.
    expanded.add('w1');
    h.m.renderBoard({ ...flowBoard(), idle: onlyClosedDay.idle }, false);
    expect(h.d.byId.inbox.classes.has('has-cards')).toBe(true);
    expect(io).toEqual(['w1']);
  });
});

describe('[T3] board — a failed first load stops the skeleton', () => {
  function loadSessionsWith(fetchImpl: () => Promise<unknown>) {
    const d = fakeDocument(['kanban', 'board-error']);
    const renderBoard = vi.fn();
    const m = load<{
      loadSessions(): Promise<void>;
      setBoardLoad(s: string): void;
      retryBoardLoad(): void;
      _state: { _boardLoad: string };
    }>(['loadSessions', ...BOARD_FNS], LOAD_VARS, {
      document: d.document,
      fetch: fetchImpl,
      renderBoard,
      currentUserId: '',
      _lastPolledBoard: null,
      _lifecycle: null,
      panelOpen: false,
      panelSessionKey: null,
      _sessionCache: {},
      repaintPanelSession: () => {},
      onServerBuild: () => {},
      console: { error: () => {} },
      ...paintEnv(),
    });
    return { d, m, renderBoard };
  }

  it('network error on the first load → failed: error shown, the element told (it stops the skeleton)', async () => {
    const { d, m } = loadSessionsWith(() => Promise.reject(new Error('offline')));
    await m.loadSessions();
    expect(m._state._boardLoad).toBe('failed');
    expect(d.byId.kanban._ibPlan?.load).toBe('failed');
    expect(d.byId.kanban.data?.load).toBe('failed');
    expect(d.byId['board-error'].hidden).toBe(false);
  });

  it('an HTTP error is a failure too (no res.json() of an error page)', async () => {
    const json = vi.fn(() => Promise.resolve({ error: 'Internal Server Error' }));
    const { d, m, renderBoard } = loadSessionsWith(() => Promise.resolve({ ok: false, status: 500, json }));
    await m.loadSessions();
    expect(renderBoard).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(m._state._boardLoad).toBe('failed');
    expect(d.byId['board-error'].hidden).toBe(false);
  });

  it('a background poll failing after the board loaded keeps the board as it is', async () => {
    const { d, m } = loadSessionsWith(() => Promise.reject(new Error('offline')));
    m.setBoardLoad('ready');
    await m.loadSessions();
    expect(m._state._boardLoad).toBe('ready');
    expect(d.byId['board-error'].hidden).toBe(true);
  });

  it('다시 시도 shows the skeleton again and reloads; success paints the board', async () => {
    let fail = true;
    const board = { working: [], waiting: [], idle: [], closed: [] };
    const { d, m, renderBoard } = loadSessionsWith(() =>
      fail
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ board }) }),
    );
    await m.loadSessions();
    expect(m._state._boardLoad).toBe('failed');
    expect(d.byId.kanban.data?.load).toBe('failed');
    fail = false;
    m.retryBoardLoad();
    expect(m._state._boardLoad).toBe('loading');
    expect(d.byId.kanban.data?.load).toBe('loading');
    expect(d.byId['board-error'].hidden).toBe(true);
    // A poll answer is a certified paint (partial = false).
    await vi.waitFor(() => expect(renderBoard).toHaveBeenCalledWith(board, false));
  });
});

describe('[T2] board — only a poll answer certifies the board (review R1/R2)', () => {
  type Api = {
    loadSessions(): Promise<void>;
    paintPushedBoard(b: unknown): boolean;
    setBoardLoad(s: string): void;
    select(u: string): void;
    _state: { _boardLoad: string; _heldWsBoard: unknown };
  };
  function harness(fetchImpl: () => Promise<unknown>) {
    const d = fakeDocument(['kanban', 'board-error']);
    const painted: unknown[] = [];
    const m = load<Api>(
      ['loadSessions', 'paintPushedBoard', ...BOARD_FNS],
      LOAD_VARS,
      {
        document: d.document,
        fetch: fetchImpl,
        renderBoard: (b: unknown) => painted.push(b),
        mergeSiblingCards: (b: unknown) => b,
        currentUserId: '',
        _lastPolledBoard: null,
        _lifecycle: null,
        panelOpen: false,
        panelSessionKey: null,
        _sessionCache: {},
        repaintPanelSession: () => {},
        onServerBuild: () => {},
        console: { error: () => {} },
        ...paintEnv(),
      },
      ['function select(u) { currentUserId = u; }'],
    );
    return { d, m, painted };
  }
  const board = (tag: string) => ({ tag, working: [], waiting: [], idle: [], closed: [] });
  const ok = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ board: b }) });
  const WS = board('ws');
  const POLL = board('poll');

  it('a WebSocket push before the first poll answer is held, not painted (it has no sibling cards)', () => {
    const { m, painted } = harness(() => new Promise(() => {}));
    expect(m.paintPushedBoard(WS)).toBe(false);
    expect(painted).toEqual([]);
    expect(m._state._boardLoad).toBe('loading');
  });

  it('the poll answer paints, latches ready and drops the held push; later pushes paint at once', async () => {
    const { m, painted } = harness(() => ok(POLL));
    m.paintPushedBoard(WS);
    await m.loadSessions();
    expect(painted).toEqual([POLL]);
    expect(m._state._boardLoad).toBe('ready');
    expect(m._state._heldWsBoard).toBeNull();
    expect(m.paintPushedBoard(WS)).toBe(true);
    expect(painted).toEqual([POLL, WS]);
  });

  it('a first poll that fails paints the held push as partial data — under the error, never certified', async () => {
    const { d, m, painted } = harness(() => Promise.reject(new Error('offline')));
    m.paintPushedBoard(WS);
    await m.loadSessions();
    expect(painted).toEqual([WS]);
    expect(m._state._boardLoad).toBe('failed');
    expect(d.byId['board-error'].hidden).toBe(false);
  });

  it('after a failed first load a push paints, and the error stays until a poll succeeds', async () => {
    let fail = true;
    const { d, m, painted } = harness(() => (fail ? Promise.reject(new Error('offline')) : ok(POLL)));
    await m.loadSessions();
    expect(m.paintPushedBoard(WS)).toBe(true);
    expect(painted).toEqual([WS]);
    expect(m._state._boardLoad).toBe('failed');
    expect(d.byId['board-error'].hidden).toBe(false);
    fail = false;
    await m.loadSessions(); // the next 30 s poll
    expect(m._state._boardLoad).toBe('ready');
    expect(d.byId['board-error'].hidden).toBe(true);
  });

  it("a user switch drops the previous user's late answer", async () => {
    const answers: Array<(v: unknown) => void> = [];
    const { m, painted } = harness(() => new Promise((r) => answers.push(r)));
    const first = m.loadSessions(); // user A (All Users)
    m.select('U_B');
    const second = m.loadSessions(); // selectUser → user B
    answers[1](ok(POLL));
    await second;
    answers[0](ok(WS));
    await first;
    expect(painted).toEqual([POLL]);
  });

  it('a held push from the previous user is never painted for the next one', async () => {
    const { d, m, painted } = harness(() => Promise.reject(new Error('offline')));
    m.paintPushedBoard(WS); // held while All Users was selected
    m.select('U_B');
    await m.loadSessions(); // B's first load fails
    expect(painted).toEqual([]);
    expect(m._state._boardLoad).toBe('failed');
    expect(d.byId['board-error'].hidden).toBe(false);
  });

  it('a push held after a user switch belongs to the new user: the old load drops, the new failed load paints it (review R2, grok)', async () => {
    const answers: Array<{ ok(v: unknown): void; fail(e: Error): void }> = [];
    const { d, m, painted } = harness(
      () =>
        new Promise((ok, fail) => {
          answers.push({ ok, fail });
        }),
    );
    const loadA = m.loadSessions(); // All Users, in flight
    m.select('U_B');
    const loadB = m.loadSessions(); // selectUser → B
    // ws.onmessage filters by currentUserId (B) and holds with the same currentUserId.
    m.paintPushedBoard(WS);
    expect(m._state._heldWsBoard).toEqual({ user: 'U_B', board: WS });
    answers[0].fail(new Error('offline')); // A's late failure: not B's business
    await loadA;
    expect(painted).toEqual([]);
    expect(m._state._heldWsBoard).toEqual({ user: 'U_B', board: WS });
    answers[1].fail(new Error('offline')); // B's own failure: B's held cards, under the error
    await loadB;
    expect(painted).toEqual([WS]);
    expect(m._state._boardLoad).toBe('failed');
    expect(d.byId['board-error'].hidden).toBe(false);
  });

  it('certified, slow polls never starve each other: overlapping same-user polls all paint (review R2)', async () => {
    const answers: Array<(v: unknown) => void> = [];
    const { m, painted } = harness(() => new Promise((r) => answers.push(r)));
    const first = m.loadSessions();
    answers[0](ok(board('p0')));
    await first;
    expect(m._state._boardLoad).toBe('ready');
    // Three 30 s polls start before the first (40 s) answer lands.
    const loads = [m.loadSessions(), m.loadSessions(), m.loadSessions()];
    answers[1](ok(board('p1')));
    await loads[0];
    answers[2](ok(board('p2')));
    answers[3](ok(board('p3')));
    await Promise.all(loads);
    expect(painted).toEqual([board('p0'), board('p1'), board('p2'), board('p3')]);
  });

  it('ws.onmessage goes through paintPushedBoard', () => {
    const ws = TEMPLATE.slice(TEMPLATE.indexOf('ws.onmessage = function(ev) {'));
    const branch = ws.slice(0, ws.indexOf('renderPanelPermission(panelS);'));
    expect(branch).toContain('if (!paintPushedBoard(msg.board)) return;');
    expect(branch).not.toContain('renderBoard(mergeSiblingCards(msg.board));');
  });
});

describe('[T3] first load is bounded; partial data is never announced as the board (#482)', () => {
  type Api = {
    loadSessions(): Promise<void>;
    paintPushedBoard(b: unknown): boolean;
    setBoardLoad(s: string): void;
    retryBoardLoad(): void;
    select(u: string): void;
    _state: { _boardLoad: string; _heldWsBoard: unknown; BOARD_LOAD_TIMEOUT_MS: number };
  };
  type Call = { url: string; signal?: AbortSignal; settle(v: unknown): void; fail(e: unknown): void };
  function harness() {
    const d = fakeDocument(['kanban', 'board-error']);
    d.byId['board-error'].hidden = true; // as served
    const calls: Call[] = [];
    const painted: Array<{ board: unknown; partial: unknown; state: string }> = [];
    let m!: Api;
    const fetchImpl = (url: string, opts?: { signal?: AbortSignal }) =>
      new Promise((settle, fail) => {
        const call: Call = { url, signal: opts?.signal, settle, fail };
        calls.push(call);
        opts?.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')));
      });
    m = load<Api>(
      ['loadSessions', 'paintPushedBoard', ...BOARD_FNS],
      LOAD_VARS,
      {
        document: d.document,
        fetch: fetchImpl,
        // Record what the board was painted with, and the load state at that moment.
        renderBoard: (b: unknown, partial: unknown) => painted.push({ board: b, partial, state: m._state._boardLoad }),
        mergeSiblingCards: (b: unknown) => b,
        currentUserId: '',
        _lastPolledBoard: null,
        _lifecycle: null,
        panelOpen: false,
        panelSessionKey: null,
        _sessionCache: {},
        repaintPanelSession: () => {},
        onServerBuild: () => {},
        console: { error: () => {} },
        ...paintEnv(),
      },
      ['function select(u) { currentUserId = u; }'],
    );
    return { d, m, calls, painted };
  }
  const board = (tag: string) => ({ tag, working: [], waiting: [], idle: [], closed: [] });
  const res = (b: unknown, delayMs = 0) => ({
    ok: true,
    json: () => new Promise((r) => setTimeout(() => r({ board: b }), delayMs)),
  });

  it('the deadline is shorter than the 30 s poll', () => {
    const { m } = harness();
    expect(m._state.BOARD_LOAD_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(m._state.BOARD_LOAD_TIMEOUT_MS).toBeLessThan(30000);
    expect(TEMPLATE).toContain('setInterval(loadSessions, 30000);');
  });

  it('a first request that never answers ends in 다시 시도 — with the held push shown as partial data', async () => {
    vi.useFakeTimers();
    try {
      const { d, m, calls, painted } = harness();
      const load = m.loadSessions();
      m.paintPushedBoard(board('ws'));
      expect(calls[0].signal).toBeDefined();
      await vi.advanceTimersByTimeAsync(m._state.BOARD_LOAD_TIMEOUT_MS);
      await load;
      expect(calls[0].signal?.aborted).toBe(true);
      expect(m._state._boardLoad).toBe('failed');
      expect(d.byId['board-error'].hidden).toBe(false);
      // The partial paint happens under 'failed' — renderBoard does not announce it as the board.
      expect(painted).toEqual([{ board: board('ws'), partial: undefined, state: 'failed' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the deadline bounds the wait for the answer, not the transfer: a slow body on a slow link still paints', async () => {
    vi.useFakeTimers();
    try {
      const { m, calls, painted } = harness();
      const load = m.loadSessions();
      calls[0].settle(res(board('poll'), m._state.BOARD_LOAD_TIMEOUT_MS * 2)); // headers now, body later
      await vi.advanceTimersByTimeAsync(m._state.BOARD_LOAD_TIMEOUT_MS * 2);
      await load;
      expect(calls[0].signal?.aborted).toBe(false);
      expect(painted).toEqual([{ board: board('poll'), partial: false, state: 'loading' }]);
      expect(m._state._boardLoad).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('once the board is certified, polls run without a deadline (a slow healthy poll is never cut off)', async () => {
    const { m, calls } = harness();
    const first = m.loadSessions();
    calls[0].settle(res(board('poll')));
    await first;
    expect(m._state._boardLoad).toBe('ready');
    m.loadSessions();
    expect(calls[1].signal).toBeUndefined();
  });

  it("before certification the same user's next ask joins the load in flight — task_update, toggles, polls, 다시 시도 (#487 R2, fable P1)", async () => {
    const { d, m, calls } = harness();
    const first = m.loadSessions(); // the first load, slow
    // A busy board: task_update calls loadSessions() on every message.
    const joins = [m.loadSessions(), m.loadSessions(), m.loadSessions()];
    expect(calls).toHaveLength(1); // one request, one sibling fan-out
    expect(calls[0].signal?.aborted).toBe(false); // nobody restarts its clock
    calls[0].settle(res(board('poll')));
    await Promise.all([first, ...joins]);
    expect(m._state._boardLoad).toBe('ready');
    expect(d.byId['board-error'].hidden).toBe(true);
    // Certified: every ask is its own request again, never aborted.
    m.loadSessions();
    m.loadSessions();
    expect(calls).toHaveLength(3);
    expect(calls[1].signal).toBeUndefined();
    expect(calls[2].signal).toBeUndefined();
  });

  it('다시 시도 while a poll is in flight joins it: its outcome is the answer', async () => {
    const { d, m, calls } = harness();
    const poll = m.loadSessions(); // the 30 s poll, after a failed first load
    m.setBoardLoad('failed');
    m.retryBoardLoad();
    expect(calls).toHaveLength(1);
    expect(m._state._boardLoad).toBe('loading');
    expect(d.byId['board-error'].hidden).toBe(true);
    calls[0].fail(new Error('offline'));
    await poll;
    expect(m._state._boardLoad).toBe('failed');
    expect(d.byId['board-error'].hidden).toBe(false);
  });

  it("a user switch aborts the previous user's uncertified load (its answer would be dropped; #487 review, grok P2)", async () => {
    const { d, m, calls } = harness();
    const forA = m.loadSessions();
    m.select('U_B');
    m.loadSessions();
    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].signal?.aborted).toBe(false);
    await forA; // A's abort is not B's failure
    expect(m._state._boardLoad).toBe('loading');
    expect(d.byId['board-error'].hidden).toBe(true);
    calls[1].settle(res(board('b')));
    await vi.waitFor(() => expect(m._state._boardLoad).toBe('ready'));
  });

  it('A → B → A before certification: the aborted A load is not a failure of the new A load (#487 R3, fable P2)', async () => {
    const { d, m, calls } = harness();
    const a1 = m.loadSessions();
    m.select('U_B');
    const b = m.loadSessions(); // aborts A1
    m.select('');
    m.loadSessions(); // back to A: aborts B, starts A2
    expect(calls).toHaveLength(3);
    await Promise.all([a1, b]);
    expect(m._state._boardLoad).toBe('loading');
    expect(d.byId['board-error'].hidden).toBe(true);
    calls[2].settle(res(board('a2')));
    await vi.waitFor(() => expect(m._state._boardLoad).toBe('ready'));
  });

  it('a body that stalls after the headers does not swallow 다시 시도: once answered, the next ask is a new request (#487 R3, grok P2)', async () => {
    const { m, calls } = harness();
    m.loadSessions();
    calls[0].settle({ ok: true, json: () => new Promise(() => {}) }); // headers in, body never
    await new Promise((r) => setTimeout(r, 0));
    m.setBoardLoad('failed');
    m.retryBoardLoad();
    expect(calls).toHaveLength(2);
    calls[1].settle(res(board('retry')));
    await vi.waitFor(() => expect(m._state._boardLoad).toBe('ready'));
  });

  it('renderBoard announces only a certified board', () => {
    const body = clientFn('renderBoard');
    expect(body.startsWith('function renderBoard(board, partial) {')).toBe(true);
    // Unspecified: whatever is painted while the board is in error is partial (toggles re-render it too).
    // Anything painted before the board is certified is partial — also a re-render during
    // 다시 시도 (cron poll, visibility, toggles) of the partial cards (#487 review, fable P2).
    expect(body).toContain("if (partial === undefined) partial = _boardLoad !== 'ready';");
    expect(clientFn('loadSessions')).toContain('renderBoard(data.board, false);');
    // The counts always travel (data.announce: the data as it came); the element says them only
    // when load is ready (library 'announces the host counts (data.announce), and nothing with
    // announce: false' and 'load: loading draws skeletons … failed keeps cards and makes no claims').
    const h = boardFlow();
    h.m.renderBoard(flowBoard());
    expect(h.kanban.data).toMatchObject({ load: 'loading', announce: { needs: 1, running: 2 } });
    h.m.setBoardLoad('failed');
    h.m.renderBoard(flowBoard());
    expect(h.kanban.data).toMatchObject({ load: 'failed', announce: { needs: 1, running: 2 } });
    h.m.renderBoard(flowBoard(), false);
    expect(h.kanban.data).toMatchObject({ load: 'ready', announce: { needs: 1, running: 2 } });
  });
});

describe('[T2] stats strip — skeleton bars, started in parallel with the board', () => {
  // 세션 · 토큰 · 비용 are <ui-stat-strip id="stats-strip">'s data (D2); the cards behind 자세히 are a second
  // <ui-stat-strip id="stats-grid"> in layout 'cards' (D4, B-07). Both roll from the value under the loading bar.
  const STRIP_FNS = [
    'setStripFigure',
    'statsStripData',
    'paintStatsStrip',
    'statCardsData',
    'paintStatCards',
    'fillStatSlot',
  ];
  const STRIP_VARS = ['_strip', '_tokenBreakdown', '_statsDetailOpen', 'PERIOD_OPTIONS', '_statCards'];
  // The two <ui-bar-chart>s (B-08): CHARTS spans lines, so it travels as extra source.
  const CHART_FNS = ['toNum', 'chartDayTitle', 'chartData', 'paintCharts'];
  const CHARTS_SRC = cook(`${between(TEMPLATE, 'var CHARTS = [', '\n];')}\n];`);
  type StripMetric = {
    key: string;
    value: number | null;
    loading: boolean;
    from?: string;
    slot?: string;
    wide?: boolean;
  };
  const figures = (strip: FakeEl) =>
    ((strip.data as unknown as { metrics: StripMetric[] }).metrics ?? []).map((x) => ({
      key: x.key,
      value: x.value,
      loading: x.loading,
    }));

  it('every figure is served loading: the strip and the cards start as skeleton bars, each rolling from its last value', () => {
    expect(PAGE).toContain(
      '<ui-stat-strip id="stats-grid" class="stats-grid" lang="ko"><span id="stat-merge-lines"></span><span id="stat-workflows" class="stat-wf"></span></ui-stat-strip>',
    );
    for (const gone of [
      'class="stat-card"',
      'id="stat-turns"',
      'id="stat-prs"',
      'id="stat-merged"',
      'stat-commits-hidden',
    ]) {
      expect(PAGE, gone).not.toContain(gone);
    }
    const m = load<{
      statsStripData(): { metrics: StripMetric[] };
      statCardsData(): { layout: string; metrics: StripMetric[] };
    }>(['statsStripData', 'statCardsData'], STRIP_VARS, { currentPeriod: 'day' });
    expect(m.statsStripData().metrics.map((x) => [x.key, x.value, x.loading, x.from])).toEqual([
      ['sessions', null, true, 'last'],
      ['tokens', null, true, 'last'],
      ['cost', null, true, 'last'],
    ]);
    const cards = m.statCardsData();
    expect(cards.layout).toBe('cards');
    expect(cards.metrics.map((x) => [x.key, x.loading, x.from ?? x.slot])).toEqual([
      ['turns', true, 'last'],
      ['prs', true, 'last'],
      ['merged', true, 'last'],
      ['lines', true, 'lines'],
      ['wf', true, 'wf'],
    ]);
    expect(cards.metrics[4].wide).toBe(true);
  });

  it('a load: the bar over the kept value, then one write with the answer — the element rolls (from: last), no hand-off', () => {
    // 0.10.0 keeps a figure's value under its loading bar (metrics[].from: 'last'), so the page no longer hands
    // the old value back first (D2-GAPS G2-1's landStripFigures is gone).
    expect(TEMPLATE).not.toContain('landStripFigures');
    const d = fakeDocument(['stats-strip', 'stats-grid', 'stat-merge-lines', 'stat-workflows']);
    const strip = d.byId['stats-strip'];
    const writes: StripMetric[][] = [];
    let data: unknown;
    Object.defineProperty(strip, 'data', {
      get: () => data,
      set: (v) => {
        data = v;
        writes.push(figures(strip));
      },
    });
    const m = load<{ markStatsLoading(): void; paintStats(d: unknown): void; paintUsage(r: unknown): void }>(
      ['markStatsLoading', 'paintStats', 'paintUsage', 'esc', 'toNum', ...STRIP_FNS],
      STRIP_VARS,
      {
        document: d.document,
        currentPeriod: 'day',
        paintCharts: () => {},
        paintUsageBreakdown: () => {},
        _chartDays: [],
        _usageReport: null,
      },
    );
    const sessions = () => writes.map((w) => w.find((x) => x.key === 'sessions'));
    const at = <T>(list: T[], i: number): T | undefined => list[list.length - 1 - i];
    const totals = (n: number) => ({
      totals: {
        sessionsCreated: n,
        turnsUsed: 7,
        prsCreated: 2,
        prsMerged: 1,
        mergeLinesAdded: 30,
        mergeLinesDeleted: 4,
        workflowCounts: { autoz: 1, z: 3 },
      },
      days: [],
    });
    m.paintStats(totals(10));
    expect(at(sessions(), 0)).toEqual({ key: 'sessions', value: 10, loading: false });
    // A new load: the bar, with the last value kept under it.
    m.markStatsLoading();
    expect(at(writes, 0)?.map((x) => x.loading)).toEqual([true, true, true]);
    expect(at(sessions(), 0)).toEqual({ key: 'sessions', value: 10, loading: true });
    expect(figures(d.byId['stats-grid']).map((x) => x.loading)).toEqual([true, true, true, true, true]);
    // Its answer: one write with the new value.
    writes.length = 0;
    m.paintStats(totals(25));
    expect(sessions()).toEqual([{ key: 'sessions', value: 25, loading: false }]);
    expect(figures(d.byId['stats-grid'])).toEqual([
      { key: 'turns', value: 7, loading: false },
      { key: 'prs', value: 2, loading: false },
      { key: 'merged', value: 1, loading: false },
      { key: 'lines', value: undefined, loading: false },
      { key: 'wf', value: undefined, loading: false },
    ]);
    // The free-form figures go into their slots, the most-run workflow first.
    expect(d.byId['stat-merge-lines'].innerHTML).toBe('+30 / -4');
    expect(d.byId['stat-merge-lines'].attrs.slot).toBe('lines');
    expect(d.byId['stat-workflows'].innerHTML).toBe('<span>z: <b>3</b></span><span>autoz: <b>1</b></span>');
    expect(d.byId['stat-workflows'].attrs.slot).toBe('wf');
    // A failed answer is a dash: null figures, and the slotted figures leave their slots (the element's "—").
    m.markStatsLoading();
    m.paintStats(null);
    expect(at(sessions(), 0)).toEqual({ key: 'sessions', value: null, loading: false });
    expect(
      figures(d.byId['stats-grid'])
        .slice(0, 3)
        .map((x) => x.value),
    ).toEqual([null, null, null]);
    expect(d.byId['stat-merge-lines'].attrs.slot).toBeUndefined();
    expect(d.byId['stat-workflows'].attrs.slot).toBeUndefined();
    // 토큰 · 비용 land from the usage answer the same way.
    m.paintUsage({ totals: { totalInputTokens: 5, totalOutputTokens: 6, totalCostUsd: 1.5 } });
    expect(at(writes, 0)?.filter((x) => x.key !== 'sessions')).toEqual([
      { key: 'tokens', value: 11, loading: false },
      { key: 'cost', value: 1.5, loading: false },
    ]);
  });

  it('every stats load (first load, period, user) shows bars until its answer lands', () => {
    const body = clientFn('loadStats');
    expect(body).toContain('markStatsLoading();');
    expect(body.indexOf('markStatsLoading();')).toBeLessThan(body.indexOf('statsJson('));
    const d = fakeDocument(['chart-sessions', 'chart-merge', 'stats-strip', 'stats-grid']);
    const m = load<{ markStatsLoading(): void }>(
      ['markStatsLoading', ...STRIP_FNS, ...CHART_FNS],
      ['_chartDays', ...STRIP_VARS],
      { document: d.document, currentPeriod: 'week' },
      [CHARTS_SRC],
    );
    m.markStatsLoading();
    expect(figures(d.byId['stats-strip']).map((x) => x.loading)).toEqual([true, true, true]);
    expect(figures(d.byId['stats-grid']).map((x) => x.loading)).toEqual([true, true, true, true, true]);
    expect((d.byId['stats-strip'].data as unknown as { period: { value: string } }).period.value).toBe('week');
    // The charts: skeleton bars before the first answer (the element dims the last bars after it).
    for (const id of ['chart-sessions', 'chart-merge']) {
      expect(d.byId[id].data, id).toMatchObject({ loading: true, bars: [] });
    }
  });

  it('paintStats ends the cards and chart bars', () => {
    const body = clientFn('paintStats');
    expect(body).toMatch(/fillStatSlot\('stat-workflows', 'wf'[\s\S]*paintStatCards\(\);/);
    // D2 (B-08): each <ui-bar-chart> gets the days — label the day of the month, title 'M월 D일', the day's value —
    // and loading: false; a failed load (null) says so in the plot.
    expect(body).toContain('paintCharts(_chartDays, false);');
    const d = fakeDocument(['chart-sessions', 'chart-merge']);
    const m = load<{ paintCharts(days: unknown[] | null, loading: boolean): void }>(
      CHART_FNS,
      [],
      { document: d.document },
      [CHARTS_SRC],
    );
    const days = [
      { date: '2026-10-05', sessionsCreated: 3, mergeLinesAdded: 10, mergeLinesDeleted: 4 },
      { date: '2026-10-06', sessionsCreated: 0, mergeLinesAdded: 0, mergeLinesDeleted: 0 },
    ];
    m.paintCharts(days, false);
    expect(d.byId['chart-sessions'].data).toEqual({
      title: '세션',
      unit: '세션',
      bars: [
        { key: '2026-10-05', label: '5', title: '10월 5일', value: 3 },
        { key: '2026-10-06', label: '6', title: '10월 6일', value: 0 },
      ],
      empty: '이 기간에 데이터가 없습니다',
      loading: false,
    });
    expect(d.byId['chart-merge'].data).toMatchObject({
      title: '코드 변경 (머지)',
      bars: [{ value: 14 }, { value: 0 }],
    });
    m.paintCharts(null, false);
    expect(d.byId['chart-merge'].data).toMatchObject({ bars: [], empty: '통계를 불러오지 못했어요', loading: false });
  });

  it('stats no longer wait for the board: both start at init', () => {
    const init = TEMPLATE.slice(TEMPLATE.lastIndexOf('// ── Init ──'));
    expect(init).not.toContain('loadSessions().then(function() { loadStats(); });');
    expect(init).toMatch(/\nloadSessions\(\);\nloadStats\(\);\n/);
  });
});

describe('[T3] session panel — turn-shaped skeleton instead of "Loading..."', () => {
  it('openPanel no longer prints "Loading..."; 지시와 답변 is handed loading (the element’s turn skeletons, busy) until the turns land', () => {
    const body = clientFn('openPanel');
    expect(body).not.toContain('Loading...');
    // SSOT 2026-10-29: the opening marks 지시와 답변's data as loading; the tab paints from it (convPaint).
    expect(body).toContain("_panelTurnsMsg = s.conversationId ? 'loading' : 'unrecorded';");
    const sets: Record<string, unknown>[] = [];
    const m = load<{ convPaint(): void; __set(n: string, v: unknown): void }>(
      ['convPaint'],
      ['CONV_EMPTY', '_resumSent'],
      {
        convEl: () => ({}),
        _psec: 'conv',
        _panelAgent: '',
        panelSessionKey: null,
        _sessionCache: {},
        panelConvId: 'c',
        _panelTurnsCid: 'c',
        _panelTurnsList: [] as unknown[],
        _panelTurnsMsg: 'loading',
        _panelTurnsHasMore: false,
        _panelTurnsLoading: true,
        _panelTurnsWhy: '',
        _panelOlderWhy: '',
        _panelDetail: false,
        _rawLoadedCache: {},
        _ansFailed: {},
        _artCache: {},
        botNameOf: () => 'Soma',
        ansLinkTitles: () => ({}),
        ansSession: () => null,
        ansPendingShow: () => false,
        convTurnsOf: (list: { id: string }[]) => ({ turns: list.map((t) => ({ id: t.id, role: 'user' })), slots: [] }),
        convSlots: () => {},
        convSetData: (_el: unknown, d: Record<string, unknown>) => sets.push(d),
      },
      ['function __set(n, v) { eval(n + " = v"); }'],
    );
    const last = () => sets[sets.length - 1];
    m.convPaint();
    // No turns and loading: <ui-conversation> draws its three turn-shaped skeletons and is aria-busy.
    expect(last()).toMatchObject({ turns: [], loading: true });
    // Every way out of the load clears the busy state: a failure, no turns, the turns.
    m.__set('_panelTurnsLoading', false);
    m.__set('_panelTurnsMsg', 'failed');
    m.__set('_panelTurnsWhy', 'HTTP 500');
    m.convPaint();
    expect(last()).toMatchObject({ loading: false, error: 'HTTP 500' });
    m.__set('_panelTurnsMsg', 'none');
    m.convPaint();
    expect(last()).toMatchObject({ loading: false, emptyText: '아직 대화가 없습니다' });
    expect(last()).not.toHaveProperty('error');
    m.__set('_panelTurnsList', [{ id: 't1' }, { id: 't2' }]);
    m.__set('_panelTurnsMsg', '');
    m.convPaint();
    expect(last()).toMatchObject({
      loading: false,
      turns: [
        { id: 't1', role: 'user' },
        { id: 't2', role: 'user' },
      ],
    });
    // The inline skeleton renderer and its styles are gone (the element's own skeleton turns).
    expect(TEMPLATE).not.toMatch(/\nfunction turnsSkeletonHtml\(/);
    expect(TEMPLATE).not.toContain('.sk-turn');
  });
});

describe('[T3] expanded card — 지시/응답 skeleton instead of a "불러오는 중…" line', () => {
  type Io = { renderCardIo(s: unknown): string; _state: { _ioCache: Record<string, unknown> } };
  it('while the first answer is in flight: busy, skeleton lines, the words kept for screen readers', () => {
    const m = load<Io>(['renderCardIo'], ['_ioCache']);
    const html = m.renderCardIo({ conversationId: 'c1' });
    expect(html).toContain('<div class="card-io" aria-busy="true">');
    expect(html).toContain('class="io-row io-skel" aria-hidden="true"');
    // D7 (K-02, A-18): the lines are the kit's skeleton (.ui-skeleton.is-line, the second row staggered with --i),
    // the words the kit's visually-hidden class.
    expect((html.match(/class="ui-skeleton is-line"/g) ?? []).length).toBe(4);
    expect((html.match(/--i:1/g) ?? []).length).toBe(2);
    expect(html).not.toContain('class="sk ');
    expect(html).toContain('<span class="ui-sr-only">지시/응답 불러오는 중…</span>');
    expect(html).not.toContain('io-text is-muted">지시/응답 불러오는 중');
  });

  it('a failed first answer still says so in words (no skeleton)', () => {
    const m = load<Io>(['renderCardIo'], ['_ioCache']);
    m._state._ioCache.c1 = { state: 'error', data: null };
    const html = m.renderCardIo({ conversationId: 'c1' });
    expect(html).toContain('지시/응답을 불러오지 못했습니다');
    expect(html).not.toContain('sk-line');
    expect(html).not.toContain('aria-busy');
  });
});

describe('[T3] skeleton motion and accessibility', () => {
  // D7 (K-02): the pulse is the kit's (.ui-skeleton in ui-kit.css: opacity only, --i staggers, still under reduced
  // motion); the page keeps no skeleton rule or keyframe of its own.
  const KIT = uiLibKitCss();

  it('the pulse is compositor-only (opacity) and staggered — the kit’s', () => {
    expect(CSS).not.toContain('@keyframes sk-pulse');
    expect(CSS).not.toMatch(/^\.sk \{/m);
    expect(CSS).not.toContain('.sk-line');
    const kf = between(KIT, '@keyframes ui-sk-pulse', '}\n');
    expect(kf).toContain('opacity');
    expect(kf).not.toMatch(/background|width|height|transform/);
    expect(KIT).toMatch(
      /\.ui-skeleton \{[^}]*animation: ui-sk-pulse 1\.6s ease-in-out infinite; animation-delay: calc\(var\(--i, 0\) \* 120ms\);/,
    );
  });

  it('reduced motion: a still skeleton — the kit’s rule', () => {
    const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? [];
    expect(blocks.some((b) => /\.sk\b/.test(b))).toBe(false);
    const kitReduced = KIT.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? [];
    expect(kitReduced.some((b) => /\.ui-skeleton[^{]*\{ animation: none; \}/.test(b))).toBe(true);
  });

  // Deleted: 'skeletons show only while the board is loading, and only in columns with no cards yet' — library 'load: loading draws skeletons with no counts or empty hints; failed keeps cards and makes no claims'.
  // Deleted: 'counts and "Nothing here" are claims about the whole board: only a certified (ready) board shows them (#482)' — library 'load: loading draws skeletons with no counts or empty hints; failed keeps cards and makes no claims'.
});
