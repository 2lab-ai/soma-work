/**
 * #1315 — "슬랙 비공개 채널의 작업은 … 비공개 작업이라고 열쇠 표시를 둔다. 이러한 비공개 작업은 어드민과 작업 오너만
 * 볼수 있다."
 *
 * A task whose Slack conversation not everyone can read (a private channel, a DM, a channel the registry does not say
 * is public) is its owner's and the admins': anyone else gets no card, no live push, and 404 from its routes. The
 * owner's and an admin's card says so (`privateTask`, the key on its face).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { boardForViewer, canViewCard, canViewTask, cardForViewer, isPrivateTask } from '../task-visibility';

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

const paths = vi.hoisted(() => ({ dataDir: '' }));

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({
  IS_DEV: true,
  get DATA_DIR() {
    return paths.dataDir;
  },
}));
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
// The archive store: empty unless a test puts an archived task in it.
const archive = vi.hoisted(() => ({ recent: [] as Array<Record<string, any>> }));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({
    listRecent: () => archive.recent,
    load: (sessionKey: string, archivedAt: number) =>
      archive.recent.find((a) => a.sessionKey === sessionKey && a.archivedAt === archivedAt) ?? null,
  }),
}));

// ── The rule (pure) ──

describe('task-visibility — the rule', () => {
  const registry: Record<string, { isPrivate?: boolean }> = {
    C_PUB: { isPrivate: false },
    C_PRIV: { isPrivate: true },
    C_OLD: {},
  };
  const lookup = (id: string) => registry[id];

  it('a private channel, a DM, a channel the registry cannot say is public: private; a public one, or none: not', () => {
    expect(isPrivateTask('C_PUB', lookup)).toBe(false);
    expect(isPrivateTask('C_PRIV', lookup)).toBe(true);
    expect(isPrivateTask('D123', lookup)).toBe(true);
    // A registry entry that never said, a channel it does not know, a registry that throws: not known to be public.
    expect(isPrivateTask('C_OLD', lookup)).toBe(true);
    expect(isPrivateTask('C_UNKNOWN', lookup)).toBe(true);
    expect(
      isPrivateTask('C_PUB', () => {
        throw new Error('down');
      }),
    ).toBe(true);
    // An old dashboard task with no Slack conversation is everyone's, as before.
    expect(isPrivateTask('', lookup)).toBe(false);
    expect(isPrivateTask(undefined, lookup)).toBe(false);
  });

  it('the owner and an admin see a private task; anyone else does not; everyone sees a public one', () => {
    const priv = { channelId: 'C_PRIV', ownerId: 'U_OWNER' };
    const pub = { channelId: 'C_PUB', ownerId: 'U_OWNER' };
    expect(canViewTask({ userId: 'U_OWNER' }, priv, lookup)).toBe(true);
    expect(canViewTask({ userId: 'U_ADMIN', isAdmin: true }, priv, lookup)).toBe(true);
    expect(canViewTask({ userId: 'U_OTHER' }, priv, lookup)).toBe(false);
    expect(canViewTask(undefined, priv, lookup)).toBe(false);
    // No user id never matches an empty owner.
    expect(canViewTask({ userId: '' }, { channelId: 'C_PRIV', ownerId: '' }, lookup)).toBe(false);
    expect(canViewTask({ userId: 'U_OTHER' }, pub, lookup)).toBe(true);
  });

  it('a card: false is everyone’s; true — or no mark, a card from an older build — the owner’s and admins’', () => {
    expect(canViewCard({ userId: 'U_OTHER' }, { privateTask: false, ownerId: 'U_OWNER' })).toBe(true);
    expect(canViewCard({ userId: 'U_OTHER' }, { privateTask: true, ownerId: 'U_OWNER' })).toBe(false);
    expect(canViewCard({ userId: 'U_OTHER' }, { ownerId: 'U_OWNER' })).toBe(false);
    expect(canViewCard({ userId: 'U_OWNER' }, { ownerId: 'U_OWNER' })).toBe(true);
    // The owner sees an unmarked card with the key: it is private to them.
    expect(cardForViewer({ ownerId: 'U_OWNER' }, { userId: 'U_OWNER' })).toEqual({
      ownerId: 'U_OWNER',
      privateTask: true,
    });
  });

  it('the board leaves out what the viewer may not see — an epic’s private children too — and keeps its own object when nothing is', () => {
    const pub = { key: 'a', privateTask: false, ownerId: 'U_OWNER' };
    const priv = { key: 'b', privateTask: true, ownerId: 'U_OWNER' };
    const epic = {
      key: 'e',
      privateTask: false,
      ownerId: 'U_OWNER',
      epic: { state: 'running', children: [pub, priv] },
    };
    const board = { working: [pub, priv], waiting: [epic], idle: [], closed: [] };
    const other = boardForViewer(board, { userId: 'U_OTHER' });
    expect(other.working.map((c) => c.key)).toEqual(['a']);
    expect(other.waiting[0].epic.children.map((c: { key: string }) => c.key)).toEqual(['a']);
    expect(other.waiting[0].epic.state).toBe('running');
    // The input is not changed.
    expect(board.working).toHaveLength(2);
    expect(epic.epic.children).toHaveLength(2);
    expect(boardForViewer(board, { userId: 'U_OWNER' })).toBe(board);
    expect(boardForViewer(board, { userId: 'U_ADMIN', isAdmin: true })).toBe(board);
  });
});

// ── The server ──

function userCookie(sub: string): string {
  const token = jwt.sign({ sub, email: `${sub}@x`, name: sub, provider: 'slack' }, VIEWER_TOKEN, { expiresIn: 3600 });
  return `soma_dash_token=${encodeURIComponent(token)}`;
}
const AS = {
  owner: { cookie: userCookie('U_OWNER') },
  other: { cookie: userCookie('U_OTHER') },
  admin: { cookie: userCookie('U_ADMIN') },
  token: { Authorization: `Bearer ${VIEWER_TOKEN}` },
};

function liveSession(id: string, channelId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: `sid-${id}`,
    conversationId: `conv-${id}`,
    title: `Task ${id}`,
    ownerId: 'U_OWNER',
    ownerName: 'Owner',
    workflow: 'default',
    model: 'claude-opus-4-6',
    channelId,
    threadTs: `${id}.1`,
    activityState: 'working',
    state: 'MAIN',
    lastActivity: new Date('2026-11-16T00:00:00Z'),
    ...extra,
  };
}

// Public channel, private channel, a DM, a channel the registry does not know.
const SESSIONS: Array<[string, string]> = [
  ['pub', 'C_PUB'],
  ['priv', 'C_PRIV'],
  ['dm', 'D_OWNER'],
  ['unk', 'C_UNK'],
];
const keyOf = (id: string) => `${SESSIONS.find(([s]) => s === id)?.[1]}:${id}.1`;

function conversation(id: string, channelId: string) {
  return {
    id: `conv-${id}`,
    channelId,
    threadTs: `${id}.1`,
    ownerId: 'U_OWNER',
    ownerName: 'Owner',
    title: `Task ${id}`,
    workflow: 'default',
    createdAt: 1,
    updatedAt: 2,
    turns: [
      { id: 'u1', role: 'user', timestamp: 1, userName: 'Owner', rawContent: `secret instruction ${id}` },
      { id: 'a1', role: 'assistant', timestamp: 2, rawContent: `secret answer ${id}`, summaryTitle: 'answer' },
    ],
  };
}
const CONVERSATIONS = new Map(SESSIONS.map(([id, ch]) => [`conv-${id}`, conversation(id, ch)]));

describe('task-visibility — board, live pushes and routes', () => {
  let web: typeof import('../web-server');
  let dashboard: typeof import('../dashboard');
  let sessions: Map<string, any>;
  const sockets: any[] = [];

  beforeEach(async () => {
    vi.resetModules();
    archive.recent = [];
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-task-visibility-'));
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    const registry = await import('../../channel-registry');
    registry.upsertChannel({ id: 'C_PUB', name: 'open', isPrivate: false });
    registry.upsertChannel({ id: 'C_PRIV', name: 'acquisition', isPrivate: true });
    const recorder = await import('../recorder');
    (recorder.getConversation as any).mockImplementation(async (id: string) => CONVERSATIONS.get(id) ?? null);
    (recorder.getTurnRawContent as any).mockImplementation(async (id: string, turnId: string) => {
      const t = CONVERSATIONS.get(id)?.turns.find((x) => x.id === turnId);
      return t?.rawContent ?? null;
    });
    (recorder.listConversations as any).mockImplementation(async () =>
      [...CONVERSATIONS.values()].map((c) => ({
        id: c.id,
        ownerId: c.ownerId,
        channelId: c.channelId,
        ownerName: c.ownerName,
        title: c.title,
        workflow: c.workflow,
        turnCount: c.turns.length,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    );
    sessions = new Map(
      SESSIONS.map(([id, ch]) => [
        keyOf(id),
        liveSession(id, ch, id === 'priv' ? { taskPlan: { state: 'awaiting', revision: 1, updatedAt: 1 } } : {}),
      ]),
    );
    dashboard.setDashboardSessionAccessor(() => sessions);
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    dashboard.setDashboardCronSource(null);
    await web.stopWebServer();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  async function boardAs(headers: Record<string, string>) {
    const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers });
    expect(res.statusCode).toBe(200);
    const board = JSON.parse(res.body).board;
    return [...board.working, ...board.waiting, ...board.idle, ...board.closed] as Array<Record<string, any>>;
  }
  const ids = (cards: Array<Record<string, any>>) => cards.map((c) => c.conversationId).sort();

  it('the board: a stranger gets only the public task; the owner, an admin and the viewer token get all, the private ones marked', async () => {
    expect(ids(await boardAs(AS.other))).toEqual(['conv-pub']);
    for (const who of [AS.owner, AS.admin, AS.token]) {
      const cards = await boardAs(who);
      expect(ids(cards)).toEqual(['conv-dm', 'conv-priv', 'conv-pub', 'conv-unk']);
      const mark = Object.fromEntries(cards.map((c) => [c.conversationId, c.privateTask]));
      expect(mark).toEqual({ 'conv-pub': false, 'conv-priv': true, 'conv-dm': true, 'conv-unk': true });
    }
  });

  async function connect(headers: Record<string, string>): Promise<{ messages: any[] }> {
    const messages: any[] = [];
    const ws = await web.injectWebServerWS('/ws/dashboard', { headers }, (socket: any) => {
      socket.on('message', (data: any) => messages.push(JSON.parse(data.toString())));
    });
    sockets.push(ws);
    return { messages };
  }
  const boardIds = (m: any) =>
    [...m.board.working, ...m.board.waiting, ...m.board.idle, ...m.board.closed]
      .map((c: any) => c.conversationId)
      .sort();

  /** Everything sent before a later session_update has arrived when it does (one socket keeps order). */
  async function flushAll(clients: Array<{ messages: any[] }>): Promise<void> {
    const marks = clients.map((c) => c.messages.filter((m) => m.type === 'session_update').length);
    dashboard.broadcastSessionUpdate();
    await vi.waitFor(() => {
      clients.forEach((c, i) => {
        expect(c.messages.filter((m) => m.type === 'session_update').length).toBeGreaterThan(marks[i]);
      });
    });
  }

  it('the socket: the first frame and every board push leave the private tasks out for a stranger', async () => {
    const other = await connect(AS.other);
    const owner = await connect(AS.owner);
    await vi.waitFor(() => {
      expect(other.messages.some((m) => m.type === 'session_update')).toBe(true);
      expect(owner.messages.some((m) => m.type === 'session_update')).toBe(true);
    });
    expect(boardIds(other.messages.find((m) => m.type === 'session_update'))).toEqual(['conv-pub']);
    expect(boardIds(owner.messages.find((m) => m.type === 'session_update'))).toHaveLength(4);
    await flushAll([other, owner]);
    const last = (c: { messages: any[] }) => {
      const updates = c.messages.filter((m) => m.type === 'session_update');
      return updates[updates.length - 1];
    };
    expect(boardIds(last(other))).toEqual(['conv-pub']);
    expect(boardIds(last(owner))).toEqual(['conv-dm', 'conv-priv', 'conv-pub', 'conv-unk']);
  });

  it('the socket: a private task’s card, task, title and artifact pushes reach its owner and admins, not a stranger', async () => {
    const other = await connect(AS.other);
    const owner = await connect(AS.owner);
    const admin = await connect(AS.admin);
    const all = [other, owner, admin];
    await vi.waitFor(() => all.forEach((c) => expect(c.messages.length).toBeGreaterThan(0)));
    const key = keyOf('priv');
    dashboard.broadcastSingleSessionUpdate(key);
    dashboard.broadcastTaskUpdate(key, []);
    dashboard.broadcastSummaryTitleChanged(key, 'secret title');
    dashboard.broadcastArtifactUpdate({
      id: 'art-1',
      conversationId: 'conv-priv',
      name: 'secret.md',
      kind: 'markdown',
      createdAt: 1,
    } as any);
    // A public task's pushes still reach everyone.
    dashboard.broadcastSummaryTitleChanged(keyOf('pub'), 'open title');
    await flushAll(all);
    const scoped = (c: { messages: any[] }) =>
      c.messages
        .filter((m) => m.type !== 'session_update' && m.type !== 'hello')
        .map((m) => `${m.type}:${m.sessionKey ?? m.session?.conversationId ?? m.conversationId ?? m.key}`);
    expect(scoped(other)).toEqual([`summaryTitleChanged:${keyOf('pub')}`]);
    for (const c of [owner, admin]) {
      expect(scoped(c)).toEqual([
        'sessionUpdated:conv-priv',
        `task_update:${key}`,
        `summaryTitleChanged:${key}`,
        'artifact_update:conv-priv',
        // The artifact re-pushes the live card so its face row grows — as the fields that changed (card-push.ts);
        // here the artifact store holds nothing of it, so the card is as the socket has it and nothing is re-sent.
        `summaryTitleChanged:${keyOf('pub')}`,
      ]);
    }
  });

  it('the socket: a card push carries only what changed since this socket’s copy, or nothing (dashboard perf 2026-11-24)', async () => {
    const owner = await connect(AS.owner);
    const ownerSocket = sockets[sockets.length - 1];
    const stranger = await connect(AS.other);
    await vi.waitFor(() =>
      [owner, stranger].forEach((c) => expect(c.messages.some((m) => m.type === 'session_update')).toBe(true)),
    );
    const pushes = (c: { messages: any[] }) =>
      c.messages.filter((m) => m.type === 'sessionUpdated' || m.type === 'sessionPatch');
    const lastPush = (c: { messages: any[] }) => pushes(c)[pushes(c).length - 1];
    // The clock stands still: a slow run must not reach the 30 s whole-card refresh (CARD_KEYFRAME_MS) by itself.
    const frozen = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(frozen);
    onTestFinished(() => clock.mockRestore());
    const key = keyOf('pub');
    dashboard.broadcastSingleSessionUpdate(key);
    dashboard.broadcastSingleSessionUpdate(key); // the card as the sockets have it: nothing
    sessions.get(key).title = 'Renamed';
    dashboard.broadcastSingleSessionUpdate(key);
    await flushAll([owner, stranger]);
    for (const c of [owner, stranger]) {
      const [whole, patch, ...rest] = pushes(c);
      expect(rest).toEqual([]);
      expect(whole.type).toBe('sessionUpdated');
      expect(whole.session.title).toBe('Task pub');
      expect(patch.type).toBe('sessionPatch');
      expect(patch.key).toBe(whole.session.key);
      expect(patch.set.title).toBe('Renamed');
      // What did not change stays home.
      expect('conversationId' in patch.set).toBe(false);
    }
    // The board push replaced the page's cards: the next push of the card is whole again.
    dashboard.broadcastSingleSessionUpdate(key);
    await flushAll([owner]);
    expect(pushes(owner).map((m) => m.type)).toEqual(['sessionUpdated', 'sessionPatch', 'sessionUpdated']);
    // That board push (flushAll) reset it again: whole once more, then a change is a patch again…
    dashboard.broadcastSingleSessionUpdate(key);
    sessions.get(key).title = 'Before poll';
    dashboard.broadcastSingleSessionUpdate(key);
    await vi.waitFor(() => expect(pushes(owner)).toHaveLength(5));
    expect(
      pushes(owner)
        .slice(3)
        .map((m) => m.type),
    ).toEqual(['sessionUpdated', 'sessionPatch']);
    // …until the page repaints from a board poll and says so (resync): the next push of the card is whole.
    ownerSocket.send('{"type":"resync"}');
    sessions.get(key).title = 'After resync';
    await vi.waitFor(() => {
      dashboard.broadcastSingleSessionUpdate(key);
      expect(lastPush(owner)?.type).toBe('sessionUpdated');
    });
    expect(lastPush(owner)?.session.title).toBe('After resync');
    // Patches before the resync arrived, then the whole card — never a whole card without it.
    expect(
      pushes(owner)
        .slice(5)
        .every((m, i, all) => m.type === 'sessionPatch' || i === all.length - 1),
    ).toBe(true);
    // A private card's push still reaches only who may see it, whole or patched.
    const priv = keyOf('priv');
    dashboard.broadcastSingleSessionUpdate(priv);
    sessions.get(priv).title = 'Secret renamed';
    dashboard.broadcastSingleSessionUpdate(priv);
    await flushAll([owner, stranger]);
    expect(pushes(stranger).some((m) => (m.session?.conversationId ?? '') === 'conv-priv')).toBe(false);
    expect(JSON.stringify(stranger.messages)).not.toContain('Secret renamed');
    expect(
      pushes(owner)
        .slice(-2)
        .map((m) => m.type),
    ).toEqual(['sessionUpdated', 'sessionPatch']);
  });

  it('the socket: a private task’s turns do not follow a non-owner who instructed it from Slack; a public task’s do', async () => {
    sessions.get(keyOf('priv')).currentInitiatorId = 'U_OTHER';
    sessions.get(keyOf('pub')).currentInitiatorId = 'U_OTHER';
    const other = await connect(AS.other);
    const owner = await connect(AS.owner);
    await vi.waitFor(() => [other, owner].forEach((c) => expect(c.messages.length).toBeGreaterThan(0)));
    dashboard.broadcastConversationUpdate('conv-priv', { id: 't9', role: 'user', rawContent: 'secret' });
    dashboard.broadcastConversationUpdate('conv-pub', { id: 't9', role: 'user', rawContent: 'open' });
    await flushAll([other, owner]);
    const turns = (c: { messages: any[] }) =>
      c.messages.filter((m) => m.type === 'conversation_update').map((m) => m.conversationId);
    expect(turns(other)).toEqual(['conv-pub']);
    expect(turns(owner)).toEqual(['conv-priv', 'conv-pub']);
  });

  it('the socket: a phone call’s update reaches its requester, the conversation owner and admins — not whoever else instructed the thread', async () => {
    sessions.get(keyOf('pub')).currentInitiatorId = 'U_OTHER';
    const other = await connect(AS.other);
    const owner = await connect(AS.owner);
    const admin = await connect(AS.admin);
    const all = [other, owner, admin];
    await vi.waitFor(() => all.forEach((c) => expect(c.messages.length).toBeGreaterThan(0)));
    const call = {
      id: 'CA1',
      env: 'e',
      direction: 'outbound',
      ourNumber: '07000000000',
      peerNumber: '01000000000',
      title: 't',
      status: 'active',
      createdAt: 1,
      requester: 'U_REQ',
      conversationId: 'conv-pub',
      tail: [{ role: 'peer', text: 'private words', at: 1 }],
      lines: 1,
    };
    dashboard.broadcastPhoneCallUpdate(call as any);
    dashboard.broadcastPhoneCallUpdate({ ...call, id: 'CA2', requester: 'U_OTHER', conversationId: undefined } as any);
    await flushAll(all);
    const calls = (c: { messages: any[] }) =>
      c.messages.filter((m) => m.type === 'phone_call_update').map((m) => m.call.id);
    expect(calls(other)).toEqual(['CA2']); // only the call they asked for
    expect(calls(owner)).toEqual(['CA1']);
    expect(calls(admin)).toEqual(['CA1', 'CA2']);
  });

  it('the socket: a call from a conversation no longer live still reaches that conversation’s owner (from its record)', async () => {
    CONVERSATIONS.set('conv-archived', conversation('archived', 'C_PUB'));
    try {
      const other = await connect(AS.other);
      const owner = await connect(AS.owner);
      await vi.waitFor(() => [other, owner].forEach((c) => expect(c.messages.length).toBeGreaterThan(0)));
      dashboard.broadcastPhoneCallUpdate({
        id: 'CA3',
        env: 'e',
        direction: 'outbound',
        ourNumber: '07000000000',
        peerNumber: '01000000000',
        title: 't',
        status: 'ended',
        createdAt: 1,
        requester: 'U_REQ',
        conversationId: 'conv-archived',
        tail: [],
        lines: 0,
      } as any);
      await vi.waitFor(() =>
        expect(owner.messages.filter((m) => m.type === 'phone_call_update').map((m) => m.call.id)).toEqual(['CA3']),
      );
      await flushAll([other, owner]);
      expect(other.messages.some((m) => m.type === 'phone_call_update')).toBe(false);
    } finally {
      CONVERSATIONS.delete('conv-archived');
    }
  });

  it('a private task with no live session (archived) is read from its record: 404 to a stranger, its owner reads it', async () => {
    CONVERSATIONS.set('conv-gone', conversation('gone', 'C_PRIV'));
    try {
      for (const url of [
        '/api/dashboard/session/conv-gone',
        '/api/dashboard/session/conv-gone/media',
        '/conversations/conv-gone',
      ]) {
        expect((await web.injectWebServer({ method: 'GET', url, headers: AS.other })).statusCode).toBe(404);
      }
      const own = await web.injectWebServer({
        method: 'GET',
        url: '/api/dashboard/session/conv-gone',
        headers: AS.owner,
      });
      expect(own.statusCode).toBe(200);
      expect(own.body).toContain('secret instruction gone');
    } finally {
      CONVERSATIONS.delete('conv-gone');
    }
  });

  it('a lookup that fails refuses (fail closed) — a record a pre-handler already loaded is never served past it', async () => {
    const recorder = await import('../recorder');
    const real = (recorder.getConversation as any).getMockImplementation();
    CONVERSATIONS.set('conv-gone', conversation('gone', 'C_PRIV'));
    // The first read (the conversation route's loader) succeeds; every later one fails.
    let reads = 0;
    (recorder.getConversation as any).mockImplementation(async (id: string) => {
      if (id === 'conv-gone' && reads++ > 0) throw new Error('disk gone');
      return CONVERSATIONS.get(id) ?? null;
    });
    try {
      const res = await web.injectWebServer({ method: 'GET', url: '/api/conversations/conv-gone', headers: AS.other });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('secret');
      // A read the gate itself cannot make: refused too.
      reads = 1;
      const detail = await web.injectWebServer({
        method: 'GET',
        url: '/api/dashboard/session/conv-gone',
        headers: AS.other,
      });
      expect(detail.statusCode).toBe(404);
    } finally {
      (recorder.getConversation as any).mockImplementation(real);
      CONVERSATIONS.delete('conv-gone');
    }
  });

  it('the socket: a board that cannot be serialised keeps the sockets registered for the next push', async () => {
    const other = await connect(AS.other);
    await vi.waitFor(() => expect(other.messages.some((m) => m.type === 'session_update')).toBe(true));
    // A value JSON cannot write (a bigint) on a public card: this push fails for everyone.
    sessions.set('C_PUB:bad.1', liveSession('bad', 'C_PUB', { model: BigInt(1) }));
    dashboard.broadcastSessionUpdate();
    sessions.delete('C_PUB:bad.1');
    await flushAll([other]);
    {
      const u = other.messages.filter((m) => m.type === 'session_update');
      expect(boardIds(u[u.length - 1])).toEqual(['conv-pub']);
    }
  });

  it('the socket: an artifact of a task no longer live goes to whoever may see its conversation record', async () => {
    CONVERSATIONS.set('conv-gone-pub', conversation('gone-pub', 'C_PUB'));
    CONVERSATIONS.set('conv-gone', conversation('gone', 'C_PRIV'));
    try {
      const other = await connect(AS.other);
      const owner = await connect(AS.owner);
      await vi.waitFor(() => [other, owner].forEach((c) => expect(c.messages.length).toBeGreaterThan(0)));
      for (const conversationId of ['conv-gone-pub', 'conv-gone'])
        dashboard.broadcastArtifactUpdate({
          id: 'a',
          conversationId,
          name: 'x.md',
          kind: 'markdown',
          createdAt: 1,
        } as any);
      const arts = (c: { messages: any[] }) =>
        c.messages
          .filter((m) => m.type === 'artifact_update')
          .map((m) => m.conversationId)
          .sort();
      await vi.waitFor(() => expect(arts(owner)).toEqual(['conv-gone', 'conv-gone-pub']));
      await flushAll([other, owner]);
      expect(arts(other)).toEqual(['conv-gone-pub']);
    } finally {
      CONVERSATIONS.delete('conv-gone-pub');
      CONVERSATIONS.delete('conv-gone');
    }
  });

  it('the socket: two owners of private tasks each get their own private task and the public ones, never the other’s', async () => {
    sessions.set('C_PRIV:priv2.1', liveSession('priv2', 'C_PRIV', { ownerId: 'U_OWNER2', ownerName: 'Owner 2' }));
    const owner = await connect(AS.owner);
    const owner2 = await connect({ cookie: userCookie('U_OWNER2') });
    const other = await connect(AS.other);
    await flushAll([owner, owner2, other]);
    const last = (c: { messages: any[] }) => {
      const updates = c.messages.filter((m) => m.type === 'session_update');
      return boardIds(updates[updates.length - 1]);
    };
    expect(last(owner)).toEqual(['conv-dm', 'conv-priv', 'conv-pub', 'conv-unk']);
    expect(last(owner2)).toEqual(['conv-priv2', 'conv-pub']);
    expect(last(other)).toEqual(['conv-pub']);
  });

  it('a private task’s stored bytes — an attachment, an artifact — answer a stranger 404; its owner gets them', async () => {
    // An attachment kept under the conversation, named on its user turn.
    const mediaDir = path.join(paths.dataDir, 'user-media', 'conv-priv');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'm1'), 'secret attachment bytes');
    const record = CONVERSATIONS.get('conv-priv') as any;
    const turn = record.turns[0];
    turn.attachments = [{ id: 'm1', name: 'plan.txt', kind: 'file', mime: 'text/plain', size: 23, stored: true }];
    // An artifact the model posted.
    // The store copies an upload only from under /tmp (artifacts.ts UPLOAD_ROOTS).
    const srcDir = fs.mkdtempSync('/tmp/soma-task-visibility-art-');
    const src = path.join(srcDir, 'report.md');
    fs.writeFileSync(src, '# secret artifact bytes');
    const { getArtifactStore } = await import('../artifacts');
    const art = await getArtifactStore().recordSlackUpload({
      conversationId: 'conv-priv',
      filePath: src,
      filename: 'report.md',
      slackFileId: 'F1',
    });
    try {
      const urls = [
        '/api/dashboard/session/conv-priv/media/m1/content',
        `/api/dashboard/session/conv-priv/artifacts/${art?.id}/content`,
      ];
      for (const url of urls) {
        const stranger = await web.injectWebServer({ method: 'GET', url, headers: AS.other });
        expect({ url, status: stranger.statusCode }).toEqual({ url, status: 404 });
        expect(stranger.body).not.toContain('secret');
        const own = await web.injectWebServer({ method: 'GET', url, headers: AS.owner });
        expect({ url, status: own.statusCode }).toEqual({ url, status: 200 });
        expect(own.body).toContain('secret');
      }
    } finally {
      delete turn.attachments;
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('a request that reaches a task route with no viewer at all sees public tasks only', async () => {
    // A sign-in check that let a request through without saying who it is: the gate still refuses private tasks.
    const fastify = (await import('fastify')).default;
    const app = fastify();
    dashboard.installPrivateTaskGate(app);
    app.get('/api/dashboard/session/:conversationId', { preHandler: [async () => {}] }, async () => ({ served: true }));
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/session/conv-priv' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/session/conv-nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/session/conv-pub' })).json()).toEqual({
      served: true,
    });
    await app.close();
  });

  it('the socket: a public epic’s push carries its private child to its owner only — a stranger gets the epic without it', async () => {
    sessions.set(
      'C_PUB:epic.1',
      liveSession('epic', 'C_PUB', {
        kind: 'epic',
        taskId: 'T-EPIC',
        plan: { nodes: [{ id: 'n1', title: 'node one', kind: 'issue' }] },
      }),
    );
    sessions.set(
      'C_PRIV:child.1',
      liveSession('child', 'C_PRIV', {
        parentTaskId: 'T-EPIC',
        planNodeId: 'n1',
        taskId: 'T-CHILD',
        title: 'secret child',
      }),
    );
    const other = await connect(AS.other);
    const owner = await connect(AS.owner);
    await vi.waitFor(() => [other, owner].forEach((c) => expect(c.messages.length).toBeGreaterThan(0)));
    dashboard.broadcastSingleSessionUpdate('C_PRIV:child.1');
    await flushAll([other, owner]);
    const epicPush = (c: { messages: any[] }) => c.messages.find((m) => m.type === 'sessionUpdated');
    expect(epicPush(other)?.session.conversationId).toBe('conv-epic');
    expect(epicPush(other)?.session.epic.children).toEqual([]);
    expect(JSON.stringify(epicPush(other))).not.toContain('secret child');
    expect(epicPush(owner)?.session.epic.children.map((c: any) => c.conversationId)).toEqual(['conv-child']);
  });

  it('archived cards: a private one is on its owner’s and admins’ board (marked), not a stranger’s', async () => {
    const archived = (id: string, channelId: string) => ({
      sessionKey: `${channelId}:${id}.9`,
      archivedAt: 1_700_000_000_000,
      ownerId: 'U_OWNER',
      ownerName: 'Owner',
      channelId,
      threadTs: `${id}.9`,
      sessionId: `sid-${id}`,
      conversationId: `conv-${id}`,
      title: `Archived ${id}`,
      lastActivity: Date.now(),
    });
    archive.recent = [archived('old-pub', 'C_PUB'), archived('old-priv', 'C_PRIV')];
    const closed = async (headers: Record<string, string>) => {
      const res = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/sessions', headers });
      return (JSON.parse(res.body).board.closed as Array<Record<string, unknown>>)
        .map((c) => [c.conversationId, c.privateTask])
        .sort();
    };
    expect(await closed(AS.other)).toEqual([['conv-old-pub', false]]);
    expect(await closed(AS.owner)).toEqual([
      ['conv-old-priv', true],
      ['conv-old-pub', false],
    ]);
  });

  it('the conversation page’s side list is the viewer’s too', async () => {
    const viewer = await import('../viewer');
    const res = await web.injectWebServer({ method: 'GET', url: '/conversations/conv-pub', headers: AS.other });
    expect(res.statusCode).toBe(200);
    const calls = (viewer.renderConversationViewPage as any).mock.calls;
    const list = calls[calls.length - 1][1] as Array<Record<string, unknown>>;
    expect(list.map((c) => c.id)).toEqual(['conv-pub']);
    expect(list[0]).not.toHaveProperty('channelId');
  });

  it('a session key that names no task when the gate reads it is refused — a task that appears before the route reads is never served', async () => {
    // The gate's read finds nothing; the route's read (a moment later) finds the private task with a plan.
    let reads = 0;
    dashboard.setDashboardSessionAccessor(() => (reads++ === 0 ? new Map() : sessions));
    const res = await web.injectWebServer({
      method: 'GET',
      url: `/api/dashboard/session/${encodeURIComponent(keyOf('priv'))}/plan`,
      headers: AS.other,
    });
    expect(res.statusCode).toBe(404);
    expect(reads).toBe(1);
    dashboard.setDashboardSessionAccessor(() => sessions);
  });

  it('the socket: an artifact whose conversation cannot be read goes to admins only', async () => {
    const recorder = await import('../recorder');
    const real = (recorder.getConversation as any).getMockImplementation();
    (recorder.getConversation as any).mockImplementation(async (id: string) => {
      if (id === 'conv-broken') throw new Error('disk gone');
      return CONVERSATIONS.get(id) ?? null;
    });
    try {
      const owner = await connect(AS.owner);
      const admin = await connect(AS.admin);
      await vi.waitFor(() => [owner, admin].forEach((c) => expect(c.messages.length).toBeGreaterThan(0)));
      dashboard.broadcastArtifactUpdate({
        id: 'a',
        conversationId: 'conv-broken',
        name: 'x.md',
        kind: 'markdown',
        createdAt: 1,
      } as any);
      const arts = (c: { messages: any[] }) => c.messages.filter((m) => m.type === 'artifact_update').length;
      await vi.waitFor(() => expect(arts(admin)).toBe(1));
      await flushAll([owner, admin]);
      expect(arts(owner)).toBe(0);
    } finally {
      (recorder.getConversation as any).mockImplementation(real);
    }
  });

  it('every read route of a private task answers 404 to a stranger, as if it did not exist; the owner and an admin read it', async () => {
    const reads = (id: string) => [
      `/api/dashboard/session/conv-${id}`,
      `/api/dashboard/session/conv-${id}/media`,
      `/api/dashboard/session/conv-${id}/artifacts`,
      `/api/dashboard/session/conv-${id}/worklog`,
      `/api/dashboard/session/conv-${id}/instructions`,
      `/api/conversations/conv-${id}`,
      `/api/conversations/conv-${id}/turns/a1/raw`,
      `/conversations/conv-${id}`,
    ];
    for (const id of ['priv', 'dm', 'unk']) {
      for (const url of reads(id)) {
        const res = await web.injectWebServer({ method: 'GET', url, headers: AS.other });
        expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
        expect(res.body).not.toContain('secret');
      }
      for (const who of [AS.owner, AS.admin]) {
        const res = await web.injectWebServer({
          method: 'GET',
          url: `/api/dashboard/session/conv-${id}`,
          headers: who,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain(`secret instruction ${id}`);
      }
    }
    // By session key: the plan and the plan page.
    const k = encodeURIComponent(keyOf('priv'));
    for (const url of [`/api/dashboard/session/${k}/plan`, `/dashboard/plan/${k}`]) {
      expect((await web.injectWebServer({ method: 'GET', url, headers: AS.other })).statusCode).toBe(404);
    }
    expect(
      (await web.injectWebServer({ method: 'GET', url: `/api/dashboard/session/${k}/plan`, headers: AS.owner }))
        .statusCode,
    ).toBe(200);
    // A public task is readable by everyone, as before.
    const pub = await web.injectWebServer({ method: 'GET', url: '/api/dashboard/session/conv-pub', headers: AS.other });
    expect(pub.statusCode).toBe(200);
    expect(
      (await web.injectWebServer({ method: 'GET', url: '/api/conversations/conv-pub/turns/a1/raw', headers: AS.other }))
        .statusCode,
    ).toBe(200);
  });

  it('the conversation lists leave the private tasks out for a stranger and carry no owner or channel', async () => {
    const list = async (headers: Record<string, string>) =>
      JSON.parse((await web.injectWebServer({ method: 'GET', url: '/api/conversations', headers })).body)
        .conversations as Array<Record<string, unknown>>;
    const stranger = await list(AS.other);
    expect(stranger.map((c) => c.id)).toEqual(['conv-pub']);
    expect(stranger[0]).not.toHaveProperty('channelId');
    expect(stranger[0]).not.toHaveProperty('ownerId');
    expect((await list(AS.owner)).map((c) => c.id).sort()).toEqual(['conv-dm', 'conv-priv', 'conv-pub', 'conv-unk']);
    // The HTML list page renders the same filtered list.
    const viewer = await import('../viewer');
    await web.injectWebServer({ method: 'GET', url: '/conversations', headers: AS.other });
    const calls = (viewer.renderConversationListPage as any).mock.calls;
    const rendered = calls[calls.length - 1][0] as Array<{ id: string }>;
    expect(rendered.map((c) => c.id)).toEqual(['conv-pub']);
  });

  it('the cron lane leaves out a stranger’s view of a job that runs in a private channel', async () => {
    const job = (id: string, channel: string) => ({
      id,
      name: `job-${id}`,
      expression: '0 9 * * *',
      prompt: 'p',
      owner: 'U_OWNER',
      channel,
      threadTs: null,
      createdAt: '2026-11-01T00:00:00Z',
      lastRunAt: null,
      lastRunMinute: null,
    });
    dashboard.setDashboardCronSource({
      listJobs: () => [job('j-pub', 'C_PUB'), job('j-priv', 'C_PRIV'), job('j-dm', 'D_OWNER')] as any,
      listHistory: () => [],
      getJob: () => undefined,
      updateJob: () => null,
    });
    const jobs = async (headers: Record<string, string>) =>
      (
        JSON.parse((await web.injectWebServer({ method: 'GET', url: '/api/dashboard/cron', headers })).body)
          .jobs as Array<{
          id: string;
        }>
      )
        .map((j) => j.id)
        .sort();
    expect(await jobs(AS.other)).toEqual(['j-pub']);
    expect(await jobs(AS.owner)).toEqual(['j-dm', 'j-priv', 'j-pub']);
    expect(await jobs(AS.admin)).toEqual(['j-dm', 'j-priv', 'j-pub']);
  });

  it('the cron lane: a public job’s run that is a private task (the job moved, or it ran in a private thread) shows no task to a stranger', async () => {
    const run = (sessionKey: string) => ({
      jobId: 'j-moved',
      jobName: 'job-moved',
      executedAt: '2026-11-15T09:00:00Z',
      status: 'success',
      executionPath: 'new_thread',
      sessionKey,
    });
    dashboard.setDashboardCronSource({
      listJobs: () =>
        [
          {
            id: 'j-moved',
            name: 'job-moved',
            expression: '0 9 * * *',
            prompt: 'p',
            owner: 'U_OWNER',
            channel: 'C_PUB',
            threadTs: null,
            createdAt: '2026-11-01T00:00:00Z',
            lastRunAt: null,
            lastRunMinute: null,
          },
        ] as any,
      // A run names its thread by the work-session key (`work:<channel>:<thread>`).
      listHistory: () => [run(`work:${keyOf('priv')}`), run(`work:${keyOf('pub')}`)] as any,
      getJob: () => undefined,
      updateJob: () => null,
    });
    const runs = async (headers: Record<string, string>) => {
      const body = JSON.parse((await web.injectWebServer({ method: 'GET', url: '/api/dashboard/cron', headers })).body);
      return (body.jobs[0].runs as Array<{ session?: { headline?: string } }>).map((r) => r.session?.headline ?? null);
    };
    expect(await runs(AS.other)).toEqual([null, 'Task pub']);
    expect(await runs(AS.owner)).toEqual(['Task priv', 'Task pub']);
    expect(await runs(AS.admin)).toEqual(['Task priv', 'Task pub']);
  });
});

describe('task-visibility — instructions', () => {
  let web: typeof import('../web-server');
  let dashboard: typeof import('../dashboard');
  let sent: Array<[string, string | undefined]>;
  let sessions: Map<string, any>;

  beforeEach(async () => {
    vi.resetModules();
    archive.recent = [];
    paths.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-task-visibility-cmd-'));
    web = await import('../web-server');
    dashboard = await import('../dashboard');
    const registry = await import('../../channel-registry');
    registry.upsertChannel({ id: 'C_PUB', name: 'open', isPrivate: false });
    registry.upsertChannel({ id: 'C_PRIV', name: 'acquisition', isPrivate: true });
    sessions = new Map(SESSIONS.map(([id, ch]) => [keyOf(id), liveSession(id, ch, { activityState: 'idle' })]));
    dashboard.setDashboardSessionAccessor(() => sessions);
    sent = [];
    dashboard.setDashboardCommandHandler(async (k: string, _m: string, _a: unknown, actor?: string) => {
      sent.push([k, actor]);
    });
    await web.startWebServer({ listen: false });
  });

  afterEach(async () => {
    await web.stopWebServer();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
  });

  async function signIn(userId: string) {
    const { issueSlackToken } = await import('../oauth');
    const token = issueSlackToken({ slackUserId: userId, email: `${userId}@slack.local`, name: userId });
    const sso = await web.injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await web.injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json' };
  }
  const command = (id: string, headers: Record<string, string>) =>
    web.injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(keyOf(id))}/command`,
      headers,
      payload: JSON.stringify({ message: 'do it' }),
    });

  it('stopping a private task tells its owner’s and admins’ sockets, not a stranger’s — also when the stop takes the session away', async () => {
    // The stop removes the session: who may see it is read before, not after.
    dashboard.setDashboardStopHandler(async (key: string) => {
      sessions.delete(key);
    });
    const sockets: any[] = [];
    const connect = async (who: string) => {
      const messages: any[] = [];
      const { cookie } = await signIn(who);
      sockets.push(
        await web.injectWebServerWS('/ws/dashboard', { headers: { cookie } }, (socket: any) => {
          socket.on('message', (data: any) => messages.push(JSON.parse(data.toString())));
        }),
      );
      return messages;
    };
    try {
      const other = await connect('U_OTHER');
      const admin = await connect('U_ADMIN');
      const ownerSocket = await connect('U_OWNER');
      const owner = await signIn('U_OWNER');
      const res = await web.injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(keyOf('priv'))}/stop`,
        headers: owner,
        payload: '{}',
      });
      expect(res.statusCode).toBe(200);
      expect(sessions.has(keyOf('priv'))).toBe(false);
      // The stop's board push follows its action push on every socket (one socket keeps order).
      await vi.waitFor(() => {
        for (const m of [other, admin, ownerSocket])
          expect(m.filter((x) => x.type === 'session_update').length).toBeGreaterThan(1);
      });
      for (const m of [admin, ownerSocket])
        expect(m.filter((x) => x.type === 'session_action').map((x) => x.sessionKey)).toEqual([keyOf('priv')]);
      expect(other.filter((m) => m.type === 'session_action')).toEqual([]);
    } finally {
      for (const ws of sockets) ws.terminate();
    }
  });

  it('an archived private task’s card key answers a stranger 404, as a key that does not exist does; its owner revives it', async () => {
    archive.recent = [
      {
        sessionKey: 'C_PRIV:old.1',
        archivedAt: 1_700_000_000_000,
        ownerId: 'U_OWNER',
        ownerName: 'Owner',
        channelId: 'C_PRIV',
        threadTs: 'old.1',
        sessionId: 'sid-old',
        conversationId: 'conv-old',
      },
    ];
    const restored: string[] = [];
    dashboard.setDashboardLifecycleHandler({
      star: () => ({ ok: false, code: 'not_found' }) as any,
      revive: () => ({ ok: false, code: 'not_found' }) as any,
      restore: (archived: any) => {
        restored.push(archived.sessionKey);
        return { ok: true, sessionKey: archived.sessionKey, starred: false, revived: true } as any;
      },
    });
    const revive = (key: string, headers: Record<string, string>) =>
      web.injectWebServer({
        method: 'POST',
        url: `/api/dashboard/session/${encodeURIComponent(key)}/revive`,
        headers,
        payload: '{}',
      });
    try {
      const other = await signIn('U_OTHER');
      expect((await revive('archived_C_PRIV:old.1_1700000000000', other)).statusCode).toBe(404);
      expect((await revive('archived_C_PRIV:gone.1_1700000000000', other)).statusCode).toBe(404);
      expect(restored).toEqual([]);
      const owner = await signIn('U_OWNER');
      const res = await revive('archived_C_PRIV:old.1_1700000000000', owner);
      expect(res.statusCode).toBe(200);
      expect(restored).toEqual(['C_PRIV:old.1']);
    } finally {
      dashboard.setDashboardLifecycleHandler(null);
    }
  });

  it('a stranger cannot instruct a private task (404, nothing sent); an admin needs admin mode; the owner can', async () => {
    const other = await signIn('U_OTHER');
    for (const id of ['priv', 'dm', 'unk']) expect((await command(id, other)).statusCode).toBe(404);
    expect(sent).toEqual([]);
    const admin = await signIn('U_ADMIN');
    expect((await command('priv', admin)).statusCode).toBe(403);
    expect(sent).toEqual([]);
    expect((await command('priv', { ...admin, 'x-admin-mode': 'on' })).statusCode).toBe(200);
    const owner = await signIn('U_OWNER');
    expect((await command('priv', owner)).statusCode).toBe(200);
    // A public task takes anyone's instruction, as before (it runs as them).
    expect((await command('pub', other)).statusCode).toBe(200);
    expect(sent).toEqual([
      [keyOf('priv'), 'U_ADMIN'],
      [keyOf('priv'), 'U_OWNER'],
      [keyOf('pub'), 'U_OTHER'],
    ]);
  });
});
