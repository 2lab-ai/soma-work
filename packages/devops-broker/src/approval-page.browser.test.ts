import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalState,
  type Approvals,
  createApprovals,
  initialApprovalState,
} from './approval.js';
import { type ApprovalPage, startApprovalPage } from './approval-page.js';
import { Ledger } from './ledger.js';
import { createPasskeys, initialPasskeyState, PASSKEY_STATE_FILE, type Passkeys } from './passkeys.js';
import type { BrokerPolicy } from './policy.js';
import { createSlackApi } from './slack-api.js';
import { StateStore } from './state.js';
import { relyingParty } from './webauthn.js';

// The approval page in a real browser (#1056): headless Chromium with a virtual platform authenticator
// (user verification on) against the real page server, the real approvals and a local fake Slack. This is the
// check that the bytes a browser really sends pass the broker's WebAuthn checks, and that the page's own
// headers hold in a browser. Skipped (with a line saying so) only where Chromium cannot start.

interface FakeMessage {
  channel: string;
  ts: string;
  updates: { text: string; blocks: unknown[] | undefined }[];
}
interface FakeSlack {
  apiBase: string;
  cards(channel: string): FakeMessage[];
  close(): Promise<void>;
}
const { startFakeSlack } = createRequire(__filename)('./__fixtures__/fake-slack.cjs') as {
  startFakeSlack(opts: { token: string }): Promise<FakeSlack>;
};

const HOST = 'approve.home.arpa';
const ADMIN = 'U000ADMIN';
const TOKEN = ['xoxb', 'fake', 'broker', 'app', 'not', 'real'].join('-');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

let dir: string;
let origin: string;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let skipReason: string | undefined;
let fake: FakeSlack;
let approvals: Approvals;
let passkeys: Passkeys;
let server: ApprovalPage;
let outside: http.Server;
let outsidePort: number;
let ledgerFile: string;

function rows(): Record<string, unknown>[] {
  return fs
    .readFileSync(ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function request(n: number): ApprovalRequest {
  const argv = [
    'pr',
    'comment',
    String(n),
    '-R',
    'example-org/repo',
    '--body',
    `<img src=x onerror="document.title='pwned'">`,
  ];
  return {
    tool: 'gh_write',
    title: `member 계정으로 example-org/repo PR ${n}에 댓글을 단다`,
    details: [{ label: '계정', value: 'member' }],
    argv,
    warnings: ['CI 코드 실행 가능'],
    claimedRequester: { slackUserId: 'U000ALICE', sessionKey: `C000CHAN:1700000000.00010${n}` },
    canonical: { account: 'member', args: argv },
  };
}

async function waiting(n: number): Promise<{ approvalId: string; result: Promise<ApprovalOutcome> }> {
  const pending: { approvalId: string }[] = [];
  const result = approvals.request(request(n), { onPending: (p) => pending.push(p) });
  const deadline = Date.now() + 5000;
  while (pending.length === 0) {
    if (Date.now() > deadline) throw new Error('the card did not open');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { approvalId: pending[0].approvalId, result };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-page-browser-'));
  const port = await freePort();
  origin = `https://${HOST}:${port}`;
  // A certificate for the page host; Chromium is told to accept exactly this key.
  const config = path.join(dir, 'req.cnf');
  fs.writeFileSync(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${HOST}\n[ext]\nsubjectAltName=DNS:${HOST}\n`,
  );
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  for (const args of [
    ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyFile],
    ['req', '-new', '-x509', '-key', keyFile, '-out', certFile, '-days', '2', '-config', config],
  ]) {
    const made = spawnSync('openssl', args, { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`openssl ${args[0]} failed: ${made.stderr}`);
  }
  const cert = fs.readFileSync(certFile);
  const spki = createHash('sha256')
    .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');

  fake = await startFakeSlack({ token: TOKEN });
  ledgerFile = path.join(dir, 'state', 'ledger.jsonl');
  const ledger = new Ledger(ledgerFile);
  const policy: BrokerPolicy = {
    admins: [ADMIN],
    gh: {
      org: 'example-org',
      allowedOwners: ['example-org'],
      accounts: { member: { login: 'alice', class: 'member' } },
      restWriteAllowlist: [],
    },
    cloudflare: {},
    approvalTimeoutSeconds: 300,
    maxPendingApprovals: 3,
    approvalPage: { origin, rpId: HOST, listenHost: '127.0.0.1', port },
  };
  const store = new StateStore<ApprovalState>(path.join(dir, 'state', 'approvals.json'), initialApprovalState());
  await store.load();
  approvals = createApprovals({
    policy,
    slack: createSlackApi({ token: TOKEN, apiBase: fake.apiBase }),
    store,
    ledger,
    pollIntervalMs: 50,
    pageOrigin: () => origin,
    log: () => undefined,
  });
  passkeys = createPasskeys({
    rp: relyingParty(origin),
    isAdmin: (user) => policy.admins.includes(user),
    store: new StateStore(path.join(dir, 'state', PASSKEY_STATE_FILE), initialPasskeyState()),
    ledger,
  });
  server = await startApprovalPage({
    page: policy.approvalPage as NonNullable<BrokerPolicy['approvalPage']>,
    tls: { cert, key: fs.readFileSync(keyFile) },
    approvals,
    passkeys,
    log: () => undefined,
  });
  // Another site (it stands for the dashboard, or anything else): it tries to frame the page and to post to it.
  outside = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>outside</title><body></body>');
  });
  outsidePort = await new Promise<number>((resolve) =>
    outside.listen(0, '127.0.0.1', () => resolve((outside.address() as net.AddressInfo).port)),
  );

  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spki}`],
    });
    context = await browser.newContext();
  } catch (err) {
    skipReason = `Chromium could not start (${err instanceof Error ? err.message.split('\n')[0] : 'error'})`;
    process.stderr.write(`approval-page.browser.test: SKIPPED — ${skipReason}\n`);
  }
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.close();
  await approvals?.close();
  await fake?.close();
  await new Promise((resolve) => outside?.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A new tab with a platform authenticator that verifies the user (Touch ID stand-in). */
async function tab(): Promise<Page> {
  if (context === undefined) throw new Error('no browser');
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return page;
}

describe('the approval page in Chromium', () => {
  // One tab for the whole flow: the virtual authenticator (and the passkey it holds) lives in it.
  let page: Page;

  it('enrols a passkey: the code comes from the address, the fingerprint goes back through the operator', async (ctx) => {
    if (skipReason !== undefined) return ctx.skip();
    page = await tab();
    const started = passkeys.startEnrolment(ADMIN);
    await page.goto(`${origin}/enroll#${started.code}`);
    // The code left the address bar.
    await page.waitForFunction(() => document.getElementById('create')?.hasAttribute('disabled') === false);
    expect(page.url()).toBe(`${origin}/enroll`);
    await page.click('#create');
    await page.waitForFunction(() => (document.getElementById('fingerprint')?.textContent ?? '').length > 0);
    const fingerprint = (await page.textContent('#fingerprint')) ?? '';
    expect(fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    // The page cannot finish alone.
    expect(await passkeys.list()).toEqual([]);
    expect(await passkeys.confirm(started.enrolmentId, fingerprint)).toBe('enrolled');
    expect((await passkeys.list()).map((p) => p.fingerprint)).toEqual([fingerprint]);
    // The enrol page is gone again.
    const after = await page.goto(`${origin}/enroll`);
    expect(after?.status()).toBe(404);
  }, 60_000);

  it('approves a card: the page shows the request as text, the buttons arm after a pause, Touch ID decides', async (ctx) => {
    if (skipReason !== undefined) return ctx.skip();
    const { approvalId, result } = await waiting(1);
    expect(approvals.pending()[0].pageUrl).toBe(`${origin}/a/${approvalId}`);
    const opened = Date.now();
    await page.goto(`${origin}/a/${approvalId}`);
    await page.waitForSelector('#card:not([hidden])');
    expect(await page.textContent('#title')).toBe(request(1).title);
    expect(await page.textContent('#header')).toBe('GitHub 쓰기 승인 요청');
    expect(await page.textContent('#warnings')).toContain('CI 코드 실행 가능');
    // The argument that looks like markup is shown as its JSON string, not run.
    const command = (await page.textContent('#command')) ?? '';
    expect(command).toContain('gh pr comment 1 -R example-org/repo --body');
    expect(command).toContain(JSON.stringify(request(1).argv?.[6]));
    expect(await page.locator('#command img').count()).toBe(0);
    expect(await page.title()).toBe('devops 승인');
    // Not armed yet: the buttons are disabled right after the page appears.
    if (Date.now() - opened < 1200) expect(await page.isDisabled('#approve')).toBe(true);
    await page.waitForFunction(() => document.getElementById('approve')?.hasAttribute('disabled') === false);
    expect(Date.now() - opened).toBeGreaterThanOrEqual(1400);
    await page.click('#approve');
    await page.waitForFunction(() => (document.getElementById('status')?.textContent ?? '').includes('승인했습니다'));
    const outcome = await result;
    expect(outcome).toMatchObject({ outcome: 'approved', approvalId });
    if (outcome.outcome === 'approved') await outcome.consume();
    const mine = rows().filter((row) => row.approvalId === approvalId);
    const evidence = mine.find((row) => row.event === 'approval.passkey-decision');
    expect(evidence).toMatchObject({ admin: ADMIN, action: 'approve', via: 'passkey' });
    // What the browser signed names this page's origin, and nothing else.
    const clientData = JSON.parse(Buffer.from(String(evidence?.clientDataJSON), 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(clientData).toMatchObject({ type: 'webauthn.get', origin, crossOrigin: false });
    expect(mine.find((row) => row.event === 'approval.approved')).toMatchObject({ by: ADMIN });
    // The admin's Slack card says the same.
    const card = fake.cards(`D${ADMIN.slice(1)}`).at(-1);
    const deadline = Date.now() + 5000;
    while ((card?.updates.length ?? 0) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(JSON.stringify(card?.updates.at(-1))).toContain('승인됨');
  }, 60_000);

  it('denies a card with 거부, and a decided card shows as gone', async (ctx) => {
    if (skipReason !== undefined) return ctx.skip();
    const { approvalId, result } = await waiting(2);
    await page.goto(`${origin}/a/${approvalId}`);
    await page.waitForFunction(() => document.getElementById('deny')?.hasAttribute('disabled') === false);
    await page.click('#deny');
    await page.waitForFunction(() => (document.getElementById('status')?.textContent ?? '').includes('거부했습니다'));
    await expect(result).resolves.toMatchObject({ outcome: 'denied' });
    await page.goto(`${origin}/a/${approvalId}`);
    await page.waitForFunction(() =>
      (document.getElementById('status')?.textContent ?? '').includes('이미 결정됐거나'),
    );
    expect(await page.isHidden('#card')).toBe(true);
  }, 60_000);

  it('another site can neither frame the page, nor read it, nor post a decision to it', async (ctx) => {
    if (skipReason !== undefined) return ctx.skip();
    const { approvalId, result } = await waiting(3);
    const other = await tab();
    await other.goto(`http://127.0.0.1:${outsidePort}/`);
    const probe = await other.evaluate(
      async ({ target, id }) => {
        const frame = document.createElement('iframe');
        frame.src = `${target}/a/${id}`;
        document.body.appendChild(frame);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        let framed = 'blocked';
        try {
          // A blocked frame is an error page with no access; a loaded one would still be cross-origin.
          framed =
            frame.contentDocument === null ? 'cross-origin' : `same:${frame.contentDocument.body.childElementCount}`;
        } catch {
          framed = 'cross-origin';
        }
        const read = await fetch(`${target}/api/card/${id}`).then(
          () => 'readable',
          () => 'unreadable',
        );
        const post = await fetch(`${target}/api/challenge`, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ approvalId: id }),
        }).then(
          (response) => `sent:${response.type}`,
          () => 'failed',
        );
        let passkey = 'no-error';
        try {
          await navigator.credentials.get({
            publicKey: { challenge: new Uint8Array(32), rpId: 'approve.home.arpa', userVerification: 'required' },
          });
        } catch (err) {
          passkey = (err as Error).name;
        }
        return { framed, read, post, passkey };
      },
      { target: origin, id: approvalId },
    );
    // The frame shows nothing of the page (frame-ancestors 'none'): Chromium replaces it with an error document.
    expect(probe.framed).not.toMatch(/^same:[1-9]/);
    expect(probe.read).toBe('unreadable');
    // A no-cors post leaves the browser but the page refuses it (wrong content type and origin): nothing changed.
    expect(probe.post === 'failed' || probe.post === 'sent:opaque').toBe(true);
    // Another origin cannot ask for this page's passkey at all.
    expect(probe.passkey).toBe('SecurityError');
    expect(approvals.describe(approvalId)).toBeDefined();
    expect(rows().some((row) => row.approvalId === approvalId && row.event === 'approval.passkey-decision')).toBe(
      false,
    );
    await other.close();
    // Clean up the waiting card through the page itself.
    await page.goto(`${origin}/a/${approvalId}`);
    await page.waitForFunction(() => document.getElementById('deny')?.hasAttribute('disabled') === false);
    await page.click('#deny');
    await expect(result).resolves.toMatchObject({ outcome: 'denied' });
  }, 60_000);
});
