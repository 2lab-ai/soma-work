/**
 * The dashboard top bar — host contract with @2lab.ai/ui <ui-app-bar> (D2 group 1, A-03..A-14).
 *
 * The bar is the library's element: brand, the 대화 · 설정 · 기억 links (folded into 메뉴 when the bar
 * is short of room), the live-update status (tone dot + word, role=status), the account pill and the
 * theme toggle are its data; it draws, folds and narrows them itself (the library's own tests and docs
 * cover that). What the page owns, and what these tests pin:
 *
 *   - the data it hands the bar (paintAppBar) — the links' routes, the status words per connection
 *     state, the account from /auth/me (a link to /login), the current theme;
 *   - the events it answers — ui-theme-change applies and stores the theme (stored only while it
 *     differs from the OS); links are real links (ui-navigate / ui-account not cancelled);
 *   - its own controls in the bar's actions slot — the scope group (default model / effort, the
 *     board's user, admin write mode) and 새 작업 — and where the scope group goes on a narrower
 *     screen (the row under the bar, placeTopbarScope), so the one-row bar never overflows;
 *   - no page overflow sideways, 44px targets for its own controls on touch, the docked drawer under
 *     the header (--topbar-b).
 *
 * The runtime fold (1440 → 320px, light/dark, desktop/phone) is checked in a browser:
 * qa/d2/shots.ts `appbar` (bar overflow 0, page overflow 0 at every width).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS;

/** Evaluate a template-literal fragment the way the server does (\\n → \n, \\' → \'). */
function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
const STRINGS = new Function(
  `${cook(TEMPLATE.slice(TEMPLATE.indexOf('var STRINGS = {'), TEMPLATE.indexOf('\n};\n', TEMPLATE.indexOf('var STRINGS = {')) + 3))}\nreturn STRINGS;`,
)() as Record<string, string>;
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
/** A top-level `var NAME = …;` declaration (single line, or a multi-line literal ending in `];` / `};`). */
function clientVar(name: string): string {
  const start = TEMPLATE.indexOf(`\nvar ${name} = `);
  if (start < 0) throw new Error(`client var ${name} not found`);
  const line = TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n', start + 1));
  if (/;\s*(\/\/.*)?$/.test(line)) return cook(line.replace(/\s*\/\/.*$/, ''));
  const end = TEMPLATE.indexOf('\n];\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 3));
}
/** Build a module from shipped functions; `inject` names become parameters; `seams` read them back. */
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}, seams: string[] = []): T {
  const names = Object.keys(inject);
  const seamNames = seams.map((src) => /^function (\w+)/.exec(src)?.[1] ?? '');
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${seams.join('\n')}\nreturn { ${[...fns, ...seamNames].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const HEADER = TEMPLATE.slice(TEMPLATE.indexOf('<header class="topbar" id="topbar">'), TEMPLATE.indexOf('</header>'));
function cssRule(selector: string): string {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  return re.exec(TEMPLATE)?.[1] ?? '';
}

type BarData = {
  brand?: { label: string; mark?: unknown };
  nav?: Array<{ id: string; label: string; href: string; icon: string }>;
  navLabel?: string;
  status?: { tone: string; label: string; live?: boolean };
  account?: { name: string; href?: string };
  theme?: string;
};

describe('the top bar is <ui-app-bar> (A-03..A-14)', () => {
  it('a sticky header holds the bar and the row under it; the element module is served', () => {
    expect(HEADER).toContain('<ui-app-bar id="app-bar" lang="ko">');
    expect(HEADER).toMatch(/<\/ui-app-bar>\s*<div class="topbar-sub" id="topbar-sub" hidden><\/div>\s*$/);
    expect(HEADER).toContain('<h1 class="ar-vh">soma-work</h1>');
    expect(TEMPLATE).toContain('<script type="module" src="/dashboard/ui/app-bar.js?v=${UI_LIB_VERSION}"></script>');
    const bar = cssRule('.topbar');
    expect(bar).toMatch(/position: sticky;\s*top: 0;\s*z-index: 90;/);
  });

  it('the inline bar is gone: brand mark, status badge, nav links, user pill, theme toggle', () => {
    for (const gone of [
      'class="brand-mark"',
      'id="ws-status"',
      'class="ws-badge"',
      'id="user-pill"',
      'id="theme-toggle"',
      'id="settings-link"',
      'id="memory-link"',
      '<div class="nav">',
      'class="topbar-account"',
    ])
      expect(TEMPLATE, gone).not.toContain(gone);
    for (const gone of [/\.ws-badge\b/, /#theme-toggle\b/, /\.user-pill\b/, /\.topbar \.nav\b/, /\.topbar h1\b/])
      expect(TEMPLATE, String(gone)).not.toMatch(gone);
  });

  it("the page's controls ride in the actions slot: the scope group, then 새 작업", () => {
    const scope = HEADER.indexOf('<div class="topbar-scope" id="topbar-scope" slot="actions">');
    const defaults = HEADER.indexOf('id="topbar-defaults"');
    const user = HEADER.indexOf('id="user-select"');
    const admin = HEADER.indexOf('id="admin-mode-toggle"');
    const newTask = HEADER.indexOf('id="new-task-btn" slot="actions"');
    expect(scope).toBeGreaterThan(0);
    expect(defaults).toBeGreaterThan(scope);
    expect(user).toBeGreaterThan(defaults);
    expect(admin).toBeGreaterThan(user);
    expect(newTask).toBeGreaterThan(admin);
    // Before the element is defined the bar keeps its height and shows none of the raw controls.
    expect(TEMPLATE).toContain('ui-app-bar:not(:defined) { display: block; height: 56px; }');
    expect(TEMPLATE).toContain('ui-app-bar:not(:defined) > * { visibility: hidden; }');
    // 새 작업's word steps aside on a narrow bar (its + and title stay).
    expect(TEMPLATE).toContain('ui-app-bar[narrow] .nt-btn-label { display: none; }');
  });

  it('the user select is a visible label over a transparent native select whose title carries the full name', () => {
    expect(HEADER).toMatch(
      /<span class="user-select"><span class="user-select-label" id="user-select-label" aria-hidden="true">[^<]+<\/span><select id="user-select" title="[^"]+" aria-label="보드에 보일 사용자"/,
    );
    expect(cssRule('.topbar .user-select select')).toMatch(/opacity: 0;/);
    // In the bar the selected name is capped; in the row under it the row is the cap.
    expect(TEMPLATE).toMatch(/\.topbar \.user-select \{[^}]*max-inline-size: 180px;/);
    expect(TEMPLATE).toContain('.topbar-sub .user-select { max-inline-size: 100%; }');
  });

  it('admin-mode-label is split into prefix + state spans (JS rewrites 켬/끔 only)', () => {
    expect(HEADER).toContain(
      '<span id="admin-mode-label"><span class="admin-mode-prefix">관리자 </span><span class="admin-mode-state">끔</span></span>',
    );
    expect(clientFn('_renderAdminModeButton')).toMatch(
      /querySelector\('\.admin-mode-state'\)[\s\S]*?textContent\s*=\s*on\s*\?\s*STRINGS\.on\s*:\s*STRINGS\.off/,
    );
    expect(STRINGS.on).toBe('켬');
    expect(STRINGS.off).toBe('끔');
  });
});

describe('paintAppBar — the data the page hands the bar', () => {
  function harness(theme = 'dark') {
    const bar: { data?: BarData } = {};
    const document = {
      getElementById: (id: string) => (id === 'app-bar' ? bar : null),
      documentElement: { getAttribute: () => theme },
    };
    return { bar, document };
  }

  it('brand, the three page links (routes unchanged), the status, the theme; no account before /auth/me', () => {
    const h = harness('light');
    const { paintAppBar } = load<{ paintAppBar(): void }>(
      ['paintAppBar'],
      ['APP_BAR_NAV', '_appBarStatus', '_appBarAccount'],
      { document: h.document, STRINGS },
    );
    paintAppBar();
    const d = h.bar.data as BarData;
    expect(d.brand).toEqual({ label: 'soma-work', mark: true });
    expect(d.nav).toEqual([
      { id: 'conversations', label: '대화', href: '/conversations', icon: 'chat' },
      { id: 'settings', label: '설정', href: '/dashboard/settings', icon: 'gear' },
      { id: 'memory', label: '기억', href: '/dashboard/settings#memory', icon: 'brain' },
    ]);
    expect(d.navLabel).toBe('주 메뉴');
    expect(d.status).toEqual({ tone: 'run', label: '연결 중…', live: true });
    expect(d.theme).toBe('light');
    expect('account' in d).toBe(false);
  });

  it('the account from /auth/me: the name in full (the bar ellipsizes it and names the pill with it), a link to /login', () => {
    const LONG = '가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라';
    const h = harness();
    const m = load<{ _applyUserPill(d: unknown): void; paintAppBar(): void; account(): unknown }>(
      ['_applyUserPill', 'paintAppBar'],
      ['APP_BAR_NAV', '_appBarStatus', '_appBarAccount'],
      { document: h.document, STRINGS, localStorage: { removeItem() {} } },
      ['function account() { return _appBarAccount; }'],
    );
    m._applyUserPill({ user: { name: LONG } });
    expect(m.account()).toEqual({ name: LONG, href: '/login' });
    expect(h.bar.data?.account).toEqual({ name: LONG, href: '/login' });
    // A viewer-token admin reads 관리자; nobody signed in = no pill.
    m._applyUserPill({ isAdmin: true });
    expect(h.bar.data?.account).toEqual({ name: STRINGS.viewerAdmin, href: '/login' });
    m._applyUserPill(null);
    expect(h.bar.data && 'account' in h.bar.data).toBe(false);
  });

  it('the live-update status follows the socket: 연결 중… → 실시간 연결됨 (done) → 다시 연결 중… (wait)', () => {
    let sock: { onopen?: () => void; onclose?: () => void } = {};
    function WebSocket(this: typeof sock) {
      // biome-ignore lint/complexity/noUselessThisAlias: the stub hands its instance to the test
      sock = this;
    }
    const painted: unknown[] = [];
    const m = load<{ connectWs(): void; status(): unknown }>(
      ['connectWs'],
      ['_appBarStatus'],
      {
        STRINGS,
        WebSocket,
        ws: null,
        location: { protocol: 'https:', host: 'x' },
        panelOpen: false,
        _wl: null,
        setTimeout: () => 0,
        paintAppBar: () => painted.push(1),
      },
      ['function status() { return _appBarStatus; }'],
    );
    expect(m.status()).toEqual({ tone: 'run', label: '연결 중…', live: true });
    m.connectWs();
    sock.onopen?.();
    expect(m.status()).toEqual({ tone: 'done', label: '실시간 연결됨', live: true });
    sock.onclose?.();
    expect(m.status()).toEqual({ tone: 'wait', label: '다시 연결 중…', live: true });
    expect(painted.length).toBe(2);
    // Korean, sentence case, "…" not "..."; no badge element of the page's own (the tone is the bar's).
    for (const w of [STRINGS.wsConnecting, STRINGS.wsLive, STRINGS.wsReconnecting])
      expect(w).not.toMatch(/\.\.\.|[A-Za-z]/);
    expect(clientFn('connectWs')).not.toMatch(/statusEl|ws-status/);
  });
});

describe('theme — the bar asks, the page applies and stores', () => {
  function env(os: 'light' | 'dark') {
    const store = new Map<string, string>();
    const attrs: Record<string, string> = {};
    const painted: string[] = [];
    const inject = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
      window: { matchMedia: (q: string) => ({ matches: q.includes('light') ? os === 'light' : os === 'dark' }) },
      document: {
        documentElement: {
          setAttribute: (k: string, v: string) => {
            attrs[k] = v;
          },
          getAttribute: (k: string) => attrs[k] ?? null,
        },
      },
      paintAppBar: () => painted.push(attrs['data-theme']),
    };
    const m = load<{ setTheme(t: string): void; toggleTheme(): void }>(
      ['setTheme', 'toggleTheme', 'applyTheme'],
      [],
      inject,
    );
    return { m, store, attrs, painted };
  }

  it('the chosen theme is stored only while it differs from the OS; the bar is repainted with it', () => {
    const e = env('dark');
    e.m.setTheme('light');
    expect(e.attrs['data-theme']).toBe('light');
    expect(e.store.get('soma-theme')).toBe('light');
    expect(e.painted).toEqual(['light']);
    e.m.toggleTheme();
    expect(e.attrs['data-theme']).toBe('dark');
    expect(e.store.has('soma-theme')).toBe(false);
    expect(e.painted).toEqual(['light', 'dark']);
  });

  it('ui-theme-change from the bar applies the theme it asks for (not cancelled: the toggle shows it at once)', () => {
    const init = TEMPLATE.slice(
      TEMPLATE.indexOf('(function initAppBar() {'),
      TEMPLATE.indexOf('})();', TEMPLATE.indexOf('(function initAppBar() {')),
    );
    expect(init).toContain("bar.addEventListener('ui-theme-change', function(e) {");
    expect(init).toMatch(/if \(t === 'light' \|\| t === 'dark'\) setTheme\(t\);/);
    expect(init).not.toContain('preventDefault');
    // The OS listener and the first paint go through applyTheme (which repaints the bar).
    expect(clientFn('applyTheme')).toMatch(/setAttribute\('data-theme', theme\);\n\s*paintAppBar\(\);/);
  });
});

describe('placeTopbarScope — the scope group in the bar on a wide screen, in the row under it below', () => {
  function harness(wide: boolean) {
    const sub: { hidden: boolean; children: unknown[]; appendChild(n: { parentElement: unknown }): void } = {
      hidden: true,
      children: [],
      appendChild(n) {
        n.parentElement = sub;
        this.children.push(n);
      },
    };
    const newTask = { id: 'new-task-btn' };
    const bar = {
      inserted: [] as unknown[],
      insertBefore(n: { parentElement: unknown }, ref: unknown) {
        n.parentElement = bar;
        this.inserted.push([n, ref]);
      },
    };
    const attrs: Record<string, string> = {};
    const scope = {
      parentElement: bar as unknown,
      get slot() {
        return attrs.slot ?? '';
      },
      set slot(v: string) {
        attrs.slot = v;
      },
      removeAttribute: (k: string) => delete attrs[k],
    };
    attrs.slot = 'actions';
    const byId: Record<string, unknown> = {
      'app-bar': bar,
      'topbar-sub': sub,
      'topbar-scope': scope,
      'new-task-btn': newTask,
    };
    let closed = 0;
    const m = load<{ placeTopbarScope(): void }>(['placeTopbarScope'], ['TOPBAR_SCOPE_MIN'], {
      document: { getElementById: (id: string) => byId[id] ?? null },
      window: { matchMedia: (q: string) => ({ matches: wide && q === '(min-width: 1280px)' }) },
      closeDefaultsMenu: () => closed++,
    });
    return { m, bar, sub, scope, newTask, attrs, closed: () => closed };
  }

  it('below 1280px it leaves the bar for the row under it (no slot), and the row shows', () => {
    const h = harness(false);
    h.m.placeTopbarScope();
    expect(h.scope.parentElement).toBe(h.sub);
    expect(h.attrs.slot).toBeUndefined();
    expect(h.sub.hidden).toBe(false);
    expect(h.closed()).toBe(1); // an open defaults menu does not travel with its chip
    h.m.placeTopbarScope();
    expect(h.closed()).toBe(1); // already there: nothing moves
  });

  it('from 1280px it is the bar’s action again, before 새 작업, and the row hides', () => {
    const h = harness(true);
    h.scope.parentElement = h.sub;
    delete h.attrs.slot;
    h.m.placeTopbarScope();
    expect(h.scope.parentElement).toBe(h.bar);
    expect(h.attrs.slot).toBe('actions');
    expect(h.bar.inserted).toEqual([[h.scope, h.newTask]]);
    expect(h.sub.hidden).toBe(true);
  });

  it('runs at load and on every crossing of the breakpoint', () => {
    expect(TEMPLATE).toContain('var TOPBAR_SCOPE_MIN = 1280;');
    expect(TEMPLATE).toMatch(/\nplaceTopbarScope\(\);\n/);
    expect(TEMPLATE).toMatch(/_topbarScopeMq\.addEventListener\('change', placeTopbarScope\)/);
  });

  it('the row under the bar is the bar’s surface and wraps its controls; opaque on reduced transparency', () => {
    const sub = cssRule('.topbar-sub');
    expect(sub).toContain('background: color-mix(in srgb, var(--bg) 86%, transparent);');
    expect(sub).toContain('backdrop-filter: saturate(1.4) blur(10px);');
    expect(sub).toContain('border-bottom: 1px solid var(--border);');
    expect(TEMPLATE).toContain('.topbar-sub[hidden] { display: none; }');
    expect(TEMPLATE).toContain('.topbar-sub .topbar-scope { flex: 1 1 auto; flex-wrap: wrap; }');
    expect(TEMPLATE).toMatch(
      /@media \(prefers-reduced-transparency: reduce\) \{\n {2}\.topbar-sub \{ background: var\(--bg\); -webkit-backdrop-filter: none; backdrop-filter: none; \}/,
    );
  });
});

describe('touch targets and overflow', () => {
  it("the page's own top-bar controls are 44px on narrow or touch screens (the bar's are the element's)", () => {
    const block = TEMPLATE.match(/@media \(max-width: 639px\), \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).toContain('.topbar .user-select, .topbar .admin-toggle, .topbar .td-chip { min-height: 44px; }');
  });

  it('does NOT add html, body { overflow-x: hidden } — width is fitted directly', () => {
    expect(DASHBOARD_TS).not.toMatch(/html\s*,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
    expect(DASHBOARD_TS).not.toMatch(/body\s*,\s*html\s*\{[^}]*overflow-x:\s*hidden/);
  });
});
