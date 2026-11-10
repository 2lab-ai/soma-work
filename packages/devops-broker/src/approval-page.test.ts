import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticatorData,
  clientData,
  FLAG_AT,
  FLAG_UP,
  FLAG_UV,
  type SoftPasskey,
  signAssertion,
  softPasskey,
} from './__fixtures__/soft-authenticator.js';
import type { ApprovalDescription, VerifiedDecision } from './approval.js';
import { type ApprovalPage, CHALLENGE_TTL_MS, loadPageTls, startApprovalPage } from './approval-page.js';
import { Ledger } from './ledger.js';
import { createPasskeys, initialPasskeyState, PASSKEY_STATE_FILE, type Passkeys } from './passkeys.js';
import type { ApprovalPagePolicy } from './policy.js';
import { StateStore } from './state.js';
import { relyingParty } from './webauthn.js';

const HOST = 'approve.home.arpa';
const ADMIN = 'U0ADMIN0001';
const APPROVAL = 'approval-id-0001-aaaaaa';
const OTHER_APPROVAL = 'approval-id-0002-bbbbbb';
const DIGEST = 'a'.repeat(64);

let certDir: string;
let cert: Buffer;
let key: Buffer;

/** A throwaway certificate for the page host, made with the system openssl (LibreSSL on macOS). */
beforeAll(() => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-page-tls-'));
  fs.chmodSync(certDir, 0o700);
  const config = path.join(certDir, 'req.cnf');
  fs.writeFileSync(
    config,
    [
      '[req]',
      'distinguished_name=dn',
      'x509_extensions=ext',
      'prompt=no',
      '[dn]',
      `CN=${HOST}`,
      '[ext]',
      `subjectAltName=DNS:${HOST}`,
    ].join('\n'),
  );
  const run = (args: string[]) => {
    const result = spawnSync('openssl', args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
  };
  run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(certDir, 'key.pem')]);
  run([
    'req',
    '-new',
    '-x509',
    '-key',
    path.join(certDir, 'key.pem'),
    '-out',
    path.join(certDir, 'cert.pem'),
    '-days',
    '2',
    '-config',
    config,
  ]);
  fs.rmSync(config);
  fs.chmodSync(path.join(certDir, 'key.pem'), 0o600);
  cert = fs.readFileSync(path.join(certDir, 'cert.pem'));
  key = fs.readFileSync(path.join(certDir, 'key.pem'));
});
afterAll(() => {
  fs.rmSync(certDir, { recursive: true, force: true });
});

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

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown>;
}

let dir: string;
let now: number;
let policy: ApprovalPagePolicy;
let origin: string;
let passkeys: Passkeys;
let page: ApprovalPage | undefined;
let cards: Map<string, ApprovalDescription>;
let decisions: VerifiedDecision[];
let decideResult: 'approved' | 'denied' | 'expired' | 'cancelled' | 'ignored' | undefined;
let describeThrows: boolean;
let logged: string[];

function description(approvalId: string, digest = DIGEST): ApprovalDescription {
  return {
    approvalId,
    digest,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    tool: 'gh_write',
    header: 'GitHub 쓰기 승인 요청',
    title: 'member 계정으로 example-org/repo PR 1에 댓글을 단다',
    warnings: ['CI 코드 실행 가능'],
    argv: ['pr', 'comment', '1', '-R', 'example-org/repo', '--body', 'hi <b>there</b>'],
    details: [{ label: '계정', value: 'member' }],
    requester: 'U000ALICE',
    sessionKey: 'C000CHAN:1700000000.000100',
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-page-'));
  now = Date.parse('2026-11-10T04:00:00Z');
  const port = await freePort();
  origin = `https://${HOST}:${port}`;
  policy = { origin, rpId: HOST, listenHost: '127.0.0.1', port };
  passkeys = createPasskeys({
    rp: relyingParty(origin),
    isAdmin: (user) => user === ADMIN,
    store: new StateStore(path.join(dir, PASSKEY_STATE_FILE), initialPasskeyState()),
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
    now: () => now,
  });
  cards = new Map([[APPROVAL, description(APPROVAL)]]);
  decisions = [];
  decideResult = undefined;
  describeThrows = false;
  logged = [];
  page = await startApprovalPage({
    page: policy,
    tls: { cert, key },
    approvals: {
      describe: (approvalId) => {
        if (describeThrows) throw new Error('boom');
        return cards.get(approvalId);
      },
      decideVerified: async (decision) => {
        decisions.push(decision);
        return decideResult ?? (decision.action === 'approve' ? 'approved' : 'denied');
      },
    },
    passkeys,
    now: () => now,
    log: (line) => logged.push(line),
  });
});
afterEach(async () => {
  await page?.close();
  page = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(
  method: string,
  target: string,
  body?: unknown,
  headers: Record<string, string | undefined> = {},
): Promise<Reply> {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const merged: Record<string, string | undefined> = {
    host: `${HOST}:${policy.port}`,
    ...(payload === undefined ? {} : { 'content-type': 'application/json', origin }),
    ...headers,
  };
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) if (value !== undefined) sent[name] = value;
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: '127.0.0.1',
        port: policy.port,
        method,
        path: target,
        ca: cert,
        servername: HOST,
        headers: sent,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // not JSON
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

/** Enrols a software passkey for `admin` the way the operator and the enrol page would. */
async function enrol(admin = ADMIN): Promise<SoftPasskey> {
  const passkey = softPasskey();
  const started = passkeys.startEnrolment(admin);
  const options = await call('POST', '/api/enroll/options', { code: started.code });
  expect(options.status).toBe(200);
  const finished = await call('POST', '/api/enroll/finish', {
    code: started.code,
    clientDataJSON: clientData({
      type: 'webauthn.create',
      challenge: Buffer.from(String(options.json.challenge), 'base64url'),
      origin,
    }).toString('base64url'),
    authenticatorData: authenticatorData({
      rpId: HOST,
      flags: FLAG_UP | FLAG_UV | FLAG_AT,
      attested: { credentialId: passkey.credentialId, cose: passkey.cose },
    }).toString('base64url'),
  });
  expect(finished.status).toBe(200);
  expect(await passkeys.confirm(started.enrolmentId, String(finished.json.fingerprint))).toBe('enrolled');
  return passkey;
}

/** What the page sends after navigator.credentials.get for `challenge`. */
function decideBody(
  passkey: SoftPasskey,
  challenge: string,
  action: 'approve' | 'deny',
  bend: { origin?: string; flags?: number; approvalId?: string } = {},
) {
  const clientDataJSON = clientData({
    type: 'webauthn.get',
    challenge: Buffer.from(challenge, 'base64url'),
    origin: bend.origin ?? origin,
  });
  const authData = authenticatorData({ rpId: HOST, flags: bend.flags ?? FLAG_UP | FLAG_UV });
  return {
    approvalId: bend.approvalId ?? APPROVAL,
    action,
    challenge,
    credentialId: passkey.credentialId.toString('base64url'),
    clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: authData.toString('base64url'),
    signature: signAssertion(passkey.privateKey, authData, clientDataJSON).toString('base64url'),
  };
}

async function challenges(approvalId = APPROVAL): Promise<{ approve: string; deny: string }> {
  const reply = await call('POST', '/api/challenge', { approvalId });
  expect(reply.status).toBe(200);
  return { approve: String(reply.json.approve), deny: String(reply.json.deny) };
}

describe('the pages', () => {
  it('serves the card page over TLS with headers that keep every other site out', async () => {
    const reply = await call('GET', `/a/${APPROVAL}`);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
    const csp = String(reply.headers['content-security-policy']);
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain('unsafe');
    expect(reply.headers['x-frame-options']).toBe('DENY');
    expect(reply.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(reply.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['strict-transport-security']).toBe('max-age=31536000');
    // The page carries no card data and no inline script: the same bytes for every card.
    expect(reply.text).not.toContain('example-org');
    expect(reply.text).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(reply.text).not.toMatch(/\son[a-z]+=/);
    expect((await call('GET', `/a/${OTHER_APPROVAL}`)).text).toBe(reply.text);
  });

  it('serves its script and style, and nothing else', async () => {
    const script = await call('GET', '/assets/approve.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    // Card text reaches the document as text only, and nothing comes from another window or the address.
    for (const banned of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'postMessage',
      'opener',
      'location.search',
      'location.hash',
    ]) {
      expect(script.text).not.toContain(banned);
    }
    expect((await call('GET', '/assets/page.css')).headers['content-type']).toBe('text/css; charset=utf-8');
    for (const target of [
      '/',
      '/a',
      '/a/',
      '/a/short',
      `/a/${APPROVAL}/x`,
      '/assets/',
      '/assets/../cli.js',
      '/api/card',
      '/favicon.ico',
      '/a/%2e%2e',
    ]) {
      expect((await call('GET', target)).status, target).toBe(404);
    }
    expect((await call('DELETE', `/a/${APPROVAL}`)).status).toBe(405);
    expect((await call('POST', `/a/${APPROVAL}`, {})).status).toBe(405);
  });

  it('answers only for its own host name', async () => {
    for (const host of ['127.0.0.1', `127.0.0.1:${policy.port}`, `evil.example:${policy.port}`, HOST]) {
      expect((await call('GET', `/a/${APPROVAL}`, undefined, { host })).status, host).toBe(421);
    }
  });

  it('does not speak plain HTTP', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const request = http.request({ host: '127.0.0.1', port: policy.port, path: `/a/${APPROVAL}` }, (response) =>
        resolve(`status ${response.statusCode}`),
      );
      request.on('error', () => resolve('error'));
      request.end();
    });
    expect(outcome).toBe('error');
  });
});

describe('the card', () => {
  it('returns everything the Slack card says, from the broker entry', async () => {
    const reply = await call('GET', `/api/card/${APPROVAL}`);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    const { digest, ...shown } = description(APPROVAL);
    expect(reply.json).toEqual({ ...shown, digestPrefix: digest.slice(0, 12), now: new Date(now).toISOString() });
  });

  it('says gone for a card that is not waiting', async () => {
    const reply = await call('GET', `/api/card/${OTHER_APPROVAL}`);
    expect(reply.status).toBe(404);
    expect(reply.json).toEqual({ error: 'gone' });
  });
});

describe('deciding with a passkey', () => {
  it('approves: a challenge per decision, signed by the admin passkey, handed on with its evidence', async () => {
    const passkey = await enrol();
    const reply = await call('POST', '/api/challenge', { approvalId: APPROVAL });
    expect(reply.status).toBe(200);
    expect(reply.json.rpId).toBe(HOST);
    expect(reply.json.credentialIds).toEqual([passkey.credentialId.toString('base64url')]);
    expect(reply.json.approve).not.toBe(reply.json.deny);
    expect(Buffer.from(String(reply.json.approve), 'base64url')).toHaveLength(32);

    const body = decideBody(passkey, String(reply.json.approve), 'approve');
    const decided = await call('POST', '/api/decide', body);
    expect(decided.status).toBe(200);
    expect(decided.json).toEqual({ result: 'approved' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ approvalId: APPROVAL, action: 'approve', admin: ADMIN, digest: DIGEST });
    const evidence = decisions[0].evidence;
    expect(evidence.via).toBe('passkey');
    expect(evidence.fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(evidence.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(evidence.clientDataJSON, 'base64').equals(Buffer.from(body.clientDataJSON, 'base64url'))).toBe(
      true,
    );
    expect(Buffer.from(evidence.signature, 'base64').equals(Buffer.from(body.signature, 'base64url'))).toBe(true);
    expect(Buffer.from(evidence.authenticatorData, 'base64')).toHaveLength(37);
  });

  it('denies with the other challenge', async () => {
    const passkey = await enrol();
    const { deny } = await challenges();
    const decided = await call('POST', '/api/decide', decideBody(passkey, deny, 'deny'));
    expect(decided.json).toEqual({ result: 'denied' });
    expect(decisions[0]).toMatchObject({ action: 'deny', admin: ADMIN });
  });

  it('tells the page how the card really ended', async () => {
    const passkey = await enrol();
    decideResult = 'expired';
    const late = await call('POST', '/api/decide', decideBody(passkey, (await challenges()).approve, 'approve'));
    expect(late.status).toBe(200);
    expect(late.json).toEqual({ result: 'expired' });
    decideResult = 'ignored';
    const ignored = await call('POST', '/api/decide', decideBody(passkey, (await challenges()).approve, 'approve'));
    expect(ignored.status).toBe(409);
    expect(ignored.json).toEqual({ error: 'not-decided' });
  });

  it('a challenge works once: a replayed assertion decides nothing', async () => {
    const passkey = await enrol();
    const body = decideBody(passkey, (await challenges()).approve, 'approve');
    expect((await call('POST', '/api/decide', body)).status).toBe(200);
    const replay = await call('POST', '/api/decide', body);
    expect(replay.status).toBe(409);
    expect(replay.json).toEqual({ error: 'stale-challenge' });
    expect(decisions).toHaveLength(1);
  });

  it('an assertion for 거부 cannot approve, and one for another card cannot decide this one', async () => {
    const passkey = await enrol();
    cards.set(OTHER_APPROVAL, description(OTHER_APPROVAL, 'b'.repeat(64)));
    const mine = await challenges();
    const swapped = await call('POST', '/api/decide', { ...decideBody(passkey, mine.deny, 'deny'), action: 'approve' });
    expect(swapped.status).toBe(409);
    const other = await challenges(OTHER_APPROVAL);
    const crossed = await call('POST', '/api/decide', decideBody(passkey, other.approve, 'approve'));
    expect(crossed.status).toBe(409);
    expect(decisions).toEqual([]);
  });

  it.each<[string, Parameters<typeof decideBody>[3], Record<string, unknown>]>([
    ['made on the dashboard origin', { origin: 'https://agents.home.arpa' }, {}],
    ['made on the same host, another port', { origin: `https://${HOST}:33000` }, {}],
    ['without user verification', { flags: FLAG_UP }, {}],
    ['with a signature that does not verify', {}, { signature: Buffer.alloc(70, 1).toString('base64url') }],
    ['from a passkey nobody enrolled', {}, { credentialId: randomBytes(20).toString('base64url') }],
  ])('refuses an assertion %s', async (_name, bend, replace) => {
    const passkey = await enrol();
    const { approve } = await challenges();
    const reply = await call('POST', '/api/decide', { ...decideBody(passkey, approve, 'approve', bend), ...replace });
    expect(reply.status).toBe(403);
    expect(reply.json).toEqual({ error: 'refused' });
    expect(decisions).toEqual([]);
    // The refused try used the challenge up.
    expect((await call('POST', '/api/decide', decideBody(passkey, approve, 'approve'))).status).toBe(409);
  });

  it('a challenge lasts two minutes', async () => {
    const passkey = await enrol();
    const { approve } = await challenges();
    now += CHALLENGE_TTL_MS;
    const reply = await call('POST', '/api/decide', decideBody(passkey, approve, 'approve'));
    expect(reply.status).toBe(409);
    expect(decisions).toEqual([]);
  });

  it('refuses when the card is no longer the request the challenge was made for', async () => {
    const passkey = await enrol();
    const { approve } = await challenges();
    cards.set(APPROVAL, description(APPROVAL, 'c'.repeat(64)));
    const changed = await call('POST', '/api/decide', decideBody(passkey, approve, 'approve'));
    expect(changed.status).toBe(409);
    cards.delete(APPROVAL);
    const fresh = await call('POST', '/api/challenge', { approvalId: APPROVAL });
    expect(fresh.status).toBe(404);
    expect(decisions).toEqual([]);
  });

  it('keeps the newest challenges of a card: flooding cannot lock the card, old ones stop working', async () => {
    const passkey = await enrol();
    const first = await challenges();
    for (let i = 0; i < 8; i++) await challenges();
    const last = await challenges();
    expect((await call('POST', '/api/decide', decideBody(passkey, first.approve, 'approve'))).status).toBe(409);
    expect((await call('POST', '/api/decide', decideBody(passkey, last.approve, 'approve'))).status).toBe(200);
  });

  it('says so when no passkey is enrolled', async () => {
    const reply = await call('POST', '/api/challenge', { approvalId: APPROVAL });
    expect(reply.status).toBe(409);
    expect(reply.json).toEqual({ error: 'no-passkey' });
  });
});

describe('requests from anywhere but the page itself', () => {
  it.each<[string, Record<string, string | undefined>]>([
    ['no Origin header', { origin: undefined }],
    ['the dashboard origin', { origin: 'https://agents.home.arpa' }],
    ['a null origin', { origin: 'null' }],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site fetch from another port', { 'sec-fetch-site': 'same-site' }],
    ['a form post', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['a text post', { 'content-type': 'text/plain' }],
  ])('refuses a POST with %s', async (_name, headers) => {
    await enrol();
    const reply = await call('POST', '/api/challenge', { approvalId: APPROVAL }, headers);
    expect(reply.status).toBe(403);
    expect(reply.json).toEqual({ error: 'forbidden' });
  });

  it('refuses bodies that are too large, not JSON, or not the expected shape', async () => {
    await enrol();
    expect((await call('POST', '/api/challenge', `{"approvalId":"${'a'.repeat(20_000)}"}`)).status).toBe(413);
    expect((await call('POST', '/api/challenge', '{not json')).status).toBe(400);
    expect((await call('POST', '/api/challenge', '[]')).status).toBe(400);
    expect((await call('POST', '/api/challenge', { approvalId: '../x' })).status).toBe(400);
    expect((await call('POST', '/api/decide', { approvalId: APPROVAL, action: 'maybe' })).status).toBe(400);
    expect(
      (await call('POST', '/api/decide', { approvalId: APPROVAL, action: 'approve', challenge: 'x' })).status,
    ).toBe(400);
    expect(decisions).toEqual([]);
  });

  it('a failing request answers 500 and the page keeps serving', async () => {
    describeThrows = true;
    const failed = await call('GET', `/api/card/${APPROVAL}`);
    expect(failed.status).toBe(500);
    expect(failed.json).toEqual({ error: 'internal' });
    expect(failed.text).not.toContain('boom');
    expect(logged.join('\n')).toContain('approval page request failed');
    describeThrows = false;
    expect((await call('GET', `/api/card/${APPROVAL}`)).status).toBe(200);
  });
});

describe('enrolment pages', () => {
  it('do not exist while no enrolment is open', async () => {
    expect((await call('GET', '/enroll')).status).toBe(404);
    expect((await call('GET', '/assets/enroll.js')).status).toBe(404);
    expect((await call('POST', '/api/enroll/options', { code: 'AAAAA-AAAAA-AAAAA-AAAAA' })).status).toBe(404);
    expect(
      (await call('POST', '/api/enroll/finish', { code: 'x', clientDataJSON: 'eA', authenticatorData: 'eA' })).status,
    ).toBe(404);
  });

  it('open with the operator enrolment: the code opens the options, the page gets the fingerprint to show', async () => {
    const started = passkeys.startEnrolment(ADMIN);
    const shell = await call('GET', '/enroll');
    expect(shell.status).toBe(200);
    // No box to type a code into: it comes from the address the terminal printed.
    expect(shell.text).not.toMatch(/<input/i);
    const script = await call('GET', '/assets/enroll.js');
    expect(script.status).toBe(200);
    expect(script.text).toContain('location.hash');
    expect(script.text).toContain('replaceState');
    expect(script.text).not.toContain('innerHTML');

    const wrong = await call('POST', '/api/enroll/options', { code: 'AAAAA-AAAAA-AAAAA-AAAAA' });
    expect(wrong.status).toBe(403);
    expect(wrong.json).toEqual({ error: 'bad-code' });

    const options = await call('POST', '/api/enroll/options', { code: started.code });
    expect(options.status).toBe(200);
    expect(options.json.rp).toEqual({ id: HOST, name: 'soma devops approvals' });

    const passkey = softPasskey();
    const finish = {
      code: started.code,
      clientDataJSON: clientData({
        type: 'webauthn.create',
        challenge: Buffer.from(String(options.json.challenge), 'base64url'),
        origin,
      }).toString('base64url'),
      authenticatorData: authenticatorData({
        rpId: HOST,
        flags: FLAG_UP | FLAG_UV | FLAG_AT,
        attested: { credentialId: passkey.credentialId, cose: passkey.cose },
      }).toString('base64url'),
    };
    const finished = await call('POST', '/api/enroll/finish', finish);
    expect(finished.status).toBe(200);
    expect(String(finished.json.fingerprint)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    // A second submit cannot swap the passkey the operator is about to confirm.
    const again = await call('POST', '/api/enroll/finish', finish);
    expect(again.status).toBe(403);
    expect(again.json).toEqual({ error: 'already-submitted' });
    // Nothing is enrolled until the operator confirms: the page alone cannot do it.
    expect(await passkeys.list()).toEqual([]);
    expect((await call('POST', '/api/challenge', { approvalId: APPROVAL })).json).toEqual({ error: 'no-passkey' });
  });
});

describe('loadPageTls', () => {
  let tlsDir: string;

  beforeEach(() => {
    tlsDir = path.join(dir, 'tls');
    fs.mkdirSync(tlsDir, { mode: 0o700 });
    fs.chmodSync(tlsDir, 0o700);
    fs.copyFileSync(path.join(certDir, 'cert.pem'), path.join(tlsDir, 'cert.pem'));
    fs.copyFileSync(path.join(certDir, 'key.pem'), path.join(tlsDir, 'key.pem'));
    fs.chmodSync(path.join(tlsDir, 'key.pem'), 0o600);
    fs.chmodSync(path.join(tlsDir, 'cert.pem'), 0o644);
  });

  it('loads a certificate for the page host with a private key only the broker can read', () => {
    const tls = loadPageTls(tlsDir, HOST, Date.now());
    expect(tls.cert.equals(cert)).toBe(true);
    expect(tls.key.equals(key)).toBe(true);
    expect(tls.daysLeft).toBeGreaterThanOrEqual(1);
  });

  it.each<[string, (d: string) => void, RegExp]>([
    ['a missing certificate', (d) => fs.rmSync(path.join(d, 'cert.pem')), /cert\.pem.*does not exist/],
    ['a missing key', (d) => fs.rmSync(path.join(d, 'key.pem')), /key\.pem.*does not exist/],
    ['a key others can read', (d) => fs.chmodSync(path.join(d, 'key.pem'), 0o640), /key\.pem.*0600/],
    ['a directory others can enter', (d) => fs.chmodSync(d, 0o750), /tls.*0700/],
    ['a certificate others can write', (d) => fs.chmodSync(path.join(d, 'cert.pem'), 0o666), /cert\.pem.*writable/],
    [
      'a key that is a link',
      (d) => {
        fs.renameSync(path.join(d, 'key.pem'), path.join(d, 'real.pem'));
        fs.symlinkSync(path.join(d, 'real.pem'), path.join(d, 'key.pem'));
      },
      /key\.pem.*not a regular file/,
    ],
    [
      'a key that is not this certificate’s',
      (d) => {
        const other = spawnSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout'], {
          encoding: 'utf8',
        });
        fs.writeFileSync(path.join(d, 'key.pem'), other.stdout, { mode: 0o600 });
      },
      /does not match/,
    ],
  ])('refuses %s', (_name, damage, message) => {
    damage(tlsDir);
    expect(() => loadPageTls(tlsDir, HOST, Date.now())).toThrow(message);
  });

  it('refuses a certificate for another name, and one that has expired', () => {
    expect(() => loadPageTls(tlsDir, 'other.home.arpa', Date.now())).toThrow(/not for other\.home\.arpa/);
    expect(() => loadPageTls(tlsDir, HOST, Date.now() + 5 * 24 * 3600 * 1000)).toThrow(/expired/);
  });
});
