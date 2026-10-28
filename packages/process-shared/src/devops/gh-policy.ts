// gh argv classifier for the devops broker (.prd/16-devops-tools-architecture.md §4).
//
// Allowlist only: a command, subcommand, flag, value form or `gh api` path head that is not spelled out
// below is denied, so a flag a newer gh adds is denied too. Every read is scoped to the policy's owners.
// The tables were read from `gh <cmd> <sub> --help` of the pinned version. Pure and import-free: the
// broker bundles this file into its root-owned copy. classifyGh never throws; anything unexpected denies.

export const GH_POLICY_GH_VERSION = '2.102.0';

export type GhDenyCode =
  | 'argv-invalid'
  | 'command-not-allowed'
  | 'subcommand-not-allowed'
  | 'flag-not-allowed'
  | 'flag-form'
  | 'flag-duplicate'
  | 'flag-value-missing'
  | 'flag-value-invalid'
  | 'stdin-not-allowed'
  | 'positional-count'
  | 'positional-invalid'
  | 'required-flag-missing'
  | 'scope-required'
  | 'owner-not-allowed'
  | 'api-path-invalid'
  | 'api-path-not-allowlisted'
  | 'api-graphql'
  | 'api-credential-path'
  | 'api-rest-write-not-allowlisted'
  | 'api-field-not-allowlisted'
  /** Malformed policy context or an unexpected failure inside the classifier. */
  | 'internal-error';

export type GhApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface GhApiRequest {
  method: GhApiMethod;
  /** Normalized: one leading slash, no query. */
  path: string;
  query: string | null;
}

export type GhClassification =
  | {
      kind: 'read' | 'write' | 'org-admin-op';
      reason: string;
      command: string;
      subcommand: string | null;
      /** `owner/name` the command targets, as written, when there is one. */
      repo: string | null;
      api?: GhApiRequest;
    }
  | { kind: 'deny'; code: GhDenyCode; reason: string };

/** One (method, path pattern, fields) row of the REST write allowlist. `{x}` matches one path segment. */
export interface GhRestWriteRule {
  method: Exclude<GhApiMethod, 'GET'>;
  path: string;
  fields: readonly string[];
}

export interface GhPolicyContext {
  /** Owners (org or user logins) that `-R`, `--org`, `--owner`, search qualifiers and `gh api` paths may name. */
  allowedOwners: readonly string[];
  /** Empty in v1 (§4 item 6): every non-GET `gh api` call is denied. */
  restWriteAllowlist?: readonly GhRestWriteRule[];
}

// ── Value formats ─────────────────────────────────────────

type Check = { ok: true } | { ok: false; code: GhDenyCode; reason: string };
type ValueCheck = (value: string, ctx: GhPolicyContext) => Check;

const OK: Check = { ok: true };
const MAX_ARGV = 100;
const MAX_TOKEN_LENGTH = 65_536;
const MAX_LINE = 1024;
const MAX_JQ = 1000;
const MAX_LIMIT = 200;

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
// The approval card shows these values. Format characters (bidi overrides and isolates, zero-width
// characters, BOM) render as nothing or reorder what the admin reads, and line/paragraph separators
// render as a line break: either way the card stops showing what gh will send.
const LINE_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const TEXT_FORBIDDEN_RE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u2028\u2029]/u;

function hasOwn(object: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(object, key) !== undefined;
}

function invalid(reason: string): Check {
  return { ok: false, code: 'flag-value-invalid', reason };
}

function pattern(re: RegExp, what: string): ValueCheck {
  return (value) => (re.test(value) ? OK : invalid(`expected ${what}`));
}

function oneOf(values: readonly string[]): ValueCheck {
  return (value) => (values.includes(value) ? OK : invalid(`expected one of ${values.join(', ')}`));
}

function ownerAllowed(owner: string, ctx: GhPolicyContext): boolean {
  const wanted = owner.toLowerCase();
  return ctx.allowedOwners.some((allowed) => allowed.toLowerCase() === wanted);
}

function checkRepo(value: string, ctx: GhPolicyContext): Check {
  const parts = value.split('/');
  if (parts.length !== 2 || !LOGIN_RE.test(parts[0]) || !REPO_NAME_RE.test(parts[1]) || /^\.+$/.test(parts[1])) {
    return invalid('expected owner/name (no host)');
  }
  if (!ownerAllowed(parts[0], ctx)) {
    return { ok: false, code: 'owner-not-allowed', reason: `owner ${parts[0]} is not in the policy's owners` };
  }
  return OK;
}

function checkOrg(value: string, ctx: GhPolicyContext): Check {
  if (!LOGIN_RE.test(value)) return invalid('expected an organization login');
  if (!ownerAllowed(value, ctx)) {
    return { ok: false, code: 'owner-not-allowed', reason: `owner ${value} is not in the policy's owners` };
  }
  return OK;
}

function checkLine(value: string): Check {
  if (value.length === 0 || value.length > MAX_LINE) return invalid(`expected 1-${MAX_LINE} characters`);
  if (LINE_FORBIDDEN_RE.test(value)) {
    return invalid('expected a single line without control, format or separator characters');
  }
  return OK;
}

function checkText(value: string): Check {
  if (value.length > MAX_TOKEN_LENGTH) return invalid('text too long');
  if (value.includes('\u0000') || TEXT_FORBIDDEN_RE.test(value)) {
    return invalid('text may not hold NUL, bidi controls, zero-width characters or U+2028/U+2029');
  }
  return OK;
}

// GitHub ORs repo:/org:/user:/owner: qualifiers with the scope gh adds for -R / --owner, so a
// qualifier naming another owner widens the search past the policy. Matched case-insensitively and
// after any non-word character (`-repo:`, `(repo:`); the value must be a bare allowed owner or repo.
const SCOPE_QUALIFIER_RE = /(?<![A-Za-z0-9_])(repo|org|user|owner):([^\s()]*)/giu;

function checkScopeQualifiers(value: string, ctx: GhPolicyContext): Check {
  for (const match of value.matchAll(SCOPE_QUALIFIER_RE)) {
    const key = match[1].toLowerCase();
    const target = match[2];
    const check = key === 'repo' ? checkRepo(target, ctx) : checkOrg(target, ctx);
    if (!check.ok) {
      return check.code === 'owner-not-allowed'
        ? check
        : invalid(`${key}: qualifier needs a bare ${key === 'repo' ? 'owner/name' : 'login'} of an allowed owner`);
    }
  }
  return OK;
}

function checkSearchText(value: string, ctx: GhPolicyContext): Check {
  const line = checkLine(value);
  return line.ok ? checkScopeQualifiers(value, ctx) : line;
}

function checkQueryTerm(value: string, ctx: GhPolicyContext): Check {
  return value.length > 256 ? invalid('search term too long') : checkSearchText(value, ctx);
}

function checkLimit(value: string): Check {
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > MAX_LIMIT) return invalid(`expected 1-${MAX_LIMIT}`);
  return OK;
}

// go-gh pkg/jq compiles every expression with gojq.WithEnvironLoader(os.Environ): `$ENV` and `env`
// would read GH_TOKEN out of the broker's gh process and print it past the output scrubber.
// Checked on the raw text: string interpolation `"\(env)"` is code, so literals are not skipped.
function checkJq(value: string): Check {
  if (value.length === 0 || value.length > MAX_JQ) return invalid(`expected a jq expression of 1-${MAX_JQ} characters`);
  if (/\$ENV\b|\benv\b/.test(value)) return invalid('jq expressions may not read the environment ($ENV, env)');
  return OK;
}

function checkBranch(value: string): Check {
  if (
    !/^[A-Za-z0-9._/-]{1,255}$/.test(value) ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    value.includes('//')
  ) {
    return invalid('expected a branch name');
  }
  return OK;
}

function checkTag(value: string): Check {
  if (!/^[A-Za-z0-9._+-]{1,128}$/.test(value) || value.startsWith('-') || value.includes('..')) {
    return invalid('expected a tag name');
  }
  return OK;
}

function checkWorkflow(value: string): Check {
  if (/^[1-9][0-9]{0,15}$/.test(value)) return OK;
  if (/^[A-Za-z0-9 ._()-]{1,100}$/.test(value) && !/^[-.]/.test(value) && !value.includes('..')) return OK;
  return invalid('expected a workflow id, file name or name');
}

function checkRef(value: string): Check {
  if (
    /^refs\/(?:heads|tags|pull)\/[A-Za-z0-9._/-]{1,240}$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//')
  ) {
    return OK;
  }
  return invalid('expected refs/heads/<branch> or refs/pull/<n>/merge');
}

function listOf(item: ValueCheck, what: string): ValueCheck {
  return (value, ctx) => {
    const items = value.split(',');
    if (items.length > 20) return invalid(`expected at most 20 ${what}`);
    for (const one of items) {
      const result = item(one, ctx);
      if (!result.ok) return result;
    }
    return OK;
  };
}

const login = pattern(/^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'a user login');
const reviewer = pattern(/^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/, 'a login or org/team');

const V = {
  number: pattern(/^[1-9][0-9]{0,15}$/, 'a positive number'),
  limit: checkLimit,
  repo: checkRepo,
  org: checkOrg,
  login,
  logins: listOf(login, 'logins'),
  reviewers: listOf(reviewer, 'reviewers'),
  text: checkText,
  line: checkLine,
  labels: listOf(checkLine, 'labels'),
  branch: checkBranch,
  sha: pattern(/^[0-9a-f]{7,40}$/, 'a commit SHA'),
  tag: checkTag,
  jq: checkJq,
  jsonFields: pattern(/^[A-Za-z]+(?:,[A-Za-z]+){0,99}$/, 'comma-separated JSON field names'),
  date: pattern(/^[0-9<>=.:TZ+-]{1,64}$/, 'a date or date range'),
  event: pattern(/^[a-z_]{1,64}$/, 'an event name'),
  color: pattern(/^#?[0-9A-Fa-f]{6}$/, 'a hex color'),
  workflow: checkWorkflow,
  variableName: pattern(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/, 'a variable name'),
  envName: pattern(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/, 'an environment name'),
  repoNames: listOf(pattern(REPO_NAME_RE, 'a repository name'), 'repository names'),
  cacheKey: pattern(/^[A-Za-z0-9_][A-Za-z0-9._+=:-]{0,511}$/, 'a cache id or key'),
  ref: checkRef,
  query: checkQueryTerm,
  search: checkSearchText,
  order: oneOf(['asc', 'desc']),
};

// ── gh api field and header values ────────────────────────

const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[A-Za-z0-9_]*\]){0,4}$/;
// gh api.go placeholderRE: fillPlaceholders runs on the whole endpoint and on every -F value.
const PLACEHOLDER_RE = /:(?:owner|repo|branch)\b|\{[a-z]+\}/;

function fieldKey(value: string): string {
  return value.slice(0, value.indexOf('='));
}

function rawField(value: string): Check {
  const eq = value.indexOf('=');
  if (eq < 1 || !FIELD_KEY_RE.test(value.slice(0, eq))) return invalid('expected key=value');
  return checkText(value.slice(eq + 1));
}

// -F: gh reads `@path` / `@-` from disk or stdin and fills placeholders; neither is allowed.
function typedField(value: string): Check {
  const shape = rawField(value);
  if (!shape.ok) return shape;
  const fieldValue = value.slice(value.indexOf('=') + 1);
  if (fieldValue.startsWith('@')) return invalid('-F values may not read a file or stdin (@)');
  if (PLACEHOLDER_RE.test(fieldValue)) return invalid('-F values may not use {owner}/:owner placeholders');
  return OK;
}

function header(value: string): Check {
  return /^(?:accept|x-github-api-version): ?[A-Za-z0-9.+/=;, -]{1,200}$/i.test(value)
    ? OK
    : invalid('only Accept and X-GitHub-Api-Version headers are allowed');
}

// ── Tables ────────────────────────────────────────────────

export interface GhFlagSpec {
  /** Long name without the leading `--`. */
  long: string;
  /** Single-letter short name without the leading `-`. */
  short?: string;
  /** `null` = boolean flag. */
  value: ValueCheck | null;
  /** Only for gh StringArray `key=value` flags: may repeat, keys must be distinct. */
  repeatable?: true;
}

/**
 * Where the command's target comes from:
 * repo = `-R owner/name` required · repo-or-org = exactly one of `-R` / `--org` ·
 * owner = `--owner` required · owner-or-repo = `--owner` or `-R` (search) ·
 * positional-repo = the positional is `owner/name` · none = the positionals carry the owner (repo list)
 * or there is no target (org list).
 */
export type GhScope = 'repo' | 'repo-or-org' | 'owner' | 'owner-or-repo' | 'positional-repo' | 'none';

export interface GhSubcommandSpec {
  kind: 'read' | 'write';
  scope: GhScope;
  positionals: { min: number; max: number; value: ValueCheck };
  flags: readonly GhFlagSpec[];
  required?: readonly string[];
}

function f(long: string, short: string | undefined, value: ValueCheck | null): GhFlagSpec {
  return short === undefined ? { long, value } : { long, short, value };
}

const REPO_FLAG = f('repo', 'R', V.repo);
const JSON_FLAG = f('json', undefined, V.jsonFields);
const JQ_FLAG = f('jq', 'q', V.jq);
const LIMIT_FLAG = f('limit', 'L', V.limit);
const OUTPUT = [JSON_FLAG, JQ_FLAG];
const NO_POSITIONAL = { min: 0, max: 0, value: V.number };
const ONE_NUMBER = { min: 1, max: 1, value: V.number };

function spec(
  kind: 'read' | 'write',
  scope: GhScope,
  positionals: GhSubcommandSpec['positionals'],
  flags: GhFlagSpec[],
  required?: string[],
): GhSubcommandSpec {
  const all = scope === 'repo' || scope === 'repo-or-org' ? [REPO_FLAG, ...flags] : flags;
  return required === undefined
    ? { kind, scope, positionals, flags: all }
    : { kind, scope, positionals, flags: all, required };
}

const SEARCH_COMMON = [LIMIT_FLAG, ...OUTPUT, f('owner', undefined, V.org)];
const SEARCH_ORDER = f('order', undefined, V.order);
const ISSUE_SEARCH = [
  REPO_FLAG,
  f('state', undefined, oneOf(['open', 'closed'])),
  f('label', undefined, V.labels),
  f('author', undefined, V.login),
  f('assignee', undefined, V.login),
  f('created', undefined, V.date),
  f('updated', undefined, V.date),
  f('closed', undefined, V.date),
];
const ISSUE_SORT = oneOf(['comments', 'created', 'interactions', 'reactions', 'updated']);
const RUN_STATUS = oneOf([
  'queued',
  'completed',
  'in_progress',
  'requested',
  'waiting',
  'pending',
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
]);

function queryTerms(min: number): GhSubcommandSpec['positionals'] {
  return { min, max: 10, value: V.query };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** command → subcommand → spec, frozen at load. `gh status` is left out: it aggregates every repo and org. */
export const GH_COMMAND_TABLE: Readonly<Record<string, Readonly<Record<string, GhSubcommandSpec>>>> = deepFreeze({
  pr: {
    view: spec('read', 'repo', ONE_NUMBER, [f('comments', 'c', null), ...OUTPUT]),
    list: spec('read', 'repo', NO_POSITIONAL, [
      f('state', 's', oneOf(['open', 'closed', 'merged', 'all'])),
      f('label', 'l', V.labels),
      f('author', 'A', V.login),
      f('assignee', 'a', V.login),
      f('base', 'B', V.branch),
      f('head', 'H', V.branch),
      f('draft', 'd', null),
      f('search', 'S', V.search),
      f('app', undefined, V.login),
      LIMIT_FLAG,
      ...OUTPUT,
    ]),
    diff: spec('read', 'repo', ONE_NUMBER, [f('name-only', undefined, null), f('patch', undefined, null)]),
    checks: spec('read', 'repo', ONE_NUMBER, [f('required', undefined, null), ...OUTPUT]),
    status: spec('read', 'repo', NO_POSITIONAL, [f('conflict-status', 'c', null), ...OUTPUT]),
    // Without --head gh reads the local git branch and may fork and push (create.go handlePush).
    create: spec(
      'write',
      'repo',
      NO_POSITIONAL,
      [
        f('title', 't', V.line),
        f('body', 'b', V.text),
        f('base', 'B', V.branch),
        f('head', 'H', V.branch),
        f('draft', 'd', null),
        f('label', 'l', V.labels),
        f('assignee', 'a', V.logins),
        f('reviewer', 'r', V.reviewers),
        f('milestone', 'm', V.line),
        f('project', 'p', V.line),
        f('no-maintainer-edit', undefined, null),
      ],
      ['head'],
    ),
    comment: spec('write', 'repo', ONE_NUMBER, [f('body', 'b', V.text)]),
    edit: spec('write', 'repo', ONE_NUMBER, [
      f('title', 't', V.line),
      f('body', 'b', V.text),
      f('base', 'B', V.branch),
      f('add-label', undefined, V.labels),
      f('remove-label', undefined, V.labels),
      f('add-assignee', undefined, V.logins),
      f('remove-assignee', undefined, V.logins),
      f('add-reviewer', undefined, V.reviewers),
      f('remove-reviewer', undefined, V.reviewers),
      f('milestone', 'm', V.line),
      f('remove-milestone', undefined, null),
      f('add-project', undefined, V.line),
      f('remove-project', undefined, V.line),
    ]),
    // Left out on purpose: --admin (bypasses branch protection), --author-email, and --auto (a standing
    // auto-merge also merges commits pushed after the admin approved the card). --disable-auto only
    // cancels one and merges nothing (merge.go returns right after disabling).
    merge: spec('write', 'repo', ONE_NUMBER, [
      f('merge', 'm', null),
      f('squash', 's', null),
      f('rebase', 'r', null),
      f('disable-auto', undefined, null),
      f('delete-branch', 'd', null),
      f('subject', 't', V.line),
      f('body', 'b', V.text),
      f('match-head-commit', undefined, V.sha),
    ]),
    close: spec('write', 'repo', ONE_NUMBER, [f('comment', 'c', V.text), f('delete-branch', 'd', null)]),
    reopen: spec('write', 'repo', ONE_NUMBER, [f('comment', 'c', V.text)]),
    ready: spec('write', 'repo', ONE_NUMBER, [f('undo', undefined, null)]),
    review: spec('write', 'repo', ONE_NUMBER, [
      f('approve', 'a', null),
      f('request-changes', 'r', null),
      f('comment', 'c', null),
      f('body', 'b', V.text),
    ]),
  },
  issue: {
    view: spec('read', 'repo', ONE_NUMBER, [f('comments', 'c', null), ...OUTPUT]),
    list: spec('read', 'repo', NO_POSITIONAL, [
      f('state', 's', oneOf(['open', 'closed', 'all'])),
      f('label', 'l', V.labels),
      f('author', 'A', V.login),
      f('assignee', 'a', V.login),
      f('mention', undefined, V.login),
      f('milestone', 'm', V.line),
      f('search', 'S', V.search),
      f('type', undefined, V.line),
      f('app', undefined, V.login),
      LIMIT_FLAG,
      ...OUTPUT,
    ]),
    status: spec('read', 'repo', NO_POSITIONAL, [...OUTPUT]),
    create: spec('write', 'repo', NO_POSITIONAL, [
      f('title', 't', V.line),
      f('body', 'b', V.text),
      f('label', 'l', V.labels),
      f('assignee', 'a', V.logins),
      f('milestone', 'm', V.line),
      f('project', 'p', V.line),
      f('type', undefined, V.line),
      f('parent', undefined, V.number),
    ]),
    comment: spec('write', 'repo', ONE_NUMBER, [f('body', 'b', V.text)]),
    edit: spec('write', 'repo', ONE_NUMBER, [
      f('title', 't', V.line),
      f('body', 'b', V.text),
      f('add-label', undefined, V.labels),
      f('remove-label', undefined, V.labels),
      f('add-assignee', undefined, V.logins),
      f('remove-assignee', undefined, V.logins),
      f('milestone', 'm', V.line),
      f('remove-milestone', undefined, null),
      f('add-project', undefined, V.line),
      f('remove-project', undefined, V.line),
      f('type', undefined, V.line),
      f('remove-type', undefined, null),
    ]),
    close: spec('write', 'repo', ONE_NUMBER, [
      f('comment', 'c', V.text),
      f('reason', 'r', oneOf(['completed', 'not planned', 'duplicate'])),
      f('duplicate-of', undefined, V.number),
    ]),
    reopen: spec('write', 'repo', ONE_NUMBER, [f('comment', 'c', V.text)]),
  },
  repo: {
    view: spec('read', 'positional-repo', { min: 1, max: 1, value: V.repo }, [f('branch', 'b', V.branch), ...OUTPUT]),
    list: spec('read', 'none', { min: 1, max: 1, value: V.org }, [
      LIMIT_FLAG,
      ...OUTPUT,
      f('visibility', undefined, oneOf(['public', 'private', 'internal'])),
      f('archived', undefined, null),
      f('no-archived', undefined, null),
      f('fork', undefined, null),
      f('source', undefined, null),
      f('language', 'l', V.line),
      f('topic', undefined, V.labels),
    ]),
  },
  run: {
    view: spec('read', 'repo', { min: 0, max: 1, value: V.number }, [
      f('attempt', 'a', V.number),
      f('job', 'j', V.number),
      f('log', undefined, null),
      f('log-failed', undefined, null),
      f('verbose', 'v', null),
      f('exit-status', undefined, null),
      ...OUTPUT,
    ]),
    list: spec('read', 'repo', NO_POSITIONAL, [
      f('branch', 'b', V.branch),
      f('commit', 'c', V.sha),
      f('created', undefined, V.date),
      f('event', 'e', V.event),
      f('status', 's', RUN_STATUS),
      f('user', 'u', V.login),
      f('workflow', 'w', V.workflow),
      f('all', 'a', null),
      LIMIT_FLAG,
      ...OUTPUT,
    ]),
    rerun: spec('write', 'repo', { min: 0, max: 1, value: V.number }, [
      f('failed', undefined, null),
      f('debug', 'd', null),
      f('job', 'j', V.number),
    ]),
    cancel: spec('write', 'repo', ONE_NUMBER, []),
  },
  workflow: {
    view: spec('read', 'repo', { min: 1, max: 1, value: V.workflow }, [f('ref', 'r', V.branch), f('yaml', 'y', null)]),
    list: spec('read', 'repo', NO_POSITIONAL, [f('all', 'a', null), LIMIT_FLAG, ...OUTPUT]),
    // -F (honours @file) and --json (reads stdin) are left out; -f is a gh StringArray.
    run: spec('write', 'repo', { min: 1, max: 1, value: V.workflow }, [
      f('ref', 'r', V.branch),
      { long: 'raw-field', short: 'f', value: rawField, repeatable: true },
    ]),
    enable: spec('write', 'repo', { min: 1, max: 1, value: V.workflow }, []),
    disable: spec('write', 'repo', { min: 1, max: 1, value: V.workflow }, []),
  },
  release: {
    view: spec('read', 'repo', { min: 0, max: 1, value: V.tag }, [...OUTPUT]),
    list: spec('read', 'repo', NO_POSITIONAL, [
      f('exclude-drafts', undefined, null),
      f('exclude-pre-releases', undefined, null),
      f('order', 'O', V.order),
      LIMIT_FLAG,
      ...OUTPUT,
    ]),
    edit: spec('write', 'repo', { min: 1, max: 1, value: V.tag }, [
      f('title', 't', V.line),
      f('notes', 'n', V.text),
      f('draft', undefined, null),
      f('prerelease', undefined, null),
      f('latest', undefined, null),
      f('tag', undefined, V.tag),
      f('target', undefined, V.branch),
      f('verify-tag', undefined, null),
      f('discussion-category', undefined, V.line),
    ]),
  },
  label: {
    list: spec('read', 'repo', NO_POSITIONAL, [
      LIMIT_FLAG,
      f('search', 'S', V.line),
      f('sort', undefined, oneOf(['created', 'name'])),
      f('order', undefined, V.order),
      ...OUTPUT,
    ]),
    create: spec('write', 'repo', { min: 1, max: 1, value: V.line }, [
      f('color', 'c', V.color),
      f('description', 'd', V.line),
      f('force', 'f', null),
    ]),
    edit: spec('write', 'repo', { min: 1, max: 1, value: V.line }, [
      f('color', 'c', V.color),
      f('description', 'd', V.line),
      f('name', 'n', V.line),
    ]),
  },
  search: {
    repos: spec('read', 'owner-or-repo', queryTerms(0), [
      ...SEARCH_COMMON,
      SEARCH_ORDER,
      f('language', undefined, V.line),
      f('topic', undefined, V.labels),
      f('visibility', undefined, oneOf(['public', 'private', 'internal'])),
      f('archived', undefined, null),
      f('sort', undefined, oneOf(['forks', 'help-wanted-issues', 'stars', 'updated'])),
    ]),
    issues: spec('read', 'owner-or-repo', queryTerms(0), [
      ...SEARCH_COMMON,
      SEARCH_ORDER,
      ...ISSUE_SEARCH,
      f('include-prs', undefined, null),
      f('sort', undefined, ISSUE_SORT),
    ]),
    prs: spec('read', 'owner-or-repo', queryTerms(0), [
      ...SEARCH_COMMON,
      SEARCH_ORDER,
      ...ISSUE_SEARCH,
      f('base', 'B', V.branch),
      f('head', 'H', V.branch),
      f('draft', undefined, null),
      f('merged', undefined, null),
      f('merged-at', undefined, V.date),
      f('checks', undefined, oneOf(['pending', 'success', 'failure'])),
      f('review', undefined, oneOf(['none', 'required', 'approved', 'changes_requested'])),
      f('review-requested', undefined, V.login),
      f('reviewed-by', undefined, V.login),
      f('sort', undefined, ISSUE_SORT),
    ]),
    // gh 2.102.0 `search code` has neither --order nor --sort.
    code: spec('read', 'owner-or-repo', queryTerms(1), [
      ...SEARCH_COMMON,
      REPO_FLAG,
      f('language', undefined, V.line),
      f('extension', undefined, V.line),
      f('filename', undefined, V.line),
    ]),
    commits: spec('read', 'owner-or-repo', queryTerms(0), [
      ...SEARCH_COMMON,
      SEARCH_ORDER,
      REPO_FLAG,
      f('author', undefined, V.login),
      f('committer', undefined, V.login),
      f('hash', undefined, V.sha),
      f('author-date', undefined, V.date),
      f('committer-date', undefined, V.date),
      f('sort', undefined, oneOf(['author-date', 'committer-date'])),
    ]),
  },
  org: {
    list: spec('read', 'none', NO_POSITIONAL, [LIMIT_FLAG]),
  },
  cache: {
    list: spec('read', 'repo', NO_POSITIONAL, [
      LIMIT_FLAG,
      ...OUTPUT,
      f('key', 'k', V.cacheKey),
      f('ref', 'r', V.ref),
      f('order', 'O', V.order),
      f('sort', 'S', oneOf(['created_at', 'last_accessed_at', 'size_in_bytes'])),
    ]),
    delete: spec('write', 'repo', { min: 0, max: 1, value: V.cacheKey }, [f('all', 'a', null), f('ref', 'r', V.ref)]),
  },
  ruleset: {
    list: spec('read', 'repo-or-org', NO_POSITIONAL, [LIMIT_FLAG, f('parents', 'p', null), f('org', 'o', V.org)]),
    view: spec('read', 'repo-or-org', ONE_NUMBER, [f('parents', 'p', null), f('org', 'o', V.org)]),
    check: spec('read', 'repo', { min: 0, max: 1, value: V.branch }, [f('default', undefined, null)]),
  },
  variable: {
    list: spec('read', 'repo-or-org', NO_POSITIONAL, [f('env', 'e', V.envName), f('org', 'o', V.org), ...OUTPUT]),
    get: spec('read', 'repo-or-org', { min: 1, max: 1, value: V.variableName }, [
      f('env', 'e', V.envName),
      f('org', 'o', V.org),
      ...OUTPUT,
    ]),
    // Without --body gh reads the value from stdin, which the broker never provides.
    set: spec(
      'write',
      'repo-or-org',
      { min: 1, max: 1, value: V.variableName },
      [
        f('body', 'b', V.text),
        f('env', 'e', V.envName),
        f('org', 'o', V.org),
        f('visibility', 'v', oneOf(['all', 'private', 'selected'])),
        f('repos', 'r', V.repoNames),
      ],
      ['body'],
    ),
    delete: spec('write', 'repo-or-org', { min: 1, max: 1, value: V.variableName }, [
      f('env', 'e', V.envName),
      f('org', 'o', V.org),
    ]),
  },
  project: {
    view: spec('read', 'owner', ONE_NUMBER, [
      f('owner', undefined, V.org),
      f('format', undefined, oneOf(['json'])),
      JQ_FLAG,
    ]),
    list: spec('read', 'owner', NO_POSITIONAL, [
      f('owner', undefined, V.org),
      f('closed', undefined, null),
      LIMIT_FLAG,
      f('format', undefined, oneOf(['json'])),
      JQ_FLAG,
    ]),
    'item-list': spec('read', 'owner', ONE_NUMBER, [
      f('owner', undefined, V.org),
      LIMIT_FLAG,
      f('format', undefined, oneOf(['json'])),
      JQ_FLAG,
      f('query', undefined, V.line),
    ]),
    'field-list': spec('read', 'owner', ONE_NUMBER, [
      f('owner', undefined, V.org),
      LIMIT_FLAG,
      f('format', undefined, oneOf(['json'])),
      JQ_FLAG,
    ]),
  },
});

const API_FLAGS: readonly GhFlagSpec[] = deepFreeze([
  f('method', 'X', oneOf(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])),
  { long: 'raw-field', short: 'f', value: rawField, repeatable: true },
  { long: 'field', short: 'F', value: typedField, repeatable: true },
  f('header', 'H', header),
  JQ_FLAG,
  f('paginate', undefined, null),
  f('slurp', undefined, null),
  f('include', 'i', null),
  f('silent', undefined, null),
]);

// Any one of these path segments marks a credential endpoint, for every method. secret-scanning
// alerts carry the leaked secret itself.
const CREDENTIAL_SEGMENTS = new Set([
  'secret-scanning',
  'private-registries',
  'secrets',
  'keys',
  'gpg_keys',
  'ssh_signing_keys',
  'authorizations',
  'applications',
  'access_tokens',
  'hooks',
  'registration-token',
  'remove-token',
  'personal-access-tokens',
  'personal-access-token-requests',
  'credential-authorizations',
]);

// ── gh api ────────────────────────────────────────────────

export type GhApiPath =
  | { ok: true; path: string; segments: string[]; query: string | null }
  | { ok: false; reason: string };

/**
 * Normalizes a `gh api` endpoint: one leading slash, segments of `[A-Za-z0-9._-]` only. Full URLs,
 * percent-encoding, `..`, empty segments (`//`, trailing `/`), placeholders and a `/` inside the
 * query are rejected rather than repaired.
 */
export function normalizeGhApiPath(endpoint: string): GhApiPath {
  if (endpoint.length === 0 || endpoint.length > 2048) return { ok: false, reason: 'empty or oversized endpoint' };
  if (/[\s\p{Cc}\\%#]/u.test(endpoint)) {
    return { ok: false, reason: 'endpoint contains whitespace, a backslash, % encoding or #' };
  }
  if (endpoint.includes('://')) return { ok: false, reason: 'full URLs are not allowed' };
  const q = endpoint.indexOf('?');
  const rawPath = q < 0 ? endpoint : endpoint.slice(0, q);
  const query = q < 0 ? null : endpoint.slice(q + 1);
  const trimmed = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, reason: 'empty path segment (//, leading // or trailing /)' };
    if (segment.includes('..') || segment === '.') return { ok: false, reason: 'dot segments are not allowed' };
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      return { ok: false, reason: `path segment ${JSON.stringify(segment)} has characters outside [A-Za-z0-9._-]` };
    }
  }
  if (query !== null) {
    if (query.length === 0 || !/^[A-Za-z0-9._=&,+*:-]+$/.test(query)) {
      return { ok: false, reason: 'query may hold only key=value pairs (no /, no second ?)' };
    }
    if (query.includes('..') || PLACEHOLDER_RE.test(query)) {
      return { ok: false, reason: 'query may not hold .. or placeholders' };
    }
  }
  return { ok: true, path: `/${segments.join('/')}`, segments, query };
}

function orgAdminTool(segments: string[]): string | null {
  const s = segments.map((segment) => segment.toLowerCase());
  if (s[0] === 'orgs' && (s[2] === 'memberships' || s[2] === 'members')) return 'gh_org_member';
  if (s[0] === 'repos' && s[3] === 'collaborators') return 'gh_repo_access';
  return null;
}

function matchRule(rule: GhRestWriteRule, method: GhApiMethod, segments: string[]): boolean {
  if (rule.method !== method) return false;
  const want = rule.path.replace(/^\//, '').split('/');
  if (want.length !== segments.length) return false;
  return want.every((part, i) => /^\{[A-Za-z_]+\}$/.test(part) || part === segments[i]);
}

function deny(code: GhDenyCode, reason: string): GhClassification {
  return { kind: 'deny', code, reason };
}

function classifyApi(rest: readonly string[], ctx: GhPolicyContext): GhClassification {
  const parsed = parseArgs(rest, API_FLAGS, ctx);
  if (!parsed.ok) return deny(parsed.code, parsed.reason);
  if (parsed.positionals.length !== 1) return deny('positional-count', 'gh api takes exactly one endpoint');
  const endpoint = parsed.positionals[0];

  if (endpoint.replace(/^\//, '').split('?')[0].toLowerCase() === 'graphql') {
    return deny('api-graphql', 'graphql is not allowed in v1');
  }
  const normalized = normalizeGhApiPath(endpoint);
  if (!normalized.ok) return deny('api-path-invalid', normalized.reason);
  const { segments } = normalized;

  let repo: string | null = null;
  const head = segments[0].toLowerCase();
  if (head === 'repos' || head === 'orgs') {
    if (segments.length < (head === 'repos' ? 3 : 2)) return deny('api-path-invalid', `incomplete ${head}/ path`);
    const owner = checkOrg(segments[1], ctx);
    if (!owner.ok) return deny(owner.code, owner.reason);
    if (head === 'repos') repo = `${segments[1]}/${segments[2]}`;
  }
  const credential = segments.find((segment) => CREDENTIAL_SEGMENTS.has(segment.toLowerCase()));
  if (credential !== undefined) return deny('api-credential-path', `credential endpoint (${credential})`);
  // Path-head allowlist: user/, users/, search/, repositories/<id>, organizations/<id>, gists,
  // notifications, app/ and the rest reach past the policy's owners or the account's own data.
  const allowedHead =
    segments[0] === 'repos' || segments[0] === 'orgs' || (segments[0] === 'rate_limit' && segments.length === 1);
  if (!allowedHead) {
    return deny(
      'api-path-not-allowlisted',
      `${normalized.path}: gh api reaches only repos/<owner>/<repo>/…, orgs/<owner>/… and rate_limit`,
    );
  }

  const fields = [...(parsed.flags.get('raw-field') ?? []), ...(parsed.flags.get('field') ?? [])];
  const keys = fields.map(fieldKey);

  // gh api.go: -X wins when given; otherwise any field (or --input, never allowed here) means POST.
  const explicit = parsed.flags.get('method')?.[0] as GhApiMethod | undefined;
  const method: GhApiMethod = explicit ?? (fields.length > 0 ? 'POST' : 'GET');
  const api: GhApiRequest = { method, path: normalized.path, query: normalized.query };

  if (method === 'GET') {
    return { kind: 'read', reason: 'gh api GET', command: 'api', subcommand: null, repo, api };
  }
  const tool = orgAdminTool(segments);
  if (tool !== null) {
    return {
      kind: 'org-admin-op',
      reason: `organization and repository access changes go through the ${tool} tool, not gh api`,
      command: 'api',
      subcommand: null,
      repo,
      api,
    };
  }
  const rule = (ctx.restWriteAllowlist ?? []).find((candidate) => matchRule(candidate, method, segments));
  if (rule === undefined) {
    return deny('api-rest-write-not-allowlisted', `${method} ${normalized.path} is not in the REST write allowlist`);
  }
  const extra = keys.find((key) => !rule.fields.includes(key));
  if (extra !== undefined) return deny('api-field-not-allowlisted', `field ${extra} is not allowed for ${rule.path}`);
  return {
    kind: 'write',
    reason: `REST write allowlist: ${method} ${rule.path}`,
    command: 'api',
    subcommand: null,
    repo,
    api,
  };
}

// ── argv parsing ──────────────────────────────────────────

type Parsed =
  | { ok: true; flags: Map<string, string[]>; positionals: string[] }
  | { ok: false; code: GhDenyCode; reason: string };

/**
 * Canonical forms only: `--long value`, `--long=value`, `-s value`, bare booleans (also
 * `--long=true|false`). pflag also accepts `-sVALUE`, `-s=VALUE`, grouped shorts and `--`; each is a
 * place where this parser and gh could read the same argv differently, so each is denied. A
 * value-taking flag consumes the next token whatever it looks like, as pflag does.
 */
function parseArgs(tokens: readonly string[], flags: readonly GhFlagSpec[], ctx: GhPolicyContext): Parsed {
  const values = new Map<string, string[]>();
  const fieldKeys = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-') return { ok: false, code: 'stdin-not-allowed', reason: '"-" (stdin) is never allowed' };
    if (token === '--') return { ok: false, code: 'flag-form', reason: '"--" end-of-flags marker is not allowed' };
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    let flag: GhFlagSpec | undefined;
    let inline: string | undefined;
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const name = eq < 0 ? body : body.slice(0, eq);
      inline = eq < 0 ? undefined : body.slice(eq + 1);
      flag = flags.find((candidate) => candidate.long === name);
      if (flag === undefined) return { ok: false, code: 'flag-not-allowed', reason: `--${name} is not allowed here` };
    } else {
      if (token.length !== 2) {
        return {
          ok: false,
          code: 'flag-form',
          reason: `${token}: write short flags alone, value as the next argument`,
        };
      }
      flag = flags.find((candidate) => candidate.short === token[1]);
      if (flag === undefined) return { ok: false, code: 'flag-not-allowed', reason: `${token} is not allowed here` };
    }
    const seen = values.get(flag.long);
    if (seen !== undefined && flag.repeatable !== true) {
      return { ok: false, code: 'flag-duplicate', reason: `--${flag.long} is given more than once` };
    }
    let value: string;
    if (flag.value === null) {
      if (inline !== undefined && inline !== 'true' && inline !== 'false') {
        return { ok: false, code: 'flag-value-invalid', reason: `--${flag.long} takes no value (or =true / =false)` };
      }
      value = inline ?? 'true';
    } else {
      if (inline !== undefined) {
        value = inline;
      } else {
        if (i + 1 >= tokens.length)
          return { ok: false, code: 'flag-value-missing', reason: `--${flag.long} needs a value` };
        i += 1;
        value = tokens[i];
      }
      if (value === '-')
        return { ok: false, code: 'stdin-not-allowed', reason: `--${flag.long} -: stdin is never allowed` };
      const check = flag.value(value, ctx);
      if (!check.ok) return { ok: false, code: check.code, reason: `--${flag.long}: ${check.reason}` };
      if (flag.repeatable === true) {
        const key = fieldKey(value);
        if (fieldKeys.has(key)) return { ok: false, code: 'flag-duplicate', reason: `field ${key} is given twice` };
        fieldKeys.add(key);
      }
    }
    values.set(flag.long, [...(seen ?? []), value]);
  }
  return { ok: true, flags: values, positionals };
}

function checkScope(scope: GhScope, flags: Map<string, string[]>, positionals: string[]): string | null {
  switch (scope) {
    case 'repo':
      return flags.has('repo') ? null : '-R owner/name is required (the broker has no checkout)';
    case 'repo-or-org':
      return flags.has('repo') !== flags.has('org') ? null : 'exactly one of -R owner/name or --org is required';
    case 'owner':
      return flags.has('owner') ? null : '--owner is required';
    case 'owner-or-repo':
      return flags.has('owner') || flags.has('repo') ? null : '--owner or -R owner/name is required';
    case 'positional-repo':
      return positionals.length === 1 ? null : 'owner/name is required';
    case 'none':
      return null;
  }
}

function isRestWriteRule(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Record<string, unknown>;
  return (
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(rule.method as string) &&
    typeof rule.path === 'string' &&
    Array.isArray(rule.fields) &&
    rule.fields.every((field) => typeof field === 'string')
  );
}

function isPolicyContext(value: unknown): value is GhPolicyContext {
  if (typeof value !== 'object' || value === null) return false;
  const { allowedOwners, restWriteAllowlist } = value as Record<string, unknown>;
  if (!Array.isArray(allowedOwners) || !allowedOwners.every((owner) => typeof owner === 'string')) return false;
  return (
    restWriteAllowlist === undefined || (Array.isArray(restWriteAllowlist) && restWriteAllowlist.every(isRestWriteRule))
  );
}

function classify(argv: readonly string[], ctx: GhPolicyContext): GhClassification {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) {
    return deny('argv-invalid', `argv must hold 1-${MAX_ARGV} arguments`);
  }
  for (const token of argv) {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || token.includes('\u0000')) {
      return deny('argv-invalid', 'every argument must be a string without NUL, at most 64 KiB');
    }
  }
  if (!isPolicyContext(ctx)) return deny('internal-error', 'the gh policy context is malformed');
  const [command, subcommand, ...args] = argv;
  if (command === 'api') return classifyApi(argv.slice(1), ctx);
  const entry = hasOwn(GH_COMMAND_TABLE, command) ? GH_COMMAND_TABLE[command] : undefined;
  if (entry === undefined) return deny('command-not-allowed', `gh ${command} is not allowed`);
  const name = subcommand ?? '';
  const sub = hasOwn(entry, name) ? entry[name] : undefined;
  if (sub === undefined) return deny('subcommand-not-allowed', `gh ${command} ${name} is not allowed`);

  const parsed = parseArgs(args, sub.flags, ctx);
  if (!parsed.ok) return deny(parsed.code, parsed.reason);
  const { positionals } = parsed;
  const { min, max, value } = sub.positionals;
  if (positionals.length < min || positionals.length > max) {
    const want = min === max ? `${min}` : `${min}-${max}`;
    return deny('positional-count', `expected ${want} positional argument(s), got ${positionals.length}`);
  }
  for (const positional of positionals) {
    const check = value(positional, ctx);
    if (!check.ok) {
      const code = check.code === 'owner-not-allowed' ? check.code : 'positional-invalid';
      return deny(code, `${JSON.stringify(positional)}: ${check.reason}`);
    }
  }
  for (const flag of sub.required ?? []) {
    if (!parsed.flags.has(flag)) return deny('required-flag-missing', `--${flag} is required`);
  }
  const scopeProblem = checkScope(sub.scope, parsed.flags, positionals);
  if (scopeProblem !== null) return deny('scope-required', scopeProblem);

  const repo = sub.scope === 'positional-repo' ? positionals[0] : (parsed.flags.get('repo')?.[0] ?? null);
  return {
    kind: sub.kind,
    reason: `gh ${command} ${name} is on the ${sub.kind} allowlist`,
    command,
    subcommand: name,
    repo,
  };
}

/**
 * Classifies a gh argv (no shell; `gh` itself not included) as read, write, org-admin-op (a
 * `gh api` call that the dedicated org/repo access tools cover) or deny. Never throws: a malformed
 * context or an unexpected failure is a deny with code `internal-error`.
 */
export function classifyGh(argv: readonly string[], ctx: GhPolicyContext): GhClassification {
  try {
    return classify(argv, ctx);
  } catch {
    return deny('internal-error', 'the gh classifier failed on this input');
  }
}
