// A software passkey for tests: builds the bytes a browser hands back from navigator.credentials.create / get,
// signed with a real P-256 key, so the broker's WebAuthn checks run against the wire format.

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

export interface SoftPasskey {
  credentialId: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** The credential public key as CTAP2 writes it (COSE EC2, canonical order). */
  cose: Buffer;
}

function coseKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(String(jwk.x), 'base64url');
  const y = Buffer.from(String(jwk.y), 'base64url');
  return Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), x, Buffer.from('225820', 'hex'), y]);
}

export function softPasskey(): SoftPasskey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { credentialId: randomBytes(20), privateKey, publicKey, cose: coseKey(publicKey) };
}

export function clientData(fields: {
  type: string;
  challenge: Buffer;
  origin: string;
  crossOrigin?: boolean;
  extra?: Record<string, unknown>;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: fields.type,
      challenge: fields.challenge.toString('base64url'),
      origin: fields.origin,
      ...(fields.crossOrigin === undefined ? {} : { crossOrigin: fields.crossOrigin }),
      ...fields.extra,
    }),
    'utf8',
  );
}

export function authenticatorData(fields: {
  rpId: string;
  flags: number;
  signCount?: number;
  attested?: { credentialId: Buffer; cose: Buffer };
  extensions?: Buffer;
}): Buffer {
  const head = Buffer.alloc(37);
  createHash('sha256').update(fields.rpId, 'utf8').digest().copy(head, 0);
  head[32] = fields.flags;
  head.writeUInt32BE(fields.signCount ?? 0, 33);
  const parts = [head];
  if (fields.attested) {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(fields.attested.credentialId.length, 0);
    parts.push(Buffer.alloc(16), length, fields.attested.credentialId, fields.attested.cose);
  }
  if (fields.extensions) parts.push(fields.extensions);
  return Buffer.concat(parts);
}

/** The assertion signature: ES256 (DER) over authenticatorData || SHA-256(clientDataJSON). */
export function signAssertion(key: KeyObject, authData: Buffer, clientDataJSON: Buffer): Buffer {
  const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
  return sign('sha256', signed, { key, dsaEncoding: 'der' });
}
