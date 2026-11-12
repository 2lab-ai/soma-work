/**
 * An environment user's GitHub actions (env-access WU3, #1211): look at a PR, approve it, merge it — with the
 * environment's own token (an org-admin's, `{"$secret": …}` in config), which no model reads.
 *
 * - **view**: the PR's state, head SHA, base, author and checks.
 * - **approve**: only when the environment's `approveWhen` holds — the PR is open and not a draft, its author and
 *   base are listed, the caller's SHA is still the head, and every check is green (unless the environment sets
 *   `requiredChecksGreen: false`). The review is pinned to that SHA; if the head or the base changed while it was
 *   posted, the review is dismissed again.
 * - **merge**: only when `mergeWhen` holds the same way, with an allowed method. Head and base are read once more
 *   right before the merge, and the merge is pinned to the SHA, so a push after the look does not get merged.
 *   A retarget in the last moment before the merge is not caught here: a branch rule on the repository is what
 *   stops a merge into a branch this environment must not touch (.prd/24 §6).
 *
 * Every approve and merge is written to the audit ledger before it runs and again with its outcome.
 */

export interface EnvGithubConfig {
  /** The environment's GitHub token (resolved from `{"$secret": …}`). */
  token: string;
  /** Repositories this environment acts on, `owner/name`. */
  repos: string[];
  /** When this environment approves a PR. Unset: it approves none. */
  approveWhen?: PrConditions;
  /** When this environment merges a PR. Unset: it merges none. */
  mergeWhen?: PrConditions;
  /** Allowed merge methods; default `merge`. */
  mergeMethods?: ('merge' | 'squash' | 'rebase')[];
}

export interface PrConditions {
  /** PR authors (logins; a GitHub App's PRs are by `<app>[bot]`). */
  authors?: string[];
  /** Base branches. */
  bases?: string[];
  /**
   * Every check run and commit status on the head must have reported and be green. Default true; only `false`
   * turns it off.
   */
  requiredChecksGreen?: boolean;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface Checks {
  total: number;
  /** Checks that finished with success. Skipped and neutral ones are not a pass on their own. */
  passed: number;
  green: boolean;
  /** Names of checks that are not finished. */
  pending: string[];
  /** Names of checks that finished other than success, neutral or skipped. */
  failing: string[];
}

export interface PrState {
  repo: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  base: string;
  headSha: string;
  checks: Checks;
}

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubError';
  }
}

const API = 'https://api.github.com';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** The repository as configured (case-insensitive match), or a reason it is not allowed. */
export function allowedRepo(config: EnvGithubConfig, repo: unknown): string {
  if (typeof repo !== 'string' || !REPO.test(repo)) throw new GithubError('repo must be "owner/name"');
  const match = config.repos.find((r) => r.toLowerCase() === repo.toLowerCase());
  if (!match) throw new GithubError(`${repo} is not one of this environment's repositories`);
  return match;
}

export function prNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1e9) {
    throw new GithubError('pr must be a PR number');
  }
  return value;
}

export function headSha(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value))
    throw new GithubError('sha must be the full 40-character head SHA');
  return value;
}

async function call(fetch: Fetch, token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'soma-work-server-tools',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const message =
      json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string'
        ? (json as { message: string }).message
        : 'no message';
    throw new GithubError(`GitHub ${method} ${path} answered ${res.status}: ${message}`);
  }
  return json;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const GREEN_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** The PR as GitHub has it now, with the checks on its head. */
export async function prState(fetch: Fetch, config: EnvGithubConfig, repo: string, number: number): Promise<PrState> {
  const pr = obj(await call(fetch, config.token, 'GET', `/repos/${repo}/pulls/${number}`));
  const head = obj(pr.head);
  const sha = str(head.sha);
  const runs = obj(await call(fetch, config.token, 'GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`));
  const status = obj(await call(fetch, config.token, 'GET', `/repos/${repo}/commits/${sha}/status?per_page=100`));
  const pending: string[] = [];
  const failing: string[] = [];
  let passed = 0;
  const checkRuns = Array.isArray(runs.check_runs) ? runs.check_runs.map(obj) : [];
  for (const run of checkRuns) {
    const name = str(run.name) || 'check';
    if (run.status !== 'completed') pending.push(name);
    else if (!GREEN_CONCLUSIONS.has(str(run.conclusion))) failing.push(name);
    else if (run.conclusion === 'success') passed++;
  }
  // More check runs than one page cannot be judged here: not green.
  if (typeof runs.total_count === 'number' && runs.total_count > checkRuns.length) pending.push('(more checks)');
  const statuses = Array.isArray(status.statuses) ? status.statuses.map(obj) : [];
  for (const s of statuses) {
    const name = str(s.context) || 'status';
    if (s.state === 'pending') pending.push(name);
    else if (s.state !== 'success') failing.push(name);
    else passed++;
  }
  // The combined state covers every status, also those past this page. GitHub says `pending` when there are none.
  const statusTotal = typeof status.total_count === 'number' ? status.total_count : statuses.length;
  if (statusTotal > statuses.length) pending.push('(more statuses)');
  if (statusTotal > 0 && status.state !== 'success') {
    (status.state === 'pending' ? pending : failing).push('(combined status)');
  }
  const total = checkRuns.length + statuses.length;
  return {
    repo,
    number,
    title: str(pr.title),
    state: str(pr.state),
    draft: pr.draft === true,
    author: str(obj(pr.user).login),
    base: str(obj(pr.base).ref),
    headSha: sha,
    checks: {
      total,
      passed,
      // Right after a push nothing has reported yet, and a path filter may skip every workflow: green needs one
      // success and nothing unfinished or red.
      green: passed > 0 && pending.length === 0 && failing.length === 0,
      pending,
      failing,
    },
  };
}

function checksProblem(pr: PrState): string | undefined {
  if (pr.checks.green) return undefined;
  if (pr.checks.pending.length === 0 && pr.checks.failing.length === 0) {
    return pr.checks.total === 0
      ? 'no check has reported on the head yet'
      : 'no check has passed on the head (only skipped or neutral ones)';
  }
  const parts = [
    pr.checks.pending.length > 0 ? `not finished: ${pr.checks.pending.join(', ')}` : '',
    pr.checks.failing.length > 0 ? `not green: ${pr.checks.failing.join(', ')}` : '',
  ].filter(Boolean);
  return `checks are not all green (${parts.join('; ')})`;
}

function openAtHead(pr: PrState, sha: string): string | undefined {
  if (pr.state !== 'open') return `PR is ${pr.state}`;
  if (pr.draft) return 'PR is a draft';
  if (pr.headSha !== sha) return `head is ${pr.headSha}, not ${sha}: look again before acting`;
  return undefined;
}

function conditionsProblem(when: PrConditions, pr: PrState, sha: string, verb: string): string | undefined {
  const notOpen = openAtHead(pr, sha);
  if (notOpen) return notOpen;
  if (!when.authors?.includes(pr.author)) return `author ${pr.author} is not one this environment ${verb}`;
  if (!when.bases?.includes(pr.base)) return `base ${pr.base} is not one this environment ${verb} into`;
  // Green checks are required unless the environment explicitly says otherwise.
  if (when.requiredChecksGreen !== false) return checksProblem(pr);
  return undefined;
}

/** Why this environment will not approve the PR at `sha`, or undefined when it will. */
export function approvalProblem(config: EnvGithubConfig, pr: PrState, sha: string): string | undefined {
  if (!config.approveWhen) return 'this environment does not approve PRs (no approveWhen)';
  return conditionsProblem(config.approveWhen, pr, sha, 'approves');
}

/** Why this environment will not merge the PR at `sha` with `method`, or undefined when it will. */
export function mergeProblem(config: EnvGithubConfig, pr: PrState, sha: string, method: string): string | undefined {
  if (!config.mergeWhen) return 'this environment does not merge PRs (no mergeWhen)';
  const methods = config.mergeMethods ?? ['merge'];
  const problem = conditionsProblem(config.mergeWhen, pr, sha, 'merges');
  if (problem) return problem;
  if (!(methods as string[]).includes(method)) return `merge method ${method} is not allowed (${methods.join(', ')})`;
  return undefined;
}

/** Head and base as GitHub has them now. */
async function headAndBase(fetch: Fetch, config: EnvGithubConfig, repo: string, number: number) {
  const pr = obj(await call(fetch, config.token, 'GET', `/repos/${repo}/pulls/${number}`));
  return { head: str(obj(pr.head).sha), base: str(obj(pr.base).ref) };
}

/**
 * Approve at `sha`. The review is pinned to the SHA; afterwards the PR is read again, and if its head or base is
 * no longer what was approved — or the read fails — the review is dismissed and a `GithubError` says so (or that
 * the approval still stands, when the dismissal fails too).
 */
export async function approve(
  fetch: Fetch,
  config: EnvGithubConfig,
  repo: string,
  number: number,
  sha: string,
  base: string,
  body: string,
): Promise<void> {
  const review = obj(
    await call(fetch, config.token, 'POST', `/repos/${repo}/pulls/${number}/reviews`, {
      event: 'APPROVE',
      commit_id: sha,
      body,
    }),
  );
  let changed: string;
  try {
    const now = await headAndBase(fetch, config, repo, number);
    if (now.head === sha && now.base === base) return;
    changed = `the PR changed while it was being approved (head ${now.head}, base ${now.base})`;
  } catch (err) {
    // Not knowing is not confirming: the approval is taken back as if the PR had changed.
    const why = err instanceof GithubError ? err.message : 'error';
    changed = `the approval could not be confirmed (${why})`;
  }
  try {
    if (typeof review.id !== 'number') throw new GithubError('no review id');
    await call(fetch, config.token, 'PUT', `/repos/${repo}/pulls/${number}/reviews/${review.id}/dismissals`, {
      message: 'The PR changed while the environment was approving it.',
      event: 'DISMISS',
    });
  } catch (err) {
    const why = err instanceof GithubError ? err.message : 'error';
    throw new GithubError(`${changed}; dismissing the approval failed (${why}): it still stands`);
  }
  throw new GithubError(`${changed}; the approval was dismissed`);
}

/**
 * Merge at `sha` with `method`. Head and base are read once more first; the merge itself is pinned to the SHA.
 * Returns the merge commit SHA.
 */
export async function merge(
  fetch: Fetch,
  config: EnvGithubConfig,
  repo: string,
  number: number,
  sha: string,
  base: string,
  method: string,
): Promise<string> {
  const now = await headAndBase(fetch, config, repo, number);
  if (now.head !== sha || now.base !== base) {
    throw new GithubError(`the PR changed since the look (head ${now.head}, base ${now.base}): look again`);
  }
  const res = obj(
    await call(fetch, config.token, 'PUT', `/repos/${repo}/pulls/${number}/merge`, { sha, merge_method: method }),
  );
  return str(res.sha);
}
