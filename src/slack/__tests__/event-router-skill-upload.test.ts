import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeHandler } from '../../claude-handler';
import type { ConversationSession } from '../../types';
import type { ActionHandlers, MessageHandler } from '../action-handlers';
import { EventRouter, type EventRouterDeps } from '../event-router';
import type { SessionUiManager } from '../session-manager';
import type { SlackApiHelper } from '../slack-api-helper';

/**
 * Integration: `EventRouter.handleFileUpload` MUST intercept a `file_share`
 * event when the session carries an armed `pendingSkillUpload` marker and
 * the upload matches the marker (uploader + filename). The file is then
 * routed into the SKILL.md roundtrip (apply via `updateUserSkill`) — NOT
 * into the normal Claude pipeline.
 *
 * The roundtrip logic itself (every guard / outcome) is unit-tested in
 * `user-skill-file-roundtrip.test.ts`; this file pins the wiring: marker
 * present → consume → no Claude.
 */

vi.mock('../../channel-registry', () => ({
  registerChannel: vi.fn().mockResolvedValue(null),
  unregisterChannel: vi.fn(),
}));

// Mock node-fetch so the download step inside the event-router's consume
// path returns a deterministic SKILL.md body without hitting Slack.
const mockFetch = vi.fn();
vi.mock('node-fetch', () => ({
  default: (...args: any[]) => mockFetch(...args),
}));

// Mock the user-skill store reads/writes the consume path depends on.
const NEW_BODY = '---\nname: autoz\ndescription: new\n---\nNEW';
const CURRENT_BODY = '---\nname: autoz\ndescription: old\n---\nOLD';

vi.mock('../../user-skill-store', async () => {
  const actual = await vi.importActual<typeof import('../../user-skill-store')>('../../user-skill-store');
  return {
    ...actual,
    getUserSkill: vi.fn((_userId: string, _skillName: string) => ({
      name: 'autoz',
      description: 'old',
      content: CURRENT_BODY,
    })),
    updateUserSkill: vi.fn(() => ({ ok: true, message: 'Skill "autoz" updated.' })),
    // computeContentHash stays the real implementation so the baseline check
    // exercises the actual hashing path.
  };
});

const createMockSlackApi = () => ({
  getBotUserId: vi.fn().mockResolvedValue('B123'),
  getChannelInfo: vi.fn().mockResolvedValue({ name: 'general' }),
  getClient: vi.fn().mockReturnValue({}),
  addReaction: vi.fn().mockResolvedValue(true),
  postMessage: vi.fn().mockResolvedValue({ ts: 'p1' }),
});

const broadcastSessionUpdate = vi.fn();
const createMockClaudeHandler = (session: ConversationSession | null) => ({
  getSession: vi.fn().mockReturnValue(session),
  broadcastSessionUpdate,
  setExpiryCallbacks: vi.fn(),
  cleanupInactiveSessions: vi.fn().mockResolvedValue(undefined),
});

const createMockSession = (overrides: Partial<ConversationSession> = {}): ConversationSession =>
  ({
    ownerId: 'U123',
    ownerName: 'Test User',
    channelId: 'C456',
    threadTs: '111.222',
    sessionId: 'session-123',
    isActive: true,
    lastActivity: new Date(),
    userId: 'U123',
    ...overrides,
  }) as ConversationSession;

describe('EventRouter.handleFileUpload + pendingSkillUpload', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let mockClaudeHandler: ReturnType<typeof createMockClaudeHandler>;
  let mockSessionManager: any;
  let mockActionHandlers: any;
  let mockApp: any;
  let mockMessageHandler: MessageHandler;
  let deps: EventRouterDeps;
  let router: EventRouter;
  let session: ConversationSession;
  let userSkillStore: typeof import('../../user-skill-store');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    broadcastSessionUpdate.mockReset();

    userSkillStore = await import('../../user-skill-store');
    vi.mocked(userSkillStore.getUserSkill).mockReturnValue({
      name: 'autoz',
      description: 'old',
      content: CURRENT_BODY,
    });
    vi.mocked(userSkillStore.updateUserSkill).mockReturnValue({
      ok: true,
      message: 'Skill "autoz" updated.',
    });

    // Real hashContent is preserved; capture the baseline the action-handler
    // would have stored for the CURRENT_BODY.
    const baselineHash = userSkillStore.computeContentHash(CURRENT_BODY);
    session = createMockSession({
      pendingSkillUpload: {
        skillName: 'autoz',
        requesterId: 'U123',
        baselineHash,
        expiresAt: Date.now() + 30 * 60 * 1000,
      },
    });

    mockSlackApi = createMockSlackApi();
    mockClaudeHandler = createMockClaudeHandler(session);
    mockSessionManager = {
      handleSessionWarning: vi.fn(),
      handleSessionSleep: vi.fn(),
      handleSessionExpiry: vi.fn(),
    };
    mockActionHandlers = { registerHandlers: vi.fn() };
    mockApp = { message: vi.fn(), event: vi.fn(), command: vi.fn() };
    mockMessageHandler = vi.fn().mockResolvedValue(undefined) as unknown as MessageHandler;

    deps = {
      slackApi: mockSlackApi as unknown as SlackApiHelper,
      claudeHandler: mockClaudeHandler as unknown as ClaudeHandler,
      sessionManager: mockSessionManager as unknown as SessionUiManager,
      actionHandlers: mockActionHandlers as unknown as ActionHandlers,
    };

    router = new EventRouter(mockApp, deps, mockMessageHandler);
  });

  afterEach(() => {
    router.cleanup();
  });

  /** Convenience: invoke the `message` event handler registered via setup(). */
  const getMessageHandler = (): Function => {
    router.setup();
    const call = mockApp.event.mock.calls.find((c: any[]) => c[0] === 'message');
    if (!call) throw new Error('message handler not registered');
    return call[1];
  };

  it('intercepts file_share matching the marker, applies updateUserSkill, clears marker, skips Claude', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(NEW_BODY).buffer,
    });

    const handler = getMessageHandler();
    const ev = {
      user: 'U123',
      channel: 'C456',
      thread_ts: '111.222',
      ts: '333.444',
      subtype: 'file_share',
      files: [
        {
          id: 'F1',
          name: 'SKILL.md',
          mimetype: 'text/markdown',
          url_private_download: 'https://files.slack/test',
          size: NEW_BODY.length,
        },
      ],
    };

    await handler({ event: ev, say: vi.fn() });

    // Bot downloaded the file with the bot token.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://files.slack/test');

    // Apply went through with the downloaded bytes.
    expect(vi.mocked(userSkillStore.updateUserSkill)).toHaveBeenCalledWith('U123', 'autoz', NEW_BODY);

    // Marker cleared + dashboard/disk synced.
    expect(session.pendingSkillUpload).toBeUndefined();
    expect(broadcastSessionUpdate).toHaveBeenCalled();

    // Confirmation message posted to the thread.
    expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
      'C456',
      expect.stringMatching(/업데이트되었습니다/),
      expect.objectContaining({ threadTs: '111.222' }),
    );

    // Claude was NOT called — the file was a roundtrip control message, not
    // a prompt attachment.
    expect(mockMessageHandler).not.toHaveBeenCalled();
  });

  it('falls through to the normal pipeline when no SKILL.md file is in the upload', async () => {
    const handler = getMessageHandler();
    const ev = {
      user: 'U123',
      channel: 'C456',
      thread_ts: '111.222',
      ts: '333.444',
      subtype: 'file_share',
      files: [{ id: 'F1', name: 'screenshot.png', mimetype: 'image/png' }],
    };

    await handler({ event: ev, say: vi.fn() });

    // Marker survives; no fetch/update fired.
    expect(session.pendingSkillUpload).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(userSkillStore.updateUserSkill)).not.toHaveBeenCalled();
    // File still routed to Claude as a normal prompt attachment.
    expect(mockMessageHandler).toHaveBeenCalledTimes(1);
  });

  it('falls through with the marker preserved when the uploader is not the requester', async () => {
    const handler = getMessageHandler();
    const ev = {
      user: 'U-other',
      channel: 'C456',
      thread_ts: '111.222',
      ts: '333.444',
      subtype: 'file_share',
      files: [
        {
          id: 'F1',
          name: 'SKILL.md',
          mimetype: 'text/markdown',
          url_private_download: 'https://files.slack/test',
        },
      ],
    };

    await handler({ event: ev, say: vi.fn() });

    expect(session.pendingSkillUpload).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(userSkillStore.updateUserSkill)).not.toHaveBeenCalled();
    // The other user's upload still falls through to the normal pipeline.
    expect(mockMessageHandler).toHaveBeenCalledTimes(1);
  });

  it('consumes the event and reports staleness when the on-disk SKILL.md changed since baseline', async () => {
    // On-disk content drifted — hash will not match the marker's baselineHash.
    vi.mocked(userSkillStore.getUserSkill).mockReturnValue({
      name: 'autoz',
      description: 'old',
      content: `${CURRENT_BODY}\n# external edit`,
    });

    const handler = getMessageHandler();
    const ev = {
      user: 'U123',
      channel: 'C456',
      thread_ts: '111.222',
      ts: '333.444',
      subtype: 'file_share',
      files: [
        {
          id: 'F1',
          name: 'SKILL.md',
          mimetype: 'text/markdown',
          url_private_download: 'https://files.slack/test',
        },
      ],
    };

    await handler({ event: ev, say: vi.fn() });

    // Stale guard fired — no download attempted, no update applied.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(userSkillStore.updateUserSkill)).not.toHaveBeenCalled();
    // Marker cleared; the user must re-click 편집 to start fresh.
    expect(session.pendingSkillUpload).toBeUndefined();
    expect(broadcastSessionUpdate).toHaveBeenCalled();
    // Claude not invoked — the event was consumed with a user-facing notice.
    expect(mockMessageHandler).not.toHaveBeenCalled();
    expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
      'C456',
      expect.stringMatching(/변경되었/),
      expect.objectContaining({ threadTs: '111.222' }),
    );
  });
});
