import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #666 P4 kill-switch: heartbeat tests assume the native spinner is enabled.
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

describe('AssistantStatusManager — Heartbeat', () => {
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

  // ─── Scenario 1: Heartbeat Keepalive ───

  // Trace: Scenario 1, Section 3a — heartbeat 시작
  it('heartbeat_starts_on_setStatus', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');

    // Initial call
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(1);

    // Advance 20s — heartbeat tick should resend
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(2);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C123', '123.456', 'is thinking...');
  });

  // Trace: Scenario 1, Section 3b — tick 재전송
  it('heartbeat_resends_status_on_tick', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');

    // Advance 60s (3 ticks)
    await vi.advanceTimersByTimeAsync(60_000);
    // 1 initial + 3 heartbeat ticks = 4 total
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(4);
  });

  // ─── Scenario 2: Status Update Preserves Heartbeat ───

  // Trace: Scenario 2, Section 3a — lastStatus 갱신
  it('setStatus_updates_lastStatus_without_new_timer', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');
    await manager.setStatus('C123', '123.456', 'is reading files...');

    // 2 explicit calls
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(2);

    // Advance 20s — only 1 heartbeat tick (not 2 timers)
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(3); // 2 + 1 tick
  });

  // Trace: Scenario 2, Section 3b — tick이 최신 status 사용
  it('heartbeat_uses_latest_status', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');
    await manager.setStatus('C123', '123.456', 'is reading files...');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C123', '123.456', 'is reading files...');
  });

  // ─── Scenario 3: Clear Status Stops Heartbeat ───

  // Trace: Scenario 3, Section 3a — timer 정리
  it('clearStatus_stops_heartbeat_timer', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');
    await manager.clearStatus('C123', '123.456');

    mockSlackApi.setAssistantStatus.mockClear();

    // Advance 40s — no heartbeat ticks should fire
    await vi.advanceTimersByTimeAsync(40_000);
    expect(mockSlackApi.setAssistantStatus).not.toHaveBeenCalled();
  });

  // Trace: Scenario 3, Section 4 — Map 정리 (verified via no tick after clear)
  it('clearStatus_cleans_maps', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');
    await manager.clearStatus('C123', '123.456');

    // Start fresh status on same session — should work normally
    mockSlackApi.setAssistantStatus.mockClear();
    await manager.setStatus('C123', '123.456', 'is working...');

    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C123', '123.456', 'is working...');

    await vi.advanceTimersByTimeAsync(20_000);
    // 1 explicit + 1 heartbeat tick
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(2);
  });

  // Trace: Scenario 3, Section 5 — 타이머 없는 경우
  it('clearStatus_without_active_heartbeat', async () => {
    // Should not throw when clearing with no active heartbeat
    await expect(manager.clearStatus('C123', '123.456')).resolves.not.toThrow();
  });

  // ─── Scenario 4: Auto-Disable Kills Heartbeat ───

  // Trace: Scenario 4, Section 3a — 전역 disable
  it('heartbeat_failure_disables_and_cleans_all', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');

    // Make next API call fail (heartbeat tick)
    mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
      Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }),
    );

    await vi.advanceTimersByTimeAsync(20_000);

    // Manager should be disabled
    expect(manager.isEnabled()).toBe(false);

    mockSlackApi.setAssistantStatus.mockClear();

    // No further ticks
    await vi.advanceTimersByTimeAsync(40_000);
    expect(mockSlackApi.setAssistantStatus).not.toHaveBeenCalled();
  });

  // #689 P4 Part 2 — heartbeat transient failure MUST NOT disable the manager.
  it('heartbeat_transient_failure_keeps_manager_enabled', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');

    // First heartbeat tick fails with transient error, second recovers
    mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
      Object.assign(new Error('ratelimited'), { data: { error: 'ratelimited' } }),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(manager.isEnabled()).toBe(true);

    // Next tick fires and succeeds
    await vi.advanceTimersByTimeAsync(20_000);
    // 1 explicit + 2 heartbeat ticks (first failed transient, second ok)
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(3);
  });

  // disable transition should best-effort clear residual Slack spinner
  it('heartbeat_failure_best_effort_clears', async () => {
    await manager.setStatus('C123', '123.456', 'is thinking...');
    mockSlackApi.setAssistantStatus.mockClear();

    // Fail once (the tick) with a permanent error, subsequent calls (best-effort clear) succeed
    mockSlackApi.setAssistantStatus.mockRejectedValueOnce(
      Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } }),
    );

    await vi.advanceTimersByTimeAsync(20_000);

    // Expect: 1 failing tick + 1 best-effort clear with ''
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(2);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenNthCalledWith(1, 'C123', '123.456', 'is thinking...');
    expect(mockSlackApi.setAssistantStatus).toHaveBeenNthCalledWith(2, 'C123', '123.456', '');
  });

  // Setting empty status should not generate empty-string heartbeats
  it('setStatus_empty_string_does_not_start_empty_heartbeat', async () => {
    await manager.setStatus('C123', '123.456', '');

    // Should have called clearStatus path once (Slack API call with '')
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(1);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C123', '123.456', '');

    mockSlackApi.setAssistantStatus.mockClear();

    // Advance — no heartbeat should have been registered (clearStatus path)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSlackApi.setAssistantStatus).not.toHaveBeenCalled();
  });

  // descriptor with resolver: tick re-invokes resolver with latest state
  it('heartbeat_tick_reinvokes_descriptor_resolver', async () => {
    let counter = 0;
    const resolver = vi.fn(() => `tick-${++counter}`);

    await manager.setStatus('C123', '123.456', resolver);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C123', '123.456', 'tick-1');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C123', '123.456', 'tick-2');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenLastCalledWith('C123', '123.456', 'tick-3');

    expect(resolver).toHaveBeenCalledTimes(3);
  });

  // ─── Scenario 5: Multi-Session Independence ───

  // Trace: Scenario 5, Section 3a — 독립 타이머
  it('multi_session_independent_heartbeats', async () => {
    await manager.setStatus('C1', '1.0', 'is thinking...');
    await manager.setStatus('C2', '2.0', 'is working...');

    // 2 initial calls
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    // 2 initial + 2 heartbeat ticks = 4
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(4);
  });

  // Trace: Scenario 5, Section 3b — 부분 정리
  it('clearStatus_one_session_preserves_other', async () => {
    await manager.setStatus('C1', '1.0', 'is thinking...');
    await manager.setStatus('C2', '2.0', 'is working...');

    await manager.clearStatus('C1', '1.0');
    mockSlackApi.setAssistantStatus.mockClear();

    await vi.advanceTimersByTimeAsync(20_000);
    // Only session C2 heartbeat should tick
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledTimes(1);
    expect(mockSlackApi.setAssistantStatus).toHaveBeenCalledWith('C2', '2.0', 'is working...');
  });
});
