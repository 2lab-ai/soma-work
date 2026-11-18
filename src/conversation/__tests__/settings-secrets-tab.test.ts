/**
 * secret-access WU1 (#1337, .prd/32 §4.2): the settings page 비밀 tab, client half — what an admin sees (names,
 * times, where each is used, never a value), who gets the add / replace / delete controls (admin mode on), what
 * each control sends, and that the tab is listed for admins only. Functions are cut out of the shipped script.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderSettingsPage, SETTINGS_CLIENT_JS, SETTINGS_TABS } from '../settings-page';
import { SECRETS_CLIENT_JS } from '../settings-secrets-tab';

const ALL_JS = `${SECRETS_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`;

function clientFn(name: string): string {
  const plain = ALL_JS.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : ALL_JS.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = ALL_JS.indexOf('\n}\n', start);
  return ALL_JS.slice(start + 1, end + 2);
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const FNS = [
  'scUserName',
  'scChip',
  'scAccess',
  'scGrant',
  'scAddGrant',
  'scRemoveGrant',
  'esc',
  'escAttr',
  'scStatus',
  'scWhen',
  'scUsageText',
  'scFilterText',
  'scBanner',
  'scValueBox',
  'scRow',
  'scMissingRow',
  'scAddForm',
  'renderSecrets',
  'scFindSecret',
  'scPut',
  'scAdd',
  'scDelete',
  'scStartReplace',
  'scSaveReplace',
];

function data() {
  return {
    secrets: [
      {
        name: 'gh-token',
        updatedAt: '2026-11-18T01:00:00.000Z',
        updatedBy: 'U_ADMIN',
        updatedByName: '관리자님',
        usages: [{ server: 'dev2', path: 'github.token' }],
        access: { direct: ['U_A'], environments: [{ id: 'env:acme-dev2', server: 'dev2', users: ['U_B'] }] },
      },
      { name: 'unused', updatedAt: '2026-11-17T01:00:00.000Z', usages: [] },
    ],
    missing: [{ name: 'gone', usages: [{ server: '<b>x</b>', path: 'web.logins.p.body.pw' }] }],
    users: [
      { id: 'U_A', name: '에이' },
      { id: 'U_B', name: '비' },
      { id: 'U_C', name: '씨' },
    ],
  };
}

function page(opts: { adminMode: boolean; inputs?: Record<string, { value: string; focus?: () => void }> }) {
  const els: Record<string, any> = {
    'sc-body': { innerHTML: '' },
    'sc-status': { textContent: '', className: '', setAttribute: vi.fn() },
    'sc-filter': { value: '' },
    ...(opts.inputs ?? {}),
  };
  const document = { getElementById: (id: string) => els[id] ?? null };
  const apiWrite = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { created: true } });
  const confirmDialog = vi.fn().mockResolvedValue(true);
  const loadSecrets = vi.fn().mockResolvedValue(undefined);
  const api = new Function(
    'document',
    'adminModeOn',
    'apiWrite',
    'confirmDialog',
    'loadSecrets',
    `var _sc = __DATA__; var _scReplacing = '';
${FNS.map(clientFn).join('\n')}
return { ${FNS.join(', ')}, set: function (k, v) { if (k === 'replacing') _scReplacing = v; } };`.replace(
      '__DATA__',
      JSON.stringify(data()),
    ),
  )(document, () => opts.adminMode, apiWrite, confirmDialog, loadSecrets);
  return { api, els, apiWrite, confirmDialog, loadSecrets };
}

describe('비밀 tab — list', () => {
  it('without admin mode: names, times, usages, the missing ones, no controls', () => {
    const { api, els } = page({ adminMode: false });
    api.renderSecrets();
    const html: string = els['sc-body'].innerHTML;
    expect(html).toContain('gh-token');
    expect(html).toContain('dev2 › github.token');
    // who changed it, by name; an unused secret says so once (not "쓰는 곳: 쓰는 곳 없음")
    expect(html).toContain('관리자님');
    expect(html).not.toContain('U_ADMIN');
    expect(html).toContain('설정에서 쓰지 않음');
    expect(html).not.toContain('쓰는 곳: 쓰는 곳 없음');
    expect(html).toContain('설정이 가리키지만 저장소에 없습니다');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('관리자 모드 켜기');
    expect(html).not.toContain('id="sc-value"');
    expect(html).not.toContain('scDelete');
    expect(html).not.toContain('값 바꾸기');
  });

  it('with admin mode: the add form, and replace / delete on every row', () => {
    const { api, els } = page({ adminMode: true });
    api.renderSecrets();
    const html: string = els['sc-body'].innerHTML;
    expect(html).toContain('id="sc-name"');
    expect(html).toContain('id="sc-value"');
    expect(html.match(/onclick="scDelete\(this\)"/g)).toHaveLength(2);
    expect(html.match(/onclick="scStartReplace\(this\)"/g)).toHaveLength(2);
    expect(html).toContain('이 이름으로 추가');
    // the value box is a password-manager-free plain box: no autocomplete, no spellcheck
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain('spellcheck="false"');
  });

  it('the filter narrows the list by name', () => {
    const { api, els } = page({ adminMode: false });
    els['sc-filter'].value = 'GH';
    api.renderSecrets();
    expect(els['sc-body'].innerHTML).toContain('gh-token');
    expect(els['sc-body'].innerHTML).not.toContain('>unused<');
  });
});

describe('비밀 tab — changes', () => {
  it('adds a new secret with PUT, overwrite false, and clears both boxes', async () => {
    const inputs = { 'sc-name': { value: ' new-key ' }, 'sc-value': { value: 'v@lue' } };
    const { api, apiWrite, confirmDialog, loadSecrets } = page({ adminMode: true, inputs });
    await api.scAdd();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/secrets/new-key', { value: 'v@lue', overwrite: false });
    expect(inputs['sc-value'].value).toBe('');
    expect(inputs['sc-name'].value).toBe('');
    expect(loadSecrets).toHaveBeenCalled();
  });

  it('adding an existing name asks first; cancel sends nothing, confirm overwrites', async () => {
    const inputs = { 'sc-name': { value: 'gh-token' }, 'sc-value': { value: 'new' } };
    const p = page({ adminMode: true, inputs });
    p.confirmDialog.mockResolvedValueOnce(false);
    await p.api.scAdd();
    expect(p.apiWrite).not.toHaveBeenCalled();
    expect(p.confirmDialog.mock.calls[0][0].body).toContain('dev2 › github.token');
    await p.api.scAdd();
    expect(p.apiWrite).toHaveBeenCalledWith('PUT', '/api/secrets/gh-token', { value: 'new', overwrite: true });
  });

  it('an empty name or value sends nothing', async () => {
    const inputs = { 'sc-name': { value: 'x' }, 'sc-value': { value: '' } };
    const p = page({ adminMode: true, inputs });
    await p.api.scAdd();
    expect(p.apiWrite).not.toHaveBeenCalled();
    expect(p.els['sc-status'].textContent).toContain('이름과 값');
  });

  it('a refused write says why and keeps the value box as typed', async () => {
    const inputs = { 'sc-name': { value: 'k' }, 'sc-value': { value: 'v' } };
    const p = page({ adminMode: true, inputs });
    p.apiWrite.mockResolvedValueOnce({ ok: false, status: 403, error: '관리자 모드를 켜야' });
    await p.api.scAdd();
    expect(p.els['sc-status'].textContent).toBe('권한이 없습니다: 관리자 모드를 켜야');
    expect(inputs['sc-value'].value).toBe('v');
    expect(p.loadSecrets).not.toHaveBeenCalled();
  });

  it('replace sends the new value with overwrite true', async () => {
    const inputs = { 'sc-replace-value': { value: 'rotated', focus: vi.fn() } };
    const p = page({ adminMode: true, inputs });
    p.api.scStartReplace({ getAttribute: () => 'gh-token' });
    expect(p.els['sc-body'].innerHTML).toContain('새 값 저장');
    await p.api.scSaveReplace({ getAttribute: () => 'gh-token' });
    expect(p.apiWrite).toHaveBeenCalledWith('PUT', '/api/secrets/gh-token', { value: 'rotated', overwrite: true });
    expect(inputs['sc-replace-value'].value).toBe('');
  });

  it('delete names what stops working, then sends DELETE', async () => {
    const p = page({ adminMode: true });
    await p.api.scDelete({ getAttribute: () => 'gh-token' });
    const asked = p.confirmDialog.mock.calls[0][0];
    expect(asked.body).toContain('dev2 › github.token');
    expect(asked.action).toBe('gh-token 삭제');
    expect(p.apiWrite).toHaveBeenCalledWith('DELETE', '/api/secrets/gh-token');
  });

  it('a delete the admin cancels sends nothing', async () => {
    const p = page({ adminMode: true });
    p.confirmDialog.mockResolvedValueOnce(false);
    await p.api.scDelete({ getAttribute: () => 'unused' });
    expect(p.apiWrite).not.toHaveBeenCalled();
  });
});

describe('비밀 tab — on the page', () => {
  it('is an admin-only tab with its panel and its loader hook', () => {
    expect(SETTINGS_TABS).toContainEqual({ id: 'secrets', label: '비밀', icon: 'lock', adminOnly: true });
    const html = renderSettingsPage();
    expect(html).toContain('<div slot="secrets" data-tab="secrets" class="page" hidden>');
    expect(html).toContain("if (id === 'secrets' && !_scLoaded) loadSecrets();");
    expect(SECRETS_CLIENT_JS).not.toContain('`');
    expect(SECRETS_CLIENT_JS).not.toContain('${');
    const script = /<script>([\s\S]*?)<\/script>\n<script type="module"/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
  });

  it('lists the admin-only tab only once /auth/me says admin', () => {
    const tabs = JSON.stringify([
      { id: 'preferences', label: '개인 설정' },
      { id: 'secrets', label: '비밀', adminOnly: true },
    ]);
    const document = { getElementById: () => ({ textContent: tabs }) };
    const make = (admin: boolean) =>
      new Function('document', `var _viewerIsAdmin = ${admin};\n${clientFn('settingsTabs')}\nreturn settingsTabs();`)(
        document,
      );
    expect(make(false).map((t: { id: string }) => t.id)).toEqual(['preferences']);
    expect(make(true).map((t: { id: string }) => t.id)).toEqual(['preferences', 'secrets']);
  });
});

describe('비밀 tab — opened by address', () => {
  function shell(admin: boolean) {
    const panels = ['preferences', 'secrets'].map((id) => ({ hidden: id !== 'preferences', getAttribute: () => id }));
    const tabsEl: { data?: { value: string } } = {};
    const json = JSON.stringify([
      { id: 'preferences', label: '개인 설정' },
      { id: 'secrets', label: '비밀', adminOnly: true },
    ]);
    const document = {
      querySelectorAll: () => panels,
      getElementById: (id: string) => (id === 'settings-tabs' ? tabsEl : { textContent: json }),
    };
    const onTabShown = vi.fn();
    const api = new Function(
      'document',
      'onTabShown',
      `var _viewerIsAdmin = ${admin};\n${clientFn('settingsTabs')}\n${clientFn('showTab')}\nreturn { showTab };`,
    )(document, onTabShown);
    return { api, panels, tabsEl, onTabShown };
  }

  it('a non-admin who types #secrets lands on 개인 설정 and never loads the tab', () => {
    const s = shell(false);
    s.api.showTab('secrets');
    expect(s.tabsEl.data?.value).toBe('preferences');
    expect(s.panels[1].hidden).toBe(true);
    expect(s.onTabShown).toHaveBeenCalledWith('preferences');
    expect(s.onTabShown).not.toHaveBeenCalledWith('secrets');
  });

  it('an admin who types #secrets gets the tab', () => {
    const s = shell(true);
    s.api.showTab('secrets');
    expect(s.tabsEl.data?.value).toBe('secrets');
    expect(s.panels[1].hidden).toBe(false);
  });
});

describe('비밀 tab — who may use it (secret-access WU2)', () => {
  it('shows the environment holders read-only and the direct grants; editable with admin mode', () => {
    const view = page({ adminMode: false });
    view.api.renderSecrets();
    const html: string = view.els['sc-body'].innerHTML;
    expect(html).toContain('acme-dev2 환경 허락:');
    expect(html).toContain('>비<');
    expect(html).toContain('>에이<');
    expect(html).not.toContain('scRemoveGrant');
    expect(html).not.toContain('scAddGrant');

    const edit = page({ adminMode: true });
    edit.api.renderSecrets();
    const editable: string = edit.els['sc-body'].innerHTML;
    // one ✕ — the direct grant; the environment holder is edited on the environment
    expect(editable.match(/onclick="scRemoveGrant\(this\)"/g)).toHaveLength(1);
    // the picker of gh-token offers those not yet granted directly
    const picker = /id="sc-pick-gh-token"[^>]*>(.*?)<\/select>/.exec(editable)![1];
    expect(picker).toContain('U_B');
    expect(picker).toContain('U_C');
    expect(picker).not.toContain('value="U_A"');
  });

  it('adds and removes through POST …/grants and redraws from the answer', async () => {
    const p = page({ adminMode: true, inputs: { 'sc-pick-gh-token': { value: 'U_C' } } });
    p.apiWrite.mockResolvedValue({
      ok: true,
      status: 200,
      data: { access: { direct: ['U_A', 'U_C'], environments: [] } },
    });
    await p.api.scAddGrant({ getAttribute: () => 'gh-token' });
    expect(p.apiWrite).toHaveBeenCalledWith('POST', '/api/secrets/gh-token/grants', { userId: 'U_C', allow: true });
    expect(p.els['sc-body'].innerHTML).toContain('>씨<');
    await p.api.scRemoveGrant({ getAttribute: (k: string) => (k === 'data-name' ? 'gh-token' : 'U_A') });
    expect(p.apiWrite).toHaveBeenLastCalledWith('POST', '/api/secrets/gh-token/grants', {
      userId: 'U_A',
      allow: false,
    });
  });

  it('no pick sends nothing', async () => {
    const p = page({ adminMode: true, inputs: { 'sc-pick-gh-token': { value: '' } } });
    await p.api.scAddGrant({ getAttribute: () => 'gh-token' });
    expect(p.apiWrite).not.toHaveBeenCalled();
  });
});
