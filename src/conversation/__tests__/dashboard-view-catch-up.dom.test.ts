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
 *   C9  every finite animation on the page — the document's and each element's shadow tree's, nested — jumps to its
 *       end (a chat turn's or a work-log row's entrance); endless ones run on; one that cannot finish is left
 *   C10 the return lands them at once and then once per frame while the page catches up; settled or gone again, the
 *       frame loop stops
 *   C11 the chat and the work log, given data while catching up, land their new rows right after they draw them
 *       (a microtask after the element's render) — also when they draw in a frame callback after the loop's
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
  'viewFinishMotion',
  'viewFinishLoop',
  'viewLandSoon',
];
const VIEW_VARS = [
  'VIEW_SETTLE_QUIET_MS',
  'VIEW_SETTLE_MAX_MS',
  '_viewAway',
  '_viewBackAt',
  '_viewSettleTimer',
  '_viewHolds',
  '_viewGen',
  '_viewFinishRaf',
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
  const v = load<View>(VIEW_FNS, VIEW_VARS, {
    document: doc,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  });
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

// ── C9 / C10: every element's entrance lands while the page catches up ──
type Anim = { name: string; endTime: number; playState: string; finished: number; finish(): void };
function anim(name: string, endTime: number, playState = 'running', throws = false): Anim {
  const a: Anim = {
    name,
    endTime,
    playState,
    finished: 0,
    finish() {
      if (throws) throw new Error('InvalidStateError');
      a.finished++;
      a.playState = 'finished';
    },
  };
  return a;
}
// A scope (the document or a shadow root): its elements, and the animations whose targets are in it.
function scope(els: unknown[], anims: Anim[]) {
  return {
    querySelectorAll: (sel: string) => (sel === '*' ? els : []),
    getAnimations: () =>
      anims.map((a) => ({
        ...a,
        effect: { getComputedTiming: () => ({ endTime: a.endTime }) },
        finish: () => a.finish(),
        playState: a.playState,
      })),
  };
}

describe('every finite animation lands while catching up (C9)', () => {
  it('the document’s and each shadow tree’s, nested; endless and finished ones are left; one that throws is skipped', () => {
    const turnIn = anim('ls-in@cv-turn', 360);
    const rowIn = anim('wl-rise@wl-entry', 320);
    const spin = anim('wl-spin', Number.POSITIVE_INFINITY);
    const beam = anim('beam', Number.POSITIVE_INFINITY);
    const done = anim('old', 200, 'finished');
    const stuck = anim('zero-rate', 300, 'running', true);
    const pageFade = anim('panel-fade', 180);
    // document → <ui-conversation> (shadow) → <ui-ai-answer> (shadow); document → <ui-work-log> (shadow)
    // The one that cannot finish comes first, in the first shadow tree visited: the rest still land.
    const answerRoot = scope([], [turnIn, beam]);
    const convRoot = scope([{ shadowRoot: answerRoot }, {}], [stuck, rowIn]);
    const wlRoot = scope([], [spin, done, pageFade]);
    const doc = scope([{ shadowRoot: convRoot }, { shadowRoot: null }, { shadowRoot: wlRoot }], []);
    const v = load<{ viewFinishMotion(): number }>(['viewFinishMotion'], [], { document: doc });
    expect(v.viewFinishMotion()).toBe(3);
    expect([turnIn, rowIn, pageFade].map((a) => a.finished)).toEqual([1, 1, 1]);
    expect([spin, beam, done, stuck].map((a) => a.finished)).toEqual([0, 0, 0, 0]);
  });

  it('a scope without getAnimations (an old browser) is passed over', () => {
    const doc = { querySelectorAll: () => [] };
    const v = load<{ viewFinishMotion(): number }>(['viewFinishMotion'], [], { document: doc });
    expect(v.viewFinishMotion()).toBe(0);
  });
});

describe('the return lands them at once, then once per frame while catching up (C10)', () => {
  it('runs on the return and each frame until settled; a leave stops the loop', () => {
    vi.useFakeTimers();
    const frames: Array<() => void> = [];
    let cancelled = 0;
    const row = anim('wl-rise@wl-entry', 320);
    const anims: Anim[] = [row];
    const doc = { hidden: true, ...scope([], anims) };
    const v = load<View>(VIEW_FNS, VIEW_VARS, {
      document: doc,
      requestAnimationFrame: (f: () => void) => frames.push(f),
      cancelAnimationFrame: () => cancelled++,
    });
    v.viewLeave();
    doc.hidden = false;
    v.viewReturn();
    expect(row.finished).toBe(1); // at once, before the first frame back is painted
    expect(frames).toHaveLength(1);
    // A held message adds a row: the next frame lands it, and asks for the next.
    const next = anim('ls-in@cv-turn', 360);
    anims.push(next);
    frames.shift()?.();
    expect(next.finished).toBe(1);
    expect(frames).toHaveLength(1);
    // Settled: the loop's next frame finds nothing to do and stops.
    vi.advanceTimersByTime(400);
    expect(v.viewCatchingUp()).toBe(false);
    const live = anim('ls-in@cv-turn', 360);
    anims.push(live);
    frames.shift()?.();
    expect(live.finished).toBe(0); // a live entrance plays
    expect(frames).toHaveLength(0);
    // Back again, then away before settling: the loop is cancelled.
    doc.hidden = true;
    v.viewLeave();
    doc.hidden = false;
    v.viewReturn();
    expect(frames).toHaveLength(1);
    doc.hidden = true;
    v.viewLeave();
    expect(cancelled).toBeGreaterThan(0);
  });
});

describe('the chat and the work log land their rows right after drawing them (C11)', () => {
  it('queues one landing after the element’s render while back and catching up; not in view or settled, nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const row = anim('ls-in@cv-turn', 360);
    const anims: Anim[] = [];
    const doc = { hidden: true, ...scope([], anims) };
    const v = load<View & { viewLandSoon(): void }>(VIEW_FNS, VIEW_VARS, {
      document: doc,
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
    });
    v.viewLeave();
    v.viewLandSoon(); // hidden: the return lands everything at once instead
    doc.hidden = false;
    v.viewReturn();
    // The element's render was queued when the data was set (first), the landing after it: the row it draws lands.
    queueMicrotask(() => anims.push(row));
    v.viewLandSoon();
    expect(row.finished).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(row.finished).toBe(1);
    // Settled: a live row keeps its entrance.
    vi.advanceTimersByTime(400);
    const live = anim('ls-in@cv-turn', 360);
    queueMicrotask(() => anims.push(live));
    v.viewLandSoon();
    await Promise.resolve();
    await Promise.resolve();
    expect(live.finished).toBe(0);
  });

  it('the chat and the work log ask for it right after setting their element’s data', () => {
    const conv = clientFn('convSetData');
    expect(conv.indexOf("if (typeof viewLandSoon === 'function') viewLandSoon();")).toBeGreaterThan(
      conv.indexOf('el.data = d;'),
    );
    const wl = clientFn('wlPaint');
    const set = wl.indexOf('el.data = d;');
    const land = wl.indexOf("if (typeof viewLandSoon === 'function') viewLandSoon();");
    expect(land).toBeGreaterThan(set);
    expect(land).toBeLessThan(wl.indexOf('wlRbSync();')); // inside the branch that set new data
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
