/**
 * SSOT 2026-11-13 — 입력 필요 is the chat's last message.
 *
 * Before: the detail card drew 입력 필요 (the approvals, the question, a plan) right under the title bar, above the
 * tab bar and the chat. Answering needs the conversation that led to the ask, and the zone pushed it away — the
 * reader could not scroll up through the chat while the question stayed where they answer it.
 *
 * Now, while the card shows the main agent's 대화 and something waits on the user:
 *
 *   대화 ┌ … the conversation (scroll up for the context)
 *        ├ [bot] 아래에서 답하면 작업이 이어집니다.
 *        │      ┌ 입력 필요 2 ─────────────────┐   ← #panel-needs, slotted as the turn's attachments-panel-needs
 *        │      │ approval card · question     │
 *        └      └──────────────────────────────┘   (no writing row under it — the agent waits on the reader)
 *
 * On 작업 로그 · 에이전트 트리, on a subagent, or with nothing waiting, the zone is back under the title bar (never in a
 * tab). Executes the shipped page code cut out of renderDashboardPage()'s template literal (the harness of
 * dashboard-steer-chat-client.test.ts) over a small fake DOM.
 *
 *   N1  who waits, and where the zone goes (panelNeedsCount · panelNeedsInChat · needsTurnOf)
 *   N2  placePanelNeeds moves #panel-needs into the chat and back, and hides it under the title bar when empty
 *   N3  syncPanelNeeds repaints the chat only when the zone comes or goes
 *   N4  convPaint: the zone's turn is the chat's last, with no writing row under it
 *   N5  convSlots never drops the zone; psecClear and a subagent's chat send it back under the title bar
 *   N6  an opening with the zone in the chat lands on the chat (its newest), not on a question above it
 *   N7  focus survives a move: the last answer hands it to a safe place; into the chat it returns once drawn
 *   N8  a decided plan alone keeps the box shown under the title bar, through the real renderPanelPlan
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { nextActionSeams } from '../__fixtures__/viewer-scope';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function assertUnique(name: string) {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
}
function clientFn(name: string): string {
  assertUnique(name);
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  assertUnique(name);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  inject = { ...nextActionSeams(fns, inject), ...inject };
  const names = Object.keys(inject);
  const setter = '__set: function(n, v) { eval(n + " = v"); }';
  const getter = '__get: function(n) { return eval(n); }';
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${[...fns, setter, getter].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);

// ── A small DOM: ids, a parent, ordered children, attributes (slot), hidden and style.display ──
// Every reparent counts: a box moved when nothing changed would drop the focus in a card the reader is answering.
let moves = 0;
// Focus, as a browser keeps it: only a drawn node takes it — not under a hidden (or display:none) ancestor, not in a
// light-DOM child whose slot the host has not drawn yet (`drawn`) — and taking a node out of the page blurs a focused
// node inside it (focus falls to <body>).
const BODY = { id: 'body' };
const focus: { active: unknown } = { active: BODY };
class El {
  id: string;
  children: El[] = [];
  parentNode: El | null = null;
  hidden = false;
  style = { display: '' };
  attrs: Record<string, string> = {};
  /** A shadow host's drawn slots (the chat: the turns' slots its last render made). */
  drawn?: Set<string>;
  constructor(id = '') {
    this.id = id;
  }
  get slot(): string {
    return this.attrs.slot ?? '';
  }
  set slot(v: string) {
    this.attrs.slot = v;
  }
  getAttribute(n: string): string | null {
    return n in this.attrs ? this.attrs[n] : null;
  }
  setAttribute(n: string, v: string) {
    this.attrs[n] = String(v);
  }
  removeAttribute(n: string) {
    delete this.attrs[n];
  }
  contains(x: unknown): boolean {
    return x === this || this.children.some((c) => c.contains(x));
  }
  /** In the page: under the card's surface or its chat (the fake's two roots). */
  get isConnected(): boolean {
    let n: El = this;
    while (n.parentNode) n = n.parentNode;
    return n.id === 'panel-surface' || n.id === 'panel-conv';
  }
  rendered(): boolean {
    for (let n: El | null = this; n; n = n.parentNode) {
      if (n.hidden || n.style.display === 'none') return false;
      const slot = n.attrs.slot;
      if (slot && n.parentNode?.drawn && !n.parentNode.drawn.has(slot)) return false;
    }
    return true;
  }
  focus() {
    if (this.rendered()) focus.active = this;
  }
  set innerHTML(_v: string) {
    for (const c of [...this.children]) c.remove();
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    if (this.contains(focus.active)) focus.active = BODY;
    p.children.splice(p.children.indexOf(this), 1);
    this.parentNode = null;
  }
  appendChild(c: El): El {
    moves++;
    c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: El, ref: El | null): El {
    if (!ref) return this.appendChild(c);
    moves++;
    c.remove();
    c.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, c);
    return c;
  }
}

// The detail card's parts this change touches, as the page lays them out.
function card() {
  const byId: Record<string, El> = {};
  const el = (id: string) => (byId[id] = new El(id));
  const surf = el('panel-surface');
  const needs = el('panel-needs');
  const head = el('panel-needs-head');
  const perm = el('panel-permission');
  const question = el('panel-question');
  const plan = el('panel-plan');
  head.hidden = true;
  perm.style.display = 'none';
  question.style.display = 'none';
  plan.hidden = true;
  needs.hidden = true;
  for (const part of [head, perm, question, plan]) needs.appendChild(part);
  const family = el('panel-family');
  family.hidden = true;
  for (const part of [needs, family, el('panel-needs-status'), el('panel-midbar')]) surf.appendChild(part);
  const conv = el('panel-conv');
  conv.drawn = new Set();
  el('panel-title');
  el('panel-needs-count');
  focus.active = BODY;
  const document = {
    body: BODY,
    getElementById: (id: string) => byId[id] ?? null,
    get activeElement() {
      return focus.active;
    },
  };
  return { byId, surf, needs, head, perm, question, plan, family, conv, document };
}

const WAITING = { key: 'k', activityState: 'working', pendingPermissions: [{ approvalId: 'a1', toolName: 'Bash' }] };
const IDLE = { key: 'k', activityState: 'idle', pendingPermissions: [] };
const PLACE_FNS = ['panelQuestionShown', 'panelNeedsCount', 'panelNeedsInChat', 'placePanelNeeds', 'needsRefocus'];
const NEEDS_VARS = ['NEEDS_TURN_ID', 'NEEDS_SLOT', 'NEEDS_TURN_TEXT'];

function placer(session: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  const c = card();
  const m = load<{
    placePanelNeeds(): boolean;
    __set(n: string, v: unknown): void;
  }>(PLACE_FNS, NEEDS_VARS, {
    document: c.document,
    panelSessionKey: session ? 'k' : '',
    _sessionCache: session ? { k: session } : {},
    _psec: 'conv',
    _panelAgent: '',
    ...over,
  });
  return { ...c, m };
}

describe('N1 — who waits, and where the zone goes', () => {
  const m = load<{
    panelNeedsCount(s: unknown): number;
    panelNeedsInChat(psec: string, agent: string, n: number): boolean;
    needsTurnOf(bot: string): Record<string, unknown>;
  }>(['panelQuestionShown', 'panelNeedsCount', 'panelNeedsInChat', 'needsTurnOf'], NEEDS_VARS);

  it('counts the prompts, a goal decision, the instruction approvals, the question and a plan to start', () => {
    expect(m.panelNeedsCount(null)).toBe(0);
    expect(m.panelNeedsCount(IDLE)).toBe(0);
    expect(
      m.panelNeedsCount({
        activityState: 'waiting',
        pendingPermissions: [{}, {}],
        pendingGoalDecision: { decisionId: 'g' },
        pendingInstructionApprovals: [{}],
        pendingQuestion: { type: 'user_choice', choices: [{}] },
        taskPlan: { state: 'awaiting', revision: 1 },
      }),
    ).toBe(6);
    // An approved plan waits on no one.
    expect(m.panelNeedsCount({ activityState: 'working', taskPlan: { state: 'approved', revision: 2 } })).toBe(0);
  });

  it('goes in the chat only on 대화, on the main agent, with something waiting', () => {
    expect(m.panelNeedsInChat('conv', '', 1)).toBe(true);
    expect(m.panelNeedsInChat('conv', '', 0)).toBe(false);
    expect(m.panelNeedsInChat('log', '', 1)).toBe(false);
    expect(m.panelNeedsInChat('tree', '', 2)).toBe(false);
    expect(m.panelNeedsInChat('conv', 'a3', 1)).toBe(false);
  });

  it('its turn is the bot’s answer that carries the zone in its file row (attachments-panel-needs)', () => {
    expect(m.needsTurnOf('Soma')).toEqual({
      id: 'panel-needs',
      role: 'assistant',
      name: 'Soma',
      markdown: '아래에서 답하면 작업이 이어집니다.',
      // A blank source: no 원본 disclosure on the ask's turn (review).
      source: ' ',
      attachments: true,
    });
  });
});

describe('N2 — placePanelNeeds moves the zone into the chat and back', () => {
  it('waiting, on 대화: the zone is the chat’s slotted child, shown', () => {
    const p = placer(WAITING);
    expect(p.m.placePanelNeeds()).toBe(true);
    expect(p.needs.parentNode).toBe(p.conv);
    expect(p.needs.getAttribute('slot')).toBe('attachments-panel-needs');
    expect(p.needs.hidden).toBe(false);
    expect(p.surf.children.map((x) => x.id)).toEqual(['panel-family', 'panel-needs-status', 'panel-midbar']);
    // A second call moves nothing (review P2: no reparent — a focused answer stays focused).
    const before = moves;
    expect(p.m.placePanelNeeds()).toBe(true);
    expect(moves).toBe(before);
    expect(p.conv.children.filter((x) => x.id === 'panel-needs')).toHaveLength(1);
  });

  it('on 작업 로그 it goes back under the title bar, where it was (before the family line), without its slot', () => {
    const p = placer(WAITING);
    p.m.placePanelNeeds();
    p.perm.style.display = '';
    p.m.__set('_psec', 'log');
    expect(p.m.placePanelNeeds()).toBe(false);
    expect(p.needs.parentNode).toBe(p.surf);
    expect(p.surf.children.map((x) => x.id)).toEqual([
      'panel-needs',
      'panel-family',
      'panel-needs-status',
      'panel-midbar',
    ]);
    expect(p.needs.getAttribute('slot')).toBeNull();
    expect(p.needs.hidden).toBe(false);
    // Already there: no reparent.
    const before = moves;
    p.m.placePanelNeeds();
    expect(moves).toBe(before);
  });

  it('on a subagent it stays under the title bar (the ask is the main agent’s)', () => {
    const p = placer(WAITING, { _panelAgent: 'a3' });
    p.perm.style.display = '';
    expect(p.m.placePanelNeeds()).toBe(false);
    expect(p.needs.parentNode).toBe(p.surf);
  });

  it('with nothing waiting it is under the title bar, hidden while none of its parts shows', () => {
    const p = placer(IDLE);
    expect(p.m.placePanelNeeds()).toBe(false);
    expect(p.needs.parentNode).toBe(p.surf);
    expect(p.needs.hidden).toBe(true);
    // A decided plan still shows there (folded), as before.
    p.plan.hidden = false;
    p.m.placePanelNeeds();
    expect(p.needs.hidden).toBe(false);
  });

  it('after the phone moves the status bar to the surface’s top, the zone still goes back under it', () => {
    const p = placer(WAITING);
    p.m.placePanelNeeds();
    const status = new El('panel-status');
    p.surf.insertBefore(status, p.surf.children[0]);
    p.m.__set('_psec', 'tree');
    p.m.placePanelNeeds();
    expect(p.surf.children.map((x) => x.id).slice(0, 3)).toEqual(['panel-status', 'panel-needs', 'panel-family']);
  });
});

describe('N3 — syncPanelNeeds repaints the chat only when the zone comes or goes', () => {
  function syncer(session: Record<string, unknown>) {
    const c = card();
    const convPaint = vi.fn();
    const m = load<{ syncPanelNeeds(): void; __set(n: string, v: unknown): void }>(
      [...PLACE_FNS, 'syncPanelNeeds'],
      NEEDS_VARS,
      {
        document: c.document,
        panelSessionKey: 'k',
        _sessionCache: { k: session },
        _psec: 'conv',
        _panelAgent: '',
        convPaint,
      },
    );
    return { ...c, m, convPaint, session };
  }

  it('an ask arrives: the zone goes in the chat and the chat paints its turn; the same state again paints nothing', () => {
    const p = syncer({ ...IDLE });
    p.m.syncPanelNeeds();
    expect(p.convPaint).not.toHaveBeenCalled();
    p.session.pendingPermissions = WAITING.pendingPermissions;
    p.m.syncPanelNeeds();
    expect(p.needs.parentNode).toBe(p.conv);
    expect(p.convPaint).toHaveBeenCalledTimes(1);
    p.m.syncPanelNeeds();
    expect(p.convPaint).toHaveBeenCalledTimes(1);
  });

  it('the last ask is answered: the zone leaves the chat and the chat paints without its turn', () => {
    const p = syncer({ ...WAITING });
    p.m.syncPanelNeeds();
    expect(p.convPaint).toHaveBeenCalledTimes(1);
    p.session.pendingPermissions = [];
    p.m.syncPanelNeeds();
    expect(p.needs.parentNode).toBe(p.surf);
    expect(p.convPaint).toHaveBeenCalledTimes(2);
  });

  it('the needs head keeps its count and lets the zone follow', () => {
    const c = card();
    const syncPanelNeeds = vi.fn();
    const count = new El('panel-needs-count');
    const m = load<{ renderPanelNeedsHead(s: unknown): void }>(
      ['panelQuestionShown', 'panelNeedsCount', 'renderPanelNeedsHead'],
      [],
      {
        document: {
          getElementById: (id: string) => (id === 'panel-needs-count' ? count : c.document.getElementById(id)),
        },
        syncPanelNeeds,
      },
    );
    (count as unknown as { textContent: string }).textContent = '';
    m.renderPanelNeedsHead(WAITING);
    expect(c.head.hidden).toBe(false);
    expect((count as unknown as { textContent: string }).textContent).toBe('1');
    expect(syncPanelNeeds).toHaveBeenCalledTimes(1);
  });
});

describe('N4 — convPaint: the zone’s turn is the chat’s last, with no writing row under it', () => {
  const LIST = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
    { id: 'u2', role: 'user' },
  ];
  function painter(session: Record<string, unknown>, pendingShow = true, list = LIST, msg = '') {
    const c = card();
    const sets: { turns: { id: string; role?: string }[]; pending?: boolean; startText?: string; loading?: boolean }[] =
      [];
    const m = load<{ convPaint(): void; __set(n: string, v: unknown): void }>(
      [...PLACE_FNS, 'needsTurnOf', 'convPaint'],
      [...NEEDS_VARS, 'CONV_EMPTY', '_resumSent'],
      {
        document: c.document,
        convEl: () => c.conv,
        _psec: 'conv',
        _panelAgent: '',
        panelSessionKey: 'k',
        _sessionCache: { k: session },
        panelConvId: 'c',
        _panelTurnsCid: 'c',
        _panelTurnsList: list,
        _panelTurnsMsg: msg,
        _panelTurnsHasMore: false,
        _panelTurnsLoading: false,
        _panelTurnsWhy: '',
        _panelOlderWhy: '',
        _panelDetail: false,
        _rawLoadedCache: {},
        _ansFailed: {},
        _artCache: {},
        botNameOf: () => 'Soma',
        ansLinkTitles: () => ({}),
        ansSession: () => null,
        ansPendingShow: () => pendingShow,
        convTurnsOf: (turns: { id: string; role: string }[]) => ({
          turns: turns.map((t) => ({ id: t.id, role: t.role })),
          slots: [],
        }),
        convSlots: () => {},
        convSetData: (_el: unknown, d: { turns: { id: string }[]; pending?: boolean; startText?: string }) =>
          sets.push(d),
        rbIndex: () => null,
        rewindSpansOf: () => null,
        renderAgentConv: () => {},
      },
    );
    return { ...c, m, last: () => sets[sets.length - 1] };
  }

  it('something waits: the zone is in the chat, its turn is last, and the writing row is off', () => {
    const p = painter({ ...WAITING });
    p.m.convPaint();
    const d = p.last();
    expect(d.turns.map((t) => t.id)).toEqual(['u1', 'a1', 'u2', 'panel-needs']);
    expect(d.turns[3]).toMatchObject({ role: 'assistant', name: 'Soma', attachments: true });
    expect(d.pending).toBe(false);
    expect(p.needs.parentNode).toBe(p.conv);
  });

  it('the ask alone while the turns load: no “대화의 시작” above it (review); with turns the start line is back', () => {
    const p = painter({ ...WAITING }, true, [], 'loading');
    p.m.convPaint();
    expect(p.last().turns.map((t) => t.id)).toEqual(['panel-needs']);
    expect(p.last().startText).toBe('');
    expect(p.last().loading).toBe(true);
    const q = painter({ ...WAITING });
    q.m.convPaint();
    expect(q.last().startText).toBe('대화의 시작');
  });

  it('nothing waits: no zone turn, the writing row as before', () => {
    const p = painter({ ...IDLE });
    p.m.convPaint();
    const d = p.last();
    expect(d.turns.map((t) => t.id)).toEqual(['u1', 'a1', 'u2']);
    expect(d.pending).toBe(true);
    expect(p.needs.parentNode).toBe(p.surf);
  });

  it('on a subagent the chat is that agent’s: the zone in the chat goes back under the title bar, shown', () => {
    const p = painter({ ...WAITING });
    p.perm.style.display = '';
    p.m.convPaint();
    expect(p.needs.parentNode).toBe(p.conv);
    // The reader picks a subagent: the same box leaves the main agent's chat for the title bar, visible there.
    p.m.__set('_panelAgent', 'a3');
    p.m.convPaint();
    expect(p.needs.parentNode).toBe(p.surf);
    expect(p.needs.getAttribute('slot')).toBeNull();
    expect(p.needs.hidden).toBe(false);
  });
});

describe('N5 — the zone survives the chat’s own housekeeping', () => {
  it('convSlots drops a turn’s stale files but never the zone', () => {
    const m = load<{ convSlots(el: unknown, slots: unknown[], cid: string): void }>(['convSlots'], [], {
      umRegister: () => {},
    });
    const conv = new El('panel-conv');
    const stale = new El('');
    stale.slot = 'attachments-old';
    const needs = new El('panel-needs');
    needs.slot = 'attachments-panel-needs';
    conv.appendChild(stale);
    conv.appendChild(needs);
    m.convSlots(conv, [], 'c');
    expect(conv.children).toEqual([needs]);
  });

  it('leaving 대화 (psecClear) sends the zone back under the title bar', () => {
    const c = card();
    const m = load<{ psecClear(sec: string): void; placePanelNeeds(): boolean; __set(n: string, v: unknown): void }>(
      [...PLACE_FNS, 'psecClear'],
      NEEDS_VARS,
      {
        document: c.document,
        panelSessionKey: 'k',
        _sessionCache: { k: { ...WAITING } },
        _psec: 'conv',
        _panelAgent: '',
        _ansIo: null,
        convEl: () => c.conv,
        convSlots: () => {},
        convSetData: () => {},
      },
    );
    m.placePanelNeeds();
    expect(c.needs.parentNode).toBe(c.conv);
    m.__set('_psec', 'log');
    m.psecClear('conv');
    expect(c.needs.parentNode).toBe(c.surf);
  });

  it('a subagent’s chat sends it back too (renderAgentConv)', () => {
    expect(clientFn('renderAgentConv')).toMatch(/_psec !== 'conv'\) return;\n[^\n]*\n {2}placePanelNeeds\(\);/);
  });
});

describe('N6 — an opening with the zone in the chat lands on the chat', () => {
  function lander(inChat: boolean) {
    const c = card();
    const scrolls: number[] = [];
    const rdReset = vi.fn();
    const rect = (top: number, bottom = top + 100) => ({ top, bottom });
    const scroll = Object.assign(new El('panel-scroll'), {
      scrollTop: 0,
      clientHeight: 600,
      getBoundingClientRect: () => rect(0),
      scrollTo: (o: { top: number }) => scrolls.push(o.top),
    });
    c.perm.style.display = '';
    Object.assign(c.perm, { getBoundingClientRect: () => rect(300) });
    Object.assign(c.head, { offsetHeight: 40 });
    c.head.hidden = false;
    if (inChat) {
      c.needs.slot = 'attachments-panel-needs';
      c.conv.appendChild(c.needs);
    }
    const secs = Object.assign(new El('panel-sections'), { getBoundingClientRect: () => rect(700) });
    const body = Object.assign(new El('panel-sections-body'), { getBoundingClientRect: () => rect(700, 1500) });
    const byId: Record<string, unknown> = {
      'panel-scroll': scroll,
      'panel-sections': secs,
      'panel-sections-body': body,
    };
    const m = load<{ landPanel(): void; __get(n: string): unknown }>(['landPanel'], [], {
      document: { getElementById: (id: string) => byId[id] ?? c.document.getElementById(id) },
      _panelLand: '',
      _panelLanded: false,
      _panelLandAt: null,
      _panelOnQuestion: false,
      _panelScrollGen: 0,
      _panelHold: false,
      _panelHoldUntil: 0,
      rdReset,
      panelReading: () => false,
      panelTabsHeight: () => 44,
      psecLandingTop: (secTop: number, _bottom: number, _view: number, under: number) => secTop - under,
    });
    return { m, scrolls, rdReset, c };
  }

  it('in the chat: the section landing (the chat at its newest), the composer back once an opening', () => {
    const l = lander(true);
    l.m.landPanel();
    expect(l.scrolls).toEqual([700 - 44]);
    expect(l.rdReset).toHaveBeenCalledTimes(1);
    expect(l.m.__get('_panelOnQuestion')).toBe('chat');
    // The landing after the turns arrive lands on the chat again, without undoing a reader who started reading.
    l.m.landPanel();
    expect(l.scrolls).toEqual([700 - 44, 700 - 44]);
    expect(l.rdReset).toHaveBeenCalledTimes(1);
  });

  it('under the title bar (off the chat): the question landing as before, head in view', () => {
    const l = lander(false);
    l.m.landPanel();
    expect(l.scrolls).toEqual([300 - 40]);
    expect(l.m.__get('_panelOnQuestion')).toBe('top');
    // Landed on the question once: a later landing of the same opening leaves the reader be.
    l.m.landPanel();
    expect(l.scrolls).toEqual([300 - 40]);
  });

  it('a chat landing, then the box back under the title bar (작업 로그, a subagent): the next landing finds the question (review)', () => {
    const l = lander(true);
    l.m.landPanel();
    expect(l.scrolls).toEqual([700 - 44]);
    l.c.needs.removeAttribute('slot');
    l.c.surf.insertBefore(l.c.needs, l.c.family);
    l.m.landPanel();
    expect(l.scrolls).toEqual([700 - 44, 300 - 40]);
    expect(l.m.__get('_panelOnQuestion')).toBe('top');
  });
});

describe('N7 — focus survives a move (review on #1259)', () => {
  const ASK_FNS = [
    ...PLACE_FNS,
    'syncPanelNeeds',
    'renderPanelNeedsHead',
    'renderPanelPermission',
    'apSafeFocus',
    'apAnnounce',
  ];

  it('the last ask answered from the keyboard: the box leaves the chat and focus lands on a safe place, not <body>', () => {
    const c = card();
    const cache: Record<string, unknown> = { k: { ...WAITING } };
    const m = load<{ renderPanelPermission(s: unknown): void }>(ASK_FNS, NEEDS_VARS, {
      document: c.document,
      panelSessionKey: 'k',
      _sessionCache: cache,
      _psec: 'conv',
      _panelAgent: '',
      // The chat draws the zone's turn when it paints (convPaint → the element's render).
      convPaint: () => c.conv.drawn?.add('attachments-panel-needs'),
      acPermissionsHtml: (s: { pendingPermissions: unknown[] }) => (s.pendingPermissions.length ? '<card>' : ''),
      acGoalDecisionHtml: () => '',
      acInstructionApprovalsHtml: () => '',
      // The prompt's card: one focusable control in the container.
      morphInnerHtml: (el: El) => {
        if (!el.children.length) el.appendChild(new El('ask-card'));
      },
      acHydrate: () => {},
    });
    m.renderPanelPermission(cache.k);
    expect(c.needs.parentNode).toBe(c.conv);
    const askCard = c.perm.children[0];
    askCard.focus();
    expect(c.document.activeElement).toBe(askCard);
    // Answered: the push no longer carries the ask.
    cache.k = { ...IDLE };
    m.renderPanelPermission(cache.k);
    expect(c.needs.parentNode).toBe(c.surf);
    expect(c.document.activeElement).toBe(c.byId['panel-title']);
  });

  it('into the chat: a control focused under the title bar gets the focus back once the chat draws its slot', async () => {
    const c = card();
    const cache: Record<string, unknown> = { k: { ...IDLE } };
    // The chat's render comes a microtask after its data (the element batches it).
    const convPaint = () => queueMicrotask(() => c.conv.drawn?.add('attachments-panel-needs'));
    const m = load<{ syncPanelNeeds(): void }>([...PLACE_FNS, 'syncPanelNeeds'], NEEDS_VARS, {
      document: c.document,
      panelSessionKey: 'k',
      _sessionCache: cache,
      _psec: 'conv',
      _panelAgent: '',
      convPaint,
    });
    // A decided plan, folded under the title bar, its summary focused.
    c.plan.hidden = false;
    const summary = new El('summary');
    c.plan.appendChild(summary);
    m.syncPanelNeeds();
    summary.focus();
    expect(c.document.activeElement).toBe(summary);
    // An ask arrives: the box moves into the chat before its turn is drawn — the focus has nowhere to stay yet.
    cache.k = { ...WAITING };
    m.syncPanelNeeds();
    expect(c.needs.parentNode).toBe(c.conv);
    expect(c.document.activeElement).toBe(BODY);
    await new Promise((r) => setTimeout(r, 5));
    expect(c.document.activeElement).toBe(summary);
  });

  it('into the chat: a reader who moved the focus meanwhile keeps it', async () => {
    const c = card();
    const cache: Record<string, unknown> = { k: { ...IDLE } };
    const m = load<{ syncPanelNeeds(): void }>([...PLACE_FNS, 'syncPanelNeeds'], NEEDS_VARS, {
      document: c.document,
      panelSessionKey: 'k',
      _sessionCache: cache,
      _psec: 'conv',
      _panelAgent: '',
      convPaint: () => queueMicrotask(() => c.conv.drawn?.add('attachments-panel-needs')),
    });
    c.plan.hidden = false;
    const summary = new El('summary');
    c.plan.appendChild(summary);
    m.syncPanelNeeds();
    summary.focus();
    cache.k = { ...WAITING };
    m.syncPanelNeeds();
    const elsewhere = new El('composer');
    elsewhere.focus();
    await new Promise((r) => setTimeout(r, 5));
    expect(c.document.activeElement).toBe(elsewhere);
  });
});

describe('N8 — a decided plan alone keeps the box shown under the title bar (real renderPanelPlan)', () => {
  it('a plan that waits on no one shows; once it is gone the box hides', () => {
    const c = card();
    const bar = new El('panel-plan-bar');
    const cache: Record<string, unknown> = {
      k: { key: 'k', activityState: 'working', taskPlan: { state: 'approved', revision: 2 } },
    };
    const m = load<{ renderPanelPlan(s: unknown): void }>(
      [...PLACE_FNS, 'syncPanelNeeds', 'renderPanelPlan'],
      NEEDS_VARS,
      {
        document: {
          ...c.document,
          getElementById: (id: string) => (id === 'panel-plan-bar' ? bar : c.document.getElementById(id)),
        },
        panelSessionKey: 'k',
        _sessionCache: cache,
        _psec: 'conv',
        _panelAgent: '',
        convPaint: () => {},
        panelPlanHtml: () => '<details class="pp-fold">…</details>',
        planBarHtml: () => '',
      },
    );
    m.renderPanelPlan(cache.k);
    // Nothing waits (the plan is decided): the box stays under the title bar, shown for the plan.
    expect(c.needs.parentNode).toBe(c.surf);
    expect(c.plan.hidden).toBe(false);
    expect(c.needs.hidden).toBe(false);
    cache.k = { key: 'k', activityState: 'working' };
    m.renderPanelPlan(cache.k);
    expect(c.plan.hidden).toBe(true);
    expect(c.needs.hidden).toBe(true);
  });
});

describe('the page and its styles', () => {
  it('the four parts are the box’s own children in the shipped markup (review: containment, not order)', async () => {
    // The shipped markup, parsed (happy-dom's parser): the box's direct children, in order.
    const win = new Window();
    const tpl = win.document.createElement('template');
    tpl.innerHTML = PAGE;
    const box = tpl.content.querySelector('#panel-needs');
    expect(box).not.toBeNull();
    expect(Array.from(box?.children ?? []).map((c) => c.id)).toEqual([
      'panel-needs-head',
      'panel-permission',
      'panel-question',
      'panel-plan',
    ]);
    expect(box?.querySelector('#panel-family')).toBeNull();
    await win.happyDOM.close();
  });

  it('one box holds the zone, under the title bar until placePanelNeeds moves it', () => {
    const at = (s: string) => PAGE.indexOf(s);
    // Its own region name: in the chat, the turn's file row around it is named for files (이 답변이 만든 파일).
    expect(PAGE).toContain('<div class="panel-needs" id="panel-needs" role="region" aria-label="입력 필요" hidden>');
    for (const id of ['panel-needs-head', 'panel-permission', 'panel-question', 'panel-plan'])
      expect(at(`id="${id}"`), id).toBeGreaterThan(at('id="panel-needs"'));
    expect(at('id="panel-family"')).toBeGreaterThan(at('id="panel-plan"'));
  });

  it('in the chat it is one framed card the width of the turn; under the title bar its parts keep their rules', () => {
    expect(CSS).toContain(
      '#panel-conv > .panel-needs { flex: 1 1 100%; min-width: 0; border: 1px solid var(--tint-wait-line);',
    );
    expect(CSS).toContain('.panel-needs[hidden] { display: none; }');
    expect(CSS).toContain(
      '.panel-surface > .panel-needs > :not([hidden]):not([style*="display:none"]):not([style*="display: none"]) + :not([hidden]) { border-top: 1px solid var(--border); }',
    );
  });
});
