// The admins' passkeys for the broker's own approval page (#1056): enrolment and the check behind every
// page decision.
//
// Enrolment is started by the operator from a sudo terminal and ends there. The terminal prints a one-time
// address (the code is its fragment); the admin opens it, the page creates a passkey and shows its
// fingerprint; the operator types that fingerprint back into the terminal. Only then is the passkey stored.
// The first passkey submitted for a code is the only candidate, so someone who read the code can make the
// admin's attempt fail but cannot get a key enrolled: the admin never sees a fingerprint to type.
//
// What this rests on: the admin opens the printed address itself (not a page that asks for the code), and
// the operator's terminal is not driven by the attacker. Where the operator account is the bot user, the
// second does not hold against the model.
//
// The broker process is the only writer of the passkey file. Every check re-reads it, so a revoked passkey
// stops working at once. Nothing here is reachable from the bot user's socket.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Ledger } from './ledger.js';
import type { StateStore } from './state.js';
import {
  type RelyingParty,
  verifyAssertion,
  verifyRegistration,
  WebauthnError,
  type WebauthnProblem,
} from './webauthn.js';

export type PasskeyProblem =
  | WebauthnProblem
  | 'bad-code'
  | 'already-submitted'
  | 'not-admin'
  | 'busy'
  | 'unknown-credential';

const PROBLEM_TEXT: Partial<Record<PasskeyProblem, string>> = {
  'bad-code': 'the enrolment code is wrong or no longer valid',
  'already-submitted': 'a passkey was already submitted for this enrolment',
  'not-admin': 'this user is not an admin in the broker policy',
  busy: 'another enrolment is open; finish or cancel it first',
  'unknown-credential': 'this passkey is not enrolled',
};

export class PasskeyError extends Error {
  readonly reason: PasskeyProblem;

  constructor(reason: PasskeyProblem, message?: string) {
    super(message ?? PROBLEM_TEXT[reason] ?? 'the passkey response was refused');
    this.name = 'PasskeyError';
    this.reason = reason;
  }
}

/** Runs a WebAuthn check; its refusal keeps its reason. */
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof WebauthnError) throw new PasskeyError(err.reason, err.message);
    throw err;
  }
}

export interface PasskeyRecord {
  /** Slack user id, as in `policy.admins`. A passkey counts only while its admin is in the policy. */
  admin: string;
  /** base64url, as the browser reports `PublicKeyCredential.id`. */
  credentialId: string;
  /** base64 DER SubjectPublicKeyInfo (P-256). */
  publicKeySpki: string;
  fingerprint: string;
  createdAt: string;
}

export interface PasskeyState {
  passkeys: PasskeyRecord[];
}

/** Lives in the broker's state directory (`state/passkeys.json`, 0600 in a 0700 directory). */
export const PASSKEY_STATE_FILE = 'passkeys.json';
export const ENROLMENT_TTL_MS = 10 * 60 * 1000;
export const MAX_PASSKEYS_PER_ADMIN = 8;

export function initialPasskeyState(): PasskeyState {
  return { passkeys: [] };
}

/** What the enrol page passes to `navigator.credentials.create` (binary fields as base64url). */
export interface EnrolOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  excludeCredentials: string[];
  timeoutMs: number;
}

export interface AssertionResponse {
  credentialId: string;
  expectedChallenge: Buffer;
  clientDataJSON: Buffer;
  authenticatorData: Buffer;
  signature: Buffer;
}

export interface Passkeys {
  /** Operator only. Opens the one enrolment; the code is returned once and kept nowhere. */
  startEnrolment(admin: string): { enrolmentId: string; code: string; expiresAt: string };
  /** Operator only. `submitted` = the page handed in a passkey and waits for the fingerprint. */
  enrolmentStatus(enrolmentId: string): 'waiting' | 'submitted' | 'gone';
  /**
   * Operator only. `fingerprint` as read from the enrol page; null = discard. Anything but an exact match
   * discards the submitted passkey and ends the enrolment.
   */
  confirm(
    enrolmentId: string,
    fingerprint: string | null,
  ): Promise<'enrolled' | 'discarded' | 'not-submitted' | 'gone'>;
  cancelEnrolment(enrolmentId: string): void;
  /** Whether the enrol page has anything to do right now. */
  enrolmentOpen(): boolean;
  /** Page: the code opens the registration options. */
  enrolOptions(code: string): EnrolOptions;
  /** Page: the new passkey. Returns the fingerprint to show; nothing is stored yet. */
  enrolFinish(input: { code: string; clientDataJSON: Buffer; authenticatorData: Buffer }): { fingerprint: string };
  /** The credential ids of current admins (for the page's `allowCredentials`). */
  credentialIds(): Promise<string[]>;
  /** Checks one assertion against the enrolled key. Throws PasskeyError. */
  verify(input: AssertionResponse): Promise<{ admin: string; fingerprint: string }>;
  list(): Promise<Pick<PasskeyRecord, 'admin' | 'fingerprint' | 'createdAt'>[]>;
  revoke(fingerprint: string): Promise<'revoked' | 'not-found'>;
}

const RP_NAME = 'soma devops approvals';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 20;
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{16,1400}$/;

/** 100 bits, shown as four groups of five. */
function freshCode(): string {
  const bytes = randomBytes(CODE_CHARS);
  let text = '';
  for (let i = 0; i < CODE_CHARS; i++) text += CROCKFORD[bytes[i] & 31];
  return text.replace(/(.{5})(?=.)/g, '$1-');
}

function codeHash(code: string): Buffer {
  const normal = code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return createHash('sha256').update(`soma-devops-enrol-code-v1:${normal}`, 'utf8').digest();
}

function normalFingerprint(text: string): string {
  return text.toUpperCase().replace(/[^0-9A-F]/g, '');
}

/** 64 bits over the credential id and key, shown as `XXXX-XXXX-XXXX-XXXX`. */
export function passkeyFingerprint(credentialId: Buffer, publicKeySpki: Buffer): string {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(credentialId.length, 0);
  const hex = createHash('sha256')
    .update('soma-devops-passkey-v1')
    .update(length)
    .update(credentialId)
    .update(publicKeySpki)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return hex.replace(/(.{4})(?=.)/g, '$1-');
}

interface Enrolment {
  enrolmentId: string;
  admin: string;
  codeHash: Buffer;
  expiresAtMs: number;
  userHandle: Buffer;
  challenge?: Buffer;
  candidate?: { credentialId: string; publicKeySpki: string; fingerprint: string };
}

function isPasskeyRecord(value: unknown): value is PasskeyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.admin === 'string' &&
    typeof r.credentialId === 'string' &&
    typeof r.publicKeySpki === 'string' &&
    typeof r.fingerprint === 'string' &&
    typeof r.createdAt === 'string'
  );
}

export function createPasskeys(opts: {
  rp: RelyingParty;
  /** Read at every use, so a policy without the admin ends their passkeys. */
  isAdmin(user: string): boolean;
  store: StateStore<PasskeyState>;
  ledger: Ledger;
  now?: () => number;
}): Passkeys {
  const { rp, isAdmin, store, ledger } = opts;
  const clock = opts.now ?? Date.now;
  let open: Enrolment | undefined;

  /** The file, not this process's memory, is the authority. A malformed entry is never used. */
  async function records(): Promise<PasskeyRecord[]> {
    await store.load();
    const state = store.get();
    return Array.isArray(state.passkeys) ? state.passkeys.filter(isPasskeyRecord) : [];
  }

  function current(): Enrolment | undefined {
    if (open !== undefined && clock() >= open.expiresAtMs) {
      const expired = open;
      open = undefined;
      void ledger
        .append({ event: 'passkey.enrol-discarded', admin: expired.admin, reason: 'expired' })
        .catch(() => undefined);
    }
    return open;
  }

  function byCode(code: string): Enrolment {
    const enrolment = current();
    if (enrolment === undefined || typeof code !== 'string' || code.length > 64) throw new PasskeyError('bad-code');
    if (!timingSafeEqual(codeHash(code), enrolment.codeHash)) throw new PasskeyError('bad-code');
    if (enrolment.candidate !== undefined) throw new PasskeyError('already-submitted');
    return enrolment;
  }

  function byId(enrolmentId: string): Enrolment | undefined {
    const enrolment = current();
    return enrolment !== undefined && enrolment.enrolmentId === enrolmentId ? enrolment : undefined;
  }

  async function discard(enrolment: Enrolment, reason: string): Promise<'discarded'> {
    if (open === enrolment) open = undefined;
    await ledger.append({ event: 'passkey.enrol-discarded', admin: enrolment.admin, reason }).catch(() => undefined);
    return 'discarded';
  }

  return {
    startEnrolment(admin) {
      if (!isAdmin(admin)) throw new PasskeyError('not-admin');
      if (current() !== undefined) throw new PasskeyError('busy');
      const code = freshCode();
      const expiresAtMs = clock() + ENROLMENT_TTL_MS;
      open = {
        enrolmentId: randomBytes(16).toString('base64url'),
        admin,
        codeHash: codeHash(code),
        expiresAtMs,
        userHandle: randomBytes(16),
      };
      void ledger.append({ event: 'passkey.enrol-started', admin }).catch(() => undefined);
      return { enrolmentId: open.enrolmentId, code, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    enrolmentStatus(enrolmentId) {
      const enrolment = byId(enrolmentId);
      if (enrolment === undefined) return 'gone';
      return enrolment.candidate === undefined ? 'waiting' : 'submitted';
    },

    enrolmentOpen() {
      return current() !== undefined;
    },

    cancelEnrolment(enrolmentId) {
      const enrolment = byId(enrolmentId);
      if (enrolment !== undefined) void discard(enrolment, 'cancelled');
    },

    enrolOptions(code) {
      const enrolment = byCode(code);
      enrolment.challenge = randomBytes(32);
      const state = store.get();
      const known = Array.isArray(state.passkeys) ? state.passkeys.filter(isPasskeyRecord) : [];
      return {
        challenge: enrolment.challenge.toString('base64url'),
        rp: { id: rp.rpId, name: RP_NAME },
        user: {
          id: enrolment.userHandle.toString('base64url'),
          name: `${RP_NAME} (${enrolment.admin})`,
          displayName: `${RP_NAME} (${enrolment.admin})`,
        },
        excludeCredentials: known.map((record) => record.credentialId),
        timeoutMs: Math.max(0, Math.min(120_000, enrolment.expiresAtMs - clock())),
      };
    },

    enrolFinish(input) {
      const enrolment = byCode(input.code);
      if (enrolment.challenge === undefined) throw new PasskeyError('wrong-challenge');
      const expectedChallenge = enrolment.challenge;
      const registration = checked(() =>
        verifyRegistration({
          rp,
          expectedChallenge,
          clientDataJSON: input.clientDataJSON,
          authenticatorData: input.authenticatorData,
        }),
      );
      const fingerprint = passkeyFingerprint(registration.credentialId, registration.publicKeySpki);
      enrolment.candidate = {
        credentialId: registration.credentialId.toString('base64url'),
        publicKeySpki: registration.publicKeySpki.toString('base64'),
        fingerprint,
      };
      delete enrolment.challenge;
      return { fingerprint };
    },

    async confirm(enrolmentId, fingerprint) {
      const enrolment = byId(enrolmentId);
      if (enrolment === undefined) return 'gone';
      if (fingerprint === null) return discard(enrolment, 'operator-declined');
      const candidate = enrolment.candidate;
      if (candidate === undefined) return 'not-submitted';
      // From here the enrolment is over whatever happens: one candidate, one answer.
      open = undefined;
      const typed = Buffer.from(normalFingerprint(fingerprint), 'utf8');
      const shown = Buffer.from(normalFingerprint(candidate.fingerprint), 'utf8');
      if (typed.length !== shown.length || !timingSafeEqual(typed, shown)) {
        return discard(enrolment, 'fingerprint-mismatch');
      }
      if (!isAdmin(enrolment.admin)) return discard(enrolment, 'not-admin');
      const record: PasskeyRecord = {
        admin: enrolment.admin,
        credentialId: candidate.credentialId,
        publicKeySpki: candidate.publicKeySpki,
        fingerprint: candidate.fingerprint,
        createdAt: new Date(clock()).toISOString(),
      };
      await store.load();
      const refused = await store.update((draft) => {
        if (!Array.isArray(draft.passkeys)) draft.passkeys = [];
        if (draft.passkeys.some((p) => p.credentialId === record.credentialId)) return 'already-enrolled';
        if (draft.passkeys.filter((p) => p.admin === record.admin).length >= MAX_PASSKEYS_PER_ADMIN) {
          return 'too-many-passkeys';
        }
        draft.passkeys.push(record);
        return null;
      });
      if (refused !== null) return discard(enrolment, refused);
      try {
        await ledger.append({ event: 'passkey.enrolled', admin: record.admin, fingerprint: record.fingerprint });
      } catch {
        // No audit row, no passkey.
        await store.update((draft) => {
          draft.passkeys = draft.passkeys.filter((p) => p.credentialId !== record.credentialId);
        });
        return 'discarded';
      }
      return 'enrolled';
    },

    async credentialIds() {
      return (await records()).filter((record) => isAdmin(record.admin)).map((record) => record.credentialId);
    },

    async verify(input) {
      if (typeof input.credentialId !== 'string' || !CREDENTIAL_ID_RE.test(input.credentialId)) {
        throw new PasskeyError('unknown-credential');
      }
      const record = (await records()).find((r) => r.credentialId === input.credentialId);
      if (record === undefined) throw new PasskeyError('unknown-credential');
      if (!isAdmin(record.admin)) throw new PasskeyError('not-admin');
      checked(() =>
        verifyAssertion({
          rp,
          expectedChallenge: input.expectedChallenge,
          clientDataJSON: input.clientDataJSON,
          authenticatorData: input.authenticatorData,
          signature: input.signature,
          publicKeySpki: Buffer.from(record.publicKeySpki, 'base64'),
        }),
      );
      return { admin: record.admin, fingerprint: record.fingerprint };
    },

    async list() {
      return (await records()).map(({ admin, fingerprint, createdAt }) => ({ admin, fingerprint, createdAt }));
    },

    async revoke(fingerprint) {
      const wanted = normalFingerprint(fingerprint);
      await store.load();
      const removed = await store.update((draft) => {
        if (!Array.isArray(draft.passkeys)) draft.passkeys = [];
        const at = draft.passkeys.findIndex((p) => normalFingerprint(p.fingerprint) === wanted);
        return at < 0 ? null : draft.passkeys.splice(at, 1)[0];
      });
      if (removed === null) return 'not-found';
      await ledger
        .append({ event: 'passkey.revoked', admin: removed.admin, fingerprint: removed.fingerprint })
        .catch(() => undefined);
      return 'revoked';
    },
  };
}
