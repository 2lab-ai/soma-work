/**
 * An environment's Cloudflare calls (env-access WU6, #1214): the environment's own scoped API token — a
 * `{"$secret": …}` in config, read by server-tools outside every model sandbox — on the environment's own zones only.
 *
 * It replaces the broker's leases. A lease held a short-lived token minted by a token-creating key; here the scoped
 * token never leaves server-tools, and the approval is the environment's grant (or an admin) at the tool gate.
 */

export interface EnvCloudflareConfig {
  /** The environment's scoped Cloudflare API token (resolved from `{"$secret": …}`). */
  token: string;
  /** Zones this environment acts on: name → zone ID. */
  zones: Record<string, string>;
  /** Writes (POST, PUT, PATCH, DELETE) allowed. Default false: reads only. */
  write?: boolean;
  /** Zone parts reachable beyond the default list (`DEFAULT_PARTS`), e.g. `["logpush"]`. */
  parts?: string[];
}

/**
 * The zone parts `cf_api` reaches by default: DNS, settings, cache, rules, TLS, custom hostnames, firewall, workers
 * routes, load balancers, health checks, analytics. Anything else (logpush destinations, access, …) only when the
 * operator lists it in `cloudflare.parts` — an answer there may carry another system's credentials.
 */
export const DEFAULT_PARTS: readonly string[] = [
  'dns_records',
  'settings',
  'purge_cache',
  'rulesets',
  'pagerules',
  'ssl',
  'custom_hostnames',
  'firewall',
  'filters',
  'rate_limits',
  'workers',
  'load_balancers',
  // Not `healthchecks`: a check's request headers can hold an origin's credentials (review R3). List it in
  // `cloudflare.parts` to reach it.
  'analytics',
  'cache',
];

export interface CfResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type CfFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'manual' },
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
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const QUERY_KEY = /^[A-Za-z0-9_.[\]-]{1,100}$/;
const CALL_TIMEOUT_MS = 30_000;
const MAX_PATH = 512;
const MAX_BODY = 64 * 1024;
const MAX_ANSWER_CHARS = 200_000;

export function cfMethod(value: unknown): CfMethod {
  if (typeof value !== 'string' || !(METHODS as readonly string[]).includes(value)) {
    throw new CfError(`method must be one of ${METHODS.join(', ')}`);
  }
  return value as CfMethod;
}

/**
 * The path as asked, checked: `/zones/<id>[/…]` for one of the environment's zones, plain segments only. Key
 * management, users and memberships are never reachable, whatever the token's scope. Returns the zone's name.
 */
export function zonePath(config: EnvCloudflareConfig, value: unknown): { path: string; zone: string } {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH || !value.startsWith('/')) {
    throw new CfError(`path must start with / and hold at most ${MAX_PATH} characters`);
  }
  for (const bad of ['..', '//', '%', '\\', '?', '#']) {
    if (value.includes(bad))
      throw new CfError(`path must not contain ${JSON.stringify(bad)} (the query goes in query)`);
  }
  const segments = value.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || !SEGMENT.test(s))) {
    throw new CfError('path segments must be runs of A-Z a-z 0-9 . _ ~ -');
  }
  if (segments[0] !== 'zones' || segments.length < 2)
    throw new CfError("path must be /zones/<one of this environment's zones>/…");
  const zone = Object.entries(config.zones).find(([, id]) => id === segments[1]);
  if (!zone) throw new CfError(`${segments[1]} is not one of this environment's zones`);
  const lower = segments.map((s) => s.toLowerCase());
  if (lower.some((s) => s.includes('token') || s.includes('member') || s.startsWith('user'))) {
    throw new CfError('key management, users and memberships are never reachable');
  }
  const part = segments[2];
  if (part !== undefined && !DEFAULT_PARTS.includes(part) && !(config.parts ?? []).includes(part)) {
    throw new CfError(`${part} is not a part cf_api reaches (an operator can add it to cloudflare.parts)`);
  }
  return { path: value, zone: zone[0] };
}

function queryString(value: unknown): string {
  if (value === undefined) return '';
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CfError('query must be an object of strings');
  const params = new URLSearchParams();
  const entries = Object.entries(value);
  if (entries.length > 50) throw new CfError('query holds more than 50 keys');
  for (const [key, v] of entries) {
    if (!QUERY_KEY.test(key) || !['string', 'number', 'boolean'].includes(typeof v)) {
      throw new CfError(`query ${key} must be a string, number or boolean`);
    }
    params.append(key, String(v));
  }
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

/** Check a call before it is made: the method, the path, the query and the body; writes need `write`. */
export function cfRequest(config: EnvCloudflareConfig, args: Record<string, unknown>) {
  const method = cfMethod(args.method);
  const { path, zone } = zonePath(config, args.path);
  if (method !== 'GET' && config.write !== true)
    throw new CfError('this environment reads only (cloudflare.write is not true)');
  // Deleting, pausing or re-planning the zone itself is never an environment's call.
  if (method !== 'GET' && path.split('/').length < 4) throw new CfError('the zone itself is never written');
  return { method, path, zone, query: queryString(args.query), body: bodyText(method, args.body) };
}

/** Make a checked call. A write that gets no answer throws `CfOutcomeUnknownError`. */
export async function cfCall(
  fetch: CfFetch,
  config: EnvCloudflareConfig,
  request: ReturnType<typeof cfRequest>,
): Promise<{ status: number; truncated: boolean; body: unknown }> {
  let res: CfResponse;
  try {
    res = await fetch(`${API}${request.path}${request.query}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        'User-Agent': 'soma-work-server-tools',
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      // A redirect is never followed: it would carry the token somewhere the zone check never saw (review R3).
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
    throw new CfError(`Cloudflare ${request.method} ${request.path} answered ${res.status} (moved): not followed`);
  }
  let json: unknown;
  let readable = true;
  try {
    json = await res.json();
  } catch {
    json = undefined;
    readable = false;
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
        `Cloudflare ${request.method} ${request.path} answered ${res.status}: ${errorsOf(json, config.token)}`,
      );
    }
    // Done only when Cloudflare says so; a body that does not say `success: true` leaves the write unknown (review R3).
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
      `Cloudflare ${request.method} ${request.path} answered ${res.status}: ${errorsOf(json, config.token)}`,
    );
  }
  const text = scrub(JSON.stringify(json ?? null), config.token);
  return text.length > MAX_ANSWER_CHARS
    ? { status: res.status, truncated: true, body: text.slice(0, MAX_ANSWER_CHARS) }
    : { status: res.status, truncated: false, body: JSON.parse(text) };
}
