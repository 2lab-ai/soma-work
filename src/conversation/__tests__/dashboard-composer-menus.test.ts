/**
 * The composers' `/` and `$` menus on the dashboard (2026-11-04): the route that hands each composer its triggers,
 * and the page code that puts them into both composers' data (the new task's and the open session's).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    // A cold import of the web server (every case resets the modules) can take longer than the default 10s.
  }, 30_000);

  afterEach(async () => {
    await stopWebServer?.();
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

describe('POST /api/dashboard/session/:key/command — where a command answers', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;

  // The first import transforms the whole web server: pay it once (dashboard-command-attachments.test.ts).
  beforeAll(async () => {
    await import('../web-server');
    await import('../dashboard');
  }, 300_000);

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 'sid1',
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'idle',
      state: 'MAIN',
      lastActivity: new Date(),
    });
    dashboard.setDashboardSessionAccessor(() => sessions);
    dashboard.setDashboardCommandHandler(vi.fn().mockResolvedValue(undefined));
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    await stopWebServer?.();
  });

  const send = (message: string) =>
    injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent('C1:t1')}/command`,
      headers: { Authorization: 'Bearer test-token' },
      payload: { message },
    });

  it('a command the router answers and consumes: its answer is in the Slack thread', async () => {
    const classify = vi.fn(() => 'control');
    dashboard.setDashboardCommandClassifier(classify);
    const res = await send('/help');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, answer: 'thread' });
    // Classified as whoever it runs as: the sender, else the session's owner (a viewer token names nobody).
    expect(classify).toHaveBeenCalledWith('/help', 'U1');
  });

  it('an inline directive ahead of a command: what runs is the command after it (%model opus /help)', async () => {
    const classify = vi.fn((text: string) => (text === '/help' ? 'control' : 'instruction'));
    dashboard.setDashboardCommandClassifier(classify);
    expect(JSON.parse((await send('%model opus /help')).body)).toEqual({ ok: true, answer: 'thread' });
    expect(classify).toHaveBeenLastCalledWith('/help', 'U1');
    // A directive with an instruction after it is the user's turn.
    expect(JSON.parse((await send('%nogoal 이 함수 이름만 바꿔줘')).body)).toEqual({ ok: true });
  });

  it('a classifier that throws after the command went out still answers ok — a 500 would make Retry send it twice', async () => {
    dashboard.setDashboardCommandClassifier(() => {
      throw new Error('probe broke');
    });
    const res = await send('/help');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('an instruction, or a command that starts a turn: the turn is on the board — no answer field', async () => {
    dashboard.setDashboardCommandClassifier(() => 'control-with-dispatch');
    expect(JSON.parse((await send('/goal ship it')).body)).toEqual({ ok: true });
    dashboard.setDashboardCommandClassifier(() => 'instruction');
    expect(JSON.parse((await send('로그인 버그 고쳐줘')).body)).toEqual({ ok: true });
  });

  it('no classifier wired: as before', async () => {
    expect(JSON.parse((await send('/help')).body)).toEqual({ ok: true });
  });
});

describe('page — a command answered in the Slack thread', () => {
  it('says where the answer is, with the thread link when the card has one', () => {
    const page = loadWith<{ pcThreadAnswerToast(s: unknown): any }>(['pcThreadAnswerToast'], {});
    expect(page.pcThreadAnswerToast({ slackThreadUrl: 'https://slack.example/p1' })).toEqual({
      title: '명령을 보냈어요',
      description: '답은 Slack 스레드에 있어요',
      tone: 'success',
      link: { label: 'Slack에서 보기', href: 'https://slack.example/p1' },
    });
    expect(page.pcThreadAnswerToast(null)).toEqual({
      title: '명령을 보냈어요',
      description: '답은 Slack 스레드에 있어요',
      tone: 'success',
    });
  });

  it('sendCommand drops the turn it showed and says so when the answer went to the thread', () => {
    const src = clientFn('sendCommand');
    expect(src).toContain("data.answer === 'thread'");
    expect(src).toMatch(/answeredInThread[\s\S]*dropTurnFromPanel\(optimisticId\)/);
    expect(src).toContain('pcThreadAnswerToast(_sessionCache[sendingSessionKey])');
  });
});

describe('POST /api/dashboard/new-task — a first message that only answers starts no task (trinity R2, grok-elon)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let start: ReturnType<typeof vi.fn>;
  const CONTEXT = {
    models: [
      {
        nickname: 'opus[1m]',
        model: 'claude-opus-5-5[1m]',
        label: 'Opus 5.5 (1M)',
        battery: { level: 0.5, best: 0.5, windows: [], accounts: { measured: 1, total: 1, available: 1 } },
      },
    ],
    defaultModel: 'opus[1m]',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    channels: [{ id: 'C_ALPHA', name: 'workspace-alpha', repos: ['2lab-ai/soma-work'] }],
    defaultChannelId: 'C_ALPHA',
    membershipUnknown: false,
    autogoalDefault: true,
    usage: { scope: 'shared-pool', source: 'llmux', fetchedAt: 1 },
    limits: { maxPromptChars: 12000, maxFiles: 10, maxFileBytes: 20971520, maxTotalBytes: 31457280 },
  };

  beforeAll(async () => {
    await import('../web-server');
    await import('../dashboard');
  }, 300_000);

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    start = vi.fn(async () => ({
      channel: 'C_ALPHA',
      threadTs: '1.1',
      sessionKey: 'C_ALPHA:1.1',
      permalink: '',
      status: 'running',
    }));
    dashboard.setDashboardNewTaskProvider({ context: vi.fn(async () => structuredClone(CONTEXT)), start });
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    await stopWebServer?.();
  });

  async function launch(prompt: string, requestId: string, autoz = false) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId: 'U_PLAIN', email: 'U_PLAIN@slack.local', name: 'Plain' });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const setCookie = sso.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(';')[0];
    const me = await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } });
    const csrf = JSON.parse(me.body).csrfToken as string;
    return injectWebServer({
      method: 'POST',
      url: '/api/dashboard/new-task',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: {
        requestId,
        prompt,
        model: 'opus[1m]',
        effort: 'xhigh',
        channelId: 'C_ALPHA',
        autogoal: true,
        autoz,
        attachments: [],
      },
    });
  }

  it('a first message that only answers (/help, /goal alone) is launched answer-only: its answer is in the new thread', async () => {
    const classify = vi.fn((text: string) => (text === '/help' ? 'control' : 'control-with-dispatch'));
    dashboard.setDashboardCommandClassifier(classify);
    start.mockImplementationOnce(async () => ({
      channel: 'C_ALPHA',
      threadTs: '2.2',
      sessionKey: 'C_ALPHA:2.2',
      permalink: 'https://slack.example/p2',
      status: 'answered',
    }));
    const res = await launch('/help', 'req-help-answer-01');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, status: 'answered', permalink: 'https://slack.example/p2' });
    expect(classify).toHaveBeenCalledWith('/help', 'U_PLAIN');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]).toMatchObject({ prompt: '/help', answerOnly: true });
  });

  it('a first message that starts the work is not answer-only', async () => {
    dashboard.setDashboardCommandClassifier(() => 'instruction');
    const res = await launch('로그인 버그 고쳐줘', 'req-instr-000001');
    expect(res.statusCode).toBe(200);
    expect(start.mock.calls[0][1].answerOnly).toBeUndefined();
  });

  // The production router reads `/help` + `$autoz` as a skill turn (`$autoz` is a forced skill): this classifier
  // answers the same way, so a launch that appended `$autoz` before judging would run autoz on "/help".
  const routerLike = (text: string) =>
    text.includes('$autoz')
      ? 'control-with-dispatch'
      : text.startsWith('/') || text.startsWith('%')
        ? 'control'
        : 'instruction';

  it.each([
    '/help',
    '/model opus',
    '%nogoal',
  ])('with autoz on, “%s” picked from the / menu is still a command: judged and sent as typed, answer-only, no $autoz', async (prompt) => {
    const classify = vi.fn(routerLike);
    dashboard.setDashboardCommandClassifier(classify);
    const res = await launch(prompt, `req-autoz-cmd-${prompt.replace(/\W/g, '')}-0001`, true);
    expect(res.statusCode).toBe(200);
    expect(classify).toHaveBeenCalledWith(prompt, 'U_PLAIN');
    expect(classify.mock.calls.every(([text]) => !text.includes('$autoz'))).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]).toMatchObject({ prompt, autoz: false, answerOnly: true });
  });

  it('with autoz on, an instruction keeps autoz (the launch appends $autoz to it)', async () => {
    dashboard.setDashboardCommandClassifier(vi.fn(routerLike));
    const res = await launch('로그인 버그 고쳐줘', 'req-autoz-instr-00001', true);
    expect(res.statusCode).toBe(200);
    expect(start.mock.calls[0][1]).toMatchObject({ prompt: '로그인 버그 고쳐줘', autoz: true });
    expect(start.mock.calls[0][1].answerOnly).toBeUndefined();
  });

  it('/goal with its objective starts the task', async () => {
    dashboard.setDashboardCommandClassifier(() => 'control-with-dispatch');
    const res = await launch('/goal 대시보드 테스트 전부 통과', 'req-goal-full-0001');
    expect(res.statusCode).toBe(200);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('page — a new task whose first message only answers', () => {
  it('the toast says the answer is in the new Slack thread, with its link and no 카드 열기', () => {
    const page = loadWith<{ ntLaunchToast(d: unknown, c: string | null, r?: boolean): any }>(['ntLaunchToast'], {});
    expect(
      page.ntLaunchToast({ channel: 'C1', status: 'answered', permalink: 'https://slack.example/p2' }, 'general'),
    ).toEqual({
      title: '명령을 보냈어요',
      description: '#general · 답은 Slack 스레드에 있어요',
      tone: 'success',
      duration: 12000,
      link: { label: 'Slack에서 보기', href: 'https://slack.example/p2' },
    });
  });

  it('a command still being handled: the toast says its answer is on its way, not that it is there', () => {
    const page = loadWith<{ ntLaunchToast(d: unknown, c: string | null, r?: boolean): any }>(['ntLaunchToast'], {});
    expect(page.ntLaunchToast({ channel: 'C1', status: 'answered', handled: false }, 'general')).toEqual({
      title: '명령을 보냈어요',
      description: '#general · 답이 곧 Slack 스레드에 올라와요',
      tone: 'success',
      duration: 12000,
    });
  });

  it('an answered launch leaves no 시작 중 card waiting for a task', () => {
    const src = clientFn('ntOnLaunched');
    expect(src).toMatch(/data\.status === 'answered'/);
    expect(src).toMatch(/answered[\s\S]*ntPendingDrop\(launch\)/);
  });
});
