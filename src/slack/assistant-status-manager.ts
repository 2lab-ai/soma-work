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

/**
 * Manages native Slack AI spinner status via assistant.threads.setStatus API.
 * Complements ReactionManager (emoji) and StatusReporter (message).
 * Auto-disables on first failure (missing scope or feature not enabled).
 *
 * Heartbeat: Slack auto-clears status after ~30s. This manager re-sends
 * the last status every 20s to keep the spinner alive until explicitly cleared.
 */
export class AssistantStatusManager {
  private logger = new Logger('AssistantStatus');
  private enabled = true;
  private heartbeats = new Map<string, NodeJS.Timeout>();
  private lastStatus = new Map<string, { channelId: string; threadTs: string; status: string }>();

  constructor(private slackApi: SlackApiHelper) {}

  async setStatus(channelId: string, threadTs: string, status: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.slackApi.setAssistantStatus(channelId, threadTs, status);
    } catch (error: any) {
      this.enabled = false;
      this.logger.debug('assistant.threads.setStatus unavailable, disabling', {
        error: error?.data?.error || error?.message,
      });
      this.clearAllHeartbeats();
      return;
    }

    const key = `${channelId}:${threadTs}`;
    this.lastStatus.set(key, { channelId, threadTs, status });

    if (!this.heartbeats.has(key)) {
      const timer = setInterval(() => this.heartbeatTick(key), HEARTBEAT_INTERVAL_MS);
      this.heartbeats.set(key, timer);
    }
  }

  async clearStatus(channelId: string, threadTs: string): Promise<void> {
    const key = `${channelId}:${threadTs}`;

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
    } catch {
      // already disabled or not critical
    }
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

  getToolStatusText(toolName: string, serverName?: string): string {
    if (serverName) {
      return `is calling ${serverName}...`;
    }
    return TOOL_STATUS_MAP[toolName] || 'is working...';
  }

  isEnabled(): boolean {
    return this.enabled;
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
      await this.slackApi.setAssistantStatus(entry.channelId, entry.threadTs, entry.status);
    } catch (error: any) {
      this.enabled = false;
      this.logger.debug('assistant.threads.setStatus unavailable, disabling', {
        error: error?.data?.error || error?.message,
      });
      this.clearAllHeartbeats();
    }
  }

  private clearAllHeartbeats(): void {
    for (const timer of this.heartbeats.values()) {
      clearInterval(timer);
    }
    this.heartbeats.clear();
    this.lastStatus.clear();
  }
}
