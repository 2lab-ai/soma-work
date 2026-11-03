/**
 * SSOT 2026-11-03 — the goal loop on a Slack-less dashboard task. A task has
 * no thread: nothing is posted to Slack (no `postNotice` call, no stall form);
 * every notice lands in the task's work log (the dashboard shows it); the
 * continuation is handed to the injector with the session it is for — a task's
 * event carries no channel to find it by.
 */

import { setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';
import type { WorkLogInput } from '@soma/slack/work-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyntheticMessageEvent } from '../../cron-scheduler';
import type { ConversationSession, SessionGoal } from '../../types';
import type { GoalEvalVerdict } from '../goal-completion-evaluator';
import { GoalLoopController, type GoalLoopControllerDeps } from '../goal-loop-controller';

const KEY = 'task:11111111-2222-4333-8444-555555555555';
const NOT_YET: GoalEvalVerdict = { completed: false, reason: 'missing tests', remaining: ['add tests'] };
const DONE: GoalEvalVerdict = { completed: true, reason: 'all done', remaining: [] };

function goal(over: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'g1',
    objective: 'ship it',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'UOWNER',
    continuationCount: 0,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 0,
    ...over,
  };
}

const recorded: Array<[string, WorkLogInput]> = [];

function harness(opts: {
  dispatcher?: GoalLoopControllerDeps['dispatcher'];
  verdict?: GoalEvalVerdict;
  goal?: Partial<SessionGoal>;
}) {
  const g = goal(opts.goal);
  const session = {
    slackless: true,
    channelId: '',
    ownerId: 'UOWNER',
    conversationId: 'conv-task',
    model: 'claude-opus-4',
    goal: g,
    goalLastTurnText: 'shipped PR #1',
  } as unknown as ConversationSession;
  const posted: string[] = [];
  const injected: Array<{ event: SyntheticMessageEvent; sessionKey: string }> = [];
  const askStallQuestion = vi.fn(async () => undefined);
  const deps: GoalLoopControllerDeps = {
    registry: { getSessionByKey: () => session, getActivityStateByKey: () => 'idle', saveSessions: vi.fn() },
    requestCoordinator: { isRequestActive: () => false },
    dispatcher: opts.dispatcher ?? (async () => JSON.stringify(opts.verdict ?? NOT_YET)),
    injectContinuation: async (event, target) => {
      injected.push({ event, sessionKey: target.sessionKey });
    },
    postNotice: async (_c, _t, text) => {
      posted.push(text);
      return undefined;
    },
    askStallQuestion,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: 'claude-sonnet-4',
    scheduleEvalRetry: () => undefined,
  };
  return { controller: new GoalLoopController(deps), session, goal: g, posted, injected, askStallQuestion };
}

async function settle(h: ReturnType<typeof harness>) {
  h.controller.onTurnSettled(KEY);
  await h.controller.settled(KEY);
}

const notices = () => recorded.filter(([id]) => id === 'conv-task').map(([, e]) => e.text);

describe('GoalLoopController — a dashboard task', () => {
  beforeEach(() => {
    recorded.length = 0;
    setStreamExecutorProviders({
      appendWorkLog: (conversationId, entry) => {
        recorded.push([conversationId, entry]);
      },
    });
  });
  afterEach(() => {
    setStreamExecutorProviders({ appendWorkLog: () => {} });
  });

  it('not yet complete: the next turn is handed over with its session key; nothing goes to Slack', async () => {
    const h = harness({ verdict: NOT_YET });
    await settle(h);
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0].sessionKey).toBe(KEY);
    expect(h.injected[0].event.text).toMatch(/^\[goal-continuation\]/);
    expect(h.posted).toEqual([]);
    expect(notices().some((t) => t.includes('🔄 Goal not yet complete'))).toBe(true);
  });

  it('complete: the ✅ result is in the work log, not posted', async () => {
    const h = harness({ verdict: DONE });
    await settle(h);
    expect(h.goal.status).toBe('complete');
    expect(h.posted).toEqual([]);
    expect(notices().some((t) => t.includes('✅ Goal completed'))).toBe(true);
    expect(h.injected).toHaveLength(0);
  });

  it('an eval that fails for good is reported in the work log, not posted', async () => {
    const h = harness({
      dispatcher: async () => {
        throw new Error('model said no');
      },
      goal: { evalDispatchRetryCount: 99 },
    });
    await settle(h);
    expect(h.posted).toEqual([]);
    expect(notices().some((t) => /Goal completion evaluation/.test(t))).toBe(true);
  });

  it('a stall is announced in the work log; no Slack form is asked', async () => {
    const h = harness({
      verdict: {
        completed: false,
        reason: 'missing tests',
        remaining: ['add tests'],
        sameAsPrevious: true,
        sameConfidence: 0.95,
        progressed: false,
        userActions: ['add the tests', 'skip tests', 'stop'],
      },
      goal: { lastEvalReason: 'missing tests' },
    });
    await settle(h);
    expect(h.goal.stall).toBeDefined();
    expect(h.posted).toEqual([]);
    expect(h.askStallQuestion).not.toHaveBeenCalled();
    expect(notices().some((t) => t.includes('🛑'))).toBe(true);
    expect(h.injected).toHaveLength(0);
  });

  it('a failed injection is reported in the work log with the task’s way to resume', async () => {
    const h = harness({ verdict: NOT_YET });
    (h.controller as unknown as { deps: GoalLoopControllerDeps }).deps.injectContinuation = async () => {
      throw new Error('one dashboard task runs at a time');
    };
    await settle(h);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.posted).toEqual([]);
    const failure = notices().find((t) => t.includes('Goal continuation failed to start'));
    expect(failure).toMatch(/send the task an instruction/);
  });
});
