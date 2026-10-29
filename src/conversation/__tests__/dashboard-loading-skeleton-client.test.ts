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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, extra: string[] = []): T {
  const names = Object.keys(inject);
  const extraNames = extra.map((src) => /^function (\w+)/.exec(src)?.[1] ?? '').filter(Boolean);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${extra.join('\n')}\nreturn { ${[...fns, ...extraNames].join(', ')}, get _state() { return { ${vars.join(', ')} }; } };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
/** The page markup as served (between <body> and the first <script>). */
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
/** The page CSS as served (the first <style> block). */
const CSS = cook(TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>')));

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
function boardFlow(cardOf?: (s: { key: string }, col: string) => unknown) {
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
      'placeCard',
      'renderBoard',
      ...BOARD_FNS,
    ],
    ['BOARD_LABELS', '_cardHost', '_cardCol', '_cardData', '_cardDrawn', '_cardClosing', '_boardRenders', '_boardLoad'],
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
    expect(inbox).toContain('<ui-agent-inbox id="kanban" class="kanban" view="board"></ui-agent-inbox>');
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
      ['waiting', 'NEEDS YOU', []],
      ['working', 'RUNNING', []],
      ['done', 'DONE', []],
    ]);
  });

  // Deleted: 'each column carries card-shaped skeletons, hidden from assistive tech' — library 'load: loading draws skeletons with no counts or empty hints; failed keeps cards and makes no claims'.
  // Deleted: 'no false empty state: no "0" count and no "Nothing here" before data' — library 'load: loading draws skeletons with no counts or empty hints; failed keeps cards and makes no claims'.

  it('a board-wide error with 다시 시도 exists, hidden until a first load fails', () => {
    const err = between(PAGE, '<div class="board-error" id="board-error"', '</div>');
    expect(err).toContain('role="alert"');
    expect(err).toContain('hidden');
    expect(err).toContain('onclick="retryBoardLoad()"');
    expect(err).toContain('다시 시도');
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
  const STAT_IDS = [
    'stat-sessions',
    'stat-tokens',
    'stat-cost',
    'stat-turns',
    'stat-prs',
    'stat-merged',
    'stat-merge-lines',
  ];

  it('every stat value is served loading, without a "-" placeholder', () => {
    for (const id of STAT_IDS) {
      const m = PAGE.match(new RegExp(`<[^>]*id="${id}"[^>]*>([^<]*)<`));
      expect(m, id).not.toBeNull();
      expect(m?.[0], id).toContain('is-loading');
      expect(m?.[1], id).toBe('');
    }
    expect(PAGE).toMatch(
      /id="stat-workflows"[^>]*class="[^"]*is-loading|class="[^"]*is-loading[^"]*"[^>]*id="stat-workflows"/,
    );
  });

  it('setStat ends the loading bar for that value', () => {
    const d = fakeDocument(['stat-sessions']);
    d.byId['stat-sessions'].classes.add('is-loading');
    const m = load<{ setStat(id: string, t: string): void }>(['setStat'], [], { document: d.document });
    m.setStat('stat-sessions', '12');
    expect(d.byId['stat-sessions'].textContent).toBe('12');
    expect(d.byId['stat-sessions'].classes.has('is-loading')).toBe(false);
  });

  it('every stats load (first load, period, user) shows bars until its answer lands', () => {
    const body = clientFn('loadStats');
    expect(body).toContain('markStatsLoading();');
    expect(body.indexOf('markStatsLoading();')).toBeLessThan(body.indexOf('statsJson('));
    const d = fakeDocument([
      'stat-sessions',
      'stat-tokens',
      'stat-cost',
      'stat-turns',
      'stat-prs',
      'stat-merged',
      'stat-merge-lines',
      'stat-workflows',
      'chart-row',
    ]);
    const m = load<{ markStatsLoading(): void }>(['markStatsLoading'], ['STAT_IDS'], { document: d.document });
    m.markStatsLoading();
    for (const id of [...STAT_IDS, 'stat-workflows']) {
      expect(d.byId[id].classes.has('is-loading'), id).toBe(true);
      expect(d.byId[id].textContent, id).toBe('');
    }
  });

  it('paintStats ends the workflows and chart bars', () => {
    const body = clientFn('paintStats');
    expect(body).toMatch(/stat-workflows'\);[\s\S]*classList\.remove\('is-loading'\)/);
    expect(body).toMatch(/chart-row[\s\S]*classList\.remove\('is-loading'\)/);
  });

  it('stats no longer wait for the board: both start at init', () => {
    const init = TEMPLATE.slice(TEMPLATE.lastIndexOf('// ── Init ──'));
    expect(init).not.toContain('loadSessions().then(function() { loadStats(); });');
    expect(init).toMatch(/\nloadSessions\(\);\nloadStats\(\);\n/);
  });
});

describe('[T3] session panel — turn-shaped skeleton instead of "Loading..."', () => {
  it('openPanel no longer prints "Loading..."; 지시와 답변 shows turn skeletons and marks the list busy until the turns land', () => {
    const body = clientFn('openPanel');
    expect(body).not.toContain('Loading...');
    // SSOT 2026-10-29: the opening marks 지시와 답변's data as loading; the tab paints from it (paintConvTab).
    expect(body).toContain("_panelTurnsMsg = s.conversationId ? 'loading' : 'unrecorded';");
    const attrs: Record<string, string> = {};
    const turnsEl = {
      innerHTML: '',
      hidden: false,
      firstChild: null,
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      removeAttribute: (k: string) => {
        delete attrs[k];
      },
    };
    const host = { innerHTML: '', firstChild: null, hidden: false, _html: '' };
    const m = load<{ paintConvTab(): void; __set(n: string, v: unknown): void }>(
      ['turnsSkeletonHtml', 'paintConvTab'],
      ['PANEL_TURNS_MSG'],
      {
        document: {
          getElementById: (id: string) => (id === 'panel-turns' ? turnsEl : id === 'panel-agent-conv' ? host : null),
        },
        _psec: 'conv',
        _panelAgent: '',
        _ansIo: null,
        _panelTurnsList: [] as unknown[],
        _panelTurnsCid: 'c',
        _panelTurnsMsg: 'loading',
        esc: (x: string) => x,
        renderTurn: (t: { id: string }) => `<div class="turn" data-turn-id="${t.id}"></div>`,
        attachRawToggleHandlers: () => {},
        decoratePanelTurns: () => {},
      },
      ['function __set(n, v) { eval(n + " = v"); }'],
    );
    m.paintConvTab();
    expect(turnsEl.innerHTML).toContain('sk-turn');
    expect(attrs['aria-busy']).toBe('true');
    // Every way out of the load clears the busy state: a failure, no turns, the turns.
    m.__set('_panelTurnsMsg', 'failed');
    m.paintConvTab();
    expect(turnsEl.innerHTML).toContain('Failed to load conversation');
    expect(attrs['aria-busy']).toBeUndefined();
    m.__set('_panelTurnsMsg', 'loading');
    m.paintConvTab();
    m.__set('_panelTurnsMsg', 'none');
    m.paintConvTab();
    expect(turnsEl.innerHTML).toContain('No conversation turns');
    expect(attrs['aria-busy']).toBeUndefined();
    m.__set('_panelTurnsMsg', 'loading');
    m.paintConvTab();
    m.__set('_panelTurnsList', [{ id: 't1' }, { id: 't2' }]);
    m.__set('_panelTurnsMsg', '');
    m.paintConvTab();
    expect(turnsEl.innerHTML).toBe(
      '<div class="turn" data-turn-id="t1"></div><div class="turn" data-turn-id="t2"></div>',
    );
    expect(attrs['aria-busy']).toBeUndefined();
  });

  it('turnsSkeletonHtml: aria-hidden rows shaped like user / assistant turns', () => {
    const m = load<{ turnsSkeletonHtml(): string }>(['turnsSkeletonHtml'], []);
    const html = m.turnsSkeletonHtml();
    expect(html).toContain('aria-hidden="true"');
    expect((html.match(/class="sk-turn( |")/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('sk-turn user');
    expect(html).toContain('sk-turn assistant');
  });
});

describe('[T3] expanded card — 지시/응답 skeleton instead of a "불러오는 중…" line', () => {
  type Io = { renderCardIo(s: unknown): string; _state: { _ioCache: Record<string, unknown> } };
  it('while the first answer is in flight: busy, skeleton lines, the words kept for screen readers', () => {
    const m = load<Io>(['renderCardIo'], ['_ioCache']);
    const html = m.renderCardIo({ conversationId: 'c1' });
    expect(html).toContain('<div class="card-io" aria-busy="true">');
    expect(html).toContain('class="io-row io-skel" aria-hidden="true"');
    expect((html.match(/class="sk sk-line"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<span class="ib-sr">지시/응답 불러오는 중…</span>');
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
  it('the pulse is compositor-only (opacity) and staggered', () => {
    const kf = between(CSS, '@keyframes sk-pulse', '}\n');
    expect(kf).toContain('opacity');
    expect(kf).not.toMatch(/background|width|height|transform/);
    expect(CSS).toMatch(/\.sk \{[^}]*animation: sk-pulse/);
  });

  it('reduced motion: a still skeleton', () => {
    const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? [];
    expect(blocks.some((b) => /\.sk\b[^{]*\{[^}]*animation: none !important/.test(b))).toBe(true);
  });

  // Deleted: 'skeletons show only while the board is loading, and only in columns with no cards yet' — library 'load: loading draws skeletons with no counts or empty hints; failed keeps cards and makes no claims'.
  // Deleted: 'counts and "Nothing here" are claims about the whole board: only a certified (ready) board shows them (#482)' — library 'load: loading draws skeletons with no counts or empty hints; failed keeps cards and makes no claims'.
});
