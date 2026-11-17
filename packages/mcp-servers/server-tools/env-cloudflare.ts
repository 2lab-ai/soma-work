/**
 * An environment's Cloudflare calls (env-access WU6, #1214): the environment's own Cloudflare API tokens — each a
 * `{"$secret": …}` in config, read by server-tools outside every model sandbox — on what each token's account entry
 * names. The token never leaves server-tools, and the approval is the environment's grant (or an admin) at the tool
 * gate.
 *
 * One environment can hold several Cloudflare accounts (`cloudflare.accounts`), each with its own token. An account
 * entry reaches either the zones it lists (`reach: "zones"`, the default and the original shape) or everything its
 * token can do on that account (`reach: "account"`): its `/accounts/<id>/…` paths, the zones Cloudflare says are its
 * own, every zone part. Whatever the reach, a path that would hand a model a credential to use outside server-tools
 * (API tokens, members, Access service tokens, a tunnel's token, R2 access keys, signing keys) is never reachable.
 */

import { createHash } from 'node:crypto';

/** What a Cloudflare account entry reaches. */
export type CfReach = 'zones' | 'account';

/** One Cloudflare account an environment acts on, with its own token. */
export interface CfAccountConfig {
  /** The account entry's scoped Cloudflare API token (resolved from `{"$secret": …}`). */
  token: string;
  /** The Cloudflare account ID (32 hex). Required with `reach: "account"`. */
  id?: string;
  /** Zones this entry names: name → zone ID. Required with `reach: "zones"`. */
  zones?: Record<string, string>;
  /** Writes (POST, PUT, PATCH, DELETE) allowed. Default false: reads only. */
  write?: boolean;
  /** `reach: "zones"` only: zone parts reachable beyond the default list (`DEFAULT_PARTS`), e.g. `["logpush"]`. */
  parts?: string[];
  /** Default `"zones"`. */
  reach?: CfReach;
}

/**
 * An environment's `cloudflare` section: named accounts, or — the original shape — one account's fields at the top,
 * which is the account `default`.
 */
export type EnvCloudflareConfig = CfAccountConfig | { accounts: Record<string, CfAccountConfig> };

/** The account entries of a `cloudflare` section by name; the original one-account shape is `default`. */
export function cloudflareAccounts(section: unknown): Record<string, unknown> {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return {};
  const accounts = (section as { accounts?: unknown }).accounts;
  if (accounts !== undefined) {
    return accounts && typeof accounts === 'object' && !Array.isArray(accounts)
      ? (accounts as Record<string, unknown>)
      : {};
  }
  return { default: section };
}

/**
 * The zone parts `reach: "zones"` reaches by default: DNS, settings, cache, TLS settings, rate limits, workers routes,
 * load balancers, analytics. Anything else only when the operator lists it in `parts`, because an answer there may
 * carry another system's credentials: health checks (request headers), rulesets, firewall rules, filters and page
 * rules (static header values and expressions can hold an origin's key, a forwarding URL its basic auth), custom
 * hostnames (`ssl.custom_key`, an uploaded TLS private key), logpush destinations, access. `reach: "account"` uses the
 * same zone parts.
 */
export const DEFAULT_PARTS: readonly string[] = [
  'dns_records',
  'settings',
  'purge_cache',
  'ssl',
  'rate_limits',
  'workers',
  'load_balancers',
  'analytics',
  'cache',
];

/**
 * The account parts `reach: "account"` reaches by default: what deploying and running an app on Cloudflare takes —
 * Workers (scripts, versions, deployments, secrets, routes, domains, Durable Objects), D1, KV (`storage`), R2, Pages,
 * Queues, Hyperdrive, Vectorize, Workers AI and AI Gateway, Workflows, Analytics Engine, Images, Lists (`rules`),
 * Browser Rendering. Anything else only when the operator lists it in `parts` (or `"*"` for every part), because an
 * answer there can carry another system's credential: Secondary DNS TSIG secrets, Stream live-input keys, Turnstile
 * widget secrets (`challenges`), Realtime TURN keys and app secrets (`calls`), logpush destinations, a tunnel created
 * with a chosen secret (`cfd_tunnel`), Zero Trust (`access`, `gateway`, `devices`), monitor headers
 * (`load_balancers`), mTLS certificates, billing and registrar.
 */
export const DEFAULT_ACCOUNT_PARTS: readonly string[] = [
  'workers',
  'd1',
  'storage',
  'r2',
  'pages',
  'queues',
  'hyperdrive',
  'vectorize',
  'ai',
  'ai-gateway',
  'workflows',
  'analytics_engine',
  'images',
  'rules',
  'browser-rendering',
];

/**
 * Path segments that make a credential or change who is a member, under any account or zone: API tokens (and their
 * verify and permission groups), members and memberships, Access service tokens, a tunnel's connector token, R2
 * temporary access keys, a Worker's live tail (a URL that streams its logs), Pages and Workers asset upload tokens
 * (short-lived JWTs that work outside the tool; cf_api always sends the account token, so it cannot use them itself),
 * bearer URLs: Images and Stream direct uploads (`uploadURL` uploads without the account token), Pages deploy hooks
 * (a hook ID alone triggers a deployment), Worker edge previews. Matched as whole segments, so a Worker named
 * `token-refresher` stays reachable. Even `parts: ["*"]` does not open them.
 */
const NEVER_SEGMENTS = new Set([
  'tokens',
  'token',
  'service_tokens',
  'members',
  'memberships',
  'temp-access-credentials',
  'tails',
  'upload-token',
  'assets-upload-session',
  'direct_upload',
  'deploy_hooks',
  'edge-preview',
]);

export interface CfResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** The raw answer; when present it is read instead of `json()`, so an answer that is not JSON comes back as text. */
  text?(): Promise<string>;
}
export type CfFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
    redirect?: 'manual';
  },
) => Promise<CfResponse>;

export class CfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfError';
  }
}

/** A write that got no answer: it may or may not have been made. */
export class CfOutcomeUnknownError extends CfError {
  constructor(message: string) {
    super(message);
    this.name = 'CfOutcomeUnknownError';
  }
}

const API = 'https://api.cloudflare.com/client/v4';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type CfMethod = (typeof METHODS)[number];
const BODY_METHODS: readonly CfMethod[] = ['POST', 'PUT', 'PATCH'];
/** Plain path characters; `@` for Workers AI model names (`ai/run/@cf/meta/…`), after the host so it is no userinfo. */
const SEGMENT = /^[A-Za-z0-9._~@-]+$/;
const HEX32 = /^[0-9a-f]{32}$/;
const QUERY_KEY = /^[A-Za-z0-9_.[\]-]{1,100}$/;
const FORM_NAME = /^[A-Za-z0-9_.[\]-]{1,100}$/;
/** A module name or file name; may hold `/` (`chunks/x.js`), never a dot segment, a leading or doubled `/`. */
const MODULE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/;
const moduleName = (v: unknown): v is string =>
  typeof v === 'string' && MODULE_NAME.test(v) && v.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
const MEDIA_TYPE = /^[a-z]+\/[A-Za-z0-9.+-]{1,100}$/;
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;
/**
 * Whole base64: 4-character groups, padding only at the end (Node would silently drop a dangling character). Checked
 * by length, not by a grouped pattern, which overflows the regex stack on a multi-megabyte upload.
 */
const wholeBase64 = (v: string): boolean => v.length % 4 === 0 && BASE64_CHARS.test(v);
const CALL_TIMEOUT_MS = 30_000;
const MAX_PATH = 512;
const MAX_BODY = 64 * 1024;
/** A multipart upload (a Worker's modules) is capped at Cloudflare's own Worker size limit. */
const MAX_FORM = 10 * 1024 * 1024;
const MAX_FORM_PARTS = 50;
const MAX_ANSWER_CHARS = 200_000;

export function cfMethod(value: unknown): CfMethod {
  if (typeof value !== 'string' || !(METHODS as readonly string[]).includes(value)) {
    throw new CfError(`method must be one of ${METHODS.join(', ')}`);
  }
  return value as CfMethod;
}

/** The path's segments, checked: starts with `/`, plain segments only, no dot segments, no query. */
function pathSegments(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH || !value.startsWith('/')) {
    throw new CfError(`path must start with / and hold at most ${MAX_PATH} characters`);
  }
  for (const bad of ['..', '//', '%', '\\', '?', '#']) {
    if (value.includes(bad))
      throw new CfError(`path must not contain ${JSON.stringify(bad)} (the query goes in query)`);
  }
  const segments = value.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || !SEGMENT.test(s))) {
    throw new CfError('path segments must be runs of A-Z a-z 0-9 . _ ~ @ -');
  }
  return segments;
}

/**
 * Where a checked path goes: the zone it is on (its name when listed), a zone to prove first, a query to add, and a
 * list answer to cut down to this account (`accounts`: the account itself; `zones`: its zones).
 */
interface CfTarget {
  zone?: string;
  prove?: string;
  addQuery?: Record<string, string>;
  keep?: 'accounts' | 'zones';
}

/** A part the entry reaches: a default one, one it lists, or any when it lists `"*"`. */
function reachesPart(account: CfAccountConfig, defaults: readonly string[], part: string): boolean {
  const listed = account.parts ?? [];
  return defaults.includes(part) || listed.includes(part) || listed.includes('*');
}

/**
 * `reach: "zones"` (the original rule): `/zones/<id>[/…]` for one of the entry's zones, a listed part. Key
 * management, users and memberships are never reachable, whatever the token's scope.
 */
function zonesTarget(account: CfAccountConfig, segments: string[], method: CfMethod): CfTarget {
  if (segments[0] !== 'zones' || segments.length < 2)
    throw new CfError("path must be /zones/<one of this environment's zones>/…");
  const zone = Object.entries(account.zones ?? {}).find(([, id]) => id === segments[1]);
  if (!zone) throw new CfError(`${segments[1]} is not one of this environment's zones`);
  const lower = segments.map((s) => s.toLowerCase());
  if (lower.some((s) => s.includes('token') || s.includes('member') || s.startsWith('user'))) {
    throw new CfError('key management, users and memberships are never reachable');
  }
  const part = segments[2];
  if (part !== undefined && !DEFAULT_PARTS.includes(part) && !(account.parts ?? []).includes(part)) {
    throw new CfError(`${part} is not a part cf_api reaches (an operator can add it to cloudflare.parts)`);
  }
  // Deleting, pausing or re-planning the zone itself is never an environment's call.
  if (method !== 'GET' && segments.length < 3) throw new CfError('the zone itself is never written');
  return { zone: zone[0] };
}

/** Tunnel collections: creating a tunnel answers with its connector token and credentials file. */
const TUNNEL_PARTS = new Set(['cfd_tunnel', 'tunnels', 'warp_connector']);

/**
 * A call that hands out a credential or changes who is a member: a `NEVER_SEGMENTS` segment, Stream and Images
 * signing keys (the private key comes back on creation), or creating a tunnel (`POST /accounts/<id>/cfd_tunnel`).
 */
function handsOutCredential(segments: string[], method: CfMethod): boolean {
  const lower = segments.map((s) => s.toLowerCase());
  const createsTunnel =
    method === 'POST' && lower[0] === 'accounts' && lower.length === 3 && TUNNEL_PARTS.has(lower[2]);
  return (
    createsTunnel ||
    lower.some(
      (s, i) =>
        NEVER_SEGMENTS.has(s) ||
        (s === 'keys' && (lower[i - 1] === 'stream' || (lower[i - 1] === 'v1' && lower[i - 2] === 'images'))),
    )
  );
}

/**
 * Answer fields that hold a credential, whatever the path: a tunnel's token and secret, an app's or widget's secret,
 * a TLS private key, a live input's stream key and passphrase, S3-style access keys, and bearer URLs that act
 * without the account token (an upload URL, a signed download URL, a preview exchange URL). Their values are
 * replaced, so a part an operator opened (or `"*"`) still never hands one to a model.
 */
const CREDENTIAL_FIELDS = new Set([
  'token',
  'secret',
  'client_secret',
  'tunnel_secret',
  'tunnelsecret',
  'credentials_file',
  'private_key',
  'custom_key',
  'streamkey',
  'passphrase',
  'secret_access_key',
  'uploadurl',
  'upload_url',
  'signed_url',
  'exchange_url',
]);

function redactCredentials(value: unknown, depth = 0): unknown {
  if (depth > 64 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactCredentials(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      CREDENTIAL_FIELDS.has(k.toLowerCase()) && v !== null && v !== ''
        ? [k, '[redacted]']
        : [k, redactCredentials(v, depth + 1)],
    ),
  );
}

/**
 * `reach: "account"`: `/accounts` (read), `/accounts/<this account>[/…]`, `/zones` (read, this account's), and
 * `/zones/<zone>[/…]` for a listed zone or one Cloudflare says is this account's. The account and the zone themselves
 * are never written — creating, deleting, pausing or renaming them is the account owner's call.
 */
function accountTarget(name: string, account: CfAccountConfig, segments: string[], method: CfMethod): CfTarget {
  const shape = `path must be /accounts/<account ${name}>/…, /zones or /zones/<zone of account ${name}>/…`;
  if (segments[0] !== 'accounts' && segments[0] !== 'zones') throw new CfError(shape);
  if (handsOutCredential(segments, method)) {
    throw new CfError('tokens, members, service tokens and other credentials are never reachable');
  }
  const part = segments[2];
  if (segments[0] === 'accounts') {
    if (segments.length === 1) {
      if (method !== 'GET') throw new CfError('the account list is read only');
      return { keep: 'accounts' };
    }
    if (segments[1] !== account.id) throw new CfError(`${segments[1]} is not account ${name}`);
    if (method !== 'GET' && segments.length === 2) throw new CfError('the account itself is never written');
    if (part !== undefined && !reachesPart(account, DEFAULT_ACCOUNT_PARTS, part)) {
      throw new CfError(`${part} is not an account part cf_api reaches (an operator can add it to the entry's parts)`);
    }
    return {};
  }
  if (segments.length === 1) {
    if (method !== 'GET') throw new CfError('the zone itself is never written here');
    // `match=any` would turn the account filter into "this account OR …": the filters always all hold.
    return { addQuery: { 'account.id': account.id as string, match: 'all' }, keep: 'zones' };
  }
  if (!HEX32.test(segments[1])) throw new CfError(`${segments[1]} is not a zone ID (32 hex)`);
  if (method !== 'GET' && segments.length === 2) throw new CfError('the zone itself is never written');
  if (part !== undefined && !reachesPart(account, DEFAULT_PARTS, part)) {
    throw new CfError(`${part} is not a part cf_api reaches (an operator can add it to the entry's parts)`);
  }
  const listed = Object.entries(account.zones ?? {}).find(([, id]) => id === segments[1]);
  return listed ? { zone: listed[0] } : { zone: segments[1], prove: segments[1] };
}

function queryString(value: unknown, add: Record<string, string> = {}): string {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new CfError('query must be an object of strings');
  const params = new URLSearchParams();
  const entries = Object.entries((value ?? {}) as Record<string, unknown>);
  if (entries.length > 50) throw new CfError('query holds more than 50 keys');
  for (const [key, v] of entries) {
    if (!QUERY_KEY.test(key) || !['string', 'number', 'boolean'].includes(typeof v)) {
      throw new CfError(`query ${key} must be a string, number or boolean`);
    }
    const fixed = Object.hasOwn(add, key);
    if (fixed && String(v) !== add[key]) throw new CfError(`query ${key} must be ${add[key]} here`);
    if (!fixed) params.append(key, String(v));
  }
  for (const [key, v] of Object.entries(add)) params.append(key, v);
  const s = params.toString();
  return s ? `?${s}` : '';
}

function bodyText(method: CfMethod, body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (!BODY_METHODS.includes(method)) throw new CfError('a body is only sent with POST, PUT or PATCH');
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    text = undefined;
  }
  // The cap is in bytes as sent (UTF-8), not in characters (review R3).
  if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_BODY) {
    throw new CfError(`body must be JSON of at most ${MAX_BODY} bytes`);
  }
  return text;
}

/**
 * A multipart body (a Worker upload: a `metadata` field and its module files), checked, with a SHA-256 of what is
 * sent for the audit ledger. A file is given as `text` or as `base64`, never both.
 */
function formBody(method: CfMethod, form: unknown): { data: FormData; sha256: string } | undefined {
  if (form === undefined) return undefined;
  if (!BODY_METHODS.includes(method)) throw new CfError('a form is only sent with POST, PUT or PATCH');
  if (!form || typeof form !== 'object' || Array.isArray(form)) {
    throw new CfError('form must be an object of fields and files');
  }
  const { fields = {}, files = [] } = form as { fields?: unknown; files?: unknown };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new CfError('form.fields must be an object of strings');
  }
  if (!Array.isArray(files)) throw new CfError('form.files must be a list');
  const fieldEntries = Object.entries(fields as Record<string, unknown>);
  if (fieldEntries.length + files.length === 0 || fieldEntries.length + files.length > MAX_FORM_PARTS) {
    throw new CfError(`form must hold 1 to ${MAX_FORM_PARTS} parts`);
  }
  // The whole budget is checked before any content is decoded or copied.
  let bytes = 0;
  for (const [key, value] of fieldEntries) {
    if (!FORM_NAME.test(key) || typeof value !== 'string') {
      throw new CfError(`form field ${key} must be a string under a plain name`);
    }
    bytes += Buffer.byteLength(value, 'utf8');
  }
  for (const file of files) {
    const { name, text, base64 } = (file ?? {}) as Record<string, unknown>;
    if ((text === undefined) === (base64 === undefined)) {
      throw new CfError(`form file ${String(name)}: give its content as text or base64, one of them`);
    }
    if (text !== undefined && typeof text !== 'string') {
      throw new CfError(`form file ${String(name)}: text must be a string`);
    }
    if (base64 !== undefined && (typeof base64 !== 'string' || !wholeBase64(base64))) {
      throw new CfError(`form file ${String(name)}: base64 must be whole, padded base64`);
    }
    bytes +=
      typeof text === 'string'
        ? Buffer.byteLength(text, 'utf8')
        : ((base64 as string).length / 4) * 3 - ((base64 as string).match(/=*$/)?.[0].length ?? 0);
  }
  if (bytes > MAX_FORM) throw new CfError(`form must hold at most ${MAX_FORM} bytes`);
  const data = new FormData();
  const hash = createHash('sha256');
  for (const [key, value] of fieldEntries as [string, string][]) {
    hash.update(`field ${key} ${Buffer.byteLength(value, 'utf8')}\n`).update(value);
    data.append(key, value);
  }
  for (const file of files) {
    const { name, filename, type, text, base64 } = (file ?? {}) as Record<string, unknown>;
    if (!moduleName(name)) throw new CfError('form file name must be a plain module name');
    if (!moduleName(filename)) throw new CfError(`form file ${name}: filename must be a plain file name`);
    const mediaType = type === undefined ? 'application/octet-stream' : type;
    if (typeof mediaType !== 'string' || !MEDIA_TYPE.test(mediaType)) {
      throw new CfError(`form file ${name}: type must be a media type`);
    }
    const content = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(base64 as string, 'base64');
    hash.update(`file ${name} ${filename} ${mediaType} ${content.length}\n`).update(content);
    data.append(name, new Blob([content], { type: mediaType }), filename);
  }
  return { data, sha256: hash.digest('hex') };
}

/** The token never appears in what is handed back, even if an answer echoes it. */
function scrub(text: string, token: string): string {
  return token ? text.split(token).join('[redacted]') : text;
}

function errorsOf(json: unknown, token: string): string {
  const errors = (json as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return 'no message';
  return scrub(
    errors
      .slice(0, 5)
      .map((e) => `${(e as { code?: unknown }).code ?? ''} ${(e as { message?: unknown }).message ?? ''}`.trim())
      .join('; '),
    token,
  );
}

export interface CfRequest {
  method: CfMethod;
  path: string;
  /** The account entry's name. */
  account: string;
  /** The zone the path is on: its name when the entry lists it, else its ID. */
  zone?: string;
  /** A zone not listed: Cloudflare must say it is this account's before the call. */
  prove?: string;
  /** A list answer cut down to this account before it is handed back. */
  keep?: 'accounts' | 'zones';
  query: string;
  body?: string;
  form?: FormData;
  formSha256?: string;
}

/** Check a call before it is made: the method, the path, the query and the body or form; writes need `write`. */
export function cfRequest(name: string, account: CfAccountConfig, args: Record<string, unknown>): CfRequest {
  const method = cfMethod(args.method);
  const segments = pathSegments(args.path);
  const target =
    account.reach === 'account'
      ? accountTarget(name, account, segments, method)
      : zonesTarget(account, segments, method);
  if (method !== 'GET' && account.write !== true)
    throw new CfError(`account ${name} reads only (its cloudflare entry's write is not true)`);
  if (args.body !== undefined && args.form !== undefined) throw new CfError('send either body or form, not both');
  const form = formBody(method, args.form);
  return {
    method,
    path: args.path as string,
    account: name,
    ...(target.zone ? { zone: target.zone } : {}),
    ...(target.prove ? { prove: target.prove } : {}),
    ...(target.keep ? { keep: target.keep } : {}),
    query: queryString(args.query, target.addQuery),
    body: bodyText(method, args.body),
    ...(form ? { form: form.data, formSha256: form.sha256 } : {}),
  };
}

function headers(account: CfAccountConfig, json: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${account.token}`,
    Accept: 'application/json',
    'User-Agent': 'soma-work-server-tools',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** Zones Cloudflare has said belong to an account, per fetch (one per process in production). */
const provenZones = new WeakMap<CfFetch, Set<string>>();

/**
 * A zone the entry does not list is reached only when Cloudflare, asked with the entry's own token, says the zone's
 * account is this account: one token can see several accounts, and the entry named is the account acted on.
 */
export async function cfProve(fetch: CfFetch, account: CfAccountConfig, request: CfRequest): Promise<void> {
  if (!request.prove) return;
  const zone = request.prove;
  let seen = provenZones.get(fetch);
  if (!seen) provenZones.set(fetch, (seen = new Set()));
  const key = `${account.id}/${zone}`;
  if (seen.has(key)) return;
  // Fails closed either way; a lookup that failed says so instead of claiming the zone is another account's.
  const unconfirmed = (why: string) =>
    new CfError(`could not confirm that ${zone} is a zone of account ${request.account} (${why}); nothing was sent`);
  let res: CfResponse;
  try {
    res = await fetch(`${API}/zones/${zone}`, {
      method: 'GET',
      headers: headers(account, false),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (err) {
    throw unconfirmed(`no answer: ${err instanceof Error ? err.name : 'error'}`);
  }
  if (!res.ok) throw unconfirmed(`Cloudflare answered ${res.status}`);
  let owner: unknown;
  try {
    owner = ((await res.json()) as { result?: { account?: { id?: unknown } } } | null)?.result?.account?.id;
  } catch {
    throw unconfirmed('the answer could not be read');
  }
  if (typeof owner !== 'string') throw unconfirmed('the answer names no account');
  if (owner !== account.id) throw new CfError(`${zone} is not a zone of account ${request.account}`);
  seen.add(key);
}

/**
 * A list of accounts or zones cut down to this account's: one token can see several accounts, and `GET /accounts` or
 * `GET /zones` answers with all it sees.
 */
function keepOwn(json: unknown, keep: CfRequest['keep'], id: string | undefined): unknown {
  const result = (json as { result?: unknown } | null)?.result;
  if (!keep || !Array.isArray(result)) return json;
  const own = result.filter((r) =>
    keep === 'accounts'
      ? (r as { id?: unknown } | null)?.id === id
      : (r as { account?: { id?: unknown } } | null)?.account?.id === id,
  );
  return { ...(json as Record<string, unknown>), result: own };
}

/** Make a checked call. A write that gets no answer throws `CfOutcomeUnknownError`. */
export async function cfCall(
  fetch: CfFetch,
  account: CfAccountConfig,
  request: CfRequest,
): Promise<{ status: number; truncated: boolean; body: unknown }> {
  // Proven before the audit by the caller; asked again only if it was not (a proven zone is remembered).
  await cfProve(fetch, account, request);
  const sent = request.form ?? request.body;
  let res: CfResponse;
  try {
    res = await fetch(`${API}${request.path}${request.query}`, {
      method: request.method,
      // A form sets its own multipart Content-Type (with the boundary).
      headers: headers(account, request.body !== undefined),
      ...(sent === undefined ? {} : { body: sent }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      // A redirect is never followed: it would carry the token somewhere the path check never saw (review R3).
      redirect: 'manual',
    });
  } catch (err) {
    const why = err instanceof Error ? err.name : 'error';
    if (request.method !== 'GET') {
      throw new CfOutcomeUnknownError(
        `Cloudflare ${request.method} got no answer (${why}): the write may have been made — check before retrying`,
      );
    }
    throw new CfError(`Cloudflare GET got no answer (${why})`);
  }
  if (res.status >= 300 && res.status < 400) {
    // A 303 can follow a write that was made: a moved write is unknown, a moved read failed (trinity R3, fable).
    if (request.method !== 'GET') {
      throw new CfOutcomeUnknownError(
        `Cloudflare ${request.method} ${request.path} answered ${res.status} (moved), not followed: the write may have been made — check before retrying`,
      );
    }
    throw new CfError(`Cloudflare ${request.method} ${request.path} answered ${res.status} (moved): not followed`);
  }
  let json: unknown;
  let readable = true;
  /** The raw answer when it is not JSON (a Worker's source, a log line): a read hands it back as text. */
  let raw: string | undefined;
  if (typeof res.text === 'function') {
    try {
      const answer = await res.text();
      if (answer === '') {
        readable = false;
        // An empty 2xx read is an answer (a zero-length KV value); an empty write answer stays as before.
        if (request.method === 'GET' && res.ok && res.status !== 204) raw = '';
      } else {
        try {
          json = JSON.parse(answer);
        } catch {
          raw = answer;
          readable = false;
        }
      }
    } catch {
      readable = false;
    }
  } else {
    try {
      json = await res.json();
    } catch {
      json = undefined;
      readable = false;
    }
  }
  if (res.ok && request.method === 'GET' && raw !== undefined) {
    const text = scrub(raw, account.token);
    return text.length > MAX_ANSWER_CHARS
      ? { status: res.status, truncated: true, body: text.slice(0, MAX_ANSWER_CHARS) }
      : { status: res.status, truncated: false, body: text };
  }
  // An empty 204 is an answer; any other 2xx needs a body it can read.
  if (res.ok && !readable && res.status !== 204 && request.method === 'GET') {
    throw new CfError(`Cloudflare GET ${request.path} answered ${res.status} with an unreadable body`);
  }
  // A write answered 2xx is done only when its body says so: unreadable → may have been made; `success: false` → not.
  if (res.ok && request.method !== 'GET') {
    if (!readable && res.status !== 204) {
      throw new CfOutcomeUnknownError(
        `Cloudflare ${request.method} answered ${res.status} with an unreadable body: the write may have been made — check before retrying`,
      );
    }
    const success = (json as { success?: unknown } | null)?.success;
    if (success === false) {
      throw new CfError(
        `Cloudflare ${request.method} ${request.path} answered ${res.status}: ${errorsOf(json, account.token)}`,
      );
    }
    // Done only when Cloudflare says so; a body that does not say `success: true` leaves the write unknown (review R3).
    // An empty 204 is HTTP's own "done, nothing to say" and stays done (trinity R3, astra: on purpose, tested).
    if (readable && success !== true) {
      throw new CfOutcomeUnknownError(
        `Cloudflare ${request.method} answered ${res.status} without success: true: the write may have been made — check before retrying`,
      );
    }
  }
  if (!res.ok) {
    if (request.method !== 'GET' && res.status >= 500) {
      throw new CfOutcomeUnknownError(
        `Cloudflare ${request.method} answered ${res.status}: the write may have been made — check before retrying`,
      );
    }
    throw new CfError(
      `Cloudflare ${request.method} ${request.path} answered ${res.status}: ${errorsOf(json, account.token)}`,
    );
  }
  const text = scrub(JSON.stringify(redactCredentials(keepOwn(json, request.keep, account.id)) ?? null), account.token);
  return text.length > MAX_ANSWER_CHARS
    ? { status: res.status, truncated: true, body: text.slice(0, MAX_ANSWER_CHARS) }
    : { status: res.status, truncated: false, body: JSON.parse(text) };
}
