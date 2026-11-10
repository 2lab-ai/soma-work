// Broker policy (.prd/16-devops-tools-architecture.md §8): who may approve, which gh accounts and
// Cloudflare environments exist, and the lease ceilings. It lives in a file the bot user cannot write,
// so the model cannot widen its own scope. Strict: unknown keys are errors, every error names the JSON
// path, and no error echoes a value.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type DevopsTool, MAX_LEASE_TTL_SECONDS, parseLeaseTtlSeconds } from '@soma/process-shared/devops/protocol.js';

export type GhAccountClass = 'member' | 'org-admin';

export interface CfEnvPolicy {
  accountId: string;
  /** Zone name -> zone id. Empty = account-level resources only. */
  zones: Record<string, string>;
  /** Cloudflare permission-group IDs a lease of each access level may carry. */
  permissionGroups: { read: string[]; edit: string[] };
  defaultTtlSeconds: number;
  /** At most MAX_LEASE_TTL_SECONDS. */
  maxTtlSeconds: number;
  ipCondition: false;
}

export interface BrokerPolicy {
  /** Slack user IDs whose reaction approves or denies a card — the only admin list the broker trusts. */
  admins: string[];
  gh: {
    org: string;
    allowedOwners: string[];
    accounts: Record<string, { login: string; class: GhAccountClass }>;
    restWriteAllowlist: [];
  };
  cloudflare: Record<string, CfEnvPolicy>;
  approvalTimeoutSeconds: number;
  maxPendingApprovals: number;
  /**
   * #1128: how long a card stays open after its requester's live wait (`approvalTimeoutSeconds`) ended. Null =
   * no queue: the card expires with the live wait, as before. Set: the requester is told `queued`, and an
   * admin's approval inside this window runs the request then; the result is kept for the bot (`results`).
   */
  queueTimeoutSeconds: number | null;
  /** Queued cards at most (all sessions). A new card is refused while the queue is full. */
  maxQueuedApprovals: number;
  /**
   * #1129: the tools whose cards the `decide` admin op may approve or deny (the dashboard). Empty = off. The
   * dashboard runs as the model's OS user, so turning this on lets that user decide these cards: an operator
   * choice recorded in this root-owned file, which the model cannot change.
   */
  dashboardDecisionTools: DevopsTool[];
}

export const DEFAULT_LEASE_TTL_SECONDS = 3600;
export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 600;
/**
 * 10 minutes (16 §5.3) — its own ceiling, not the bot's 5-minute permission-request one. The card expires at
 * E = request + this; the broker answers by E + 25 s, the MCP server waits until min(call start + 655 s, E + 30 s)
 * and the bot's SDK ends the tool call at 660 s, so a longer card would outlive the call waiting on it.
 */
export const MAX_APPROVAL_TIMEOUT_SECONDS = 600;
export const DEFAULT_MAX_PENDING_APPROVALS = 3;
export const MAX_PENDING_APPROVALS_LIMIT = 20;
/** A queued card's longest life: one week. */
export const MAX_QUEUE_TIMEOUT_SECONDS = 168 * 3600;
export const DEFAULT_MAX_QUEUED_APPROVALS = 50;
export const MAX_QUEUED_APPROVALS_LIMIT = 200;
/** The tools that post a card, so the only ones a dashboard decision can apply to. */
export const DASHBOARD_DECIDABLE_TOOLS: readonly DevopsTool[] = [
  'gh_write',
  'gh_org_member',
  'gh_repo_access',
  'cf_lease_request',
];

/** `path` is the JSON path (`policy.gh.org`) or, for file-level problems, the policy file. */
export class PolicyError extends Error {
  readonly path: string;

  constructor(where: string, problem: string) {
    super(`${where}: ${problem}`);
    this.name = 'PolicyError';
    this.path = where;
  }
}

const SLACK_USER_RE = /^[UW][A-Z0-9]{2,}$/;
const ACCOUNT_RE = /^[a-z0-9-]{1,32}$/;
const ENV_RE = /^[a-z0-9-]{1,16}$/;
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const ZONE_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PERMISSION_GROUP_RE = /^[!-~]{1,100}$/;
/** Unknown keys shaped like a field name are named in errors; anything else could be a pasted value. */
const PRINTABLE_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type Json = Record<string, unknown>;

function fail(where: string, problem: string): never {
  throw new PolicyError(where, problem);
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(object, key) !== undefined;
}

/** Only for keys already known to be safe to print (schema keys, validated names). */
function child(parent: string, key: string): string {
  return IDENTIFIER_RE.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/** Seconds back to the on-disk `<n>h` / `<n>m` form (for summaries). */
export function formatDuration(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600}h` : `${seconds / 60}m`;
}

function object(value: unknown, at: string, required: readonly string[], optional: readonly string[] = []): Json {
  if (!isRecord(value)) fail(at, 'must be an object');
  for (const key of Object.keys(value)) {
    if (required.includes(key) || optional.includes(key)) continue;
    if (PRINTABLE_KEY_RE.test(key)) fail(child(at, key), 'unknown key');
    fail(at, 'has an unknown key');
  }
  for (const key of required) {
    if (!hasOwn(value, key) || value[key] === undefined) fail(child(at, key), 'is required');
  }
  return value;
}

function string(value: unknown, at: string, re: RegExp, what: string): string {
  if (typeof value !== 'string' || !re.test(value)) fail(at, `must be ${what}`);
  return value;
}

function stringList(
  value: unknown,
  at: string,
  re: RegExp,
  what: string,
  min: number,
  identity: (item: string) => string = (item) => item,
): string[] {
  if (!Array.isArray(value) || value.length < min) {
    fail(at, `must be ${min > 0 ? 'a non-empty' : 'an'} array of ${what}`);
  }
  const seen = new Set<string>();
  return value.map((item, i) => {
    const text = string(item, `${at}[${i}]`, re, `one of ${what}`);
    if (seen.has(identity(text))) fail(`${at}[${i}]`, 'is a duplicate');
    seen.add(identity(text));
    return text;
  });
}

/** Entries of a name-keyed map; a malformed name is reported by position, never printed. */
function namedEntries(value: unknown, at: string, nameRe: RegExp, what: string, min: number): [string, unknown][] {
  if (!isRecord(value)) fail(at, 'must be an object');
  const entries = Object.entries(value);
  if (entries.length < min) fail(at, `must name at least ${min} ${what}`);
  entries.forEach(([name], i) => {
    if (!nameRe.test(name)) fail(at, `${what} name #${i + 1} has the wrong format`);
  });
  return entries;
}

function duration(value: unknown, at: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const seconds = typeof value === 'string' ? parseLeaseTtlSeconds(value) : null;
  if (seconds === null || seconds > max) fail(at, `must be "<n>m" or "<n>h", at most ${formatDuration(max)}`);
  return seconds;
}

const LONG_DURATION_RE = /^([1-9][0-9]{0,5})([mh])$/;

/** As `duration`, past the 71 h lease ceiling (a queue may run for days). */
function longDuration(value: unknown, at: string, max: number): number {
  const match = typeof value === 'string' ? LONG_DURATION_RE.exec(value) : null;
  const seconds = match === null ? null : Number(match[1]) * (match[2] === 'h' ? 3600 : 60);
  if (seconds === null || seconds > max) fail(at, `must be "<n>m" or "<n>h", at most ${formatDuration(max)}`);
  return seconds;
}

function integer(value: unknown, at: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(at, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseGh(value: unknown): BrokerPolicy['gh'] {
  const at = 'policy.gh';
  const gh = object(value, at, ['org', 'accounts'], ['allowedOwners', 'restWriteAllowlist']);
  const org = string(gh.org, `${at}.org`, GH_LOGIN_RE, 'a GitHub organization login');
  const allowedOwners =
    gh.allowedOwners === undefined
      ? [org]
      : stringList(gh.allowedOwners, `${at}.allowedOwners`, GH_LOGIN_RE, 'GitHub logins', 1, (login) =>
          login.toLowerCase(),
        );
  const accounts: BrokerPolicy['gh']['accounts'] = {};
  for (const [name, entry] of namedEntries(gh.accounts, `${at}.accounts`, ACCOUNT_RE, 'account', 1)) {
    const accountAt = child(`${at}.accounts`, name);
    const account = object(entry, accountAt, ['login', 'class']);
    const login = string(account.login, `${accountAt}.login`, GH_LOGIN_RE, 'a GitHub login');
    if (account.class !== 'member' && account.class !== 'org-admin') {
      fail(`${accountAt}.class`, 'must be "member" or "org-admin"');
    }
    accounts[name] = { login, class: account.class };
  }
  const allowlist = gh.restWriteAllowlist;
  if (allowlist !== undefined && (!Array.isArray(allowlist) || allowlist.length > 0)) {
    fail(`${at}.restWriteAllowlist`, 'must be [] in this version (every non-GET gh api call is denied)');
  }
  return { org, allowedOwners, accounts, restWriteAllowlist: [] };
}

function parseCfEnv(value: unknown, at: string): CfEnvPolicy {
  const env = object(value, at, ['accountId', 'zones', 'permissionGroups'], ['defaultTtl', 'maxTtl', 'ipCondition']);
  const accountId = string(env.accountId, `${at}.accountId`, HEX32_RE, 'an account ID of 32 lowercase hex characters');
  const zones: Record<string, string> = {};
  const zoneIds = new Set<string>();
  for (const [zone, id] of namedEntries(env.zones, `${at}.zones`, ZONE_RE, 'zone', 0)) {
    zones[zone] = string(id, child(`${at}.zones`, zone), HEX32_RE, 'a zone ID of 32 lowercase hex characters');
    if (zoneIds.has(zones[zone])) fail(`${at}.zones`, 'names the same zone ID twice');
    zoneIds.add(zones[zone]);
  }
  const groupsAt = `${at}.permissionGroups`;
  const groups = object(env.permissionGroups, groupsAt, ['read', 'edit']);
  const permissionGroups = {
    read: stringList(groups.read, `${groupsAt}.read`, PERMISSION_GROUP_RE, 'permission group IDs', 0),
    edit: stringList(groups.edit, `${groupsAt}.edit`, PERMISSION_GROUP_RE, 'permission group IDs', 0),
  };
  const maxTtlSeconds = duration(env.maxTtl, `${at}.maxTtl`, MAX_LEASE_TTL_SECONDS, MAX_LEASE_TTL_SECONDS);
  const defaultTtlSeconds = duration(
    env.defaultTtl,
    `${at}.defaultTtl`,
    Math.min(DEFAULT_LEASE_TTL_SECONDS, maxTtlSeconds),
    MAX_LEASE_TTL_SECONDS,
  );
  if (defaultTtlSeconds > maxTtlSeconds) fail(`${at}.defaultTtl`, 'must not exceed maxTtl');
  if (env.ipCondition !== undefined && env.ipCondition !== false) {
    fail(`${at}.ipCondition`, 'must be false in this version (the IP condition key is not confirmed yet)');
  }
  return { accountId, zones, permissionGroups, defaultTtlSeconds, maxTtlSeconds, ipCondition: false };
}

function parseCloudflare(value: unknown): Record<string, CfEnvPolicy> {
  const at = 'policy.cloudflare';
  const envs: Record<string, CfEnvPolicy> = {};
  if (value === undefined) return envs;
  for (const [name, entry] of namedEntries(value, at, ENV_RE, 'environment', 0)) {
    envs[name] = parseCfEnv(entry, child(at, name));
  }
  return envs;
}

function parseDashboardDecisions(value: unknown): DevopsTool[] {
  const at = 'policy.dashboardDecisions';
  if (value === undefined) return [];
  const section = object(value, at, ['tools']);
  const names = DASHBOARD_DECIDABLE_TOOLS.join(', ');
  const toolRe = new RegExp(`^(?:${DASHBOARD_DECIDABLE_TOOLS.join('|')})$`);
  return stringList(section.tools, `${at}.tools`, toolRe, `the tools that post a card (${names})`, 1) as DevopsTool[];
}

/**
 * Validates the on-disk policy (16 §8) and returns it with durations in seconds and defaults filled:
 * allowedOwners = [org], restWriteAllowlist = [], defaultTtl 1h (capped at maxTtl), maxTtl 71h,
 * ipCondition false, approvalTimeout 10m (at most 10m), maxPendingApprovals 3 (1-20), queueTimeout off
 * (at most 168h, longer than approvalTimeout), maxQueuedApprovals 50 (1-200), dashboardDecisions off.
 */
export function parsePolicy(json: unknown): BrokerPolicy {
  const policy = object(
    json,
    'policy',
    ['admins', 'gh'],
    [
      'cloudflare',
      'approvalTimeout',
      'maxPendingApprovals',
      'queueTimeout',
      'maxQueuedApprovals',
      'dashboardDecisions',
    ],
  );
  const approvalTimeoutSeconds = duration(
    policy.approvalTimeout,
    'policy.approvalTimeout',
    DEFAULT_APPROVAL_TIMEOUT_SECONDS,
    MAX_APPROVAL_TIMEOUT_SECONDS,
  );
  const queueTimeoutSeconds =
    policy.queueTimeout === undefined
      ? null
      : longDuration(policy.queueTimeout, 'policy.queueTimeout', MAX_QUEUE_TIMEOUT_SECONDS);
  if (queueTimeoutSeconds !== null && queueTimeoutSeconds <= approvalTimeoutSeconds) {
    fail('policy.queueTimeout', 'must be longer than approvalTimeout');
  }
  return {
    admins: stringList(policy.admins, 'policy.admins', SLACK_USER_RE, 'Slack user IDs (U… or W…)', 1),
    gh: parseGh(policy.gh),
    cloudflare: parseCloudflare(policy.cloudflare),
    approvalTimeoutSeconds,
    maxPendingApprovals: integer(
      policy.maxPendingApprovals,
      'policy.maxPendingApprovals',
      DEFAULT_MAX_PENDING_APPROVALS,
      1,
      MAX_PENDING_APPROVALS_LIMIT,
    ),
    queueTimeoutSeconds,
    maxQueuedApprovals: integer(
      policy.maxQueuedApprovals,
      'policy.maxQueuedApprovals',
      DEFAULT_MAX_QUEUED_APPROVALS,
      1,
      MAX_QUEUED_APPROVALS_LIMIT,
    ),
    dashboardDecisionTools: parseDashboardDecisions(policy.dashboardDecisions),
  };
}

export interface LoadPolicyOptions {
  /** Owners the policy file and its directory may have. Defaults to root and this process's uid. */
  trustedUids?: readonly number[];
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Nobody but a trusted owner may be able to change what the file says. Group read is fine (0640). */
function checkWritableOnlyByOwner(where: string, stat: fs.Stats, trusted: readonly number[]): void {
  if (!trusted.includes(stat.uid)) fail(where, `is owned by uid ${stat.uid}, not root or the broker user`);
  if ((stat.mode & 0o022) !== 0) fail(where, `is group- or world-writable (mode 0${(stat.mode & 0o777).toString(8)})`);
}

export function loadPolicy(file: string, options: LoadPolicyOptions = {}): BrokerPolicy {
  const uid = process.getuid?.();
  const trusted = options.trustedUids ?? (uid === undefined ? [0] : [0, uid]);
  const dir = path.dirname(file);
  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(dir);
  } catch (err) {
    fail(dir, `cannot be inspected (${errorCode(err) ?? 'error'})`);
  }
  checkWritableOnlyByOwner(dir, dirStat, trusted);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') fail(file, 'does not exist');
    if (code === 'ELOOP') fail(file, 'is a symlink');
    fail(file, `cannot be opened (${code ?? 'error'})`);
  }
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail(file, 'is not a regular file');
    checkWritableOnlyByOwner(file, stat, trusted);
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // The parser's message quotes the input; never pass it on.
    fail(file, 'is not valid JSON');
  }
  return parsePolicy(json);
}
