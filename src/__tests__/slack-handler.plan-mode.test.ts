/**
 * #853 — plan mode on a Slack session: the Slack path itself plans, no separate task path.
 *
 *   H1 a new task opened with the plan switch (`planModeOverride`) starts drafting, and its first
 *      turn reaches the executor with the plan-mode notice; the gate is saved.
 *   H2 the user's word while a plan waits is direct input: the gate goes back to drafting and the
 *      turn carries the revision notice.
 *   H3 a session with a started plan, or none, gets no notice.
 *   H4 a session that plans is not promoted to a goal (the goal loop would drive work the plan holds back).
 *   H5 not every message is the user's word: `/compact` (a maintenance turn) and a post-compaction
 *      replay of a host turn leave a waiting plan waiting — 시작 still finds it (review #858).
 */
import { describe, expect, it, vi } from 'vitest';
import { SlackHandler } from '../slack-handler';

function harness(fullSession: any) {
  const app = { client: {}, assistant: vi.fn() } as any;
  const claudeHandler: any = {
    getSessionByKey: vi.fn().mockReturnValue(fullSession),
    getSession: vi.fn().mockReturnValue(fullSession),
    saveSessions: vi.fn(),
    setActivityStateByKey: vi.fn(),
  };
  const handler = new SlackHandler(app, claudeHandler, {} as any);
  const h = handler as any;
  const sessionResult = {
    session: fullSession,
    sessionKey: 'C123:111.222',
    isNewSession: true,
    userName: 'Test User',
    workingDirectory: '/tmp',
    abortController: new AbortController(),
    halted: false,
  };
  h.slackApi = {
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    postSystemMessage: vi.fn().mockResolvedValue({ ts: 'notice' }),
    postMessage: vi.fn().mockResolvedValue({ ts: 'notice' }),
  };
  h.inputProcessor = {
    processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
    routeCommand: vi.fn().mockResolvedValue({ handled: false }),
  };
  h.sessionInitializer = {
    validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
    initialize: vi.fn().mockResolvedValue(sessionResult),
  };
  const seen: Array<{ notice?: string; gate: unknown }> = [];
  const execute = vi.fn().mockImplementation(async (params: any) => {
    seen.push({ notice: params.promptNotice, gate: structuredClone(fullSession.taskPlan) });
    return { success: true, messageCount: 1 };
  });
  h.streamExecutor = { execute };
  h.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };
  return { handler, claudeHandler, execute, seen };
}

const say = () => vi.fn().mockResolvedValue({ ts: 'msg' });

describe('SlackHandler — plan mode on a Slack session (#853)', () => {
  it('H1 — the plan switch starts a drafting plan; the first turn carries the plan-mode notice', async () => {
    const session: any = { ownerId: 'U123', systemPrompt: 'cached' };
    const { handler, claudeHandler, execute, seen } = harness(session);
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.222', text: '로그인 고쳐줘', planModeOverride: true } as any,
      say(),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(seen[0].gate).toMatchObject({ state: 'drafting', revision: 0 });
    expect(seen[0].notice).toMatch(/<task-plan-mode state="drafting" revision="0">/);
    expect(execute.mock.calls[0][0].text).toBe('로그인 고쳐줘');
    expect(claudeHandler.saveSessions).toHaveBeenCalled();
  });

  it('H2 — a word while a plan waits revises it: drafting again, the direct-input notice', async () => {
    const session: any = {
      ownerId: 'U123',
      systemPrompt: 'cached',
      sessionId: 'sdk',
      taskPlan: { state: 'awaiting', revision: 2, updatedAt: 1, plan: { summary: 's' } },
    };
    const { handler, seen } = harness(session);
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.333', thread_ts: '111.222', text: '2단계 빼' } as any,
      say(),
    );
    expect(seen[0].gate).toMatchObject({ state: 'drafting', revision: 2 });
    expect(seen[0].notice).toMatch(/유저가 계획 v2에 대해 직접 입력했다/);
  });

  it('H5 — `/compact` and a host turn’s replay leave a waiting plan waiting', async () => {
    const waiting = () => ({
      ownerId: 'U123',
      systemPrompt: 'cached',
      sessionId: 'sdk',
      taskPlan: { state: 'awaiting', revision: 2, updatedAt: 1, plan: { summary: 's' } },
    });
    const compacting: any = waiting();
    const a = harness(compacting);
    await a.handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.333', thread_ts: '111.222', text: '/compact' } as any,
      say(),
    );
    expect(compacting.taskPlan).toMatchObject({ state: 'awaiting', revision: 2 });
    const replaying: any = waiting();
    const b = harness(replaying);
    await b.handler.handleMessage(
      {
        user: 'U123',
        channel: 'C123',
        ts: '111.444',
        thread_ts: '111.222',
        text: '계속',
        routeContext: { hostTurn: true },
      } as any,
      say(),
    );
    expect(replaying.taskPlan).toMatchObject({ state: 'awaiting', revision: 2 });
    expect(b.seen[0].notice).not.toMatch(/직접 입력했다/);
  });

  it('H3 — a started plan, or no plan mode: no notice', async () => {
    const started: any = {
      ownerId: 'U123',
      systemPrompt: 'cached',
      taskPlan: { state: 'approved', revision: 2, updatedAt: 1 },
    };
    const a = harness(started);
    await a.handler.handleMessage({ user: 'U123', channel: 'C123', ts: '111.222', text: 'go' } as any, say());
    expect(a.seen[0].notice).toBeUndefined();
    // A started plan stays started: the user's word never takes it back to drafting.
    expect(started.taskPlan).toMatchObject({ state: 'approved', revision: 2 });
    const plain = harness({ ownerId: 'U123', systemPrompt: 'cached' });
    await plain.handler.handleMessage({ user: 'U123', channel: 'C123', ts: '111.222', text: 'go' } as any, say());
    expect(plain.seen[0].notice).toBeUndefined();
  });

  it('H4 — a planning session is not promoted to a goal, even with autogoal on', async () => {
    const session: any = { ownerId: 'U123', systemPrompt: 'cached' };
    const { handler } = harness(session);
    await handler.handleMessage(
      {
        user: 'U123',
        channel: 'C123',
        ts: '111.222',
        text: '로그인 고쳐줘',
        planModeOverride: true,
        autoGoalOverride: true,
      } as any,
      say(),
    );
    expect(session.goal).toBeUndefined();
  });
});
