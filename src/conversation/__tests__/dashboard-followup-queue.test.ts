import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FollowupItem } from '@soma/slack/followup-queue';
import type { FollowupQueueView } from '@soma/slack/followup-queue-blocks';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dashboard batch 2 — the session's follow-up queue on the panel (<ui-agent-steering>). Z: "show each
 * session's follow-up queue with Send now / Cancel / Edit, owner-only like Stop".
 *
 * Server half, on the real Fastify app with a real sign-in:
 *   - the session payload carries `followups` (what the panel lists, with the generations an act carries);
 *   - POST /api/dashboard/session/:key/queue/:itemId/(promote|cancel|edit) is owner-only like Stop, validates the
 *     generation it carries, and answers with the queue's own words (a refusal is a 4xx, the item stays);
 *   - after an act the panel is pushed over the dashboard WebSocket (sessionUpdated with the queue as it is now).
 * The queue behind the route (SlackHandler.handleDashboardFollowupAction) has its own suite:
 * src/__tests__/slack-handler.followup-dashboard.test.ts.
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

const AUTH_HEADER = { Authorization: 'Bearer test-token' };
const KEY = 'C1:t1';

let seq = 0;
function item(state: FollowupItem['state'], over: Partial<FollowupItem> & { user?: string; text?: string } = {}) {
  const n = ++seq;
  const { user = 'U1', text = `note ${n}`, ...rest } = over;
  return {
    id: `${KEY}#${n}`,
    sessionKey: KEY,
    seq: n,
    epoch: 3,
    state,
    eventKey: `C1:${n}.0`,
    message: { type: 'message', channel: 'C1', thread_ts: 't1', ts: `${n}.0`, user, text },
    context: {},
    enqueuedAt: 1_793_000_000_000 + n,
    updatedAt: 1_793_000_000_000 + n,
    ...rest,
  } as FollowupItem;
}

describe('Dashboard — the follow-up queue (batch 2)', () => {
  let injectWebServer: any;
  let injectWebServerWS: any;
  let stopWebServer: any;
  let dashboard: typeof import('../dashboard');
  let view: FollowupQueueView;
  let act: ReturnType<typeof vi.fn>;
  const sockets: any[] = [];

  // The first import transforms the whole web server (seconds on a loaded runner): paid once, outside the budget.
  beforeAll(async () => {
    await import('../web-server');
    await import('../dashboard');
  }, 300_000);

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string };
  }

  function post(itemId: string, op: string, payload: unknown, headers: Record<string, string> = AUTH_HEADER) {
    return injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(KEY)}/queue/${encodeURIComponent(itemId)}/${op}`,
      headers,
      payload: payload as any,
    });
  }

  async function card() {
    const res = await injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const board = JSON.parse(res.body).board;
    for (const col of ['working', 'waiting', 'idle', 'closed']) {
      const hit = (board[col] || []).find((c: any) => c.channelId === 'C1');
      if (hit) return hit;
    }
    throw new Error('card not on the board');
  }

  beforeEach(async () => {
    vi.resetModules();
    seq = 0;
    const webServer = await import('../web-server');
    injectWebServer = webServer.injectWebServer;
    injectWebServerWS = webServer.injectWebServerWS;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../dashboard');
    dashboard.setDashboardSessionAccessor(
      () =>
        new Map<string, any>([
          [
            KEY,
            {
              sessionId: 'sid1',
              ownerId: 'U1',
              ownerName: 'Alice',
              workflow: 'default',
              model: 'claude-opus-4-6',
              channelId: 'C1',
              threadTs: 't1',
              activityState: 'working',
              state: 'MAIN',
              lastActivity: new Date('2026-10-29T00:00:00Z'),
            },
          ],
          [
            'C2:t2',
            {
              sessionId: 'sid2',
              ownerId: 'U2',
              ownerName: 'Bob',
              channelId: 'C2',
              threadTs: 't2',
              activityState: 'idle',
              state: 'MAIN',
              lastActivity: new Date('2026-10-29T00:00:00Z'),
            },
          ],
        ]),
    );
    view = {
      sessionKey: KEY,
      turnEpoch: 7,
      items: [
        item('queued', {
          text: 'Use Postgres 16 syntax',
          epoch: 2,
          stateReason: '편집됨',
          message: {
            type: 'message',
            channel: 'C1',
            thread_ts: 't1',
            ts: '1.0',
            user: 'U1',
            text: 'Use Postgres 16 syntax',
            files: [
              {
                id: 'F1',
                name: 'schema.sql',
                mimetype: 'text/plain',
                filetype: 'text',
                url_private: 'u',
                url_private_download: 'd',
                size: 1,
              },
            ],
          } as any,
        }),
        item('queued', { user: 'U2', text: 'from Bob in the thread' }),
        item('steered', { stateReason: 'steered' }),
        item('dispatched'),
        item('resolved', { stateReason: 'consumed' }),
        item('cancelled'),
        item('paused', { stateReason: '세션이 중지되어 보류' }),
        ...Array.from({ length: 6 }, (_, i) => item('failed', { stateReason: `failed ${i}` })),
        item('queued', {
          message: {
            type: 'message',
            channel: 'C1',
            thread_ts: 't1',
            ts: '99.0',
            user: 'U1',
            text: 'goal opening',
            routeContext: { goalOpeningId: 'g1' },
          } as any,
        }),
      ],
    };
    act = vi.fn(async () => ({ ok: true }));
    dashboard.setDashboardFollowupHandler({ view: (key) => (key === KEY ? view : undefined), act: act as any });
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await stopWebServer?.();
  });

  describe('the session payload', () => {
    it('lists what still has a control — oldest first, the newest five failures, no history', async () => {
      const f = (await card()).followups;
      expect(f.turnEpoch).toBe(7);
      const ids = f.items.map((i: any) => Number(i.id.split('#')[1]));
      // #5 resolved and #6 cancelled are history; of the six failures (#8–#13) only the newest five.
      expect(ids).toEqual([1, 2, 3, 4, 7, 9, 10, 11, 12, 13, 14]);
      expect(f.items.map((i: any) => i.state)).toEqual([
        'queued',
        'queued',
        'steered',
        'dispatched',
        'paused',
        'failed',
        'failed',
        'failed',
        'failed',
        'failed',
        'queued',
      ]);
    });

    it('carries the text, files, generation and reason — and the author only when it is not the owner', async () => {
      const [mine, bobs, steered] = (await card()).followups.items;
      expect(mine).toEqual({
        id: `${KEY}#1`,
        text: 'Use Postgres 16 syntax',
        files: ['schema.sql'],
        enqueuedAt: 1_793_000_000_001,
        state: 'queued',
        epoch: 2,
        stateReason: '편집됨',
        editable: true,
        authorId: 'U1',
      });
      expect(bobs.author).toBe('Bob');
      expect(bobs.authorId).toBe('U2');
      // A reason that only repeats the state is left out.
      expect(steered.stateReason).toBeUndefined();
    });

    // SSOT 2026-11-02 — anyone may write here, so Edit is offered on anyone's queued words, to their writer
    // (authorId; the page shows it to that viewer only, the server checks the author again).
    it('offers Edit on queued words that are not a goal’s opening turn, naming their writer', async () => {
      const items = (await card()).followups.items;
      const editable = Object.fromEntries(items.map((i: any) => [Number(i.id.split('#')[1]), i.editable]));
      expect(editable[1]).toBe(true);
      expect(editable[2]).toBe(true); // Bob's words — Bob's to edit
      expect(editable[3]).toBe(false); // steered: handed over
      expect(editable[7]).toBe(false); // paused
      expect(editable[14]).toBe(false); // a goal's opening turn
    });

    it('a session with nothing to show carries no followups', async () => {
      view = { sessionKey: KEY, turnEpoch: 7, items: [item('resolved'), item('cancelled')] };
      expect((await card()).followups).toBeUndefined();
    });
  });

  // SSOT 2026-11-02 — open to whoever may instruct: one who may manage the session
  // (the owner, the token, an admin in admin mode) acts as its owner; anyone else
  // as themselves, so the queue's own (Slack) rules answer their press.
  describe('POST …/queue/:itemId/:op — whoever may instruct; the queue decides', () => {
    it('the owner’s act reaches the queue with the generation the panel showed', async () => {
      const res = await post(`${KEY}#1`, 'promote', { epoch: 2, turnEpoch: 7 }, await signIn('U1'));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(act).toHaveBeenCalledWith({
        sessionKey: KEY,
        itemId: `${KEY}#1`,
        op: 'promote',
        epoch: 2,
        turnEpoch: 7,
        actorUserId: 'U1',
        manages: true,
      });
    });

    it('anyone else reaches the queue as themselves (it answers by its own rules); the operator token as the owner', async () => {
      for (const op of ['promote', 'cancel', 'edit']) {
        const res = await post(`${KEY}#1`, op, { epoch: 2, turnEpoch: 7, text: 'x' }, await signIn('U2'));
        expect(res.statusCode).toBe(200);
        expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ op, actorUserId: 'U2', manages: false }));
      }
      expect((await post(`${KEY}#1`, 'cancel', { epoch: 2, turnEpoch: 7 })).statusCode).toBe(200);
      expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'cancel', manages: true }));
      expect(act.mock.calls[act.mock.calls.length - 1][0]).not.toHaveProperty('actorUserId');
      expect(act).toHaveBeenCalledTimes(4);
    });

    it('a refusal is a 4xx with the queue’s own words; a receipt comes back as the message', async () => {
      act.mockResolvedValueOnce({
        ok: false,
        status: 409,
        message: 'Send now rejected (stale-turn-epoch): turn moved on. The item stays in the queue.',
      });
      const stale = await post(`${KEY}#1`, 'promote', { epoch: 2, turnEpoch: 6 });
      expect(stale.statusCode).toBe(409);
      expect(JSON.parse(stale.body).error).toBe(
        'Send now rejected (stale-turn-epoch): turn moved on. The item stays in the queue.',
      );

      act.mockResolvedValueOnce({ ok: true, message: '취소했습니다 — 항목은 기록으로 남습니다.' });
      const done = await post(`${KEY}#1`, 'cancel', { epoch: 2, turnEpoch: 7 });
      expect(done.statusCode).toBe(200);
      expect(JSON.parse(done.body)).toEqual({ ok: true, message: '취소했습니다 — 항목은 기록으로 남습니다.' });
    });

    it('Edit sends the new text, trimmed; it needs one', async () => {
      expect((await post(`${KEY}#1`, 'edit', { epoch: 2, turnEpoch: 7, text: '  Postgres 16  ' })).statusCode).toBe(
        200,
      );
      expect(act).toHaveBeenLastCalledWith({
        sessionKey: KEY,
        itemId: `${KEY}#1`,
        op: 'edit',
        epoch: 2,
        turnEpoch: 7,
        text: 'Postgres 16',
        manages: true,
      });
      expect((await post(`${KEY}#1`, 'edit', { epoch: 2, turnEpoch: 7, text: '   ' })).statusCode).toBe(400);
      expect((await post(`${KEY}#1`, 'edit', { epoch: 2, turnEpoch: 7 })).statusCode).toBe(400);
      expect(act).toHaveBeenCalledTimes(1);
    });

    it('an act without its generation, or an unknown op, is refused before the queue', async () => {
      expect((await post(`${KEY}#1`, 'promote', { turnEpoch: 7 })).statusCode).toBe(400);
      expect((await post(`${KEY}#1`, 'promote', { epoch: 2 })).statusCode).toBe(400);
      expect((await post(`${KEY}#1`, 'promote', { epoch: -1, turnEpoch: 7 })).statusCode).toBe(400);
      expect((await post(`${KEY}#1`, 'promote', { epoch: '2', turnEpoch: 7 })).statusCode).toBe(400);
      expect((await post(`${KEY}#1`, 'resume', { epoch: 2, turnEpoch: 7 })).statusCode).toBe(404);
      expect(act).not.toHaveBeenCalled();
    });

    it('with no queue wired the route says so (501)', async () => {
      dashboard.setDashboardFollowupHandler(null);
      expect((await post(`${KEY}#1`, 'cancel', { epoch: 2, turnEpoch: 7 })).statusCode).toBe(501);
    });
  });

  it('after an act the panel gets the queue as it is now over the dashboard WebSocket', async () => {
    const messages: any[] = [];
    const ws = await injectWebServerWS(
      '/ws/dashboard',
      { headers: { authorization: 'Bearer test-token' } },
      (s: any) => {
        s.on('message', (data: any) => messages.push(JSON.parse(data.toString())));
      },
    );
    sockets.push(ws);
    act.mockImplementationOnce(async () => {
      view = { ...view, items: view.items.filter((i) => i.id !== `${KEY}#1`) };
      return { ok: true, message: '취소했습니다 — 항목은 기록으로 남습니다.' };
    });
    expect((await post(`${KEY}#1`, 'cancel', { epoch: 2, turnEpoch: 7 })).statusCode).toBe(200);
    await vi.waitFor(() => {
      const pushed = messages.filter((m) => m.type === 'sessionUpdated' && m.session?.channelId === 'C1');
      expect(pushed.length).toBeGreaterThan(0);
      const ids = pushed[pushed.length - 1].session.followups.items.map((i: any) => i.id);
      expect(ids).not.toContain(`${KEY}#1`);
      expect(ids).toContain(`${KEY}#2`);
    });
  });
});

// The entry point (the brief's rule: a route without wiring is a dead feature). The chain the panel rides:
// ui-promote / ui-cancel / ui-edit → POST …/queue/:itemId/:op → setDashboardFollowupHandler.act →
// SlackHandler.handleDashboardFollowupAction (the Slack controls' handlers, editQueued) → the queue's save
// sink → setFollowupChangeListener → scheduleLiveSessionUpdate → the sessionUpdated push → the panel repaints
// (repaintPanelSession → renderPanelComposer). Each link has its own test; this pins the two in src/index.ts.
describe('src/index.ts wires the queue to the dashboard', () => {
  const INDEX = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf-8');

  it('the route’s handler is the SlackHandler’s control view and action, and every committed change pushes its session', () => {
    expect(INDEX).toMatch(/import \{[^}]*\bsetDashboardFollowupHandler\b[^}]*\} from '\.\/conversation'/);
    expect(INDEX).toMatch(
      /setDashboardFollowupHandler\(\{\s*view: \(sessionKey\) => slackHandler\.getFollowupView\(sessionKey\),\s*act: \(request\) => slackHandler\.handleDashboardFollowupAction\(request\),\s*\}\);/,
    );
    expect(INDEX).toContain(
      'slackHandler.setFollowupChangeListener((sessionKey) => scheduleLiveSessionUpdate(sessionKey));',
    );
  });
});
