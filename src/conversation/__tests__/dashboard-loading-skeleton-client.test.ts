/**
 * Dashboard loading states — skeletons instead of a false empty board.
 *
 * Before the first board answer the page used to say "0 · Nothing here" in all
 * three columns and "-" in the stats strip, then cards popped in. These tests
 * pin the loading contract (ssot-task IDs in brackets):
 *
 *   [T2] the board shows card-shaped skeletons, no count and no empty hint until
 *        the first board paints; the stats strip shows skeleton bars, not "-"
 *   [T2] the skeleton is first-load only — a background poll never brings it back
 *   [T2] stats start in parallel with the board, not after it
 *   [T3] a failed first load stops the skeleton and offers 다시 시도
 *   [T3] the session panel shows turn-shaped skeleton rows, not "Loading..."
 *   [T3] reduced motion: a still skeleton; skeleton nodes are aria-hidden
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
function column(id: 'waiting' | 'working' | 'done'): string {
  const start = PAGE.indexOf(`<section class="kanban-col" id="col-${id}"`);
  if (start < 0) throw new Error(`column ${id} not found`);
  return PAGE.slice(start, PAGE.indexOf('</section>', start));
}

// ── Fake DOM ──
type FakeEl = {
  id?: string;
  hidden: boolean;
  textContent: string;
  innerHTML: string;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  classes: Set<string>;
  removed: boolean;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  remove(): void;
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
    dataset: {},
    attrs: {},
    classes: new Set(classes),
    removed: false,
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    remove() {
      this.removed = true;
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
function fakeDocument(ids: string[], skeletons = 3) {
  const byId: Record<string, FakeEl> = {};
  for (const id of ids) byId[id] = el(id);
  const skels = Array.from({ length: skeletons }, () => el(undefined, ['col-skel']));
  const statLoading = ['stat-sessions', 'stat-tokens', 'stat-cost'].map((id) => byId[id]).filter(Boolean);
  return {
    byId,
    skels,
    document: {
      getElementById: (id: string) => byId[id] ?? null,
      querySelectorAll: (sel: string) => {
        if (sel === '.col-skel') return skels.filter((s) => !s.removed);
        if (sel.includes('is-loading')) return statLoading.filter((s) => s.classes.has('is-loading'));
        return [];
      },
    },
  };
}

const BOARD_FNS = ['setBoardLoad', 'retryBoardLoad'];

describe('[T2] board — skeleton until the first board paints', () => {
  it('the served board starts loading: aria-busy, data-load="loading"', () => {
    const kanban = between(PAGE, '<div class="kanban" id="kanban"', '>');
    expect(kanban).toContain('data-load="loading"');
    expect(kanban).toContain('aria-busy="true"');
  });

  it('each column carries card-shaped skeletons, hidden from assistive tech', () => {
    for (const id of ['waiting', 'working', 'done'] as const) {
      const col = column(id);
      const skel = between(col, '<div class="col-skel"', '</div>\n');
      expect(skel, id).toContain('aria-hidden="true"');
      expect((col.match(/class="sk-card"/g) ?? []).length, id).toBeGreaterThanOrEqual(2);
    }
  });

  it('no false empty state: no "0" count and no "Nothing here" before data', () => {
    for (const id of ['waiting', 'working', 'done'] as const) {
      const col = column(id);
      expect(col, id).toContain(`<span class="count" id="count-${id}"></span>`);
      expect(col, id).not.toContain(`id="count-${id}">0<`);
      // The hint is still in the page (a loaded, empty column says it), just hidden.
      expect(col, id).toContain(`<div class="col-empty" id="empty-${id}" hidden>Nothing here</div>`);
    }
  });

  it('a board-wide error with 다시 시도 exists, hidden until a first load fails', () => {
    const err = between(PAGE, '<div class="board-error" id="board-error"', '</div>');
    expect(err).toContain('role="alert"');
    expect(err).toContain('hidden');
    expect(err).toContain('onclick="retryBoardLoad()"');
    expect(err).toContain('다시 시도');
    // Inside the inbox, right before the columns.
    expect(PAGE.indexOf('id="board-error"')).toBeGreaterThan(PAGE.indexOf('<section class="inbox" id="inbox"'));
    expect(PAGE.indexOf('id="board-error"')).toBeLessThan(PAGE.indexOf('<div class="kanban" id="kanban"'));
  });

  it('setBoardLoad("ready") ends the busy state and hides the error', () => {
    const d = fakeDocument(['kanban', 'board-error']);
    const m = load<{ setBoardLoad(s: string): void; _state: { _boardLoad: string } }>(BOARD_FNS, ['_boardLoad'], {
      document: d.document,
      loadSessions: () => {},
    });
    expect(m._state._boardLoad).toBe('loading');
    m.setBoardLoad('failed');
    expect(d.byId['board-error'].hidden).toBe(false);
    m.setBoardLoad('ready');
    expect(m._state._boardLoad).toBe('ready');
    expect(d.byId.kanban.dataset.load).toBe('ready');
    expect(d.byId.kanban.attrs['aria-busy']).toBe('false');
    expect(d.byId['board-error'].hidden).toBe(true);
  });

  it('first load only: once ready, nothing brings the skeleton or the error back', () => {
    const d = fakeDocument(['kanban', 'board-error']);
    const m = load<{ setBoardLoad(s: string): void; _state: { _boardLoad: string } }>(BOARD_FNS, ['_boardLoad'], {
      document: d.document,
      loadSessions: () => {},
    });
    m.setBoardLoad('ready');
    m.setBoardLoad('loading');
    m.setBoardLoad('failed');
    expect(m._state._boardLoad).toBe('ready');
    expect(d.byId.kanban.dataset.load).toBe('ready');
    expect(d.byId['board-error'].hidden).toBe(true);
  });

  it('renderBoard drops the skeleton nodes after the reconciler; only a poll answer latches ready', () => {
    const body = clientFn('renderBoard');
    const drop = "document.querySelectorAll('.col-skel').forEach(function(n) { n.remove(); });";
    expect(body).toContain(drop);
    // After the reconciler has drawn real cards: a render that throws on the way leaves
    // the skeleton, and loadSessions' catch shows 다시 시도 (review R1, fable P2).
    expect(body.indexOf(drop)).toBeGreaterThan(body.indexOf('reconcileBoard('));
    // A WebSocket push is this instance's cards only — it never certifies the board (review R2).
    expect(body).not.toContain('setBoardLoad(');
    const ls = clientFn('loadSessions');
    expect(ls.indexOf("setBoardLoad('ready');")).toBeGreaterThan(ls.indexOf('renderBoard(data.board);'));
    // A loaded, empty column still says it.
    expect(clientFn('reconcileBoard')).toContain('if (empty && empty.hidden !== has) empty.hidden = has;');
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
    }>(['loadSessions', ...BOARD_FNS], ['_boardLoad', '_heldWsBoard'], {
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
    });
    return { d, m, renderBoard };
  }

  it('network error on the first load → failed: error shown, skeleton stopped', async () => {
    const { d, m } = loadSessionsWith(() => Promise.reject(new Error('offline')));
    await m.loadSessions();
    expect(m._state._boardLoad).toBe('failed');
    expect(d.byId.kanban.dataset.load).toBe('failed');
    expect(d.byId.kanban.attrs['aria-busy']).toBe('false');
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
    fail = false;
    m.retryBoardLoad();
    expect(m._state._boardLoad).toBe('loading');
    expect(d.byId.kanban.dataset.load).toBe('loading');
    expect(d.byId.kanban.attrs['aria-busy']).toBe('true');
    expect(d.byId['board-error'].hidden).toBe(true);
    await vi.waitFor(() => expect(renderBoard).toHaveBeenCalledWith(board));
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
      ['_boardLoad', '_heldWsBoard'],
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

  it('slow polls never starve each other: overlapping same-user polls all paint (review R2)', async () => {
    const answers: Array<(v: unknown) => void> = [];
    const { m, painted } = harness(() => new Promise((r) => answers.push(r)));
    // Three 30 s polls start before the first (40 s) answer lands.
    const loads = [m.loadSessions(), m.loadSessions(), m.loadSessions()];
    answers[0](ok(board('p1')));
    await loads[0];
    expect(painted).toEqual([board('p1')]);
    expect(m._state._boardLoad).toBe('ready');
    answers[1](ok(board('p2')));
    answers[2](ok(board('p3')));
    await Promise.all(loads);
    expect(painted).toHaveLength(3);
  });

  it('ws.onmessage goes through paintPushedBoard', () => {
    const ws = TEMPLATE.slice(TEMPLATE.indexOf('ws.onmessage = function(ev) {'));
    const branch = ws.slice(0, ws.indexOf('renderPanelPermission(panelS);'));
    expect(branch).toContain('if (!paintPushedBoard(msg.board)) return;');
    expect(branch).not.toContain('renderBoard(mergeSiblingCards(msg.board));');
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
  it('openPanel no longer prints "Loading..."; it shows turn skeletons and marks the list busy', () => {
    const body = clientFn('openPanel');
    expect(body).not.toContain('Loading...');
    expect(body).toContain('turnsEl.innerHTML = turnsSkeletonHtml();');
    expect(body).toContain("turnsEl.setAttribute('aria-busy', 'true');");
    // Every way out of the load clears the busy state.
    expect((body.match(/turnsEl\.removeAttribute\('aria-busy'\);/g) ?? []).length).toBeGreaterThanOrEqual(3);
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

  it('skeletons show only while the board is loading', () => {
    expect(CSS).toMatch(/\.kanban:not\(\[data-load="loading"\]\) \.col-skel \{ display: none; \}/);
  });
});
