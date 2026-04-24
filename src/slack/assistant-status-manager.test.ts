import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #666 P4 kill-switch: default tests assume the native spinner is enabled.
// Tests that exercise the kill-switch explicitly mutate `mockConfig` below.
const mockConfig = vi.hoisted(() => ({
  ui: {
    fiveBlockPhase: 0,
    b4NativeStatusEnabled: true,
  },
}));
vi.mock('../config', () => ({ config: mockConfig }));

import { AssistantStatusManager } from './assistant-status-manager';
import type { SlackApiHelper } from './slack-api-helper';

const createMockSlackApi = () => ({
  setAssistantStatus: vi.fn().mockResolvedValue(undefined),
  setAssistantTitle: vi.fn().mockResolvedValue(undefined),
});

describe('AssistantStatusManager', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let manager: AssistantStatusManager;

  beforeEach(() => {
    mockSlackApi = createMockSlackApi();
    manager = new AssistantStatusManager(mockSlackApi as unknown as SlackApiHelper);
  });

  describe('setStatus', () => {
    it('should call slackApi.setAssistantStatus', async () => {
      await manager.setStatus('C123', '123.456', 'is thinking...');

      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C123', '123.456', 'is thinking...');
    });

    it('should auto-disable on first failure', async () => {
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
        Object.assign(new Error('not_allowed'), { data: { error: 'not_allowed' } }),
      );

      await manager.setStatus('C123', '123.456', 'is thinking...');
      expect(manager.isEnabled()).toBe(false);

      // Subsequent calls should be no-ops
      await manager.setStatus('C123', '123.456', 'is working...');
      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearStatus', () => {
    it('should call setAssistantStatus with empty string', async () => {
      await manager.clearStatus('C123', '123.456');

      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C123', '123.456', '');
    });

    it('should not call when disabled', async () => {
      // Force disable by triggering error
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(new Error('fail'));
      await manager.setStatus('C123', '123.456', 'test');

      mockSlackApi.setAssistantStatus.mockClear();
      await manager.clearStatus('C123', '123.456');
      expect(mockSlackApi.setAssistantStatus).not.toHaveBeenCalled();
    });
  });

  describe('setTitle', () => {
    it('should call slackApi.setAssistantTitle', async () => {
      await manager.setTitle('C123', '123.456', 'My Thread');

      expect(mockSlackApi.setAssistantTitle).toHaveBeenCalledWith('C123', '123.456', 'My Thread');
    });

    it('should not call when disabled', async () => {
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(new Error('fail'));
      await manager.setStatus('C123', '123.456', 'test');

      await manager.setTitle('C123', '123.456', 'Title');
      expect(mockSlackApi.setAssistantTitle).not.toHaveBeenCalled();
    });
  });

  describe('getToolStatusText', () => {
    it('should return tool-specific text for known tools', () => {
      expect(manager.getToolStatusText('Read')).toBe('is reading files...');
      expect(manager.getToolStatusText('Write')).toBe('is editing code...');
      expect(manager.getToolStatusText('Edit')).toBe('is editing code...');
      expect(manager.getToolStatusText('Bash')).toBe('is running commands...');
      expect(manager.getToolStatusText('Grep')).toBe('is searching...');
      expect(manager.getToolStatusText('Glob')).toBe('is searching...');
      expect(manager.getToolStatusText('WebSearch')).toBe('is researching...');
      expect(manager.getToolStatusText('WebFetch')).toBe('is researching...');
      expect(manager.getToolStatusText('Task')).toBe('is delegating to agent...');
    });

    it('should return generic text for unknown tools', () => {
      expect(manager.getToolStatusText('SomeUnknownTool')).toBe('is working...');
    });

    it('should return MCP server-specific text when serverName provided', () => {
      expect(manager.getToolStatusText('mcp__jira__search', 'jira')).toBe('is calling jira...');
    });
  });

  describe('isEnabled', () => {
    it('should be enabled by default', () => {
      expect(manager.isEnabled()).toBe(true);
    });
  });

  // #666 P4 Part 1/2 — B4 native spinner kill switch. Default is OFF so that
  // registering the Bolt Assistant container in Part 1 does not silently
  // activate spinner wiring before Part 2 is wired. Flip via
  // SOMA_UI_B4_NATIVE_STATUS=1 after Part 2 lands.
  describe('constructor — B4 native-status kill switch (#666)', () => {
    // Restore the flag to the tests' happy-path default so we don't leak into
    // other describes inside this file.
    afterEach(() => {
      mockConfig.ui.b4NativeStatusEnabled = true;
    });

    it('sets enabled=false when config.ui.b4NativeStatusEnabled is false (default off)', () => {
      mockConfig.ui.b4NativeStatusEnabled = false;
      const api = createMockSlackApi();
      const m = new AssistantStatusManager(api as unknown as SlackApiHelper);
      expect(m.isEnabled()).toBe(false);
    });

    it('leaves enabled=true when config.ui.b4NativeStatusEnabled is true (opt-in)', () => {
      mockConfig.ui.b4NativeStatusEnabled = true;
      const api = createMockSlackApi();
      const m = new AssistantStatusManager(api as unknown as SlackApiHelper);
      expect(m.isEnabled()).toBe(true);
    });

    it('setStatus is a no-op (no API call) when kill switch is off', async () => {
      mockConfig.ui.b4NativeStatusEnabled = false;
      const api = createMockSlackApi();
      const m = new AssistantStatusManager(api as unknown as SlackApiHelper);
      await m.setStatus('C123', '123.456', 'is thinking...');
      expect(api.setAssistantStatus).not.toHaveBeenCalled();
    });
  });
});
