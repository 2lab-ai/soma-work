/**
 * Message formatting utilities for Slack bot
 */

export class MessageFormatter {
  /**
   * Format a message for Slack display
   * Converts markdown to Slack format
   */
  static formatMessage(text: string, _isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, _lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  /**
   * Format time elapsed since a date in human-readable Korean
   */
  static formatTimeAgo(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();

    const minutes = Math.floor(diff / (60 * 1000));
    const hours = Math.floor(diff / (60 * 60 * 1000));
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));

    if (days > 0) {
      return `${days}일 ${hours % 24}시간 전`;
    } else if (hours > 0) {
      return `${hours}시간 ${minutes % 60}분 전`;
    } else if (minutes > 0) {
      return `${minutes}분 전`;
    } else {
      return '방금 전';
    }
  }

  /**
   * Format session expiry time remaining
   */
  static formatExpiresIn(lastActivity: Date, sessionTimeoutMs: number = 24 * 60 * 60 * 1000): string {
    const expiresAt = lastActivity.getTime() + sessionTimeoutMs;
    const remaining = expiresAt - Date.now();

    if (remaining <= 0) {
      return '만료됨';
    }

    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));

    if (hours > 0) {
      return `${hours}시간 ${minutes}분 남음`;
    }
    return `${minutes}분 남음`;
  }

  /**
   * Format time remaining in human-readable format (Korean)
   */
  static formatTimeRemaining(ms: number): string {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

    if (hours > 0) {
      return `${hours}시간 ${minutes}분`;
    }
    return `${minutes}분`;
  }

  /**
   * Generate a session title from the first message
   * - Clean up mentions, URLs, code blocks
   * - Truncate to reasonable length
   * - Make it readable
   */
  static generateSessionTitle(text: string): string {
    let title = text
      // Remove mentions
      .replace(/<@[A-Z0-9]+>/g, '')
      // Remove URLs
      .replace(/<https?:\/\/[^|>]+\|?[^>]*>/g, '[link]')
      .replace(/https?:\/\/\S+/g, '[link]')
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, '[code]')
      .replace(/`[^`]+`/g, '[code]')
      // Clean up whitespace
      .replace(/\s+/g, ' ')
      .trim();

    // Truncate to 50 chars
    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    // If too short or just special chars, use default
    if (title.length < 3 || /^[\[\]\s\.\,]+$/.test(title)) {
      return '새 대화';
    }

    return title;
  }
}
