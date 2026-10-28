/**
 * Spec 10 §3.2-5 — at `minimal` only the header, task list, final answer,
 * choice/approval and errors stay in Slack. The goal loop's progress notices
 * (🔄 not yet complete, ▶️ next queued goal) need `STATUS_MESSAGE` (compact and
 * above); the notices that carry the result or ask the user to act (✅
 * completed, ⏸️ asked via DM, ⏹️ paused) are posted at every level. Every one of
 * them is recorded in the conversation's work log as a `notice` at every level.
 * The loop itself (counter, injection, queue advance) is unchanged.
 */

import { getVerbosityFlags, LOG_MINIMAL } from '@soma/slack/output-flags';
import { setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';
import type { WorkLogInput } from '@soma/slack/work-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyntheticMessageEvent } from '../../cron-scheduler';
import type { ConversationSession, SessionGoal } from '../../types';
import type { GoalEvalVerdict } from '../goal-completion-evaluator';
import { GoalLoopController, type GoalLoopControllerDeps } from '../goal-loop-controller';

const SESSION_KEY = 'C1:T1';
const COMPACT = getVerbosityFlags('compact');

const NOT_YET: GoalEvalVerdict = { completed: false, reason: 'missing tests', remaining: ['add tests'] };
const DONE: GoalEvalVerdict = { completed: true, reason: 'all done', remaining: [] };

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-test',
    objective: 'ship the feature',
    status: 'active',
    createdAt: 100,
    updatedAt: 100,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 0,
    ...overrides,
  };
}

const recorded: Array<[string, WorkLogInput]> = [];

function makeHarness(opts: {
  verdict: GoalEvalVerdict;
  logVerbosity: number | undefined;
  conversationId?: string | null;
  goal?: Partial<SessionGoal>;
  withDm?: boolean;
}) {
  const goal = makeGoal(opts.goal);
  const session = {
    channelId: 'C1',
    threadTs: 'T1',
    model: 'claude-opus-4',
    goal,
    goalLastTurnText: 'did some work',
    logVerbosity: opts.logVerbosity,
    ...(opts.conversationId === null ? {} : { conversationId: opts.conversationId ?? 'conv-1' }),
  } as unknown as ConversationSession;
  const notices: string[] = [];
  const injected: SyntheticMessageEvent[] = [];

  const deps: GoalLoopControllerDeps = {
    registry: { getSessionByKey: () => session, getActivityStateByKey: () => 'idle', saveSessions: vi.fn() },
    requestCoordinator: { isRequestActive: () => false },
    dispatcher: async () => JSON.stringify(opts.verdict),
    injectContinuation: async (event) => {
      injected.push(event);
    },
    postNotice: async (_channel, _threadTs, text) => {
      notices.push(text);
      return undefined;
    },
    ...(opts.withDm ? { postOwnerDm: async () => undefined } : {}),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: 'claude-sonnet-4',
  };
  const controller = new GoalLoopController(deps);
  return { controller, session, notices, injected };
}

async function settle(h: ReturnType<typeof makeHarness>): Promise<void> {
  h.controller.onTurnSettled(SESSION_KEY);
  await h.controller.settled(SESSION_KEY);
}

const noticeTexts = () => recorded.map(([conversationId, entry]) => [conversationId, entry.kind, entry.text]);

describe('GoalLoopController — notices follow the session verbosity', () => {
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

  describe('🔄 Goal not yet complete', () => {
    it('minimal: not posted, recorded once as a notice, the continuation still injected', async () => {
      const h = makeHarness({ verdict: NOT_YET, logVerbosity: LOG_MINIMAL });
      await settle(h);

      expect(h.notices).toEqual([]);
      expect(noticeTexts()).toEqual([['conv-1', 'notice', expect.stringContaining('🔄 Goal not yet complete')]]);
      expect(recorded[0][1].text).toContain('missing tests');
      expect(recorded[0][1].text).toContain('• add tests');
      expect(recorded[0][1].turnId).toBeUndefined();
      expect(h.injected).toHaveLength(1);
    });

    it.each([
      ['compact', COMPACT],
      ['unset (read as detail)', undefined],
    ])('%s: posted as today, and recorded', async (_label, mask) => {
      const h = makeHarness({ verdict: NOT_YET, logVerbosity: mask });
      await settle(h);

      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain('🔄 Goal not yet complete');
      expect(noticeTexts()).toEqual([['conv-1', 'notice', h.notices[0]]]);
      expect(h.injected).toHaveLength(1);
    });

    it('minimal without a conversation: not posted, nothing recorded', async () => {
      const h = makeHarness({ verdict: NOT_YET, logVerbosity: LOG_MINIMAL, conversationId: null });
      await settle(h);

      expect(h.notices).toEqual([]);
      expect(recorded).toEqual([]);
      expect(h.injected).toHaveLength(1);
    });
  });

  describe('✅ completed + ▶️ next queued goal', () => {
    function withQueue(mask: number | undefined) {
      const h = makeHarness({ verdict: DONE, logVerbosity: mask });
      h.session.goalQueue = [makeGoal({ goalId: 'goal-2', objective: 'second objective', status: 'queued' })];
      return h;
    }

    it('minimal: ✅ posted, ▶️ not posted, both recorded in order, the next goal still injected', async () => {
      const h = withQueue(LOG_MINIMAL);
      await settle(h);

      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain('✅ Goal completed');
      expect(noticeTexts()).toEqual([
        ['conv-1', 'notice', h.notices[0]],
        ['conv-1', 'notice', expect.stringContaining('▶️ Starting next queued goal')],
      ]);
      expect(recorded[1][1].text).toContain('second objective');
      expect(h.session.goal?.objective).toBe('second objective');
      expect(h.injected).toHaveLength(1);
    });

    it('compact: both posted as today, and both recorded', async () => {
      const h = withQueue(COMPACT);
      await settle(h);

      expect(h.notices).toHaveLength(2);
      expect(h.notices[0]).toContain('✅ Goal completed');
      expect(h.notices[1]).toContain('▶️ Starting next queued goal');
      expect(noticeTexts()).toEqual(h.notices.map((text) => ['conv-1', 'notice', text]));
    });
  });

  describe('cap reached — the user has to act, posted at every level', () => {
    const atCap = { continuationCount: 10, maxContinuations: 10 };

    it('minimal, owner DM sent: ⏸️ posted and recorded', async () => {
      const h = makeHarness({ verdict: NOT_YET, logVerbosity: LOG_MINIMAL, goal: atCap, withDm: true });
      await settle(h);

      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain('⏸️');
      expect(noticeTexts()).toEqual([['conv-1', 'notice', h.notices[0]]]);
      expect(h.injected).toHaveLength(0);
    });

    it('minimal, no DM transport: ⏹️ paused posted and recorded', async () => {
      const h = makeHarness({ verdict: NOT_YET, logVerbosity: LOG_MINIMAL, goal: atCap });
      await settle(h);

      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain('⏹️ Goal auto-continuation paused');
      expect(noticeTexts()).toEqual([['conv-1', 'notice', h.notices[0]]]);
      expect(h.injected).toHaveLength(0);
    });
  });
});
