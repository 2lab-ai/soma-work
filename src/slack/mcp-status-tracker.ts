import { Logger } from '../logger';
import { McpCallTracker } from '../mcp-call-tracker';
import type { SlackApiHelper } from './slack-api-helper';

export interface StatusUpdateConfig {
  displayType: string; // "MCP", "Subagent", etc.
  displayLabel: string; // "codex → query", "General Purpose", etc.
  initialDelay: number; // ignored in session-tick model (kept for API compat)
  predictKey: { serverName: string; toolName: string };
  paramsSummary?: string; // compact params e.g. "(prompt: hello world)"
}

interface ActiveCallEntry {
  callId: string;
  sessionKey: string;
  config: StatusUpdateConfig;
  channel: string;
  threadTs: string;
  startTime: number;
  /**
   * Issue #816 — `failed` distinguishes a tool-result with `isError: true`
   * (the SDK actually saw a failure) from a `completed` happy path. The
   * Slack render must surface 🔴 for `failed` so the UI matches the
   * SDK-observed state — closing the split-brain gap reported in the
   * issue ("🟢 success" while the agent saw `Not connected`).
   */
  status: 'running' | 'completed' | 'failed' | 'timed_out';
  duration?: number;
  predicted: number | null;
}

interface SessionTick {
  sessionKey: string;
  channel: string;
  threadTs: string;
  messageTs: string | null;
  interval: NodeJS.Timeout | null;
  currentIntervalMs: number;
  /**
   * Issue #794 — serialized render queue. Every render path
   * (setInterval tick, immediate-on-register tick, `flushSession`)
   * enqueues onto this chain so Slack never sees interleaved
   * `postMessage`/`updateMessage` for the same session, and
   * `flushSession` can `await tick(tick)` to drain pending renders.
   */
  renderChain: Promise<void>;
}

const MCP_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

function getAdaptiveInterval(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 10_000;
  if (elapsedMs < 600_000) return 30_000;
  if (elapsedMs < 1_800_000) return 60_000;
  return 300_000;
}

/**
 * Session-level MCP status display.
 * Instead of per-call timers, uses a single tick per session
 * that renders all active calls in a consolidated message.
 * Maximum 1 Slack API call per tick.
 */
export class McpStatusDisplay {
  private logger = new Logger('McpStatusDisplay');
  private activeCalls: Map<string, ActiveCallEntry> = new Map();
  private sessionTicks: Map<string, SessionTick> = new Map();

  constructor(
    private slackApi: SlackApiHelper,
    private mcpCallTracker: McpCallTracker,
  ) {}

  /**
   * Register a new MCP/subagent call for session-level tracking.
   */
  registerCall(
    sessionKey: string,
    callId: string,
    config: StatusUpdateConfig,
    channel: string,
    threadTs: string,
  ): void {
    const predicted = this.mcpCallTracker.getPredictedDuration(
      config.predictKey.serverName,
      config.predictKey.toolName,
    );

    this.activeCalls.set(callId, {
      callId,
      sessionKey,
      config,
      channel,
      threadTs,
      startTime: Date.now(),
      status: 'running',
      predicted,
    });

    // Start session tick if needed
    if (!this.sessionTicks.has(sessionKey)) {
      const tick: SessionTick = {
        sessionKey,
        channel,
        threadTs,
        messageTs: null,
        interval: null,
        currentIntervalMs: 10_000,
        renderChain: Promise.resolve(),
      };
      this.sessionTicks.set(sessionKey, tick);
      this.startTick(tick);
      // Issue #794 — fire the first render synchronously (enqueued on
      // `renderChain`) so short-lived calls don't wait the full 10s
      // until the next setInterval before the user sees a progress
      // line. Subsequent `registerCall`s with the same `sessionKey`
      // hit the `has(sessionKey)` guard above and join the existing
      // tick — no extra `postMessage` round-trip.
      void this.tick(tick);
    }
  }

  /**
   * Mark a call as completed. Rendered on next tick.
   * If duration is null (e.g. abort path or untracked call), fall back
   * to startTime so the final render still shows real elapsed time.
   *
   * Issue #816 — `isError` is optional for backward compatibility (cleanup
   * sweeps in `ToolEventProcessor.cleanup` pass it as `undefined` so the
   * sweep semantics stay "treat as completed"). When `true`, the entry
   * flips to `failed` so the consolidated render surfaces 🔴 + a "실패"
   * header instead of a misleading "🟢 success".
   */
  completeCall(callId: string, duration: number | null, isError?: boolean): void {
    const entry = this.activeCalls.get(callId);
    if (!entry) return;

    const finalDuration = duration ?? Math.max(0, Date.now() - entry.startTime);
    this.activeCalls.set(callId, {
      ...entry,
      status: isError === true ? 'failed' : 'completed',
      duration: finalDuration,
    });
  }

  /**
   * Cleanup all calls and tick for a session.
   */
  cleanupSession(sessionKey: string): void {
    // Remove all calls for this session
    for (const [callId, entry] of this.activeCalls) {
      if (entry.sessionKey === sessionKey) {
        this.activeCalls.delete(callId);
      }
    }

    // Stop and remove tick
    const tick = this.sessionTicks.get(sessionKey);
    if (tick) {
      this.stopTick(tick);
      this.sessionTicks.delete(sessionKey);
    }
  }

  /**
   * Number of active (running) calls across all sessions.
   */
  getActiveCount(): number {
    let count = 0;
    for (const entry of this.activeCalls.values()) {
      if (entry.status === 'running') count++;
    }
    return count;
  }

  /**
   * Issue #794 — flush a session: drain the render chain (so any
   * in-flight tick has finished its `postMessage`/`updateMessage`),
   * enqueue one final tick to render the latest state, then — if no
   * `running` calls remain — tear the tick down. Idempotent: a second
   * call on the same `sessionKey` is a no-op once the tick is gone.
   *
   * Called by `ToolEventProcessor.cleanup(sessionKey, turnId)` AFTER
   * it has marked every active callId as completed. The order matters:
   *   1. completeCall → entry.status = 'completed' for each call.
   *   2. flushSession → tick reads the completed state and renders the
   *      "🟢 N개 작업 완료" / final allDone branch, then stops itself.
   *
   * Race-safety: `await this.tick(tick)` chains onto the existing
   * `renderChain`, so even if a `setInterval` tick fired moments
   * earlier, our enqueued tick runs after it. No interleaving with
   * Slack API calls.
   *
   * The final fallback `cleanupSession(sessionKey)` is gated on "no
   * remaining running calls" so a brand-new turn that registered a
   * call between our render and our fallback doesn't get its just-
   * registered tracker silently torn down. If running calls remain,
   * we leave the tick running — the next turn (or this one's later
   * cleanup) will re-flush.
   */
  async flushSession(sessionKey: string): Promise<void> {
    const tick = this.sessionTicks.get(sessionKey);
    if (!tick) return;
    // Drain the chain: in-flight tick (if any) → our enqueued tick →
    // we resolve. `doTick` handles the allDone teardown itself when
    // every entry is non-running.
    await this.tick(tick);
    if (this.sessionTicks.has(sessionKey)) {
      const remainingRunning = this.getSessionCalls(sessionKey).some((c) => c.status === 'running');
      if (!remainingRunning) {
        this.cleanupSession(sessionKey);
      }
      // Otherwise the setInterval keeps running — a new turn already
      // registered a call against the same session and owns the tick.
    }
  }

  // --- Private tick management ---

  private startTick(tick: SessionTick): void {
    tick.interval = setInterval(() => {
      void this.tick(tick);
    }, tick.currentIntervalMs);
  }

  private stopTick(tick: SessionTick): void {
    if (tick.interval) {
      clearInterval(tick.interval);
      tick.interval = null;
    }
  }

  /**
   * Issue #794 — public render-chain entry point. Every entry point
   * within this class (setInterval, registerCall's immediate first
   * tick, flushSession) goes through here so all renders for a
   * session serialize. The structure has two safeguards:
   *
   * 1. **Inner try/catch** wraps `doTick(tick)` so this tick's
   *    synchronous-or-async throw never escapes. Inner Slack I/O
   *    already has its own try/catch+`logger.warn`, so the only
   *    paths reaching here are unexpected throws inside `doTick`'s
   *    pure-CPU code (`getSessionCalls`/`computeMinInterval`/
   *    `buildConsolidatedText`). Logging-and-continuing here means
   *    a regression that adds a throwing path won't silently
   *    disable progress UI for the rest of the session, AND it
   *    cannot escape as an unhandled rejection between this tick
   *    and the next.
   * 2. **Front `.catch(() => {})`** swallows any latent rejection
   *    on the prior chain link (defense-in-depth — the inner
   *    try/catch should make this unreachable, but a future edit
   *    that reorders the chain shouldn't be able to break the
   *    poison-pill contract).
   */
  private tick(tick: SessionTick): Promise<void> {
    tick.renderChain = tick.renderChain
      .catch(() => {})
      .then(async () => {
        try {
          await this.doTick(tick);
        } catch (err) {
          this.logger.warn('mcp render tick failed (chain kept alive)', {
            sessionKey: tick.sessionKey,
            error: (err as Error)?.message ?? String(err),
          });
        }
      });
    return tick.renderChain;
  }

  private async doTick(tick: SessionTick): Promise<void> {
    const calls = this.getSessionCalls(tick.sessionKey);
    if (calls.length === 0) {
      this.stopTick(tick);
      this.sessionTicks.delete(tick.sessionKey);
      return;
    }

    // Check timeouts
    for (const call of calls) {
      if (call.status !== 'running') continue;
      const elapsed = this.mcpCallTracker.getElapsedTime(call.callId);
      const elapsedMs = elapsed ?? Date.now() - call.startTime;
      if (elapsedMs >= MCP_TIMEOUT_MS) {
        this.activeCalls.set(call.callId, { ...call, status: 'timed_out' });
        this.logger.warn('MCP call timed out', { callId: call.callId, elapsed: elapsedMs });
      }
    }

    // Re-fetch after timeout mutations
    const updatedCalls = this.getSessionCalls(tick.sessionKey);
    const allDone = updatedCalls.every((c) => c.status !== 'running');

    // Compute adaptive interval from running calls
    if (!allDone) {
      const minInterval = this.computeMinInterval(updatedCalls);
      if (minInterval !== tick.currentIntervalMs) {
        this.stopTick(tick);
        tick.currentIntervalMs = minInterval;
        tick.interval = setInterval(() => {
          void this.tick(tick);
        }, tick.currentIntervalMs);
      }
    }

    // Render consolidated message
    const statusText = this.buildConsolidatedText(updatedCalls);

    if (!tick.messageTs) {
      try {
        const result = await this.slackApi.postMessage(tick.channel, statusText, { threadTs: tick.threadTs });
        if (result.ts) {
          tick.messageTs = result.ts;
        }
      } catch (error) {
        this.logger.warn('Failed to create session status message', error);
      }
    } else {
      try {
        await this.slackApi.updateMessage(tick.channel, tick.messageTs, statusText);
      } catch (error) {
        this.logger.warn('Failed to update session status message', error);
      }
    }

    // All done → final render complete, stop tick and remove entries
    if (allDone) {
      this.stopTick(tick);
      this.sessionTicks.delete(tick.sessionKey);
      for (const call of updatedCalls) {
        this.activeCalls.delete(call.callId);
      }
    }
  }

  private getSessionCalls(sessionKey: string): ActiveCallEntry[] {
    const calls: ActiveCallEntry[] = [];
    for (const entry of this.activeCalls.values()) {
      if (entry.sessionKey === sessionKey) {
        calls.push(entry);
      }
    }
    return calls;
  }

  private computeMinInterval(calls: ActiveCallEntry[]): number {
    let minInterval = 300_000;
    for (const call of calls) {
      if (call.status !== 'running') continue;
      const elapsed = this.mcpCallTracker.getElapsedTime(call.callId);
      const elapsedMs = elapsed ?? Date.now() - call.startTime;
      const interval = getAdaptiveInterval(elapsedMs);
      if (interval < minInterval) {
        minInterval = interval;
      }
    }
    return minInterval;
  }

  // --- Rendering ---

  private buildConsolidatedText(calls: ActiveCallEntry[]): string {
    const total = calls.length;
    const completed = calls.filter((c) => c.status === 'completed').length;
    const failed = calls.filter((c) => c.status === 'failed').length;
    const timedOut = calls.filter((c) => c.status === 'timed_out').length;
    // Issue #816 — `failed` counts toward "done" so the tick can stop, but
    // it must NOT count toward the all-clean header below.
    const allDone = completed + failed + timedOut === total;

    let header: string;
    if (allDone && timedOut === 0 && failed === 0) {
      // All-clean only when zero failures and zero timeouts.
      header = total === 1 ? `🟢 작업 완료` : `🟢 ${total}개 작업 완료`;
    } else if (allDone) {
      // Mixed/all-bad termination — surface counts so the user sees how
      // many tools actually failed vs. timed out vs. succeeded.
      header = `📊 ${total}개 작업 종료 (${completed} 완료, ${failed} 실패, ${timedOut} 타임아웃)`;
    } else {
      header = `📊 ${total}개 작업 실행 중 (${completed}/${total} 완료)`;
    }

    // For single call, skip header redundancy
    if (total === 1) {
      const call = calls[0];
      return this.renderSingleCallText(call);
    }

    const lines = calls.map((call) => this.renderCallLine(call));

    return `${header}\n\n${lines.join('\n')}`;
  }

  private renderSingleCallText(call: ActiveCallEntry): string {
    const params = call.config.paramsSummary ? ` ${call.config.paramsSummary}` : '';

    // Issue #688 — Bash background calls get a single-line running
    // format so the tracker's output aligns with the S7 acceptance text
    // ("⏳ Running in background — <cmd> (Ns)"). Completion/timeout
    // reuse the generic formatting below.
    if (call.status === 'running' && call.config.displayType === 'BashBG') {
      const elapsed = this.mcpCallTracker.getElapsedTime(call.callId);
      const elapsedMs = elapsed ?? Date.now() - call.startTime;
      const seconds = Math.round(elapsedMs / 1000);
      return `⏳ Running in background — ${call.config.displayLabel} (${seconds}s)`;
    }

    if (call.status === 'completed') {
      let text = `🟢 *${call.config.displayType} 완료: ${call.config.displayLabel}*${params}`;
      if (call.duration !== undefined) {
        text += ` (${McpCallTracker.formatDuration(call.duration)})`;
      }
      return text;
    }

    // Issue #816 — `failed` mirrors the `completed` shape but with 🔴 +
    // "실패" so the user immediately sees the SDK-reported failure
    // instead of a misleading happy-path "🟢 완료".
    if (call.status === 'failed') {
      let text = `🔴 *${call.config.displayType} 실패: ${call.config.displayLabel}*${params}`;
      if (call.duration !== undefined) {
        text += ` (${McpCallTracker.formatDuration(call.duration)})`;
      }
      return text;
    }

    if (call.status === 'timed_out') {
      return `⏱️ *${call.config.displayType} 타임아웃: ${call.config.displayLabel}*${params} (2시간+)`;
    }

    // Running
    const elapsed = this.mcpCallTracker.getElapsedTime(call.callId);
    const elapsedMs = elapsed ?? Date.now() - call.startTime;
    return this.buildRunningText(call, elapsedMs);
  }

  private renderCallLine(call: ActiveCallEntry): string {
    const params = call.config.paramsSummary ? ` ${call.config.paramsSummary}` : '';

    if (call.status === 'completed') {
      let line = `🟢 ${call.config.displayLabel}${params}`;
      if (call.duration !== undefined) {
        line += ` (${McpCallTracker.formatDuration(call.duration)})`;
      }
      return line;
    }

    // Issue #816 — `failed` per-line marker. Mirrors the completed branch
    // so the multi-call rendering stays grid-aligned, only the leading
    // emoji + (optional) tag flips.
    if (call.status === 'failed') {
      let line = `🔴 ${call.config.displayLabel}${params}`;
      if (call.duration !== undefined) {
        line += ` (${McpCallTracker.formatDuration(call.duration)})`;
      }
      return line;
    }

    if (call.status === 'timed_out') {
      return `⏱️ ${call.config.displayLabel}${params} (타임아웃)`;
    }

    // Running
    const elapsed = this.mcpCallTracker.getElapsedTime(call.callId);
    const elapsedMs = elapsed ?? Date.now() - call.startTime;
    let line = `⏳ ${call.config.displayLabel}${params} — ${McpCallTracker.formatDuration(elapsedMs)}`;

    if (call.predicted !== null && call.predicted > 0) {
      const adaptive = McpCallTracker.computeAdaptivePrediction(elapsedMs, call.predicted);
      const progress = Math.min(100, (elapsedMs / adaptive.predicted) * 100);
      if (adaptive.wasAdjusted) {
        line += McpStatusDisplay.formatAdaptiveIndicator(adaptive.originalPredicted, adaptive.predicted);
      }
      const barLen = 20;
      const filled = Math.round((progress / 100) * barLen);
      const empty = barLen - filled;
      line += ` \`${'█'.repeat(filled)}${'░'.repeat(empty)}\``;
    }

    return line;
  }

  private buildRunningText(call: ActiveCallEntry, elapsedMs: number): string {
    const params = call.config.paramsSummary ? ` ${call.config.paramsSummary}` : '';
    let statusText = `⏳ *${call.config.displayType} 실행 중: ${call.config.displayLabel}*${params}`;
    statusText += `\n경과 시간: ${McpCallTracker.formatDuration(elapsedMs)}`;

    if (call.predicted !== null && call.predicted > 0) {
      const adaptive = McpCallTracker.computeAdaptivePrediction(elapsedMs, call.predicted);
      const remaining = Math.max(0, adaptive.predicted - elapsedMs);
      const progress = Math.min(100, (elapsedMs / adaptive.predicted) * 100);

      statusText += `\n예상 시간: ${McpCallTracker.formatDuration(adaptive.predicted)}`;
      if (adaptive.wasAdjusted) {
        statusText += McpStatusDisplay.formatAdaptiveIndicator(adaptive.originalPredicted, adaptive.predicted);
      }
      if (remaining > 0) {
        statusText += ` | 남은 시간: ~${McpCallTracker.formatDuration(remaining)}`;
      }
      statusText += `\n진행률: ${progress.toFixed(0)}%`;

      const progressBarLength = 20;
      const filledLength = Math.round((progress / 100) * progressBarLength);
      const emptyLength = progressBarLength - filledLength;
      const progressBar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
      statusText += ` \`${progressBar}\``;
    }

    return statusText;
  }

  private static formatAdaptiveIndicator(original: number, adjusted: number): string {
    return ` _🐢 ${McpCallTracker.formatDuration(original)} → ${McpCallTracker.formatDuration(adjusted)}_`;
  }
}
