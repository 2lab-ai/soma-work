import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──

const mockConfig = {
  conversation: {
    viewerToken: 'shared-token',
    instanceName: 'self-instance',
  },
};

vi.mock('../../config', () => ({ config: mockConfig }));

const mockReadAllInstances = vi.fn();

vi.mock('../instance-registry', () => ({
  readAllInstances: () => mockReadAllInstances(),
}));

// ── Module under test ──

let aggregator: typeof import('../aggregator');

beforeEach(async () => {
  vi.resetModules();
  mockConfig.conversation.viewerToken = 'shared-token';
  mockConfig.conversation.instanceName = 'self-instance';
  mockReadAllInstances.mockReset();
  aggregator = await import('../aggregator');
  // Reset the one-shot warn flag between tests so each case gets a fresh
  // observation of "would this warn?" behaviour.
  if (typeof (aggregator as any).__resetWarnFlagForTests === 'function') {
    (aggregator as any).__resetWarnFlagForTests();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: create a fetch stub that responds per-URL
function makeFetchStub(handlers: Record<string, () => Promise<Response> | Response>) {
  return vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return handler();
      }
    }
    throw new Error('No handler for URL: ' + url);
  });
}

// ── Tests ──

describe('aggregator: shouldAggregate', () => {
  it('returns false when selfOnly query flag is set', () => {
    expect(aggregator.shouldAggregate({ selfOnly: true, viewerToken: 't', siblingCount: 1 })).toBe(false);
  });

  it('returns false when no siblings are present', () => {
    expect(aggregator.shouldAggregate({ selfOnly: false, viewerToken: 't', siblingCount: 0 })).toBe(false);
  });

  it('returns false when viewerToken is unset (no shared auth)', () => {
    expect(aggregator.shouldAggregate({ selfOnly: false, viewerToken: '', siblingCount: 1 })).toBe(false);
  });

  it('returns true when sibling exists, viewerToken is set, and selfOnly is off', () => {
    expect(aggregator.shouldAggregate({ selfOnly: false, viewerToken: 't', siblingCount: 1 })).toBe(true);
  });
});

describe('aggregator: fetchSiblingBoards — self exclusion', () => {
  it('excludes the entry whose port matches self', async () => {
    mockReadAllInstances.mockResolvedValue([
      { port: 33000, instanceName: 'self', host: '127.0.0.1', pid: 999, lastSeen: Date.now() },
      { port: 33001, instanceName: 'mac-mini-dev', host: '127.0.0.1', pid: 1001, lastSeen: Date.now() },
    ]);

    const fetchStub = makeFetchStub({
      ':33001': () =>
        new Response(JSON.stringify({ board: { working: [], waiting: [], idle: [], closed: [] } }), { status: 200 }),
    });

    const result = await aggregator.fetchSiblingBoards({
      selfPort: 33000,
      selfPid: 999,
      viewerToken: 'shared-token',
      fetchImpl: fetchStub as any,
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(expect.stringContaining(':33001'), expect.any(Object));
    expect(result).toHaveLength(1);
  });

  it('excludes the entry whose pid matches self even on a different port', async () => {
    // Defensive case: the heartbeat for our previous port is still on disk
    // because shutdown didn't run — the port was reused for another sibling
    // process, but our pid still appears. We must not call ourselves.
    mockReadAllInstances.mockResolvedValue([
      { port: 33000, instanceName: 'self', host: '127.0.0.1', pid: 999, lastSeen: Date.now() },
      { port: 33002, instanceName: 'leftover-self', host: '127.0.0.1', pid: 999, lastSeen: Date.now() },
      { port: 33001, instanceName: 'mac-mini-dev', host: '127.0.0.1', pid: 1001, lastSeen: Date.now() },
    ]);

    const fetchStub = makeFetchStub({
      ':33001': () =>
        new Response(JSON.stringify({ board: { working: [], waiting: [], idle: [], closed: [] } }), { status: 200 }),
    });

    await aggregator.fetchSiblingBoards({
      selfPort: 33000,
      selfPid: 999,
      viewerToken: 'shared-token',
      fetchImpl: fetchStub as any,
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(expect.stringContaining(':33001'), expect.any(Object));
  });
});

describe('aggregator: fetchSiblingBoards — selfOnly enforcement (fan-out prevention)', () => {
  it('always appends ?selfOnly=true to sibling URLs to prevent recursive fan-out', async () => {
    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'sib', host: '127.0.0.1', pid: 1001, lastSeen: Date.now() },
    ]);

    const fetchStub = makeFetchStub({
      ':33001': () =>
        new Response(JSON.stringify({ board: { working: [], waiting: [], idle: [], closed: [] } }), { status: 200 }),
    });

    await aggregator.fetchSiblingBoards({
      selfPort: 33000,
      selfPid: 999,
      viewerToken: 'shared-token',
      fetchImpl: fetchStub as any,
    });

    const call = fetchStub.mock.calls[0];
    const calledUrl: string = call[0];
    expect(calledUrl).toMatch(/[?&]selfOnly=true(?:&|$)/);
  });

  it('passes the viewerToken via Authorization: Bearer', async () => {
    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'sib', host: '127.0.0.1', pid: 1001, lastSeen: Date.now() },
    ]);

    const fetchStub = makeFetchStub({
      ':33001': () =>
        new Response(JSON.stringify({ board: { working: [], waiting: [], idle: [], closed: [] } }), { status: 200 }),
    });

    await aggregator.fetchSiblingBoards({
      selfPort: 33000,
      selfPid: 999,
      viewerToken: 'shared-token',
      fetchImpl: fetchStub as any,
    });

    const call = fetchStub.mock.calls[0] as any[];
    const init = (call[1] || {}) as any;
    const headers = init.headers || {};
    const authHeader = headers.Authorization || headers.authorization;
    expect(authHeader).toBe('Bearer shared-token');
  });
});

describe('aggregator: fetchSiblingBoards — failure modes', () => {
  it('skips siblings that return non-200 (silently)', async () => {
    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'good', host: '127.0.0.1', pid: 1, lastSeen: Date.now() },
      { port: 33002, instanceName: 'bad', host: '127.0.0.1', pid: 2, lastSeen: Date.now() },
    ]);

    const fetchStub = makeFetchStub({
      ':33001': () =>
        new Response(JSON.stringify({ board: { working: [{ key: 'k1' }], waiting: [], idle: [], closed: [] } }), {
          status: 200,
        }),
      ':33002': () => new Response('boom', { status: 500 }),
    });

    const result = await aggregator.fetchSiblingBoards({
      selfPort: 33000,
      selfPid: 999,
      viewerToken: 'shared-token',
      fetchImpl: fetchStub as any,
    });

    expect(result).toHaveLength(1);
    expect(result[0].instanceName).toBe('good');
  });

  it('skips siblings whose fetch rejects (timeout / network error)', async () => {
    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'good', host: '127.0.0.1', pid: 1, lastSeen: Date.now() },
      { port: 33002, instanceName: 'dead', host: '127.0.0.1', pid: 2, lastSeen: Date.now() },
    ]);

    const fetchStub = makeFetchStub({
      ':33001': () =>
        new Response(JSON.stringify({ board: { working: [], waiting: [], idle: [], closed: [] } }), { status: 200 }),
      ':33002': () => Promise.reject(new Error('ECONNREFUSED')),
    });

    const result = await aggregator.fetchSiblingBoards({
      selfPort: 33000,
      selfPid: 999,
      viewerToken: 'shared-token',
      fetchImpl: fetchStub as any,
    });

    expect(result).toHaveLength(1);
    expect(result[0].instanceName).toBe('good');
  });

  it('skips siblings whose body fails JSON parse', async () => {
    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'malformed', host: '127.0.0.1', pid: 1, lastSeen: Date.now() },
    ]);

    const fetchStub = makeFetchStub({
      ':33001': () => new Response('not-json', { status: 200 }),
    });

    const result = await aggregator.fetchSiblingBoards({
      selfPort: 33000,
      selfPid: 999,
      viewerToken: 'shared-token',
      fetchImpl: fetchStub as any,
    });

    expect(result).toEqual([]);
  });
});

describe('aggregator: fetchSiblingBoards — empty / disabled cases', () => {
  it('returns [] without any fetch when there are no siblings to call', async () => {
    mockReadAllInstances.mockResolvedValue([
      { port: 33000, instanceName: 'self', host: '127.0.0.1', pid: 999, lastSeen: Date.now() },
    ]);

    const fetchStub = vi.fn();

    const result = await aggregator.fetchSiblingBoards({
      selfPort: 33000,
      selfPid: 999,
      viewerToken: 'shared-token',
      fetchImpl: fetchStub as any,
    });

    expect(fetchStub).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('returns [] without fetching when viewerToken is empty (graceful fallback)', async () => {
    mockReadAllInstances.mockResolvedValue([
      { port: 33001, instanceName: 'sib', host: '127.0.0.1', pid: 1, lastSeen: Date.now() },
    ]);

    const fetchStub = vi.fn();

    const result = await aggregator.fetchSiblingBoards({
      selfPort: 33000,
      selfPid: 999,
      viewerToken: '',
      fetchImpl: fetchStub as any,
    });

    expect(fetchStub).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('aggregator: mergeBoards', () => {
  it('preserves self board first, then concatenates each sibling column', () => {
    const self = {
      board: {
        working: [{ key: 'a' }],
        waiting: [],
        idle: [],
        closed: [],
      },
    };
    const siblingBoards = [
      {
        instanceName: 's1',
        port: 33001,
        host: '127.0.0.1',
        board: { working: [{ key: 'b' }], waiting: [{ key: 'c' }], idle: [], closed: [] },
      },
    ];
    const merged = aggregator.mergeBoards({
      selfBoard: self.board,
      selfEnv: { instanceName: 'self', port: 33000, host: '127.0.0.1' },
      siblings: siblingBoards as any,
    });
    expect(merged.working.map((s: any) => s.key)).toEqual(['a', 's1::b']);
    expect(merged.waiting.map((s: any) => s.key)).toEqual(['s1::c']);
  });

  it('stamps environment metadata on sibling sessions during merge', () => {
    const self = {
      board: { working: [], waiting: [], idle: [], closed: [] },
    };
    const siblingBoards = [
      {
        instanceName: 'mac-mini-dev',
        port: 33001,
        host: 'mac-mini.local',
        board: {
          working: [{ key: 'orig-key', title: 't' }],
          waiting: [],
          idle: [],
          closed: [],
        },
      },
    ];

    const merged = aggregator.mergeBoards({
      selfBoard: self.board,
      selfEnv: { instanceName: 'self', port: 33000, host: '127.0.0.1' },
      siblings: siblingBoards as any,
    });

    const card = merged.working[0] as any;
    expect(card.environment).toEqual({
      instanceName: 'mac-mini-dev',
      port: 33001,
      host: 'mac-mini.local',
    });
  });

  it('uses composite key for sibling sessions (instance::originalKey) so collisions are impossible', () => {
    const self = {
      board: { working: [{ key: 'self::C1:t1' }], waiting: [], idle: [], closed: [] },
    };
    const siblings = [
      {
        instanceName: 'mac-mini-dev',
        port: 33001,
        host: '127.0.0.1',
        board: {
          working: [{ key: 'C1:t1' }], // raw key from sibling, same channel:thread coincidentally
          waiting: [],
          idle: [],
          closed: [],
        },
      },
    ];

    const merged = aggregator.mergeBoards({
      selfBoard: self.board,
      selfEnv: { instanceName: 'self', port: 33000, host: '127.0.0.1' },
      siblings: siblings as any,
    });

    const keys = merged.working.map((s: any) => s.key);
    expect(keys).toContain('self::C1:t1');
    expect(keys).toContain('mac-mini-dev::C1:t1');
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
  });
});
