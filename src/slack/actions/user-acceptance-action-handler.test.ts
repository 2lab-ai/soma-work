import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn(),
}));

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    acceptUser: vi.fn(),
    removeUserSettings: vi.fn(),
    getUserSettings: vi.fn(),
  },
}));

import { isAdminUser } from '../../admin-utils';
import { userSettingsStore } from '../../user-settings-store';
import { UserAcceptanceActionHandler } from './user-acceptance-action-handler';

function makeBody(actionId: string, value: string, userId = 'U_ADMIN') {
  return {
    user: { id: userId },
    actions: [{ action_id: actionId, value }],
  };
}

describe('UserAcceptanceActionHandler', () => {
  let handler: UserAcceptanceActionHandler;
  let mockSlackApi: any;
  let mockRespond: any;

  beforeEach(() => {
    mockSlackApi = {
      postMessage: vi.fn().mockResolvedValue({}),
    };
    handler = new UserAcceptanceActionHandler({ slackApi: mockSlackApi });
    mockRespond = vi.fn().mockResolvedValue(undefined);
    vi.mocked(isAdminUser).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Scenario 4: Accept via Button ──
  describe('handleAccept', () => {
    it('sets accepted=true', async () => {
      const body = makeBody('accept_user', 'U_NEW');
      await handler.handleAccept(body, mockRespond);

      expect(userSettingsStore.acceptUser).toHaveBeenCalledWith('U_NEW', 'U_ADMIN');
    });

    it('updates admin DM', async () => {
      const body = makeBody('accept_user', 'U_NEW');
      await handler.handleAccept(body, mockRespond);

      expect(mockRespond).toHaveBeenCalledWith(
        expect.objectContaining({
          replace_original: true,
          text: expect.stringContaining('U_NEW'),
        }),
      );
    });

    it('notifies user via DM', async () => {
      const body = makeBody('accept_user', 'U_NEW');
      await handler.handleAccept(body, mockRespond);

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        'U_NEW',
        expect.stringContaining('승인'),
        expect.any(Object),
      );
    });

    it('rejects non-admin', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const body = makeBody('accept_user', 'U_NEW', 'U_NON_ADMIN');
      await handler.handleAccept(body, mockRespond);

      expect(userSettingsStore.acceptUser).not.toHaveBeenCalled();
    });

    it('is idempotent for already-accepted user', async () => {
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U_NEW',
        accepted: true,
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6' as any,
        lastUpdated: '',
      });
      const body = makeBody('accept_user', 'U_NEW');
      await handler.handleAccept(body, mockRespond);

      // Should still work (idempotent)
      expect(mockRespond).toHaveBeenCalled();
    });
  });

  // ── Scenario 5: Deny via Button ──
  describe('handleDeny', () => {
    it('removes user settings', async () => {
      const body = makeBody('deny_user', 'U_NEW');
      await handler.handleDeny(body, mockRespond);

      expect(userSettingsStore.removeUserSettings).toHaveBeenCalledWith('U_NEW');
    });

    it('updates admin DM', async () => {
      const body = makeBody('deny_user', 'U_NEW');
      await handler.handleDeny(body, mockRespond);

      expect(mockRespond).toHaveBeenCalledWith(
        expect.objectContaining({
          replace_original: true,
        }),
      );
    });

    it('notifies denied user', async () => {
      const body = makeBody('deny_user', 'U_NEW');
      await handler.handleDeny(body, mockRespond);

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        'U_NEW',
        expect.stringContaining('거부'),
        expect.any(Object),
      );
    });

    it('rejects non-admin', async () => {
      vi.mocked(isAdminUser).mockReturnValue(false);
      const body = makeBody('deny_user', 'U_NEW', 'U_NON_ADMIN');
      await handler.handleDeny(body, mockRespond);

      expect(userSettingsStore.removeUserSettings).not.toHaveBeenCalled();
    });
  });
});
