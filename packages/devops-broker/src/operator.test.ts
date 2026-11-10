import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticatorData,
  clientData,
  FLAG_AT,
  FLAG_UP,
  FLAG_UV,
  softPasskey,
} from './__fixtures__/soft-authenticator.js';
import { Ledger } from './ledger.js';
import { connectOperator, type OperatorServer, runPasskeyCommand, startOperatorSocket } from './operator.js';
import { createPasskeys, initialPasskeyState, PASSKEY_STATE_FILE, type Passkeys } from './passkeys.js';
import { StateStore } from './state.js';
import { relyingParty } from './webauthn.js';

const ORIGIN = 'https://approve.home.arpa:8443';
const ENROL_URL = `${ORIGIN}/enroll`;
const rp = relyingParty(ORIGIN);
const ADMIN = 'U0ADMIN0001';

let dir: string;
let socketPath: string;
let passkeys: Passkeys;
let server: OperatorServer | undefined;
let enrolled: { admin: string; fingerprint: string }[];

beforeEach(() => {
  // Short: a unix socket path is at most 104 bytes on macOS.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dop-'));
  fs.chmodSync(dir, 0o700);
  socketPath = path.join(dir, 'operator.sock');
  passkeys = createPasskeys({
    rp,
    isAdmin: (user) => user === ADMIN,
    store: new StateStore(path.join(dir, PASSKEY_STATE_FILE), initialPasskeyState()),
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
  });
  enrolled = [];
  server = undefined;
});
afterEach(async () => {
  await server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<void> {
  server = await startOperatorSocket({
    socketPath,
    passkeys,
    enrolUrl: ENROL_URL,
    onEnrolled: (admin, fingerprint) => enrolled.push({ admin, fingerprint }),
    log: () => undefined,
  });
}

/** The enrol page's part: opens the code and hands in a new passkey. Returns the fingerprint the page shows. */
function pageSubmits(code: string): string {
  const passkey = softPasskey();
  const options = passkeys.enrolOptions(code);
  return passkeys.enrolFinish({
    code,
    clientDataJSON: clientData({
      type: 'webauthn.create',
      challenge: Buffer.from(options.challenge, 'base64url'),
      origin: ORIGIN,
    }),
    authenticatorData: authenticatorData({
      rpId: rp.rpId,
      flags: FLAG_UP | FLAG_UV | FLAG_AT,
      attested: { credentialId: passkey.credentialId, cose: passkey.cose },
    }),
  }).fingerprint;
}

/** Runs the CLI with a scripted terminal: `answer` is called each time the CLI prompts. */
async function cli(
  args: string[],
  answer?: (printed: string, prompt: number) => string | null,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let printed = '';
  let errors = '';
  let prompts = 0;
  stdout.on('data', (chunk: Buffer) => {
    printed += chunk.toString();
    if (printed.endsWith('fingerprint> ')) {
      const typed = answer?.(printed, prompts++);
      if (typed === null || typed === undefined) stdin.end();
      else stdin.write(`${typed}\n`);
    }
  });
  stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const code = await runPasskeyCommand(args, { socketPath, stdin, stdout, stderr });
  return { code, stdout: printed, stderr: errors };
}

function codeIn(printed: string): string {
  const match = /\/enroll#([0-9A-Z-]+)/.exec(printed);
  if (!match) throw new Error('the CLI did not print the enrol address');
  return match[1];
}

describe('operator socket', () => {
  it('is a 0600 socket and refuses to open in a directory others can enter', async () => {
    await start();
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    await server?.close();
    server = undefined;
    fs.chmodSync(dir, 0o750);
    await expect(start()).rejects.toThrow(/must be 0700/);
  });

  it('replaces a stale socket but never another kind of file', async () => {
    await start();
    await server?.close();
    server = undefined;
    await start();
    await server?.close();
    server = undefined;
    fs.rmSync(socketPath, { force: true });
    fs.writeFileSync(socketPath, 'not a socket');
    await expect(start()).rejects.toThrow(/not a socket/);
  });

  it('answers a malformed line with an error and keeps the connection', async () => {
    await start();
    const client = await connectOperator(socketPath);
    expect(await client.call({ op: 'approve-everything' })).toEqual({ ok: false, error: 'malformed request' });
    expect(await client.call({ op: 'enrol-start', admin: 'not a user id' })).toEqual({
      ok: false,
      error: 'malformed request',
    });
    expect(await client.call({ op: 'list' })).toEqual({ ok: true, passkeys: [] });
    client.close();
  });

  it('cancels an enrolment when the connection that started it closes', async () => {
    await start();
    const client = await connectOperator(socketPath);
    const started = await client.call({ op: 'enrol-start', admin: ADMIN });
    const fingerprint = pageSubmits(String(started.code));
    expect(await client.call({ op: 'enrol-status' })).toEqual({ ok: true, status: 'submitted' });
    client.close();
    await expect.poll(() => passkeys.enrolmentOpen()).toBe(false);
    // The submitted passkey went with it: a new connection cannot confirm it.
    const other = await connectOperator(socketPath);
    expect(await other.call({ op: 'enrol-confirm', fingerprint })).toEqual({ ok: true, result: 'gone' });
    expect(await other.call({ op: 'list' })).toEqual({ ok: true, passkeys: [] });
    other.close();
  });

  it("does not let a second connection confirm or read the first one's enrolment", async () => {
    await start();
    const first = await connectOperator(socketPath);
    const started = await first.call({ op: 'enrol-start', admin: ADMIN });
    const fingerprint = pageSubmits(String(started.code));
    const second = await connectOperator(socketPath);
    expect(await second.call({ op: 'enrol-status' })).toEqual({ ok: true, status: 'gone' });
    expect(await second.call({ op: 'enrol-confirm', fingerprint })).toEqual({ ok: true, result: 'gone' });
    expect((await second.call({ op: 'enrol-start', admin: ADMIN })).ok).toBe(false);
    second.close();
    expect(await first.call({ op: 'enrol-confirm', fingerprint })).toEqual({ ok: true, result: 'enrolled' });
    first.close();
  });
});

describe('soma-devops-broker passkey', () => {
  it('enrol: prints the one-time address, takes the fingerprint from the page, stores the passkey', async () => {
    await start();
    let shown = '';
    const result = await cli(['enrol', ADMIN], (printed) => {
      shown = pageSubmits(codeIn(printed));
      return shown.toLowerCase().replaceAll('-', ' ');
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${ENROL_URL}#`);
    expect(result.stdout).toContain(`address bar says ${ORIGIN}`);
    // The terminal never prints the fingerprint: it has to come from the page.
    expect(result.stdout).not.toContain(shown);
    expect(result.stdout).toContain('enrolled.');
    expect((await passkeys.list()).map((p) => p.fingerprint)).toEqual([shown]);
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0].admin).toBe(ADMIN);
  });

  it('enrol: asks again while the page has not handed in a passkey', async () => {
    await start();
    const result = await cli(['enrol', ADMIN], (printed, prompt) => {
      if (prompt === 0) return '0000-0000-0000-0000';
      return pageSubmits(codeIn(printed));
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('has not handed in a passkey yet');
    expect(await passkeys.list()).toHaveLength(1);
  });

  it.each<[string, (fingerprint: string) => string | null, RegExp]>([
    ['a different fingerprint', () => 'FFFF-FFFF-FFFF-FFFF', /does not match/],
    ['an empty line', () => '', /cancelled; nothing was enrolled/],
    ['a closed terminal', () => null, /cancelled; nothing was enrolled/],
  ])('enrol: %s stores nothing', async (_name, typed, message) => {
    await start();
    const result = await cli(['enrol', ADMIN], (printed) => typed(pageSubmits(codeIn(printed))));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(await passkeys.list()).toEqual([]);
    expect(enrolled).toEqual([]);
    expect(passkeys.enrolmentOpen()).toBe(false);
  });

  it('enrol: refuses a user who is not an admin, and a second enrolment while one is open', async () => {
    await start();
    const notAdmin = await cli(['enrol', 'U0NOTADMIN1']);
    expect(notAdmin.code).toBe(1);
    expect(notAdmin.stderr).toContain('not an admin');
    passkeys.startEnrolment(ADMIN);
    const busy = await cli(['enrol', ADMIN]);
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain('another enrolment is open');
  });

  it('list and revoke', async () => {
    await start();
    expect((await cli(['list'])).stdout).toContain('no passkeys enrolled');
    let shown = '';
    await cli(['enrol', ADMIN], (printed) => {
      shown = pageSubmits(codeIn(printed));
      return shown;
    });
    const listed = await cli(['list']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(shown);
    expect(listed.stdout).toContain(ADMIN);
    expect((await cli(['revoke', 'FFFF-FFFF-FFFF-FFFF'])).code).toBe(1);
    const revoked = await cli(['revoke', shown]);
    expect(revoked.code).toBe(0);
    expect(await passkeys.list()).toEqual([]);
  });

  it('says what to do when no broker with an approval page is running', async () => {
    const result = await cli(['list']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no broker with an approval page is running');
  });

  it.each([
    [[]],
    [['enrol']],
    [['enrol', ADMIN, 'extra']],
    [['list', 'x']],
    [['revoke']],
    [['approve', 'x']],
  ])('usage error for %j', async (args) => {
    const result = await cli(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('passkey enrol <admin>');
  });

  it('refuses a malformed admin id before connecting', async () => {
    const result = await cli(['enrol', 'someone']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Slack user id');
  });
});
