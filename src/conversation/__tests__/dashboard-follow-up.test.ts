import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #829 T5 → #917 — a follow-up waits for its user only through a question.
 *
 * SSOT_1 (Z, 2026-11-03): "가능하면 그럴 경우에 작업 카드가 완료가 되면 안되고 유저의 후속 작업을 입력 대기로
 * 표기해여함"
 *
 * SSOT_2 (Z, 2026-11-04): "유저 입력대기는 반드시 최소한 질문 하나에 해당 질문에 1번은 추천 행동 2번 3번은
 * 대안행동 그리고 맨 마지막에는 직접입력하는 유저에게 질문이 있어야함."
 *
 * Server: a follow-up (`session.followUp`, from the summary's ⚠️ TL;DR line) no longer projects a card to `waiting`
 * on its own. The host asks the follow-up question (`src/slack/follow-up-question.ts`); that question is what puts
 * the card in NEEDS YOU, like any other question. A running session stays RUNNING.
 * Client: a follow-up is no ask by itself — no summary line, no read-only row in 입력 필요.
 */

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
const FOLLOW_UP = { reason: 'PR #12 not merged — needs a maintainer approval.', at: 1_793_600_000_000 };

function session(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    activityState: 'idle',
    state: 'MAIN',
    lastActivity: new Date('2026-11-03T02:00:00Z'),
    ...overrides,
  };
}

describe('server — the follow-up projects an idle card to NEEDS YOU', () => {
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../web-server');
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    await webServer.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  async function board(sessions: Map<string, any>) {
    dashboard.setDashboardSessionAccessor(() => sessions);
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).board;
  }

  it('idle + follow-up and no question → NOT waiting: no 입력 대기 without a question (#917)', async () => {
    const live = session({ followUp: FOLLOW_UP });
    const b = await board(new Map([['C1:t1', live]]));
    expect(b.waiting).toHaveLength(0);
    expect(b.idle).toHaveLength(1);
    expect(b.idle[0].activityState).toBe('idle');
    expect(b.idle[0].pendingFollowUp).toBeUndefined();
    expect(b.idle[0].waitingSince).toBeUndefined();
  });

  it('the follow-up with its question open → waiting, and the card carries the question (#917)', async () => {
    const question = {
      type: 'user_choices',
      title: '⚠️ 후속 작업 필요 — 다음에 할 일을 골라 주세요',
      questions: [
        {
          id: 'follow-up-next',
          question: '후속 작업을 어떻게 할까요',
          choices: [
            { id: '1', label: 'a' },
            { id: '2', label: 'b' },
            { id: '3', label: 'c' },
          ],
          recommendedChoiceId: '1',
        },
      ],
    };
    const live = session({
      followUp: { ...FOLLOW_UP, askedAt: FOLLOW_UP.at + 1, questionTurnId: 'host:k:1' },
      activityState: 'waiting',
      actionPanel: { pendingQuestion: question, waitingForChoice: true },
    });
    const b = await board(new Map([['C1:t1', live]]));
    expect(b.waiting).toHaveLength(1);
    expect(b.waiting[0].pendingQuestion.type).toBe('user_choices');
    expect(b.waiting[0].pendingQuestion.questions[0].choices).toHaveLength(3);
  });

  it('a Slack-less dashboard task (no channel, no thread) with a follow-up and no question is not waiting', async () => {
    const task = {
      sessionId: 'sid9',
      ownerId: 'U1',
      slackless: true,
      taskId: 't-9',
      channelId: '',
      threadTs: undefined,
      activityState: 'idle',
      state: 'MAIN',
      lastActivity: new Date('2026-11-03T02:00:00Z'),
      followUp: FOLLOW_UP,
    };
    const b = await board(new Map([['task:t-9', task]]));
    expect(b.waiting).toHaveLength(0);
  });

  it('a running turn stays RUNNING (the user is already acting)', async () => {
    const b = await board(new Map([['C1:t1', session({ activityState: 'working', followUp: FOLLOW_UP })]]));
    expect(b.working).toHaveLength(1);
    expect(b.waiting).toHaveLength(0);
  });

  it('an armed automatic resume (error retry) wins: RUNNING, the agent acts again first', async () => {
    const at = Date.now() + 60 * 60 * 1000;
    const b = await board(
      new Map([
        [
          'C1:t1',
          session({
            followUp: FOLLOW_UP,
            pendingRetryAt: at,
            pendingRetrySessionId: 'sid1',
            pendingRetryDetail: { attempt: 1, maxAttempts: 3, reason: '429' },
          }),
        ],
      ]),
    );
    expect(b.working).toHaveLength(1);
    expect(b.waiting).toHaveLength(0);
    expect(b.working[0].pendingFollowUp).toBeUndefined();
  });

  // #846 item 7 — `**x**` is the contract's bold and is unwrapped; `__x__` is an identifier and stays.
  it('the card TL;DR box shows the ⚠️ line without the markdown bold markers', async () => {
    const b = await board(
      new Map([
        [
          'C1:t1',
          session({
            followUp: FOLLOW_UP,
            executiveSummary: {
              tldr: ['PR #12 opened.', `⚠️ **${FOLLOW_UP.reason}**`, 'Next: **merge** #12, then fix __init__.'],
              at: FOLLOW_UP.at,
            },
          }),
        ],
      ]),
    );
    expect(b.idle[0].esTldr.lines).toEqual([
      'PR #12 opened.',
      `⚠️ ${FOLLOW_UP.reason}`,
      'Next: merge #12, then fix __init__.',
    ]);
  });

  it('no follow-up (or an empty reason) → DONE as before', async () => {
    const b = await board(
      new Map([
        ['C1:t1', session()],
        ['C2:t2', session({ channelId: 'C2', threadTs: 't2', followUp: { reason: '  ', at: 1 } })],
      ]),
    );
    expect(b.waiting).toHaveLength(0);
    expect(b.idle).toHaveLength(2);
  });
});

// ── client: the card face ──

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
type Face = {
  cardSummary(s: unknown, col: string, headline: string): string;
  cardAsks(s: unknown, col: string): boolean;
};
const face = (): Face => {
  const inject: Record<string, unknown> = {
    cardCurrentTask: () => null,
    permissionSummary: () => 'perm',
    pendingAutoResume: () => null,
    dhShow: () => true,
  };
  const names = Object.keys(inject);
  const body = `${['cardSummary', 'cardAsks'].map(clientFn).join('\n')}\nreturn { cardSummary, cardAsks };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as Face;
};

describe('client — a follow-up alone never asks (#917)', () => {
  const s = { key: 'k', title: 'Login fix', pendingFollowUp: FOLLOW_UP };

  it('a follow-up is no ask on the card: only a question, a prompt or a decision asks', () => {
    expect(face().cardAsks(s, 'waiting')).toBe(false);
    expect(face().cardAsks(s, 'idle')).toBe(false);
    expect(face().cardSummary(s, 'idle', 'Login fix')).not.toContain('후속 작업 필요');
  });

  it('the page has no read-only "후속 작업 필요" row in 입력 필요 — the question is what the user answers', () => {
    expect(TEMPLATE).not.toContain('후속 작업 필요');
    expect(TEMPLATE).not.toContain('pendingFollowUp');
  });
});
