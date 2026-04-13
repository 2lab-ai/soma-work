/**
 * Slack refs tests (Issue #409)
 */

import { describe, expect, it } from 'vitest';
import {
  extractSlackMessageRef,
  extractSlackRef,
  type SlackConversationRef,
  type SlackMessageRef,
  slackMessageHandle,
  slackTarget,
} from './slack-refs.js';

describe('Slack refs', () => {
  describe('slackTarget', () => {
    it('creates a ConversationTarget with Slack ref', () => {
      const target = slackTarget('U123', 'C456', '1700000000.000000');

      expect(target.platform).toBe('slack');
      expect(target.userId).toBe('U123');

      const ref = target.ref as SlackConversationRef;
      expect(ref.channel).toBe('C456');
      expect(ref.threadTs).toBe('1700000000.000000');
    });

    it('creates target without threadTs', () => {
      const target = slackTarget('U123', 'C456');

      const ref = target.ref as SlackConversationRef;
      expect(ref.threadTs).toBeUndefined();
    });
  });

  describe('slackMessageHandle', () => {
    it('creates a MessageHandle with Slack ref', () => {
      const handle = slackMessageHandle('C456', '1700000000.000100');

      expect(handle.platform).toBe('slack');

      const ref = handle.ref as SlackMessageRef;
      expect(ref.channel).toBe('C456');
      expect(ref.ts).toBe('1700000000.000100');
    });
  });

  describe('extractSlackRef', () => {
    it('extracts ref from Slack target', () => {
      const target = slackTarget('U123', 'C456', '1700000000.000000');
      const ref = extractSlackRef(target);

      expect(ref.channel).toBe('C456');
      expect(ref.threadTs).toBe('1700000000.000000');
    });

    it('throws for non-Slack target', () => {
      const target = { platform: 'web' as const, ref: {}, userId: 'U123' };
      expect(() => extractSlackRef(target)).toThrow('Expected Slack target');
    });
  });

  describe('extractSlackMessageRef', () => {
    it('extracts ref from Slack message handle', () => {
      const handle = slackMessageHandle('C456', '1700000000.000100');
      const ref = extractSlackMessageRef(handle);

      expect(ref.channel).toBe('C456');
      expect(ref.ts).toBe('1700000000.000100');
    });

    it('throws for non-Slack handle', () => {
      const handle = { platform: 'telegram' as const, ref: {} };
      expect(() => extractSlackMessageRef(handle)).toThrow('Expected Slack message handle');
    });
  });
});
