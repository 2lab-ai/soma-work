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
    expect(html).toContain('<div slot="memory" data-tab="memory" class="page" hidden>');
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
    expect(uiLibTokensCss()).toMatch(
      /:root, \[data-theme="light"\] \{[^}]*--ui-yellow: #[0-9a-f]{6};[^}]*--ui-st-wait: #[0-9a-f]{6};/,
    );
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
  });

  it('지식 페이지 and 관찰 기록 are the library elements too (M-05, M-06): no inline list, editor or day view', async () => {
    const html = renderSettingsPage();
    const { UI_LIB_VERSION, uiLibDistDir } = await import('../ui-lib');
    expect(html).toContain(
      '<div class="ui-tok"><ui-knowledge-pages id="kp-panel" lang="ko"></ui-knowledge-pages></div>',
    );
    expect(html).toContain('<div class="ui-tok"><ui-episode-log id="ep-log" lang="ko"></ui-episode-log></div>');
    for (const file of ['knowledge-pages.js', 'episode-log.js']) {
      expect(html).toContain(`<script type="module" src="/dashboard/ui/${file}?v=${UI_LIB_VERSION}"></script>`);
      expect(existsSync(join(uiLibDistDir() as string, file))).toBe(true);
    }
    for (const gone of [
      'id="mem-page-list"',
      'id="mem-page-detail"',
      'id="mem-ep-body"',
      'id="mem-ep-new"',
      '.pages-grid',
      '.ep-entry',
      'renderDay',
      'renderPageEditor',
    ]) {
      expect(html, gone).not.toContain(gone);
    }
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
    paintPages: () => {},
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
      paintPages: () => {},
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
      paintPages: () => {},
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

// ── 지식 페이지 = <ui-knowledge-pages>, 관찰 기록 = <ui-episode-log> (@2lab.ai/ui) — the host glue ──
// The elements' list, search, editor, drafts kept across updates, the switch guard, the conflict's Reload /
// Overwrite, the two-press delete, the day filter and the note box are pinned by the library's
// knowledge-pages.test.ts and episode-log.test.ts. Here: the data each is handed, where each write event goes
// (route, revision), one memory write at a time, 409s, and the element's source mode (the whole markdown) for a page
// the form cannot hold (D7 M-05).
const KP_FNS = [
  'kpHistoryIn',
  'kpHistoryOut',
  'kpPage',
  'paintPages',
  'kpOnEvent',
  'kpOpen',
  'kpNewId',
  'kpSave',
  'kpConflict',
  'kpDelete',
  'kpDeleteWrite',
  'refreshPageIndex',
];
const EP_FNS = [
  'epToday',
  'epDates',
  'epDay',
  'paintEpisodes',
  'paintDates',
  'epDatesChanged',
  'loadDay',
  'epOnEvent',
  'epWrite',
  'epTakeDay',
  'epAdd',
];
const MEM_FNS = ['memStatus', 'memHold', 'esc', 'escAttr', ...KP_FNS, ...EP_FNS];
const MEM_VARS = ['PAGE_GROUPS', 'KP_EVENTS', 'KP_GROUPS', '_kp', 'EP_EVENTS', '_ep'];

const INDEX = [
  { id: 'agent/review', type: 'agent', title: '리뷰', aliases: ['review'], updated: '2026-10-29' },
  { id: 'concepts/tokens', type: 'concepts', title: 'Tokens', aliases: [], updated: '2026-10-20' },
];
function pageAnswer(over: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    page: {
      id: 'agent/review',
      type: 'agent',
      title: '리뷰',
      aliases: ['review'],
      updated: '2026-10-29',
      current: 'Read the diff first.',
      history: ['2026-10-29: first version', 'a line without a date'],
      ...over,
    },
    revision: 'r1',
    raw: '# 리뷰\n',
    representable: true,
    ...rest,
  };
}
function dayAnswer(date: string, entries: string[], revision = `d-${date}`) {
  return { date, revision, entries: entries.map((content, i) => ({ time: `0${i}:00`, title: '', content })) };
}
type Answer = { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;
/** fetch for GET: `route(url)` answers; a pending promise holds the answer. */
function fakeFetch(route: (url: string) => Answer) {
  return vi.fn(async (url: string) => {
    const a = await route(url);
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.body };
  });
}
function memEnv(
  opts: { fetch?: any; apiWrite?: any; mem?: any; confirm?: boolean; epDays?: Record<string, unknown> } = {},
) {
  const kp = fakePanel();
  const ep = fakePanel();
  const els: Record<string, any> = {
    'kp-panel': kp,
    'ep-log': ep,
    'mem-status': { textContent: '', className: '', setAttribute: vi.fn() },
  };
  const mem = opts.mem ?? { l1: {}, pages: INDEX.slice(), episodicDates: ['2026-10-30', '2026-10-29'] };
  const days = opts.epDays ?? {
    '2026-10-30': dayAnswer('2026-10-30', ['first', 'second']),
    '2026-10-29': dayAnswer('2026-10-29', ['older']),
  };
  const fetch =
    opts.fetch ??
    fakeFetch((url) => {
      if (url === '/api/memory') return { body: mem };
      if (url.startsWith('/api/memory/page?id=')) return { body: pageAnswer() };
      const d = /\/api\/memory\/episodic\/([^/]+)$/.exec(url);
      if (d) return { body: days[decodeURIComponent(d[1])] ?? {} };
      return { status: 404, body: { error: 'nope' } };
    });
  const confirmDialog = vi.fn(async () => opts.confirm ?? true);
  const apiWrite = opts.apiWrite ?? vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } }));
  const fns = load<any>(MEM_FNS, MEM_VARS, {
    document: { getElementById: (id: string) => els[id] ?? null, querySelectorAll: () => [] },
    _mem: mem,
    apiWrite,
    fetch,
    confirmDialog,
  });
  fns.paintPages(); // binds the elements' events, as loadMemory's first paint does
  fns.paintEpisodes();
  return { fns, kp, ep, els, mem, fetch, apiWrite, confirmDialog, status: els['mem-status'] };
}

describe('지식 페이지 — the data <ui-knowledge-pages> is given', () => {
  it('the index as the list (group = page type, in the tab’s group order); the open page with its revision', async () => {
    const { fns, kp } = memEnv();
    fns.paintPages();
    expect(kp.data.groups.map((g: any) => g.id)).toEqual(['agent', 'sites', 'concepts', 'project', 'cron']);
    expect(kp.data.pages[0]).toEqual({
      id: 'agent/review',
      title: '리뷰',
      aliases: ['review'],
      group: 'agent',
      updatedAt: '2026-10-29',
    });
    expect(kp.data.selected).toBe(null);
    expect(kp.data.page).toBe(null);
    kp.fire('ui-select', { id: 'agent/review' });
    expect(kp.data.loading).toBe(true);
    expect(kp.data.selected).toBe('agent/review');
    await tick();
    expect(kp.data.loading).toBe(false);
    expect(kp.data.page).toMatchObject({
      id: 'agent/review',
      group: 'agent',
      current: 'Read the diff first.',
      revision: 'r1',
    });
    // D7 (M-05): every page carries its whole markdown for the element's source mode; a form-sized page is not sourceOnly.
    expect(kp.data.page.source).toBe('# 리뷰\n');
    expect(kp.data.page.sourceOnly).toBeUndefined();
    expect(kp.data.readOnly).toBeUndefined();
  });

  it('History lines are the store’s "YYYY-MM-DD: text" bullets, both ways, byte for byte', () => {
    const { fns } = memEnv();
    for (const line of ['2026-10-29: first version', 'a line without a date', '2026-10-29:no space', '2026-10-29: ']) {
      expect(fns.kpHistoryOut(fns.kpHistoryIn(line))).toBe(line.trimEnd() === line ? line : '2026-10-29');
    }
    expect(fns.kpHistoryIn('2026-10-29: first version')).toEqual({ date: '2026-10-29', text: 'first version' });
    expect(fns.kpHistoryIn('a line without a date')).toEqual({ date: '', text: 'a line without a date' });
  });

  it('only the latest page opened is shown: an earlier one answering last is dropped (review R9)', async () => {
    const holds: Record<string, (v: Answer) => void> = {};
    const fetch = fakeFetch((url) => new Promise((res) => (holds[url] = res as any)));
    const { kp } = memEnv({ fetch });
    kp.fire('ui-select', { id: 'agent/review' });
    kp.fire('ui-select', { id: 'concepts/tokens' });
    holds['/api/memory/page?id=concepts%2Ftokens']({ body: pageAnswer({ id: 'concepts/tokens', type: 'concepts' }) });
    await tick();
    holds['/api/memory/page?id=agent%2Freview']({ body: pageAnswer() });
    await tick();
    expect(kp.data.selected).toBe('concepts/tokens');
    expect(kp.data.page.id).toBe('concepts/tokens');
  });
});

describe('지식 페이지 — writes', () => {
  it('ui-save sends the whole page with the revision it was loaded with; the answer is the new page', async () => {
    const saved = pageAnswer({ current: 'Read the tests too.' }, { revision: 'r2' });
    const apiWrite = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, ...saved } }));
    const { kp, fetch } = memEnv({ apiWrite });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    const e = kp.fire('ui-save', {
      id: 'agent/review',
      title: '리뷰',
      aliases: ['review'],
      group: 'agent',
      current: 'Read the tests too.',
      history: [
        { date: '2026-10-31', text: 'tests' },
        { date: '', text: 'a line without a date' },
      ],
      revision: 'r1',
    });
    expect(e.defaultPrevented).toBe(false);
    expect(kp.data.saving).toBe(true);
    await tick();
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/memory/page', {
      id: 'agent/review',
      title: '리뷰',
      aliases: ['review'],
      current: 'Read the tests too.',
      history: ['2026-10-31: tests', 'a line without a date'],
      revision: 'r1',
    });
    await tick();
    expect(kp.data).toMatchObject({ saving: false, status: '저장했습니다', error: '', conflict: '' });
    expect(kp.data.page).toMatchObject({ current: 'Read the tests too.', revision: 'r2' });
    expect(fetch).toHaveBeenCalledWith('/api/memory'); // the index again (title, updated)
  });

  it('a new page is created with revision null under <group>/<name from the title>, never an id the index has', async () => {
    const apiWrite = vi.fn(async (_m: string, _u: string, body: any) => ({
      ok: true,
      status: 200,
      data: { ok: true, ...pageAnswer({ id: body.id, type: 'agent', title: body.title }, { revision: 'n1' }) },
    }));
    const { fns, kp } = memEnv({ apiWrite });
    expect(fns.kpNewId('agent', 'Release Checklist!')).toBe('agent/release-checklist');
    expect(fns.kpNewId('agent', '리뷰')).toMatch(/^agent\/page-[a-z0-9]+$/);
    expect(fns.kpNewId('nope', 'x')).toBe('agent/x');
    expect(fns.kpNewId('agent', 'Review')).toBe('agent/review-2'); // agent/review is taken
    kp.fire('ui-new', {});
    kp.fire('ui-save', {
      id: null,
      title: 'Release Checklist',
      aliases: [],
      group: 'agent',
      current: '- tag',
      history: [],
    });
    await tick();
    expect(apiWrite.mock.calls[0][2]).toMatchObject({ id: 'agent/release-checklist', revision: null, history: [] });
    await tick();
    expect(kp.data.selected).toBe('agent/release-checklist'); // the element opens the new page and drops its draft
    expect(kp.data.status).toBe('agent/release-checklist 페이지를 만들었습니다');
  });

  it('a 409 holds the tab until the newer version is fetched, then hands the element the conflict; Overwrite writes over that revision', async () => {
    let latestAnswer: (v: Answer) => void = () => {};
    let pageGets = 0;
    const fetch = fakeFetch((url) => {
      if (url.startsWith('/api/memory/page?id=')) {
        pageGets++;
        if (pageGets === 1) return { body: pageAnswer() };
        return new Promise((res) => (latestAnswer = res as any));
      }
      return { body: { pages: INDEX, episodicDates: [] } };
    });
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'changed' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { ok: true, ...pageAnswer({ current: 'mine' }, { revision: 'r3' }) },
      });
    const { fns, kp } = memEnv({ fetch, apiWrite });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    const draft = { id: 'agent/review', title: '리뷰', aliases: [], current: 'mine', history: [], revision: 'r1' };
    kp.fire('ui-save', draft);
    await tick();
    await tick();
    expect(fns.memHold.at).toBeGreaterThan(0); // still held: the newer version is on its way
    expect(kp.fire('ui-select', { id: 'concepts/tokens' }).defaultPrevented).toBe(true);
    latestAnswer({ body: pageAnswer({ current: 'theirs', updated: '2026-10-31' }, { revision: 'r2' }) });
    await tick();
    await tick();
    expect(fns.memHold.at).toBe(0);
    expect(kp.data).toMatchObject({ saving: false, error: '' });
    expect(kp.data.conflict).toContain('마지막 수정 2026-10-31');
    expect(kp.data.page.revision).toBe('r1'); // the page the draft started from stays the base
    kp.fire('ui-save', { ...draft, overwrite: true });
    await tick();
    expect(apiWrite.mock.calls[1][2]).toMatchObject({ current: 'mine', revision: 'r2' });
    await tick();
    expect(kp.data).toMatchObject({ conflict: '', status: '저장했습니다' });
  });

  it('Overwrite without a newer version to write over is refused, and Reload loads the latest', async () => {
    const fetch = fakeFetch((url) =>
      url.startsWith('/api/memory/page?id=')
        ? { body: pageAnswer({}, { revision: 'r9' }) }
        : { body: { pages: INDEX } },
    );
    const { kp, apiWrite } = memEnv({ fetch });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    const e = kp.fire('ui-save', {
      id: 'agent/review',
      title: 't',
      aliases: [],
      current: 'c',
      history: [],
      revision: 'r1',
      overwrite: true,
    });
    expect(e.defaultPrevented).toBe(true);
    expect(kp.data.error).toContain('덮어쓸 수 없습니다');
    expect(apiWrite).not.toHaveBeenCalled();
    kp.fire('ui-reload', { id: 'agent/review' });
    await tick();
    expect(kp.data).toMatchObject({ error: '', conflict: '' });
    expect(kp.data.page.revision).toBe('r9');
  });

  it('one memory write at a time: while a page save is out, a switch, a new page, a save and a delete wait (review R10)', async () => {
    let answer: (v: unknown) => void = () => {};
    const apiWrite = vi.fn(() => new Promise((res) => (answer = res)));
    const { kp, status } = memEnv({ apiWrite });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    kp.fire('ui-save', { id: 'agent/review', title: 't', aliases: [], current: 'c', history: [], revision: 'r1' });
    for (const [type, detail] of [
      ['ui-select', { id: 'concepts/tokens' }],
      ['ui-new', {}],
      ['ui-save', { id: 'agent/review', title: 't', aliases: [], current: 'd', history: [], revision: 'r1' }],
      ['ui-delete', { id: 'agent/review', revision: 'r1' }],
    ] as const) {
      expect(kp.fire(type, detail).defaultPrevented, type).toBe(true);
    }
    expect(status.textContent).toContain('저장 중입니다');
    expect(apiWrite).toHaveBeenCalledTimes(1);
    answer({ ok: true, status: 200, data: { ok: true, ...pageAnswer({}, { revision: 'r2' }) } });
    await tick();
    expect(kp.fire('ui-select', { id: 'concepts/tokens' }).defaultPrevented).toBe(false);
  });

  it('ui-delete sends the revision the element shows; the editor closes and the index loses the page', async () => {
    const apiWrite = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } }));
    const mem = { l1: {}, pages: INDEX.slice(), episodicDates: [] as string[] };
    const fetch = fakeFetch((url) =>
      url === '/api/memory' ? { body: { pages: [INDEX[1]], episodicDates: [] } } : { body: pageAnswer() },
    );
    const { kp, status } = memEnv({ apiWrite, fetch, mem });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    kp.fire('ui-delete', { id: 'agent/review', revision: 'r1' });
    await tick();
    await tick();
    expect(apiWrite).toHaveBeenCalledWith('DELETE', '/api/memory/page', { id: 'agent/review', revision: 'r1' });
    expect(kp.data).toMatchObject({ selected: null, page: null, saving: false });
    expect(kp.data.pages.map((p: any) => p.id)).toEqual(['concepts/tokens']); // the element drops the draft with it
    expect(status.textContent).toBe('agent/review 페이지를 지웠습니다');
  });

  it('a refused delete keeps the page and says why', async () => {
    const apiWrite = vi.fn(async () => ({ ok: false, status: 409, error: 'changed' }));
    const { kp } = memEnv({ apiWrite });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    kp.fire('ui-delete', { id: 'agent/review', revision: 'r1' });
    await tick();
    expect(kp.data).toMatchObject({ selected: 'agent/review', saving: false });
    expect(kp.data.error).toContain('그사이 바뀌었습니다');
  });
});

describe('지식 페이지 — the element’s source mode for the whole markdown; a page the form cannot hold opens that way (review R3, D7 M-05)', () => {
  const rawFetch = (answers: unknown[]) => {
    let n = 0;
    return fakeFetch((url) =>
      url.startsWith('/api/memory/page?id=')
        ? { body: answers[Math.min(n++, answers.length - 1)] }
        : { body: { pages: INDEX, episodicDates: [] } },
    );
  };
  const odd = pageAnswer({}, { raw: '# 리뷰\n\n## Extra\n', representable: false });
  const saveSource = (source: string, over: Record<string, unknown> = {}) => ({
    id: 'agent/review',
    title: '리뷰',
    aliases: ['review'],
    group: 'agent',
    current: 'Read the diff first.',
    history: [],
    revision: 'r1',
    source,
    ...over,
  });

  it('a page the form cannot hold is handed as sourceOnly with its markdown (the element opens it as source, no form); a source save goes through /page/raw with its revision', async () => {
    const apiWrite = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, ...odd, revision: 'r2', raw: 'NEW' },
    }));
    const { kp } = memEnv({ fetch: rawFetch([odd]), apiWrite });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    expect(kp.data.page).toMatchObject({
      id: 'agent/review',
      source: '# 리뷰\n\n## Extra\n',
      sourceOnly: true,
      revision: 'r1',
    });
    expect(kp.data.readOnly).toBeUndefined(); // the element edits the source; nothing of the page's sits under it
    // The element's ui-save from source mode carries the whole text: written as it is, never through the form route.
    kp.fire('ui-save', saveSource('NEW'));
    await tick();
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/memory/page/raw', {
      id: 'agent/review',
      raw: 'NEW',
      revision: 'r1',
    });
    expect(kp.data.page).toMatchObject({ revision: 'r2', source: 'NEW', sourceOnly: true });
    expect(kp.data.status).toBe('저장했습니다');
  });

  it('a source 409 hands the element the conflict (its draft stays in it); Overwrite writes over the newer revision (review P1, R4)', async () => {
    const newer = { ...odd, revision: 'r5', raw: 'THEIRS' };
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'changed' })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, ...newer, revision: 'r6', raw: 'MINE' } });
    const { fns, kp } = memEnv({ fetch: rawFetch([odd, newer]), apiWrite });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    kp.fire('ui-save', saveSource('MINE'));
    await tick();
    expect(fns.memHold.at).toBe(0);
    expect(kp.data.conflict).toContain('다른 곳(에이전트·Slack)에서 이 페이지를 고쳤습니다');
    expect(kp.data.page.source).toBe('# 리뷰\n\n## Extra\n'); // the loaded page stands; the draft is the element's
    kp.fire('ui-save', saveSource('MINE', { overwrite: true }));
    await tick();
    expect(apiWrite.mock.calls[1][2]).toEqual({ id: 'agent/review', raw: 'MINE', revision: 'r5' });
    expect(kp.data.conflict).toBe('');
    expect(kp.data.page).toMatchObject({ revision: 'r6', source: 'MINE' });
  });

  it('every page carries its source for the element’s 원문 mode; the tab keeps no box, toggle or recovery box of its own', async () => {
    const { kp } = memEnv({ fetch: rawFetch([pageAnswer()]) });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    expect(kp.data.page).toMatchObject({ source: '# 리뷰\n' });
    expect(kp.data.page.sourceOnly).toBeUndefined();
    for (const gone of [
      'pageRawMode',
      'renderPageRaw',
      'keepRawDraft',
      'savePageRaw',
      'overwritePageRaw',
      'deletePageRaw',
      'kp-raw',
      'kp-tools',
      'pg-raw',
      'memRecover',
      'mem-recover',
      'readOnly',
    ])
      expect(MEMORY_CLIENT_JS, gone).not.toContain(gone);
    expect(renderSettingsPage()).not.toMatch(/kp-raw|kp-tools|mem-recover/);
  });

  it('a source page is deleted through the element’s ui-delete (its two presses) with the revision it was loaded with', async () => {
    const apiWrite = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } }));
    const { kp } = memEnv({ fetch: rawFetch([odd]), apiWrite });
    kp.fire('ui-select', { id: 'agent/review' });
    await tick();
    kp.fire('ui-delete', { id: 'agent/review', revision: 'r1' });
    await tick();
    expect(apiWrite).toHaveBeenCalledWith('DELETE', '/api/memory/page', { id: 'agent/review', revision: 'r1' });
    expect(kp.data).toMatchObject({ selected: null, page: null });
  });
});

describe('관찰 기록 — the data <ui-episode-log> is given', () => {
  it('the newest day is shown and loaded; entries as { time, text }; times are UTC; today is the store’s (UTC) day', async () => {
    const { fns, ep, fetch } = memEnv();
    fns.paintDates();
    expect(ep.data).toMatchObject({
      date: '2026-10-30',
      dates: ['2026-10-30', '2026-10-29'],
      loading: true,
      timeLabel: 'UTC',
    });
    expect(ep.data.today).toBe(new Date().toISOString().slice(0, 10));
    await tick();
    expect(fetch).toHaveBeenCalledWith('/api/memory/episodic/2026-10-30');
    expect(ep.data.loading).toBe(false);
    expect(ep.data.days).toEqual([
      {
        date: '2026-10-30',
        revision: 'd-2026-10-30',
        entries: [
          { time: '00:00', text: 'first' },
          { time: '01:00', text: 'second' },
        ],
      },
    ]);
  });

  it('ui-date loads a day not loaded yet; "every day" (null) loads nothing; only the latest day request paints (review R8)', async () => {
    const holds: Record<string, (v: Answer) => void> = {};
    const fetch = fakeFetch((url) => new Promise((res) => (holds[url] = res as any)));
    const { ep } = memEnv({ fetch });
    ep.fire('ui-date', { date: '2026-10-29' });
    ep.fire('ui-date', { date: '2026-10-30' });
    holds['/api/memory/episodic/2026-10-30']({ body: dayAnswer('2026-10-30', ['new']) });
    await tick();
    holds['/api/memory/episodic/2026-10-29']({ body: dayAnswer('2026-10-29', ['old']) });
    await tick();
    expect(ep.data.date).toBe('2026-10-30');
    expect(ep.data.days.map((d: any) => d.date)).toEqual(['2026-10-30']);
    ep.fire('ui-date', { date: null });
    expect(ep.data.date).toBe(null);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('관찰 기록 — writes', () => {
  async function shown(opts: Parameters<typeof memEnv>[0] = {}) {
    const env = memEnv(opts);
    env.fns.paintDates();
    await tick();
    return env;
  }

  it('ui-edit sends the new text to the day and index with the day’s revision; busy while it is out', async () => {
    let answer: (v: unknown) => void = () => {};
    const apiWrite = vi.fn(() => new Promise((res) => (answer = res)));
    const { ep } = await shown({ apiWrite });
    ep.fire('ui-edit', {
      date: '2026-10-30',
      index: 1,
      original: 'second',
      text: 'second, edited',
      revision: 'd-2026-10-30',
    });
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/memory/episodic/2026-10-30/1', {
      content: 'second, edited',
      revision: 'd-2026-10-30',
    });
    expect(ep.data.busy).toBe(true);
    answer({
      ok: true,
      status: 200,
      data: { ok: true, day: dayAnswer('2026-10-30', ['first', 'second, edited'], 'd2') },
    });
    await tick();
    expect(ep.data).toMatchObject({ busy: false, status: '저장했습니다', error: '' });
    expect(ep.data.days[0].entries[1].text).toBe('second, edited'); // the element closes its editor on this
  });

  it('an edit or delete whose entry no longer reads as the element saw it is refused and the day reloaded', async () => {
    const { ep, apiWrite, fetch } = await shown();
    const e = ep.fire('ui-edit', { date: '2026-10-30', index: 0, original: 'not first', text: 'x' });
    expect(e.defaultPrevented).toBe(true);
    expect(apiWrite).not.toHaveBeenCalled();
    expect(ep.data.error).toContain('그사이 이 기록이 바뀌었습니다');
    expect(fetch).toHaveBeenLastCalledWith('/api/memory/episodic/2026-10-30');
  });

  it('a 409 reloads the day even while held, keeps the draft with the element, then releases the hold (review R11, R12)', async () => {
    let reload: (v: Answer) => void = () => {};
    let gets = 0;
    const fetch = fakeFetch((url) => {
      if (url === '/api/memory') return { body: { pages: INDEX, episodicDates: ['2026-10-30'] } };
      gets++;
      if (gets === 1) return { body: dayAnswer('2026-10-30', ['first', 'second']) };
      return new Promise((res) => (reload = res as any));
    });
    const apiWrite = vi.fn(async () => ({ ok: false, status: 409, error: 'changed' }));
    const { fns, ep } = await shown({ fetch, apiWrite });
    ep.fire('ui-edit', { date: '2026-10-30', index: 1, original: 'second', text: 'mine' });
    await tick();
    expect(fns.memHold.at).toBeGreaterThan(0);
    expect(ep.fire('ui-add', { text: 'note' }).defaultPrevented).toBe(true);
    reload({ body: dayAnswer('2026-10-30', ['first, by the agent', 'second'], 'd9') });
    await tick();
    await tick();
    expect(fns.memHold.at).toBe(0);
    expect(ep.data).toMatchObject({ busy: false });
    expect(ep.data.days[0].revision).toBe('d9');
    expect(ep.data.error).toContain('작성하던 내용은 그대로 있습니다');
  });

  it('deleting the last entry of a day drops the day and shows the newest one left', async () => {
    const apiWrite = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, day: dayAnswer('2026-10-30', []) },
    }));
    const fetch = fakeFetch((url) => {
      if (url === '/api/memory') return { body: { pages: INDEX, episodicDates: ['2026-10-29'] } };
      const d = /episodic\/(.+)$/.exec(url)![1];
      return { body: d === '2026-10-30' ? dayAnswer(d, ['only']) : dayAnswer(d, ['older']) };
    });
    const { ep } = await shown({ fetch, apiWrite });
    ep.fire('ui-delete', { date: '2026-10-30', index: 0, text: 'only', revision: 'd-2026-10-30' });
    await tick();
    await tick();
    await tick();
    expect(apiWrite).toHaveBeenCalledWith('DELETE', '/api/memory/episodic/2026-10-30/0', { revision: 'd-2026-10-30' });
    expect(ep.data.dates).toEqual(['2026-10-29']);
    expect(ep.data.date).toBe('2026-10-29');
    expect(ep.data.days.map((d: any) => d.date)).toEqual(['2026-10-29']);
  });

  it('a note goes to the store’s today; that day becomes "today" for the element, which empties its box', async () => {
    const apiWrite = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, day: dayAnswer('2026-10-31', ['a note']) },
    }));
    const { ep } = await shown({ apiWrite });
    ep.fire('ui-add', { text: 'a note' });
    expect(apiWrite).toHaveBeenCalledWith('POST', '/api/memory/episodic', { text: 'a note' });
    await tick();
    expect(ep.data.today).toBe('2026-10-31');
    expect(ep.data.days.some((d: any) => d.date === '2026-10-31' && d.entries[0].text === 'a note')).toBe(true);
    expect(ep.data.status).toContain('2026-10-31'); // the view stays on the day it shows
  });

  it('a note’s day stays listed and shown even when the index refresh after it fails', async () => {
    const apiWrite = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, day: dayAnswer('2026-10-31', ['a note']) },
    }));
    let indexFails = false;
    const fetch = fakeFetch((url) => {
      if (url === '/api/memory')
        return indexFails
          ? { status: 500, body: { error: 'down' } }
          : { body: { pages: INDEX, episodicDates: ['2026-10-30'] } };
      return { body: dayAnswer('2026-10-30', ['first']) };
    });
    const { ep } = await shown({ apiWrite, fetch });
    indexFails = true;
    ep.fire('ui-add', { text: 'a note' });
    await tick();
    await tick();
    expect(ep.data.dates).toEqual(['2026-10-31', '2026-10-30', '2026-10-29']); // the index as loaded, plus the note's day
    expect(ep.data.days.map((d: any) => d.date)).toContain('2026-10-31');
  });

  it('a refused note stays in the element’s box: an error, not busy', async () => {
    const apiWrite = vi.fn(async () => ({ ok: false, status: 500, error: 'disk full' }));
    const { ep } = await shown({ apiWrite });
    ep.fire('ui-add', { text: 'a note' });
    await tick();
    expect(ep.data).toMatchObject({ busy: false, error: '추가하지 못했습니다: disk full' });
  });
});
