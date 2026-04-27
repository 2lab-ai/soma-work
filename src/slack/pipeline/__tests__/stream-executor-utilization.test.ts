/**
 * Percent-only boundary tests for `normalizeUtilizationToPercent` (#701).
 *
 * Anthropic's `/api/oauth/usage` endpoint sends raw integer percent. The
 * pre-#701 dual-form split at `raw <= 1.5` silently misinterpreted server
 * value `1` (= 1%) as `100%` (fraction form 1.0), corrupting the footer /
 * turn-notifier usage display. This file locks the new single-form contract
 * and prevents a future half-fix from reintroducing the ambiguity at `1`.
 */

import { describe, expect, it } from 'vitest';
import { normalizeUtilizationToPercent } from '../stream-executor';

describe('#701: normalizeUtilizationToPercent percent-only boundary', () => {
  const rows: Array<[number | undefined, number | undefined]> = [
    [undefined, undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [0, 0],
    [0.5, 0.5],
    [1, 1], // THE #701 fix — pre-#701 returned 100
    [1.5, 1.5],
    [2, 2],
    [50, 50],
    [99.99, 100],
    [100, 100],
    [105, 100], // clamp to 100
    [-5, 0], // clamp to 0
  ];

  for (const [input, expected] of rows) {
    it(`normalizeUtilizationToPercent(${input}) → ${expected}`, () => {
      expect(normalizeUtilizationToPercent(input)).toBe(expected);
    });
  }
});
