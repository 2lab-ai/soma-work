/**
 * A work session's code changes (.prd/26, .prd/27 §3): what the session did to code, in four layers that do not overlap.
 *
 *   uncommitted  the working tree and index against HEAD, new untracked files included
 *   committed    commits in HEAD that no pull request of the session has yet
 *   pr           the files of the session's open (or draft) pull requests
 *   merged       the files of the session's merged pull requests
 *
 * One document per conversation holds the patches (CodeChangesStore); the session keeps only the summary
 * (`ConversationSession.codeChanges`), which the model reads and the board stamps.
 */

export type ChangeLayer = 'uncommitted' | 'committed' | 'pr' | 'merged';
export const CHANGE_LAYERS: readonly ChangeLayer[] = ['uncommitted', 'committed', 'pr', 'merged'];

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  /** The path before a rename. */
  oldPath?: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  binary?: true;
  /** Unified hunks from the first `@@` on; absent for a binary file, a file past the budget, or in a list answer. */
  patch?: string;
  /** The patch was cut at the per-file budget. */
  patchTruncated?: true;
}

export interface LayerFiles {
  files: ChangedFile[];
  additions: number;
  deletions: number;
  /** More files changed than the layer keeps. */
  truncated?: true;
}

export interface CommitRef {
  sha: string;
  subject: string;
  /** Committer time, epoch ms. */
  at: number;
}

export interface CheckoutChanges {
  /** Stable id of the checkout within the document: a short hash of its directory. */
  id: string;
  /** `owner/name` (lower case) for a GitHub remote, else `local:<folder name>`. */
  repo: string;
  /** The checkout's directory relative to the session's own folder when under it, else its folder name. */
  dir: string;
  branch?: string;
  head?: string;
  /**
   * `skipped` says why a layer was not read this time (the repository's config runs commands, git failed, the git dir
   * changed during the read). A layer read before is kept as it was then, with the reason; else it is empty.
   */
  uncommitted: LayerFiles & {
    skipped?: string;
  };
  committed: LayerFiles & {
    /** The commit the layer is measured from. */
    base?: string;
    commits: CommitRef[];
    skipped?: string;
  };
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';

export interface PrChanges {
  /** `owner/name#number` (lower-case repo). */
  id: string;
  url: string;
  repo: string;
  number: number;
  title?: string;
  state: PrState;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRef?: string;
  headSha?: string;
  /** The head's repository (`owner/name`, lower case) when it is not `repo` — a fork's branch. */
  headRepo?: string;
  /** The base commit the files were read against: a moved base changes them, the head staying put. */
  baseSha?: string;
  /** Epoch ms. */
  createdAt?: number;
  /** Epoch ms. */
  mergedAt?: number;
  files: ChangedFile[];
  filesTruncated?: true;
  /** The last files request failed (or stopped part-way): the next collect asks again, whatever the head. */
  filesStale?: true;
  /** Patches were dropped for the document's size budget: the next collect reads the files again. */
  patchesDropped?: true;
  fetchedAt: number;
}

export interface CodeChangesDoc {
  version: 1;
  conversationId: string;
  owner: { id: string; name: string };
  sessionStartedAt?: number;
  updatedAt: number;
  checkouts: CheckoutChanges[];
  /** The session's own pull requests (created after it started), newest first. */
  prs: PrChanges[];
  /** What the metrics already hold for this conversation — commit shas whose lines were recorded. */
  counted: { commits: string[] };
}

export interface LayerTotals {
  files: number;
  additions: number;
  deletions: number;
}

/** What the session keeps and the model reads: counts and a few paths, never a patch. */
export interface CodeChangesSummary {
  updatedAt: number;
  layers: Record<ChangeLayer, LayerTotals>;
  repos: Array<{
    repo: string;
    dir?: string;
    branch?: string;
    uncommitted: LayerTotals;
    committed: LayerTotals & { commits: number };
    /** The first paths of the uncommitted, then committed, layer (≤ 8). */
    paths: string[];
    skipped?: string;
  }>;
  prs: Array<{
    url: string;
    number: number;
    repo: string;
    state: PrState;
    additions: number;
    deletions: number;
    changedFiles: number;
  }>;
}
