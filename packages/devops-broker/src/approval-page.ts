// The broker's own approval page (#1056): an admin reads a waiting card here and decides it with a passkey,
// without Slack. The broker serves it itself, over TLS it terminates itself, on an origin under home.arpa
// whose certificate only the installer's throwaway CA could issue. The bot user (and so the model) holds
// neither this origin nor any passkey for it, so a decision made here is the admin's own act — the same
// guarantee the Slack card gives.
//
// The page shows the card from the broker's entry, never from the caller. A decision is a WebAuthn assertion
// over a challenge the broker drew for that approval, that request digest and that decision; it works once.
// The dashboard only links here. Nothing it sends can decide a card.
//
// A request that fails answers 500 and stops there: it never reaches the request socket or the Slack loop.

import { randomBytes, X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import type { Approvals } from './approval.js';
import { APPROVE_HTML, APPROVE_JS, ENROLL_HTML, ENROLL_JS, PAGE_CSS } from './approval-page-assets.js';
import { PasskeyError, type Passkeys } from './passkeys.js';
import type { ApprovalPagePolicy } from './policy.js';
import { approvalChallenge, type DecisionAction } from './webauthn.js';

export const TLS_CERT_FILE = 'cert.pem';
export const TLS_KEY_FILE = 'key.pem';
/** How long a challenge can be answered. */
export const CHALLENGE_TTL_MS = 120_000;
/** Challenges kept per card and in all; past either, the oldest go. */
const CHALLENGES_PER_APPROVAL = 8;
const CHALLENGES_TOTAL = 256;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CONNECTIONS = 64;
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;

export interface PageTls {
  cert: Buffer;
  key: Buffer;
  /** Whole days until the certificate ends. */
  daysLeft: number;
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function readPrivate(file: string, what: string, check: (stat: fs.Stats) => void): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`${file} does not exist`);
    if (code === 'ELOOP') throw new Error(`${file} is not a regular file`);
    throw new Error(`${file} cannot be opened (${code ?? 'error'})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid && stat.uid !== 0) {
      throw new Error(`${file} (${what}) is not owned by the broker user or root`);
    }
    if (stat.size > 64 * 1024) throw new Error(`${file} is too large`);
    check(stat);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The page's certificate and key from the broker's `tls/` directory. Refuses anything another user could have
 * put there or could read: the directory is 0700 and the key 0600, both the broker user's; the certificate is
 * for exactly the page host, not expired, and belongs to that key.
 */
export function loadPageTls(tlsDir: string, host: string, nowMs: number): PageTls {
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(tlsDir);
  } catch {
    throw new Error(`${tlsDir} does not exist`);
  }
  const uid = process.getuid?.();
  if (!dirStat.isDirectory()) throw new Error(`${tlsDir} is not a directory`);
  if (uid !== undefined && dirStat.uid !== uid) throw new Error(`${tlsDir} is not owned by the broker user`);
  if ((dirStat.mode & 0o077) !== 0) throw new Error(`${tlsDir} is mode ${octal(dirStat.mode)}; it must be 0700`);
  const certFile = path.join(tlsDir, TLS_CERT_FILE);
  const keyFile = path.join(tlsDir, TLS_KEY_FILE);
  const cert = readPrivate(certFile, 'certificate', (stat) => {
    if ((stat.mode & 0o022) !== 0) throw new Error(`${certFile} is group- or world-writable (${octal(stat.mode)})`);
  });
  const key = readPrivate(keyFile, 'private key', (stat) => {
    if ((stat.mode & 0o077) !== 0) throw new Error(`${keyFile} is mode ${octal(stat.mode)}; it must be 0600`);
  });
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch {
    throw new Error(`${certFile} is not a certificate`);
  }
  if (x509.checkHost(host, { wildcards: false, subject: 'never' }) === undefined) {
    throw new Error(`${certFile} is not for ${host}`);
  }
  const notAfter = Date.parse(x509.validTo);
  const notBefore = Date.parse(x509.validFrom);
  if (!Number.isFinite(notAfter) || nowMs >= notAfter) throw new Error(`${certFile} has expired`);
  if (Number.isFinite(notBefore) && nowMs < notBefore) throw new Error(`${certFile} is not valid yet`);
  try {
    // Throws when the key is not the certificate's.
    https.createServer({ cert, key }).close();
  } catch {
    throw new Error(`${keyFile} does not match ${certFile}`);
  }
  return { cert, key, daysLeft: Math.floor((notAfter - nowMs) / (24 * 3600 * 1000)) };
}

interface IssuedChallenge {
  approvalId: string;
  digest: string;
  action: DecisionAction;
  nonce: Buffer;
  challenge: Buffer;
  expiresAtMs: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  // This host only (no includeSubDomains): a plain-http look-alike on the same name stops loading after one visit.
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'publickey-credentials-get=(self), publickey-credentials-create=(self)',
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'too-large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new HttpError(400, 'bad-request')));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(body: Record<string, unknown>, name: string, re: RegExp, max: number): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !re.test(value)) {
    throw new HttpError(400, 'bad-request');
  }
  return value;
}

function bytes(body: Record<string, unknown>, name: string, max: number): Buffer {
  return Buffer.from(field(body, name, B64U_RE, max), 'base64url');
}

export interface ApprovalPage {
  close(): Promise<void>;
}

export async function startApprovalPage(opts: {
  page: ApprovalPagePolicy;
  tls: { cert: Buffer; key: Buffer };
  approvals: Pick<Approvals, 'describe' | 'decideVerified'>;
  passkeys: Passkeys;
  now?: () => number;
  log(line: string): void;
}): Promise<ApprovalPage> {
  const { page, approvals, passkeys } = opts;
  const clock = opts.now ?? Date.now;
  const expectedHost = new URL(page.origin).host;
  /** Keyed by the challenge (base64url). Insertion order = age. */
  const issued = new Map<string, IssuedChallenge>();

  function issue(approvalId: string, digest: string, action: DecisionAction): string {
    const nonce = randomBytes(32);
    const challenge = approvalChallenge({ nonce, approvalId, digest, action });
    const id = challenge.toString('base64url');
    issued.set(id, { approvalId, digest, action, nonce, challenge, expiresAtMs: clock() + CHALLENGE_TTL_MS });
    return id;
  }

  /** Drops what has expired, then the oldest of this card and the oldest of all past the caps. */
  function prune(approvalId: string): void {
    const now = clock();
    let mine = 0;
    for (const [id, entry] of issued) {
      if (now >= entry.expiresAtMs) issued.delete(id);
      else if (entry.approvalId === approvalId) mine++;
    }
    for (const [id, entry] of issued) {
      if (mine <= CHALLENGES_PER_APPROVAL) break;
      if (entry.approvalId !== approvalId) continue;
      issued.delete(id);
      mine--;
    }
    for (const id of issued.keys()) {
      if (issued.size <= CHALLENGES_TOTAL) break;
      issued.delete(id);
    }
  }

  async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    // Only this page's own script may post: the browser sets Origin and Sec-Fetch-Site, not the script.
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const site = req.headers['sec-fetch-site'];
    if (
      type !== 'application/json' ||
      req.headers.origin !== page.origin ||
      (site !== undefined && site !== 'same-origin')
    ) {
      throw new HttpError(403, 'forbidden');
    }
    const raw = await readBody(req);
    let value: unknown;
    try {
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'bad-request');
    }
    if (!isRecord(value)) throw new HttpError(400, 'bad-request');
    return value;
  }

  async function postChallenge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await jsonBody(req);
    const approvalId = field(body, 'approvalId', APPROVAL_ID_RE, 64);
    const card = approvals.describe(approvalId);
    if (card === undefined) throw new HttpError(404, 'gone');
    const credentialIds = await passkeys.credentialIds();
    if (credentialIds.length === 0) throw new HttpError(409, 'no-passkey');
    const approve = issue(approvalId, card.digest, 'approve');
    const deny = issue(approvalId, card.digest, 'deny');
    prune(approvalId);
    sendJson(res, 200, { rpId: page.rpId, timeoutMs: CHALLENGE_TTL_MS, credentialIds, approve, deny });
  }

  async function postDecide(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await jsonBody(req);
    const approvalId = field(body, 'approvalId', APPROVAL_ID_RE, 64);
    const action = body.action;
    if (action !== 'approve' && action !== 'deny') throw new HttpError(400, 'bad-request');
    const challengeId = field(body, 'challenge', /^[A-Za-z0-9_-]{43}$/, 43);
    const credentialId = field(body, 'credentialId', B64U_RE, 1400);
    const clientDataJSON = bytes(body, 'clientDataJSON', 6000);
    const authenticatorData = bytes(body, 'authenticatorData', 3000);
    const signature = bytes(body, 'signature', 400);

    // One use, whatever comes next: taken out before anything is checked.
    const entry = issued.get(challengeId);
    issued.delete(challengeId);
    if (
      entry === undefined ||
      clock() >= entry.expiresAtMs ||
      entry.approvalId !== approvalId ||
      entry.action !== action
    ) {
      throw new HttpError(409, 'stale-challenge');
    }
    // The card must still be the request this challenge was drawn for.
    const card = approvals.describe(approvalId);
    if (card === undefined) throw new HttpError(404, 'gone');
    if (card.digest !== entry.digest) throw new HttpError(409, 'stale-challenge');

    let verified: { admin: string; fingerprint: string };
    try {
      verified = await passkeys.verify({
        credentialId,
        expectedChallenge: entry.challenge,
        clientDataJSON,
        authenticatorData,
        signature,
      });
    } catch (err) {
      if (err instanceof PasskeyError) {
        opts.log(`approval page: an assertion for approval ${approvalId} was refused (${err.reason})`);
        throw new HttpError(403, 'refused');
      }
      throw err;
    }
    const result = await approvals.decideVerified({
      approvalId,
      action,
      admin: verified.admin,
      digest: entry.digest,
      evidence: {
        via: 'passkey',
        fingerprint: verified.fingerprint,
        nonce: entry.nonce.toString('hex'),
        clientDataJSON: clientDataJSON.toString('base64'),
        authenticatorData: authenticatorData.toString('base64'),
        signature: signature.toString('base64'),
      },
    });
    if (result === 'ignored') throw new HttpError(409, 'not-decided');
    sendJson(res, 200, { result });
  }

  async function postEnrol(req: IncomingMessage, res: ServerResponse, step: 'options' | 'finish'): Promise<void> {
    const body = await jsonBody(req);
    const code = field(body, 'code', /^[0-9A-Za-z-]+$/, 64);
    try {
      if (step === 'options') {
        sendJson(res, 200, passkeys.enrolOptions(code));
        return;
      }
      const clientDataJSON = bytes(body, 'clientDataJSON', 6000);
      const authenticatorData = bytes(body, 'authenticatorData', 3000);
      sendJson(res, 200, passkeys.enrolFinish({ code, clientDataJSON, authenticatorData }));
    } catch (err) {
      if (!(err instanceof PasskeyError)) throw err;
      const shown = err.reason === 'bad-code' || err.reason === 'already-submitted' ? err.reason : 'refused';
      if (shown === 'refused') opts.log(`approval page: an enrolment response was refused (${err.reason})`);
      throw new HttpError(403, shown);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.host !== expectedHost) throw new HttpError(421, 'wrong-host');
    const target = req.url ?? '';
    const method = req.method ?? '';
    const enrolling = passkeys.enrolmentOpen();
    const get: Record<string, () => void> = {
      '/assets/approve.js': () => send(res, 200, 'text/javascript; charset=utf-8', APPROVE_JS),
      '/assets/page.css': () => send(res, 200, 'text/css; charset=utf-8', PAGE_CSS),
      ...(enrolling
        ? {
            '/enroll': () => send(res, 200, 'text/html; charset=utf-8', ENROLL_HTML),
            '/assets/enroll.js': () => send(res, 200, 'text/javascript; charset=utf-8', ENROLL_JS),
          }
        : {}),
    };
    const post: Record<string, () => Promise<void>> = {
      '/api/challenge': () => postChallenge(req, res),
      '/api/decide': () => postDecide(req, res),
      ...(enrolling
        ? {
            '/api/enroll/options': () => postEnrol(req, res, 'options'),
            '/api/enroll/finish': () => postEnrol(req, res, 'finish'),
          }
        : {}),
    };
    const cardPage = /^\/a\/([A-Za-z0-9_-]{8,64})$/.exec(target);
    const cardData = /^\/api\/card\/([A-Za-z0-9_-]{8,64})$/.exec(target);
    const known = cardPage !== null || cardData !== null || Object.hasOwn(get, target);
    if (Object.hasOwn(post, target)) {
      if (method !== 'POST') throw new HttpError(405, 'method-not-allowed');
      return post[target]();
    }
    if (!known) throw new HttpError(404, 'not-found');
    if (method !== 'GET') throw new HttpError(405, 'method-not-allowed');
    if (cardPage !== null) return send(res, 200, 'text/html; charset=utf-8', APPROVE_HTML);
    if (cardData !== null) {
      const card = approvals.describe(cardData[1]);
      if (card === undefined) throw new HttpError(404, 'gone');
      const { digest, ...shown } = card;
      return sendJson(res, 200, { ...shown, digestPrefix: digest.slice(0, 12), now: new Date(clock()).toISOString() });
    }
    get[target]();
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code });
        return;
      }
      opts.log(`approval page request failed (${err instanceof Error ? err.name : 'error'})`);
      sendJson(res, 500, { error: 'internal' });
    });
  }

  const server = https.createServer({ cert: opts.tls.cert, key: opts.tls.key, minVersion: 'TLSv1.2' }, (req, res) => {
    try {
      handle(req, res);
    } catch {
      res.destroy();
    }
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(page.port, page.listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (err) =>
    opts.log(`approval page server error (${(err as NodeJS.ErrnoException).code ?? 'error'})`),
  );

  return {
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
