/**
 * ToolResultInterceptor — Detects git/gh commands in Bash tool results
 * and emits corresponding metrics events.
 *
 * Trace: docs/daily-weekly-report/trace.md, Scenario 3
 */

import { Logger } from '../logger';
import { getMetricsEmitter } from './event-emitter';

const logger = new Logger('ToolResultInterceptor');

interface ToolResultLike {
  toolName?: string;
  toolUseId: string;
  result: any;
  isError?: boolean;
}

/**
 * Parse commit info from git commit output.
 * Example output: "[main abc1234] commit message\n 3 files changed, 50 insertions(+), 10 deletions(-)"
 */
function parseGitCommitResult(output: string): { sha?: string; linesAdded?: number; linesDeleted?: number } | null {
  // Match: [branch sha] message
  const commitMatch = output.match(/\[[\w/.-]+\s+([a-f0-9]{7,})\]/);
  if (!commitMatch) return null;

  const sha = commitMatch[1];

  // Match: N insertions(+), M deletions(-)
  const statsMatch = output.match(/(\d+)\s+insertion[s]?\(\+\)/);
  const delMatch = output.match(/(\d+)\s+deletion[s]?\(-\)/);
  const linesAdded = statsMatch ? parseInt(statsMatch[1], 10) : 0;
  const linesDeleted = delMatch ? parseInt(delMatch[1], 10) : 0;

  return { sha, linesAdded, linesDeleted };
}

/**
 * Parse PR creation from gh pr create output.
 * Example: "https://github.com/org/repo/pull/123"
 */
function parseGhPrCreateResult(output: string): { prUrl?: string; prNumber?: number } | null {
  const match = output.match(/(https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+))/);
  if (!match) return null;
  return { prUrl: match[1], prNumber: parseInt(match[2], 10) };
}

/**
 * Parse PR merge from gh pr merge output.
 * Example: "✓ Merged pull request #123" or "Merged" or merge URL
 */
function parseGhPrMergeResult(output: string): { prNumber?: number } | null {
  // "✓ Merged pull request #123"
  const match = output.match(/[Mm]erged\s+pull\s+request\s+#(\d+)/);
  if (match) return { prNumber: parseInt(match[1], 10) };

  // Just "Merged" with a PR number somewhere
  const numMatch = output.match(/#(\d+)/);
  if (output.toLowerCase().includes('merged') && numMatch) {
    return { prNumber: parseInt(numMatch[1], 10) };
  }

  return null;
}

/**
 * Inspect tool results for git/gh commands and emit metrics events.
 * Fire-and-forget — must never block the main pipeline.
 *
 * @param toolResults Array of tool result objects from stream-executor
 * @param userId Slack user ID of the session owner
 * @param userName Slack display name
 * @param sessionKey Session key for context
 */
export function interceptToolResults(
  toolResults: ToolResultLike[],
  userId: string,
  userName: string,
  sessionKey: string,
): void {
  for (const tr of toolResults) {
    // Only inspect Bash tool results that succeeded
    if (tr.toolName !== 'Bash' || tr.isError) continue;

    const output = typeof tr.result === 'string' ? tr.result : String(tr.result || '');
    if (!output) continue;

    try {
      const emitter = getMetricsEmitter();

      // Detect git commit
      const commitInfo = parseGitCommitResult(output);
      if (commitInfo) {
        emitter.emitGitHubEvent('commit_created', userId, userName, sessionKey, {
          commitSha: commitInfo.sha,
          linesAdded: commitInfo.linesAdded,
          linesDeleted: commitInfo.linesDeleted,
        }).catch(err => logger.error('Failed to emit metrics event', err));

        // Also emit code_lines_added if there are lines
        if (commitInfo.linesAdded && commitInfo.linesAdded > 0) {
          emitter.emitGitHubEvent('code_lines_added', userId, userName, sessionKey, {
            linesAdded: commitInfo.linesAdded,
            linesDeleted: commitInfo.linesDeleted,
          }).catch(err => logger.error('Failed to emit metrics event', err));
        }

        logger.debug(`Detected git commit: ${commitInfo.sha}, +${commitInfo.linesAdded}/-${commitInfo.linesDeleted}`);
      }

      // Detect gh pr create
      const prCreateInfo = parseGhPrCreateResult(output);
      if (prCreateInfo) {
        emitter.emitGitHubEvent('pr_created', userId, userName, sessionKey, {
          prUrl: prCreateInfo.prUrl,
          prNumber: prCreateInfo.prNumber,
        }).catch(err => logger.error('Failed to emit pr_created', err));

        logger.debug(`Detected PR create: ${prCreateInfo.prUrl}`);
      }

      // Detect gh pr merge
      const mergeInfo = parseGhPrMergeResult(output);
      if (mergeInfo) {
        emitter.emitGitHubEvent('pr_merged', userId, userName, sessionKey, {
          prNumber: mergeInfo.prNumber,
        }).catch(err => logger.error('Failed to emit pr_merged', err));

        logger.debug(`Detected PR merge: #${mergeInfo.prNumber}`);
      }
    } catch (error) {
      // Fire-and-forget: never block
      logger.error('Failed to intercept tool result', error);
    }
  }
}

// Export parsers for testing
export { parseGitCommitResult, parseGhPrCreateResult, parseGhPrMergeResult };
