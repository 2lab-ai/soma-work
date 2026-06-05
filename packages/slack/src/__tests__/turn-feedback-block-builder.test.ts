import { describe, expect, it } from 'vitest';
import {
  buildFeedbackAckBlock,
  buildFeedbackContextActions,
  encodeFeedbackValue,
  parseFeedbackValue,
  TURN_FEEDBACK_ACTION_ID,
} from '../turn-feedback-block-builder';

describe('turn-feedback-block-builder', () => {
  describe('encode/parse round-trip', () => {
    it('round-trips positive and negative', () => {
      expect(parseFeedbackValue(encodeFeedbackValue('positive', 't1'))).toEqual({
        sentiment: 'positive',
        turnId: 't1',
      });
      expect(parseFeedbackValue(encodeFeedbackValue('negative', 't1'))).toEqual({
        sentiment: 'negative',
        turnId: 't1',
      });
    });

    it('preserves turnIds containing colons (sessionKey:ts:uuid)', () => {
      const turnId = 'C0AKY:1700.55:9f-1a-2b';
      expect(parseFeedbackValue(encodeFeedbackValue('positive', turnId))?.turnId).toBe(turnId);
    });

    it('returns null on malformed/empty values', () => {
      expect(parseFeedbackValue(undefined)).toBeNull();
      expect(parseFeedbackValue('')).toBeNull();
      expect(parseFeedbackValue('nocolon')).toBeNull();
      expect(parseFeedbackValue('weird:')).toBeNull();
      expect(parseFeedbackValue(':t1')).toBeNull();
      expect(parseFeedbackValue('sideways:t1')).toBeNull();
    });
  });

  describe('buildFeedbackContextActions', () => {
    const block = buildFeedbackContextActions('t1') as any;

    it('is a context_actions block with a single feedback_buttons element', () => {
      expect(block.type).toBe('context_actions');
      expect(block.elements).toHaveLength(1);
      expect(block.elements.length).toBeLessThanOrEqual(5); // Slack limit
      expect(block.elements[0].type).toBe('feedback_buttons');
    });

    it('uses the stable versioned action_id', () => {
      expect(block.elements[0].action_id).toBe(TURN_FEEDBACK_ACTION_ID);
      expect(TURN_FEEDBACK_ACTION_ID).toBe('turn_feedback_v1');
    });

    it('builds plain_text button labels and encoded values within Slack limits', () => {
      const fb = block.elements[0];
      for (const btn of [fb.positive_button, fb.negative_button]) {
        expect(btn.text.type).toBe('plain_text');
        expect(btn.text.text.length).toBeLessThanOrEqual(75);
        expect(btn.value.length).toBeLessThanOrEqual(2000);
      }
      expect(parseFeedbackValue(fb.positive_button.value)?.sentiment).toBe('positive');
      expect(parseFeedbackValue(fb.negative_button.value)?.sentiment).toBe('negative');
    });
  });

  describe('buildFeedbackAckBlock', () => {
    it('renders a non-interactive context block with the chosen emoji', () => {
      const pos = buildFeedbackAckBlock('positive') as any;
      expect(pos.type).toBe('context');
      expect(pos.elements[0].text).toContain('👍');
      const neg = buildFeedbackAckBlock('negative') as any;
      expect(neg.elements[0].text).toContain('👎');
    });
  });
});
