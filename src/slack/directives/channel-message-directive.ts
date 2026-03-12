/**
 * ChannelMessageDirectiveHandler - Detects channel_message JSON directive in model text
 * and extracts a root-channel message body for out-of-thread posting.
 *
 * JSON format:
 * {
 *   "type": "channel_message",
 *   "text": "Message to post to channel root"
 * }
 */

export interface ChannelMessageExtractResult {
  messageText: string | null;
  cleanedText: string;
}

export class ChannelMessageDirectiveHandler {
  /**
   * Extract channel_message directives from model text.
   * Supports both ```json blocks and raw JSON objects.
   * Returns extracted message text and text with directive stripped.
   */
  static extract(text: string): ChannelMessageExtractResult {
    if (!text) {
      return { messageText: null, cleanedText: text };
    }

    // Try code blocks first
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;

    while ((match = jsonBlockPattern.exec(text)) !== null) {
      const messageText = this.parseChannelMessageJson(match[1].trim());
      if (messageText) {
        const cleanedText = text.replace(match[0], '').trim();
        return { messageText, cleanedText };
      }
    }

    // Try raw JSON object
    const jsonStartPattern = /\{\s*"type"\s*:\s*"channel_message"/g;
    let rawMatch;

    while ((rawMatch = jsonStartPattern.exec(text)) !== null) {
      const jsonStr = this.extractBalancedJson(text, rawMatch.index);
      if (!jsonStr) continue;

      const messageText = this.parseChannelMessageJson(jsonStr);
      if (messageText) {
        const before = text.substring(0, rawMatch.index).trim();
        const after = text.substring(rawMatch.index + jsonStr.length).trim();
        const cleanedText = before && after ? `${before}\n\n${after}` : (before || after);
        return { messageText, cleanedText };
      }
    }

    return { messageText: null, cleanedText: text };
  }

  /**
   * Extract a balanced JSON object starting from a given position.
   */
  private static extractBalancedJson(text: string, startIndex: number): string | null {
    let braceCount = 0;
    let inString = false;
    let escape = false;
    let jsonStart = -1;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\' && inString) {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') {
        if (braceCount === 0) jsonStart = i;
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0 && jsonStart !== -1) {
          return text.substring(jsonStart, i + 1);
        }
      }
    }

    return null;
  }

  /**
   * Parse JSON and extract message text if it's a valid channel_message directive.
   */
  private static parseChannelMessageJson(jsonStr: string): string | null {
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.type !== 'channel_message') return null;

      const raw =
        typeof parsed.text === 'string' ? parsed.text
          : typeof parsed.message === 'string' ? parsed.message
            : typeof parsed.content === 'string' ? parsed.content
              : null;

      const normalized = raw?.trim();
      return normalized ? normalized : null;
    } catch {
      return null;
    }
  }
}
