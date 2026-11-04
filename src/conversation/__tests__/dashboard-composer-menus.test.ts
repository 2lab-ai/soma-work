/**
 * The composers' `/` and `$` menus on the dashboard (2026-11-04): the route that hands each composer its triggers,
 * and the page code that puts them into both composers' data (the new task's and the open session's).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function loadWith<T>(fns: string[], globals: Record<string, unknown>): T {
  const names = Object.keys(globals);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => globals[n])) as T;
}

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: 604800,
  },
};
vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [] }),
}));

const SLASH = {
  char: '/',
  at: 'start',
  label: '명령어',
  items: [{ value: '/model', description: 'x', example: '/model opus' }],
};
const DOLLAR = { char: '$', at: 'word', label: '스킬', items: [{ value: '$local:autoz' }] };

describe('GET /api/dashboard/composer-menus', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let menus: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    const dashboard = await import('../dashboard');
    menus = vi.fn((opts: { where: string }) => (opts.where === 'new-task' ? [SLASH] : [SLASH, DOLLAR]));
    dashboard.setDashboardComposerMenus(menus as never);
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  async function signIn(slackUserId = 'U_PLAIN') {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: 'Plain' });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const setCookie = sso.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
  }

  it('hands a signed-in user the triggers of both composers, for them', async () => {
    const cookie = await signIn('U_PLAIN');
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/composer-menus', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ newTask: [SLASH], session: [SLASH, DOLLAR] });
    expect(menus).toHaveBeenCalledWith({ where: 'new-task', userId: 'U_PLAIN', admin: false });
    expect(menus).toHaveBeenCalledWith({ where: 'session', userId: 'U_PLAIN', admin: false });
  });

  it('a viewer token names nobody: no personal skills, no admin rows', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/composer-menus',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(menus).toHaveBeenCalledWith({ where: 'session', userId: undefined, admin: false });
  });

  it('refuses a request with no sign-in', async () => {
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/composer-menus' });
    expect(res.statusCode).toBe(401);
    expect(menus).not.toHaveBeenCalled();
  });

  it('a menu that cannot be built is a 500, not a crash', async () => {
    menus.mockImplementation(() => {
      throw new Error('disk gone');
    });
    const cookie = await signIn();
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/composer-menus', headers: { cookie } });
    expect(res.statusCode).toBe(500);
  });
});

describe('page — both composers take the menus', () => {
  const NT_GLOBALS = {
    _ntValue: '',
    _ntState: null,
    _ntCtx: null,
    ntReadDraft: () => null,
    ntDictationUsable: () => false,
    ntSendNarrow: () => false,
    ntDictationWide: () => true,
    NT_NO_FILES: '.none',
    window: {},
    PC_LIMITS: { maxFiles: 10, maxFileBytes: 1, maxTotalBytes: 2 },
    PC_NO_FILES: '.none',
  };

  it('the new-task composer gets newTask, the session composer gets session', () => {
    const page = loadWith<{ ntComposerData(): any; pcComposerData(t?: boolean): any }>(
      ['cmTriggersFor', 'ntComposerData', 'pcComposerData'],
      { ...NT_GLOBALS, _cmMenus: { newTask: [SLASH], session: [SLASH, DOLLAR] } },
    );
    expect(page.ntComposerData().triggers).toEqual([SLASH]);
    expect(page.pcComposerData(true).triggers).toEqual([SLASH, DOLLAR]);
  });

  it('before the menus arrive the composers have none', () => {
    const page = loadWith<{ ntComposerData(): any; pcComposerData(t?: boolean): any }>(
      ['cmTriggersFor', 'ntComposerData', 'pcComposerData'],
      { ...NT_GLOBALS, _cmMenus: null },
    );
    expect('triggers' in page.ntComposerData()).toBe(false);
    expect('triggers' in page.pcComposerData(true)).toBe(false);
  });

  it('loads the menus and repaints both composers; a failed load leaves them as they were', async () => {
    const paintNtComposer = vi.fn();
    const pcPaintComposer = vi.fn();
    const state: { _cmMenus: unknown } = { _cmMenus: null };
    const fetchOk = vi.fn(async () => ({ ok: true, json: async () => ({ newTask: [SLASH], session: [DOLLAR] }) }));
    const src = `var _cmMenus = null;\n${clientFn('cmTriggersFor')}\n${clientFn('cmLoadMenus')}\nreturn { cmLoadMenus, menus: function () { return _cmMenus; }, cmTriggersFor };`;
    const page = new Function('fetch', 'paintNtComposer', 'pcPaintComposer', src)(
      fetchOk,
      paintNtComposer,
      pcPaintComposer,
    ) as { cmLoadMenus(): Promise<void>; menus(): any; cmTriggersFor(w: string): any };
    await page.cmLoadMenus();
    expect(fetchOk).toHaveBeenCalledWith('/api/dashboard/composer-menus');
    expect(page.cmTriggersFor('newTask')).toEqual([SLASH]);
    expect(page.cmTriggersFor('session')).toEqual([DOLLAR]);
    expect(paintNtComposer).toHaveBeenCalledTimes(1);
    expect(pcPaintComposer).toHaveBeenCalledTimes(1);
    void state;

    const failing = new Function('fetch', 'paintNtComposer', 'pcPaintComposer', src)(
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
      paintNtComposer,
      pcPaintComposer,
    ) as { cmLoadMenus(): Promise<void>; cmTriggersFor(w: string): any };
    await failing.cmLoadMenus();
    expect(failing.cmTriggersFor('session')).toBeNull();
    expect(paintNtComposer).toHaveBeenCalledTimes(1);
  });

  it('the page loads the menus at start and again when the new-task dialog opens', () => {
    const boot = TEMPLATE.slice(TEMPLATE.indexOf('\nntInit();'), TEMPLATE.indexOf('\nntInit();') + 200);
    expect(boot).toContain('cmLoadMenus();');
    const open = clientFn('openNewTask');
    expect(open).toContain('cmLoadMenus()');
  });
});
