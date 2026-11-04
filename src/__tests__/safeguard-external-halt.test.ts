/**
 * ssot-task: T2/T3/T4 — a safeguards block seen outside the turn's own stream
 * (the permission guardian, an incident attempt's screener) halts the session
 * the same way: locked and saved first, the running turn stopped, one
 * "세이프가드 에러" notice with the admin button (review R5, astra P1).
 */
import { SAFEGUARD_ADMIN_RETRY_ACTION } from '@soma/slack/safeguard';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeHandler } from '../claude-handler';
import type { McpManager } from '../mcp-manager';
import { haltSessionOnSafeguardFlag } from '../safeguard-external-halt';

const KEY = 'work:C905:1700000000.0905';
const FLAG = { model: 'Opus 5.5 (1M context)', detail: 'reasoning_extraction', requestId: 'req_1' };

function harness(opts: { session?: Record<string, unknown> | null; active?: boolean; saveThrows?: boolean } = {}) {
  const session =
    opts.session === null ? undefined : (opts.session ?? { channelId: 'C905', threadTs: '1700000000.0905' });
  const order: string[] = [];
  const deps = {
    getSessionByKey: vi.fn(() => session as any),
    saveSessions: vi.fn(() => {
      order.push('save');
      if (opts.saveThrows) throw new Error('disk full');
    }),
    broadcastSessionUpdate: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => 5_000,
    ports: {
      isRequestActive: vi.fn(() => opts.active ?? false),
      abortSession: vi.fn(() => {
        order.push('abort');
        return true;
      }),
      postNotice: vi.fn(async () => {
        order.push('notice');
        return undefined;
      }),
    },
  };
  return { session, deps, order };
}

describe('haltSessionOnSafeguardFlag', () => {
  it('locks and saves the session, stops the running turn, then posts one notice with the admin button', async () => {
    const h = harness({ active: true });
    const halt = haltSessionOnSafeguardFlag(h.deps, KEY, FLAG, { source: 'guardian', stopRunningTurn: true });
    await Promise.resolve();
    expect(halt).toEqual({ atMs: 5_000, ...FLAG });
    expect((h.session as any).safeguardHalt).toEqual(halt);
    expect(h.order).toEqual(['save', 'abort', 'notice']);
    expect(h.deps.ports.abortSession).toHaveBeenCalledWith(KEY, 'safeguard');
    const [channel, threadTs, text, blocks] = h.deps.ports.postNotice.mock.calls[0] as unknown as [
      string,
      string,
      string,
      unknown[],
    ];
    expect(channel).toBe('C905');
    expect(threadTs).toBe('1700000000.0905');
    expect(text).toContain('세이프가드 에러');
    expect(JSON.stringify(blocks)).toContain(SAFEGUARD_ADMIN_RETRY_ACTION);
  });

  it('leaves a finished attempt alone when asked not to stop the turn', () => {
    const h = harness({ active: true });
    haltSessionOnSafeguardFlag(h.deps, KEY, FLAG, { source: 'incident', stopRunningTurn: false });
    expect((h.session as any).safeguardHalt).toBeDefined();
    expect(h.deps.ports.abortSession).not.toHaveBeenCalled();
  });

  it('keeps the lock in memory when the save fails (fail closed)', () => {
    const h = harness({ saveThrows: true });
    expect(() =>
      haltSessionOnSafeguardFlag(h.deps, KEY, FLAG, { source: 'guardian', stopRunningTurn: true }),
    ).not.toThrow();
    expect((h.session as any).safeguardHalt).toBeDefined();
  });

  it('an already-halted session keeps its halt and gets no second notice, but the turn still stops', () => {
    const first = { atMs: 1, detail: 'x' };
    const h = harness({
      session: { channelId: 'C905', threadTs: '1700000000.0905', safeguardHalt: first },
      active: true,
    });
    haltSessionOnSafeguardFlag(h.deps, KEY, FLAG, { source: 'guardian', stopRunningTurn: true });
    expect((h.session as any).safeguardHalt).toBe(first);
    expect(h.deps.ports.postNotice).not.toHaveBeenCalled();
    expect(h.deps.ports.abortSession).toHaveBeenCalledWith(KEY, 'safeguard');
  });

  it('a session that is gone is logged, never thrown', () => {
    const h = harness({ session: null });
    expect(
      haltSessionOnSafeguardFlag(h.deps, KEY, FLAG, { source: 'guardian', stopRunningTurn: true }),
    ).toBeUndefined();
    expect(h.deps.logger.error).toHaveBeenCalled();
  });
});

describe('ClaudeHandler — safeguard halt wiring', () => {
  it("the permission advisor's blocked guardian halts the session through the handler's ports", async () => {
    const handler = new ClaudeHandler({ getPluginManager: () => null } as unknown as McpManager);
    const session: Record<string, unknown> = { channelId: 'C905', threadTs: '1700000000.0905' };
    const registry = (handler as unknown as { sessionRegistry: Record<string, unknown> }).sessionRegistry;
    registry.getSessionByKey = vi.fn(() => session);
    registry.saveSessions = vi.fn();
    const ports = {
      isRequestActive: vi.fn(() => true),
      abortSession: vi.fn(() => true),
      postNotice: vi.fn(async () => undefined),
    };
    handler.setSafeguardHaltPorts(ports);
    (handler as unknown as { safetyClassifierCache: unknown }).safetyClassifierCache = {
      classify: vi.fn(async () => ({ verdict: 'ask', reason: 'blocked', safeguardFlag: FLAG })),
    };
    const advisor = (
      handler as unknown as { mcpConfigBuilder: { permissionAdvisor?: (r: unknown) => Promise<unknown> } }
    ).mcpConfigBuilder.permissionAdvisor;
    await expect(
      advisor?.({ scope: KEY, user: 'U1', toolName: 'Bash', input: { command: 'rm -rf /x' }, ruleIds: [] }),
    ).resolves.toBeNull();
    expect(session.safeguardHalt).toMatchObject(FLAG);
    expect(ports.abortSession).toHaveBeenCalledWith(KEY, 'safeguard');
    expect(ports.postNotice).toHaveBeenCalled();
  });
});

describe('haltSafeguardOnFlag — a session closed while the guardian ran (review round 6)', () => {
  it('tombstones the thread through the registry and saves', () => {
    const h = harness({ session: null });
    const haltSafeguardByKey = vi.fn(() => 'tombstone');
    const halt = haltSessionOnSafeguardFlag({ ...h.deps, haltSafeguardByKey }, KEY, FLAG, {
      source: 'guardian',
      stopRunningTurn: true,
    });
    expect(halt).toMatchObject(FLAG);
    expect(haltSafeguardByKey).toHaveBeenCalledWith(KEY, expect.objectContaining(FLAG));
    expect(h.deps.saveSessions).toHaveBeenCalled();
  });
});
