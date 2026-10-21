/**
 * DeployCompletedDirectiveHandler - Detects deploy_completed JSON directives in model text.
 *
 * The deploy workflow emits one per repo after the merge landed AND the deployment
 * succeeded. The host matches it against cron jobs whose owner opted in with
 * `onDeploy` and fires them (src/deploy-lanes.ts).
 *
 * JSON format:
 * {
 *   "type": "deploy_completed",
 *   "repo": "acme/app",
 *   "target": "deploy/dev2",
 *   "before": "<sha>",   // optional
 *   "after": "<sha>"
 * }
 *
 * Unlike channel_message, a single text may carry several (multi-repo deploy), so
 * every valid directive is collected and stripped. An invalid one is logged and
 * left in the text — never thrown into the turn.
 */

import { Logger } from '@soma/common/logger';
import { extractBalancedJson } from './extract-balanced-json.js';

const logger = new Logger('DeployCompletedDirective');

export interface DeployCompletedPayload {
  /** `owner/repo` as emitted (trimmed). Matching is case-insensitive. */
  repo: string;
  /** The branch the deploy merged into, e.g. `deploy/dev2`. */
  target: string;
  /** Target SHA before the merge (lower-case hex), when known. */
  before?: string;
  /** Merge commit SHA (lower-case hex). */
  after: string;
}

export interface DeployCompletedExtractResult {
  payloads: DeployCompletedPayload[];
  cleanedText: string;
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** [start, end) of a directive to strip from the text. */
type Range = [number, number];

export class DeployCompletedDirectiveHandler {
  /**
   * Extract every deploy_completed directive from model text.
   * Supports both ```json blocks and raw JSON objects.
   * Returns the valid payloads and the text with those directives stripped.
   */
  static extract(text: string): DeployCompletedExtractResult {
    if (!text) {
      return { payloads: [], cleanedText: text };
    }

    const payloads: DeployCompletedPayload[] = [];

    // Code blocks first, so a stripped directive does not leave an empty fence behind.
    const blockRanges: Range[] = [];
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;
    while ((match = jsonBlockPattern.exec(text)) !== null) {
      const payload = DeployCompletedDirectiveHandler.parse(match[1].trim());
      if (payload) {
        payloads.push(payload);
        blockRanges.push([match.index, match.index + match[0].length]);
      }
    }
    const afterBlocks = DeployCompletedDirectiveHandler.strip(text, blockRanges);

    // Then raw JSON objects in what is left.
    const rawRanges: Range[] = [];
    const jsonStartPattern = /\{\s*"type"\s*:\s*"deploy_completed"/g;
    let rawMatch;
    while ((rawMatch = jsonStartPattern.exec(afterBlocks)) !== null) {
      const jsonStr = extractBalancedJson(afterBlocks, rawMatch.index);
      if (!jsonStr) continue;
      const payload = DeployCompletedDirectiveHandler.parse(jsonStr);
      if (payload) {
        payloads.push(payload);
        rawRanges.push([rawMatch.index, rawMatch.index + jsonStr.length]);
        jsonStartPattern.lastIndex = rawMatch.index + jsonStr.length;
      }
    }

    if (payloads.length === 0) {
      return { payloads, cleanedText: text };
    }
    return { payloads, cleanedText: DeployCompletedDirectiveHandler.strip(afterBlocks, rawRanges) };
  }

  /**
   * Cut the ranges out and join what remains the way channel_message does for a
   * single directive: each piece trimmed, empty pieces dropped, joined by a blank line.
   */
  private static strip(text: string, ranges: Range[]): string {
    if (ranges.length === 0) return text;
    const pieces: string[] = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
      pieces.push(text.substring(cursor, start));
      cursor = end;
    }
    pieces.push(text.substring(cursor));
    return pieces
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0)
      .join('\n\n');
  }

  /**
   * Parse JSON and return the payload if it is a valid deploy_completed directive.
   * Anything with the right type but a bad field is logged and rejected.
   */
  private static parse(jsonStr: string): DeployCompletedPayload | null {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.type !== 'deploy_completed') return null;

    const repo = typeof parsed.repo === 'string' ? parsed.repo.trim() : '';
    const target = typeof parsed.target === 'string' ? parsed.target.trim() : '';
    const after = typeof parsed.after === 'string' ? parsed.after.trim() : '';
    // `before` is informational: absent, null and "" all mean "not known".
    const before = typeof parsed.before === 'string' ? parsed.before.trim() : undefined;
    const hasBefore = parsed.before !== undefined && parsed.before !== null && before !== '';

    const problem = !REPO_PATTERN.test(repo)
      ? 'repo must be owner/repo'
      : !target || /\s/.test(target)
        ? 'target must be a branch name'
        : !SHA_PATTERN.test(after)
          ? 'after must be a 7-40 char hex sha'
          : hasBefore && !(before && SHA_PATTERN.test(before))
            ? 'before must be a 7-40 char hex sha when present'
            : null;
    if (problem) {
      logger.warn('Ignoring invalid deploy_completed directive', { problem, repo, target });
      return null;
    }

    return {
      repo,
      target,
      ...(hasBefore && before ? { before: before.toLowerCase() } : {}),
      after: after.toLowerCase(),
    };
  }
}
