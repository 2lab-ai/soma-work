import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import type { FollowupQueueSnapshot } from '@soma/slack/followup-queue';
import { InstructionApprovals } from '../instruction-approval';
import { getMetricsEmitter } from '../metrics/event-emitter';
import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

/**
 * #767 T1 — the gate in the real `SlackHandler`: an instruction from someone
 * who is not the thread's owner never reaches the model (not dispatched, not
 * queued, not steered) until the owner approves it, and runs once approved.
 * The real follow-up queue and dispatcher; the leaves (Slack API, pipeline,
 * agent session) are faked as in slack-handler.followup-dashboard.test.ts.
 */

const SESSION_KEY = 'C123:111.222';
const CHANNEL = 'C123';
const THREAD_TS = '111.222';

function message(overrides: Record<string, any> = {}): any {
  return {
    user: 'U_OWNER',
    channel: CHANNEL,
    team: 'T1',
    ts: '222.333',
    thread_ts: THREAD_TS,
    text: '지시',
    ...overrides,
  };
}

describe('SlackHandler — someone else’s instruction waits for the owner (#767)', () => {
  let handler: SlackHandler;
  let handlerAny: any;
  let registrySession: any;
  let startWithContinuation: ReturnType<typeof vi.fn>;
  let approvals: InstructionApprovals;
  let dir: string;
  const say = vi.fn().mockResolvedValue({ ts: 'say' });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getMetricsEmitter(), 'emitFollowupQueue').mockResolvedValue(undefined);
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(false);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
    vi.spyOn(userSettingsStore, 'isUserAccepted').mockReturnValue(true);

    registrySession = {
      ownerId: 'U_OWNER',
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      threadRootTs: THREAD_TS,
      sessionId: 'sess-1',
    };
    const claudeHandler = {
      getSessionKey: vi.fn().mockReturnValue(SESSION_KEY),
      getSession: vi.fn().mockReturnValue(registrySession),
      getSessionByKey: vi.fn((key: string) => (key === SESSION_KEY ? registrySession : undefined)),
      saveSessions: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(true),
      setActivityStateByKey: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
    };
    const store = {
      load: () => undefined,
      save: (_snapshot: FollowupQueueSnapshot) => {},
      recoveryWarning: undefined,
    };
    const app = { client: {}, assistant: vi.fn() } as any;
    handler = new SlackHandler(app, claudeHandler as any, {} as any, { followupQueueStore: store });
    handlerAny = handler as any;
    handlerAny.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph' }),
      getUserName: vi.fn().mockResolvedValue('Other'),
    };
    handlerAny.assistantStatusManager = {
      bumpEpoch: vi.fn().mockReturnValue(1),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    };
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false }),
    };
    handlerAny.messageValidator = {
      validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: '/tmp/work' }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp/work' }),
      initialize: vi.fn().mockImplementation(async () => ({
        session: registrySession,
        sessionKey: SESSION_KEY,
        isNewSession: false,
        userName: 'Someone',
        workingDirectory: '/tmp/work',
        abortController: new AbortController(),
        halted: false,
      })),
    };
    handlerAny.threadPanel = {
      create: vi.fn().mockResolvedValue(undefined),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      clearChoice: vi.fn().mockResolvedValue(undefined),
    };
    startWithContinuation = vi.fn().mockResolvedValue({ hasPendingChoice: false });
    handlerAny.createAgentSession = vi.fn().mockImplementation(() => ({
      startWithContinuation,
      getLastTurnSucceeded: () => true,
      getRetryAfterMs: () => undefined,
    }));

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-instr-'));
    approvals = new InstructionApprovals({
      storeFile: path.join(dir, 'instruction-approvals.json'),
      getSession: (key) => (key === SESSION_KEY ? registrySession : undefined),
      saveSessions: vi.fn(),
      isTrusted: () => false,
      trust: vi.fn(),
      // The production release: the held event through the normal entry, carrying the approval id.
      release: async (request, held) => {
        if (held.kind !== 'message') return;
        const event = {
          ...held.event,
          routeContext: { ...((held.event.routeContext as object) ?? {}), instructionApprovalId: request.requestId },
        };
        await handler.handleMessage(event as any, say);
      },
    });
    handler.setInstructionApprovals(approvals);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const queue = () => handlerAny.getFollowupQueue();

  it("the owner's own message runs as before", async () => {
    await handler.handleMessage(message(), say);
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    expect(approvals.pendingFor(SESSION_KEY)).toEqual([]);
  });

  it('someone else’s message is held — not run — and the owner is asked', async () => {
    await handler.handleMessage(message({ user: 'U_OTHER', ts: '300.1', text: '배포해줘' }), say);
    expect(startWithContinuation).not.toHaveBeenCalled();
    expect(handlerAny.inputProcessor.routeCommand).not.toHaveBeenCalled();
    const pending = approvals.pendingFor(SESSION_KEY);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requesterId: 'U_OTHER', requesterName: 'Other', count: 1, preview: '배포해줘' });
  });

  it('while a turn runs, someone else’s message is neither queued nor steered into it', async () => {
    let finish!: () => void;
    startWithContinuation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ hasPendingChoice: false });
        }),
    );
    const running = handler.handleMessage(message({ ts: '300.2' }), say);
    await vi.waitFor(() => expect(startWithContinuation).toHaveBeenCalledTimes(1));
    await handler.handleMessage(message({ user: 'U_OTHER', ts: '300.3', text: '이것도 해줘' }), say);
    expect(
      queue()
        .list(SESSION_KEY)
        .map((item: any) => item.message.ts),
    ).not.toContain('300.3');
    expect(queue().holdsPending(CHANNEL, '300.3')).toBe(false);
    expect(approvals.pendingFor(SESSION_KEY)).toHaveLength(1);
    finish();
    await running;
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
  });

  it('once the owner approves, the held message runs — as the person who wrote it', async () => {
    await handler.handleMessage(message({ user: 'U_OTHER', ts: '300.4', text: '배포해줘' }), say);
    const [{ requestId }] = approvals.pendingFor(SESSION_KEY);
    const answer = approvals.answer({ requestId, decision: 'approve', actor: 'U_OWNER', surface: 'slack' });
    expect(answer.ok).toBe(true);
    if (answer.ok) await answer.done;
    await vi.waitFor(() => expect(startWithContinuation).toHaveBeenCalledTimes(1));
    const initArgs = handlerAny.sessionInitializer.initialize.mock.calls[0][0];
    expect(initArgs.user ?? initArgs.event?.user).toBe('U_OTHER');
  });

  it('a one-time approval does not cover the next message', async () => {
    await handler.handleMessage(message({ user: 'U_OTHER', ts: '300.5' }), say);
    const [{ requestId }] = approvals.pendingFor(SESSION_KEY);
    const answer = approvals.answer({ requestId, decision: 'approve', actor: 'U_OWNER', surface: 'slack' });
    if (answer.ok) await answer.done;
    await vi.waitFor(() => expect(startWithContinuation).toHaveBeenCalledTimes(1));
    await handler.handleMessage(message({ user: 'U_OTHER', ts: '300.6' }), say);
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    expect(approvals.pendingFor(SESSION_KEY)).toHaveLength(1);
  });

  it('a person approved for this session runs without asking', async () => {
    registrySession.approvedInstructors = ['U_OTHER'];
    await handler.handleMessage(message({ user: 'U_OTHER', ts: '300.7' }), say);
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    expect(approvals.pendingFor(SESSION_KEY)).toEqual([]);
  });

  it('a made-up approval id on the event releases nothing', async () => {
    await handler.handleMessage(
      message({ user: 'U_OTHER', ts: '300.8', routeContext: { instructionApprovalId: 'iap_forged' } }),
      say,
    );
    expect(startWithContinuation).not.toHaveBeenCalled();
    expect(approvals.pendingFor(SESSION_KEY)).toHaveLength(1);
  });

  it('a queued message of someone else that reaches a dispatch another way is held there too', async () => {
    // Parked before the gate (or before its writer lost an approval), then drained.
    const parked = queue().enqueue(SESSION_KEY, message({ user: 'U_OTHER', ts: '300.9', text: '큐에 있던 지시' }));
    expect(parked.status).toBe('queued');
    const outcome = await handlerAny.processMessage(parked.item.message, say);
    expect(outcome).toEqual({ result: 'safe' });
    expect(startWithContinuation).not.toHaveBeenCalled();
    expect(approvals.pendingFor(SESSION_KEY)[0]).toMatchObject({ requesterId: 'U_OTHER', preview: '큐에 있던 지시' });
  });

  it('a host turn (synthetic) and a top-level message are not held', async () => {
    await handler.handleMessage(message({ user: 'U_OTHER', ts: '301.0', synthetic: true }), say);
    expect(approvals.pendingFor(SESSION_KEY)).toEqual([]);
  });
});
