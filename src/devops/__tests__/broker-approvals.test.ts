import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devopsBrokerAdminApprovalAdapter, devopsBrokerSocketPath } from '../broker-approvals';

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
