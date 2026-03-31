import { Logger } from '../../logger';
import type { SessionLink } from '../../types';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles link command - attach issue/PR/doc links to current session
 */
export class LinkHandler implements CommandHandler {
  private logger = new Logger('LinkHandler');

  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isLinkCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, threadTs, text, say } = ctx;

    try {
      const parsed = CommandParser.parseLinkCommand(text);
      if (!parsed) {
        await say({
          text: '❌ 올바른 형식: `link issue|pr|doc <url>`',
          thread_ts: threadTs,
        });
        return { handled: true };
      }

      // Validate URL - must be http or https
      if (!this.isValidUrl(parsed.url)) {
        await say({
          text: '❌ 유효한 HTTP/HTTPS URL을 입력해주세요.',
          thread_ts: threadTs,
        });
        return { handled: true };
      }

      // Check if there's an active session in this thread
      const session = this.deps.claudeHandler.getSession(channel, threadTs);
      if (!session) {
        await say({
          text: '❌ 이 스레드에 활성 세션이 없습니다. 먼저 대화를 시작하세요.',
          thread_ts: threadTs,
        });
        return { handled: true };
      }

      // Detect provider from URL
      const provider = this.detectProvider(parsed.url);
      const label = this.extractLabel(parsed.url, parsed.linkType, provider);

      const link: SessionLink = {
        url: parsed.url,
        type: parsed.linkType,
        provider,
        label,
      };

      this.deps.claudeHandler.setSessionLink(channel, threadTs, link);

      const typeLabels = { issue: '이슈', pr: 'PR', doc: '문서' };
      await say({
        text: `🔗 ${typeLabels[parsed.linkType]} 링크가 세션에 연결되었습니다: ${label || parsed.url}`,
        thread_ts: threadTs,
      });

      return { handled: true };
    } catch (error) {
      this.logger.error('Link command failed', error);
      await say({
        text: '❌ 링크 처리 중 오류가 발생했습니다.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }
  }

  /**
   * Validate URL is well-formed and uses http/https protocol
   */
  private isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private detectProvider(url: string): SessionLink['provider'] {
    if (url.includes('github.com')) return 'github';
    if (url.includes('atlassian.net/wiki')) return 'confluence';
    if (url.includes('atlassian.net')) return 'jira';
    if (url.includes('linear.app')) return 'linear';
    return 'unknown';
  }

  private extractLabel(url: string, type: string, provider: string): string {
    // Jira issue
    const jiraMatch = url.match(/browse\/(\w+-\d+)/) || url.match(/selectedIssue=(\w+-\d+)/);
    if (jiraMatch) return jiraMatch[1];

    // GitHub PR
    const ghPrMatch = url.match(/\/pull\/(\d+)/);
    if (ghPrMatch) return `PR #${ghPrMatch[1]}`;

    // GitHub issue
    const ghIssueMatch = url.match(/\/issues\/(\d+)/);
    if (ghIssueMatch) return `#${ghIssueMatch[1]}`;

    // Linear issue
    const linearMatch = url.match(/\/issue\/(\w+-\d+)/);
    if (linearMatch) return linearMatch[1];

    // Confluence - use page title from URL, sanitize mrkdwn special chars
    const confluenceMatch = url.match(/\/pages\/\d+\/([^/?]+)/);
    if (confluenceMatch) {
      const decoded = decodeURIComponent(confluenceMatch[1].replace(/\+/g, ' '));
      return decoded.replace(/[<>|]/g, '');
    }

    return url.length > 40 ? url.substring(0, 37) + '...' : url;
  }
}
