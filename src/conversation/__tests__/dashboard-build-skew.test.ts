/**
 * A dashboard tab outlives the server that served it (2026-10-31, a dev deployment): a tab
 * opened before a deploy kept running the old page script against the new
 * server. The new server projected a goal's 10/10 "keep going?" decision as a
 * waiting card (`activityState: 'waiting'` + `pendingGoalDecision`, #624); the
 * old script drew "Waiting for you · 2h ago" and had no code for the decision,
 * so the card asked for an answer and offered none.
 *
 * The contract pinned here: every page, socket and board answer carries the
 * server's build; a tab whose build differs reloads itself (or, holding unsent
 * input, says a new version is out and reloads on request) — never a loop.
 *
 *   T1 — the server's build reaches the tab: page (PAGE_BUILD), socket (hello), board poll (x-dashboard-build)
 *   T2 — a skewed tab reloads; with unsent input it asks instead; one reload per server build
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    jwtSecret: '',
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

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

// ── The shipped client code, cut out of renderDashboardPage()'s template literal ──
const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], inject: Record<string, unknown>, vars: string[] = []): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

describe('dashboard build skew — T1: the server build reaches the tab', () => {
  let webServer: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    webServer = await import('../web-server');
    dashboard = await import('../dashboard');
    await webServer.startWebServer({ listen: false });
    dashboard.setDashboardSessionAccessor(() => new Map());
  });

  afterEach(async () => {
    await webServer.stopWebServer();
  });

  it('names a deployed build by its commit and build time, else a per-process id', () => {
    expect(
      dashboard.resolveDashboardBuildId({ commitHash: 'ac3a27db74de', buildTime: '2026-10-31T04:16:34Z' }, 'proc-x'),
    ).toBe('ac3a27db74de@2026-10-31T04:16:34Z');
    expect(dashboard.resolveDashboardBuildId(null, 'proc-x')).toBe('proc-x');
    expect(dashboard.resolveDashboardBuildId({ commitHash: '' }, 'proc-x')).toBe('proc-x');
    // One process, one build: the id never changes under a running server.
    const id = dashboard.dashboardBuildId();
    expect(dashboard.dashboardBuildId()).toBe(id);
    // Without version.json the build is the code (this module's mtime), not the process: a restart of the same
    // code — a crash loop — does not reload every tab (review P2, fable).
    expect(id).toMatch(/^(file-[0-9a-z]+|[0-9a-f]{7,}@.+)$/);
  });

  it('the page carries the build it was rendered by (PAGE_BUILD)', async () => {
    const res = await webServer.injectWebServer({ method: 'GET', url: '/dashboard/U1', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`const PAGE_BUILD = ${JSON.stringify(dashboard.dashboardBuildId())};`);
  });

  it('a `</script>` in the dashboard path stays data in the page (pre-existing reflected XSS, review round 3)', async () => {
    const evil = '</script><script>window.__xss=1</script>';
    const res = await webServer.injectWebServer({
      method: 'GET',
      url: `/dashboard/${encodeURIComponent(evil)}`,
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>window.__xss=1</script>');
    expect(res.body).toContain('const INIT_USER = "\\u003c/script>\\u003cscript>window.__xss=1\\u003c/script>";');
  });

  it('every board poll answers with the server build (x-dashboard-build)', async () => {
    const res = await webServer.injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-dashboard-build']).toBe(dashboard.dashboardBuildId());
  });

  it('a socket hears the server build first (hello), before the board', async () => {
    const messages: any[] = [];
    const headers = { cookie: `soma_dash_token=${encodeURIComponent('bearer:test-token')}` };
    const ws = await webServer.injectWebServerWS('/ws/dashboard', { headers }, (socket: any) => {
      socket.on('message', (data: any) => messages.push(JSON.parse(data.toString())));
    });
    try {
      await vi.waitFor(() => expect(messages.some((m) => m.type === 'session_update')).toBe(true));
    } finally {
      ws.terminate();
    }
    expect(messages[0]).toEqual({ type: 'hello', build: dashboard.dashboardBuildId() });
  });
});

describe('dashboard build skew — T2: a tab on another build reloads', () => {
  type Api = {
    buildSkewed: (b: unknown) => boolean;
    hasUnsentInput: () => boolean;
    onServerBuild: (b: unknown) => boolean;
  };

  /** A root as the client queries it: its fields, its open-or-shut dialogs, its elements (a shadow host among them). */
  function root(opts: { fields?: any[]; dialogs?: any[]; elements?: any[] } = {}) {
    return {
      querySelectorAll: (sel: string) =>
        sel === 'ui-dialog, dialog' ? (opts.dialogs ?? []) : sel === '*' ? (opts.elements ?? []) : (opts.fields ?? []),
    };
  }

  function fakeEnv(
    opts: {
      composer?: any;
      ntComposer?: any;
      ntOpen?: boolean;
      fields?: any[];
      dialogs?: any[];
      elements?: any[];
    } = {},
  ) {
    const els: Record<string, any> = {
      'pc-composer': opts.composer ?? { value: '', files: [] },
      'nt-composer': opts.ntComposer ?? { value: '', files: [] },
      'nt-dialog': { open: !!opts.ntOpen },
    };
    // The new task's composer lives in its dialog: a field there, closed unless the dialog is open.
    const ntField = { value: els['nt-composer'].value, closest: () => els['nt-dialog'] };
    const store = new Map<string, string>();
    const env = {
      reloads: 0,
      toasts: [] as any[],
      toastActions: [] as Array<() => void>,
      document: {
        getElementById: (id: string) => els[id] ?? null,
        ...root({
          fields: [...(opts.fields ?? []), ntField],
          dialogs: [els['nt-dialog'], ...(opts.dialogs ?? [])],
          elements: opts.elements,
        }),
      },
      location: {
        reload: () => {
          env.reloads++;
        },
      },
      sessionStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k) : null),
        setItem: (k: string, v: string) => store.set(k, v),
      },
      store,
    };
    return env;
  }

  function api(
    env: ReturnType<typeof fakeEnv>,
    pageBuild = 'build-A',
    page: {
      _pcSending?: boolean;
      _pcInFlight?: number;
      _pcFailed?: Record<string, boolean>;
      _recording?: unknown[];
      _ntDictation?: unknown;
      _ntBusy?: boolean;
      _acState?: Record<string, Record<string, { status: string }>>;
      _mcState?: Record<string, unknown>;
      ntDraft?: string;
    } = {},
  ): Api {
    return load<Api>(
      [
        'buildSkewed',
        'hasUnsentInput',
        'ntSavedPrompt',
        'inClosedDialog',
        'filledField',
        'buildReload',
        'onServerBuild',
      ],
      {
        PAGE_BUILD: pageBuild,
        _pcSending: page._pcSending ?? false,
        _pcInFlight: page._pcInFlight ?? 0,
        _pcFailed: page._pcFailed ?? {},
        _recording: page._recording ?? [],
        _ntDictation: page._ntDictation ?? null,
        _ntBusy: page._ntBusy ?? false,
        _acState: page._acState ?? {},
        NT_DRAFT_KEY: 'soma-nt-draft',
        localStorage: {
          getItem: (k: string) =>
            k === 'soma-nt-draft' && page.ntDraft !== undefined ? JSON.stringify({ prompt: page.ntDraft }) : null,
        },
        _mcState: page._mcState ?? {},
        document: env.document,
        location: env.location,
        sessionStorage: env.sessionStorage,
        dashToast: (input: any, onAction?: () => void) => {
          env.toasts.push(input);
          if (onAction) env.toastActions.push(onAction);
          return 't';
        },
      },
      ['_buildSkewToast'],
    );
  }

  it('the same build, or none, is no skew', () => {
    const env = fakeEnv();
    const a = api(env);
    expect(a.buildSkewed('build-A')).toBe(false);
    expect(a.buildSkewed('')).toBe(false);
    expect(a.buildSkewed(null)).toBe(false);
    expect(a.buildSkewed(undefined)).toBe(false);
    expect(a.buildSkewed('build-B')).toBe(true);
    // A page rendered without a build (an old server) never decides on its own.
    expect(api(env, '').buildSkewed('build-B')).toBe(false);
    a.onServerBuild('build-A');
    a.onServerBuild(null);
    expect(env.reloads).toBe(0);
    expect(env.toasts).toEqual([]);
  });

  it('a skewed tab with nothing unsent reloads at once', () => {
    const env = fakeEnv();
    api(env).onServerBuild('build-B');
    expect(env.reloads).toBe(1);
    expect(env.toasts).toEqual([]);
  });

  it('reloads once per server build — a page that is still skewed after it asks instead of looping', () => {
    const env = fakeEnv();
    api(env).onServerBuild('build-B');
    expect(env.reloads).toBe(1);
    // The reloaded page (a proxy served the old HTML again) hears the same build.
    const again = api(env);
    again.onServerBuild('build-B');
    expect(env.reloads).toBe(1);
    expect(env.toasts).toHaveLength(1);
    expect(env.toasts[0]).toMatchObject({ id: 'build-skew', tone: 'warning', duration: 0 });
    // A later deploy is a new build: one more reload for it.
    again.onServerBuild('build-C');
    expect(env.reloads).toBe(2);
  });

  it('two builds answering in turn behind one origin stop after two reloads (review P2, fable)', () => {
    const env = fakeEnv();
    expect(api(env, 'build-A').onServerBuild('build-B')).toBe(true); // A hears B
    expect(api(env, 'build-B').onServerBuild('build-A')).toBe(true); // the reloaded page is B; it hears A
    expect(api(env, 'build-A').onServerBuild('build-B')).toBe(false); // A again, hears B: no third reload
    expect(env.reloads).toBe(2);
    expect(env.toasts).toHaveLength(1);
  });

  it('unsent input holds the reload — composers, any open dialog, a filled field in the page or in an open shadow root', () => {
    const shadowHost = (field: any) => ({ shadowRoot: root({ fields: [field] }) });
    const cases = [
      fakeEnv({ composer: { value: '머지 완료 됐어?', files: [] } }),
      fakeEnv({ composer: { value: '  ', files: [{ name: 'a.png' }] } }),
      fakeEnv({ ntComposer: { value: 'new task', files: [] }, ntOpen: true }),
      fakeEnv({ ntOpen: true }),
      fakeEnv({ fields: [{ value: '' }, { value: 'goal draft' }] }),
      // The admin lifecycle dialog (number fields) — any open dialog holds it (review P3, grok · fable).
      fakeEnv({ dialogs: [{ open: false }, { open: true }] }),
      // A choice form's typed answer before Enter / a queued note being edited: in the element's shadow root (P2, grok).
      fakeEnv({ elements: [{ shadowRoot: null }, shadowHost({ value: '직접 입력한 답' })] }),
    ];
    for (const env of cases) {
      const a = api(env);
      expect(a.hasUnsentInput()).toBe(true);
      a.onServerBuild('build-B');
      a.onServerBuild('build-B'); // the next poll: still one toast
      expect(env.reloads).toBe(0);
      expect(env.toasts).toHaveLength(1);
      expect(env.toasts[0]).toMatchObject({ id: 'build-skew', tone: 'warning', duration: 0, action: { id: 'reload' } });
      env.toastActions[0]();
      expect(env.reloads).toBe(1);
    }
  });

  it('a note on its way out, or a multi-question form with picked answers not yet submitted, holds the reload', () => {
    expect(api(fakeEnv(), 'build-A', { _pcSending: true }).hasUnsentInput()).toBe(true);
    // Its POST still unanswered (the composer already cleared) — review round 3, astra.
    expect(api(fakeEnv(), 'build-A', { _pcInFlight: 1 }).hasUnsentInput()).toBe(true);
    // A voice note being recorded; a note whose send failed (its Retry row holds the only copy) — round 3, astra.
    expect(api(fakeEnv(), 'build-A', { _recording: [{ isConnected: true }] }).hasUnsentInput()).toBe(true);
    // A composer swapped out mid-recording (its cancel fired off the page) no longer counts (round 3, astra).
    expect(api(fakeEnv(), 'build-A', { _recording: [{ isConnected: false }] }).hasUnsentInput()).toBe(false);
    // A live dictation in the new task (SSOT 2026-11-01): its words are still arriving.
    expect(api(fakeEnv(), 'build-A', { _ntDictation: { stopping: false } }).hasUnsentInput()).toBe(true);
    expect(api(fakeEnv(), 'build-A', { _pcFailed: { 'as-1': true } }).hasUnsentInput()).toBe(true);
    // A new task being launched (dialog possibly closed), an approval answer in flight — round 3, astra · fable.
    expect(api(fakeEnv(), 'build-A', { _ntBusy: true }).hasUnsentInput()).toBe(true);
    expect(api(fakeEnv(), 'build-A', { _acState: { k: { 'g|d1': { status: 'sending' } } } }).hasUnsentInput()).toBe(
      true,
    );
    expect(api(fakeEnv(), 'build-A', { _acState: { k: { 'g|d1': { status: 'resolved' } } } }).hasUnsentInput()).toBe(
      false,
    );
    const picked = { k1: { id: 'mc|k1', answers: { q1: { choiceId: '1' } } } };
    expect(api(fakeEnv(), 'build-A', { _mcState: picked }).hasUnsentInput()).toBe(true);
    // Submitted, or nothing picked yet: nothing to lose.
    const sent = { k1: { id: 'mc|k1', answers: { q1: { choiceId: '1' } }, sent: true } };
    expect(api(fakeEnv(), 'build-A', { _mcState: sent }).hasUnsentInput()).toBe(false);
    expect(api(fakeEnv(), 'build-A', { _mcState: { k1: { id: 'mc|k1', answers: {} } } }).hasUnsentInput()).toBe(false);
  });

  it('an empty page has nothing unsent', () => {
    expect(api(fakeEnv()).hasUnsentInput()).toBe(false);
    expect(api(fakeEnv({ fields: [{ value: '  ' }] })).hasUnsentInput()).toBe(false);
    expect(api(fakeEnv({ dialogs: [{ open: false }] })).hasUnsentInput()).toBe(false);
    // A closed dialog keeps its fields filled: the lifecycle form holds the saved policy after 닫기, the new task
    // keeps its draft (saved in localStorage) — neither holds the reload (review round 2, fable P2/P3).
    const closed = { open: false };
    expect(api(fakeEnv({ fields: [{ value: '24', closest: () => closed }], dialogs: [closed] })).hasUnsentInput()).toBe(
      false,
    );
    expect(
      api(fakeEnv({ ntComposer: { value: 'saved draft', files: [] } }), 'build-A', {
        ntDraft: 'saved draft',
      }).hasUnsentInput(),
    ).toBe(false);
    // …only when localStorage really took it (ntSaveDraft swallows quota errors) — round 3, astra.
    expect(api(fakeEnv({ ntComposer: { value: 'never saved', files: [] } })).hasUnsentInput()).toBe(true);
    // …but its files are not in the draft: attached files hold the reload with the dialog closed (round 3, fable P3).
    expect(api(fakeEnv({ ntComposer: { value: '', files: [{ name: 'spec.pdf' }] } })).hasUnsentInput()).toBe(true);
    expect(
      api(
        fakeEnv({
          elements: [{ closest: () => closed, shadowRoot: root({ fields: [{ value: 'in a closed dialog' }] }) }],
        }),
      ).hasUnsentInput(),
    ).toBe(false);
    expect(api(fakeEnv({ elements: [{ shadowRoot: { querySelectorAll: () => [] } }] })).hasUnsentInput()).toBe(false);
  });
});

describe('dashboard build skew — a failed note stops holding the reload once its row goes', () => {
  it('pcGiveBack (a Retry that could not go out) drops the failed marker with the row (round 3, astra)', () => {
    const failed: Record<string, boolean> = { 'as-1': true };
    const states: string[] = [];
    const { pcGiveBack } = load<{ pcGiveBack: (el: unknown, ref: string, msg: string, key: string) => void }>(
      ['pcGiveBack'],
      {
        _pcNoteFiles: { 'as-1': [] },
        _pcFailed: failed,
        panelSessionKey: 'k',
        document: { getElementById: () => null },
      },
    );
    pcGiveBack({ value: '', setItemState: (_r: string, st: string) => states.push(st) }, 'as-1', 'retry me', 'k');
    expect(states).toEqual(['cancelled']);
    expect(failed).toEqual({});
  });
});

describe('dashboard build skew — T1/T2 wiring: the socket and the poll hand the build to onServerBuild', () => {
  it("the socket's hello reaches onServerBuild", () => {
    const seen: unknown[] = [];
    let sock: any = null;
    class FakeWebSocket {
      onopen: any;
      onclose: any;
      onerror: any;
      onmessage: any;
      constructor() {
        sock = this;
      }
      close() {}
    }
    const { connectWs } = load<{ connectWs: () => void }>(['connectWs'], {
      WebSocket: FakeWebSocket,
      location: { protocol: 'https:', host: 'x' },
      ws: null,
      onServerBuild: (b: unknown) => seen.push(b),
    });
    connectWs();
    sock.onmessage({ data: JSON.stringify({ type: 'hello', build: 'build-B' }) });
    expect(seen).toEqual(['build-B']);
  });

  function pollWith(reloading: boolean) {
    const seen: unknown[] = [];
    const rendered: unknown[] = [];
    const { loadSessions } = load<{ loadSessions: () => Promise<void> }>(['loadSessions'], {
      _sessionsInflight: null,
      currentUserId: '',
      _boardLoad: 'ready',
      BOARD_LOAD_TIMEOUT_MS: 1000,
      AbortController,
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'x-dashboard-build' ? 'build-B' : null) },
        json: async () => ({ board: { working: [], waiting: [], idle: [], closed: [] } }),
      }),
      _heldWsBoard: null,
      _lastPolledBoard: null,
      _lifecycle: null,
      renderBoard: (b: unknown) => rendered.push(b),
      setBoardLoad: () => {},
      panelOpen: false,
      panelSessionKey: null,
      _sessionCache: {},
      repaintPanelSession: () => {},
      onServerBuild: (b: unknown) => {
        seen.push(b);
        return reloading;
      },
    });
    return { loadSessions, seen, rendered };
  }

  it('a poll that set off a reload draws nothing more (review P3, fable)', async () => {
    const reloading = pollWith(true);
    await reloading.loadSessions();
    expect(reloading.seen).toEqual(['build-B']);
    expect(reloading.rendered).toEqual([]);
    const same = pollWith(false);
    await same.loadSessions();
    expect(same.rendered).toHaveLength(1);
  });

  it("a board poll's x-dashboard-build reaches onServerBuild", async () => {
    const seen: unknown[] = [];
    const { loadSessions } = load<{ loadSessions: () => Promise<void> }>(['loadSessions'], {
      _sessionsInflight: null,
      currentUserId: '',
      _boardLoad: 'ready',
      BOARD_LOAD_TIMEOUT_MS: 1000,
      AbortController,
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'x-dashboard-build' ? 'build-B' : null) },
        json: async () => ({ board: { working: [], waiting: [], idle: [], closed: [] } }),
      }),
      _heldWsBoard: null,
      _lastPolledBoard: null,
      _lifecycle: null,
      renderBoard: () => {},
      setBoardLoad: () => {},
      panelOpen: false,
      panelSessionKey: null,
      _sessionCache: {},
      repaintPanelSession: () => {},
      onServerBuild: (b: unknown) => seen.push(b),
    });
    await loadSessions();
    expect(seen).toEqual(['build-B']);
  });
});
