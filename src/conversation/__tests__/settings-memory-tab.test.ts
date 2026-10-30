/**
 * SSOT 2026-10-23 T3 — the settings page "기억" tab, client half. Runs the
 * shipped script (`MEMORY_CLIENT_JS` + the page helpers it calls) with stubbed
 * fetch / DOM: what each store looks like, what every control sends, and that
 * a conflicting edit reloads and keeps the user's draft.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MEMORY_CLIENT_JS } from '../settings-memory-tab';
import { renderSettingsPage, SETTINGS_CLIENT_JS } from '../settings-page';

const ALL_JS = `${MEMORY_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`;

function clientFn(name: string): string {
  const plain = ALL_JS.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : ALL_JS.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = ALL_JS.indexOf('\n}\n', start);
  return ALL_JS.slice(start + 1, end + 2);
}
function clientVar(name: string): string {
  const m = ALL_JS.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return m[1];
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

function block(over: Record<string, unknown> = {}) {
  return {
    entries: ['테스트 전에 빌드', '배포는 dev 먼저'],
    charLimit: 2200,
    totalChars: 30,
    percentUsed: 1,
    perEntryCap: 660,
    revision: 'r1',
    ...over,
  };
}

describe('기억 tab shell', () => {
  it('the page carries the 기억 tab and the whole script still parses', () => {
    const html = renderSettingsPage();
    expect(html).toContain('<a href="#memory">기억</a>');
    expect(html).toContain('<div data-tab="memory" class="page" hidden>');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
  });

  it('개인 메모리 is the library element: its script from /dashboard/ui, inside the settings token bridge', async () => {
    const html = renderSettingsPage();
    const { UI_LIB_FILE, UI_LIB_VERSION, uiLibDistDir, uiLibTokensCss, pageTokenAliases } = await import('../ui-lib');
    expect(html).toContain(`<script type="module" src="/dashboard/ui/memory-panel.js?v=${UI_LIB_VERSION}"></script>`);
    expect(UI_LIB_FILE.test('memory-panel.js')).toBe(true);
    expect(existsSync(join(uiLibDistDir() as string, 'memory-panel.js'))).toBe(true); // the pinned build ships it
    expect(html).toContain('<div class="ui-tok"><ui-memory-panel id="l1-panel" lang="ko"></ui-memory-panel></div>');
    // the bridge: every token the element reads, from the same-named settings token, both themes
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    const bridge = /\.ui-tok \{([^}]*)\}/.exec(css)![1];
    for (const t of [
      'bg',
      'surface',
      'surface-raised',
      'border',
      'border-focus',
      'text',
      'text-secondary',
      'text-tertiary',
      'accent',
      'yellow',
      'red',
      'ib-pill',
      'st-wait',
      'st-done',
      'st-fail',
      'ease-out',
      'dur-press',
      'dur-fade',
      'radius',
      'font',
    ]) {
      expect(bridge, t).toContain(`--ui-${t}: var(--${t});`);
      // Tone pass P9: the page token is @2lab.ai/ui's (the ui-tokens sheet), aliased as on the dashboard —
      // was a hex palette of the settings page's own.
      expect(uiLibTokensCss(), t).toContain(`--ui-${t}:`);
      expect(html, t).toContain(`--${t}: var(--ui-${t});`);
    }
    expect(html).toContain(`<style id="ui-tokens">\n${uiLibTokensCss()}\n${pageTokenAliases()}\n</style>`);
    // light: the warn band's amber and the status tones are the library's light palette, not a drifted copy
    expect(uiLibTokensCss()).toMatch(/:root, \[data-theme="light"\] \{[^}]*--ui-yellow: #[0-9a-f]{6};[^}]*--ui-st-wait: #[0-9a-f]{6};/);
    expect(css).not.toMatch(/--(bg|surface|text|accent|yellow|st-wait): #/);
  });

  it('the inline 개인 메모리 renderer is gone: no chips, tray, cards or .mm-* styles of its own', () => {
    const html = renderSettingsPage();
    for (const gone of [
      'id="l1-chips"',
      'id="l1-foot"',
      'id="l1-undo"',
      'id="l1-total"',
      'class="mm',
      '.mm-',
      '.meter-line',
      'renderL1Card',
      'l1TrayHold',
    ]) {
      expect(html, gone).not.toContain(gone);
    }
    // 지식 페이지 and 관찰 기록 stay inline
    expect(html).toContain('id="mem-page-list"');
    expect(html).toContain('id="mem-ep-body"');
  });

  it('the memory script ships byte for byte (no template-literal syntax)', () => {
    expect(MEMORY_CLIENT_JS).not.toContain('`');
    expect(MEMORY_CLIENT_JS).not.toContain('${');
  });
});

// ── 개인 메모리 = <ui-memory-panel> (@2lab.ai/ui) — the host glue ──
// The element's rendering, chips, search, edit, delete + undo, add, clear and refuse() are pinned by the
// library's src/components/memory-panel/memory-panel.test.ts. Here: what the tab hands it (data), where each
// of its write events goes (route, revision, CSRF via apiWrite), one write at a time, and how a refusal comes back.
const L1_GLUE_FNS = [
  'memStatus',
  'memHold',
  'esc',
  'loadMemory',
  'l1Stores',
  'paintL1',
  'l1Route',
  'l1OnWrite',
  'l1Say',
  'l1Held',
  'l1Unsay',
  'l1Write',
];
const L1_GLUE_VARS = ['L1_LABELS', 'L1_FILES', 'L1_TARGETS', 'L1_EMPTY', 'L1_WRITES'];

/** The element as the host sees it: `data` in, cancelable `ui-*` events out, `refuse()`. */
function fakePanel() {
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const panel: any = {
    datas: [] as any[],
    log: [] as string[],
    get data() {
      return this.datas[this.datas.length - 1];
    },
    set data(v: any) {
      this.datas.push(v);
      this.log.push('data');
    },
    addEventListener: vi.fn((type: string, fn: (e: any) => void) => {
      (listeners[type] ||= []).push(fn);
    }),
    refuse: vi.fn(() => {
      panel.log.push('refuse');
      return true;
    }),
    /** Dispatch like the element: the same detail object the listener got goes to refuse(). */
    fire(type: string, detail: Record<string, unknown>) {
      const e = {
        type,
        detail,
        currentTarget: panel,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const fn of listeners[type] || []) fn(e);
      return e;
    },
  };
  return panel;
}

function l1Env(opts: { apiWrite?: any; fetch?: any; mem?: any } = {}) {
  const panel = fakePanel();
  const els: Record<string, any> = {
    'l1-panel': panel,
    'mem-l1-body': { innerHTML: '<div class="notice">불러오는 중…</div>' },
    'mem-status': { textContent: '', className: '', setAttribute: vi.fn() },
  };
  const mem = opts.mem ?? { l1: { memory: block(), user: block({ entries: ['직접적인 말투'], revision: 'u1' }) } };
  const fns = load<any>(L1_GLUE_FNS, L1_GLUE_VARS, {
    document: { getElementById: (id: string) => els[id] ?? null },
    _mem: mem,
    _memLoaded: true,
    apiWrite: opts.apiWrite ?? vi.fn(async () => ({ ok: true, data: { ok: true, l1: block({ revision: 'r2' }) } })),
    fetch:
      opts.fetch ?? vi.fn(async () => ({ ok: true, json: async () => ({ l1: mem.l1, pages: [], episodicDates: [] }) })),
    paintPageList: () => {},
    paintDates: () => {},
  });
  fns.paintL1();
  return { fns, panel, els, mem, status: els['mem-status'] };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('개인 메모리 — the data <ui-memory-panel> is given', () => {
  it('one store per L1 block: label, file, limits, the store’s separator, entries, and the tab’s empty line', () => {
    const { panel, els } = l1Env({
      mem: {
        l1: {
          memory: block(),
          user: block({ entries: [], charLimit: 1375, perEntryCap: 412, totalChars: 0, revision: 'u1' }),
        },
      },
    });
    expect(panel.data).toEqual({
      stores: [
        {
          id: 'memory',
          label: '에이전트 노트',
          file: 'MEMORY.md',
          limit: 2200,
          perEntryLimit: 660,
          separator: '\n§\n',
          entries: ['테스트 전에 빌드', '배포는 dev 먼저'],
          empty: '비어 있음 — Slack에서 "기억해줘"라고 하거나 아래에서 추가하세요.',
        },
        expect.objectContaining({ id: 'user', label: '사용자 프로필', file: 'USER.md', limit: 1375, entries: [] }),
      ],
    });
    expect(els['mem-l1-body'].innerHTML).toBe(''); // the loading notice goes once data is in
  });

  it('the usage the element counts (entries joined with the separator) is the store’s own totalChars', async () => {
    const store = await import('../../user-memory-store');
    const user = 'U-l1-usage';
    store.addMemory(user, 'memory', '테스트 전에 빌드');
    store.addMemory(user, 'memory', '여러 줄\n노트');
    const b = store.loadMemoryWithRevision(user, 'memory');
    const { panel } = l1Env({ mem: { l1: { memory: { ...b, perEntryCap: 660 }, user: block() } } });
    const s = panel.data.stores[0];
    expect(s.entries.join(s.separator).length).toBe(b.totalChars);
  });

  it('each write event is bound once, however often the stores are repainted', () => {
    const { fns, panel } = l1Env();
    fns.paintL1();
    fns.paintL1();
    expect(panel.addEventListener.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'ui-add',
      'ui-edit',
      'ui-delete',
      'ui-restore',
      'ui-clear',
    ]);
    expect(panel.datas).toHaveLength(3);
  });
});

describe('개인 메모리 — each write goes to its L1 route with the loaded revision', () => {
  it('add / edit / delete / undo / clear: method, route, body', async () => {
    const apiWrite = vi.fn(async () => ({ ok: true, data: { ok: true, l1: block() } })); // the revision stays r1
    const { panel } = l1Env({ apiWrite });
    const long = '긴 노트 '.repeat(140); // a note Slack saved: longer than a new note may be
    const sent: Array<[string, Record<string, unknown>]> = [
      ['ui-add', { store: 'memory', text: '새 메모' }],
      ['ui-edit', { store: 'memory', index: 1, text: '고친 메모', previous: '배포는 dev 먼저' }],
      ['ui-delete', { store: 'memory', index: 0, text: '테스트 전에 빌드' }],
      ['ui-restore', { store: 'memory', index: 0, text: long }],
      ['ui-clear', { store: 'user' }],
    ];
    for (const [type, detail] of sent) {
      expect(panel.fire(type, detail).defaultPrevented).toBe(false);
      await tick();
    }
    expect(apiWrite.mock.calls).toEqual([
      ['POST', '/api/memory/l1/memory', { text: '새 메모', revision: 'r1' }],
      ['PUT', '/api/memory/l1/memory/1', { text: '고친 메모', revision: 'r1' }],
      ['DELETE', '/api/memory/l1/memory/0', { revision: 'r1' }],
      ['POST', '/api/memory/l1/memory', { text: long, revision: 'r1', restore: true }], // the exact note (review R5)
      ['DELETE', '/api/memory/l1/user', { revision: 'u1' }],
    ]);
    expect(panel.refuse).not.toHaveBeenCalled();
  });

  it('the answer’s block is the next data, and the next write sends its revision', async () => {
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { ok: true, l1: block({ entries: ['a', 'b', 'c'], revision: 'r2' }) } })
      .mockResolvedValueOnce({ ok: true, data: { ok: true, l1: block({ entries: ['a', 'c'], revision: 'r3' }) } });
    const { panel, mem } = l1Env({ apiWrite });
    panel.fire('ui-add', { store: 'memory', text: 'c' });
    await tick();
    expect(mem.l1.memory.revision).toBe('r2');
    expect(panel.data.stores[0].entries).toEqual(['a', 'b', 'c']);
    panel.fire('ui-delete', { store: 'memory', index: 1, text: 'b' });
    await tick();
    expect(apiWrite).toHaveBeenLastCalledWith('DELETE', '/api/memory/l1/memory/1', { revision: 'r2' });
    expect(panel.data.stores[0].entries).toEqual(['a', 'c']);
  });

  it('an edit or delete whose entry is not the one this tab has at that index is refused and reloads; nothing is sent', async () => {
    const apiWrite = vi.fn();
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ l1: { memory: block(), user: block() } }) }));
    const { panel } = l1Env({ apiWrite, fetch });
    panel.fire('ui-edit', { store: 'memory', index: 1, text: 'x', previous: 'not this one' });
    panel.fire('ui-delete', { store: 'memory', index: 0, text: 'not this one either' });
    await tick();
    expect(apiWrite).not.toHaveBeenCalled();
    expect(panel.refuse).toHaveBeenCalledTimes(2);
    expect(panel.refuse.mock.calls[0][0].type).toBe('ui-edit');
    expect(fetch).toHaveBeenCalled();
  });

  it('an event for a store this tab does not have is cancelled', () => {
    const apiWrite = vi.fn();
    const { panel } = l1Env({ apiWrite });
    expect(panel.fire('ui-add', { store: 'pages', text: 'x' }).defaultPrevented).toBe(true);
    expect(apiWrite).not.toHaveBeenCalled();
  });
});

describe('개인 메모리 — one memory write at a time (review R10, R11)', () => {
  it('while any write of the tab is out, every element write is cancelled and #mem-status says 저장 중', async () => {
    let answer: (v: unknown) => void = () => {};
    const apiWrite = vi.fn(() => new Promise((res) => (answer = res)));
    const { fns, panel, status } = l1Env({ apiWrite });
    panel.fire('ui-delete', { store: 'memory', index: 0, text: '테스트 전에 빌드' });
    expect(fns.memHold.at).toBeGreaterThan(0); // pages and episodic wait for it too
    for (const [type, detail] of [
      ['ui-delete', { store: 'memory', index: 0, text: '테스트 전에 빌드' }], // a second click: no double delete
      ['ui-edit', { store: 'memory', index: 1, text: 'x', previous: '배포는 dev 먼저' }],
      ['ui-add', { store: 'user', text: 'y' }],
      ['ui-restore', { store: 'memory', index: 0, text: 'z' }],
      ['ui-clear', { store: 'user' }],
    ] as const) {
      expect(panel.fire(type, detail).defaultPrevented).toBe(true); // the element keeps what was typed
    }
    expect(status.textContent).toContain('저장 중');
    expect(apiWrite).toHaveBeenCalledTimes(1);
    answer({ ok: true, data: { ok: true, l1: block({ entries: ['배포는 dev 먼저'], revision: 'r2' }) } });
    await tick();
    expect(fns.memHold.at).toBe(0);
    expect(status.textContent).toBe(''); // the success clears the 저장 중 it caused
    expect(panel.fire('ui-add', { store: 'user', text: 'y' }).defaultPrevented).toBe(false);
  });

  it('a page or episodic write that is out holds the element too', () => {
    const apiWrite = vi.fn();
    const { fns, panel, status } = l1Env({ apiWrite });
    fns.memHold.at = Date.now();
    expect(panel.fire('ui-add', { store: 'memory', text: 'x' }).defaultPrevented).toBe(true);
    expect(apiWrite).not.toHaveBeenCalled();
    expect(status.textContent).toContain('저장 중');
  });
});

describe('개인 메모리 — a refused write comes back through el.refuse()', () => {
  it('a 409 reloads the stores (still holding the tab), then refuses the same event; the full message stays in #mem-status (review P1)', async () => {
    let reload: (v: unknown) => void = () => {};
    const apiWrite = vi.fn(async () => ({ ok: false, status: 409, error: 'conflict' }));
    const fetch = vi.fn(() => new Promise((res) => (reload = res)));
    const { fns, panel, status } = l1Env({ apiWrite, fetch });
    const e = panel.fire('ui-edit', { store: 'memory', index: 1, text: '고친 배포 규칙', previous: '배포는 dev 먼저' });
    await tick();
    expect(fns.memHold.at).toBeGreaterThan(0); // the 409 is in, the reload is out: still held
    expect(panel.fire('ui-add', { store: 'memory', text: 'x' }).defaultPrevented).toBe(true);
    reload({
      ok: true,
      json: async () => ({
        l1: { memory: block({ entries: ['테스트 전에 빌드', '에이전트가 바꾼 항목'], revision: 'r5' }), user: block() },
        pages: [],
        episodicDates: [],
      }),
    });
    await tick();
    expect(fns.memHold.at).toBe(0);
    expect(panel.data.stores[0].entries).toEqual(['테스트 전에 빌드', '에이전트가 바꾼 항목']); // the truth first …
    expect(panel.refuse).toHaveBeenCalledTimes(1); // … then the refusal, which puts the draft back
    expect(panel.refuse.mock.calls[0][0]).toBe(e);
    expect(panel.log.slice(-2)).toEqual(['data', 'refuse']);
    expect(status.textContent).toContain('최신 내용을 불러왔습니다');
    expect(status.textContent).toContain('편집 칸에 그대로');
    expect(status.className).toContain('is-error');
  });

  it('a 409 whose reload fails still releases the hold and refuses (the optimistic change rolls back) (review R12)', async () => {
    const apiWrite = vi.fn(async () => ({ ok: false, status: 409, error: 'conflict' }));
    const fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));
    const { fns, panel, status } = l1Env({ apiWrite, fetch });
    panel.fire('ui-delete', { store: 'memory', index: 0, text: '테스트 전에 빌드' });
    await tick();
    await tick();
    expect(fns.memHold.at).toBe(0);
    expect(panel.refuse).toHaveBeenCalledTimes(1);
    expect(panel.datas).toHaveLength(1); // no new data: the element keeps its last stores
    expect(status.textContent).toContain('최신 내용은 불러오지 못했습니다');
    expect(status.textContent).toContain('다시 적용하세요');
  });

  it('over the limit, a lock or a network error: refused with the reason, no reload, the store unchanged', async () => {
    const fetch = vi.fn();
    for (const r of [
      { ok: false, status: 400, error: '에이전트 노트 용량(2200자)을 넘습니다' },
      { ok: false, status: 503, error: '잠시 후 다시 시도하세요' },
    ]) {
      const apiWrite = vi.fn(async () => r);
      const { panel, status, mem } = l1Env({ apiWrite, fetch });
      const e = panel.fire('ui-add', { store: 'memory', text: '새 메모' });
      await tick();
      expect(panel.refuse).toHaveBeenCalledWith(e, `저장하지 못했습니다: ${r.error}`);
      expect(status.textContent).toBe(`저장하지 못했습니다: ${r.error}`);
      expect(mem.l1.memory.revision).toBe('r1');
    }
    const thrown = l1Env({ apiWrite: vi.fn(async () => Promise.reject(new Error('offline'))), fetch });
    thrown.panel.fire('ui-restore', { store: 'memory', index: 0, text: '되돌릴 노트' });
    await tick();
    expect(thrown.panel.refuse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ui-restore' }),
      '저장하지 못했습니다: offline',
    );
    expect(thrown.fns.memHold.at).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a successful L1 write clears the alert L1 left; a message another section wrote since stays', async () => {
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, error: 'no' })
      .mockResolvedValueOnce({ ok: true, data: { ok: true, l1: block() } })
      .mockResolvedValueOnce({ ok: false, status: 400, error: 'no' })
      .mockResolvedValueOnce({ ok: true, data: { ok: true, l1: block() } });
    const { fns, panel, status } = l1Env({ apiWrite });
    panel.fire('ui-add', { store: 'memory', text: 'a' });
    await tick();
    expect(status.textContent).toBe('저장하지 못했습니다: no');
    panel.fire('ui-add', { store: 'memory', text: 'a' });
    await tick();
    expect(status.textContent).toBe('');
    panel.fire('ui-add', { store: 'memory', text: 'a' });
    await tick();
    fns.memStatus('페이지를 지웠습니다', false); // another section
    panel.fire('ui-add', { store: 'memory', text: 'a' });
    await tick();
    expect(status.textContent).toBe('페이지를 지웠습니다');
  });
});

describe('개인 메모리 — loads around writes (review R12, R13)', () => {
  it('the first memory load is applied even while a note is being added', async () => {
    let loadAnswer: (v: unknown) => void = () => {};
    const panel = fakePanel();
    const els: Record<string, any> = { 'l1-panel': panel, 'mem-l1-body': { innerHTML: 'x' } };
    const fns = load<any>(L1_GLUE_FNS, L1_GLUE_VARS, {
      document: { getElementById: (id: string) => els[id] ?? null },
      _mem: null,
      _memLoaded: false,
      apiWrite: vi.fn(),
      fetch: vi.fn(() => new Promise((res) => (loadAnswer = res))),
      paintPageList: () => {},
      paintDates: () => {},
    });
    const first = fns.loadMemory();
    fns.memHold.at = Date.now(); // a note for today is out
    loadAnswer({
      ok: true,
      json: async () => ({ l1: { memory: block({ entries: ['e0'] }), user: block() }, pages: [], episodicDates: [] }),
    });
    await first;
    expect(panel.data.stores[0].entries).toEqual(['e0']);
  });

  it('a load answered during a write, or older than another, does not replace the data', async () => {
    const loads: Array<(v: unknown) => void> = [];
    let answer: (v: unknown) => void = () => {};
    const { fns, panel } = l1Env({
      apiWrite: vi.fn(() => new Promise((res) => (answer = res))),
      fetch: vi.fn(() => new Promise((res) => loads.push(res))),
    });
    const late = fns.loadMemory(); // a load from an earlier tab switch is still out
    panel.fire('ui-add', { store: 'memory', text: 'new note' });
    const fresh = { l1: { memory: block({ entries: ['stale'] }), user: block() }, pages: [], episodicDates: [] };
    for (const res of loads) res({ ok: true, json: async () => fresh });
    await late;
    expect(panel.datas).toHaveLength(1); // the write's own data comes with its answer
    answer({
      ok: true,
      data: { ok: true, l1: block({ entries: ['테스트 전에 빌드', '배포는 dev 먼저', 'new note'], revision: 'r2' }) },
    });
    await tick();
    expect(panel.data.stores[0].entries).toEqual(['테스트 전에 빌드', '배포는 dev 먼저', 'new note']);
  });

  it('a failed first load shows the alert in the list; a failed later load keeps the stores and reports in #mem-status', async () => {
    const panel = fakePanel();
    const els: Record<string, any> = {
      'l1-panel': panel,
      'mem-l1-body': { innerHTML: '' },
      'mem-status': { textContent: '', className: '', setAttribute: vi.fn() },
    };
    const fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));
    const deps = {
      document: { getElementById: (id: string) => els[id] ?? null },
      _mem: null as any,
      _memLoaded: false,
      apiWrite: vi.fn(),
      fetch,
      paintPageList: () => {},
      paintDates: () => {},
    };
    expect(await load<any>(L1_GLUE_FNS, L1_GLUE_VARS, deps).loadMemory()).toBe(false);
    expect(els['mem-l1-body'].innerHTML).toContain('role="alert"');
    expect(els['mem-l1-body'].innerHTML).toContain('boom');
    deps._mem = { l1: { memory: block(), user: block() } };
    els['mem-l1-body'].innerHTML = '';
    const later = load<any>(L1_GLUE_FNS, L1_GLUE_VARS, deps);
    later.paintL1();
    expect(await later.loadMemory()).toBe(false);
    expect(els['mem-l1-body'].innerHTML).toBe('');
    expect(els['mem-status'].textContent).toBe('boom');
    expect(panel.datas).toHaveLength(1);
  });
});

describe('지식 페이지 editor', () => {
  it('shows title, aliases, Current and every History line editable; a new page asks type and name', () => {
    const el: any = { innerHTML: '' };
    const doc = { getElementById: () => el };
    const page = {
      id: 'concepts/ssot',
      title: 'SSOT <b>',
      aliases: ['ssot', 'truth'],
      current: 'v2',
      history: ['2026-10-22: a', '2026-10-21: b'],
      updated: '2026-10-22',
    };
    const fns = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS', '_memPageRaw'], {
      document: doc,
      _memPage: { page, revision: 'p1' },
    });
    fns.renderPageEditor();
    expect(el.innerHTML).toContain('value="SSOT &lt;b&gt;"');
    expect(el.innerHTML).toContain('value="ssot, truth"');
    expect(el.innerHTML).toContain('<textarea id="pg-current" rows="8">v2</textarea>');
    expect(el.innerHTML.match(/class="pg-hist"/g)).toHaveLength(2);
    expect(el.innerHTML).toContain('페이지 삭제');
    const fresh = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS', '_memPageRaw'], {
      document: doc,
      _memPage: { page: { id: '', title: '', aliases: [], current: '', history: [] }, revision: null },
    });
    fresh.renderPageEditor();
    expect(el.innerHTML).toContain('<select id="pg-type">');
    expect(el.innerHTML).toContain('id="pg-name"');
    expect(el.innerHTML).toContain('만들기');
  });

  it('a page the form cannot hold opens as raw markdown, saved with its revision; 409 keeps the draft (review R3 P1)', async () => {
    const el: any = { innerHTML: '' };
    const conflictBox: any = { innerHTML: '' };
    const rawBox: any = { value: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const raw = '---\ntitle: L\n---\n\n## Current\n\nintro\n## Details\nimportant <text>\n';
    const memPage: any = {
      page: { id: 'concepts/lossy', title: 'L', aliases: [], current: 'intro', history: [], updated: '2026-10-23' },
      revision: 'p1',
      raw,
      representable: false,
    };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? el : id === 'pg-conflict' ? conflictBox : id === 'pg-raw' ? rawBox : status,
      querySelectorAll: () => [],
    };
    const view = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS', '_memPageRaw'], {
      document: doc,
      _memPage: memPage,
    });
    view.renderPageEditor();
    expect(el.innerHTML).toContain('<textarea id="pg-raw"');
    expect(el.innerHTML).toContain('important &lt;text&gt;');
    expect(el.innerHTML).toContain('양식에 담기지 않는');
    expect(el.innerHTML).not.toContain('id="pg-current"');
    expect(el.innerHTML).toContain('onclick="savePageRaw()"');

    rawBox.value = raw.replace('important', 'very important');
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'conflict' })
      .mockResolvedValueOnce({ ok: true, data: { ...memPage, revision: 'p3' } });
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ...memPage, revision: 'p2' }) }));
    const fns = load<any>(
      [
        'esc',
        'savePageRaw',
        'memStatus',
        'renderPageConflict',
        'overwritePage',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageConflict409',
      ],
      ['_memPageConflict', '_memPageRaw'],
      {
        document: doc,
        fetch,
        _memPage: memPage,
        apiWrite,
        refreshPageIndex: async () => {},
        renderPageEditor: () => {},
      },
    );
    await fns.savePageRaw();
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/page/raw', {
      id: 'concepts/lossy',
      raw: rawBox.value,
      revision: 'p1',
    });
    expect(conflictBox.innerHTML).toContain('내 수정본으로 덮어쓰기');
    expect(rawBox.value).toContain('very important'); // the draft is still in the editor
    await fns.overwritePage();
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/page/raw', {
      id: 'concepts/lossy',
      raw: rawBox.value,
      revision: 'p2',
    });
  });

  it('any page can be switched to raw markdown editing', () => {
    const el: any = { innerHTML: '' };
    const page = { id: 'concepts/a', title: 'A', aliases: [], current: 'v', history: [], updated: '2026-10-23' };
    const fns = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS', '_memPageRaw'], {
      document: { getElementById: () => el },
      _memPage: { page, revision: 'p1', raw: '# A\n', representable: true },
    });
    fns.renderPageEditor();
    expect(el.innerHTML).toContain('id="pg-current"');
    expect(el.innerHTML).toContain('onclick="pageRawMode(true)"');
  });

  it('save sends the whole page with the loaded revision; a new page is created with revision null', async () => {
    const values: Record<string, string> = {
      'pg-title': 'New title',
      'pg-aliases': 'a, b ,, c',
      'pg-current': 'now',
      'pg-type': 'agent',
      'pg-name': 'ci-runner',
    };
    const hist = [{ value: '2026-10-23: x' }, { value: '  ' }];
    const doc = {
      getElementById: (id: string) => (id in values ? { value: values[id] } : { textContent: '', setAttribute() {} }),
      querySelectorAll: () => hist,
    };
    const apiWrite = vi.fn(async () => ({ ok: true, data: { page: { id: 'x' }, revision: 'p2' } }));
    const memPage: any = { page: { id: 'concepts/ssot' }, revision: 'p1' };
    const fns = load<any>(
      [
        'pageDraft',
        'savePage',
        'memStatus',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageDraftText',
        'pageConflict409',
      ],
      [],
      {
        document: doc,
        _memPage: memPage,
        apiWrite,
        refreshPageIndex: async () => {},
        renderPageEditor: () => {},
        openPage: async () => {},
      },
    );
    await fns.savePage();
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/memory/page', {
      id: 'concepts/ssot',
      title: 'New title',
      aliases: ['a', 'b', 'c'],
      current: 'now',
      history: ['2026-10-23: x'],
      revision: 'p1',
    });
    const fresh = load<any>(
      [
        'pageDraft',
        'savePage',
        'memStatus',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageDraftText',
        'pageConflict409',
      ],
      [],
      {
        document: doc,
        _memPage: { page: { id: '' }, revision: null },
        apiWrite,
        refreshPageIndex: async () => {},
        renderPageEditor: () => {},
        openPage: async () => {},
      },
    );
    await fresh.savePage();
    expect(apiWrite).toHaveBeenLastCalledWith(
      'PUT',
      '/api/memory/page',
      expect.objectContaining({ id: 'agent/ci-runner', revision: null }),
    );
  });
});

describe('in-flight writes hold what they were sent from (review R7)', () => {
  it('a page save locks the fields until it is answered, so nothing typed meanwhile is overwritten', async () => {
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const fields = [{ disabled: false }, { disabled: false }];
    const values: Record<string, string> = { 'pg-title': 'A', 'pg-aliases': '', 'pg-current': 'a draft' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? detail : id in values ? { value: values[id] } : status,
      querySelectorAll: (sel: string) => (sel.includes('pg-history') ? [] : fields),
    };
    const pageA = { id: 'concepts/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    let answer: (v: unknown) => void = () => {};
    const apiWrite = vi.fn().mockImplementationOnce(() => new Promise((res) => (answer = res)));
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'savePage',
        'memStatus',
        'renderPageConflict',
        'renderPageEditor',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageDraftText',
        'pageConflict409',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'a1', raw: '# A\n', representable: true },
        apiWrite,
        fetch: vi.fn(async () => ({
          ok: true,
          json: async () => ({ page: pageA, revision: 'a2', raw: '# A\n', representable: true }),
        })),
        refreshPageIndex: async () => {},
        paintPageList: () => {},
      },
    );
    const saving = fns.savePage();
    expect(fields.every((f) => f.disabled)).toBe(true); // locked while the save is out
    answer({ ok: false, status: 409, error: 'changed' });
    await saving;
    expect(fields.every((f) => !f.disabled)).toBe(true); // the draft is editable again after a refusal
  });

  it('an episodic save holds the day: switching days waits, and a late answer never repaints another day', async () => {
    const body: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const dateSel: any = { value: '2026-10-20', innerHTML: '' };
    const editBox: any = { value: '20th edited' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-ep-body' ? body : id === 'mem-ep-date' ? dateSel : id === 'ep-edit' ? editBox : status,
    };
    const d20 = { date: '2026-10-20', revision: 'r20', entries: [{ time: '09:00', content: '20th original' }] };
    const d21 = { date: '2026-10-21', revision: 'r21', entries: [{ time: '10:00', content: '21st only' }] };
    let answer: (v: unknown) => void = () => {};
    const apiWrite = vi.fn().mockImplementationOnce(() => new Promise((res) => (answer = res)));
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => d21 }));
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'renderDay',
        'epSave',
        'epWrite',
        'loadDay',
        'epBusy',
        'memStatus',
        'refreshDatesIfEmptied',
        'fillDateSelect',
        'openEpEditor',
        'reopenEpEditor',
        'repaintDay',
        'keepEpDraft',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'paintRecover',
        'epRecover409',
      ],
      ['_epEditor'],
      {
        document: doc,
        _memDay: d20,
        _mem: { episodicDates: ['2026-10-21', '2026-10-20'] },
        apiWrite,
        fetch: fetchMock,
        refreshPageIndex: async () => {},
        paintDates: () => {},
      },
    );
    fns.renderDay(0);
    const saving = fns.epSave(0);
    await fns.loadDay('2026-10-21'); // the user picks another day while the save is out
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dateSel.value).toBe('2026-10-20'); // the picker stays on the day the body shows
    expect(status.textContent).toContain('저장 중');
    // (a fresh object, as the server sends it — not a copy of the view with its hold)
    const d20b: any = { date: '2026-10-20', revision: 'r20b', entries: [{ time: '09:00', content: '20th edited' }] };
    answer({ ok: true, data: { ok: true, day: d20b } });
    await saving;
    expect(body.innerHTML).toContain('20th edited');

    // a save that hung past the hold: the user moves on, and its late answer only reports
    apiWrite.mockImplementationOnce(() => new Promise((res) => (answer = res)));
    fns.renderDay(0);
    const late = fns.epSave(0);
    d20b.saving = 0; // (defense: the holds are gone — the UI never releases them before the answer, review R11)
    fns.memHold.at = 0;
    expect(apiWrite).toHaveBeenCalledTimes(2); // the second save did go out
    await fns.loadDay('2026-10-21');
    expect(dateSel.value).toBe('2026-10-21');
    answer({ ok: true, data: { ok: true, day: { ...d20, revision: 'r20c' } } });
    await late;
    expect(dateSel.value).toBe('2026-10-21');
    expect(body.innerHTML).toContain('21st only');
    expect(body.innerHTML).not.toContain('20th');
  });

  it('a note for today keeps an open editor of today, with its draft', async () => {
    const body: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const editBox: any = { value: 'today record, edited' };
    const noteBox: any = { value: 'a new note' };
    const dateSel: any = { value: '2026-10-23', innerHTML: '' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-ep-body'
          ? body
          : id === 'ep-edit'
            ? editBox
            : id === 'mem-ep-new'
              ? noteBox
              : id === 'mem-ep-date'
                ? dateSel
                : status,
    };
    const today = { date: '2026-10-23', revision: 't1', entries: [{ time: '08:00', content: 'today record' }] };
    const after = {
      date: '2026-10-23',
      revision: 't2',
      entries: [...today.entries, { time: '09:00', content: 'a new note' }],
    };
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'renderDay',
        'epAdd',
        'epBusy',
        'memStatus',
        'fillDateSelect',
        'keepEpDraft',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'openEpEditor',
        'paintRecover',
        'reopenEpEditor',
      ],
      ['_epEditor'],
      {
        document: doc,
        _memDay: today,
        _mem: { episodicDates: ['2026-10-23'] },
        apiWrite: vi.fn(async () => ({ ok: true, data: { ok: true, day: after } })),
        refreshPageIndex: async () => {},
        paintDates: () => {},
        loadDay: async () => {},
      },
    );
    fns.renderDay(0);
    await fns.epAdd();
    expect(body.innerHTML).toContain('today record, edited'); // the draft is still in the editor
    expect(body.innerHTML).toContain('a new note');
  });
});

describe('episodic answers apply only where they belong (review R8)', () => {
  const EP_FNS = [
    'esc',
    'escAttr',
    'renderDay',
    'epSave',
    'epDelete',
    'epWrite',
    'epAdd',
    'loadDay',
    'epBusy',
    'memStatus',
    'fillDateSelect',
    'refreshDatesIfEmptied',
    'openEpEditor',
    'reopenEpEditor',
    'repaintDay',
    'keepEpDraft',
    'memHold',
    'memKeepDraft',
    'memRecover',
    'paintRecover',
    'epRecover409',
    'epCancel',
  ];
  function page(day: unknown, extra: Record<string, unknown> = {}) {
    const els: Record<string, any> = {
      'mem-ep-body': { innerHTML: '' },
      'mem-ep-date': { value: (day as { date: string }).date, innerHTML: '' },
      'mem-ep-new': { value: '', disabled: false },
      status: { textContent: '', setAttribute() {} },
    };
    let editBox: any = null;
    const doc = {
      getElementById: (id: string) => {
        if (id === 'ep-edit') {
          if (!els['mem-ep-body'].innerHTML.includes('id="ep-edit"')) return null;
          editBox ??= { value: '', disabled: false };
          return editBox;
        }
        return els[id] ?? els.status;
      },
    };
    return { els, doc, edit: () => doc.getElementById('ep-edit'), extra };
  }

  it('a note for today re-attaches an open editor only to the same record (time and text), never by position', async () => {
    const today = {
      date: '2026-10-23',
      revision: 't1',
      entries: [
        { time: '08:00', content: 'A' },
        { time: '09:00', content: 'B' },
        { time: '10:00', content: 'C' },
      ],
    };
    // another client deleted A meanwhile; the note N is appended
    const after = {
      date: '2026-10-23',
      revision: 't3',
      entries: [
        { time: '09:00', content: 'B' },
        { time: '10:00', content: 'C' },
        { time: '11:00', content: 'N' },
      ],
    };
    const p = page(today);
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { ok: true, day: after } })
      .mockResolvedValue({ ok: true, data: { ok: true, day: after } });
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: today,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite,
      refreshPageIndex: async () => {},
      paintDates: () => {},
      confirmDialog: async () => true,
    });
    fns.renderDay(1); // B is open
    p.edit().value = 'B, edited';
    p.els['mem-ep-new'].value = 'N';
    await fns.epAdd();
    await fns.epSave(0); // the editor now sits on B at index 0
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/episodic/2026-10-23/0', {
      content: 'B, edited',
      revision: 't3',
    });
  });

  it("a delete answered after the view moved to another day reports, and leaves that day's view alone", async () => {
    const past = { date: '2026-01-01', revision: 'p1', entries: [{ time: '09:00', content: 'old' }] };
    const today = { date: '2026-10-23', revision: 't1', entries: [{ time: '08:00', content: 'today' }] };
    const p = page(past);
    let release: () => void = () => {};
    const confirmDialog = () => new Promise<boolean>((res) => (release = () => res(true)));
    const apiWrite = vi.fn(async () => ({
      ok: true,
      data: { ok: true, day: { ...past, revision: 'p2', entries: [] } },
    }));
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: past,
      _mem: { episodicDates: ['2026-10-23', '2026-01-01'] },
      apiWrite,
      fetch: vi.fn(async () => ({ ok: true, json: async () => today })),
      refreshPageIndex: async () => {},
      paintDates: () => {},
      confirmDialog,
    });
    const deleting = fns.epDelete(0); // the dialog for the past record is open ...
    await fns.loadDay('2026-10-23'); // ... and the view moves to today behind it
    release();
    await deleting;
    expect(apiWrite).toHaveBeenCalledWith('DELETE', '/api/memory/episodic/2026-01-01/0', { revision: 'p1' });
    expect(p.els['mem-ep-date'].value).toBe('2026-10-23');
    expect(p.els['mem-ep-body'].innerHTML).toContain('today');
  });

  it('only the latest day request paints the view', async () => {
    const d1 = { date: '2026-10-21', revision: 'a', entries: [{ time: '01:00', content: 'first day' }] };
    const d2 = { date: '2026-10-22', revision: 'b', entries: [{ time: '02:00', content: 'second day' }] };
    const p = page(d1);
    const answers: Record<string, (v: unknown) => void> = {};
    const fetchMock = vi.fn((url: string) => new Promise((res) => (answers[url.split('/').pop() as string] = res)));
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: null,
      fetch: fetchMock,
      apiWrite: vi.fn(),
    });
    const a = fns.loadDay('2026-10-21');
    const b = fns.loadDay('2026-10-22');
    answers['2026-10-22']({ ok: true, json: async () => d2 });
    await b;
    answers['2026-10-21']({ ok: true, json: async () => d1 }); // the older request answers last
    await a;
    expect(p.els['mem-ep-date'].value).toBe('2026-10-22');
    expect(p.els['mem-ep-body'].innerHTML).toContain('second day');
  });

  it('while a delete is out, opening an editor waits; an editor open before it keeps its record and draft (review R8, grok)', async () => {
    const day = {
      date: '2026-10-23',
      revision: 't1',
      entries: [
        { time: '08:00', content: 'r0' },
        { time: '09:00', content: 'r1' },
        { time: '10:00', content: 'r2' },
      ],
    };
    const after = {
      date: '2026-10-23',
      revision: 't2',
      entries: [
        { time: '09:00', content: 'r1' },
        { time: '10:00', content: 'r2' },
      ],
    };
    const p = page(day);
    let answer: (v: unknown) => void = () => {};
    const apiWrite = vi.fn().mockImplementation(() => new Promise((res) => (answer = res)));
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: day,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite,
      refreshPageIndex: async () => {},
      paintDates: () => {},
      confirmDialog: async () => true,
    });
    fns.renderDay(1); // r1 is open, and edited
    p.edit().value = 'r1, edited';
    const deleting = fns.epDelete(0); // r0 is deleted
    await Promise.resolve();
    fns.renderDay(2); // "수정" on r2 while the delete is out
    expect(p.els.status.textContent).toContain('저장 중');
    answer({ ok: true, data: { ok: true, day: after } });
    await deleting;
    // the editor stays on r1 (now at index 0), with the draft
    expect(p.els['mem-ep-body'].innerHTML).toContain('r1, edited');
    apiWrite.mockResolvedValueOnce({ ok: true, data: { ok: true, day: after } });
    await fns.epSave(0);
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/episodic/2026-10-23/0', {
      content: 'r1, edited',
      revision: 't2',
    });
  });

  it('a note for today holds the day like any episodic write (review R8, grok)', async () => {
    const past = { date: '2026-10-20', revision: 'p1', entries: [{ time: '09:00', content: 'past' }] };
    const p = page(past);
    let answer: (v: unknown) => void = () => {};
    const fetchMock = vi.fn();
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: past,
      _mem: { episodicDates: ['2026-10-20'] },
      apiWrite: vi.fn(() => new Promise((res) => (answer = res))),
      fetch: fetchMock,
      refreshPageIndex: async () => {},
      paintDates: () => {},
    });
    p.els['mem-ep-new'].value = 'note';
    const adding = fns.epAdd();
    await fns.loadDay('2026-10-21'); // the user picks another day while the note is out
    fns.renderDay(0); // or opens an editor
    expect(fetchMock).not.toHaveBeenCalled();
    expect(p.els['mem-ep-body'].innerHTML).not.toContain('id="ep-edit"');
    answer({ ok: false, status: 400, error: 'no' });
    await adding;
  });

  it('a delete refused with 409 keeps an open editor of the day, with its draft (review R9)', async () => {
    const day = {
      date: '2026-10-23',
      revision: 't1',
      entries: [
        { time: '08:00', content: 'r0' },
        { time: '09:00', content: 'r1' },
      ],
    };
    const latest = {
      date: '2026-10-23',
      revision: 't2',
      entries: [...day.entries, { time: '12:00', content: 'agent wrote this turn' }],
    };
    const p = page(day);
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: day,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite: vi.fn(async () => ({ ok: false, status: 409, error: 'changed' })),
      fetch: vi.fn(async () => ({ ok: true, json: async () => latest })),
      refreshPageIndex: async () => {},
      paintDates: () => {},
      confirmDialog: async () => true,
    });
    fns.renderDay(1);
    p.edit().value = 'r1, edited';
    await fns.epDelete(0);
    expect(p.els['mem-ep-body'].innerHTML).toContain('r1, edited');
  });

  it('an editor opened on one of two identical records is never re-attached; its draft goes to the note box (review R9, astra)', async () => {
    const twin = { time: '09:00', content: 'same' };
    const day = { date: '2026-10-23', revision: 't1', entries: [twin, { ...twin }] };
    // another client deleted the second one; then a note was added
    const after = { date: '2026-10-23', revision: 't3', entries: [{ ...twin }, { time: '11:00', content: 'N' }] };
    const p = page(day);
    const apiWrite = vi.fn(async () => ({ ok: true, data: { ok: true, day: after } }));
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: day,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite,
      refreshPageIndex: async () => {},
      paintDates: () => {},
    });
    fns.renderDay(1); // the second twin
    p.edit().value = 'SECOND RECORD DRAFT';
    p.els['mem-ep-new'].value = 'N';
    await fns.epAdd();
    expect(p.els['mem-ep-body'].innerHTML).not.toContain('SECOND RECORD DRAFT');
    expect(p.els['mem-ep-new'].value).toBe('SECOND RECORD DRAFT');
    await fns.epSave(0);
    expect(apiWrite).toHaveBeenCalledTimes(1); // nothing was written onto the first twin
  });

  it('a note for today does not reload the day it already has', async () => {
    const today = { date: '2026-10-23', revision: 't1', entries: [{ time: '08:00', content: 'A' }] };
    const after = { ...today, revision: 't2', entries: [...today.entries, { time: '09:00', content: 'N' }] };
    const p = page(today);
    const fetchMock = vi.fn();
    const paintDates = vi.fn();
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: today,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite: vi.fn(async () => ({ ok: true, data: { ok: true, day: after } })),
      fetch: fetchMock,
      refreshPageIndex: async () => {},
      paintDates,
    });
    p.els['mem-ep-new'].value = 'N';
    await fns.epAdd();
    expect(paintDates).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(p.els['mem-ep-body'].innerHTML).toContain('N');
  });

  it('a 409 on a save whose record was one of two twins never attaches the draft to the other twin (review R10, astra)', async () => {
    const twin = { time: '09:00', content: 'same' };
    const day = { date: '2026-10-23', revision: 't1', entries: [twin, { ...twin }] };
    const latest = { date: '2026-10-23', revision: 't2', entries: [{ ...twin }] }; // the first twin was deleted elsewhere
    const p = page(day);
    p.els['mem-recover'] = { innerHTML: '' };
    const apiWrite = vi.fn(async () => ({ ok: false, status: 409, error: 'changed' }));
    const fns = load<any>(
      [...EP_FNS, 'memKeepDraft', 'memRecover', 'paintRecover', 'memHold', 'esc', 'escAttr'],
      ['_epEditor'],
      {
        document: p.doc,
        _memDay: day,
        _mem: { episodicDates: ['2026-10-23'] },
        apiWrite,
        fetch: vi.fn(async () => ({ ok: true, json: async () => latest })),
        refreshPageIndex: async () => {},
        paintDates: () => {},
      },
    );
    fns.renderDay(0);
    p.edit().value = 'FIRST TWIN DRAFT';
    await fns.epSave(0);
    expect(p.els['mem-ep-body'].innerHTML).not.toContain('FIRST TWIN DRAFT');
    expect(p.els['mem-ep-new'].value + p.els['mem-recover'].innerHTML).toContain('FIRST TWIN DRAFT');
  });

  it('a note for today with an open editor whose record vanished keeps the draft (review R10, grok)', async () => {
    const day = { date: '2026-10-23', revision: 't1', entries: [{ time: '09:00', content: 'mine' }] };
    const after = { date: '2026-10-23', revision: 't3', entries: [{ time: '11:00', content: 'N' }] };
    const p = page(day);
    p.els['mem-recover'] = { innerHTML: '' };
    const fns = load<any>(
      [...EP_FNS, 'memKeepDraft', 'memRecover', 'paintRecover', 'memHold', 'esc', 'escAttr'],
      ['_epEditor'],
      {
        document: p.doc,
        _memDay: day,
        _mem: { episodicDates: ['2026-10-23'] },
        apiWrite: vi.fn(async () => ({ ok: true, data: { ok: true, day: after } })),
        refreshPageIndex: async () => {},
        paintDates: () => {},
      },
    );
    fns.renderDay(0);
    p.edit().value = 'mine, edited';
    p.els['mem-ep-new'].value = 'N';
    await fns.epAdd();
    expect(p.els['mem-ep-new'].value + p.els['mem-recover'].innerHTML).toContain('mine, edited');
  });

  it('switching days with the note box in use keeps the editor draft in the recovery box (review R10, astra)', async () => {
    const d1 = { date: '2026-10-22', revision: 'a', entries: [{ time: '01:00', content: 'x' }] };
    const d2 = { date: '2026-10-23', revision: 'b', entries: [{ time: '02:00', content: 'y' }] };
    const p = page(d1);
    p.els['mem-recover'] = { innerHTML: '' };
    const fns = load<any>(
      [...EP_FNS, 'memKeepDraft', 'memRecover', 'paintRecover', 'memHold', 'esc', 'escAttr'],
      ['_epEditor'],
      {
        document: p.doc,
        _memDay: d1,
        fetch: vi.fn(async () => ({ ok: true, json: async () => d2 })),
        apiWrite: vi.fn(),
      },
    );
    fns.renderDay(0);
    p.edit().value = 'x, edited';
    p.els['mem-ep-new'].value = 'a note being written';
    await fns.loadDay('2026-10-23');
    expect(p.els['mem-ep-new'].value).toBe('a note being written');
    expect(p.els['mem-recover'].innerHTML).toContain('x, edited');
  });

  it('an episodic save answered after the hold expired closes only its own editor (review R11, fable)', async () => {
    const day = {
      date: '2026-10-23',
      revision: 't1',
      entries: [
        { time: '08:00', content: 'r0' },
        { time: '09:00', content: 'r1' },
      ],
    };
    const p = page(day);
    p.els['mem-recover'] = { innerHTML: '' };
    let answer: (v: unknown) => void = () => {};
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: day,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite: vi.fn(() => new Promise((res) => (answer = res))),
      refreshPageIndex: async () => {},
      paintDates: () => {},
    });
    fns.renderDay(0);
    p.edit().value = 'r0, edited';
    const saving = fns.epSave(0);
    fns.memHold.at = 0; // (defense: the holds are gone, review R11)
    (day as any).saving = 0;
    fns.renderDay(1);
    p.edit().value = 'r1, edited';
    answer({
      ok: true,
      data: {
        ok: true,
        day: {
          ...day,
          revision: 't2',
          entries: [
            { time: '08:00', content: 'r0, edited' },
            { time: '09:00', content: 'r1' },
          ],
        },
      },
    });
    await saving;
    expect(p.els['mem-ep-body'].innerHTML + p.els['mem-ep-new'].value + p.els['mem-recover'].innerHTML).toContain(
      'r1, edited',
    );
  });

  it('switching between two identical episodic records keeps the first draft (review R11, astra)', () => {
    const twin = { time: '09:00', content: 'same' };
    const day = { date: '2026-10-23', revision: 't1', entries: [twin, { ...twin }] };
    const p = page(day);
    p.els['mem-recover'] = { innerHTML: '' };
    const fns = load<any>(EP_FNS, ['_epEditor'], { document: p.doc, _memDay: day, apiWrite: vi.fn() });
    fns.renderDay(0);
    p.edit().value = 'first twin, edited';
    fns.renderDay(1);
    expect(p.els['mem-ep-new'].value + p.els['mem-recover'].innerHTML).toContain('first twin, edited');
  });

  it('a 409 whose reload fails still releases the hold and keeps the draft (review R12, fable)', async () => {
    const day = { date: '2026-10-23', revision: 't1', entries: [{ time: '09:00', content: 'r0' }] };
    const p = page(day);
    p.els['mem-recover'] = { innerHTML: '' };
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: day,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite: vi.fn(async () => ({ ok: false, status: 409, error: 'changed' })),
      fetch: vi.fn(async () => {
        throw new Error('network down');
      }),
      refreshPageIndex: async () => {},
      paintDates: () => {},
    });
    fns.renderDay(0);
    const box = p.edit();
    box.value = 'r0, edited';
    await fns.epSave(0).catch(() => {});
    expect(fns.memHold.at).toBe(0);
    expect(box.disabled).toBe(false);
    expect(
      p.els['mem-ep-body'].innerHTML + p.els['mem-ep-new'].value + p.els['mem-recover'].innerHTML + box.value,
    ).toContain('r0, edited');
  });

  it('cancelling an episodic editor waits while its save is out (review R12, fable)', async () => {
    const day = { date: '2026-10-23', revision: 't1', entries: [{ time: '09:00', content: 'r0' }] };
    const p = page(day);
    let answer: (v: unknown) => void = () => {};
    const fns = load<any>([...EP_FNS, 'epCancel'], ['_epEditor'], {
      document: p.doc,
      _memDay: day,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite: vi.fn(() => new Promise((res) => (answer = res))),
      refreshPageIndex: async () => {},
      paintDates: () => {},
    });
    fns.renderDay(0);
    p.edit().value = 'r0, edited';
    const saving = fns.epSave(0);
    fns.epCancel();
    expect(p.els['mem-ep-body'].innerHTML).toContain('id="ep-edit"');
    answer({ ok: false, status: 400, error: 'no' });
    await saving;
    expect(p.edit().value).toBe('r0, edited');
  });

  it('an episodic 409 holds the tab until its reload is done (review R11, astra)', async () => {
    const day = { date: '2026-10-23', revision: 't1', entries: [{ time: '09:00', content: 'r0' }] };
    const p = page(day);
    p.els['mem-recover'] = { innerHTML: '' };
    let reload: (v: unknown) => void = () => {};
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: day,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite: vi.fn(async () => ({ ok: false, status: 409, error: 'changed' })),
      fetch: vi.fn(() => new Promise((res) => (reload = res))),
      refreshPageIndex: async () => {},
      paintDates: () => {},
    });
    fns.renderDay(0);
    const box = p.edit();
    box.value = 'r0, edited';
    const saving = fns.epSave(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(box.disabled).toBe(true); // still locked while the day reloads
    reload({ ok: true, json: async () => ({ ...day, revision: 't2' }) });
    await saving;
    expect(p.els['mem-ep-body'].innerHTML).toContain('r0, edited');
  });

  it('switching days with an editor open moves its draft to the note box', async () => {
    const d1 = { date: '2026-10-22', revision: 'a', entries: [{ time: '01:00', content: 'x' }] };
    const d2 = { date: '2026-10-23', revision: 'b', entries: [{ time: '02:00', content: 'y' }] };
    const p = page(d1);
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: d1,
      fetch: vi.fn(async () => ({ ok: true, json: async () => d2 })),
      apiWrite: vi.fn(),
    });
    fns.renderDay(0);
    p.edit().value = 'x, edited';
    await fns.loadDay('2026-10-23');
    expect(p.els['mem-ep-new'].value).toBe('x, edited');
  });

  it('the episodic editor and the note box are locked while their write is out', async () => {
    const today = { date: '2026-10-23', revision: 't1', entries: [{ time: '08:00', content: 'A' }] };
    const p = page(today);
    let answer: (v: unknown) => void = () => {};
    const apiWrite = vi.fn().mockImplementation(() => new Promise((res) => (answer = res)));
    const fns = load<any>(EP_FNS, ['_epEditor'], {
      document: p.doc,
      _memDay: today,
      _mem: { episodicDates: ['2026-10-23'] },
      apiWrite,
      refreshPageIndex: async () => {},
      paintDates: () => {},
    });
    fns.renderDay(0);
    const box = p.edit();
    box.value = 'A sent';
    const saving = fns.epSave(0);
    expect(box.disabled).toBe(true);
    answer({ ok: false, status: 400, error: 'no' });
    await saving;
    expect(box.disabled).toBe(false);
    p.els['mem-ep-new'].value = 'note';
    const adding = fns.epAdd();
    expect(p.els['mem-ep-new'].disabled).toBe(true);
    await fns.epAdd(); // a double click sends nothing more
    expect(apiWrite).toHaveBeenCalledTimes(2);
    answer({ ok: false, status: 400, error: 'no' });
    await adding;
    expect(p.els['mem-ep-new'].disabled).toBe(false);
  });
});

describe('관찰 기록 (에피소딕) — the editor is bound to its day (review R6)', () => {
  it('a note added to today while a past day is being edited never retargets that editor', async () => {
    const body: any = { innerHTML: '' };
    const editBox: any = { value: 'OLD DAY EDITED' };
    const noteBox: any = { value: 'a note for today' };
    const status: any = { textContent: '', setAttribute() {} };
    const dateSel: any = { value: '2026-01-01', innerHTML: '' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-ep-body'
          ? body
          : id === 'ep-edit'
            ? editBox
            : id === 'mem-ep-new'
              ? noteBox
              : id === 'mem-ep-date'
                ? dateSel
                : status,
    };
    const pastDay = { date: '2026-01-01', revision: 'p1', entries: [{ time: '09:00', content: 'OLD DAY ORIGINAL' }] };
    const today = {
      date: '2026-10-23',
      revision: 't2',
      entries: [
        { time: '08:00', content: 'TODAY IMPORTANT ORIGINAL' },
        { time: '10:00', content: 'a note for today' },
      ],
    };
    let indexDone: () => void = () => {};
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { ok: true, day: today } }) // the note
      .mockResolvedValueOnce({ ok: true, data: { ok: true, day: pastDay } }); // the edit
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'renderDay',
        'epSave',
        'epWrite',
        'epAdd',
        'memStatus',
        'refreshDatesIfEmptied',
        'epBusy',
        'fillDateSelect',
        'openEpEditor',
        'reopenEpEditor',
        'repaintDay',
        'keepEpDraft',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'paintRecover',
        'epRecover409',
      ],
      ['_epEditor'],
      {
        document: doc,
        _memDay: pastDay,
        _mem: { episodicDates: ['2026-10-23', '2026-01-01'] },
        apiWrite,
        refreshPageIndex: () => new Promise<void>((res) => (indexDone = res)),
        paintDates: () => {},
        loadDay: async () => {},
      },
    );
    fns.renderDay(0); // the past day's record is open for editing
    const adding = fns.epAdd(); // a note goes to today; the list refresh is slow
    await Promise.resolve();
    await Promise.resolve();
    await fns.epSave(0); // the user saves the open editor in that window
    indexDone();
    await adding;
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/episodic/2026-01-01/0', {
      content: 'OLD DAY EDITED',
      revision: 'p1',
    });
  });
});

describe('관찰 기록 (에피소딕)', () => {
  it('a day shows entries with time, edit and delete; the edit sends the day revision', async () => {
    const el: any = { innerHTML: '' };
    const day = { date: '2026-10-20', revision: 'd1', entries: [{ time: '05:09', title: 'Ask', content: 'Ask: <x>' }] };
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'renderDay',
        'epBusy',
        'keepEpDraft',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'openEpEditor',
        'paintRecover',
      ],
      ['_epEditor'],
      {
        document: { getElementById: () => el },
        _memDay: day,
      },
    );
    fns.renderDay();
    expect(el.innerHTML).toContain('05:09 UTC');
    expect(el.innerHTML).toContain('Ask: &lt;x&gt;');
    expect(el.innerHTML).toContain('onclick="epDelete(0)"');

    const apiWrite = vi.fn(async () => ({ ok: true, data: { day: { ...day, revision: 'd2' } } }));
    const w = load<any>(
      [
        'epWrite',
        'epSave',
        'epDelete',
        'memStatus',
        'refreshDatesIfEmptied',
        'epBusy',
        'fillDateSelect',
        'openEpEditor',
        'reopenEpEditor',
        'repaintDay',
        'keepEpDraft',
        'esc',
        'escAttr',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'paintRecover',
        'epRecover409',
      ],
      [],
      {
        document: {
          getElementById: (id: string) =>
            id === 'ep-edit' ? { value: '고친 기록' } : { textContent: '', setAttribute() {} },
        },
        _memDay: day,
        // the editor renderDay(0) opened: bound to the day and revision it showed (review R6)
        _epEditor: { date: '2026-10-20', revision: 'd1', index: 0, time: '05:09', content: 'Ask: <x>' },
        apiWrite,
        renderDay: () => {},
        loadDay: async () => {},
        confirmDialog: async () => true,
        refreshPageIndex: async () => {},
        paintDates: () => {},
      },
    );
    await w.epSave(0);
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/memory/episodic/2026-10-20/0', {
      content: '고친 기록',
      revision: 'd1',
    });
  });

  it('after a 409 a draft never lands in ANOTHER entry: only where its original still is, else the note box (review R2 P1)', async () => {
    const renderDay = vi.fn();
    const noteBox: any = { value: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const w = load<any>(
      [
        'epWrite',
        'memStatus',
        'epBusy',
        'fillDateSelect',
        'openEpEditor',
        'reopenEpEditor',
        'repaintDay',
        'keepEpDraft',
        'esc',
        'escAttr',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'paintRecover',
        'epRecover409',
      ],
      ['_epEditor'],
      {
        document: { getElementById: (id: string) => (id === 'mem-ep-new' ? noteBox : status) },
        // the entry being edited ("A") was deleted elsewhere: index 0 is now "B"
        _memDay: { date: '2026-10-20', revision: 'd2', entries: [{ time: '02:00', content: 'B' }] },
        apiWrite: async () => ({ ok: false, status: 409, error: 'conflict' }),
        renderDay,
        loadDay: async () => {},
      },
    );
    await w.epWrite(
      'PUT',
      '/api/memory/episodic/2026-10-20/0',
      { content: 'A fixed', revision: 'd1' },
      'A fixed',
      0,
      'A',
    );
    expect(renderDay).not.toHaveBeenCalledWith(0, 'A fixed');
    expect(noteBox.value).toBe('A fixed');
  });

  it('after a 409 a draft for one of two identical records goes back to the one with its time, never the first match (review R3 P1)', async () => {
    const renderDay = vi.fn();
    const noteBox: any = { value: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const day = {
      date: '2026-10-20',
      revision: 'd2',
      entries: [
        { time: '01:00', content: 'same' },
        { time: '02:00', content: 'same' },
      ],
    };
    const w = load<any>(
      [
        'epWrite',
        'memStatus',
        'epBusy',
        'fillDateSelect',
        'openEpEditor',
        'reopenEpEditor',
        'repaintDay',
        'keepEpDraft',
        'esc',
        'escAttr',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'paintRecover',
        'epRecover409',
      ],
      ['_epEditor'],
      {
        document: { getElementById: (id: string) => (id === 'mem-ep-new' ? noteBox : status) },
        _memDay: day,
        apiWrite: async () => ({ ok: false, status: 409, error: 'conflict' }),
        renderDay,
        loadDay: async () => {},
      },
    );
    await w.epWrite(
      'PUT',
      '/api/memory/episodic/2026-10-20/1',
      { content: 'mine', revision: 'd1' },
      'mine',
      1,
      'same',
      '02:00',
    );
    expect(renderDay).toHaveBeenLastCalledWith(1, 'mine');
    // identical in time AND text: there is no telling them apart — the draft goes to the note box
    day.entries[0].time = '02:00';
    renderDay.mockClear();
    await w.epWrite(
      'PUT',
      '/api/memory/episodic/2026-10-20/1',
      { content: 'mine', revision: 'd1' },
      'mine',
      1,
      'same',
      '02:00',
    );
    expect(renderDay).not.toHaveBeenCalledWith(expect.anything(), 'mine');
    expect(noteBox.value).toBe('mine');
  });

  it('a delete sends the date, entry and revision the confirmation showed, even if the view moved meanwhile (review R3 P1)', async () => {
    const day: any = {
      date: '2026-10-20',
      revision: 'd20',
      entries: [{ time: '05:09', content: 'the 20th' }],
    };
    const apiWrite = vi.fn(async () => ({ ok: true, data: { day: { ...day, entries: [] } } }));
    const w = load<any>(
      [
        'epWrite',
        'epDelete',
        'memStatus',
        'refreshDatesIfEmptied',
        'epBusy',
        'fillDateSelect',
        'openEpEditor',
        'reopenEpEditor',
        'repaintDay',
        'keepEpDraft',
        'esc',
        'escAttr',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'paintRecover',
        'epRecover409',
      ],
      ['_epEditor'],
      {
        document: { getElementById: () => ({ textContent: '', setAttribute() {} }) },
        _memDay: day,
        _mem: { episodicDates: [] },
        apiWrite,
        renderDay: () => {},
        loadDay: async () => {},
        // while the dialog is open the date picker finished loading another day
        confirmDialog: async () => {
          Object.assign(day, {
            date: '2026-10-21',
            revision: 'd21',
            entries: [{ time: '07:00', content: 'the 21st' }],
          });
          return true;
        },
        refreshPageIndex: async () => {},
        paintDates: () => {},
      },
    );
    await w.epDelete(0);
    expect(apiWrite).toHaveBeenCalledWith('DELETE', '/api/memory/episodic/2026-10-20/0', { revision: 'd20' });
  });

  it('clear-all sends the revision of the stores on screen; page delete the one its dialog was about (review R3 P1)', async () => {
    // 모두 지우기 is the element's two-press confirm: the first press names the count, and data that changes the
    // count disarms it (memory-panel.test.ts "Clear all needs a second press that names the count"). ui-clear
    // then goes out with the revision of the stores the element was showing.
    const apiWrite = vi.fn(async () => ({ ok: true, data: { l1: block({ entries: [], revision: 'r9' }) } }));
    const { panel } = l1Env({ apiWrite });
    panel.fire('ui-clear', { store: 'memory' });
    await tick();
    expect(apiWrite).toHaveBeenLastCalledWith('DELETE', '/api/memory/l1/memory', { revision: 'r1' });

    const pageApi = vi.fn(async () => ({ ok: true, data: {} }));
    const memPage: any = { page: { id: 'concepts/a', title: 'A' }, revision: 'pa' };
    const w = load<any>(
      [
        'deletePage',
        'memStatus',
        'pageSaveBusy',
        'memHold',
        'setPageFieldsDisabled',
        'keepPageDraft',
        'pageUnsavedText',
        'pageDraft',
        'pageDraftText',
        'memRecover',
        'paintRecover',
      ],
      [],
      {
        document: { getElementById: () => ({ textContent: '', setAttribute() {}, innerHTML: '' }) },
        _memPage: memPage,
        apiWrite: pageApi,
        confirmDialog: async () => {
          Object.assign(memPage, { page: { id: 'concepts/b', title: 'B' }, revision: 'pb' });
          return true;
        },
        refreshPageIndex: async () => {},
        renderPageEditor: () => {},
        paintPageList: () => {},
      },
    );
    await w.deletePage();
    expect(pageApi).toHaveBeenCalledWith('DELETE', '/api/memory/page', { id: 'concepts/a', revision: 'pa' });
  });

  it('a 409 reloads the day the request was for, not the day the view moved to meanwhile (review R4)', async () => {
    const status: any = { textContent: '', setAttribute() {} };
    const loaded: string[] = [];
    const view: any = {
      date: '2026-10-20',
      revision: 'd1',
      entries: [{ time: '09:00', content: 'standup' }],
    };
    const days: Record<string, any> = {
      '2026-10-20': { date: '2026-10-20', revision: 'd2', entries: [{ time: '09:00', content: 'standup' }] },
      '2026-10-21': { date: '2026-10-21', revision: 'e1', entries: [{ time: '09:00', content: 'standup' }] },
    };
    const renderDay = vi.fn();
    let apiDone: (v: unknown) => void = () => {};
    const w = load<any>(
      [
        'epWrite',
        'memStatus',
        'epBusy',
        'fillDateSelect',
        'openEpEditor',
        'reopenEpEditor',
        'repaintDay',
        'keepEpDraft',
        'esc',
        'escAttr',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'paintRecover',
        'epRecover409',
      ],
      ['_epEditor'],
      {
        document: { getElementById: () => status },
        _memDay: view,
        apiWrite: () => new Promise((res) => (apiDone = res)),
        renderDay,
        loadDay: async (date: string) => {
          loaded.push(date);
          Object.assign(view, days[date]);
        },
      },
    );
    const pending = w.epWrite(
      'PUT',
      '/api/memory/episodic/2026-10-20/0',
      { content: '20th standup corrected', revision: 'd1' },
      '20th standup corrected',
      0,
      'standup',
      '09:00',
    );
    // the user opens the 21st while the request is in flight
    Object.assign(view, days['2026-10-21']);
    apiDone({ ok: false, status: 409, error: 'conflict' });
    expect(await pending).toBe(false);
    expect(loaded).toEqual(['2026-10-20']);
    // the draft goes back to the 20th's record, shown again; the 21st's look-alike is untouched
    expect(view.date).toBe('2026-10-20');
    expect(renderDay).toHaveBeenLastCalledWith(0, '20th standup corrected');
  });

  it('a 409 on a day reloads it and reopens the edit with the whole draft (review P1)', async () => {
    const loadDay = vi.fn(async () => {});
    const renderDay = vi.fn();
    const status: any = { textContent: '', setAttribute() {} };
    const long = '긴 기록 '.repeat(100);
    const w = load<any>(
      [
        'epWrite',
        'memStatus',
        'epBusy',
        'fillDateSelect',
        'openEpEditor',
        'reopenEpEditor',
        'repaintDay',
        'keepEpDraft',
        'esc',
        'escAttr',
        'memHold',
        'memKeepDraft',
        'memRecover',
        'paintRecover',
        'epRecover409',
      ],
      ['_epEditor'],
      {
        document: { getElementById: () => status },
        _memDay: {
          date: '2026-10-20',
          revision: 'd1',
          entries: [
            { time: '01:00', content: 'first' },
            { time: '02:00', content: 'second' },
          ],
        },
        apiWrite: async () => ({ ok: false, status: 409, error: 'conflict' }),
        renderDay,
        loadDay,
      },
    );
    expect(
      await w.epWrite('PUT', '/api/memory/episodic/2026-10-20/1', { content: long, revision: 'd1' }, long, 1, 'second'),
    ).toBe(false);
    expect(loadDay).toHaveBeenCalledWith('2026-10-20', true);
    expect(renderDay).toHaveBeenLastCalledWith(1, long);
    expect(status.textContent).toContain('편집 칸에 그대로');
  });

  it('a page 409 keeps the editor as typed and offers overwrite with the newer revision (review P1)', async () => {
    const conflictBox: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const values: Record<string, string> = {
      'pg-title': 'My title',
      'pg-aliases': 'a',
      'pg-current': 'my long current',
    };
    const doc = {
      getElementById: (id: string) =>
        id === 'pg-conflict' ? conflictBox : id in values ? { value: values[id] } : status,
      querySelectorAll: () => [{ value: '2026-10-23: mine' }],
    };
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'conflict' })
      .mockResolvedValueOnce({ ok: true, data: { page: { id: 'concepts/ssot' }, revision: 'p3' } });
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        page: { id: 'concepts/ssot', updated: '2026-10-23', current: 'agent wrote this' },
        revision: 'p2',
      }),
    }));
    const renderPageEditor = vi.fn();
    const openPage = vi.fn();
    const fns = load<any>(
      [
        'esc',
        'pageDraft',
        'savePage',
        'memStatus',
        'renderPageConflict',
        'overwritePage',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageDraftText',
        'pageConflict409',
      ],
      ['_memPageConflict', '_memPageRaw'],
      {
        document: doc,
        fetch,
        _memPage: { page: { id: 'concepts/ssot' }, revision: 'p1' },
        apiWrite,
        refreshPageIndex: async () => {},
        renderPageEditor,
        openPage,
      },
    );
    await fns.savePage();
    expect(openPage).not.toHaveBeenCalled();
    expect(conflictBox.innerHTML).toContain('내 수정본으로 덮어쓰기');
    expect(conflictBox.innerHTML).toContain('agent wrote this');
    await fns.overwritePage();
    expect(apiWrite).toHaveBeenLastCalledWith(
      'PUT',
      '/api/memory/page',
      expect.objectContaining({ current: 'my long current', title: 'My title', revision: 'p2' }),
    );
  });

  it('after a 409 and overwrite, the raw editor starts from the latest page, never the stale one (review R4)', async () => {
    const conflictBox: any = { innerHTML: '' };
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const values: Record<string, string> = { 'pg-title': 'Mine', 'pg-aliases': '', 'pg-current': 'my current' };
    const doc = {
      getElementById: (id: string) =>
        id === 'pg-conflict'
          ? conflictBox
          : id === 'mem-page-detail'
            ? detail
            : id in values
              ? { value: values[id] }
              : status,
      querySelectorAll: () => [],
    };
    const memPage: any = {
      page: { id: 'concepts/race', title: 'T', aliases: [], current: 'v1', history: [], updated: '2026-10-23' },
      revision: 'p1',
      raw: 'STALE RAW v1\n',
      representable: true,
    };
    // Meanwhile the agent added a sub-heading: the latest page no longer fits the form.
    const latest = {
      page: { ...memPage.page, current: 'v2' },
      revision: 'p2',
      raw: 'LATEST RAW v2\n## Details\nagent text\n',
      representable: false,
    };
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'conflict' })
      .mockResolvedValueOnce({ ok: false, status: 400, error: '원문(markdown)으로 고치세요' });
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'savePage',
        'memStatus',
        'renderPageConflict',
        'overwritePage',
        'renderPageEditor',
        'pageRawMode',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageDraftText',
        'keepPageDraft',
        'memRecover',
        'pageUnsavedText',
        'paintRecover',
        'pageConflict409',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        fetch: vi.fn(async () => ({ ok: true, json: async () => latest })),
        _memPage: memPage,
        apiWrite,
        refreshPageIndex: async () => {},
        openPage: vi.fn(),
      },
    );
    await fns.savePage();
    await fns.overwritePage();
    // the overwrite went out on the form path the user was editing in, with the newer revision
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/page', expect.objectContaining({ revision: 'p2' }));
    // the server refused it (the latest page needs raw editing); raw mode shows the latest bytes
    fns.pageRawMode(true);
    expect(detail.innerHTML).toContain('LATEST RAW v2');
    expect(detail.innerHTML).not.toContain('STALE RAW');
  });

  it('a save answer that arrives after another page was opened never retargets the open editor (review R5)', async () => {
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    // what the editor shows: page B, as the user typed into it
    const values: Record<string, string> = { 'pg-title': 'B title', 'pg-aliases': '', 'pg-current': 'b user edit' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? detail : id in values ? { value: values[id] } : { innerHTML: '', ...status },
      querySelectorAll: () => [],
    };
    const pageA = { id: 'concepts/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    const pageB = { id: 'concepts/b', title: 'B', aliases: [], current: 'b', history: [], updated: '2026-10-23' };
    let answerA: (v: unknown) => void = () => {};
    const apiWrite = vi
      .fn()
      .mockImplementationOnce(() => new Promise((res) => (answerA = res)))
      .mockResolvedValue({
        ok: true,
        data: { ok: true, page: pageB, revision: 'b2', raw: '# B\n', representable: true },
      });
    const pendingIndex: Array<() => void> = [];
    const editorA: any = { page: pageA, revision: 'a1', raw: '# A\n', representable: true };
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'savePage',
        'memStatus',
        'renderPageConflict',
        'renderPageEditor',
        'openPage',
        'pageAnswerElsewhere',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageDraftText',
        'memRecover',
        'paintRecover',
        'keepPageDraft',
        'pageUnsavedText',
        'pageConflict409',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: editorA,
        apiWrite,
        fetch: vi.fn(async () => ({
          ok: true,
          json: async () => ({ page: pageB, revision: 'b1', raw: '# B\n', representable: true }),
        })),
        refreshPageIndex: () => new Promise<void>((res) => pendingIndex.push(res)),
        paintPageList: () => {},
      },
    );
    const savingA = fns.savePage(); // the save of A goes out ...
    editorA.saving = 0; // ... (defense: the holds are gone — the UI never releases them before the answer, review R11) ...
    fns.memHold.at = 0;
    await fns.openPage('concepts/b'); // ... and the user opens B before it is answered
    answerA({
      ok: true,
      data: { ok: true, page: { ...pageA, title: 'A' }, revision: 'a2', raw: '# A\n', representable: true },
    });
    await Promise.resolve();
    await Promise.resolve();
    // while the page list refreshes, the user saves B
    const savingB = fns.savePage();
    // let both saves finish: every page-list refresh completes
    for (let k = 0; k < 10; k++) {
      while (pendingIndex.length) pendingIndex.shift()?.();
      await Promise.resolve();
    }
    await Promise.all([savingA, savingB]);
    expect(apiWrite).toHaveBeenLastCalledWith(
      'PUT',
      '/api/memory/page',
      expect.objectContaining({ id: 'concepts/b', revision: 'b1', current: 'b user edit' }),
    );
    expect(detail.innerHTML).not.toContain('concepts/a');
  });

  it('replacing a page editor that has unsaved changes keeps them in the recovery box (review R12, fable)', async () => {
    let detailHtml = '';
    const recover: any = { innerHTML: '' };
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const values: Record<string, string> = { 'pg-title': 'A', 'pg-aliases': '', 'pg-current': 'A CURRENT, EDITED' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail'
          ? {
              set innerHTML(v: string) {
                detailHtml = v;
              },
              get innerHTML() {
                return detailHtml;
              },
            }
          : id === 'mem-recover'
            ? recover
            : id in values && detailHtml.includes('id="' + id + '"')
              ? { value: values[id] }
              : id === 'pg-raw' || id in values
                ? null
                : status,
      querySelectorAll: () => [],
    };
    const pageA = { id: 'concepts/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    const pageB = { id: 'concepts/b', title: 'B', aliases: [], current: 'b', history: [], updated: '2026-10-23' };
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'openPage',
        'newPageForm',
        'pageRawMode',
        'renderPageEditor',
        'renderPageConflict',
        'memStatus',
        'pageSaveBusy',
        'memHold',
        'pageDraft',
        'pageDraftText',
        'pageUnsavedText',
        'memRecover',
        'paintRecover',
        'keepPageDraft',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'a1', raw: '# A\n', representable: true },
        fetch: vi.fn(async () => ({
          ok: true,
          json: async () => ({ page: pageB, revision: 'b1', raw: '# B\n', representable: true }),
        })),
        paintPageList: () => {},
      },
    );
    fns.pageRawMode(false); // renders A's form
    await fns.openPage('concepts/b');
    expect(recover.innerHTML).toContain('A CURRENT, EDITED');
  });

  it('a page delete closes only the editor it was confirmed for; the latest page opened wins (review R9, astra)', async () => {
    let detailHtml = '';
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail'
          ? {
              set innerHTML(v: string) {
                detailHtml = v;
              },
              get innerHTML() {
                return detailHtml;
              },
            }
          : status,
      querySelectorAll: () => [],
    };
    const pageA = { id: 'concepts/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    const pageB = { id: 'concepts/b', title: 'B', aliases: [], current: 'b', history: [], updated: '2026-10-23' };
    const pageC = { id: 'concepts/c', title: 'C', aliases: [], current: 'c', history: [], updated: '2026-10-23' };
    const got: Record<string, (v: unknown) => void> = {};
    const fetchMock = vi.fn(
      (url: string) => new Promise((res) => (got[decodeURIComponent(url.split('id=')[1])] = res)),
    );
    let confirm: (v: boolean) => void = () => {};
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'deletePage',
        'openPage',
        'renderPageEditor',
        'renderPageConflict',
        'memStatus',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'keepPageDraft',
        'memRecover',
        'pageDraft',
        'pageDraftText',
        'pageUnsavedText',
        'paintRecover',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'a1', raw: '# A\n', representable: true },
        apiWrite: vi.fn(async () => ({ ok: true, data: { ok: true } })),
        fetch: fetchMock,
        confirmDialog: () => new Promise<boolean>((res) => (confirm = res)),
        refreshPageIndex: async () => {},
        paintPageList: () => {},
      },
    );
    const opening = fns.openPage('concepts/b'); // B's GET goes out ...
    const deleting = fns.deletePage(); // ... the dialog for A opens ...
    got['concepts/b']({
      ok: true,
      json: async () => ({ page: pageB, revision: 'b1', raw: '# B\n', representable: true }),
    });
    await opening; // ... and B opens behind it
    confirm(true);
    await deleting;
    expect(detailHtml).toContain('concepts/b'); // A's delete leaves B open
    // two opens in a row: the later one wins even if the earlier answers last
    const c = fns.openPage('concepts/c');
    const a = fns.openPage('concepts/a');
    got['concepts/a']({
      ok: true,
      json: async () => ({ page: pageA, revision: 'a2', raw: '# A\n', representable: true }),
    });
    await a;
    got['concepts/c']({
      ok: true,
      json: async () => ({ page: pageC, revision: 'c1', raw: '# C\n', representable: true }),
    });
    await c;
    expect(detailHtml).toContain('concepts/a');
  });

  it('a page save holds the tab until it is answered, however long that takes (review R11, grok)', async () => {
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const values: Record<string, string> = { 'pg-title': 'A', 'pg-aliases': '', 'pg-current': 'FIRST DRAFT' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? detail : id in values ? { value: values[id] } : status,
      querySelectorAll: () => [],
    };
    const pageA = { id: 'agent/x', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    const editor: any = { page: pageA, revision: 'p1', raw: '# A\n', representable: true };
    const apiWrite = vi.fn(() => new Promise(() => {}));
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'savePage',
        'memStatus',
        'renderPageConflict',
        'renderPageEditor',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageDraftText',
        'pageConflict409',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: editor,
        apiWrite,
        fetch: vi.fn(),
        refreshPageIndex: async () => {},
        paintPageList: () => {},
      },
    );
    void fns.savePage();
    // a minute later, still unanswered
    fns.memHold.at = Date.now() - 60_000;
    editor.saving = Date.now() - 60_000;
    await fns.savePage();
    expect(apiWrite).toHaveBeenCalledTimes(1);
  });

  it('a page 409 holds the tab until the newer version is loaded (review R12, grok)', async () => {
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const fields = [{ disabled: false }];
    const values: Record<string, string> = { 'pg-title': 'A', 'pg-aliases': '', 'pg-current': 'FORM DRAFT' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? detail : id in values ? { value: values[id] } : status,
      querySelectorAll: (sel: string) => (sel.includes('pg-history') ? [] : fields),
    };
    const pageA = { id: 'agent/x', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    let latest: (v: unknown) => void = () => {};
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'pageDraftText',
        'savePage',
        'memStatus',
        'renderPageConflict',
        'renderPageEditor',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageRawMode',
        'keepPageDraft',
        'pageUnsavedText',
        'memRecover',
        'paintRecover',
        'pageConflict409',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'p1', raw: 'STALE RAW BYTES', representable: true },
        apiWrite: vi.fn(async () => ({ ok: false, status: 409, error: 'changed' })),
        fetch: vi.fn(() => new Promise((res) => (latest = res))),
        refreshPageIndex: async () => {},
        paintPageList: () => {},
      },
    );
    const saving = fns.savePage();
    await Promise.resolve();
    await Promise.resolve();
    // the newer version is being loaded: still held
    expect(fns.memHold.at).not.toBe(0);
    expect(fields[0].disabled).toBe(true);
    fns.pageRawMode(true);
    expect(detail.innerHTML).not.toContain('STALE RAW BYTES');
    latest({
      ok: true,
      json: async () => ({ page: { ...pageA, current: 'agent' }, revision: 'p2', raw: '# newer', representable: true }),
    });
    await saving;
    expect(fns.memHold.at).toBe(0);
    expect(fields[0].disabled).toBe(false);
  });

  it('"내 수정 버림" holds the tab until the latest is loaded; a new page opened before cannot be overwritten (review R13, astra)', async () => {
    let detailHtml = '';
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const fields = [{ disabled: false }];
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail'
          ? {
              set innerHTML(v: string) {
                detailHtml = v;
              },
              get innerHTML() {
                return detailHtml;
              },
            }
          : status,
      querySelectorAll: () => fields,
    };
    const pageA = { id: 'agent/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    let latest: (v: unknown) => void = () => {};
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'discardPageDraft',
        'openPage',
        'newPageForm',
        'renderPageEditor',
        'renderPageConflict',
        'memStatus',
        'pageSaveBusy',
        'memHold',
        'setPageFieldsDisabled',
        'keepPageDraft',
        'pageUnsavedText',
        'pageDraft',
        'pageDraftText',
        'memRecover',
        'paintRecover',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'a1', raw: '# A\n', representable: true },
        fetch: vi.fn(() => new Promise((res) => (latest = res))),
        paintPageList: () => {},
      },
    );
    const discarding = fns.discardPageDraft();
    expect(fields[0].disabled).toBe(true);
    fns.newPageForm(); // waits
    expect(status.textContent).toContain('저장 중');
    latest({
      ok: true,
      json: async () => ({ page: { ...pageA, current: 'latest' }, revision: 'a2', raw: '# A2\n', representable: true }),
    });
    await discarding;
    expect(fns.memHold.at).toBe(0);
    expect(detailHtml).toContain('agent/a');
  });

  it('opening a new page drops an answer still out for a page opened before (review R13, astra)', async () => {
    let detailHtml = '';
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail'
          ? {
              set innerHTML(v: string) {
                detailHtml = v;
              },
              get innerHTML() {
                return detailHtml;
              },
            }
          : status,
      querySelectorAll: () => [],
    };
    const pageB = { id: 'agent/b', title: 'B', aliases: [], current: 'b', history: [], updated: '2026-10-23' };
    let got: (v: unknown) => void = () => {};
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'openPage',
        'newPageForm',
        'renderPageEditor',
        'renderPageConflict',
        'memStatus',
        'pageSaveBusy',
        'memHold',
        'keepPageDraft',
        'pageUnsavedText',
        'pageDraft',
        'pageDraftText',
        'memRecover',
        'paintRecover',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      { document: doc, _memPage: null, fetch: vi.fn(() => new Promise((res) => (got = res))), paintPageList: () => {} },
    );
    const opening = fns.openPage('agent/b');
    fns.newPageForm();
    got({ ok: true, json: async () => ({ page: pageB, revision: 'b1', raw: '# B\n', representable: true }) });
    await opening;
    expect(detailHtml).toContain('새 페이지');
    expect(detailHtml).not.toContain('agent/b');
  });

  it('a page delete locks the editor until it is answered; a refused delete unlocks it (review R14, astra)', async () => {
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const fields = [{ disabled: false }];
    const doc = {
      getElementById: (id: string) => (id === 'mem-page-detail' ? detail : status),
      querySelectorAll: () => fields,
    };
    const pageA = { id: 'agent/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    let answer: (v: unknown) => void = () => {};
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'deletePage',
        'renderPageEditor',
        'memStatus',
        'pageSaveBusy',
        'memHold',
        'setPageFieldsDisabled',
        'keepPageDraft',
        'pageUnsavedText',
        'pageDraft',
        'pageDraftText',
        'memRecover',
        'paintRecover',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'a1', raw: '# A\n', representable: true },
        apiWrite: vi.fn(() => new Promise((res) => (answer = res))),
        confirmDialog: async () => true,
        refreshPageIndex: async () => {},
        paintPageList: () => {},
      },
    );
    const deleting = fns.deletePage();
    await Promise.resolve();
    await Promise.resolve();
    expect(fields[0].disabled).toBe(true); // nothing can be typed while the delete is out
    answer({ ok: false, status: 409, error: 'changed' });
    await deleting;
    expect(fields[0].disabled).toBe(false);
  });

  it('a deleted page keeps its unsaved changes in the recovery box; the fields lock before the dialog (review R15, grok)', async () => {
    let detailHtml = '';
    const recover: any = { innerHTML: '' };
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const fields = [{ disabled: false }];
    const values: Record<string, string> = { 'pg-title': 'A', 'pg-aliases': '', 'pg-current': 'UNSAVED BEFORE DELETE' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail'
          ? {
              set innerHTML(v: string) {
                detailHtml = v;
              },
              get innerHTML() {
                return detailHtml;
              },
            }
          : id === 'mem-recover'
            ? recover
            : id in values && detailHtml.includes('id="' + id + '"')
              ? { value: values[id] }
              : id === 'pg-raw' || id in values
                ? null
                : status,
      querySelectorAll: (sel: string) => (sel.includes('pg-history') ? [] : fields),
    };
    const pageA = { id: 'agent/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    let lockedAtDialog = false;
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'deletePage',
        'renderPageEditor',
        'renderPageConflict',
        'memStatus',
        'pageSaveBusy',
        'memHold',
        'setPageFieldsDisabled',
        'pageRawMode',
        'keepPageDraft',
        'pageUnsavedText',
        'pageDraft',
        'pageDraftText',
        'memRecover',
        'paintRecover',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'a1', raw: '# A\n', representable: true },
        apiWrite: vi.fn(async () => ({ ok: true, data: { ok: true } })),
        confirmDialog: async () => {
          lockedAtDialog = fields[0].disabled;
          return true;
        },
        refreshPageIndex: async () => {},
        paintPageList: () => {},
      },
    );
    fns.pageRawMode(false); // A's form, with the unsaved Current
    await fns.deletePage();
    expect(lockedAtDialog).toBe(true);
    expect(recover.innerHTML).toContain('UNSAVED BEFORE DELETE');
  });

  it('a History line can be removed only when no save is out (review R14, astra)', () => {
    const status: any = { textContent: '', setAttribute() {} };
    const row: any = {
      removed: false,
      remove() {
        this.removed = true;
      },
    };
    const fns = load<any>(['removeHistoryLine', 'pageSaveBusy', 'memHold', 'memStatus'], [], {
      document: { getElementById: () => status },
      _memPage: { page: { id: 'agent/a' }, saving: Date.now() },
    });
    fns.memHold.at = Date.now();
    fns.removeHistoryLine({ parentNode: row });
    expect(row.removed).toBe(false);
    fns.memHold.at = 0;
    fns.removeHistoryLine({ parentNode: row });
    expect(row.removed).toBe(false); // the page's own save is still out
  });

  it('a refused page answer for an editor no longer open keeps its draft in the recovery box (review R11, grok)', async () => {
    const recover: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const fns = load<any>(['pageAnswerElsewhere', 'memStatus', 'memRecover', 'paintRecover', 'esc', 'escAttr'], [], {
      document: { getElementById: (id: string) => (id === 'mem-recover' ? recover : status) },
      refreshPageIndex: async () => {},
    });
    await fns.pageAnswerElsewhere({ ok: false, status: 409, error: 'changed' }, 'agent/x', 'FIRST DRAFT');
    expect(recover.innerHTML).toContain('FIRST DRAFT');
  });

  it('while a page save is in flight, a second save and a switch to another page wait (review R6)', async () => {
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', innerHTML: '', setAttribute() {} };
    const values: Record<string, string> = { 'pg-title': 'A', 'pg-aliases': '', 'pg-current': 'a draft' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? detail : id in values ? { value: values[id] } : status,
      querySelectorAll: () => [],
    };
    const pageA = { id: 'concepts/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    let answer: (v: unknown) => void = () => {};
    const apiWrite = vi.fn().mockImplementationOnce(() => new Promise((res) => (answer = res)));
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'savePage',
        'savePageRaw',
        'memStatus',
        'renderPageConflict',
        'renderPageEditor',
        'openPage',
        'newPageForm',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageDraftText',
        'keepPageDraft',
        'memRecover',
        'pageUnsavedText',
        'paintRecover',
        'pageConflict409',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'a1', raw: '# A\n', representable: true },
        apiWrite,
        fetch: fetchMock,
        refreshPageIndex: async () => {},
        paintPageList: () => {},
      },
    );
    const first = fns.savePage();
    await fns.savePage(); // a double click
    await fns.savePageRaw();
    expect(apiWrite).toHaveBeenCalledTimes(1);
    await fns.openPage('concepts/b'); // the user clicks another page
    fns.newPageForm();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status.textContent).toContain('저장 중');
    answer({
      ok: true,
      data: { ok: true, page: { ...pageA, current: 'a draft' }, revision: 'a2', raw: '# A\n', representable: true },
    });
    await first;
    // once answered, the next save goes out on the saved revision
    apiWrite.mockResolvedValueOnce({
      ok: true,
      data: { ok: true, page: pageA, revision: 'a3', raw: '# A\n', representable: true },
    });
    await fns.savePage();
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/page', expect.objectContaining({ revision: 'a2' }));
  });

  it('a successful form save keeps the saved raw markdown for a later switch to raw editing (review R4)', async () => {
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const values: Record<string, string> = { 'pg-title': 'T', 'pg-aliases': '', 'pg-current': 'v2' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? detail : id in values ? { value: values[id] } : { innerHTML: '', ...status },
      querySelectorAll: () => [],
    };
    const page = { id: 'concepts/kept', title: 'T', aliases: [], current: 'v2', history: [], updated: '2026-10-23' };
    const apiWrite = vi.fn().mockResolvedValueOnce({
      ok: true,
      data: { ok: true, page, revision: 'p2', raw: 'SAVED RAW v2\n', representable: true },
    });
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'savePage',
        'memStatus',
        'renderPageConflict',
        'renderPageEditor',
        'pageRawMode',
        'pageSaveBusy',
        'setPageFieldsDisabled',
        'memHold',
        'pageDraftText',
        'keepPageDraft',
        'memRecover',
        'pageUnsavedText',
        'paintRecover',
        'pageConflict409',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: { ...page, current: 'v1' }, revision: 'p1', raw: 'OLD RAW v1\n', representable: true },
        apiWrite,
        refreshPageIndex: async () => {},
      },
    );
    await fns.savePage();
    fns.pageRawMode(true);
    expect(detail.innerHTML).toContain('SAVED RAW v2');
  });
});
