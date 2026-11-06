/**
 * Phone chrome (SSOT 2026-11-04) — on a phone the content takes the screen.
 *
 *   T1  the board's top bar is one line: the scope group (승인 · 관리자 · the board's user · the defaults) leaves the
 *       bar's toolbar for the board's head (syncPhoneScope) and goes back on a wide screen;
 *   T2  the detail card keeps only its title bar while the reader scrolls: the status bar joins the scroll area
 *       (syncPhoneStatus); reading (rdRead → data-read) gives the section box the whole view (sizePanelSections) and
 *       scrolls everything above it out; a tap on the title bar or the start of the history brings it back (rdStep);
 *   T3  the model picker sits on the composer's own row, left of Send: slotted into <ui-composer slot="end"> (#918,
 *       @2lab.ai/ui ≥ 0.36.0) — the page never reads the composer's shadow DOM; a narrow row draws it compact;
 *   T4  the reader's scroll away from the newest tucks the composer (data-tuck), the very bottom and ^ (#pc-reveal)
 *       bring it back — never while the reader types in it (rdStep).
 *
 * The runtime (real touch scrolls, a phone upright and sideways, the desktop unchanged) is checked in a browser:
 * scripts/screenshot-mobile-chrome.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEMPLATE = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');

/** Evaluate a template-literal fragment the way the server does (\\n → \n, \\' → \'). */
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
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
function cssRule(selector: string): string {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  return re.exec(TEMPLATE)?.[1] ?? '';
}

/** A node that knows its parent and children — enough for the moves. */
class FakeNode {
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  style = {
    props: {} as Record<string, string>,
    setProperty(k: string, v: string) {
      this.props[k] = v;
    },
  };
  constructor(public id: string) {}
  get firstChild() {
    return this.children[0] ?? null;
  }
  appendChild(n: FakeNode) {
    n.parentNode?.remove(n);
    this.children.push(n);
    n.parentNode = this;
    return n;
  }
  insertBefore(n: FakeNode, ref: FakeNode | null) {
    n.parentNode?.remove(n);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n);
    else this.children.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  remove(n: FakeNode) {
    this.children = this.children.filter((c) => c !== n);
    n.parentNode = null;
  }
  hasAttribute(k: string) {
    return k in this.attrs;
  }
  getAttribute(k: string) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
}
function fakeDocument(nodes: FakeNode[], selectors: Record<string, FakeNode> = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: (sel: string) => selectors[sel] ?? null,
  };
}

describe('the phone breakpoint is the page’s own (narrow, or a phone sideways)', () => {
  it('PHONE_MQ names the width and the height the composer row already uses', () => {
    expect(TEMPLATE).toContain("var PHONE_MQ = '(max-width: 639px), (max-height: 560px)';");
    expect(TEMPLATE).toContain('@media (max-width: 639px), (max-height: 560px) {');
  });
  it('a breakpoint change re-homes the parts and starts the card over (syncPhoneChrome on change)', () => {
    expect(clientFn('syncPhoneChrome')).toMatch(
      /syncPhoneScope\(\);\s*syncPhoneStatus\(\);\s*rdReset\(\);\s*syncPickerFit\(\);/,
    );
    expect(TEMPLATE).toContain("_phoneMq.addEventListener('change', syncPhoneChrome)");
  });
});

describe('T1 — the top bar is one line on a phone', () => {
  const setup = (phone: boolean) => {
    const bar = new FakeNode('app-bar');
    const tools = new FakeNode('inbox-tools');
    const seg = new FakeNode('view-seg');
    tools.appendChild(seg);
    const scope = new FakeNode('topbar-scope');
    bar.appendChild(scope);
    const document = fakeDocument([bar, tools, scope]);
    const m = load<{ syncPhoneScope: () => void }>(['syncPhoneScope'], { document, isPhone: () => phone });
    return { bar, tools, scope, seg, ...m };
  };

  it('a phone: the scope group leads the board’s head — the bar keeps no toolbar row', () => {
    const t = setup(true);
    t.syncPhoneScope();
    expect(t.scope.parentNode).toBe(t.tools);
    expect(t.tools.children[0]).toBe(t.scope);
    expect(t.bar.children).toHaveLength(0);
    t.syncPhoneScope(); // idempotent
    expect(t.tools.children).toEqual([t.scope, t.seg]);
  });

  it('a wide screen: it stays (or goes back to be) the bar’s toolbar', () => {
    const t = setup(false);
    t.syncPhoneScope();
    expect(t.scope.parentNode).toBe(t.bar);
    t.tools.insertBefore(t.scope, t.tools.firstChild); // where a phone left it
    t.syncPhoneScope();
    expect(t.scope.parentNode).toBe(t.bar);
    expect(t.tools.children).toEqual([t.seg]);
  });

  it('the board’s head has a place for it, and its chips keep their look there (admin on = the fail tint)', () => {
    expect(TEMPLATE).toContain('<div class="inbox-tools" id="inbox-tools">');
    expect(cssRule('.inbox-tools > .topbar-scope')).toContain('margin-right: auto;');
    expect(cssRule('.inbox-tools .admin-toggle[aria-pressed="true"]')).toContain('background: var(--tint-fail-bg);');
    expect(cssRule('.inbox-tools .topbar-defaults[hidden], .inbox-tools .td-also[hidden]')).toContain('display: none;');
  });

  it('the bar’s own rules for the group stay as they were on a wide screen', () => {
    expect(TEMPLATE).toContain('<div class="topbar-scope" id="topbar-scope" slot="toolbar">');
    expect(cssRule('.topbar .admin-toggle[aria-pressed="true"]')).toContain('background: var(--tint-fail-bg);');
  });
});

describe('T2 — only the title bar stays while the reader scrolls', () => {
  it('a phone: the status bar leaves the title bar for the top of the scroll area, and comes back on a wide screen', () => {
    const head = new FakeNode('head');
    const close = new FakeNode('close');
    head.appendChild(close);
    const status = new FakeNode('panel-status');
    head.appendChild(status);
    const surface = new FakeNode('panel-surface');
    const needs = new FakeNode('panel-needs-head');
    surface.appendChild(needs);
    const document = fakeDocument([status, surface], { '#slide-panel .panel-header': head });
    let phone = true;
    const m = load<{ syncPhoneStatus: () => void }>(['syncPhoneStatus'], { document, isPhone: () => phone });
    m.syncPhoneStatus();
    expect(surface.children).toEqual([status, needs]);
    expect(head.children).toEqual([close]);
    phone = false;
    m.syncPhoneStatus();
    expect(head.children).toEqual([close, status]);
    expect(surface.children).toEqual([needs]);
  });

  it('reading gives the section box the whole view under the section tabs (sizePanelSections, T5)', () => {
    expect(clientFn('sizePanelSections')).toContain(
      'var h = panelReading() ? Math.max(0, view - strip) : psecHeightOf(view, top, panelTabsHeight() + strip);',
    );
    // A short screen (sideways, the composer back): no floor in CSS either, or the newest rows hide behind the composer.
    expect(cssRule('.slide-panel[data-read] .psec')).toContain('min-height: 0;');
  });

  it('T5: reading lands on the section tabs (대화 · 작업 로그) — they stay right under the title bar', () => {
    const rect = (top: number) => ({ getBoundingClientRect: () => ({ top }) });
    const sc = Object.assign(rect(52), { scrollTop: 300 });
    const m = load<{ rdBoxTop: () => number }>(['rdBoxTop'], {
      document: {
        getElementById: (id: string) => (id === 'panel-scroll' ? sc : id === 'panel-sections' ? rect(200) : null),
      },
    });
    // The tabs are 148px under the scroll area's top, 300px into its content: land at 448.
    expect(m.rdBoxTop()).toBe(448);
  });

  it('T5: a glide stopped short is finished once it settles — the tabs end exactly under the title bar', () => {
    const panel = new FakeNode('slide-panel');
    const calls: string[] = [];
    const scroll = Object.assign(new FakeNode('panel-scroll'), {
      scrollTop: 0,
      scrollTo(o: { top: number; behavior: string }) {
        calls.push(`scroll ${o.top} ${o.behavior}`);
      },
    });
    const timers: Array<() => void> = [];
    const m = load<{ rdRead: (on: boolean) => void }>(['rdRead'], {
      document: fakeDocument([panel, scroll as unknown as FakeNode]),
      rdHow: () => 'smooth',
      rdBoxTop: () => 240,
      sizePanelSections: () => {},
      _rd: { leave: 0, land: 0 },
      _panelScrollGen: 0,
      setTimeout: (f: () => void) => {
        timers.push(f);
        return timers.length;
      },
      clearTimeout: () => {},
    });
    m.rdRead(true);
    expect(calls).toEqual(['scroll 240 smooth']);
    scroll.scrollTop = 234; // the reader's fling cut the glide 6px short
    timers[0]();
    expect(calls[1]).toBe('scroll 240 instant');
    expect(clientFn('rdRead')).toMatch(/if \(Math\.abs\(sc\.scrollTop - t\) <= 1\) return;\s*_panelScrollGen\+\+;/);
    // The reader's own input in the scroll area cancels it — never a pull-back of a place scrolled to by hand.
    expect(TEMPLATE).toMatch(
      /pscroll\.addEventListener\(t, function\(\) \{ clearTimeout\(_rd\.land\); \}, \{ passive: true \}\);/,
    );
    scroll.scrollTop = 240;
    timers[0](); // landed: nothing more
    expect(calls).toHaveLength(2);
    panel.removeAttribute('data-read'); // the reader left meanwhile: nothing
    scroll.scrollTop = 0;
    timers[0]();
    expect(calls).toHaveLength(2);
  });

  it('rdRead: in — the box grows, the panel scrolls it under the title bar; out — back to the top, the box shrinks when the scroll lands', () => {
    const panel = new FakeNode('slide-panel');
    const calls: string[] = [];
    const listeners: Record<string, () => void> = {};
    const scroll = Object.assign(new FakeNode('panel-scroll'), {
      scrollTop: 0,
      scrollTo(o: { top: number; behavior: string }) {
        calls.push(`scroll ${o.top} ${o.behavior}`);
        this.scrollTop = o.top;
      },
      addEventListener: (t: string, f: () => void) => {
        listeners[t] = f;
      },
      removeEventListener: (t: string) => {
        delete listeners[t];
      },
    });
    const document = fakeDocument([panel, scroll as unknown as FakeNode]);
    const timers: Array<() => void> = [];
    const m = load<{ rdRead: (on: boolean) => void }>(['rdRead'], {
      document,
      rdHow: () => 'smooth',
      rdBoxTop: () => 240,
      sizePanelSections: () => calls.push(`size ${panel.getAttribute('data-read')}`),
      _rd: { leave: 0 },
      _panelScrollGen: 0,
      setTimeout: (f: () => void) => {
        timers.push(f);
        return timers.length;
      },
      clearTimeout: () => {},
    });
    m.rdRead(true);
    expect(panel.getAttribute('data-read')).toBe('1');
    expect(calls).toEqual(['size 1', 'scroll 240 smooth']);
    m.rdRead(true); // already in, and landed: nothing more
    expect(calls).toHaveLength(2);
    scroll.scrollTop = 90; // a live repaint stopped the glide short
    m.rdRead(true);
    expect(calls[2]).toBe('scroll 240 smooth');
    calls.splice(2, 1);
    m.rdRead(false);
    expect(panel.getAttribute('data-read')).toBe('leaving');
    expect(calls[2]).toBe('scroll 0 smooth');
    m.rdRead(false); // a second tap while it scrolls back: nothing more
    expect(calls).toHaveLength(3);
    listeners.scrollend(); // the scroll landed
    expect(panel.hasAttribute('data-read')).toBe(false);
    expect(calls[3]).toBe('size null');
    expect(listeners.scrollend).toBeUndefined();
    timers[timers.length - 1](); // the floor timer after it: nothing more
    expect(calls).toHaveLength(4);
  });

  it('rdRead: the reader scrolls again while the head comes back — reading again, the landing forgotten', () => {
    const panel = new FakeNode('slide-panel');
    panel.setAttribute('data-read', 'leaving');
    const calls: string[] = [];
    const scroll = Object.assign(new FakeNode('panel-scroll'), {
      scrollTop: 100,
      scrollTo: (o: { top: number }) => calls.push(`scroll ${o.top}`),
    });
    const m = load<{ rdRead: (on: boolean) => void }>(['rdRead'], {
      document: fakeDocument([panel, scroll as unknown as FakeNode]),
      rdHow: () => 'smooth',
      rdBoxTop: () => 240,
      sizePanelSections: () => calls.push('size'),
      _rd: { leave: 7, land: 9 },
      _panelScrollGen: 0,
      setTimeout: () => 0,
      clearTimeout: (id: number) => calls.push(`clear ${id}`),
    });
    m.rdRead(true);
    expect(panel.getAttribute('data-read')).toBe('1');
    expect(calls).toEqual(['clear 7', 'size', 'scroll 240', 'clear 9']);
  });

  it('what waits on the reader (a question, a permission, a plan) brings the head and the composer back', () => {
    expect(clientFn('landPanel')).toMatch(/if \(onQuestion\) \{\n[^\n]*\n\s*rdReset\(\);/);
    expect(clientFn('focusPanelComposer')).toContain('rdTuck(false);');
  });

  it('reading moves the reader’s place: a layout anchor taken before it is stale (_panelScrollGen)', () => {
    const fn = clientFn('rdRead');
    // Entering, leaving, and the settle correction (T5) each move the reader's place.
    expect(fn.match(/_panelScrollGen\+\+;/g)).toHaveLength(3);
  });

  it('nothing sticks above the box while reading; a tap on the title bar (not its buttons) brings the head back', () => {
    expect(cssRule('.slide-panel[data-read] .panel-tabs::part(list)')).toContain('position: static;');
    expect(TEMPLATE).toMatch(
      /head\.addEventListener\('click', function\(e\) \{[\s\S]{0,260}t\.closest\('button, a, input, select, ui-deck-nav, ui-status-bar'\)[\s\S]{0,40}rdRead\(false\);/,
    );
  });

  it('a new view starts as the card opens: another card, tab or agent resets reading', () => {
    for (const fn of ['selectPanelMid', 'selectPanelAgent'])
      expect(clientFn(fn).split('\n').slice(0, 4).join('\n'), fn).toContain('rdReset();');
    expect(clientFn('openPanel')).toMatch(
      /\/\/ Phone chrome: every opening starts with the head and the composer in\.\n\s*rdReset\(\);/,
    );
  });

  it('T5: a section tab pressed while reading keeps reading — the tabs stay, the old box is let go, the composer is back', () => {
    const calls: string[] = [];
    const panel = new FakeNode('slide-panel');
    panel.setAttribute('data-read', '1');
    const _rd = { vp: { old: true } as unknown, last: 300 };
    const m = load<{ selectPanelSection: (sec: string) => void }>(['selectPanelSection'], {
      PSEC_ORDER: ['conv', 'log', 'tree'],
      _psec: 'log',
      _rd,
      panelSessionKey: 'k',
      document: fakeDocument([panel]),
      rdTuck: (on: boolean) => calls.push(`tuck ${on}`),
      rdReset: () => calls.push('reset'),
      rdRead: (on: boolean) => calls.push(`read ${on}`),
      renderPanelSections: () => calls.push('render'),
      psecClear: () => {},
      paintSection: (sec: string) => calls.push(`paint ${sec}`),
      psecToNewest: () => calls.push('newest'),
    });
    m.selectPanelSection('conv');
    expect(calls).toEqual(['tuck false', 'render', 'paint conv', 'newest', 'read true']);
    expect(_rd.vp).toBeNull();
    expect(_rd.last).toBe(-1);
    calls.length = 0;
    panel.setAttribute('data-read', 'leaving'); // the head is coming back (the title bar was tapped): it keeps coming
    m.selectPanelSection('log');
    expect(calls).toEqual(['reset', 'render', 'paint log', 'newest']);
    calls.length = 0;
    panel.removeAttribute('data-read'); // not reading: the card starts as it opens
    m.selectPanelSection('conv');
    expect(calls).toEqual(['reset', 'render', 'paint conv', 'newest']);
  });

  it('a section tab never reads as an agent choice: the agent strip answers only its own ui-change', () => {
    const listeners: Array<(e: unknown) => void> = [];
    const strip = {
      _bound: false,
      addEventListener: (_t: string, f: (e: unknown) => void) => listeners.push(f),
    };
    const picked: string[] = [];
    const m = load<{ bindPanelTabs: () => void }>(['bindPanelTabs'], {
      document: { getElementById: (id: string) => (id === 'panel-tabs' ? strip : null) },
      selectPanelAgent: (id: string) => picked.push(id),
      panelTabAgent: (v: string) => (v.startsWith('a:') ? v.slice(2) : ''),
      renderPanelTabs: () => {},
    });
    m.bindPanelTabs();
    listeners[0]({ target: { id: 'panel-sections' }, detail: { value: 'conv' } }); // bubbled from 대화 · 작업 로그
    expect(picked).toEqual([]);
    listeners[0]({ target: strip, detail: { value: 'a:toolu_1' } });
    expect(picked).toEqual(['toolu_1']);
  });

  it('T6: on a phone the card’s title bar is the top bar’s height (52px), over the sheet’s notch rule', () => {
    expect(TEMPLATE).toMatch(
      /@media \(max-width: 639px\), \(max-height: 560px\) \{[\s\S]{0,400}ui-drawer\.slide-panel \.panel-header \{\s*min-height: calc\(52px \+ env\(safe-area-inset-top, 0px\)\);\s*padding: env\(safe-area-inset-top, 0px\) 12px 0 16px;/,
    );
  });

  it('the reader’s box is found through the open shadow roots, the chat, the log or the tree', () => {
    const vp = { id: 'vp' };
    const scroller = (tag: string) => ({
      tagName: tag,
      shadowRoot: { querySelector: (s: string) => (s === '.ls-vp' ? vp : null) },
    });
    const conv = {
      tagName: 'UI-CONVERSATION',
      shadowRoot: { querySelector: (s: string) => (s === 'ui-log-scroller' ? scroller('UI-LOG-SCROLLER') : null) },
    };
    let el: unknown = conv;
    const m = load<{ psecViewport: () => unknown }>(['psecViewport'], { psecEl: () => el });
    expect(m.psecViewport()).toBe(vp);
    el = scroller('UI-LOG-SCROLLER'); // the tree is a <ui-log-scroller> itself
    expect(m.psecViewport()).toBe(vp);
    el = null;
    expect(m.psecViewport()).toBeNull();
  });
});

describe('T2 · T4 — what one scroll of the reader’s box asks (rdStep)', () => {
  const { rdStep } = load<{
    rdStep: (
      top: number,
      max: number,
      prev: number,
      user: boolean,
      olderLeft: boolean,
      typing: boolean,
      grow?: number,
    ) => {
      read: boolean | null;
      tuck: boolean | null;
    };
  }>(['rdStep']);

  it('the reader scrolls back from the newest: the head scrolls out and the composer tucks away', () => {
    expect(rdStep(900, 1000, 1000, true, true, false)).toEqual({ read: true, tuck: true });
  });
  it('… or forward, still short of the bottom: the same', () => {
    expect(rdStep(500, 1000, 400, true, false, false)).toEqual({ read: true, tuck: true });
  });
  it('the very bottom brings the composer back — whoever scrolled there (the "latest" pill too); the head stays out', () => {
    expect(rdStep(1000, 1000, 900, true, false, false)).toEqual({ read: null, tuck: false });
    expect(rdStep(995, 1000, 600, false, false, false)).toEqual({ read: null, tuck: false });
  });
  it('a box that cannot scroll is at its bottom', () => {
    expect(rdStep(0, 0, -1, false, false, false)).toEqual({ read: null, tuck: false });
  });
  it('the page’s own moves (a new item followed, a place kept) ask nothing', () => {
    expect(rdStep(500, 1000, 400, false, false, false)).toEqual({ read: null, tuck: null });
  });
  it('no move, or the first event of a box, asks nothing', () => {
    expect(rdStep(500, 1000, 500, true, false, false)).toEqual({ read: null, tuck: null });
    expect(rdStep(500, 1000, -1, true, false, false)).toEqual({ read: null, tuck: null });
  });
  it('the composer the reader types in stays', () => {
    expect(rdStep(500, 1000, 600, true, false, true)).toEqual({ read: true, tuck: null });
  });
  it('back up at the start of everything (nothing older left), the head comes back', () => {
    expect(rdStep(0, 1000, 120, true, false, false)).toEqual({ read: false, tuck: true });
  });
  it('near the bottom the composer stays: the grown box would land on the bottom and bring it straight back', () => {
    // 150px off the bottom; the composer's row and the head would add 300px to the box.
    expect(rdStep(850, 1000, 900, true, false, false, 300)).toEqual({ read: true, tuck: null });
    // Far enough up, it goes.
    expect(rdStep(500, 1000, 600, true, false, false, 300)).toEqual({ read: true, tuck: true });
  });
  it('… not while an older page is still to come (the box pages it in)', () => {
    expect(rdStep(0, 1000, 120, true, true, false)).toEqual({ read: true, tuck: true });
  });
});

describe('T4 — the composer slides away while reading; ^ brings it back', () => {
  it('rdTuck sets and clears data-tuck, once', () => {
    const panel = new FakeNode('slide-panel');
    const set: string[] = [];
    const orig = panel.setAttribute.bind(panel);
    panel.setAttribute = (k: string, v: string) => {
      set.push(k);
      orig(k, v);
    };
    const m = load<{ rdTuck: (on: boolean) => void }>(['rdTuck'], { document: fakeDocument([panel]) });
    m.rdTuck(true);
    m.rdTuck(true);
    expect(set).toEqual(['data-tuck']);
    m.rdTuck(false);
    expect(panel.hasAttribute('data-tuck')).toBe(false);
  });

  // SSOT 2026-11-05: the steering element's queue button floats above the composer and sets its own visibility —
  // tucked, it must neither peek out under ^ nor take a tap, and an open queue closes.
  it('tucking closes the composer’s queue; showing it again does not open it', () => {
    const panel = new FakeNode('slide-panel');
    const steer = new FakeNode('cmd-steer') as FakeNode & { closeQueue?: () => void };
    const closed: number[] = [];
    steer.closeQueue = () => closed.push(1);
    const m = load<{ rdTuck: (on: boolean) => void }>(['rdTuck'], { document: fakeDocument([panel, steer]) });
    m.rdTuck(true);
    expect(closed).toHaveLength(1);
    m.rdTuck(false);
    expect(closed).toHaveLength(1);
  });

  it('tucked, the composer leaves the flow and slides down, hidden from the reader and the keyboard', () => {
    const r = cssRule('.slide-panel[data-tuck] .panel-command');
    expect(r).toContain('position: absolute;');
    expect(r).toContain('transform: translateY(100%);');
    expect(r).toContain('visibility: hidden;');
    // The queue's round button floats above the composer's box and keeps its own visibility: clipped, no presses.
    expect(r).toContain('clip-path: inset(0);');
    expect(r).toContain('pointer-events: none;');
    expect(cssRule('.slide-panel::part(body)')).toContain('position: relative;');
  });

  it('^ is a real button at the bottom right, named, shown only while the composer is away', () => {
    expect(TEMPLATE).toContain(
      '<button type="button" class="ui-icon-btn is-bordered pc-reveal" id="pc-reveal" aria-label="입력창 보이기" title="입력창 보이기" onclick="pcReveal(event)"><i data-ui-icon="chevron-up"></i></button>',
    );
    const r = cssRule('.pc-reveal');
    expect(r).toMatch(
      /right: calc\(16px \+ env\(safe-area-inset-right, 0px\)\); bottom: calc\(16px \+ env\(safe-area-inset-bottom, 0px\)\);/,
    );
    expect(r).toContain('visibility: hidden;');
    expect(r).toContain('width: 44px; height: 44px;');
    expect(cssRule('.slide-panel[data-tuck] .pc-reveal')).toContain('visibility: visible;');
  });

  it('^ brings the composer back; from a key, focus follows into it (not to the page)', () => {
    const calls: string[] = [];
    const comp = { focus: () => calls.push('focus') };
    const m = load<{ pcReveal: (e: { detail: number }) => void }>(['pcReveal'], {
      rdTuck: (on: boolean) => calls.push(`tuck ${on}`),
      document: { getElementById: (id: string) => (id === 'pc-composer' ? comp : null) },
    });
    m.pcReveal({ detail: 1 }); // a tap
    expect(calls).toEqual(['tuck false']);
    m.pcReveal({ detail: 0 }); // Enter / Space
    expect(calls).toEqual(['tuck false', 'tuck false', 'focus']);
  });

  it('the reader’s gestures in the sections arm the box’s scroll listener (touch, wheel, keys)', () => {
    expect(TEMPLATE).toContain(
      "['touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel', 'keydown'].forEach(function(t) {",
    );
    expect(clientFn('rdGesture')).toContain("vp.addEventListener('scroll', rdOnScroll, { passive: true });");
  });

  it('the reader’s window is the finger plus a fixed fling — the page’s own scrolls never extend it', () => {
    let now = 1000;
    const vp = { scrollTop: 0, _rdBound: false, addEventListener: () => {} };
    const _rd = { touch: false, until: 0, last: -1, vp: null as unknown, leave: 0 };
    const m = load<{ rdGesture: (e: { type: string }) => void }>(['rdGesture', 'rdTouchEnd'], {
      isPhone: () => true,
      psecViewport: () => vp,
      rdOnScroll: () => {},
      _rd,
      Date: { now: () => now },
    });
    m.rdGesture({ type: 'touchstart' });
    expect(_rd.touch).toBe(true);
    m.rdGesture({ type: 'touchend' });
    expect(_rd.touch).toBe(false);
    expect(_rd.until).toBe(2200);
    now = 1500;
    m.rdGesture({ type: 'wheel' });
    expect(_rd.until).toBe(1900);
    // A finger that began elsewhere (the title bar, the composer) and lifts over the sections opens no window.
    now = 3000;
    m.rdGesture({ type: 'touchend' });
    expect(_rd.until).toBe(1900);
    expect(clientFn('rdOnScroll')).toContain('var user = _rd.touch || Date.now() < _rd.until;');
    expect(clientFn('rdOnScroll')).not.toMatch(/_rd\.(until|gesture) = /);
  });
});

describe('T3 — the model picker on the composer’s row, left of Send, through the composer’s slot (#918)', () => {
  it('#panel-controls is the composer’s slot="end" child: the composer lays it out before Send', () => {
    expect(TEMPLATE).toContain(
      '<ui-composer id="pc-composer" slot="composer" lang="ko"><div class="panel-controls" id="panel-controls" slot="end" aria-label="이 세션의 모델과 추론 강도"></div></ui-composer>',
    );
  });
  it('the page reads nothing in the composer’s shadow DOM: no measuring, no docked box', () => {
    expect(TEMPLATE).not.toContain('syncPickerDock');
    expect(TEMPLATE).not.toContain('data-pick-dock');
    expect(TEMPLATE).not.toMatch(/--pd-[lrth]/);
    expect(TEMPLATE).not.toMatch(/shadowRoot\.querySelector\('\.cp-(bar|end|tools)'\)/);
  });
  it('a new card’s composer takes the controls with it (the picker element and its state move, not a copy)', () => {
    const ctl = new FakeNode('panel-controls');
    const oldComp = new FakeNode('pc-composer');
    oldComp.appendChild(ctl);
    const oldSteer = Object.assign(new FakeNode('cmd-steer'), {
      replaceWith(n: FakeNode) {
        replaced.push(n);
      },
    });
    oldSteer.appendChild(oldComp);
    const replaced: FakeNode[] = [];
    const made: Array<FakeNode & { slot?: string }> = [];
    const document = {
      getElementById: (id: string) => (id === 'cmd-steer' ? oldSteer : id === 'panel-controls' ? ctl : null),
      createElement: (tag: string) => {
        const n = new FakeNode(tag) as FakeNode & { slot?: string };
        made.push(n);
        return n;
      },
    };
    const m = load<{ pcFreshSteer: () => void }>(['pcFreshSteer'], {
      document,
      ntDictateStopIn: () => {},
      pcComposerSetup: () => {},
      _pcFailed: {},
      _pcNoteFiles: {},
    });
    m.pcFreshSteer();
    const comp = made.find((n) => n.id === 'pc-composer')!;
    expect(comp.slot).toBe('composer');
    expect(ctl.parentNode).toBe(comp); // the same node, now the new composer's slot="end" child
    expect(oldComp.children).toEqual([]);
    expect(replaced).toEqual([made.find((n) => n.id === 'cmd-steer')]);
  });
  it('the controls sit on the row: one line, the note floats above the picker; no "이 세션" label', () => {
    const r = cssRule('#panel-controls');
    expect(r).toContain('position: relative;');
    expect(r).toContain('flex-wrap: nowrap;');
    expect(r).toContain('min-width: 0;');
    expect(r).toContain('padding: 0;');
    const note = cssRule('#panel-controls > .cb-model-note');
    expect(note).toContain('position: absolute;');
    expect(note).toContain('bottom: calc(100% + 6px);');
    expect(cssRule('#panel-controls ui-model-picker')).toContain('min-width: 0;');
    // Narrower than even the compact trigger (320px, four tools): its content clips inside the button, never over Send.
    expect(cssRule('#panel-controls ui-model-picker::part(trigger)')).toContain('overflow: hidden;');
    expect(clientFn('renderPanelControls')).not.toContain('pc-scope');
  });
  it('the controls’ repaint fits the picker to the row (syncPickerFit), and so does a resize of the composer', () => {
    expect(clientFn('renderPanelControls')).toMatch(/mpHydrate\(el\);\n\s*syncPickerFit\(\);/);
    expect(TEMPLATE).toMatch(/new ResizeObserver\(function\(\) \{ syncPickerFit\(\); \}\)/);
  });
});

describe('T3 — a narrow row draws the picker compact: the maker’s mark and the level (#918)', () => {
  const setup = (width: number, touch: boolean, had = false, open = false) => {
    const attrs: Record<string, boolean> = had ? { compact: true } : {};
    if (open) attrs.open = true;
    const picker = {
      toggleAttribute: (k: string, on: boolean) => {
        if (on) attrs[k] = true;
        else delete attrs[k];
      },
      hasAttribute: (k: string) => !!attrs[k],
    };
    const comp = { getBoundingClientRect: () => ({ width }) };
    const m = load<{ syncPickerFit: () => void }>(['syncPickerFit'], {
      document: {
        getElementById: (id: string) => (id === 'pc-composer' ? comp : null),
        querySelector: (sel: string) => (sel === '#panel-controls ui-model-picker' ? picker : null),
      },
      window: { matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' && touch }) },
      PICKER_COMPACT_BELOW: 400,
      PICKER_COMPACT_BELOW_TOUCH: 480,
      _pcCompact: had,
    });
    return { m, attrs };
  };
  it('the room the name needs follows the composer’s buttons: 44px touch targets take more of the row', () => {
    expect(TEMPLATE).toContain('var PICKER_COMPACT_BELOW = 400;');
    expect(TEMPLATE).toContain('var PICKER_COMPACT_BELOW_TOUCH = 480;');
    const run = (w: number, touch: boolean, had = false) => {
      const t = setup(w, touch, had);
      t.m.syncPickerFit();
      return !!t.attrs.compact;
    };
    expect(run(358, true)).toBe(true); // a 390px phone's row
    expect(run(408, true)).toBe(true); // a 440px phone's row: the name would not fit beside four 44px buttons
    expect(run(600, true, true)).toBe(false); // a tablet's
    expect(run(407, false)).toBe(false); // the desktop card's (440px wide): 32px buttons leave the name its room
    expect(run(380, false)).toBe(true); // a desktop card dragged narrow
    expect(run(0, true, true)).toBe(true); // a closed panel keeps what it had
    // An open menu holds its trigger: the toggle waits for the close (whose repaint renders _pcCompact).
    const held = setup(358, true, false, true);
    held.m.syncPickerFit();
    expect(held.attrs.compact).toBeUndefined();
    expect(clientFn('mpOnOpenChange')).toContain('repaintPanelControlsFor(key);');
  });
  it('the panel’s picker is drawn compact while the row is narrow, so a repaint keeps it; the board card’s never', () => {
    const fn = clientFn('renderModelPicker');
    expect(fn).toContain("(where === 'panel' && _pcCompact ? ' compact' : '')");
    expect(clientFn('syncPickerFit')).toContain('_pcCompact = narrow;');
  });
});

describe('#918 — a named keyboard path brings the head back', () => {
  it('a title-bar button, named, shown only while reading', () => {
    expect(TEMPLATE).toContain(
      '<button type="button" id="panel-head-back" class="ui-icon-btn panel-title-act panel-head-back" aria-label="카드 위쪽 보이기" title="카드 위쪽 보이기" onclick="rdHeadBack(event)"><i data-ui-icon="chevron-down"></i></button>',
    );
    expect(cssRule('.panel-title-row > .panel-head-back')).toContain('display: none;');
    expect(cssRule('.slide-panel[data-read="1"] .panel-title-row > .panel-head-back')).toContain(
      'display: inline-flex;',
    );
    const en = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'),
        'utf-8',
      ),
    );
    expect(JSON.stringify(en)).toContain('카드 위쪽 보이기');
  });
  it('it scrolls the head back in; focus that was on it moves to the card’s title, never to the page', () => {
    const calls: string[] = [];
    const btn = { id: 'panel-head-back' };
    const title = { focus: (o: { preventScroll: boolean }) => calls.push(`focus title ${o.preventScroll}`) };
    let active: unknown = btn;
    const m = load<{ rdHeadBack: (e: { detail: number }) => void }>(['rdHeadBack'], {
      rdRead: (on: boolean) => calls.push(`read ${on}`),
      document: {
        getElementById: (id: string) => (id === 'panel-head-back' ? btn : id === 'panel-title' ? title : null),
        get activeElement() {
          return active;
        },
      },
    });
    m.rdHeadBack({ detail: 0 });
    expect(calls).toEqual(['read false', 'focus title true']);
    calls.length = 0;
    active = null; // a tap that left focus elsewhere: it stays there
    m.rdHeadBack({ detail: 1 });
    expect(calls).toEqual(['read false']);
  });
});

describe('#918 — the reading follow-ups from the trinity review of #915', () => {
  const leaveSetup = () => {
    const panel = new FakeNode('slide-panel');
    const calls: string[] = [];
    const listeners: Record<string, () => void> = {};
    const scroll = Object.assign(new FakeNode('panel-scroll'), {
      scrollTop: 400,
      scrollTo(o: { top: number; behavior: string }) {
        calls.push(`scroll ${o.top} ${o.behavior}`);
      },
      addEventListener: (t: string, f: () => void) => {
        listeners[t] = f;
      },
      removeEventListener: (t: string, f: () => void) => {
        if (listeners[t] === f) delete listeners[t];
      },
    });
    const _rd = { leave: 0, land: 0, last: 5, off: null as null | (() => void) };
    const timers: Array<() => void> = [];
    const inject = {
      document: fakeDocument([panel, scroll as unknown as FakeNode]),
      rdHow: () => 'smooth',
      rdBoxTop: () => 240,
      sizePanelSections: () => calls.push(`size ${panel.getAttribute('data-read')}`),
      _rd,
      _panelScrollGen: 0,
      setTimeout: (f: () => void) => {
        timers.push(f);
        return timers.length;
      },
      clearTimeout: () => {},
    };
    const m = load<{ rdRead: (on: boolean) => void; rdReset: () => void }>(['rdRead', 'rdReset'], inject);
    panel.setAttribute('data-read', '1');
    return { m, panel, scroll, listeners, calls, _rd, timers };
  };

  it('rdReset takes the leaving scroll’s listeners off with its timer (_rd.off)', () => {
    const t = leaveSetup();
    t.m.rdRead(false);
    expect(Object.keys(t.listeners).sort()).toEqual(['scroll', 'scrollend']);
    t.m.rdReset();
    expect(t.listeners).toEqual({});
    expect(t._rd.off).toBeNull();
  });

  it('iOS Safari has no scrollend: the scroll that reaches the top ends the leaving there, not after the 900ms floor', () => {
    const t = leaveSetup();
    t.m.rdRead(false);
    expect(t.panel.getAttribute('data-read')).toBe('leaving');
    t.scroll.scrollTop = 120;
    t.listeners.scroll(); // still on its way up
    expect(t.panel.getAttribute('data-read')).toBe('leaving');
    t.scroll.scrollTop = 0;
    t.listeners.scroll(); // landed at the top
    expect(t.panel.hasAttribute('data-read')).toBe(false);
    expect(t.calls[t.calls.length - 1]).toBe('size null');
    expect(t.listeners).toEqual({});
  });

  it('a goal, agent or tasks landing (and its hold) that runs while reading starts the card over first', () => {
    const land = clientFn('landPanel');
    const goal = land.slice(land.indexOf("if (_panelLand === 'goal'"), land.indexOf("if (_panelLand !== 'worklog')"));
    expect(goal).toMatch(/if \(panelReading\(\)\) rdReset\(\);\n\s*var under = /);
    expect(clientFn('holdPanelLanding')).toMatch(/if \(panelReading\(\)\) rdReset\(\);\n\s*var under = /);
    const calls: string[] = [];
    const scrollEl = {
      scrollTop: 300,
      scrollHeight: 2000,
      clientHeight: 600,
      getBoundingClientRect: () => ({ top: 0 }),
      scrollTo: (o: { top: number }) => calls.push(`scroll ${o.top}`),
    };
    const sec = { style: { display: '' }, getBoundingClientRect: () => ({ top: 500 }) };
    const m = load<{ holdPanelLanding: () => void }>(['holdPanelLanding'], {
      Date: { now: () => 0 },
      _panelHoldUntil: 1,
      _panelHold: true,
      _panelLand: 'goal',
      _panelScrollGen: 0,
      panelTabsHeight: () => 0,
      panelReading: () => true,
      rdReset: () => calls.push('reset'),
      document: {
        getElementById: (id: string) => (id === 'panel-scroll' ? scrollEl : id === 'panel-goal' ? sec : null),
      },
    });
    m.holdPanelLanding();
    expect(calls).toEqual(['reset', 'scroll 800']);
  });

  it('a finger lifted off a node that left the DOM still ends the touch (document-level end listeners)', () => {
    expect(TEMPLATE).toContain(
      "['touchend', 'touchcancel', 'pointerup', 'pointercancel'].forEach(function(t) {\n    document.addEventListener(t, rdTouchEnd, { passive: true, capture: true });",
    );
    let now = 1000;
    const _rd = { touch: true, until: 0 };
    const m = load<{ rdTouchEnd: () => void }>(['rdTouchEnd'], { _rd, Date: { now: () => now } });
    m.rdTouchEnd();
    expect(_rd).toEqual({ touch: false, until: 2200 });
    now = 5000;
    m.rdTouchEnd(); // no touch on the sections: a lift elsewhere never opens the reader's window
    expect(_rd).toEqual({ touch: false, until: 2200 });
  });

  it('a touch ends on the node it began on, even after that node left the DOM (touchend never bubbles from a detached node)', () => {
    const listeners: Record<string, Array<{ f: () => void; once: boolean }>> = {};
    const node = {
      addEventListener: (t: string, f: () => void, o: { once?: boolean }) => {
        (listeners[t] ||= []).push({ f, once: !!o?.once });
      },
    };
    let now = 1000;
    const _rd = { touch: false, until: 0, last: -1, vp: null as unknown, leave: 0 };
    const m = load<{ rdGesture: (e: unknown) => void }>(['rdGesture', 'rdTouchEnd'], {
      isPhone: () => true,
      psecViewport: () => null,
      rdOnScroll: () => {},
      _rd,
      Date: { now: () => now },
    });
    // The touch starts on a node inside the chat's shadow root (composedPath()[0], not the retargeted host).
    m.rdGesture({ type: 'touchstart', target: { host: true }, composedPath: () => [node, { host: true }] });
    expect(_rd.touch).toBe(true);
    expect(Object.keys(listeners).sort()).toEqual(['touchcancel', 'touchend']);
    expect(listeners.touchend.every((l) => l.once)).toBe(true);
    // The node re-renders away; its touchend fires on the detached node only.
    now = 1500;
    for (const l of listeners.touchend) l.f();
    expect(_rd).toMatchObject({ touch: false, until: 2700 });
  });

  it('a new view (rdReset) forgets a touch and its fling window', () => {
    const _rd = { touch: true, until: 99999, last: 5, leave: 0, land: 0, off: null };
    const m = load<{ rdReset: () => void }>(['rdReset'], {
      _rd,
      document: fakeDocument([]),
      clearTimeout: () => {},
      sizePanelSections: () => {},
    });
    m.rdReset();
    expect(_rd).toMatchObject({ touch: false, until: 0, last: -1 });
  });

  it('^ moves focus into the composer whenever focus was on it (an assistive activation can report detail 1); a finger’s tap does not bring up the keyboard', () => {
    const calls: string[] = [];
    const btn = { id: 'pc-reveal' };
    const comp = { focus: () => calls.push('focus') };
    let active: unknown = btn;
    const m = load<{ pcReveal: (e: { detail: number; pointerType?: string }) => void }>(['pcReveal'], {
      rdTuck: (on: boolean) => calls.push(`tuck ${on}`),
      document: {
        getElementById: (id: string) => (id === 'pc-composer' ? comp : id === 'pc-reveal' ? btn : null),
        get activeElement() {
          return active;
        },
      },
    });
    m.pcReveal({ detail: 1 }); // VoiceOver / TalkBack: focus was on ^
    expect(calls).toEqual(['tuck false', 'focus']);
    calls.length = 0;
    m.pcReveal({ detail: 1, pointerType: 'touch' }); // a finger (Chrome on Android focuses the button it taps)
    expect(calls).toEqual(['tuck false']);
    calls.length = 0;
    active = null;
    m.pcReveal({ detail: 1, pointerType: 'mouse' }); // a click that left focus elsewhere
    expect(calls).toEqual(['tuck false']);
    m.pcReveal({ detail: 0 }); // Enter / Space
    expect(calls).toEqual(['tuck false', 'tuck false', 'focus']);
  });

  it('a scroll reads the composer’s and the box’s heights only when it may tuck the composer (the reader’s own, composer in, not typing)', () => {
    let reads = 0;
    const h = <T extends object>(o: T, v: number): T =>
      Object.defineProperties(o, {
        clientHeight: {
          get() {
            reads++;
            return v;
          },
        },
        offsetHeight: {
          get() {
            reads++;
            return v;
          },
        },
      });
    const panel = new FakeNode('slide-panel');
    const cmd = h(Object.assign(new FakeNode('panel-command'), { contains: () => false }), 120);
    const sc = h(new FakeNode('panel-scroll'), 700);
    const vp = { scrollTop: 500, scrollHeight: 2000, clientHeight: 400, getRootNode: () => ({}) };
    const _rd = { touch: false, until: 0, last: 600, vp };
    const steps: Array<[boolean, number]> = [];
    const run = (user: boolean, tucked: boolean) => {
      reads = 0;
      _rd.touch = user;
      _rd.last = 600;
      if (tucked) panel.setAttribute('data-tuck', '');
      else panel.removeAttribute('data-tuck');
      const m = load<{ rdOnScroll: (e: { currentTarget: unknown }) => void }>(['rdOnScroll'], {
        _rd,
        isPhone: () => true,
        panelOpen: true,
        psecBox: () => h({}, 400),
        document: { ...fakeDocument([panel, cmd, sc]), activeElement: null, body: {} },
        Date: { now: () => 0 },
        rdStep: (_t: number, _m: number, _p: number, u: boolean, _o: boolean, _ty: boolean, grow: number) => {
          steps.push([u, grow]);
          return { read: null, tuck: null };
        },
        rdTuck: () => {},
        rdRead: () => {},
      });
      m.rdOnScroll({ currentTarget: vp });
      return reads;
    };
    expect(run(false, false)).toBe(0); // the page's own scroll
    expect(run(true, true)).toBe(0); // the composer is already away
    expect(run(true, false)).toBe(3); // the reader's own: sc, cmd and the box, once
    expect(steps[2]).toEqual([true, 420]);
  });
});
