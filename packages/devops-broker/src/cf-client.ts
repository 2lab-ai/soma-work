// Cloudflare short-lived keys (.prd/16-devops-tools-architecture.md §6): per approved lease the broker mints an
// account-owned child token with the environment's forge key, relays scoped API calls with it, and deletes it
// on expiry or request — "revoked" only once a forge-key GET answers 404, never the child's own verify (R5).
// Lease key values live in broker memory and a 0600 state file; never in the lease file, the ledger, an
// error or a view.

import * as path from 'node:path';
import { type CfApiMethod, type DevopsErrorCode, MAX_LEASE_TTL_SECONDS } from '@soma/process-shared/devops/protocol.js';
import type { Ledger } from './ledger.js';
import type { BrokerPolicy, CfEnvPolicy } from './policy.js';
import { createScrubber, type Scrubber, scrub } from './scrub.js';
import { StateStore } from './state.js';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
/** Basenames under the broker's state/ directory. */
export const CF_LEASES_FILE = 'cf-leases.json';
export const CF_LEASE_TOKENS_FILE = 'cf-lease-tokens.json';
/** Every child token the broker mints is named this plus the lease id; the sweeper owns the prefix. */
export const LEASE_TOKEN_PREFIX = 'soma-lease-';
export const MIN_LEASE_TTL_SECONDS = 60;
export const DEFAULT_SWEEP_INTERVAL_MS = 300_000;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PERMISSION_GROUP_CACHE_MS = 3600 * 1000;
const LIST_PER_PAGE = 50;
const MAX_LIST_PAGES = 100;
const MAX_SCOPE_ITEMS = 20;
const MAX_PATH_LENGTH = 2048;
const MAX_QUERY_KEYS = 50;
const MAX_ERROR_LENGTH = 300;
/** Deeper responses are scrubbed as text instead of walked (a 1 MB body can nest far past the stack). */
const MAX_SCRUB_DEPTH = 256;

const LEASE_ID_RE = /^[0-9a-f]{32}$/;
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
const QUERY_KEY_RE = /^[A-Za-z0-9_.[\]-]{1,100}$/;
const CONTROL_RE = /\p{Cc}/u;
const SPACE_OR_CONTROL_RE = /[\s\p{Cc}]/u;
const PRINTABLE_RE = /^[!-~]+$/;
const METHODS: readonly CfApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const BODY_METHODS: readonly CfApiMethod[] = ['POST', 'PUT', 'PATCH'];
const FORBIDDEN_QUERY_KEYS = ['__proto__', 'constructor', 'prototype'];

export type LeaseAccess = 'read' | 'edit';
export type LeaseState = 'minting' | 'active' | 'revoking' | 'revoked' | 'revoke_failed' | 'mint_failed';

export interface LeaseScope {
  env: string;
  access: LeaseAccess;
  permissionGroupIds: string[];
  /** Empty = account level. */
  zoneIds: string[];
}

/** What the model may see: no key value, no Cloudflare token id. `zones` are zone IDs (what cf_api paths use). */
export interface LeaseView {
  leaseId: string;
  env: string;
  access: LeaseAccess;
  zones: string[];
  expiresAt: string;
  state: string;
}

export interface LeaseRecord {
  leaseId: string;
  env: string;
  access: LeaseAccess;
  permissionGroupIds: string[];
  zoneIds: string[];
  approvalId: string;
  tokenName: string;
  tokenId?: string;
  state: LeaseState;
  createdAt: string;
  notBefore: string;
  expiresAt: string;
  revokedAt?: string;
  lastError?: string;
}

/** state/cf-leases.json */
export interface CfLeaseStoreData {
  leases: Record<string, LeaseRecord>;
}

/** state/cf-lease-tokens.json (0600, like every state file): lease id -> key value. */
export interface CfLeaseTokenData {
  values: Record<string, string>;
}

export function initialCfLeaseStore(): CfLeaseStoreData {
  return { leases: {} };
}

export function initialCfLeaseTokens(): CfLeaseTokenData {
  return { values: {} };
}

/** Both lease stores under `stateDir`, loaded. */
export async function loadCfLeaseStores(
  stateDir: string,
): Promise<{ store: StateStore<CfLeaseStoreData>; tokenStore: StateStore<CfLeaseTokenData> }> {
  const store = new StateStore(path.join(stateDir, CF_LEASES_FILE), initialCfLeaseStore());
  const tokenStore = new StateStore(path.join(stateDir, CF_LEASE_TOKENS_FILE), initialCfLeaseTokens());
  await store.load();
  await tokenStore.load();
  return { store, tokenStore };
}

export type CfLeaseErrorCode = Extract<
  DevopsErrorCode,
  | 'bad-request'
  | 'policy-denied'
  | 'unknown-env'
  | 'lease-not-found'
  | 'lease-expired'
  | 'lease-out-of-scope'
  | 'upstream-error'
  | 'result-unknown'
  | 'internal'
>;

/** Messages never carry a key value; Cloudflare's own error text is scrubbed first. */
export class CfLeaseError extends Error {
  readonly code: CfLeaseErrorCode;

  constructor(code: CfLeaseErrorCode, message: string) {
    super(message);
    this.name = 'CfLeaseError';
    this.code = code;
  }
}

export interface CfApiRequest {
  method: CfApiMethod;
  /** Under the API v4 base, starting with `/`; the query goes in `query`, never in the path. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface CfApiResult {
  status: number;
  /** Parsed JSON when the scrubbed response is complete JSON, otherwise the scrubbed text. */
  body: unknown;
  /** The response passed 1 MB and was cut there. Always set here; optional so `{status, body}` fakes still fit. */
  truncated?: boolean;
}

export interface SweepResult {
  revoked: number;
  failed: number;
  orphansDeleted: number;
}

export interface CloudflareLeases {
  mint(input: { leaseId: string; scope: LeaseScope; ttlSeconds: number; approvalId: string }): Promise<LeaseView>;
  call(leaseId: string, req: CfApiRequest, caller: { sessionKey: string }): Promise<CfApiResult>;
  /** DELETE then GET must be 404, else the lease ends `revoke_failed` (returned, not thrown). */
  revoke(leaseId: string, reason: string): Promise<LeaseView>;
  sweep(): Promise<SweepResult>;
  list(): LeaseView[];
  /** id -> name via the forge key, cached per env for an hour. */
  permissionGroupNames(env: string): Promise<Record<string, string>>;
  /** Sweeps every `intervalMs` (first one after one interval); a tick while a sweep runs is skipped. Returns stop. */
  startSweeper(intervalMs?: number): () => void;
}

export interface CloudflareLeasesOptions {
  policy: BrokerPolicy;
  /** Called per operation; the result is never kept past it. */
  readForgeKey: (env: string) => string;
  /** Loaded by the caller. */
  store: StateStore<CfLeaseStoreData>;
  /** Loaded by the caller. Absent = key values in memory only: active leases stop working after a restart. */
  tokenStore?: StateStore<CfLeaseTokenData>;
  ledger: Ledger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  apiBase?: string;
  /** Called when a lease enters `revoke_failed` (not again on each failed retry). */
  onRevokeFailed?: (lease: LeaseView, error: string) => void;
  timeoutMs?: number;
}

interface Upstream {
  status: number;
  text: string;
  truncated: boolean;
}

interface ListedToken {
  id: string;
  name: string;
  expiresOn?: string;
}

function hasOwn(object: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(object, key) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 3339 UTC at second precision: `2026-10-26T12:00:00Z`. */
function rfc3339(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Error class and errno only: fetch failure messages can quote the URL. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
  const code = (err as NodeJS.ErrnoException).code ?? (err.cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? `${err.name} ${code}` : err.name;
}

function bound(text: string): string {
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

/** Cloudflare's `errors[]` as `: code message; …`, scrubbed. */
function cloudflareErrors(text: string, secrets: readonly string[]): string {
  const body = parseJson(text);
  if (!isRecord(body) || !Array.isArray(body.errors)) return '';
  const parts = body.errors.slice(0, 3).map((e) => {
    if (!isRecord(e)) return '?';
    const code = typeof e.code === 'number' || typeof e.code === 'string' ? String(e.code) : '?';
    const message = typeof e.message === 'string' ? e.message.replace(/\p{Cc}/gu, ' ').slice(0, 120) : '';
    return `${code} ${message}`.trim();
  });
  return parts.length === 0 ? '' : scrub(`: ${parts.join('; ')}`, secrets);
}

/** Every string in a parsed JSON value, object keys included, scrubbed; undefined past MAX_SCRUB_DEPTH. */
function scrubJson(value: unknown, scrubber: Scrubber, depth = 0): unknown {
  if (typeof value === 'string') return scrubber.scrub(value);
  if (!Array.isArray(value) && !isRecord(value)) return value;
  if (depth >= MAX_SCRUB_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const scrubbed = scrubJson(item, scrubber, depth + 1);
      if (scrubbed === undefined) return undefined;
      items.push(scrubbed);
    }
    return items;
  }
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    const scrubbed = scrubJson(item, scrubber, depth + 1);
    if (scrubbed === undefined) return undefined;
    entries.push([scrubber.scrub(key), scrubbed]);
  }
  // fromEntries defines own properties, so a "__proto__" key stays a key.
  return Object.fromEntries(entries);
}

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (res.body === null) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function refuse(code: CfLeaseErrorCode, message: string): never {
  throw new CfLeaseError(code, message);
}

function view(lease: LeaseRecord): LeaseView {
  return {
    leaseId: lease.leaseId,
    env: lease.env,
    access: lease.access,
    zones: [...lease.zoneIds],
    expiresAt: lease.expiresAt,
    state: lease.state,
  };
}

function idList(value: unknown, what: string, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_SCOPE_ITEMS) {
    refuse('bad-request', `${what} must hold ${min}-${MAX_SCOPE_ITEMS} IDs`);
  }
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || id.length > 100 || !PRINTABLE_RE.test(id)) {
      refuse('bad-request', `${what} must be printable IDs`);
    }
    if (seen.has(id)) refuse('bad-request', `${what} names an ID twice`);
    seen.add(id);
  }
  return [...seen];
}

/** Path → segments, or a bad-request refusal. The query never rides in the path. */
function pathSegments(p: unknown): string[] {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LENGTH) {
    refuse('bad-request', `path must be 1-${MAX_PATH_LENGTH} characters`);
  }
  if (!p.startsWith('/')) refuse('bad-request', 'path must start with /');
  if (SPACE_OR_CONTROL_RE.test(p)) refuse('bad-request', 'path must not contain whitespace or control characters');
  for (const bad of ['..', '//', '%', '\\', '?', '#']) {
    if (p.includes(bad))
      refuse('bad-request', `path must not contain ${JSON.stringify(bad)} (the query goes in query)`);
  }
  const segments = p.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || !SEGMENT_RE.test(segment)) {
      refuse('bad-request', 'path segments must be non-empty runs of A-Z a-z 0-9 . _ ~ -');
    }
  }
  return segments;
}

/** Key management, users and memberships are never reachable with a lease, whatever its scope. */
function deniedPath(segments: readonly string[]): boolean {
  const lower = segments.map((s) => s.toLowerCase());
  if (lower[0].startsWith('user')) return true;
  if (lower.length === 1 && lower[0] === 'accounts') return true;
  return lower.some((s) => s.includes('token') || s.includes('member'));
}

function queryString(query: unknown): string {
  if (query === undefined) return '';
  if (!isRecord(query)) refuse('bad-request', 'query must be an object of strings');
  const entries = Object.entries(query);
  if (entries.length > MAX_QUERY_KEYS) refuse('bad-request', `query holds more than ${MAX_QUERY_KEYS} keys`);
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (FORBIDDEN_QUERY_KEYS.includes(key) || !QUERY_KEY_RE.test(key)) {
      refuse('bad-request', 'query keys must be 1-100 characters of A-Z a-z 0-9 _ . [ ] -');
    }
    if (typeof value !== 'string' || value.length > 2048 || CONTROL_RE.test(value)) {
      refuse('bad-request', 'query values must be single-line strings of at most 2048 characters');
    }
    params.append(key, value);
  }
  return params.toString();
}

function bodyText(method: CfApiMethod, body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (!BODY_METHODS.includes(method)) refuse('bad-request', 'a body is only sent with POST, PUT or PATCH');
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    refuse('bad-request', 'body must be JSON');
  }
  if (text === undefined) refuse('bad-request', 'body must be JSON');
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BODY_BYTES) refuse('bad-request', 'body is larger than 256 KB');
  return text;
}

export function createCloudflareLeases(opts: CloudflareLeasesOptions): CloudflareLeases {
  const { policy, store, tokenStore, ledger } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const apiBase = (opts.apiBase ?? CLOUDFLARE_API_BASE).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Lease id -> key value. Loaded from the token file for leases that are still active. */
  const values = new Map<string, string>();
  const storedLeases = store.get().leases ?? {};
  for (const [leaseId, value] of Object.entries(tokenStore?.get().values ?? {})) {
    if (hasOwn(storedLeases, leaseId) && storedLeases[leaseId].state === 'active' && typeof value === 'string') {
      values.set(leaseId, value);
    }
  }
  /** Mints in flight in this process: their tokens exist before their lease is active. */
  const minting = new Set<string>();
  const revoking = new Map<string, Promise<LeaseView>>();
  const groupCache = new Map<string, { at: number; names: Record<string, string> }>();
  let sweeping: Promise<SweepResult> | null = null;

  function busy(leaseId: string): boolean {
    return minting.has(leaseId) || revoking.has(leaseId);
  }

  function getLease(leaseId: unknown): LeaseRecord | undefined {
    if (typeof leaseId !== 'string') return undefined;
    const leases = store.get().leases ?? {};
    return hasOwn(leases, leaseId) ? leases[leaseId] : undefined;
  }

  function envPolicy(env: unknown): CfEnvPolicy {
    if (typeof env !== 'string' || !hasOwn(policy.cloudflare, env)) {
      refuse('unknown-env', 'no Cloudflare environment by that name in the broker policy');
    }
    return policy.cloudflare[env];
  }

  function forgeKey(env: string): string {
    let key: unknown;
    try {
      key = opts.readForgeKey(env);
    } catch {
      refuse('internal', `the forge key for ${env} cannot be read`);
    }
    if (typeof key !== 'string' || !PRINTABLE_RE.test(key)) refuse('internal', `the forge key for ${env} is unusable`);
    return key;
  }

  async function send(method: CfApiMethod, p: string, auth: string, query = '', body?: string): Promise<Upstream> {
    const headers: Record<string, string> = { Authorization: `Bearer ${auth}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(`${apiBase}${p}${query ? `?${query}` : ''}`, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const { text, truncated } = await readCapped(res, MAX_RESPONSE_BYTES);
    return { status: res.status, text, truncated };
  }

  function setLease(leaseId: string, fn: (lease: LeaseRecord) => void): Promise<LeaseRecord> {
    return store.update((draft) => {
      const lease = draft.leases[leaseId];
      fn(lease);
      return lease;
    });
  }

  /** Forgets a key value in memory and in the token file. Best effort: the token is already gone or dead. */
  async function dropValue(leaseId: string): Promise<void> {
    values.delete(leaseId);
    if (tokenStore === undefined || !hasOwn(tokenStore.get().values ?? {}, leaseId)) return;
    await tokenStore
      .update((draft) => {
        delete draft.values[leaseId];
      })
      .catch(() => undefined);
  }

  /** For rows written after the fact: a full disk must not change an outcome that already happened. */
  async function note(row: { event: string } & Record<string, unknown>): Promise<void> {
    await ledger.append(row).catch(() => undefined);
  }

  // ── mint ────────────────────────────────────────────────

  type MintInput = { leaseId: string; scope: LeaseScope; ttlSeconds: number; approvalId: string };

  function checkMint(input: MintInput): { env: CfEnvPolicy; permissionGroupIds: string[]; zoneIds: string[] } {
    if (!isRecord(input) || !isRecord(input.scope)) {
      refuse('bad-request', 'mint needs leaseId, scope, ttlSeconds and approvalId');
    }
    const { leaseId, scope, ttlSeconds, approvalId } = input;
    if (typeof leaseId !== 'string' || !LEASE_ID_RE.test(leaseId)) {
      refuse('bad-request', 'leaseId must be 32 lowercase hex characters');
    }
    if (typeof approvalId !== 'string' || !APPROVAL_ID_RE.test(approvalId)) {
      refuse('bad-request', 'approvalId has the wrong format');
    }
    const env = envPolicy(scope.env);
    if (scope.access !== 'read' && scope.access !== 'edit') refuse('bad-request', 'access must be read or edit');
    const permissionGroupIds = idList(scope.permissionGroupIds, 'permissionGroupIds', 1);
    const allowedGroups = env.permissionGroups[scope.access];
    if (permissionGroupIds.some((id) => !allowedGroups.includes(id))) {
      refuse('lease-out-of-scope', `a permission group is not allowed for ${scope.access} leases in ${scope.env}`);
    }
    const zoneIds = idList(scope.zoneIds, 'zoneIds', 0);
    const policyZones = Object.values(env.zones);
    if (zoneIds.some((id) => !policyZones.includes(id))) {
      refuse('lease-out-of-scope', `a zone is not in the policy for ${scope.env}`);
    }
    if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds < MIN_LEASE_TTL_SECONDS) {
      refuse('bad-request', `ttlSeconds must be a whole number of at least ${MIN_LEASE_TTL_SECONDS}`);
    }
    const ceiling = Math.min(env.maxTtlSeconds, MAX_LEASE_TTL_SECONDS);
    if (ttlSeconds > ceiling)
      refuse('policy-denied', `ttl is past the ${ceiling / 60}-minute ceiling for ${scope.env}`);
    if (minting.has(leaseId) || getLease(leaseId) !== undefined) refuse('bad-request', 'leaseId is already in use');
    return { env, permissionGroupIds, zoneIds };
  }

  /** minting → mint_failed; a no-op once the lease has left minting (a mint that finished meanwhile). */
  async function failMint(leaseId: string, error: string, tokenId?: string): Promise<void> {
    const changed = await store
      .update((draft) => {
        const lease = draft.leases[leaseId];
        if (lease?.state !== 'minting') return false;
        lease.state = 'mint_failed';
        lease.lastError = bound(error);
        if (tokenId !== undefined) lease.tokenId = tokenId;
        return true;
      })
      .catch(() => true);
    if (!changed) return;
    await note({ event: 'cf-lease-mint-failed', leaseId, env: getLease(leaseId)?.env ?? null, error: bound(error) });
  }

  async function mint(input: MintInput): Promise<LeaseView> {
    const { env, permissionGroupIds, zoneIds } = checkMint(input);
    const { leaseId, scope, ttlSeconds, approvalId } = input;
    minting.add(leaseId);
    try {
      const at = now();
      const notBeforeMs = Math.floor(at / 1000) * 1000;
      const record: LeaseRecord = {
        leaseId,
        env: scope.env,
        access: scope.access,
        permissionGroupIds,
        zoneIds,
        approvalId,
        tokenName: `${LEASE_TOKEN_PREFIX}${leaseId}`,
        state: 'minting',
        createdAt: rfc3339(at),
        notBefore: rfc3339(notBeforeMs),
        expiresAt: rfc3339(notBeforeMs + ttlSeconds * 1000),
      };
      await store.update((draft) => {
        draft.leases ??= {};
        draft.leases[leaseId] = record;
      });

      let key: string;
      try {
        key = forgeKey(scope.env);
      } catch (err) {
        await failMint(leaseId, (err as Error).message);
        throw err;
      }
      const resources: Record<string, string> = {};
      if (zoneIds.length > 0) for (const id of zoneIds) resources[`com.cloudflare.api.account.zone.${id}`] = '*';
      else resources[`com.cloudflare.api.account.${env.accountId}`] = '*';
      const request = {
        name: record.tokenName,
        policies: [{ effect: 'allow', resources, permission_groups: permissionGroupIds.map((id) => ({ id })) }],
        not_before: record.notBefore,
        expires_on: record.expiresAt,
      };
      let reply: Upstream;
      try {
        reply = await send('POST', `/accounts/${env.accountId}/tokens`, key, '', JSON.stringify(request));
      } catch (err) {
        await failMint(leaseId, `token create failed (${describeError(err)})`);
        refuse('upstream-error', 'Cloudflare did not answer the token create; the sweeper removes any token it made');
      }
      const parsed = reply.truncated ? undefined : parseJson(reply.text);
      const result = isRecord(parsed) && parsed.success === true && isRecord(parsed.result) ? parsed.result : undefined;
      const tokenId = typeof result?.id === 'string' && TOKEN_ID_RE.test(result.id) ? result.id : undefined;
      const value = typeof result?.value === 'string' && PRINTABLE_RE.test(result.value) ? result.value : undefined;
      if (reply.status < 200 || reply.status > 299 || tokenId === undefined || value === undefined) {
        const why = `token create returned ${reply.status}${cloudflareErrors(reply.text, [key])}`;
        await failMint(leaseId, why, tokenId);
        refuse('upstream-error', bound(`Cloudflare refused the lease: ${why}`));
      }

      // The minted row lands before the lease turns active, so every active lease has one. A failure here
      // leaves a live token whose key is not stored: mint_failed, and the sweeper deletes it by name.
      try {
        if (tokenStore !== undefined) {
          await tokenStore.update((draft) => {
            draft.values ??= {};
            draft.values[leaseId] = value;
          });
        }
        values.set(leaseId, value);
        await ledger.append({
          event: 'cf-lease-minted',
          leaseId,
          env: scope.env,
          scope: { access: scope.access, permissionGroupIds, zoneIds },
          approvalId,
          tokenId,
          expiresAt: record.expiresAt,
        });
        const active = await setLease(leaseId, (lease) => {
          lease.state = 'active';
          lease.tokenId = tokenId;
        });
        return view(active);
      } catch (err) {
        await dropValue(leaseId);
        await failMint(leaseId, `minted key could not be recorded (${describeError(err)})`, tokenId);
        refuse('internal', 'the lease key was minted but could not be stored; the sweeper will delete it');
      }
    } finally {
      minting.delete(leaseId);
    }
  }

  // ── call ────────────────────────────────────────────────

  async function call(leaseId: string, req: CfApiRequest, caller: { sessionKey: string }): Promise<CfApiResult> {
    const sessionKey = typeof caller?.sessionKey === 'string' ? caller.sessionKey.slice(0, 256) : '';
    try {
      return await callChecked(leaseId, req, sessionKey);
    } catch (err) {
      if (err instanceof CfLeaseError && err.code !== 'result-unknown' && err.code !== 'upstream-error') {
        await note({
          event: 'cf-api-refused',
          leaseId: typeof leaseId === 'string' ? leaseId.slice(0, 64) : null,
          method: isRecord(req) && typeof req.method === 'string' ? req.method.slice(0, 16) : null,
          path: isRecord(req) && typeof req.path === 'string' ? req.path.slice(0, 256) : null,
          code: err.code,
          sessionKey,
        });
      }
      throw err;
    }
  }

  async function callChecked(leaseId: string, req: CfApiRequest, sessionKey: string): Promise<CfApiResult> {
    const lease = getLease(leaseId);
    if (lease === undefined) refuse('lease-not-found', 'no lease with that id');
    if (lease.state !== 'active') {
      refuse(
        lease.state === 'minting' || lease.state === 'mint_failed' ? 'lease-not-found' : 'lease-expired',
        `the lease is ${lease.state}`,
      );
    }
    if (now() >= Date.parse(lease.expiresAt)) {
      await revoke(lease.leaseId, 'expired').catch(() => undefined);
      refuse('lease-expired', 'the lease has expired and was revoked');
    }
    const value = values.get(lease.leaseId);
    if (value === undefined) {
      await revoke(lease.leaseId, 'key not held').catch(() => undefined);
      refuse('lease-not-found', 'this broker no longer holds the key for that lease; it was revoked');
    }
    if (!isRecord(req)) refuse('bad-request', 'request must be an object');
    const method = req.method;
    if (!METHODS.includes(method)) refuse('bad-request', `method must be one of ${METHODS.join(', ')}`);
    const segments = pathSegments(req.path);
    if (deniedPath(segments)) refuse('policy-denied', 'token, user and membership endpoints are never reachable');
    const env = envPolicy(lease.env);
    const zoneLease = lease.zoneIds.length > 0;
    const inScope = zoneLease
      ? segments[0] === 'zones' && (segments.length === 1 ? method === 'GET' : lease.zoneIds.includes(segments[1]))
      : segments[0] === 'accounts' && segments[1] === env.accountId;
    if (!inScope) {
      refuse(
        'lease-out-of-scope',
        zoneLease
          ? 'a zone lease reaches /zones/<one of its zones>/… and GET /zones only'
          : 'an account lease reaches /accounts/<its account>/… only',
      );
    }
    if (lease.access === 'read' && method !== 'GET') refuse('lease-out-of-scope', 'a read lease allows GET only');
    const query = queryString(req.query);
    const body = bodyText(method, req.body);
    const key = forgeKey(lease.env);
    const p = `/${segments.join('/')}`;
    let reply: Upstream;
    try {
      reply = await send(method, p, value, query, body);
    } catch (err) {
      const why = describeError(err);
      await note({
        event: 'cf-api',
        leaseId,
        env: lease.env,
        method,
        path: p,
        status: null,
        error: why,
        sessionKey,
      });
      if (method === 'GET') refuse('upstream-error', `Cloudflare did not answer (${why})`);
      refuse('result-unknown', `Cloudflare did not answer (${why}); the change may or may not have happened`);
    }
    // Best effort, like every row written after the fact: the request has already reached Cloudflare.
    await note({
      event: 'cf-api',
      leaseId,
      env: lease.env,
      method,
      path: p,
      status: reply.status,
      truncated: reply.truncated,
      sessionKey,
    });
    // One scrubber per response: the key patterns are compiled once, not once per JSON string.
    const scrubber = createScrubber([value, key]);
    // A cut response can end in the first characters of a key: scrubTruncated redacts that tail too.
    if (reply.truncated) return { status: reply.status, body: scrubber.scrubTruncated(reply.text), truncated: true };
    // Parsed first, so a key hidden behind JSON escapes (`\uXXXX`, `\/`) is plain text when it is scrubbed.
    const parsed = parseJson(reply.text);
    const walked = parsed === undefined ? undefined : scrubJson(parsed, scrubber);
    const scrubbed = walked === undefined ? scrubber.scrub(reply.text) : walked;
    return { status: reply.status, body: scrubbed, truncated: false };
  }

  // ── revoke ──────────────────────────────────────────────

  /** null once a forge-key GET answers 404 after the DELETE; otherwise why not. */
  async function deleteAndConfirm(envName: string, tokenId: string | undefined): Promise<string | null> {
    if (tokenId === undefined || !TOKEN_ID_RE.test(tokenId)) return 'the lease has no Cloudflare token id';
    let env: CfEnvPolicy;
    let key: string;
    try {
      env = envPolicy(envName);
      key = forgeKey(envName);
    } catch (err) {
      return (err as Error).message;
    }
    const tokenPath = `/accounts/${env.accountId}/tokens/${tokenId}`;
    try {
      const deleted = await send('DELETE', tokenPath, key);
      if (deleted.status !== 404 && (deleted.status < 200 || deleted.status > 299)) {
        return bound(`DELETE returned ${deleted.status}${cloudflareErrors(deleted.text, [key])}`);
      }
    } catch (err) {
      return `DELETE failed (${describeError(err)})`;
    }
    try {
      const got = await send('GET', tokenPath, key);
      if (got.status === 404) return null;
      return got.status >= 200 && got.status <= 299
        ? 'the token still exists after DELETE'
        : bound(`confirming GET returned ${got.status}${cloudflareErrors(got.text, [key])}`);
    } catch (err) {
      return `confirming GET failed (${describeError(err)})`;
    }
  }

  function revoke(leaseId: string, reason: string): Promise<LeaseView> {
    const running = typeof leaseId === 'string' ? revoking.get(leaseId) : undefined;
    if (running !== undefined) return running;
    const lease = getLease(leaseId);
    if (lease === undefined) return Promise.reject(new CfLeaseError('lease-not-found', 'no lease with that id'));
    const job = revokeLease(lease, typeof reason === 'string' ? reason.slice(0, 200) : '').finally(() =>
      revoking.delete(lease.leaseId),
    );
    revoking.set(lease.leaseId, job);
    return job;
  }

  async function revokeLease(lease: LeaseRecord, reason: string): Promise<LeaseView> {
    // minting / mint_failed / revoked: this lease holds no token to delete; a stray one is the sweeper's.
    if (lease.state !== 'active' && lease.state !== 'revoking' && lease.state !== 'revoke_failed') return view(lease);
    const { leaseId, env } = lease;
    const wasFailed = lease.state === 'revoke_failed';
    await setLease(leaseId, (draft) => {
      draft.state = 'revoking';
    });
    const error = await deleteAndConfirm(env, lease.tokenId);
    if (error === null) {
      const revoked = await setLease(leaseId, (draft) => {
        draft.state = 'revoked';
        draft.revokedAt = rfc3339(now());
        delete draft.lastError;
      });
      await dropValue(leaseId);
      await note({ event: 'cf-lease-revoked', leaseId, env, reason });
      return view(revoked);
    }
    const failed = await setLease(leaseId, (draft) => {
      draft.state = 'revoke_failed';
      draft.lastError = error;
    });
    await note({ event: 'cf-lease-revoke-failed', leaseId, env, reason, error });
    if (!wasFailed && opts.onRevokeFailed !== undefined) {
      try {
        opts.onRevokeFailed(view(failed), error);
      } catch {
        // The ledger row above is the record; a failing notifier must not change the outcome.
      }
    }
    return view(failed);
  }

  // ── sweep ───────────────────────────────────────────────

  async function listLeaseTokens(envName: string, accountId: string): Promise<ListedToken[]> {
    const key = forgeKey(envName);
    const found: ListedToken[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      // Expired tokens are left out of the list unless asked for — and those are the orphans that pile up.
      const query = new URLSearchParams({
        per_page: String(LIST_PER_PAGE),
        page: String(page),
        include_expired: 'true',
      }).toString();
      const reply = await send('GET', `/accounts/${accountId}/tokens`, key, query);
      const body = reply.truncated ? undefined : parseJson(reply.text);
      if (reply.status !== 200 || !isRecord(body) || !Array.isArray(body.result)) {
        refuse('upstream-error', bound(`token list returned ${reply.status}${cloudflareErrors(reply.text, [key])}`));
      }
      for (const token of body.result) {
        if (!isRecord(token) || typeof token.id !== 'string' || typeof token.name !== 'string') continue;
        if (!token.name.startsWith(LEASE_TOKEN_PREFIX)) continue;
        found.push({
          id: token.id,
          name: token.name,
          expiresOn: typeof token.expires_on === 'string' ? token.expires_on : undefined,
        });
      }
      const info = isRecord(body.result_info) ? body.result_info : {};
      const last = typeof info.total_pages === 'number' ? page >= info.total_pages : body.result.length < LIST_PER_PAGE;
      if (body.result.length === 0 || last) return found;
    }
    refuse('upstream-error', `token list has more than ${MAX_LIST_PAGES} pages`);
  }

  /** Records a deleted orphan on its lease when it was that lease's own token. */
  async function settleOrphan(leaseId: string, tokenId: string): Promise<void> {
    const lease = getLease(leaseId);
    const own = lease !== undefined && (lease.tokenId === undefined || lease.tokenId === tokenId);
    if (own && lease.state !== 'revoked') {
      await setLease(leaseId, (draft) => {
        if (draft.state !== 'mint_failed') draft.state = 'revoked';
        draft.tokenId = tokenId;
        draft.revokedAt = rfc3339(now());
      });
    }
    if (lease === undefined || own) await dropValue(leaseId);
  }

  async function runSweep(): Promise<SweepResult> {
    const counts: SweepResult = { revoked: 0, failed: 0, orphansDeleted: 0 };
    const handled = new Set<string>();
    const startedAt = now();
    for (const leaseId of Object.keys(store.get().leases ?? {})) {
      // Decided on the state as it is now: earlier iterations await, and a mint or revoke may have moved on.
      const lease = getLease(leaseId);
      if (lease === undefined || busy(leaseId)) continue;
      if (lease.state === 'minting') {
        // Not minting in this process: the broker stopped mid-mint. Its token, if any, is an orphan below.
        await failMint(leaseId, 'the broker stopped while minting');
        continue;
      }
      const due =
        (lease.state === 'active' && startedAt >= Date.parse(lease.expiresAt)) ||
        lease.state === 'revoke_failed' ||
        lease.state === 'revoking';
      if (!due) continue;
      handled.add(leaseId);
      try {
        const result = await revoke(leaseId, lease.state === 'active' ? 'expired' : 'retry');
        if (result.state === 'revoked') counts.revoked++;
        else counts.failed++;
      } catch (err) {
        // One lease's broken revoke (e.g. a state write that failed) must not stop the rest of the sweep.
        counts.failed++;
        await note({ event: 'cf-sweep-revoke-error', leaseId, error: describeError(err) });
      }
    }

    // One listing per Cloudflare account, even when several environments share it.
    const accounts = new Map<string, string>();
    for (const [name, env] of Object.entries(policy.cloudflare)) {
      if (!accounts.has(env.accountId)) accounts.set(env.accountId, name);
    }
    for (const [accountId, envName] of accounts) {
      let tokens: ListedToken[];
      try {
        tokens = await listLeaseTokens(envName, accountId);
      } catch (err) {
        counts.failed++;
        await note({
          event: 'cf-sweep-list-failed',
          env: envName,
          error: err instanceof CfLeaseError ? err.message : bound(describeError(err)),
        });
        continue;
      }
      for (const token of tokens) {
        const leaseId = token.name.slice(LEASE_TOKEN_PREFIX.length);
        if (handled.has(leaseId) || busy(leaseId)) continue;
        const lease = getLease(leaseId);
        const expired = token.expiresOn !== undefined && Date.parse(token.expiresOn) <= now();
        const orphan = lease === undefined || lease.state !== 'active' || lease.tokenId !== token.id || expired;
        if (!orphan) continue;
        const row = { leaseId: leaseId.slice(0, 64), env: envName, tokenId: token.id.slice(0, 64) };
        const error = await deleteAndConfirm(envName, token.id);
        if (error === null) {
          counts.orphansDeleted++;
          await settleOrphan(leaseId, token.id);
          await note({ event: 'cf-lease-orphan-deleted', ...row });
        } else {
          counts.failed++;
          await note({ event: 'cf-lease-orphan-delete-failed', ...row, error });
        }
      }
    }

    // A key whose lease is no longer active is of no use; drop leftovers from crashes.
    for (const leaseId of Object.keys(tokenStore?.get().values ?? {})) {
      if (!busy(leaseId) && getLease(leaseId)?.state !== 'active') await dropValue(leaseId);
    }
    if (counts.revoked + counts.failed + counts.orphansDeleted > 0) await note({ event: 'cf-sweep', ...counts });
    return counts;
  }

  function sweep(): Promise<SweepResult> {
    if (sweeping === null) {
      sweeping = runSweep().finally(() => {
        sweeping = null;
      });
    }
    return sweeping;
  }

  function startSweeper(intervalMs = DEFAULT_SWEEP_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      if (sweeping !== null) return;
      sweep().catch((err) => note({ event: 'cf-sweep-error', error: describeError(err) }));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // ── permission groups ───────────────────────────────────

  async function permissionGroupNames(envName: string): Promise<Record<string, string>> {
    const env = envPolicy(envName);
    const hit = groupCache.get(envName);
    if (hit !== undefined && now() - hit.at < PERMISSION_GROUP_CACHE_MS) return { ...hit.names };
    const key = forgeKey(envName);
    let reply: Upstream;
    try {
      reply = await send('GET', `/accounts/${env.accountId}/tokens/permission_groups`, key);
    } catch (err) {
      refuse('upstream-error', `Cloudflare did not answer the permission group list (${describeError(err)})`);
    }
    const body = reply.truncated ? undefined : parseJson(reply.text);
    if (reply.status !== 200 || !isRecord(body) || !Array.isArray(body.result)) {
      refuse(
        'upstream-error',
        bound(`permission group list returned ${reply.status}${cloudflareErrors(reply.text, [key])}`),
      );
    }
    const names: Record<string, string> = {};
    for (const group of body.result) {
      if (isRecord(group) && typeof group.id === 'string' && typeof group.name === 'string') {
        // defineProperty: an id of "__proto__" stays a plain key.
        Object.defineProperty(names, group.id, {
          value: group.name,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    groupCache.set(envName, { at: now(), names });
    return { ...names };
  }

  function list(): LeaseView[] {
    return Object.values(store.get().leases ?? {}).map(view);
  }

  return { mint, call, revoke, sweep, list, permissionGroupNames, startSweeper };
}
