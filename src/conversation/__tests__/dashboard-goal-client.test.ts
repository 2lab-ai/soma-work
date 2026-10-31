/**
 * SSOT 2026-10-21 T2/T3 — the work item's goal list, client half, on @2lab.ai/ui
 * `<ui-goal-card>` (E-12, D6b). Executes the shipped client code (cut out of
 * renderDashboardPage()'s template literal and cooked exactly as the browser
 * receives it, same harness as dashboard-agent-inbox-client.test.ts): the host
 * contract — what the page hands the element (goalCardData), which actions it
 * lets the element offer (what the goal route answers), what each element event
 * sends, the one write in flight, and that the element in #panel-goal is made
 * once per session and handed data only when it changed. How the card draws
 * (the fold, the two-press Delete, the past goals' fold) is the library's.
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
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/** The element's two listeners (ui-delete, ui-add), as the page registers them on document. */
const GOAL_LISTENERS = (() => {
  const start = TEMPLATE.indexOf("document.addEventListener('ui-delete', function(e) {");
  const end = TEMPLATE.indexOf('// Card click / Enter / Space', start);
  if (start < 0 || end < 0) throw new Error('goal listeners not found');
  return cook(TEMPLATE.slice(start, end));
})();
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, __set: function(n, v) { eval(n + ' = v'); }, __busy: typeof _goalBusy !== 'undefined' ? _goalBusy : undefined, __errors: typeof _goalErrors !== 'undefined' ? _goalErrors : undefined };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const DATA_FNS = ['toNum', 'formatTokens', 'formatDuration', 'goalPastItem', 'goalCardData'];
const DATA_VARS = ['GOAL_VIA_LABELS', 'GOAL_OBJECTIVE_MAX', 'GOAL_ACTIONS', '_goalErrors', '_goalBusy'];

interface GoalData {
  canEdit: boolean;
  actions: string[];
  maxLength: number;
  current: null | { id: string; objective: string; status: string; meta?: unknown[]; note?: string };
  queue: Array<{ id: string; objective: string }>;
  history: Array<{ id: string; objective: string; status: string; endedAt?: number; meta?: string[]; note?: string }>;
  busy?: string;
  busyId?: string;
  error?: string;
}
interface GoalModule {
  goalCardData(s: unknown, canEdit: boolean): GoalData;
  __busy: Record<string, { op: string; id: string }>;
  __errors: Record<string, string>;
}

function card(overrides: Record<string, any> = {}) {
  return {
    key: 'self::C1:t1',
    terminated: false,
    goal: {
      current: {
        goalId: 'g1',
        objective: '대시보드 개선',
        status: 'active',
        continuationCount: 2,
        maxContinuations: 10,
        lastEvalReason: '테스트가 없다',
      },
      queue: [
        { goalId: 'g2', objective: '두번째' },
        { goalId: 'g3', objective: '세번째' },
      ],
      completedCount: 1,
      history: [
        {
          goalId: 'g0',
          objective: '끝난 goal',
          completedAt: 1_700_000_000_000,
          completedVia: 'eval-model',
          completionReason: '모든 요건에 증거가 있다',
          activeMsUsed: 600_000,
          tokens: 1_500_000,
          costUsd: 3.4,
          continuationCount: 4,
        },
      ],
    },
    ...overrides,
  };
}

describe('goal card data — what the page hands <ui-goal-card> (T2)', () => {
  const m = load<GoalModule>(DATA_FNS, DATA_VARS);

  it('the current goal: id, objective, status; the 이어하기 budget as meta (not progress), 남은 것 as the note', () => {
    const d = m.goalCardData(card(), true);
    expect(d.current).toEqual({
      id: 'g1',
      objective: '대시보드 개선',
      status: 'active',
      meta: [{ label: '이어하기', value: '2/10' }],
      note: '남은 것: 테스트가 없다',
    });
    expect('progress' in (d.current as object)).toBe(false);
    expect(d.queue).toEqual([
      { id: 'g2', objective: '두번째' },
      { id: 'g3', objective: '세번째' },
    ]);
  });

  it('only what the goal route answers: actions are delete only; the add box is canEdit; the route cap is maxLength', () => {
    const d = m.goalCardData(card(), true);
    expect(d.actions).toEqual(['delete']);
    expect(d.canEdit).toBe(true);
    expect(d.maxLength).toBe(4000);
    expect(m.goalCardData(card(), false).canEdit).toBe(false);
    // The route refuses anything else: the page never lets the element offer it.
    expect(TEMPLATE).not.toContain("'ui-complete'");
    expect(TEMPLATE).not.toContain("'ui-pause'");
    expect(TEMPLATE).not.toContain("'ui-resume'");
  });

  it.each(['paused', 'complete'])('a %s goal carries no budget line and no 남은 것', (status) => {
    const d = m.goalCardData(card({ goal: { current: { ...card().goal.current, status }, queue: [] } }), true);
    expect(d.current).toEqual({ id: 'g1', objective: '대시보드 개선', status });
    expect(d.queue).toEqual([]);
    expect(d.history).toEqual([]);
  });

  it('no 이어하기 line without a cap; no note without a verdict', () => {
    const cur = { goalId: 'g1', objective: 'x', status: 'active', continuationCount: 0, maxContinuations: 0 };
    expect(m.goalCardData(card({ goal: { current: cur, queue: [] } }), true).current).toEqual({
      id: 'g1',
      objective: 'x',
      status: 'active',
    });
  });

  it('no goal at all: current null, empty queue and history (the element says 아직 목표가 없습니다 and shows the add box)', () => {
    expect(m.goalCardData(card({ goal: undefined }), true)).toEqual({
      canEdit: true,
      actions: ['delete'],
      maxLength: 4000,
      current: null,
      queue: [],
      history: [],
    });
  });

  it('ids travel as strings (the element keys its rows and events by them)', () => {
    const d = m.goalCardData(
      card({
        goal: { current: { goalId: 12, objective: 'n', status: 'active' }, queue: [{ goalId: 34, objective: 'q' }] },
      }),
      true,
    );
    expect(d.current?.id).toBe('12');
    expect(d.queue[0].id).toBe('34');
  });
});

describe('goal card data — the completed goals with their details (T6)', () => {
  const m = load<GoalModule>(DATA_FNS, DATA_VARS);

  it('each past goal: when it closed (endedAt), time spent, tokens, cost, continuations, how it closed; the verdict as the note', () => {
    const [h] = m.goalCardData(card(), true).history;
    expect(h).toEqual({
      id: 'g0',
      objective: '끝난 goal',
      status: 'complete',
      endedAt: 1_700_000_000_000,
      meta: ['소요 10m 0s', '1.5M tok', '$3.40', '이어하기 4회', '평가 모델 완료'],
      note: '모든 요건에 증거가 있다',
    });
  });

  it('a goal the person finished: 직접 완료, no note for the placeholder reason "user"; unknown fields leave no row', () => {
    const d = m.goalCardData(
      card({
        goal: {
          queue: [],
          history: [{ goalId: 'g1', objective: '첫', completedVia: 'user', completionReason: 'user' }],
        },
      }),
      true,
    );
    expect(d.history).toEqual([{ id: 'g1', objective: '첫', status: 'complete', meta: ['직접 완료'] }]);
  });

  it('in the order the server sends them (newest first)', () => {
    const d = m.goalCardData(
      card({
        goal: {
          queue: [],
          history: [
            { goalId: 'b', objective: '나중' },
            { goalId: 'a', objective: '먼저' },
          ],
        },
      }),
      false,
    );
    expect(d.history.map((h) => h.id)).toEqual(['b', 'a']);
    expect(d.history[0]).toEqual({ id: 'b', objective: '나중', status: 'complete' });
  });
});

describe('the panel goal — one <ui-goal-card> per session, data only when it changed (executed)', () => {
  function rig(sessions: Record<string, unknown>, opts: { user?: string; col?: string; sibling?: boolean } = {}) {
    const writes: GoalData[] = [];
    const classes = new Set<string>();
    let child: any = null;
    const host: any = {
      style: { display: '' },
      _key: undefined,
      classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
      get firstElementChild() {
        return child;
      },
      set innerHTML(v: string) {
        if (v !== '') throw new Error('the section takes the element only');
        child = null;
      },
      appendChild(el: unknown) {
        child = el;
      },
    };
    let made = 0;
    const document = {
      getElementById: (id: string) => (id === 'panel-goal' ? host : null),
      createElement: (tag: string) => {
        made++;
        const attrs: Record<string, string> = {};
        const el = {
          tagName: tag.toUpperCase(),
          setAttribute: (n: string, v: string) => {
            attrs[n] = v;
          },
          getAttribute: (n: string) => attrs[n] ?? null,
          attrs,
          set data(d: GoalData) {
            writes.push(d);
          },
        };
        return el;
      },
    };
    const m = load<{ renderPanelGoal(): void; __set(n: string, v: unknown): void }>(
      [...DATA_FNS, 'renderPanelGoal'],
      DATA_VARS,
      {
        document,
        panelSessionKey: Object.keys(sessions)[0],
        _sessionCache: sessions,
        sessionColOf: () => opts.col ?? 'working',
        currentUserId: opts.user ?? 'U1',
        isSiblingSession: () => !!opts.sibling,
      },
    );
    return { m, host, writes, classes, made: () => made, child: () => child };
  }
  const owned = (over: Record<string, unknown> = {}) => ({ ...card(over), ownerId: 'U1' });

  it('the owner of a live session: the element, lang ko, keyed by session; data once; an equal repaint writes nothing', () => {
    const r = rig({ 'self::C1:t1': owned() });
    r.m.renderPanelGoal();
    r.m.renderPanelGoal();
    expect(r.made()).toBe(1);
    expect(r.child().attrs).toEqual({ lang: 'ko', 'data-goal-key': 'self::C1:t1' });
    expect(r.host._key).toBe('self::C1:t1');
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].canEdit).toBe(true);
    expect(r.writes[0].actions).toEqual(['delete']);
    expect(r.host.style.display).toBe('');
    expect(r.classes.has('is-empty')).toBe(false);
  });

  it('a change in the goal is a new data write on the same element (the element morphs — the draft and focus stay)', () => {
    const sessions: Record<string, any> = { 'self::C1:t1': owned() };
    const r = rig(sessions);
    r.m.renderPanelGoal();
    sessions['self::C1:t1'] = owned({ goal: { ...card().goal, queue: [] } });
    r.m.renderPanelGoal();
    expect(r.made()).toBe(1);
    expect(r.writes).toHaveLength(2);
    expect(r.writes[1].queue).toEqual([]);
  });

  it('another session: a fresh element (its draft never carries over)', () => {
    const sessions: Record<string, any> = { A: { ...owned(), key: 'A' }, B: { ...owned(), key: 'B' } };
    const r = rig(sessions);
    r.m.renderPanelGoal();
    r.m.__set('panelSessionKey', 'B');
    r.m.renderPanelGoal();
    expect(r.made()).toBe(2);
    expect(r.child().attrs['data-goal-key']).toBe('B');
    expect(r.host._key).toBe('B');
  });

  it('a read-only viewer sees a goal list that exists, with no controls; without goals the section is hidden and emptied', () => {
    const r = rig({ 'self::C1:t1': owned() }, { user: 'U2' });
    r.m.renderPanelGoal();
    expect(r.writes[0].canEdit).toBe(false);
    const none = rig({ 'self::C1:t1': owned({ goal: undefined }) }, { user: 'U2' });
    none.m.renderPanelGoal();
    expect(none.host.style.display).toBe('none');
    expect(none.made()).toBe(0);
  });

  it("a closed or terminated session and a sibling instance's: read-only; the owner's empty live session keeps the editor (T1.6 is-empty)", () => {
    const closed = rig({ 'self::C1:t1': owned() }, { col: 'closed' });
    closed.m.renderPanelGoal();
    expect(closed.writes[0].canEdit).toBe(false);
    const ended = rig({ 'self::C1:t1': owned({ terminated: true }) });
    ended.m.renderPanelGoal();
    expect(ended.writes[0].canEdit).toBe(false);
    const sib = rig({ 'self::C1:t1': owned() }, { sibling: true });
    sib.m.renderPanelGoal();
    expect(sib.writes[0].canEdit).toBe(false);
    const empty = rig({ 'self::C1:t1': owned({ goal: undefined }) });
    empty.m.renderPanelGoal();
    expect(empty.host.style.display).toBe('');
    expect(empty.classes.has('is-empty')).toBe(true);
    expect(empty.writes[0]).toMatchObject({ canEdit: true, current: null });
    // A closed session without goals: nothing, and a card drawn before is dropped.
    const gone = rig({ 'self::C1:t1': owned({ goal: undefined }) }, { col: 'closed' });
    gone.host._key = 'self::C1:t1';
    gone.m.renderPanelGoal();
    expect(gone.host.style.display).toBe('none');
    expect(gone.host._key).toBeNull();
  });
});

describe("goal writes — the element's events, one in flight per session (T3, executed)", () => {
  function writer(post: (k: string, p: any) => Promise<{ ok: boolean; error: string }>, panel = true) {
    const repaints: Array<{ busy?: { op: string; id: string }; error?: string }> = [];
    const loadSessions = vi.fn();
    const m = load<{
      goalAction(k: string, p: unknown, id?: string): Promise<boolean>;
      addGoal(k: string, o: string, card: unknown): Promise<void>;
      isBusy(k: string, op: string): boolean;
      __busy: Record<string, { op: string; id: string }>;
      __errors: Record<string, string>;
    }>(
      ['isBusy', 'setBusy', 'setGoalError', 'repaintPanelGoalFor', 'goalAction', 'addGoal'],
      ['_busy', '_goalErrors', '_goalBusy'],
      {
        postGoalAction: post,
        loadSessions,
        panelOpen: panel,
        panelSessionKey: 'k',
        renderPanelGoal: () => repaints.push({ busy: m.__busy.k, error: m.__errors.k }),
      },
    );
    return { m, repaints, loadSessions };
  }

  it('a delete: busy (goal lock + the op the element spins) while out, cleared on the outcome; a refusal stays as the error until the next success', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'The current goal has changed — refresh and try again' })
      .mockResolvedValueOnce({ ok: true, error: '' });
    const w = writer(post);
    const first = w.m.goalAction('k', { action: 'delete', goalId: 'g1', expect: 'current' });
    expect(w.m.isBusy('k', 'goal')).toBe(true);
    expect(w.repaints).toEqual([{ busy: { op: 'delete', id: '' }, error: undefined }]);
    expect(await first).toBe(false);
    expect(w.m.isBusy('k', 'goal')).toBe(false);
    expect(w.repaints[1]).toEqual({ busy: undefined, error: 'The current goal has changed — refresh and try again' });
    expect(await w.m.goalAction('k', { action: 'delete', goalId: 'g2', expect: 'queued' }, 'g2')).toBe(true);
    expect(w.repaints[2]).toEqual({
      busy: { op: 'delete', id: 'g2' },
      error: 'The current goal has changed — refresh and try again',
    });
    expect(w.repaints[3]).toEqual({ busy: undefined, error: undefined });
    expect(w.loadSessions).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map((c) => c[1])).toEqual([
      { action: 'delete', goalId: 'g1', expect: 'current' },
      { action: 'delete', goalId: 'g2', expect: 'queued' },
    ]);
  });

  it('a second goal write while one is pending is refused — add and delete share the goal lock', async () => {
    let release: (v: { ok: boolean; error: string }) => void = () => {};
    const posts: string[] = [];
    const w = writer((_k, p) => {
      posts.push(p.action);
      return new Promise((r) => (release = r));
    });
    const del = w.m.goalAction('k', { action: 'delete', goalId: 'g1', expect: 'current' });
    await w.m.addGoal('k', 'next goal', null);
    expect(await w.m.goalAction('k', { action: 'delete', goalId: 'g2', expect: 'queued' }, 'g2')).toBe(false);
    expect(posts).toEqual(['delete']);
    release({ ok: true, error: '' });
    await del;
    expect(w.m.isBusy('k', 'goal')).toBe(false);
  });

  it("an add: trimmed, empty sends nothing; the draft is cleared only once it went through, on this session's live card", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'refused' })
      .mockResolvedValueOnce({ ok: true, error: '' })
      .mockResolvedValueOnce({ ok: true, error: '' });
    const w = writer(post);
    const el = (key: string, draft: string, connected = true) => ({
      isConnected: connected,
      getAttribute: (n: string) => (n === 'data-goal-key' ? key : null),
      draft,
    });
    await w.m.addGoal('k', '   ', el('k', '   '));
    expect(post).not.toHaveBeenCalled();
    const refused = el('k', ' ship it ');
    await w.m.addGoal('k', ' ship it ', refused);
    expect(post.mock.calls[0][1]).toEqual({ action: 'add', objective: 'ship it' });
    expect(refused.draft).toBe(' ship it '); // the words stay to fix
    expect(w.m.__errors.k).toBe('refused');
    const other = el('other', 'ship it');
    await w.m.addGoal('k', 'ship it', other);
    expect(other.draft).toBe('ship it'); // never another session's draft
    const live = el('k', 'ship it');
    await w.m.addGoal('k', 'ship it', live);
    expect(live.draft).toBe('');
    expect(w.m.__errors.k).toBeUndefined();
  });

  it('with the panel on another session a write repaints nothing there (the data is re-read when it opens)', async () => {
    const w = writer(async () => ({ ok: true, error: '' }), false);
    await w.m.goalAction('k', { action: 'delete', goalId: 'g1', expect: 'current' });
    expect(w.repaints).toEqual([]);
  });

  it('posts the action as JSON with the CSRF token, and retries once after a token refresh', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 403, ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ ok: true }) });
    let token = 'old';
    const { postGoalAction } = new Function(
      'fetch',
      'refreshCsrfToken',
      'getToken',
      `${clientFn('postGoalAction').replace(/_csrfToken/g, 'getToken()')}\nreturn { postGoalAction };`,
    )(
      fetch,
      async () => {
        token = 'new';
      },
      () => token,
    );

    const r = await postGoalAction('self::C1:t1', { action: 'add', objective: '새 목표' });

    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/dashboard/session/self%3A%3AC1%3At1/goal');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ action: 'add', objective: '새 목표' });
    expect(init.headers['X-CSRF-Token']).toBe('old');
    expect(fetch.mock.calls[1][1].headers['X-CSRF-Token']).toBe('new');
  });
});

describe("the element's events on document (executed)", () => {
  function listeners() {
    const on: Record<string, (e: any) => void> = {};
    const goalAction = vi.fn();
    const addGoal = vi.fn();
    new Function('document', '_sessionCache', 'goalAction', 'addGoal', GOAL_LISTENERS)(
      { addEventListener: (t: string, fn: (e: any) => void) => (on[t] = fn) },
      { k: { key: 'k' } },
      goalAction,
      addGoal,
    );
    const target = (key: string | null, tag = 'UI-GOAL-CARD') => ({
      tagName: tag,
      getAttribute: (n: string) => (n === 'data-goal-key' ? key : null),
    });
    const fire = (type: string, target: unknown, detail: unknown) => {
      const e = {
        target,
        detail,
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      on[type](e);
      return e;
    };
    return { on, goalAction, addGoal, target, fire };
  }

  it('ui-delete names where the goal was seen: the current goal, or a queued one whose remove spins (busyId)', () => {
    const l = listeners();
    expect(Object.keys(l.on).sort()).toEqual(['ui-add', 'ui-delete']);
    l.fire('ui-delete', l.target('k'), { id: 'g1', queued: false });
    l.fire('ui-delete', l.target('k'), { id: 'g2', queued: true });
    expect(l.goalAction.mock.calls).toEqual([
      ['k', { action: 'delete', goalId: 'g1', expect: 'current' }, ''],
      ['k', { action: 'delete', goalId: 'g2', expect: 'queued' }, 'g2'],
    ]);
  });

  it('ui-add is prevented (the element keeps the draft until the page clears it) and hands the words with the card', () => {
    const l = listeners();
    const t = l.target('k');
    const e = l.fire('ui-add', t, { objective: '새 goal' });
    expect(e.prevented).toBe(true);
    expect(l.addGoal).toHaveBeenCalledWith('k', '새 goal', t);
  });

  it("another element's event, or a card of a session the page no longer knows: nothing is sent", () => {
    const l = listeners();
    l.fire('ui-delete', l.target('k', 'UI-APPROVAL-CARD'), { id: 'x' });
    const stale = l.fire('ui-delete', l.target('gone'), { id: 'g1', queued: false });
    expect(stale.prevented).toBe(true);
    l.fire('ui-add', l.target('gone'), { objective: 'x' });
    expect(l.goalAction).not.toHaveBeenCalled();
    expect(l.addGoal).not.toHaveBeenCalled();
  });
});

describe('the page around the element', () => {
  it('loads the element, sizes it as a block in its section, and keeps none of its own goal editor', () => {
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/goal-card.js?v=');
    expect(TEMPLATE).toContain('.panel-goal > ui-goal-card { display: block; }');
    for (const gone of [
      'renderCardGoal',
      'renderGoalHistory',
      'addGoalFromCard',
      'togglePanelGoal',
      'syncGoalMore',
      '_panelGoalOpen',
      '_goalHistoryOpen',
      'goalHistoryToggle',
      'cg-add-input',
      'cg-objective',
      'cg-history',
      '.card-goal {',
      'cg-hx',
    ])
      expect(TEMPLATE, gone).not.toContain(gone);
  });

  it("the goal landing focuses the element's add box (else its group) through the open shadow root, else the section", () => {
    const src = clientFn('focusPanelLanding');
    expect(src).toContain(
      "if (_panelLand === 'goal') t = goalCardFocusTarget() || document.getElementById('panel-goal');",
    );
    const m = load<{ goalCardFocusTarget(): unknown }>(['goalCardFocusTarget'], [], {
      document: {
        querySelector: (sel: string) =>
          sel === '#panel-goal > ui-goal-card'
            ? { shadowRoot: { querySelector: (s: string) => (s === 'textarea' ? 'box' : 'group') } }
            : null,
      },
    });
    expect(m.goalCardFocusTarget()).toBe('box');
    const none = load<{ goalCardFocusTarget(): unknown }>(['goalCardFocusTarget'], [], {
      document: { querySelector: () => null },
    });
    expect(none.goalCardFocusTarget()).toBeNull();
  });

  it('every live panel repaint goes through renderPanelGoal; the open card body no longer carries a goal draft', () => {
    expect(clientFn('repaintPanelSession')).toContain('renderPanelGoal();');
    expect(clientFn('paintCardBody')).not.toContain('isEditingGoal');
    expect(TEMPLATE).not.toContain('function isEditingGoal(');
    expect(TEMPLATE).not.toContain('function captureGoalDraft(');
  });
});
