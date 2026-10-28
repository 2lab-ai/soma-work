// Local stand-in for the Cloudflare API v4 in cf-client.test.ts: account-owned tokens (create, get, delete,
// paged list, permission groups) and a few zone routes a minted token can reach. Every request is recorded.
// `hook` answers a request itself (failures, slow pages, a DELETE that does not delete, a dropped connection);
// `next()` runs the default route so a hook can also wrap it. Like the real list, expired tokens are left out
// unless `include_expired=true`, and `result_info` carries page, per_page, count and total_count only.

import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_TOKEN_VALUE_PREFIX = 'fake-cf-lease-value-';

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /** The bearer value, or '' without one. */
  auth: string;
  body: unknown;
}

export interface FakeToken {
  id: string;
  name: string;
  value: string;
  status: string;
  policies: unknown;
  not_before?: string;
  expires_on?: string;
}

export interface FakeReply {
  status: number;
  body: unknown;
  /** Close the connection without an answer (the client sees a network error). */
  drop?: boolean;
}

export type FakeHook = (
  req: FakeRequest,
  next: () => FakeReply,
) => FakeReply | undefined | Promise<FakeReply | undefined>;

export interface FakeCloudflare {
  /** Pass as `apiBase`. */
  apiBase: string;
  requests: FakeRequest[];
  tokens: Map<string, FakeToken>;
  /** Every value ever issued, deleted tokens included. */
  issued: string[];
  hook: FakeHook | undefined;
  addToken(fields: { name: string } & Partial<FakeToken>): FakeToken;
  close(): Promise<void>;
}

export interface FakeCloudflareOptions {
  accountId: string;
  forgeKey: string;
  /** zone id -> zone name */
  zones: Record<string, string>;
  /** permission-group id -> name */
  permissionGroups: Record<string, string>;
  /** The clock `expires_on` is compared with (the test's injected clock). */
  now: () => number;
}

function envelope(result: unknown, extra: Record<string, unknown> = {}): unknown {
  return { success: true, errors: [], messages: [], result, ...extra };
}

function failure(code: number, message: string): unknown {
  return { success: false, errors: [{ code, message }], messages: [], result: null };
}

const UNAUTHORIZED: FakeReply = { status: 403, body: failure(9109, 'Unauthorized to access requested resource') };
const NOT_FOUND: FakeReply = { status: 404, body: failure(7003, 'Could not route to the requested resource') };

function withoutValue(token: FakeToken): Omit<FakeToken, 'value'> {
  const { value: _value, ...rest } = token;
  return rest;
}

export async function startFakeCloudflare(options: FakeCloudflareOptions): Promise<FakeCloudflare> {
  const tokens = new Map<string, FakeToken>();
  const issued: string[] = [];
  const requests: FakeRequest[] = [];
  const dnsRecords = new Map<string, unknown[]>(Object.keys(options.zones).map((id) => [id, []]));
  let serial = 0;

  function addToken(fields: { name: string } & Partial<FakeToken>): FakeToken {
    serial += 1;
    const token: FakeToken = {
      id: randomBytes(16).toString('hex'),
      value: `${FAKE_TOKEN_VALUE_PREFIX}${serial}-${randomBytes(12).toString('hex')}`,
      status: 'active',
      policies: [],
      ...fields,
    };
    tokens.set(token.id, token);
    issued.push(token.value);
    return token;
  }

  function leaseToken(auth: string): FakeToken | undefined {
    for (const token of tokens.values()) if (token.value === auth && token.status === 'active') return token;
    return undefined;
  }

  function zonesOf(token: FakeToken): string[] {
    const ids: string[] = [];
    for (const policy of token.policies as { resources: Record<string, string> }[]) {
      for (const key of Object.keys(policy.resources)) {
        const match = /^com\.cloudflare\.api\.account\.zone\.([0-9a-f]{32})$/.exec(key);
        if (match) ids.push(match[1]);
      }
    }
    return ids;
  }

  function hasAccount(token: FakeToken): boolean {
    return (token.policies as { resources: Record<string, string> }[]).some((policy) =>
      Object.hasOwn(policy.resources, `com.cloudflare.api.account.${options.accountId}`),
    );
  }

  function route(req: FakeRequest): FakeReply {
    const seg = req.path.split('/').slice(1);
    const forge = req.auth === options.forgeKey;
    if (seg[0] === 'accounts' && seg[1] === options.accountId && seg[2] === 'tokens') {
      if (!forge) return UNAUTHORIZED;
      if (seg.length === 3 && req.method === 'POST') {
        const body = req.body as Record<string, unknown>;
        if (typeof body?.name !== 'string' || !Array.isArray(body.policies)) {
          return { status: 400, body: failure(6003, 'Invalid request headers') };
        }
        const token = addToken({
          name: body.name,
          policies: body.policies,
          not_before: body.not_before as string | undefined,
          expires_on: body.expires_on as string | undefined,
        });
        return { status: 200, body: envelope({ ...withoutValue(token), value: token.value }) };
      }
      if (seg.length === 3 && req.method === 'GET') {
        const perPage = Number(req.query.per_page ?? '20');
        const page = Number(req.query.page ?? '1');
        const includeExpired = req.query.include_expired === 'true';
        const all = [...tokens.values()]
          .filter((t) => includeExpired || t.expires_on === undefined || Date.parse(t.expires_on) > options.now())
          .map(withoutValue);
        const result = all.slice((page - 1) * perPage, page * perPage);
        return {
          status: 200,
          body: envelope(result, {
            result_info: { page, per_page: perPage, count: result.length, total_count: all.length },
          }),
        };
      }
      if (seg.length === 4 && seg[3] === 'permission_groups' && req.method === 'GET') {
        return {
          status: 200,
          body: envelope(Object.entries(options.permissionGroups).map(([id, name]) => ({ id, name, scopes: [] }))),
        };
      }
      if (seg.length === 4) {
        const token = tokens.get(seg[3]);
        if (token === undefined) return { status: 404, body: failure(1003, 'Invalid API Token') };
        if (req.method === 'GET') return { status: 200, body: envelope(withoutValue(token)) };
        if (req.method === 'DELETE') {
          tokens.delete(token.id);
          return { status: 200, body: envelope({ id: token.id }) };
        }
      }
      return NOT_FOUND;
    }
    const token = leaseToken(req.auth);
    if (token === undefined) return UNAUTHORIZED;
    if (seg[0] === 'zones') {
      const allowed = zonesOf(token);
      if (seg.length === 1 && req.method === 'GET') {
        return { status: 200, body: envelope(allowed.map((id) => ({ id, name: options.zones[id] }))) };
      }
      if (!allowed.includes(seg[1])) return UNAUTHORIZED;
      const records = dnsRecords.get(seg[1]) ?? [];
      if (seg.length === 3 && seg[2] === 'dns_records' && req.method === 'GET') {
        return { status: 200, body: envelope(records) };
      }
      if (seg.length === 3 && seg[2] === 'dns_records' && req.method === 'POST') {
        const record = { id: randomBytes(16).toString('hex'), ...(req.body as object) };
        records.push(record);
        return { status: 200, body: envelope(record) };
      }
      return NOT_FOUND;
    }
    if (seg[0] === 'accounts' && seg[1] === options.accountId && hasAccount(token)) {
      return { status: 200, body: envelope({ path: req.path }) };
    }
    return UNAUTHORIZED;
  }

  const server = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const url = new URL(incoming.url ?? '/', 'http://fake.invalid');
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const auth = /^Bearer (.*)$/.exec(incoming.headers.authorization ?? '')?.[1] ?? '';
      const req: FakeRequest = {
        method: incoming.method ?? 'GET',
        path: url.pathname.replace(/^\/client\/v4/, ''),
        query: Object.fromEntries(url.searchParams),
        auth,
        body,
      };
      requests.push(req);
      Promise.resolve(fake.hook ? fake.hook(req, () => route(req)) : undefined)
        .then((hooked) => hooked ?? route(req))
        .then((reply) => {
          if (reply.drop) {
            incoming.socket.destroy();
            return;
          }
          const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
          outgoing.writeHead(reply.status, { 'content-type': 'application/json' });
          outgoing.end(payload);
        })
        .catch(() => {
          outgoing.writeHead(500);
          outgoing.end();
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeCloudflare = {
    apiBase: `http://127.0.0.1:${port}/client/v4`,
    requests,
    tokens,
    issued,
    hook: undefined,
    addToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return fake;
}
