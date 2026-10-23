/**
 * SSOT 2026-10-23 T4 — the settings page "프로젝트 메모리" tab, client half:
 * a non-admin reads the notes with a lock banner and no edit controls; an
 * admin edits only with admin mode on; what each control sends.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderSettingsPage, SETTINGS_CLIENT_JS } from '../settings-page';
import { PROJECT_CLIENT_JS } from '../settings-project-tab';

const ALL_JS = `${PROJECT_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`;

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

const PROJECT = {
  slug: '2lab-ai/soma-work',
  entries: ['CI 러너는 1대', '<b>배포</b>는 dev 먼저'],
  totalChars: 30,
  revision: 'p1',
  updatedAt: '2026-10-23T05:00:00.000Z',
  updatedBy: 'U_ADMIN',
  channels: ['soma-work-dev'],
};

function detail(isAdmin: boolean, adminMode: boolean) {
  const el: any = { innerHTML: '' };
  const fns = load<any>(['esc', 'escAttr', 'pmIsAdmin', 'pmCanEdit', 'pmProject', 'renderProjectDetail'], {
    document: { getElementById: () => el },
    _pm: { isAdmin, projects: [PROJECT] },
    _pmSlug: PROJECT.slug,
    _pmEditing: -1,
    adminModeOn: () => adminMode,
    fmtNum: (n: number) => String(n),
  });
  return { fns, el };
}

describe('프로젝트 메모리 tab', () => {
  it('the page carries the tab and the whole script still parses', () => {
    const html = renderSettingsPage();
    expect(html).toContain('<a href="#project">프로젝트 메모리</a>');
    expect(html).toContain('<div data-tab="project" class="page" hidden>');
    const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
    expect(PROJECT_CLIENT_JS).not.toContain('`');
    expect(PROJECT_CLIENT_JS).not.toContain('${');
  });

  it('a non-admin reads the notes (escaped) with no edit control at all', () => {
    const { fns, el } = detail(false, true);
    fns.renderProjectDetail();
    expect(el.innerHTML).toContain('공유 프로젝트 메모리 · 2lab-ai/soma-work');
    expect(el.innerHTML).toContain('CI 러너는 1대');
    expect(el.innerHTML).toContain('&lt;b&gt;배포&lt;/b&gt;');
    expect(el.innerHTML).not.toMatch(/<textarea|pmEditStart|pmDelete|pmAdd|pmClear/);
  });

  it('an admin without admin mode also gets no controls; with admin mode, edit / delete / add / clear', () => {
    const off = detail(true, false);
    off.fns.renderProjectDetail();
    expect(off.el.innerHTML).not.toMatch(/pmEditStart|pmAdd/);
    const on = detail(true, true);
    on.fns.renderProjectDetail();
    expect(on.el.innerHTML).toContain('onclick="pmEditStart(1)"');
    expect(on.el.innerHTML).toContain('onclick="pmDelete(0)"');
    expect(on.el.innerHTML).toContain('onclick="pmAdd()"');
    expect(on.el.innerHTML).toContain('모든 사용자에게 적용');
  });

  it('the banner says read-only for a non-admin, offers admin mode to an admin', () => {
    const els: Record<string, any> = { 'pm-banner': { innerHTML: '' }, 'pm-new-box': { innerHTML: '' } };
    const run = (isAdmin: boolean, mode: boolean) =>
      load<any>(['pmIsAdmin', 'pmCanEdit', 'paintProjectBanner'], {
        document: { getElementById: (id: string) => els[id] },
        _pm: { isAdmin },
        adminModeOn: () => mode,
      }).paintProjectBanner();
    run(false, false);
    expect(els['pm-banner'].innerHTML).toContain('읽기 전용 — 관리자만 수정할 수 있습니다.');
    expect(els['pm-new-box'].innerHTML).toBe('');
    run(true, false);
    expect(els['pm-banner'].innerHTML).toContain('관리자 모드 켜기');
    run(true, true);
    expect(els['pm-banner'].innerHTML).toContain('모든 세션에 적용');
    expect(els['pm-new-box'].innerHTML).toContain('owner/repo');
  });

  it('the banner explains an anonymous dashboard and an unreadable store instead of looking empty (#380 review)', () => {
    const els: Record<string, any> = { 'pm-banner': { innerHTML: '' }, 'pm-new-box': { innerHTML: '' } };
    const run = (pm: Record<string, unknown>) =>
      load<any>(['esc', 'pmIsAdmin', 'pmCanEdit', 'paintProjectBanner'], {
        document: { getElementById: (id: string) => els[id] },
        _pm: pm,
        adminModeOn: () => true,
      }).paintProjectBanner();
    run({ isAdmin: false, readOnlyReason: 'anonymous' });
    expect(els['pm-banner'].innerHTML).toContain('인증이 설정되지 않아');
    expect(els['pm-new-box'].innerHTML).toBe('');
    run({ isAdmin: true, storeError: '파일을 <읽을> 수 없어' });
    expect(els['pm-banner'].innerHTML).toContain('role="alert"');
    expect(els['pm-banner'].innerHTML).toContain('파일을 &lt;읽을&gt; 수 없어');
    expect(els['pm-banner'].innerHTML).toContain('모든 세션에 적용'); // the admin banner is still there
  });

  it('add sends project, text and the loaded revision; a 409 reloads and keeps the draft', async () => {
    const status: any = { textContent: '', setAttribute() {} };
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { project: { ...PROJECT, revision: 'p2' } } })
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'conflict' });
    const loadProjects = vi.fn(async () => {});
    const fns = load<any>(['pmProject', 'pmStatus', 'pmWrite', 'pmAdd'], {
      document: { getElementById: (id: string) => (id === 'pm-new' ? { value: '새 규칙' } : status) },
      _pm: { isAdmin: true, projects: [{ ...PROJECT }] },
      _pmSlug: PROJECT.slug,
      _pmEditing: -1,
      apiWrite,
      loadProjects,
      paintProjectList: () => {},
      renderProjectDetail: () => {},
    });
    await fns.pmAdd();
    expect(apiWrite).toHaveBeenCalledWith('POST', '/api/project-memory/entries', {
      project: '2lab-ai/soma-work',
      text: '새 규칙',
      revision: 'p1',
    });
    await fns.pmAdd();
    expect(loadProjects).toHaveBeenCalled();
    expect(status.textContent).toContain('다른 관리자');
    expect(status.textContent).toContain('새 항목 칸');
  });

  it('a 409 puts the whole draft back into the add box after the reload, however long (review R3)', async () => {
    const status: any = { textContent: '', setAttribute() {} };
    const newBox: any = { value: '' };
    const long = '긴 규칙 '.repeat(195); // 975 chars, under the 1,000-character cap
    const loadProjects = vi.fn(async () => {
      newBox.value = ''; // the reload re-renders the detail: the add box comes back empty
    });
    const fns = load<any>(['pmStatus', 'pmWrite'], {
      document: { getElementById: (id: string) => (id === 'pm-new' ? newBox : status) },
      _pm: { isAdmin: true, projects: [{ ...PROJECT }] },
      apiWrite: async () => ({ ok: false, status: 409, error: 'conflict' }),
      loadProjects,
      paintProjectList: () => {},
      renderProjectDetail: () => {},
    });
    expect(await fns.pmWrite('PUT', '/api/project-memory/entries/0', { project: PROJECT.slug, text: long }, long)).toBe(
      false,
    );
    expect(loadProjects).toHaveBeenCalled();
    expect(newBox.value).toBe(long);
    expect(status.textContent).toContain('새 항목 칸');
  });
});
