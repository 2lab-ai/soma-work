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
 *   - its own controls in the bar's slots — the scope group (default model / effort, the board's
 *     user, admin write mode) in the toolbar slot (the bar's own row under it below toolbarAt or
 *     when it would overflow, 0.10.0 — D2-GAPS G1-1) and 새 작업 in the actions slot;
 *   - the brand as the page's h1, each link's title, the status's description (D2-GAPS G1-2..G1-4);
 *   - no page overflow sideways, 44px targets for its own controls on touch, the docked drawer under
 *     the header (--topbar-b).
 *
 * The runtime fold (1440 → 320px, light/dark, desktop/phone) is checked in a browser:
 * qa/d2/shots.ts `appbar` (bar overflow 0, page overflow 0 at every width).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';
import { uiLibKitCss } from '../ui-lib';

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
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const seamNames = seams.map((src) => /^function (\w+)/.exec(src)?.[1] ?? '');
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${seams.join('\n')}\nreturn { ${[...fns, ...seamNames].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const KIT = uiLibKitCss();
const HEADER = TEMPLATE.slice(TEMPLATE.indexOf('<header class="topbar" id="topbar">'), TEMPLATE.indexOf('</header>'));
function cssRule(selector: string): string {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  return re.exec(TEMPLATE)?.[1] ?? '';
}

type BarData = {
  brand?: { label: string; mark?: unknown };
  nav?: Array<{ id: string; label: string; href: string; icon: string; title?: string }>;
  navLabel?: string;
  toolbarAt?: number;
  status?: { tone: string; label: string; live?: boolean; description?: string };
  account?: { name: string; href?: string };
  theme?: string;
};

describe('the top bar is <ui-app-bar> (A-03..A-14)', () => {
  it('a sticky header holds the bar alone (its toolbar row is its own); the element module is served', () => {
    expect(HEADER).toContain('<ui-app-bar id="app-bar" lang="ko">');
    expect(HEADER).toMatch(/<\/ui-app-bar>\s*$/);
    // The brand is the page's h1 (brand.heading) — no visually hidden one of the page's own.
    expect(HEADER).not.toContain('<h1');
    expect(TEMPLATE).not.toMatch(/id="topbar-sub"|\.topbar-sub\b|placeTopbarScope|TOPBAR_SCOPE_MIN/);
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

  it("the page's controls ride in the bar's slots: the scope group its toolbar, 새 작업 its action", () => {
    const scope = HEADER.indexOf('<div class="topbar-scope" id="topbar-scope" slot="toolbar">');
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

  it('the user select is the kit’s select chip (D7 A-11): a native select read as a label, its title the full name', () => {
    expect(HEADER).toMatch(
      /<select class="ui-select-chip user-select" id="user-select" title="[^"]+" aria-label="보드에 보일 사용자" onchange="selectUser\(this\.value\)">/,
    );
    expect(HEADER).not.toContain('user-select-label');
    // The kit sizes the select to its selected option and ellipsizes past --ui-select-max; the page sets the cap:
    // in the bar 180px, in the bar's row under it the row.
    expect(KIT).toContain('max-width: var(--ui-select-max, 220px); field-sizing: content;');
    expect(TEMPLATE).toContain('.topbar .user-select { --ui-select-max: 180px; flex: 0 1 auto; }');
    expect(TEMPLATE).toContain('ui-app-bar[toolbar-row] .user-select { --ui-select-max: 100%; }');
    expect(TEMPLATE).not.toMatch(/\.topbar \.user-select select/);
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

  it('brand (the h1), the three page links (routes unchanged, titled), the toolbar width, the status, the theme; no account before /auth/me', () => {
    const h = harness('light');
    const { paintAppBar } = load<{ paintAppBar(): void }>(
      ['paintAppBar'],
      ['APP_BAR_NAV', 'APP_BAR_TOOLBAR_AT', '_appBarStatus', '_appBarAccount'],
      { document: h.document, STRINGS },
    );
    paintAppBar();
    const d = h.bar.data as BarData;
    expect(d.brand).toEqual({ label: 'soma-work', mark: true, heading: true });
    // Each link says what its page is for (the old nav's titles): its hover title and the folded menu row's line.
    expect(d.nav).toEqual([
      { id: 'conversations', label: '대화', href: '/conversations', icon: 'chat', title: '지난 대화를 모두 봅니다' },
      {
        id: 'settings',
        label: '설정',
        href: '/dashboard/settings',
        icon: 'gear',
        title: 'Slack 명령으로 바꾸던 설정을 여기서 확인하고 바꿉니다',
      },
      {
        id: 'memory',
        label: '기억',
        href: '/dashboard/settings#memory',
        icon: 'brain',
        title: '에이전트가 기억하는 개인 메모리와 관찰 기록을 보고 고칩니다',
      },
    ]);
    expect(d.navLabel).toBe('주 메뉴');
    // The scope group takes the bar's row under it below a 1280px bar (as the page's own row did).
    expect(d.toolbarAt).toBe(1280);
    expect(d.status).toEqual({ tone: 'run', label: '연결 중…', live: true, description: '실시간 업데이트' });
    expect(d.theme).toBe('light');
    expect('account' in d).toBe(false);
  });

  it('the account from /auth/me: the name in full (the bar ellipsizes it and names the pill with it), a link to /login', () => {
    const LONG = '가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라';
    const h = harness();
    const m = load<{ _applyUserPill(d: unknown): void; paintAppBar(): void; account(): unknown }>(
      ['_applyUserPill', 'paintAppBar'],
      ['APP_BAR_NAV', 'APP_BAR_TOOLBAR_AT', '_appBarStatus', '_appBarAccount'],
      {
        document: h.document,
        STRINGS,
        localStorage: { removeItem() {} },
        adminInboxLoad: () => {},
        // View mode (SSOT 2026-11-01): learning the viewer re-says whose board this is (none in this harness).
        syncBoardScope: () => {},
        autoOpenDecisions: () => {},
      },
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

  it('the live-update status follows the socket: 연결 중… → 연결됨 (done) → 다시 연결 중… (wait), each about 실시간 업데이트', () => {
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
        adminInboxLoad: () => {},
      },
      ['function status() { return _appBarStatus; }'],
    );
    // The bar reads the description first: "실시간 업데이트: 연결됨" — the old badge's accessible name (G1-4).
    const about = '실시간 업데이트';
    expect(m.status()).toEqual({ tone: 'run', label: '연결 중…', live: true, description: about });
    m.connectWs();
    sock.onopen?.();
    expect(m.status()).toEqual({ tone: 'done', label: '연결됨', live: true, description: about });
    sock.onclose?.();
    expect(m.status()).toEqual({ tone: 'wait', label: '다시 연결 중…', live: true, description: about });
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

// The scope group's place (inline in the bar while it fits, the bar's wrapping row under it below toolbarAt or when
// it would overflow, its nodes never moved) is the bar's: library app-bar.test.ts (appBarToolbarRow, toolbar-row).
describe('the scope group is the bar’s toolbar — the bar places it', () => {
  it('in the bar’s row under it the group wraps and the user select fills what the chips leave on a phone', () => {
    expect(TEMPLATE).toContain('ui-app-bar[toolbar-row] .topbar-scope { flex: 1 1 auto; flex-wrap: wrap; }');
    const phone = TEMPLATE.slice(TEMPLATE.indexOf('@media (max-width: 639px) {'));
    expect(phone).toContain('ui-app-bar[toolbar-row] .user-select { flex: 1 1 auto; }');
    expect(TEMPLATE).toContain('var APP_BAR_TOOLBAR_AT = 1280;');
  });
});

describe('touch targets and overflow', () => {
  it("the page's own top-bar controls are 44px on narrow or touch screens (the bar's are the element's)", () => {
    const block = TEMPLATE.match(/@media \(max-width: 639px\), \(pointer: coarse\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    // D7 (A-11): the user select is a kit select chip — 44px on touch / narrow is ui-kit.css's rule.
    expect(block).not.toContain('.user-select');
    expect(KIT).toContain('.ui-select-chip { min-height: 44px; }');
    // D7 (A-06, A-12): the defaults and admin chips are kit chips — their 44px hit area is the kit's own rule.
    expect(TEMPLATE).toMatch(/<button type="button" class="ui-chip td-chip" id="td-model"/);
    expect(TEMPLATE).toMatch(/<button type="button" class="ui-chip td-chip" id="td-effort"/);
    expect(TEMPLATE).toMatch(/class="ui-chip admin-toggle admin-inbox-btn"/);
    expect(TEMPLATE).toMatch(/class="ui-chip admin-toggle"\n/);
    expect(block).not.toContain('.admin-toggle');
    expect(block).not.toContain('.td-chip');
  });

  it('does NOT add html, body { overflow-x: hidden } — width is fitted directly', () => {
    expect(DASHBOARD_TS).not.toMatch(/html\s*,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
    expect(DASHBOARD_TS).not.toMatch(/body\s*,\s*html\s*\{[^}]*overflow-x:\s*hidden/);
  });
});
