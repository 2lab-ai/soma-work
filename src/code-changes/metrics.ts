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
 * What the old command-output parsers already recorded is not counted again, and nothing they wrote stands in for a
 * real merge. The boundary is the moment this host started counting from the collector (`CodeChangesStore.countingSince`):
 * commits count from then on — the parser's commit rows have random ids that no fixed id could replace — and a merge the
 * session's `mergeStats` holds by number only (the parser's record, written with its own row) is skipped when it merged
 * before then; one merged after it was only a view of the open PR, so the merge counts, and the card's record is
 * replaced with GitHub's counts.
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

/** How a session's `mergeStats` already holds a PR: by its URL (the collector's record), by number only (the old parser's), or not. */
export type MergeRecord = 'url' | 'legacy' | undefined;

/**
 * The record of `pr` in a session's `mergeStats`: by URL; else one the old command-output parser wrote (it kept no URL)
 * with the same number — only when the number is unambiguous, i.e. among the session's PR links (`sessionPrUrls`) no
 * other repository has a PR with that number.
 */
export function mergeRecordOf(stats: MergeStats, pr: MergedPr, sessionPrUrls: string[] = []): MergeRecord {
  if (stats.mergedPRs.some((m) => m.prUrl === pr.prUrl)) return 'url';
  const numberOf = (url: string) => Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  const sameNumber = new Set(sessionPrUrls.filter((u) => numberOf(u) === pr.prNumber));
  sameNumber.add(pr.prUrl);
  if (sameNumber.size !== 1) return undefined;
  return stats.mergedPRs.some((m) => !m.prUrl && m.prNumber === pr.prNumber) ? 'legacy' : undefined;
}

/**
 * Put a merged PR in a session's `mergeStats` once, with GitHub's counts: added when it is not there; an old parser's
 * record of it — which may be a view of the PR while it was open, with that day's counts (#1301 review) — is replaced
 * and the totals moved by the difference. True when the stats changed.
 */
export function addMergedPr(stats: MergeStats, pr: MergedPr, sessionPrUrls: string[] = []): boolean {
  const record = mergeRecordOf(stats, pr, sessionPrUrls);
  if (record === 'url') return false;
  if (record === 'legacy') {
    const i = stats.mergedPRs.findIndex((m) => !m.prUrl && m.prNumber === pr.prNumber);
    const old = stats.mergedPRs[i];
    stats.totalLinesAdded += pr.linesAdded - old.linesAdded;
    stats.totalLinesDeleted += pr.linesDeleted - old.linesDeleted;
    stats.mergedPRs[i] = { ...pr };
    return true;
  }
  stats.totalLinesAdded += pr.linesAdded;
  stats.totalLinesDeleted += pr.linesDeleted;
  stats.mergedPRs.push({ ...pr });
  return true;
}

export interface CodeMetricsSink {
  emitter: Pick<MetricsEventEmitter, 'emitGitHubEvent'>;
  /** How the session's merge total on its card (`mergeStats`) holds the PR now (`mergeRecordOf`). */
  mergeRecord?: (pr: MergedPr) => MergeRecord;
  /** Put the PR in the session's merge total (`addMergedPr`) — only once its metric row was written. */
  recordMerge?: (pr: MergedPr) => void;
  /**
   * When this host started counting from the collector (`CodeChangesStore.countingSince`). An old parser's record of a
   * PR merged before it was that parser's to count; one merged after it was only a view, and the merge counts now.
   */
  countingSince?: number;
  logger?: { error: (msg: string, err?: unknown) => void };
}

/**
 * Emit the metrics a collect found new. The promise settles once every row was written, and rejects when one was not:
 * the caller marks the commits and merges counted only after it resolves, so one whose row failed is handed on again
 * next time (rows are written first-wins, so a second write adds nothing). A merge goes on the session's card only
 * after its row is written — a failed write never leaves a card record that would block the retry.
 */
export async function emitCodeMetrics(
  result: Pick<CollectResult, 'newMerges' | 'newCommits'>,
  who: { userId: string; userName: string; sessionKey: string },
  sink: CodeMetricsSink,
): Promise<void> {
  const fail = (what: string) => (err: unknown) => sink.logger?.error(`Failed to emit ${what}`, err);
  const writes: Array<Promise<unknown>> = [];
  let failed = false;
  const track = (what: string, write: Promise<unknown>) =>
    writes.push(
      write.catch((err) => {
        failed = true;
        fail(what)(err);
      }),
    );
  const strict = { ifAbsent: true, strict: true } as const;
  for (const pr of result.newMerges) {
    try {
      const merged: MergedPr = {
        prNumber: pr.number,
        prUrl: pr.url,
        linesAdded: pr.additions,
        linesDeleted: pr.deletions,
        mergedAt: pr.mergedAt ?? Date.now(),
      };
      const record = sink.mergeRecord?.(merged);
      // The old parser counted this merge itself (it saw the PR merged, before this host took over counting).
      const theirs = record === 'legacy' && merged.mergedAt < (sink.countingSince ?? Number.POSITIVE_INFINITY);
      const write = theirs
        ? Promise.resolve()
        : sink.emitter.emitGitHubEvent(
            'merge_lines_added',
            who.userId,
            who.userName,
            who.sessionKey,
            { prNumber: pr.number, prUrl: pr.url, linesAdded: pr.additions, linesDeleted: pr.deletions },
            { id: `merge_lines:${pr.url}`, timestamp: merged.mergedAt, ...strict },
          );
      track(
        'merge_lines_added',
        write.then(() => {
          if (record !== 'url') sink.recordMerge?.(merged);
        }),
      );
    } catch (err) {
      failed = true;
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
          ...strict,
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
            { id: `commit_lines:${c.sha}`, timestamp: c.at, ...strict },
          ),
        );
      }
    } catch (err) {
      failed = true;
      fail('commit_created')(err);
    }
  }
  await Promise.all(writes);
  if (failed) throw new Error('a code-change metric was not written');
}
