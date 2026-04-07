import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { PluginUpdateActionHandler } from './plugin-update-action-handler';
import type { RespondFn } from './types';

// Mock admin-utils
vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn((id: string) => id === 'ADMIN_USER'),
}));

function makeBody(userId: string, value: string) {
  return {
    user: { id: userId },
    actions: [{ value }],
  };
}

function validValue(pluginName: string) {
  return JSON.stringify({ pluginName, failureCode: 'SECURITY_BLOCKED' });
}

describe('PluginUpdateActionHandler', () => {
  let handler: PluginUpdateActionHandler;
  let respond: Mock<RespondFn>;
  let mockForceRefresh: ReturnType<typeof vi.fn>;
  let mockGetPluginManager: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    respond = vi.fn<RespondFn>().mockResolvedValue(undefined);
    mockForceRefresh = vi.fn();
    mockGetPluginManager = vi.fn().mockReturnValue({
      forceRefresh: mockForceRefresh,
    });

    handler = new PluginUpdateActionHandler({
      mcpManager: { getPluginManager: mockGetPluginManager } as any,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // handleIgnore
  // -------------------------------------------------------------------------
  describe('handleIgnore', () => {
    it('rejects non-admin users', async () => {
      const body = makeBody('NORMAL_USER', validValue('test@market'));
      await handler.handleIgnore(body, respond);

      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          response_type: 'ephemeral',
          replace_original: false,
        }),
      );
    });

    it('accepts admin and replaces message', async () => {
      const body = makeBody('ADMIN_USER', validValue('superpowers@claude-plugins-official'));
      await handler.handleIgnore(body, respond);

      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          replace_original: true,
          text: expect.stringContaining('superpowers@claude-plugins-official'),
        }),
      );
    });

    it('handles invalid JSON payload gracefully', async () => {
      const body = makeBody('ADMIN_USER', 'not-json');
      await handler.handleIgnore(body, respond);

      // Should not throw, should not respond (silent fail with log)
      expect(respond).not.toHaveBeenCalled();
    });

    it('handles missing actions gracefully', async () => {
      const body = { user: { id: 'ADMIN_USER' }, actions: [] };
      await handler.handleIgnore(body, respond);

      expect(respond).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // handleForceUpdate
  // -------------------------------------------------------------------------
  describe('handleForceUpdate', () => {
    it('rejects non-admin users', async () => {
      const body = makeBody('NORMAL_USER', validValue('test@market'));
      await handler.handleForceUpdate(body, respond);

      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          response_type: 'ephemeral',
          replace_original: false,
        }),
      );
      expect(mockForceRefresh).not.toHaveBeenCalled();
    });

    it('handles missing plugin manager', async () => {
      mockGetPluginManager.mockReturnValue(null);
      const body = makeBody('ADMIN_USER', validValue('test@market'));
      await handler.handleForceUpdate(body, respond);

      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('not available'),
        }),
      );
    });

    it('calls forceRefresh with skipSecurityGate and reports success', async () => {
      const pluginName = 'superpowers@claude-plugins-official';
      mockForceRefresh.mockResolvedValue({
        details: [{ name: pluginName, status: 'updated', newSha: 'abc12345' }],
      });

      const body = makeBody('ADMIN_USER', validValue(pluginName));
      await handler.handleForceUpdate(body, respond);

      // Should call forceRefresh with skipSecurityGate for this plugin
      expect(mockForceRefresh).toHaveBeenCalledWith({
        [pluginName]: { skipSecurityGate: true },
      });

      // Should show progress then success (2 calls)
      expect(respond).toHaveBeenCalledTimes(2);
      const lastCall = respond.mock.calls[1][0];
      expect(lastCall.text).toContain('강제 업데이트 완료');
      expect(lastCall.text).toContain('abc12345');
    });

    it('reports failure when plugin still fails after force update', async () => {
      const pluginName = 'test@market';
      mockForceRefresh.mockResolvedValue({
        details: [{ name: pluginName, status: 'error', error: 'Download failed' }],
      });

      const body = makeBody('ADMIN_USER', validValue(pluginName));
      await handler.handleForceUpdate(body, respond);

      const lastCall = respond.mock.calls[1][0];
      expect(lastCall.text).toContain('강제 업데이트 실패');
      expect(lastCall.text).toContain('Download failed');
    });

    it('handles forceRefresh throwing an error', async () => {
      mockForceRefresh.mockRejectedValue(new Error('Network timeout'));

      const body = makeBody('ADMIN_USER', validValue('test@market'));
      await handler.handleForceUpdate(body, respond);

      const lastCall = respond.mock.calls[1][0];
      expect(lastCall.text).toContain('강제 업데이트 실패');
      expect(lastCall.text).toContain('Network timeout');
    });

    it('handles invalid JSON payload gracefully', async () => {
      const body = makeBody('ADMIN_USER', '{broken');
      await handler.handleForceUpdate(body, respond);

      expect(mockForceRefresh).not.toHaveBeenCalled();
    });
  });
});
