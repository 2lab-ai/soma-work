import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalConsumeError,
  ApprovalError,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalState,
  type Approvals,
  createApprovals,
  initialApprovalState,
} from './approval.js';
import { type BrokerDeps, createBroker } from './broker.js';
import type { CloudflareLeases, LeaseView } from './cf-client.js';
import { GhRunDeniedError, type GhRunner, type GhRunResult } from './gh-runner.js';
import { type GithubAdmin, GithubAdminError } from './github-admin.js';
import { Ledger } from './ledger.js';
import { type BrokerPaths, brokerPaths } from './paths.js';
import { type BrokerPolicy, parsePolicy } from './policy.js';
import type { SlackApi } from './slack-api.js';
import { StateStore } from './state.js';

const ZERO_ID = '0'.repeat(32);
const ONE_ID = '1'.repeat(32);
const TWO_ID = '2'.repeat(32);
const GH_TOKEN = 'test-gh-token-0001';
const LEASE_ID = 'a'.repeat(32);
const HEAD_SHA = 'c'.repeat(40);

const POLICY_JSON = {
  admins: ['U000ADMIN'],
  gh: {
    org: 'example-org',
    accounts: {
      member: { login: 'alice-bot', class: 'member' },
      'org-admin': { login: 'alice-admin', class: 'org-admin' },
    },
  },
  cloudflare: {
    dev2: {
      accountId: ZERO_ID,
      zones: { 'example.com': ONE_ID, 'api.example.com': TWO_ID },
      permissionGroups: { read: ['dns-read-group'], edit: ['dns-edit-group', 'dns-read-group'] },
      defaultTtl: '1h',
      maxTtl: '24h',
    },
  },
};

let dir: string;
let paths: BrokerPaths;
let policy: BrokerPolicy;
let handle: { close(): Promise<void> } | undefined;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-broker-'));
  paths = brokerPaths(dir);
  fs.mkdirSync(paths.runDir);
  fs.chmodSync(paths.runDir, 0o750);
  policy = parsePolicy(POLICY_JSON);
});
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Fakes ─────────────────────────────────────────────────

type Script = 'approved' | 'denied' | 'expired' | 'cancelled' | 'hang';

interface FakeApprovals {
  approvals: Approvals;
  requests: ApprovalRequest[];
  signals: AbortSignal[];
  results: string[];
  released: [string, string][];
}

function fakeApprovals(
  script: Script,
  opts: { events?: string[]; expiresInMs?: number; waitFor?: number; decideAfterMs?: number } = {},
): FakeApprovals {
  const requests: ApprovalRequest[] = [];
  const signals: AbortSignal[] = [];
  const results: string[] = [];
  const released: [string, string][] = [];
  const events = opts.events ?? [];
  let consumed = false;
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const approvals: Approvals = {
    async request(req, hooks) {
      requests.push(req);
      if (hooks.signal) signals.push(hooks.signal);
      const approvalId = 'appr-0001';
      hooks.onPending({
        approvalId,
        digestPrefix: '0123456789ab',
        expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 300_000)).toISOString(),
      });
      if (requests.length >= (opts.waitFor ?? 1)) release();
      await barrier;
      if (opts.decideAfterMs !== undefined) await new Promise((resolve) => setTimeout(resolve, opts.decideAfterMs));
      if (script === 'hang') {
        return new Promise<ApprovalOutcome>((resolve) => {
          hooks.signal?.addEventListener('abort', () => resolve({ outcome: 'cancelled', approvalId }), { once: true });
        });
      }
      if (script !== 'approved') return { outcome: script, approvalId };
      return {
        outcome: 'approved',
        approvalId,
        consume: async () => {
          events.push('consume');
          if (consumed) throw new ApprovalConsumeError(approvalId);
          consumed = true;
        },
      };
    },
    async postResult(_approvalId, line) {
      results.push(line);
    },
    async release(approvalId, reason) {
      events.push('release');
      released.push([approvalId, reason]);
    },
    async close() {},
  };
  return { approvals, requests, signals, results, released };
}

function ghResult(overrides: Partial<GhRunResult> = {}): GhRunResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: 'out',
    stderr: '',
    truncated: false,
    timedOut: false,
    killedForMemory: false,
    watchdogFailed: false,
    durationMs: 5,
    ...overrides,
  };
}

function fakeGhRunner(events: string[] = [], result: () => Promise<GhRunResult> = async () => ghResult()) {
  const run = vi.fn(async (_token: string, _argv: readonly string[]) => {
    events.push('run');
    return result();
  });
  return { runner: { run } as GhRunner, run };
}

function leaseView(overrides: Partial<LeaseView> = {}): LeaseView {
  return {
    leaseId: LEASE_ID,
    env: 'dev2',
    access: 'read',
    zones: ['example.com'],
    expiresAt: '2026-10-26T01:00:00.000Z',
    state: 'active',
    ...overrides,
  };
}

function fakeLeases(): CloudflareLeases & { [K in keyof CloudflareLeases]: ReturnType<typeof vi.fn> } {
  return {
    mint: vi.fn(async (input: { leaseId: string }) => leaseView({ leaseId: input.leaseId })),
    call: vi.fn(async () => ({ status: 200, body: { success: true } })),
    revoke: vi.fn(async (leaseId: string) => leaseView({ leaseId, state: 'revoked' })),
    sweep: vi.fn(async () => ({ revoked: 0, failed: 0, orphansDeleted: 0 })),
    list: vi.fn(() => [] as LeaseView[]),
    permissionGroupNames: vi.fn(async () => ({ 'dns-read-group': 'DNS Read', 'dns-edit-group': 'DNS Write' })),
  } as never;
}

function fakeGithubAdmin(events: string[] = []) {
  const ok = async () => {
    events.push('github');
    return { status: 200, body: '{"state":"active"}', truncated: false };
  };
  return {
    getMembership: vi.fn(async (): Promise<Awaited<ReturnType<GithubAdmin['getMembership']>>> => {
      events.push('read');
      return { member: false };
    }),
    getCollaboratorPermission: vi.fn(
      async (): Promise<Awaited<ReturnType<GithubAdmin['getCollaboratorPermission']>>> => {
        events.push('read');
        return { collaborator: false };
      },
    ),
    getPullRequest: vi.fn(async (): Promise<Awaited<ReturnType<GithubAdmin['getPullRequest']>>> => {
      events.push('read');
      return { merged: false, mergeCommitSha: null, state: 'open' };
    }),
    setMembership: vi.fn(ok),
    removeMembership: vi.fn(ok),
    addCollaborator: vi.fn(ok),
    removeCollaborator: vi.fn(ok),
    mergePullRequest: vi.fn(async () => {
      events.push('merge');
      return {
        status: 200,
        body: JSON.stringify({ sha: 'd'.repeat(40), merged: true, message: 'Pull Request successfully merged' }),
        truncated: false,
      };
    }),
  } satisfies GithubAdmin;
}

function deps(overrides: Partial<BrokerDeps> = {}): BrokerDeps {
  return {
    paths,
    policy,
    readSecret: (kind, name) => `${GH_TOKEN}-${kind}-${name}`,
    ghRunner: fakeGhRunner().runner,
    cfLeases: fakeLeases(),
    approvals: fakeApprovals('denied').approvals,
    githubAdmin: fakeGithubAdmin(),
    ledger: new Ledger(paths.ledgerFile),
    log: () => {},
    ...overrides,
  };
}

async function start(overrides: Partial<BrokerDeps> = {}): Promise<BrokerDeps> {
  const d = deps(overrides);
  handle = await createBroker(d).listen();
  return d;
}

// ── Client ────────────────────────────────────────────────

type Message = Record<string, unknown>;

function exchange(line: string, onMessage?: (message: Message, socket: net.Socket) => void): Promise<Message[]> {
  return new Promise((resolve) => {
    const socket = net.connect(paths.socketPath);
    const messages: Message[] = [];
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => {
      const parts = `${buffered}${chunk}`.split('\n');
      buffered = parts.pop() ?? '';
      for (const part of parts) {
        if (part.length === 0) continue;
        const message = JSON.parse(part) as Message;
        messages.push(message);
        onMessage?.(message, socket);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve(messages));
  });
}

function request(tool: string, args: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    v: 1,
    id: `req-${seq}`,
    tool,
    args,
    claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 'session-1' },
    ...extra,
  };
}

function send(req: Record<string, unknown>, onMessage?: (message: Message, socket: net.Socket) => void) {
  return exchange(`${JSON.stringify(req)}\n`, onMessage);
}

function terminal(messages: Message[]): Message {
  const last = messages[messages.length - 1];
  expect(last, 'a terminal message').toBeDefined();
  expect(last.type).not.toBe('pending');
  return last;
}

function ledgerRows(): Record<string, unknown>[] {
  if (!fs.existsSync(paths.ledgerFile)) return [];
  return fs
    .readFileSync(paths.ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const PR_COMMENT = ['pr', 'comment', '7', '-R', 'example-org/app', '--body', 'hello'];

// ── Socket ────────────────────────────────────────────────

describe('broker socket', () => {
  it('refuses to start when the run directory is missing', async () => {
    fs.rmSync(paths.runDir, { recursive: true });
    await expect(createBroker(deps()).listen()).rejects.toThrow(/run/);
    expect(fs.existsSync(paths.socketPath)).toBe(false);
  });

  it('refuses to start when the run directory is group- or other-writable', async () => {
    fs.chmodSync(paths.runDir, 0o777);
    await expect(createBroker(deps()).listen()).rejects.toThrow(/writable/);
    expect(fs.existsSync(paths.socketPath)).toBe(false);
  });

  it('refuses to start when the socket path holds a regular file', async () => {
    fs.writeFileSync(paths.socketPath, 'not a socket');
    await expect(createBroker(deps()).listen()).rejects.toThrow(/not a socket/);
    expect(fs.readFileSync(paths.socketPath, 'utf8')).toBe('not a socket');
  });

  it('binds the socket 0660 and replaces a stale socket file', async () => {
    const other = path.join(paths.runDir, 'old.sock');
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(other, resolve));
    fs.renameSync(other, paths.socketPath);
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    expect(fs.lstatSync(paths.socketPath).isSocket()).toBe(true);

    await start();
    const stat = fs.lstatSync(paths.socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o660);
    const messages = await send(request('list', {}));
    expect(terminal(messages).type).toBe('result');
  });

  it('refuses to start while another broker is listening on the socket', async () => {
    await start();
    await expect(createBroker(deps()).listen()).rejects.toThrow(/already/);
  });

  it('answers a protocol version mismatch with version-mismatch', async () => {
    await start();
    const messages = await send(request('list', {}, { v: 99 }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ v: 1, type: 'error', code: 'version-mismatch' });
  });

  it('answers an unknown request key with bad-request', async () => {
    await start();
    const messages = await send(request('list', {}, { extra: true }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'error', code: 'bad-request' });
  });

  it('answers a line that is not JSON with bad-request and a null id', async () => {
    await start();
    const messages = await exchange('{nope\n');
    expect(messages).toEqual([expect.objectContaining({ type: 'error', code: 'bad-request', id: null })]);
  });

  it('destroys a half-open connection 2 s after its answer, so 64 of them cannot lock the broker out', async () => {
    await start();
    const line = `${JSON.stringify(request('list', {}))}\n`;
    const holders: net.Socket[] = [];
    const answers = await Promise.all(
      Array.from(
        { length: 64 },
        () =>
          new Promise<boolean>((resolve) => {
            // allowHalfOpen: the client never ends its side, like a stuck or hostile peer.
            const socket = net.connect({ path: paths.socketPath, allowHalfOpen: true });
            holders.push(socket);
            let text = '';
            socket.setEncoding('utf8');
            socket.on('error', () => {});
            socket.on('data', (chunk: string) => {
              text += chunk;
            });
            socket.on('end', () => resolve(text.includes('"result"')));
            socket.on('connect', () => socket.write(line));
          }),
      ),
    );
    try {
      expect(answers).toEqual(Array(64).fill(true));
      // Every slot is held by a client that will never close; only the broker can free them.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const late = await send(request('list', {}));
      expect(late.map((m) => m.type)).toEqual(['result']);
    } finally {
      for (const socket of holders) socket.destroy();
    }
  }, 15_000);

  it('closes a connection that sends no request line in time', async () => {
    await start({ requestTimeoutMs: 100 });
    const messages = await exchange('');
    expect(messages).toEqual([expect.objectContaining({ type: 'error', code: 'bad-request', id: null })]);
  });
});

// ── list ──────────────────────────────────────────────────

describe('list', () => {
  it('shows account names and classes, environments, and only the requesting session’s leases', async () => {
    const cfLeases = fakeLeases();
    const approvals = fakeApprovals('approved').approvals;
    await start({ cfLeases, approvals });
    const minted = terminal(
      await send(
        request('cf_lease_request', {
          env: 'dev2',
          access: 'read',
          permissions: ['dns-read-group'],
          zones: ['example.com'],
          reason: 'check records',
        }),
      ),
    );
    expect(minted.type).toBe('result');
    const leaseId = (minted.data as { leaseId: string }).leaseId;
    cfLeases.list.mockReturnValue([leaseView({ leaseId }), leaseView({ leaseId: 'b'.repeat(32) })]);

    const mine = terminal(await send(request('list', {})));
    expect(mine.data).toEqual({
      accounts: [
        { name: 'member', class: 'member' },
        { name: 'org-admin', class: 'org-admin' },
      ],
      envs: [
        {
          name: 'dev2',
          zones: ['example.com', 'api.example.com'],
          access: { read: ['dns-read-group'], edit: ['dns-edit-group', 'dns-read-group'] },
          defaultTtl: '1h',
          maxTtl: '24h',
        },
      ],
      leases: [leaseView({ leaseId })],
    });
    expect(JSON.stringify(mine)).not.toContain('alice-bot');

    const other = terminal(
      await send(request('list', {}, { claimedRequester: { slackUserId: 'U000BOB', sessionKey: 'session-2' } })),
    );
    expect((other.data as { leases: unknown[] }).leases).toEqual([]);
  });
});

// ── gh_read ───────────────────────────────────────────────

describe('gh_read', () => {
  it('runs a read immediately with the account token and returns the run result', async () => {
    const gh = fakeGhRunner();
    const readSecret = vi.fn((kind: string, name: string) => `${GH_TOKEN}-${kind}-${name}`);
    await start({ ghRunner: gh.runner, readSecret });
    const argv = ['pr', 'view', '7', '-R', 'example-org/app'];
    const messages = await send(request('gh_read', { account: 'member', args: argv }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'result',
      data: {
        exitCode: 0,
        stdout: 'out',
        stderr: '',
        truncated: false,
        timedOut: false,
        killedForMemory: false,
        watchdogFailed: false,
      },
    });
    expect(readSecret).toHaveBeenCalledWith('gh', 'member');
    expect(gh.run).toHaveBeenCalledWith(`${GH_TOKEN}-gh-member`, argv);
    const row = ledgerRows().find((r) => r.tool === 'gh_read');
    expect(row).toMatchObject({ account: 'member', classification: 'read', outcome: 'ok', exitCode: 0 });
    expect(JSON.stringify(row)).not.toContain(GH_TOKEN);
  });

  it('keeps the full argv in the ledger only once the classifier allowed it', async () => {
    const gh = fakeGhRunner();
    await start({ ghRunner: gh.runner });
    const argv = ['pr', 'view', '7', '-R', 'example-org/app'];
    await send(request('gh_read', { account: 'member', args: argv }));
    const huge = ['auth', 'token', 'x'.repeat(60_000), 'y'];
    await send(request('gh_read', { account: 'member', args: huge }));
    const rows = ledgerRows().filter((r) => r.tool === 'gh_read');
    expect(rows[0]).toMatchObject({ argv, classification: 'read' });
    expect(rows[1]).toMatchObject({
      classification: 'deny',
      outcome: 'policy-denied',
      argc: 4,
      argvSha256: createHash('sha256').update(JSON.stringify(huge)).digest('hex'),
      argvPreview: ['auth', 'token', 'x'.repeat(200), 'y'],
    });
    expect(rows[1]).not.toHaveProperty('argv');
    expect(JSON.stringify(rows[1]).length).toBeLessThan(2000);
  });

  it('records an allowed argv too large for an approval card as count + hash + previews, not whole', async () => {
    const gh = fakeGhRunner();
    await start({ ghRunner: gh.runner });
    const big = ['api', '-X', 'GET', 'repos/example-org/app/issues', '-f', `q=${'x'.repeat(60_000)}`];
    const messages = await send(request('gh_read', { account: 'member', args: big }));
    expect(terminal(messages)).toMatchObject({ type: 'result' });
    expect(gh.run).toHaveBeenCalledWith(`${GH_TOKEN}-gh-member`, big);
    const row = ledgerRows().find((r) => r.tool === 'gh_read');
    expect(row).toMatchObject({
      classification: 'read',
      outcome: 'ok',
      argc: 6,
      argvSha256: createHash('sha256').update(JSON.stringify(big)).digest('hex'),
      argvPreview: big.map((arg) => arg.slice(0, 200)),
    });
    expect(row).not.toHaveProperty('argv');
    expect(JSON.stringify(row).length).toBeLessThan(3000);
  });

  it('denies a write argv with policy-denied and runs nothing', async () => {
    const gh = fakeGhRunner();
    const approvals = fakeApprovals('approved');
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_read', { account: 'member', args: PR_COMMENT }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'policy-denied' });
    expect(String(terminal(messages).message)).toContain('gh_write');
    expect(gh.run).not.toHaveBeenCalled();
    expect(approvals.requests).toHaveLength(0);
  });

  it('points org access changes through gh api at the dedicated tools', async () => {
    const gh = fakeGhRunner();
    await start({ ghRunner: gh.runner });
    const messages = await send(
      request('gh_read', { account: 'org-admin', args: ['api', '-X', 'PUT', 'orgs/example-org/memberships/alice'] }),
    );
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'policy-denied' });
    expect(String(terminal(messages).message)).toMatch(/gh_org_member/);
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('denies an argv the classifier denies, with its reason', async () => {
    const gh = fakeGhRunner();
    await start({ ghRunner: gh.runner });
    const messages = await send(request('gh_read', { account: 'member', args: ['auth', 'token'] }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'policy-denied' });
    expect(String(terminal(messages).message)).toContain('gh auth is not allowed');
    expect(gh.run).not.toHaveBeenCalled();
  });

  it.each(['constructor', 'tostring', 'nobody'])('answers account %s with unknown-account', async (account) => {
    const gh = fakeGhRunner();
    await start({ ghRunner: gh.runner });
    const messages = await send(request('gh_read', { account, args: ['pr', 'view', '7', '-R', 'example-org/app'] }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'unknown-account' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('turns a throwing classifier into internal and runs nothing', async () => {
    const gh = fakeGhRunner();
    const approvals = fakeApprovals('approved');
    await start({
      ghRunner: gh.runner,
      approvals: approvals.approvals,
      classifyGh: () => {
        throw new Error('classifier exploded');
      },
    });
    for (const tool of ['gh_read', 'gh_write']) {
      const messages = await send(request(tool, { account: 'member', args: PR_COMMENT }));
      expect(terminal(messages)).toMatchObject({ type: 'error', code: 'internal' });
    }
    expect(gh.run).not.toHaveBeenCalled();
    expect(approvals.requests).toHaveLength(0);
  });

  it('treats an internal-error denial from the classifier as internal, not policy', async () => {
    const gh = fakeGhRunner();
    await start({
      ghRunner: gh.runner,
      classifyGh: () => ({ kind: 'deny', code: 'internal-error', reason: 'the gh policy context is malformed' }),
    });
    const messages = await send(
      request('gh_read', { account: 'member', args: ['pr', 'view', '7', '-R', 'example-org/app'] }),
    );
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'internal' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('answers internal (no run) when the account token cannot be read', async () => {
    const gh = fakeGhRunner();
    await start({
      ghRunner: gh.runner,
      readSecret: () => {
        throw new Error('/secret/path/gh/member.token does not exist');
      },
    });
    const messages = await send(
      request('gh_read', { account: 'member', args: ['pr', 'view', '7', '-R', 'example-org/app'] }),
    );
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'internal' });
    expect(String(terminal(messages).message)).not.toContain('/secret/path');
    expect(gh.run).not.toHaveBeenCalled();
  });
});

// ── gh_write ──────────────────────────────────────────────

describe('gh_write', () => {
  it.each([
    ['denied', 'denied'],
    ['expired', 'expired'],
  ] as const)('answers a %s card with not-approved and never runs gh', async (script, reason) => {
    const gh = fakeGhRunner();
    const approvals = fakeApprovals(script);
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(messages[0]).toMatchObject({ type: 'pending', approvalId: 'appr-0001', digestPrefix: '0123456789ab' });
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'not-approved', reason });
    expect(messages).toHaveLength(2);
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('consumes the approval before running gh, then reports on the card and in the ledger', async () => {
    const events: string[] = [];
    const gh = fakeGhRunner(events);
    const approvals = fakeApprovals('approved', { events });
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(messages.map((m) => m.type)).toEqual(['pending', 'result']);
    expect(terminal(messages).data).toMatchObject({ exitCode: 0, stdout: 'out' });
    expect(events).toEqual(['consume', 'run']);
    expect(gh.run).toHaveBeenCalledWith(`${GH_TOKEN}-gh-member`, PR_COMMENT);
    await waitFor(() => approvals.results.length === 1);
    expect(approvals.results[0]).toMatch(/0/);
    const row = ledgerRows().find((r) => r.tool === 'gh_write');
    expect(row).toMatchObject({
      approvalId: 'appr-0001',
      account: 'member',
      classification: 'write',
      outcome: 'ok',
      exitCode: 0,
      claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 'session-1' },
    });
  });

  it('builds the card from the structured request', async () => {
    const approvals = fakeApprovals('denied');
    await start({ approvals: approvals.approvals });
    await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    const card = approvals.requests[0];
    expect(card.tool).toBe('gh_write');
    expect(card.title).toContain('member');
    expect(card.title).toContain('example-org/app');
    expect(card.title).toBe('member 계정이 example-org/app에 gh pr comment 실행');
    expect(card.argv).toEqual(PR_COMMENT);
    expect(card.details.map((d) => d.label)).toEqual(expect.arrayContaining(['계정', '레포', '명령']));
    expect(card.claimedRequester).toEqual({ slackUserId: 'U000ALICE', sessionKey: 'session-1' });
    expect(card.warnings).toEqual([]);
    expect(card.canonical).toMatchObject({ tool: 'gh_write', account: 'member', args: PR_COMMENT });
  });

  it.each([
    [
      ['pr', 'review', '7', '--approve', '-R', 'example-org/app'],
      '다른 계정이 만든 PR의 리뷰 요건을 채우는 데 쓰일 수 있음',
    ],
    [['workflow', 'run', 'ci.yml', '-R', 'example-org/app'], 'CI 코드 실행에 영향'],
    [['variable', 'set', 'FOO', '--body', 'x', '--org', 'example-org'], 'CI 코드 실행에 영향'],
    // Deferred effects (gh 2.102.0): what the admin approves can take effect later.
    [
      ['pr', 'review', '7', '--approve', '-R', 'example-org/app'],
      '이후 커밋에도 이 승인이 남을 수 있음 (오래된 승인 자동 해제가 꺼진 레포)',
    ],
    [
      ['workflow', 'enable', 'ci.yml', '-R', 'example-org/app'],
      '이후 예약·이벤트 실행이 다시 켜짐 (그때 브랜치의 워크플로 코드가 실행됨)',
    ],
  ])('warns on %j', async (argv, warning) => {
    const approvals = fakeApprovals('denied');
    await start({ approvals: approvals.approvals });
    await send(request('gh_write', { account: 'member', args: argv }));
    expect(approvals.requests[0].warnings).toContain(warning);
  });

  it.each([
    [['pr', 'merge', '7', '--squash', '-R', 'example-org/app']],
    [['pr', 'merge', '7', '--squash', '--match-head-commit', 'c'.repeat(7), '-R', 'example-org/app']],
    // --body takes the next token as its value; that is not the flag.
    [['pr', 'merge', '7', '--squash', '--body', '--match-head-commit', '-R', 'example-org/app']],
  ])('refuses %j without a pinned 40-hex head commit, without a card', async (argv) => {
    const approvals = fakeApprovals('approved');
    const gh = fakeGhRunner();
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: argv }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'policy-denied' });
    expect(String(terminal(messages).message)).toContain('--match-head-commit');
    expect(approvals.requests).toHaveLength(0);
    expect(gh.run).not.toHaveBeenCalled();
  });

  const MERGE = ['pr', 'merge', '7', '--squash', '--match-head-commit', HEAD_SHA, '-R', 'example-org/app'];

  it('merges through the REST API with the pinned sha after approval, never through gh', async () => {
    const events: string[] = [];
    const gh = fakeGhRunner(events);
    const github = fakeGithubAdmin(events);
    const approvals = fakeApprovals('approved', { events });
    await start({ ghRunner: gh.runner, githubAdmin: github, approvals: approvals.approvals });
    const argv = [...MERGE, '--subject', 'Ship it', '--body', 'release notes'];
    const messages = await send(request('gh_write', { account: 'member', args: argv }));
    expect(messages.map((m) => m.type)).toEqual(['pending', 'result']);
    expect(terminal(messages).data).toMatchObject({ status: 200 });
    expect(events).toEqual(['consume', 'merge']);
    expect(gh.run).not.toHaveBeenCalled();
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(github.mergePullRequest).toHaveBeenCalledWith(`${GH_TOKEN}-gh-member`, 'example-org', 'app', 7, {
      sha: HEAD_SHA,
      method: 'squash',
      title: 'Ship it',
      message: 'release notes',
    });
    const card = approvals.requests[0];
    expect(card.title).toContain('즉시 머지');
    expect(card.title).toContain(`기준 커밋 ${HEAD_SHA.slice(0, 12)}`);
    expect(card.title).toContain('방식 squash');
    expect(card.title).toContain('그 사이 커밋이 올라오면 GitHub가 거절함');
    expect(card.title).toContain('머지 큐가 필요한 브랜치면 실패함');
    expect(card.warnings.join('\n')).not.toContain('머지 큐가 켜진');
    expect(card.details).toContainEqual({ label: '커밋 제목', value: 'Ship it' });
    expect(card.details).toContainEqual({ label: '커밋 메시지', value: 'release notes' });
    expect(card.canonical).toMatchObject({
      method: 'squash',
      sha: HEAD_SHA,
      title: 'Ship it',
      message: 'release notes',
    });
    await waitFor(() => ledgerRows().some((r) => r.tool === 'gh_write'));
    expect(ledgerRows().find((r) => r.tool === 'gh_write')).toMatchObject({ outcome: 'ok', status: 200, pr: 7 });
  });

  it('reports a merge GitHub refuses (head moved: 409) as upstream-error with its message, without retrying', async () => {
    const github = fakeGithubAdmin();
    github.mergePullRequest.mockResolvedValue({
      status: 409,
      body: '{"message":"Head branch was modified. Review and try the merge again."}',
      truncated: false,
    });
    const approvals = fakeApprovals('approved');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: MERGE }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'upstream-error' });
    expect(String(terminal(messages).message)).toContain('Head branch was modified');
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('turns a merge whose answer was lost into result-unknown and records a confirming read', async () => {
    const github = fakeGithubAdmin();
    github.mergePullRequest.mockRejectedValue(new GithubAdminError('result-unknown', 'connection reset'));
    github.getPullRequest.mockResolvedValue({ merged: true, mergeCommitSha: 'e'.repeat(40), state: 'closed' });
    const approvals = fakeApprovals('approved');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: MERGE }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'result-unknown' });
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(github.getPullRequest).toHaveBeenCalledWith(`${GH_TOKEN}-gh-member`, 'example-org', 'app', 7);
    await waitFor(() => ledgerRows().some((r) => r.tool === 'gh_write'));
    expect(ledgerRows().find((r) => r.tool === 'gh_write')).toMatchObject({
      outcome: 'result-unknown',
      observed: { merged: true, mergeCommitSha: 'e'.repeat(40), state: 'closed' },
    });
    await waitFor(() => approvals.results.length === 1);
    expect(approvals.results[0]).toContain('머지됨');
  });

  it.each([
    [['pr', 'merge', '7', '--match-head-commit', HEAD_SHA, '-R', 'example-org/app'], '--merge'],
    [['pr', 'merge', '7', '--squash', '--rebase', '--match-head-commit', HEAD_SHA, '-R', 'example-org/app'], '--merge'],
    [[...MERGE, '--delete-branch'], 'not supported for merges in v1'],
    // gh-policy itself refuses --auto (aaa4fa23).
    [[...MERGE, '--auto'], '--auto'],
    [[...MERGE, '--disable-auto'], '--disable-auto'],
  ])('refuses merge argv %j without a card', async (argv, text) => {
    const approvals = fakeApprovals('approved');
    const gh = fakeGhRunner();
    const github = fakeGithubAdmin();
    await start({ ghRunner: gh.runner, githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: argv }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'policy-denied' });
    expect(String(terminal(messages).message)).toContain(text);
    expect(approvals.requests).toHaveLength(0);
    expect(gh.run).not.toHaveBeenCalled();
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('still runs pr merge --disable-auto through gh, as its own card', async () => {
    const gh = fakeGhRunner();
    const github = fakeGithubAdmin();
    const approvals = fakeApprovals('approved');
    await start({ ghRunner: gh.runner, githubAdmin: github, approvals: approvals.approvals });
    const argv = ['pr', 'merge', '7', '--disable-auto', '-R', 'example-org/app'];
    const messages = await send(request('gh_write', { account: 'member', args: argv }));
    expect(terminal(messages)).toMatchObject({ type: 'result', data: { exitCode: 0 } });
    expect(gh.run).toHaveBeenCalledWith(`${GH_TOKEN}-gh-member`, argv);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(approvals.requests[0].title).toContain('자동 머지 해제');
    expect(approvals.requests[0].title).not.toContain('즉시 머지');
  });

  it('shows the pinned head commit of a merge on the card', async () => {
    const approvals = fakeApprovals('denied');
    await start({ approvals: approvals.approvals });
    await send(
      request('gh_write', {
        account: 'member',
        args: ['pr', 'merge', '7', `--match-head-commit=${HEAD_SHA}`, '--squash', '-R', 'example-org/app'],
      }),
    );
    expect(approvals.requests[0].details).toContainEqual({ label: '머지 기준 커밋', value: HEAD_SHA });
  });

  it('names the organization in the title of an org-scoped write', async () => {
    const approvals = fakeApprovals('denied');
    await start({ approvals: approvals.approvals });
    await send(
      request('gh_write', {
        account: 'member',
        args: ['variable', 'set', 'FOO', '--body', 'x', '--org', 'example-org'],
      }),
    );
    expect(approvals.requests[0].title).toContain('example-org');
    expect(approvals.requests[0].title).toContain('gh variable set');
    expect(approvals.requests[0].title).not.toContain('`');
  });

  it('refuses a read argv (use gh_read) without a card', async () => {
    const approvals = fakeApprovals('approved');
    await start({ approvals: approvals.approvals });
    const messages = await send(
      request('gh_write', { account: 'member', args: ['pr', 'view', '7', '-R', 'example-org/app'] }),
    );
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'policy-denied' });
    expect(String(terminal(messages).message)).toContain('gh_read');
    expect(approvals.requests).toHaveLength(0);
  });

  it('runs once when two concurrent connections are handed the same approval', async () => {
    const events: string[] = [];
    const gh = fakeGhRunner(events);
    const approvals = fakeApprovals('approved', { events, waitFor: 2 });
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const [a, b] = await Promise.all([
      send(request('gh_write', { account: 'member', args: PR_COMMENT })),
      send(request('gh_write', { account: 'member', args: PR_COMMENT })),
    ]);
    expect(gh.run).toHaveBeenCalledTimes(1);
    const codes = [terminal(a), terminal(b)].map((m) => (m.type === 'result' ? 'result' : m.code));
    expect(codes.sort()).toEqual(['result', 'still-executing']);
    expect(events.filter((e) => e === 'consume')).toHaveLength(2);
  });

  it('tells a cancelled approval apart from an unanswered one', async () => {
    const gh = fakeGhRunner();
    const approvals = fakeApprovals('cancelled');
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    const last = terminal(messages);
    expect(last).toMatchObject({ type: 'error', code: 'not-approved' });
    expect(String(last.message)).toMatch(/cancel/);
    expect(String(last.message)).not.toMatch(/no admin answered/);
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('withdraws a waiting card on shutdown and says so', async () => {
    const gh = fakeGhRunner();
    const approvals = fakeApprovals('hang');
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }), (message) => {
      if (message.type === 'pending') void handle?.close();
    });
    expect(messages.map((m) => m.type)).toEqual(['pending', 'error']);
    expect(terminal(messages)).toMatchObject({ code: 'not-approved' });
    expect(String(terminal(messages).message)).toMatch(/shutting down/);
    expect(approvals.signals[0].reason).toBe('broker-shutting-down');
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('with the real approvals: a card cancelled while the client still waits is not called unanswered', async () => {
    const slack: SlackApi = {
      openDm: async (user) => `D${user.slice(1)}`,
      postMessage: async () => ({ ts: '1700000000.000100' }),
      updateMessage: async () => {},
      getReactions: async () => [],
    };
    const store = new StateStore<ApprovalState>(path.join(paths.stateDir, 'approvals.json'), initialApprovalState());
    await store.load();
    const ledger = new Ledger(paths.ledgerFile);
    const approvals = createApprovals({ policy, slack, store, ledger, pollIntervalMs: 20, log: () => {} });
    const gh = fakeGhRunner();
    await start({ ghRunner: gh.runner, approvals, ledger });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }), (message) => {
      if (message.type === 'pending') void approvals.close();
    });
    expect(messages.map((m) => m.type)).toEqual(['pending', 'error']);
    const last = terminal(messages);
    expect(last).toMatchObject({ code: 'not-approved' });
    expect(String(last.message)).toMatch(/cancel/);
    expect(String(last.message)).not.toMatch(/no admin answered/);
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('aborts the approval when the client disconnects while it is pending', async () => {
    const gh = fakeGhRunner();
    const approvals = fakeApprovals('hang');
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }), (message, socket) => {
      if (message.type === 'pending') socket.destroy();
    });
    expect(messages.map((m) => m.type)).toEqual(['pending']);
    await waitFor(() => approvals.signals[0]?.aborted === true);
    expect(approvals.signals[0].reason).toBe('client-disconnected');
    await waitFor(() => ledgerRows().some((r) => r.tool === 'gh_write'));
    expect(ledgerRows().find((r) => r.tool === 'gh_write')).toMatchObject({ outcome: 'cancelled' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('answers still-executing at expiresAt + 25 s and records the outcome when the run ends', async () => {
    let finish: (result: GhRunResult) => void = () => {};
    const gh = fakeGhRunner(
      [],
      () =>
        new Promise<GhRunResult>((resolve) => {
          finish = resolve;
        }),
    );
    const approvals = fakeApprovals('approved', { expiresInMs: 300 });
    // The broker's clock runs 25 s ahead, so expiresAt + 25 s is ~300 ms of real time away.
    await start({ ghRunner: gh.runner, approvals: approvals.approvals, now: () => Date.now() + 25_000 });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(messages.map((m) => m.type)).toEqual(['pending', 'error']);
    expect(terminal(messages)).toMatchObject({ code: 'still-executing' });
    expect(gh.run).toHaveBeenCalledTimes(1);
    expect(ledgerRows().filter((r) => r.tool === 'gh_write')).toHaveLength(0);

    finish(ghResult({ exitCode: 0 }));
    await waitFor(() => ledgerRows().some((r) => r.tool === 'gh_write'));
    expect(ledgerRows().find((r) => r.tool === 'gh_write')).toMatchObject({
      outcome: 'ok',
      exitCode: 0,
      stillExecuting: true,
    });
    await waitFor(() => approvals.results.length === 1);
  });

  it('releases an approval that arrives after the client was told not-approved, and never consumes it', async () => {
    const events: string[] = [];
    const gh = fakeGhRunner(events);
    const approvals = fakeApprovals('approved', { events, expiresInMs: 200, decideAfterMs: 800 });
    // The broker's clock runs 25 s ahead: its answer deadline (expiresAt + 25 s) is ~200 ms away.
    await start({ ghRunner: gh.runner, approvals: approvals.approvals, now: () => Date.now() + 25_000 });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(messages.map((m) => m.type)).toEqual(['pending', 'error']);
    expect(terminal(messages)).toMatchObject({ code: 'not-approved', reason: 'expired' });
    await waitFor(() => approvals.released.length === 1);
    expect(approvals.released).toEqual([['appr-0001', 'requester-stopped-waiting']]);
    expect(events).toEqual(['release']);
    expect(gh.run).not.toHaveBeenCalled();
    await waitFor(() => ledgerRows().some((r) => r.tool === 'gh_write'));
    expect(ledgerRows().find((r) => r.tool === 'gh_write')).toMatchObject({ outcome: 'approved-too-late' });
  });

  it('reports a gh write that timed out as result-unknown', async () => {
    const gh = fakeGhRunner([], async () => ghResult({ exitCode: null, signal: 'SIGKILL', timedOut: true }));
    const approvals = fakeApprovals('approved');
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'result-unknown' });
    expect(gh.run).toHaveBeenCalledTimes(1);
    await waitFor(() => ledgerRows().some((r) => r.tool === 'gh_write'));
    expect(ledgerRows().find((r) => r.tool === 'gh_write')).toMatchObject({
      outcome: 'result-unknown',
      confirm: 'manual',
    });
  });

  it('reports a gh write stopped by a failed memory watchdog as result-unknown', async () => {
    const gh = fakeGhRunner([], async () => ghResult({ exitCode: null, signal: 'SIGKILL', watchdogFailed: true }));
    const approvals = fakeApprovals('approved');
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'result-unknown' });
    expect(String(terminal(messages).message)).toContain('watchdog');
    await waitFor(() => ledgerRows().some((r) => r.tool === 'gh_write'));
    expect(ledgerRows().find((r) => r.tool === 'gh_write')).toMatchObject({ watchdogFailed: true });
  });

  it('passes watchdogFailed through on a read', async () => {
    const gh = fakeGhRunner([], async () => ghResult({ exitCode: null, signal: 'SIGKILL', watchdogFailed: true }));
    await start({ ghRunner: gh.runner });
    const messages = await send(
      request('gh_read', { account: 'member', args: ['pr', 'view', '7', '-R', 'example-org/app'] }),
    );
    expect(terminal(messages)).toMatchObject({ type: 'result', data: { watchdogFailed: true } });
  });

  it('reports a gh write killed for memory as result-unknown', async () => {
    const gh = fakeGhRunner([], async () => ghResult({ exitCode: null, signal: 'SIGKILL', killedForMemory: true }));
    const approvals = fakeApprovals('approved');
    await start({ ghRunner: gh.runner, approvals: approvals.approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'result-unknown' });
    expect(String(terminal(messages).message)).toContain('memory');
  });

  it('passes a gh-runner denial through as policy-denied with its code', async () => {
    const gh = fakeGhRunner([], async () => {
      throw new GhRunDeniedError('api-path-not-allowlisted', 'GET /x is not on the read path allowlist');
    });
    await start({ ghRunner: gh.runner });
    const messages = await send(
      request('gh_read', { account: 'member', args: ['pr', 'view', '7', '-R', 'example-org/app'] }),
    );
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'policy-denied' });
    expect(String(terminal(messages).message)).toContain('api-path-not-allowlisted');
  });

  it('maps a full approval queue to too-many-pending-approvals', async () => {
    const gh = fakeGhRunner();
    const approvals: Approvals = {
      request: async () => {
        throw new ApprovalError('too-many-pending-approvals');
      },
      postResult: async () => {},
      release: async () => {},
      close: async () => {},
    };
    await start({ ghRunner: gh.runner, approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'too-many-pending-approvals' });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it.each([
    [
      new ApprovalError(
        'too-many-pending-approvals',
        'approval cards from this session are rate-limited for 42 s after an abandoned card',
        42,
      ),
      ['rate-limited for 42 s after an abandoned card', 'try again in 42 s'],
    ],
    [
      new ApprovalError(
        'too-many-pending-approvals',
        'approval cards are rate-limited: at most 4 new cards per session in 10 min; try again in 7 s',
        7,
      ),
      ['at most 4 new cards per session', 'try again in 7 s'],
    ],
    [new ApprovalError('too-many-pending-approvals'), ['too many approval cards are waiting']],
  ])('passes the approval limit and its retry time to the model (%#)', async (error, parts) => {
    const approvals: Approvals = {
      request: async () => {
        throw error;
      },
      postResult: async () => {},
      release: async () => {},
      close: async () => {},
    };
    await start({ approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    const last = terminal(messages);
    expect(last).toMatchObject({ type: 'error', code: 'too-many-pending-approvals' });
    for (const part of parts) expect(String(last.message)).toContain(part);
    expect(String(last.message).match(/try again in/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it.each([
    ['a card too long to show', 'policy-denied', () => new ApprovalError('card-too-long')],
    ['Slack being unavailable', 'upstream-error', () => new ApprovalError('slack-unavailable')],
    ['a request after close (plain Error)', 'internal', () => new Error('approvals are closed')],
  ])('maps %s to %s and runs nothing', async (_what, code, error) => {
    const gh = fakeGhRunner();
    const approvals: Approvals = {
      request: async () => {
        throw error();
      },
      postResult: async () => {},
      release: async () => {},
      close: async () => {},
    };
    await start({ ghRunner: gh.runner, approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code });
    expect(gh.run).not.toHaveBeenCalled();
  });

  it.each([
    ['used', 'still-executing', /already used/],
    ['closed', 'internal', /shutting down/],
    ['not-approved', 'not-approved', /no longer valid/],
  ] as const)('maps a consume refusal with reason %s to %s and runs nothing', async (reason, code, message) => {
    const gh = fakeGhRunner();
    const approvals: Approvals = {
      request: async (_req, hooks) => {
        hooks.onPending({
          approvalId: 'appr-0003',
          digestPrefix: '0123456789ab',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return {
          outcome: 'approved',
          approvalId: 'appr-0003',
          consume: async () => {
            throw new ApprovalConsumeError('appr-0003', reason);
          },
        };
      },
      postResult: async () => {},
      release: async () => {},
      close: async () => {},
    };
    await start({ ghRunner: gh.runner, approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code });
    expect(String(terminal(messages).message)).toMatch(message);
    expect(gh.run).not.toHaveBeenCalled();
  });

  it('answers internal and runs nothing when consume fails for another reason', async () => {
    const gh = fakeGhRunner();
    const approvals: Approvals = {
      request: async (_req, hooks) => {
        hooks.onPending({
          approvalId: 'appr-0002',
          digestPrefix: '0123456789ab',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return {
          outcome: 'approved',
          approvalId: 'appr-0002',
          consume: async () => {
            throw new Error('disk full');
          },
        };
      },
      postResult: async () => {},
      release: async () => {},
      close: async () => {},
    };
    await start({ ghRunner: gh.runner, approvals });
    const messages = await send(request('gh_write', { account: 'member', args: PR_COMMENT }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'internal' });
    expect(gh.run).not.toHaveBeenCalled();
  });
});

// ── gh_org_member / gh_repo_access ────────────────────────

describe('gh_org_member and gh_repo_access', () => {
  it('reads the current membership, shows it on the card, then adds after approval', async () => {
    const events: string[] = [];
    const github = fakeGithubAdmin(events);
    const approvals = fakeApprovals('approved', { events });
    await start({ githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(request('gh_org_member', { action: 'add', user: 'alice', role: 'member' }));
    expect(terminal(messages)).toMatchObject({ type: 'result', data: { status: 200 } });
    expect(events).toEqual(['read', 'consume', 'github']);
    expect(github.getMembership).toHaveBeenCalledWith(`${GH_TOKEN}-gh-org-admin`, 'example-org', 'alice');
    expect(github.setMembership).toHaveBeenCalledWith(`${GH_TOKEN}-gh-org-admin`, 'example-org', 'alice', 'member');
    const card = approvals.requests[0];
    expect(card.title).toBe('org-admin 계정이 example-org에서 alice의 조직 역할: 현재 멤버 아님 → member로 추가');
    expect(card.details).toContainEqual({ label: '현재 상태', value: '멤버 아님' });
    expect(card.warnings).not.toContain('권한이 낮아짐');
    expect(card.canonical).toMatchObject({ current: { member: false } });
  });

  it('calls an add on an existing owner what it is: a demotion', async () => {
    const github = fakeGithubAdmin();
    github.getMembership.mockResolvedValue({ member: true, role: 'admin', state: 'active' });
    const approvals = fakeApprovals('denied');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    await send(request('gh_org_member', { action: 'add', user: 'alice', role: 'member' }));
    const card = approvals.requests[0];
    expect(card.title).toBe('org-admin 계정이 example-org에서 alice의 조직 역할: 현재 admin → member로 변경');
    expect(card.warnings).toContain('권한이 낮아짐');
    expect(card.canonical).toMatchObject({ current: { member: true, role: 'admin', state: 'active' } });
    expect(github.setMembership).not.toHaveBeenCalled();
  });

  it('shows the current state on a removal', async () => {
    const github = fakeGithubAdmin();
    github.getMembership.mockResolvedValue({ member: true, role: 'admin', state: 'active' });
    const approvals = fakeApprovals('denied');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    await send(request('gh_org_member', { action: 'remove', user: 'alice' }));
    expect(approvals.requests[0].title).toBe('org-admin 계정이 example-org에서 alice의 조직 역할: 현재 admin → 제거');
  });

  it('refuses without a card when the current membership cannot be read', async () => {
    const github = fakeGithubAdmin();
    github.getMembership.mockRejectedValue(new GithubAdminError('upstream-error', 'GitHub answered 502'));
    const approvals = fakeApprovals('approved');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(request('gh_org_member', { action: 'add', user: 'alice', role: 'member' }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'upstream-error' });
    expect(approvals.requests).toHaveLength(0);
    expect(github.setMembership).not.toHaveBeenCalled();
  });

  it('calls a grant on an existing collaborator a change and warns when it lowers access', async () => {
    const github = fakeGithubAdmin();
    github.getCollaboratorPermission.mockResolvedValue({ collaborator: true, permission: 'maintain' });
    const approvals = fakeApprovals('denied');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    await send(
      request('gh_repo_access', { action: 'grant', repo: 'example-org/app', user: 'alice', permission: 'pull' }),
    );
    expect(github.getCollaboratorPermission).toHaveBeenCalledWith(
      `${GH_TOKEN}-gh-org-admin`,
      'example-org',
      'app',
      'alice',
    );
    const card = approvals.requests[0];
    expect(card.title).toBe('org-admin 계정이 example-org/app에서 alice의 레포 권한: 현재 maintain → pull로 변경');
    expect(card.warnings).toContain('권한이 낮아짐');
    expect(card.canonical).toMatchObject({ current: { collaborator: true, permission: 'maintain' } });
  });

  it('grants repo access after approval', async () => {
    const github = fakeGithubAdmin();
    const approvals = fakeApprovals('approved');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(
      request('gh_repo_access', { action: 'grant', repo: 'example-org/app', user: 'alice', permission: 'push' }),
    );
    expect(terminal(messages)).toMatchObject({ type: 'result' });
    expect(approvals.requests[0].title).toBe(
      'org-admin 계정이 example-org/app에서 alice의 레포 권한: 현재 협업자 아님 → push로 추가',
    );
    expect(github.addCollaborator).toHaveBeenCalledWith(
      `${GH_TOKEN}-gh-org-admin`,
      'example-org',
      'app',
      'alice',
      'push',
    );
  });

  it('refuses when the policy holds two org-admin accounts, without a card', async () => {
    const twoAdmins = parsePolicy({
      ...POLICY_JSON,
      gh: {
        ...POLICY_JSON.gh,
        accounts: { ...POLICY_JSON.gh.accounts, 'org-admin-2': { login: 'bob-admin', class: 'org-admin' } },
      },
    });
    const github = fakeGithubAdmin();
    const approvals = fakeApprovals('approved');
    await start({ policy: twoAdmins, githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(request('gh_org_member', { action: 'remove', user: 'alice' }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'policy-denied' });
    expect(approvals.requests).toHaveLength(0);
    expect(github.removeMembership).not.toHaveBeenCalled();
  });

  it.each([
    ['gh_org_member', { action: 'add', user: 'alice-', role: 'member' }, 'bad-request'],
    ['gh_org_member', { action: 'remove', user: 'al--ice' }, 'bad-request'],
    ['gh_repo_access', { action: 'revoke', repo: 'other-org/app', user: 'alice' }, 'policy-denied'],
    ['gh_repo_access', { action: 'revoke', repo: 'example-org/..', user: 'alice' }, 'bad-request'],
    ['gh_repo_access', { action: 'grant', repo: 'example-org/.', user: 'alice', permission: 'pull' }, 'bad-request'],
  ])('%s %j → %s without a card', async (tool, args, code) => {
    const github = fakeGithubAdmin();
    const approvals = fakeApprovals('approved');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(request(tool, args));
    expect(terminal(messages)).toMatchObject({ type: 'error', code });
    expect(approvals.requests).toHaveLength(0);
    for (const fn of Object.values(github)) expect(fn).not.toHaveBeenCalled();
  });

  it('passes result-unknown through, never retries, and records a confirming read', async () => {
    const github = fakeGithubAdmin();
    github.getCollaboratorPermission
      .mockResolvedValueOnce({ collaborator: true, permission: 'push' })
      .mockResolvedValueOnce({ collaborator: false });
    github.removeCollaborator.mockRejectedValue(new GithubAdminError('result-unknown', 'connection reset'));
    const approvals = fakeApprovals('approved');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(
      request('gh_repo_access', { action: 'revoke', repo: 'example-org/app', user: 'alice' }),
    );
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'result-unknown' });
    expect(String(terminal(messages).message)).toContain('협업자 아님');
    expect(github.removeCollaborator).toHaveBeenCalledTimes(1);
    expect(github.getCollaboratorPermission).toHaveBeenCalledTimes(2);
    await waitFor(() => ledgerRows().some((r) => r.tool === 'gh_repo_access'));
    expect(ledgerRows().find((r) => r.tool === 'gh_repo_access')).toMatchObject({
      outcome: 'result-unknown',
      observed: { collaborator: false },
    });
    await waitFor(() => approvals.results.length === 1);
    expect(approvals.results[0]).toContain('조회 결과: 협업자 아님');
  });

  it('records an unavailable confirming read on result-unknown', async () => {
    const github = fakeGithubAdmin();
    github.getMembership
      .mockResolvedValueOnce({ member: true, role: 'member', state: 'active' })
      .mockRejectedValueOnce(new GithubAdminError('upstream-error', 'GitHub answered 502'));
    github.setMembership.mockRejectedValue(new GithubAdminError('result-unknown', 'connection reset'));
    const approvals = fakeApprovals('approved');
    await start({ githubAdmin: github, approvals: approvals.approvals });
    const messages = await send(request('gh_org_member', { action: 'set-role', user: 'alice', role: 'admin' }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'result-unknown' });
    expect(github.setMembership).toHaveBeenCalledTimes(1);
    await waitFor(() => ledgerRows().some((r) => r.tool === 'gh_org_member'));
    expect(ledgerRows().find((r) => r.tool === 'gh_org_member')).toMatchObject({
      outcome: 'result-unknown',
      observed: 'unavailable',
    });
  });
});

// ── Cloudflare ────────────────────────────────────────────

describe('cf_lease_request', () => {
  const base = {
    env: 'dev2',
    access: 'edit',
    permissions: ['dns-edit-group'],
    zones: ['example.com'],
    reason: 'rotate a record',
  };

  it.each([
    [{ ...base, permissions: ['account-settings-write'] }, 'policy-denied'],
    [{ ...base, access: 'read', permissions: ['dns-edit-group'] }, 'policy-denied'],
    [{ ...base, zones: ['other.example.com'] }, 'policy-denied'],
    [{ ...base, ttl: '72h' }, 'bad-request'],
    [{ ...base, ttl: '48h' }, 'policy-denied'],
    [{ ...base, env: 'constructor' }, 'unknown-env'],
    [{ ...base, env: 'stage9' }, 'unknown-env'],
  ])('%j → %s without a card', async (args, code) => {
    const cfLeases = fakeLeases();
    const approvals = fakeApprovals('approved');
    await start({ cfLeases, approvals: approvals.approvals });
    const messages = await send(request('cf_lease_request', args));
    expect(terminal(messages)).toMatchObject({ type: 'error', code });
    expect(approvals.requests).toHaveLength(0);
    expect(cfLeases.mint).not.toHaveBeenCalled();
  });

  it('mints a lease after approval and returns the lease view, never a key', async () => {
    const events: string[] = [];
    const cfLeases = fakeLeases();
    cfLeases.mint.mockImplementation(async (input: { leaseId: string }) => {
      events.push('mint');
      return leaseView({ leaseId: input.leaseId, access: 'edit' });
    });
    const approvals = fakeApprovals('approved', { events });
    await start({ cfLeases, approvals: approvals.approvals });
    const messages = await send(request('cf_lease_request', { ...base, ttl: '2h' }));
    expect(messages.map((m) => m.type)).toEqual(['pending', 'result']);
    expect(events).toEqual(['consume', 'mint']);
    const input = cfLeases.mint.mock.calls[0][0] as {
      leaseId: string;
      scope: unknown;
      ttlSeconds: number;
      approvalId: string;
    };
    expect(input.leaseId).toMatch(/^[0-9a-f]{32}$/);
    expect(input).toEqual({
      leaseId: input.leaseId,
      scope: { env: 'dev2', access: 'edit', permissionGroupIds: ['dns-edit-group'], zoneIds: [ONE_ID] },
      ttlSeconds: 7200,
      approvalId: 'appr-0001',
    });
    expect(terminal(messages).data).toEqual(leaseView({ leaseId: input.leaseId, access: 'edit' }));
    const card = approvals.requests[0];
    expect(card.details.map((d) => d.label)).toEqual(['환경', '권한', '존', '수명', '사유']);
    expect(card.details.find((d) => d.label === '권한')?.value).toContain('DNS Write');
    expect(card.details.find((d) => d.label === '수명')?.value).toBe('2h');
  });

  it('uses the policy default TTL and falls back to ids when group names are unavailable', async () => {
    const cfLeases = fakeLeases();
    cfLeases.permissionGroupNames.mockRejectedValue(new Error('cloudflare down'));
    const approvals = fakeApprovals('denied');
    await start({ cfLeases, approvals: approvals.approvals });
    const messages = await send(request('cf_lease_request', { ...base, zones: [] }));
    expect(terminal(messages)).toMatchObject({ code: 'not-approved', reason: 'denied' });
    const card = approvals.requests[0];
    expect(card.details.find((d) => d.label === '권한')?.value).toContain('dns-edit-group');
    expect(card.details.find((d) => d.label === '수명')?.value).toBe('1h');
    expect(card.canonical).toMatchObject({ ttlSeconds: 3600, zoneIds: [] });
    expect(card.details.find((d) => d.label === '존')?.value).toBe('계정 전체 (계정의 모든 존에 적용될 수 있음)');
    expect(card.title).toContain('계정 전체');
  });
});

describe('cf_api and cf_lease_revoke', () => {
  it('delegates a call to the lease with the claimed session', async () => {
    const cfLeases = fakeLeases();
    const approvals = fakeApprovals('approved');
    await start({ cfLeases, approvals: approvals.approvals });
    const messages = await send(
      request('cf_api', { lease: LEASE_ID, method: 'GET', path: `/zones/${ONE_ID}/dns_records`, query: { page: '1' } }),
    );
    expect(terminal(messages)).toMatchObject({ type: 'result', data: { status: 200, body: { success: true } } });
    expect(cfLeases.call).toHaveBeenCalledWith(
      LEASE_ID,
      { method: 'GET', path: `/zones/${ONE_ID}/dns_records`, query: { page: '1' } },
      { sessionKey: 'session-1' },
    );
    expect(approvals.requests).toHaveLength(0);
  });

  it.each([
    'lease-not-found',
    'lease-expired',
    'lease-out-of-scope',
    'upstream-error',
  ])('maps a cf-client %s error to the protocol code', async (code) => {
    const cfLeases = fakeLeases();
    cfLeases.call.mockRejectedValue(Object.assign(new Error(`lease problem: ${code}`), { code }));
    await start({ cfLeases });
    const messages = await send(request('cf_api', { lease: LEASE_ID, method: 'GET', path: '/zones' }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code });
  });

  it('maps an unknown cf-client error to internal', async () => {
    const cfLeases = fakeLeases();
    cfLeases.revoke.mockRejectedValue(new Error('surprise'));
    await start({ cfLeases });
    const messages = await send(request('cf_lease_revoke', { lease: LEASE_ID }));
    expect(terminal(messages)).toMatchObject({ type: 'error', code: 'internal' });
  });

  it('revokes a lease without a card', async () => {
    const cfLeases = fakeLeases();
    const approvals = fakeApprovals('approved');
    await start({ cfLeases, approvals: approvals.approvals });
    const messages = await send(request('cf_lease_revoke', { lease: LEASE_ID }));
    expect(terminal(messages)).toMatchObject({ type: 'result', data: { leaseId: LEASE_ID, state: 'revoked' } });
    expect(cfLeases.revoke).toHaveBeenCalledWith(LEASE_ID, expect.any(String));
    expect(approvals.requests).toHaveLength(0);
  });
});
