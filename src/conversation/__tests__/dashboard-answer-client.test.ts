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
  submitMultiChoice(key: string): Promise<void>;
  answerChoice(key: string, qid: string, choiceId: string): Promise<unknown>;
  acQuestionId(q: unknown): string;
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
      const res = await injectWebServer({
        method: init.method ?? 'GET',
        url,
        headers: { ...(init.headers ?? {}), ...AUTH_HEADER },
        ...(init.body !== undefined ? { payload: init.body } : {}),
      });
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
    client = load<AnswerClient>(
      [
        'submitAllRecommended',
        'submitMultiChoice',
        'answerChoice',
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
        _acState: {},
        acRepaint: () => {},
        document: { querySelector: () => fakeNode(), querySelectorAll: () => [] },
        setTimeout: () => 0,
        console: { error() {}, warn() {} },
        _csrfToken: 'csrf-1',
        refreshCsrfToken: async () => {
          csrfRefreshes++;
        },
        _sessionCache: sessionCache,
        _mcState: {
          [KEY]: {
            selections: { q1: { choiceId: '1', label: 'a' }, q2: { choiceId: '1', label: 'b' } },
            activeQ: 0,
          },
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

  it('T1 — "⭐ 추천대로 모두 선택" reaches the submit-recommended handler (no "❌ Bad Request")', async () => {
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

    await client.submitMultiChoice(KEY);

    expect(alerts).toEqual([]);
    expect(handler).toHaveBeenCalledWith(KEY, {
      q1: { choiceId: '1', label: 'a' },
      q2: { choiceId: '1', label: 'b' },
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
      name: '⭐ 추천대로 모두 선택',
      run: () => client.submitAllRecommended(KEY),
      register: (h: any) => dashboard.setDashboardSubmitRecommendedHandler(h),
    },
    {
      name: '제출하기',
      run: () => client.submitMultiChoice(KEY),
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
