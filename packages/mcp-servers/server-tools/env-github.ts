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
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
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

/** A request that got no answer (a dropped connection, the timeout): it may or may not have reached GitHub. */
class NoAnswerError extends GithubError {}

/** A write that may have been made: it got no answer and its result could not be looked up either. */
export class OutcomeUnknownError extends GithubError {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeUnknownError';
  }
}

/** No GitHub call waits longer than this. */
const CALL_TIMEOUT_MS = 30_000;

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
  let res: HttpResponse;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'soma-work-server-tools',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new NoAnswerError(`GitHub ${method} ${path} got no answer (${err instanceof Error ? err.name : 'error'})`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // A success whose body cannot be read is no answer: a read refuses, a write is looked up.
    if (res.ok) throw new NoAnswerError(`GitHub ${method} ${path} answered ${res.status} with an unreadable body`);
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
  // Only the shape asked for is judged: anything else is not "no checks".
  if (!Array.isArray(runs.check_runs) || typeof runs.total_count !== 'number') {
    throw new GithubError(`GitHub answered an unexpected check-runs body for ${repo}#${number}`);
  }
  if (!Array.isArray(status.statuses) || typeof status.total_count !== 'number' || typeof status.state !== 'string') {
    throw new GithubError(`GitHub answered an unexpected status body for ${repo}#${number}`);
  }
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
  if (!Array.isArray(when.authors) || !when.authors.includes(pr.author)) {
    return `author ${pr.author} is not one this environment ${verb}`;
  }
  if (!Array.isArray(when.bases) || !when.bases.includes(pr.base)) {
    return `base ${pr.base} is not one this environment ${verb} into`;
  }
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
  let review: Obj;
  try {
    review = obj(
      await call(fetch, config.token, 'POST', `/repos/${repo}/pulls/${number}/reviews`, {
        event: 'APPROVE',
        commit_id: sha,
        body,
      }),
    );
  } catch (err) {
    if (!(err instanceof NoAnswerError)) throw err;
    review = await ownApproval(fetch, config, repo, number, sha);
  }
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
 * After an approval that got no answer: this token's latest approval of `sha`. Anything short of finding it —
 * not seen yet (GitHub may still be applying it), a full page, a malformed list, a failed lookup — is an
 * `OutcomeUnknownError`: the approval may stand.
 */
async function ownApproval(fetch: Fetch, config: EnvGithubConfig, repo: string, number: number, sha: string) {
  const unknown = (why: string) =>
    new OutcomeUnknownError(
      `the approval of ${repo}#${number} got no answer and ${why}: it may stand — check the PR before retrying`,
    );
  let login: string;
  let reviews: unknown;
  try {
    login = str(obj(await call(fetch, config.token, 'GET', '/user')).login);
    reviews = await call(fetch, config.token, 'GET', `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  } catch {
    throw unknown('could not be looked up');
  }
  if (login === '' || !Array.isArray(reviews)) throw unknown('the lookup answered something unexpected');
  const mine = reviews
    .map(obj)
    .filter((r) => str(obj(r.user).login) === login && r.state === 'APPROVED' && r.commit_id === sha)
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (mine) return mine;
  throw unknown(reviews.length >= 100 ? 'is not on the first page of reviews' : 'is not seen yet');
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
  try {
    const res = obj(
      await call(fetch, config.token, 'PUT', `/repos/${repo}/pulls/${number}/merge`, { sha, merge_method: method }),
    );
    return str(res.sha);
  } catch (err) {
    if (!(err instanceof NoAnswerError)) throw err;
  }
  // No answer: the PR says whether the merge was made.
  let after: Obj;
  try {
    after = obj(await call(fetch, config.token, 'GET', `/repos/${repo}/pulls/${number}`));
  } catch {
    throw new OutcomeUnknownError(
      `the merge of ${repo}#${number} got no answer and the PR could not be read again: it may be merged — check before retrying`,
    );
  }
  if (after.merged === true) return str(after.merge_commit_sha);
  // GitHub may still be applying it: not merged yet is not proof it was not made.
  throw new OutcomeUnknownError(
    `the merge of ${repo}#${number} got no answer and the PR is not merged yet — check before retrying`,
  );
}
