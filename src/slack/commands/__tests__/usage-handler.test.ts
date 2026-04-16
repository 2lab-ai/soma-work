import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext, CommandDependencies } from '../types';
import { UsageHandler } from '../usage-handler';

/**
 * UsageHandler P0 regression tests.
 *
 * Covers the two privacy/correctness blockers from PR #502 review:
 * - `/usage @other_user` must be rejected (privacy leak)
 * - date ranges must be computed in Asia/Seoul (not UTC)
 */

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_ALICE',
    channel: 'C_TEST',
    threadTs: '1.1',
    text: 'usage',
    say: vi.fn(),
    ...overrides,
  };
}

function makeDeps(): { deps: CommandDependencies; postSystemMessage: ReturnType<typeof vi.fn> } {
  const postSystemMessage = vi.fn().mockResolvedValue({});
  const deps = {
    slackApi: { postSystemMessage },
  } as unknown as CommandDependencies;
  return { deps, postSystemMessage };
}

describe('UsageHandler — privacy gate', () => {
  it('rejects `/usage @other_user` with a clear Korean error message', async () => {
    const { deps, postSystemMessage } = makeDeps();
    const handler = new UsageHandler(deps);
    const result = await handler.execute(makeCtx({ user: 'U_ALICE', text: 'usage <@U_BOB>' }));

    expect(result.handled).toBe(true);
    expect(postSystemMessage).toHaveBeenCalledTimes(1);
    const [, message] = postSystemMessage.mock.calls[0];
    expect(message).toMatch(/다른 사용자의 토큰 사용량은 조회할 수 없습니다/);
  });

  it('allows `/usage @self` (same user filtering own data)', async () => {
    const { deps, postSystemMessage } = makeDeps();
    const handler = new UsageHandler(deps);
    // No store wiring — handler will construct its own. We only check that
    // the privacy gate does NOT fire for the same user. If it reached the
    // report path it will either succeed or blow up on filesystem access;
    // we only care that the gate didn't short-circuit with the reject msg.
    try {
      await handler.execute(makeCtx({ user: 'U_ALICE', text: 'usage <@U_ALICE>' }));
    } catch {
      // ignore report-generation errors — out of scope
    }
    const calls = postSystemMessage.mock.calls;
    for (const [, message] of calls) {
      expect(message).not.toMatch(/다른 사용자의 토큰 사용량은 조회할 수 없습니다/);
    }
  });

  it('allows `/usage` with no @mention (no privacy concern)', async () => {
    const { deps, postSystemMessage } = makeDeps();
    const handler = new UsageHandler(deps);
    try {
      await handler.execute(makeCtx({ user: 'U_ALICE', text: 'usage' }));
    } catch {
      // ignore report-generation errors — out of scope
    }
    const calls = postSystemMessage.mock.calls;
    for (const [, message] of calls) {
      expect(message).not.toMatch(/다른 사용자의 토큰 사용량은 조회할 수 없습니다/);
    }
  });
});

describe('UsageHandler — Asia/Seoul date range', () => {
  // Access private method via cast — narrow scope to keep the test surgical.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getRange = (h: UsageHandler, now: Date, period: 'today' | 'week' | 'month') =>
    (h as any).getDateRange(now, period) as { startDate: string; endDate: string };

  let handler: UsageHandler;
  beforeEach(() => {
    const { deps } = makeDeps();
    handler = new UsageHandler(deps);
  });

  it('uses Asia/Seoul date at 00:30 KST (15:30 UTC prev day) — prevents UTC/KST off-by-one', () => {
    // 2026-04-16 00:30 KST === 2026-04-15 15:30 UTC.
    // Naïve UTC slice would report 2026-04-15; correct KST formatting → 2026-04-16.
    const now = new Date('2026-04-15T15:30:00Z');
    const { startDate, endDate } = getRange(handler, now, 'today');
    expect(endDate).toBe('2026-04-16');
    expect(startDate).toBe('2026-04-16');
  });

  it('week period = today − 6 days (rolling 7-day window) in KST', () => {
    const now = new Date('2026-04-16T03:00:00Z'); // 12:00 KST
    const { startDate, endDate } = getRange(handler, now, 'week');
    expect(endDate).toBe('2026-04-16');
    expect(startDate).toBe('2026-04-10');
  });

  it('month period = today − 29 days (rolling 30-day window) in KST', () => {
    const now = new Date('2026-04-16T03:00:00Z');
    const { startDate, endDate } = getRange(handler, now, 'month');
    expect(endDate).toBe('2026-04-16');
    expect(startDate).toBe('2026-03-18');
  });

  it('day transition at midnight KST: 14:59 UTC vs 15:00 UTC on the same calendar UTC day', () => {
    // 2026-04-15 14:59 UTC === 2026-04-15 23:59 KST → endDate 2026-04-15
    const before = new Date('2026-04-15T14:59:00Z');
    expect(getRange(handler, before, 'today').endDate).toBe('2026-04-15');
    // 2026-04-15 15:00 UTC === 2026-04-16 00:00 KST → endDate 2026-04-16
    const after = new Date('2026-04-15T15:00:00Z');
    expect(getRange(handler, after, 'today').endDate).toBe('2026-04-16');
  });
});
