/**
 * E4 ⑨c (#725, .prd/19 D11) — an epic's children right under its card, client side.
 * The global EPIC lane above the board is gone. Executes the shipped client code cut out
 * of renderDashboardPage()'s template literal, cooked as the browser receives it, with
 * injected fakes — no DOM. (renderBoard itself is run in dashboard-affectui-agent-inbox-client.)
 *
 *   N1 withEpicChildren: each epic's children right after its card, each in its own
 *      activity as its column; other cards, and an epic without a bundle, unchanged.
 *   L2 a child's card reads its own activity as its column; a sleeping child is closed.
 *   N2 a push whose children differ from the ones last placed redraws the board; the same
 *      children refresh in place; nothing drawn, nothing redrawn; a panel finds a child.
 *   N3 the epic's plan tree is in its open card: the element, its data from epicPlanData.
 *   L9 the plan tree's data: issues as steps, subs nested, accepted is done, a note per status.
 *   L7 the epic's own card leads with EPIC; a child's card leads with ↳ #node.
 *   N4 the page: no lane is left (markup, CSS, code, layout hosts); renderBoard places the
 *      children through withEpicChildren in every list and records them for the push.
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
  const n = (TEMPLATE.match(new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm')) ?? []).length;
  if (n !== 1) throw new Error(`client ${name} is declared ${n} times`);
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, seam = ''): T {
  const names = Object.keys(inject);
  const seamName = /^function (\w+)/.exec(seam)?.[1];
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${seam}\nreturn { ${[...fns, ...(seamName ? [seamName] : [])].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const EPIC_VARS = ['EPIC_STATE_LABEL', 'EPIC_NODE_STEP', 'EPIC_NODE_NOTE'];
const ESC = ['esc', 'escAttr', 'toNum'];

const child = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  title: key,
  parentTaskId: 'e',
  activityState: 'idle',
  sessionState: 'MAIN',
  ...over,
});
const epicCard = (key: string, state: string, children: unknown[], over: Record<string, unknown> = {}) => ({
  key,
  title: `Epic ${key}`,
  kind: 'epic',
  epic: { state, progress: { accepted: 1, total: 3, byStatus: {} }, nodes: [], children },
  ...over,
});

describe('N1, L2 — the children after their epic, each in its own column', () => {
  const m = load<{
    withEpicChildren(
      items: Array<{ s: unknown; col: string }>,
      hideSleeping?: boolean,
      revealKey?: string | null,
    ): Array<{ s: { key: string }; col: string }>;
    epicChildrenOf(s: unknown): Array<{ key: string }>;
    epicKidsShown(s: unknown, hideSleeping?: boolean, revealKey?: string | null): Array<{ key: string }>;
    epicKidsSig(s: unknown, hideSleeping?: boolean, revealKey?: string | null): string;
    epicKidsCounts(board: unknown): { needs: number; running: number; sleeping: number };
    epicChildCol(c: unknown): string;
  }>(['epicChildCol', 'epicChildrenOf', 'epicKidsShown', 'epicKidsSig', 'epicKidsCounts', 'withEpicChildren'], []);
  const keysCols = (items: Array<{ s: { key: string }; col: string }>) => items.map((it) => [it.s.key, it.col]);

  it('N1 — an epic is followed by its children; plain cards and a bundle-less epic are left as they are', () => {
    const items = [
      { s: { key: 'p1' }, col: 'working' },
      {
        s: epicCard('E', 'running', [
          child('c1', { activityState: 'working' }),
          child('c2', { activityState: 'waiting' }),
          child('c3', { sessionState: 'SLEEPING' }),
        ]),
        col: 'working',
      },
      { s: { key: 'p2' }, col: 'working' },
      { s: { key: 'E2', kind: 'epic' }, col: 'working' },
    ];
    expect(keysCols(m.withEpicChildren(items))).toEqual([
      ['p1', 'working'],
      ['E', 'working'],
      ['c1', 'working'],
      ['c2', 'waiting'],
      ['c3', 'closed'],
      ['p2', 'working'],
      ['E2', 'working'],
    ]);
    // The child item carries the very card from the bundle (cardOf draws it as anywhere).
    expect(m.withEpicChildren([items[1]])[1].s).toBe((items[1].s as any).epic.children[0]);
    expect(m.withEpicChildren([])).toEqual([]);
  });

  it('N1 — only an epic’s bundle counts: a non-epic card with a bundle, a child without a key, no bundle', () => {
    expect(m.epicChildrenOf({ key: 'x', epic: { children: [child('c')] } })).toEqual([]);
    expect(
      m.epicChildrenOf(epicCard('E', 'running', [null, { title: 'no key' }, child('c')])).map((c) => c.key),
    ).toEqual(['c']);
    expect(m.epicChildrenOf({ key: 'E', kind: 'epic', epic: { state: 'idle' } })).toEqual([]);
    expect(m.epicChildrenOf(undefined)).toEqual([]);
    expect(m.epicChildrenOf({ key: 'E', kind: 'epic', epic: { children: 'bad' } })).toEqual([]);
  });

  it('N1 — 휴면 hidden: a sleeping child is not drawn under its epic, unless a deep link revealed it', () => {
    const e = epicCard('E', 'running', [child('c1'), child('zz', { sessionState: 'SLEEPING' })]);
    const items = [{ s: e, col: 'working' }];
    expect(keysCols(m.withEpicChildren(items, true))).toEqual([
      ['E', 'working'],
      ['c1', 'idle'],
    ]);
    expect(keysCols(m.withEpicChildren(items, true, 'zz')).map((x) => x[0])).toEqual(['E', 'c1', 'zz']);
    expect(keysCols(m.withEpicChildren(items, false)).map((x) => x[0])).toEqual(['E', 'c1', 'zz']);
    expect(m.epicKidsShown(e, true, 'other').map((c) => c.key)).toEqual(['c1']);
  });

  it('N1 — the signature: each shown child and its column, in order; the same filter as the drawing', () => {
    const e = epicCard('E', 'running', [
      child('c1', { activityState: 'working' }),
      child('c2', { activityState: 'waiting' }),
      child('zz', { sessionState: 'SLEEPING' }),
    ]);
    expect(m.epicKidsSig(e)).toBe('c1:working c2:waiting zz:closed');
    expect(m.epicKidsSig(e, true)).toBe('c1:working c2:waiting');
    expect(m.epicKidsSig({ key: 'p' })).toBe('');
  });

  it('N1 — the announcement counts: children that wait, run and sleep, from every column’s epics', () => {
    const board = {
      working: [
        epicCard('E1', 'running', [child('a', { activityState: 'working' }), child('b', { activityState: 'waiting' })]),
      ],
      waiting: [epicCard('E2', 'needs-input', [child('c', { activityState: 'waiting' })])],
      idle: [epicCard('E3', 'done', [child('d'), child('e', { sessionState: 'SLEEPING' })]), { key: 'plain' }],
    };
    expect(m.epicKidsCounts(board)).toEqual({ needs: 2, running: 1, sleeping: 1 });
    expect(m.epicKidsCounts({})).toEqual({ needs: 0, running: 0, sleeping: 0 });
  });

  it('L2 — a child reads its own activity; a sleeping one is closed', () => {
    expect(m.epicChildCol(child('a', { activityState: 'working' }))).toBe('working');
    expect(m.epicChildCol(child('a', { activityState: 'waiting' }))).toBe('waiting');
    expect(m.epicChildCol(child('a'))).toBe('idle');
    expect(m.epicChildCol(child('a', { activityState: 'working', sessionState: 'SLEEPING' }))).toBe('closed');
  });
});

describe('N2 — the push path', () => {
  function pushHarness() {
    const calls = { boards: [] as unknown[], refreshed: [] as string[] };
    const state = {
      _sessionCache: Object.create(null) as Record<string, unknown>,
      _epicKidsDrawn: Object.create(null) as Record<string, string>,
      _cardHost: Object.create(null) as Record<string, unknown>,
    };
    const m = load<{
      applyEpicPush(s: unknown): void;
      epicChildOf(s: unknown, key: string): unknown;
      setBoard(b: unknown): void;
    }>(
      ['epicChildCol', 'epicChildrenOf', 'epicKidsShown', 'epicKidsSig', 'applyEpicPush', 'epicChildOf'],
      [],
      {
        ...state,
        showSleeping: true,
        _revealedKey: null,
        renderBoard: (b: unknown) => calls.boards.push(b),
        refreshCard: (k: string) => calls.refreshed.push(k),
        _lastBoardData: null,
      },
      'function setBoard(b) { _lastBoardData = b; }',
    );
    return { m, calls, state };
  }

  it('caches the children even with no board yet, and draws nothing then', () => {
    const h = pushHarness();
    const c = child('task:c1');
    h.m.applyEpicPush(epicCard('task:e', 'running', [c]));
    expect(h.state._sessionCache['task:c1']).toBe(c);
    expect(h.calls.boards).toHaveLength(0);
    expect(h.calls.refreshed).toHaveLength(0);
  });

  it('children not the ones last placed under the epic: the board is redrawn from the patched data', () => {
    const h = pushHarness();
    const board = { working: [] };
    h.m.setBoard(board);
    // A first child: the epic was placed with none.
    h.state._epicKidsDrawn['task:e'] = '';
    h.state._cardHost['task:e'] = {};
    h.m.applyEpicPush(epicCard('task:e', 'running', [child('task:c1')]));
    expect(h.calls.boards).toEqual([board]);
    // A child that left (closed): redrawn too.
    h.state._epicKidsDrawn['task:e'] = 'task:c1:idle task:c2:idle';
    h.m.applyEpicPush(epicCard('task:e', 'running', [child('task:c1')]));
    expect(h.calls.boards).toHaveLength(2);
    // The epic's card comes back with no bundle (closed): its children go, redrawn.
    h.m.applyEpicPush({ key: 'task:e', kind: 'epic' });
    expect(h.calls.boards).toHaveLength(3);
    expect(h.calls.refreshed).toHaveLength(0);
  });

  it('the same children in the same columns: each child card on the board refreshes in place, no redraw', () => {
    const h = pushHarness();
    h.m.setBoard({});
    h.state._epicKidsDrawn['task:e'] = 'task:c1:working task:c2:idle';
    h.state._cardHost['task:e'] = {};
    h.state._cardHost['task:c1'] = {};
    const fresh = child('task:c1', { activityState: 'working', title: 'new title' });
    h.m.applyEpicPush(epicCard('task:e', 'running', [fresh, child('task:c2')]));
    expect(h.calls.boards).toHaveLength(0);
    // Only a child with a host (placed by the last render) refreshes; c2 has none here.
    expect(h.calls.refreshed).toEqual(['task:c1']);
    // The refresh reads the pushed card (cached first).
    expect(h.state._sessionCache['task:c1']).toBe(fresh);
  });

  it('a child whose column changed (working → waiting, → sleeping) redraws — its face is drawn with its new column', () => {
    const h = pushHarness();
    h.m.setBoard({});
    h.state._epicKidsDrawn['task:e'] = 'task:c1:working';
    h.state._cardHost['task:e'] = {};
    h.state._cardHost['task:c1'] = {};
    h.m.applyEpicPush(epicCard('task:e', 'running', [child('task:c1', { activityState: 'waiting' })]));
    expect(h.calls.boards).toHaveLength(1);
    h.m.applyEpicPush(epicCard('task:e', 'running', [child('task:c1', { sessionState: 'SLEEPING' })]));
    expect(h.calls.boards).toHaveLength(2);
    expect(h.calls.refreshed).toHaveLength(0);
  });

  it('an epic the last render did not place, and a plain card: nothing redrawn', () => {
    const h = pushHarness();
    h.m.setBoard({});
    // Hidden (sleeping, toggle off) or not on this board: no host, nothing placed.
    h.m.applyEpicPush(epicCard('task:hidden', 'running', [child('task:c9')]));
    h.m.applyEpicPush({ key: 'task:plain' });
    h.m.applyEpicPush(null);
    h.m.applyEpicPush({});
    expect(h.calls.boards).toHaveLength(0);
    expect(h.calls.refreshed).toHaveLength(0);
    // Drawn but not yet recorded (the push races the first render): redrawn.
    h.state._cardHost['task:new'] = {};
    h.m.applyEpicPush(epicCard('task:new', 'running', [child('task:c8')]));
    expect(h.calls.boards).toHaveLength(1);
  });

  it('a panel open on a child finds it in the epic’s pushed card', () => {
    const h = pushHarness();
    const pushed = epicCard('task:e', 'running', [child('task:c1'), child('task:c2')]);
    expect(h.m.epicChildOf(pushed, 'task:c2')).toMatchObject({ key: 'task:c2' });
    expect(h.m.epicChildOf(pushed, 'task:none')).toBeNull();
    expect(h.m.epicChildOf({ key: 'task:p' }, 'task:c2')).toBeNull();
  });
});

describe('N3, L9 — the plan tree, now in the epic’s open card', () => {
  const m = load<{
    renderEpicPlan(s: unknown): string;
    epicPlanData(s: unknown): { steps: Array<Record<string, any>> };
  }>([...ESC, 'epicStateOf', 'epicPlanStep', 'epicPlanData', 'renderEpicPlan'], EPIC_VARS);
  const node = (id: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `T ${id}`,
    kind: 'issue',
    status,
    accepted: false,
    childTaskIds: [],
    ...over,
  });

  it('N3 — an epic with a plan gets the element, keyed by its card; no plan or no epic, nothing', () => {
    const e = epicCard('task:"e"', 'running', []);
    (e.epic as any).nodes = [node('login', 'running')];
    expect(m.renderEpicPlan(e)).toBe(
      '<ui-task-plan class="card-task-plan epic-plan" lang="ko" flush foot="none" data-epic-plan-key="task:&quot;e&quot;"></ui-task-plan>',
    );
    expect(m.renderEpicPlan(epicCard('task:e', 'running', []))).toBe('');
    expect(m.renderEpicPlan({ key: 'task:p', epic: { nodes: [node('x', 'none')] } })).toBe('');
    expect(m.renderEpicPlan({ key: 'task:e', kind: 'epic' })).toBe('');
    expect(m.renderEpicPlan(null)).toBe('');
  });

  it('N3 — the open card hydrates the element with the epic’s plan; the body puts it after the needs', () => {
    const datas: Array<[unknown, unknown]> = [];
    const plan = { getAttribute: (k: string) => (k === 'data-epic-plan-key' ? 'task:e' : null) };
    const e = epicCard('task:e', 'running', []);
    (e.epic as any).nodes = [node('login', 'running')];
    const { cardTaskPlanHydrate } = load<{ cardTaskPlanHydrate(root: unknown): void }>(
      [...ESC, 'epicStateOf', 'epicPlanStep', 'epicPlanData', 'cardTaskPlanHydrate'],
      EPIC_VARS,
      {
        _sessionCache: { 'task:e': e },
        taskElData: (el: unknown, d: unknown) => datas.push([el, d]),
        cardTaskPlanData: () => ({}),
      },
    );
    cardTaskPlanHydrate({
      querySelectorAll: (sel: string) => (sel === 'ui-task-plan[data-epic-plan-key]' ? [plan] : []),
    });
    expect(datas).toEqual([[plan, { steps: [{ id: 'login', label: 'T login', ref: '#login', status: 'running' }] }]]);
    const body = clientFn('renderCardBody');
    expect(body).toContain("return '<div class=\"card-body\">' + needsHtml + renderEpicPlan(s) + rest + '</div>';");
  });

  it('L9 — issues are steps, subs nest under their issue; accepted is done; each status as a step with a short note', () => {
    const data = m.epicPlanData({
      epic: {
        nodes: [
          node('login', 'running'),
          node('login-test', 'finished', { kind: 'sub', parent: 'login' }),
          node('docs', 'finished', { accepted: true }),
          node('api', 'needs-input'),
          node('ops', 'failed'),
          node('old', 'cancelled'),
          node('net', 'interrupted'),
          node('gone', 'closed'),
          node('next', 'none'),
          node('lost-sub', 'none', { kind: 'sub', parent: 'missing' }),
        ],
      },
    });
    expect(data.steps.map((st) => [st.id, st.status, st.note])).toEqual([
      ['login', 'running', undefined],
      ['docs', 'done', undefined],
      ['api', 'paused', '입력 필요'],
      ['ops', 'failed', undefined],
      ['old', 'dropped', undefined],
      ['net', 'paused', '끊김'],
      ['gone', 'skipped', '닫힘'],
      ['next', 'pending', undefined],
      // A sub whose issue is gone still shows, at the top.
      ['lost-sub', 'pending', undefined],
    ]);
    expect(data.steps[0].steps).toEqual([
      { id: 'login-test', label: 'T login-test', ref: '#login-test', status: 'paused', note: '판정 대기' },
    ]);
    expect(data.steps[0].label).toBe('T login');
    expect(m.epicPlanData({ epic: { state: 'idle' } })).toEqual({ steps: [] });
    expect(m.epicPlanData({ epic: { nodes: [node('x', 'bogus')] } }).steps[0].status).toBe('pending');
    expect(m.epicPlanData({ epic: { nodes: [node('x', 'constructor')] } }).steps[0]).toEqual({
      id: 'x',
      label: 'T x',
      ref: '#x',
      status: 'pending',
    });
  });
});

const CARD_OF_FNS = [
  'toNum',
  'formatTokens',
  'formatTaskTime',
  'permissionSummary',
  'cardSummary',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardCurrentTask',
  'cardTaskRow',
  'agentStatusOf',
  'agentCounts',
  'agentDotOf',
  'cardTotalTokens',
  'ctxLevel',
  'ctxPercent',
  'cardCtxTitle',
  'cardPrMetric',
  '_hashStr',
  'ownerBadgeHue',
  'isSiblingSession',
  'cardOf',
];
const CARD_OF_VARS = [
  'PR_STATE_LABEL',
  'PR_STATE_TONE',
  'AGENT_STATUS_LABEL',
  'AGENT_STATUS_TONE',
  'AGENT_STATUS_GLYPH',
  'OWNER_BADGE_HUES',
  'EPIC_STATE_LABEL',
];
const CARD_OF_EXTRA = ['epicStateOf'];
const PAGE_STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)();

describe('L7 — the epic’s own card', () => {
  const { cardOf } = load<{ cardOf(s: unknown, col: string): Record<string, any> }>(
    [...CARD_OF_EXTRA, ...CARD_OF_FNS],
    CARD_OF_VARS,
    {
      STRINGS: PAGE_STRINGS,
      dhShow: () => true,
      dhTruncate: () => null,
      currentUserId: 'U1',
      _ownerIndex: null,
      SELF_INSTANCE_NAME: 'inst',
    },
  );
  const base = { ownerId: 'U1', ownerName: 'Z', activityState: 'idle', lastActivity: '2026-10-25T10:00:00.000Z' };

  it('leads with EPIC, says running / needs-input, and shows its progress as steps', () => {
    const run = cardOf({ ...base, ...epicCard('task:e', 'running', []) }, 'working');
    // SSOT 2026-11-01: an epic's mark is the epic glyph (stacked layers), apart from a plan node's task list.
    expect(run.lead).toEqual({ text: 'EPIC', glyph: 'epic', title: '에픽 — 자식 실행 중' });
    expect(run.status).toBe('running');
    expect(run.statusText).toBe('자식 실행 중');
    expect(run.steps).toEqual({ done: 1, total: 3 });
    const ask = cardOf({ ...base, ...epicCard('task:e', 'needs-input', []) }, 'waiting');
    expect(ask.statusText).toBe('입력 필요');
    const done = cardOf({ ...base, ...epicCard('task:e', 'done', []) }, 'idle');
    expect(done.lead.title).toBe('에픽 — 완료');
    expect(done.statusText).not.toBe('완료');
    expect(cardOf({ ...base, ...epicCard('task:e', 'constructor', []) }, 'idle').lead.title).toBe('에픽 — 대기');
    // A child leads with its node, the ref its epic's plan tree shows (fable #707 R1) — after ↳ when
    // it came in its epic's bundle (E4 ⑨c: drawn right under the epic); without, no arrow to nothing.
    expect(
      cardOf({ ...base, key: 'task:c', title: 'C', parentTaskId: 'e', planNodeId: 'login', underEpic: true }, 'working')
        .lead,
    ).toEqual({
      text: '\u21b3 #login',
      glyph: 'tasks',
      title: '위 에픽의 노드 login',
    });
    expect(
      cardOf({ ...base, key: 'task:c', title: 'C', parentTaskId: 'e', planNodeId: 'login' }, 'closed').lead,
    ).toEqual({
      text: '#login',
      glyph: 'tasks',
      title: '에픽의 노드 login',
    });
    const plain = cardOf({ ...base, key: 'task:p', title: 'P' }, 'idle');
    expect(plain.lead).toBeUndefined();
    const noPlan = cardOf(
      { ...base, ...epicCard('task:e', 'idle', []), epic: { state: 'idle', children: [] } },
      'idle',
    );
    expect(noPlan.steps).toBeUndefined();
  });
});

describe('N4 — the page: no lane; renderBoard places the children', () => {
  const fn = (name: string) => clientFn(name);
  it('no lane is left: not in the markup, the CSS, the code or the layout hosts', () => {
    for (const gone of [
      'id="epic-lane"',
      '.epic-lane',
      'ui-agent-inbox.epic-inbox',
      'epic-group',
      'epic-head',
      'renderEpicLane',
      'syncEpicLane',
      'planEpicLane',
      'paintEpicLaneCards',
      'epicLaneKeeps',
      '_epicGroupEls',
    ]) {
      expect(DASHBOARD_TS, gone).not.toContain(gone);
    }
    expect(fn('boardHosts')).not.toContain('epic');
  });

  it('renderBoard places every list through withEpicChildren and records each epic’s children', () => {
    const rb = fn('renderBoard');
    expect(rb).toContain('_epicKidsDrawn = Object.create(null);');
    expect(rb).toContain('return withEpicChildren(items, hideKids, _revealedKey).map(function(it) {');
    expect(rb).toContain(
      "if (it.s.kind === 'epic') _epicKidsDrawn[it.s.key] = epicKidsSig(it.s, hideKids, _revealedKey);",
    );
    expect(rb).toContain('var hideKids = showSleeping === false;');
    expect(rb).toContain('renderSleepingToggle(plan.sleepingCount + kidCounts.sleeping);');
    // The push computes the same signature with the same filter.
    expect(fn('applyEpicPush')).toContain('var now = epicKidsSig(s, showSleeping === false, _revealedKey);');
    expect(rb).toContain('keys: place(g.items, kb, g.open),');
    expect(rb).toContain("{ id: 'working', label: BOARD_LABELS.working, keys: keys(rest.working, 'working', kb) },");
  });

  it('renderBoard caches the children in its first walk, before the answer states are evicted (fable #706 R1 P1)', () => {
    const rb = fn('renderBoard');
    const kids = rb.indexOf('_sessionCache[kids[k0].key] = kids[k0];');
    expect(kids).toBeGreaterThan(-1);
    expect(kids).toBeLessThan(rb.indexOf('for (var ak in _acState) acEvict(ak, _sessionCache[ak]);'));
    expect(kids).toBeLessThan(rb.indexOf('_envIndex = _buildEnvIndex();'));
  });

  it('the push applies an epic’s bundle after the board is patched, and follows a child’s panel', () => {
    const push = TEMPLATE.slice(TEMPLATE.indexOf("msg.type === 'sessionUpdated'"));
    const block = push.slice(0, push.indexOf("msg.type === 'artifact_update'"));
    expect(block.indexOf('applyEpicPush(msg.session);')).toBeGreaterThan(block.indexOf('patchLastBoard(msg.session);'));
    expect(block).toContain('epicChildOf(msg.session, panelSessionKey)');
    expect(block).toContain('renderPanelQuestion(panelChild);');
  });
});
