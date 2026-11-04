/**
 * Phone chrome (SSOT 2026-11-04) — on a phone the content takes the screen.
 *
 *   T1  the board's top bar is one line: the scope group (승인 · 관리자 · the board's user · the defaults) leaves the
 *       bar's toolbar for the board's head (syncPhoneScope) and goes back on a wide screen;
 *   T2  the detail card keeps only its title bar while the reader scrolls: the status bar joins the scroll area
 *       (syncPhoneStatus); reading (rdRead → data-read) gives the section box the whole view (sizePanelSections) and
 *       scrolls everything above it out; a tap on the title bar or the start of the history brings it back (rdStep);
 *   T3  the model picker sits on the composer's own row, left of Send (syncPickerDock);
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
      /syncPhoneScope\(\);\s*syncPhoneStatus\(\);\s*rdReset\(\);\s*syncPickerDock\(\);/,
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

  it('reading gives the section box the whole view (sizePanelSections)', () => {
    expect(clientFn('sizePanelSections')).toContain(
      'var h = panelReading() ? view : psecHeightOf(view, top, panelTabsHeight() + strip);',
    );
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
      _rd: { leave: 7 },
      _panelScrollGen: 0,
      setTimeout: () => 0,
      clearTimeout: (id: number) => calls.push(`clear ${id}`),
    });
    m.rdRead(true);
    expect(panel.getAttribute('data-read')).toBe('1');
    expect(calls).toEqual(['clear 7', 'size', 'scroll 240']);
  });

  it('what waits on the reader (a question, a permission, a plan) brings the head and the composer back', () => {
    expect(clientFn('landPanel')).toMatch(/if \(onQuestion\) \{\n[^\n]*\n\s*rdReset\(\);/);
    expect(clientFn('focusPanelComposer')).toContain('rdTuck(false);');
  });

  it('reading moves the reader’s place: a layout anchor taken before it is stale (_panelScrollGen)', () => {
    const fn = clientFn('rdRead');
    expect(fn.match(/_panelScrollGen\+\+;/g)).toHaveLength(2);
  });

  it('nothing sticks above the box while reading; a tap on the title bar (not its buttons) brings the head back', () => {
    expect(cssRule('.slide-panel[data-read] .panel-tabs::part(list)')).toContain('position: static;');
    expect(TEMPLATE).toMatch(
      /head\.addEventListener\('click', function\(e\) \{[\s\S]{0,260}t\.closest\('button, a, input, select, ui-deck-nav, ui-status-bar'\)[\s\S]{0,40}rdRead\(false\);/,
    );
  });

  it('a new view starts as the card opens: another card, section, tab or agent resets reading', () => {
    for (const fn of ['selectPanelSection', 'selectPanelMid', 'selectPanelAgent'])
      expect(clientFn(fn).split('\n').slice(0, 4).join('\n'), fn).toContain('rdReset();');
    expect(clientFn('openPanel')).toMatch(
      /\/\/ Phone chrome: every opening starts with the head and the composer in\.\n\s*rdReset\(\);/,
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

  it('tucked, the composer leaves the flow and slides down, hidden from the reader and the keyboard', () => {
    const r = cssRule('.slide-panel[data-tuck] .panel-command');
    expect(r).toContain('position: absolute;');
    expect(r).toContain('transform: translateY(100%);');
    expect(r).toContain('visibility: hidden;');
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
    const m = load<{ rdGesture: (e: { type: string }) => void }>(['rdGesture'], {
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
    expect(clientFn('rdOnScroll')).toContain('var user = _rd.touch || Date.now() < _rd.until;');
    expect(clientFn('rdOnScroll')).not.toMatch(/_rd\.(until|gesture) = /);
  });
});

describe('T3 — the model picker on the composer’s row, left of Send', () => {
  type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
  const rect = (left: number, top: number, w: number, h: number): Rect => ({
    left,
    right: left + w,
    top,
    bottom: top + h,
    width: w,
    height: h,
  });
  const setup = (phone: boolean, withEnd = true) => {
    const cmd = Object.assign(new FakeNode('panel-command'), { getBoundingClientRect: () => rect(0, 600, 390, 160) });
    const ctl = new FakeNode('panel-controls');
    const send = { getBoundingClientRect: () => rect(323, 700, 44, 44) };
    const hidden = { getBoundingClientRect: () => rect(0, 0, 0, 0) };
    const end = { children: [hidden, send] };
    const tools = { getBoundingClientRect: () => rect(23, 700, 136, 44) };
    const bar = {
      getBoundingClientRect: () => rect(17, 698, 356, 48),
      querySelector: (s: string) => (s === '.cp-end' ? (withEnd ? end : null) : s === '.cp-tools' ? tools : null),
    };
    const comp = Object.assign(new FakeNode('pc-composer'), {
      shadowRoot: { querySelector: (s: string) => (s === '.cp-bar' ? bar : null) },
    });
    const document = fakeDocument([cmd, ctl, comp]);
    const m = load<{ syncPickerDock: () => void }>(['syncPickerDock'], { document, isPhone: () => phone });
    return { cmd, ctl, ...m };
  };

  it('a phone: the picker’s box spans from the tools’ end to Send’s start, on the row', () => {
    const t = setup(true);
    t.syncPickerDock();
    expect(t.cmd.hasAttribute('data-pick-dock')).toBe(true);
    expect(t.ctl.style.props).toEqual({ '--pd-l': '165px', '--pd-r': '73px', '--pd-t': '98px', '--pd-h': '48px' });
  });
  it('a wide screen, or a recording in the row: the picker keeps its line above the composer', () => {
    const wide = setup(false);
    wide.cmd.setAttribute('data-pick-dock', '');
    wide.syncPickerDock();
    expect(wide.cmd.hasAttribute('data-pick-dock')).toBe(false);
    const rec = setup(true, false);
    rec.syncPickerDock();
    expect(rec.cmd.hasAttribute('data-pick-dock')).toBe(false);
  });
  it('docked, the box lets taps through where it is empty and ends at Send', () => {
    const r = cssRule('.panel-command[data-pick-dock] > .panel-controls');
    expect(r).toContain('position: absolute;');
    expect(r).toContain('justify-content: flex-end;');
    expect(r).toContain('pointer-events: none;');
    expect(cssRule('.panel-command[data-pick-dock] > .panel-controls > *')).toContain('pointer-events: auto;');
  });
  it('it follows the composer: its tools, its size, a new card’s composer, the controls’ repaint', () => {
    expect(clientFn('pcComposerSetup')).toContain('requestAnimationFrame(syncPickerDock)');
    expect(clientFn('renderPanelControls')).toMatch(/mpHydrate\(el\);\n\s*syncPickerDock\(\);/);
    expect(TEMPLATE).toContain("['#panel-command', '#panel-command .pc-steer-wrap'].forEach(function(sel) {");
  });
});
