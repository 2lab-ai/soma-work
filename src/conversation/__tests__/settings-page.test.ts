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

const RENDER = [
  'esc',
  'escAttr',
  'valueText',
  'soundCue',
  'renderSegmented',
  'renderSelect',
  'renderControl',
  'renderRow',
];

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
      { id: 'layout', label: '대시보드 화면', icon: 'board' },
    ]);
    expect(renderSettingsPage([{ id: 'x', label: '</script><b>' }])).toContain('"label":"\\u003c/script>\\u003cb>"');
    // the kit sheet comes before the page sheet, the tokens after it
    expect(html.indexOf('<style id="ui-kit">')).toBeLessThan(html.indexOf('<style>'));
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('<style id="ui-tokens">'));
    // the old hand-made bar is gone
    expect(html).not.toMatch(/class="(back|theme|who|tabs|brand-mark)"/);
  });

  it('the app bar gets brand, links (설정 current), account, theme and the sound choice; ui-theme-change sets and stores the theme', () => {
    const set = vi.fn();
    const html = {
      attr: 'dark',
      getAttribute: () => html.attr,
      setAttribute: (_n: string, v: string) => (html.attr = v),
    };
    const bar: { data?: Record<string, unknown> } = {};
    const document = { documentElement: html, getElementById: (id: string) => (id === 'app-bar' ? bar : null) };
    const api = load<{ paintAppBar: () => void; setTheme: (t: string) => void; toggleTheme: () => void }>(
      ['currentTheme', 'paintAppBar', 'setTheme', 'toggleTheme'],
      {
        document,
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
      // The speaker (interface sound, #614) is the bar's own: without the head's sound script, off.
      sound: false,
      account: { name: '민아', href: '/login', role: '관리자' },
    });
    api.toggleTheme();
    expect(html.attr).toBe('light');
    expect(set).toHaveBeenCalledWith('soma-theme', 'light');
    expect(bar.data?.theme).toBe('light');
    // The head script's choice (_somaOn, read from soma-sound before paint) is handed to the bar: pressed while on.
    const withSound = load<{ paintAppBar: () => void }>(['currentTheme', 'paintAppBar'], {
      document,
      APP_BAR_NAV: [],
      _appBarAccount: null,
      _somaOn: true,
    });
    withSound.paintAppBar();
    expect(bar.data?.sound).toBe(true);
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
    expect(css).toContain(
      '.settings-tabs::part(list) { box-sizing: border-box; width: 100%; max-width: 1080px; margin: 0 auto; padding: 8px 20px 0; }',
    );
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

  it('기억 tab: no page-list, field or day-view styles of its own — <ui-knowledge-pages> and <ui-episode-log> draw them', () => {
    for (const gone of ['.pages-list', '.pages-detail', '.ep-bar', '.ep-entry', '.ep-add'])
      expect(css, gone).not.toContain(gone);
  });
});

describe('개인 설정 rows — <ui-setting-row> (M-02)', () => {
  const r = load<{ renderRow(row: any): string; rowData(row: any): any }>([...RENDER, 'rowData'], {
    _rowStatus: { defaultModel: { state: 'error', text: '저장하지 못했습니다: 없음' } },
  });

  it('a row is the element with its control in the slot; a short choice is a native radio group that saves on change', () => {
    const html = r.renderRow(row());
    expect(html.startsWith('<ui-setting-row lang="ko" id="row-defaultEffort" data-key="defaultEffort">')).toBe(true);
    expect(html.endsWith('</ui-setting-row>')).toBe(true);
    expect(html).toContain('<fieldset class="seg"><legend>기본 effort</legend>');
    expect(html.match(/type="radio"/g)).toHaveLength(5);
    expect(html).toContain('value="xhigh" checked');
    expect(html).toContain('onchange="onChoice(this)"');
    // label, description, hints, default, reset and status are the element's data, not markup
    expect(html).not.toMatch(/기본값|Slack:|class="(meta|hint|status)"/);
  });

  it('rowData: label, description, the Slack command as a hint, the default, Modified with reset, the badge, the status', () => {
    expect(r.rowData(row())).toEqual({
      key: 'defaultEffort',
      label: '기본 effort',
      description: '새 세션의 추론 강도',
      hints: [{ label: 'Slack:', code: 'effort <level>' }],
      modified: false,
      canReset: false,
      status: null,
      locked: null,
      defaultText: 'XHIGH',
    });
    const mod = r.rowData(
      row({
        key: 'defaultModel',
        label: '기본 모델',
        value: 'grok[1m]',
        defaultValue: 'XHIGH'.toLowerCase(),
        modified: true,
        adminOnly: true,
      }),
    );
    expect(mod).toMatchObject({ modified: true, canReset: true, badge: '관리자' });
    expect(mod.status).toEqual({ state: 'error', text: '저장하지 못했습니다: 없음' });
    // a list row is changed item by item: no reset to default
    expect(r.rowData(row({ kind: 'list', value: ['a'], defaultValue: [], modified: true })).canReset).toBe(false);
  });

  it('a long list is a kit select with a custom entry', () => {
    const html = r.renderRow(row({ key: 'defaultModel', label: '기본 모델', value: 'grok[1m]', allowCustom: true }));
    expect(html).toContain('<select class="ui-input" id="f-defaultModel"');
    expect(html).toContain('<input type="text" class="ui-input" id="c-defaultModel" data-key="defaultModel"');
  });

  it('an admin-only row for a non-admin is locked: no control, the value and the reason are the row data', () => {
    const locked = row({
      key: 'sandbox',
      kind: 'toggle',
      value: true,
      defaultValue: true,
      editable: false,
      adminOnly: true,
      lockedReason: '관리자만 바꿀 수 있습니다.',
      options: undefined,
    });
    expect(r.renderRow(locked)).toBe('<ui-setting-row lang="ko" id="row-sandbox" data-key="sandbox"></ui-setting-row>');
    expect(r.rowData(locked)).toMatchObject({
      badge: '관리자',
      canReset: false,
      locked: { reason: '관리자만 바꿀 수 있습니다.', value: '켬' },
    });
  });

  it('toggle (kit switch, the row names it), typed (kit input) and list rows', () => {
    const toggle = r.renderRow(row({ key: 'autoGoal', kind: 'toggle', value: false, options: undefined }));
    // data-ui-sound="toggle": the switch sounds through bindSound (#614); a danger row's would be "off".
    expect(toggle).toContain(
      '<label class="ui-switch"><input type="checkbox" role="switch" data-ui-sound="toggle" id="f-autoGoal"',
    );
    expect(toggle).toContain('<span aria-hidden="true">꺼짐</span>');
    const typed = r.renderRow(row({ key: 'email', kind: 'text', value: 'a@b.co', options: undefined }));
    expect(typed).toContain('<input type="text" class="ui-input" id="f-email"');
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
    expect(list).toContain('<select class="ui-input" id="f-autoskills"');
    expect(list).toContain('<option value="local:autoz">');
    expect(list).not.toContain('<option value="local:z">');
  });

  it('without admin acceptance every row is locked with the reason (the server refuses writes)', () => {
    const { lockIfNotAccepted } = load<{ lockIfNotAccepted(d: any): any }>(['lockIfNotAccepted']);
    const snap = lockIfNotAccepted({ accepted: false, settings: [row(), row({ key: 'email', kind: 'text' })] });
    expect(snap.settings.every((s: any) => s.editable === false && s.lockedReason.includes('승인'))).toBe(true);
    expect(r.renderRow(snap.settings[0])).not.toContain('<input');
    expect(r.rowData(snap.settings[0]).locked.reason).toBe('관리자 승인 전에는 바꿀 수 없습니다.');
    const ok = lockIfNotAccepted({ accepted: true, settings: [row()] });
    expect(ok.settings[0].editable).toBe(true);
  });

  it('user text is escaped everywhere', () => {
    const html = r.renderRow(
      row({ key: 'email', kind: 'text', value: '"><img src=x onerror=alert(1)>', options: undefined }),
    );
    expect(html).not.toContain('<img');
    expect(r.renderRow(row({ key: '"><img src=x>' }))).not.toContain('<img');
  });
});

describe('side nav and filter — <ui-settings-nav> (M-03)', () => {
  it('ui-filter runs the library applySettingsFilter on the 개인 설정 rows only, and the nav gets the counts back', () => {
    const body = { id: 'pref-body' };
    const nav: { data?: any } = {};
    const applySettingsFilter = vi.fn(() => ({ shown: 0, total: 3, sections: { 'g-model': 0, 'g-permissions': 0 } }));
    const api = load<{ applyFilter(): void; paintNav(r: any): void }>(['findRow', 'applyFilter', 'paintNav'], {
      document: { getElementById: (id: string) => (id === 'pref-body' ? body : id === 'pref-nav' ? nav : null) },
      applySettingsFilter,
      _prefFilter: { query: 'zz', modifiedOnly: false },
      _prefSections: [
        { id: 'g-model', label: '모델', keys: ['defaultEffort', 'defaultModel'] },
        { id: 'g-permissions', label: '권한', keys: ['permissionMode'] },
      ],
      _snapshot: { settings: [row(), row({ key: 'defaultModel', modified: true }), row({ key: 'permissionMode' })] },
    });
    api.applyFilter();
    expect(applySettingsFilter).toHaveBeenCalledWith(body, { query: 'zz', modifiedOnly: false });
    expect(nav.data).toEqual({
      sections: [
        { id: 'g-model', label: '모델', modified: 1, count: 0 },
        { id: 'g-permissions', label: '권한', modified: 0, count: 0 },
      ],
      query: 'zz',
      modifiedOnly: false,
      empty: true,
      label: '개인 설정 섹션',
      placeholder: '설정 검색 (이름 · 설명 · Slack 명령)',
    });
  });

  it('before the library module has loaded, the nav is still painted (no counts) and nothing throws', () => {
    const nav: { data?: any } = {};
    const api = load<{ applyFilter(): void }>(['findRow', 'applyFilter', 'paintNav'], {
      document: { getElementById: (id: string) => (id === 'pref-nav' ? nav : { id }) },
      applySettingsFilter: undefined,
      _prefFilter: { query: '', modifiedOnly: false },
      _prefSections: [{ id: 'g-model', label: '모델', keys: [] }],
      _snapshot: { settings: [] },
    });
    api.applyFilter();
    expect(nav.data.sections).toEqual([{ id: 'g-model', label: '모델', modified: 0 }]);
    expect(nav.data.empty).toBe(false);
  });

  it('the page markup: the nav with its notice slot, the kit loading notice, the filter module from /dashboard/ui', async () => {
    const html = renderSettingsPage();
    const { UI_LIB_VERSION } = await import('../ui-lib');
    expect(html).toContain(
      '<ui-settings-nav id="pref-nav" lang="ko"><div slot="notice" id="pref-notice" class="ui-notice" data-tone="wait" role="status" hidden></div></ui-settings-nav>',
    );
    expect(html).toContain('<div id="pref-body"><div class="ui-notice" role="status">불러오는 중…</div></div>');
    expect(html).toContain(`import { applySettingsFilter } from '/dashboard/ui/settings-nav.js?v=${UI_LIB_VERSION}';`);
    expect(html).toContain(`<script type="module" src="/dashboard/ui/setting-row.js?v=${UI_LIB_VERSION}"></script>`);
    expect(html).not.toMatch(/id="pref-filter"|id="pref-modified"|class="row/);
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
      paintRowData: vi.fn(),
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
    expect(deps._rowStatus.defaultEffort).toEqual({ state: 'saved', text: '저장됨 — HIGH' });
    expect(deps.paintRowData).toHaveBeenCalledWith('defaultEffort'); // the row says 저장 중… while the PATCH is out
    expect(deps.repaintRow).toHaveBeenCalledWith('defaultEffort');
  });

  it('a refusal keeps the old value and says why', async () => {
    const { saveSetting, deps, snapshot } = env({
      apiWrite: vi.fn(async () => ({ ok: false, error: 'effort는 … 중 하나여야 합니다' })),
    });
    expect(await saveSetting('defaultEffort', 'turbo')).toBe(false);
    expect(snapshot.settings[0].value).toBe('xhigh');
    expect(deps._rowStatus.defaultEffort).toEqual({
      state: 'error',
      text: '저장하지 못했습니다: effort는 … 중 하나여야 합니다',
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
