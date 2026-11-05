/**
 * A turn the restart cut is resumed as that turn — an active goal does not take its place.
 *
 * Incident (dev, 2026-11-05): a goal session started two background subagents and its turn stayed open for them
 * (`working`). The restart at 07:32:53Z killed the CLI and both agents. Crash recovery told the thread "자동으로
 * 재개합니다", then skipped the resume because the session had an active goal and left it to the goal loop. The goal
 * loop's restart kick judged the last summary `completed: true` and injected nothing, so no turn ever ran: the cut
 * work (two components half-written) sat until a person wrote 21 minutes later. Only then did the CLI report "2
 * background agents didn't finish before the previous session ended".
 *
 * So: a session that was working at shutdown is resumed with the restart prompt whether or not its goal is active,
 * the goal loop judges after that turn settles (its own idle settle), and the restart kick is left out for it — one
 * turn, never two. The cut goal turn still gives its continuation back. The restart prompt tells the resumed turn
 * that the background work it started was stopped with the restart and must be picked up again, not waited on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock(import('../env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DATA_DIR: '/tmp/soma-work-restart-cut-goal-test' };
});

import { SlackHandler } from '../slack-handler';
import type { ConversationSession } from '../types';

function goalSession(activityState: 'working' | 'idle', continuationCount = 0): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    ownerId: 'U1',
    activityState,
    goal: {
      goalId: 'g1',
      objective: 'ship the six components',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'U1',
      continuationCount,
      maxContinuations: 10,
      lastAssistantTurnSummary: 'npm publish done; two subagents are still building ui-working and ui-copy-field',
    },
  } as unknown as ConversationSession;
}

function recovered(working: boolean) {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    ownerId: 'U1',
    activityState: working ? 'working' : 'idle',
    shouldAutoResume: working,
    sessionKey: 'C1-T1',
  };
}

async function boot(session: ConversationSession, working: boolean, opts: { noticeFails?: boolean } = {}) {
  const sessions = new Map<string, ConversationSession>([['C1-T1', session]]);
  const postMessage = opts.noticeFails
    ? vi.fn().mockRejectedValue(new Error('channel_not_found'))
    : vi.fn().mockResolvedValue({ ok: true, ts: '1.1' });
  const app = { client: { chat: { postMessage } }, assistant: vi.fn() } as any;
  const claudeHandler = {
    getAllSessions: vi.fn().mockReturnValue(sessions),
    getSessionByKey: vi.fn((k: string) => sessions.get(k)),
    getCrashRecoveredSessions: vi.fn().mockReturnValue([recovered(working)]),
    clearCrashRecoveredSessions: vi.fn(),
    saveSessions: vi.fn(),
  } as any;
  const handler = new SlackHandler(app, claudeHandler, {} as any);
  const handleMessage = vi.fn().mockResolvedValue(undefined);
  (handler as any).handleMessage = handleMessage;
  const kick = vi.fn();
  handler.setGoalTurnSettledHandler(kick);
  await handler.notifyCrashRecovery();
  const kicked = handler.resumeActiveGoals();
  return { handleMessage, kick, kicked, postMessage };
}

describe('restart — a cut turn is resumed as itself, an active goal does not replace it', () => {
  it('resumes a goal session the restart cut with the restart prompt (the notice promised it)', async () => {
    const { handleMessage, postMessage } = await boot(goalSession('working'), true);

    expect(postMessage.mock.calls[0][0].text).toContain('자동으로 재개합니다');
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const event = handleMessage.mock.calls[0][0];
    expect(event.routeContext).toEqual({ autoResume: true });
    expect(event.text).toContain('The service was restarted');
  });

  it('leaves the goal loop out of that session — one resume turn, never two', async () => {
    const { kick, kicked } = await boot(goalSession('working'), true);

    expect(kick).not.toHaveBeenCalled();
    expect(kicked).toBe(0);
  });

  it('does not force the resumed turn idle — it may already be running', async () => {
    const session = goalSession('working');
    await boot(session, true);

    expect(session.activityState).toBe('working');
  });

  it('keeps the cut continuation — the resume turn is that continuation, so nothing is given back', async () => {
    const session = goalSession('working', 10);
    await boot(session, true);

    // Refunding as well would buy one extra turn on the same budget (astra review, P2).
    expect(session.goal?.continuationCount).toBe(10);
  });

  it('a goal session idle at shutdown is not resumed by the restart prompt — the goal loop drives it', async () => {
    const { handleMessage, kick, kicked } = await boot(goalSession('idle'), false);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(kick).toHaveBeenCalledWith('C1-T1', { cause: 'kick' });
    expect(kicked).toBe(1);
  });

  it('a restart resume that could not start its turn hands the goal session back to the loop — once', async () => {
    const session = goalSession('working', 3);
    const sessions = new Map<string, ConversationSession>([['C1-T1', session]]);
    const app = {
      client: { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.1' }) } },
      assistant: vi.fn(),
    } as any;
    const claudeHandler = {
      getAllSessions: vi.fn().mockReturnValue(sessions),
      getSessionByKey: vi.fn((k: string) => sessions.get(k)),
      getCrashRecoveredSessions: vi.fn().mockReturnValue([recovered(true)]),
      clearCrashRecoveredSessions: vi.fn(),
      saveSessions: vi.fn(),
    } as any;
    const handler = new SlackHandler(app, claudeHandler, {} as any);
    (handler as any).handleMessage = vi.fn().mockRejectedValue(new Error('dispatch failed'));
    const kick = vi.fn();
    handler.setGoalTurnSettledHandler(kick);

    await handler.notifyCrashRecovery();
    handler.resumeActiveGoals();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith('C1-T1', { cause: 'kick' });
    expect(session.activityState).toBe('idle');
    // The loop now makes the replacement turn, so the cut one is given back — once.
    expect(session.goal?.continuationCount).toBe(2);
  });

  describe('a resume that never starts, with a false stall left by an earlier restart — one refund, one kick', () => {
    function stalledCut(): ConversationSession {
      const session = goalSession('working', 3);
      const goal = session.goal as NonNullable<ConversationSession['goal']>;
      goal.lastAssistantTurnSummary = '';
      goal.lastEvalReason = 'no output';
      goal.stall = { stallId: 's1', stalledAt: 1, reason: 'no output', actions: ['a', 'b', 'c'], confidence: 0.97 };
      return session;
    }

    function wire(session: ConversationSession, handleMessage: ReturnType<typeof vi.fn>) {
      const sessions = new Map<string, ConversationSession>([['C1-T1', session]]);
      const app = {
        client: { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.1' }) } },
        assistant: vi.fn(),
      } as any;
      const claudeHandler = {
        getAllSessions: vi.fn().mockReturnValue(sessions),
        getSessionByKey: vi.fn((k: string) => sessions.get(k)),
        getCrashRecoveredSessions: vi.fn().mockReturnValue([recovered(true)]),
        clearCrashRecoveredSessions: vi.fn(),
        saveSessions: vi.fn(),
      } as any;
      const handler = new SlackHandler(app, claudeHandler, {} as any);
      (handler as any).handleMessage = handleMessage;
      const kick = vi.fn();
      handler.setGoalTurnSettledHandler(kick);
      return { handler, kick };
    }

    it('fails before the startup goal pass: that pass resumes it as a plain cut', async () => {
      const session = stalledCut();
      const { handler, kick } = wire(session, vi.fn().mockRejectedValue(new Error('dispatch failed')));

      await handler.notifyCrashRecovery();
      await new Promise((resolve) => setTimeout(resolve, 0));
      handler.resumeActiveGoals();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(session.goal?.stall).toBeUndefined();
      expect(session.goal?.continuationCount).toBe(2);
      expect(kick).toHaveBeenCalledTimes(1);
      expect(session.activityState).toBe('idle');
    });

    it('fails after the startup goal pass: the hand-back refunds and kicks', async () => {
      const session = stalledCut();
      let fail: (error: Error) => void = () => {};
      const pending = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
      const { handler, kick } = wire(
        session,
        vi.fn(() => pending),
      );

      await handler.notifyCrashRecovery();
      handler.resumeActiveGoals();
      expect(kick).not.toHaveBeenCalled();
      fail(new Error('dispatch failed'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(session.goal?.stall).toBeUndefined();
      expect(session.goal?.continuationCount).toBe(2);
      expect(kick).toHaveBeenCalledTimes(1);
      expect(session.activityState).toBe('idle');
    });
  });

  it('a cut goal session whose restart notice failed is still resumed — by the goal loop', async () => {
    const session = goalSession('working', 3);
    const { handleMessage, kick, kicked } = await boot(session, true, { noticeFails: true });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(kick).toHaveBeenCalledWith('C1-T1', { cause: 'kick' });
    expect(kicked).toBe(1);
    expect(session.goal?.continuationCount).toBe(2);
  });
});

describe('restart.prompt — background work the restart stopped is picked up again, not waited on', () => {
  const PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompt', 'restart.prompt'), 'utf-8');

  it('says background subagents, commands and watches stopped with the restart and will not report back', () => {
    expect(PROMPT).toContain('subagents, background commands, Monitor watches');
    expect(PROMPT).toContain('will not report back');
  });

  it('says the "did not finish before the previous session ended" notice is the interruption, not the user', () => {
    expect(PROMPT).toContain("didn't finish before the previous session ended");
    expect(PROMPT).toContain('not from the user');
  });

  it('says how to pick each one up: SendMessage resumes a subagent, a command runs again', () => {
    expect(PROMPT).toContain('SendMessage');
    expect(PROMPT).toContain('agent ID');
    expect(PROMPT).toContain('run a stopped command again');
  });

  it('a stopped command that is an outside action meets the check above first', () => {
    const line = PROMPT.split('\n').find((l) => l.includes('run a stopped command again'));
    expect(line).toContain('after the check above');
  });

  it('forbids ending the turn to wait for work that no longer runs', () => {
    expect(PROMPT).toContain('Never end your turn waiting for work that is no longer running');
  });

  it('states the rule before the steps, so every resume path meets it', () => {
    const rule = PROMPT.indexOf('will not report back');
    const firstStep = PROMPT.search(/^0\. /m);
    expect(rule).toBeGreaterThanOrEqual(0);
    expect(firstStep).toBeGreaterThan(rule);
  });
});
