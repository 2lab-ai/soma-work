/**
 * DeployCompletedDirectiveHandler - Detects deploy_completed JSON directives in model text.
 *
 * The deploy workflow emits one per repo once the merge landed. `confirmed: false`
 * means "merged, but the deployment could not be confirmed"; absent or true means
 * it was. The host matches it against the lanes (cron jobs with onDeploy, or
 * deploy-lanes.json) and fires them (src/deploy-lanes.ts).
 *
 * JSON format:
 * {
 *   "type": "deploy_completed",
 *   "repo": "acme/app",
 *   "target": "deploy/staging",
 *   "before": "<sha>",      // optional
 *   "after": "<sha>",
 *   "confirmed": false      // optional, default true
 * }
 *
 * Unlike channel_message, a single text may carry several (multi-repo deploy), so
 * every valid directive is collected and stripped. Every attempt that is not
 * valid — a bad field, unparseable JSON, a raw object whose "type" is not the
 * first key — is reported as a rejection and left in the text. Nothing throws.
 * An "attempt" is any occurrence of the quoted token `"deploy_completed"`, so
 * prose that names the directive in backticks is not one.
 */

import { Logger } from '@soma/common/logger';
import { extractBalancedJson } from './extract-balanced-json.js';

const logger = new Logger('DeployCompletedDirective');

export interface DeployCompletedPayload {
  /** `owner/repo` as emitted (trimmed). Matching is case-insensitive. */
  repo: string;
  /** The branch the deploy merged into, e.g. `deploy/staging`. */
  target: string;
  /** Target SHA before the merge (lower-case hex), when known. */
  before?: string;
  /** Merge commit SHA (lower-case hex). */
  after: string;
  /** False when the merge landed but the deployment could not be confirmed. */
  confirmed: boolean;
}

/** A deploy_completed attempt that yielded no payload. Field values are raw, for the log and the reply. */
export interface DeployCompletedRejection {
  problem: string;
  repo?: string;
  target?: string;
  before?: string;
  after?: string;
}

export interface DeployCompletedExtractResult {
  payloads: DeployCompletedPayload[];
  rejections: DeployCompletedRejection[];
  cleanedText: string;
}

/** What the stream executor hands its host for one text segment. */
export type DeployCompletedSignal =
  | { kind: 'completed'; payload: DeployCompletedPayload }
  | { kind: 'rejected'; rejections: DeployCompletedRejection[] };

/** Where the host answers: the deploy thread. `reply` posts one line there. */
export interface DeployCompletedHookContext {
  channel: string;
  threadTs: string;
  /** Who ran the deploy session. */
  user: string;
  reply: (line: string) => Promise<void>;
}

const MARKER = '"deploy_completed"';
const UNPARSEABLE = 'unparseable JSON, or "type" is not the first key';
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** [start, end) of a span of the text. */
type Range = [number, number];

type ParseResult = { payload: DeployCompletedPayload } | { rejection: DeployCompletedRejection } | null;

export class DeployCompletedDirectiveHandler {
  /**
   * Extract every deploy_completed directive from model text.
   * Supports both ```json blocks and raw JSON objects.
   * Returns the valid payloads, the rejected attempts, and the text with the
   * valid directives stripped.
   */
  static extract(text: string): DeployCompletedExtractResult {
    if (!text) {
      return { payloads: [], rejections: [], cleanedText: text };
    }

    const payloads: DeployCompletedPayload[] = [];
    const rejections: DeployCompletedRejection[] = [];
    const strip: Range[] = [];
    let accounted = 0;

    // Code blocks first: a fence that IS one directive is stripped whole. A
    // fence the block parse settles (payload or rejection) is skipped by the
    // raw scan below; any other fence — several objects, an array, broken JSON
    // — is left to the raw scan, which reads each object inside it.
    const blocks: Range[] = [];
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;
    while ((match = jsonBlockPattern.exec(text)) !== null) {
      if (!match[1].includes(MARKER)) continue;
      const range: Range = [match.index, match.index + match[0].length];
      const result = DeployCompletedDirectiveHandler.parse(match[1].trim());
      if (result && 'payload' in result) {
        payloads.push(result.payload);
        strip.push(range);
        blocks.push(range);
        accounted++;
      } else if (result) {
        rejections.push(result.rejection);
        blocks.push(range);
        accounted++;
      }
    }

    // Then raw JSON objects outside those blocks.
    const jsonStartPattern = /\{\s*"type"\s*:\s*"deploy_completed"/g;
    let rawMatch;
    while ((rawMatch = jsonStartPattern.exec(text)) !== null) {
      const at = rawMatch.index;
      if (blocks.some(([start, end]) => at >= start && at < end)) continue;
      const jsonStr = extractBalancedJson(text, at);
      if (!jsonStr) continue;
      const result = DeployCompletedDirectiveHandler.parse(jsonStr);
      if (result && 'payload' in result) {
        payloads.push(result.payload);
        strip.push([at, at + jsonStr.length]);
        accounted++;
        jsonStartPattern.lastIndex = at + jsonStr.length;
      } else if (result) {
        rejections.push(result.rejection);
        accounted++;
        jsonStartPattern.lastIndex = at + jsonStr.length;
      }
    }

    // Attempts neither scan could read: broken JSON, or "type" not first.
    if (countOccurrences(text, MARKER) > accounted) {
      logger.warn('Ignoring unreadable deploy_completed directive', {
        problem: UNPARSEABLE,
        snippet: snippetAround(text, MARKER),
      });
      rejections.push({ problem: UNPARSEABLE });
    }

    if (payloads.length === 0) {
      return { payloads, rejections, cleanedText: text };
    }
    strip.sort((a, b) => a[0] - b[0]);
    const stripped = DeployCompletedDirectiveHandler.strip(text, strip);
    return { payloads, rejections, cleanedText: DeployCompletedDirectiveHandler.dropEmptyFences(stripped) };
  }

  /**
   * A fence whose directives were all cut out is left holding nothing but
   * whitespace, commas and array brackets: drop it, as stripping a one-directive
   * fence does. It goes together with the whitespace-only lines right around it
   * (the next line keeps its indentation). A run of adjacent emptied fences
   * becomes one blank line between the text on either side, or nothing at the
   * start or end; nothing else in the text is touched.
   */
  private static dropEmptyFences(text: string): string {
    const GAP = '\u0000';
    // GAP marks removed fences; text that already holds one is left as is.
    if (text.includes(GAP)) return text;
    const marked = text.replace(
      /(?:[ \t]*\n)*[ \t]*```json\s*\n?([\s\S]*?)\n?```[ \t]*(?:\n[ \t]*(?=\n))*\n?/g,
      (fence: string, body: string) => (/^[\s,[\]]*$/.test(body) ? GAP : fence),
    );
    if (marked === text) return text;
    return marked.replace(/\u0000+/g, (run: string, offset: number) =>
      offset === 0 || offset + run.length === marked.length ? '' : '\n\n',
    );
  }

  /**
   * Cut the ranges out and join what remains the way channel_message does for a
   * single directive: each piece trimmed, empty pieces dropped, joined by a blank line.
   */
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

  /**
   * Parse one JSON candidate. Null when it is not JSON or not a deploy_completed
   * object; a rejection (logged with the raw field values) when a field is bad.
   */
  private static parse(jsonStr: string): ParseResult {
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
    const hasConfirmed = parsed.confirmed !== undefined && parsed.confirmed !== null;

    const problem = !REPO_PATTERN.test(repo)
      ? 'repo must be owner/repo'
      : !target || /\s/.test(target)
        ? 'target must be a branch name'
        : !SHA_PATTERN.test(after)
          ? 'after must be a 7-40 char hex sha'
          : hasBefore && !(before && SHA_PATTERN.test(before))
            ? 'before must be a 7-40 char hex sha when present'
            : hasConfirmed && typeof parsed.confirmed !== 'boolean'
              ? 'confirmed must be true or false'
              : null;
    if (problem) {
      const raw = {
        repo: rawField(parsed.repo),
        target: rawField(parsed.target),
        before: rawField(parsed.before),
        after: rawField(parsed.after),
      };
      logger.warn('Ignoring invalid deploy_completed directive', { problem, ...raw });
      const rejection: DeployCompletedRejection = { problem };
      for (const [key, value] of Object.entries(raw)) {
        if (value !== undefined) rejection[key as keyof typeof raw] = value;
      }
      return { rejection };
    }

    return {
      payload: {
        repo,
        target,
        ...(hasBefore && before ? { before: before.toLowerCase() } : {}),
        after: after.toLowerCase(),
        confirmed: parsed.confirmed !== false,
      },
    };
  }
}

/** A field as the model wrote it, short enough for a log line and a Slack reply. */
function rawField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) count++;
  return count;
}

function snippetAround(text: string, needle: string): string {
  const at = Math.max(0, text.indexOf(needle) - 60);
  return text.slice(at, at + 200);
}
