import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BROKER_SOCKET_ENV,
  DEVOPS_TOOLS,
  MAX_LINE_LENGTH,
  PROTOCOL_VERSION,
  parseRequest,
  validateToolArgs,
} from '@soma/process-shared/devops/protocol.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callBroker,
  DEVOPS_TOOL_DEFINITIONS,
  DevopsToolsMCPServer,
  formatOutcome,
  MAX_WAIT_MS,
  PENDING_GRACE_MS,
  readRequesterClaim,
  runDevopsTool,
  sessionKeyFor,
} from './devops-tools-mcp-server.js';

// ── Fake broker on a temp unix socket ─────────────────────

const SLACK_CONTEXT = JSON.stringify({ channel: 'C000CHAN', threadTs: '1700000000.000100', user: 'U000ALICE' });
const ENV = { SLACK_CONTEXT };
/** Retry guidance: only a broker `not-approved` terminal may carry it. */
const RETRY_GUIDANCE = '승인되지 않음 — 다시 요청 가능';
const RETRY_WORDS = ['승인되지 않음', '다시 요청 가능'];
const UNCONFIRMED_TEXT =
  '결과 확인 안 됨 — 승인·실행됐을 수 있음. 같은 작업을 다시 요청하기 전에 상태를 먼저 확인할 것';
const GH_WRITE_ARGS = {
  account: 'member',
  args: ['issue', 'comment', '12', '--repo', 'example-org/app', '--body', 'hi'],
};

const tmpDirs: string[] = [];
const servers: net.Server[] = [];
const peers: net.Socket[] = [];

afterEach(async () => {
  for (const socket of peers.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tmpDirs.splice(0)) {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvt-'));
  tmpDirs.push(dir);
  return path.join(dir, 'b.sock');
}

interface FakeBroker {
  socketPath: string;
  requests: string[];
  connections: number;
  /** Resolves when the client side of the first connection is gone. */
  peerClosed: Promise<void>;
}

type Reply = (request: { id: string } & Record<string, unknown>, socket: net.Socket) => void;

async function fakeBroker(reply: Reply): Promise<FakeBroker> {
  const socketPath = tmpSocketPath();
  let markClosed: () => void = () => {};
  const broker: FakeBroker = {
    socketPath,
    requests: [],
    connections: 0,
    peerClosed: new Promise<void>((resolve) => {
      markClosed = resolve;
    }),
  };
  const server = net.createServer((socket) => {
    broker.connections++;
    peers.push(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => markClosed());
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf('\n');
      if (end < 0) return;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      broker.requests.push(line);
      reply(JSON.parse(line), socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return broker;
}

function send(socket: net.Socket, ...messages: unknown[]): void {
  socket.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(''));
}

const pending = (id: string, expiresAt: string) => ({
  v: PROTOCOL_VERSION,
  id,
  type: 'pending',
  approvalId: 'appr-0001',
  digestPrefix: '0123456789ab',
  expiresAt,
});
const result = (id: string, data: unknown) => ({ v: PROTOCOL_VERSION, id, type: 'result', data });
const error = (id: string | null, code: string, message: string, extra: Record<string, unknown> = {}) => ({
  v: PROTOCOL_VERSION,
  id,
  type: 'error',
  code,
  message,
  ...extra,
});

function textOf(toolResult: { content: Array<{ type: string; text?: string }> }): string {
  const first = toolResult.content[0];
  return first?.type === 'text' ? (first.text ?? '') : '';
}

/** A local timeout after `pending`: the broker's own answer was lost, so the action may have run. */
function expectUnconfirmedAfterPending(text: string): void {
  expect(text).toContain(`${UNCONFIRMED_TEXT} (approval appr-0001, card 0123456789ab)`);
  expect(text).toContain('Outcome unknown');
  expect(text).toContain('Check the current state before requesting the same action again');
  for (const word of RETRY_WORDS) expect(text).not.toContain(word);
}

// ── Tool table ────────────────────────────────────────────

const VALID_ARGS: Record<(typeof DEVOPS_TOOLS)[number], Record<string, unknown>[]> = {
  list: [{}],
  gh_read: [{ account: 'member', args: ['pr', 'view', '12', '--repo', 'example-org/app'] }],
  gh_write: [GH_WRITE_ARGS],
  gh_org_member: [
    { action: 'add', user: 'alice', role: 'member' },
    { action: 'remove', user: 'alice' },
  ],
  gh_repo_access: [
    { action: 'grant', repo: 'example-org/app', user: 'alice', permission: 'push' },
    { action: 'revoke', repo: 'example-org/app', user: 'alice' },
  ],
  cf_lease_request: [
    {
      env: 'dev2',
      access: 'edit',
      permissions: ['DNS Write'],
      zones: ['example.com'],
      ttl: '1h',
      reason: 'add a record',
    },
  ],
  cf_api: [
    {
      lease: '0123456789abcdef0123456789abcdef',
      method: 'POST',
      path: '/zones/0000/dns_records',
      query: { page: '1' },
      body: { type: 'A' },
    },
  ],
  cf_lease_revoke: [{ lease: '0123456789abcdef0123456789abcdef' }],
};

describe('tool table', () => {
  it('defines exactly the eight protocol tools, each with a closed object schema', () => {
    expect(DEVOPS_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...DEVOPS_TOOLS]);
    for (const tool of DEVOPS_TOOL_DEFINITIONS) {
      const schema = tool.inputSchema as {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.type, tool.name).toBe('object');
      expect(schema.additionalProperties, tool.name).toBe(false);
      for (const key of schema.required) expect(Object.keys(schema.properties), tool.name).toContain(key);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });

  it('describes every key a valid protocol argument object uses, and requires no key it may omit', () => {
    for (const tool of DEVOPS_TOOL_DEFINITIONS) {
      const name = tool.name as (typeof DEVOPS_TOOLS)[number];
      const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
      for (const args of VALID_ARGS[name]) {
        expect(validateToolArgs(name, args), `${name} example`).toEqual({ ok: true });
        for (const key of Object.keys(args)) expect(Object.keys(schema.properties), name).toContain(key);
        for (const key of schema.required) expect(Object.keys(args), name).toContain(key);
      }
    }
  });

  it('mirrors the protocol enums', () => {
    const props = (name: string) =>
      (
        DEVOPS_TOOL_DEFINITIONS.find((tool) => tool.name === name)?.inputSchema as {
          properties: Record<string, { enum?: string[] }>;
        }
      ).properties;
    expect(props('gh_org_member').action.enum).toEqual(['add', 'set-role', 'remove']);
    expect(props('gh_org_member').role.enum).toEqual(['member', 'admin']);
    expect(props('gh_repo_access').action.enum).toEqual(['grant', 'revoke']);
    expect(props('gh_repo_access').permission.enum).toEqual(['pull', 'triage', 'push', 'maintain', 'admin']);
    expect(props('cf_lease_request').access.enum).toEqual(['read', 'edit']);
    expect(props('cf_api').method.enum).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });

  it('tells the model which calls wait for an admin ✅, to use the structured gh tools, and never to ask for tokens', () => {
    const description = (name: string) => DEVOPS_TOOL_DEFINITIONS.find((tool) => tool.name === name)?.description ?? '';
    for (const name of ['gh_write', 'gh_org_member', 'gh_repo_access', 'cf_lease_request']) {
      expect(description(name), name).toContain('✅');
      expect(description(name), name).toContain('5 minutes');
    }
    for (const name of ['list', 'gh_read', 'cf_api', 'cf_lease_revoke'])
      expect(description(name), name).not.toContain('✅');
    for (const name of ['gh_read', 'gh_write']) {
      expect(description(name), name).toContain('gh_org_member');
      expect(description(name), name).toContain('gh_repo_access');
      expect(description(name), name).toContain('gh api');
    }
    for (const tool of DEVOPS_TOOL_DEFINITIONS)
      expect(tool.description, tool.name).toContain('Never ask users for tokens');
  });

  it('is what the server lists', () => {
    expect(new DevopsToolsMCPServer({ env: ENV }).defineTools()).toEqual(DEVOPS_TOOL_DEFINITIONS);
  });
});

// ── Requester claim ───────────────────────────────────────

describe('requester claim', () => {
  it('takes the Slack user and derives the session key from channel and thread', () => {
    expect(readRequesterClaim(ENV)).toEqual({
      ok: true,
      claim: { slackUserId: 'U000ALICE', sessionKey: 'work:C000CHAN:1700000000.000100' },
    });
  });

  it('uses the direct thread segment when the context has no thread', () => {
    const env = { SLACK_CONTEXT: JSON.stringify({ channel: 'D000DM', user: 'U000ALICE' }) };
    expect(readRequesterClaim(env)).toEqual({
      ok: true,
      claim: { slackUserId: 'U000ALICE', sessionKey: 'work:D000DM:direct' },
    });
    expect(sessionKeyFor('C000CHAN', '')).toBe('work:C000CHAN:direct');
  });

  it.each([
    ['unset', {}],
    ['not JSON', { SLACK_CONTEXT: '{' }],
    ['no user', { SLACK_CONTEXT: JSON.stringify({ channel: 'C000CHAN' }) }],
    ['no channel', { SLACK_CONTEXT: JSON.stringify({ user: 'U000ALICE' }) }],
  ])('refuses a SLACK_CONTEXT that is %s', (_label, env) => {
    const claim = readRequesterClaim(env);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.message).toContain('SLACK_CONTEXT');
  });
});

// ── Local rejection: nothing reaches the broker ───────────

describe('local rejection', () => {
  it.each([
    ['empty gh argv', 'gh_read', { account: 'member', args: [] }],
    ['unknown key', 'cf_lease_revoke', { lease: '0123456789abcdef0123456789abcdef', extra: 1 }],
    ['role on remove', 'gh_org_member', { action: 'remove', user: 'alice', role: 'admin' }],
    ['ttl over the ceiling', 'cf_lease_request', { ...VALID_ARGS.cf_lease_request[0], ttl: '72h' }],
  ])('rejects %s before connecting', async (_label, tool, args) => {
    const broker = await fakeBroker(() => {});
    const out = await runDevopsTool(tool, args, { env: ENV, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(new RegExp(`^error bad-request: ${tool}: `));
    expect(broker.connections).toBe(0);
  });

  it('rejects an unknown tool before connecting', async () => {
    const broker = await fakeBroker(() => {});
    const out = await runDevopsTool('gh_admin', {}, { env: ENV, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('unknown tool');
    expect(broker.connections).toBe(0);
  });

  it('refuses without a Slack requester, before connecting', async () => {
    const broker = await fakeBroker(() => {});
    const out = await runDevopsTool('list', {}, { env: {}, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('SLACK_CONTEXT');
    expect(broker.connections).toBe(0);
  });

  it('refuses a requester id the broker would reject, before connecting', async () => {
    const broker = await fakeBroker(() => {});
    const env = { SLACK_CONTEXT: JSON.stringify({ channel: 'C000CHAN', user: 'alice' }) };
    const out = await runDevopsTool('list', {}, { env, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/^error bad-request: claimedRequester\.slackUserId/);
    expect(broker.connections).toBe(0);
  });
});

// ── Broker unreachable ────────────────────────────────────

describe('broker unreachable', () => {
  it('reports a missing socket immediately', async () => {
    const socketPath = tmpSocketPath();
    const started = Date.now();
    const out = await runDevopsTool('list', {}, { env: ENV, socketPath });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/^devops broker is not reachable \(ENOENT /);
    expect(textOf(out)).toContain(socketPath);
  });

  it('reports a stale socket (nothing listening) as refused', async () => {
    const socketPath = tmpSocketPath();
    const child = spawn(process.execPath, [
      '-e',
      'require("net").createServer().listen(process.argv[1], () => console.log("up"))',
      socketPath,
    ]);
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(fs.existsSync(socketPath)).toBe(true);
    const out = await runDevopsTool('list', {}, { env: ENV, socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/^devops broker is not reachable \(ECONNREFUSED /);
  });

  it.skipIf(process.getuid?.() === 0)('reports a socket the bot user may not open as access denied', async () => {
    const broker = await fakeBroker(() => {});
    fs.chmodSync(broker.socketPath, 0o000);
    const out = await runDevopsTool('list', {}, { env: ENV, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/^devops broker is not reachable \(EACCES /);
    expect(broker.connections).toBe(0);
  });

  it('reports a path that is not a socket', async () => {
    const socketPath = tmpSocketPath();
    fs.writeFileSync(socketPath, '');
    const out = await runDevopsTool('list', {}, { env: ENV, socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/^devops broker is not reachable \((ENOTSOCK|ECONNREFUSED) /);
  });
});

// ── Exchange ──────────────────────────────────────────────

describe('exchange', () => {
  it('sends one request line carrying the Slack claim and nothing secret', async () => {
    const broker = await fakeBroker((request, socket) => send(socket, result(request.id, { ok: true })));
    const env = {
      ...ENV,
      SLACK_BOT_TOKEN: 'xoxb-placeholder-not-a-token',
      GITHUB_TOKEN: 'ghp_placeholder_not_a_token',
      GH_TOKEN: 'gho_placeholder_not_a_token',
    };
    await runDevopsTool('gh_write', GH_WRITE_ARGS, { env, socketPath: broker.socketPath });
    expect(broker.requests).toHaveLength(1);
    const line = broker.requests[0];
    const request = JSON.parse(line);
    expect(Object.keys(request).sort()).toEqual(['args', 'claimedRequester', 'id', 'tool', 'v']);
    expect(request.v).toBe(PROTOCOL_VERSION);
    expect(request.tool).toBe('gh_write');
    expect(request.args).toEqual(GH_WRITE_ARGS);
    expect(request.claimedRequester).toEqual({
      slackUserId: 'U000ALICE',
      sessionKey: 'work:C000CHAN:1700000000.000100',
    });
    expect(parseRequest(request).ok).toBe(true);
    for (const secret of ['xoxb-', 'ghp_', 'gho_', 'placeholder']) expect(line).not.toContain(secret);
  });

  it('sends {} for list when the client omits arguments', async () => {
    const broker = await fakeBroker((request, socket) => send(socket, result(request.id, [])));
    await runDevopsTool('list', undefined, { env: ENV, socketPath: broker.socketPath });
    expect(JSON.parse(broker.requests[0]).args).toEqual({});
  });

  it('reads the socket path from SOMA_DEVOPS_BROKER_SOCKET', async () => {
    const broker = await fakeBroker((request, socket) => send(socket, result(request.id, { accounts: [] })));
    const out = await runDevopsTool('list', {}, { env: { ...ENV, [BROKER_SOCKET_ENV]: broker.socketPath } });
    expect(textOf(out)).toBe('{"accounts":[]}');
  });

  it('returns the result data to the model as compact JSON', async () => {
    const data = { accounts: [{ name: 'member', class: 'member' }], envs: ['dev2'], leases: [] };
    const broker = await fakeBroker((request, socket) => send(socket, result(request.id, data)));
    const out = await runDevopsTool('list', {}, { env: ENV, socketPath: broker.socketPath });
    expect(out.isError).toBeFalsy();
    expect(textOf(out)).toBe(JSON.stringify(data));
  });

  it('waits through pending for the result and reports the pending message', async () => {
    const broker = await fakeBroker((request, socket) => {
      send(socket, pending(request.id, new Date(Date.now() + 60_000).toISOString()));
      setTimeout(() => send(socket, result(request.id, { merged: true })), 50);
    });
    const onPending = vi.fn();
    const out = await runDevopsTool('gh_write', GH_WRITE_ARGS, { env: ENV, socketPath: broker.socketPath, onPending });
    expect(out.isError).toBeFalsy();
    expect(textOf(out)).toBe('{"merged":true}');
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(onPending.mock.calls[0][0]).toMatchObject({ type: 'pending', approvalId: 'appr-0001' });
  });

  it('gives up after expiresAt plus grace without the broker’s answer: unconfirmed, no retry guidance', async () => {
    const broker = await fakeBroker((request, socket) =>
      send(socket, pending(request.id, new Date(Date.now() + 100).toISOString())),
    );
    const started = Date.now();
    const out = await runDevopsTool('gh_write', GH_WRITE_ARGS, {
      env: ENV,
      socketPath: broker.socketPath,
      graceMs: 100,
      maxWaitMs: 10_000,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2000);
    expect(out.isError).toBe(true);
    expectUnconfirmedAfterPending(textOf(out));
    await broker.peerClosed;
  });

  it('never waits past the total ceiling even when expiresAt is later', async () => {
    const broker = await fakeBroker((request, socket) =>
      send(socket, pending(request.id, new Date(Date.now() + 3_600_000).toISOString())),
    );
    const started = Date.now();
    const out = await runDevopsTool('gh_write', GH_WRITE_ARGS, {
      env: ENV,
      socketPath: broker.socketPath,
      maxWaitMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expectUnconfirmedAfterPending(textOf(out));
    await broker.peerClosed;
  });

  it('does not call a silent broker (no pending) a missing approval: the outcome is unknown', async () => {
    const broker = await fakeBroker(() => {});
    const out = await runDevopsTool('cf_api', VALID_ARGS.cf_api[0], {
      env: ENV,
      socketPath: broker.socketPath,
      maxWaitMs: 200,
    });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('did not answer');
    expect(textOf(out)).toContain('outcome is unknown');
    for (const word of RETRY_WORDS) expect(textOf(out)).not.toContain(word);
    await broker.peerClosed;
  });

  it.each([
    'policy-denied',
    'bad-request',
    'unknown-account',
    'unknown-env',
    'lease-not-found',
    'lease-expired',
    'lease-out-of-scope',
    'too-many-pending-approvals',
    'still-executing',
    'result-unknown',
    'upstream-error',
    'internal',
  ])('passes broker error %s through as "error <code>: <message>"', async (code) => {
    const broker = await fakeBroker((request, socket) => send(socket, error(request.id, code, `broker says ${code}`)));
    const out = await runDevopsTool('gh_read', VALID_ARGS.gh_read[0], { env: ENV, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(`error ${code}: broker says ${code}`);
  });

  it.each([
    'denied',
    'expired',
  ])('passes not-approved (%s) through with its reason, the only outcome that carries retry guidance', async (reason) => {
    const broker = await fakeBroker((request, socket) => {
      send(socket, pending(request.id, new Date(Date.now() + 60_000).toISOString()));
      send(socket, error(request.id, 'not-approved', 'no admin approval', { reason }));
    });
    const out = await runDevopsTool('gh_write', GH_WRITE_ARGS, { env: ENV, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    const [first, second] = textOf(out).split('\n');
    expect(first).toBe(`error not-approved (${reason}): no admin approval`);
    expect(second).toContain(RETRY_GUIDANCE);
  });

  it.each([
    'still-executing',
    'result-unknown',
    'internal',
  ])('gives no retry guidance with broker error %s', async (code) => {
    const broker = await fakeBroker((request, socket) => send(socket, error(request.id, code, 'x')));
    const out = await runDevopsTool('gh_write', GH_WRITE_ARGS, { env: ENV, socketPath: broker.socketPath });
    for (const word of RETRY_WORDS) expect(textOf(out)).not.toContain(word);
  });

  it('delivers the first terminal and forwards nothing the broker writes after it in a later read', async () => {
    const broker = await fakeBroker((request, socket) => {
      send(socket, result(request.id, 'FIRST-RESULT'));
      setTimeout(() => {
        if (!socket.destroyed) send(socket, result(request.id, 'SECOND-RESULT'), error(request.id, 'internal', 'LATE'));
      }, 50);
    });
    const out = await runDevopsTool('gh_read', VALID_ARGS.gh_read[0], { env: ENV, socketPath: broker.socketPath });
    await broker.peerClosed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(out.isError).toBeFalsy();
    expect(out.content).toEqual([{ type: 'text', text: '"FIRST-RESULT"' }]);
  });

  it('accepts an error the broker could not tie to a request id', async () => {
    const broker = await fakeBroker((_request, socket) =>
      send(socket, error(null, 'bad-request', 'line is not valid JSON')),
    );
    const out = await runDevopsTool('list', {}, { env: ENV, socketPath: broker.socketPath });
    expect(textOf(out)).toBe('error bad-request: line is not valid JSON');
  });
});

// ── Version mismatch and malformed broker output ──────────

describe('version mismatch', () => {
  it('explains a broker that speaks another protocol version', async () => {
    const broker = await fakeBroker((request, socket) => send(socket, { ...result(request.id, {}), v: 2 }));
    const out = await runDevopsTool('list', {}, { env: ENV, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/^error version-mismatch: /);
    expect(textOf(out)).toContain('deployed together');
    await broker.peerClosed;
  });

  it('explains a broker that rejected this server’s protocol version', async () => {
    const broker = await fakeBroker((request, socket) =>
      send(socket, error(request.id, 'version-mismatch', 'protocol version 1 is not 2')),
    );
    const out = await runDevopsTool('list', {}, { env: ENV, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/^error version-mismatch: protocol version 1 is not 2/);
    expect(textOf(out)).toContain('deployed together');
  });
});

describe('malformed broker output', () => {
  async function expectProtocolError(reply: Reply, detail: RegExp, absent?: string): Promise<void> {
    const broker = await fakeBroker(reply);
    const out = await runDevopsTool('gh_write', GH_WRITE_ARGS, { env: ENV, socketPath: broker.socketPath });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/^devops broker protocol error \(/);
    expect(textOf(out)).toMatch(detail);
    expect(textOf(out)).toContain('outcome is unknown');
    if (absent !== undefined) expect(textOf(out)).not.toContain(absent);
    await broker.peerClosed;
  }

  it('rejects a line that is not JSON without echoing it', async () => {
    await expectProtocolError(
      (_request, socket) => socket.write('not json RAW-BROKER-BYTES\n'),
      /not valid JSON/,
      'RAW',
    );
  });

  it('rejects a message that fails the schema', async () => {
    await expectProtocolError(
      (request, socket) => send(socket, { v: PROTOCOL_VERSION, id: request.id, type: 'result' }),
      /missing data/,
    );
  });

  it('rejects two terminal messages and returns neither', async () => {
    await expectProtocolError(
      (request, socket) => send(socket, result(request.id, 'FIRST-RESULT'), result(request.id, 'SECOND-RESULT')),
      /after the exchange ended/,
      'RESULT',
    );
  });

  it('rejects trailing bytes after the terminal message', async () => {
    await expectProtocolError(
      (request, socket) => socket.write(`${JSON.stringify(result(request.id, 'FIRST-RESULT'))}\n{"v":`),
      /after the terminal message/,
      'RESULT',
    );
  });

  it('rejects a second pending message', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await expectProtocolError(
      (request, socket) => send(socket, pending(request.id, expiresAt), pending(request.id, expiresAt)),
      /second pending/,
    );
  });

  it('rejects a message for another request', async () => {
    await expectProtocolError((_request, socket) => send(socket, result('someone-else', 'x')), /expected/);
  });

  it('rejects a connection closed before a terminal message', async () => {
    await expectProtocolError((request, socket) => {
      send(socket, pending(request.id, new Date(Date.now() + 60_000).toISOString()));
      socket.end();
    }, /closed the connection/);
  });

  it('rejects a line longer than the protocol allows', async () => {
    await expectProtocolError((_request, socket) => socket.write('x'.repeat(MAX_LINE_LENGTH + 1)), /too long/);
  });
});

// ── Default wait bounds (fake clock; the socket stays real) ─

describe('default wait bounds', () => {
  const SDK_CALL_TIMEOUT_MS = 360_000;
  /** What the broker does: it answers `still-executing` this long after the card expires. */
  const BROKER_ANSWER_AFTER_EXPIRY_MS = 25_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts a gh_write against a broker that answers with `pending` (expiring `expiresInMs` after the call starts). */
  async function startPending(expiresInMs: number | null) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const startedAt = Date.now();
    let received: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      received = resolve;
    });
    let peer: net.Socket | undefined;
    let requestId = '';
    const broker = await fakeBroker((request, socket) => {
      peer = socket;
      requestId = request.id;
      if (expiresInMs !== null) send(socket, pending(request.id, new Date(startedAt + expiresInMs).toISOString()));
      else received();
    });
    let settled = false;
    const out = runDevopsTool('gh_write', GH_WRITE_ARGS, {
      env: ENV,
      socketPath: broker.socketPath,
      onPending: () => received(),
    }).then((value) => {
      settled = true;
      return value;
    });
    await ready;
    return {
      broker,
      out,
      isSettled: () => settled,
      /** Moves the fake clock to `ms` after the call started. */
      advanceTo: (ms: number) => vi.advanceTimersByTimeAsync(startedAt + ms - Date.now()),
      answer: (message: unknown) => send(peer as net.Socket, { ...(message as object), id: requestId }),
    };
  }

  it('stays just under the SDK per-call timeout, with a 30 s grace after the card expires', () => {
    expect(MAX_WAIT_MS).toBe(355_000);
    expect(MAX_WAIT_MS).toBeLessThan(SDK_CALL_TIMEOUT_MS);
    expect(PENDING_GRACE_MS).toBe(30_000);
  });

  it('delivers still-executing sent at expiry + 25 s when posting the card pushed expiry past start + 300 s', async () => {
    // Slack posting took 20 s: the card expires 320 s after the call started.
    const call = await startPending(320_000);
    await call.advanceTo(320_000 + BROKER_ANSWER_AFTER_EXPIRY_MS);
    expect(call.isSettled()).toBe(false);
    call.answer(error('x', 'still-executing', 'approved and running'));
    const out = await call.out;
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe('error still-executing: approved and running');
  });

  it('after pending, stops at the 355 s ceiling as unconfirmed (never "승인되지 않음") even if the card expires later', async () => {
    const call = await startPending(3_600_000);
    await call.advanceTo(MAX_WAIT_MS - 1);
    expect(call.isSettled()).toBe(false);
    await call.advanceTo(MAX_WAIT_MS);
    const out = await call.out;
    expect(out.isError).toBe(true);
    expectUnconfirmedAfterPending(textOf(out));
    await call.broker.peerClosed;
  });

  it('after pending, stops 30 s after the card expires when that comes first, as unconfirmed', async () => {
    const call = await startPending(300_000);
    await call.advanceTo(300_000 + PENDING_GRACE_MS - 1);
    expect(call.isSettled()).toBe(false);
    await call.advanceTo(300_000 + PENDING_GRACE_MS);
    expectUnconfirmedAfterPending(textOf(await call.out));
  });

  it('without pending, gives up at the same 355 s ceiling and calls the outcome unknown', async () => {
    const call = await startPending(null);
    await call.advanceTo(MAX_WAIT_MS - 1);
    expect(call.isSettled()).toBe(false);
    await call.advanceTo(MAX_WAIT_MS);
    const text = textOf(await call.out);
    expect(text).toContain('did not answer within 355 s');
    expect(text).toContain('outcome is unknown');
    for (const word of RETRY_WORDS) expect(text).not.toContain(word);
    await call.broker.peerClosed;
  });
});

// ── Cancellation and progress ─────────────────────────────

describe('cancellation', () => {
  const request = {
    v: PROTOCOL_VERSION,
    id: 'req-cancel',
    tool: 'list' as const,
    args: {},
    claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 'work:C000CHAN:direct' },
  };
  const NOTHING_SENT = 'nothing was sent';
  const MAY_STILL_RUN = 'the broker may still run it';

  it('before anything is sent: a call already cancelled never connects', async () => {
    const broker = await fakeBroker(() => {});
    const controller = new AbortController();
    controller.abort();
    await expect(callBroker(request, { socketPath: broker.socketPath, signal: controller.signal })).resolves.toEqual({
      kind: 'cancelled',
      sent: false,
      pending: null,
    });
    const out = await runDevopsTool('list', {}, { env: ENV, socketPath: broker.socketPath, signal: controller.signal });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(NOTHING_SENT);
    expect(textOf(out)).not.toContain(MAY_STILL_RUN);
    expect(broker.connections).toBe(0);
  });

  it('before anything is sent: cancelled while connecting, the request line is never written', async () => {
    const broker = await fakeBroker(() => {});
    const controller = new AbortController();
    const outcome = callBroker(request, { socketPath: broker.socketPath, signal: controller.signal });
    controller.abort();
    await expect(outcome).resolves.toEqual({ kind: 'cancelled', sent: false, pending: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(broker.requests).toEqual([]);
  });

  it('after the request was sent: closes the socket and says the broker may still run it', async () => {
    const controller = new AbortController();
    const broker = await fakeBroker(() => controller.abort());
    const out = await runDevopsTool('gh_write', GH_WRITE_ARGS, {
      env: ENV,
      socketPath: broker.socketPath,
      signal: controller.signal,
    });
    await broker.peerClosed;
    expect(broker.requests).toHaveLength(1);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(MAY_STILL_RUN);
    expect(textOf(out)).toContain('Check the current state before requesting the same action again');
    expect(textOf(out)).not.toContain(NOTHING_SENT);
    for (const word of RETRY_WORDS) expect(textOf(out)).not.toContain(word);
  });

  it('after pending: names the approval card the broker may still act on', async () => {
    const broker = await fakeBroker((sent, socket) =>
      send(socket, pending(sent.id, new Date(Date.now() + 60_000).toISOString())),
    );
    const controller = new AbortController();
    const outcome = await callBroker(request, {
      socketPath: broker.socketPath,
      signal: controller.signal,
      onPending: () => controller.abort(),
    });
    await broker.peerClosed;
    expect(outcome).toMatchObject({ kind: 'cancelled', sent: true, pending: { approvalId: 'appr-0001' } });
    const text = textOf(formatOutcome(outcome));
    expect(text).toContain(MAY_STILL_RUN);
    expect(text).toContain('(approval appr-0001, card 0123456789ab)');
    for (const word of RETRY_WORDS) expect(text).not.toContain(word);
  });
});

describe('progress while pending', () => {
  function extra(progressToken?: string) {
    return {
      signal: new AbortController().signal,
      _meta: progressToken === undefined ? undefined : { progressToken },
      sendNotification: vi.fn(async () => {}),
    };
  }

  it('sends one progress notification with the card digest when the client asked for progress', async () => {
    const broker = await fakeBroker((request, socket) => {
      send(socket, pending(request.id, '2030-01-01T00:00:00.000Z'));
      setTimeout(() => send(socket, result(request.id, { done: true })), 20);
    });
    const server = new DevopsToolsMCPServer({ env: ENV, socketPath: broker.socketPath });
    const call = extra('tok-1');
    const out = await server.callTool('gh_write', GH_WRITE_ARGS, call);
    expect(textOf(out)).toBe('{"done":true}');
    expect(call.sendNotification).toHaveBeenCalledTimes(1);
    expect(call.sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: expect.objectContaining({
        progressToken: 'tok-1',
        progress: 0,
        message: expect.stringContaining('0123456789ab'),
      }),
    });
  });

  it('sends nothing when the client did not ask for progress', async () => {
    const broker = await fakeBroker((request, socket) => {
      send(socket, pending(request.id, '2030-01-01T00:00:00.000Z'));
      send(socket, result(request.id, { done: true }));
    });
    const server = new DevopsToolsMCPServer({ env: ENV, socketPath: broker.socketPath });
    const call = extra();
    await server.callTool('gh_write', GH_WRITE_ARGS, call);
    expect(call.sendNotification).not.toHaveBeenCalled();
  });
});
