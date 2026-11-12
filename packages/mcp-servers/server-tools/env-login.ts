/**
 * An environment user's web login (env-access WU3b, #1211): log in to the environment's web app with the
 * environment's own account — its password a `{"$secret": …}` in config, read by server-tools outside every model
 * sandbox — and hand back only the session (a bearer token from the JSON answer, or a session cookie).
 *
 * No password, request body or response body ever leaves this module: errors say only the host and the status.
 */

/** What `login` needs of an HTTP answer. */
export interface LoginResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Every `Set-Cookie` header of the answer. */
  setCookies(): string[];
}
export type LoginFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<LoginResponse>;

/** One account's login: where to post, what to post (secrets already resolved), where the session comes back. */
export interface WebLogin {
  url: string;
  body: Record<string, unknown>;
  /** `json:<dot.path>` — a string in the JSON answer; `cookie:<name>` — a cookie the answer sets. */
  token: string;
}

export type LoginSession = { kind: 'bearer'; token: string } | { kind: 'cookie'; cookie: string; token: string };

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

const TOKEN = /^(json:[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*|cookie:[A-Za-z0-9_.-]+)$/;
const LOGIN_TIMEOUT_MS = 30_000;

/** The login of `account` as configured, checked; throws `LoginError` naming what is wrong (never a value). */
export function loginSpec(raw: unknown, account: string): WebLogin {
  const spec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let url: URL;
  try {
    url = new URL(String(spec.url));
  } catch {
    throw new LoginError(`login ${account}: url is not a URL`);
  }
  // The password travels in the body: only over TLS.
  if (url.protocol !== 'https:') throw new LoginError(`login ${account}: url must be https`);
  if (!spec.body || typeof spec.body !== 'object' || Array.isArray(spec.body)) {
    throw new LoginError(`login ${account}: body must be an object`);
  }
  if (typeof spec.token !== 'string' || !TOKEN.test(spec.token)) {
    throw new LoginError(`login ${account}: token must be json:<path> or cookie:<name>`);
  }
  return { url: url.toString(), body: spec.body as Record<string, unknown>, token: spec.token };
}

function fromJson(json: unknown, path: string): string | undefined {
  let at: unknown = json;
  for (const key of path.split('.')) {
    if (!at || typeof at !== 'object' || !Object.keys(at).includes(key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === 'string' && at !== '' ? at : undefined;
}

function fromCookies(cookies: string[], name: string): string | undefined {
  for (const header of cookies) {
    const first = header.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq > 0 && first.slice(0, eq).trim() === name) {
      const value = first.slice(eq + 1).trim();
      if (value !== '') return value;
    }
  }
  return undefined;
}

/** Post the account and return the session. Throws `LoginError` with the host and status only. */
export async function login(fetch: LoginFetch, spec: WebLogin): Promise<LoginSession> {
  const host = new URL(spec.url).host;
  let res: LoginResponse;
  try {
    res = await fetch(spec.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'soma-work-server-tools',
      },
      body: JSON.stringify(spec.body),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LoginError(`login to ${host} got no answer (${err instanceof Error ? err.name : 'error'})`);
  }
  // Never the answer's body: a refused login may echo what was sent.
  if (!res.ok) throw new LoginError(`login to ${host} answered ${res.status}`);
  if (spec.token.startsWith('cookie:')) {
    const cookie = spec.token.slice('cookie:'.length);
    const token = fromCookies(res.setCookies(), cookie);
    if (!token) throw new LoginError(`login to ${host} set no session token (cookie ${cookie})`);
    return { kind: 'cookie', cookie, token };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const token = fromJson(json, spec.token.slice('json:'.length));
  if (!token) throw new LoginError(`login to ${host} answered no session token at ${spec.token}`);
  return { kind: 'bearer', token };
}

/** The real fetch, as `login` needs it: no redirect is followed (a session cookie comes with the first answer). */
export const defaultLoginFetch: LoginFetch = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
    setCookies: () =>
      typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [],
  };
};
