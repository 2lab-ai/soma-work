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

    // #689 P4 Part 2: permanent failure (missing_scope / not_allowed_token_type
    // / invalid_auth) disables + best-effort clear. `not_allowed` is per-thread
    // and NOT a disable trigger anymore — see separate non-clamp test below.
    it('should auto-disable on permanent failure and best-effort clear', async () => {
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
        Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }),
      );

      await manager.setStatus('C123', '123.456', 'is thinking...');
      expect(manager.isEnabled()).toBe(false);

      // Expect 2 calls: the failing first call + the best-effort fallback clear
      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(2);
      expect(mockSlackApi.setAssistantStatus).toHaveBeenNthCalledWith(1, 'C123', '123.456', 'is thinking...');
      expect(mockSlackApi.setAssistantStatus).toHaveBeenNthCalledWith(2, 'C123', '123.456', '');

      // Subsequent calls should be no-ops
      mockSlackApi.setAssistantStatus.mockClear();
      await manager.setStatus('C123', '123.456', 'is working...');
      expect(mockSlackApi.setAssistantStatus).not.toHaveBeenCalled();
    });

    // #689 P4 Part 2 — token-lifecycle codes (token_revoked / token_expired /
    // account_inactive) are permanent and MUST disable the manager
    // process-wide, same as scope/auth failures.
    it('should auto-disable on token_revoked (permanent token-lifecycle)', async () => {
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
        Object.assign(new Error('token_revoked'), { data: { error: 'token_revoked' } }),
      );

      await manager.setStatus('C123', '123.456', 'is thinking...');
      expect(manager.isEnabled()).toBe(false);
    });

    it('should auto-disable on token_expired (permanent token-lifecycle)', async () => {
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
        Object.assign(new Error('token_expired'), { data: { error: 'token_expired' } }),
      );

      await manager.setStatus('C123', '123.456', 'is thinking...');
      expect(manager.isEnabled()).toBe(false);
    });

    it('should auto-disable on account_inactive (permanent token-lifecycle)', async () => {
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
        Object.assign(new Error('account_inactive'), { data: { error: 'account_inactive' } }),
      );

      await manager.setStatus('C123', '123.456', 'is thinking...');
      expect(manager.isEnabled()).toBe(false);
    });

    // #689 P4 Part 2 — per-thread `not_allowed` MUST NOT disable.
    it('should NOT disable on per-thread not_allowed (mixed-traffic protection)', async () => {
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
        Object.assign(new Error('not_allowed'), { data: { error: 'not_allowed' } }),
      );

      await manager.setStatus('C123', '123.456', 'is thinking...');
      expect(manager.isEnabled()).toBe(true);

      await manager.setStatus('C123', '123.456', 'is working...');
      // 1 failing + 1 retry (no best-effort clear because not disabled)
      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(2);
    });

    // #689 P4 Part 2 — transient (ratelimited/network) MUST NOT disable.
    it('should NOT disable on transient ratelimited failure', async () => {
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
        Object.assign(new Error('ratelimited'), { data: { error: 'ratelimited' } }),
      );

      await manager.setStatus('C123', '123.456', 'is thinking...');
      expect(manager.isEnabled()).toBe(true);

      await manager.setStatus('C123', '123.456', 'is working...');
      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(2);
    });

    it('should reroute empty string to clearStatus (no empty-string heartbeat)', async () => {
      const clearSpy = vi.spyOn(manager, 'clearStatus');

      await manager.setStatus('C123', '123.456', '');

      expect(clearSpy).toHaveBeenCalledWith('C123', '123.456');
      expect(clearSpy).toHaveBeenCalledTimes(1);
      // clearStatus hits slackApi exactly once with ''
      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(1);
      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C123', '123.456', '');
    });

    it('should reroute empty-string StatusDescriptor to clearStatus', async () => {
      const clearSpy = vi.spyOn(manager, 'clearStatus');

      await manager.setStatus('C123', '123.456', '');

      expect(clearSpy).toHaveBeenCalledWith('C123', '123.456');
      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(1);
      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C123', '123.456', '');
    });

    it('should evaluate resolver on initial call', async () => {
      const resolver = vi.fn(() => 'resolved-text-1');

      await manager.setStatus('C123', '123.456', resolver);

      expect(resolver).toHaveBeenCalledTimes(1);
      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C123', '123.456', 'resolved-text-1');
    });
  });

  describe('clearStatus', () => {
    it('should call setAssistantStatus with empty string', async () => {
      await manager.clearStatus('C123', '123.456');

      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C123', '123.456', '');
    });

    it('should not call when disabled', async () => {
      // Force disable by triggering error
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
        Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }),
      );
      await manager.setStatus('C123', '123.456', 'test');

      mockSlackApi.setAssistantStatus.mockClear();
      await manager.clearStatus('C123', '123.456');
      expect(mockSlackApi.setAssistantStatus).not.toHaveBeenCalled();
    });

    it('should skip when expectedEpoch does not match current epoch', async () => {
      const oldEpoch = manager.bumpEpoch('C123', '123.456'); // → 1
      manager.bumpEpoch('C123', '123.456'); // → 2 (newer turn)

      await manager.clearStatus('C123', '123.456', { expectedEpoch: oldEpoch });

      expect(mockSlackApi.setAssistantStatus).not.toHaveBeenCalled();
    });

    it('should proceed when expectedEpoch matches current epoch', async () => {
      const epoch = manager.bumpEpoch('C123', '123.456');

      await manager.clearStatus('C123', '123.456', { expectedEpoch: epoch });

      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C123', '123.456', '');
    });

    it('should isolate epoch per-thread (bump on one thread does not affect other)', async () => {
      const epochA = manager.bumpEpoch('C_A', 'tsA');
      manager.bumpEpoch('C_B', 'tsB'); // bumps B independently

      await manager.clearStatus('C_A', 'tsA', { expectedEpoch: epochA });

      expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C_A', 'tsA', '');
    });
  });

  describe('bumpEpoch', () => {
    it('should return monotonically increasing values per key', () => {
      expect(manager.bumpEpoch('C', 't')).toBe(1);
      expect(manager.bumpEpoch('C', 't')).toBe(2);
      expect(manager.bumpEpoch('C', 't')).toBe(3);
    });

    it('should track epochs independently per (channelId, threadTs)', () => {
      expect(manager.bumpEpoch('C1', 't1')).toBe(1);
      expect(manager.bumpEpoch('C2', 't2')).toBe(1);
      expect(manager.bumpEpoch('C1', 't1')).toBe(2);
      expect(manager.bumpEpoch('C2', 't2')).toBe(2);
    });
  });

  describe('registerBackgroundBashActive', () => {
    it('should increment counter and return unregister that decrements', () => {
      const unregister = manager.registerBackgroundBashActive('C', 't');

      expect(manager.getToolStatusText('Bash', undefined, 'C', 't')).toBe('is waiting on background shell...');

      unregister();
      expect(manager.getToolStatusText('Bash', undefined, 'C', 't')).toBe('is running commands...');
    });

    it('unregister should be idempotent', () => {
      const un1 = manager.registerBackgroundBashActive('C', 't');
      const un2 = manager.registerBackgroundBashActive('C', 't');

      un1();
      un1(); // idempotent — counter should still be 1 (from un2)

      expect(manager.getToolStatusText('Bash', undefined, 'C', 't')).toBe('is waiting on background shell...');

      un2();
      expect(manager.getToolStatusText('Bash', undefined, 'C', 't')).toBe('is running commands...');
    });

    it('should track counter per (channelId, threadTs) independently', () => {
      const unA = manager.registerBackgroundBashActive('C_A', 'tsA');

      expect(manager.getToolStatusText('Bash', undefined, 'C_A', 'tsA')).toBe('is waiting on background shell...');
      expect(manager.getToolStatusText('Bash', undefined, 'C_B', 'tsB')).toBe('is running commands...');

      unA();
    });
  });

  describe('buildBashStatus', () => {
    it('returns foreground text when no background bash active', () => {
      expect(manager.buildBashStatus('C', 't')).toBe('is running commands...');
    });

    it('returns background text when at least one background bash active', () => {
      const un = manager.registerBackgroundBashActive('C', 't');
      expect(manager.buildBashStatus('C', 't')).toBe('is waiting on background shell...');
      un();
    });
  });

  describe('setTitle', () => {
    it('should call slackApi.setAssistantTitle', async () => {
      await manager.setTitle('C123', '123.456', 'My Thread');

      expect(mockSlackApi.setAssistantTitle).toHaveBeenCalledWith('C123', '123.456', 'My Thread');
    });

    it('should not call when disabled', async () => {
      mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
        Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }),
      );
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

    it('should return background-shell text when Bash bg active on thread', () => {
      const un = manager.registerBackgroundBashActive('C', 't');
      expect(manager.getToolStatusText('Bash', undefined, 'C', 't')).toBe('is waiting on background shell...');
      un();
      expect(manager.getToolStatusText('Bash', undefined, 'C', 't')).toBe('is running commands...');
    });

    it('should fall back to static Bash text when channel/thread not provided', () => {
      // Register bg active but query without ch/ts
      const un = manager.registerBackgroundBashActive('C', 't');
      expect(manager.getToolStatusText('Bash')).toBe('is running commands...');
      un();
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

describe('AssistantStatusManager — descriptor resolver on heartbeat', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let manager: AssistantStatusManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSlackApi = createMockSlackApi();
    manager = new AssistantStatusManager(mockSlackApi as unknown as SlackApiHelper);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should re-invoke resolver on each heartbeat tick', async () => {
    let i = 0;
    const resolver = vi.fn(() => `tick-${++i}`);

    await manager.setStatus('C', 't', resolver);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C', 't', 'tick-1');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C', 't', 'tick-2');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(resolver).toHaveBeenCalledTimes(3);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C', 't', 'tick-3');
  });

  it('should reflect dynamic bg-bash counter via buildBashStatus resolver', async () => {
    const resolver = () => manager.buildBashStatus('C', 't');
    await manager.setStatus('C', 't', resolver);

    // Initially: no bg, foreground text
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C', 't', 'is running commands...');

    // Register bg and tick → resolver picks up new count
    const un = manager.registerBackgroundBashActive('C', 't');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C', 't', 'is waiting on background shell...');

    un();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C', 't', 'is running commands...');
  });
});

// #689 P4 Part 2/2 — markDisabledIfScopeMissing public API. Only permanent
// scope/auth codes flip `enabled=false`. `not_allowed` is per-thread and
// transient codes (ratelimited / internal_error / network) are non-fatal —
// neither should clamp the process-global manager.
describe('markDisabledIfScopeMissing (#689)', () => {
  let mockSlackApi: {
    setAssistantStatus: ReturnType<typeof vi.fn>;
    setAssistantTitle: ReturnType<typeof vi.fn>;
  };
  let manager: AssistantStatusManager;

  beforeEach(() => {
    mockSlackApi = {
      setAssistantStatus: vi.fn().mockResolvedValue(undefined),
      setAssistantTitle: vi.fn().mockResolvedValue(undefined),
    };
    manager = new AssistantStatusManager(mockSlackApi as unknown as SlackApiHelper);
  });

  it('missing_scope → enabled=false + clearAllHeartbeats + returns true', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');
    expect(manager.isEnabled()).toBe(true);

    const err = Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
    const result = manager.markDisabledIfScopeMissing(err);

    expect(result).toBe(true);
    expect(manager.isEnabled()).toBe(false);

    // After disable, subsequent setStatus should be no-op even on a fresh key
    mockSlackApi.setAssistantStatus.mockClear();
    await manager.setStatus('C456', '999.000', 'foo');
    expect(mockSlackApi.setAssistantStatus).not.toHaveBeenCalled();
  });

  it('not_allowed_token_type → enabled=false + returns true', () => {
    const err = Object.assign(new Error('scope'), { data: { error: 'not_allowed_token_type' } });
    expect(manager.markDisabledIfScopeMissing(err)).toBe(true);
    expect(manager.isEnabled()).toBe(false);
  });

  it('invalid_auth → enabled=false + returns true', () => {
    const err = Object.assign(new Error('auth'), { data: { error: 'invalid_auth' } });
    expect(manager.markDisabledIfScopeMissing(err)).toBe(true);
    expect(manager.isEnabled()).toBe(false);
  });

  it('not_allowed (per-thread) → enabled unchanged + returns false', () => {
    const err = Object.assign(new Error('not allowed'), { data: { error: 'not_allowed' } });
    expect(manager.markDisabledIfScopeMissing(err)).toBe(false);
    expect(manager.isEnabled()).toBe(true);
  });

  it('generic/transient error → enabled unchanged + returns false', () => {
    const transientErrs = [
      new Error('network timeout'),
      Object.assign(new Error('rl'), { data: { error: 'ratelimited' } }),
      Object.assign(new Error('ie'), { data: { error: 'internal_error' } }),
    ];
    for (const err of transientErrs) {
      expect(manager.markDisabledIfScopeMissing(err)).toBe(false);
    }
    expect(manager.isEnabled()).toBe(true);
  });

  it('already disabled → returns true without double clearAllHeartbeats', () => {
    const err = Object.assign(new Error('scope'), { data: { error: 'missing_scope' } });
    expect(manager.markDisabledIfScopeMissing(err)).toBe(true);
    expect(manager.isEnabled()).toBe(false);

    // Re-call: already disabled. Should return true (matcher matched) but
    // no state mutation. There are no heartbeats at this point, so the
    // idempotency is asserted by not throwing and by the return value.
    expect(manager.markDisabledIfScopeMissing(err)).toBe(true);
    expect(manager.isEnabled()).toBe(false);
  });
});
