/**
 * .prd/29 §4 — what GitHub says about how the session's issues and PRs relate, as issue-tree entries for the host
 * (`SessionRegistry.noteIssueTree`): the issues a PR closes (`Closes #N` in its body), the PR a PR is stacked on (its
 * base branch is another session PR's head), an issue's GitHub parent (`parent_issue_url`). Pure, except the one read
 * of an issue (`refreshIssueEntries`, given its fetcher).
 */
import type { IssueTreeLinkInput } from 'somalib/model-commands/issue-tree';

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

/** The session's PRs as tree entries: title and state, the issues each closes, the session PR each is stacked on. */
export function prTreeEntries(prs: ReadonlyArray<PrRelationSource>): IssueTreeLinkInput[] {
  return prs.map((pr) => {
    // Stacked: its base branch is the head branch of another session PR in the same repository (not a fork's).
    const base = pr.baseRef
      ? prs.find(
          (o) => o !== pr && o.repo === pr.repo && !o.headRepo && o.headRef === pr.baseRef && o.state !== 'closed',
        )
      : undefined;
    const rel = {
      ...(pr.closes && pr.closes.length ? { closes: pr.closes } : {}),
      ...(base ? { base: base.url } : {}),
    };
    return {
      kind: 'pr' as const,
      url: pr.url,
      provider: 'github' as const,
      ...(pr.title ? { title: pr.title } : {}),
      status: pr.state,
      ...(Object.keys(rel).length ? { rel } : {}),
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
): Promise<Array<IssueTreeLinkInput & { checkedAt?: number }>> {
  const out: Array<IssueTreeLinkInput & { checkedAt?: number }> = [];
  for (const url of urls.slice(0, max)) {
    const m = ISSUE_URL.exec(url.replace(/\/+$/, ''));
    if (!m) continue;
    const meta = await fetchIssue(m[1], m[2], Number(m[3]));
    if (!meta) continue;
    if (meta.parentUrl) out.push({ kind: 'issue', url: meta.parentUrl, provider: 'github' });
    out.push({
      kind: 'issue',
      url,
      provider: 'github',
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.state ? { status: meta.state } : {}),
      ...(meta.parentUrl ? { rel: { subOf: meta.parentUrl } } : {}),
      checkedAt: now,
    });
  }
  return out;
}
