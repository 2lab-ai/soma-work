// @vitest-environment happy-dom
/**
 * 보낸 지시 (SSOT 2026-11-27) — the client half: the round button with the count beside the follow-up queue's, the
 * list it opens (a page at a time, 처음부터 · 최근부터), and a row moving 대화 to its instruction. Executes the shipped
 * client code (instruction-history-client.ts) against the page's markup, with the page's panel state injected.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageText, registerPageCatalog, scanPage } from '@soma/common/i18n-page';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function boot(
  opts: { state?: Json; fetch?: Record<string, Reply> | ((url: string) => Json | Error); fns?: Json } = {},
) {
  document.body.innerHTML = `<div class="panel-command">${MARKUP}</div><div id="outside"></div>`;
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
  state: function() { return { ih: _ih, list: _panelTurnsList, oldest: _panelTurnsOldestId, hasMore: _panelTurnsHasMore,
    loading: _panelTurnsLoading, psec: _psec }; },
};`;
  const values = names.map((n) => (n in state ? state[n] : n === 'adminFmt' ? adminFmt : fns[n]));
  const api = new Function(...names, body)(...values) as any;
  return { api, calls, fns: fns as any, vp, turnNode, conv };
}
const flush = async (ms = 10) => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, ms));
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
      const { api, calls } = boot({ fetch: (url) => (url.includes('/c2/') ? { total: 99 } : { total }) });
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
      // A switch while a count is on its way: the old card's answer does not paint the new card's button.
      api.ihSync('c2');
      api.ihSync('c3');
      await vi.advanceTimersByTimeAsync(10);
      expect($('ih-dock-n').textContent).not.toBe('99');
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

  it('a load on its way (the first page) settles first, then the jump goes on', async () => {
    const { api, calls } = boot({
      state: { _panelTurnsLoading: true },
      fetch: (url) =>
        url.includes('through=') ? { id: 'c1', turns: loaded(['u1', 'a1']), hasMore: false } : { total: 1 },
    });
    api.ihJump('u1');
    await flush();
    expect(calls.some((u) => u.includes('through='))).toBe(false);
    api.set('_panelTurnsLoading', false);
    await new Promise((r) => setTimeout(r, 150));
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
