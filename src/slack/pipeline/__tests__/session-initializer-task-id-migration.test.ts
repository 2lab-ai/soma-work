/**
 * Task id contract (MVP-A0 #595) T2 — bot-thread migration keeps the task id.
 *
 * `createBotInitiatedThread` builds a NEW session for the bot's thread and
 * terminates the original. The task is the same card, so its task id must
 * travel to the new session and the task-id lookup must land there — not on
 * the terminated original, and not miss. Runs against a real SessionRegistry
 * so the create → transition → terminate order is the production one.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return { TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-task-id-migration-${process.pid}`) };
});

vi.mock('../../../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../../../metrics/event-emitter', () => {
  const ok = () => vi.fn(async () => undefined);
  const emitter = { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() };
  return { getMetricsEmitter: () => emitter };
});

vi.mock('../../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv-123'),
  getConversationUrl: vi.fn().mockReturnValue('http://localhost:3000/conversations/conv-123'),
}));

import { SessionRegistry } from '../../../session-registry';
import { SessionInitializer } from '../session-initializer';

describe('SessionInitializer — bot-thread migration keeps the task id (#595 T2)', () => {
  let registry: SessionRegistry;
  let sessionInitializer: SessionInitializer;

  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    registry = new SessionRegistry();

    const slackApi = {
      getUserName: vi.fn().mockResolvedValue('Test User'),
      postMessage: vi.fn().mockResolvedValue({ ts: '900.002' }),
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p1'),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph123' }),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      deleteThreadBotMessages: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockReturnValue({}),
    };

    sessionInitializer = new SessionInitializer({
      claudeHandler: registry,
      slackApi,
      messageValidator: { validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true }) } as any,
      workingDirManager: { createSessionBaseDir: vi.fn().mockReturnValue(undefined) } as any,
      reactionManager: {
        setOriginalMessage: vi.fn(),
        clearSessionLifecycleEmojis: vi.fn().mockResolvedValue(undefined),
        getCurrentReaction: vi.fn().mockReturnValue(null),
        cleanup: vi.fn(),
      } as any,
      contextWindowManager: { setOriginalMessage: vi.fn().mockResolvedValue(undefined) } as any,
      requestCoordinator: {
        isRequestActive: vi.fn().mockReturnValue(false),
        setController: vi.fn(),
        abortSession: vi.fn(),
        getLastActivityAt: vi.fn().mockReturnValue(undefined),
        touchSession: vi.fn(),
      } as any,
      assistantStatusManager: {
        setStatus: vi.fn().mockResolvedValue(undefined),
        clearStatus: vi.fn().mockResolvedValue(undefined),
        bumpEpoch: vi.fn().mockReturnValue(1),
        isEnabled: vi.fn().mockReturnValue(true),
      } as any,
    } as any);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('the bot-thread session carries the task id and conversationId; the lookup lands on it', async () => {
    const original = registry.createSession('U123', 'Test User', 'C123', '900.001');
    original.conversationId = 'conv-orig';
    original.state = 'MAIN';
    original.workflow = 'default';
    original.title = 'Session';
    const taskId = original.taskId!;
    expect(typeof taskId).toBe('string');

    const result = await (sessionInitializer as any).createBotInitiatedThread(
      original,
      'C123',
      '900.001',
      'U123',
      'Test User',
      '/test/dir',
      false,
    );

    const botSession = result.session;
    expect(botSession).not.toBe(original);
    expect(registry.getSession('C123', '900.002')).toBe(botSession);
    // The original thread's session is gone.
    expect(registry.getSession('C123', '900.001')).toBeUndefined();

    expect(botSession.taskId).toBe(taskId);
    expect(botSession.conversationId).toBe('conv-orig');
    expect(registry.getSessionByTaskId(taskId)).toBe(botSession);
  });

  it('a refused termination leaves the task id on the original — the lookup never points at the unreturned bot session', async () => {
    const original = registry.createSession('U123', 'Test User', 'C123', '900.001');
    original.state = 'MAIN';
    original.workflow = 'default';
    original.title = 'Session';
    const taskId = original.taskId!;

    // The host refuses to delete the original (fail-closed deletion seam).
    registry.setBeforeSessionDelete((key) => {
      if (key === registry.getSessionKey('C123', '900.001')) throw new Error('durable state not settled');
    });

    await expect(
      (sessionInitializer as any).createBotInitiatedThread(
        original,
        'C123',
        '900.001',
        'U123',
        'Test User',
        '/test/dir',
        false,
      ),
    ).rejects.toThrow();

    // The original is still live and still owns its task id.
    expect(registry.getSession('C123', '900.001')).toBe(original);
    expect(original.taskId).toBe(taskId);
    expect(registry.getSessionByTaskId(taskId)).toBe(original);
    // The half-made bot session does not carry the task id.
    const bot = registry.getSession('C123', '900.002');
    if (bot) expect(bot.taskId).not.toBe(taskId);
  });
});
