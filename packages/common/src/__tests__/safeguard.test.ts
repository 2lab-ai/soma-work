/**
 * ssot-task: T1 — recognise an Anthropic safeguards flag.
 *
 * Claude Code hands the block back as the turn's text (field log, dev,
 * 2026-11-04T00:42Z: `stopReason: end_turn, isError: false`), so the text is
 * the only signal. The example is the one the user pasted (SSOT_2).
 */
import { describe, expect, it } from 'vitest';
import { formatSafeguardDetail, isSafeguardFlagError, parseSafeguardFlag } from '../safeguard';

const SSOT_2_EXAMPLE = `API Error: Opus 5.5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Opus 5.5 (1M context).

Try rephrasing the request in a new session or change your model.

Learn more: https://support.claude.com/en/articles/8106465

Details: \`[reasoning_extraction]\`

Request ID: req_011CggxYZxQ7TEBU95XW3X19

Message ID: msg_011CggxYckLHkHA9sUKftEWG`;

describe('parseSafeguardFlag (T1)', () => {
  it('reads the model, the Details code and the request/message ids from the SSOT_2 example', () => {
    expect(parseSafeguardFlag(SSOT_2_EXAMPLE)).toEqual({
      model: 'Opus 5.5 (1M context)',
      detail: 'reasoning_extraction',
      requestId: 'req_011CggxYZxQ7TEBU95XW3X19',
      messageId: 'msg_011CggxYckLHkHA9sUKftEWG',
    });
  });

  it('reads the block with only its Request ID line', () => {
    expect(
      parseSafeguardFlag("API Error: Sonnet 4.6's safeguards flagged this message.\n\nRequest ID: req_abc"),
    ).toEqual({
      model: 'Sonnet 4.6',
      requestId: 'req_abc',
    });
  });

  it('requires an anchor line (Details / Request ID / Message ID) — the bare sentence is not the SDK block', () => {
    expect(parseSafeguardFlag("API Error: Sonnet 4.6's safeguards flagged this message.")).toBeNull();
  });

  it('does not treat the older Usage Policy refusal as a safeguards flag (no authentic anchored sample)', () => {
    const older =
      'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.';
    expect(parseSafeguardFlag(older)).toBeNull();
  });

  it('a turn text must START with the block — an answer that quotes it after prose is not one', () => {
    expect(parseSafeguardFlag(`Here is the error you asked about:\n${SSOT_2_EXAMPLE}`)).toBeNull();
  });

  it('recognises the block on its own line inside a thrown SDK error message', () => {
    expect(
      parseSafeguardFlag(`Claude Code process exited with code 1\n${SSOT_2_EXAMPLE}`, { source: 'error' })?.detail,
    ).toBe('reasoning_extraction');
  });

  it('does not fire on an answer that merely talks about safeguards', () => {
    expect(parseSafeguardFlag('The safeguards flagged this message earlier, so I rephrased it.')).toBeNull();
    expect(parseSafeguardFlag('Here is how our usage policy works.')).toBeNull();
    expect(parseSafeguardFlag('')).toBeNull();
    expect(parseSafeguardFlag(undefined)).toBeNull();
  });

  it('does not fire on a long answer that quotes the error deep inside', () => {
    const quoting = `${'설명 문단입니다. '.repeat(400)}\n${SSOT_2_EXAMPLE}`;
    expect(parseSafeguardFlag(quoting)).toBeNull();
  });
});

describe('parseSafeguardFlag — several errors (review round 2, astra P1 #6)', () => {
  it('finds the block behind a generic API error in the same error source', () => {
    const joined = `API Error: 500 internal server error\n${SSOT_2_EXAMPLE}`;
    expect(parseSafeguardFlag(joined, { source: 'error' })?.detail).toBe('reasoning_extraction');
  });
});

describe('isSafeguardFlagError (T1)', () => {
  it('is true for an error tagged by the content guard', () => {
    const tagged = Object.assign(new Error('blocked'), { safeguardFlag: { detail: 'reasoning_extraction' } });
    expect(isSafeguardFlagError(tagged)).toBe(true);
  });

  it('is true for a thrown error whose message or stderr carries the block', () => {
    expect(isSafeguardFlagError(new Error(SSOT_2_EXAMPLE))).toBe(true);
    expect(isSafeguardFlagError(Object.assign(new Error('exit 1'), { stderrContent: SSOT_2_EXAMPLE }))).toBe(true);
  });

  it('is false for other errors', () => {
    expect(isSafeguardFlagError(new Error('Prompt is too long'))).toBe(false);
    expect(isSafeguardFlagError(null)).toBe(false);
  });
});

describe('formatSafeguardDetail (T4)', () => {
  it('names the model, the Details code and the request id on one line', () => {
    const line = formatSafeguardDetail(parseSafeguardFlag(SSOT_2_EXAMPLE)!);
    expect(line).toContain('Opus 5.5 (1M context)');
    expect(line).toContain('reasoning_extraction');
    expect(line).toContain('req_011CggxYZxQ7TEBU95XW3X19');
  });
});

/**
 * Review round 10 (astra-zhuge P1): the other shapes the installed Claude Code
 * (2.1.284, `dot()` refusal builder) emits for the same API refusal — read from
 * its bundled source, not guessed.
 */
describe('parseSafeguardFlag — every refusal shape the installed CLI emits', () => {
  // Opus 5.5 cyber / bio / frontier_llm: "…flagged this session…" (`vPr`).
  const SESSION_VARIANT = [
    "API Error: Opus 5.5 (1M context)'s safeguards flagged this session (https://www.anthropic.com/legal/aup). " +
      'You may be seeing this for the first time: Opus 5.5 (1M context) is more capable and has stronger safeguards ' +
      'as a result, which can sometimes flag non-cybersecurity work. We’re improving these safeguards to reduce ' +
      "the amount of incorrectly flagged messages. Claude Code can't respond to your last message with Opus 5.5 (1M context).",
    'Learn more: https://support.claude.com/en/articles/8106465',
    '',
    'Details: `[cyber]`',
    'Request ID: req_011SessionVariant1',
    'Message ID: msg_011SessionVariant1',
  ].join('\n');

  // A model the CLI cannot name: "<model> can't help with this. Start a new session to continue."
  const CANT_HELP_VARIANT = [
    "API Error: Claude can't help with this. Start a new session to continue.",
    'Learn more: https://www.anthropic.com/legal/aup',
    'Request ID: req_011CantHelpVariant',
    'Message ID: msg_011CantHelpVariant',
  ].join('\n');

  it('reads the "flagged this session" refusal (cyber / bio / frontier_llm)', () => {
    expect(parseSafeguardFlag(SESSION_VARIANT)).toEqual({
      model: 'Opus 5.5 (1M context)',
      detail: 'cyber',
      requestId: 'req_011SessionVariant1',
      messageId: 'msg_011SessionVariant1',
    });
  });

  it('reads the "can\'t help with this. Start a new session" refusal', () => {
    expect(parseSafeguardFlag(CANT_HELP_VARIANT)).toMatchObject({
      model: 'Claude',
      requestId: 'req_011CantHelpVariant',
    });
  });

  it('reads both in an error source too', () => {
    expect(
      parseSafeguardFlag(`Claude Code process exited with code 1\n${SESSION_VARIANT}`, { source: 'error' }),
    ).not.toBeNull();
    expect(parseSafeguardFlag(`exit 1\n${CANT_HELP_VARIANT}`, { source: 'error' })).not.toBeNull();
  });

  it('still needs an anchor line — the bare sentence is prose', () => {
    expect(parseSafeguardFlag("API Error: Claude can't help with this. Start a new session to continue.")).toBeNull();
  });
});
