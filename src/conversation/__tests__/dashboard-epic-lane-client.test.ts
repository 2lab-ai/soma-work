/**
 * E4 ⑨a (.prd/19 D11) — the EPIC lane on the board, client side. Executes the
 * shipped client code cut out of renderDashboardPage()'s template literal, cooked
 * as the browser receives it (the harness of dashboard-affectui-agent-inbox-client),
 * with injected fakes — no DOM.
 *
 *   L1 planEpicLane: one group per epic card with children, from any column; waiting
 *      groups first, then running, idle, done; epics without children and other cards
 *      have none.
 *   L2 a child's card reads its own activity as its column; a sleeping child is closed.
 *   L3 a group's head: the epic's title (escaped), its state chip and its progress.
 *   L4 syncEpicLane / paintEpicLaneCards: one persistent box per group, its head, and a
 *      <ui-agent-inbox view="list"> with one bare column of the children's cards; a group
 *      that goes is removed after its fade; no group, the lane is hidden.
 *   L5 renderEpicLane caches the children (a card opens only from the cache).
 *   L6 a single-session push of an epic redraws the lane from the patched board and
 *      refreshes each drawn child card; a push without a bundle does nothing; a panel
 *      open on a child finds it in the epic's card.
 *   L7 the epic's own card leads with EPIC, says its state while a child works or waits,
 *      and shows its progress as steps.
 *   L8 the page: renderBoard draws the lane, the push applies it, the markup and the
 *      layout hosts carry it.
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

const LANE_VARS = ['EPIC_STATE_LABEL', 'EPIC_STATE_TONE', 'EPIC_STATE_RANK', 'EPIC_NODE_STEP', 'EPIC_NODE_NOTE'];
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

describe('L1–L3 — the lane’s plan, a child’s column, a group’s head', () => {
  const m = load<{
    planEpicLane(board: unknown): Array<{ key: string; children: Array<{ key: string }> }>;
    epicChildCol(c: unknown): string;
    epicLaneHeadHtml(s: unknown): string;
    epicPlanData(s: unknown): { steps: Array<Record<string, any>> };
    epicProgressHtml(p: unknown): string;
  }>(
    [
      ...ESC,
      'epicStateOf',
      'planEpicLane',
      'epicChildCol',
      'epicProgressHtml',
      'epicLaneHeadHtml',
      'epicPlanStep',
      'epicPlanData',
    ],
    LANE_VARS,
  );

  it('L1 — one group per epic with children, from any column, waiting first; nothing else', () => {
    const board = {
      working: [
        epicCard('task:run', 'running', [child('task:c1')]),
        { key: 'task:plain' },
        // A bundle on a card that is not an epic is not a group.
        { key: 'task:odd', epic: { state: 'running', children: [child('task:x')] } },
      ],
      waiting: [epicCard('task:ask', 'needs-input', [child('task:c2'), child('task:c3')])],
      idle: [
        epicCard('task:done', 'done', [child('task:c4')]),
        epicCard('task:empty', 'idle', []),
        epicCard('task:rest', 'idle', [child('task:c5')]),
      ],
      closed: [epicCard('task:sleep', 'idle', [child('task:c6', { sessionState: 'SLEEPING' })])],
    };
    const groups = m.planEpicLane(board);
    expect(groups.map((g) => g.key)).toEqual(['task:ask', 'task:run', 'task:rest', 'task:sleep', 'task:done']);
    expect(groups[0].children.map((c) => c.key)).toEqual(['task:c2', 'task:c3']);
    expect(m.planEpicLane({})).toEqual([]);
    expect(m.planEpicLane({ idle: [{ key: 'x', kind: 'epic' }] })).toEqual([]);
  });

  it('L2 — a child reads its own activity; a sleeping one is closed', () => {
    expect(m.epicChildCol(child('a', { activityState: 'working' }))).toBe('working');
    expect(m.epicChildCol(child('a', { activityState: 'waiting' }))).toBe('waiting');
    expect(m.epicChildCol(child('a'))).toBe('idle');
    expect(m.epicChildCol(child('a', { activityState: 'working', sessionState: 'SLEEPING' }))).toBe('closed');
  });

  it('L3 — the head: the title escaped, the state chip, the progress; an unknown state reads idle', () => {
    const html = m.epicLaneHeadHtml(epicCard('task:e', 'needs-input', [], { displayHeadline: '<b>Login</b>' }));
    expect(html).toContain('<span class="epic-title">&lt;b&gt;Login&lt;/b&gt;</span>');
    expect(html).toContain('data-state="needs-input"');
    expect(html).toContain('--ui-tone:var(--st-wait)');
    expect(html).toContain('>입력 필요</span>');
    expect(html).toContain('>1/3</span>');
    expect(
      m.epicLaneHeadHtml(
        epicCard('task:e', 'idle', [], { epic: { state: 'idle', progress: { accepted: 7, total: 3 } } }),
      ),
    ).toContain('>3/3</span>');
    // A prototype key is no state the page knows (fable #706 R1 P3).
    expect(m.epicLaneHeadHtml({ key: 'k', kind: 'epic', epic: { state: 'constructor' } })).toContain(
      'data-state="idle"',
    );
    const odd = m.epicLaneHeadHtml({ key: 'k', kind: 'epic', epic: { state: 'bogus', progress: { total: 0 } } });
    expect(odd).toContain('data-state="idle"');
    expect(odd).toContain('>대기</span>');
    expect(odd).not.toContain('epic-progress');
  });
});

type FakeEl = {
  tag: string;
  className: string;
  hidden?: boolean;
  innerHTML: string;
  attrs: Record<string, string>;
  children: FakeEl[];
  parentNode: FakeEl | null;
  _ibPlan?: { cols: Array<{ id: string; bare?: boolean; keys: string[] }>; load: string; announce: unknown };
  _head?: FakeEl;
  _plan?: FakeEl;
  _cards?: FakeEl;
  data?: unknown;
  _inbox?: FakeEl;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  insertBefore(c: FakeEl, ref: FakeEl | null): FakeEl;
  readonly firstChild: FakeEl | null;
  readonly nextSibling: FakeEl | null;
};
/** DOM moves (append / insert) — each one disconnects the moved subtree in a browser. */
const moves = { count: 0 };
function el(tag: string): FakeEl {
  const e: FakeEl = {
    tag,
    className: '',
    innerHTML: '',
    attrs: {},
    children: [],
    parentNode: null,
    setAttribute(k, v) {
      e.attrs[k] = v;
    },
    getAttribute(k) {
      return k in e.attrs ? e.attrs[k] : null;
    },
    appendChild(c) {
      moves.count++;
      if (c.parentNode) c.parentNode.removeChild(c);
      e.children.push(c);
      c.parentNode = e;
      return c;
    },
    insertBefore(c, ref) {
      if (!ref) return e.appendChild(c);
      moves.count++;
      if (c.parentNode) c.parentNode.removeChild(c);
      e.children.splice(e.children.indexOf(ref), 0, c);
      c.parentNode = e;
      return c;
    },
    get firstChild() {
      return e.children[0] ?? null;
    },
    get nextSibling() {
      const p = e.parentNode;
      return p ? (p.children[p.children.indexOf(e) + 1] ?? null) : null;
    },
    removeChild(c) {
      e.children = e.children.filter((x) => x !== c);
      c.parentNode = null;
      return c;
    },
  };
  return e;
}

function laneHarness() {
  const lane = el('div');
  lane.hidden = true;
  const placed: Array<[string, string]> = [];
  const painted: FakeEl[] = [];
  const wired: FakeEl[] = [];
  const refreshed: string[] = [];
  const released: unknown[] = [];
  const bodies = { synced: 0 };
  const timers: Array<() => void> = [];
  const state = {
    _sessionCache: Object.create(null) as Record<string, unknown>,
    _cardHost: Object.create(null) as Record<string, any>,
    _cardCol: Object.create(null) as Record<string, unknown>,
    _cardData: Object.create(null) as Record<string, unknown>,
    _cardDrawn: Object.create(null) as Record<string, unknown>,
    _expanded: new Set<string>(),
  };
  const m = load<{
    syncEpicLane(groups: unknown[]): void;
    paintEpicLaneCards(groups: unknown[]): void;
    renderEpicLane(board: unknown): unknown[];
    applyEpicPush(s: unknown): void;
    epicChildOf(s: unknown, key: string): unknown;
    planEpicLane(board: unknown): unknown[];
    setBoard(b: unknown): void;
  }>(
    [
      ...ESC,
      'epicStateOf',
      'taskElData',
      'planEpicLane',
      'epicChildCol',
      'epicProgressHtml',
      'epicLaneHeadHtml',
      'epicPlanStep',
      'epicPlanData',
      'syncEpicLane',
      'epicLaneKeeps',
      'paintEpicLaneCards',
      'renderEpicLane',
      'applyEpicPush',
      'epicChildOf',
    ],
    [...LANE_VARS, '_epicGroupEls'],
    {
      document: {
        getElementById: (id: string) => (id === 'epic-lane' ? lane : null),
        createElement: (tag: string) => el(tag),
      },
      MOTION: { fade: 160 },
      setTimeout: (fn: () => void) => timers.push(fn),
      wireInbox: (x: FakeEl) => wired.push(x),
      placeCard: (s: { key: string }, col: string, host: unknown) => {
        placed.push([s.key, col]);
        state._cardHost[s.key] = host;
      },
      releaseCardIoTimer: (cid: unknown) => released.push(cid),
      syncCardBodies: () => {
        bodies.synced++;
      },
      _cardCol: state._cardCol,
      _cardData: state._cardData,
      _cardDrawn: state._cardDrawn,
      _expanded: state._expanded,
      inboxPaint: (x: FakeEl) => painted.push(x),
      refreshCard: (k: string) => refreshed.push(k),
      get _sessionCache() {
        return state._sessionCache;
      },
      get _cardHost() {
        return state._cardHost;
      },
      _lastBoardData: null,
    },
    'function setBoard(b) { _lastBoardData = b; }',
  );
  return { m, lane, placed, painted, wired, refreshed, released, bodies, timers, state };
}

describe('L4–L6 — the lane’s boxes, its cards, the cache and the push', () => {
  it('L4 — a box per group with its head and a list inbox of the children; a group that goes fades out; none, hidden', () => {
    const h = laneHarness();
    const board = {
      waiting: [epicCard('task:a', 'needs-input', [child('task:a1', { activityState: 'waiting' }), child('task:a2')])],
      working: [epicCard('task:b', 'running', [child('task:b1', { activityState: 'working' })])],
    };
    const groups = h.m.renderEpicLane(board);
    expect(groups).toHaveLength(2);
    expect(h.lane.hidden).toBe(false);
    expect(h.lane.children.map((b) => b.attrs['data-epic'])).toEqual(['task:a', 'task:b']);
    const box = h.lane.children[0];
    expect(box.className).toBe('epic-group');
    expect(box._head?.innerHTML).toContain('입력 필요');
    const inbox = box._inbox as FakeEl;
    expect(inbox.className).toBe('epic-inbox');
    expect(inbox.attrs).toMatchObject({ view: 'list', lang: 'ko' });
    expect(inbox.parentNode).toBe(box._cards);
    expect(h.wired).toContain(inbox);
    expect(inbox._ibPlan).toMatchObject({ load: 'ready', announce: false });
    expect(inbox._ibPlan?.cols).toEqual([
      expect.objectContaining({ id: 'epic', bare: true, keys: ['task:a1', 'task:a2'] }),
    ]);
    expect(h.placed).toEqual([
      ['task:a1', 'waiting'],
      ['task:a2', 'idle'],
      ['task:b1', 'working'],
    ]);
    expect(h.painted).toHaveLength(2);

    // The same groups again: the boxes and the inboxes are kept, and nothing moves in the DOM
    // (a move disconnects the box's subtree — fable #706 R1 P1).
    moves.count = 0;
    h.m.renderEpicLane(board);
    expect(moves.count).toBe(0);
    expect(h.lane.children[0]).toBe(box);
    expect(box._inbox).toBe(inbox);
    expect(h.wired).toHaveLength(2);
    // The order changes (b now waits): one move, and the lane reads b, a.
    const flipped = {
      waiting: [epicCard('task:b', 'needs-input', [child('task:b1', { activityState: 'waiting' })])],
      working: [epicCard('task:a', 'running', [child('task:a1', { activityState: 'working' }), child('task:a2')])],
    };
    moves.count = 0;
    h.m.renderEpicLane(flipped);
    expect(moves.count).toBe(1);
    expect(h.lane.children.map((b) => b.attrs['data-epic'])).toEqual(['task:b', 'task:a']);
    h.m.renderEpicLane(board);

    // One group goes: its box fades out (a timer), then leaves the lane.
    h.m.renderEpicLane({ working: board.working });
    expect(h.timers).toHaveLength(1);
    h.timers[0]();
    expect(h.lane.children.map((b) => b.attrs['data-epic'])).toEqual(['task:b']);
    // Gone for good: the next render schedules nothing more for it.
    h.m.renderEpicLane({ working: board.working });
    expect(h.timers).toHaveLength(1);
    h.m.renderEpicLane({});
    expect(h.lane.hidden).toBe(true);
  });

  it('L4b — a group that leaves from the middle moves no box after it while it fades (fable #706 R2 P3)', () => {
    const h = laneHarness();
    const g = (k: string) => epicCard(k, 'running', [child(`${k}1`, { activityState: 'working' })]);
    h.m.renderEpicLane({ working: [g('task:a'), g('task:b'), g('task:c')] });
    expect(h.lane.children.map((b) => b.attrs['data-epic'])).toEqual(['task:a', 'task:b', 'task:c']);
    const c = h.lane.children[2];
    moves.count = 0;
    h.m.renderEpicLane({ working: [g('task:a'), g('task:c')] });
    expect(moves.count).toBe(0);
    expect(h.lane.children[2]).toBe(c);
    // Still fading, it is skipped again; then it leaves.
    h.m.renderEpicLane({ working: [g('task:a'), g('task:c')] });
    expect(moves.count).toBe(0);
    h.timers[0]();
    expect(h.lane.children.map((b) => b.attrs['data-epic'])).toEqual(['task:a', 'task:c']);
    // A group that comes back while its old box fades gets a new box, placed after the fading one.
    h.m.renderEpicLane({ working: [g('task:a'), g('task:b'), g('task:c')] });
    h.m.renderEpicLane({ working: [g('task:a'), g('task:c')] });
    h.m.renderEpicLane({ working: [g('task:a'), g('task:b'), g('task:c')] });
    const live = h.lane.children.filter((b) => b.attrs['data-epic'] === 'task:b');
    expect(live).toHaveLength(2);
    expect(h.lane.children.map((b) => b.attrs['data-epic'])).toEqual(['task:a', 'task:b', 'task:b', 'task:c']);
  });

  it('L5 — the children are cached so their cards open', () => {
    const h = laneHarness();
    const c = child('task:c1');
    h.m.renderEpicLane({ working: [epicCard('task:e', 'running', [c])] });
    expect(h.state._sessionCache['task:c1']).toBe(c);
  });

  it('L6 — a push with a bundle redraws the lane from the patched board and refreshes drawn children; a panel finds a child', () => {
    const h = laneHarness();
    const fresh = child('task:c1', { activityState: 'working' });
    const pushed = epicCard('task:e', 'running', [fresh, child('task:c2')]);
    // No board yet: nothing drawn, but the children are cached (a panel open on one reads it).
    h.m.applyEpicPush(pushed);
    expect(h.painted).toHaveLength(0);
    expect(h.state._sessionCache['task:c2']).toMatchObject({ key: 'task:c2' });
    h.m.setBoard({ working: [pushed] });
    h.state._cardHost['task:c1'] = {};
    h.m.applyEpicPush(pushed);
    expect(h.painted).toHaveLength(1);
    // Both children are drawn in the lane now (placeCard), so both refresh.
    expect(h.refreshed).toEqual(['task:c1', 'task:c2']);
    expect(h.state._sessionCache['task:c1']).toBe(fresh);
    // A push of a plain card does nothing here.
    h.m.applyEpicPush({ key: 'task:p' });
    expect(h.painted).toHaveLength(1);
    // c2 leaves the bundle (closed): its card is released, its body synced away; c1 stays.
    h.state._expanded.add('task:c2');
    const without = epicCard('task:e', 'running', [fresh]);
    h.m.setBoard({ working: [without] });
    h.m.applyEpicPush(without);
    expect(h.state._cardHost['task:c2']).toBeUndefined();
    expect(h.state._expanded.has('task:c2')).toBe(false);
    expect(h.released).toHaveLength(1);
    expect(h.bodies.synced).toBe(1);
    expect(h.state._cardHost['task:c1']).toBeDefined();
    // Nothing left: no release, no body sync.
    h.m.applyEpicPush(without);
    expect(h.bodies.synced).toBe(1);
    // The epic's card comes back with no bundle (grok #706 R2): its group goes and its children are released.
    const bare = { key: 'task:e', title: 'Epic task:e', kind: 'epic' };
    h.m.setBoard({ working: [bare] });
    h.m.applyEpicPush(bare);
    expect(h.state._cardHost['task:c1']).toBeUndefined();
    expect(h.bodies.synced).toBe(2);
    expect(h.timers).toHaveLength(1);
    // A plain card with no group never redraws the lane.
    h.m.applyEpicPush({ key: 'task:other' });
    expect(h.bodies.synced).toBe(2);
    expect(h.m.epicChildOf(pushed, 'task:c2')).toMatchObject({ key: 'task:c2' });
    expect(h.m.epicChildOf(pushed, 'task:none')).toBeNull();
    expect(h.m.epicChildOf({ key: 'task:p' }, 'task:c2')).toBeNull();
  });
});

describe('L9–L11 (⑨b) — the plan tree and the progress bar', () => {
  const m = load<{
    epicPlanData(s: unknown): { steps: Array<Record<string, any>> };
    epicProgressHtml(p: unknown): string;
  }>([...ESC, 'epicPlanStep', 'epicPlanData', 'epicProgressHtml'], LANE_VARS);
  const node = (id: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `T ${id}`,
    kind: 'issue',
    status,
    accepted: false,
    childTaskIds: [],
    ...over,
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

  it('L10 — the bar: accepted of all, read by a screen reader; none for an empty plan; never past full', () => {
    const html = m.epicProgressHtml({ accepted: 1, total: 4 });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemax="4" aria-valuenow="1"');
    expect(html).toContain('style="width:25%"');
    expect(m.epicProgressHtml({ accepted: 0, total: 0 })).toBe('');
    expect(m.epicProgressHtml(undefined)).toBe('');
    expect(m.epicProgressHtml({ accepted: 9, total: 3 })).toContain('style="width:100%"');
    // Never below empty either; the text a screen reader speaks (grok, fable #707 R1).
    expect(m.epicProgressHtml({ accepted: -3, total: 4 })).toContain('aria-valuenow="0" aria-valuetext="0/4"');
    expect(m.epicProgressHtml({ accepted: -3, total: 4 })).toContain('style="width:0%"');
    expect(html).toContain('aria-valuetext="1/4"');
  });

  it('L11 — the group box holds the plan between its head and its cards; no plan, hidden; the data set only when it changed', () => {
    const h = laneHarness();
    const withPlan = epicCard('task:e', 'running', [child('task:c1')]);
    (withPlan.epic as any).nodes = [node('login', 'running')];
    h.m.renderEpicLane({ working: [withPlan] });
    const box = h.lane.children[0];
    expect(box.children.map((c) => c.className)).toEqual(['epic-head', 'epic-plan', 'cards epic-cards']);
    const plan = box._plan as FakeEl;
    expect(plan.tag).toBe('ui-task-plan');
    expect(plan.attrs).toMatchObject({ lang: 'ko', flush: '', foot: 'none' });
    expect(plan.hidden).toBe(false);
    expect(plan.data).toEqual({ steps: [{ id: 'login', label: 'T login', ref: '#login', status: 'running' }] });
    expect(box._head?.innerHTML).toContain('role="progressbar"');
    const first = plan.data;
    h.m.renderEpicLane({ working: [withPlan] });
    expect(plan.data).toBe(first);
    h.m.renderEpicLane({ working: [epicCard('task:e', 'running', [child('task:c1')])] });
    expect(plan.hidden).toBe(true);
    // display: block beats the UA [hidden] rule: the plan's own rule hides it.
    expect(DASHBOARD_TS).toContain('.epic-plan[hidden] { display: none; }');
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
    expect(run.lead).toEqual({ text: 'EPIC', glyph: 'tasks', title: '에픽 — 자식 실행 중' });
    expect(run.status).toBe('running');
    expect(run.statusText).toBe('자식 실행 중');
    expect(run.steps).toEqual({ done: 1, total: 3 });
    const ask = cardOf({ ...base, ...epicCard('task:e', 'needs-input', []) }, 'waiting');
    expect(ask.statusText).toBe('입력 필요');
    const done = cardOf({ ...base, ...epicCard('task:e', 'done', []) }, 'idle');
    expect(done.lead.title).toBe('에픽 — 완료');
    expect(done.statusText).not.toBe('완료');
    expect(cardOf({ ...base, ...epicCard('task:e', 'constructor', []) }, 'idle').lead.title).toBe('에픽 — 대기');
    // A child leads with its node, the ref its epic's plan tree shows (fable #707 R1).
    expect(
      cardOf({ ...base, key: 'task:c', title: 'C', parentTaskId: 'e', planNodeId: 'login' }, 'working').lead,
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

describe('L8 — the page wires the lane', () => {
  const fn = (name: string) => clientFn(name);
  it('renderBoard caches the children in its first walk, before the answer states are evicted (fable #706 R1 P1)', () => {
    const rb = fn('renderBoard');
    const kids = rb.indexOf('_sessionCache[kids[k0].key] = kids[k0];');
    expect(kids).toBeGreaterThan(-1);
    expect(kids).toBeLessThan(rb.indexOf('for (var ak in _acState) acEvict(ak, _sessionCache[ak]);'));
    expect(kids).toBeLessThan(rb.indexOf('_envIndex = _buildEnvIndex();'));
  });

  it('renderBoard draws the lane after the CRON lane; the push applies it and follows a child’s panel', () => {
    const rb = fn('renderBoard');
    expect(rb.indexOf('renderEpicLane(board);')).toBeGreaterThan(
      rb.indexOf('paintCronLaneCards(cronLaneSlots(cronPlan));'),
    );
    const push = TEMPLATE.slice(TEMPLATE.indexOf("msg.type === 'sessionUpdated'"));
    const block = push.slice(0, push.indexOf("msg.type === 'artifact_update'"));
    expect(block.indexOf('applyEpicPush(msg.session);')).toBeGreaterThan(block.indexOf('patchLastBoard(msg.session);'));
    expect(block).toContain('epicChildOf(msg.session, panelSessionKey)');
    expect(block).toContain('renderPanelQuestion(panelChild);');
  });
  it('the markup has the lane, the CSS lays it out, the layout coordinator measures its inboxes', () => {
    expect(TEMPLATE).toContain('<div class="epic-lane ui-tok" id="epic-lane" aria-label="에픽" hidden></div>');
    expect(DASHBOARD_TS).toContain('ui-agent-inbox.epic-inbox { display: block; min-width: 0; }');
    expect(DASHBOARD_TS).toContain('.epic-lane { display: flex;');
    // An author display beats the UA [hidden] rule: the empty lane must be hidden by its own rule.
    expect(DASHBOARD_TS).toContain('.epic-lane[hidden] { display: none; }');
    // The bar and the count sit together at the end of the head.
    expect(DASHBOARD_TS).toContain('.epic-head .epic-bar { margin-left: auto; }');
    expect(fn('boardHosts')).toContain("document.querySelectorAll('ui-agent-inbox.epic-inbox')");
  });
  it('an epic’s children are in no column the client builds (the server already took them out)', () => {
    expect(fn('planEpicLane')).not.toContain('board.working.push');
  });
});
