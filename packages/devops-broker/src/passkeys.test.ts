import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { Ledger } from './ledger.js';
import {
  createPasskeys,
  initialPasskeyState,
  PASSKEY_STATE_FILE,
  PasskeyError,
  type PasskeyProblem,
  type PasskeyState,
  type Passkeys,
} from './passkeys.js';
import { StateStore } from './state.js';
import { relyingParty } from './webauthn.js';

const ORIGIN = 'https://approve.home.arpa:8443';
const rp = relyingParty(ORIGIN);
const ADMIN = 'U0ADMIN0001';
const OTHER_ADMIN = 'U0ADMIN0002';

let dir: string;
let now: number;
let admins: Set<string>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-passkeys-'));
  now = Date.parse('2026-11-10T04:00:00Z');
  admins = new Set([ADMIN, OTHER_ADMIN]);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function make(): { passkeys: Passkeys; store: StateStore<PasskeyState>; ledgerRows(): Record<string, unknown>[] } {
  const store = new StateStore(path.join(dir, PASSKEY_STATE_FILE), initialPasskeyState());
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const passkeys = createPasskeys({
    rp,
    isAdmin: (user) => admins.has(user),
    store,
    ledger: new Ledger(ledgerFile),
    now: () => now,
  });
  const ledgerRows = () =>
    fs.existsSync(ledgerFile)
      ? fs
          .readFileSync(ledgerFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return { passkeys, store, ledgerRows };
}

async function problemOf(run: () => unknown): Promise<PasskeyProblem | 'no-error'> {
  try {
    await run();
  } catch (err) {
    if (err instanceof PasskeyError) return err.reason;
    throw err;
  }
  return 'no-error';
}

/** What the enrol page sends back after navigator.credentials.create. */
function createResponse(passkey: SoftPasskey, challenge: string, origin = ORIGIN) {
  return {
    clientDataJSON: clientData({
      type: 'webauthn.create',
      challenge: Buffer.from(challenge, 'base64url'),
      origin,
    }),
    authenticatorData: authenticatorData({
      rpId: rp.rpId,
      flags: FLAG_UP | FLAG_UV | FLAG_AT,
      attested: { credentialId: passkey.credentialId, cose: passkey.cose },
    }),
  };
}

/** The whole enrolment: operator starts it, the page submits a passkey, the operator confirms the fingerprint. */
async function enrol(passkeys: Passkeys, admin = ADMIN, passkey = softPasskey()) {
  const started = passkeys.startEnrolment(admin);
  const options = passkeys.enrolOptions(started.code);
  const submitted = passkeys.enrolFinish({ code: started.code, ...createResponse(passkey, options.challenge) });
  expect(passkeys.enrolmentStatus(started.enrolmentId)).toBe('submitted');
  expect(await passkeys.confirm(started.enrolmentId, submitted.fingerprint)).toBe('enrolled');
  return { passkey, fingerprint: submitted.fingerprint };
}

function assertionFor(passkey: SoftPasskey, challenge: Buffer, bend: { origin?: string; flags?: number } = {}) {
  const clientDataJSON = clientData({ type: 'webauthn.get', challenge, origin: bend.origin ?? ORIGIN });
  const authData = authenticatorData({ rpId: rp.rpId, flags: bend.flags ?? FLAG_UP | FLAG_UV });
  return {
    credentialId: passkey.credentialId.toString('base64url'),
    expectedChallenge: challenge,
    clientDataJSON,
    authenticatorData: authData,
    signature: signAssertion(passkey.privateKey, authData, clientDataJSON),
  };
}

describe('enrolment', () => {
  it('stores a passkey only after the operator confirms the fingerprint the page shows', async () => {
    const { passkeys, store, ledgerRows } = make();
    const passkey = softPasskey();
    const started = passkeys.startEnrolment(ADMIN);
    expect(started.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(Date.parse(started.expiresAt)).toBe(now + 10 * 60 * 1000);

    expect(passkeys.enrolmentStatus(started.enrolmentId)).toBe('waiting');
    // The operator typed before the page handed anything in: nothing is lost.
    expect(await passkeys.confirm(started.enrolmentId, '0000-0000-0000-0000')).toBe('not-submitted');
    const options = passkeys.enrolOptions(started.code);
    expect(options.rp).toEqual({ id: 'approve.home.arpa', name: 'soma devops approvals' });
    expect(options.user.name).toContain(ADMIN);
    const submitted = passkeys.enrolFinish({ code: started.code, ...createResponse(passkey, options.challenge) });
    expect(submitted.fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);

    // Submitted is not enrolled: nothing on disk, nothing to sign in with.
    await store.load();
    expect(store.get().passkeys).toEqual([]);
    expect(await passkeys.credentialIds()).toEqual([]);

    expect(await passkeys.confirm(started.enrolmentId, submitted.fingerprint)).toBe('enrolled');
    await store.load();
    const saved = store.get().passkeys;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ admin: ADMIN, fingerprint: submitted.fingerprint });
    expect(saved[0].credentialId).toBe(passkey.credentialId.toString('base64url'));
    expect(await passkeys.credentialIds()).toEqual([saved[0].credentialId]);
    expect(ledgerRows().map((row) => row.event)).toEqual(['passkey.enrol-started', 'passkey.enrolled']);
    expect(ledgerRows()[1]).toMatchObject({ admin: ADMIN, fingerprint: submitted.fingerprint });
  });

  it('never writes the code to the ledger or the state file', async () => {
    const { passkeys } = make();
    const started = passkeys.startEnrolment(ADMIN);
    const options = passkeys.enrolOptions(started.code);
    const submitted = passkeys.enrolFinish({ code: started.code, ...createResponse(softPasskey(), options.challenge) });
    await passkeys.confirm(started.enrolmentId, submitted.fingerprint);
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(text).not.toContain(started.code);
      expect(text).not.toContain(started.code.replaceAll('-', ''));
    }
  });

  it('discards the submitted passkey when the operator names another fingerprint or says no', async () => {
    const { passkeys, store, ledgerRows } = make();
    const started = passkeys.startEnrolment(ADMIN);
    const options = passkeys.enrolOptions(started.code);
    passkeys.enrolFinish({ code: started.code, ...createResponse(softPasskey(), options.challenge) });
    expect(await passkeys.confirm(started.enrolmentId, '0000-0000-0000-0000')).toBe('discarded');
    await store.load();
    expect(store.get().passkeys).toEqual([]);
    expect(ledgerRows().at(-1)).toMatchObject({ event: 'passkey.enrol-discarded', admin: ADMIN });
    // The enrolment is over: the code opens nothing any more.
    expect(await problemOf(() => passkeys.enrolOptions(started.code))).toBe('bad-code');

    const again = passkeys.startEnrolment(ADMIN);
    const options2 = passkeys.enrolOptions(again.code);
    passkeys.enrolFinish({ code: again.code, ...createResponse(softPasskey(), options2.challenge) });
    expect(await passkeys.confirm(again.enrolmentId, null)).toBe('discarded');
  });

  it('takes the first submitted passkey only (a second submit cannot replace what the operator compares)', async () => {
    const { passkeys } = make();
    const started = passkeys.startEnrolment(ADMIN);
    const options = passkeys.enrolOptions(started.code);
    const first = passkeys.enrolFinish({ code: started.code, ...createResponse(softPasskey(), options.challenge) });
    expect(
      await problemOf(() =>
        passkeys.enrolFinish({ code: started.code, ...createResponse(softPasskey(), options.challenge) }),
      ),
    ).toBe('already-submitted');
    expect(await problemOf(() => passkeys.enrolOptions(started.code))).toBe('already-submitted');
    expect(passkeys.enrolmentStatus(started.enrolmentId)).toBe('submitted');
    // What the operator can confirm is still the first one.
    expect(await passkeys.confirm(started.enrolmentId, first.fingerprint)).toBe('enrolled');
  });

  it('refuses a wrong code, a code after its 10 minutes, and a user who is not an admin', async () => {
    const { passkeys } = make();
    expect(await problemOf(() => passkeys.startEnrolment('U0NOTADMIN1'))).toBe('not-admin');
    const started = passkeys.startEnrolment(ADMIN);
    expect(await problemOf(() => passkeys.enrolOptions('AAAAA-AAAAA-AAAAA-AAAAA'))).toBe('bad-code');
    expect(await problemOf(() => passkeys.enrolOptions(''))).toBe('bad-code');
    // Typed without dashes or in lower case is the same code.
    expect(passkeys.enrolOptions(started.code.replaceAll('-', '').toLowerCase()).rp.id).toBe('approve.home.arpa');
    now += 10 * 60 * 1000;
    expect(await problemOf(() => passkeys.enrolOptions(started.code))).toBe('bad-code');
    expect(passkeys.enrolmentStatus(started.enrolmentId)).toBe('gone');
    expect(passkeys.enrolmentOpen()).toBe(false);
    expect(await passkeys.confirm(started.enrolmentId, null)).toBe('gone');
  });

  it('runs one enrolment at a time and frees the slot when it ends', async () => {
    const { passkeys } = make();
    expect(passkeys.enrolmentOpen()).toBe(false);
    const started = passkeys.startEnrolment(ADMIN);
    expect(passkeys.enrolmentOpen()).toBe(true);
    expect(await problemOf(() => passkeys.startEnrolment(OTHER_ADMIN))).toBe('busy');
    passkeys.cancelEnrolment(started.enrolmentId);
    expect(passkeys.enrolmentOpen()).toBe(false);
    expect(await problemOf(() => passkeys.enrolOptions(started.code))).toBe('bad-code');
    expect(passkeys.startEnrolment(OTHER_ADMIN).code).not.toBe(started.code);
  });

  it('wrong codes never lock the right one out (the code is 100 bits; there is nothing to slow down)', async () => {
    const { passkeys } = make();
    const started = passkeys.startEnrolment(ADMIN);
    for (let i = 0; i < 200; i++) {
      expect(await problemOf(() => passkeys.enrolOptions('AAAAA-AAAAA-AAAAA-AAAAA'))).toBe('bad-code');
    }
    expect(passkeys.enrolOptions(started.code).rp.id).toBe('approve.home.arpa');
  });

  it('a passkey abandoned by the operator can no longer be confirmed', async () => {
    const { passkeys, store } = make();
    const started = passkeys.startEnrolment(ADMIN);
    const options = passkeys.enrolOptions(started.code);
    const submitted = passkeys.enrolFinish({ code: started.code, ...createResponse(softPasskey(), options.challenge) });
    passkeys.cancelEnrolment(started.enrolmentId);
    expect(await passkeys.confirm(started.enrolmentId, submitted.fingerprint)).toBe('gone');
    await store.load();
    expect(store.get().passkeys).toEqual([]);
  });

  it('refuses a registration for another challenge or origin, and one whose admin left the policy', async () => {
    const { passkeys } = make();
    const started = passkeys.startEnrolment(ADMIN);
    const options = passkeys.enrolOptions(started.code);
    const other = randomBytes(32).toString('base64url');
    expect(
      await problemOf(() => passkeys.enrolFinish({ code: started.code, ...createResponse(softPasskey(), other) })),
    ).toBe('wrong-challenge');
    expect(
      await problemOf(() =>
        passkeys.enrolFinish({
          code: started.code,
          ...createResponse(softPasskey(), options.challenge, 'https://agents.home.arpa'),
        }),
      ),
    ).toBe('wrong-origin');
    // A refused submit does not use up the enrolment.
    const submitted = passkeys.enrolFinish({ code: started.code, ...createResponse(softPasskey(), options.challenge) });
    admins.delete(ADMIN);
    expect(await passkeys.confirm(started.enrolmentId, submitted.fingerprint)).toBe('discarded');
  });

  it('refuses to enrol the same credential twice', async () => {
    const { passkeys } = make();
    const { passkey } = await enrol(passkeys);
    const started = passkeys.startEnrolment(OTHER_ADMIN);
    const options = passkeys.enrolOptions(started.code);
    expect(options.excludeCredentials).toEqual([passkey.credentialId.toString('base64url')]);
    const submitted = passkeys.enrolFinish({ code: started.code, ...createResponse(passkey, options.challenge) });
    expect(await passkeys.confirm(started.enrolmentId, submitted.fingerprint)).toBe('discarded');
  });
});

describe('verifying a decision', () => {
  it('names the admin whose passkey signed', async () => {
    const { passkeys } = make();
    const { passkey, fingerprint } = await enrol(passkeys);
    const challenge = randomBytes(32);
    expect(await passkeys.verify(assertionFor(passkey, challenge))).toEqual({ admin: ADMIN, fingerprint });
  });

  it.each<[string, (passkey: SoftPasskey, challenge: Buffer) => ReturnType<typeof assertionFor>, PasskeyProblem]>([
    ['a passkey nobody enrolled', (_p, c) => assertionFor(softPasskey(), c), 'unknown-credential'],
    [
      'an assertion made on another origin',
      (p, c) => assertionFor(p, c, { origin: 'https://agents.home.arpa' }),
      'wrong-origin',
    ],
    [
      'an assertion without user verification',
      (p, c) => assertionFor(p, c, { flags: FLAG_UP }),
      'no-user-verification',
    ],
    ['an assertion for another challenge', (p) => assertionFor(p, randomBytes(32)), 'wrong-challenge'],
    [
      'a credential id that is not base64url',
      (p, c) => ({ ...assertionFor(p, c), credentialId: '!!!' }),
      'unknown-credential',
    ],
  ])('refuses %s', async (_name, build, problem) => {
    const { passkeys } = make();
    const { passkey } = await enrol(passkeys);
    const challenge = randomBytes(32);
    const input = { ...build(passkey, challenge), expectedChallenge: challenge };
    expect(await problemOf(() => passkeys.verify(input))).toBe(problem);
  });

  it('stops accepting a passkey when its admin leaves the policy', async () => {
    const { passkeys } = make();
    const { passkey } = await enrol(passkeys);
    admins.delete(ADMIN);
    expect(await passkeys.credentialIds()).toEqual([]);
    expect(await problemOf(() => passkeys.verify(assertionFor(passkey, randomBytes(32))))).toBe('not-admin');
  });

  it('stops accepting a revoked passkey at once, and a later enrolment does not bring it back', async () => {
    const { passkeys, store, ledgerRows } = make();
    const first = await enrol(passkeys);
    expect((await passkeys.list()).map((p) => p.fingerprint)).toEqual([first.fingerprint]);
    expect(await passkeys.revoke('FFFF-FFFF-FFFF-FFFF')).toBe('not-found');
    expect(await passkeys.revoke(first.fingerprint)).toBe('revoked');
    expect(ledgerRows().at(-1)).toMatchObject({
      event: 'passkey.revoked',
      admin: ADMIN,
      fingerprint: first.fingerprint,
    });
    expect(await problemOf(() => passkeys.verify(assertionFor(first.passkey, randomBytes(32))))).toBe(
      'unknown-credential',
    );
    const second = await enrol(passkeys, OTHER_ADMIN);
    await store.load();
    expect(store.get().passkeys.map((p) => p.fingerprint)).toEqual([second.fingerprint]);
  });

  it('reads the file before each check: a passkey removed from it behind this object is refused', async () => {
    const { passkeys } = make();
    const { passkey } = await enrol(passkeys);
    fs.writeFileSync(path.join(dir, PASSKEY_STATE_FILE), JSON.stringify(initialPasskeyState()));
    expect(await problemOf(() => passkeys.verify(assertionFor(passkey, randomBytes(32))))).toBe('unknown-credential');
  });

  it('refuses every check while the file is unreadable (never falls back to memory)', async () => {
    const { passkeys } = make();
    const { passkey } = await enrol(passkeys);
    fs.writeFileSync(path.join(dir, PASSKEY_STATE_FILE), '{not json');
    await expect(passkeys.verify(assertionFor(passkey, randomBytes(32)))).rejects.toThrow(/not valid JSON/);
    await expect(passkeys.credentialIds()).rejects.toThrow(/not valid JSON/);
  });

  it('keeps at most 8 passkeys per admin', async () => {
    const { passkeys } = make();
    for (let i = 0; i < 8; i++) await enrol(passkeys);
    const started = passkeys.startEnrolment(ADMIN);
    const options = passkeys.enrolOptions(started.code);
    const submitted = passkeys.enrolFinish({ code: started.code, ...createResponse(softPasskey(), options.challenge) });
    expect(await passkeys.confirm(started.enrolmentId, submitted.fingerprint)).toBe('discarded');
    expect(await passkeys.list()).toHaveLength(8);
  });
});
