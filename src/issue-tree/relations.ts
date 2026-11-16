/**
 * .prd/29 §4 — what GitHub says about how the session's issues and PRs relate, as issue-tree entries for the host
 * (`SessionRegistry.noteIssueTree`): the issues a PR closes (`Closes #N` in its body), the PR a PR is stacked on (its
 * base branch is another session PR's head), an issue's GitHub parent (`parent_issue_url`). Pure, except the one read
 * of an issue (`refreshIssueEntries`, given its fetcher).
 */
import type { IssueTreeLinkInput } from 'somalib/model-commands/issue-tree';

/**
 * What a read tells the tree, beyond the node itself: a read result changes a node that is still there and never brings
 * a removed one back (`onlyIfPresent`); a parent issue joins only while the issue it was read for is there (`addedFor`);
 * a failed read is stamped (`triedAt`) so the next pass reads the others first.
 */
export type IssueTreeNote = IssueTreeLinkInput & {
  checkedAt?: number;
  triedAt?: number;
  onlyIfPresent?: boolean;
  addedFor?: string;
  /** When the read began: a parent the model removed after it does not come back. */
  readAt?: number;
};

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi;
export const MAX_CLOSING_ISSUES = 5;

/** The GitHub issues a PR body says it closes (`Closes #12`, `fixes owner/repo#3`), as issue URLs, at most five. */
export function closingIssueUrls(body: string | null | undefined, owner: string, repo: string): string[] {
  const out: string[] = [];
  for (const m of (body ?? '').matchAll(CLOSING)) {
    const url = `https://github.com/${m[1] ?? owner}/${m[2] ?? repo}/issues/${m[3]}`;
    if (out.some((u) => u.toLowerCase() === url.toLowerCase())) continue;
    out.push(url);
    if (out.length >= MAX_CLOSING_ISSUES) break;
  }
  return out;
}

/** A PR as the code-changes collector stored it (the fields these relations read). */
export interface PrRelationSource {
  url: string;
  repo: string;
  title?: string;
  state: string;
  headRef?: string;
  headRepo?: string;
  baseRef?: string;
  closes?: string[];
}

/**
 * The session's PRs as tree entries: title and state, the issues each closes, the session PR each is stacked on. A read
 * is the truth for both relations: no closing ref or no stack clears what an older body said. A record from before
 * .prd/29 (no `closes`, no `baseRef`) read neither, so it leaves them as they are. The entries change only nodes still in
 * the tree: a PR the model removed while the collect ran does not come back.
 */
export function prTreeEntries(prs: ReadonlyArray<PrRelationSource>): IssueTreeNote[] {
  return prs.map((pr) => {
    // Stacked: its base branch is the head branch of another session PR in the same repository (not a fork's).
    const bases = pr.baseRef
      ? prs.filter(
          (o) => o !== pr && o.repo === pr.repo && !o.headRepo && o.headRef === pr.baseRef && o.state !== 'closed',
        )
      : [];
    // A branch reused in one session: the live PR (open or draft) before a merged one.
    const base = bases.find((o) => o.state !== 'merged') ?? bases[0];
    return {
      kind: 'pr' as const,
      url: pr.url,
      provider: 'github' as const,
      ...(pr.title ? { title: pr.title } : {}),
      status: pr.state,
      rel: {
        ...(pr.closes ? { closes: pr.closes } : {}),
        ...(pr.baseRef !== undefined ? { base: base ? base.url : null } : {}),
      },
      onlyIfPresent: true,
    };
  });
}

/** One GitHub issue as `GET /repos/{o}/{r}/issues/{n}` describes it — what the tree reads. */
export interface GitHubIssueMeta {
  title?: string;
  state?: string;
  /** The parent issue's web URL (from `parent_issue_url`), when it is a sub-issue. */
  parentUrl?: string;
}

const ISSUE_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/i;

/** `https://api.github.com/repos/o/r/issues/7` → `https://github.com/o/r/issues/7`. */
export function issueWebUrl(apiUrl: string | null | undefined): string | undefined {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/i.exec(apiUrl ?? '');
  return m ? `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}` : undefined;
}

/**
 * Reads each GitHub issue once (the ones the tree has not checked, at most `max`): its title and state, and its GitHub
 * parent — which joins the tree too (it is related), to be read in its turn. A failed read is retried next time.
 */
export async function refreshIssueEntries(
  urls: ReadonlyArray<string>,
  fetchIssue: (owner: string, repo: string, number: number) => Promise<GitHubIssueMeta | undefined>,
  now: number,
  max = 8,
): Promise<IssueTreeNote[]> {
  const out: IssueTreeNote[] = [];
  // A query or a comment anchor (`#issuecomment-1`) is the same issue; a URL that is not an issue takes no read slot.
  const issues = urls
    .map((url) => ({ url, m: ISSUE_URL.exec(url.replace(/[?#].*$/, '').replace(/\/+$/, '')) }))
    .filter((x): x is { url: string; m: RegExpExecArray } => !!x.m);
  for (const { url, m } of issues.slice(0, max)) {
    const meta = await fetchIssue(m[1], m[2], Number(m[3]));
    if (!meta) {
      out.push({ kind: 'issue', url, triedAt: now, onlyIfPresent: true });
      continue;
    }
    if (meta.parentUrl)
      out.push({ kind: 'issue', url: meta.parentUrl, provider: 'github', addedFor: url, readAt: now });
    out.push({
      kind: 'issue',
      url,
      provider: 'github',
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.state ? { status: meta.state } : {}),
      rel: { subOf: meta.parentUrl ?? null },
      checkedAt: now,
      onlyIfPresent: true,
    });
  }
  return out;
}
