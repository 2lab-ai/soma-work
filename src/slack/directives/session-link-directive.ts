/**
 * SessionLinkDirectiveHandler - Detects session_links JSON directive in model text
 * and extracts session links (jira, pr, doc) for automatic session metadata updates.
 *
 * Supports both ```json blocks and raw JSON objects (similar to UserChoiceExtractor).
 *
 * JSON format:
 * {
 *   "type": "session_links",
 *   "jira": "https://xxx.atlassian.net/browse/PTN-123",
 *   "pr": "https://github.com/org/repo/pull/42",
 *   "doc": "https://xxx.atlassian.net/wiki/spaces/..."
 * }
 */

import { SessionLink, SessionLinks } from '../../types';

export interface SessionLinkExtractResult {
  links: SessionLinks | null;
  cleanedText: string;
}

/**
 * Map JSON keys to SessionLink types
 */
const LINK_KEY_TO_TYPE: Record<string, SessionLink['type']> = {
  jira: 'issue',
  issue: 'issue',
  pr: 'pr',
  doc: 'doc',
};

export class SessionLinkDirectiveHandler {
  /**
   * Extract session link directives from model text.
   * Supports both ```json blocks and raw JSON objects.
   * Returns extracted links and text with directives stripped.
   */
  static extract(text: string): SessionLinkExtractResult {
    if (!text) {
      return { links: null, cleanedText: text };
    }

    // Try to find JSON in code blocks first (```json ... ```)
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;

    while ((match = jsonBlockPattern.exec(text)) !== null) {
      const result = this.parseSessionLinksJson(match[1].trim());
      if (result.links) {
        const cleanedText = text.replace(match[0], '').trim();
        return { links: result.links, cleanedText };
      }
    }

    // Try to find raw JSON objects with "type": "session_links"
    const jsonStartPattern = /\{\s*"type"\s*:\s*"session_links"/g;
    let rawMatch;

    while ((rawMatch = jsonStartPattern.exec(text)) !== null) {
      const jsonStr = this.extractBalancedJson(text, rawMatch.index);
      if (jsonStr) {
        const result = this.parseSessionLinksJson(jsonStr);
        if (result.links) {
          const before = text.substring(0, rawMatch.index).trim();
          const after = text.substring(rawMatch.index + jsonStr.length).trim();
          const cleanedText = before && after ? `${before}\n\n${after}` : (before || after);
          return { links: result.links, cleanedText };
        }
      }
    }

    return { links: null, cleanedText: text };
  }

  /**
   * Extract a balanced JSON object starting from a given position
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
   * Parse JSON and extract session links if it's a valid session_links directive
   */
  private static parseSessionLinksJson(jsonStr: string): { links: SessionLinks | null } {
    try {
      const parsed = JSON.parse(jsonStr);

      // Must have type: "session_links"
      if (parsed.type !== 'session_links') {
        return { links: null };
      }

      const links: SessionLinks = {};
      let hasLinks = false;

      // Extract each known link key
      for (const [key, linkType] of Object.entries(LINK_KEY_TO_TYPE)) {
        const url = parsed[key];
        if (url && typeof url === 'string' && isValidUrl(url)) {
          const link = buildSessionLink(url, linkType);
          if (link) {
            links[linkType] = link;
            hasLinks = true;
          }
        }
      }

      return { links: hasLinks ? links : null };
    } catch {
      return { links: null };
    }
  }
}

/**
 * Validate URL is http/https
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Build a SessionLink from a URL, detecting provider and extracting label.
 * Reuses the same detection logic as link-handler.ts and dispatch-service.ts.
 */
function buildSessionLink(url: string, type: SessionLink['type']): SessionLink {
  const provider = detectProvider(url);
  const label = extractLabel(url, provider);

  return { url, type, provider, label };
}

function detectProvider(url: string): SessionLink['provider'] {
  if (url.includes('github.com')) return 'github';
  if (url.includes('atlassian.net/wiki')) return 'confluence';
  if (url.includes('atlassian.net')) return 'jira';
  if (url.includes('linear.app')) return 'linear';
  return 'unknown';
}

function extractLabel(url: string, provider: string): string {
  // Jira issue key
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

  // Confluence page title
  const confluenceMatch = url.match(/\/pages\/\d+\/([^/?]+)/);
  if (confluenceMatch) {
    const decoded = decodeURIComponent(confluenceMatch[1].replace(/\+/g, ' '));
    return decoded.replace(/[<>|]/g, '');
  }

  return url.length > 40 ? url.substring(0, 37) + '...' : url;
}
