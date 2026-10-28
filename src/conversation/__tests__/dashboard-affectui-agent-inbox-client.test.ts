/**
 * affectUI Agent Inbox → the session board (.prd/affectui/re-agent-inbox.md §4).
 * Executes the shipped client code cut out of renderDashboardPage()'s template
 * literal, cooked as the browser receives it (the harness of
 * dashboard-three-surfaces-client.test.ts), with injected fakes — no DOM.
 *
 *   D1  the face's status tag carries a tone: run · wait · done · rest
 *   D4  a state change pops the status icon (only a change, only with motion)
 *   D5  the new state shows in place first; the card changes column 900ms later
 *   D6  a polite announcement of how many need you and how many run
 *   D7  Escape closes the open card and puts focus back on its face
 *   D8  the face names the region it opens (aria-controls)
 *   D10 one primary button per open card: the decision, else 작업 로그
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
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
// Cut + cooked once per name: the suites load the same functions many times.
const cutCache = new Map<string, string>();
function clientFn(name: string): string {
  const hit = cutCache.get(name);
  if (hit !== undefined) return hit;
  const cut = cutClientFn(name);
  cutCache.set(name, cut);
  return cut;
}
function cutClientFn(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
/** A multi-line `var NAME = [ … ];` (clientVar only matches one line). */
function clientArrayVar(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} = [`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const end = TEMPLATE.indexOf('\n];\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 4));
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const T0 = 1_700_000_000_000;

// ── D1 — tone on the face ──
const FACE_FNS = [
  'esc',
  'escAttr',
  'escJs',
  'toNum',
  'formatTokens',
  'formatCount',
  'cardTotalTokens',
  'cardCurrentTask',
  'renderCardTaskRow',
  'agentStatusOf',
  'agentCounts',
  'renderCardAgents',
  'renderCardUsage',
  'formatTaskTime',
  'pendingAutoResume',
  'autoResumeLabel',
  'cardSummary',
  'doneTimeOf',
  'cardAgo',
  'renderCardStatus',
  'renderOwnerBadge',
  'ctxLevel',
  'renderCardPr',
  'renderCardFace',
];
const FACE_VARS = [
  'SPARK_SVG',
  'WAIT_SVG',
  'TASKS_SVG',
  'CTX_SVG',
  'RESUME_SVG',
  'PR_STATE_LABEL',
  'PR_SVG',
  'AGENT_STATUS_LABEL',
  'AGENT_DOTS_MAX',
  'AGENTS_SVG',
];
const FACE_ENV = {
  dhShow: () => true,
  dhMax: (_f: string, d: number) => d,
  dhTruncate: () => null,
  currentUserId: 'U1',
  isSiblingSession: () => false,
  artFaceChips: () => '',
  umFaceBadge: () => '',
};
const faceCard = (over: Record<string, unknown> = {}) => ({
  key: 'inst::C1:t1',
  displayHeadline: 'Agent inbox',
  ownerId: 'U1',
  ownerName: 'Z',
  activityState: 'idle',
  activeLegStartedAtMs: 0,
  activeAccumulatedMs: 120_000,
  lastActivity: '2026-10-25T10:00:00.000Z',
  ...over,
});

describe('D1 — the status tag carries a tone', () => {
  const face = load<{ renderCardFace(s: unknown, col: string): string }>(FACE_FNS, FACE_VARS, FACE_ENV);
  const tone = (html: string) => /<span class="card-status" data-tone="([a-z]+)">/.exec(html)?.[1];

  it('waiting → wait, working → run, idle → done, closed (sleeping or archived) → rest', () => {
    expect(tone(face.renderCardFace(faceCard({ activityState: 'waiting' }), 'waiting'))).toBe('wait');
    expect(tone(face.renderCardFace(faceCard({ activityState: 'working', activeLegStartedAtMs: T0 }), 'working'))).toBe(
      'run',
    );
    expect(tone(face.renderCardFace(faceCard(), 'idle'))).toBe('done');
    expect(tone(face.renderCardFace(faceCard({ sessionState: 'SLEEPING' }), 'closed'))).toBe('rest');
    expect(tone(face.renderCardFace(faceCard({ terminated: true }), 'closed'))).toBe('rest');
  });

  it('an armed automatic resume in RUNNING is a wait, not a run', () => {
    const s = faceCard({ autoResume: { kind: 'error-retry', at: T0, attempt: 1, maxAttempts: 3, reason: '429' } });
    const html = face.renderCardFace(s, 'working');
    expect(tone(html)).toBe('wait');
    expect(html).toContain('is-resume'); // the status markup inside is unchanged
  });

  it('the status markup keeps its parts: icon, text, prefix, clock, recency', () => {
    const html = face.renderCardFace(faceCard({ finishedAt: T0 }), 'idle');
    expect(html).toContain(
      '<span class="card-status" data-tone="done"><span class="st-icon"><span class="st-dot"></span></span><span class="st-text"><span class="st-prefix">Done in </span>',
    );
    expect(html).toContain(`<span class="st-ago"><span class="rel-time" data-ts="${T0}"></span></span>`);
  });
});

// ── D4 — the status icon pops on a state change ──
describe('D4 — a state change pops the status icon', () => {
  function fakeCard(state: string | null) {
    const icon = {
      calls: [] as unknown[][],
      animate(...a: unknown[]) {
        this.calls.push(a);
        return {};
      },
    };
    const face = {
      innerHTML: '',
      querySelector: (sel: string) => (sel === '.card-status .st-icon' ? icon : null),
    };
    const body = { innerHTML: '', querySelector: () => null };
    const attrs: Record<string, string | undefined> = { 'data-col': 'waiting' };
    if (state) attrs['data-state'] = state;
    const el = {
      attrs,
      getAttribute(n: string) {
        return this.attrs[n] ?? null;
      },
      setAttribute(n: string, v: string) {
        this.attrs[n] = v;
      },
      _faceEl: face,
      _faceHtml: 'old-face',
      _bodyEl: body,
      _bodyHtml: 'body',
    };
    return { el, icon };
  }
  function applier(opts: { animate?: boolean; reduce?: boolean } = {}) {
    return load<{ applyCardParts(el: unknown, p: unknown): boolean }>(
      ['isEditingGoal', 'isPickingModel', 'captureGoalDraft', 'restoreGoalDraft', 'popStatusIcon', 'applyCardParts'],
      [],
      {
        document: { activeElement: null },
        updateTimersIn: () => {},
        animateCountersIn: () => {},
        morphInnerHtml: () => {},
        anFocusCapture: () => null,
        anFocusRestore: () => {},
        canAnimate: () => opts.animate !== false,
        reduceMotion: () => !!opts.reduce,
        MOTION: { move: 320, easeOut: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      },
    );
  }
  const parts = (state: string, face = 'new-face') => ({ col: 'working', state, face, body: 'body', cid: null });

  it('a card that moved from waiting to working pops once: 320ms, scale 0.6 → 1, ease-out', () => {
    const { el, icon } = fakeCard('waiting');
    applier().applyCardParts(el, parts('working'));
    expect(icon.calls.length).toBe(1);
    const [frames, timing] = icon.calls[0] as [unknown, { duration: number; easing: string }];
    expect(frames).toEqual([
      { opacity: 0, transform: 'scale(0.6)' },
      { opacity: 1, transform: 'scale(1)' },
    ]);
    expect(timing.duration).toBe(320);
    expect(timing.easing).toBe('cubic-bezier(0.23, 1, 0.32, 1)');
  });

  it('no pop: same state with a new face, a brand-new card, reduced motion, a hidden tab', () => {
    const same = fakeCard('waiting');
    applier().applyCardParts(same.el, parts('waiting'));
    expect(same.icon.calls.length).toBe(0);
    const fresh = fakeCard(null);
    applier().applyCardParts(fresh.el, parts('working'));
    expect(fresh.icon.calls.length).toBe(0);
    const reduced = fakeCard('waiting');
    applier({ reduce: true }).applyCardParts(reduced.el, parts('working'));
    expect(reduced.icon.calls.length).toBe(0);
    const hidden = fakeCard('waiting');
    applier({ animate: false }).applyCardParts(hidden.el, parts('working'));
    expect(hidden.icon.calls.length).toBe(0);
  });
});

// ── D5 — state first, column later ──
describe('D5 — holdLanes: the new state in place first, the move 900ms later', () => {
  type Hold = { from: string; to: string; until: number };
  const holdLanes = (
    want: Record<string, string>,
    drawn: Record<string, string>,
    holds: Record<string, Hold>,
    now: number,
    on: boolean,
  ) => loadHold().holdLanes(want, drawn, holds, now, on);
  const loadHold = () =>
    load<{
      holdLanes(
        want: Record<string, string>,
        drawn: Record<string, string>,
        holds: Record<string, { from: string; to: string; until: number }>,
        now: number,
        on: boolean,
      ): {
        lanes: Record<string, string>;
        holds: Record<string, { from: string; to: string; until: number }>;
        wakeAt: number;
      };
    }>(['holdLanes'], ['BOARD_HOLD_MS']);

  it('a change first seen keeps the card where it is drawn and wakes at now + 900', () => {
    const r = holdLanes({ a: 'working', b: 'waiting' }, { a: 'waiting', b: 'waiting' }, {}, T0, true);
    expect(r.lanes).toEqual({ a: 'waiting', b: 'waiting' });
    expect(r.holds.a).toEqual({ from: 'waiting', to: 'working', until: T0 + 900 });
    expect(r.holds.b).toBeUndefined();
    expect(r.wakeAt).toBe(T0 + 900);
  });

  it('at the deadline the card goes to its new column and the hold is gone', () => {
    const held = { a: { from: 'waiting', to: 'working', until: T0 + 900 } };
    const early = holdLanes({ a: 'working' }, { a: 'waiting' }, held, T0 + 899, true);
    expect(early.lanes.a).toBe('waiting');
    expect(early.wakeAt).toBe(T0 + 900);
    const due = holdLanes({ a: 'working' }, { a: 'waiting' }, held, T0 + 900, true);
    expect(due.lanes.a).toBe('working');
    expect(due.holds.a).toBeUndefined();
    expect(due.wakeAt).toBe(0);
  });

  it('data that flips back drops the hold; a second target keeps the first deadline', () => {
    const held = { a: { from: 'waiting', to: 'working', until: T0 + 900 } };
    const back = holdLanes({ a: 'waiting' }, { a: 'waiting' }, held, T0 + 300, true);
    expect(back.lanes.a).toBe('waiting');
    expect(back.holds.a).toBeUndefined();
    const retarget = holdLanes({ a: 'done' }, { a: 'waiting' }, held, T0 + 300, true);
    expect(retarget.holds.a).toEqual({ from: 'waiting', to: 'done', until: T0 + 900 });
  });

  it('no hold without motion, for a card not drawn yet, and holds of cards that left are dropped', () => {
    const off = holdLanes({ a: 'working' }, { a: 'waiting' }, {}, T0, false);
    expect(off.lanes.a).toBe('working');
    expect(off.holds).toEqual({});
    const fresh = holdLanes({ a: 'working' }, {}, {}, T0, true);
    expect(fresh.lanes.a).toBe('working');
    const gone = holdLanes({}, { a: 'waiting' }, { a: { from: 'waiting', to: 'working', until: T0 + 900 } }, T0, true);
    expect(gone.holds).toEqual({});
  });

  it('the hold is 900ms', () => {
    expect(clientVar('BOARD_HOLD_MS')).toBe('var BOARD_HOLD_MS = 900;');
  });
});

describe('D5 — applyLaneHolds: a held card stays in its container with its new state, counted there', () => {
  function container(id: string) {
    return { id, children: [] as unknown[] };
  }
  function setup(now: number, on = true) {
    const cWaiting = container('cards-waiting');
    const cWorking = container('cards-working');
    const cDay = container('day-1');
    const elA = { _colId: 'waiting', parentNode: cWaiting };
    const elB = { _colId: 'waiting', parentNode: cWaiting };
    cWaiting.children.push(elA, elB);
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const env = {
      _cardEls: { a: elA, b: elB } as Record<string, unknown>,
      _laneHolds: Object.create(null),
      _laneHoldTimer: 0,
      _lastBoardData: { waiting: [], working: [] },
      canAnimate: () => on,
      reduceMotion: () => false,
      renderBoard: () => {},
      Date: { now: () => now },
      setTimeout: (fn: () => void, ms: number) => {
        timers.push({ ms, fn });
        return timers.length;
      },
      clearTimeout: () => {},
    };
    const fns = load<{ applyLaneHolds(slots: unknown[], counts: Record<string, number>): void }>(
      ['holdLanes', 'applyLaneHolds'],
      ['BOARD_HOLD_MS'],
      env,
    );
    const sa = { key: 'a' };
    const sb = { key: 'b' };
    const slots = [
      { colId: 'waiting', container: cWaiting, items: [{ s: sb, col: 'waiting' }] },
      { colId: 'working', container: cWorking, items: [{ s: sa, col: 'working' }] },
      { colId: 'done', day: 'd1', container: cDay, items: [] },
    ];
    const counts = { waiting: 1, working: 1, done: 0 };
    return { fns, slots, counts, timers, sa };
  }

  it('the answered card stays first in NEEDS YOU, drawn as working; badges count where it is drawn', () => {
    const { fns, slots, counts, timers, sa } = setup(T0);
    fns.applyLaneHolds(slots, counts);
    const waiting = slots[0].items as Array<{ s: unknown; col: string }>;
    expect(waiting.map((i) => i.s)).toEqual([sa, { key: 'b' }]);
    expect(waiting[0].col).toBe('working'); // the new state, in the old place
    expect(slots[1].items).toEqual([]);
    expect(counts).toEqual({ waiting: 2, working: 0, done: 0 });
    expect(timers.length).toBe(1);
    expect(timers[0].ms).toBeGreaterThanOrEqual(900);
  });

  it('two cards leaving one column together keep their order there during the hold (astra P2)', () => {
    const c = container('cards-waiting');
    const w = container('cards-working');
    const els: Record<string, { _colId: string; parentNode: unknown }> = {};
    for (const k of ['a', 'b', 'c']) {
      els[k] = { _colId: 'waiting', parentNode: c };
      c.children.push(els[k]);
    }
    const fns = load<{ applyLaneHolds(slots: unknown[], counts: Record<string, number>): void }>(
      ['holdLanes', 'applyLaneHolds'],
      ['BOARD_HOLD_MS'],
      {
        _cardEls: els,
        _laneHolds: Object.create(null),
        _laneHoldTimer: 0,
        _lastBoardData: null,
        canAnimate: () => true,
        reduceMotion: () => false,
        renderBoard: () => {},
        Date: { now: () => T0 },
        setTimeout: () => 1,
        clearTimeout: () => {},
      },
    );
    // a and b both start running — in either order in the RUNNING data.
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ]) {
      const slots = [
        { colId: 'waiting', container: c, items: [{ s: { key: 'c' }, col: 'waiting' }] },
        { colId: 'working', container: w, items: order.map((k) => ({ s: { key: k }, col: 'working' })) },
      ];
      const counts = { waiting: 1, working: 2 };
      fns.applyLaneHolds(slots, counts);
      expect(
        (slots[0].items as Array<{ s: { key: string } }>).map((i) => i.s.key),
        order.join(''),
      ).toEqual(['a', 'b', 'c']);
      expect(counts).toEqual({ waiting: 3, working: 0 });
    }
  });

  it('without motion the card moves at once and nothing is scheduled', () => {
    const { fns, slots, counts, timers, sa } = setup(T0, false);
    fns.applyLaneHolds(slots, counts);
    expect((slots[1].items as Array<{ s: unknown }>).map((i) => i.s)).toEqual([sa]);
    expect(counts).toEqual({ waiting: 1, working: 1, done: 0 });
    expect(timers.length).toBe(0);
  });
});

// ── D6 — the announcer ──
describe('D6 — a polite announcement of the board', () => {
  function announcer() {
    // The region counts its writes, so "said once" and "said nothing" are observable.
    const live = {
      text: '',
      writes: [] as string[],
      get textContent() {
        return this.text;
      },
      set textContent(v: string) {
        this.text = v;
        this.writes.push(v);
      },
    };
    const timers: Array<{ fn: () => void }> = [];
    const fns = load<{ boardAnnounceText(w: number, r: number): string; announceBoard(w: number, r: number): void }>(
      ['setTextIfChanged', 'boardAnnounceText', 'announceBoard'],
      ['ANNOUNCE_MS', '_announceTimer', '_announceText'],
      {
        document: { getElementById: (id: string) => (id === 'inbox-live' ? live : null) },
        setTimeout: (fn: () => void) => {
          timers.push({ fn });
          return timers.length;
        },
      },
    );
    const flush = () => {
      const due = timers.splice(0);
      for (const t of due) t.fn();
    };
    return { fns, live, timers, flush };
  }
  const say = (w: number, r: number) => `응답이 필요한 세션 ${w}개, 실행 중 ${r}개`;

  it('says how many need you and how many run', () => {
    expect(announcer().fns.boardAnnounceText(2, 3)).toBe(say(2, 3));
  });

  it('the first sentence goes into the empty region at once — the same counts again inside the window keep it (PR #450 R1 P1)', () => {
    const { fns, live, timers, flush } = announcer();
    fns.announceBoard(2, 1);
    fns.announceBoard(2, 1); // loadSessions / a WS push re-render with the same counts
    expect(live.textContent).toBe(say(2, 1));
    expect(timers.length).toBe(0);
    flush();
    expect(live.textContent).toBe(say(2, 1));
    expect(live.writes).toEqual([say(2, 1)]);
  });

  it('a burst of real changes within a second is said once — the last text', () => {
    const { fns, live, timers, flush } = announcer();
    fns.announceBoard(1, 0);
    fns.announceBoard(2, 0);
    fns.announceBoard(2, 1);
    expect(timers.length).toBe(1);
    expect(live.textContent).toBe(say(1, 0));
    flush();
    expect(live.textContent).toBe(say(2, 1));
    expect(live.writes).toEqual([say(1, 0), say(2, 1)]);
  });

  it('a change that returns before the flush says nothing new; the next change is said', () => {
    const { fns, live, timers, flush } = announcer();
    fns.announceBoard(2, 1);
    fns.announceBoard(3, 1);
    fns.announceBoard(2, 1);
    flush();
    expect(live.writes).toEqual([say(2, 1)]);
    fns.announceBoard(3, 1);
    expect(timers.length).toBe(1);
    flush();
    expect(live.textContent).toBe(say(3, 1));
  });

  it('the same counts again schedule nothing', () => {
    const { fns, timers } = announcer();
    fns.announceBoard(2, 1);
    fns.announceBoard(2, 1);
    expect(timers.length).toBe(0);
  });

  it('coalesces over ANNOUNCE_MS = 1000', () => {
    expect(clientVar('ANNOUNCE_MS')).toBe('var ANNOUNCE_MS = 1000;');
  });
});

// ── D7 — Escape ──
describe('D7 — Escape closes the open card and puts focus back on its face', () => {
  function setup(targetInCard: boolean, open = true, extra: Record<string, unknown> = {}) {
    const focus: unknown[] = [];
    const toggled: Array<[string, boolean]> = [];
    const faceEl = { focus: (o: unknown) => focus.push(o) };
    const card = {
      _faceEl: faceEl,
      getAttribute: (n: string) => (n === 'data-session-key' ? 'k1' : null),
    };
    const root = { contains: (n: unknown) => n === card };
    const target = { closest: (sel: string) => (targetInCard && sel === '.card.is-expanded' ? card : null), ...extra };
    let stopped = 0;
    const e = { key: 'Escape', target, stopPropagation: () => stopped++ };
    const env = {
      _expanded: new Set<string>(open ? ['k1'] : []),
      toggleCard: (k: string, instant: boolean) => toggled.push([k, instant]),
    };
    const { closeCardOnEscape } = load<{ closeCardOnEscape(e: unknown, root: unknown): boolean }>(
      ['closeCardOnEscape'],
      [],
      env,
    );
    return { run: () => closeCardOnEscape(e, root), focus, toggled, stopped: () => stopped };
  }

  it('inside an open card: closes it without motion, focuses its face, keeps the panel', () => {
    const t = setup(true);
    expect(t.run()).toBe(true);
    expect(t.toggled).toEqual([['k1', true]]);
    expect(t.focus).toEqual([{ preventScroll: true }]);
    expect(t.stopped()).toBe(1);
  });

  it('a text field, a select or an editable region keeps its own Escape — the card stays open (fable P2)', () => {
    for (const extra of [
      { tagName: 'INPUT' },
      { tagName: 'textarea' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      const t = setup(true, true, extra);
      expect(t.run(), JSON.stringify(extra)).toBe(false);
      expect(t.toggled).toEqual([]);
      expect(t.stopped()).toBe(0);
    }
    // A button inside the open card still closes it.
    expect(setup(true, true, { tagName: 'BUTTON' }).run()).toBe(true);
  });

  it('outside an open card: untouched (the panel handler still sees it)', () => {
    const t = setup(false);
    expect(t.run()).toBe(false);
    expect(t.toggled).toEqual([]);
    expect(t.stopped()).toBe(0);
  });

  it('is wired to the board roots', () => {
    const init = TEMPLATE.slice(TEMPLATE.indexOf('(function initBoardInteractions() {'));
    expect(init.slice(0, init.indexOf('})();'))).toContain(
      "if (e.key === 'Escape') { closeCardOnEscape(e, root); return; }",
    );
  });
});

// ── D8 — aria-controls ──
describe('D8 — the face names the region it opens', () => {
  function fakeEl(tag: string) {
    const attrs: Record<string, string> = {};
    return {
      tag,
      id: '',
      className: '',
      kids: [] as unknown[],
      setAttribute(n: string, v: string) {
        attrs[n] = v;
      },
      getAttribute(n: string) {
        return attrs[n] ?? null;
      },
      appendChild(k: unknown) {
        this.kids.push(k);
      },
    };
  }
  type Shell = { _faceEl: ReturnType<typeof fakeEl>; _expandEl: ReturnType<typeof fakeEl> };
  it('aria-controls → the expand id; ids are unique and never carry the session key', () => {
    const { createCardShell } = load<{ createCardShell(key: string): Shell }>(['createCardShell'], ['_cardSeq'], {
      document: { createElement: fakeEl },
    });
    const a = createCardShell('self::C1:t1');
    const b = createCardShell('self::C2:t2');
    expect(a._faceEl.getAttribute('aria-controls')).toBe(a._expandEl.id);
    expect(b._faceEl.getAttribute('aria-controls')).toBe(b._expandEl.id);
    expect(a._expandEl.id).toMatch(/^card-x-\d+$/);
    expect(a._expandEl.id).not.toBe(b._expandEl.id);
    expect(a._expandEl.getAttribute('inert')).toBe('');
  });
});

// ── D10 — one primary per open card ──
describe('D10 — one primary button per open card', () => {
  const STUBS: Record<string, unknown> = {
    dhShow: () => true,
    formatTokens: (n: number) => `${n}`,
    formatNmSSs: () => '0',
    cardTotalTokens: () => 0,
    _goalErrors: {},
    safeHref: (u: string) => u,
    getEnvBadgeColor: () => '#000',
    _envCount: () => 1,
    isSiblingSession: () => false,
    renderCardIo: () => '[IO]',
    renderCardArtifacts: () => '[ARTS]',
    renderAgentTree: () => '[AGENTS]',
    renderTimeline: () => '[TASKS]',
    renderPermissionBlock: () => '[PERM]',
    resolveRecommendedId: () => null,
    stripRecommendedMarker: (l: string) => l,
    choiceDataAttrs: () => '',
    renderMultiChoiceCard: () => '[MC]',
    renderModelNote: () => '',
    renderModelPicker: () => '[MODEL]',
    renderEffortPicker: () => '[EFFORT]',
    effortLabel: (e: string) => e,
    currentUserId: 'U1',
    SELF_INSTANCE_NAME: '',
    READ_ONLY_MSG: 'read only',
  };
  const body = (s: Record<string, unknown>, col: string, inject: Record<string, unknown> = {}) =>
    load<{ renderCardBody(s: unknown, col: string): string }>(
      [
        'esc',
        'escAttr',
        'escJs',
        'toNum',
        'formatTaskTime',
        'pendingAutoResume',
        'autoResumeLabel',
        'permissionSummary',
        'cardSummary',
        'cardCurrentTask',
        'renderCardResume',
        'isBusy',
        'sessionActionHtml',
        'cardGoalLine',
        'renderCardBody',
      ],
      ['RESUME_SVG', 'GOAL_STATUS_LABELS', 'SESSION_ACTION_ARIA', '_busy'],
      { ...STUBS, ...inject },
    ).renderCardBody(s, col);
  const card = (over: Record<string, unknown> = {}) => ({
    key: 'inst::C1:t1',
    conversationId: 'conv-1',
    ownerId: 'U1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'waiting',
    lastActivity: new Date(T0).toISOString(),
    ...over,
  });
  const worklog = (html: string) => /<button type="button" class="([^"]*)"[^>]*>작업 로그<\/button>/.exec(html)?.[1];
  const question = { type: 'user_choice', question: 'Ship it?', choices: [{ id: '1', label: 'Yes' }] };
  const perm = (requesterId: string) => ({ approvalId: 'ap1', toolName: 'Bash', requesterId });

  it('nothing to answer here: 작업 로그 is the primary', () => {
    expect(worklog(body(card({ activityState: 'working' }), 'working'))).toBe('btn-action btn-primary');
    expect(worklog(body(card({ activityState: 'idle' }), 'idle'))).toBe('btn-action btn-primary');
  });

  it('my question or my permission prompt: the decision is the primary, 작업 로그 steps back', () => {
    expect(worklog(body(card({ pendingQuestion: question }), 'waiting'))).toBe('btn-action');
    expect(worklog(body(card({ pendingPermissions: [perm('U1')] }), 'working'))).toBe('btn-action');
  });

  it("someone else's decision (not the owner, not the requester, a sibling instance, a closed card): 작업 로그 stays primary", () => {
    expect(worklog(body(card({ ownerId: 'U2', pendingQuestion: question }), 'waiting'))).toBe('btn-action btn-primary');
    expect(worklog(body(card({ pendingPermissions: [perm('U2')] }), 'working'))).toBe('btn-action btn-primary');
    expect(worklog(body(card({ pendingPermissions: [perm('U1')] }), 'closed'))).toBe('btn-action btn-primary');
    const sibling = {
      SELF_INSTANCE_NAME: 'a',
      isSiblingSession: () => true,
    };
    const s = card({ pendingQuestion: question, environment: { instanceName: 'b', host: 'h', port: 1 } });
    expect(worklog(body(s, 'waiting', sibling))).toBe('btn-action btn-primary');
  });

  it("a recommended answer is ink only where this viewer can answer it: the owner's card on this instance (astra P1)", () => {
    const rec = {
      type: 'user_choice',
      question: 'Ship it?',
      recommendedChoiceId: '1',
      choices: [
        { id: '1', label: 'Yes' },
        { id: '2', label: 'No' },
      ],
    };
    const inject = { resolveRecommendedId: (id: string) => id };
    const recClass = (html: string) => /<button class="(btn-choice btn-choice-recommended[^"]*)"/.exec(html)?.[1];
    // Mine, here: the recommended answer is the ink primary, 작업 로그 steps back.
    const mine = body(card({ pendingQuestion: rec }), 'waiting', inject);
    expect(recClass(mine)).toBe('btn-choice btn-choice-recommended');
    expect(worklog(mine)).toBe('btn-action');
    // Mine on a sibling instance: 작업 로그 is the primary, the recommended answer is quiet.
    const sib = { ...inject, SELF_INSTANCE_NAME: 'a', isSiblingSession: () => true };
    const there = body(
      card({ pendingQuestion: rec, environment: { instanceName: 'b', host: 'h', port: 1 } }),
      'waiting',
      sib,
    );
    expect(recClass(there)).toBe('btn-choice btn-choice-recommended is-quiet');
    expect(worklog(there)).toBe('btn-action btn-primary');
    // Someone else's question: quiet (and disabled), 작업 로그 the primary.
    const theirs = body(card({ ownerId: 'U2', pendingQuestion: rec }), 'waiting', inject);
    expect(recClass(theirs)).toBe('btn-choice btn-choice-recommended is-quiet');
    expect(worklog(theirs)).toBe('btn-action btn-primary');
  });

  it("the multi-question 답변하기 is the primary in the owner's card only (fable P2), never on a sibling instance (astra P1)", () => {
    let sibling = false;
    const { renderMultiChoiceCard } = load<{ renderMultiChoiceCard(s: unknown, f: string): string }>(
      ['esc', 'escJs', 'renderMultiChoiceCard'],
      [],
      { _mcState: {}, console, currentUserId: 'U1', isSiblingSession: () => sibling },
    );
    const q = { type: 'user_choices', title: 'Pick', questions: [{ id: 'q1' }] };
    expect(renderMultiChoiceCard({ key: 'k', ownerId: 'U1', pendingQuestion: q }, '')).toContain(
      '<button class="btn-choice btn-choice-primary"',
    );
    for (const ownerId of ['U2', undefined]) {
      expect(renderMultiChoiceCard({ key: 'k', ownerId, pendingQuestion: q }, ''), String(ownerId)).toContain(
        '<button class="btn-choice" onclick=',
      );
    }
    sibling = true;
    expect(renderMultiChoiceCard({ key: 'k', ownerId: 'U1', pendingQuestion: q }, '')).toContain(
      '<button class="btn-choice" onclick=',
    );
  });
});

// ── D10 — the card's lead Approve (astra P1): one ink even with two answerable prompts ──
describe('D10 — renderPermissionBlock marks only the first Approve this viewer can press, in the card only', () => {
  function client(viewer: string, sibling = false) {
    const names = ['esc', 'escAttr', 'isPermissionRequester', 'renderPermissionBlock'];
    const env: Record<string, unknown> = {
      currentUserId: viewer,
      isSiblingSession: () => sibling,
      loadPermissionDetail: () => {},
      _permDetails: { ap1: { input: 'ls' }, ap2: { input: 'rm -rf build' } },
      _permNotes: {},
    };
    const keys = Object.keys(env);
    const src = `${clientArrayVar('PERM_DECISIONS')}\n${names.map(clientFn).join('\n')}\nreturn { renderPermissionBlock };`;
    return new Function(...keys, src)(...keys.map((k) => env[k])) as {
      renderPermissionBlock(s: unknown, where: string): string;
    };
  }
  const two = (requester: string) => ({
    key: 'inst::C1:t1',
    pendingPermissions: [
      { approvalId: 'ap1', toolName: 'Bash', requesterId: requester, rules: [] },
      { approvalId: 'ap2', toolName: 'Bash', requesterId: requester, rules: [] },
    ],
  });
  const approves = (html: string) =>
    [...html.matchAll(/<button type="button" class="([^"]*btn-perm-approve[^"]*)"[^>]*data-perm-id="([^"]+)"/g)].map(
      (m) => [m[2], m[1]],
    );

  it('two prompts from the same requester: the first Approve is the lead, the second is not', () => {
    expect(approves(client('U1').renderPermissionBlock(two('U1'), 'card'))).toEqual([
      ['ap1', 'btn-perm btn-perm-approve is-lead'],
      ['ap2', 'btn-perm btn-perm-approve'],
    ]);
  });

  it('a prompt the viewer cannot answer is skipped: the lead is the first answerable one', () => {
    const s = two('U1');
    s.pendingPermissions[0].requesterId = 'U2';
    expect(approves(client('U1').renderPermissionBlock(s, 'card'))).toEqual([
      ['ap1', 'btn-perm btn-perm-approve'],
      ['ap2', 'btn-perm btn-perm-approve is-lead'],
    ]);
  });

  it('no lead in the panel, for another viewer, or on a sibling instance', () => {
    expect(client('U1').renderPermissionBlock(two('U1'), 'panel')).not.toContain('is-lead');
    expect(client('U2').renderPermissionBlock(two('U1'), 'card')).not.toContain('is-lead');
    expect(client('U1', true).renderPermissionBlock(two('U1'), 'card')).not.toContain('is-lead');
  });
});
