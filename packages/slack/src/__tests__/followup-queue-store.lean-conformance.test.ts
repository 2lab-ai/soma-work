/**
 * Conformance of the snapshot gate with its Lean model.
 *
 * `verification/lean/SomaVerify/FollowupSnapshot/Model.lean` transcribes
 * `parseFollowupQueueSnapshot` (`../followup-queue-store.ts:47-284`) check by
 * check, and `Proofs.lean` proves properties of that transcription: it accepts
 * exactly the snapshots the declarative `ValidSnapshot` describes, it returns
 * its input unchanged, and it answers every input exactly as the gate did
 * before its proof-backed simplification (`ModelOriginal.lean`, whose
 * duplicate-seq check could never fire). Those theorems are about the model;
 * this suite ties the model to the code.
 * `SomaVerify/FollowupSnapshot/Vectors.lean` varies one valid snapshot
 * field by field, adds exhaustive state and `nextSeq` grids, and records what
 * the model does with each document: return it, or throw which message. Every
 * case is replayed here against the real exported function.
 *
 * The vector file is regenerated and drift-checked by the "Lean Verify"
 * workflow (`scripts/verification/lean-verify.sh --check`), so it cannot fall
 * behind the model unnoticed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFollowupQueueSnapshot } from '../followup-queue-store';

const repoRoot = path.resolve(__dirname, '../../../..');

type Outcome = { ok: true } | { error: string };

interface SnapshotCase {
  name: string;
  input: unknown;
  expect: Outcome;
}

interface VectorFile {
  module: string;
  generator: string;
  lean: string;
  count: number;
  cases: SnapshotCase[];
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'verification/vectors/followup-snapshot.json'), 'utf8'),
) as VectorFile;

/** The markers for values JSON has no literal for. */
const SPECIAL_LITERALS = new Map<string, unknown>([
  ['undefined', undefined],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
]);

/** The only number literal the generator writes in a marker: no exponent, no hex. */
const DECIMAL_LITERAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Whether `x` is exactly the value of the decimal literal `[-]whole[.fraction]`,
 * sign of zero included. A finite Number is `±significand * 2^exponent`
 * (ECMA-262 section 6.1.6.1), read here from its binary64 bits; the literal is
 * `±digits / 10^fraction.length`; the two are compared by cross-multiplying in
 * BigInt, so nothing is rounded on the way.
 */
function isExactly(x: number, negative: boolean, whole: string, fraction: string): boolean {
  if (!Number.isFinite(x)) return false;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const signBit = bits >> 63n === 1n;
  if (signBit !== negative) return false;
  const biased = (bits >> 52n) & 0x7ffn;
  const stored = bits & ((1n << 52n) - 1n);
  // A biased exponent of 0 is a denormalized value or zero: no implicit leading bit.
  const significand = biased === 0n ? stored : stored | (1n << 52n);
  const exponent = biased === 0n ? -1074n : biased - 1075n;
  const digits = BigInt(whole + fraction);
  const tens = 10n ** BigInt(fraction.length);
  return exponent >= 0n
    ? digits === significand * 2n ** exponent * tens
    : digits * 2n ** -exponent === significand * tens;
}

/**
 * JSON cannot write `undefined`, `NaN`, the infinities or `-0`, and the Lean
 * vector writer has integers only, so the generator writes a number as a plain
 * JSON number only when it is a safe integer, and those values and every other
 * number as `{"$js": "<JS literal>"}`. Decoding is literal and exact: a marker
 * is `undefined`, `NaN`, `±Infinity`, or a decimal literal that must be exactly
 * the Number it parses to, and a plain number must be a safe integer.
 *
 * Exact, because the model reads a number as the exact decimal it is written
 * as and the code gets the Number the parser rounds that literal to: the two
 * judge the same input only when they are the same value. On a literal the
 * parser rounds (`1.0000000000000001` is 1, a 401-digit integer is Infinity)
 * they would not. Objects are rebuilt with the same keys in the same order, and
 * a decoded `undefined` stays an own property: an explicit `undefined`, the
 * shape `FollowupQueue` itself leaves in memory when it clears a field.
 */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === 'number') {
    // A plain number is an integer literal (the Lean writer has no other kind), and an integer
    // literal parses to a safe integer only when it is one: then it was read exactly.
    if (!Number.isSafeInteger(value)) throw new Error(`plain JSON number ${value} is not a safe integer`);
    return value;
  }
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if ('$js' in record) {
    const literal = record.$js;
    if (typeof literal !== 'string' || Object.keys(record).length !== 1) {
      throw new Error(`malformed $js marker: ${JSON.stringify(record)}`);
    }
    if (SPECIAL_LITERALS.has(literal)) return SPECIAL_LITERALS.get(literal);
    const match = DECIMAL_LITERAL.exec(literal);
    if (match === null) throw new Error(`unknown $js literal: ${literal}`);
    const [, sign, whole, fraction = ''] = match;
    const number = Number(literal);
    if (!isExactly(number, sign === '-', whole, fraction)) {
      const parsed = Object.is(number, -0) ? '-0' : String(number);
      throw new Error(`$js literal ${literal} is not exactly a Number: it parses to ${parsed}`);
    }
    return number;
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decode(entry)]));
}

/** What the real gate does with `input`, in the vector file's terms. */
function outcome(input: unknown): Outcome | { returned: 'a different value' } {
  let result: unknown;
  try {
    result = parseFollowupQueueSnapshot(input);
  } catch (error) {
    return { error: error instanceof Error ? error.message : `non-Error thrown: ${String(error)}` };
  }
  // The gate must hand back the very object it was given (no field lost, none rebuilt).
  return result === input ? { ok: true } : { returned: 'a different value' };
}

describe('followup-snapshot Lean conformance vectors', () => {
  it('carry exactly the cases they declare, enough of them, under distinct names', () => {
    expect(vectors.module).toBe('followup-snapshot');
    expect(vectors.count).toBe(vectors.cases.length);
    expect(vectors.count).toBeGreaterThanOrEqual(200);
    expect(new Set(vectors.cases.map((c) => c.name)).size).toBe(vectors.count);
  });

  it('were generated by the pinned Lean toolchain', () => {
    const toolchain = fs.readFileSync(path.join(repoRoot, 'verification/lean/lean-toolchain'), 'utf8').trim();
    expect(toolchain).toBe(`leanprover/lean4:v${vectors.lean}`);
  });

  it('exercise both outcomes', () => {
    const accepted = vectors.cases.filter((c) => 'ok' in c.expect).length;
    expect(accepted).toBeGreaterThan(0);
    expect(vectors.count - accepted).toBeGreaterThan(0);
  });

  it('decode the non-JSON markers to the values they name', () => {
    expect(decode({ $js: 'undefined' })).toBeUndefined();
    expect(Number.isNaN(decode({ $js: 'NaN' }))).toBe(true);
    expect(decode({ $js: 'Infinity' })).toBe(Number.POSITIVE_INFINITY);
    expect(decode({ $js: '-Infinity' })).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(decode({ $js: '-0' }), -0)).toBe(true);
    expect(decode({ $js: '1.5' })).toBe(1.5);
    expect(decode({ $js: '1.0' })).toBe(1);
    const explicit = decode({ steerUuid: { $js: 'undefined' } }) as Record<string, unknown>;
    expect(Object.keys(explicit)).toEqual(['steerUuid']);
    expect(explicit.steerUuid).toBeUndefined();
  });

  it('decode a number only when it is exactly the Number it parses to', () => {
    // Every finite Number is a finite decimal: the two extremes, written out in full.
    expect(decode({ $js: `0.${(5n ** 1074n).toString().padStart(1074, '0')}` })).toBe(Number.MIN_VALUE);
    expect(decode({ $js: ((2n ** 53n - 1n) * 2n ** 971n).toString() })).toBe(Number.MAX_VALUE);
    expect(decode({ $js: '9007199254740992' })).toBe(2 ** 53);
    expect(decode({ $js: '-0.5' })).toBe(-0.5);
    expect(decode(9007199254740991)).toBe(Number.MAX_SAFE_INTEGER);
    // Literals the parser rounds: to 1, 1, -0, Infinity and the Number nearest 0.1. On each, the
    // model would judge the literal and the code the Number.
    for (const literal of [
      '1.0000000000000001',
      '0.99999999999999999',
      `-0.${'0'.repeat(399)}1`,
      `1${'0'.repeat(400)}`,
      '0.1',
    ]) {
      expect(() => decode({ $js: literal }), literal).toThrow(/is not exactly a Number/);
    }
    // The generator writes plain decimals only: no exponent, no hex, no empty string, no bare fraction.
    for (const literal of ['1e400', '0x10', '', '.5']) {
      expect(() => decode({ $js: literal }), literal).toThrow(/unknown \$js literal/);
    }
    // A plain JSON number is a safe integer, the only kind the parser cannot have rounded.
    expect(() => decode(2 ** 53)).toThrow(/is not a safe integer/);
    expect(() => decode(0.5)).toThrow(/is not a safe integer/);
  });

  it('carry only numbers that are exactly the Number they parse to', () => {
    const refused = vectors.cases.flatMap((c) => {
      try {
        decode(c.input);
        return [];
      } catch (error) {
        return [`${c.name}: ${error instanceof Error ? error.message : String(error)}`];
      }
    });
    expect(refused).toEqual([]);
  });

  it('agree with parseFollowupQueueSnapshot on every case: the same object back, or the same message', () => {
    const mismatches = vectors.cases.flatMap((c) => {
      const actual = outcome(decode(c.input));
      return JSON.stringify(actual) === JSON.stringify(c.expect)
        ? []
        : [`${c.name}: code ${JSON.stringify(actual)}, model ${JSON.stringify(c.expect)}`];
    });
    expect(mismatches).toEqual([]);
  });
});
