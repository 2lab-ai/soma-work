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
 *   C6  a board load asked while catching up (the poll a frozen tab fires on its return) holds the window until it
 *       has answered — within VIEW_SETTLE_MAX_MS; one asked during an earlier time away no longer holds it
 *   C7  the real <ui-agent-inbox>, painted through the page's inboxPaint while catching up: the cards land, nothing
 *       animates; once settled, the next paint animates again; document.hidden is the browser's again after; the
 *       return itself lands every planned board element still (a card held in its lane when the page left)
 *   C8  the wiring: visibility / freeze / page show events, the socket's open and the end of every message, the board
 *       poll's hold, the layout check's quiet view switch; the reader's own motion (canAnimate) is left alone
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
// An async client function, whole (clientFn finds plain `function` declarations).
function clientAsyncFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client async function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
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
  'viewHold',
  'viewQuiet',
  'viewStill',
  'viewLand',
];
const VIEW_VARS = [
  'VIEW_SETTLE_QUIET_MS',
  'VIEW_SETTLE_MAX_MS',
  '_viewAway',
  '_viewBackAt',
  '_viewSettleTimer',
  '_viewHolds',
  '_viewGen',
];
type View = {
  viewCatchingUp(): boolean;
  viewLeave(): void;
  viewReturn(): void;
  viewSync(): void;
  viewHeard(): void;
  viewHold(): () => void;
  viewStill(host: unknown): void;
};
// A page whose visibility the test flips (document.hidden), with the timers faked; no board elements on it.
function page(hidden = false) {
  const doc = { hidden, querySelectorAll: () => [] };
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

describe('a board load asked while catching up holds the window (C6)', () => {
  it('the poll a frozen tab fires on its return: the window stays open until it has answered', () => {
    vi.useFakeTimers();
    const { v, doc } = page();
    doc.hidden = true;
    v.viewLeave();
    doc.hidden = false;
    v.viewReturn();
    const release = v.viewHold(); // the overdue 30 s poll, asked at once
    vi.advanceTimersByTime(3_000); // the socket went quiet long ago; the answer is slow (sibling fan-out)
    expect(v.viewCatchingUp()).toBe(true);
    release(); // answered — painted while still catching up
    release(); // a second call is nothing
    vi.advanceTimersByTime(399);
    expect(v.viewCatchingUp()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(v.viewCatchingUp()).toBe(false);
  });

  it('a load that never answers holds it 8 s after the return at most; a load asked in view holds nothing', () => {
    vi.useFakeTimers();
    const { v, doc } = page();
    expect(v.viewHold()).toBeTypeOf('function'); // in view and settled: a no-op release
    doc.hidden = true;
    v.viewLeave();
    doc.hidden = false;
    v.viewReturn();
    v.viewHold();
    vi.advanceTimersByTime(7_999);
    expect(v.viewCatchingUp()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(v.viewCatchingUp()).toBe(false);
  });

  it('a load asked during an earlier time away no longer holds the window', () => {
    vi.useFakeTimers();
    const { v, doc } = page();
    doc.hidden = true;
    v.viewLeave();
    const stale = v.viewHold(); // asked while hidden, never answers in time
    v.viewLeave(); // frozen: a new time away
    doc.hidden = false;
    v.viewReturn();
    vi.advanceTimersByTime(400);
    expect(v.viewCatchingUp()).toBe(false);
    // Its late answer does not reopen anything, nor count against the next time away.
    stale();
    expect(v.viewCatchingUp()).toBe(false);
    doc.hidden = true;
    v.viewLeave();
    doc.hidden = false;
    v.viewReturn();
    vi.advanceTimersByTime(400);
    expect(v.viewCatchingUp()).toBe(false);
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

  it('the return itself lands every board element the page painted, still; one it did not plan is left alone', () => {
    const renders: string[] = [];
    const host = (name: string, planned: boolean) => ({
      ...(planned ? { _ibPlan: {} } : {}),
      renderNow() {
        renders.push(`${name}:${String(doc.hidden)}`);
      },
    });
    const els = [host('board', true), host('cron', true), host('docs', false)];
    const doc: { hidden: boolean; querySelectorAll(sel: string): unknown[] } = {
      hidden: true,
      querySelectorAll: (sel: string) => (sel === 'ui-agent-inbox' ? els : []),
    };
    const v = load<View>(VIEW_FNS, VIEW_VARS, { document: doc });
    v.viewLeave();
    doc.hidden = false;
    v.viewReturn();
    // Drawn with document.hidden reading true (the stand-in document is plain: its own value is put back after).
    expect(renders).toEqual(['board:true', 'cron:true']);
    expect(doc.hidden).toBe(false);
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

  it('the socket: its open catches up like a return; the quiet counts from the end of every message', () => {
    const connect = clientFn('connectWs');
    const open = connect.slice(connect.indexOf('ws.onopen = function() {'), connect.indexOf('ws.onclose'));
    expect(open).toContain("if (typeof viewSync === 'function') viewSync();");
    const onMessage = connect.slice(connect.indexOf('ws.onmessage = function(ev) {'));
    // In the finally: after the message's work, even one that returned early or threw.
    expect(onMessage).toMatch(
      /\} finally \{\n\s*\/\/[^\n]*\n\s*if \(typeof viewHeard === 'function'\) viewHeard\(\);\n\s*\}\n\s*\};\n\}$/,
    );
    expect(onMessage.match(/viewHeard\(\)/g)).toHaveLength(1);
  });

  it('the board poll holds the window while it is out, and lets go in its finally', () => {
    const body = clientAsyncFn('loadSessions');
    expect(body).toContain("var viewRelease = typeof viewHold === 'function' ? viewHold() : null;");
    const fin = body.slice(body.lastIndexOf('} finally {'));
    expect(fin).toContain('if (viewRelease) viewRelease();');
    // Asked after the join: a poll that joins one already out adds no hold of its own.
    expect(body.indexOf('viewHold()')).toBeGreaterThan(body.indexOf('return _sessionsInflight.done;'));
  });

  it('a layout that changed while away lands without its glide; the reader’s own motion is left alone', () => {
    const check = clientFn('runLayoutCheck');
    expect(check).toContain(
      "var quiet = typeof viewCatchingUp === 'function' && viewCatchingUp() && !document.hidden;",
    );
    expect(check).toContain('if (quiet) viewQuiet(function() { setBoardView(autoView); });');
    expect(check).toContain('var animate = canAnimate() && !keyed && !quiet;');
    // canAnimate (a card's close, the panel's drag settle) does not look at the catch-up.
    expect(clientFn('canAnimate')).not.toContain('viewCatchingUp');
  });

  it('every board element paint goes through viewStill, after the page has set its data', () => {
    const body = clientFn('inboxPaint');
    expect(body).toContain("if (typeof viewStill === 'function') viewStill(host);");
    expect(body.indexOf('viewStill(host)')).toBeGreaterThan(body.indexOf('host.data = {'));
  });
});
