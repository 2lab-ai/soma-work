import { Logger } from '@soma/common/logger';

const HEARTBEAT_INTERVAL_MS = 20_000;
const CLEAR_MAX_ATTEMPTS = 3;

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

const PERMANENT_CODES = new Set<string>([
  'missing_scope',
  'not_allowed_token_type',
  'invalid_auth',
  'token_revoked',
  'token_expired',
  'account_inactive',
]);

const TRANSIENT_WARN_THRESHOLD = 10;

export interface AssistantStatusSlackApi {
  setAssistantStatus(channelId: string, threadTs: string, status: string): Promise<unknown>;
  setAssistantTitle(channelId: string, threadTs: string, title: string): Promise<unknown>;
}

export type StatusDescriptor = string | (() => string);

interface LastStatusEntry {
  channelId: string;
  threadTs: string;
  descriptor: StatusDescriptor;
  epoch: number;
}

function readErrorData(error: unknown): { error?: unknown } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  return data as { error?: unknown };
}

function readErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return readErrorData(error)?.error ?? (error as { code?: unknown }).code;
}

function readErrorLabel(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return readErrorData(error)?.error || (error as { message?: unknown }).message;
}

export class AssistantStatusManager {
  private logger = new Logger('AssistantStatus');
  private enabled = true;
  private heartbeats = new Map<string, NodeJS.Timeout>();
  private lastStatus = new Map<string, LastStatusEntry>();
  private epochCounter = new Map<string, number>();
  private closedEpochs = new Set<string>();
  private writers = new Map<string, Promise<void>>();
  private clearRetries = new Map<string, NodeJS.Timeout>();
  private bgBashCounter = new Map<string, number>();
  private transientFailuresSinceLastSuccess = new Map<string, number>();
  /** Threads whose title has already been set — keeps setTitle once-per-thread. */
  private titledThreads = new Set<string>();

  constructor(private slackApi: AssistantStatusSlackApi) {}

  async setStatus(
    channelId: string,
    threadTs: string,
    status: StatusDescriptor,
    options?: { expectedEpoch?: number },
  ): Promise<void> {
    const key = `${channelId}:${threadTs}`;
    const epoch = this.epochCounter.get(key) ?? 0;
    if (options?.expectedEpoch !== undefined && (options.expectedEpoch !== epoch || this.closedEpochs.has(key))) return;

    if (status === '') {
      if (options) await this.clearStatus(channelId, threadTs, options);
      else await this.clearStatus(channelId, threadTs);
      return;
    }
    if (!this.enabled) return;

    // Publish intent before any network await. A completed write never owns
    // desired state, so it cannot resurrect a cleared or superseded turn.
    this.cancelClearRetry(key);
    const entry = { channelId, threadTs, descriptor: status, epoch };
    this.lastStatus.set(key, entry);
    this.ensureHeartbeat(key);
    await this.writeStatus(key, entry);
  }

  async clearStatus(channelId: string, threadTs: string, options?: { expectedEpoch?: number }): Promise<void> {
    const key = `${channelId}:${threadTs}`;

    if (options?.expectedEpoch !== undefined) {
      const currentEpoch = this.epochCounter.get(key) ?? 0;
      if (currentEpoch !== options.expectedEpoch) {
        this.logger.debug('clearStatus epoch mismatch — stale clear dropped', {
          channelId,
          threadTs,
          expectedEpoch: options.expectedEpoch,
          currentEpoch,
        });
        return;
      }
    }

    this.cancelHeartbeat(key);
    this.cancelClearRetry(key);
    this.closedEpochs.add(key);
    const entry = {
      channelId,
      threadTs,
      descriptor: '',
      epoch: this.epochCounter.get(key) ?? 0,
    };
    this.lastStatus.set(key, entry);
    await this.writeStatus(key, entry);
  }

  bumpEpoch(channelId: string, threadTs: string): number {
    const key = `${channelId}:${threadTs}`;
    this.cancelHeartbeat(key);
    this.cancelClearRetry(key);
    this.lastStatus.delete(key);
    this.closedEpochs.delete(key);
    const next = (this.epochCounter.get(key) ?? 0) + 1;
    this.epochCounter.set(key, next);
    return next;
  }

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

  buildBashStatus(channelId: string, threadTs: string): string {
    const key = `${channelId}:${threadTs}`;
    const count = this.bgBashCounter.get(key) ?? 0;
    if (count > 0) return BG_BASH_STATUS_TEXT;
    return TOOL_STATUS_MAP.Bash;
  }

  /**
   * Set the assistant thread title — ONCE per thread (#1064 surface
   * modernization). Re-setting on every turn would flicker the sidebar, so the
   * first non-empty title for a thread wins and later calls are no-ops. Shares
   * the `enabled` gate with `setStatus`, so in workspaces/threads where the
   * assistant API isn't available the call disables itself the same way status
   * does — no separate assistant-thread marker needed. `force` re-titles even
   * if already set (unused today, reserved for an explicit rename).
   */
  async setTitle(channelId: string, threadTs: string, title: string, opts?: { force?: boolean }): Promise<void> {
    if (!this.enabled) return;
    const trimmed = title?.trim();
    if (!trimmed) return;

    const key = `${channelId}:${threadTs}`;
    if (!opts?.force && this.titledThreads.has(key)) return;

    try {
      await this.slackApi.setAssistantTitle(channelId, threadTs, trimmed);
      this.titledThreads.add(key);
    } catch (error) {
      this.logger.debug('assistant.threads.setTitle failed', {
        error: readErrorLabel(error),
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

  markDisabledIfScopeMissing(err: unknown): boolean {
    const code = readErrorCode(err);
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
    if (!entry || entry.descriptor === '') {
      this.cancelHeartbeat(key);
      return;
    }
    // A pending writer already owns the refresh; never queue elapsed ticks.
    if (this.writers.has(key)) return;
    await this.writeStatus(key, entry);
  }

  /** All status writes, including heartbeat retries and clears, share one lane per thread. */
  private writeStatus(key: string, entry: LastStatusEntry, attempt = 1): Promise<void> {
    const send = async () => {
      if (!this.enabled || this.lastStatus.get(key) !== entry || (this.epochCounter.get(key) ?? 0) !== entry.epoch)
        return;
      try {
        const text = typeof entry.descriptor === 'function' ? entry.descriptor() : entry.descriptor;
        await this.slackApi.setAssistantStatus(entry.channelId, entry.threadTs, text);
        this.recordSetStatusSuccess(key);
      } catch (error) {
        // The best-effort auth clear runs inside this same serialized lane.
        if (this.markDisabledIfScopeMissing(error)) {
          await this.bestEffortClearSlack(entry.channelId, entry.threadTs);
        } else if (entry.descriptor === '') {
          this.scheduleClearRetry(key, entry, attempt, error);
        } else {
          this.recordTransientFailure(key, error);
        }
      }
    };
    const previous = this.writers.get(key);
    const writing = previous ? previous.then(send, send) : send();
    const settled = writing.finally(() => {
      if (this.writers.get(key) === settled) this.writers.delete(key);
    });
    this.writers.set(key, settled);
    return settled;
  }

  private cancelHeartbeat(key: string): void {
    const timer = this.heartbeats.get(key);
    if (timer) clearInterval(timer);
    this.heartbeats.delete(key);
  }

  private cancelClearRetry(key: string): void {
    const timer = this.clearRetries.get(key);
    if (timer) clearTimeout(timer);
    this.clearRetries.delete(key);
  }

  private scheduleClearRetry(key: string, entry: LastStatusEntry, attempt: number, error: unknown): void {
    if (!this.enabled || this.lastStatus.get(key) !== entry || (this.epochCounter.get(key) ?? 0) !== entry.epoch)
      return;
    if (attempt >= CLEAR_MAX_ATTEMPTS) {
      this.logger.warn('assistant.threads.setStatus clear retries exhausted', {
        key,
        attempts: attempt,
        error: readErrorLabel(error),
      });
      return;
    }
    this.logger.debug('assistant.threads.setStatus transient clear failure — scheduling retry', {
      key,
      attempt,
      error: readErrorLabel(error),
    });
    // Do not await a retry inside the writer that it must follow.
    const timer = setTimeout(() => {
      if (this.clearRetries.get(key) !== timer) return;
      this.clearRetries.delete(key);
      void this.writeStatus(key, entry, attempt + 1);
    }, attempt * 1_000);
    this.clearRetries.set(key, timer);
  }

  private recordSetStatusSuccess(key: string): void {
    if (this.transientFailuresSinceLastSuccess.has(key)) {
      this.transientFailuresSinceLastSuccess.delete(key);
    }
  }

  private recordTransientFailure(key: string, error: unknown): void {
    const prev = this.transientFailuresSinceLastSuccess.get(key) ?? 0;
    const next = prev + 1;
    this.transientFailuresSinceLastSuccess.set(key, next);
    const errorCode = readErrorLabel(error);
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

  private async bestEffortClearSlack(channelId: string, threadTs: string): Promise<void> {
    try {
      await this.slackApi.setAssistantStatus(channelId, threadTs, '');
    } catch {
      // Already disabled; swallow the final best-effort clear.
    }
  }

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
    for (const key of this.clearRetries.keys()) this.cancelClearRetry(key);
    this.lastStatus.clear();
    this.transientFailuresSinceLastSuccess.clear();
  }
}
