import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentRegistry, applyAgentEvent } from '../../session/agent-registry';

/**
 * Spec 12 (agent tree) §3 — the card payload carries the session's subagents.
 *
 * `KanbanSession.agents` = the subagents (the main agent is the card itself),
 * in spawn order, each with its own tasks — never the main agent's. A card
 * without subagents carries no `agents` key at all (nothing changes for it).
 * Archived cards keep theirs; an agent the archive still thought running reads
 * as `unknown` (nobody is watching it any more).
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

const archives: any[] = [];
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
  getArchiveStore: () => ({ listRecent: () => archives }),
}));

const AUTH_HEADER = { Authorization: 'Bearer test-token' };
const T0 = Date.parse('2026-10-23T00:00:00Z');

function registry(): AgentRegistry {
  const h: { agents?: AgentRegistry } = {};
  applyAgentEvent(h, {
    kind: 'spawn',
    agentId: 'toolu_explore',
    agentType: 'Explore',
    description: 'Trace frames',
    background: true,
    ts: T0,
  });
  applyAgentEvent(h, {
    kind: 'todos',
    agentId: 'toolu_explore',
    todos: [
      { content: 'Read mapper', status: 'in_progress' },
      { content: 'Read processor', status: 'in_progress' },
    ],
    ts: T0 + 1,
  });
  applyAgentEvent(h, { kind: 'spawn', agentId: 'toolu_nested', parentAgentId: 'toolu_explore', ts: T0 + 2 });
  applyAgentEvent(h, { kind: 'returned', agentId: 'toolu_nested', ok: false, ack: false, ts: T0 + 30_000 });
  return h.agents as AgentRegistry;
}

function liveSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sid1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 't1',
    model: 'claude-opus-5-5[1m]',
    activityState: 'working',
    state: 'MAIN',
    lastActivity: new Date('2026-10-23T00:01:00Z'),
    ...overrides,
  };
}

describe('Dashboard — agent tree payload (spec 12 §3)', () => {
  let startWebServer: any;
  let stopWebServer: any;
  let injectWebServer: any;
  let dashboard: any;

  beforeEach(async () => {
    vi.resetModules();
    archives.length = 0;
    const webServer = await import('../web-server');
    startWebServer = webServer.startWebServer;
    stopWebServer = webServer.stopWebServer;
    injectWebServer = webServer.injectWebServer;
    dashboard = await import('../dashboard');
    await startWebServer({ listen: false });
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

  it('a card carries its subagents in spawn order, each with its own tasks (one current at most)', async () => {
    const card = (await board(new Map([['C1:t1', liveSession({ agents: registry() })]]))).working[0];
    expect(card.agents.map((a: any) => [a.id, a.n, a.parentId, a.type, a.status])).toEqual([
      ['toolu_explore', 1, undefined, 'Explore', 'running'],
      ['toolu_nested', 2, 'toolu_explore', undefined, 'failed'],
    ]);
    expect(card.agents[0]).toMatchObject({ description: 'Trace frames', background: true, startedAt: T0 });
    expect(card.agents[0].tasks.map((t: any) => [t.id, t.content, t.status])).toEqual([
      ['T1', 'Read mapper', 'in_progress'],
      ['T2', 'Read processor', 'pending'],
    ]);
    expect(card.agentsTotal).toBe(2);
    // The main agent's tasks are the session's own — the subagent's never appear there.
    expect(card.tasks).toBeUndefined();
  });

  it('an agent that is not running has no current task', async () => {
    const reg = registry();
    applyAgentEvent(
      { agents: reg },
      { kind: 'returned', agentId: 'toolu_explore', ok: true, ack: false, ts: T0 + 60_000 },
    );
    const card = (await board(new Map([['C1:t1', liveSession({ agents: reg })]]))).working[0];
    expect(card.agents[0].tasks.map((t: any) => t.status)).toEqual(['pending', 'pending']);
  });

  it("a card carries the main agent's own tool count as agentRoot — with or without subagents", async () => {
    const reg = registry();
    reg.root = { toolCalls: 7, lastTool: 'Edit' };
    const withSubs = (await board(new Map([['C1:t1', liveSession({ agents: reg })]]))).working[0];
    expect(withSubs.agentRoot).toEqual({ toolCalls: 7, lastTool: 'Edit' });
    const mainOnly = (
      await board(new Map([['C1:t1', liveSession({ agents: { nextN: 1, agents: [], root: { toolCalls: 2 } } })]]))
    ).working[0];
    expect(mainOnly.agentRoot).toEqual({ toolCalls: 2 });
    expect('agents' in mainOnly).toBe(false);
    const none = (await board(new Map([['C1:t1', liveSession()]]))).working[0];
    expect('agentRoot' in none).toBe(false);
  });

  it('a card without subagents carries no agents key', async () => {
    const card = (await board(new Map([['C1:t1', liveSession()]]))).working[0];
    expect('agents' in card).toBe(false);
    expect('agentsTotal' in card).toBe(false);
  });

  it('an archived card keeps its agents; one the archive saw running reads unknown', async () => {
    archives.push({
      archivedAt: T0 + 120_000,
      archiveReason: 'terminated',
      sessionKey: 'C1:t9',
      sessionId: 'sid9',
      conversationId: 'conv9',
      ownerId: 'U1',
      ownerName: 'Zhuge',
      channelId: 'C1',
      threadTs: 't9',
      title: 'Archived run',
      model: 'claude-opus-5-5[1m]',
      workflow: 'default',
      lastActivity: new Date(T0 + 110_000).toISOString(),
      finalState: 'MAIN',
      finalActivityState: 'idle',
      agents: JSON.parse(JSON.stringify(registry())),
    });
    const b = await board(new Map());
    const card = b.closed.find((c: any) => c.conversationId === 'conv9');
    expect(card.agents.map((a: any) => a.status)).toEqual(['unknown', 'failed']);
    expect(card.agents[0].tasks.map((t: any) => t.status)).toEqual(['pending', 'pending']);
  });

  // RED (SSOT T2/T3) — each subagent carries its own spend (tokens + API-equivalent
  // cost); the card's total is the task's (persisted taskUsage + the running turn),
  // not the runtime usage a restart or /new wipes; the subagents' sum rides along.
  describe('spend — per subagent and the task total', () => {
    const spend = (n: number, extra: Record<string, unknown> = {}) => ({
      inputTokens: n,
      outputTokens: 2 * n,
      cacheReadTokens: 10 * n,
      cacheCreateTokens: 0,
      costUsd: n / 1000,
      calls: 3,
      ...extra,
    });

    it('a subagent carries its own spend; the SDK context size is not passed off as tokens', async () => {
      const reg = registry();
      reg.agents[0].tokens = 134;
      reg.agents[0].spend = spend(1000, { unpricedModels: ['grok-4.7-build'] });
      const card = (await board(new Map([['C1:t1', liveSession({ agents: reg })]]))).working[0];
      expect(card.agents[0].spend).toEqual(spend(1000, { unpricedModels: ['grok-4.7-build'] }));
      expect('tokens' in card.agents[0]).toBe(false);
      expect('spend' in card.agents[1]).toBe(false);
    });

    it('the card carries the subagents’ sum — those dropped by the record cap included', async () => {
      const reg = registry();
      reg.agents[0].spend = spend(1000);
      reg.agents[1].spend = spend(500, { unpricedModels: ['gpt-6-astra'] });
      reg.prunedSpend = { ...spend(100), agents: 4 };
      const card = (await board(new Map([['C1:t1', liveSession({ agents: reg })]]))).working[0];
      expect(card.subagentSpend).toMatchObject({
        agents: 6,
        inputTokens: 1600,
        outputTokens: 3200,
        cacheReadTokens: 16_000,
        cacheCreateTokens: 0,
        unpriced: true,
      });
      expect(card.subagentSpend.costUsd).toBeCloseTo(1.6);
    });

    it('the card total is the task total plus the running turn — not the runtime usage', async () => {
      const s = liveSession({
        taskUsage: {
          inputTokens: 5000,
          outputTokens: 600,
          cacheReadTokens: 900_000,
          cacheCreateTokens: 7000,
          costUsd: 42,
        },
        usage: {
          totalInputTokens: 10,
          totalOutputTokens: 10,
          totalCacheReadTokens: 10,
          totalCacheCreateTokens: 10,
          totalCostUsd: 0.01,
          currentInputTokens: 100_000,
          currentOutputTokens: 0,
          currentCacheReadTokens: 0,
          currentCacheCreateTokens: 0,
          contextWindow: 1_000_000,
        },
        liveUsage: { 'm:x': { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreateTokens: 4 } },
      });
      const card = (await board(new Map([['C1:t1', s]]))).working[0];
      expect(card.tokenUsage).toMatchObject({
        totalInputTokens: 5001,
        totalOutputTokens: 602,
        totalCacheReadTokens: 900_003,
        totalCacheCreateTokens: 7004,
      });
      expect(card.tokenUsage.totalCostUsd).toBeGreaterThan(42);
      expect(card.tokenUsage.totalCostUsd).toBeLessThan(42.01);
      // The context gauge is still the live window's.
      expect(card.tokenUsage.contextUsagePercent).toBeCloseTo(10);
    });

    it('a partial task total says since when it counts', async () => {
      const s = liveSession({
        taskUsage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          costUsd: 0.01,
          partialSince: T0,
        },
      });
      const card = (await board(new Map([['C1:t1', s]]))).working[0];
      expect(card.tokenUsage.partialSince).toBe(T0);
    });

    it('review r1 — after /new (no SDK session yet) a task with spend stays on the board', async () => {
      const s = liveSession({
        sessionId: undefined,
        taskUsage: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.5 },
      });
      const b = await board(new Map([['C1:t1', s]]));
      const all = [...b.working, ...b.waiting, ...b.idle, ...b.closed];
      expect(all).toHaveLength(1);
      expect(all[0].tokenUsage.totalCostUsd).toBeCloseTo(0.5);
      // Without any history it is still a not-yet-started session: not shown.
      const empty = await board(new Map([['C1:t2', liveSession({ sessionId: undefined })]]));
      expect([...empty.working, ...empty.waiting, ...empty.idle, ...empty.closed]).toHaveLength(0);
    });

    it('a closed card shows the task total it archived', async () => {
      archives.push({
        archivedAt: T0 + 120_000,
        archiveReason: 'terminated',
        sessionKey: 'C1:t8',
        sessionId: 'sid8',
        conversationId: 'conv8',
        ownerId: 'U1',
        ownerName: 'Zhuge',
        channelId: 'C1',
        threadTs: 't8',
        title: 'Archived spend',
        model: 'claude-opus-5-5[1m]',
        workflow: 'default',
        lastActivity: new Date(T0 + 110_000).toISOString(),
        finalState: 'MAIN',
        finalActivityState: 'idle',
        usage: {
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheReadTokens: 1,
          totalCacheCreateTokens: 1,
          totalCostUsd: 0.001,
        },
        taskUsage: { inputTokens: 70, outputTokens: 80, cacheReadTokens: 900, cacheCreateTokens: 10, costUsd: 12.5 },
      });
      const card = (await board(new Map())).closed.find((c: any) => c.conversationId === 'conv8');
      expect(card.tokenUsage).toMatchObject({
        totalInputTokens: 70,
        totalOutputTokens: 80,
        totalCacheReadTokens: 900,
        totalCacheCreateTokens: 10,
        totalCostUsd: 12.5,
      });
    });
  });
});
