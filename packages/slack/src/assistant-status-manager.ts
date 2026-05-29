import { Logger } from '@soma/common/logger';

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
  private bgBashCounter = new Map<string, number>();
  private transientFailuresSinceLastSuccess = new Map<string, number>();

  constructor(private slackApi: AssistantStatusSlackApi) {}

  async setStatus(channelId: string, threadTs: string, status: StatusDescriptor): Promise<void> {
    if (typeof status === 'string' && status === '') {
      await this.clearStatus(channelId, threadTs);
      return;
    }

    if (!this.enabled) return;

    const descriptor: StatusDescriptor = status;
    const text = typeof descriptor === 'function' ? descriptor() : descriptor;
    const key = `${channelId}:${threadTs}`;

    try {
      await this.slackApi.setAssistantStatus(channelId, threadTs, text);
      this.recordSetStatusSuccess(key);
    } catch (error) {
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
        this.logger.debug('clearStatus epoch mismatch — stale clear dropped', {
          channelId,
          threadTs,
          expectedEpoch: options.expectedEpoch,
          currentEpoch,
        });
        return;
      }
    }

    const timer = this.heartbeats.get(key);
    if (timer) {
      clearInterval(timer);
      this.heartbeats.delete(key);
    }
    this.lastStatus.delete(key);

    if (!this.enabled) return;
    try {
      await this.slackApi.setAssistantStatus(channelId, threadTs, '');
      this.recordSetStatusSuccess(key);
    } catch (error) {
      await this.disableAndBestEffortClear(channelId, threadTs, error, key);
    }
  }

  bumpEpoch(channelId: string, threadTs: string): number {
    const key = `${channelId}:${threadTs}`;
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

  async setTitle(channelId: string, threadTs: string, title: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.slackApi.setAssistantTitle(channelId, threadTs, title);
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
    if (!entry) {
      const timer = this.heartbeats.get(key);
      if (timer) clearInterval(timer);
      this.heartbeats.delete(key);
      return;
    }

    try {
      const text = typeof entry.descriptor === 'function' ? entry.descriptor() : entry.descriptor;
      await this.slackApi.setAssistantStatus(entry.channelId, entry.threadTs, text);
      this.recordSetStatusSuccess(key);
    } catch (error) {
      const { channelId, threadTs } = entry;
      await this.disableAndBestEffortClear(channelId, threadTs, error, key);
    }
  }

  private async disableAndBestEffortClear(
    channelId: string,
    threadTs: string,
    error: unknown,
    key?: string,
  ): Promise<void> {
    const disabled = this.markDisabledIfScopeMissing(error);
    if (!disabled) {
      this.recordTransientFailure(key ?? `${channelId}:${threadTs}`, error);
      return;
    }
    await this.bestEffortClearSlack(channelId, threadTs);
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
    this.lastStatus.clear();
    this.transientFailuresSinceLastSuccess.clear();
  }
}
