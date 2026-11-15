/**
 * The session's own pull requests as change layers (.prd/26 §3, .prd/27 §4): a PR on the session's card that GitHub
 * says was created after the session started. Its files and patches come from GitHub; a merged PR is read from the
 * stored record instead (it does not change), and any other whose head and base did not move keeps its stored files.
 */

import type { GitHubPullDetail, GitHubPullFile } from '../link-metadata-fetcher';
import { capPatch } from './git-diff-parse';
import type { ChangedFile, ChangedFileStatus, PrChanges, PrState } from './types';

export const MAX_SESSION_PRS = 20;
export const MAX_PR_FILES = 300;
/** A PR created this long before the session's recorded start still counts (clock skew, a start stamped late). */
export const PR_START_SLACK_MS = 2 * 60_000;

export interface PrDeps {
  fetchPullDetail: (owner: string, repo: string, number: number) => Promise<GitHubPullDetail | undefined>;
  fetchPullFiles: (
    owner: string,
    repo: string,
    number: number,
    max: number,
  ) => Promise<{ files: GitHubPullFile[]; truncated: boolean; complete?: boolean } | undefined>;
  now: () => number;
}

const PULL_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i;

export function pullRefOf(url: string): { owner: string; repo: string; number: number; id: string } | undefined {
  const m = PULL_URL.exec(url.trim());
  if (!m) return undefined;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  return { owner: m[1], repo: m[2], number, id: `${m[1]}/${m[2]}#${number}`.toLowerCase() };
}

function stateOf(d: GitHubPullDetail): PrState {
  if (d.merged || d.merged_at) return 'merged';
  if (d.state === 'closed') return 'closed';
  return d.draft ? 'draft' : 'open';
}

const FILE_STATUS: Record<string, ChangedFileStatus> = {
  added: 'added',
  removed: 'deleted',
  renamed: 'renamed',
  copied: 'added',
};

export function prFileOf(f: GitHubPullFile): ChangedFile {
  const file: ChangedFile = {
    path: f.filename,
    status: FILE_STATUS[f.status ?? ''] ?? 'modified',
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  };
  if (f.previous_filename && f.previous_filename !== f.filename) file.oldPath = f.previous_filename;
  if (typeof f.patch === 'string' && f.patch) {
    const capped = capPatch(f.patch);
    file.patch = capped.patch;
    if (capped.truncated) file.patchTruncated = true;
  } else if ((f.changes ?? 0) > 0) {
    // GitHub leaves the patch out of a diff too large to show.
    file.patchTruncated = true;
  } else if (file.status !== 'renamed') {
    file.binary = true;
  }
  return file;
}

const time = (iso: string | null | undefined): number | undefined => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
};

/**
 * The session's own PRs among `urls`, newest first. `prev` is the stored record: reused as is for a settled PR whose head
 * did not move, and kept when GitHub does not answer.
 */
export async function sessionPrChanges(
  urls: string[],
  startedAt: number | undefined,
  prev: PrChanges[],
  deps: PrDeps,
  /** Cuts the patches of each PR's freshly read files as they arrive; true when it dropped some. */
  trim?: (files: ChangedFile[]) => boolean,
): Promise<PrChanges[]> {
  const seen = new Set<string>();
  const out: PrChanges[] = [];
  for (const url of urls) {
    const ref = pullRefOf(url);
    if (!ref || seen.has(ref.id)) continue;
    seen.add(ref.id);
    if (seen.size > MAX_SESSION_PRS) break;
    const old = prev.find((p) => p.id === ref.id);
    // A merged PR does not change — unless its files never arrived whole, or the budget dropped their patches. A closed
    // one is asked again: it can be reopened, and merged later.
    if (old && old.state === 'merged' && !old.filesStale && !old.patchesDropped) {
      out.push(old);
      continue;
    }
    const detail = await deps.fetchPullDetail(ref.owner, ref.repo, ref.number);
    if (!detail) {
      if (old) out.push(old);
      continue;
    }
    const createdAt = time(detail.created_at);
    // Not this session's: a PR it only looked at (created before it started).
    if (startedAt !== undefined && createdAt !== undefined && createdAt < startedAt - PR_START_SLACK_MS) continue;
    // The stored files are this head's against this base only when they arrived whole and kept their patches; a failed
    // or partial read, or one the budget cut, is asked again.
    const reusable =
      !!old &&
      !old.filesStale &&
      !old.patchesDropped &&
      !!old.headSha &&
      old.headSha === detail.head_sha &&
      old.baseSha === detail.base_sha;
    let files = reusable ? old.files : undefined;
    let filesTruncated = files ? old?.filesTruncated : undefined;
    let filesStale = false;
    let patchesDropped = false;
    if (!files) {
      const listed = await deps.fetchPullFiles(ref.owner, ref.repo, ref.number, MAX_PR_FILES);
      if (listed) {
        files = listed.files.map(prFileOf);
        if (trim?.(files)) patchesDropped = true;
        filesTruncated = listed.truncated || undefined;
        filesStale = listed.complete === false;
      } else {
        files = old?.files ?? [];
        filesTruncated = old?.filesTruncated;
        filesStale = true;
      }
    }
    const pr: PrChanges = {
      id: ref.id,
      url: detail.html_url || url,
      repo: `${ref.owner}/${ref.repo}`.toLowerCase(),
      number: ref.number,
      state: stateOf(detail),
      additions: detail.additions ?? files.reduce((n, f) => n + f.additions, 0),
      deletions: detail.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
      changedFiles: detail.changed_files ?? files.length,
      files,
      fetchedAt: deps.now(),
    };
    if (detail.title) pr.title = detail.title;
    if (detail.head_ref) pr.headRef = detail.head_ref;
    if (detail.head_sha) pr.headSha = detail.head_sha;
    if (detail.base_sha) pr.baseSha = detail.base_sha;
    const headRepo = detail.head_repo?.toLowerCase();
    if (headRepo && headRepo !== pr.repo) pr.headRepo = headRepo;
    if (createdAt !== undefined) pr.createdAt = createdAt;
    const mergedAt = time(detail.merged_at);
    if (mergedAt !== undefined) pr.mergedAt = mergedAt;
    if (filesTruncated) pr.filesTruncated = true;
    if (filesStale) pr.filesStale = true;
    if (patchesDropped) pr.patchesDropped = true;
    out.push(pr);
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
