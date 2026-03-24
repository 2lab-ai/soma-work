/**
 * SourceWorkingDirDirectiveHandler - Detects source_working_dir JSON directive in model text
 * and extracts directory paths for session-scoped lifecycle tracking.
 *
 * When the AI agent clones a PR source, it outputs this directive so the session
 * can track the directory and clean it up on session end.
 *
 * JSON format:
 * {
 *   "type": "source_working_dir",
 *   "action": "add",
 *   "path": "/tmp/USER_ID/20260323_1532_guci_pr_123"
 * }
 */

import { Logger } from '../../logger';

const logger = new Logger('SourceWorkingDirDirective');

export interface SourceWorkingDirExtractResult {
  action: 'add' | null;
  path: string | null;
  cleanedText: string;
}

export class SourceWorkingDirDirectiveHandler {
  /**
   * Extract source_working_dir directive from model text.
   * Supports both ```json blocks and raw JSON objects.
   * Returns extracted action/path and text with directive stripped.
   */
  static extract(text: string): SourceWorkingDirExtractResult {
    if (!text) {
      return { action: null, path: null, cleanedText: text };
    }

    // Try to find JSON in code blocks first (```json ... ```)
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;

    while ((match = jsonBlockPattern.exec(text)) !== null) {
      const result = this.parseDirectiveJson(match[1].trim());
      if (result) {
        const cleanedText = text.replace(match[0], '').trim();
        return { ...result, cleanedText };
      }
    }

    // Try to find raw JSON objects with "type": "source_working_dir"
    const jsonStartPattern = /\{\s*"type"\s*:\s*"source_working_dir"/g;
    let rawMatch;

    while ((rawMatch = jsonStartPattern.exec(text)) !== null) {
      const jsonStr = this.extractBalancedJson(text, rawMatch.index);
      if (jsonStr) {
        const result = this.parseDirectiveJson(jsonStr);
        if (result) {
          const before = text.substring(0, rawMatch.index).trim();
          const after = text.substring(rawMatch.index + jsonStr.length).trim();
          const cleanedText = before && after ? `${before}\n\n${after}` : (before || after);
          return { ...result, cleanedText };
        }
      }
    }

    return { action: null, path: null, cleanedText: text };
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
   * Parse JSON and extract directive if it's a valid source_working_dir directive
   */
  private static parseDirectiveJson(jsonStr: string): Omit<SourceWorkingDirExtractResult, 'cleanedText'> | null {
    try {
      const parsed = JSON.parse(jsonStr);

      if (parsed.type !== 'source_working_dir') return null;
      if (parsed.action !== 'add') return null;

      const dirPath = parsed.path;
      if (!dirPath || typeof dirPath !== 'string') return null;

      // Security: must be absolute path under /tmp/ (or /private/tmp/ on macOS)
      if (!dirPath.startsWith('/tmp/') && !dirPath.startsWith('/private/tmp/')) return null;

      // Reject path traversal
      if (dirPath.includes('..')) return null;

      return { action: 'add', path: dirPath };
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        logger.error('Unexpected error parsing source_working_dir directive', { jsonStr, error });
      }
      return null;
    }
  }
}
