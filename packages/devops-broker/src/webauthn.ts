// WebAuthn checks for the broker's own approval page (#1056): pure functions over the bytes a browser returns.
// The broker verifies every assertion itself, against keys it stored at enrolment. ES256 (P-256) only, user
// verification always required, and the origin must be the approval page's own — a page served by anyone else
// (the bot's dashboard included) can never produce an assertion that passes here.
//
// No error message carries a received value.

import { createHash, createPublicKey, type KeyObject, timingSafeEqual, verify } from 'node:crypto';

export type DecisionAction = 'approve' | 'deny';

export type WebauthnProblem =
  | 'malformed'
  | 'wrong-type'
  | 'wrong-challenge'
  | 'wrong-origin'
  | 'cross-origin'
  | 'wrong-rp'
  | 'no-user-presence'
  | 'no-user-verification'
  | 'bad-key'
  | 'bad-signature';

const PROBLEM_TEXT: Record<WebauthnProblem, string> = {
  malformed: 'the passkey response is malformed',
  'wrong-type': 'the passkey response is for another kind of ceremony',
  'wrong-challenge': 'the passkey response answers another challenge',
  'wrong-origin': 'the passkey response comes from another origin',
  'cross-origin': 'the passkey response comes from a framed page',
  'wrong-rp': 'the passkey response is for another relying party',
  'no-user-presence': 'the passkey response has no user presence',
  'no-user-verification': 'the passkey response has no user verification',
  'bad-key': 'the passkey public key is not an ES256 (P-256) key',
  'bad-signature': 'the passkey signature does not verify',
};

export class WebauthnError extends Error {
  readonly reason: WebauthnProblem;

  constructor(reason: WebauthnProblem) {
    super(PROBLEM_TEXT[reason]);
    this.name = 'WebauthnError';
    this.reason = reason;
  }
}

function fail(reason: WebauthnProblem): never {
  throw new WebauthnError(reason);
}

export interface RelyingParty {
  /** `https://host[:port]` exactly as the browser writes it in clientDataJSON. */
  origin: string;
  /** The page host. Never a parent domain: a sibling site must not be able to ask for these passkeys. */
  rpId: string;
}

/**
 * `home.arpa` (RFC 8375) is for private networks: no public CA issues a certificate under it, so only a
 * certificate from the installer's own CA can serve this origin. A public or tailnet name could get a
 * certificate from a tool the bot user runs.
 */
export const APPROVAL_HOST_SUFFIX = '.home.arpa';
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The approval page's origin and rp id. Only `https://<name>.home.arpa[:port]` in the form a browser
 * serializes it (lower case, no default port, no path): the comparison with clientDataJSON.origin is then
 * plain equality.
 */
export function relyingParty(origin: string): RelyingParty {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    fail('malformed');
  }
  if (url.protocol !== 'https:' || url.origin !== origin) fail('malformed');
  if (!HOST_RE.test(url.hostname) || !url.hostname.endsWith(APPROVAL_HOST_SUFFIX)) fail('malformed');
  return { origin, rpId: url.hostname };
}

const CHALLENGE_DOMAIN = 'soma-devops-approval-v1';

function framed(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/**
 * What an approval assertion signs: one hash over the broker's nonce, the approval, the digest of the request
 * the card shows, and the decision. A signature for 거부 or for another card is a signature over other bytes.
 */
export function approvalChallenge(input: {
  nonce: Buffer;
  approvalId: string;
  digest: string;
  action: DecisionAction;
}): Buffer {
  return createHash('sha256')
    .update(framed(CHALLENGE_DOMAIN))
    .update(framed(input.nonce.toString('hex')))
    .update(framed(input.approvalId))
    .update(framed(input.digest))
    .update(framed(input.action))
    .digest();
}

const MAX_CLIENT_DATA_BYTES = 4096;
const MAX_AUTH_DATA_BYTES = 2048;
const MAX_SIGNATURE_BYTES = 256;
const AUTH_DATA_HEAD = 37;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkClientData(
  clientDataJSON: Buffer,
  type: 'webauthn.create' | 'webauthn.get',
  rp: RelyingParty,
  expectedChallenge: Buffer,
): void {
  if (clientDataJSON.length === 0 || clientDataJSON.length > MAX_CLIENT_DATA_BYTES) fail('malformed');
  let data: unknown;
  try {
    data = JSON.parse(clientDataJSON.toString('utf8'));
  } catch {
    fail('malformed');
  }
  if (!isRecord(data)) fail('malformed');
  if (typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string') {
    fail('malformed');
  }
  if (data.type !== type) fail('wrong-type');
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(data.challenge)) fail('malformed');
  if (!sameBytes(Buffer.from(data.challenge, 'base64url'), expectedChallenge)) fail('wrong-challenge');
  if (data.origin !== rp.origin) fail('wrong-origin');
  // A top-level page of the broker's own origin writes neither. Anything else was framed by another site.
  if ((data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) {
    fail('cross-origin');
  }
}

/**
 * rp id hash, user presence and user verification; returns the flags. The pages ask for no extension, so
 * extension data is refused rather than parsed. The signature counter is not used: synced passkeys report 0,
 * and a challenge is good for one use.
 */
function checkAuthDataHead(authData: Buffer, rp: RelyingParty): number {
  if (authData.length < AUTH_DATA_HEAD || authData.length > MAX_AUTH_DATA_BYTES) fail('malformed');
  const rpIdHash = createHash('sha256').update(rp.rpId, 'utf8').digest();
  if (!sameBytes(authData.subarray(0, 32), rpIdHash)) fail('wrong-rp');
  const flags = authData[32];
  if ((flags & FLAG_UP) === 0) fail('no-user-presence');
  if ((flags & FLAG_UV) === 0) fail('no-user-verification');
  if ((flags & FLAG_ED) !== 0) fail('malformed');
  return flags;
}

/** COSE EC2 / ES256 / P-256 with 32-byte x and y, in CTAP2 canonical order: the only key shape accepted. */
const COSE_HEAD = Buffer.from('a5010203262001215820', 'hex');
const COSE_MID = Buffer.from('225820', 'hex');
const COSE_KEY_BYTES = COSE_HEAD.length + 32 + COSE_MID.length + 32;
/** DER SubjectPublicKeyInfo header for an uncompressed P-256 point. */
const SPKI_P256_HEAD = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

function p256Key(spki: Buffer): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    fail('bad-key');
  }
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') fail('bad-key');
  return key;
}

function spkiFromCose(cose: Buffer): Buffer {
  if (cose.length !== COSE_KEY_BYTES) fail('bad-key');
  const xAt = COSE_HEAD.length;
  const midAt = xAt + 32;
  const yAt = midAt + COSE_MID.length;
  if (!cose.subarray(0, xAt).equals(COSE_HEAD) || !cose.subarray(midAt, yAt).equals(COSE_MID)) fail('bad-key');
  const spki = Buffer.concat([
    SPKI_P256_HEAD,
    Buffer.from([0x04]),
    cose.subarray(xAt, midAt),
    cose.subarray(yAt, yAt + 32),
  ]);
  // Importing the key checks the point is on the curve.
  p256Key(spki);
  return spki;
}

export interface RegistrationInput {
  rp: RelyingParty;
  expectedChallenge: Buffer;
  clientDataJSON: Buffer;
  /** `AuthenticatorAttestationResponse.getAuthenticatorData()`: the credential id and key are read from here. */
  authenticatorData: Buffer;
}

export interface RegistrationResult {
  credentialId: Buffer;
  /** DER SubjectPublicKeyInfo, derived from the key inside the authenticator data. */
  publicKeySpki: Buffer;
}

const MIN_CREDENTIAL_ID_BYTES = 16;
const MAX_CREDENTIAL_ID_BYTES = 1023;

/**
 * A new passkey (attestation "none"). Nothing here proves which device made it: what authorises an enrolment
 * is the one-time invitation the caller checks. This proves the response is for our origin and challenge,
 * with user verification, and yields the credential id and key from one structure, so they cannot disagree.
 * The attestation object is never read.
 */
export function verifyRegistration(input: RegistrationInput): RegistrationResult {
  checkClientData(input.clientDataJSON, 'webauthn.create', input.rp, input.expectedChallenge);
  const authData = input.authenticatorData;
  const flags = checkAuthDataHead(authData, input.rp);
  if ((flags & FLAG_AT) === 0) fail('malformed');
  const idLengthAt = AUTH_DATA_HEAD + 16;
  if (authData.length < idLengthAt + 2) fail('malformed');
  const idLength = authData.readUInt16BE(idLengthAt);
  if (idLength < MIN_CREDENTIAL_ID_BYTES || idLength > MAX_CREDENTIAL_ID_BYTES) fail('malformed');
  const idAt = idLengthAt + 2;
  const keyAt = idAt + idLength;
  if (authData.length < keyAt + 1) fail('malformed');
  // The key is the last thing in the data: one fixed shape, nothing after it.
  const publicKeySpki = spkiFromCose(authData.subarray(keyAt));
  return { credentialId: Buffer.from(authData.subarray(idAt, keyAt)), publicKeySpki };
}

export interface AssertionInput {
  rp: RelyingParty;
  expectedChallenge: Buffer;
  clientDataJSON: Buffer;
  authenticatorData: Buffer;
  signature: Buffer;
  /** The key stored at enrolment. */
  publicKeySpki: Buffer;
}

/** One assertion. Returns only when every check passed. */
export function verifyAssertion(input: AssertionInput): void {
  checkClientData(input.clientDataJSON, 'webauthn.get', input.rp, input.expectedChallenge);
  const authData = input.authenticatorData;
  const flags = checkAuthDataHead(authData, input.rp);
  // An assertion is the 37-byte head and nothing else.
  if ((flags & FLAG_AT) !== 0 || authData.length !== AUTH_DATA_HEAD) fail('malformed');
  if (input.signature.length === 0 || input.signature.length > MAX_SIGNATURE_BYTES) fail('malformed');
  const key = p256Key(input.publicKeySpki);
  const signed = Buffer.concat([authData, createHash('sha256').update(input.clientDataJSON).digest()]);
  let ok: boolean;
  try {
    ok = verify('sha256', signed, { key, dsaEncoding: 'der' }, input.signature);
  } catch {
    ok = false;
  }
  if (!ok) fail('bad-signature');
}
