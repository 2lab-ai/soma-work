import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  devopsApprovalsAppUrl,
  devopsBrokerAdminApprovalAdapter,
  devopsBrokerSocketPath,
  devopsPendingDir,
} from '../broker-approvals';

// devops broker cards in the dashboard's admin approvals (#1051): the adapter reads the broker's waiting cards
// over its socket and points the admin at their own Slack card. It never decides: this process runs as the same
// OS user as the model, so a decision relayed from here would let the model approve its own request.

const VIEW = {
  approvalId: 'appr_0001abcd',
  tool: 'cf_lease_request',
  title: 'Cloudflare 단기 키를 발급합니다',
  requester: 'U000ALICE',
  digestPrefix: '0123456789ab',
  createdAt: '2026-11-09T03:00:00.000Z',
  expiresAt: '2026-11-09T03:10:00.000Z',
  cards: [
    { admin: 'U000ADMIN', permalink: 'https://example.slack.com/archives/D000ADMIN/p1700000000000001' },
    { admin: 'U000ADMINB' },
  ],
};

let dir: string;
let socketPath: string;
let server: net.Server | undefined;
let received: Record<string, unknown>[];

/** A broker that answers each admin op line with `reply(req)` as its result data. */
async function fakeBroker(reply: (req: Record<string, unknown>) => unknown): Promise<void> {
  server = net.createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const nl = buffered.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buffered.slice(0, nl)) as Record<string, unknown>;
      received.push(req);
      socket.end(`${JSON.stringify({ v: 1, id: req.id, type: 'result', data: reply(req) })}\n`);
    });
  });
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-approvals-'));
  socketPath = path.join(dir, 'broker.sock');
  received = [];
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('devopsBrokerAdminApprovalAdapter', () => {
  it('shows each waiting broker card as a card whose one choice opens the admin’s own Slack card', async () => {
    await fakeBroker(() => ({ approvals: [VIEW] }));
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath });
    const [card] = await adapter.pending(Date.parse('2026-11-09T03:01:00Z'));
    expect(received[0]).toMatchObject({ v: 1, op: 'approvals', args: {} });
    expect(card).toMatchObject({
      id: 'devops_broker:appr_0001abcd',
      kind: 'devops_broker',
      card: 'question',
      title: 'Cloudflare 단기 키를 발급합니다',
      tool: 'devops:cf_lease_request',
      requesterId: 'U000ALICE',
      createdAt: Date.parse(VIEW.createdAt),
      expiresAt: Date.parse(VIEW.expiresAt),
      choices: [{ id: 'open_slack', label: expect.stringContaining('Slack') }],
      recommendedId: 'open_slack',
      links: [{ admin: 'U000ADMIN', url: 'https://example.slack.com/archives/D000ADMIN/p1700000000000001' }],
    });
    expect(card.description).toContain('Slack');
  });

  it('lists nothing (and does not throw) on a host without a broker', async () => {
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath: path.join(dir, 'missing.sock') });
    await expect(adapter.pending(Date.now())).resolves.toEqual([]);
  });

  it('drops a card past its deadline and ignores a malformed listing', async () => {
    await fakeBroker(() => ({ approvals: [VIEW, { approvalId: 7 }] }));
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath });
    await expect(adapter.pending(Date.parse(VIEW.expiresAt) + 1)).resolves.toEqual([]);
    const [only, ...rest] = await adapter.pending(Date.parse('2026-11-09T03:01:00Z'));
    expect(only.id).toBe('devops_broker:appr_0001abcd');
    expect(rest).toEqual([]);
  });

  it('never decides: every dashboard answer is refused without reaching the broker', async () => {
    await fakeBroker(() => ({ approvals: [] }));
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath });
    for (const choice of ['approve', 'deny', 'open_slack']) {
      await expect(adapter.answer('appr_0001abcd', choice, 'U000ADMIN')).resolves.toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(received).toEqual([]);
    expect(await adapter.resolved(0)).toEqual([]);
  });
});

describe('devopsBrokerAdminApprovalAdapter: polling and links (#1051 review)', () => {
  it('links only to Slack: another https host is dropped', async () => {
    await fakeBroker(() => ({
      approvals: [
        {
          ...VIEW,
          cards: [
            { admin: 'U000ADMIN', permalink: 'https://evil.example/archives/D1/p1' },
            { admin: 'U000ADMINB', permalink: 'https://example.slack.com.evil.example/archives/D2/p2' },
          ],
        },
      ],
    }));
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath });
    const [card] = await adapter.pending(Date.parse('2026-11-09T03:01:00Z'));
    expect(card.links).toEqual([]);
  });

  it('asks the broker at most once per refresh interval', async () => {
    await fakeBroker(() => ({ approvals: [VIEW] }));
    let clock = Date.parse('2026-11-09T03:01:00Z');
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath, now: () => clock });
    await adapter.pending(clock);
    clock += 1000;
    await adapter.pending(clock);
    expect(received).toHaveLength(1);
    clock += 5000;
    await adapter.pending(clock);
    expect(received).toHaveLength(2);
  });

  it('backs off a broker that refuses the listing (an older build), so its ledger is not flooded', async () => {
    server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', () => {
        received.push({});
        socket.end(
          `${JSON.stringify({ v: 1, id: null, type: 'error', code: 'bad-request', message: 'unknown key "op"' })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
    let clock = Date.parse('2026-11-09T03:01:00Z');
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath, now: () => clock });
    await expect(adapter.pending(clock)).resolves.toEqual([]);
    clock += 60_000;
    await adapter.pending(clock);
    expect(received).toHaveLength(1);
    clock += 10 * 60_000;
    await adapter.pending(clock);
    expect(received).toHaveLength(2);
  });

  it('reads the socket path from config.json devops-tools.socketPath when it is absolute', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ 'devops-tools': { socketPath: '/var/run/x/broker.sock' } }));
    expect(devopsBrokerSocketPath(file)).toBe('/var/run/x/broker.sock');
    fs.writeFileSync(file, JSON.stringify({ 'devops-tools': { socketPath: 'relative.sock' } }));
    expect(devopsBrokerSocketPath(file)).toBeUndefined();
    expect(devopsBrokerSocketPath(path.join(dir, 'missing.json'))).toBeUndefined();
  });
});

describe('devopsBrokerAdminApprovalAdapter: a broker older than the listing (#1051, no root upgrade first)', () => {
  const APP = 'https://example.slack.com/app_redirect?app=A0000APP';
  const RECORD = {
    v: 1,
    approvalId: 'appr_0002efgh',
    requestId: 'req-1',
    pid: process.pid,
    tool: 'cf_lease_request',
    digestPrefix: 'abcdef012345',
    requester: 'U000ALICE',
    createdAt: '2026-11-09T03:00:00.000Z',
    expiresAt: '2026-11-09T03:10:00.000Z',
  };
  const NOW = Date.parse('2026-11-09T03:01:00Z');
  let pendingDir: string;

  const nameOf = (r: { approvalId: string; requestId: string }) => `${r.approvalId}.${r.requestId}.json`;
  function writeRecord(name: string, body: unknown): string {
    const file = path.join(pendingDir, name);
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  }
  const put = (r: typeof RECORD) => writeRecord(nameOf(r), r);

  async function refusingBroker(): Promise<void> {
    server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', () => {
        received.push({});
        socket.end(
          `${JSON.stringify({ v: 1, id: null, type: 'error', code: 'bad-request', message: 'unknown key "op"' })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
  }

  /** The pid of a process that has exited. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    return child.pid as number;
  }

  beforeEach(() => {
    pendingDir = devopsPendingDir(dir);
    fs.mkdirSync(pendingDir);
  });

  it('lists the MCP server’s records, each opening the approvals app DM for any admin', async () => {
    await refusingBroker();
    put(RECORD);
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath, pendingDir, approvalsAppUrl: APP });
    const [card, ...rest] = await adapter.pending(NOW);
    expect(rest).toEqual([]);
    expect(card).toMatchObject({
      id: 'devops_broker:appr_0002efgh',
      kind: 'devops_broker',
      card: 'question',
      tool: 'devops:cf_lease_request',
      requesterId: 'U000ALICE',
      expiresAt: Date.parse(RECORD.expiresAt),
      choices: [{ id: 'open_slack', label: expect.stringContaining('Slack') }],
      links: [{ admin: '*', url: APP }],
    });
    expect(card.title).toContain('abcdef012345');
    // Written by the model's OS user: the card says it is only a pointer.
    expect(card.description).toContain('보장하지 않습니다');
    expect(await adapter.answer('appr_0002efgh', 'open_slack', 'U000ADMIN')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('shows one card for identical requests joined to the same card', async () => {
    await refusingBroker();
    put(RECORD);
    put({ ...RECORD, requestId: 'req-2', createdAt: '2026-11-09T03:00:30.000Z' });
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath, pendingDir, approvalsAppUrl: APP });
    const cards = await adapter.pending(NOW);
    expect(cards.map((c) => c.id)).toEqual(['devops_broker:appr_0002efgh']);
    expect(cards[0].createdAt).toBe(Date.parse(RECORD.createdAt));
  });

  it('skips malformed, misnamed and expired records, and removes long-dead ones', async () => {
    await refusingBroker();
    put({ ...RECORD, approvalId: 'appr_0003ijkl', tool: 'rm_rf' });
    writeRecord('appr_0004mnop.req-1.json', { ...RECORD, approvalId: 'appr_0005qrst' });
    writeRecord('appr_0006uvwx.req-1.json', '{not json');
    writeRecord('notes.txt', RECORD);
    writeRecord('appr_0002efgh.json', RECORD);
    put({ ...RECORD, approvalId: 'appr_0007yzab', expiresAt: '2026-11-09T03:00:30.000Z' });
    const dead = put({ ...RECORD, approvalId: 'appr_0008cdef', expiresAt: '2026-11-09T01:00:00.000Z' });
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath, pendingDir, approvalsAppUrl: APP });
    await expect(adapter.pending(NOW)).resolves.toEqual([]);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it('removes a record whose MCP server is gone (killed before it could)', async () => {
    await refusingBroker();
    const gone = put({ ...RECORD, pid: await deadPid() });
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath, pendingDir, approvalsAppUrl: APP });
    await expect(adapter.pending(NOW)).resolves.toEqual([]);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('never follows a link and never reads an oversized record', async () => {
    await refusingBroker();
    const elsewhere = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify(RECORD));
    fs.symlinkSync(elsewhere, path.join(pendingDir, nameOf(RECORD)));
    const big = { ...RECORD, approvalId: 'appr_0009ghij' };
    writeRecord(nameOf(big), JSON.stringify(big).replace(/}$/, `,"pad":"${'x'.repeat(5000)}"}`));
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath, pendingDir, approvalsAppUrl: APP });
    await expect(adapter.pending(NOW)).resolves.toEqual([]);
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it('ignores the records while the broker lists its own cards, but still prunes the dead ones', async () => {
    await fakeBroker(() => ({ approvals: [VIEW] }));
    put(RECORD);
    const gone = put({ ...RECORD, approvalId: 'appr_0010klmn', pid: await deadPid() });
    const adapter = devopsBrokerAdminApprovalAdapter({ socketPath, pendingDir, approvalsAppUrl: APP });
    const cards = await adapter.pending(NOW);
    expect(cards.map((c) => c.id)).toEqual(['devops_broker:appr_0001abcd']);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('re-reads the records every refresh while the refusing broker is left alone', async () => {
    await refusingBroker();
    let clock = NOW;
    const adapter = devopsBrokerAdminApprovalAdapter({
      socketPath,
      pendingDir,
      approvalsAppUrl: APP,
      now: () => clock,
    });
    await expect(adapter.pending(clock)).resolves.toEqual([]);
    put(RECORD);
    clock += 5_000;
    const cards = await adapter.pending(clock);
    expect(cards.map((c) => c.id)).toEqual(['devops_broker:appr_0002efgh']);
    expect(received).toHaveLength(1);
  });

  it('a card without a configured app link has no link (the client says where to look)', async () => {
    await refusingBroker();
    put(RECORD);
    for (const approvalsAppUrl of [undefined, 'https://evil.example/app_redirect?app=A0000APP']) {
      const adapter = devopsBrokerAdminApprovalAdapter({ socketPath, pendingDir, approvalsAppUrl });
      const [card] = await adapter.pending(NOW);
      expect(card.links).toEqual([]);
    }
  });

  it('reads devops-tools.approvalsAppUrl only as a Slack app_redirect link', () => {
    const file = path.join(dir, 'config.json');
    const cases: [unknown, string | undefined][] = [
      [APP, APP],
      [`${APP}&team=T0000TEAM`, `${APP}&team=T0000TEAM`],
      ['https://example.slack.com/archives/D1/p1', undefined],
      ['http://example.slack.com/app_redirect?app=A0000APP', undefined],
      ['https://example.slack.com.evil.example/app_redirect?app=A0000APP', undefined],
      [42, undefined],
    ];
    for (const [approvalsAppUrl, expected] of cases) {
      fs.writeFileSync(file, JSON.stringify({ 'devops-tools': { approvalsAppUrl } }));
      expect(devopsApprovalsAppUrl(file)).toBe(expected);
    }
  });
});
