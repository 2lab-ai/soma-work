/**
 * M-07 / M-08 — the conversation viewer pages as a host of @2lab.ai/ui: <ui-app-bar> on top, the list as kit
 * `.ui-row` links with <ui-elapsed>, the open conversation in <ui-conversation> (its data in a JSON block, media
 * and raw-output buttons in its slots), and the page's own two features the library does not cover (G5-1 export
 * selection, G5-2 lazy raw load) — run here from the shipped client scripts with a stubbed DOM / fetch.
 */

import { describe, expect, it, vi } from 'vitest';
import { UI_LIB_VERSION } from '../ui-lib';
import {
  renderConversationListPage,
  renderConversationViewPage,
  VIEWER_CLIENT_JS,
  VIEWER_CSS,
  VIEWER_SHELL_JS,
  viewerTurns,
} from '../viewer';

const NOW = 1793400000000;

const metas = [
  {
    id: 'c1',
    ownerId: 'U1',
    ownerName: 'Zhuge Hyuk',
    title: 'Release notes for 2.4',
    workflow: 'default',
    turnCount: 4,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 18 * 60_000,
  },
  {
    id: 'c 2/<x>',
    ownerId: 'U2',
    ownerName: 'Mina <b>Park</b>',
    titleSub: 'Flaky sign-in test',
    workflow: 'pr-review',
    turnCount: 2,
    createdAt: NOW - 26 * 3_600_000,
    updatedAt: NOW - 3 * 3_600_000,
  },
  { id: 'c3', ownerId: 'U3', ownerName: 'Ada Kim', title: '', turnCount: 0, createdAt: 1, updatedAt: 2 },
] as any[];

const record = {
  id: 'c1',
  channelId: 'C1',
  threadTs: 't1',
  ownerId: 'U1',
  ownerName: 'Zhuge Hyuk',
  title: 'Release <notes> for 2.4',
  workflow: 'default',
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 18 * 60_000,
  turns: [
    {
      id: 't1',
      role: 'user',
      timestamp: NOW - 3_500_000,
      userName: 'Zhuge Hyuk',
      rawContent: 'Write the release notes.\nGroup by area.',
      attachments: [{ id: 'm1', name: 'changelog.txt', kind: 'text', size: 2048, stored: true }],
    },
    {
      id: 't2',
      role: 'assistant',
      timestamp: NOW - 3_300_000,
      rawContent: '',
      summarized: true,
      summaryTitle: 'Drafted the 2.4 notes',
      summaryBody: 'Grouped 31 PRs into 5 areas.',
    },
    { id: 't3', role: 'user', timestamp: NOW - 1_200_000, userName: 'Zhuge Hyuk', rawContent: 'Shorter, please.' },
    { id: 't4', role: 'assistant', timestamp: NOW - 18 * 60_000, rawContent: '', summarized: false },
    { id: 't5', role: 'assistant', timestamp: NOW - 17 * 60_000, rawContent: '', summarized: true },
  ],
} as any;

function pageData(html: string): { id: string; turns: Array<Record<string, unknown>> } {
  const m = /<script type="application\/json" id="conv-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no conv-data block');
  return JSON.parse(m[1]);
}

/** One top-level function of a shipped client script, by name. */
function clientFn(src: string, name: string): string {
  const plain = src.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : src.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start + 1, end + 2);
}
function load<T>(src: string, fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${fns.map((f) => clientFn(src, f)).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

describe('viewer pages — the shell (M-07)', () => {
  it('both pages: tokens and kit inlined, <ui-app-bar> on top, app-bar.js and elapsed.js from /dashboard/ui, no palette of their own', () => {
    for (const html of [renderConversationListPage(metas), renderConversationViewPage(record, metas)]) {
      expect(html).toContain('<html lang="ko">');
      expect(html).toContain('<style id="ui-tokens">');
      expect(html).toContain('<style id="ui-kit">');
      expect(html).toContain('<header class="vw-top"><ui-app-bar id="app-bar" lang="ko"></ui-app-bar></header>');
      expect(html).toContain(`<script type="module" src="/dashboard/ui/app-bar.js?v=${UI_LIB_VERSION}"></script>`);
      expect(html).toContain(`<script type="module" src="/dashboard/ui/elapsed.js?v=${UI_LIB_VERSION}"></script>`);
      expect(html).toContain("localStorage.getItem('soma-theme')"); // the dashboard's theme, before paint
    }
    expect(VIEWER_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(VIEWER_CSS).not.toMatch(/\brgba?\(/);
    expect(VIEWER_CSS).toContain('var(--ui-bg)');
  });

  it('the client scripts ship byte for byte: they parse, and hold no template syntax', () => {
    for (const src of [VIEWER_SHELL_JS, VIEWER_CLIENT_JS]) {
      expect(() => new Function(src)).not.toThrow();
      expect(src).not.toContain('`');
      expect(src).not.toContain('${');
    }
  });

  it('the app bar is the same nav as the settings page with 대화 current, the theme from <html>, the account once /auth/me answers', () => {
    const attrs: Record<string, string> = { 'data-theme': 'light' };
    const html = {
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => (attrs[k] = v),
    };
    const bar: Record<string, unknown> = {};
    const stored: Record<string, string> = {};
    const api = load<{ paintAppBar: () => void; setTheme: (t: string) => void; currentTheme: () => string }>(
      VIEWER_SHELL_JS,
      ['currentTheme', 'paintAppBar', 'setTheme'],
      {
        document: { documentElement: html, getElementById: (id: string) => (id === 'app-bar' ? bar : null) },
        localStorage: { setItem: (k: string, v: string) => (stored[k] = v) },
        APP_BAR_NAV: [
          { id: 'dashboard', label: '대시보드', href: '/dashboard', icon: 'board' },
          { id: 'conversations', label: '대화', href: '/conversations', icon: 'chat', current: true },
          { id: 'settings', label: '설정', href: '/dashboard/settings', icon: 'gear' },
        ],
        _appBarAccount: { name: 'Zhuge Hyuk', href: '/login', role: '관리자' },
      },
    );
    api.paintAppBar();
    const data = bar.data as Record<string, any>;
    expect(data.brand).toEqual({ label: 'soma-work', mark: true, href: '/dashboard' });
    expect(data.nav.map((l: any) => [l.id, l.href, !!l.current])).toEqual([
      ['dashboard', '/dashboard', false],
      ['conversations', '/conversations', true],
      ['settings', '/dashboard/settings', false],
    ]);
    expect(data.theme).toBe('light');
    expect(data.account).toEqual({ name: 'Zhuge Hyuk', href: '/login', role: '관리자' });
    api.setTheme('dark');
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(stored['soma-theme']).toBe('dark');
    expect((bar.data as any).theme).toBe('dark');
    expect(VIEWER_SHELL_JS).toContain("'ui-theme-change'");
    expect(VIEWER_SHELL_JS).toContain(
      "{ id: 'conversations', label: '대화', href: '/conversations', icon: 'chat', current: true }",
    );
  });
});

describe('conversation list (M-07)', () => {
  const html = renderConversationListPage(metas);

  it('one .ui-row link per conversation: glyph, title, owner · workflow · turns, and a <ui-elapsed format="ago"> with the time in words under it', () => {
    expect(html).toContain('<body data-view="list">');
    expect(html).toContain('<nav class="vw-side" aria-label="대화 목록">');
    expect(html).toContain('<h2>대화 <small>3</small></h2>');
    const row = html.slice(
      html.indexOf('<a class="ui-row" href="/conversations/c1"'),
      html.indexOf('</a>', html.indexOf('href="/conversations/c1"')),
    );
    expect(row).toContain('data-icon="chat"');
    expect(row).toContain('<strong>Release notes for 2.4</strong>');
    expect(row).toContain('Zhuge Hyuk · default · 4턴 · ');
    expect(row).toMatch(/<ui-elapsed since="\d+" format="ago" lang="ko">[^<]+<\/ui-elapsed>/);
    expect(row).toContain(`since="${NOW - 18 * 60_000}"`);
    expect(html).not.toContain('<table');
    expect(html).not.toContain('onclick="window.location');
  });

  it('escapes the id in the href and the owner in the row; a conversation without a title shows its sub-title, then 제목 없음', () => {
    expect(html).toContain('href="/conversations/c%202%2F%3Cx%3E"');
    expect(html).toContain('Mina &lt;b&gt;Park&lt;/b&gt;');
    expect(html).not.toContain('<b>Park</b>');
    expect(html).toContain('<strong>Flaky sign-in test</strong>');
    expect(html).toContain('<strong>(제목 없음)</strong>');
    expect(html).toContain('Ada Kim · default · 0턴');
  });

  it('with no conversations: a kit empty state, no list', () => {
    const empty = renderConversationListPage([]);
    expect(empty).toContain('<p class="ui-empty">');
    expect(empty).toContain('아직 기록된 대화가 없습니다');
    expect(empty).toContain('<h2>대화 <small>0</small></h2>');
    expect(empty).not.toContain('<ul>');
    // and the main pane asks to pick one
    expect(html).toContain('<strong>대화를 고르세요</strong>');
  });
});

describe('one conversation (M-08)', () => {
  const html = renderConversationViewPage(record, metas);
  const data = pageData(html);

  it('is <ui-conversation lang="ko"> with conversation.js and dialog.js, the list beside it with the open one current', () => {
    expect(html).toContain('<body data-view="detail">');
    expect(html).toContain('<ui-conversation id="conv" lang="ko">');
    expect(html).toContain(`<script type="module" src="/dashboard/ui/conversation.js?v=${UI_LIB_VERSION}"></script>`);
    expect(html).toContain(`<script type="module" src="/dashboard/ui/dialog.js?v=${UI_LIB_VERSION}"></script>`);
    expect(html).toContain('<a class="ui-row" href="/conversations/c1" aria-current="page">');
    expect(html).not.toContain('href="/conversations/c3" aria-current');
    expect(html).toContain('<a class="ui-icon-btn vw-back" href="/conversations" aria-label="모든 대화">');
    expect(html).toContain('<h1>Release &lt;notes&gt; for 2.4</h1>');
    expect(html).toContain('<title>Release &lt;notes&gt; for 2.4 — soma-work</title>');
    expect(html).toContain('Zhuge Hyuk · <code>default</code> · 5턴 · <time datetime="');
    expect(html).toContain('<noscript><p class="ui-notice">');
  });

  it('alone (no list): the page is the conversation with its back link, and no side nav', () => {
    const solo = renderConversationViewPage(record);
    expect(solo).toContain('<body data-view="detail" class="vw-solo">');
    expect(solo).not.toContain('<nav class="vw-side"');
    expect(solo).toContain('href="/conversations" aria-label="모든 대화"');
    expect(html).not.toContain('class="vw-solo"');
  });

  it("the element's data is a JSON block (viewerTurns): user turns with text and media, answers with their summary state and response time", () => {
    expect(data.id).toBe('c1');
    expect(data.turns).toEqual(viewerTurns(record.turns));
    expect(data.turns[0]).toEqual({
      id: 't1',
      role: 'user',
      name: 'Zhuge Hyuk',
      at: NOW - 3_500_000,
      text: 'Write the release notes.\nGroup by area.',
      media: true,
    });
    expect(data.turns[1]).toEqual({
      id: 't2',
      role: 'assistant',
      at: NOW - 3_300_000,
      summary: { title: 'Drafted the 2.4 notes', text: 'Grouped 31 PRs into 5 areas.' },
      summaryState: 'done',
      responseMs: 200_000,
    });
    expect(data.turns[3]).toEqual({
      id: 't4',
      role: 'assistant',
      at: NOW - 18 * 60_000,
      summaryState: 'pending',
      responseMs: 120_000,
    });
    expect(data.turns[4]).toEqual({ id: 't5', role: 'assistant', at: NOW - 17 * 60_000, summaryState: 'failed' }); // after an answer: no response time
    expect(data.turns.some((t) => 'rawContent' in t || 'summaryTitle' in t)).toBe(false);
  });

  it('the JSON block cannot be closed early by a turn text', () => {
    const evil = renderConversationViewPage({
      ...record,
      turns: [{ id: 'x', role: 'user', timestamp: 1, userName: 'a', rawContent: '</script><script>alert(1)</script>' }],
    });
    const block = /<script type="application\/json" id="conv-data">([\s\S]*?)<\/script>/.exec(evil)![1];
    expect(block).not.toContain('</script');
    expect(JSON.parse(block).turns[0].text).toBe('</script><script>alert(1)</script>');
  });

  it('every answer has a raw-output button in its attachments-<id> slot (a summarised one says the summary stands in); user media sits in media-<id>', () => {
    expect(html).toContain('<div slot="media-t1" class="vw-media">');
    const t2 = html.slice(
      html.indexOf('<div slot="attachments-t2" class="vw-raw">'),
      html.indexOf('<div slot="media-', html.indexOf('slot="attachments-t2"') + 1),
    );
    expect(t2).toContain('<p class="vw-raw-note">위 내용은 요약입니다.</p>');
    expect(t2).toContain('<button type="button" class="ui-btn is-sm is-quiet" data-raw="t2">');
    expect(t2).toContain('원본 응답 보기');
    const t4 = html.slice(
      html.indexOf('<div slot="attachments-t4" class="vw-raw">'),
      html.indexOf('slot="attachments-t5"'),
    );
    expect(t4).not.toContain('vw-raw-note');
    expect(t4).toContain('data-raw="t4"');
    expect(html).not.toContain('<details class="raw-details"');
  });

  it('export (G5-1): a <ui-dialog> with every turn checked, opened by the 내보내기 button; no turns → the button is disabled', () => {
    expect(html).toContain('<button type="button" class="ui-btn is-sm" id="export-open" onclick="openExport()">');
    expect(html).toContain('<ui-dialog id="export-dialog" heading="Markdown으로 내보내기" size="md" lang="ko">');
    expect(html.match(/class="turn-checkbox" data-turn-id="t\d" checked/g)).toHaveLength(5);
    expect(html).toContain('<span id="selectedCount" role="status">5개 선택</span>');
    expect(html).toContain('<strong>Zhuge Hyuk · 사용자</strong>');
    expect(html).toContain('<span class="vw-x-ex">Write the release notes.</span>');
    expect(html).toContain('<span class="vw-x-ex">Drafted the 2.4 notes</span>');
    expect(html).toContain('<span class="vw-x-ex">요약 전</span>');
    expect(html).toContain('<span class="vw-x-ex">요약 없음</span>');
    expect(html).toContain('<div slot="footer" class="vw-x-foot">');
    expect(html).toContain('<p class="ui-notice" data-tone="fail" id="export-error" role="alert" hidden></p>');
    const none = renderConversationViewPage({ ...record, turns: [] });
    expect(none).toContain('id="export-open" onclick="openExport()" disabled>');
    expect(none).toContain('<span id="selectedCount" role="status">0개 선택</span>');
  });
});

describe('viewerTurns', () => {
  it('a user turn: name (사용자 without one), time, text; an answer: summary → done, summarised without a title → failed, else pending', () => {
    expect(viewerTurns([{ id: 'a', role: 'user', timestamp: 5, rawContent: 'x' } as any])).toEqual([
      { id: 'a', role: 'user', name: '사용자', at: 5, text: 'x' },
    ]);
    const [done, failed, pending] = viewerTurns([
      { id: 'b', role: 'assistant', timestamp: 5, summarized: true, summaryTitle: 'T' },
      { id: 'c', role: 'assistant', timestamp: 6, summarized: true },
      { id: 'd', role: 'assistant', timestamp: 7 },
    ] as any);
    expect(done).toEqual({
      id: 'b',
      role: 'assistant',
      at: 5,
      summary: { title: 'T', text: '' },
      summaryState: 'done',
    });
    expect(failed.summaryState).toBe('failed');
    expect(pending.summaryState).toBe('pending');
  });

  it('the response time is the gap to the instruction right before, only when it is earlier', () => {
    const turns = viewerTurns([
      { id: 'u', role: 'user', timestamp: 100, rawContent: 'q' },
      { id: 'a', role: 'assistant', timestamp: 100 },
      { id: 'u2', role: 'user', timestamp: 300, rawContent: 'q' },
      { id: 'a2', role: 'assistant', timestamp: 1300 },
    ] as any);
    expect(turns[1]).not.toHaveProperty('responseMs');
    expect(turns[3].responseMs).toBe(1000);
  });
});

describe('client: what <ui-conversation> is shown (viewTurn)', () => {
  const { viewTurn } = load<{ viewTurn: (t: any) => any }>(VIEWER_CLIENT_JS, ['viewTurn']);

  it('a user turn passes through', () => {
    const t = { id: 'u', role: 'user', name: 'Z', at: 1, text: 'hi', media: true };
    expect(viewTurn(t)).toBe(t);
  });

  it('an answer not loaded yet shows its summary as the answer (bold title, text), no Raw source, and the slot button', () => {
    expect(
      viewTurn({
        id: 'a',
        role: 'assistant',
        at: 1,
        responseMs: 90,
        summary: { title: ' T ', text: 'body' },
        summaryState: 'done',
      }),
    ).toEqual({
      id: 'a',
      role: 'assistant',
      at: 1,
      responseMs: 90,
      markdown: '**T**\n\nbody',
      source: '',
      attachments: true,
    });
    expect(viewTurn({ id: 'a', role: 'assistant', at: 1, summaryState: 'failed' }).markdown).toBe(
      '_요약하지 못했습니다._',
    );
    expect(viewTurn({ id: 'a', role: 'assistant', at: 1, summaryState: 'pending' }).markdown).toBe(
      '_요약을 만드는 중입니다._',
    );
  });

  it('while it loads: loading; after a failure: the error with Try again', () => {
    expect(viewTurn({ id: 'a', role: 'assistant', at: 1, summaryState: 'pending', loading: true })).toMatchObject({
      loading: true,
      attachments: true,
    });
    expect(viewTurn({ id: 'a', role: 'assistant', at: 1, summaryState: 'pending', error: 'HTTP 404' })).toMatchObject({
      error: 'HTTP 404',
      canRetry: true,
    });
  });

  it('a loaded answer: the raw output as the answer, the summary in Raw, and no slot', () => {
    const v = viewTurn({
      id: 'a',
      role: 'assistant',
      at: 1,
      summary: { title: 'T' },
      summaryState: 'done',
      markdown: '# Raw',
      loading: false,
    });
    expect(v).toEqual({ id: 'a', role: 'assistant', at: 1, markdown: '# Raw', summary: { title: 'T' } });
  });
});

describe('client: the raw output on request (G5-2, loadRaw)', () => {
  function harness(fetchImpl: (url: string) => Promise<any>) {
    const turns: any[] = [
      { id: 'u', role: 'user', at: 1, text: 'q' },
      { id: 'a', role: 'assistant', at: 2, summary: { title: 'T' }, summaryState: 'done' },
    ];
    const conv: Record<string, any> = {};
    const slot = { parentNode: { removeChild: vi.fn() } };
    const btn: Record<string, any> = {
      disabled: false,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      closest: () => slot,
    };
    const fetch = vi.fn(fetchImpl);
    const api = load<{ loadRaw: (id: string) => Promise<void> }>(
      VIEWER_CLIENT_JS,
      ['viewTurn', 'paintConversation', 'turnById', 'replaceTurn', 'loadRaw'],
      {
        _turns: turns,
        CONVERSATION_ID: 'c/1',
        window: {},
        fetch,
        document: {
          getElementById: (id: string) => (id === 'conv' ? conv : null),
          querySelector: (sel: string) => (sel === '[data-raw="a"]' ? btn : null),
        },
      },
    );
    return { api, turns, conv, slot, btn, fetch };
  }

  it('fetches /api/conversations/:id/turns/:turnId/raw, shows the answer loading meanwhile, then the raw output; the slot button goes', async () => {
    let resolve!: (v: any) => void;
    const h = harness(() => new Promise((r) => (resolve = r)));
    const p = h.api.loadRaw('a');
    await Promise.resolve();
    expect(h.fetch).toHaveBeenCalledWith('/api/conversations/c%2F1/turns/a/raw');
    expect(h.conv.data.turns[1]).toMatchObject({ loading: true, attachments: true });
    expect(h.btn.disabled).toBe(true);
    resolve({ ok: true, status: 200, json: async () => ({ raw: '# Full answer' }) });
    await p;
    expect(h.conv.data.turns[1]).toEqual({
      id: 'a',
      role: 'assistant',
      at: 2,
      markdown: '# Full answer',
      summary: { title: 'T' },
    });
    expect(h.slot.parentNode.removeChild).toHaveBeenCalledWith(h.slot);
    expect(h.conv.data.startText).toBe('대화의 시작');
  });

  it('a failed fetch: the error (with the status) and Try again, the button usable again; a second press while loading is ignored', async () => {
    const h = harness(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Turn not found' }) }));
    await h.api.loadRaw('a');
    expect(h.conv.data.turns[1]).toMatchObject({ error: '원본 응답을 불러오지 못했습니다 (HTTP 404)', canRetry: true });
    expect(h.conv.data.turns[1]).not.toHaveProperty('loading');
    expect(h.turns[1].loading).toBe(false);
    expect(h.btn.disabled).toBe(false);
    expect(h.btn.removeAttribute).toHaveBeenCalledWith('aria-busy');
    const net = harness(async () => {
      throw new Error('offline');
    });
    await net.api.loadRaw('a');
    expect(net.conv.data.turns[1].error).toBe('원본 응답을 불러오지 못했습니다 — 네트워크 오류');
    net.turns[1].loading = true;
    await net.api.loadRaw('a');
    expect(net.fetch).toHaveBeenCalledTimes(1);
    await net.api.loadRaw('u'); // not an answer
    expect(net.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('client: export as Markdown (G5-1)', () => {
  function harness(responses: Array<{ status: number; body: string }>) {
    const boxes = [
      { checked: true, dataset: { turnId: 't1' } },
      { checked: false, dataset: { turnId: 't2' } },
      { checked: true, dataset: { turnId: 't3' } },
    ];
    const els: Record<string, any> = {
      exportBtn: { disabled: false, setAttribute: vi.fn(), removeAttribute: vi.fn() },
      selectAllBtn: { textContent: '' },
      selectedCount: { textContent: '' },
      'export-error': { textContent: '', hidden: true },
      'export-dialog': { hide: vi.fn(), show: vi.fn() },
    };
    const anchor = { href: '', download: '', click: vi.fn() };
    const fetch = vi.fn(async () => {
      const r = responses.shift() ?? { status: 500, body: '' };
      return { ok: r.status < 400, status: r.status, text: async () => r.body };
    });
    const refreshCsrfToken = vi.fn(async () => {});
    const api = load<{
      exportSelected: () => Promise<void>;
      toggleSelectAll: () => void;
      updateSelectedCount: () => void;
      openExport: () => void;
      closeExport: () => void;
    }>(
      VIEWER_CLIENT_JS,
      [
        'exportDialog',
        'setExportError',
        'openExport',
        'closeExport',
        'updateSelectedCount',
        'toggleSelectAll',
        'exportSelected',
      ],
      {
        CONVERSATION_ID: 'c1a2b3c4d5',
        _csrfToken: 'csrf-1',
        refreshCsrfToken,
        fetch,
        Blob: class {
          parts: unknown[];
          constructor(parts: unknown[]) {
            this.parts = parts;
          }
        },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() },
        document: {
          getElementById: (id: string) => els[id] ?? null,
          querySelectorAll: (sel: string) =>
            sel === '.turn-checkbox:checked' ? boxes.filter((b) => b.checked) : boxes,
          createElement: () => anchor,
          body: { appendChild: vi.fn(), removeChild: vi.fn() },
        },
      },
    );
    return { api, boxes, els, anchor, fetch, refreshCsrfToken };
  }

  it('posts the checked turn ids with the CSRF token and downloads the Markdown; the dialog closes', async () => {
    const h = harness([{ status: 200, body: '# md' }]);
    await h.api.exportSelected();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/conversations/c1a2b3c4d5/export');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-1' });
    expect(JSON.parse(init.body as string)).toEqual({ turnIds: ['t1', 't3'] });
    expect(h.anchor.download).toBe('conversation-c1a2b3c4.md');
    expect(h.anchor.click).toHaveBeenCalled();
    expect(h.els['export-dialog'].hide).toHaveBeenCalled();
    expect(h.els['export-error'].hidden).toBe(true);
  });

  it('a 403 refreshes the CSRF token and retries once; a failure is a notice in the dialog, not an alert', async () => {
    const h = harness([
      { status: 403, body: '' },
      { status: 200, body: '# md' },
    ]);
    await h.api.exportSelected();
    expect(h.refreshCsrfToken).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const bad = harness([{ status: 500, body: '' }]);
    await bad.api.exportSelected();
    expect(bad.els['export-error']).toEqual({ textContent: '내보내지 못했습니다: HTTP 500', hidden: false });
    expect(bad.els['export-dialog'].hide).not.toHaveBeenCalled();
    expect(bad.els.exportBtn.removeAttribute).toHaveBeenCalledWith('aria-busy');
    expect(VIEWER_CLIENT_JS).not.toContain('alert(');
  });

  it('the count and the select-all button follow the boxes; export is disabled with none checked', () => {
    const h = harness([]);
    h.api.updateSelectedCount();
    expect(h.els.selectedCount.textContent).toBe('2개 선택');
    expect(h.els.selectAllBtn.textContent).toBe('전체 선택');
    expect(h.els.exportBtn.disabled).toBe(false);
    h.api.toggleSelectAll(); // not all checked → check all
    expect(h.boxes.every((b) => b.checked)).toBe(true);
    expect(h.els.selectAllBtn.textContent).toBe('전체 해제');
    h.api.toggleSelectAll(); // all checked → clear
    expect(h.boxes.some((b) => b.checked)).toBe(false);
    expect(h.els.exportBtn.disabled).toBe(true);
    expect(h.els.selectedCount.textContent).toBe('0개 선택');
  });

  it('opening clears an old error and uses show(); before the element is defined, the open attribute', () => {
    const h = harness([]);
    h.els['export-error'].textContent = 'old';
    h.els['export-error'].hidden = false;
    h.api.openExport();
    expect(h.els['export-dialog'].show).toHaveBeenCalled();
    expect(h.els['export-error']).toEqual({ textContent: '', hidden: true });
    const raw = { setAttribute: vi.fn(), removeAttribute: vi.fn() };
    h.els['export-dialog'] = raw;
    h.api.openExport();
    expect(raw.setAttribute).toHaveBeenCalledWith('open', '');
    h.api.closeExport();
    expect(raw.removeAttribute).toHaveBeenCalledWith('open');
  });
});
