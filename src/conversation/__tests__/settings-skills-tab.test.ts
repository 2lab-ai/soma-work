/**
 * #1079 — the settings page "스킬" tab, client half: what each viewer sees in 내 스킬 / 환경 스킬 /
 * 시스템 스킬, who gets edit controls (the owner; an admin with admin mode on), and what each
 * control sends. The functions are cut out of the shipped script and run as they ship.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderSettingsPage, SETTINGS_CLIENT_JS, SETTINGS_TABS } from '../settings-page';
import { SKILLS_CLIENT_JS } from '../settings-skills-tab';

const ALL_JS = `${SKILLS_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`;

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

const RENDER = [
  'esc',
  'escAttr',
  'skIsAdmin',
  'skCanEditEnv',
  'skUserName',
  'skFilterText',
  'skMatches',
  'skAccessLabel',
  'skGrantEditor',
  'skEnvBanner',
  'skRow',
  'skFindMine',
  'skFindEnv',
  'skContent',
  'skBack',
  'skMineList',
  'skEnvList',
  'skPickId',
  'skSystemList',
  'skMineDetail',
  'skEnvDetail',
  'skSystemDetail',
  'renderSkills',
];

const USERS = [
  { id: 'U_ME', name: '나' },
  { id: 'U_A', name: '에이' },
  { id: 'U_B', name: '<b>비</b>' },
];

function snapshot(over: Record<string, unknown> = {}) {
  return {
    me: 'U_ME',
    isAdmin: false,
    users: USERS,
    mine: {
      allowAll: ['U_A'],
      skills: [
        { name: 'deploy', description: '배포 <절차>', isSingleFile: true, allowed: ['U_B'] },
        { name: 'multi', description: '여러 파일', isSingleFile: false, allowed: [] },
      ],
    },
    env: { skills: [{ key: 'envx:post-deploy', plugin: 'envx', name: 'post-deploy', access: 'none' }] },
    system: [
      { source: 'local', name: 'zcheck', description: 'gate' },
      { source: 'local', name: 'explore', description: 'search' },
      { source: 'stv', name: 'debug', description: '버그' },
    ],
    ...over,
  };
}

function view(state: { sk: any; open?: any; detail?: any; adminMode?: boolean; filter?: string; section?: string }) {
  const els: Record<string, any> = {
    'sk-detail': { innerHTML: '' },
    'sk-filter': { value: state.filter ?? '' },
  };
  const fns = load<any>(RENDER, {
    document: { getElementById: (id: string) => els[id] ?? null },
    _sk: state.sk,
    _skSection: state.section ?? 'mine',
    _skOpen: state.open ?? null,
    _skDetail: state.detail ?? null,
    _skDetailError: '',
    adminModeOn: () => !!state.adminMode,
  });
  fns.renderSkills();
  return els['sk-detail'].innerHTML as string;
}

describe('스킬 tab — the page', () => {
  it('carries the tab (lazy-loaded on first show) and the whole script still parses', () => {
    expect(SETTINGS_TABS).toContainEqual({ id: 'skills', label: '스킬', icon: 'file-code' });
    const html = renderSettingsPage();
    expect(html).toContain('<div slot="skills" data-tab="skills" class="page" hidden>');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    expect(script).toContain('function loadSkills');
    expect(script).toContain("if (id === 'skills' && !_skLoaded) loadSkills();");
    expect(() => new Function(script)).not.toThrow();
    expect(SKILLS_CLIENT_JS).not.toContain('`');
    expect(SKILLS_CLIENT_JS).not.toContain('${');
  });
});

describe('스킬 tab — 내 스킬', () => {
  it('lists my skills (escaped) and lets me say who runs all of them — never offering myself', () => {
    const html = view({ sk: snapshot() });
    expect(html).toContain('deploy');
    expect(html).toContain('배포 &lt;절차&gt;');
    expect(html).toContain('data-sec="mine" data-id="deploy"');
    // allowAll: 에이 is a chip with a remove button; the picker offers 비 but neither me nor 에이
    expect(html).toContain('에이<button');
    expect(html).toContain('data-user="U_A"');
    expect(html).toContain('<option value="U_B">&lt;b&gt;비&lt;/b&gt;</option>');
    expect(html).not.toContain('<option value="U_ME">');
    expect(html).not.toContain('<option value="U_A">');
  });

  it('a SKILL.md that starts with a blank line keeps it: the parser drops the first newline after <textarea> and <pre> (fable 1091-3)', () => {
    const detail = { name: 'deploy', content: '\nintro', hash: 'h1', isSingleFile: true };
    const edit = view({ sk: snapshot(), open: { section: 'mine', id: 'deploy' }, detail });
    expect(edit).toMatch(/<textarea[^>]*>\n\nintro<\/textarea>/);
    const sys = view({ sk: snapshot(), open: { section: 'system', id: 'stv:debug', source: 'stv' }, detail });
    if (sys.includes('<pre')) expect(sys).toMatch(/<pre[^>]*>\n\nintro<\/pre>/);
  });

  it('a viewer-token session has no 내 스킬: it says why', () => {
    const html = view({ sk: snapshot({ mine: null, me: null }) });
    expect(html).toContain('Slack 계정으로 로그인');
    expect(html).not.toContain('skAddGrant');
  });

  it('an open skill shows who may run it and SKILL.md in an editor; a multi-file skill says only SKILL.md is edited', () => {
    const one = view({
      sk: snapshot(),
      open: { section: 'mine', id: 'deploy' },
      detail: { name: 'deploy', content: '---\n<x>\n---', hash: 'h1', isSingleFile: true },
    });
    expect(one).toContain('<textarea');
    expect(one).toContain('&lt;x&gt;');
    expect(one).toContain('onclick="skSaveMine()"');
    expect(one).toContain('data-user="U_B"'); // the per-skill grant
    expect(one).toContain('내 모든 스킬을 실행할 수 있는 사람도 실행합니다');
    expect(one).not.toContain('SKILL.md만 고칩니다');
    const multi = view({
      sk: snapshot(),
      open: { section: 'mine', id: 'multi' },
      detail: { name: 'multi', content: 'x', hash: 'h2', isSingleFile: false },
    });
    expect(multi).toContain('SKILL.md만 고칩니다');
  });

  it('save sends the content and the hash it was read with; a 409 keeps the draft and says so', async () => {
    const status: any = { textContent: '', setAttribute() {} };
    const ta = { value: 'new body', getAttribute: () => 'deploy' };
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'conflict' })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          skill: { name: 'deploy', description: '새 설명', content: 'new body', hash: 'h2', isSingleFile: true },
        },
      });
    const sk = snapshot();
    const renderSkills = vi.fn();
    const fns = load<any>(['skStatus', 'skSaveMine'], {
      document: { getElementById: (id: string) => (id === 'sk-edit' ? ta : status) },
      _sk: sk,
      _skOpen: { section: 'mine', id: 'deploy' },
      _skDetail: { name: 'deploy', content: 'old', hash: 'h1', isSingleFile: true },
      apiWrite,
      renderSkills,
    });
    expect(await fns.skSaveMine()).toBe(false);
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/skills/mine/deploy', { content: 'new body', hash: 'h1' });
    expect(status.textContent).toContain('다른 곳에서 이 스킬이 바뀌어');
    expect(ta.value).toBe('new body');
    expect(await fns.skSaveMine()).toBe(true);
    expect(sk.mine.skills[0].description).toBe('새 설명');
    expect(status.textContent).toBe('저장했습니다');
  });

  it('an empty editor is not sent', async () => {
    const status: any = { textContent: '', setAttribute() {} };
    const apiWrite = vi.fn();
    const fns = load<any>(['skStatus', 'skSaveMine'], {
      document: { getElementById: (id: string) => (id === 'sk-edit' ? { value: '  \n' } : status) },
      _sk: snapshot(),
      _skOpen: { section: 'mine', id: 'deploy' },
      _skDetail: { name: 'deploy', content: 'old', hash: 'h1' },
      apiWrite,
      renderSkills: () => {},
    });
    expect(await fns.skSaveMine()).toBe(false);
    expect(apiWrite).not.toHaveBeenCalled();
  });
});

describe('스킬 tab — grants', () => {
  it('add and remove send one grant change, skill null meaning all; the answer replaces that scope', async () => {
    const status: any = { textContent: '', setAttribute() {} };
    const sk = snapshot();
    const fresh = { allowAll: [], skills: [] };
    const apiWrite = vi.fn().mockResolvedValue({ ok: true, data: { mine: fresh } });
    const fns = load<any>(['skStatus', 'skSetGrant', 'skAddGrant', 'skRemoveGrant', 'skPickId'], {
      document: { getElementById: (id: string) => (id === 'sk-pick-all' ? { value: 'U_B' } : status) },
      _sk: sk,
      apiWrite,
      renderSkills: () => {},
    });
    const btn = (attrs: Record<string, string>) => ({ getAttribute: (k: string) => attrs[k] ?? null });
    await fns.skAddGrant(btn({ 'data-scope': 'mine', 'data-skill': '' }));
    expect(apiWrite).toHaveBeenLastCalledWith('POST', '/api/skills/grants', {
      scope: 'mine',
      skill: null,
      userId: 'U_B',
      allow: true,
    });
    expect(sk.mine).toBe(fresh);
    await fns.skRemoveGrant(btn({ 'data-scope': 'env', 'data-skill': 'envx:post-deploy', 'data-user': 'U_A' }));
    expect(apiWrite).toHaveBeenLastCalledWith('POST', '/api/skills/grants', {
      scope: 'env',
      skill: 'envx:post-deploy',
      userId: 'U_A',
      allow: false,
    });
    await fns.skRemoveGrant(btn({ 'data-scope': 'environment', 'data-skill': 'env:acme-dev2', 'data-user': 'U_A' }));
    expect(apiWrite).toHaveBeenLastCalledWith('POST', '/api/skills/grants', {
      scope: 'environment',
      skill: 'env:acme-dev2',
      userId: 'U_A',
      allow: false,
    });
  });

  it('a refusal is shown, and nothing local changes', async () => {
    const status: any = { textContent: '', setAttribute() {} };
    const sk = snapshot();
    const before = sk.env;
    const fns = load<any>(['skStatus', 'skSetGrant'], {
      document: { getElementById: () => status },
      _sk: sk,
      apiWrite: async () => ({ ok: false, status: 403, error: 'Forbidden' }),
      renderSkills: () => {},
    });
    expect(await fns.skSetGrant('env', null, 'U_A', true)).toBe(false);
    expect(status.textContent).toContain('Forbidden');
    expect(sk.env).toBe(before);
  });
});

describe('스킬 tab — 환경 스킬', () => {
  const adminEnv = {
    allowAll: ['U_A'],
    skills: [
      {
        key: 'envx:post-deploy',
        plugin: 'envx',
        name: 'post-deploy',
        access: 'admin',
        description: 'QA',
        allowed: ['U_B'],
      },
    ],
  };

  it('a non-admin sees the names and their own access, no grant control, and how to ask', () => {
    const html = view({
      sk: snapshot({
        env: {
          skills: [
            { key: 'envx:post-deploy', plugin: 'envx', name: 'post-deploy', access: 'none' },
            { key: 'envx:smoke', plugin: 'envx', name: 'smoke', access: 'granted', description: '스모크' },
          ],
        },
      }),
      section: 'env',
    });
    expect(html).toContain('envx:post-deploy');
    expect(html).toContain('권한 없음');
    expect(html).toContain('허용됨');
    expect(html).toContain('스모크');
    expect(html).toContain('관리자에게 승인 요청');
    expect(html).not.toMatch(/skAddGrant|skRemoveGrant/);
  });

  it('an admin without admin mode sees who has access read-only and the admin-mode switch', () => {
    const html = view({ sk: snapshot({ isAdmin: true, env: adminEnv }), section: 'env' });
    expect(html).toContain('관리자 모드 켜기');
    expect(html).toContain('에이'); // allowAll, read-only
    expect(html).not.toMatch(/skAddGrant|skRemoveGrant/);
    const on = view({ sk: snapshot({ isAdmin: true, env: adminEnv }), section: 'env', adminMode: true });
    expect(on).toContain('관리자 모드 끄기');
    expect(on).toContain('onclick="skAddGrant(this)"');
    expect(on).toContain('data-scope="env"');
    // the admin may pick anyone, themselves included (admins are exempt anyway, but the list is not 'mine')
    expect(on).toContain('<option value="U_ME">');
  });

  // env-access WU4 (#1212): who holds each environment whole, and taking it back.
  it('an admin sees who holds each environment whole; in admin mode adds and removes them', () => {
    const env = {
      ...adminEnv,
      environments: [{ id: 'env:acme-dev2', label: 'acme-dev2', skills: ['envx:*'], allowed: ['U_B'] }],
    };
    const ro = view({ sk: snapshot({ isAdmin: true, env }), section: 'env' });
    expect(ro).toContain('acme-dev2');
    expect(ro).toContain('비');
    expect(ro).not.toContain('data-scope="environment"');
    const on = view({ sk: snapshot({ isAdmin: true, env }), section: 'env', adminMode: true });
    expect(on).toContain('data-scope="environment" data-skill="env:acme-dev2"');
    expect(on).toContain('id="sk-pick-env-env:acme-dev2"');
  });

  // trinity R3 (fable): a grant left for an environment no longer in config is marked, and only removable.
  it('marks an environment that left the config and offers no way to add to it', () => {
    const env = {
      ...adminEnv,
      environments: [{ id: 'env:acme-gone', label: 'acme-gone', skills: [], allowed: ['U_B'], inConfig: false }],
    };
    const on = view({ sk: snapshot({ isAdmin: true, env }), section: 'env', adminMode: true });
    expect(on).toContain('설정에 없음');
    expect(on).toContain('onclick="skRemoveGrant(this)"');
    expect(on).not.toContain('id="sk-pick-env-env:acme-gone"');
  });

  it('an open skill: no access → the ask hint and no content; admin → per-skill grants; admin mode → the editor (1.b)', () => {
    const none = view({
      sk: snapshot(),
      section: 'env',
      open: { section: 'env', id: 'envx:post-deploy' },
    });
    expect(none).toContain('$envx:post-deploy');
    expect(none).toContain('관리자에게 승인 요청');
    expect(none).not.toContain('<pre');
    const admin = view({
      sk: snapshot({ isAdmin: true, env: adminEnv }),
      section: 'env',
      adminMode: true,
      open: { section: 'env', id: 'envx:post-deploy' },
      detail: { key: 'envx:post-deploy', content: 'SECRET <b>', description: 'QA' },
    });
    // admin mode on: SKILL.md in an editor that saves through skSaveEnv, with what the edit lasts until said first
    expect(admin).toContain('<textarea id="sk-edit"');
    expect(admin).toContain('data-name="envx:post-deploy"');
    expect(admin).toContain('SECRET &lt;b&gt;');
    expect(admin).toContain('onclick="skSaveEnv()"');
    expect(admin).toContain('data-user="U_B"');
    expect(admin).toContain('저장소에 새 커밋이 생기거나');
    expect(admin).not.toContain('<pre');
    // admin mode off: read-only, and how to edit
    const adminOff = view({
      sk: snapshot({ isAdmin: true, env: adminEnv }),
      section: 'env',
      open: { section: 'env', id: 'envx:post-deploy' },
      detail: { key: 'envx:post-deploy', content: 'SECRET', description: 'QA' },
    });
    expect(adminOff).toContain('<pre');
    expect(adminOff).toContain('관리자 모드를 켜면 여기서 고칠 수 있습니다');
    expect(adminOff).not.toContain('<textarea');
    // a granted non-admin reads it, never edits
    const granted = view({
      sk: snapshot({
        env: { skills: [{ key: 'envx:post-deploy', plugin: 'envx', name: 'post-deploy', access: 'granted' }] },
      }),
      section: 'env',
      adminMode: true,
      open: { section: 'env', id: 'envx:post-deploy' },
      detail: { key: 'envx:post-deploy', content: 'SECRET', description: 'QA' },
    });
    expect(granted).toContain('<pre');
    expect(granted).not.toMatch(/<textarea|skSaveEnv|관리자 모드를 켜면/);
  });

  it('an admin saves an environment skill with the hash it was read with; 409 keeps the draft; 403 says why', async () => {
    const status: any = { textContent: '', setAttribute() {} };
    const ta = { value: 'edited', getAttribute: () => 'envx:post-deploy' };
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'conflict' })
      .mockResolvedValueOnce({ ok: false, status: 403, error: 'Forbidden' })
      .mockResolvedValueOnce({
        ok: true,
        data: { skill: { key: 'envx:post-deploy', description: '새 설명', content: 'edited', hash: 'h2' } },
      });
    const sk = snapshot({ isAdmin: true, env: adminEnv });
    const fns = load<any>(['skStatus', 'skFindEnv', 'skSaveEnv'], {
      document: { getElementById: (id: string) => (id === 'sk-edit' ? ta : status) },
      _sk: sk,
      _skOpen: { section: 'env', id: 'envx:post-deploy' },
      _skDetail: { key: 'envx:post-deploy', content: 'old', hash: 'h1' },
      apiWrite,
      renderSkills: () => {},
    });
    expect(await fns.skSaveEnv()).toBe(false);
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/skills/env/envx%3Apost-deploy', {
      content: 'edited',
      hash: 'h1',
    });
    expect(status.textContent).toContain('다른 곳에서 이 스킬이 바뀌어');
    expect(ta.value).toBe('edited');
    expect(await fns.skSaveEnv()).toBe(false);
    expect(status.textContent).toContain('권한이 없습니다');
    expect(await fns.skSaveEnv()).toBe(true);
    expect((sk.env.skills[0] as { description?: string }).description).toBe('새 설명');
    expect(status.textContent).toBe('저장했습니다');
  });

  it('opening an env skill without access fetches nothing', async () => {
    const fetch = vi.fn();
    const fns = load<any>(['skFindEnv', 'skDetailUrl', 'skOpen'], {
      _sk: snapshot(),
      _skOpen: null,
      _skDetail: null,
      _skDetailError: '',
      fetch,
      renderSkills: () => {},
    });
    await fns.skOpen('env', 'envx:post-deploy');
    expect(fetch).not.toHaveBeenCalled();
    expect(fns.skDetailUrl('env', 'envx:post-deploy')).toBeNull();
    expect(fns.skDetailUrl('mine', 'deploy')).toBe('/api/skills/mine/deploy');
    expect(fns.skDetailUrl('system', 'debug', 'stv')).toBe('/api/skills/system/stv/debug');
  });
});

describe('스킬 tab — 시스템 스킬', () => {
  it('groups by source with counts, read-only; the filter narrows the list', () => {
    const html = view({ sk: snapshot(), section: 'system' });
    expect(html).toMatch(/local <span class="lock">2<\/span>/);
    expect(html).toMatch(/stv <span class="lock">1<\/span>/);
    expect(html).toContain('data-sec="system" data-id="debug" data-src="stv"');
    expect(html).not.toMatch(/<textarea|skAddGrant/);
    const filtered = view({ sk: snapshot(), section: 'system', filter: 'BUG' });
    expect(filtered).not.toContain('zcheck');
    expect(filtered).toContain('debug');
  });

  it('an open system skill shows its SKILL.md read-only', () => {
    const html = view({
      sk: snapshot(),
      section: 'system',
      open: { section: 'system', id: 'debug', source: 'stv' },
      detail: { source: 'stv', name: 'debug', content: 'BODY <i>', description: '버그' },
    });
    expect(html).toContain('stv:debug');
    expect(html).toContain('BODY &lt;i&gt;');
    expect(html).not.toContain('<textarea');
  });
});
