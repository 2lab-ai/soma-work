/**
 * Z 2026-11-21 — "https://libraries.dev/waves 이거 ui repo에 추가해주고 soma-work 작업카드 상태 변할때 사용해줘 / fable모델은
 * 요란하게 다른 것들은 좀 살짝 / … 모든 컴포넌트 각각도 다 추가해주고 어디에 적용할지 고민해서 최적한 스팟이 있으면 적용해줘".
 * The page half of the Libraries.dev effects (@2lab.ai/ui 0.44.0), run from the shipped client code cut out of
 * renderDashboardPage()'s template literal (the wave tier itself: card-finish-client.test.ts):
 *
 *   E1  the board's cards keep `wave` through every layout (faceOf's FACE_KEEP)
 *   E2  the 시작 중 launch card wears the border beam (ntPendingCardOf — dashboard-new-task-launch-card.test.ts)
 *   E3  the detail card's head shows the card's face: <ui-bot-avatar id="panel-avatar"> before the title, its module
 *       loaded; panelAvatarOf picks the face by model family and the state by the session; renderPanelAvatar paints it
 *       (hidden with no open card, attributes untouched when unchanged)
 *   E4  the conversation's writing row carries the agent's last tool as the thinking orb's state (convPendingOf /
 *       orbActivityOf — the library's ORB_TOOL_STATES), for the main agent and a running subagent
 *   E5  the detail card's next steps are drops of one liquid (<ui-gooey>): a new answer's steps split out of one drop
 *       once, the pressed step swallows the others as it is sent, the bar waits for that before it goes; the open
 *       card's stack stays plain; reduced motion / no element: no motion at all
 *   E6  a live phone call's view wears <ui-voice-ring>: its state from the call record (phoneRingOf), the module loaded
 *       on the first live call, the element gone (loop and WebGL lens with it) once the call ends or the view closes
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
/** A `var NAME = [ … ];` block that spans lines. */
function clientBlock(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} = [`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const end = TEMPLATE.indexOf('\n];\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 4));
}

describe('E1 — faceOf keeps the wave in every layout', () => {
  const { faceOf } = new Function(`${VIEW_LAYOUT_CLIENT_JS}\nreturn { faceOf };`)() as {
    faceOf(card: unknown, model: string, face: unknown): Record<string, unknown>;
  };
  it('a card with no rows on keeps its wave, as it keeps its status', () => {
    const out = faceOf({ id: 'a', title: 't', status: 'running', wave: 'loud', summary: 's' }, 'm', {
      rows: [],
      foot: [],
    });
    expect(out.wave).toBe('loud');
    expect(out.summary).toBeUndefined();
  });
});

describe('E3 — the card’s face in the detail card’s head', () => {
  const PAGE = TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body')));
  it('the head holds a decorative <ui-bot-avatar> before the title, hidden until a card is open; its module loads', () => {
    const head = PAGE.slice(PAGE.indexOf('<div class="panel-header">'));
    const avatar = head.indexOf('<ui-bot-avatar id="panel-avatar"');
    expect(avatar).toBeGreaterThan(0);
    expect(avatar).toBeLessThan(head.indexOf('id="panel-title"'));
    expect(head).toContain(
      '<ui-bot-avatar id="panel-avatar" class="panel-avatar" size="28" decorative lang="ko" hidden>',
    );
    expect(DASHBOARD_TS).toContain(
      '<script type="module" src="/dashboard/ui/bot-avatar.js?v=${UI_LIB_VERSION}"></script>',
    );
    expect(clientFn('renderPanelHead')).toContain("if (typeof renderPanelAvatar === 'function') renderPanelAvatar(s);");
  });

  const fns = new Function(
    'turnHolds',
    'document',
    `${clientBlock('PANEL_AVATAR_SHAPES')}\n${clientFn('panelAvatarOf')}\n${clientFn('renderPanelAvatar')}\nreturn { panelAvatarOf, renderPanelAvatar };`,
  );
  const turnHolds = (s: { activityState?: string; turnBusy?: boolean } | null) =>
    !!s && (s.activityState === 'working' || s.turnBusy === true);

  it('the face by model family (whole words), the state by the session', () => {
    const { panelAvatarOf } = fns(turnHolds, null) as { panelAvatarOf(s: unknown): { shape: string; state: string } };
    const shape = (model: string) => panelAvatarOf({ model }).shape;
    expect(shape('claude-fable-5-2[1m]')).toBe('star');
    expect(shape('claude-opus-5-5[1m]')).toBe('droid');
    expect(shape('claude-sonnet-4-6')).toBe('cloud');
    expect(shape('claude-haiku-4-5')).toBe('pebble');
    expect(shape('gpt-6-astra[1m]')).toBe('alien');
    expect(shape('gpt-6.1-sol[1m]')).toBe('circle');
    expect(shape('grok-4.7')).toBe('mech');
    expect(shape('gemini-3-pro')).toBe('clover');
    expect(shape('gpt-6-astral')).toBe('blob');
    expect(shape('console-1')).toBe('blob');
    expect(shape('')).toBe('blob');
    const state = (s: Record<string, unknown>) => panelAvatarOf(s).state;
    expect(state({ activityState: 'working' })).toBe('working');
    expect(state({ activityState: 'idle', turnBusy: true })).toBe('working');
    expect(state({ activityState: 'waiting' })).toBe('default');
    expect(state({ activityState: 'idle', sessionState: 'SLEEPING' })).toBe('sleeping');
    expect(state({ activityState: 'working', terminated: true })).toBe('sleeping');
  });

  it('renderPanelAvatar paints the open card’s face and hides it with none; an unchanged face is not touched', () => {
    const attrs: Record<string, string> = {};
    let sets = 0;
    const el = {
      hidden: true,
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
        sets++;
      },
    };
    const doc = { getElementById: (id: string) => (id === 'panel-avatar' ? el : null) };
    const { renderPanelAvatar } = fns(turnHolds, doc) as { renderPanelAvatar(s: unknown): void };
    renderPanelAvatar({ model: 'claude-fable-5-2[1m]', activityState: 'working' });
    expect(el.hidden).toBe(false);
    expect(attrs).toEqual({ shape: 'star', state: 'working' });
    const before = sets;
    renderPanelAvatar({ model: 'claude-fable-5-2[1m]', activityState: 'working' });
    expect(sets).toBe(before);
    renderPanelAvatar({ model: 'claude-fable-5-2[1m]', activityState: 'idle', sessionState: 'SLEEPING' });
    expect(attrs.state).toBe('sleeping');
    renderPanelAvatar(null);
    expect(el.hidden).toBe(true);
  });
});

/** A `var NAME = { … };` block that spans lines. */
function clientObj(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} = {`);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const end = TEMPLATE.indexOf('\n};\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 4));
}

describe('E4 — the writing row’s orb follows the agent’s last tool', () => {
  const { orbActivityOf, convPendingOf } = new Function(
    `${clientObj('ORB_TOOL_STATE')}\n${clientFn('orbActivityOf')}\n${clientFn('convPendingOf')}\nreturn { orbActivityOf, convPendingOf };`,
  )() as { orbActivityOf(t: unknown): string; convPendingOf(t: unknown): { activity: string } };

  it.each([
    ['Read', 'searching'],
    ['Grep', 'searching'],
    ['WebFetch', 'searching'],
    ['Edit', 'composing'],
    ['MultiEdit', 'composing'],
    ['Bash', 'working'],
    ['Task', 'weaving'],
    ['Agent', 'weaving'],
    ['TodoWrite', 'shaping'],
    ['mcp__github__create_pull_request', 'connecting'],
    ['  bash  ', 'working'],
    ['', 'breathing'],
    [undefined, 'breathing'],
    ['__proto__', 'breathing'],
    ['SomethingNew', 'breathing'],
  ])('%s → %s', (tool, state) => {
    expect(orbActivityOf(tool)).toBe(state);
  });

  it('the pending turn carries it; convPaint and the subagent chat hand it to <ui-conversation>', () => {
    expect(convPendingOf('Edit')).toEqual({ activity: 'composing' });
    expect(clientFn('convPaint')).toContain('convPendingOf(s && s.agentRoot && s.agentRoot.lastTool)');
    expect(TEMPLATE).toContain("pending: typeof convPendingOf === 'function' ? convPendingOf(a.lastTool) : true");
  });
});

describe('E5 — the next steps split out of one drop and merge into the one pressed (ui-gooey)', () => {
  const fnSrc = (name: string) => {
    const start = TEMPLATE.indexOf(`\nvar ${name} = `);
    if (start < 0) throw new Error(`client var ${name} not found`);
    return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n', start + 1)));
  };
  const VARS = ['NA_GOO_BLUR', 'NA_GOO_RING', 'NA_SPLIT_MS', 'NA_MERGE_MS', '_naSplitSeen'].map(fnSrc).join('\n');

  it('the detail card’s bar is a <ui-gooey> row of items, each holding one real button; the card stack stays plain', () => {
    const html = new Function(
      'isBusy',
      'nextActionsOpen',
      `var _naSent = {}; var NEXT_ACTIONS_LABEL = '다음 행동';
      function esc(s) { return String(s); } function escAttr(s) { return String(s); }
      ${VARS}\n${clientFn('naGooRow')}\n${clientFn('nextActionsHtml')}\nreturn nextActionsHtml;`,
    )(
      () => false,
      () => true,
    ) as (s: unknown, na: unknown, where: string) => string;
    const na = {
      turnId: 'a1',
      list: [
        { label: 'dev 배포', command: '$user:dev', recommended: true },
        { label: '', command: '1193 진행' },
      ],
    };
    const panel = html({ key: 'k' }, na, 'panel');
    expect(panel).toContain(
      '<ui-gooey class="na-row na-goo" fill="var(--ui-ib-card)" shadow="0 0 0 1px var(--ui-ib-card-border)" blur="4">',
    );
    expect(panel.match(/<ui-gooey-item><button /g)?.length).toBe(2);
    expect(panel).toContain('</button></ui-gooey-item></ui-gooey>');
    const card = html({ key: 'k' }, na, 'card');
    expect(card).toContain('<div class="na-row"><button ');
    expect(card).not.toContain('ui-gooey');
    expect(DASHBOARD_TS).toContain('<script type="module" src="/dashboard/ui/gooey.js?v=${UI_LIB_VERSION}"></script>');
    expect(DASHBOARD_TS).toContain('.na-goo > ui-gooey-item { display: flex; min-width: 0; max-width: 100%; }');
    // The liquid is the outline steps' body only once the element is defined: no module, plain buttons.
    expect(DASHBOARD_TS).toContain(
      '.na-goo:defined .na-btn:not(.is-primary):not(:hover) { background: transparent; border-color: transparent; }',
    );
  });

  type Item = {
    rect: { left: number; top: number; width: number; height: number };
    sets: Record<string, unknown>[];
    data: Record<string, unknown>;
    firstElementChild: { style: Record<string, string>; getAttribute(n: string): string | null };
    getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  };
  const item = (left: number, top: number, width: number, cmd: string): Item => {
    const it = {
      rect: { left, top, width, height: 32 },
      sets: [] as Record<string, unknown>[],
      firstElementChild: {
        style: {} as Record<string, string>,
        getAttribute: (n: string) => (n === 'data-na-cmd' ? cmd : null),
      },
      getBoundingClientRect(this: { rect: Item['rect'] }) {
        return this.rect;
      },
    } as unknown as Item;
    Object.defineProperty(it, 'data', {
      set(v: Record<string, unknown>) {
        it.sets.push(v);
      },
      get() {
        return it.sets[it.sets.length - 1];
      },
    });
    return it;
  };
  function harness(opts: { reduced?: boolean; defined?: boolean } = {}) {
    const timers: (() => void)[] = [];
    const painted: number[] = [];
    const api = new Function(
      'customElements',
      'reduceMotion',
      'requestAnimationFrame',
      'setTimeout',
      'renderPanelNext',
      `${VARS}\n${['naGooItems', 'naGooLive', 'naGooRender', 'naSplitOnce', 'naSplitIn', 'naMergeInto'].map(clientFn).join('\n')}
      return { naSplitOnce, naSplitIn, naMergeInto };`,
    )(
      { get: (t: string) => (opts.defined === false ? undefined : t === 'ui-gooey-item' ? class {} : undefined) },
      () => opts.reduced === true,
      (f: () => void) => f(),
      (f: () => void) => timers.push(f),
      () => painted.push(1),
    ) as {
      naSplitOnce(bar: unknown, key: string, na: unknown): boolean;
      naSplitIn(bar: unknown): boolean;
      naMergeInto(bar: unknown, cmd: string): boolean;
    };
    return { api, timers, painted };
  }
  const barOf = (items: Item[]) => ({
    hidden: false,
    querySelectorAll: (sel: string) => (sel === 'ui-gooey-item' ? items : []),
  });

  it('split in: every step but the first starts inside the first (no time), then runs out 40ms apart, its words fading in', () => {
    const items = [item(10, 100, 120, 'a'), item(138, 100, 90, 'b'), item(10, 140, 80, 'c')];
    // Fresh from innerHTML the slots are not rendered yet: the group and the items render before anything is measured.
    const order: string[] = [];
    const row = { renderNow: () => order.push('row') };
    items.forEach((it, i) => {
      Object.assign(it, { closest: () => row, renderNow: () => order.push(`item${i}`) });
      const rect = it.rect;
      it.getBoundingClientRect = () => (order.push(`measure${i}`), rect);
    });
    const { api } = harness();
    expect(api.naSplitIn(barOf(items))).toBe(true);
    expect(order.slice(0, 5)).toEqual(['row', 'item0', 'item1', 'item2', 'measure0']);
    expect(items[0].sets).toEqual([]);
    expect(items[1].sets[0]).toEqual({ x: -128, y: 0, scale: 0.7, transition: { duration: 0 } });
    expect(items[2].sets[0]).toEqual({ x: 0, y: -40, scale: 0.7, transition: { duration: 0 } });
    expect(items[1].sets[1]).toMatchObject({ x: 0, y: 0, scale: 1, delay: 0, transition: { duration: 520 } });
    expect(items[2].sets[1]).toMatchObject({ x: 0, y: 0, scale: 1, delay: 40 });
    expect(items[2].firstElementChild.style.opacity).toBe('');
    expect(items[2].firstElementChild.style.transition).toBe('opacity 200ms ease 180ms');
  });

  it('once per answer; nothing moves under reduced motion, without the element, or with one step', () => {
    const items = () => [item(0, 0, 50, 'a'), item(60, 0, 50, 'b')];
    const { api } = harness();
    const first = items();
    expect(api.naSplitOnce(barOf(first), 'k', { turnId: 'a1' })).toBe(true);
    const again = items();
    expect(api.naSplitOnce(barOf(again), 'k', { turnId: 'a1' })).toBe(false);
    expect(again[1].sets).toEqual([]);
    expect(api.naSplitOnce(barOf(items()), 'k', { turnId: 'a2' })).toBe(true);
    expect(api.naSplitOnce(barOf(items()), 'k', {})).toBe(false);
    const still = items();
    expect(harness({ reduced: true }).api.naSplitIn(barOf(still))).toBe(false);
    expect(still[1].sets).toEqual([]);
    expect(harness({ defined: false }).api.naSplitIn(barOf(items()))).toBe(false);
    expect(harness().api.naSplitIn(barOf([item(0, 0, 50, 'a')]))).toBe(false);
  });

  it('merge: the others run into the pressed step’s centre and shrink, words fading; the bar is held, then repainted', () => {
    const items = [item(10, 100, 120, 'a'), item(138, 100, 90, 'b'), item(236, 100, 60, 'c')];
    // The press repainted the bar busy a moment ago: its fresh items render before the merge measures them.
    const order: string[] = [];
    items.forEach((it, i) => {
      Object.assign(it, {
        closest: () => ({ renderNow: () => order.push('row') }),
        renderNow: () => order.push(`item${i}`),
      });
      const rect = it.rect;
      it.getBoundingClientRect = () => (order.push(`measure${i}`), rect);
    });
    const bar = barOf(items) as Record<string, unknown>;
    const { api, timers, painted } = harness();
    expect(api.naMergeInto(bar, 'b')).toBe(true);
    expect(order.slice(0, 5)).toEqual(['row', 'item0', 'item1', 'item2', 'measure1']);
    expect(items[1].sets).toEqual([]);
    expect(items[0].sets[0]).toMatchObject({ x: 113, y: 0, scale: 0.4, transition: { duration: 300 } });
    expect(items[2].sets[0]).toMatchObject({ x: -83, y: 0, scale: 0.4 });
    expect(items[0].firstElementChild.style.opacity).toBe('0');
    expect(bar._naMergeUntil).toBeGreaterThan(Date.now());
    timers.forEach((f) => f());
    expect(bar._naMergeUntil).toBe(0);
    expect(painted.length).toBe(1);
    expect(api.naMergeInto(barOf(items), 'gone')).toBe(false);
    expect(api.naMergeInto({ ...barOf(items), hidden: true }, 'b')).toBe(false);
  });

  it('renderPanelNext keeps the buttons while the merge runs, splits a new set in, and the press starts the merge', () => {
    const bar: Record<string, unknown> = { hidden: false, innerHTML: '<b>old</b>', _html: '<b>old</b>' };
    let html = '';
    const split: unknown[] = [];
    const render = new Function(
      'document',
      'nextActionsHtml',
      'naSplitOnce',
      `var panelOpen = true; var panelSessionKey = 'k'; var _sessionCache = { k: { key: 'k', conversationId: 'c' } };
      var _viewerIsAdmin = true; var _panelTurnsAct = ''; var _panelTurnsCid = 'c'; var _panelTurnsList = [];
      function viewerOwns() { return true; } function nextActionsOfTurns() { return { turnId: 't9', list: [] }; }
      ${clientFn('renderPanelNext')}\nreturn renderPanelNext;`,
    )(
      { getElementById: () => bar },
      () => html,
      (_b: unknown, key: string, na: unknown) => split.push([key, na]),
    ) as () => void;
    bar._naMergeUntil = Date.now() + 10_000;
    render();
    expect(bar.innerHTML).toBe('<b>old</b>');
    expect(bar.hidden).toBe(false);
    bar._naMergeUntil = 0;
    render();
    expect(bar.hidden).toBe(true);
    expect(bar.innerHTML).toBe('');
    html = '<b>new</b>';
    render();
    expect(bar.innerHTML).toBe('<b>new</b>');
    expect(split).toEqual([['k', { turnId: 't9', list: [] }]]);
    render();
    expect(split.length).toBe(1);

    const calls: string[] = [];
    const press = new Function(
      'sendNextAction',
      'naMergeInto',
      'document',
      `${clientFn('nextActionButton')}\nreturn nextActionButton;`,
    )(
      (k: string, t: string, c: string) => calls.push(`send ${k} ${t} ${c}`),
      (_b: unknown, c: string) => calls.push(`merge ${c}`),
      { getElementById: () => ({}) },
    ) as (b: unknown) => void;
    const attrs: Record<string, string> = { 'data-na-key': 'k', 'data-na-turn': 't9', 'data-na-cmd': '$user:dev' };
    press({ disabled: false, getAttribute: (n: string) => attrs[n], closest: () => ({}) });
    expect(calls).toEqual(['send k t9 $user:dev', 'merge $user:dev']);
    calls.length = 0;
    press({ disabled: false, getAttribute: (n: string) => attrs[n], closest: () => null });
    expect(calls).toEqual(['send k t9 $user:dev']);
  });
});

describe('E6 — the live call’s voice ring (ui-voice-ring in the phone dialog)', () => {
  const ringFns = (inject: Record<string, unknown>) =>
    new Function(
      ...Object.keys(inject),
      `var PH_RING_TICK_MS = 50; var PH_RING_SRC = '/dashboard/ui/voice-ring.js?v=t';
      var _phRingLoad = null; var _phRingTimer = null;
      function toNum(v) { var n = Number(v); return isFinite(n) ? n : 0; }
      ${['phoneRingOf', 'phoneRingVoice', 'phoneRingLoad', 'phoneRingSync'].map(clientFn).join('\n')}
      return { phoneRingOf, phoneRingVoice, phoneRingLoad, phoneRingSync };`,
    )(...Object.values(inject)) as {
      phoneRingOf(call: unknown, now: number): { state: string; until: number } | null;
      phoneRingVoice(): number;
      phoneRingSync(v: unknown): void;
    };

  it('the dialog holds a ring box above the content renderPhoneDialog rewrites; the module source is versioned', () => {
    expect(TEMPLATE).toContain(
      '<div class="phone-dialog-inner"><div class="ph-ringbox" id="phone-ring-box" hidden></div><div class="ph-dcontent" id="phone-dialog-body"></div></div>',
    );
    expect(TEMPLATE).toContain('onclose="_phoneView=null;if(typeof phoneRingSync===\'function\')phoneRingSync(null)"');
    expect(DASHBOARD_TS).toContain("var PH_RING_SRC = '/dashboard/ui/voice-ring.js?v=${UI_LIB_VERSION}';");
    expect(clientFn('renderPhoneDialog')).toMatch(/phoneRingSync\(v\);\n {2}var html = phoneDialogHtml\(v\);/);
    expect(clientFn('closePhoneCall')).toContain("if (typeof phoneRingSync === 'function') phoneRingSync(null);");
    expect(DASHBOARD_TS).toContain(
      '.ph-dcontent { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }',
    );
  });

  it('phoneRingOf: dialing thinks, the agent’s speech speaks until its audio has played, an unanswered line thinks', () => {
    const { phoneRingOf } = ringFns({});
    expect(phoneRingOf(null, 0)).toBeNull();
    expect(phoneRingOf({ status: 'ended', transcript: [], work: [] }, 0)).toBeNull();
    expect(phoneRingOf({ status: 'dialing' }, 0)).toEqual({ state: 'processing', until: 0 });
    expect(phoneRingOf({ status: 'active', transcript: [], work: [] }, 0)).toEqual({ state: 'listening', until: 0 });
    // The other party spoke; nothing answered it yet.
    const heard = { status: 'active', transcript: [{ role: 'peer', at: 1000, text: '여보세요' }], work: [] };
    expect(phoneRingOf(heard, 1500)).toEqual({ state: 'processing', until: 0 });
    // A reply, its speech not synthesised yet.
    const replied = { ...heard, work: [{ kind: 'reply', at: 1800, text: '네', ms: 300 }] };
    expect(phoneRingOf(replied, 2000)).toEqual({ state: 'speaking', until: 0 });
    // Synthesised at 2100 (first byte 200ms, 1.5s of audio): speaking until 3800, then listening.
    const spoke = {
      ...replied,
      transcript: [...heard.transcript, { role: 'agent', at: 2100, text: '네' }],
      work: [...replied.work, { kind: 'tts', at: 2100, text: '네', firstByteMs: 200, audioMs: 1500 }],
    };
    expect(phoneRingOf(spoke, 3000)).toEqual({ state: 'speaking', until: 3800 });
    expect(phoneRingOf(spoke, 3800)).toEqual({ state: 'listening', until: 0 });
    // The other party again, after the agent: processing.
    const again = { ...spoke, transcript: [...spoke.transcript, { role: 'peer', at: 5000, text: '그리고요' }] };
    expect(phoneRingOf(again, 5200)).toEqual({ state: 'processing', until: 0 });
  });

  it('phoneRingVoice moves like speech and stays in 0…1', () => {
    const { phoneRingVoice } = ringFns({});
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const v = phoneRingVoice();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      seen.add(Math.round(v * 100));
      const until = performance.now() + 3;
      while (performance.now() < until) {
        /* let time move */
      }
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('phoneRingSync: a live call gets one ring (module loaded once), its state and speech level; the end takes it away', () => {
    type El = { attrs: Record<string, string>; data?: { level: unknown }; _phSpeaking?: boolean };
    let made = 0;
    const box: Record<string, unknown> & { firstElementChild: (El & Record<string, unknown>) | null } = {
      hidden: true,
      firstChild: null,
      firstElementChild: null,
      set innerHTML(html: string) {
        made++;
        const attrs: Record<string, string> = {};
        for (const m of html.matchAll(/ ([a-z-]+)(?:="([^"]*)")?/g)) attrs[m[1]] = m[2] ?? '';
        const el = {
          attrs,
          getAttribute: (k: string) => attrs[k] ?? null,
          setAttribute: (k: string, v: string) => {
            attrs[k] = v;
          },
        };
        box.firstElementChild = el;
        box.firstChild = el;
      },
      set textContent(_v: string) {
        box.firstElementChild = null;
        box.firstChild = null;
      },
    };
    const timers: { f: () => void; ms: number }[] = [];
    const imports: string[] = [];
    let defined = false;
    const view = { call: { status: 'dialing' } as Record<string, unknown> };
    const fns = new Function(
      'document',
      'customElements',
      'setTimeout',
      'clearTimeout',
      'Date',
      'importer',
      `var _phoneView = null; function setView(v) { _phoneView = v; }
      var PH_RING_TICK_MS = 50; var PH_RING_SRC = '/dashboard/ui/voice-ring.js?v=t';
      var _phRingLoad = null; var _phRingTimer = null;
      function toNum(v) { var n = Number(v); return isFinite(n) ? n : 0; }
      ${['phoneRingOf', 'phoneRingVoice', 'phoneRingSync'].map(clientFn).join('\n')}
      ${clientFn('phoneRingLoad').replace('import(PH_RING_SRC)', 'importer(PH_RING_SRC)')}
      return { phoneRingSync, phoneRingVoice, setView };`,
    )(
      {
        getElementById: (id: string) => (id === 'phone-ring-box' ? box : null),
        documentElement: { getAttribute: () => 'light' },
      },
      { get: () => (defined ? class {} : undefined) },
      (f: () => void, ms: number) => (timers.push({ f, ms }), timers.length),
      () => {},
      { now: () => 3000 },
      (src: string) => (imports.push(src), Promise.resolve()),
    ) as { phoneRingSync(v: unknown): void; phoneRingVoice(): number; setView(v: unknown): void };
    fns.setView(view);
    fns.phoneRingSync(view);
    expect(box.hidden).toBe(false);
    const el = box.firstElementChild as El;
    expect(el.attrs).toMatchObject({
      class: 'ph-ring',
      type: 'ring',
      size: '88',
      decorative: '',
      lang: 'ko',
      theme: 'light',
    });
    expect(el.attrs.state).toBe('processing');
    expect(el.data).toEqual({ level: 0 });
    expect(imports).toEqual(['/dashboard/ui/voice-ring.js?v=t']);
    // Speaking until 3800: the level is the speech getter, and a re-check is set for the end of the audio.
    view.call = {
      status: 'active',
      transcript: [{ role: 'agent', at: 2100, text: '네' }],
      work: [{ kind: 'tts', at: 2100, firstByteMs: 200, audioMs: 1500 }],
    };
    defined = true;
    fns.phoneRingSync(view);
    expect(made).toBe(1); // the same element
    expect(el.attrs.state).toBe('speaking');
    expect(typeof el.data?.level).toBe('function');
    expect(timers[timers.length - 1]?.ms).toBe(800);
    expect(imports.length).toBe(1);
    // The call ends: the ring goes.
    view.call = { status: 'ended', transcript: [], work: [] };
    fns.phoneRingSync(view);
    expect(box.firstElementChild).toBeNull();
    expect(box.hidden).toBe(true);
    fns.phoneRingSync(null);
    expect(box.hidden).toBe(true);
  });
});
