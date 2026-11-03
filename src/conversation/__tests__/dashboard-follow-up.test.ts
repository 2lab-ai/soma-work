import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #829 T5 — a session whose last Executive Summary left an own issue/PR unfinished waits for its user.
 *
 * SSOT_1 (Z, 2026-11-03): "가능하면 그럴 경우에 작업 카드가 완료가 되면 안되고 유저의 후속 작업을 입력 대기로
 * 표기해여함"
 *
 * Server: an idle session with a follow-up (`session.followUp`, from the summary's ⚠️ TL;DR line) is projected
 * to `waiting` — NEEDS YOU, like a permission prompt or a plan awaiting its start — and carries
 * `pendingFollowUp` and `waitingSince`. Its own activityState is untouched. A running session stays RUNNING.
 * Client: the card's summary line names the follow-up and the card counts as asking the user.
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

  it('idle + follow-up → waiting, with the reason and since when', async () => {
    const live = session({ followUp: FOLLOW_UP });
    const b = await board(new Map([['C1:t1', live]]));
    expect(b.idle).toHaveLength(0);
    expect(b.waiting).toHaveLength(1);
    expect(b.waiting[0].activityState).toBe('waiting');
    expect(b.waiting[0].pendingFollowUp).toEqual(FOLLOW_UP);
    expect(b.waiting[0].waitingSince).toBe(FOLLOW_UP.at);
    // projection only — the session itself is still idle
    expect(live.activityState).toBe('idle');
  });

  it('a Slack-less dashboard task (no channel, no thread) waits the same way', async () => {
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
    expect(b.waiting).toHaveLength(1);
    expect(b.waiting[0].pendingFollowUp).toEqual(FOLLOW_UP);
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
    expect(b.waiting[0].esTldr.lines).toEqual([
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
    expect(b.idle[0].pendingFollowUp).toBeUndefined();
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

describe('client — the card says what the user has to do', () => {
  const s = { key: 'k', title: 'Login fix', pendingFollowUp: FOLLOW_UP };

  it('the summary line is the follow-up reason on a waiting card', () => {
    expect(face().cardSummary(s, 'waiting', 'Login fix')).toBe(`후속 작업 필요: ${FOLLOW_UP.reason}`);
  });

  it('the card asks the user (it opens like any other NEEDS YOU card)', () => {
    expect(face().cardAsks(s, 'waiting')).toBe(true);
    expect(face().cardAsks({ key: 'k' }, 'idle')).toBe(false);
  });

  it('not on a sleeping/archived card', () => {
    expect(face().cardAsks(s, 'closed')).toBe(false);
    expect(face().cardSummary(s, 'closed', 'Login fix')).not.toContain('후속 작업 필요');
  });

  it('the English page translates the label', () => {
    const en = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'),
        'utf-8',
      ),
    );
    expect(en['후속 작업 필요: ']).toBe('Follow-up needed: ');
  });
});
