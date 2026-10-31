/**
 * The dashboard's answer buttons, end to end: the shipped client functions
 * (cut out of renderDashboardPage()'s template literal and cooked exactly as
 * the browser receives them, same harness as dashboard-goal-client.test.ts)
 * send their real request through the real Fastify app, and the answer must
 * reach the registered handler.
 *
 * The route tests in dashboard.test.ts inject requests without a
 * Content-Type, which is not what the browser sends. A body-less POST with
 * `Content-Type: application/json` is refused by Fastify's JSON parser before
 * any route code runs (400 FST_ERR_CTP_EMPTY_JSON_BODY), and the hero
 * "추천대로 모두 선택" button showed that as "❌ Bad Request".
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
  getArchiveStore: () => ({ listRecent: vi.fn().mockReturnValue([]) }),
}));

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
function load<T>(fns: string[], inject: Record<string, unknown>): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

/** A disabled-able stand-in for every DOM node the answer functions touch. */
function fakeNode(): any {
  const node: any = {
    disabled: false,
    textContent: '',
    isConnected: true,
    style: {},
    setAttribute() {},
    removeAttribute() {},
    closest: () => node,
    querySelectorAll: () => [],
  };
  return node;
}

const KEY = 'C1:t1';
const AUTH_HEADER = { Authorization: 'Bearer test-token' };

interface AnswerClient {
  submitAllRecommended(key: string): Promise<void>;
  submitMultiChoice(key: string, selections: Record<string, { choiceId: string; label: string }>): Promise<void>;
  answerChoice(key: string, qid: string, choiceId: string): Promise<unknown>;
  acQuestionId(q: unknown): string;
  /** The <ui-choice-form>'s events (#599 ⑤ / #637: an action belongs to the ask its form shows). */
  mcOnChange(e: unknown): void;
  mcOnSubmit(e: unknown): void;
  mcStateOf(s: unknown, q: unknown): { answers: Record<string, unknown>; sending?: boolean; sent?: boolean };
}

describe('dashboard answer buttons → real server (shipped client code)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: typeof import('../dashboard');
  let requests: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
  let alerts: string[];
  let client: AnswerClient;
  let sessionCache: Record<string, { key: string; pendingQuestion: unknown }>;
  /** When set, the next request is refused 403 as csrfMiddleware does after a JWT rotation. */
  let staleCsrfOnce: boolean;
  let csrfRefreshes: number;
  let mcState: Record<
    string,
    { id?: string; answers?: Record<string, unknown>; sending?: boolean; sent?: boolean; error?: string }
  >;
  let formPaints: number;
  let formShown: boolean;
  let acState: Record<string, Record<string, unknown>>;
  /** When set, requests ride on this signed-in user's cookie (and its real CSRF token) instead of the bearer. */
  let authAs: { cookie: string; csrf: string } | null;
  /** Runs once a request has reached the server, before its response is returned (a push arriving meanwhile). */
  let beforeReply: (() => void) | null;
  const SELECTIONS = { q1: { choiceId: '1', label: 'a' }, q2: { choiceId: '1', label: 'b' } };

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    dashboard.setDashboardSessionAccessor(() => new Map([[KEY, { ownerId: 'U1', activityState: 'waiting' }]]) as any);
    await webServer.startWebServer({ listen: false });

    requests = [];
    alerts = [];
    staleCsrfOnce = false;
    csrfRefreshes = 0;
    acState = {};
    authAs = null;
    beforeReply = null;
    // The browser's fetch, bridged onto the real Fastify app. Auth rides on the
    // bearer header (the browser's cookie); every other header and the body
    // are exactly what the client function passed. Bearer auth skips the CSRF
    // check, so a stale-token 403 is stood in by `staleCsrfOnce`; the retry
    // that follows goes to the real server like any other request.
    const fetchBridge = async (
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      requests.push({ url, headers: { ...(init.headers ?? {}) }, body: init.body });
      if (staleCsrfOnce) {
        staleCsrfOnce = false;
        return { ok: false, status: 403, json: async () => ({ error: 'CSRF token validation failed' }) };
      }
      const auth = authAs ? { cookie: authAs.cookie, 'X-CSRF-Token': authAs.csrf } : AUTH_HEADER;
      const res = await injectWebServer({
        method: init.method ?? 'GET',
        url,
        headers: { ...(init.headers ?? {}), ...auth },
        ...(init.body !== undefined ? { payload: init.body } : {}),
      });
      if (beforeReply) {
        const run = beforeReply;
        beforeReply = null;
        run();
      }
      return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body) };
    };
    const twoQuestions = {
      type: 'user_choices',
      questions: [
        { id: 'q1', question: 'Q1', choices: [{ id: '1', label: 'a' }], recommendedChoiceId: '1' },
        { id: 'q2', question: 'Q2', choices: [{ id: '1', label: 'b' }], recommendedChoiceId: '1' },
      ],
    };
    // affectUI batch 1: the single-choice answer comes from <ui-approval-card> (answerChoice(key, qid, choiceId));
    // failures are error toasts (dashToast), not alert().
    sessionCache = { [KEY]: { key: KEY, pendingQuestion: twoQuestions } };
    mcState = {};
    formPaints = 0;
    formShown = true;
    client = load<AnswerClient>(
      [
        'submitAllRecommended',
        'submitMultiChoice',
        'mcPost',
        'mcSend',
        'mcStateOf',
        'mcFormId',
        'mcFormEl',
        'mcSettle',
        'mcOnChange',
        'mcOnSubmit',
        'mcAskShown',
        'mcAskChanged',
        'mcAnswersIn',
        'mcSelectionsOf',
        'answerChoice',
        'acDrop',
        'acQuestionId',
        'acPost',
        'acRefusal',
        'stripRecommendedMarker',
      ],
      {
        fetch: fetchBridge,
        panelOpen: false,
        panelSessionKey: null,
        renderPanelQuestion: () => {},
        dashToast: (t: { title: string; tone?: string }) => {
          if (t.tone === 'error') alerts.push(t.title);
        },
        _acState: acState,
        refreshCard: () => {},
        MC_CUSTOM_ID: '\uC9C1\uC811\uC785\uB825',
        acRepaint: () => {},
        document: {
          querySelector: () => fakeNode(),
          querySelectorAll: () => [],
          // The panel's 입력 필요 holding this session's <ui-choice-form> (or not, formShown false).
          getElementById: (id: string) =>
            id === 'panel-question' && formShown
              ? { firstElementChild: { tagName: 'UI-CHOICE-FORM', getAttribute: () => KEY } }
              : null,
        },
        setTimeout: () => 0,
        console: { error() {}, warn() {} },
        _csrfToken: 'csrf-1',
        refreshCsrfToken: async () => {
          csrfRefreshes++;
        },
        _sessionCache: sessionCache,
        _mcState: mcState,
        renderMultiChoicePanel: () => {
          formPaints++;
        },
      },
    );
  });
  const single = {
    type: 'user_choice',
    question: 'macmini:main prod 배포',
    choices: [
      { id: '1', label: 'auto-deploy' },
      { id: '2', label: 'manual-deploy' },
    ],
  };
  function useSingle(): string {
    sessionCache[KEY].pendingQuestion = single;
    return client.acQuestionId(single);
  }

  afterEach(async () => {
    await stopWebServer();
  });

  // D3 E-15: the form is <ui-choice-form>; the page hands it the send's outcome.
  it("a send is the form's submitting state, then its summary (sent) — the push clears the question", async () => {
    dashboard.setDashboardMultiChoiceAnswerHandler(vi.fn().mockResolvedValue(undefined));
    const run = client.submitMultiChoice(KEY, SELECTIONS);
    expect(mcState[KEY]).toMatchObject({ sending: true });
    await run;
    expect(mcState[KEY]).toMatchObject({ sending: false, sent: true });
    expect(mcState[KEY].error).toBeFalsy();
    expect(formPaints).toBe(2);
    expect(alerts).toEqual([]);
  });

  it("a refusal is the form's error line (it stays usable); with the form off screen it is a toast", async () => {
    dashboard.setDashboardMultiChoiceAnswerHandler(
      vi.fn().mockRejectedValue(new Error('Session is not waiting for a choice')),
    );
    await client.submitMultiChoice(KEY, SELECTIONS);
    expect(mcState[KEY]).toMatchObject({ sending: false });
    expect(mcState[KEY].sent).toBeFalsy();
    expect(mcState[KEY].error).toBeTruthy();
    expect(alerts).toEqual([]);

    formShown = false;
    mcState[KEY].error = '';
    await client.submitMultiChoice(KEY, SELECTIONS);
    expect(alerts.length).toBe(1);
  });

  it('a second send while one is out (or after it landed) sends nothing', async () => {
    dashboard.setDashboardSubmitRecommendedHandler(vi.fn().mockResolvedValue(undefined));
    const a = client.submitAllRecommended(KEY);
    const b = client.submitAllRecommended(KEY);
    await Promise.all([a, b]);
    await client.submitAllRecommended(KEY);
    expect(requests.filter((r) => r.url.endsWith('/submit-recommended'))).toHaveLength(1);
  });

  it('T1 — "추천대로 모두 선택" reaches the submit-recommended handler (no "❌ Bad Request")', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    dashboard.setDashboardSubmitRecommendedHandler(handler);

    await client.submitAllRecommended(KEY);

    expect(alerts).toEqual([]);
    expect(handler).toHaveBeenCalledWith(KEY);
    // A body-less POST must not claim a JSON body.
    const sent = requests.find((r) => r.url.endsWith('/submit-recommended'));
    expect(sent?.body).toBeUndefined();
    expect(Object.keys(sent?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('content-type');
    expect(sent?.headers['X-CSRF-Token']).toBe('csrf-1');
  });

  it('T1 — "제출하기" (multi-choice form) reaches the multi-choice handler with every selection', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    dashboard.setDashboardMultiChoiceAnswerHandler(handler);

    await client.submitMultiChoice(KEY, SELECTIONS);

    expect(alerts).toEqual([]);
    expect(handler).toHaveBeenCalledWith(KEY, {
      q1: { choiceId: '1', label: 'a' },
      q2: { choiceId: '1', label: 'b' },
    });
  });

  describe('#599 ⑤ — on a dashboard task the answer carries the question’s askId to the task handler', () => {
    const TASK = 'task:11111111-2222-4333-8444-555555555555';
    let taskHandler: ReturnType<typeof vi.fn>;
    /** A <ui-choice-form> drawn for `ask` (renderMultiChoicePanel stamps data-mc-ask). */
    const formFor = (key: string, ask: string) => ({
      tagName: 'UI-CHOICE-FORM',
      getAttribute: (n: string) => (n === 'data-mc-key' ? key : n === 'data-mc-ask' ? ask : null),
    });
    const ANSWERS = [
      { questionId: 'q1', choiceId: '1', label: 'a' },
      { questionId: 'q2', choiceId: '1', label: 'b' },
    ];
    /** The form's ui-submit (the element locks until the page settles it, unless the page cancels it). */
    const submitFrom = (el: unknown, source?: string, answers = ANSWERS) => {
      const e = {
        target: el,
        detail: { answers, ...(source ? { source } : {}) },
        cancelled: false,
        preventDefault() {},
      };
      e.preventDefault = () => {
        e.cancelled = true;
      };
      client.mcOnSubmit(e);
      return e;
    };
    beforeEach(async () => {
      dashboard.setDashboardSessionAccessor(
        () =>
          new Map([
            [KEY, { ownerId: 'U1', activityState: 'waiting' }],
            [TASK, { ownerId: 'U1', activityState: 'waiting', slackless: true }],
          ]) as any,
      );
      taskHandler = vi.fn().mockResolvedValue({ status: 202, body: { ok: true } });
      dashboard.setDashboardTaskAnswerHandler(taskHandler as any);
      // A task's answer is the signed-in owner's alone (#637 R1): no bearer here.
      const { issueSlackToken } = await import('../oauth');
      const token = issueSlackToken({ slackUserId: 'U1', email: 'U1@slack.local', name: 'U1' });
      const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
      const cookie = String(sso.headers['set-cookie']).split(';')[0];
      const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
      authAs = { cookie, csrf: me.csrfToken };
    });
    afterEach(() => dashboard.setDashboardTaskAnswerHandler(null));
    const askOf = (askId: string) => ({ ...(sessionCache[KEY].pendingQuestion as object), askId });

    it('a single choice', async () => {
      const q = { ...single, askId: 'ask-7' };
      sessionCache[TASK] = { key: TASK, pendingQuestion: q };
      const st = await client.answerChoice(TASK, client.acQuestionId(q), '2');
      expect(taskHandler).toHaveBeenCalledWith(TASK, 'ask-7', { kind: 'single', choiceId: '2' }, 'U1');
      expect(st).toMatchObject({ status: 'resolved', outcome: 'answered' });
    });

    it('a multi-choice form', async () => {
      sessionCache[TASK] = { key: TASK, pendingQuestion: askOf('ask-8') };
      const e = submitFrom(formFor(TASK, 'ask-8'));
      expect(e.cancelled).toBe(false);
      await vi.waitFor(() => expect(taskHandler).toHaveBeenCalled());
      expect(taskHandler).toHaveBeenCalledWith(
        TASK,
        'ask-8',
        { kind: 'multi', selections: { q1: { choiceId: '1', label: 'a' }, q2: { choiceId: '1', label: 'b' } } },
        'U1',
      );
      expect(alerts).toEqual([]);
    });

    it('“submit all recommended”', async () => {
      sessionCache[TASK] = { key: TASK, pendingQuestion: askOf('ask-9') };
      await client.submitAllRecommended(TASK);
      expect(taskHandler).toHaveBeenCalledWith(TASK, 'ask-9', { kind: 'recommended' }, 'U1');
      expect(alerts).toEqual([]);
    });

    // #637 R1/R2 (astra P1) — a form's answers belong to the ask it shows. When the
    // cache already holds the next ask (a push the panel has not painted yet), the
    // form's submit is refused (cancelled) and nothing is sent; its picks fill nothing.
    it('a form showing ask A never answers or fills ask B', async () => {
      sessionCache[TASK] = { key: TASK, pendingQuestion: askOf('ask-B') };
      const formA = formFor(TASK, 'ask-A');
      client.mcOnChange({ target: formA, detail: { answers: ANSWERS } });
      expect(mcState[TASK]).toBeUndefined();
      const e = submitFrom(formA);
      const r = submitFrom(
        formA,
        'recommended',
        ANSWERS.map((a) => ({ ...a, recommended: true })),
      );
      expect(e.cancelled).toBe(true);
      expect(r.cancelled).toBe(true);
      expect(requests).toHaveLength(0);
      expect(taskHandler).not.toHaveBeenCalled();
      expect(alerts.length).toBe(2);
    });

    it('a new ask starts with no answers: the previous ask’s picks do not carry over', () => {
      sessionCache[TASK] = { key: TASK, pendingQuestion: askOf('ask-A') };
      client.mcOnChange({ target: formFor(TASK, 'ask-A'), detail: { answers: ANSWERS } });
      expect(Object.keys(mcState[TASK].answers ?? {})).toEqual(['q1', 'q2']);
      sessionCache[TASK] = { key: TASK, pendingQuestion: askOf('ask-B') };
      const b = client.mcStateOf(sessionCache[TASK], sessionCache[TASK].pendingQuestion);
      expect(b.answers).toEqual({});
    });

    // #637 R2 (astra P2) — a late success for ask A leaves ask B's form state alone.
    it('a late success for one ask does not touch the next ask’s form', async () => {
      for (const source of [undefined, 'recommended']) {
        sessionCache[TASK] = { key: TASK, pendingQuestion: askOf('ask-A') };
        delete mcState[TASK];
        // A is accepted; before its response lands, B is pushed and the owner starts on it.
        beforeReply = () => {
          sessionCache[TASK].pendingQuestion = askOf('ask-B');
          client.mcOnChange({ target: formFor(TASK, 'ask-B'), detail: { answers: [ANSWERS[0]] } });
        };
        const answers = source ? ANSWERS.map((a) => ({ ...a, recommended: true })) : ANSWERS;
        submitFrom(formFor(TASK, 'ask-A'), source, answers);
        await vi.waitFor(() => expect(beforeReply).toBeNull());
        await new Promise((r) => setImmediate(r));
        expect(mcState[TASK]).toMatchObject({ answers: { q1: { choiceId: '1' } } });
        expect(mcState[TASK].sending).toBeFalsy();
        expect(mcState[TASK].sent).toBeFalsy();
      }
    });

    // #637 R1 (astra P2) — two asks with the same text are two questions.
    it('the same question asked twice is two questions: a late answer to the first never resolves the second', async () => {
      const a = { ...single, askId: 'ask-A' };
      const b = { ...single, askId: 'ask-B' };
      expect(client.acQuestionId(a)).not.toBe(client.acQuestionId(b));
      sessionCache[TASK] = { key: TASK, pendingQuestion: a };
      // The answer to A reaches the server; before its response, B is pushed.
      beforeReply = () => {
        sessionCache[TASK].pendingQuestion = b;
      };
      await client.answerChoice(TASK, client.acQuestionId(a), '2');
      expect(acState[TASK]?.[client.acQuestionId(b)]).toBeUndefined();
      // B is answered with its own id, by its own request.
      taskHandler.mockClear();
      expect(await client.answerChoice(TASK, client.acQuestionId(a), '2')).toBeNull();
      await client.answerChoice(TASK, client.acQuestionId(b), '1');
      expect(taskHandler).toHaveBeenCalledTimes(1);
      expect(taskHandler).toHaveBeenCalledWith(TASK, 'ask-B', { kind: 'single', choiceId: '1' }, 'U1');
    });
  });

  it('T1 — a single-question choice button reaches the choice handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    dashboard.setDashboardChoiceAnswerHandler(handler);

    const st = await client.answerChoice(KEY, useSingle(), '2');

    expect(handler).toHaveBeenCalledWith(KEY, '2', 'manual-deploy', 'macmini:main prod 배포');
    expect(st).toMatchObject({ status: 'resolved', outcome: 'answered', choiceId: '2' });
  });

  // After a JWT rotation the first POST is refused 403; each answer button
  // refreshes the CSRF token and retries once. The retry is a request of its
  // own (separate header object), so it must reach the handler too.
  it.each([
    {
      name: '추천대로 모두 선택',
      run: () => client.submitAllRecommended(KEY),
      register: (h: any) => dashboard.setDashboardSubmitRecommendedHandler(h),
    },
    {
      name: '제출하기',
      run: () => client.submitMultiChoice(KEY, SELECTIONS),
      register: (h: any) => dashboard.setDashboardMultiChoiceAnswerHandler(h),
    },
    {
      name: 'single choice',
      run: () => client.answerChoice(KEY, useSingle(), '2'),
      register: (h: any) => dashboard.setDashboardChoiceAnswerHandler(h),
    },
  ])('T1 — $name retried after a stale-CSRF 403 still reaches its handler', async ({ run, register }) => {
    const handler = vi.fn().mockResolvedValue(undefined);
    register(handler);
    staleCsrfOnce = true;

    await run();

    expect(csrfRefreshes).toBe(1);
    expect(requests).toHaveLength(2);
    expect(alerts).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
    const retry = requests[1];
    expect(retry.headers['X-CSRF-Token']).toBe('csrf-1');
    const claimsJson = Object.keys(retry.headers).some((h) => h.toLowerCase() === 'content-type');
    expect(claimsJson).toBe(retry.body !== undefined);
  });
});
