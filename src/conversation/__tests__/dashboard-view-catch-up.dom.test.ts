// @vitest-environment happy-dom
/**
 * Out of view → back: the past lands still (the hidden-tab replay).
 *
 * A tab the browser froze (Chrome's Energy Saver, a collapsed tab group) or suspended (Safari) holds its socket's
 * messages and runs them, back to back, once it is shown again — on a page that is visible by then, so each push
 * played its glides, fades and waves: the board replayed the time nobody watched. A reconnecting socket's whole board
 * did the same in one go. The page now catches up still:
 *
 *   C1  away opens when the page leaves view; back in view, it stays open while held messages keep coming
 *   C2  it closes once the socket has been quiet for VIEW_SETTLE_QUIET_MS after the return …
 *   C3  … or VIEW_SETTLE_MAX_MS after the return on a socket that never goes quiet
 *   C4  a return while still hidden, or a new leave, keeps it open (no settle runs out of view)
 *   C5  a socket that opens catches up like a return (its first board is the whole board)
 *   C6  the page's own motion (canAnimate) waits for the catch-up
 *   C7  the real <ui-agent-inbox>, painted through the page's inboxPaint while catching up: the cards land, nothing
 *       animates; once settled, the next paint animates again; document.hidden is the browser's again after
 *   C8  the wiring: visibility / freeze / page show events, the socket's open and every message
 *
 * Executes the shipped client code cut out of renderDashboardPage()'s template literal; C7 runs it against the
 * installed @2lab.ai/ui.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nextActionSeams } from '../__fixtures__/viewer-scope';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  if (TEMPLATE.indexOf(`\nfunction ${name}(`, start + 1) >= 0) throw new Error(`client ${name} is declared twice`);
  const line = TEMPLATE.indexOf('\n', start + 1);
  const oneLine = TEMPLATE.slice(start + 1, line)
    .trimEnd()
    .endsWith('}');
  const end = oneLine ? line : TEMPLATE.indexOf('\n}\n', start) + 2;
  return cook(TEMPLATE.slice(start + 1, end));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown>, exports = ''): T {
  inject = { ...nextActionSeams(fns, inject), ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}${exports ? `, ${exports}` : ''} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const VIEW_FNS = [
  'viewCatchingUp',
  'viewLeave',
  'viewReturn',
  'viewSync',
  'viewHeard',
  'viewSettleSoon',
  'viewSettle',
  'viewStill',
];
const VIEW_VARS = ['VIEW_SETTLE_QUIET_MS', 'VIEW_SETTLE_MAX_MS', '_viewAway', '_viewBackAt', '_viewSettleTimer'];
type View = {
  viewCatchingUp(): boolean;
  viewLeave(): void;
  viewReturn(): void;
  viewSync(): void;
  viewHeard(): void;
  viewStill(host: unknown): void;
};
// A page whose visibility the test flips (document.hidden), with the timers faked.
function page(hidden = false) {
  const doc = { hidden };
  const v = load<View>(VIEW_FNS, VIEW_VARS, { document: doc });
  return { v, doc };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the catch-up window (C1–C5)', () => {
  it('C1/C2 away → back: open while held messages keep coming, closed once the socket is quiet for 400 ms', () => {
    vi.useFakeTimers();
    const { v, doc } = page();
    expect(v.viewCatchingUp()).toBe(false);
    doc.hidden = true;
    v.viewLeave();
    expect(v.viewCatchingUp()).toBe(true);
    vi.advanceTimersByTime(60_000); // hours away change nothing
    expect(v.viewCatchingUp()).toBe(true);
    doc.hidden = false;
    v.viewReturn();
    // The held messages run back to back: every one keeps the window open.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(300);
      v.viewHeard();
      expect(v.viewCatchingUp()).toBe(true);
    }
    vi.advanceTimersByTime(399);
    expect(v.viewCatchingUp()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(v.viewCatchingUp()).toBe(false);
    // Settled: a live message is just a message.
    v.viewHeard();
    expect(v.viewCatchingUp()).toBe(false);
  });

  it('C2 a return with nothing held settles 400 ms later', () => {
    vi.useFakeTimers();
    const { v, doc } = page();
    doc.hidden = true;
    v.viewLeave();
    doc.hidden = false;
    v.viewReturn();
    vi.advanceTimersByTime(399);
    expect(v.viewCatchingUp()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(v.viewCatchingUp()).toBe(false);
  });

  it('C3 a socket that never goes quiet: settled 8 s after the return all the same', () => {
    vi.useFakeTimers();
    const { v, doc } = page();
    doc.hidden = true;
    v.viewLeave();
    doc.hidden = false;
    v.viewReturn();
    for (let t = 0; t < 7_900; t += 100) {
      vi.advanceTimersByTime(100);
      v.viewHeard();
    }
    expect(v.viewCatchingUp()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(v.viewCatchingUp()).toBe(false);
  });

  it('C4 back while still hidden keeps it open; a leave during the catch-up cancels the settle', () => {
    vi.useFakeTimers();
    const { v, doc } = page(true);
    // A page that loads hidden starts away.
    expect(v.viewCatchingUp()).toBe(true);
    v.viewReturn(); // resume (unfrozen) while hidden
    vi.advanceTimersByTime(10_000);
    expect(v.viewCatchingUp()).toBe(true);
    doc.hidden = false;
    v.viewReturn();
    vi.advanceTimersByTime(200);
    doc.hidden = true;
    v.viewLeave();
    vi.advanceTimersByTime(10_000);
    expect(v.viewCatchingUp()).toBe(true);
    // A settle timer that fires while the page is hidden does not close the window.
    doc.hidden = false;
    v.viewReturn();
    doc.hidden = true;
    vi.advanceTimersByTime(10_000);
    expect(v.viewCatchingUp()).toBe(true);
  });

  it('C5 a socket that opens catches up like a return — in view it settles once its first board has landed', () => {
    vi.useFakeTimers();
    const { v } = page();
    v.viewSync();
    expect(v.viewCatchingUp()).toBe(true);
    v.viewHeard(); // hello
    vi.advanceTimersByTime(5);
    v.viewHeard(); // the whole board
    vi.advanceTimersByTime(399);
    expect(v.viewCatchingUp()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(v.viewCatchingUp()).toBe(false);
  });
});

describe('the page’s own motion waits for the catch-up (C6)', () => {
  it('canAnimate is false while the page catches up, true once settled', () => {
    const run = (catching: boolean) =>
      load<{ canAnimate(): boolean }>(['canAnimate'], [], {
        _boardRenders: 3,
        document: { hidden: false },
        Element: { prototype: { animate() {} } },
        viewCatchingUp: () => catching,
      }).canAnimate();
    expect(run(false)).toBe(true);
    expect(run(true)).toBe(false);
  });
});

// ── C7: the real element ──
type Inbox = HTMLElementLike & {
  data: unknown;
  renderNow(): void;
  shadowRoot: { querySelectorAll(s: string): ArrayLike<HTMLElementLike> };
};
interface HTMLElementLike {
  getAttribute(n: string): string | null;
  closest(s: string): HTMLElementLike | null;
}
const g = globalThis as unknown as {
  document: { createElement(t: string): Inbox; body: { append(n: unknown): void }; hidden: boolean };
  HTMLElement: { prototype: { animate: unknown } };
  customElements: { get(n: string): unknown };
};
beforeAll(async () => {
  await import('@2lab.ai/ui');
}, 60_000);

describe('the board element paints the past still (C7)', () => {
  const cards = (ids: string[]) => ids.map((id) => ({ id, title: `card ${id}`, status: 'running' }));
  // The page's inboxPaint over its plan: one RUNNING column of the given keys.
  function board(view: View, host: Inbox & Record<string, unknown>) {
    const cardData: Record<string, unknown> = {};
    const paint = load<{ inboxPaint(h: unknown): void }>(['inboxPaint'], [], {
      _expanded: new Set<string>(),
      _cardData: cardData,
      BOARD_STRINGS: {},
      cardMinSeeds: () => [],
      boardCurrentKey: () => '',
      syncCardFinish: () => {},
      viewStill: view.viewStill,
    });
    return (ids: string[]) => {
      for (const c of cards(ids)) cardData[c.id] = c;
      host._ibPlan = { cols: [{ id: 'working', label: '실행 중', keys: ids }], load: 'ready', announce: false };
      paint.inboxPaint(host);
    };
  }
  const drawn = (host: Inbox) =>
    Array.from(host.shadowRoot.querySelectorAll('li.ib-card[data-card]')).map((li) => li.getAttribute('data-card'));

  it('while catching up the cards land and nothing animates; settled, the next paint animates again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    expect(g.customElements.get('ui-agent-inbox')).toBeTruthy();
    const calls: string[] = [];
    const proto = g.HTMLElement.prototype;
    const had = Object.getOwnPropertyDescriptor(proto, 'animate');
    // A stand-in Animation: the element cancels, chains onfinish and reads progress.
    proto.animate = function (this: { className?: string }) {
      calls.push(String(this.className || 'el'));
      return {
        cancel() {},
        finish() {},
        onfinish: null,
        oncancel: null,
        effect: { getComputedTiming: () => ({ progress: 0 }) },
      };
    };
    try {
      const doc = g.document;
      const host = doc.createElement('ui-agent-inbox') as Inbox & Record<string, unknown>;
      doc.body.append(host);
      const v = load<View>(VIEW_FNS, VIEW_VARS, { document: doc });
      const paint = board(v, host);
      // First paint (never animates), then a settled live paint: a fresh card fades in — the stub sees motion.
      paint(['a']);
      await Promise.resolve();
      host.renderNow();
      paint(['a', 'b']);
      await Promise.resolve();
      expect(drawn(host)).toEqual(['a', 'b']);
      expect(calls.length).toBeGreaterThan(0);
      // Away, then back: the held pushes paint through inboxPaint — each lands at once, without one animation.
      calls.length = 0;
      v.viewLeave();
      v.viewReturn();
      paint(['a', 'b', 'c']);
      expect(drawn(host)).toEqual(['a', 'b', 'c']); // drawn now, not a microtask later
      paint(['d', 'a', 'b', 'c']);
      paint(['d', 'c']);
      await Promise.resolve();
      expect(drawn(host)).toEqual(['d', 'c']);
      expect(calls).toEqual([]);
      // The browser's own document.hidden is back after each still render.
      expect(Object.getOwnPropertyDescriptor(doc, 'hidden')).toBeUndefined();
      expect(doc.hidden).toBe(false);
      // Settled: the next live push animates again.
      vi.advanceTimersByTime(400);
      expect(v.viewCatchingUp()).toBe(false);
      paint(['d', 'c', 'e']);
      await Promise.resolve();
      expect(drawn(host)).toEqual(['d', 'c', 'e']);
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      if (had) Object.defineProperty(proto, 'animate', had);
      else delete (proto as { animate?: unknown }).animate;
    }
  });

  it('an element not upgraded yet (no renderNow) is left to its own render', () => {
    const { v } = page();
    v.viewLeave();
    v.viewReturn();
    expect(() => v.viewStill({ data: {} })).not.toThrow();
    expect(() => v.viewStill(null)).not.toThrow();
  });

  it('a still render that throws still gives document.hidden back', () => {
    const doc = g.document;
    const v = load<View>(VIEW_FNS, VIEW_VARS, { document: doc });
    v.viewLeave();
    v.viewReturn();
    let seen: boolean | null = null;
    expect(() =>
      v.viewStill({
        renderNow() {
          seen = doc.hidden;
          throw new Error('render failed');
        },
      }),
    ).toThrow('render failed');
    expect(seen).toBe(true);
    expect(Object.getOwnPropertyDescriptor(doc, 'hidden')).toBeUndefined();
    expect(doc.hidden).toBe(false);
  });
});

describe('the wiring (C8)', () => {
  it('visibility, freeze and page show events move the window', () => {
    expect(TEMPLATE).toContain(
      "document.addEventListener('visibilitychange', function() { if (document.hidden) viewLeave(); else viewReturn(); });",
    );
    expect(TEMPLATE).toContain("document.addEventListener('freeze', viewLeave);");
    expect(TEMPLATE).toContain("document.addEventListener('resume', viewReturn);");
    expect(TEMPLATE).toContain("window.addEventListener('pagehide', viewLeave);");
    expect(TEMPLATE).toContain("window.addEventListener('pageshow', viewReturn);");
  });

  it('the socket: its open catches up like a return, and every message keeps the catch-up open', () => {
    const connect = clientFn('connectWs');
    const open = connect.slice(connect.indexOf('ws.onopen = function() {'), connect.indexOf('ws.onclose'));
    expect(open).toContain("if (typeof viewSync === 'function') viewSync();");
    const onMessage = connect.slice(connect.indexOf('ws.onmessage = function(ev) {'));
    expect(onMessage.indexOf("if (typeof viewHeard === 'function') viewHeard();")).toBeGreaterThan(-1);
    expect(onMessage.indexOf("if (typeof viewHeard === 'function') viewHeard();")).toBeLessThan(
      onMessage.indexOf('JSON.parse(ev.data)'),
    );
  });

  it('every board element paint goes through viewStill, after the page has set its data', () => {
    const body = clientFn('inboxPaint');
    expect(body).toContain("if (typeof viewStill === 'function') viewStill(host);");
    expect(body.indexOf('viewStill(host)')).toBeGreaterThan(body.indexOf('host.data = {'));
  });
});
