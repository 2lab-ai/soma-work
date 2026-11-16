/**
 * ToolResultInterceptor — the PR creates and merges a tool batch's GitHub write effects proved (`githubEffectsOf`, #832)
 * become `pr_created` / `pr_merged` metrics, like the card.
 *
 * Code-change lines are not read from command output any more (.prd/26 §5, #1297): `git commit` output parsing missed
 * quiet, piped and root commits (48 commits recorded against 1,326 PRs in 30 days), and `gh pr view --json additions`
 * counted any viewed PR, merged or not, every time it was viewed. Commit and merge lines now come from the session's code
 * changes (src/code-changes/metrics.ts), once each.
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
 * Emit the PR metrics of a tool batch's proven GitHub effects. Fire-and-forget — must never block the main pipeline.
 * `toolResults` is kept for the call shape; command output is not read (see the module comment).
 */
export function interceptToolResults(
  _toolResults: ToolResultLike[],
  userId: string,
  userName: string,
  sessionKey: string,
  githubEffects?: ReadonlyArray<GitHubEffect>,
): void {
  emitPrEffects(githubEffects, userId, userName, sessionKey);
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
