/**
 * secret-access WU3 (#1339, .prd/32 §4.3): the settings page 서버 도구 tab, client half — every server-tools tool
 * with its level (or 관리자 전용), every server with its sections, secrets and environment grants, the
 * server-tools grants; what each control sends, and that the tab is listed for admins only. Functions are cut out
 * of the shipped script.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderSettingsPage, SETTINGS_CLIENT_JS, SETTINGS_TABS } from '../settings-page';
import { SECRETS_CLIENT_JS } from '../settings-secrets-tab';
import { SERVER_TOOLS_CLIENT_JS } from '../settings-server-tools-tab';

const ALL_JS = `${SERVER_TOOLS_CLIENT_JS}\n${SECRETS_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`;

function clientFn(name: string): string {
  const plain = ALL_JS.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : ALL_JS.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = ALL_JS.indexOf('\n}\n', start);
  return ALL_JS.slice(start + 1, end + 2);
}

const FNS = [
  'esc',
  'escAttr',
  'scWhen',
  'stStatus',
  'stUserName',
  'stAccessText',
  'stLevelCell',
  'stToolRow',
  'stGrantRow',
  'stGrantForm',
  'stEnvChips',
  'stServerCard',
  'stBanner',
  'stFilterText',
  'renderServerTools',
  'stFindServer',
  'stSetLevel',
  'stCreateMap',
  'stAddGrant',
  'stRevokeGrant',
  'stEnvGrant',
  'stAddEnvUser',
  'stRemoveEnvUser',
];

function data(map: 'present' | 'missing' = 'present') {
  return {
    permissionMap: map,
    tools: [
      {
        name: 'db_query',
        summary: 'MySQL 읽기',
        access: 'read',
        sections: ['ssh', 'databases'],
        level: map === 'present' ? 'read' : null,
        adminOnly: false,
      },
      {
        name: 'redis_query',
        summary: 'Redis 읽기',
        access: 'read',
        sections: ['ssh', 'databases'],
        level: null,
        adminOnly: false,
      },
      { name: 'gh_pr', summary: 'PR 보기 · 머지', access: 'mixed', sections: ['github'], level: null, adminOnly: true },
    ],
    servers: [
      {
        name: 'dev2',
        envUser: 'env:acme-dev2',
        sections: ['ssh', 'databases', 'github'],
        tools: ['db_query', 'redis_query', 'gh_pr'],
        secrets: [
          { name: 'dev2-db', path: 'databases.app.password', exists: true },
          { name: 'gh-missing', path: 'github.token', exists: false },
        ],
        environmentUsers: ['U_B'],
      },
      { name: '<b>x</b>', sections: [], tools: [], secrets: [], environmentUsers: [] },
    ],
    toolGrants: [{ userId: 'U_A', level: 'read', expiresAt: '2026-11-25T01:00:00.000Z', grantedBy: 'U_ADMIN' }],
    users: [
      { id: 'U_A', name: '에이' },
      { id: 'U_B', name: '비' },
      { id: 'U_C', name: '씨' },
    ],
  };
}

function page(opts: {
  adminMode: boolean;
  map?: 'present' | 'missing';
  inputs?: Record<string, { value: string }>;
  confirm?: boolean;
}) {
  const els: Record<string, any> = {
    'st-body': { innerHTML: '' },
    'st-status': { textContent: '', className: '', setAttribute: vi.fn() },
    'st-filter': { value: '' },
    ...(opts.inputs ?? {}),
  };
  const document = { getElementById: (id: string) => els[id] ?? null };
  const apiWrite = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
  const confirmDialog = vi.fn().mockResolvedValue(opts.confirm ?? true);
  const loadServerTools = vi.fn().mockResolvedValue(undefined);
  const api = new Function(
    'document',
    'adminModeOn',
    'apiWrite',
    'confirmDialog',
    'loadServerTools',
    `var _st = __DATA__;
${FNS.map(clientFn).join('\n')}
return { ${FNS.join(', ')}, state: function () { return _st; } };`.replace('__DATA__', JSON.stringify(data(opts.map))),
  )(document, () => opts.adminMode, apiWrite, confirmDialog, loadServerTools);
  return { api, els, apiWrite, confirmDialog, loadServerTools };
}

describe('서버 도구 tab — what an admin sees', () => {
  it('without admin mode: tools with levels, admin-only locked, servers, secrets, who is allowed, no controls', () => {
    const { api, els } = page({ adminMode: false });
    api.renderServerTools();
    const html: string = els['st-body'].innerHTML;
    expect(html).toContain('db_query');
    expect(html).toContain('MySQL 읽기');
    expect(html).toContain('관리자 전용');
    expect(html).toContain('표에 없음');
    // servers: sections, tools there, secrets (a missing one warned), environment grants by name
    expect(html).toContain('dev2');
    expect(html).toContain('acme-dev2');
    expect(html).toContain('databases.app.password');
    expect(html).toMatch(/⚠️[^<]*gh-missing|gh-missing[\s\S]{0,200}⚠️/);
    expect(html).toContain('비');
    // server-tools grants with the user's name
    expect(html).toContain('에이');
    // no controls
    expect(html).not.toContain('<select');
    expect(html).not.toContain('onclick="stRevokeGrant');
    expect(html).toContain('관리자 모드 켜기');
    // escaped
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('with admin mode: a level picker per tool that is not admin-only, grant and environment controls', () => {
    const { api, els } = page({ adminMode: true });
    api.renderServerTools();
    const html: string = els['st-body'].innerHTML;
    expect(html).toContain('data-tool="db_query"');
    expect(html).toContain('data-tool="redis_query"');
    expect(html).not.toContain('data-tool="gh_pr"');
    expect(html).toMatch(/data-tool="db_query"[^>]*>[\s\S]*?<option value="read" selected>/);
    expect(html).toContain('onclick="stRevokeGrant(this)"');
    expect(html).toContain('id="st-grant-user"');
    expect(html).toContain('onclick="stAddEnvUser(this)"');
    expect(html).toContain('onclick="stRemoveEnvUser(this)"');
  });

  it('without a permission map: the #1170 warning and 표 만들기; no level picker until the map exists', () => {
    const { api, els } = page({ adminMode: true, map: 'missing' });
    api.renderServerTools();
    const html: string = els['st-body'].innerHTML;
    expect(html).toContain('#1170');
    expect(html).toContain('모든 유저에게 열려');
    expect(html).toContain('onclick="stCreateMap()"');
    expect(html).not.toContain('data-tool="db_query"');
  });
});

describe('서버 도구 tab — filter', () => {
  it('narrows tools and servers by name', () => {
    const { api, els } = page({ adminMode: false });
    els['st-filter'].value = 'REDIS';
    api.renderServerTools();
    const html: string = els['st-body'].innerHTML;
    expect(html).toContain('<span class="st-name">redis_query</span>');
    expect(html).not.toContain('<span class="st-name">db_query</span>');
    // a server is kept when its name or one of its tools matches
    expect(html).toContain('dev2');
    expect(html).not.toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('서버 도구 tab — changes', () => {
  it('a level change sends PUT with the level, 표에 없음 sends null', async () => {
    const { api, apiWrite, loadServerTools } = page({ adminMode: true });
    await api.stSetLevel({ value: 'write', getAttribute: () => 'db_query' });
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/server-tools/permission/db_query', { level: 'write' });
    await api.stSetLevel({ value: '', getAttribute: () => 'redis_query' });
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/server-tools/permission/redis_query', { level: null });
    expect(loadServerTools).toHaveBeenCalledTimes(2);
  });

  it('a refused level change says why and redraws the old level', async () => {
    const { api, apiWrite, els } = page({ adminMode: true });
    apiWrite.mockResolvedValueOnce({ ok: false, status: 409, error: '그사이 설정 파일이 바뀌었습니다' });
    await api.stSetLevel({ value: 'write', getAttribute: () => 'db_query' });
    expect(els['st-status'].textContent).toBe('바꾸지 못했습니다: 그사이 설정 파일이 바뀌었습니다');
    expect(els['st-body'].innerHTML).toMatch(/data-tool="db_query"[^>]*>[\s\S]*?<option value="read" selected>/);
  });

  it('표 만들기 asks first, then POSTs; cancel sends nothing', async () => {
    const cancel = page({ adminMode: true, map: 'missing', confirm: false });
    await cancel.api.stCreateMap();
    expect(cancel.apiWrite).not.toHaveBeenCalled();
    const ok = page({ adminMode: true, map: 'missing' });
    await ok.api.stCreateMap();
    expect(ok.confirmDialog).toHaveBeenCalled();
    expect(ok.apiWrite).toHaveBeenCalledWith('POST', '/api/server-tools/permission', {});
    expect(ok.loadServerTools).toHaveBeenCalled();
  });

  it('adds a server-tools grant with user, level and duration; revokes one', async () => {
    const { api, apiWrite, els } = page({
      adminMode: true,
      inputs: {
        'st-grant-user': { value: 'U_C' },
        'st-grant-level': { value: 'write' },
        'st-grant-duration': { value: '7d' },
      },
    });
    apiWrite.mockResolvedValueOnce({ ok: true, status: 200, data: { toolGrants: [] } });
    await api.stAddGrant();
    expect(apiWrite).toHaveBeenCalledWith('POST', '/api/server-tools/grants', {
      userId: 'U_C',
      level: 'write',
      duration: '7d',
    });
    expect(els['st-status'].textContent).toContain('씨');
    await api.stRevokeGrant({ getAttribute: (k: string) => (k === 'data-user' ? 'U_A' : 'read') });
    expect(apiWrite).toHaveBeenLastCalledWith('DELETE', '/api/server-tools/grants/U_A/read');
  });

  it('a grant without a user sends nothing', async () => {
    const { api, apiWrite, els } = page({
      adminMode: true,
      inputs: {
        'st-grant-user': { value: '' },
        'st-grant-level': { value: 'read' },
        'st-grant-duration': { value: '7d' },
      },
    });
    await api.stAddGrant();
    expect(apiWrite).not.toHaveBeenCalled();
    expect(els['st-status'].textContent).toBe('허락할 사람을 고르세요');
  });

  it('adds and removes an environment grant and keeps the answer', async () => {
    const { api, apiWrite, els } = page({ adminMode: true, inputs: { 'st-env-pick-dev2': { value: 'U_A' } } });
    apiWrite.mockResolvedValueOnce({ ok: true, status: 200, data: { environmentUsers: ['U_B', 'U_A'] } });
    await api.stAddEnvUser({ getAttribute: (k: string) => (k === 'data-env' ? 'env:acme-dev2' : 'dev2') });
    expect(apiWrite).toHaveBeenCalledWith('POST', '/api/server-tools/environments/env%3Aacme-dev2/users', {
      userId: 'U_A',
      allow: true,
    });
    expect(api.state().servers[0].environmentUsers).toEqual(['U_B', 'U_A']);
    apiWrite.mockResolvedValueOnce({ ok: true, status: 200, data: { environmentUsers: ['U_A'] } });
    await api.stRemoveEnvUser({
      getAttribute: (k: string) => (k === 'data-env' ? 'env:acme-dev2' : k === 'data-user' ? 'U_B' : 'dev2'),
    });
    expect(apiWrite).toHaveBeenLastCalledWith('POST', '/api/server-tools/environments/env%3Aacme-dev2/users', {
      userId: 'U_B',
      allow: false,
    });
    expect(api.state().servers[0].environmentUsers).toEqual(['U_A']);
    expect(els['st-status'].textContent).toContain('비');
  });
});

describe('서버 도구 tab — on the page', () => {
  it('is an admin-only tab with its panel and its loader hook', () => {
    expect(SETTINGS_TABS).toContainEqual({ id: 'server-tools', label: '서버 도구', icon: 'shield', adminOnly: true });
    const html = renderSettingsPage();
    expect(html).toContain('<div slot="server-tools" data-tab="server-tools" class="page" hidden>');
    expect(html).toContain("if (id === 'server-tools' && !_stLoaded) loadServerTools();");
    expect(SERVER_TOOLS_CLIENT_JS).not.toContain('`');
    expect(SERVER_TOOLS_CLIENT_JS).not.toContain('${');
    const script = /<script>([\s\S]*?)<\/script>\n<script type="module"/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
  });
});
