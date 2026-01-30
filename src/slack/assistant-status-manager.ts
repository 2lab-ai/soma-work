import { Logger } from '../logger';
import { SlackApiHelper } from './slack-api-helper';

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
 */
export class AssistantStatusManager {
  private logger = new Logger('AssistantStatus');
  private enabled = true;

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
    }
  }

  async clearStatus(channelId: string, threadTs: string): Promise<void> {
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
}
