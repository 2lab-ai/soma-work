/**
 * Dashboard instruction-centric read API (#758).
 *
 * Read-only surface — write actions live in #759. The dashboard renders
 * an "Active Instructions" section above the kanban, and clicking the
 * `[⋯]` menu must propose a lifecycle change (PR2 user-confirm gate)
 * NOT mutate the user-session-store directly. These tests exercise the
 * three new read API shapes plus the propose-lifecycle indirection.
 */

import * as jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleEvent, UserInstruction, UserSessionDoc } from '../../user-session-store';

// ── Mocks (mirror dashboard.test.ts) ──

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
    jwtSecret: 'test-jwt-secret-for-owner-scope-tests',
    jwtExpiresIn: 604800,
  },
};

// Helper: forge a JWT cookie for an oauth_jwt-mode authenticated user.
// Mirrors the production JWT shape (sub/email/name/originalIat).
function makeOAuthCookie(userId: string, email = `${userId}@example.com`): string {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { sub: userId, email, name: userId, provider: 'google', originalIat: now },
    mockConfig.oauth.jwtSecret,
    { expiresIn: mockConfig.oauth.jwtExpiresIn },
  );
  return `soma_dash_token=${encodeURIComponent(token)}`;
}

// Use TMPDIR (sandbox-writable) so user-settings store can mkdir without
// running into the sandbox /tmp write block.
const TEST_DATA_DIR = `${process.env.TMPDIR || '/tmp'}/soma-test-data-758`;

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: TEST_DATA_DIR }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
const mockListRecent = vi.fn().mockReturnValue([]);
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: mockListRecent }),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

// Helpers
function makeInstruction(overrides: Partial<UserInstruction> = {}): UserInstruction {
  return {
    id: 'inst-A',
    text: 'Implement #758 dashboard',
    status: 'active',
    linkedSessionIds: ['C1:t1'],
    createdAt: '2026-04-20T10:00:00.000Z',
    source: 'model',
    sourceRawInputIds: [],
    ...overrides,
  };
}

function makeDoc(overrides: Partial<UserSessionDoc> = {}): UserSessionDoc {
  return {
    schemaVersion: 1,
    instructions: [],
    lifecycleEvents: [],
    ...overrides,
  };
}

function makeLifecycleEvent(overrides: Partial<LifecycleEvent>): LifecycleEvent {
  return {
    id: 'evt-1',
    instructionId: 'inst-A',
    sessionKey: 'C1:t1',
    op: 'add',
    state: 'confirmed',
    at: '2026-04-20T10:00:00.000Z',
    by: { type: 'system', id: 'test' },
    payload: {},
    ...overrides,
  };
}

describe('Dashboard instruction-centric read APIs (#758)', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let setDashboardSessionAccessor: any;
  let setDashboardUserInstructionsAccessor: any;
  let setDashboardInstructionTodosAccessor: any;
  let setDashboardLifecycleProposeHandler: any;

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = 'test-token';

    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;

    const dashboard = await import('../dashboard');
    setDashboardSessionAccessor = dashboard.setDashboardSessionAccessor;
    setDashboardUserInstructionsAccessor = dashboard.setDashboardUserInstructionsAccessor;
    setDashboardInstructionTodosAccessor = dashboard.setDashboardInstructionTodosAccessor;
    setDashboardLifecycleProposeHandler = dashboard.setDashboardLifecycleProposeHandler;

    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  // ── GET /api/dashboard/users/:userId/instructions ──

  it('lists active instructions with linked sessions and progress', async () => {
    const doc = makeDoc({
      instructions: [
        makeInstruction({ id: 'inst-A', text: 'A', linkedSessionIds: ['C1:t1', 'C2:t2'] }),
        makeInstruction({ id: 'inst-DONE', text: 'B', status: 'completed', linkedSessionIds: ['C3:t3'] }),
        makeInstruction({ id: 'inst-CANCEL', text: 'C', status: 'cancelled', linkedSessionIds: [] }),
      ],
    });
    setDashboardUserInstructionsAccessor(() => doc);

    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      lastActivity: new Date(),
      title: 'Live one',
    });
    sessions.set('C2:t2', {
      sessionId: 's2',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C2',
      threadTs: 't2',
      activityState: 'idle',
      lastActivity: new Date(),
      title: 'Live two',
    });
    setDashboardSessionAccessor(() => sessions);

    setDashboardInstructionTodosAccessor((_userId: string, instructionId: string) => {
      if (instructionId === 'inst-A') {
        return [
          { id: 't1', content: 'a', status: 'completed', priority: 'medium' },
          { id: 't2', content: 'b', status: 'pending', priority: 'medium' },
          { id: 't3', content: 'c', status: 'pending', priority: 'medium' },
        ];
      }
      return [];
    });

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/users/U1/instructions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.userId).toBe('U1');
    expect(Array.isArray(body.instructions)).toBe(true);
    // Only `active` instructions surface on this read.
    expect(body.instructions).toHaveLength(1);

    const a = body.instructions[0];
    expect(a.id).toBe('inst-A');
    expect(a.text).toBe('A');
    expect(a.status).toBe('active');
    expect(a.linkedSessions).toHaveLength(2);
    // Linked-session entries carry the live activityState so the card can
    // render the dot color.
    expect(a.linkedSessions.find((ls: any) => ls.sessionKey === 'C1:t1').activityState).toBe('working');
    expect(a.linkedSessions.find((ls: any) => ls.sessionKey === 'C2:t2').activityState).toBe('idle');
    expect(a.progress).toEqual({ total: 3, completed: 1, pending: 2, in_progress: 0 });
    expect(typeof a.ageMs).toBe('number');
    expect(a.ageMs).toBeGreaterThan(0);
  });

  it('returns 401 without auth', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/users/U1/instructions',
      headers: { Accept: 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with empty list when user has no instructions yet', async () => {
    setDashboardUserInstructionsAccessor(() => null);
    setDashboardSessionAccessor(() => new Map());
    setDashboardInstructionTodosAccessor(() => []);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/users/U-empty/instructions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.instructions).toEqual([]);
  });

  it('returns 400 for unsafe userId', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/users/..%2Fevil/instructions',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(400);
  });

  // ── GET /api/dashboard/instructions/:id ──

  it('drill-down returns instruction + tasks union + lifecycle events filtered by id', async () => {
    const doc = makeDoc({
      instructions: [makeInstruction({ id: 'inst-A', text: 'A', linkedSessionIds: ['C1:t1', 'C2:t2'] })],
      lifecycleEvents: [
        makeLifecycleEvent({ id: 'evt-A1', instructionId: 'inst-A', op: 'add', state: 'confirmed' }),
        makeLifecycleEvent({ id: 'evt-A2', instructionId: 'inst-A', op: 'link', state: 'confirmed' }),
        makeLifecycleEvent({ id: 'evt-OTHER', instructionId: 'inst-OTHER', op: 'add', state: 'confirmed' }),
        makeLifecycleEvent({ id: 'evt-NULL', instructionId: null, op: 'add', state: 'rejected' }),
      ],
    });

    // User-id → doc accessor: when called with the resolved owner the doc is
    // returned. This mirrors the production seam (controller resolves owner
    // from the instruction-index, dashboard never reads disk).
    setDashboardUserInstructionsAccessor((userId: string) => (userId === 'U1' ? doc : null));

    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      lastActivity: new Date(),
      title: 'Sess one',
    });
    sessions.set('C2:t2', {
      sessionId: 's2',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C2',
      threadTs: 't2',
      activityState: 'idle',
      lastActivity: new Date(),
      title: 'Sess two',
    });
    setDashboardSessionAccessor(() => sessions);

    setDashboardInstructionTodosAccessor((userId: string, instructionId: string) => {
      if (userId === 'U1' && instructionId === 'inst-A') {
        return [
          { id: 'todo-1', content: 'one', status: 'completed', priority: 'medium' },
          { id: 'todo-2', content: 'two', status: 'in_progress', priority: 'medium' },
          { id: 'todo-3', content: 'three', status: 'pending', priority: 'low' },
        ];
      }
      return [];
    });

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/instructions/inst-A?userId=U1',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.instruction.id).toBe('inst-A');
    expect(body.instruction.text).toBe('A');
    expect(body.linkedSessions).toHaveLength(2);
    expect(body.tasks).toHaveLength(3);
    // Lifecycle events must be filtered to this instruction id only.
    expect(body.lifecycleEvents.map((e: any) => e.id).sort()).toEqual(['evt-A1', 'evt-A2']);
    expect(body.lifecycleEvents.every((e: any) => e.instructionId === 'inst-A')).toBe(true);
  });

  it('drill-down returns 404 when instruction does not exist', async () => {
    setDashboardUserInstructionsAccessor(() => makeDoc());
    setDashboardSessionAccessor(() => new Map());
    setDashboardInstructionTodosAccessor(() => []);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/instructions/inst-MISSING?userId=U1',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(404);
  });

  it('drill-down requires userId query parameter', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/instructions/inst-A',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(400);
  });

  // ── /api/dashboard/sessions extension (#758) ──

  it('extends /api/dashboard/sessions with currentInstructionId + instructionHistory', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'working',
      state: 'MAIN',
      lastActivity: new Date(),
      title: 'session',
      currentInstructionId: 'inst-A',
      instructionHistory: ['inst-OLD', 'inst-A'],
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const card = body.board.working[0];
    expect(card.currentInstructionId).toBe('inst-A');
    expect(card.instructionHistory).toEqual(['inst-OLD', 'inst-A']);
  });

  it('omits instruction fields when session has no pointer', async () => {
    const sessions = new Map<string, any>();
    sessions.set('C1:t1', {
      sessionId: 's1',
      ownerId: 'U1',
      ownerName: 'Alice',
      channelId: 'C1',
      threadTs: 't1',
      activityState: 'idle',
      state: 'MAIN',
      lastActivity: new Date(),
      title: 'plain',
    });
    setDashboardSessionAccessor(() => sessions);

    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: AUTH_HEADER,
    });

    const body = JSON.parse(res.body);
    const card = body.board.idle[0];
    expect(card.currentInstructionId).toBeUndefined();
    expect(card.instructionHistory).toBeUndefined();
  });

  // ── Lifecycle propose route (read-only PR — no direct mutation) ──

  it('POST /api/dashboard/instructions/:id/propose-lifecycle hands off to lifecycle gate, never mutating the store', async () => {
    const handler = vi.fn().mockResolvedValue({ requestId: 'req-xyz' });
    setDashboardLifecycleProposeHandler(handler);

    // CSRF token cookie + header pair (matching how other write routes are gated).
    const res = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/instructions/inst-A/propose-lifecycle',
      headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
      payload: { userId: 'U1', op: 'complete' },
    });

    expect(res.statusCode).toBe(202);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      userId: 'U1',
      instructionId: 'inst-A',
      op: 'complete',
    });
    const body = JSON.parse(res.body);
    expect(body).toEqual({ ok: true, requestId: 'req-xyz' });
  });

  it('POST propose-lifecycle returns 501 when no handler is configured', async () => {
    // Reset modules so no handler is registered.
    vi.resetModules();
    mockConfig.conversation.viewerToken = 'test-token';
    const webServer = await import('../web-server');
    const dashboard = await import('../dashboard');
    const startFresh = webServer.startWebServer;
    const injectFresh = webServer.injectWebServer;
    const stopFresh = webServer.stopWebServer;
    dashboard.setDashboardSessionAccessor(() => new Map());
    await startFresh({ listen: false });
    try {
      const res = await injectFresh({
        method: 'POST',
        url: '/api/dashboard/instructions/inst-A/propose-lifecycle',
        headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
        payload: { userId: 'U1', op: 'cancel' },
      });
      expect(res.statusCode).toBe(501);
    } finally {
      await stopFresh();
    }
  });

  it('POST propose-lifecycle rejects unknown op (only the lifecycle 5-op vocabulary is allowed)', async () => {
    const handler = vi.fn().mockResolvedValue({ requestId: 'req-xyz' });
    setDashboardLifecycleProposeHandler(handler);

    const res = await injectWebServer({
      method: 'POST',
      url: '/api/dashboard/instructions/inst-A/propose-lifecycle',
      headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
      payload: { userId: 'U1', op: 'mutate-directly' },
    });
    expect(res.statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Codex P1-1 — Owner-scope auth on instruction read endpoints ──

  describe('owner-scope auth (codex P1-1 #758)', () => {
    beforeEach(() => {
      // Cross-user instruction reads must be denied. We reuse the same
      // accessor for every user — the route is responsible for gating.
      const docU1 = makeDoc({
        instructions: [makeInstruction({ id: 'inst-A', text: 'U1 work', linkedSessionIds: [] })],
      });
      setDashboardUserInstructionsAccessor((userId: string) => (userId === 'U1' ? docU1 : null));
      setDashboardSessionAccessor(() => new Map());
      setDashboardInstructionTodosAccessor(() => []);
    });

    it('U1 (owner) CAN read /api/dashboard/users/U1/instructions', async () => {
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/users/U1/instructions',
        headers: { Cookie: makeOAuthCookie('U1') },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.userId).toBe('U1');
      expect(body.instructions).toHaveLength(1);
    });

    it('U2 (non-owner, non-admin) CANNOT read U1 instructions — 403', async () => {
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/users/U1/instructions',
        headers: { Cookie: makeOAuthCookie('U2') },
      });
      expect(res.statusCode).toBe(403);
    });

    it('U2 (non-owner, non-admin) CANNOT read U1 instruction drill-down — 403', async () => {
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/instructions/inst-A?userId=U1',
        headers: { Cookie: makeOAuthCookie('U2') },
      });
      expect(res.statusCode).toBe(403);
    });

    it('U1 (owner) CAN read own instruction drill-down', async () => {
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/instructions/inst-A?userId=U1',
        headers: { Cookie: makeOAuthCookie('U1') },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.instruction.id).toBe('inst-A');
    });

    it('admin (bearer header) CAN read any user instructions', async () => {
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/users/U1/instructions',
        headers: AUTH_HEADER, // Bearer test-token = admin
      });
      expect(res.statusCode).toBe(200);
    });

    it('admin (bearer header) CAN read any user drill-down', async () => {
      const res = await injectWebServer({
        method: 'GET',
        url: '/api/dashboard/instructions/inst-A?userId=U1',
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
    });
  });
});

describe('Dashboard HTML — Active Instructions section (#758)', () => {
  let injectWebServer: any;
  let startWebServer: any;
  let stopWebServer: any;

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = 'test-token';
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;

    const dashboard = await import('../dashboard');
    dashboard.setDashboardSessionAccessor(() => new Map());
    await startWebServer({ listen: false });
  });

  afterEach(async () => {
    await stopWebServer();
  });

  it('renders an Active Instructions section above the kanban', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });

    expect(res.statusCode).toBe(200);
    const html: string = res.body;
    // Container present
    expect(html).toContain('id="instructions-section"');
    expect(html).toContain('id="instructions-list"');
    // Inline <script> wires loadInstructions + renderInstructionCard
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch![1];
    expect(script).toContain('function loadInstructions');
    expect(script).toContain('function renderInstructionCard');
    // The instructions section must come before the kanban container
    const insIdx = html.indexOf('id="instructions-section"');
    const kanbanIdx = html.indexOf('class="kanban"');
    expect(insIdx).toBeGreaterThan(-1);
    expect(kanbanIdx).toBeGreaterThan(-1);
    expect(insIdx).toBeLessThan(kanbanIdx);
    // Inline JS is still parseable
    expect(() => new Function(script)).not.toThrow();
  });

  it('the [⋯] menu only PROPOSES lifecycle ops (never POSTs to a direct-mutation route)', async () => {
    const res = await injectWebServer({
      method: 'GET',
      url: '/dashboard',
      headers: AUTH_HEADER,
    });
    const html: string = res.body;
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch![1];

    // The propose-lifecycle endpoint must be the only mutation seam from the menu.
    expect(script).toContain('/propose-lifecycle');
    // Guard: the menu MUST NOT directly hit a per-instruction mutation route
    // such as /api/dashboard/instructions/.../complete, /cancel, /rename.
    // Anything that bypasses the y/n confirm gate is a #759 feature.
    const directComplete = script.match(/instructions\/[^']*\/complete[^-]/g);
    const directCancel = script.match(/instructions\/[^']*\/cancel[^-]/g);
    const directRename = script.match(/instructions\/[^']*\/rename[^-]/g);
    expect(directComplete).toBeNull();
    expect(directCancel).toBeNull();
    expect(directRename).toBeNull();
  });
});

describe('Dashboard WS instruction broadcasts (#758)', () => {
  let dashboard: typeof import('../dashboard');

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.conversation.viewerToken = 'test-token';
    dashboard = await import('../dashboard');
  });

  it('exposes broadcastInstructionCreated/Updated/Closed helpers', () => {
    expect(typeof dashboard.broadcastInstructionCreated).toBe('function');
    expect(typeof dashboard.broadcastInstructionUpdated).toBe('function');
    expect(typeof dashboard.broadcastInstructionClosed).toBe('function');
  });

  it('the broadcast helpers are no-ops when there are no clients (do not throw)', () => {
    const inst: UserInstruction = {
      id: 'inst-A',
      text: 'demo',
      status: 'active',
      linkedSessionIds: [],
      createdAt: '2026-04-20T00:00:00.000Z',
      source: 'model',
      sourceRawInputIds: [],
    };
    expect(() => dashboard.broadcastInstructionCreated('U1', inst)).not.toThrow();
    expect(() => dashboard.broadcastInstructionUpdated('U1', inst)).not.toThrow();
    expect(() => dashboard.broadcastInstructionClosed('U1', 'inst-A', 'completed')).not.toThrow();
  });
});
