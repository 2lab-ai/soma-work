/**
 * #983 — GET /api/dashboard/session/:key/link-embed?url=… : one follow-up of a card for the modal.
 *
 *   R1  only a URL that is one of that card's issue or PR links (404 otherwise; a wiki is not one); unknown card 404
 *   R2  the owner, an admin, or the viewer token gets the body (the fetcher called by the URL's parts, never the URL)
 *   R3  anyone else signed in gets the card's own words (reference, title, state) and full: false — no fetch
 *   R4  not a GitHub page (Jira) or the fetch failed: full: false with the reason, never a 5xx
 */
import * as jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VIEWER_TOKEN = 'test-token';
const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: VIEWER_TOKEN,
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
vi.mock('../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));
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

const BEARER = { Authorization: `Bearer ${VIEWER_TOKEN}` };
const ISSUE = 'https://github.com/2lab-ai/soma-work/issues/918';
const PR = 'https://github.com/2lab-ai/soma-work/pull/926';
const JIRA = 'https://acme.atlassian.net/browse/PROJ-12';
const WIKI = 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Design';

function userCookie(sub: string): string {
  const token = jwt.sign({ sub, email: `${sub}@x`, name: sub, provider: 'slack' }, VIEWER_TOKEN, { expiresIn: 3600 });
  return `soma_dash_token=${encodeURIComponent(token)}`;
}

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    conversationId: 'conv1',
    ownerId: 'U_OWNER',
    channelId: 'C1',
    threadTs: 't1',
    activityState: 'idle',
    state: 'MAIN',
    lastActivity: new Date('2026-11-06T00:00:00Z'),
    linkHistory: {
      issues: [
        { url: JIRA, type: 'issue', provider: 'jira', status: 'In Progress', title: 'Jira work' },
        { url: ISSUE, type: 'issue', provider: 'github', status: 'open', title: 'Phone chrome follow-ups' },
      ],
      prs: [{ url: PR, type: 'pr', provider: 'github', status: 'merged' }],
      docs: [{ url: WIKI, type: 'doc', provider: 'confluence' }],
    },
    ...overrides,
  };
}

const EMBED = {
  kind: 'issue',
  title: 'Phone chrome follow-ups',
  state: 'open',
  author: 'bot',
  labels: ['P2'],
  body: '## P2',
  comments: [],
  commentsTotal: 0,
};

describe('Dashboard — follow-up embed route (#983)', () => {
  let web: any;
  let dashboard: any;
  let fetcher: ReturnType<typeof vi.fn>;
  let visibility: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    await web.startWebServer({ listen: false });
    dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', liveSession()]]));
    fetcher = vi.fn(async () => EMBED);
    dashboard.setDashboardLinkEmbedFetcher(fetcher);
    visibility = vi.fn(async () => 'public');
    dashboard.setDashboardRepoVisibilityFetcher(visibility);
  });
  afterEach(async () => {
    dashboard.setDashboardLinkEmbedFetcher(null);
    dashboard.setDashboardRepoVisibilityFetcher(null);
    await web.stopWebServer();
  });

  const get = (url: string, headers: Record<string, string>, key = 'C1:t1') =>
    web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/link-embed?url=${encodeURIComponent(url)}`,
      headers,
    });

  it('R1 — only one of the card’s issue or PR links; an unknown card or URL is 404', async () => {
    for (const url of ['https://github.com/2lab-ai/soma-work/issues/1', WIKI, 'https://evil.example/x', '']) {
      const res = await get(url, BEARER);
      expect(res.statusCode).toBe(404);
    }
    expect((await get(ISSUE, BEARER, 'C9:nope')).statusCode).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('R2 — the owner, an admin and the viewer token get the body, fetched by the URL’s parts', async () => {
    for (const headers of [{ cookie: userCookie('U_OWNER') }, { cookie: userCookie('U_ADMIN') }, BEARER]) {
      const res = await get(ISSUE, headers);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ url: ISSUE, kind: 'issue', text: '#918', full: true, embed: EMBED });
    }
    expect(fetcher).toHaveBeenCalledWith({ owner: '2lab-ai', repo: 'soma-work', kind: 'issue', number: 918 });
    // A merged PR on the card is a link of the card too (the modal may page to it).
    expect(JSON.parse((await get(PR, BEARER)).body)).toMatchObject({ kind: 'pr', full: true });
  });

  it('R3 — anyone else signed in gets the card’s words only, no fetch', async () => {
    const res = await get(ISSUE, { cookie: userCookie('U_OTHER') });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      url: ISSUE,
      kind: 'issue',
      text: '#918',
      title: 'Phone chrome follow-ups',
      status: '열림',
      full: false,
      reason: 'owner-only',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('R4 — a Jira page or a failed fetch: full: false with the reason', async () => {
    const jira = JSON.parse((await get(JIRA, BEARER)).body);
    expect(jira).toMatchObject({
      kind: 'issue',
      text: 'PROJ-12',
      status: 'In Progress',
      full: false,
      reason: 'unsupported',
    });
    fetcher.mockResolvedValueOnce(undefined);
    const down = await get(ISSUE, BEARER);
    expect(down.statusCode).toBe(200);
    expect(JSON.parse(down.body)).toMatchObject({ full: false, reason: 'unavailable' });
    fetcher.mockRejectedValueOnce(new Error('boom'));
    const thrown = await get(ISSUE, BEARER);
    expect(thrown.statusCode).toBe(200);
    expect(JSON.parse(thrown.body)).toMatchObject({ full: false, reason: 'unavailable' });
  });

  it('R5 (review P1, round 2) — a non-admin reads anonymously; GitHub decides; admins and the viewer token read with the App', async () => {
    const ref = { owner: '2lab-ai', repo: 'soma-work', kind: 'issue', number: 918 };
    // The owner: an anonymous read; a public issue is the body.
    expect(JSON.parse((await get(ISSUE, { cookie: userCookie('U_OWNER') })).body)).toMatchObject({ full: true });
    expect(fetcher).toHaveBeenLastCalledWith(ref, { anonymous: true });
    // A private (or gone) issue: anonymous 404 → confirmed private → private-repo; unknown → unavailable.
    fetcher.mockResolvedValue('not-found');
    visibility.mockResolvedValue('private');
    const priv = JSON.parse((await get(ISSUE, { cookie: userCookie('U_OWNER') })).body);
    expect(priv).toMatchObject({ full: false, reason: 'private-repo', title: 'Phone chrome follow-ups' });
    expect(priv.embed).toBeUndefined();
    visibility.mockResolvedValue(undefined);
    expect(JSON.parse((await get(ISSUE, { cookie: userCookie('U_OWNER') })).body)).toMatchObject({
      reason: 'unavailable',
    });
    visibility.mockResolvedValue('public');
    expect(JSON.parse((await get(ISSUE, { cookie: userCookie('U_OWNER') })).body)).toMatchObject({
      reason: 'unavailable',
    });
    visibility.mockRejectedValue(new Error('down'));
    expect(JSON.parse((await get(ISSUE, { cookie: userCookie('U_OWNER') })).body)).toMatchObject({
      reason: 'unavailable',
    });
    // Admins and the viewer token: the App's read (one argument), whatever the visibility.
    fetcher.mockResolvedValue(EMBED);
    fetcher.mockClear();
    expect(JSON.parse((await get(ISSUE, { cookie: userCookie('U_ADMIN') })).body)).toMatchObject({ full: true });
    expect(JSON.parse((await get(ISSUE, BEARER)).body)).toMatchObject({ full: true });
    expect(fetcher.mock.calls).toEqual([[ref], [ref]]);
  }, 30_000);

  it('R6 (review P2) — a link past the 20 chips is still one of the card’s', async () => {
    const OLD = 'https://github.com/2lab-ai/soma-work/issues/700';
    const issues = [
      { url: OLD, type: 'issue', provider: 'github', status: 'open' },
      ...Array.from({ length: 21 }, (_, i) => ({
        url: `https://github.com/2lab-ai/soma-work/issues/${800 + i}`,
        type: 'issue',
        provider: 'github',
        status: 'closed',
      })),
    ];
    dashboard.setDashboardSessionAccessor(() => new Map([['C1:t1', liveSession({ linkHistory: { issues } })]]));
    const res = await get(OLD, BEARER);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ text: '#700', full: true });
  }, 30_000);
});
