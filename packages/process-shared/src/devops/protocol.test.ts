import { describe, expect, it } from 'vitest';
import {
  advanceExchange,
  type BrokerMessage,
  DEVOPS_ERROR_CODES,
  DEVOPS_TOOLS,
  type DevopsRequest,
  type ExchangeState,
  encodeMessage,
  isTerminal,
  MAX_LEASE_TTL_SECONDS,
  MAX_LINE_LENGTH,
  PROTOCOL_VERSION,
  parseBrokerMessage,
  parseJsonLine,
  parseLeaseTtlSeconds,
  parseRequest,
  splitLines,
  validateToolArgs,
} from './protocol.js';

const claimedRequester = { slackUserId: 'U0123ABCD', sessionKey: 'C0123ABCD-1700000000.000100' };
const LEASE = '0123456789abcdef0123456789abcdef';

function request(tool: string, args: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: PROTOCOL_VERSION, id: 'req-1', tool, args, claimedRequester, ...extra };
}

function expectBad(value: unknown, code: 'bad-request' | 'version-mismatch' = 'bad-request') {
  const parsed = parseRequest(value);
  expect(parsed.ok, JSON.stringify(value)).toBe(false);
  if (!parsed.ok) {
    expect(parsed.code).toBe(code);
    expect(parsed.message.length).toBeGreaterThan(0);
  }
  return parsed;
}

describe('protocol: version', () => {
  it('is a positive integer constant', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('rejects a mismatched or missing version before anything else, keeping the id for the reply', () => {
    for (const v of [0, PROTOCOL_VERSION + 1, String(PROTOCOL_VERSION), null, undefined]) {
      const parsed = expectBad({ ...request('list', {}), v }, 'version-mismatch');
      if (!parsed.ok) expect(parsed.id).toBe('req-1');
    }
    // Even an otherwise malformed request reports the version first.
    expectBad({ v: 99, tool: 'nope' }, 'version-mismatch');
    const reply = parseBrokerMessage({ v: 99, id: 'req-1', type: 'result', data: null });
    expect(reply).toMatchObject({ ok: false, code: 'version-mismatch' });
  });
});

describe('protocol: requests', () => {
  it('lists exactly the eight tools', () => {
    expect([...DEVOPS_TOOLS].sort()).toEqual(
      [
        'list',
        'gh_read',
        'gh_write',
        'gh_org_member',
        'gh_repo_access',
        'cf_lease_request',
        'cf_api',
        'cf_lease_revoke',
      ].sort(),
    );
  });

  const valid: Array<[string, unknown]> = [
    ['list', {}],
    ['gh_read', { account: 'member', args: ['pr', 'list', '-R', 'example-org/app'] }],
    ['gh_write', { account: 'org-admin', args: ['pr', 'comment', '1', '-R', 'example-org/app', '--body', 'x\ny'] }],
    ['gh_org_member', { action: 'add', user: 'alice', role: 'member' }],
    ['gh_org_member', { action: 'set-role', user: 'alice', role: 'admin' }],
    ['gh_org_member', { action: 'remove', user: 'alice' }],
    ['gh_repo_access', { action: 'grant', repo: 'example-org/app', user: 'alice', permission: 'push' }],
    ['gh_repo_access', { action: 'revoke', repo: 'example-org/app', user: 'alice' }],
    [
      'cf_lease_request',
      {
        env: 'dev2',
        access: 'read',
        permissions: ['DNS Read'],
        zones: ['example.com'],
        ttl: '1h',
        reason: 'check records',
      },
    ],
    [
      'cf_lease_request',
      { env: 'stage0', access: 'edit', permissions: ['DNS Write'], zones: [], reason: 'fix record' },
    ],
    ['cf_api', { lease: LEASE, method: 'GET', path: '/zones/abc/dns_records', query: { per_page: '50' } }],
    [
      'cf_api',
      { lease: LEASE, method: 'POST', path: '/zones/abc/dns_records', body: { type: 'A', ttl: 60, proxied: false } },
    ],
    ['cf_lease_revoke', { lease: LEASE }],
  ];

  it.each(valid)('accepts %s %j', (tool, args) => {
    const parsed = parseRequest(request(tool, args));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.tool).toBe(tool);
      expect(parsed.value.args).toEqual(args);
      expect(parsed.value.claimedRequester).toEqual(claimedRequester);
    }
  });

  const invalid: Array<[string, string, unknown]> = [
    ['unknown tool', 'gh_admin', {}],
    ['list with an argument', 'list', { x: 1 }],
    ['gh_read without account', 'gh_read', { args: ['pr', 'list'] }],
    ['gh_read account with slash', 'gh_read', { account: '../member', args: ['pr'] }],
    ['gh_read empty args', 'gh_read', { account: 'member', args: [] }],
    ['gh_read non-string arg', 'gh_read', { account: 'member', args: ['pr', 1] }],
    ['gh_read NUL in arg', 'gh_read', { account: 'member', args: ['pr\u0000'] }],
    ['gh_read too many args', 'gh_read', { account: 'member', args: Array.from({ length: 101 }, () => 'x') }],
    ['gh_write extra key', 'gh_write', { account: 'member', args: ['pr'], stdin: 'x' }],
    ['gh_org_member add without role', 'gh_org_member', { action: 'add', user: 'alice' }],
    ['gh_org_member remove with role', 'gh_org_member', { action: 'remove', user: 'alice', role: 'member' }],
    ['gh_org_member bad role', 'gh_org_member', { action: 'add', user: 'alice', role: 'owner' }],
    ['gh_org_member bad action', 'gh_org_member', { action: 'invite', user: 'alice', role: 'member' }],
    ['gh_org_member bad user', 'gh_org_member', { action: 'remove', user: 'alice/../x' }],
    [
      'gh_repo_access grant without permission',
      'gh_repo_access',
      { action: 'grant', repo: 'example-org/app', user: 'alice' },
    ],
    [
      'gh_repo_access revoke with permission',
      'gh_repo_access',
      { action: 'revoke', repo: 'example-org/app', user: 'alice', permission: 'pull' },
    ],
    [
      'gh_repo_access bad permission',
      'gh_repo_access',
      { action: 'grant', repo: 'example-org/app', user: 'alice', permission: 'write' },
    ],
    ['gh_repo_access repo without owner', 'gh_repo_access', { action: 'revoke', repo: 'app', user: 'alice' }],
    [
      'cf_lease_request ttl over 71h',
      'cf_lease_request',
      { env: 'dev2', access: 'read', permissions: ['DNS Read'], zones: [], ttl: '72h', reason: 'x' },
    ],
    [
      'cf_lease_request ttl format',
      'cf_lease_request',
      { env: 'dev2', access: 'read', permissions: ['DNS Read'], zones: [], ttl: '1d', reason: 'x' },
    ],
    [
      'cf_lease_request bad access',
      'cf_lease_request',
      { env: 'dev2', access: 'admin', permissions: ['DNS Read'], zones: [], reason: 'x' },
    ],
    [
      'cf_lease_request no permissions',
      'cf_lease_request',
      { env: 'dev2', access: 'read', permissions: [], zones: [], reason: 'x' },
    ],
    [
      'cf_lease_request bad zone',
      'cf_lease_request',
      { env: 'dev2', access: 'read', permissions: ['DNS Read'], zones: ['https://example.com'], reason: 'x' },
    ],
    [
      'cf_lease_request empty reason',
      'cf_lease_request',
      { env: 'dev2', access: 'read', permissions: ['DNS Read'], zones: [], reason: '' },
    ],
    ['cf_api bad lease', 'cf_api', { lease: 'not-a-lease', method: 'GET', path: '/zones' }],
    ['cf_api bad method', 'cf_api', { lease: LEASE, method: 'TRACE', path: '/zones' }],
    ['cf_api relative path', 'cf_api', { lease: LEASE, method: 'GET', path: 'zones' }],
    [
      'cf_api full URL path',
      'cf_api',
      { lease: LEASE, method: 'GET', path: 'https://api.cloudflare.com/client/v4/zones' },
    ],
    ['cf_api non-string query value', 'cf_api', { lease: LEASE, method: 'GET', path: '/zones', query: { page: 2 } }],
    ['cf_api non-JSON body', 'cf_api', { lease: LEASE, method: 'POST', path: '/zones', body: { n: Number.NaN } }],
    ['cf_lease_revoke extra key', 'cf_lease_revoke', { lease: LEASE, force: true }],
  ];

  it.each(invalid)('rejects %s', (_label, tool, args) => {
    expectBad(request(tool, args));
  });

  it('rejects malformed envelopes', () => {
    expectBad(null);
    expectBad([]);
    expectBad({ ...request('list', {}), extra: 1 });
    expectBad({ ...request('list', {}), id: '' });
    expectBad({ ...request('list', {}), id: 'a b' });
    expectBad({ ...request('list', {}), args: undefined });
    expectBad({ ...request('list', {}), claimedRequester: undefined });
    // The requester is a self-claimed value; the field name says so and there is no `requester` alias.
    const { claimedRequester: _omit, ...rest } = request('list', {});
    expectBad({ ...rest, requester: claimedRequester });
    expectBad({ ...request('list', {}), claimedRequester: { slackUserId: 'alice', sessionKey: 'k' } });
    expectBad({ ...request('list', {}), claimedRequester: { slackUserId: 'U0123ABCD', sessionKey: '' } });
    expectBad({ ...request('list', {}), claimedRequester: { ...claimedRequester, verified: true } });
  });

  it('validateToolArgs is the same per-tool check the request parser uses', () => {
    expect(validateToolArgs('gh_org_member', { action: 'remove', user: 'alice' })).toEqual({ ok: true });
    const bad = validateToolArgs('gh_org_member', { action: 'add', user: 'alice' });
    expect(bad.ok).toBe(false);
    expect(validateToolArgs('unknown' as never, {}).ok).toBe(false);
  });

  it('parses lease TTLs up to the 71 hour ceiling', () => {
    expect(MAX_LEASE_TTL_SECONDS).toBe(71 * 3600);
    expect(parseLeaseTtlSeconds('30m')).toBe(1800);
    expect(parseLeaseTtlSeconds('71h')).toBe(71 * 3600);
    expect(parseLeaseTtlSeconds('72h')).toBeNull();
    expect(parseLeaseTtlSeconds('4260m')).toBe(71 * 3600);
    expect(parseLeaseTtlSeconds('4261m')).toBeNull();
    expect(parseLeaseTtlSeconds('0h')).toBeNull();
    expect(parseLeaseTtlSeconds('1.5h')).toBeNull();
  });
});

describe('protocol: broker messages', () => {
  const pending = {
    v: PROTOCOL_VERSION,
    id: 'req-1',
    type: 'pending',
    approvalId: 'appr_0001',
    digestPrefix: '0123456789ab',
    expiresAt: '2026-10-26T01:02:03.000Z',
  };

  it('accepts pending with a 12-hex digest prefix and an ISO UTC expiry', () => {
    expect(parseBrokerMessage(pending)).toEqual({ ok: true, value: pending });
    expect(parseBrokerMessage({ ...pending, expiresAt: '2026-10-26T01:02:03Z' }).ok).toBe(true);
    for (const digestPrefix of ['0123456789a', '0123456789abc', '0123456789AB', 'g123456789ab']) {
      expect(parseBrokerMessage({ ...pending, digestPrefix }).ok, digestPrefix).toBe(false);
    }
    for (const expiresAt of [
      '2026-10-26 01:02:03',
      '2026-10-26T01:02:03+09:00',
      1700000000000,
      '2026-13-40T01:02:03Z',
    ]) {
      expect(parseBrokerMessage({ ...pending, expiresAt }).ok, String(expiresAt)).toBe(false);
    }
    expect(parseBrokerMessage({ ...pending, approvalId: 'x' }).ok).toBe(false);
  });

  it('accepts a result carrying any JSON value', () => {
    for (const data of [null, 1, 'x', [1, { a: true }], { exitCode: 0, stdout: 'ok\n' }]) {
      const message = { v: PROTOCOL_VERSION, id: 'req-1', type: 'result', data };
      expect(parseBrokerMessage(message)).toEqual({ ok: true, value: message });
    }
    expect(parseBrokerMessage({ v: PROTOCOL_VERSION, id: 'req-1', type: 'result' }).ok).toBe(false);
    expect(parseBrokerMessage({ v: PROTOCOL_VERSION, id: 'req-1', type: 'result', data: { x: undefined } }).ok).toBe(
      false,
    );
  });

  it('error codes form a closed set that separates not-approved, still-executing and result-unknown', () => {
    expect([...DEVOPS_ERROR_CODES].sort()).toEqual(
      [
        'not-approved',
        'still-executing',
        'result-unknown',
        'too-many-pending-approvals',
        'policy-denied',
        'bad-request',
        'unknown-account',
        'unknown-env',
        'lease-not-found',
        'lease-expired',
        'lease-out-of-scope',
        'version-mismatch',
        'upstream-error',
        'internal',
      ].sort(),
    );
    for (const code of DEVOPS_ERROR_CODES) {
      const message =
        code === 'not-approved'
          ? { v: PROTOCOL_VERSION, id: 'req-1', type: 'error', code, reason: 'expired', message: 'not approved' }
          : { v: PROTOCOL_VERSION, id: 'req-1', type: 'error', code, message: 'x' };
      expect(parseBrokerMessage(message).ok, code).toBe(true);
    }
    expect(parseBrokerMessage({ v: PROTOCOL_VERSION, id: 'req-1', type: 'error', code: 'nope', message: 'x' }).ok).toBe(
      false,
    );
  });

  it('not-approved must say denied or expired; no other code carries a reason', () => {
    const base = { v: PROTOCOL_VERSION, id: 'req-1', type: 'error', message: 'x' };
    expect(parseBrokerMessage({ ...base, code: 'not-approved', reason: 'denied' }).ok).toBe(true);
    expect(parseBrokerMessage({ ...base, code: 'not-approved' }).ok).toBe(false);
    expect(parseBrokerMessage({ ...base, code: 'not-approved', reason: 'timeout' }).ok).toBe(false);
    expect(parseBrokerMessage({ ...base, code: 'internal', reason: 'denied' }).ok).toBe(false);
  });

  it('an error for an unparseable request may carry a null id; pending and result may not', () => {
    expect(
      parseBrokerMessage({ v: PROTOCOL_VERSION, id: null, type: 'error', code: 'bad-request', message: 'x' }).ok,
    ).toBe(true);
    expect(parseBrokerMessage({ ...pending, id: null }).ok).toBe(false);
    expect(parseBrokerMessage({ v: PROTOCOL_VERSION, id: null, type: 'result', data: 1 }).ok).toBe(false);
  });

  it('rejects unknown types and unknown keys', () => {
    expect(parseBrokerMessage({ ...pending, type: 'progress' }).ok).toBe(false);
    expect(parseBrokerMessage({ ...pending, extra: 1 }).ok).toBe(false);
  });

  it('isTerminal: only result and error end an exchange', () => {
    expect(isTerminal(pending as BrokerMessage)).toBe(false);
    expect(isTerminal({ v: PROTOCOL_VERSION, id: 'a', type: 'result', data: null })).toBe(true);
    expect(isTerminal({ v: PROTOCOL_VERSION, id: 'a', type: 'error', code: 'internal', message: 'x' })).toBe(true);
  });
});

describe('protocol: exchange ordering (pending at most once, then exactly one terminal)', () => {
  const pending: BrokerMessage = {
    v: PROTOCOL_VERSION,
    id: 'req-1',
    type: 'pending',
    approvalId: 'appr_0001',
    digestPrefix: '0123456789ab',
    expiresAt: '2026-10-26T01:02:03.000Z',
  };
  const result: BrokerMessage = { v: PROTOCOL_VERSION, id: 'req-1', type: 'result', data: { ok: true } };
  const start: ExchangeState = { requestId: 'req-1', phase: 'awaiting' };

  it('awaiting -> pending -> done', () => {
    const a = advanceExchange(start, pending);
    expect(a).toEqual({ ok: true, state: { requestId: 'req-1', phase: 'pending' } });
    if (!a.ok) return;
    expect(advanceExchange(a.state, result)).toEqual({ ok: true, state: { requestId: 'req-1', phase: 'done' } });
  });

  it('awaiting -> done directly (no approval needed)', () => {
    expect(advanceExchange(start, result)).toMatchObject({ ok: true, state: { phase: 'done' } });
  });

  it('rejects a second pending, anything after the terminal message, and a foreign id', () => {
    const a = advanceExchange(start, pending);
    if (!a.ok) throw new Error('unreachable');
    expect(advanceExchange(a.state, pending).ok).toBe(false);
    expect(advanceExchange({ requestId: 'req-1', phase: 'done' }, result).ok).toBe(false);
    expect(advanceExchange(start, { ...result, id: 'req-2' }).ok).toBe(false);
    expect(
      advanceExchange(start, { v: PROTOCOL_VERSION, id: null, type: 'error', code: 'bad-request', message: 'x' }),
    ).toMatchObject({ ok: true, state: { phase: 'done' } });
  });
});

describe('protocol: newline-delimited JSON framing', () => {
  it('encodes one message per line, even when strings contain newlines', () => {
    const req = parseRequest(
      request('gh_write', { account: 'member', args: ['issue', 'comment', '1', '--body', 'a\nb\r\nc'] }),
    );
    if (!req.ok) throw new Error(req.message);
    const line = encodeMessage(req.value as DevopsRequest);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
    const back = parseJsonLine(line.slice(0, -1));
    expect(back.ok).toBe(true);
    if (back.ok) expect(parseRequest(back.value)).toEqual(req);
  });

  it('splitLines buffers partial lines across chunks', () => {
    const one = splitLines('', '{"a":1}\n{"b"');
    expect(one).toEqual({ lines: ['{"a":1}'], rest: '{"b"', overflow: false });
    const two = splitLines(one.rest, ':2}\n\n');
    expect(two).toEqual({ lines: ['{"b":2}'], rest: '', overflow: false });
  });

  it('flags a line longer than the cap instead of buffering it forever', () => {
    const huge = 'x'.repeat(MAX_LINE_LENGTH + 1);
    expect(splitLines('', huge).overflow).toBe(true);
    expect(splitLines('', `${huge}\n`).overflow).toBe(true);
    expect(splitLines(huge, '\nok\n')).toMatchObject({ lines: [huge, 'ok'], rest: '', overflow: true });
  });

  it('splitLines gives the same lines however the stream is chunked', () => {
    const text = '{"a":1}\n\n{"b":"x\\ny"}\n{"c":[1,2,3]}\npartial';
    let seed = 7;
    for (let round = 0; round < 200; round++) {
      let rest = '';
      const lines: string[] = [];
      for (let i = 0; i < text.length; ) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const size = 1 + (seed % 9);
        const out = splitLines(rest, text.slice(i, i + size));
        lines.push(...out.lines);
        rest = out.rest;
        i += size;
      }
      expect(lines).toEqual(['{"a":1}', '{"b":"x\\ny"}', '{"c":[1,2,3]}']);
      expect(rest).toBe('partial');
    }
  });

  it('splitLines is linear in the stream: a 4 MiB line in 256-character chunks is not rescanned per chunk', () => {
    const chunk = 'x'.repeat(256);
    const started = performance.now();
    let rest = '';
    let early = 0;
    for (let i = 0; i < (4 * 1024 * 1024) / 256; i++) {
      const out = splitLines(rest, chunk);
      early += out.lines.length;
      rest = out.rest;
    }
    const last = splitLines(rest, '\n');
    const elapsed = performance.now() - started;
    expect(early).toBe(0);
    expect(last.lines[0].length).toBe(4 * 1024 * 1024);
    expect(last.rest).toBe('');
    // Linear: a few ms. Re-splitting the whole buffer per chunk: ~10 s on the dev machine.
    expect(elapsed).toBeLessThan(1500);
  }, 60_000);

  it('parseJsonLine reports bad JSON as bad-request', () => {
    expect(parseJsonLine('{nope')).toMatchObject({ ok: false, code: 'bad-request' });
    expect(parseJsonLine('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('encodeMessage refuses a message that would not fit in one line', () => {
    const big: BrokerMessage = { v: PROTOCOL_VERSION, id: 'req-1', type: 'result', data: 'x'.repeat(MAX_LINE_LENGTH) };
    expect(() => encodeMessage(big)).toThrow(RangeError);
  });
});
