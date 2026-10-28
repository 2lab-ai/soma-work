// Organization membership and repository collaborator changes (.prd/16-devops-tools-architecture.md §3, §5):
// REST calls the broker makes itself with the org-admin token, because gh-runner refuses them as gh argv. Both
// PUTs are "add or change", so the current state is read first and shown on the card. A write is sent at most
// once — a lost response is reported as result-unknown, never retried.

import { scrub, scrubTruncated } from './scrub.js';

export type GithubOrgRole = 'member' | 'admin';
export type GithubRepoPermission = 'pull' | 'triage' | 'push' | 'maintain' | 'admin';

export interface GithubAdminResult {
  status: number;
  /** Scrubbed response text, at most 64 KB. */
  body: string;
  truncated: boolean;
}

/**
 * `upstream-error` = nothing reached GitHub (connection refused, name lookup failed); `result-unknown` = the
 * request may have been applied and its answer was lost (reset, timeout).
 */
export class GithubAdminError extends Error {
  readonly code: 'result-unknown' | 'upstream-error';

  constructor(code: 'result-unknown' | 'upstream-error', message: string) {
    super(message);
    this.name = 'GithubAdminError';
    this.code = code;
  }
}

/** `member: false` = GitHub answered 404 (no membership, no open invitation). `state` is `active` or `pending`. */
export type GithubOrgMembership = { member: false } | { member: true; role: string; state: string };

/**
 * Effective access (direct, team or organization base permission). `permission` is in the PUT vocabulary
 * (pull, triage, push, maintain, admin) or a custom role name. `collaborator: false` = 404 or permission `none`.
 */
export type GithubRepoAccess = { collaborator: false } | { collaborator: true; permission: string };

export type GithubMergeMethod = 'merge' | 'squash' | 'rebase';

export interface GithubMergeOptions {
  /** The head commit the admin approved; GitHub refuses (409) when the head moved. */
  sha: string;
  method: GithubMergeMethod;
  title?: string;
  message?: string;
}

/** What a pull request read shows after a merge whose answer was lost. */
export interface GithubPullRequestState {
  merged: boolean;
  mergeCommitSha: string | null;
  state: string;
}

export interface GithubAdmin {
  /** GET /orgs/{org}/memberships/{user}. Any failure is upstream-error: nothing changed. */
  getMembership(token: string, org: string, user: string): Promise<GithubOrgMembership>;
  /** GET /repos/{owner}/{repo}/collaborators/{user}/permission. Any failure is upstream-error. */
  getCollaboratorPermission(token: string, owner: string, repo: string, user: string): Promise<GithubRepoAccess>;
  /** GET /repos/{owner}/{repo}/pulls/{number}. Any failure (404 included) is upstream-error. */
  getPullRequest(token: string, owner: string, repo: string, number: number): Promise<GithubPullRequestState>;
  setMembership(token: string, org: string, user: string, role: GithubOrgRole): Promise<GithubAdminResult>;
  removeMembership(token: string, org: string, user: string): Promise<GithubAdminResult>;
  addCollaborator(
    token: string,
    owner: string,
    repo: string,
    user: string,
    permission: GithubRepoPermission,
  ): Promise<GithubAdminResult>;
  removeCollaborator(token: string, owner: string, repo: string, user: string): Promise<GithubAdminResult>;
  /**
   * PUT /repos/{owner}/{repo}/pulls/{number}/merge with the pinned `sha`: an immediate merge or a refusal (head
   * moved, merge queue required, checks), never a queued or auto merge.
   */
  mergePullRequest(
    token: string,
    owner: string,
    repo: string,
    number: number,
    options: GithubMergeOptions,
  ): Promise<GithubAdminResult>;
}

export interface GithubAdminOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

export const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;

/** GitHub's login rule: alphanumerics and single inner hyphens, at most 39 characters. */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** Role, state and permission words GitHub sends; anything else is not put on a card. */
const WORD_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const MERGE_METHODS: readonly string[] = ['merge', 'squash', 'rebase'];

/** The permission endpoint's role names in the collaborator PUT vocabulary. */
const PUT_PERMISSION: Record<string, string> = { read: 'pull', write: 'push' };

/** Errors that mean the connection never got as far as sending the request. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function login(value: string, what: string): string {
  if (typeof value !== 'string' || !GITHUB_LOGIN_RE.test(value)) throw new Error(`github-admin: invalid ${what}`);
  return encodeURIComponent(value);
}

/** `.` and `..` would be resolved away by the URL parser and reach another endpoint. */
function repoName(value: string): string {
  if (typeof value !== 'string' || !REPO_NAME_RE.test(value) || /^\.+$/.test(value)) {
    throw new Error('github-admin: invalid repository name');
  }
  return encodeURIComponent(value);
}

function prNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('github-admin: invalid pull request number');
  return String(value);
}

function errorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
    const room = MAX_BODY_BYTES - total;
    if (value.length > room) {
      chunks.push(value.subarray(0, room));
      await reader.cancel().catch(() => {});
      // A multi-byte character cut at the cap decodes to U+FFFD; harmless.
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: true };
    }
    chunks.push(value);
    total += value.length;
  }
}

export function createGithubAdmin(opts: GithubAdminOptions = {}): GithubAdmin {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = (opts.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function send(
    token: string,
    method: 'GET' | 'PUT' | 'DELETE',
    pathname: string,
    body?: Record<string, string>,
  ): Promise<GithubAdminResult> {
    const label = `${method} ${pathname}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'soma-devops-broker',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('github-admin-timeout'), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${apiBase}${pathname}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          // A redirected PUT would be re-sent to a URL nobody approved.
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err) {
        const code = errorCode(err);
        if (!controller.signal.aborted && code !== undefined && NOT_SENT_CODES.has(code)) {
          throw new GithubAdminError('upstream-error', `${label}: GitHub is unreachable (${code}); nothing was sent`);
        }
        const why = controller.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : (code ?? 'connection lost');
        throw new GithubAdminError(
          'result-unknown',
          `${label}: ${why}; the change may or may not have been applied and is not retried`,
        );
      }
      let text = '';
      let truncated = false;
      try {
        ({ text, truncated } = await readCapped(response));
      } catch {
        // The status is known; a body cut short by a reset or the timeout does not change the outcome.
        truncated = true;
      }
      return {
        status: response.status,
        body: truncated ? scrubTruncated(text, [token]) : scrub(text, [token]),
        truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A read changes nothing, so every failure — lost answer included — is upstream-error. */
  async function read(token: string, pathname: string): Promise<{ status: number; json: unknown }> {
    let result: GithubAdminResult;
    try {
      result = await send(token, 'GET', pathname);
    } catch (err) {
      throw new GithubAdminError('upstream-error', err instanceof Error ? err.message : `GET ${pathname} failed`);
    }
    if (result.status === 404) return { status: 404, json: null };
    if (result.status !== 200 || result.truncated) {
      throw new GithubAdminError('upstream-error', `GET ${pathname}: GitHub answered ${result.status}`);
    }
    try {
      return { status: 200, json: JSON.parse(result.body) };
    } catch {
      throw new GithubAdminError('upstream-error', `GET ${pathname}: GitHub's answer is not JSON`);
    }
  }

  function word(value: unknown, pathname: string, field: string): string {
    if (typeof value !== 'string' || !WORD_RE.test(value)) {
      throw new GithubAdminError('upstream-error', `GET ${pathname}: GitHub's ${field} could not be read`);
    }
    return value;
  }

  return {
    async getMembership(token, org, user) {
      const pathname = `/orgs/${login(org, 'organization')}/memberships/${login(user, 'user')}`;
      const { status, json } = await read(token, pathname);
      if (status === 404) return { member: false };
      const body = (json ?? {}) as { role?: unknown; state?: unknown };
      return { member: true, role: word(body.role, pathname, 'role'), state: word(body.state, pathname, 'state') };
    },
    async getCollaboratorPermission(token, owner, repo, user) {
      const pathname = `/repos/${login(owner, 'owner')}/${repoName(repo)}/collaborators/${login(user, 'user')}/permission`;
      const { status, json } = await read(token, pathname);
      if (status === 404) return { collaborator: false };
      const body = (json ?? {}) as { permission?: unknown; role_name?: unknown };
      const raw = word(typeof body.role_name === 'string' ? body.role_name : body.permission, pathname, 'permission');
      if (raw === 'none') return { collaborator: false };
      return { collaborator: true, permission: Object.hasOwn(PUT_PERMISSION, raw) ? PUT_PERMISSION[raw] : raw };
    },
    async getPullRequest(token, owner, repo, number) {
      const pathname = `/repos/${login(owner, 'owner')}/${repoName(repo)}/pulls/${prNumber(number)}`;
      const { status, json } = await read(token, pathname);
      if (status === 404) throw new GithubAdminError('upstream-error', `GET ${pathname}: GitHub answered 404`);
      const body = (json ?? {}) as { merged?: unknown; merge_commit_sha?: unknown; state?: unknown };
      if (typeof body.merged !== 'boolean') {
        throw new GithubAdminError('upstream-error', `GET ${pathname}: GitHub's merged flag could not be read`);
      }
      const sha = typeof body.merge_commit_sha === 'string' && FULL_SHA_RE.test(body.merge_commit_sha);
      return {
        merged: body.merged,
        mergeCommitSha: sha ? (body.merge_commit_sha as string) : null,
        state: word(body.state, pathname, 'state'),
      };
    },
    async setMembership(token, org, user, role) {
      return send(token, 'PUT', `/orgs/${login(org, 'organization')}/memberships/${login(user, 'user')}`, { role });
    },
    async removeMembership(token, org, user) {
      return send(token, 'DELETE', `/orgs/${login(org, 'organization')}/memberships/${login(user, 'user')}`);
    },
    async addCollaborator(token, owner, repo, user, permission) {
      const pathname = `/repos/${login(owner, 'owner')}/${repoName(repo)}/collaborators/${login(user, 'user')}`;
      return send(token, 'PUT', pathname, { permission });
    },
    async mergePullRequest(token, owner, repo, number, options) {
      if (typeof options.sha !== 'string' || !FULL_SHA_RE.test(options.sha)) {
        throw new Error('github-admin: the merge needs the full 40-character head sha');
      }
      if (!MERGE_METHODS.includes(options.method)) throw new Error('github-admin: invalid merge method');
      const pathname = `/repos/${login(owner, 'owner')}/${repoName(repo)}/pulls/${prNumber(number)}/merge`;
      const body: Record<string, string> = { sha: options.sha, merge_method: options.method };
      if (options.title !== undefined) body.commit_title = options.title;
      if (options.message !== undefined) body.commit_message = options.message;
      return send(token, 'PUT', pathname, body);
    },
    async removeCollaborator(token, owner, repo, user) {
      const pathname = `/repos/${login(owner, 'owner')}/${repoName(repo)}/collaborators/${login(user, 'user')}`;
      return send(token, 'DELETE', pathname);
    },
  };
}
