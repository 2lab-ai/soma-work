/**
 * An environment user's web login (env-access WU3b, #1211): log in to the environment's web app with the
 * environment's own account — its password a `{"$secret": …}` in config, read by server-tools outside every model
 * sandbox — and hand back only the session (a bearer token from the JSON answer, or a session cookie).
 *
 * No password, request body or response body ever leaves this module: errors say only the host and the status.
 */

/** What `login` needs of an HTTP answer. */
export interface LoginResponse {
  status: number;
  json(): Promise<unknown>;
  /** Every `Set-Cookie` header of the answer, in order. */
  setCookies(): string[];
  /** The answer's `Location` header, if any. */
  location(): string | null;
}
export type LoginFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<LoginResponse>;

/** One account's login: where to post, what to post (secrets already resolved), where the session comes back. */
export interface WebLogin {
  url: string;
  /** `json` (default) posts the body as JSON; `form` as `application/x-www-form-urlencoded`. */
  format: 'json' | 'form';
  body: Record<string, unknown>;
  /** `json:<dot.path>` — a string in the JSON answer; `cookie:<name>` — a cookie the answer sets. */
  token: string;
  /**
   * For a `cookie:` session: the path a successful login redirects to (a refused form login often redirects back to
   * the login page, with an anonymous cookie). A redirect is taken only to it, on the login's own host.
   */
  successRedirect?: string;
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
  const format = spec.format ?? 'json';
  if (format !== 'json' && format !== 'form') throw new LoginError(`login ${account}: format must be json or form`);
  if (!spec.body || typeof spec.body !== 'object' || Array.isArray(spec.body)) {
    throw new LoginError(`login ${account}: body must be an object`);
  }
  if (format === 'form') {
    for (const [key, value] of Object.entries(spec.body)) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new LoginError(`login ${account}: form value ${key} must be a string, number or boolean`);
      }
    }
  }
  if (typeof spec.token !== 'string' || !TOKEN.test(spec.token)) {
    throw new LoginError(`login ${account}: token must be json:<path> or cookie:<name>`);
  }
  const successRedirect = spec.successRedirect;
  if (successRedirect !== undefined && (typeof successRedirect !== 'string' || !successRedirect.startsWith('/'))) {
    throw new LoginError(`login ${account}: successRedirect must be a path starting with /`);
  }
  return {
    url: url.toString(),
    format,
    body: spec.body as Record<string, unknown>,
    token: spec.token,
    ...(successRedirect !== undefined ? { successRedirect } : {}),
  };
}

function fromJson(json: unknown, path: string): string | undefined {
  let at: unknown = json;
  for (const key of path.split('.')) {
    if (!at || typeof at !== 'object' || !Object.keys(at).includes(key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === 'string' && at !== '' ? at : undefined;
}

/** A `Set-Cookie` that deletes its cookie: an empty value, `Max-Age` of zero or less, or an `Expires` already past. */
function deletes(value: string, attributes: string[], now: number): boolean {
  if (value === '') return true;
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const attribute of attributes) {
    const eq = attribute.indexOf('=');
    const key = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase();
    const raw = eq < 0 ? '' : attribute.slice(eq + 1).trim();
    if (key === 'max-age' && /^-?\d+$/.test(raw)) maxAge = Number(raw);
    if (key === 'expires' && !Number.isNaN(Date.parse(raw))) expires = Date.parse(raw);
  }
  // A valid Max-Age wins over Expires (RFC 6265 §5.3).
  if (maxAge !== undefined) return maxAge <= 0;
  return expires !== undefined && expires <= now;
}

/** The value the answer leaves for cookie `name`: the last `Set-Cookie` for it wins, and a deletion leaves none. */
function fromCookies(cookies: string[], name: string, now = Date.now()): string | undefined {
  let live: string | undefined;
  for (const header of cookies) {
    const [first = '', ...attributes] = header.split(';');
    const eq = first.indexOf('=');
    if (eq <= 0 || first.slice(0, eq).trim() !== name) continue;
    const value = first.slice(eq + 1).trim();
    live = deletes(value, attributes, now) ? undefined : value;
  }
  return live;
}

/** Why a redirect is not a successful login, or `null` when it goes where `successRedirect` says. */
function redirectProblem(spec: WebLogin, status: number, location: string | null): string | null {
  const host = new URL(spec.url).host;
  if (spec.successRedirect === undefined) {
    return `login to ${host} answered ${status}; set successRedirect to the path a successful login goes to`;
  }
  if (!location) return `login to ${host} redirected without a location`;
  let target: URL;
  try {
    target = new URL(location, spec.url);
  } catch {
    return `login to ${host} redirected to an unreadable location`;
  }
  if (target.origin !== new URL(spec.url).origin) return `login to ${host} redirected to another host`;
  // Never the location itself in the message: a refusal may carry what was sent in its path.
  const goal = spec.successRedirect;
  const loginPath = new URL(spec.url).pathname;
  const under = (path: string, root: string) =>
    path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
  // `/` names the root page only; a path under the goal counts, the login page and what is under it never do
  // (unless the login itself is at `/`, where that would refuse every redirect).
  const arrived = goal === '/' ? target.pathname === '/' : under(target.pathname, goal);
  const backToLogin = loginPath !== '/' && under(target.pathname, loginPath);
  if (!arrived || backToLogin) return `login to ${host} did not redirect to successRedirect`;
  return null;
}

function encode(spec: WebLogin): { contentType: string; body: string } {
  if (spec.format === 'json') return { contentType: 'application/json', body: JSON.stringify(spec.body) };
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(spec.body)) form.append(key, String(value));
  return { contentType: 'application/x-www-form-urlencoded', body: form.toString() };
}

/** Post the account and return the session. Throws `LoginError` with the host and status only. */
export async function login(fetch: LoginFetch, spec: WebLogin): Promise<LoginSession> {
  const host = new URL(spec.url).host;
  const { contentType, body } = encode(spec);
  let res: LoginResponse;
  try {
    res = await fetch(spec.url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Accept: 'application/json',
        'User-Agent': 'soma-work-server-tools',
      },
      body,
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LoginError(`login to ${host} got no answer (${err instanceof Error ? err.name : 'error'})`);
  }
  // A 2xx; for a cookie session also the redirect a successful form login answers with (it is not followed).
  const cookieSession = spec.token.startsWith('cookie:');
  const redirect = res.status >= 300 && res.status < 400;
  // Never the answer's body: a refused login may echo what was sent.
  if (!(res.status >= 200 && res.status < 300) && !(cookieSession && redirect)) {
    throw new LoginError(`login to ${host} answered ${res.status}`);
  }
  if (redirect) {
    const problem = redirectProblem(spec, res.status, res.location());
    if (problem) throw new LoginError(problem);
  } else if (cookieSession && spec.successRedirect !== undefined) {
    // The account says a successful login redirects: a 2xx is the login page shown again.
    throw new LoginError(`login to ${host} answered ${res.status}, not the redirect successRedirect expects`);
  }
  if (cookieSession) {
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

/** The real fetch, as `login` needs it: no redirect is followed (the session comes with the first answer). */
export const defaultLoginFetch: LoginFetch = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  return {
    status: res.status,
    location: () => res.headers.get('location'),
    json: () => res.json(),
    setCookies: () =>
      typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [],
  };
};
