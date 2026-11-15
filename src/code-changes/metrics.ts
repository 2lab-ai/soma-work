/**
 * The code-change metrics (.prd/26 §5, #1297) — one source: the session's code changes, not command output.
 *
 *   merge_lines_added   a session PR seen merged: GitHub's additions / deletions, on its merge day
 *   commit_created      a commit made in a session checkout (HEAD reflog), on the day it was made
 *   code_lines_added    the same commit's line counts
 *
 * Every event carries a fixed id (the PR URL, the commit sha), so the store's upsert keeps one row however often the
 * same merge or commit is seen — a restart, a second collect, the merge seen by a turn end and by the PR watch.
 */

import type { CollectResult } from './collector';

export interface MergeStats {
  totalLinesAdded: number;
  totalLinesDeleted: number;
  mergedPRs: Array<{ prNumber: number; prUrl?: string; linesAdded: number; linesDeleted: number; mergedAt: number }>;
}

export interface MergedPr {
  prNumber: number;
  prUrl: string;
  linesAdded: number;
  linesDeleted: number;
  mergedAt: number;
}

/**
 * Add a merged PR to a session's `mergeStats` once: not when a record of the same PR is there — by URL, or by number for
 * a record the old command-output parser wrote (it kept no URL). True when it was added.
 */
export function addMergedPr(stats: MergeStats, pr: MergedPr): boolean {
  if (stats.mergedPRs.some((m) => (m.prUrl ? m.prUrl === pr.prUrl : m.prNumber === pr.prNumber))) return false;
  stats.totalLinesAdded += pr.linesAdded;
  stats.totalLinesDeleted += pr.linesDeleted;
  stats.mergedPRs.push({ ...pr });
  return true;
}

export interface CodeMetricsEmitter {
  emitGitHubEvent(
    eventType: 'commit_created' | 'code_lines_added' | 'merge_lines_added',
    userId: string,
    userName: string,
    sessionKey: string,
    metadata: Record<string, unknown>,
    opts?: { id?: string; timestamp?: number },
  ): Promise<void>;
}

export interface CodeMetricsSink {
  emitter: CodeMetricsEmitter;
  /** The session's merge total on its card (`mergeStats`): false when the PR is already there. */
  recordMerge?: (pr: MergedPr) => boolean;
  logger?: { error: (msg: string, err?: unknown) => void };
}

/** Emit the metrics a collect found new (fire-and-forget; never throws). */
export function emitCodeMetrics(
  result: Pick<CollectResult, 'newMerges' | 'newCommits'>,
  who: { userId: string; userName: string; sessionKey: string },
  sink: CodeMetricsSink,
): void {
  const fail = (what: string) => (err: unknown) => sink.logger?.error(`Failed to emit ${what}`, err);
  for (const pr of result.newMerges) {
    try {
      const mergedAt = pr.mergedAt ?? Date.now();
      sink.recordMerge?.({
        prNumber: pr.number,
        prUrl: pr.url,
        linesAdded: pr.additions,
        linesDeleted: pr.deletions,
        mergedAt,
      });
      sink.emitter
        .emitGitHubEvent(
          'merge_lines_added',
          who.userId,
          who.userName,
          who.sessionKey,
          { prNumber: pr.number, prUrl: pr.url, linesAdded: pr.additions, linesDeleted: pr.deletions },
          { id: `merge_lines:${pr.url}`, timestamp: mergedAt },
        )
        .catch(fail('merge_lines_added'));
    } catch (err) {
      fail('merge_lines_added')(err);
    }
  }
  for (const c of result.newCommits) {
    try {
      const meta = { commitSha: c.sha, repo: c.repo, linesAdded: c.additions, linesDeleted: c.deletions };
      sink.emitter
        .emitGitHubEvent('commit_created', who.userId, who.userName, who.sessionKey, meta, {
          id: `commit:${c.sha}`,
          timestamp: c.at,
        })
        .catch(fail('commit_created'));
      if (c.additions > 0 || c.deletions > 0) {
        sink.emitter
          .emitGitHubEvent(
            'code_lines_added',
            who.userId,
            who.userName,
            who.sessionKey,
            { linesAdded: c.additions, linesDeleted: c.deletions, commitSha: c.sha },
            { id: `commit_lines:${c.sha}`, timestamp: c.at },
          )
          .catch(fail('code_lines_added'));
      }
    } catch (err) {
      fail('commit_created')(err);
    }
  }
}
