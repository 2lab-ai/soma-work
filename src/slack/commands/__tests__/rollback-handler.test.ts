/**
 * `rollback` thread command (#743) — roll the model's context back to just
 * before one of the owner's inputs.
 */

import { encodeContextAnchor } from '@soma/slack/context-anchor';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const turns: any[] = [];
vi.mock('../../../conversation/recorder', () => ({
  getConversation: vi.fn(async () => ({ turns })),
}));
vi.mock('../../../session/context-rollback', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../session/context-rollback')>();
  return {
    ...real,
    // The transcript probe reads the SDK's .jsonl; the unit has none.
    requestContextRollback: (s: any, t: any, a: any, d: any) =>
      real.requestContextRollback(s, t, a, { ...d, transcriptHas: () => true }),
  };
});

import { RollbackHandler } from '../rollback-handler';
import type { CommandContext, CommandDependencies } from '../types';

const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const A = (n: number) =>
  encodeContextAnchor({ sid: SID, epoch: 0, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });

describe('RollbackHandler', () => {
  let posted: string[];
  let session: any;
  let active: boolean;
  let handler: RollbackHandler;
  let saves: number;

  beforeEach(() => {
    posted = [];
    saves = 0;
    active = false;
    turns.length = 0;
    turns.push(
      { id: 't0', role: 'user', timestamp: 1, rawContent: '처음 지시' },
      { id: 'r0', role: 'assistant', timestamp: 2, rawContent: 'ok' },
      { id: 't1', role: 'user', timestamp: 3, rawContent: '배포해줘\n상세', anchor: A(1), origin: { by: 'user' } },
      {
        id: 'g1',
        role: 'user',
        timestamp: 4,
        rawContent: '[goal-continuation] …',
        anchor: A(2),
        origin: { by: 'system' },
      },
      { id: 't2', role: 'user', timestamp: 5, rawContent: '테스트 다시', anchor: A(3), origin: { by: 'user' } },
    );
    session = { ownerId: 'U1', sessionId: SID, compactionCount: 0, contextAnchor: A(9), conversationId: 'conv-1' };
    const deps = {
      slackApi: { postSystemMessage: vi.fn(async (_c: string, text: string) => posted.push(text)) },
      claudeHandler: {
        getSession: () => session,
        getSessionKey: () => 'C1:T1',
        saveSessions: () => {
          saves += 1;
        },
      },
      requestCoordinator: { isRequestActive: () => active },
    } as unknown as CommandDependencies;
    handler = new RollbackHandler(deps);
  });

  const ctx = (text: string, user = 'U1'): CommandContext => ({
    user,
    channel: 'C1',
    threadTs: 'T1',
    text,
    say: vi.fn(),
  });

  it('matches only the strict forms', () => {
    for (const t of [
      'rollback',
      '/rollback',
      'rollback 2',
      'rollback cancel',
      '롤백',
      '롤백 1',
      '롤백 취소',
      'rollback goal',
    ]) {
      expect(handler.canHandle(t)).toBe(true);
    }
    for (const t of ['rollback the migration', 'rollback 2 3', 'rollbacks', 'please rollback']) {
      expect(handler.canHandle(t)).toBe(false);
    }
  });

  it('lists the owner’s inputs with an anchor, numbered', async () => {
    await handler.execute(ctx('rollback'));
    expect(posted[0]).toContain('1. 배포해줘');
    expect(posted[0]).toContain('2. 테스트 다시');
    expect(posted[0]).not.toContain('goal-continuation');
    expect(posted[0]).not.toContain('처음 지시');
  });

  it('rollback <n> stores the request for the next turn and says what leaves the context', async () => {
    await handler.execute(ctx('rollback 1'));
    expect(session.pendingRewind).toMatchObject({ anchor: A(1), source: 'input', requestedBy: 'U1' });
    expect(saves).toBe(1);
    expect(posted[0]).toContain('배포해줘');
    expect(posted[0]).toContain('이후 입력 2개');
  });

  it('refuses while a turn runs', async () => {
    active = true;
    await handler.execute(ctx('rollback 1'));
    expect(session.pendingRewind).toBeUndefined();
    expect(posted[0]).toContain('진행 중');
  });

  it('refuses a non-owner', async () => {
    await handler.execute(ctx('rollback 1', 'U2'));
    expect(session.pendingRewind).toBeUndefined();
    expect(posted[0]).toContain('세션 주인');
  });

  it('cancel drops the waiting rollback', async () => {
    await handler.execute(ctx('rollback 2'));
    await handler.execute(ctx('rollback cancel'));
    expect(session.pendingRewind).toBeUndefined();
    expect(posted[1]).toContain('취소');
  });

  it('an unknown number points back to the list', async () => {
    await handler.execute(ctx('rollback 7'));
    expect(posted[0]).toContain('7번 입력이 없습니다');
  });

  it('rollback goal rolls back to where the stalled goal first failed (#745) — only when offered', async () => {
    await handler.execute(ctx('rollback goal'));
    expect(session.pendingRewind).toBeUndefined();
    expect(posted[0]).toContain('되돌릴 goal 실패 지점이 없습니다');
    session.goal = {
      goalId: 'g1',
      status: 'active',
      stall: { stallId: 's1', stalledAt: 1, reason: 'r', actions: ['a'], confidence: 0.99, rollbackAnchor: A(2) },
    };
    await handler.execute(ctx('rollback goal'));
    expect(session.pendingRewind).toMatchObject({ anchor: A(2), source: 'goal', requestedBy: 'U1' });
    expect(posted[1]).toContain('처음 실패한 지점');
    active = true;
    session.pendingRewind = undefined;
    await handler.execute(ctx('rollback goal'));
    expect(session.pendingRewind).toBeUndefined();
    expect(posted[2]).toContain('진행 중');
  });
});
