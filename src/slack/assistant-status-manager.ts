import { config } from '../config';
import { Logger } from '../logger';
import type { SlackApiHelper } from './slack-api-helper';

const HEARTBEAT_INTERVAL_MS = 20_000;

const TOOL_STATUS_MAP: Record<string, string> = {
  Read: 'is reading files...',
  Write: 'is editing code...',
  Edit: 'is editing code...',
  Bash: 'is running commands...',
  Grep: 'is searching...',
  Glob: 'is searching...',
  WebSearch: 'is researching...',
  WebFetch: 'is researching...',
  Task: 'is delegating to agent...',
};

const BG_BASH_STATUS_TEXT = 'is waiting on background shell...';

/**
 * Slack error codes that indicate the manager should disable itself
 * process-wide. All of these mean future writes will keep failing the
 * same way for every thread — so re-trying just burns work on dead
 * requests and pollutes logs.
 *
 * Scope/auth (3): missing_scope, not_allowed_token_type, invalid_auth.
 * Token lifecycle (3): token_revoked, token_expired, account_inactive
 * — Slack returns these when the install was uninstalled, the OAuth
 * token rotated, or the workspace owner deactivated the account.
 *
 * Transient codes (ratelimited, internal_error, network) and the
 * per-thread `not_allowed` are intentionally NOT here — they may
 * succeed on retry or for a different thread.
 */
const PERMANENT_CODES = new Set<string>([
  'missing_scope',
  'not_allowed_token_type',
  'invalid_auth',
  'token_revoked',
  'token_expired',
  'account_inactive',
]);

/**
 * Sustained-transient observability threshold (#700 P2 decision C).
 * A single transient blip is expected (Slack ratelimited spikes, network
 * partitions); sustained failures are not. Emit a single warn when the
 * per-key consecutive-transient-failure counter crosses this threshold,
 * then stay silent until the next success resets it.
 *
 * 10 failures × 20s heartbeat ≈ 3 min of sustained degradation per thread.
 */
const TRANSIENT_WARN_THRESHOLD = 10;

/**
 * Status descriptor — either a plain string (static text) or a thunk
 * re-evaluated on every heartbeat tick so dynamic counters (e.g. bg bash)
 * can be reflected live.
 */
export type StatusDescriptor = string | (() => string);

interface LastStatusEntry {
  channelId: string;
  threadTs: string;
  descriptor: StatusDescriptor;
}

/**
 * Manages native Slack AI spinner status via assistant.threads.setStatus API.
 * Complements ReactionManager (emoji) and StatusReporter (message).
 * Auto-disables on first failure (missing scope or feature not enabled).
 *
 * Heartbeat: Slack auto-clears status after ~30s. This manager re-sends
 * the last status every 20s to keep the spinner alive until explicitly cleared.
 *
 * Epoch guard: `bumpEpoch(ch, ts)` increments a per-(ch, ts) monotonic counter.
 * `clearStatus` with `expectedEpoch` is a no-op if the current epoch differs,
 * preventing stale clears from a previous turn wiping a freshly-set spinner.
 *
 * Background bash counter: `registerBackgroundBashActive(ch, ts)` lets the
 * bash event path declare how many `run_in_background` shells are live on the
 * thread. `buildBashStatus(ch, ts)` / `getToolStatusText('Bash', ..., ch, ts)`
 * switch the text to "waiting on background shell" when the counter is > 0.
 */
export class AssistantStatusManager {
  private logger = new Logger('AssistantStatus');
  private enabled = true;
  private heartbeats = new Map<string, NodeJS.Timeout>();
  private lastStatus = new Map<string, LastStatusEntry>();
  private epochCounter = new Map<string, number>();
  private bgBashCounter = new Map<string, number>();
  /**
   * Per-(channel, threadTs) count of consecutive transient Slack failures
   * since the last successful setStatus / heartbeat write on that key.
   * Used by the TRANSIENT_WARN_THRESHOLD observability gate (#700 P2 C).
   */
  private transientFailuresSinceLastSuccess = new Map<string, number>();

  constructor(private slackApi: SlackApiHelper) {
    // #666 P4 Part 1/2 — hard kill switch. Part 1 merges the Bolt Assistant
    // container + manifest but MUST NOT activate the legacy tool-level
    // spinner path (stream-executor.ts) before Part 2 wires turn-surface
    // single-writer convergence and legacy suppression. Flip via
    // `SOMA_UI_B4_NATIVE_STATUS=1` only after Part 2 merges.
    if (!config.ui.b4NativeStatusEnabled) {
      this.enabled = false;
      this.logger.debug('Native status spinner suppressed (SOMA_UI_B4_NATIVE_STATUS=0)');
    }
  }

  async setStatus(channelId: string, threadTs: string, status: StatusDescriptor): Promise<void> {
    // Empty-string → reroute to clearStatus (fixes empty-string heartbeat
    // bug where an empty status was re-sent every 20s).
    if (typeof status === 'string' && status === '') {
      await this.clearStatus(channelId, threadTs);
      return;
    }

    if (!this.enabled) return;

    const descriptor: StatusDescriptor = status;
    const text = typeof descriptor === 'function' ? descriptor() : descriptor;
    const key = `${channelId}:${threadTs}`;

    // Transient failures (ratelimited / internal_error / network / per-thread
    // not_allowed) fall through to the persist+heartbeat tail below so the
    // next 20s tick auto-retries. Only permanent scope/auth codes short-
    // circuit — they flip `enabled=false` and run the best-effort clear.
    try {
      await this.slackApi.setAssistantStatus(channelId, threadTs, text);
      this.recordSetStatusSuccess(key);
    } catch (error: any) {
      if (this.markDisabledIfScopeMissing(error)) {
        await this.bestEffortClearSlack(channelId, threadTs);
        return;
      }
      this.recordTransientFailure(key, error);
    }

    this.lastStatus.set(key, { channelId, threadTs, descriptor });
    this.ensureHeartbeat(key);
  }

  async clearStatus(channelId: string, threadTs: string, options?: { expectedEpoch?: number }): Promise<void> {
    const key = `${channelId}:${threadTs}`;

    if (options?.expectedEpoch !== undefined) {
      const currentEpoch = this.epochCounter.get(key) ?? 0;
      if (currentEpoch !== options.expectedEpoch) {
        // Stale clear — a newer turn has already bumped past this epoch.
        // Drop at debug (not warn) so supersede races stay observable
        // without log-spam on every hit.
        this.logger.debug('clearStatus epoch mismatch — stale clear dropped', {
          channelId,
          threadTs,
          expectedEpoch: options.expectedEpoch,
          currentEpoch,
        });
        return;
      }
    }

    // Stop heartbeat first to prevent race condition
    const timer = this.heartbeats.get(key);
    if (timer) {
      clearInterval(timer);
      this.heartbeats.delete(key);
    }
    this.lastStatus.delete(key);

    if (!this.enabled) return;
    try {
      await this.slackApi.setAssistantStatus(channelId, threadTs, '');
      // Explicit clear succeeded — reset the sustained-transient counter
      // so the next setStatus on this key starts fresh.
      this.recordSetStatusSuccess(key);
    } catch (error: any) {
      // Permanent scope/auth here also flips enabled=false and arms the
      // PHASE>=4 → 3 clamp; transient failures increment the counter and
      // emit a single warn at TRANSIENT_WARN_THRESHOLD.
      await this.disableAndBestEffortClear(channelId, threadTs, error, key);
    }
  }

  /**
   * Increment per-(ch, ts) epoch. Caller captures the returned value and
   * passes it to later `clearStatus` calls as `expectedEpoch` so stale
   * clears from previous turns become no-ops.
   */
  bumpEpoch(channelId: string, threadTs: string): number {
    const key = `${channelId}:${threadTs}`;
    const next = (this.epochCounter.get(key) ?? 0) + 1;
    this.epochCounter.set(key, next);
    return next;
  }

  /**
   * Register a background bash as active on this thread. Returns an
   * unregister function that decrements the counter. The unregister
   * function is idempotent — calling it a second time is a no-op.
   */
  registerBackgroundBashActive(channelId: string, threadTs: string): () => void {
    const key = `${channelId}:${threadTs}`;
    const current = this.bgBashCounter.get(key) ?? 0;
    this.bgBashCounter.set(key, current + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const now = this.bgBashCounter.get(key) ?? 0;
      if (now <= 1) {
        this.bgBashCounter.delete(key);
      } else {
        this.bgBashCounter.set(key, now - 1);
      }
    };
  }

  /**
   * Build the Bash status text — dynamic on bg counter. Intended to be
   * injected as a thunk `StatusDescriptor` so heartbeat ticks can reflect
   * counter changes.
   */
  buildBashStatus(channelId: string, threadTs: string): string {
    const key = `${channelId}:${threadTs}`;
    const count = this.bgBashCounter.get(key) ?? 0;
    if (count > 0) return BG_BASH_STATUS_TEXT;
    return TOOL_STATUS_MAP.Bash;
  }

  async setTitle(channelId: string, threadTs: string, title: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.slackApi.setAssistantTitle(channelId, threadTs, title);
    } catch (error: any) {
      this.logger.debug('assistant.threads.setTitle failed', {
        error: error?.data?.error || error?.message,
      });
    }
  }

  getToolStatusText(toolName: string, serverName?: string, channelId?: string, threadTs?: string): string {
    if (serverName) {
      return `is calling ${serverName}...`;
    }
    if (toolName === 'Bash' && channelId && threadTs) {
      return this.buildBashStatus(channelId, threadTs);
    }
    return TOOL_STATUS_MAP[toolName] || 'is working...';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * #689 P4 Part 2/2 — flip `enabled=false` iff the provided error is a
   * permanent process-wide failure (scope/auth). Per-thread `not_allowed`
   * and transient codes (ratelimited, internal_error, network) are
   * intentionally NOT matched so the manager stays alive for other
   * assistant threads in the same process.
   *
   * Returns `true` if a permanent code matched. Callers (setStatus /
   * heartbeatTick catch blocks via `disableAndBestEffortClear`) use the
   * return value to decide whether to run the best-effort clear.
   */
  markDisabledIfScopeMissing(err: unknown): boolean {
    const code = (err as any)?.data?.error ?? (err as any)?.code;
    // Permanent process-wide failures: scope/auth/token-lifecycle. All of
    // these mean future writes will keep failing the same way for every
    // thread in this process — staying enabled just burns retries on dead
    // requests. Transient codes (ratelimited, internal_error, network)
    // and per-thread `not_allowed` stay out so the manager survives them.
    const matched = typeof code === 'string' && PERMANENT_CODES.has(code);
    if (matched && this.enabled) {
      this.enabled = false;
      this.clearAllHeartbeats();
      this.logger.warn('AssistantStatusManager disabled due to permanent scope/auth error', { code });
    }
    return matched;
  }

  private async heartbeatTick(key: string): Promise<void> {
    const entry = this.lastStatus.get(key);
    if (!entry) {
      const timer = this.heartbeats.get(key);
      if (timer) clearInterval(timer);
      this.heartbeats.delete(key);
      return;
    }

    try {
      // Invoke descriptor thunk inside try so a throwing thunk (future
      // callers may wire descriptors that dereference stale state) cannot
      // escape as an unhandled rejection from the setInterval callback.
      const text = typeof entry.descriptor === 'function' ? entry.descriptor() : entry.descriptor;
      await this.slackApi.setAssistantStatus(entry.channelId, entry.threadTs, text);
      this.recordSetStatusSuccess(key);
    } catch (error: any) {
      // Capture before clearAllHeartbeats wipes lastStatus
      const { channelId, threadTs } = entry;
      await this.disableAndBestEffortClear(channelId, threadTs, error, key);
    }
  }

  /**
   * Shared failure path for setStatus and heartbeatTick.
   *
   * #689 P4 Part 2/2 — narrowed: ONLY permanent scope/auth errors
   * (`missing_scope`, `not_allowed_token_type`, `invalid_auth`) flip
   * `enabled=false` and run the best-effort clear. Per-thread
   * `not_allowed` and transient (ratelimited / internal_error / network)
   * are logged at debug and skipped — the manager stays alive so the
   * process can keep serving other assistant threads. This also prevents
   * `getEffectiveFiveBlockPhase` from clamping to 3 on every transient
   * blip.
   */
  private async disableAndBestEffortClear(
    channelId: string,
    threadTs: string,
    error: unknown,
    key?: string,
  ): Promise<void> {
    const disabled = this.markDisabledIfScopeMissing(error);
    if (!disabled) {
      // Transient path — manager stays enabled, but observe sustained
      // degradation so operators see rate-limit storms / network partitions
      // that otherwise only manifest as a silently-missing spinner.
      this.recordTransientFailure(key ?? `${channelId}:${threadTs}`, error);
      return;
    }
    // Permanent failure path: markDisabledIfScopeMissing already cleared
    // heartbeats. Run the best-effort clear so Slack doesn't leave a
    // stale spinner visible on the caller's thread.
    await this.bestEffortClearSlack(channelId, threadTs);
  }

  /**
   * #700 P2 C — reset the per-key consecutive-transient-failure counter on
   * every successful Slack write. This is the signal that degradation has
   * recovered; the next crossing of TRANSIENT_WARN_THRESHOLD will re-warn.
   */
  private recordSetStatusSuccess(key: string): void {
    if (this.transientFailuresSinceLastSuccess.has(key)) {
      this.transientFailuresSinceLastSuccess.delete(key);
    }
  }

  /**
   * #700 P2 C — increment per-key consecutive-transient-failure counter.
   * Emit a single `logger.warn` the first time the count reaches the
   * threshold (~3 min of sustained degradation at the 20s heartbeat).
   * Subsequent ticks stay at debug until the next success resets.
   */
  private recordTransientFailure(key: string, error: unknown): void {
    const prev = this.transientFailuresSinceLastSuccess.get(key) ?? 0;
    const next = prev + 1;
    this.transientFailuresSinceLastSuccess.set(key, next);
    const errorCode = (error as any)?.data?.error || (error as any)?.message;
    if (next === TRANSIENT_WARN_THRESHOLD) {
      this.logger.warn('sustained transient Slack degradation — native spinner likely invisible on this thread', {
        key,
        count: next,
        error: errorCode,
      });
    } else {
      this.logger.debug('assistant.threads.setStatus transient failure — persisting for heartbeat retry', {
        key,
        count: next,
        error: errorCode,
      });
    }
  }

  /**
   * Fire-and-forget Slack setAssistantStatus('') that swallows every error.
   * Callers have already set `enabled=false` — retry is pointless, we just
   * give Slack a last chance to drop any lingering spinner.
   */
  private async bestEffortClearSlack(channelId: string, threadTs: string): Promise<void> {
    try {
      await this.slackApi.setAssistantStatus(channelId, threadTs, '');
    } catch {
      /* already disabled, swallow */
    }
  }

  /**
   * Arm the 20s heartbeat for `key` if no timer is already running. Callers
   * (setStatus success branch + transient-failure retry branch) write into
   * `lastStatus` first so the first tick has a descriptor to re-send.
   */
  private ensureHeartbeat(key: string): void {
    if (this.heartbeats.has(key)) return;
    const timer = setInterval(() => this.heartbeatTick(key), HEARTBEAT_INTERVAL_MS);
    this.heartbeats.set(key, timer);
  }

  private clearAllHeartbeats(): void {
    for (const timer of this.heartbeats.values()) {
      clearInterval(timer);
    }
    this.heartbeats.clear();
    this.lastStatus.clear();
    // The sustained-transient counter only matters while the manager is
    // enabled; once disabled, clearing avoids leaking stale per-key state.
    this.transientFailuresSinceLastSuccess.clear();
    // Note: bgBashCounter and epochCounter are turn-level state, independent
    // of the manager's Slack API enablement. Do NOT clear them here.
  }
}
