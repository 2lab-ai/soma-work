/**
 * #1073 — one rule for decision lines, two copies of it.
 *
 * somalib's `normalizeDecisionFields` is whitelist 1 (the validator) and whitelist 2 (the dashboard projection).
 * `@soma/slack` does not import somalib, so it has its own copy for the no-tool path (the fenced-JSON extractor) and
 * as the Slack renderer's own defense. This table holds the two to the same output, and each to a second pass that
 * changes nothing (the command path normalizes twice: validator, then projection or renderer).
 */

import { normalizeDecisionFields as slackNormalize } from '@soma/slack/decision-lines';
import { normalizeDecisionFields as somalibNormalize } from 'somalib/model-commands/validator';
import { describe, expect, it } from 'vitest';

const EMOJI = '😀'; // 4 bytes in UTF-8, a surrogate pair in UTF-16
const TABLE: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['nothing', {}, {}],
  [
    'all four',
    { blockedWork: 'a', stakes: 'b', reversible: false, reversibleWhy: 'c' },
    { blockedWork: 'a', stakes: 'b', reversible: false, reversibleWhy: 'c' },
  ],
  ['whitespace collapses', { blockedWork: '  a\n\n b\t', stakes: 'x\r\ny' }, { blockedWork: 'a b', stakes: 'x y' }],
  ['blank and non-string dropped', { blockedWork: '   ', stakes: 3, reversibleWhy: 'why' }, {}],
  ['reversible strings', { reversible: ' No ', reversibleWhy: 'w' }, { reversible: false, reversibleWhy: 'w' }],
  ['reversible yes', { reversible: 'YES' }, { reversible: true }],
  ['reversible junk drops the why', { reversible: 'maybe', reversibleWhy: 'w' }, {}],
  ['160 kept', { stakes: 'z'.repeat(160) }, { stakes: 'z'.repeat(160) }],
  ['161 cut', { stakes: 'z'.repeat(161) }, { stakes: `${'z'.repeat(159)}…` }],
  [
    'emoji at the cut is never split',
    { stakes: `${'z'.repeat(158)}${EMOJI}${EMOJI}${EMOJI}` },
    { stakes: `${'z'.repeat(158)}${EMOJI}…` },
  ],
  ['other keys ignored', { blockedWork: 'a', context: 'c', question: 'q', secret: 's' }, { blockedWork: 'a' }],
];

describe('decision fields — somalib and @soma/slack normalize alike', () => {
  it.each(TABLE)('%s', (_name, input, expected) => {
    expect(somalibNormalize(input)).toEqual(expected);
    expect(slackNormalize(input)).toEqual(expected);
    expect(somalibNormalize(somalibNormalize(input))).toEqual(expected);
    expect(slackNormalize(slackNormalize(input))).toEqual(expected);
  });

  it('a cut value never ends in half a surrogate pair', () => {
    const out = somalibNormalize({ stakes: EMOJI.repeat(200) }).stakes as string;
    expect(out.endsWith(`${EMOJI}…`)).toBe(true);
    expect(Array.from(out)).toHaveLength(160);
  });

  it('non-objects give nothing', () => {
    for (const v of [null, undefined, 'x', 3, []]) {
      expect(somalibNormalize(v)).toEqual({});
      expect(slackNormalize(v)).toEqual({});
    }
  });
});
