/**
 * Codec tests for `src/slack/cct/action-value.ts` (#803).
 *
 * Coverage targets per spec:
 *   - 9 invalid-decode cases (no legacy fallback)
 *   - tagged: first-`|` split (payload may contain `|`)
 *   - legacy: any non-empty, non-whitespace, non-prefixed string
 *   - encode: rejects unknown mode, empty/whitespace payload, > 2000 chars
 *   - encode/decode roundtrip
 */

import { describe, expect, it } from 'vitest';
import { decodeCctActionValue, encodeCctActionValue, readCctActionPayload } from '../action-value';

describe('decodeCctActionValue — invalid matrix', () => {
  it('returns invalid for null', () => {
    expect(decodeCctActionValue(null)).toEqual({ kind: 'invalid', raw: null });
  });

  it('returns invalid for undefined', () => {
    expect(decodeCctActionValue(undefined)).toEqual({ kind: 'invalid', raw: undefined });
  });

  it('returns invalid for non-string number', () => {
    expect(decodeCctActionValue(123)).toEqual({ kind: 'invalid', raw: 123 });
  });

  it('returns invalid for empty string', () => {
    expect(decodeCctActionValue('')).toEqual({ kind: 'invalid', raw: '' });
  });

  it('returns invalid for whitespace-only string', () => {
    expect(decodeCctActionValue('   ')).toEqual({ kind: 'invalid', raw: '   ' });
    expect(decodeCctActionValue('\t\n')).toEqual({ kind: 'invalid', raw: '\t\n' });
  });

  it('returns invalid for "cm:" (prefix only, no `|`)', () => {
    expect(decodeCctActionValue('cm:')).toEqual({ kind: 'invalid', raw: 'cm:' });
  });

  it('returns invalid for "cm:admin" (mode but no `|`)', () => {
    expect(decodeCctActionValue('cm:admin')).toEqual({ kind: 'invalid', raw: 'cm:admin' });
  });

  it('returns invalid for "cm:admin|" (empty payload)', () => {
    expect(decodeCctActionValue('cm:admin|')).toEqual({ kind: 'invalid', raw: 'cm:admin|' });
  });

  it('returns invalid for "cm:|abc" (empty mode)', () => {
    expect(decodeCctActionValue('cm:|abc')).toEqual({ kind: 'invalid', raw: 'cm:|abc' });
  });

  it('returns invalid for "cm:bad|abc" (unknown mode)', () => {
    expect(decodeCctActionValue('cm:bad|abc')).toEqual({ kind: 'invalid', raw: 'cm:bad|abc' });
  });
});

describe('decodeCctActionValue — tagged forms', () => {
  it('parses "cm:admin|abc"', () => {
    expect(decodeCctActionValue('cm:admin|abc')).toEqual({ kind: 'tagged', mode: 'admin', payload: 'abc' });
  });

  it('parses "cm:readonly|abc"', () => {
    expect(decodeCctActionValue('cm:readonly|abc')).toEqual({ kind: 'tagged', mode: 'readonly', payload: 'abc' });
  });

  it('splits on the FIRST `|` only — payload retains subsequent separators', () => {
    expect(decodeCctActionValue('cm:admin|abc|def')).toEqual({
      kind: 'tagged',
      mode: 'admin',
      payload: 'abc|def',
    });
  });
});

describe('decodeCctActionValue — legacy form', () => {
  it('parses a non-prefixed non-empty string as legacy', () => {
    expect(decodeCctActionValue('keyid-123')).toEqual({ kind: 'legacy', payload: 'keyid-123' });
  });

  it('parses "next" (the legacy card-level Next button value) as legacy', () => {
    expect(decodeCctActionValue('next')).toEqual({ kind: 'legacy', payload: 'next' });
  });

  it('parses "refresh_card" (legacy Refresh button value) as legacy', () => {
    expect(decodeCctActionValue('refresh_card')).toEqual({ kind: 'legacy', payload: 'refresh_card' });
  });

  it('does NOT treat "cm" (no colon) as a tagged form', () => {
    expect(decodeCctActionValue('cm')).toEqual({ kind: 'legacy', payload: 'cm' });
  });
});

describe('encodeCctActionValue', () => {
  it('encodes admin payload', () => {
    expect(encodeCctActionValue({ mode: 'admin', payload: 'abc' })).toBe('cm:admin|abc');
  });

  it('encodes readonly payload', () => {
    expect(encodeCctActionValue({ mode: 'readonly', payload: 'abc' })).toBe('cm:readonly|abc');
  });

  it('encodes payload containing `|` — codec is compositional', () => {
    expect(encodeCctActionValue({ mode: 'admin', payload: 'a|b|c' })).toBe('cm:admin|a|b|c');
  });

  it('throws on unknown mode', () => {
    expect(() => encodeCctActionValue({ mode: 'bad' as 'admin', payload: 'abc' })).toThrow(/unknown mode/);
  });

  it('throws on empty payload', () => {
    expect(() => encodeCctActionValue({ mode: 'admin', payload: '' })).toThrow(/non-empty/);
  });

  it('throws on whitespace-only payload', () => {
    expect(() => encodeCctActionValue({ mode: 'admin', payload: '   ' })).toThrow(/non-empty|non-whitespace/);
  });

  it('throws when encoded result exceeds Slack 2000-char button-value cap', () => {
    // 'cm:admin|' = 9 chars; payload of 1992 chars → encoded = 2001 (> 2000)
    const tooLong = 'x'.repeat(1992);
    expect(() => encodeCctActionValue({ mode: 'admin', payload: tooLong })).toThrow(/2000/);
  });

  it('accepts encoded result at the 2000-char cap', () => {
    // 'cm:admin|' = 9; payload of 1991 → encoded = 2000 (boundary OK)
    const atCap = 'x'.repeat(1991);
    expect(encodeCctActionValue({ mode: 'admin', payload: atCap })).toHaveLength(2000);
  });
});

describe('encode + decode roundtrip', () => {
  it('admin roundtrip', () => {
    const enc = encodeCctActionValue({ mode: 'admin', payload: 'slot-A' });
    expect(decodeCctActionValue(enc)).toEqual({ kind: 'tagged', mode: 'admin', payload: 'slot-A' });
  });

  it('readonly roundtrip', () => {
    const enc = encodeCctActionValue({ mode: 'readonly', payload: 'slot-B' });
    expect(decodeCctActionValue(enc)).toEqual({ kind: 'tagged', mode: 'readonly', payload: 'slot-B' });
  });
});

describe('readCctActionPayload', () => {
  it('returns the inner payload for tagged values', () => {
    expect(readCctActionPayload('cm:admin|slot-A')).toBe('slot-A');
    expect(readCctActionPayload('cm:readonly|slot-B')).toBe('slot-B');
  });

  it('returns the raw payload for legacy values', () => {
    expect(readCctActionPayload('slot-legacy')).toBe('slot-legacy');
    expect(readCctActionPayload('next')).toBe('next');
  });

  it('returns null for invalid values', () => {
    expect(readCctActionPayload(null)).toBeNull();
    expect(readCctActionPayload('')).toBeNull();
    expect(readCctActionPayload('cm:')).toBeNull();
    expect(readCctActionPayload('cm:admin|')).toBeNull();
    expect(readCctActionPayload('cm:bad|x')).toBeNull();
  });
});
