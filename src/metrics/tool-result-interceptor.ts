/**
 * ToolResultInterceptor — Detects git/gh commands in Bash tool results
 * and emits corresponding metrics events.
 *
 * PR creates and merges are not parsed here: they come from the GitHub write effects the card uses too
 * (`githubEffectsOf`, #832) — one parser, and a PR URL in a read's output is no longer a created PR.
 *
 * Trace: docs/archive/features/daily-weekly-report/trace.md, Scenario 3
 */

import type { GitHubEffect } from '@soma/slack/session-link-capture';
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
export function parseGitCommitResult(
  output: string,
): { sha?: string; linesAdded?: number; linesDeleted?: number } | null {
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
 * Parse gh pr view --json additions,deletions output.
 * Example: {"additions":150,"deletions":30}
 */
function parseGhPrViewStats(output: string): { additions: number; deletions: number } | null {
  try {
    // Look for JSON with additions/deletions fields
    const jsonMatch = output.match(/\{[^}]*"additions"\s*:\s*\d+[^}]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.additions === 'number' && typeof parsed.deletions === 'number') {
        return { additions: parsed.additions, deletions: parsed.deletions };
      }
    }
  } catch {
    // Not valid JSON, ignore
  }
  return null;
}

/**
 * Callback for recording merge stats into the session.
 */
export type MergeStatsCallback = (
  sessionKey: string,
  prNumber: number,
  linesAdded: number,
  linesDeleted: number,
) => void;

/**
 * Inspect tool results for git/gh commands and emit metrics events.
 * Fire-and-forget — must never block the main pipeline.
 *
 * @param toolResults Array of tool result objects from stream-executor
 * @param userId Slack user ID of the session owner
 * @param userName Slack display name
 * @param sessionKey Session key for context
 * @param onMergeStats Optional callback to record merge line stats into session
 * @param githubEffects The PR creates and merges this batch proved (`githubEffectsOf`) — the only source of
 *   `pr_created` / `pr_merged`
 */
export function interceptToolResults(
  toolResults: ToolResultLike[],
  userId: string,
  userName: string,
  sessionKey: string,
  onMergeStats?: MergeStatsCallback,
  githubEffects?: ReadonlyArray<GitHubEffect>,
): void {
  emitPrEffects(githubEffects, userId, userName, sessionKey);
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
        emitter
          .emitGitHubEvent('commit_created', userId, userName, sessionKey, {
            commitSha: commitInfo.sha,
            linesAdded: commitInfo.linesAdded,
            linesDeleted: commitInfo.linesDeleted,
          })
          .catch((err) => logger.error('Failed to emit metrics event', err));

        // Also emit code_lines_added if there are lines
        if (commitInfo.linesAdded && commitInfo.linesAdded > 0) {
          emitter
            .emitGitHubEvent('code_lines_added', userId, userName, sessionKey, {
              linesAdded: commitInfo.linesAdded,
              linesDeleted: commitInfo.linesDeleted,
            })
            .catch((err) => logger.error('Failed to emit metrics event', err));
        }

        logger.debug(`Detected git commit: ${commitInfo.sha}, +${commitInfo.linesAdded}/-${commitInfo.linesDeleted}`);
      }

      // Detect gh pr view --json additions,deletions (for merge stats)
      const prViewStats = parseGhPrViewStats(output);
      if (prViewStats && onMergeStats) {
        // Try to find the PR number from the same output or recent context
        // gh pr view output often includes the PR number in the JSON
        let prNum: number | undefined;
        try {
          const jsonMatch = output.match(/\{[^}]*"number"\s*:\s*(\d+)[^}]*\}/);
          if (jsonMatch) prNum = parseInt(jsonMatch[1], 10);
        } catch {
          /* ignore */
        }

        if (prNum) {
          onMergeStats(sessionKey, prNum, prViewStats.additions, prViewStats.deletions);
          emitter
            .emitGitHubEvent('merge_lines_added', userId, userName, sessionKey, {
              prNumber: prNum,
              linesAdded: prViewStats.additions,
              linesDeleted: prViewStats.deletions,
            })
            .catch((err) => logger.error('Failed to emit merge_lines_added', err));
          logger.debug(`Recorded merge stats: PR #${prNum} +${prViewStats.additions}/-${prViewStats.deletions}`);
        }
      }
    } catch (error) {
      // Fire-and-forget: never block
      logger.error('Failed to intercept tool result', error);
    }
  }
}

/** `pr_created` / `pr_merged` for the PRs a batch's writes created or merged (fire-and-forget). */
function emitPrEffects(
  effects: ReadonlyArray<GitHubEffect> | undefined,
  userId: string,
  userName: string,
  sessionKey: string,
): void {
  for (const e of effects ?? []) {
    if (e.link.type !== 'pr' || (e.op !== 'create' && e.op !== 'merge')) continue;
    const prNumber = Number(e.link.url.match(/\/pull\/(\d+)/)?.[1]);
    if (!prNumber) continue;
    try {
      const emitter = getMetricsEmitter();
      if (e.op === 'create') {
        emitter
          // `proven`: this create was proven by its own result (#832) — the leak report (#835) trusts only these.
          .emitGitHubEvent('pr_created', userId, userName, sessionKey, { prUrl: e.link.url, prNumber, proven: true })
          .catch((err) => logger.error('Failed to emit pr_created', err));
      } else {
        emitter
          .emitGitHubEvent('pr_merged', userId, userName, sessionKey, { prNumber })
          .catch((err) => logger.error('Failed to emit pr_merged', err));
      }
    } catch (error) {
      logger.error('Error emitting PR effect metrics', error);
    }
  }
}
