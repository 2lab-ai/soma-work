/**
 * ReleaseNotesDirectiveHandler - Detects release_notes JSON directives in model text.
 *
 * The deploy workflow emits one per repo once the merge landed
 * (src/prompt/workflows/deploy.prompt §6). The host posts a short header — repo,
 * target, version and up to three TL;DR lines — as a channel-root message and the
 * full notes as a thread reply under it (packages/slack/src/release-notes-poster.ts).
 * Which channel is the operator's choice (SOMA_RELEASE_NOTES_CHANNELS), never the
 * model's: the directive carries no channel.
 *
 * JSON format:
 * {
 *   "type": "release_notes",
 *   "repo": "acme/app",
 *   "target": "deploy/dev2",
 *   "version": "0.2.58 (c8a026e)",
 *   "tldr": ["...", "...", "..."],   // 1 to 3 one-line summaries
 *   "text": "<full release notes>"
 * }
 *
 * Every valid directive is collected and stripped (a multi-repo deploy emits
 * several). An invalid one is logged and LEFT in the text, so the thread shows
 * it instead of the notes silently vanishing. Nothing throws.
 */

import { Logger } from '@soma/common/logger';
import { extractBalancedJson } from './extract-balanced-json.js';

const logger = new Logger('ReleaseNotesDirective');

/** The header carries at most this many TL;DR lines. */
export const RELEASE_NOTES_MAX_TLDR = 3;

const MARKER = '"release_notes"';
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const BRANCH_PATTERN = /^[\w./-]+$/;

export interface ReleaseNotesPayload {
  /** `owner/repo` as emitted (trimmed). */
  repo: string;
  /** The branch the deploy merged into, e.g. `deploy/dev2`. */
  target: string;
  /** What shipped, e.g. `0.2.58 (c8a026e)` — one line. */
  version: string;
  /** 1..RELEASE_NOTES_MAX_TLDR one-line summaries for the header. */
  tldr: string[];
  /** The full notes, posted in the thread. */
  text: string;
}

export interface ReleaseNotesExtractResult {
  payloads: ReleaseNotesPayload[];
  cleanedText: string;
}

/** [start, end) of a span of the text. */
type Range = [number, number];

export class ReleaseNotesDirectiveHandler {
  /**
   * Extract every valid release_notes directive from model text.
   * Supports both ```json blocks and raw JSON objects.
   */
  static extract(text: string): ReleaseNotesExtractResult {
    if (!text || !text.includes(MARKER)) {
      return { payloads: [], cleanedText: text };
    }

    const found: Array<{ range: Range; payload: ReleaseNotesPayload }> = [];

    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match: RegExpExecArray | null;
    while ((match = jsonBlockPattern.exec(text)) !== null) {
      if (!match[1].includes(MARKER)) continue;
      const payload = ReleaseNotesDirectiveHandler.parse(match[1].trim());
      if (payload) found.push({ range: [match.index, match.index + match[0].length], payload });
    }

    const rawPattern = /\{\s*"type"\s*:\s*"release_notes"/g;
    while ((match = rawPattern.exec(text)) !== null) {
      const start = match.index;
      if (found.some(({ range }) => start >= range[0] && start < range[1])) continue;
      const jsonStr = extractBalancedJson(text, start);
      if (!jsonStr) continue;
      const payload = ReleaseNotesDirectiveHandler.parse(jsonStr);
      if (payload) found.push({ range: [start, start + jsonStr.length], payload });
    }

    if (found.length === 0) {
      return { payloads: [], cleanedText: text };
    }

    found.sort((a, b) => a.range[0] - b.range[0]);
    return {
      payloads: found.map(({ payload }) => payload),
      cleanedText: ReleaseNotesDirectiveHandler.strip(
        text,
        found.map(({ range }) => range),
      ),
    };
  }

  /** Cut the ranges out; each remaining piece trimmed, empty ones dropped, joined by a blank line. */
  private static strip(text: string, ranges: Range[]): string {
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

  /** Null when it is not JSON, not a release_notes object, or a field is bad (logged). */
  private static parse(jsonStr: string): ReleaseNotesPayload | null {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.type !== 'release_notes') return null;

    const repo = typeof parsed.repo === 'string' ? parsed.repo.trim() : '';
    const target = typeof parsed.target === 'string' ? parsed.target.trim() : '';
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    const tldr = Array.isArray(parsed.tldr)
      ? parsed.tldr.map((line: unknown) => (typeof line === 'string' ? line.trim() : ''))
      : [];

    const problem = !REPO_PATTERN.test(repo)
      ? 'repo must be owner/repo'
      : !BRANCH_PATTERN.test(target)
        ? 'target must be a branch name'
        : !version || /[\r\n]/.test(version)
          ? 'version must be one non-empty line'
          : tldr.length < 1 || tldr.length > RELEASE_NOTES_MAX_TLDR
            ? `tldr must hold 1 to ${RELEASE_NOTES_MAX_TLDR} lines`
            : tldr.some((line: string) => !line || /[\r\n]/.test(line))
              ? 'every tldr entry must be one non-empty line'
              : !text
                ? 'text must be non-empty'
                : null;

    if (problem) {
      logger.warn('release_notes directive rejected — left in the text', { problem, repo, target });
      return null;
    }
    return { repo, target, version, tldr, text };
  }
}
