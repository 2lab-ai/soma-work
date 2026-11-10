import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authenticatorData,
  clientData,
  FLAG_AT,
  FLAG_ED,
  FLAG_UP,
  FLAG_UV,
  signAssertion,
  softPasskey,
} from './__fixtures__/soft-authenticator.js';
import {
  approvalChallenge,
  relyingParty,
  verifyAssertion,
  verifyRegistration,
  WebauthnError,
  type WebauthnProblem,
} from './webauthn.js';

const ORIGIN = 'https://approve.home.arpa:8443';
const rp = relyingParty(ORIGIN);

function problemOf(run: () => unknown): WebauthnProblem | 'no-error' {
  try {
    run();
  } catch (err) {
    if (err instanceof WebauthnError) return err.reason;
    throw err;
  }
  return 'no-error';
}

/** A good assertion; each test bends one field. */
function assertion(
  bend: {
    type?: string;
    challenge?: Buffer;
    origin?: string;
    crossOrigin?: boolean;
    rpId?: string;
    flags?: number;
    extra?: Record<string, unknown>;
  } = {},
) {
  const passkey = softPasskey();
  const reg = verifyRegistration({
    rp,
    expectedChallenge: Buffer.from('enrol-challenge-0001'),
    clientDataJSON: clientData({
      type: 'webauthn.create',
      challenge: Buffer.from('enrol-challenge-0001'),
      origin: ORIGIN,
    }),
    authenticatorData: authenticatorData({
      rpId: rp.rpId,
      flags: FLAG_UP | FLAG_UV | FLAG_AT,
      attested: { credentialId: passkey.credentialId, cose: passkey.cose },
    }),
  });
  const expectedChallenge = randomBytes(32);
  const clientDataJSON = clientData({
    type: bend.type ?? 'webauthn.get',
    challenge: bend.challenge ?? expectedChallenge,
    origin: bend.origin ?? ORIGIN,
    crossOrigin: bend.crossOrigin,
    extra: bend.extra,
  });
  const authData = authenticatorData({
    rpId: bend.rpId ?? rp.rpId,
    flags: bend.flags ?? FLAG_UP | FLAG_UV,
  });
  return {
    passkey,
    input: {
      rp,
      expectedChallenge,
      clientDataJSON,
      authenticatorData: authData,
      signature: signAssertion(passkey.privateKey, authData, clientDataJSON),
      publicKeySpki: reg.publicKeySpki,
    },
  };
}

describe('relyingParty', () => {
  it('takes the rp id from the origin host, exactly', () => {
    expect(rp).toEqual({ origin: ORIGIN, rpId: 'approve.home.arpa' });
    expect(relyingParty('https://devops.iq.home.arpa')).toEqual({
      origin: 'https://devops.iq.home.arpa',
      rpId: 'devops.iq.home.arpa',
    });
  });

  it.each([
    'http://approve.home.arpa:8443',
    'https://approve.home.arpa:8443/',
    'https://approve.home.arpa:8443/a',
    'https://user@approve.home.arpa',
    'https://approve.home.arpa?x=1',
    'https://APPROVE.home.arpa',
    // Names a public CA or the tailnet could certify for whoever runs the proxy.
    'https://approve.example.com',
    'https://host.tailnet.ts.net:8443',
    'https://approve.home.arpa.example.com',
    'https://home.arpa',
    'https://192.168.0.2:8443',
    'https://[::1]:8443',
    'https://localhost:8443',
    'https://approve.home.arpa:443',
    'not a url',
    '',
  ])('refuses %j', (origin) => {
    expect(() => relyingParty(origin)).toThrow(WebauthnError);
  });
});

describe('approvalChallenge', () => {
  const base = { nonce: Buffer.alloc(32, 7), approvalId: 'approval-0001', digest: 'a'.repeat(64), action: 'approve' };

  it('is 32 bytes and the same for the same inputs', () => {
    const one = approvalChallenge({ ...base, action: 'approve' });
    expect(one).toHaveLength(32);
    expect(approvalChallenge({ ...base, action: 'approve' }).equals(one)).toBe(true);
  });

  it('changes with the nonce, the approval, the request digest and the decision', () => {
    const one = approvalChallenge({ ...base, action: 'approve' }).toString('hex');
    const others = [
      approvalChallenge({ ...base, action: 'deny' }),
      approvalChallenge({ ...base, action: 'approve', approvalId: 'approval-0002' }),
      approvalChallenge({ ...base, action: 'approve', digest: 'b'.repeat(64) }),
      approvalChallenge({ ...base, action: 'approve', nonce: Buffer.alloc(32, 8) }),
    ].map((c) => c.toString('hex'));
    expect(new Set([one, ...others]).size).toBe(5);
  });

  it('does not let a field boundary move (ids are length-framed)', () => {
    const a = approvalChallenge({ ...base, action: 'approve', approvalId: 'ab', digest: 'c'.repeat(64) });
    const b = approvalChallenge({ ...base, action: 'approve', approvalId: 'a', digest: `b${'c'.repeat(64)}` });
    expect(a.equals(b)).toBe(false);
  });
});

describe('verifyRegistration', () => {
  function registration(
    bend: {
      type?: string;
      challenge?: Buffer;
      origin?: string;
      crossOrigin?: boolean;
      rpId?: string;
      flags?: number;
      cose?: Buffer;
      extensions?: Buffer;
      truncate?: number;
    } = {},
  ) {
    const passkey = softPasskey();
    const expectedChallenge = randomBytes(32);
    const full = authenticatorData({
      rpId: bend.rpId ?? rp.rpId,
      flags: bend.flags ?? FLAG_UP | FLAG_UV | FLAG_AT,
      attested: { credentialId: passkey.credentialId, cose: bend.cose ?? passkey.cose },
      extensions: bend.extensions,
    });
    return {
      passkey,
      input: {
        rp,
        expectedChallenge,
        clientDataJSON: clientData({
          type: bend.type ?? 'webauthn.create',
          challenge: bend.challenge ?? expectedChallenge,
          origin: bend.origin ?? ORIGIN,
          crossOrigin: bend.crossOrigin,
        }),
        authenticatorData: bend.truncate === undefined ? full : full.subarray(0, bend.truncate),
      },
    };
  }

  it('returns the credential id and a P-256 SPKI key that verifies that passkey', () => {
    const { passkey, input } = registration();
    const result = verifyRegistration(input);
    expect(result.credentialId.equals(passkey.credentialId)).toBe(true);
    expect(result.publicKeySpki.equals(passkey.publicKey.export({ format: 'der', type: 'spki' }))).toBe(true);
  });

  it('refuses anything after the key, with or without the extension flag', () => {
    const extensions = Buffer.from('a0', 'hex');
    expect(problemOf(() => verifyRegistration(registration({ extensions }).input))).toBe('bad-key');
    expect(
      problemOf(() =>
        verifyRegistration(registration({ extensions, flags: FLAG_UP | FLAG_UV | FLAG_AT | FLAG_ED }).input),
      ),
    ).toBe('malformed');
    expect(
      problemOf(() => verifyRegistration(registration({ flags: FLAG_UP | FLAG_UV | FLAG_AT | FLAG_ED }).input)),
    ).toBe('malformed');
  });

  it.each<[string, Parameters<typeof registration>[0], WebauthnProblem]>([
    ['an assertion-type client data', { type: 'webauthn.get' }, 'wrong-type'],
    ['another challenge', { challenge: randomBytes(32) }, 'wrong-challenge'],
    ['another origin', { origin: 'https://dashboard.home.arpa:8443' }, 'wrong-origin'],
    ['a framed page', { crossOrigin: true }, 'cross-origin'],
    ['another rp id', { rpId: 'home.arpa' }, 'wrong-rp'],
    ['no user presence', { flags: FLAG_UV | FLAG_AT }, 'no-user-presence'],
    ['no user verification', { flags: FLAG_UP | FLAG_AT }, 'no-user-verification'],
    ['no attested credential', { flags: FLAG_UP | FLAG_UV }, 'malformed'],
    ['a cut-off credential', { truncate: 60 }, 'malformed'],
    ['a cut-off key', { truncate: 37 + 16 + 2 + 20 + 40 }, 'bad-key'],
    ['a key that is not ES256', { cose: Buffer.from('a401030339010020590100', 'hex') }, 'bad-key'],
  ])('refuses %s', (_name, bend, problem) => {
    expect(problemOf(() => verifyRegistration(registration(bend).input))).toBe(problem);
  });

  it('refuses a point that is not on the curve', () => {
    const passkey = softPasskey();
    const cose = Buffer.from(passkey.cose);
    cose[cose.length - 1] ^= 0x01;
    expect(problemOf(() => verifyRegistration(registration({ cose }).input))).toBe('bad-key');
  });
});

describe('verifyAssertion', () => {
  it('accepts a signed assertion for this origin, challenge and key', () => {
    expect(problemOf(() => verifyAssertion(assertion().input))).toBe('no-error');
  });

  it.each<[string, Parameters<typeof assertion>[0], WebauthnProblem]>([
    ['a registration-type client data', { type: 'webauthn.create' }, 'wrong-type'],
    ['another challenge', { challenge: randomBytes(32) }, 'wrong-challenge'],
    ['another origin', { origin: 'https://agents.home.arpa' }, 'wrong-origin'],
    ['the same host on another port', { origin: 'https://approve.home.arpa:33000' }, 'wrong-origin'],
    ['a framed page', { crossOrigin: true }, 'cross-origin'],
    ['a page that names a top origin', { extra: { topOrigin: 'https://agents.home.arpa' } }, 'cross-origin'],
    ['another rp id', { rpId: 'home.arpa' }, 'wrong-rp'],
    ['no user presence', { flags: FLAG_UV }, 'no-user-presence'],
    ['no user verification (no Touch ID or PIN)', { flags: FLAG_UP }, 'no-user-verification'],
    ['the extension flag', { flags: FLAG_UP | FLAG_UV | FLAG_ED }, 'malformed'],
    ['the attested-credential flag', { flags: FLAG_UP | FLAG_UV | FLAG_AT }, 'malformed'],
  ])('refuses %s', (_name, bend, problem) => {
    expect(problemOf(() => verifyAssertion(assertion(bend).input))).toBe(problem);
  });

  it('refuses a signature from another key', () => {
    const good = assertion().input;
    const other = softPasskey();
    const signature = signAssertion(other.privateKey, good.authenticatorData, good.clientDataJSON);
    expect(problemOf(() => verifyAssertion({ ...good, signature }))).toBe('bad-signature');
  });

  it('refuses when the signed bytes were changed after signing', () => {
    const good = assertion().input;
    // Same key, same challenge, but the client data now names a different decision context.
    const swapped = clientData({
      type: 'webauthn.get',
      challenge: good.expectedChallenge,
      origin: ORIGIN,
      extra: { n: 1 },
    });
    expect(problemOf(() => verifyAssertion({ ...good, clientDataJSON: swapped }))).toBe('bad-signature');
    const authData = Buffer.from(good.authenticatorData);
    authData.writeUInt32BE(9, 33);
    expect(problemOf(() => verifyAssertion({ ...good, authenticatorData: authData }))).toBe('bad-signature');
  });

  it.each<[string, (input: ReturnType<typeof assertion>['input']) => Partial<ReturnType<typeof assertion>['input']>]>([
    ['client data that is not JSON', () => ({ clientDataJSON: Buffer.from('{not json') })],
    ['client data that is not an object', () => ({ clientDataJSON: Buffer.from('"webauthn.get"') })],
    ['client data over the size cap', () => ({ clientDataJSON: Buffer.alloc(5000, 0x20) })],
    ['authenticator data that is too short', (i) => ({ authenticatorData: i.authenticatorData.subarray(0, 36) })],
    [
      'authenticator data with trailing bytes',
      (i) => ({ authenticatorData: Buffer.concat([i.authenticatorData, Buffer.alloc(3)]) }),
    ],
    ['an empty signature', () => ({ signature: Buffer.alloc(0) })],
    ['a stored key that is not SPKI', () => ({ publicKeySpki: Buffer.from('nope') })],
  ])('refuses %s without throwing anything else', (_name, bend) => {
    const good = assertion().input;
    const problem = problemOf(() => verifyAssertion({ ...good, ...bend(good) }));
    expect(['malformed', 'bad-signature', 'bad-key']).toContain(problem);
  });

  it('never puts a received value in the error message', () => {
    const good = assertion({ origin: 'https://evil.example/marker-0001' }).input;
    try {
      verifyAssertion(good);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(WebauthnError);
      expect((err as Error).message).not.toContain('marker-0001');
    }
  });
});
