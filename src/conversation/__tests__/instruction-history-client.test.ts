// @vitest-environment happy-dom
/**
 * 보낸 지시 (SSOT 2026-11-27) — the client half: the round button with the count beside the follow-up queue's, the
 * list it opens (a page at a time, 처음부터 · 최근부터), and a row moving 대화 to its instruction. Executes the shipped
 * client code (instruction-history-client.ts) against the page's markup, with the page's panel state injected.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageText, registerPageCatalog, scanPage } from '@soma/common/i18n-page';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { INSTRUCTION_HISTORY_CLIENT_JS, INSTRUCTION_HISTORY_CSS } from '../instruction-history-client';

// tsc compiles the tests without the DOM lib; happy-dom supplies these at run time.
const dom = globalThis as unknown as Record<string, any>;
const document = dom.document as any;
type HTMLElement = any;
type DOMRect = any;

registerPageCatalog(
  JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'),
      'utf8',
    ),
  ),
);

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));
const WRAP_START = DASHBOARD_TS.indexOf('<div class="ui-tok pc-steer-wrap">');
const MARKUP = `${DASHBOARD_TS.slice(WRAP_START, DASHBOARD_TS.indexOf('<ui-agent-steering', WRAP_START))}</div>`;

function cutFn(src: string, name: string): string {
  const start = src.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  return src.slice(start + 1, src.indexOf('\n}\n', start) + 2);
}
function pageFn(name: string): string {
  const raw = cutFn(TEMPLATE, name);
  return new Function(`return \`${raw}\`;`)() as string;
}

const PAGE_STATE = [
  'PANEL_TURNS_PAGE',
  'panelSessionKey',
  'panelConvId',
  '_panelGen',
  '_panelAgent',
  '_psec',
  '_panelTurnsList',
  '_panelTurnsLoading',
  '_panelTurnsHasMore',
  '_panelTurnsOldestId',
  '_panelTurnsCid',
  '_panelTurnsMsg',
  '_panelTurnsWhy',
  '_panelOlderWhy',
];
const PAGE_FNS = [
  'selectPanelAgent',
  'selectPanelSection',
  'convPaint',
  'convEl',
  'convViewport',
  'dashToast',
  'ptMergeFetched',
  'requestAnimationFrame',
  'fetch',
];

type Json = Record<string, unknown>;
type Reply = Json | Error | ((url: string) => Json | Error);

// Every boot runs the client's wiring, which adds document listeners: they are taken off after each test, so no
// earlier test's client answers a later test's presses.
const docListeners: Array<[string, any, any]> = [];
function boot(
  opts: { state?: Json; fetch?: Record<string, Reply> | ((url: string) => Json | Error); fns?: Json } = {},
) {
  document.body.innerHTML = `<div class="panel-command">${MARKUP}</div><div id="outside"></div>`;
  const realAdd = document.addEventListener.bind(document);
  document.addEventListener = (type: string, fn: any, o?: any) => {
    docListeners.push([type, fn, o]);
    realAdd(type, fn, o);
  };
  const calls: string[] = [];
  const reply = (url: string): Json | Error => {
    if (typeof opts.fetch === 'function') return opts.fetch(url);
    const table = opts.fetch || {};
    const key = Object.keys(table).find((k) => url.includes(k));
    if (!key) return new Error(`unexpected fetch ${url}`);
    const r = table[key];
    return typeof r === 'function' ? r(url) : r;
  };
  const fetchMock = vi.fn((url: string) => {
    calls.push(url);
    const r = reply(url);
    if (r instanceof Error) return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => r });
  });
  const state: Json = {
    PANEL_TURNS_PAGE: 20,
    panelSessionKey: 'C1:t1',
    panelConvId: 'c1',
    _panelGen: 1,
    _panelAgent: '',
    _psec: 'conv',
    _panelTurnsList: [],
    _panelTurnsLoading: false,
    _panelTurnsHasMore: false,
    _panelTurnsOldestId: null,
    _panelTurnsCid: 'c1',
    _panelTurnsMsg: '',
    _panelTurnsWhy: '',
    _panelOlderWhy: '',
    ...opts.state,
  };
  const vp = document.createElement('div');
  const turnNode = document.createElement('div');
  (turnNode as any).animate = vi.fn();
  const conv = {
    turnElement: vi.fn((id: string) => (shownIds.has(id) ? turnNode : null)),
  };
  const shownIds = new Set<string>();
  const fns: Json = {
    selectPanelAgent: vi.fn(),
    selectPanelSection: vi.fn(),
    convPaint: vi.fn(() => {
      for (const t of api.state().list as Json[]) shownIds.add(String(t.id));
    }),
    convEl: () => conv,
    convViewport: () => vp,
    dashToast: vi.fn(),
    ptMergeFetched: (fetched: Json[], pushed: Json[]) =>
      fetched.concat(pushed.filter((p) => !fetched.some((f) => f.id === p.id))),
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    fetch: fetchMock,
    ...opts.fns,
  };
  const adminFmt = new Function(`${pageFn('adminFmt')}\nreturn adminFmt;`)();
  const names = [...PAGE_STATE, ...PAGE_FNS, 'adminFmt'];
  const body = `${INSTRUCTION_HISTORY_CLIENT_JS}
return {
  ihSync: ihSync, ihToggle: ihToggle, ihClose: ihClose, ihSetOrder: ihSetOrder, ihJump: ihJump, ihLoadMore: ihLoadMore,
  set: function(k, v) { eval(k + ' = v'); },
  msg: function() { return { msg: _panelTurnsMsg, why: _panelTurnsWhy }; },
  state: function() { return { ih: _ih, list: _panelTurnsList, oldest: _panelTurnsOldestId, hasMore: _panelTurnsHasMore,
    loading: _panelTurnsLoading, psec: _psec }; },
};`;
  const values = names.map((n) => (n in state ? state[n] : n === 'adminFmt' ? adminFmt : fns[n]));
  const api = new Function(...names, body)(...values) as any;
  document.addEventListener = realAdd;
  return { api, calls, fns: fns as any, vp, turnNode, conv };
}
// Settles the client's promise chains and timers: real timers step in small waits; fake timers (vi.useFakeTimers)
// are advanced instead, so a test that waits out a debounce or a retry does not depend on the host's load.
const flush = async (ms = 10) => {
  for (let i = 0; i < 6; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((r) => setTimeout(r, ms));
  }
};
const wait = async (ms: number) => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
  else await new Promise((r) => setTimeout(r, ms));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const page = (offset: number, n: number, total: number, order = 'asc') => ({
  total,
  offset,
  order,
  nextOffset: offset + n < total ? offset + n : null,
  items: Array.from({ length: n }, (_, i) => {
    const num = order === 'asc' ? offset + i + 1 : total - offset - i;
    return { id: `u${num}`, n: num, at: 1_700_000_000_000 + num, userName: 'Z', text: `지시 ${num}` };
  }),
});

// The page keeps the chosen order in localStorage (happy-dom here has none without a URL).
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
beforeEach(() => {
  store.clear();
});
afterEach(() => {
  document.body.innerHTML = '';
  for (const [type, fn, o] of docListeners.splice(0)) document.removeEventListener(type, fn, o);
});

describe('the round button — how many instructions, beside the queue’s button', () => {
  it('shows the count of the open card’s conversation; the queue’s button moves left of it', async () => {
    const { api, calls } = boot({ fetch: { 'instructions?offset=0&limit=0': { total: 42, items: [] } } });
    expect($('ih-dock').hidden).toBe(true);
    api.ihSync('c1');
    await flush();
    expect(calls).toEqual(['/api/dashboard/session/c1/instructions?offset=0&limit=0&order=asc']);
    expect($('ih-dock').hidden).toBe(false);
    expect($('ih-dock-n').textContent).toBe('42');
    expect($('ih-dock').getAttribute('aria-label')).toBe('보낸 지시 42개 — 눌러서 목록 보기');
    expect($('ih-dock').parentElement?.hasAttribute('data-ih')).toBe(true);
    expect(INSTRUCTION_HISTORY_CSS).toContain(
      '.pc-steer-wrap[data-ih] > ui-agent-steering { --ui-steering-dock-right: 40px; }',
    );
  });

  it('no instruction (or a count that could not be had): no button', async () => {
    const { api } = boot({ fetch: { 'limit=0': { total: 0 } } });
    api.ihSync('c1');
    await flush();
    expect($('ih-dock').hidden).toBe(true);
    expect($('ih-dock').parentElement?.hasAttribute('data-ih')).toBe(false);
    const b = boot({ fetch: { 'limit=0': new Error('404') } });
    b.api.ihSync('c1');
    await flush();
    expect($('ih-dock').hidden).toBe(true);
  });

  it('999+ past three digits', async () => {
    const { api } = boot({ fetch: { 'limit=0': { total: 1234 } } });
    api.ihSync('c1');
    await flush();
    expect($('ih-dock-n').textContent).toBe('999+');
  });

  it('a person’s turn asks for the count again (once for a burst); closing the card hides it; another card’s late count is dropped', async () => {
    vi.useFakeTimers();
    try {
      let total = 3;
      const { api, calls, fns } = boot({ fetch: (url) => (url.includes('/c2/') ? { total: 99 } : { total }) });
      api.ihSync('c1');
      await vi.advanceTimersByTimeAsync(10);
      expect($('ih-dock-n').textContent).toBe('3');
      total = 4;
      api.ihSync('c1', true);
      api.ihSync('c1', true);
      api.ihSync('c1'); // the turns page landing: same card, no new ask
      await vi.advanceTimersByTimeAsync(700);
      expect(calls.length).toBe(2);
      expect($('ih-dock-n').textContent).toBe('4');
      api.ihSync('');
      await vi.advanceTimersByTimeAsync(10);
      expect($('ih-dock').hidden).toBe(true);
      // A switch while a count is on its way: the old card's answer, landing late, does not paint the new card's button.
      let releaseC2: (v: unknown) => void = () => {};
      fns.fetch.mockImplementation((url: string) =>
        url.includes('/c2/')
          ? new Promise((r) => {
              releaseC2 = r;
            })
          : Promise.resolve({ ok: true, json: async () => ({ total: 5 }) }),
      );
      api.ihSync('c2');
      await vi.advanceTimersByTimeAsync(10); // c2's count is on its way, held
      api.ihSync('c3');
      await vi.advanceTimersByTimeAsync(10);
      expect($('ih-dock-n').textContent).toBe('5');
      releaseC2({ ok: true, json: async () => ({ total: 99 }) });
      await vi.advanceTimersByTimeAsync(10);
      expect($('ih-dock-n').textContent).toBe('5');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the list — every instruction from the first, a page at a time', () => {
  it('a press opens it on the first page (#1 first); 더 보기 and the scroll bring the next page', async () => {
    const { api, calls } = boot({
      fetch: (url) => {
        if (url.includes('limit=0')) return { total: 45 };
        const off = Number(/offset=(\d+)/.exec(url)?.[1]);
        return page(off, Math.min(30, 45 - off), 45);
      },
    });
    api.ihSync('c1');
    await flush();
    api.ihToggle(); // the button's onclick (the page's global ihToggle)
    expect($('ih-pop').hasAttribute('data-open')).toBe(true);
    expect($('ih-dock').getAttribute('aria-expanded')).toBe('true');
    await flush();
    expect(calls).toContain('/api/dashboard/session/c1/instructions?offset=0&limit=30&order=asc');
    const rows = (): any[] => Array.from(document.querySelectorAll('#ih-list .ih-row'));
    // happy-dom lays nothing out: the end is "in view" — the list keeps asking until it is all there.
    await flush();
    expect(rows()).toHaveLength(45);
    expect(rows()[0].querySelector('.ih-n')?.textContent).toBe('#1');
    expect(rows()[0].querySelector('.ih-text')?.textContent).toBe('지시 1');
    expect(rows()[0].querySelector('.ih-meta')?.textContent).toContain('Z');
    expect(calls).toContain('/api/dashboard/session/c1/instructions?offset=30&limit=30&order=asc');
    expect($('ih-foot').textContent).toBe('');
  });

  it('a laid-out list asks for the next page only as its end nears (scroll), and 더 보기 asks too', async () => {
    const { api, calls } = boot({
      fetch: (url) => {
        if (url.includes('limit=0')) return { total: 75 };
        const off = Number(/offset=(\d+)/.exec(url)?.[1]);
        return page(off, Math.min(30, 75 - off), 75);
      },
    });
    api.ihSync('c1');
    await flush();
    const list = $('ih-list');
    // 50px a row, a 400px box: the list grows as its rows come.
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => list.querySelectorAll('.ih-row').length * 50,
    });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 400 });
    api.ihToggle();
    await flush();
    const pages = () => calls.filter((u) => !u.includes('limit=0'));
    expect(pages()).toEqual(['/api/dashboard/session/c1/instructions?offset=0&limit=30&order=asc']);
    list.scrollTop = 1000; // 1400 of 1500: not within 80px of the end yet
    list.dispatchEvent(new dom.Event('scroll'));
    await flush();
    expect(pages()).toHaveLength(1);
    list.scrollTop = 1100; // within 80px of the end
    list.dispatchEvent(new dom.Event('scroll'));
    await flush();
    expect(pages()[1]).toBe('/api/dashboard/session/c1/instructions?offset=30&limit=30&order=asc');
    expect(document.querySelectorAll('#ih-list .ih-row')).toHaveLength(60);
    list.scrollTop = 0;
    ($('ih-foot').querySelector('[data-ih="more"]') as HTMLElement).click();
    await flush();
    expect(pages()[2]).toBe('/api/dashboard/session/c1/instructions?offset=60&limit=30&order=asc');
    expect(document.querySelectorAll('#ih-list .ih-row')).toHaveLength(75);
    expect($('ih-foot').querySelector('[data-ih="more"]')).toBeNull();
  });

  it('a count that fails is asked again (a blip does not lose the button)', async () => {
    vi.useFakeTimers();
    try {
      let fails = 2;
      const { api, calls } = boot({ fetch: () => (fails-- > 0 ? new Error('blip') : { total: 7 }) });
      api.ihSync('c1');
      await vi.advanceTimersByTimeAsync(10);
      expect($('ih-dock').hidden).toBe(true);
      await vi.advanceTimersByTimeAsync(2100);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5100);
      expect(calls).toHaveLength(3);
      expect($('ih-dock').hidden).toBe(false);
      expect($('ih-dock-n').textContent).toBe('7');
    } finally {
      vi.useRealTimers();
    }
  });

  it('최근부터: the newest first, kept for the next time', async () => {
    const { api, calls } = boot({
      fetch: (url) => (url.includes('limit=0') ? { total: 5 } : page(0, 5, 5, url.includes('desc') ? 'desc' : 'asc')),
    });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush();
    api.ihSetOrder('desc');
    await flush();
    expect(calls[calls.length - 1]).toBe('/api/dashboard/session/c1/instructions?offset=0&limit=30&order=desc');
    expect(document.querySelector('#ih-list .ih-n')?.textContent).toBe('#5');
    expect(document.querySelector('.ih-ord[data-order="desc"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('soma-ih-order')).toBe('desc');
  });

  it('a page that fails says why with 다시 시도; the retry asks again', async () => {
    let fail = true;
    const { api } = boot({
      fetch: (url) => (url.includes('limit=0') ? { total: 2 } : fail ? new Error('x') : page(0, 2, 2)),
    });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush();
    expect($('ih-foot').textContent).toContain('목록을 불러오지 못했어요');
    fail = false;
    ($('ih-foot').querySelector('[data-ih="retry"]') as HTMLElement).click();
    await flush();
    expect(document.querySelectorAll('#ih-list .ih-row')).toHaveLength(2);
  });

  it('Esc closes it and gives focus back to the button; a press outside closes it', async () => {
    const { api } = boot({ fetch: (url) => (url.includes('limit=0') ? { total: 1 } : page(0, 1, 1)) });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush();
    $('ih-pop').dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('ih-pop').hasAttribute('data-open')).toBe(false);
    expect(document.activeElement).toBe($('ih-dock'));
    api.ihToggle();
    $('outside').dispatchEvent(new dom.PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect($('ih-pop').hasAttribute('data-open')).toBe(false);
  });

  it('rows are HTML-safe; a turn that only invoked skills says so and names them', async () => {
    const { api } = boot({
      fetch: (url) =>
        url.includes('limit=0')
          ? { total: 2 }
          : {
              total: 2,
              nextOffset: null,
              items: [
                { id: 'a"1', n: 1, at: 1, text: '<img src=x onerror=alert(1)>' },
                { id: 'b', n: 2, at: 2, text: '', skills: ['local:z'], files: 2 },
              ],
            },
    });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush();
    expect(document.querySelector('#ih-list img')).toBeNull();
    expect(document.querySelector('#ih-list .ih-row')?.getAttribute('data-id')).toBe('a"1');
    const second = document.querySelectorAll('#ih-list .ih-row')[1];
    expect(second.querySelector('.ih-text')?.textContent).toBe('(스킬만 호출)');
    expect(second.querySelector('.ih-meta')?.textContent).toContain('$local:z');
    expect(second.querySelector('.ih-meta')?.textContent).toContain('파일 2개');
  });
});

describe('the open list and new instructions (review on #1512)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  // A server whose total can change between answers: desc pages answered against `total`.
  const server = (st: { total: number }) => (url: string) => {
    if (url.includes('limit=0')) return { total: st.total };
    const off = Number(/offset=(\d+)/.exec(url)?.[1]);
    const lim = Number(/limit=(\d+)/.exec(url)?.[1]);
    const order = url.includes('desc') ? 'desc' : 'asc';
    return page(off, Math.max(0, Math.min(lim, st.total - off)), st.total, order);
  };

  it('최근부터: a later page answered after a new instruction (before the count) still puts it on top', async () => {
    const st = { total: 40 };
    const { api, calls } = boot({ fetch: server(st) });
    store.set('soma-ih-order', 'desc');
    api.ihSetOrder('desc');
    api.ihSync('c1');
    await flush();
    // Open with only the first page in: the list's end is out of view (happy-dom lays nothing out — say so).
    const list = $('ih-list');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 400 });
    api.ihToggle();
    await flush();
    expect(document.querySelector('#ih-list .ih-n')?.textContent).toBe('#40');
    st.total = 41; // a person sends one more; the count has not been asked yet
    api.ihLoadMore(); // the reader scrolls: a page answered against 41
    await flush();
    expect(document.querySelector('#ih-list .ih-n')?.textContent).toBe('#41');
    expect($('ih-dock-n').textContent).toBe('41');
    const ids = Array.from(document.querySelectorAll('#ih-list .ih-row')).map((r: any) => r.getAttribute('data-id'));
    expect(new Set(ids).size).toBe(ids.length); // every row once
    // The count then lands with the same news: nothing is fetched twice for it.
    const before = calls.length;
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    expect(calls.length).toBe(before + 1); // the count alone
  });

  it('최근부터: the fetch for the new rows fails — the news is kept, and the next answer brings the rows', async () => {
    const st = { total: 40 };
    let failTop = true;
    const base = server(st);
    const { api } = boot({
      fetch: (url) => (failTop && url.includes('offset=0&limit=6&order=desc') ? new Error('blip') : base(url)),
    });
    api.ihSetOrder('desc');
    api.ihSync('c1');
    await flush();
    const list = $('ih-list');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 400 });
    api.ihToggle();
    await flush();
    st.total = 41;
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    expect(document.querySelector('#ih-list .ih-n')?.textContent).toBe('#40'); // the top fetch failed
    failTop = false;
    await wait(2100); // the count is asked again
    await flush();
    expect(document.querySelector('#ih-list .ih-n')?.textContent).toBe('#41');
  });

  it('처음부터: a last page answered against an older total does not close the list on the newer count (#41 comes)', async () => {
    let total = 40;
    let releasePage: (v: unknown) => void = () => {};
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('limit=0')) return Promise.resolve({ ok: true, json: async () => ({ total }) });
      const off = Number(/offset=(\d+)/.exec(url)?.[1]);
      if (off === 30)
        return new Promise((r) => {
          releasePage = r;
        });
      return Promise.resolve({ ok: true, json: async () => page(off, Math.max(0, Math.min(30, total - off)), total) });
    });
    const { api } = boot({ fns: { fetch: fetchMock } });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush(); // page 2 (offset 30) is on its way, held
    total = 41;
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    releasePage({ ok: true, json: async () => page(30, 10, 40) }); // answered before #41: nextOffset null
    await flush();
    const rows: any[] = Array.from(document.querySelectorAll('#ih-list .ih-row'));
    expect(rows).toHaveLength(41);
    expect(rows[40].querySelector('.ih-n')?.textContent).toBe('#41');
  });

  it('최근부터: a count that lands before the first page is caught up once that page lands', async () => {
    let total = 12;
    let releaseFirst: (v: unknown) => void = () => {};
    let firstHeld = true;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('limit=0')) return Promise.resolve({ ok: true, json: async () => ({ total }) });
      const off = Number(/offset=(\d+)/.exec(url)?.[1]);
      const lim = Number(/limit=(\d+)/.exec(url)?.[1]);
      if (off === 0 && lim === 30 && firstHeld) {
        firstHeld = false;
        return new Promise((r) => {
          releaseFirst = r;
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => page(off, Math.max(0, Math.min(lim, total - off)), total, 'desc'),
      });
    });
    const { api } = boot({ fns: { fetch: fetchMock } });
    api.ihSetOrder('desc');
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush(); // the first page is held
    total = 13;
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    releaseFirst({ ok: true, json: async () => page(0, 12, 12, 'desc') }); // answered against 12, nextOffset null
    await flush();
    const rows: any[] = Array.from(document.querySelectorAll('#ih-list .ih-row'));
    expect(rows[0].querySelector('.ih-n')?.textContent).toBe('#13');
    expect(rows).toHaveLength(13);
  });

  it('최근부터: more new instructions than one page holds read the list afresh; a count that drops does too', async () => {
    const st = { total: 40 };
    const { api, calls } = boot({ fetch: server(st) });
    api.ihSetOrder('desc');
    api.ihSync('c1');
    await flush();
    const list = $('ih-list');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 400 });
    api.ihToggle();
    await flush();
    const firsts = () => calls.filter((u) => u.includes('offset=0&limit=30&order=desc')).length;
    expect(firsts()).toBe(1);
    st.total = 200;
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    expect(firsts()).toBe(2);
    expect(document.querySelector('#ih-list .ih-n')?.textContent).toBe('#200');
    st.total = 199; // a rollback took one back
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    expect(firsts()).toBe(3);
    expect(document.querySelector('#ih-list .ih-n')?.textContent).toBe('#199');
  });

  it('a count asked before a page that raised the total cannot lower it (no spurious re-read of the list)', async () => {
    let releaseCount: (v: unknown) => void = () => {};
    let holdCount = false;
    const st = { total: 40 };
    const base = server(st);
    const asked: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      asked.push(url);
      if (url.includes('limit=0') && holdCount)
        return new Promise((r) => {
          releaseCount = r;
        });
      const r = base(url);
      return Promise.resolve({ ok: true, json: async () => r });
    });
    const { api } = boot({ fns: { fetch: fetchMock } });
    api.ihSetOrder('desc');
    api.ihSync('c1');
    await flush();
    const list = $('ih-list');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 400 });
    api.ihToggle();
    await flush();
    holdCount = true;
    api.ihSync('c1', true);
    await wait(700); // the count is asked (against 40) and held
    st.total = 41;
    api.ihLoadMore(); // a page answered against 41 raises the total and brings #41 on top
    await flush();
    const firsts = () => asked.filter((u) => u.includes('offset=0&limit=30&order=desc')).length;
    expect(firsts()).toBe(1);
    releaseCount({ ok: true, json: async () => ({ total: 40 }) }); // the older count lands late
    await flush();
    expect($('ih-dock-n').textContent).toBe('41');
    expect(firsts()).toBe(1); // no re-read
    expect(document.querySelector('#ih-list .ih-n')?.textContent).toBe('#41');
  });

  it('an old first page cannot undo a newer count that dropped (a rollback while it loaded)', async () => {
    let releaseFirst: (v: unknown) => void = () => {};
    let total = 12;
    const asked: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      asked.push(url);
      if (url.includes('limit=0')) return Promise.resolve({ ok: true, json: async () => ({ total }) });
      if (url.includes('offset=0&limit=30') && asked.filter((u) => u.includes('offset=0&limit=30')).length === 1)
        return new Promise((r) => {
          releaseFirst = r;
        });
      return Promise.resolve({ ok: true, json: async () => page(0, total, total) });
    });
    const { api } = boot({ fns: { fetch: fetchMock } });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush(); // the first page (asked against 12) is held
    total = 11; // a rollback takes one back; the count says so first
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    expect($('ih-dock-n').textContent).toBe('11');
    releaseFirst({ ok: true, json: async () => page(0, 12, 12) });
    await flush();
    expect($('ih-dock-n').textContent).toBe('11'); // the old page does not raise it back
  });

  it('a rollback that puts a new instruction in place of the newest (same total) re-reads the list', async () => {
    let lastId = 'u12';
    const st = { total: 12 };
    const base = server(st);
    const { api, calls } = boot({
      fetch: (url) => {
        const r = base(url) as Json;
        return { ...r, lastId };
      },
    });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush();
    const firsts = () => calls.filter((u) => u.includes('offset=0&limit=30')).length;
    expect(firsts()).toBe(1);
    lastId = 'u12b'; // u12 rolled back, a new one sent: still 12
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    expect(firsts()).toBe(2);
  });

  it('최근부터: more than the margin landing while the new rows load re-reads the list (no gap, the order kept)', async () => {
    const st = { total: 40 };
    let bumpOnGrow = true;
    const base = server(st);
    const { api, calls } = boot({
      fetch: (url) => {
        if (bumpOnGrow && url.includes('offset=0&limit=6&order=desc')) {
          bumpOnGrow = false;
          st.total = 60; // twenty more land while the top rows are on their way
        }
        return base(url);
      },
    });
    api.ihSetOrder('desc');
    api.ihSync('c1');
    await flush();
    const list = $('ih-list');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 400 });
    api.ihToggle();
    await flush();
    st.total = 41;
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    const ns = Array.from(document.querySelectorAll('#ih-list .ih-n')).map((n: any) => Number(n.textContent.slice(1)));
    expect(ns[0]).toBe(60);
    expect(ns.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => 60 - i)); // no gap, newest first
    expect(calls.filter((u) => u.includes('offset=0&limit=30&order=desc')).length).toBe(2);
  });

  it('a count ahead of a rollback does not make 처음부터 ask for pages forever', async () => {
    const serverTotal = 40;
    const { api, calls } = boot({
      fetch: (url) => {
        if (url.includes('limit=0')) return { total: 41 }; // the count is ahead of the record
        const off = Number(/offset=(\d+)/.exec(url)?.[1]);
        return page(off, Math.max(0, Math.min(30, serverTotal - off)), serverTotal);
      },
    });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush();
    await flush();
    const pages = calls.filter((u) => !u.includes('limit=0'));
    expect(pages.length).toBeLessThanOrEqual(3); // offset 0, 30 and one more ask for the 41st — then it stops
  });

  it('a slow page answered against an older total does not take the button’s newer count back', async () => {
    let releasePage: (v: unknown) => void = () => {};
    let total = 40;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('limit=0')) return Promise.resolve({ ok: true, json: async () => ({ total }) });
      if (url.includes('offset=0&limit=30')) return Promise.resolve({ ok: true, json: async () => page(0, 30, 40) });
      return new Promise((r) => {
        releasePage = r;
      });
    });
    const { api } = boot({ fns: { fetch: fetchMock } });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush(); // the second page is now on its way, held
    total = 41;
    api.ihSync('c1', true);
    await wait(700);
    await flush();
    expect($('ih-dock-n').textContent).toBe('41');
    releasePage({ ok: true, json: async () => page(30, 10, 40) });
    await flush();
    expect($('ih-dock-n').textContent).toBe('41');
  });
});

describe('a row — 대화 moves to that instruction', () => {
  const loaded = (ids: string[]) => ids.map((id, i) => ({ id, role: i % 2 ? 'assistant' : 'user', timestamp: i }));

  it('an instruction already in the chat: the chat tab and the main agent show, the turn goes to the top and is lit', async () => {
    const { api, calls, fns, vp, turnNode } = boot({
      state: { _psec: 'log', _panelAgent: 'sub-1', _panelTurnsList: loaded(['u7', 'a7', 'u8']) },
      fetch: (url) => (url.includes('limit=0') ? { total: 8 } : page(0, 8, 8)),
    });
    api.ihSync('c1');
    await flush();
    api.ihToggle();
    await flush();
    vp.scrollTop = 500;
    vi.spyOn(turnNode, 'getBoundingClientRect').mockReturnValue({ top: 300 } as DOMRect);
    vi.spyOn(vp, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    const before = calls.length;
    (document.querySelector('#ih-list .ih-row[data-id="u7"]') as HTMLElement).click();
    expect($('ih-pop').hasAttribute('data-open')).toBe(false);
    expect(fns.selectPanelAgent).toHaveBeenCalledWith('');
    expect(fns.selectPanelSection).toHaveBeenCalledWith('conv');
    await flush();
    expect(calls.length).toBe(before); // nothing to load
    expect(vp.scrollTop).toBe(500 + 300 - 100 - 12);
    expect((turnNode as any).animate).toHaveBeenCalled();
  });

  it('an older instruction: the turns back to it come in one answer (through), ahead of the ones held', async () => {
    const older = loaded(['u2', 'a2', 'u3', 'a3']);
    const { api, calls, fns } = boot({
      state: { _panelTurnsList: loaded(['u9', 'a9']), _panelTurnsOldestId: 'u9', _panelTurnsHasMore: true },
      fetch: (url) => {
        if (url.includes('limit=0')) return { total: 9 };
        if (url.includes('through=')) return { id: 'c1', turns: older, hasMore: true };
        return page(0, 9, 9);
      },
    });
    api.ihSync('c1');
    await flush();
    api.ihJump('u2');
    await flush();
    expect(calls).toContain('/api/dashboard/session/c1?limit=20&before=u9&through=u2');
    const st = api.state();
    expect(st.list.map((t: Json) => t.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u9', 'a9']);
    expect(st.oldest).toBe('u2');
    expect(st.hasMore).toBe(true);
    expect(st.loading).toBe(false);
    expect(fns.dashToast).not.toHaveBeenCalled();
  });

  it('a long way back: the route says capped — the page asks again until the turns reach it', async () => {
    const asks: string[] = [];
    const { api, fns } = boot({
      state: { _panelTurnsList: loaded(['u90', 'a90']), _panelTurnsOldestId: 'u90', _panelTurnsHasMore: true },
      fetch: (url) => {
        if (!url.includes('through=')) return { total: 1 };
        asks.push(url);
        const chunks = [
          ['u70', 'a70'],
          ['u50', 'a50'],
          ['u30', 'a30'],
        ];
        return asks.length <= 3
          ? { id: 'c1', turns: loaded(chunks[asks.length - 1]), hasMore: true, through: 'capped' }
          : { id: 'c1', turns: loaded(['u1', 'a1']), hasMore: false, through: 'reached' };
      },
    });
    api.ihJump('u1');
    await flush();
    await flush();
    await flush();
    // Four asks — past the three the first version stopped at.
    expect(asks).toEqual([
      '/api/dashboard/session/c1?limit=20&before=u90&through=u1',
      '/api/dashboard/session/c1?limit=20&before=u70&through=u1',
      '/api/dashboard/session/c1?limit=20&before=u50&through=u1',
      '/api/dashboard/session/c1?limit=20&before=u30&through=u1',
    ]);
    expect(api.state().list.map((t: Json) => t.id)).toEqual([
      'u1',
      'a1',
      'u30',
      'a30',
      'u50',
      'a50',
      'u70',
      'a70',
      'u90',
      'a90',
    ]);
    expect(fns.dashToast).not.toHaveBeenCalled();
  });

  it('the route says none twice (behind the turns held, then in the latest window): the warning, the chat repainted', async () => {
    const asks: string[] = [];
    const { api, fns } = boot({
      state: { _panelTurnsList: loaded(['u9']), _panelTurnsOldestId: 'u9', _panelTurnsHasMore: true },
      fetch: (url) => {
        if (!url.includes('through=')) return { total: 1 };
        asks.push(url);
        return { id: 'c1', turns: loaded(['u7', 'a7']), hasMore: true, through: 'none' };
      },
    });
    const paintedWhileLoading: boolean[] = [];
    fns.convPaint.mockImplementation(() => paintedWhileLoading.push(api.state().loading));
    api.ihJump('u99');
    await flush();
    await flush();
    expect(asks).toEqual([
      '/api/dashboard/session/c1?limit=20&before=u9&through=u99',
      '/api/dashboard/session/c1?limit=20&through=u99',
    ]);
    expect(fns.dashToast).toHaveBeenCalledWith({ title: '그 지시를 대화에서 찾지 못했어요', tone: 'warning' });
    // The last paint comes after the load ended: no "loading older" line is left behind.
    expect(paintedWhileLoading[paintedWhileLoading.length - 1]).toBe(false);
  });

  it('no page yet (the first one failed): the chat says loading while the jump loads — no 다시 시도 to race it', async () => {
    let release: (v: unknown) => void = () => {};
    const { api } = boot({
      state: { _panelTurnsMsg: 'failed', _panelTurnsWhy: 'HTTP 500' },
      fns: {
        fetch: vi.fn((url: string) =>
          url.includes('through=')
            ? new Promise((r) => {
                release = r;
              })
            : Promise.resolve({ ok: true, json: async () => ({ total: 1 }) }),
        ),
      },
    });
    api.ihJump('u1');
    await flush();
    const mid = api.state();
    expect(mid.loading).toBe(true);
    expect(api.msg()).toEqual({ msg: 'loading', why: '' });
    release({ ok: false, status: 500, json: async () => ({}) });
    await flush();
    expect(api.msg()).toEqual({ msg: 'failed', why: 'HTTP 500' });
    expect(api.state().loading).toBe(false);
  });

  it('the chat’s copy is behind the record (a missed push): the latest window back to the turn takes its place', async () => {
    const asks: string[] = [];
    const pending = { id: 'opt-1', role: 'user', timestamp: 99, rawContent: '보내는 중', _optimistic: true };
    const { api, fns } = boot({
      state: {
        _panelTurnsList: [...loaded(['u5', 'a5']), pending],
        _panelTurnsOldestId: 'u5',
        _panelTurnsHasMore: true,
      },
      fetch: (url) => {
        if (!url.includes('through=')) return { total: 1 };
        asks.push(url);
        return url.includes('before=')
          ? { id: 'c1', turns: loaded(['u4', 'a4']), hasMore: true, through: 'none' }
          : { id: 'c1', turns: loaded(['u5', 'a5', 'u6', 'a6', 'u7']), hasMore: true, through: 'reached' };
      },
    });
    api.ihJump('u7');
    await flush();
    await flush();
    expect(asks).toEqual([
      '/api/dashboard/session/c1?limit=20&before=u5&through=u7',
      '/api/dashboard/session/c1?limit=20&through=u7',
    ]);
    const st = api.state();
    expect(st.list.map((t: Json) => t.id)).toEqual(['u5', 'a5', 'u6', 'a6', 'u7', 'opt-1']);
    expect(st.oldest).toBe('u5');
    expect(fns.dashToast).not.toHaveBeenCalled();
  });

  it('a fresh window keeps the turns pushed while it was on its way', async () => {
    let releaseFresh: (v: unknown) => void = () => {};
    const { api } = boot({
      state: { _panelTurnsList: loaded(['u5', 'a5']), _panelTurnsOldestId: 'u5', _panelTurnsHasMore: true },
      fns: {
        fetch: vi.fn((url: string) => {
          if (!url.includes('through=')) return Promise.resolve({ ok: true, json: async () => ({ total: 1 }) });
          if (url.includes('before='))
            return Promise.resolve({
              ok: true,
              json: async () => ({ id: 'c1', turns: [], hasMore: false, through: 'none' }),
            });
          return new Promise((r) => {
            releaseFresh = r;
          });
        }),
      },
    });
    api.ihJump('u7');
    await flush(); // the fresh ask is on its way
    api.state().list.push({ id: 'u8', role: 'user', timestamp: 100, rawContent: '방금 온 지시' }); // a push lands
    releaseFresh({
      ok: true,
      json: async () => ({
        id: 'c1',
        turns: loaded(['u5', 'a5', 'u6', 'a6', 'u7']),
        hasMore: true,
        through: 'reached',
      }),
    });
    await flush();
    expect(api.state().list.map((t: Json) => t.id)).toEqual(['u5', 'a5', 'u6', 'a6', 'u7', 'u8']);
  });

  it('an older jump that fails after a newer one started says nothing', async () => {
    let releaseA: (v: unknown) => void = () => {};
    const { api, fns } = boot({
      state: { _panelTurnsList: loaded(['u9', 'a9']), _panelTurnsOldestId: 'u9', _panelTurnsHasMore: true },
      fns: {
        fetch: vi.fn((url: string) =>
          url.includes('through=u1')
            ? new Promise((r) => {
                releaseA = r;
              })
            : Promise.resolve({ ok: true, json: async () => ({ total: 1 }) }),
        ),
      },
    });
    api.ihJump('u1'); // A: loading older turns, held
    await flush();
    api.ihJump('u9'); // B: already in the chat — waits for A's load to settle, then goes
    releaseA({ ok: false, status: 500, json: async () => ({}) });
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    expect(fns.dashToast).not.toHaveBeenCalled();
  });

  it('a jump load that never answers is given up after its deadline: a warning, the chat not left loading', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const aborted: string[] = [];
    const { api, fns } = boot({
      state: { _panelTurnsList: loaded(['u9']), _panelTurnsOldestId: 'u9', _panelTurnsHasMore: true },
      fns: {
        fetch: vi.fn((url: string, init?: { signal?: AbortSignal }) => {
          if (!url.includes('through=')) return Promise.resolve({ ok: true, json: async () => ({ total: 1 }) });
          return new Promise((_r, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted.push(url);
              reject(new Error('aborted'));
            });
          });
        }),
      },
    });
    api.ihJump('u1');
    await flush();
    expect(api.state().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(20_100);
    await flush();
    expect(aborted).toHaveLength(1);
    expect(api.state().loading).toBe(false);
    expect(fns.dashToast).toHaveBeenCalledWith({ title: '대화를 불러오지 못했어요', tone: 'warning' });
  });

  it('a card switch while the jump’s turn is being drawn stops the scroll and says nothing', async () => {
    const { api, fns, vp, conv } = boot({
      state: { _panelTurnsList: loaded(['u7', 'a7']) },
      fetch: () => ({ total: 1 }),
    });
    conv.turnElement.mockImplementation(() => null); // not drawn yet
    vp.scrollTop = 300;
    api.ihJump('u7');
    api.set('_panelGen', 2); // another card opens
    await new Promise((r) => setTimeout(r, 300));
    expect(vp.scrollTop).toBe(300);
    expect(fns.dashToast).not.toHaveBeenCalled();
  });

  it('a newer jump took over: the older one’s fresh window does not replace the chat', async () => {
    let releaseFresh: (v: unknown) => void = () => {};
    const { api } = boot({
      state: { _panelTurnsList: loaded(['u5', 'a5']), _panelTurnsOldestId: 'u5', _panelTurnsHasMore: true },
      fns: {
        fetch: vi.fn((url: string) => {
          if (!url.includes('through=')) return Promise.resolve({ ok: true, json: async () => ({ total: 1 }) });
          if (url.includes('before='))
            return Promise.resolve({
              ok: true,
              json: async () => ({ id: 'c1', turns: [], hasMore: true, through: 'none' }),
            });
          return new Promise((r) => {
            releaseFresh = r;
          });
        }),
      },
    });
    api.ihJump('u7');
    await flush(); // the fresh ask is on its way
    api.ihJump('u5'); // a newer jump, to a turn the chat has (it waits for the load)
    releaseFresh({
      ok: true,
      json: async () => ({ id: 'c1', turns: loaded(['u6', 'a6', 'u7']), hasMore: true, through: 'reached' }),
    });
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    expect(api.state().list.map((t: Json) => t.id)).toEqual(['u5', 'a5']);
  });

  it('a load on its way (the first page) settles first, then the jump goes on', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { api, calls } = boot({
      state: { _panelTurnsLoading: true },
      fetch: (url) =>
        url.includes('through=') ? { id: 'c1', turns: loaded(['u1', 'a1']), hasMore: false } : { total: 1 },
    });
    api.ihJump('u1');
    await flush();
    expect(calls.some((u) => u.includes('through='))).toBe(false);
    api.set('_panelTurnsLoading', false);
    await wait(150);
    await flush();
    expect(calls).toContain('/api/dashboard/session/c1?limit=20&through=u1');
    expect(api.state().list.map((t: Json) => t.id)).toEqual(['u1', 'a1']);
  });

  it('an instruction the chat does not have (or a load that fails): a warning, nothing moves', async () => {
    const a = boot({
      state: { _panelTurnsList: loaded(['u9']), _panelTurnsOldestId: 'u9', _panelTurnsHasMore: true },
      fetch: (url) => (url.includes('through=') ? { id: 'c1', turns: loaded(['u5']), hasMore: false } : { total: 1 }),
    });
    a.api.ihJump('gone');
    await flush();
    expect(a.fns.dashToast).toHaveBeenCalledWith({ title: '그 지시를 대화에서 찾지 못했어요', tone: 'warning' });
    const b = boot({
      state: { _panelTurnsList: loaded(['u9']), _panelTurnsOldestId: 'u9', _panelTurnsHasMore: true },
      fetch: (url) => (url.includes('through=') ? new Error('500') : { total: 1 }),
    });
    b.api.ihJump('u1');
    await flush();
    expect(b.fns.dashToast).toHaveBeenCalledWith({ title: '대화를 불러오지 못했어요', tone: 'warning' });
    expect(b.api.state().loading).toBe(false);
  });

  it('a card switched while the turns load: the old answer is dropped', async () => {
    let release: (v: unknown) => void = () => {};
    const { api } = boot({
      state: { _panelTurnsList: loaded(['u9']), _panelTurnsOldestId: 'u9', _panelTurnsHasMore: true },
      fns: {
        fetch: vi.fn(
          () =>
            new Promise((r) => {
              release = r;
            }),
        ),
      },
    });
    api.ihJump('u1');
    await flush();
    api.set('_panelGen', 2);
    api.set('_panelTurnsList', []);
    release({ ok: true, json: async () => ({ turns: loaded(['u1']), hasMore: false }) });
    await flush();
    expect(api.state().list).toEqual([]);
  });
});

describe('the page carries it', () => {
  it('the markup sits in the composer’s wrapper, before <ui-agent-steering>, closed and empty', () => {
    expect(MARKUP).toContain('id="ih-dock"');
    expect(MARKUP).toContain('onclick="ihToggle()"');
    expect(MARKUP).toContain('id="ih-list"');
    expect(MARKUP).toMatch(/<button type="button" class="ih-dock" id="ih-dock" hidden/);
    expect(DASHBOARD_TS).toContain('${INSTRUCTION_HISTORY_CLIENT_JS}');
    expect(DASHBOARD_TS).toContain('${INSTRUCTION_HISTORY_CSS}');
  });

  it('the card tells it when it opens, closes, loads its turns and when a person’s turn lands', () => {
    expect(pageFn('openPanel')).toContain("if (typeof ihSync === 'function') ihSync(s.conversationId || '');");
    expect(pageFn('closePanel')).toContain("if (typeof ihSync === 'function') ihSync('');");
    expect(pageFn('loadPanelTurns')).toContain("if (typeof ihSync === 'function') ihSync(_panelTurnsCid);");
    expect(pageFn('onConversationTurn')).toContain(
      "if (turn.role === 'user' && typeof ihSync === 'function') ihSync(cid, true);",
    );
  });

  it('every Korean string of its markup and its script has its English in the page catalog', () => {
    const missing = scanPage(`${MARKUP}\n<script>\n${INSTRUCTION_HISTORY_CLIENT_JS}\n</script>`)
      .filter((seg) => !seg.skip && pageText(seg.key) === undefined)
      .map((seg) => seg.key);
    expect(missing).toEqual([]);
  });

  it('the script is plain ES5 with no template syntax (it reaches the browser byte for byte)', () => {
    expect(INSTRUCTION_HISTORY_CLIENT_JS).not.toContain('`');
    expect(INSTRUCTION_HISTORY_CLIENT_JS).not.toContain('${');
    expect(INSTRUCTION_HISTORY_CSS).not.toContain('`');
    expect(INSTRUCTION_HISTORY_CSS).not.toContain('${');
    expect(INSTRUCTION_HISTORY_CLIENT_JS).not.toMatch(/=>|\blet |\bconst /);
  });
});
