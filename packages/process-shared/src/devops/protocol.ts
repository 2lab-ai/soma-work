// devops-tools MCP server <-> devops broker wire protocol (.prd/16-devops-tools-architecture.md §2, §5).
//
// Newline-delimited JSON over the broker's unix socket, one request per connection: the client writes
// one request line; the broker answers with at most one `pending` (an approval card was posted) and
// then exactly one terminal `result` or `error`. Pure and import-free: the broker bundles this file
// into its root-owned copy.

/** Bumped on any incompatible change. A peer speaking another version is rejected, never adapted to. */
export const PROTOCOL_VERSION = 1;

/** Longest line either side accepts, in UTF-16 code units (gh output is capped at 1 MB per stream). */
export const MAX_LINE_LENGTH = 8 * 1024 * 1024;

/** Absolute lease ceiling, "3일 미만" (§6). Broker policy `maxTtl` may narrow it per environment. */
export const MAX_LEASE_TTL_SECONDS = 71 * 3600;

/** The broker binds this itself inside a 0750 broker:soma-devops directory (Node cannot take a launchd socket). */
export const DEFAULT_BROKER_SOCKET_PATH = '/usr/local/var/soma-devops/run/broker.sock';

/** Overrides the socket path for the MCP server (tests, non-default installs). */
export const BROKER_SOCKET_ENV = 'SOMA_DEVOPS_BROKER_SOCKET';

export const DEVOPS_TOOLS = [
  'list',
  'gh_read',
  'gh_write',
  'gh_org_member',
  'gh_repo_access',
  'cf_lease_request',
  'cf_api',
  'cf_lease_revoke',
] as const;
export type DevopsTool = (typeof DEVOPS_TOOLS)[number];

export const DEVOPS_ERROR_CODES = [
  /** The admin denied the card, or nobody answered before it expired. The model may ask again. */
  'not-approved',
  /** Approved and running; the outcome will land in the ledger and on the card. Do not ask again. */
  'still-executing',
  /** A remote write was sent and its outcome is unknown (lost response). Never retried automatically. */
  'result-unknown',
  'too-many-pending-approvals',
  /** The request is well formed but outside policy (gh allowlist, owner, TTL ceiling, ...). */
  'policy-denied',
  /** Malformed line, unknown key, or arguments that fail the per-tool schema. */
  'bad-request',
  'unknown-account',
  'unknown-env',
  'lease-not-found',
  'lease-expired',
  'lease-out-of-scope',
  'version-mismatch',
  /** GitHub, Cloudflare or Slack answered with an error. */
  'upstream-error',
  'internal',
] as const;
export type DevopsErrorCode = (typeof DEVOPS_ERROR_CODES)[number];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Who the MCP server says is asking. Self-claimed and unauthenticated: any process running as the
 * bot user can put any value here. The broker records it and shows it as a claim on the card; it is
 * never an authorization input.
 */
export interface UnverifiedRequesterClaim {
  slackUserId: string;
  sessionKey: string;
}

export type ListArgs = Record<string, never>;

export interface GhArgs {
  /** Account name from the broker policy (e.g. `member`, `org-admin`). */
  account: string;
  /** gh argv without `gh`; classified by gh-policy.ts in the broker. */
  args: string[];
}

export type GhOrgMemberArgs =
  | { action: 'add' | 'set-role'; user: string; role: 'member' | 'admin' }
  | { action: 'remove'; user: string };

export type GhRepoPermission = 'pull' | 'triage' | 'push' | 'maintain' | 'admin';

export type GhRepoAccessArgs =
  | { action: 'grant'; repo: string; user: string; permission: GhRepoPermission }
  | { action: 'revoke'; repo: string; user: string };

export interface CfLeaseRequestArgs {
  env: string;
  access: 'read' | 'edit';
  permissions: string[];
  /** Zone names; empty = account-level resources. */
  zones: string[];
  /** `<n>m` or `<n>h`, at most MAX_LEASE_TTL_SECONDS. Absent = the policy default. */
  ttl?: string;
  reason: string;
}

export type CfApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CfApiArgs {
  lease: string;
  method: CfApiMethod;
  /** Path under the Cloudflare API v4 base, starting with `/`. Scope checks are the broker's. */
  path: string;
  query?: Record<string, string>;
  body?: JsonValue;
}

export interface CfLeaseRevokeArgs {
  lease: string;
}

export interface DevopsToolArgs {
  list: ListArgs;
  gh_read: GhArgs;
  gh_write: GhArgs;
  gh_org_member: GhOrgMemberArgs;
  gh_repo_access: GhRepoAccessArgs;
  cf_lease_request: CfLeaseRequestArgs;
  cf_api: CfApiArgs;
  cf_lease_revoke: CfLeaseRevokeArgs;
}

export type DevopsRequest = {
  [T in DevopsTool]: {
    v: number;
    id: string;
    tool: T;
    args: DevopsToolArgs[T];
    claimedRequester: UnverifiedRequesterClaim;
  };
}[DevopsTool];

export interface PendingMessage {
  v: number;
  id: string;
  type: 'pending';
  approvalId: string;
  /** First 12 hex characters of the sha256 the card shows. */
  digestPrefix: string;
  /** ISO 8601 UTC. */
  expiresAt: string;
}

export interface ResultMessage {
  v: number;
  id: string;
  type: 'result';
  data: JsonValue;
}

/** `id` is null only when the request line could not be read far enough to know its id. */
export type ErrorMessage =
  | { v: number; id: string | null; type: 'error'; code: 'not-approved'; reason: 'denied' | 'expired'; message: string }
  | { v: number; id: string | null; type: 'error'; code: Exclude<DevopsErrorCode, 'not-approved'>; message: string };

export type BrokerMessage = PendingMessage | ResultMessage | ErrorMessage;

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'bad-request' | 'version-mismatch'; message: string; id: string | null };

// ── Field checks ──────────────────────────────────────────

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DIGEST_PREFIX_RE = /^[0-9a-f]{12}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,20}$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const ENV_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CF_PERMISSION_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,99}$/;
const ZONE_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LEASE_ID_RE = /^[0-9a-f]{32}$/;
const TTL_RE = /^([1-9][0-9]{0,4})([mh])$/;
const CF_PATH_RE = /^\/[!-~]{0,2047}$/;
const QUERY_KEY_RE = /^[A-Za-z0-9_.[\]-]{1,100}$/;
const CONTROL_RE = /\p{Cc}/u;

const MAX_GH_ARGS = 100;
const MAX_GH_ARG_LENGTH = 65_536;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_BODY_LENGTH = 1024 * 1024;
const MAX_JSON_DEPTH = 32;

type Problem = string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(object, key) !== undefined;
}

/** Every key present must be listed, and every required key must be present. */
function keysProblem(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): Problem {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) return `unknown key ${JSON.stringify(key)}`;
  }
  for (const key of required) {
    if (!hasOwn(value, key) || value[key] === undefined) return `missing ${key}`;
  }
  return null;
}

function stringProblem(value: unknown, name: string, re: RegExp): Problem {
  return typeof value === 'string' && re.test(value) ? null : `${name} has the wrong format`;
}

function textProblem(value: unknown, name: string, max: number): Problem {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    return `${name} must be 1-${max} characters`;
  return value.includes('\u0000') ? `${name} contains NUL` : null;
}

function enumProblem(value: unknown, name: string, values: readonly string[]): Problem {
  return typeof value === 'string' && values.includes(value) ? null : `${name} must be one of ${values.join(', ')}`;
}

function arrayProblem(value: unknown, name: string, min: number, max: number, item: (v: unknown) => Problem): Problem {
  if (!Array.isArray(value) || value.length < min || value.length > max) return `${name} must hold ${min}-${max} items`;
  for (const entry of value) {
    const problem = item(entry);
    if (problem !== null) return `${name}: ${problem}`;
  }
  return null;
}

function jsonProblem(value: unknown, depth = 0): Problem {
  if (depth > MAX_JSON_DEPTH) return 'nested too deeply';
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'non-finite number';
  if (Array.isArray(value)) {
    for (const entry of value) {
      const problem = jsonProblem(entry, depth + 1);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    for (const entry of Object.values(value)) {
      const problem = jsonProblem(entry, depth + 1);
      if (problem !== null) return problem;
    }
    return null;
  }
  return 'not a JSON value';
}

/** `30m` / `1h` → seconds, or null when malformed, zero, or past MAX_LEASE_TTL_SECONDS. */
export function parseLeaseTtlSeconds(ttl: string): number | null {
  const match = TTL_RE.exec(ttl);
  if (match === null) return null;
  const seconds = Number(match[1]) * (match[2] === 'h' ? 3600 : 60);
  return seconds <= MAX_LEASE_TTL_SECONDS ? seconds : null;
}

const ARGS_CHECKS: { [T in DevopsTool]: (args: Record<string, unknown>) => Problem } = {
  list: (args) => keysProblem(args, []),
  gh_read: ghArgsProblem,
  gh_write: ghArgsProblem,
  gh_org_member: (args) => {
    const action = enumProblem(args.action, 'action', ['add', 'set-role', 'remove']);
    if (action !== null) return action;
    const withRole = args.action !== 'remove';
    return (
      keysProblem(args, withRole ? ['action', 'user', 'role'] : ['action', 'user']) ??
      stringProblem(args.user, 'user', GH_LOGIN_RE) ??
      (withRole ? enumProblem(args.role, 'role', ['member', 'admin']) : null)
    );
  },
  gh_repo_access: (args) => {
    const action = enumProblem(args.action, 'action', ['grant', 'revoke']);
    if (action !== null) return action;
    const grant = args.action === 'grant';
    return (
      keysProblem(args, grant ? ['action', 'repo', 'user', 'permission'] : ['action', 'repo', 'user']) ??
      stringProblem(args.repo, 'repo', GH_REPO_RE) ??
      stringProblem(args.user, 'user', GH_LOGIN_RE) ??
      (grant ? enumProblem(args.permission, 'permission', ['pull', 'triage', 'push', 'maintain', 'admin']) : null)
    );
  },
  cf_lease_request: (args) =>
    keysProblem(args, ['env', 'access', 'permissions', 'zones', 'reason'], ['ttl']) ??
    stringProblem(args.env, 'env', ENV_RE) ??
    enumProblem(args.access, 'access', ['read', 'edit']) ??
    arrayProblem(args.permissions, 'permissions', 1, 20, (v) => stringProblem(v, 'permission', CF_PERMISSION_RE)) ??
    arrayProblem(args.zones, 'zones', 0, 20, (v) => stringProblem(v, 'zone', ZONE_RE)) ??
    (args.ttl === undefined || (typeof args.ttl === 'string' && parseLeaseTtlSeconds(args.ttl) !== null)
      ? null
      : `ttl must be <n>m or <n>h, at most ${MAX_LEASE_TTL_SECONDS / 3600}h`) ??
    textProblem(args.reason, 'reason', 500),
  cf_api: (args) =>
    keysProblem(args, ['lease', 'method', 'path'], ['query', 'body']) ??
    stringProblem(args.lease, 'lease', LEASE_ID_RE) ??
    enumProblem(args.method, 'method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) ??
    stringProblem(args.path, 'path', CF_PATH_RE) ??
    (args.query === undefined ? null : queryProblem(args.query)) ??
    (args.body === undefined ? null : bodyProblem(args.body)),
  cf_lease_revoke: (args) => keysProblem(args, ['lease']) ?? stringProblem(args.lease, 'lease', LEASE_ID_RE),
};

function ghArgsProblem(args: Record<string, unknown>): Problem {
  return (
    keysProblem(args, ['account', 'args']) ??
    stringProblem(args.account, 'account', ACCOUNT_RE) ??
    arrayProblem(args.args, 'args', 1, MAX_GH_ARGS, (v) =>
      typeof v === 'string' && v.length <= MAX_GH_ARG_LENGTH && !v.includes('\u0000')
        ? null
        : 'each argument must be a string without NUL, at most 64 KiB',
    )
  );
}

function queryProblem(query: unknown): Problem {
  if (!isRecord(query)) return 'query must be an object of strings';
  const entries = Object.entries(query);
  if (entries.length > 50) return 'query holds more than 50 keys';
  for (const [key, value] of entries) {
    if (!QUERY_KEY_RE.test(key)) return `query key ${JSON.stringify(key)} has the wrong format`;
    if (typeof value !== 'string' || value.length > 2048 || CONTROL_RE.test(value)) {
      return `query value for ${key} must be a single-line string`;
    }
  }
  return null;
}

function bodyProblem(body: unknown): Problem {
  const problem = jsonProblem(body);
  if (problem !== null) return `body: ${problem}`;
  return JSON.stringify(body).length > MAX_BODY_LENGTH ? 'body is larger than 1 MiB' : null;
}

function isDevopsTool(value: unknown): value is DevopsTool {
  return typeof value === 'string' && (DEVOPS_TOOLS as readonly string[]).includes(value);
}

/** The per-tool schema check the request parser applies; exported so the MCP server rejects early. */
export function validateToolArgs(tool: DevopsTool, args: unknown): { ok: true } | { ok: false; message: string } {
  if (!isDevopsTool(tool)) return { ok: false, message: `unknown tool ${JSON.stringify(tool)}` };
  if (!isRecord(args)) return { ok: false, message: 'args must be an object' };
  const problem = ARGS_CHECKS[tool](args);
  return problem === null ? { ok: true } : { ok: false, message: `${tool}: ${problem}` };
}

function claimProblem(value: unknown): Problem {
  if (!isRecord(value)) return 'claimedRequester must be an object';
  return (
    keysProblem(value, ['slackUserId', 'sessionKey']) ??
    stringProblem(value.slackUserId, 'claimedRequester.slackUserId', SLACK_USER_RE) ??
    (typeof value.sessionKey === 'string' &&
    value.sessionKey.length > 0 &&
    value.sessionKey.length <= 256 &&
    !CONTROL_RE.test(value.sessionKey)
      ? null
      : 'claimedRequester.sessionKey must be 1-256 printable characters')
  );
}

function readId(value: Record<string, unknown>): string | null {
  return typeof value.id === 'string' && REQUEST_ID_RE.test(value.id) ? value.id : null;
}

/** Validates one decoded request line. The version is checked before anything else. */
export function parseRequest(value: unknown): ParseResult<DevopsRequest> {
  if (!isRecord(value)) return { ok: false, code: 'bad-request', message: 'request must be a JSON object', id: null };
  const id = readId(value);
  if (value.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'version-mismatch',
      message: `protocol version ${JSON.stringify(value.v)} is not ${PROTOCOL_VERSION}`,
      id,
    };
  }
  const problem =
    keysProblem(value, ['v', 'id', 'tool', 'args', 'claimedRequester']) ??
    (id === null ? 'id has the wrong format' : null) ??
    (isDevopsTool(value.tool) ? null : `unknown tool ${JSON.stringify(value.tool)}`) ??
    claimProblem(value.claimedRequester);
  if (problem !== null) return { ok: false, code: 'bad-request', message: problem, id };
  const args = validateToolArgs(value.tool as DevopsTool, value.args);
  if (!args.ok) return { ok: false, code: 'bad-request', message: args.message, id };
  return { ok: true, value: value as unknown as DevopsRequest };
}

function brokerProblem(value: Record<string, unknown>): Problem {
  switch (value.type) {
    case 'pending':
      return (
        keysProblem(value, ['v', 'id', 'type', 'approvalId', 'digestPrefix', 'expiresAt']) ??
        stringProblem(value.id, 'id', REQUEST_ID_RE) ??
        stringProblem(value.approvalId, 'approvalId', APPROVAL_ID_RE) ??
        stringProblem(value.digestPrefix, 'digestPrefix', DIGEST_PREFIX_RE) ??
        (typeof value.expiresAt === 'string' &&
        ISO_UTC_RE.test(value.expiresAt) &&
        !Number.isNaN(Date.parse(value.expiresAt))
          ? null
          : 'expiresAt must be an ISO 8601 UTC timestamp')
      );
    case 'result':
      return (
        keysProblem(value, ['v', 'id', 'type', 'data']) ??
        stringProblem(value.id, 'id', REQUEST_ID_RE) ??
        (jsonProblem(value.data) === null ? null : 'data must be a JSON value')
      );
    case 'error': {
      const notApproved = value.code === 'not-approved';
      return (
        keysProblem(
          value,
          notApproved ? ['v', 'id', 'type', 'code', 'reason', 'message'] : ['v', 'id', 'type', 'code', 'message'],
        ) ??
        (value.id === null ? null : stringProblem(value.id, 'id', REQUEST_ID_RE)) ??
        enumProblem(value.code, 'code', DEVOPS_ERROR_CODES) ??
        (notApproved ? enumProblem(value.reason, 'reason', ['denied', 'expired']) : null) ??
        (typeof value.message === 'string' && value.message.length <= MAX_MESSAGE_LENGTH
          ? null
          : `message must be a string of at most ${MAX_MESSAGE_LENGTH} characters`)
      );
    }
    default:
      return `unknown message type ${JSON.stringify(value.type)}`;
  }
}

/** Validates one decoded broker line (what the MCP server reads). */
export function parseBrokerMessage(value: unknown): ParseResult<BrokerMessage> {
  if (!isRecord(value)) return { ok: false, code: 'bad-request', message: 'message must be a JSON object', id: null };
  const id = readId(value);
  if (value.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'version-mismatch',
      message: `protocol version ${JSON.stringify(value.v)} is not ${PROTOCOL_VERSION}`,
      id,
    };
  }
  const problem = brokerProblem(value);
  if (problem !== null) return { ok: false, code: 'bad-request', message: problem, id };
  return { ok: true, value: value as unknown as BrokerMessage };
}

export function isTerminal(message: BrokerMessage): boolean {
  return message.type !== 'pending';
}

// ── Exchange ordering ─────────────────────────────────────

export interface ExchangeState {
  requestId: string;
  phase: 'awaiting' | 'pending' | 'done';
}

/**
 * Client-side ordering check: at most one `pending`, then exactly one terminal message, all for the
 * request's id. An `error` with a null id ends the exchange too (one request per connection).
 */
export function advanceExchange(
  state: ExchangeState,
  message: BrokerMessage,
): { ok: true; state: ExchangeState } | { ok: false; message: string } {
  if (state.phase === 'done') return { ok: false, message: `message after the exchange ended: ${message.type}` };
  if (message.id !== state.requestId && !(message.type === 'error' && message.id === null)) {
    return { ok: false, message: `message for ${JSON.stringify(message.id)}, expected ${state.requestId}` };
  }
  if (message.type === 'pending') {
    if (state.phase === 'pending') return { ok: false, message: 'second pending message' };
    return { ok: true, state: { requestId: state.requestId, phase: 'pending' } };
  }
  return { ok: true, state: { requestId: state.requestId, phase: 'done' } };
}

// ── Framing ───────────────────────────────────────────────

/** One message as one line. JSON.stringify escapes every newline inside strings. */
export function encodeMessage(message: DevopsRequest | BrokerMessage): string {
  const line = JSON.stringify(message);
  if (line.length > MAX_LINE_LENGTH) throw new RangeError(`message is longer than ${MAX_LINE_LENGTH} characters`);
  return `${line}\n`;
}

/**
 * Appends a chunk to the buffered remainder (the previous call's `rest`, which holds no newline) and
 * returns the complete, non-empty lines. Only the chunk is scanned, so a long partial line costs
 * O(chunk) per call rather than O(buffer).
 */
export function splitLines(buffered: string, chunk: string): { lines: string[]; rest: string; overflow: boolean } {
  const first = chunk.indexOf('\n');
  if (first < 0) {
    const rest = `${buffered}${chunk}`;
    return { lines: [], rest, overflow: rest.length > MAX_LINE_LENGTH };
  }
  const last = chunk.lastIndexOf('\n');
  const middle = first === last ? [] : chunk.slice(first + 1, last).split('\n');
  const lines = [`${buffered}${chunk.slice(0, first)}`, ...middle].filter((line) => line.length > 0);
  const rest = chunk.slice(last + 1);
  const overflow = rest.length > MAX_LINE_LENGTH || lines.some((line) => line.length > MAX_LINE_LENGTH);
  return { lines, rest, overflow };
}

export function parseJsonLine(
  line: string,
): { ok: true; value: unknown } | { ok: false; code: 'bad-request'; message: string } {
  if (line.length > MAX_LINE_LENGTH) return { ok: false, code: 'bad-request', message: 'line too long' };
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false, code: 'bad-request', message: 'line is not valid JSON' };
  }
}
