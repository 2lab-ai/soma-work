/**
 * SSOT 2026-10-23 T2/T5 — the settings page and its 개인 설정 tab, client half.
 * Runs the shipped client script (`SETTINGS_CLIENT_JS`, a String.raw literal
 * that reaches the browser unchanged) with stubbed fetch / DOM.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderSettingsPage, SETTINGS_CLIENT_JS } from '../settings-page';

function clientFn(name: string): string {
  const plain = SETTINGS_CLIENT_JS.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : SETTINGS_CLIENT_JS.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = SETTINGS_CLIENT_JS.indexOf('\n}\n', start);
  return SETTINGS_CLIENT_JS.slice(start + 1, end + 2);
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const RENDER = ['esc', 'escAttr', 'valueText', 'renderSegmented', 'renderSelect', 'renderControl', 'renderRow'];

function row(over: Record<string, unknown> = {}) {
  return {
    key: 'defaultEffort',
    group: 'model',
    label: '기본 effort',
    description: '새 세션의 추론 강도',
    kind: 'choice',
    value: 'xhigh',
    defaultValue: 'xhigh',
    modified: false,
    options: ['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v.toUpperCase() })),
    editable: true,
    slackCommand: 'effort <level>',
    ...over,
  };
}

describe('settings page shell', () => {
  it('the whole page script parses, and the page links back to the dashboard', () => {
    const html = renderSettingsPage();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]; // the page script (the library elements load as modules after it)
    expect(() => new Function(script)).not.toThrow();
    expect(html).toContain('<dialog id="confirm"');
  });

  it('M-01: the shell is @2lab.ai/ui — <ui-app-bar> on top, <ui-tabs> over the slotted tab pages, both from /dashboard/ui', async () => {
    const html = renderSettingsPage();
    const { UI_LIB_VERSION, uiLibDistDir } = await import('../ui-lib');
    expect(html).toContain('<header class="topbar" id="topbar">');
    expect(html).toContain('<ui-app-bar id="app-bar" lang="ko"></ui-app-bar>');
    expect(html).toContain('<ui-tabs id="settings-tabs" class="settings-tabs" panel-focus="none">');
    expect(html).toContain('<div slot="preferences" data-tab="preferences" class="page">');
    expect(html).toContain('<div slot="memory" data-tab="memory" class="page" hidden>');
    for (const file of ['app-bar.js', 'tabs.js', 'memory-panel.js']) {
      expect(html).toContain(`<script type="module" src="/dashboard/ui/${file}?v=${UI_LIB_VERSION}"></script>`);
      expect(existsSync(join(uiLibDistDir() as string, file)), file).toBe(true);
    }
    // the tab list's data: an inert JSON script the page script reads (no < can close it)
    const json = /<script type="application\/json" id="settings-tabs-data">([^<]*)<\/script>/.exec(html)![1];
    expect(JSON.parse(json)).toEqual([
      { id: 'preferences', label: '개인 설정', icon: 'gear' },
      { id: 'memory', label: '기억', icon: 'brain' },
    ]);
    expect(renderSettingsPage([{ id: 'x', label: '</script><b>' }])).toContain('"label":"\\u003c/script>\\u003cb>"');
    // the kit sheet comes before the page sheet, the tokens after it
    expect(html.indexOf('<style id="ui-kit">')).toBeLessThan(html.indexOf('<style>'));
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('<style id="ui-tokens">'));
    // the old hand-made bar is gone
    expect(html).not.toMatch(/class="(back|theme|who|tabs|brand-mark)"/);
  });

  it('the app bar gets brand, links (설정 current), account and theme; ui-theme-change sets and stores the theme', () => {
    const set = vi.fn();
    const html = {
      attr: 'dark',
      getAttribute: () => html.attr,
      setAttribute: (_n: string, v: string) => (html.attr = v),
    };
    const bar: { data?: Record<string, unknown> } = {};
    const api = load<{ paintAppBar: () => void; setTheme: (t: string) => void; toggleTheme: () => void }>(
      ['currentTheme', 'paintAppBar', 'setTheme', 'toggleTheme'],
      {
        document: { documentElement: html, getElementById: (id: string) => (id === 'app-bar' ? bar : null) },
        localStorage: { setItem: set },
        APP_BAR_NAV: [{ id: 'settings', label: '설정', href: '/dashboard/settings', current: true }],
        _appBarAccount: { name: '민아', href: '/login', role: '관리자' },
      },
    );
    api.paintAppBar();
    expect(bar.data).toEqual({
      brand: { label: 'soma-work', mark: true, href: '/dashboard' },
      nav: [{ id: 'settings', label: '설정', href: '/dashboard/settings', current: true }],
      navLabel: '주 메뉴',
      theme: 'dark',
      account: { name: '민아', href: '/login', role: '관리자' },
    });
    api.toggleTheme();
    expect(html.attr).toBe('light');
    expect(set).toHaveBeenCalledWith('soma-theme', 'light');
    expect(bar.data?.theme).toBe('light');
  });

  it('the hash picks the tab: <ui-tabs> gets the tabs and the value, the other tab page keeps hidden, the tab hook runs once', () => {
    const pages = [
      { id: 'preferences', hidden: false, getAttribute: () => 'preferences' },
      { id: 'memory', hidden: true, getAttribute: () => 'memory' },
    ];
    const tabsEl: { data?: Record<string, unknown> } = {};
    const shown: string[] = [];
    const api = load<{ showTab: (id: string) => void }>(['settingsTabs', 'showTab'], {
      document: {
        querySelectorAll: () => pages,
        getElementById: (id: string) =>
          id === 'settings-tabs'
            ? tabsEl
            : id === 'settings-tabs-data'
              ? { textContent: '[{"id":"preferences","label":"개인 설정"},{"id":"memory","label":"기억"}]' }
              : null,
      },
      onTabShown: (id: string) => shown.push(id),
    });
    api.showTab('memory');
    expect(pages.map((p) => p.hidden)).toEqual([true, false]);
    expect(tabsEl.data).toEqual({
      tabs: [
        { id: 'preferences', label: '개인 설정' },
        { id: 'memory', label: '기억' },
      ],
      value: 'memory',
      label: '설정 영역',
    });
    api.showTab('memory'); // the hashchange after a tab press: no second load
    api.showTab('nope'); // an unknown hash falls back to 개인 설정
    expect(tabsEl.data?.value).toBe('preferences');
    expect(shown).toEqual(['memory', 'preferences']);
  });

  it('a hidden tab is really hidden: no author rule may give [hidden] tab pages a display (review P1)', () => {
    // `.page { display: grid }` beats the UA `[hidden] { display: none }` — a tab
    // toggled with the hidden attribute would keep rendering under the visible one.
    const css = /<style>([\s\S]*?)<\/style>/.exec(renderSettingsPage())![1];
    expect(css).toMatch(/\.page\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
    const pageRule = css.indexOf('.page {');
    const hiddenRule = css.indexOf('.page[hidden]');
    expect(hiddenRule).toBeGreaterThan(pageRule);
  });

  it('the client script carries no template-literal syntax (it ships byte for byte)', () => {
    expect(SETTINGS_CLIENT_JS).not.toContain('`');
    expect(SETTINGS_CLIENT_JS).not.toContain('${');
  });
});

describe('tone pass P9 — the settings page speaks the dashboard language', () => {
  const html = renderSettingsPage();
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
  const rule = (sel: string) => {
    const at = css.indexOf(`\n${sel} {`);
    return at < 0 ? '' : css.slice(at + 1, css.indexOf('}', at) + 1);
  };

  it('no emoji or hand-drawn glyph entities in the shell; the bar and its theme toggle are the element', () => {
    expect(html).not.toContain('&#x26A1;');
    expect(html).not.toMatch(/&larr;|&#x1F512;|&#x2715;/);
    expect(SETTINGS_CLIENT_JS).not.toMatch(/&#x1F512;|&#x2715;/);
    expect(css).not.toContain('.topbar h1');
    expect(css).toContain('ui-app-bar:not(:defined) { display: block; height: var(--topbar-h); }');
    expect(css).toContain('.settings-tabs::part(list) { max-width: 1080px; margin: 0 auto; padding: 8px 20px 0; }');
  });

  it('one ink primary; hover is neutral and fine-pointer only; one press rule', () => {
    expect(rule('.btn.primary')).toBe(
      '.btn.primary { background: var(--ib-text); border-color: var(--ib-text); color: var(--ib-card); }',
    );
    expect(css).not.toMatch(/border-color: var\(--accent\)/);
    const hover = css.slice(css.indexOf('@media (hover: hover) and (pointer: fine) {'));
    expect(hover).toContain('.btn:hover:not(:disabled) { border-color: var(--ib-muted); }');
    expect(css).toMatch(
      /:is\(\.btn, [^)]*\):active:not\(:disabled\):not\(:focus-visible\) \{ transform: scale\(0\.97\); \}/,
    );
    expect(css).not.toMatch(/font-weight: (700|800)/);
  });

  it('no hard-coded colour outside the token block; the dialog fades in and out with the scrim', () => {
    const outside = css.slice(css.indexOf('html, body {'));
    expect(outside).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(/i);
    expect(css).toContain('dialog::backdrop { background: var(--scrim);');
    expect(css).toContain('@starting-style { dialog[open] { opacity: 0; transform: scale(0.97); } }');
  });

  it('기억 tab: the page id keeps 4.5:1 on the pill chip; its own fields get the page focus ring', () => {
    // --text-tertiary on --ib-pill is 4.27 (light) / 4.36 (dark); --text-secondary is 5.54 / 5.63
    expect(css).toContain('.pages-list .pg[aria-current="true"] .lock { color: var(--text-secondary); }');
    expect(css).toContain('.pages-list .pg:hover .lock { color: var(--text-secondary); }');
    expect(css).toMatch(
      /\.pages-detail \.field input\[type="text"\], \.pages-detail \.field select \{[^}]*border-radius: 8px;/,
    );
    for (const sel of [
      '.pages-list .pg:focus-visible',
      '.pages-detail .field select:focus-visible',
      '.ep-bar select:focus-visible',
    ]) {
      expect(css, sel).toMatch(
        new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{ outline: 2px solid var\\(--border-focus\\);`),
      );
    }
  });
});

describe('개인 설정 rows', () => {
  const r = load<{ renderRow(row: any): string }>(RENDER, { _rowStatus: {} });

  it('a short choice is a native radio group that saves on change, with the Slack command beside it', () => {
    const html = r.renderRow(row());
    expect(html).toContain('<fieldset class="seg"><legend>기본 effort</legend>');
    expect(html.match(/type="radio"/g)).toHaveLength(5);
    expect(html).toContain('value="xhigh" checked');
    expect(html).toContain('onchange="onChoice(this)"');
    expect(html).toContain('Slack: <code>effort &lt;level&gt;</code>');
    expect(html).not.toContain('기본값으로');
  });

  it('a modified row is marked and offers a reset; a long list is a select with a custom entry', () => {
    const html = r.renderRow(
      row({
        key: 'defaultModel',
        label: '기본 모델',
        value: 'grok[1m]',
        defaultValue: 'claude-opus-5-5[1m]',
        modified: true,
        allowCustom: true,
      }),
    );
    expect(html).toContain('class="row is-modified"');
    expect(html).toContain('onclick="resetRow(this.getAttribute(\'data-key\'))">기본값으로</button>');
    expect(html).toContain('<select id="f-defaultModel"');
    expect(html).toContain('id="c-defaultModel" data-key="defaultModel"');
  });

  it('an admin-only row for a non-admin is read-only with its reason, and no control', () => {
    const html = r.renderRow(
      row({
        key: 'sandbox',
        kind: 'toggle',
        value: true,
        defaultValue: true,
        editable: false,
        adminOnly: true,
        lockedReason: '관리자만 바꿀 수 있습니다.',
      }),
    );
    expect(html).toContain('(관리자)');
    expect(html).toContain('관리자만 바꿀 수 있습니다.');
    expect(html).not.toContain('<input');
  });

  it('toggle, typed and list rows', () => {
    expect(r.renderRow(row({ key: 'autoGoal', kind: 'toggle', value: false, options: undefined }))).toContain(
      'role="switch"',
    );
    const typed = r.renderRow(row({ key: 'email', kind: 'text', value: 'a@b.co', options: undefined }));
    expect(typed).toContain('value="a@b.co"');
    expect(typed).toContain('>저장</button>');
    expect(typed).toContain('>지우기</button>');
    const list = r.renderRow(
      row({
        key: 'autoskills',
        kind: 'list',
        value: ['local:z'],
        defaultValue: [],
        options: [
          { value: 'local:z', label: 'local:z' },
          { value: 'local:autoz', label: 'local:autoz' },
        ],
        maxItems: 20,
      }),
    );
    expect(list).toContain('data-item="local:z"');
    expect(list).toContain('<option value="local:autoz">');
    expect(list).not.toContain('<option value="local:z">');
  });

  it('without admin acceptance every row is read-only with the reason (the server refuses writes)', () => {
    const { lockIfNotAccepted } = load<{ lockIfNotAccepted(d: any): any }>(['lockIfNotAccepted']);
    const snap = lockIfNotAccepted({ accepted: false, settings: [row(), row({ key: 'email', kind: 'text' })] });
    expect(snap.settings.every((s: any) => s.editable === false && s.lockedReason.includes('승인'))).toBe(true);
    const html = r.renderRow(snap.settings[0]);
    expect(html).not.toContain('<input');
    expect(html).toContain('관리자 승인 전에는 바꿀 수 없습니다.');
    const ok = lockIfNotAccepted({ accepted: true, settings: [row()] });
    expect(ok.settings[0].editable).toBe(true);
  });

  it('user text is escaped everywhere', () => {
    const html = r.renderRow(
      row({ key: 'email', kind: 'text', value: '"><img src=x onerror=alert(1)>', options: undefined }),
    );
    expect(html).not.toContain('<img');
  });
});

describe('filter', () => {
  it('touches only the 개인 설정 tab — sections of other tabs have no setting rows (review P1)', () => {
    const selectors: string[] = [];
    const { applyFilter } = load<{ applyFilter(): void }>(['applyFilter'], {
      document: {
        getElementById: () => ({ value: '', checked: false }),
        querySelectorAll: (sel: string) => {
          selectors.push(sel);
          return [];
        },
      },
    });
    applyFilter();
    expect(selectors).toHaveLength(2);
    for (const sel of selectors) expect(sel.startsWith('[data-tab="preferences"] ')).toBe(true);
  });
});

describe('saving', () => {
  function env(over: Record<string, unknown> = {}) {
    const snapshot = {
      settings: [row(), row({ key: 'permissionMode', kind: 'choice', value: 'auto', danger: true, options: [] })],
    };
    const deps: Record<string, any> = {
      _snapshot: snapshot,
      _rowStatus: {} as Record<string, any>,
      document: { getElementById: () => null },
      apiWrite: vi.fn(async (_m: string, _u: string, p: any) => ({
        ok: true,
        data: { setting: row({ value: p.value, modified: p.value !== 'xhigh' }) },
      })),
      confirmDialog: vi.fn(async () => true),
      repaintRow: vi.fn(),
      ...over,
    };
    const fns = load<{ saveSetting(key: string, value: unknown): Promise<boolean> }>(
      ['findRow', 'valueText', 'needsConfirm', 'saveSetting', 'esc'],
      deps,
    );
    return { ...fns, deps, snapshot };
  }

  it('PATCHes /api/settings/:key with { value } and repaints the row with the server answer', async () => {
    const { saveSetting, deps, snapshot } = env();
    expect(await saveSetting('defaultEffort', 'high')).toBe(true);
    expect(deps.apiWrite).toHaveBeenCalledWith('PATCH', '/api/settings/defaultEffort', { value: 'high' });
    expect(snapshot.settings[0].value).toBe('high');
    expect(deps._rowStatus.defaultEffort).toEqual({ text: '저장됨 — HIGH', error: false });
    expect(deps.repaintRow).toHaveBeenCalledWith('defaultEffort');
  });

  it('a refusal keeps the old value and says why', async () => {
    const { saveSetting, deps, snapshot } = env({
      apiWrite: vi.fn(async () => ({ ok: false, error: 'effort는 … 중 하나여야 합니다' })),
    });
    expect(await saveSetting('defaultEffort', 'turbo')).toBe(false);
    expect(snapshot.settings[0].value).toBe('xhigh');
    expect(deps._rowStatus.defaultEffort).toEqual({
      text: '저장하지 못했습니다: effort는 … 중 하나여야 합니다',
      error: true,
    });
  });

  it('turning on bypass asks first; cancelling sends nothing', async () => {
    const confirmDialog = vi.fn(async () => false);
    const { saveSetting, deps } = env({ confirmDialog });
    expect(await saveSetting('permissionMode', 'bypass')).toBe(false);
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ action: '확인 없이 실행 켜기' }));
    expect(deps.apiWrite).not.toHaveBeenCalled();
    // Back to the safe value needs no confirmation.
    await saveSetting('permissionMode', 'auto');
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(deps.apiWrite).toHaveBeenCalledTimes(1);
  });

  function csrf403(error = 'CSRF token validation failed') {
    const res: any = { ok: false, status: 403, json: async () => ({ error }) };
    res.clone = () => res;
    return res;
  }

  it('a real refusal (403 that is not a CSRF failure) is not sent twice', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(csrf403('관리자 승인을 받은 뒤에 설정을 바꿀 수 있습니다'));
    const refresh = vi.fn();
    const { apiWrite } = new Function(
      'fetch',
      'refreshCsrfToken',
      'localStorage',
      `var _csrfToken = 't';\n${clientFn('adminModeOn')}\n${clientFn('apiWrite')}\nreturn { apiWrite };`,
    )(fetch, refresh, { getItem: () => null });
    const r = await apiWrite('PATCH', '/api/settings/rating', { value: 7 });
    expect(r).toMatchObject({ ok: false, status: 403, error: '관리자 승인을 받은 뒤에 설정을 바꿀 수 있습니다' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('every write carries the CSRF token and the admin-mode header, and retries once after a 403', async () => {
    let token = 'old';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(csrf403())
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const { apiWrite } = new Function(
      'fetch',
      'refreshCsrfToken',
      'getToken',
      'localStorage',
      `${clientFn('adminModeOn')}\n${clientFn('apiWrite').replace(/_csrfToken/g, 'getToken()')}\nreturn { apiWrite };`,
    )(
      fetch,
      async () => {
        token = 'new';
      },
      () => token,
      { getItem: () => 'on' },
    );
    const r = await apiWrite('PATCH', '/api/settings/rating', { value: 7 });
    expect(r.ok).toBe(true);
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ 'X-CSRF-Token': 'old', 'X-Admin-Mode': 'on' });
    expect(fetch.mock.calls[1][1].headers['X-CSRF-Token']).toBe('new');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ value: 7 });
  });
});
