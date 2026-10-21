/**
 * T3 follow-up (#auth-capacity-overview) — auth-origin wrapper codec.
 *
 * The `cm:<mode>|<payload>` codec (frozen in @soma/slack) stays untouched;
 * auth-embedded CCT cards wrap the PAYLOAD as `ao:<page>|<inner>` so a
 * mutation click can re-render the auth wrapper at the right page. Modal
 * flows carry the same origin (plus the card surface) through
 * `private_metadata` as JSON, with a bare-string fallback so direct-card
 * metadata (`'slot-B'`) keeps decoding unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeAuthOriginMetadata,
  decodeAuthOriginPayload,
  encodeAuthOriginMetadata,
  encodeAuthOriginPayload,
} from '../auth-origin';

describe('auth-origin payload wrapper (button values)', () => {
  it('roundtrips page + inner payload', () => {
    const encoded = encodeAuthOriginPayload(2, 'slot-B');
    expect(encoded).toBe('ao:2|slot-B');
    expect(decodeAuthOriginPayload(encoded)).toEqual({ origin: { page: 2 }, payload: 'slot-B' });
  });

  it('inner payload may itself contain | and : (compositional)', () => {
    const decoded = decodeAuthOriginPayload(encodeAuthOriginPayload(0, 'a|b:c'));
    expect(decoded).toEqual({ origin: { page: 0 }, payload: 'a|b:c' });
  });

  it('plain payloads pass through with origin null (direct-card values)', () => {
    expect(decodeAuthOriginPayload('slot-B')).toEqual({ origin: null, payload: 'slot-B' });
    expect(decodeAuthOriginPayload('next')).toEqual({ origin: null, payload: 'next' });
    expect(decodeAuthOriginPayload('refresh_all')).toEqual({ origin: null, payload: 'refresh_all' });
  });

  it('malformed ao: shapes are NOT treated as origin (fail to plain payload)', () => {
    for (const raw of ['ao:|x', 'ao:x|y', 'ao:1', 'ao:-1|x', 'ao:1|']) {
      expect(decodeAuthOriginPayload(raw).origin).toBeNull();
      expect(decodeAuthOriginPayload(raw).payload).toBe(raw);
    }
  });

  it('encode rejects invalid pages and empty inner payloads', () => {
    expect(() => encodeAuthOriginPayload(-1, 'x')).toThrow();
    expect(() => encodeAuthOriginPayload(Number.NaN, 'x')).toThrow();
    expect(() => encodeAuthOriginPayload(0, '')).toThrow();
  });
});

describe('auth-origin metadata wrapper (modal private_metadata)', () => {
  it('roundtrips origin (page + surface) and payload', () => {
    const encoded = encodeAuthOriginMetadata({ page: 3, channel: 'C1', ts: 'ts1' }, 'slot-B');
    const decoded = decodeAuthOriginMetadata(encoded);
    expect(decoded.origin).toEqual({ page: 3, channel: 'C1', ts: 'ts1' });
    expect(decoded.payload).toBe('slot-B');
  });

  it('bare keyId metadata (direct-card modals) decodes unchanged with origin null', () => {
    expect(decodeAuthOriginMetadata('slot-B')).toEqual({ origin: null, payload: 'slot-B' });
    expect(decodeAuthOriginMetadata('')).toEqual({ origin: null, payload: '' });
  });

  it('foreign JSON metadata is not mistaken for an auth origin', () => {
    const raw = JSON.stringify({ something: 'else' });
    expect(decodeAuthOriginMetadata(raw)).toEqual({ origin: null, payload: raw });
  });
});
