/**
 * The code-change metrics (.prd/26 §5, #1297) — one source: the session's code changes, not command output.
 *
 *   merge_lines_added   a session PR seen merged: GitHub's additions / deletions, on its merge day
 *   commit_created      a commit made in a session checkout (HEAD reflog), on the day it was made
 *   code_lines_added    the same commit's line counts
 *
 * Every event carries a fixed id (the PR URL, the commit sha) and is written first-writer-wins: the store keeps one row
 * however often the same merge or commit is seen — a restart, a second collect, the PR watch — and a second session that
 * links the same PR does not move it to its owner (#1301 review).
 *
 * What the old command-output parsers already recorded is not counted again: a merge the session's `mergeStats` already
 * holds (that parser wrote both) is skipped, and commits count only from the moment this host started counting them
 * (`CodeChangesStore.countingSince`) — the parser's commit rows have random ids that no fixed id could replace.
 */

import type { MetricsEventEmitter } from '../metrics/event-emitter';
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
 * a record the old command-output parser wrote (it kept no URL), but only when the number is unambiguous: among the
 * session's PR links (`sessionPrUrls`) no other repository has a PR with that number. True when it was added.
 */
export function addMergedPr(stats: MergeStats, pr: MergedPr, sessionPrUrls: string[] = []): boolean {
  const numberOf = (url: string) => Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  const sameNumber = new Set(sessionPrUrls.filter((u) => numberOf(u) === pr.prNumber));
  sameNumber.add(pr.prUrl);
  const legacyMatches = sameNumber.size === 1;
  const seen = stats.mergedPRs.some((m) =>
    m.prUrl ? m.prUrl === pr.prUrl : legacyMatches && m.prNumber === pr.prNumber,
  );
  if (seen) return false;
  stats.totalLinesAdded += pr.linesAdded;
  stats.totalLinesDeleted += pr.linesDeleted;
  stats.mergedPRs.push({ ...pr });
  return true;
}

export interface CodeMetricsSink {
  emitter: Pick<MetricsEventEmitter, 'emitGitHubEvent'>;
  /** The session's merge total on its card (`mergeStats`): false when the PR is already there. */
  recordMerge?: (pr: MergedPr) => boolean;
  logger?: { error: (msg: string, err?: unknown) => void };
}

/**
 * Emit the metrics a collect found new. Merges are fire-and-forget. The promise settles once every commit row was
 * written, and rejects when one was not: the caller marks the commits counted only after it resolves, so a commit
 * whose row failed is handed on again next time (its rows are written first-wins, so a second write adds nothing).
 */
export async function emitCodeMetrics(
  result: Pick<CollectResult, 'newMerges' | 'newCommits'>,
  who: { userId: string; userName: string; sessionKey: string },
  sink: CodeMetricsSink,
): Promise<void> {
  const fail = (what: string) => (err: unknown) => sink.logger?.error(`Failed to emit ${what}`, err);
  const commitWrites: Array<Promise<unknown>> = [];
  let commitFailed = false;
  const track = (what: string, write: Promise<unknown>) =>
    commitWrites.push(
      write.catch((err) => {
        commitFailed = true;
        fail(what)(err);
      }),
    );
  for (const pr of result.newMerges) {
    try {
      const mergedAt = pr.mergedAt ?? Date.now();
      const added = sink.recordMerge?.({
        prNumber: pr.number,
        prUrl: pr.url,
        linesAdded: pr.additions,
        linesDeleted: pr.deletions,
        mergedAt,
      });
      // Already in the session's merge total: the old parser wrote that record and its metric together.
      if (added === false) continue;
      sink.emitter
        .emitGitHubEvent(
          'merge_lines_added',
          who.userId,
          who.userName,
          who.sessionKey,
          { prNumber: pr.number, prUrl: pr.url, linesAdded: pr.additions, linesDeleted: pr.deletions },
          { id: `merge_lines:${pr.url}`, timestamp: mergedAt, ifAbsent: true },
        )
        .catch(fail('merge_lines_added'));
    } catch (err) {
      fail('merge_lines_added')(err);
    }
  }
  for (const c of result.newCommits) {
    try {
      const meta = { commitSha: c.sha, repo: c.repo, linesAdded: c.additions, linesDeleted: c.deletions };
      track(
        'commit_created',
        sink.emitter.emitGitHubEvent('commit_created', who.userId, who.userName, who.sessionKey, meta, {
          id: `commit:${c.sha}`,
          timestamp: c.at,
          ifAbsent: true,
        }),
      );
      if (c.additions > 0 || c.deletions > 0) {
        track(
          'code_lines_added',
          sink.emitter.emitGitHubEvent(
            'code_lines_added',
            who.userId,
            who.userName,
            who.sessionKey,
            { linesAdded: c.additions, linesDeleted: c.deletions, commitSha: c.sha },
            { id: `commit_lines:${c.sha}`, timestamp: c.at, ifAbsent: true },
          ),
        );
      }
    } catch (err) {
      commitFailed = true;
      fail('commit_created')(err);
    }
  }
  await Promise.all(commitWrites);
  if (commitFailed) throw new Error('a commit metric was not written');
}
