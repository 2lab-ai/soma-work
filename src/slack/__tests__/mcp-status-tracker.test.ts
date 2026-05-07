import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpCallTracker } from '../../mcp-call-tracker';
import { McpStatusDisplay, type StatusUpdateConfig } from '../mcp-status-tracker';
import type { SlackApiHelper } from '../slack-api-helper';

// Mock SlackApiHelper
const createMockSlackApi = () => ({
  postMessage: vi.fn().mockResolvedValue({ ts: '123.456', channel: 'C123' }),
  updateMessage: vi.fn().mockResolvedValue(undefined),
});

// Mock McpCallTracker
const createMockMcpCallTracker = () => ({
  getElapsedTime: vi.fn().mockReturnValue(5000),
  getPredictedDuration: vi.fn().mockReturnValue(null),
});

// Helper to create config
function mcpConfig(serverName: string, toolName: string, paramsSummary?: string): StatusUpdateConfig {
  return {
    displayType: 'MCP',
    displayLabel: `${serverName} → ${toolName}`,
    initialDelay: 0,
    predictKey: { serverName, toolName },
    paramsSummary,
  };
}

function subagentConfig(label: string): StatusUpdateConfig {
  return {
    displayType: 'Subagent',
    displayLabel: label,
    initialDelay: 0,
    predictKey: { serverName: '_subagent', toolName: label },
  };
}

describe('McpStatusDisplay', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let mockMcpCallTracker: ReturnType<typeof createMockMcpCallTracker>;
  let display: McpStatusDisplay;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSlackApi = createMockSlackApi();
    mockMcpCallTracker = createMockMcpCallTracker();
    display = new McpStatusDisplay(
      mockSlackApi as unknown as SlackApiHelper,
      mockMcpCallTracker as unknown as McpCallTracker,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerCall', () => {
    it('should register a call and start a session tick', () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      expect(display.getActiveCount()).toBe(1);
    });

    it('should register multiple calls in the same session', () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      expect(display.getActiveCount()).toBe(2);
    });

    it('should reuse session tick for same session', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      // Issue #794 — first registerCall fires an immediate enqueued tick;
      // the second one joins the existing session and does NOT post again.
      // Drain microtasks (no timer advance) so the immediate tick lands.
      await vi.advanceTimersByTimeAsync(0);

      // Only 1 postMessage from the immediate render — second call joined.
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
    });

    it('should create separate ticks for different sessions', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session2', 'call2', mcpConfig('jira', 'search'), 'C456', '222.333');

      // Issue #794 — each session's first registerCall fires its own
      // immediate render. Drain microtasks rather than waiting 10s.
      await vi.advanceTimersByTimeAsync(0);

      // Each session gets its own message
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(2);
    });

    it('should post initial message immediately on register (issue #794)', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // Drain microtasks — no timer advance needed.
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
      expect(mockSlackApi.postMessage).toHaveBeenCalledWith('C123', expect.stringContaining('codex → search'), {
        threadTs: '111.222',
      });
    });

    it('should update message on subsequent ticks', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // First render is immediate (issue #794) — runs after microtasks drain.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);

      // Setinterval tick at +10s: update.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.updateMessage).toHaveBeenCalled();
    });

    it('should NOT post twice when same session registers a second call (issue #794 S16)', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      // Allow the first immediate tick to land before the second register.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);

      // Second register on same session — should join existing tick.
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');
      await vi.advanceTimersByTimeAsync(0);

      // Still 1 post — the second register did NOT trigger an extra
      // immediate render, it joined the live session.
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
      // updateMessage may or may not have fired depending on render
      // ordering — what matters is no extra `postMessage` for the
      // joined call.
    });

    // S16-tri — `tick.renderChain` poison-pill catch contract: a
    // synchronous throw inside `doTick` outside the inner Slack
    // try/catches (e.g. `getElapsedTime` in the timeout-check loop)
    // must be (a) caught synchronously on the same tick — never
    // escape as an unhandled rejection — (b) logged with sessionKey,
    // and (c) leave the chain alive so the next tick's render
    // proceeds. Pin so a future "drop the inner try/catch" refactor
    // would force a visible test failure rather than silently
    // disabling the session's progress UI for the rest of its life.
    it('S16-tri: synchronous throw inside doTick is logged and renderChain stays alive', async () => {
      const warnSpy = vi.spyOn((display as any).logger, 'warn');
      let throwOnce = true;
      mockMcpCallTracker.getElapsedTime.mockImplementation(() => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('synthetic doTick failure');
        }
        return 5000;
      });

      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      // Immediate tick fires → throws inside doTick → caught by inner
      // try/catch → logger.warn fires → renderChain stays resolved.
      await vi.advanceTimersByTimeAsync(0);

      expect(warnSpy).toHaveBeenCalledWith(
        'mcp render tick failed (chain kept alive)',
        expect.objectContaining({ sessionKey: 'session1', error: 'synthetic doTick failure' }),
      );

      // setInterval tick at +10s → fresh doTick runs and lands a
      // postMessage, proving the chain is still accepting work.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.postMessage).toHaveBeenCalled();
    });

    // S16-bis — direct serialization probe for `tick.renderChain`. The
    // S16 test only counts calls; this one pins the contract that two
    // back-to-back ticks NEVER overlap a Slack API call. A future
    // refactor that drops `.then(() => this.doTick(tick))` chaining
    // (e.g. `void this.doTick(tick)`) would pass S16 but fail this.
    it('S16-bis: tick.renderChain serializes back-to-back ticks (no concurrent Slack calls)', async () => {
      // Manually-controlled deferred for the FIRST postMessage. The
      // chain must not invoke the second render path until this resolves.
      let resolveFirstPost!: (v: { ts: string; channel: string }) => void;
      const firstPost = new Promise<{ ts: string; channel: string }>((resolve) => {
        resolveFirstPost = resolve;
      });

      let postCallCount = 0;
      mockSlackApi.postMessage.mockImplementation(() => {
        postCallCount++;
        if (postCallCount === 1) return firstPost;
        // Defensive: no test path should reach here — second render must
        // hit `updateMessage` once `messageTs` is assigned by the first.
        return Promise.resolve({ ts: 'unexpected', channel: 'C123' });
      });

      // Fire the first immediate tick via registerCall.
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      // Drain microtasks but keep the first postMessage pending.
      await vi.advanceTimersByTimeAsync(0);
      expect(postCallCount).toBe(1);
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();

      // Race-attempt: complete the call mid-flight and advance the
      // setInterval — the second render path is now enqueued but MUST
      // wait for the first postMessage to resolve. Without renderChain
      // chaining, `updateMessage` would fire here on the un-set messageTs.
      display.completeCall('call1', 5000);
      await vi.advanceTimersByTimeAsync(10_000);

      // Still only one Slack call in flight (the original post). No
      // concurrent updateMessage interleaved.
      expect(postCallCount).toBe(1);
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();

      // Resolve the first postMessage; the chained tick can now run.
      resolveFirstPost({ ts: '123.456', channel: 'C123' });
      await vi.advanceTimersByTimeAsync(0);

      // Second render landed via updateMessage (messageTs is now set).
      // postCallCount must remain 1 — exactly one post per session.
      expect(postCallCount).toBe(1);
      expect(mockSlackApi.updateMessage).toHaveBeenCalled();
    });
  });

  describe('completeCall', () => {
    it('should mark a call as completed', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.completeCall('call1', 5000);

      // Should still be in active count until tick renders and cleans up
      // After tick, all completed → tick stops
      await vi.advanceTimersByTimeAsync(10_000);

      // Completion text should include green indicator
      const postText = mockSlackApi.postMessage.mock.calls[0]?.[1] ?? '';
      expect(postText).toContain('🟢');
    });

    it('should be no-op for unknown callId', () => {
      // Should not throw
      expect(() => display.completeCall('unknown', 5000)).not.toThrow();
    });

    it('should stop tick when all calls complete', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      display.completeCall('call1', 3000);
      display.completeCall('call2', 5000);

      // First tick renders final state
      await vi.advanceTimersByTimeAsync(10_000);

      // Reset mocks to check no more ticks
      mockSlackApi.postMessage.mockClear();
      mockSlackApi.updateMessage.mockClear();

      // Advance more time — should have no more API calls
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();
    });

    it('should fall back to startTime-based elapsed when duration is null', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // Issue #794 — first render is immediate (running state). Drain
      // microtasks so the immediate tick lands, then sleep 5s before
      // completion so the startTime-based fallback can resolve to 5s.
      await vi.advanceTimersByTimeAsync(5000);

      // Abort / untracked path: duration comes through as null
      display.completeCall('call1', null);

      // setInterval fires at +10s → updateMessage with the completed state.
      await vi.advanceTimersByTimeAsync(10_000);

      // Final state lives on updateMessage (the immediate post showed
      // the running state), so assert against the last update.
      const updateText = mockSlackApi.updateMessage.mock.lastCall?.[2] ?? '';
      expect(updateText).toContain('🟢');
      expect(updateText).toContain('5.0s');
    });

    it('should preserve explicit duration=0 (do not fall back on 0)', async () => {
      // Regression guard: `duration ?? fallback` must treat 0 as a real value,
      // unlike `duration || fallback` which would clobber 0.
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // Advance 4s, then report a 0ms duration (e.g. cached response).
      await vi.advanceTimersByTimeAsync(4000);
      display.completeCall('call1', 0);

      await vi.advanceTimersByTimeAsync(10_000);

      // Final completion render lands on updateMessage (issue #794:
      // immediate first post already happened with the running state).
      const updateText = mockSlackApi.updateMessage.mock.lastCall?.[2] ?? '';
      expect(updateText).toContain('0ms');
      expect(updateText).not.toContain('4.0s');
    });

    it('should show elapsed for every call in multi-call session even when one is null', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(3000);

      display.completeCall('call1', null); // fallback to 3s
      display.completeCall('call2', 7000); // explicit

      await vi.advanceTimersByTimeAsync(10_000);

      // Issue #794 — final completion text is on updateMessage (post #1
      // was the immediate render at t=0).
      const updateText = mockSlackApi.updateMessage.mock.lastCall?.[2] ?? '';
      expect(updateText).toContain('3.0s'); // from startTime fallback
      expect(updateText).toContain('7.0s'); // from explicit duration
    });

    it('should render mixed state (some complete, some running)', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      display.completeCall('call1', 3000);

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('🟢'); // completed call
      expect(postText).toContain('⏳'); // running call
      expect(postText).toContain('1/2 완료');
    });
  });

  describe('cleanupSession', () => {
    it('should remove all calls and stop tick for a session', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      // Drain immediate-tick microtasks first (issue #794 — first
      // render is enqueued on registerCall).
      await vi.advanceTimersByTimeAsync(0);

      display.cleanupSession('session1');

      expect(display.getActiveCount()).toBe(0);

      // No ticks should fire
      mockSlackApi.postMessage.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
    });

    it('should not affect other sessions', () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session2', 'call2', mcpConfig('jira', 'search'), 'C456', '222.333');

      display.cleanupSession('session1');

      expect(display.getActiveCount()).toBe(1);
    });

    it('should be no-op for unknown session', () => {
      expect(() => display.cleanupSession('unknown')).not.toThrow();
    });
  });

  describe('adaptive interval', () => {
    it('should use 10s interval for calls < 1 minute old', async () => {
      mockMcpCallTracker.getElapsedTime.mockReturnValue(30_000); // 30s
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // Immediate render is the first post (issue #794). setInterval
      // ticks at +10s/+20s issue updates.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
      expect(mockSlackApi.updateMessage).toHaveBeenCalledTimes(1);

      // Second setInterval tick at +20s — another update.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
      expect(mockSlackApi.updateMessage).toHaveBeenCalledTimes(2);
    });

    it('should use 30s interval for calls 1-10 minutes old', async () => {
      mockMcpCallTracker.getElapsedTime.mockReturnValue(120_000); // 2 min
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // First tick at 10s (initial interval)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);

      // After interval adjustment to 30s, no update at 20s
      mockSlackApi.updateMessage.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();

      // Update at 30s from adjustment
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mockSlackApi.updateMessage).toHaveBeenCalled();
    });
  });

  describe('2-hour hard timeout', () => {
    it('should mark calls as timed_out after 2 hours', async () => {
      // Set elapsed to just over 2 hours
      mockMcpCallTracker.getElapsedTime.mockReturnValue(7_200_001);
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0]?.[1] ?? '';
      expect(postText).toContain('타임아웃');
    });

    it('should stop tick after all calls timeout', async () => {
      mockMcpCallTracker.getElapsedTime.mockReturnValue(7_200_001);
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      mockSlackApi.postMessage.mockClear();
      mockSlackApi.updateMessage.mockClear();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();
    });
  });

  describe('consolidated rendering', () => {
    it('should render all-completed state', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', subagentConfig('Explorer'), 'C123', '111.222');

      display.completeCall('call1', 3000);
      display.completeCall('call2', 5000);

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('2개 작업 완료');
      expect(postText).toContain('🟢');
    });

    it('should render mixed running/completed state', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', subagentConfig('Explorer'), 'C123', '111.222');

      display.completeCall('call1', 3000);

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('2개 작업 실행 중');
      expect(postText).toContain('1/2 완료');
      expect(postText).toContain('⏳ Explorer');
      expect(postText).toContain('🟢 codex → search');
    });

    it('should show timed_out entries', async () => {
      mockMcpCallTracker.getElapsedTime.mockReturnValue(7_200_001);
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('⏱️');
      expect(postText).toContain('타임아웃');
    });

    it('should include paramsSummary in rendered text', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search', '(query: hello)'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('(query: hello)');
    });

    it('should include progress bar when prediction is available', async () => {
      mockMcpCallTracker.getPredictedDuration.mockReturnValue(60000);
      mockMcpCallTracker.getElapsedTime.mockReturnValue(30000);

      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('█');
      expect(postText).toContain('░');
    });

    it('should show duration for completed calls', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.completeCall('call1', 5000);

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('5.0s');
    });

    it('should only make 1 API call per tick', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call3', subagentConfig('Explorer'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      // Only 1 postMessage for all 3 calls
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('getActiveCount', () => {
    it('should return number of running calls', () => {
      expect(display.getActiveCount()).toBe(0);

      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      expect(display.getActiveCount()).toBe(1);

      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');
      expect(display.getActiveCount()).toBe(2);

      display.completeCall('call1', 1000);
      // Completed calls are still counted until tick cleanup
      // They should not be counted in active
      expect(display.getActiveCount()).toBe(1);
    });
  });

  /**
   * Issue #688 — BashBG displayType uses a custom single-line render so
   * the tracker's running-state text matches the S7 acceptance copy
   * ("⏳ Running in background — <cmd> (Ns)"). Non-BashBG displayTypes
   * must keep the original multi-line render.
   */
  describe('BashBG displayType (issue #688)', () => {
    function bashBgConfig(label: string): StatusUpdateConfig {
      return {
        displayType: 'BashBG',
        displayLabel: label,
        initialDelay: 0,
        predictKey: { serverName: '_bash_bg', toolName: 'bash' },
        paramsSummary: '',
      };
    }

    it('renders "⏳ Running in background — <label> (Ns)" for running BashBG', async () => {
      mockMcpCallTracker.getElapsedTime.mockReturnValue(7000);
      display.registerCall('session1', 'call_bg', bashBgConfig('`sleep 10`'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('⏳ Running in background');
      expect(postText).toContain('`sleep 10`');
      expect(postText).toMatch(/\(\d+s\)/);
      // should NOT carry the default Korean multi-line "실행 중" header
      expect(postText).not.toContain('실행 중:');
    });

    it('does not break when a BashBG call is one of many (multi-call header path)', async () => {
      display.registerCall('session1', 'call_mcp', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call_bg', bashBgConfig('`sleep 10`'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      // 1 API call — consolidated. BashBG shows up on its line via
      // the existing renderCallLine path; the text must render without
      // throwing and must contain both entries.
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('codex → search');
      expect(postText).toContain('`sleep 10`');
    });

    it('non-BashBG types keep their original single-call multi-line render (regression)', async () => {
      display.registerCall('session1', 'call_mcp', mcpConfig('codex', 'search'), 'C123', '111.222');
      await vi.advanceTimersByTimeAsync(10_000);
      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      // Canonical multi-line "실행 중" header from buildRunningText must
      // still appear for plain MCP
      expect(postText).toContain('실행 중:');
    });
  });

  /**
   * Issue #794 — `flushSession` is the awaitable final-render fence
   * called by `ToolEventProcessor.cleanup`. Caller-side contract:
   *   1. Mark every active callId as completed
   *      (`completeCall(id, null)`) BEFORE invoking flushSession.
   *   2. `await flushSession(sessionKey)` — drains the render chain
   *      (so any in-flight tick lands first), enqueues a final tick,
   *      tears the session down only when no `running` entries remain.
   */
  describe('flushSession (issue #794)', () => {
    it('S17: flushSession after completeCall renders final state and tears session down', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      // Allow the immediate render to land before we mark completed.
      await vi.advanceTimersByTimeAsync(0);
      const postCallsBefore = mockSlackApi.postMessage.mock.calls.length;

      display.completeCall('call1', 4321);
      await display.flushSession('session1');

      // After flushSession the active count is 0 — entries cleared.
      expect(display.getActiveCount()).toBe(0);

      // Final render must mention the completion marker. It lands on
      // either postMessage (if the immediate render was the very first
      // call) or updateMessage (subsequent flush). Combine both surfaces
      // and check the last text reflects the completion.
      const lastUpdate = mockSlackApi.updateMessage.mock.lastCall?.[2] ?? '';
      const lastPost = mockSlackApi.postMessage.mock.calls[postCallsBefore]?.[1] ?? '';
      const lastText = lastUpdate || lastPost;
      expect(lastText).toContain('🟢');

      // Session tick is gone — no further ticks after we advance time.
      mockSlackApi.postMessage.mockClear();
      mockSlackApi.updateMessage.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();
    });

    it('S12: flushSession is idempotent — second call is a no-op', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      await vi.advanceTimersByTimeAsync(0);
      display.completeCall('call1', 1000);

      await display.flushSession('session1');
      // Second flush — must not throw, must not re-post.
      mockSlackApi.postMessage.mockClear();
      mockSlackApi.updateMessage.mockClear();
      await display.flushSession('session1');
      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();
    });

    it('flushSession on unknown session is a no-op', async () => {
      await expect(display.flushSession('does-not-exist')).resolves.toBeUndefined();
      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();
    });

    it('flushSession leaves tick alive when running calls remain (turn-replacement guard)', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      await vi.advanceTimersByTimeAsync(0);

      // Caller forgot to completeCall — flushSession should NOT tear the
      // tick down because a running call remains. The next setInterval
      // tick (or a later flush) cleans up.
      await display.flushSession('session1');

      expect(display.getActiveCount()).toBe(1);
    });
  });

  describe('adaptive prediction rendering', () => {
    it('should show adaptive indicator when elapsed exceeds predicted', async () => {
      mockMcpCallTracker.getPredictedDuration.mockReturnValue(34800); // 34.8s
      mockMcpCallTracker.getElapsedTime.mockReturnValue(40000); // 40s elapsed

      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('🐢');
      expect(postText).toContain('→');
    });

    it('should not adapt when elapsed is within predicted time', async () => {
      mockMcpCallTracker.getPredictedDuration.mockReturnValue(60000); // 60s
      mockMcpCallTracker.getElapsedTime.mockReturnValue(30000); // 30s

      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).not.toContain('🐢');
    });
  });
});
