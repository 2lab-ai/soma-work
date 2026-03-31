import { describe, expect, it, vi } from 'vitest';
import { determineTurnCategory, getCategoryColor, TurnNotifier } from './turn-notifier';

// Contract tests — Scenario 1: TurnNotifier core + Block Kit
// Trace: docs/turn-notification/trace.md

describe('TurnNotifier', () => {
  describe('Category Classification', () => {
    it('categorizes waiting state as UIUserAskQuestion', () => {
      // Trace: Scenario 1, Section 3a
      expect(determineTurnCategory({ hasPendingChoice: true, isError: false })).toBe('UIUserAskQuestion');
    });

    it('categorizes idle state as WorkflowComplete', () => {
      // Trace: Scenario 1, Section 3a
      expect(determineTurnCategory({ hasPendingChoice: false, isError: false })).toBe('WorkflowComplete');
    });

    it('categorizes error as Exception', () => {
      // Trace: Scenario 1, Section 3a
      expect(determineTurnCategory({ hasPendingChoice: false, isError: true })).toBe('Exception');
    });
  });

  describe('Channel Dispatch', () => {
    it('sends to all enabled channels', async () => {
      // Trace: Scenario 1, Section 3b
      const channel1 = {
        name: 'test1',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const channel2 = {
        name: 'test2',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const notifier = new TurnNotifier([channel1, channel2]);

      await notifier.notify({
        category: 'WorkflowComplete',
        userId: 'U123',
        channel: 'C123',
        threadTs: '123.456',
        durationMs: 5000,
      });

      expect(channel1.send).toHaveBeenCalledOnce();
      expect(channel2.send).toHaveBeenCalledOnce();
    });

    it('skips disabled categories', async () => {
      // Trace: Scenario 1, Section 3b
      const channel = { name: 'test', isEnabled: vi.fn().mockResolvedValue(false), send: vi.fn() };
      const notifier = new TurnNotifier([channel]);

      await notifier.notify({
        category: 'WorkflowComplete',
        userId: 'U123',
        channel: 'C123',
        threadTs: '123.456',
        durationMs: 5000,
      });

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('does not block on channel failure', async () => {
      // Trace: Scenario 1, Section 5
      const failChannel = {
        name: 'fail',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockRejectedValue(new Error('boom')),
      };
      const okChannel = {
        name: 'ok',
        isEnabled: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const notifier = new TurnNotifier([failChannel, okChannel]);

      await expect(
        notifier.notify({
          category: 'WorkflowComplete',
          userId: 'U123',
          channel: 'C123',
          threadTs: '123.456',
          durationMs: 5000,
        }),
      ).resolves.toBeUndefined();

      expect(okChannel.send).toHaveBeenCalledOnce();
    });
  });

  describe('Color Mapping', () => {
    it('maps category to correct Block Kit color', () => {
      // Trace: Scenario 1, Section 3b→3c
      expect(getCategoryColor('UIUserAskQuestion')).toBe('#FF9500');
      expect(getCategoryColor('WorkflowComplete')).toBe('#36B37E');
      expect(getCategoryColor('Exception')).toBe('#FF5630');
    });
  });
});
