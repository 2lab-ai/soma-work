/**
 * #617 followup — SDK local slash command passthrough invariant.
 *
 * The user-facing bug: typing `/compact` in Slack posted "🗜️ Triggering
 * context compaction..." but the SDK never actually compacted. Root cause:
 * `preparePrompt` wrapped the text with `<speaker>…</speaker>` + a trailing
 * `<context>…</context>` footer, so the prompt delivered to the Claude
 * Agent SDK `query({ prompt })` call no longer started with `/compact` —
 * the SDK CLI's local-command matcher (only fires when prompt[0]==='/')
 * never triggered and the text went to the LLM as a normal user message.
 *
 * `isLocalSlashCommand` gates the `preparePrompt` bypass in
 * stream-executor.ts. If this matcher ever accepts something it shouldn't
 * (or rejects a legit command), the bypass is wrong. This test file is the
 * regression fence around the matcher.
 */

import { describe, expect, it } from 'vitest';
import { isLocalSlashCommand } from '../local-slash-command';

describe('isLocalSlashCommand — SDK local command matcher', () => {
  describe('positive cases (must return true so bypass triggers)', () => {
    it.each([
      ['/compact'],
      ['/clear'],
      ['/model'],
      ['/cost'],
      ['/status'],
      ['/help'],
      ['/usage'],
    ])('bare command: %s → true', (input) => {
      expect(isLocalSlashCommand(input)).toBe(true);
    });

    it.each([
      ['/compact 2'],
      ['/model opus-4-7'],
      ['/clear all'],
      // Whitespace after command separates args from the command token.
      ['/compact\targ'],
    ])('command with args: %s → true', (input) => {
      expect(isLocalSlashCommand(input)).toBe(true);
    });
  });

  describe('negative cases (must return false so normal preparePrompt runs)', () => {
    it.each([
      // Unknown commands — must NOT be passed raw. Safer to wrap and let the
      // SDK treat them as LLM input.
      ['/foo'],
      ['/compacts'],
      ['/compacta'],
      ['/compactx arg'],
      // Leading whitespace — caller must trim first. Matching pre-trimmed
      // preserves intent: ` /compact` is probably not a command typed deliberately.
      [' /compact'],
      ['\t/compact'],
      // Slash is not first character — preparePrompt wrapping would have
      // already happened or the user is not invoking a command.
      ['hey /compact'],
      ['<speaker>u</speaker>\n/compact'],
      // Empty / non-slash text
      [''],
      ['compact'],
      ['compact /compact'],
    ])('non-command: %j → false', (input) => {
      expect(isLocalSlashCommand(input)).toBe(false);
    });
  });

  it('regression: /compact alone is the most critical positive', () => {
    // This is the exact case that broke in production — PR #620 AC3 also
    // depends on this returning true.
    expect(isLocalSlashCommand('/compact')).toBe(true);
  });

  it('regression: wrapped prompt produced by preparePrompt is NOT a slash command', () => {
    // This is the exact string shape `preparePrompt` produces — if the bypass
    // accidentally matched it, we'd never actually wrap real messages.
    const wrapped = '<speaker>Zhuge</speaker>\n/compact\n\n<context>...</context>';
    expect(isLocalSlashCommand(wrapped)).toBe(false);
  });
});
