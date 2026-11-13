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

import { randomUUID } from 'node:crypto';

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
  /**
   * The checks (check-run names or status contexts) that must each have passed on the head. Unset: the base
   * branch's protection says which. When neither names any, no head is green — a check that has not registered
   * yet would otherwise go unseen.
   */
  requiredChecks?: string[];
}

export interface PrConditions {
  /** PR authors (logins; a GitHub App's PRs are by `<app>[bot]`). */
  authors?: string[];
  /** Base branches. */
  bases?: string[];
  /**
   * Every required check must have passed and nothing else on the head may be unfinished or red. Default true;
   * only `false` turns it off.
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
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'manual';
  },
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
  /** The checks that must pass (`requiredChecks`, else the base's protection); null when none is known. */
  required: string[] | null;
  /** Required checks that have not passed on the head (not reported yet, unfinished or red). */
  missing: string[];
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
  return (await callWithStatus(fetch, token, method, path, body)).json;
}

async function callWithStatus(
  fetch: Fetch,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
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
      // A redirect is never followed: GitHub moves a transferred issue to its new repository, which the environment
      // may not list, and the token must not read it (review-of-legends R5).
      redirect: 'manual',
    });
  } catch (err) {
    throw new NoAnswerError(`GitHub ${method} ${path} got no answer (${err instanceof Error ? err.name : 'error'})`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new GithubError(`GitHub ${method} ${path} answered ${res.status} (moved): not followed`);
  }
  // A GET answered 204 (no content, e.g. `pulls/<n>/merge` for a merged PR) is an answer with no body.
  if (method === 'GET' && res.status === 204) return { status: 204, json: null };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // A success whose body cannot be read is no answer: a read refuses, a write is looked up.
    if (res.ok) throw new NoAnswerError(`GitHub ${method} ${path} answered ${res.status} with an unreadable body`);
    json = undefined;
  }
  // A gateway or server error after a write may come after the write was made: that is no answer, not a refusal.
  if (method !== 'GET' && res.status >= 500) {
    throw new NoAnswerError(`GitHub ${method} ${path} answered ${res.status}: the write may have been made`);
  }
  if (!res.ok) {
    const message =
      json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string'
        ? (json as { message: string }).message
        : 'no message';
    // GitHub's message can quote what was sent or stored; the token never rides along.
    throw new GithubError(`GitHub ${method} ${path} answered ${res.status}: ${scrubToken(message, token)}`);
  }
  return { status: res.status, json };
}

// ── gh_read: a GET of the environment's repository (env-access WU5, #1213) ──

/**
 * The routes `gh_read` reads, as shapes of the path below `repos/<owner>/<name>`: what deploy confirmation and QA
 * read (commits, compares, PRs and issues, workflow runs and jobs, checks and statuses, branches, contents, releases).
 * An allowlist of shapes, not of first segments: below a part QA reads there are settings (`branches/<b>/protection`)
 * and routes that answer with another repository's data (`issues/<n>/parent`, a timeline's cross-references) — the
 * token may be an org admin's.
 */
const S = '[^/]+';
const N = '[0-9]+';
const READ_SHAPES: readonly RegExp[] = [
  '',
  'pulls',
  `pulls/${N}`,
  `pulls/${N}/(files|commits|reviews|comments|merge)`,
  'commits',
  // A ref may hold `/` (deploy/dev2): a commit, a compare and a branch take the rest of the path.
  'commits/.+',
  'compare/.+',
  'issues',
  `issues/${N}`,
  `issues/${N}/(comments|events|labels)`,
  '(issues)/(comments|events)',
  `issues/(comments|events)/${N}`,
  'branches',
  'branches/.+',
  'contents',
  'contents/.+',
  `statuses/${S}`,
  `check-runs/${N}`,
  `check-runs/${N}/annotations`,
  `check-suites/${N}`,
  `check-suites/${N}/check-runs`,
  'deployments',
  `deployments/${N}`,
  `deployments/${N}/statuses`,
  'releases',
  `releases/(${N}|latest)`,
  'releases/tags/.+',
  'tags',
  'git/(ref|refs|matching-refs)/.+',
  `git/(commits|trees|tags|blobs)/${S}`,
  'milestones',
  `milestones/${N}`,
  'labels',
  `labels/${S}`,
  'actions/runs',
  `actions/runs/${N}`,
  `actions/runs/${N}/jobs`,
  `actions/runs/${N}/attempts/${N}`,
  `actions/runs/${N}/attempts/${N}/jobs`,
  `actions/jobs/${N}`,
  'actions/workflows',
  `actions/workflows/${S}`,
  `actions/workflows/${S}/runs`,
].map((shape) => new RegExp(`^${shape}$`));
/** GitHub path characters (RFC 3986 unreserved + the sub-delims paths use: `(auth)`, `alice:branch`, `a+b`). */
const SEGMENT = /^[A-Za-z0-9_.~%()+:@,=!$*;-]+$/;
const QUERY_KEY = /^[A-Za-z0-9_[\]]+$/;
/** A field to keep: dotted names, `[]` after a name (or alone, first) for each element of a list. */
const FIELD = /^(?:\[\]|[A-Za-z0-9_]+(?:\[\])?)(?:\.[A-Za-z0-9_]+(?:\[\])?)*$/;
const MAX_FIELDS = 40;
/** Longest answer handed back, in characters of JSON; a longer one is cut and marked. */
const READ_MAX_CHARS = 200_000;

/** `repos/<owner>/<name>/…` as asked, checked: its repository is the environment's and its part one QA reads. */
export function repoReadPath(config: EnvGithubConfig, value: unknown): string {
  if (typeof value !== 'string') throw new GithubError('path must be repos/<owner>/<name>/…');
  const segments = value.replace(/^\//, '').split('/');
  // Each segment as GitHub may decode it: no `.` or `..` component, no backslash or NUL, and it must decode.
  const unsafeDecoded = (s: string) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      return true;
    }
    return /[\\\0]/.test(decoded) || decoded.split('/').some((c) => c === '.' || c === '..');
  };
  const unsafe = segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..' || unsafeDecoded(s));
  if (segments[0] !== 'repos' || segments.length < 3 || unsafe) {
    throw new GithubError('path must be repos/<owner>/<name>/… (no query, no dot segments)');
  }
  const repo = allowedRepo(config, `${segments[1]}/${segments[2]}`);
  const rest = segments.slice(3).join('/');
  if (!READ_SHAPES.some((shape) => shape.test(rest))) throw new GithubError(`${rest} is not a part gh_read reads`);
  const decoded = segments.slice(3).map((s) => decodeURIComponent(s));
  // `base...owner:branch` compares across the fork network: another repository's commits.
  if (decoded[0] === 'compare' && decoded.slice(1).some((s) => s.includes(':'))) {
    throw new GithubError('compare across forks reads another repository');
  }
  // A branch name may hold `/` (encoded or not); one that reaches the protection settings is not read. GitHub routes
  // `protection` in any case (trinity R5, fable).
  if (decoded[0] === 'branches' && decoded.slice(1).join('/').toLowerCase().split('/').includes('protection')) {
    throw new GithubError(`${rest} is not a part gh_read reads`);
  }
  return ['repos', repo, ...segments.slice(3)].join('/');
}

function readQuery(value: unknown): string {
  if (value === undefined) return '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GithubError('query must be an object');
  const params = new URLSearchParams();
  for (const [key, v] of Object.entries(value)) {
    if (!QUERY_KEY.test(key) || !['string', 'number', 'boolean'].includes(typeof v)) {
      throw new GithubError(`query ${key} must be a string, number or boolean`);
    }
    params.append(key, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

interface FieldNode {
  /** The whole value here is kept. */
  whole: boolean;
  kids: Map<string, FieldNode>;
}

/** `fields` as a tree of names (`[]` = each element); a path that a shorter one already keeps whole adds nothing. */
export function readFields(value: unknown): FieldNode | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_FIELDS ||
    !value.every((f) => typeof f === 'string' && f.length <= 200 && FIELD.test(f))
  ) {
    throw new GithubError(`fields must be 1–${MAX_FIELDS} dotted names, e.g. ["commits[].sha", "status"]`);
  }
  const root: FieldNode = { whole: false, kids: new Map() };
  for (const field of value as string[]) {
    const tokens = field
      .split('.')
      .flatMap((t) => (t === '[]' ? ['[]'] : t.endsWith('[]') ? [t.slice(0, -2), '[]'] : [t]));
    let node = root;
    for (const t of tokens) {
      if (node.whole) break;
      let next = node.kids.get(t);
      if (!next) {
        next = { whole: false, kids: new Map() };
        node.kids.set(t, next);
      }
      node = next;
    }
    if (!node.whole) {
      node.whole = true;
      node.kids.clear();
    }
  }
  return root;
}

/** Only the named parts of `value`; a name the answer lacks is left out. */
function pickFields(value: unknown, node: FieldNode): unknown {
  if (node.whole) return value;
  const each = node.kids.get('[]');
  if (Array.isArray(value)) return each ? value.map((v) => pickFields(v, each) ?? null) : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, kid] of node.kids) {
    if (name === '[]' || !Object.hasOwn(value, name)) continue;
    const kept = pickFields((value as Record<string, unknown>)[name], kid);
    if (kept !== undefined) out[name] = kept;
  }
  return out;
}

/**
 * GET one path of the environment's repository. `fields` keeps only the named parts of the answer (before the
 * output cap: a compare's file diffs can pass it alone); a long answer comes back cut, as text, with `truncated`.
 */
export async function repoRead(
  fetch: Fetch,
  config: EnvGithubConfig,
  path: unknown,
  query?: unknown,
  fields?: unknown,
): Promise<{ path: string; status: number; truncated: boolean; body: unknown }> {
  const checked = repoReadPath(config, path);
  const keep = readFields(fields);
  const { status, json: raw } = await callWithStatus(fetch, config.token, 'GET', `/${checked}${readQuery(query)}`);
  // Text in the repository (an issue body, a commit message, a committed file) can hold the token: never hand it on.
  // Scrubbed whole, before `fields` picks: a base64 file is recognized by its `encoding` beside its `content`.
  const scrubbed = scrubJson(raw ?? null, config.token);
  const json = keep ? (pickFields(scrubbed, keep) ?? null) : scrubbed;
  const text = JSON.stringify(json);
  return text.length > READ_MAX_CHARS
    ? { path: checked, status, truncated: true, body: text.slice(0, READ_MAX_CHARS) }
    : { path: checked, status, truncated: false, body: json ?? null };
}

/** `text` with every occurrence of `token` replaced. */
export function scrubToken(text: string, token: string): string {
  return token ? text.split(token).join('[redacted]') : text;
}

/**
 * Every string in a JSON answer with the token replaced, keys included; a base64 `content` (a file, a blob) is
 * decoded, scrubbed and encoded again. Past 64 levels the rest is scrubbed as text.
 */
function scrubJson(value: unknown, token: string, depth = 0): unknown {
  if (typeof value === 'string') return scrubToken(value, token);
  if (!value || typeof value !== 'object') return value;
  if (depth > 64) return JSON.parse(scrubToken(JSON.stringify(value), token));
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, token, depth + 1));
  const out: Record<string, unknown> = {};
  const o = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) out[scrubToken(k, token)] = scrubJson(v, token, depth + 1);
  if (o.encoding === 'base64' && typeof o.content === 'string') {
    const decoded = Buffer.from(o.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (decoded.includes(token)) out.content = Buffer.from(scrubToken(decoded, token), 'utf8').toString('base64');
  }
  return out;
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
  const succeeded = new Set<string>();
  /** `name\0appId` of every successful check run: an app-bound requirement needs that app's run. */
  const succeededByApp = new Set<string>();
  let passed = 0;
  const checkRuns = Array.isArray(runs.check_runs) ? runs.check_runs.map(obj) : [];
  for (const run of checkRuns) {
    const name = str(run.name) || 'check';
    if (run.status !== 'completed') pending.push(name);
    else if (!GREEN_CONCLUSIONS.has(str(run.conclusion))) failing.push(name);
    else if (run.conclusion === 'success') {
      passed++;
      succeeded.add(name);
      const appId = obj(run.app).id;
      if (typeof appId === 'number') succeededByApp.add(`${name}\u0000${appId}`);
    }
  }
  // More check runs than one page cannot be judged here: not green.
  if (typeof runs.total_count === 'number' && runs.total_count > checkRuns.length) pending.push('(more checks)');
  const statuses = Array.isArray(status.statuses) ? status.statuses.map(obj) : [];
  for (const s of statuses) {
    const name = str(s.context) || 'status';
    if (s.state === 'pending') pending.push(name);
    else if (s.state !== 'success') failing.push(name);
    else {
      passed++;
      succeeded.add(name);
    }
  }
  // The combined state covers every status, also those past this page. GitHub says `pending` when there are none.
  const statusTotal = typeof status.total_count === 'number' ? status.total_count : statuses.length;
  if (statusTotal > statuses.length) pending.push('(more statuses)');
  if (statusTotal > 0 && status.state !== 'success') {
    (status.state === 'pending' ? pending : failing).push('(combined status)');
  }
  const total = checkRuns.length + statuses.length;
  const base = str(obj(pr.base).ref);
  const required = await requiredChecks(fetch, config, repo, base);
  const missing = (required ?? [])
    .filter((r) => (r.appId === undefined ? !succeeded.has(r.name) : !succeededByApp.has(`${r.name}\u0000${r.appId}`)))
    .map((r) => r.name);
  return {
    repo,
    number,
    title: str(pr.title),
    state: str(pr.state),
    draft: pr.draft === true,
    author: str(obj(pr.user).login),
    base,
    headSha: sha,
    checks: {
      total,
      passed,
      // Right after a push nothing has reported yet, and a path filter may skip every workflow: green needs one
      // success and nothing unfinished or red.
      green: required !== null && missing.length === 0 && passed > 0 && pending.length === 0 && failing.length === 0,
      pending,
      failing,
      required: required === null ? null : required.map((r) => r.name),
      missing,
    },
  };
}

/** One check that must pass: by name, and — when the branch protection binds it to an app — by that app only. */
interface RequiredCheck {
  name: string;
  appId?: number;
}

/**
 * The checks that must pass on a PR into `base`: the environment's `requiredChecks`, else the base branch's
 * protection (its required status checks, each bound to its app when the protection says so). Null when neither
 * names any, or the protection cannot be read — unknown, so no write goes ahead.
 */
async function requiredChecks(
  fetch: Fetch,
  config: EnvGithubConfig,
  repo: string,
  base: string,
): Promise<RequiredCheck[] | null> {
  if (Array.isArray(config.requiredChecks) && config.requiredChecks.length > 0) {
    return config.requiredChecks.map((name) => ({ name }));
  }
  let protection: Obj;
  try {
    protection = obj(
      await call(
        fetch,
        config.token,
        'GET',
        `/repos/${repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`,
      ),
    );
  } catch {
    // No protection on the base (404), or none this token may read: nothing is known to be required.
    return null;
  }
  const required: RequiredCheck[] = [];
  const bound = new Set<string>();
  for (const c of Array.isArray(protection.checks) ? protection.checks.map(obj) : []) {
    if (typeof c.context !== 'string') continue;
    bound.add(c.context);
    // app_id null or -1 means any source.
    required.push(
      typeof c.app_id === 'number' && c.app_id > 0 ? { name: c.context, appId: c.app_id } : { name: c.context },
    );
  }
  for (const c of Array.isArray(protection.contexts) ? protection.contexts : []) {
    if (typeof c === 'string' && !bound.has(c)) required.push({ name: c });
  }
  return required.length > 0 ? required : null;
}

function checksProblem(pr: PrState): string | undefined {
  if (pr.checks.green) return undefined;
  if (pr.checks.required === null) {
    return `no required checks are known for ${pr.base}: list them in github.requiredChecks or require them on the branch`;
  }
  if (pr.checks.total === 0) return 'no check has reported on the head yet';
  if (pr.checks.pending.length > 0 || pr.checks.failing.length > 0) {
    const parts = [
      pr.checks.pending.length > 0 ? `not finished: ${pr.checks.pending.join(', ')}` : '',
      pr.checks.failing.length > 0 ? `not green: ${pr.checks.failing.join(', ')}` : '',
    ].filter(Boolean);
    return `checks are not all green (${parts.join('; ')})`;
  }
  if (pr.checks.passed === 0) return 'no check has passed on the head (only skipped or neutral ones)';
  return `required checks not passed yet: ${pr.checks.missing.join(', ')}`;
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
  // A marker only this call writes: a lost answer is matched to this approval, never to an older one.
  const marker = `<!-- soma-env-approval ${randomUUID()} -->`;
  let review: Obj;
  try {
    review = obj(
      await call(fetch, config.token, 'POST', `/repos/${repo}/pulls/${number}/reviews`, {
        event: 'APPROVE',
        commit_id: sha,
        body: `${body}\n\n${marker}`,
      }),
    );
  } catch (err) {
    if (!(err instanceof NoAnswerError)) throw err;
    review = await ownApproval(fetch, config, repo, number, sha, marker);
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
 * After an approval that got no answer: the review this call wrote (its `marker`), when it is an approval of `sha`.
 * Anything short of finding it — not seen yet (GitHub may still be applying it), a full page, a malformed list, a
 * failed lookup — is an `OutcomeUnknownError`: the approval may stand.
 */
async function ownApproval(
  fetch: Fetch,
  config: EnvGithubConfig,
  repo: string,
  number: number,
  sha: string,
  marker: string,
) {
  const unknown = (why: string) =>
    new OutcomeUnknownError(
      `the approval of ${repo}#${number} got no answer and ${why}: it may stand — check the PR before retrying`,
    );
  let reviews: unknown;
  try {
    reviews = await call(fetch, config.token, 'GET', `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  } catch {
    throw unknown('could not be looked up');
  }
  if (!Array.isArray(reviews)) throw unknown('the lookup answered something unexpected');
  const mine = reviews.map(obj).find((r) => str(r.body).includes(marker));
  if (mine && mine.state === 'APPROVED' && mine.commit_id === sha) return mine;
  if (mine) throw unknown('was written but is not an approval of the head');
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
  // Merged — and merged as this call asked: the head it pinned, into the base it checked.
  const mergeSha = str(after.merge_commit_sha);
  if (
    after.merged === true &&
    mergeSha !== '' &&
    str(obj(after.head).sha) === sha &&
    str(obj(after.base).ref) === base
  ) {
    return mergeSha;
  }
  // GitHub may still be applying it: not merged yet is not proof it was not made.
  throw new OutcomeUnknownError(
    `the merge of ${repo}#${number} got no answer and the PR is not seen merged as asked (head, base) — check before retrying`,
  );
}
