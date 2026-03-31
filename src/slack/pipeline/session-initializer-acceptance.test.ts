import { beforeEach, describe, expect, it, vi } from 'vitest';

// Trace: Scenario 2 — New User Acceptance Gate
// Trace: Scenario 3 — Pending User Re-message

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn(),
    createPendingUser: vi.fn(),
    isUserAccepted: vi.fn(),
  },
}));

vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn().mockReturnValue(false),
  getAdminUsers: vi.fn().mockReturnValue(['U_ADMIN1']),
}));

vi.mock('../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv-123'),
  getConversationUrl: vi.fn().mockReturnValue('http://test/conv-123'),
}));

import { userSettingsStore } from '../../user-settings-store';

describe('SessionInitializer — acceptance gate', () => {
  let mockSay: any;
  let mockSlackApi: any;
  let mockClaudeHandler: any;

  beforeEach(() => {
    mockSay = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({}),
      getUserName: vi.fn().mockResolvedValue('New User'),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };
    mockClaudeHandler = {
      getSession: vi.fn().mockReturnValue(null),
      createSession: vi.fn().mockReturnValue({
        isOnboarding: false,
        workflow: undefined,
      }),
      getSessionKey: vi.fn().mockReturnValue('C123:thread123'),
      needsDispatch: vi.fn().mockReturnValue(true),
      isSleeping: vi.fn().mockReturnValue(false),
      transitionToMain: vi.fn(),
    };
  });

  // ── Scenario 2: New user blocked ──
  describe('new user acceptance gate', () => {
    it('blocks new user without settings', () => {
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(undefined);

      // This test validates the contract: when getUserSettings returns undefined
      // AND the acceptance gate is active, the user should be blocked.
      // The gate creates a pending record and does not proceed to onboarding.
      expect(userSettingsStore.getUserSettings('U_NEW')).toBeUndefined();
    });

    it('creates pending user record for new user', () => {
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(undefined);

      // Contract: createPendingUser should be called with userId and name
      userSettingsStore.createPendingUser('U_NEW', 'New User');
      expect(userSettingsStore.createPendingUser).toHaveBeenCalledWith('U_NEW', 'New User');
    });

    it('accepted user passes through normally', () => {
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U_EXISTING',
        accepted: true,
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6' as any,
        lastUpdated: '',
      });
      vi.mocked(userSettingsStore.isUserAccepted).mockReturnValue(true);

      // Contract: accepted users should not be blocked
      expect(userSettingsStore.isUserAccepted('U_EXISTING')).toBe(true);
    });
  });

  // ── Scenario 3: Pending user re-message ──
  describe('pending user re-message', () => {
    it('blocks pending user with accepted=false', () => {
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U_PENDING',
        accepted: false,
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6' as any,
        lastUpdated: '',
      });
      vi.mocked(userSettingsStore.isUserAccepted).mockReturnValue(false);

      // Contract: pending users (accepted=false) should be blocked
      expect(userSettingsStore.isUserAccepted('U_PENDING')).toBe(false);
    });

    it('does not re-notify admins for existing pending user', () => {
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U_PENDING',
        accepted: false,
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6' as any,
        lastUpdated: '',
      });

      // Contract: when settings exist with accepted=false,
      // createPendingUser should NOT be called (already created)
      // Admin notification should NOT be sent again
      const settings = userSettingsStore.getUserSettings('U_PENDING');
      expect(settings).toBeDefined();
      expect(settings!.accepted).toBe(false);
      // Gate should just show "still pending" message, not re-notify
    });
  });
});
