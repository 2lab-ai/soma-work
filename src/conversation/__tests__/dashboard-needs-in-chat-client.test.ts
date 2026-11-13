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
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
class El {
  id: string;
  children: El[] = [];
  parentNode: El | null = null;
  hidden = false;
  style = { display: '' };
  attrs: Record<string, string> = {};
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
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 1);
    this.parentNode = null;
  }
  appendChild(c: El): El {
    c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: El, ref: El | null): El {
    if (!ref) return this.appendChild(c);
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
  const document = { getElementById: (id: string) => byId[id] ?? null };
  return { byId, surf, needs, head, perm, question, plan, family, conv, document };
}

const WAITING = { key: 'k', activityState: 'working', pendingPermissions: [{ approvalId: 'a1', toolName: 'Bash' }] };
const IDLE = { key: 'k', activityState: 'idle', pendingPermissions: [] };
const PLACE_FNS = ['panelQuestionShown', 'panelNeedsCount', 'panelNeedsInChat', 'placePanelNeeds'];
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
    // A second call moves nothing.
    expect(p.m.placePanelNeeds()).toBe(true);
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
  function painter(session: Record<string, unknown>, pendingShow = true) {
    const c = card();
    const sets: { turns: { id: string; role?: string }[]; pending?: boolean }[] = [];
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
        _panelTurnsList: [
          { id: 'u1', role: 'user' },
          { id: 'a1', role: 'assistant' },
          { id: 'u2', role: 'user' },
        ],
        _panelTurnsMsg: '',
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
        convSetData: (_el: unknown, d: { turns: { id: string }[]; pending?: boolean }) => sets.push(d),
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

  it('nothing waits: no zone turn, the writing row as before', () => {
    const p = painter({ ...IDLE });
    p.m.convPaint();
    const d = p.last();
    expect(d.turns.map((t) => t.id)).toEqual(['u1', 'a1', 'u2']);
    expect(d.pending).toBe(true);
    expect(p.needs.parentNode).toBe(p.surf);
  });

  it('on a subagent the chat is that agent’s: the zone goes under the title bar first', () => {
    const p = painter({ ...WAITING });
    p.m.__set('_panelAgent', 'a3');
    p.m.convPaint();
    expect(p.needs.parentNode).toBe(p.surf);
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
    return { m, scrolls, rdReset };
  }

  it('in the chat: the section landing (the chat at its newest), the composer back once an opening', () => {
    const l = lander(true);
    l.m.landPanel();
    expect(l.scrolls).toEqual([700 - 44]);
    expect(l.rdReset).toHaveBeenCalledTimes(1);
    expect(l.m.__get('_panelOnQuestion')).toBe(true);
    // The landing after the turns arrive lands on the chat again, without undoing a reader who started reading.
    l.m.landPanel();
    expect(l.scrolls).toEqual([700 - 44, 700 - 44]);
    expect(l.rdReset).toHaveBeenCalledTimes(1);
  });

  it('under the title bar (off the chat): the question landing as before, head in view', () => {
    const l = lander(false);
    l.m.landPanel();
    expect(l.scrolls).toEqual([300 - 40]);
    expect(l.m.__get('_panelOnQuestion')).toBe(true);
  });
});

describe('the page and its styles', () => {
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
