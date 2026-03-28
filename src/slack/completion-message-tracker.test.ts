import { describe, it, expect, vi } from 'vitest';
import { CompletionMessageTracker } from './completion-message-tracker.js';

// Trace: docs/turn-summary-lifecycle/trace.md

describe('CompletionMessageTracker', () => {
  // S6: Completion Message Track
  describe('S6 — Track', () => {
    // Trace: S6, Section 3b
    it('track() adds messageTs to tracked set', () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-1', '1234.5678', 'WorkflowComplete');
      expect(tracker.has('session-1')).toBe(true);
      expect(tracker.count('session-1')).toBe(1);
    });

    // Trace: S6, Section 5 row 1
    it('track() skips Exception category', () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-1', '1234.5678', 'Exception');
      expect(tracker.has('session-1')).toBe(false);
      expect(tracker.count('session-1')).toBe(0);
    });

    // Trace: S6, Section 5 row 2
    it('track() creates new Set if first message for session', () => {
      const tracker = new CompletionMessageTracker();
      // No prior state for this session
      expect(tracker.has('session-new')).toBe(false);
      tracker.track('session-new', '1111.0001', 'UIUserAskQuestion');
      expect(tracker.has('session-new')).toBe(true);
      expect(tracker.count('session-new')).toBe(1);
    });
  });

  // S7: Completion Message Delete on User Input
  describe('S7 — Delete on User Input', () => {
    // Trace: S7, Section 3b
    it('deleteAll() calls chat.delete for all tracked messages', async () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-1', '1000.0001', 'WorkflowComplete');
      tracker.track('session-1', '1000.0002', 'UIUserAskQuestion');
      tracker.track('session-1', '1000.0003', 'WorkflowComplete');

      const deleteMessage = vi.fn<(channel: string, ts: string) => Promise<void>>().mockResolvedValue(undefined);

      await tracker.deleteAll('session-1', deleteMessage, 'C-CHANNEL');

      expect(deleteMessage).toHaveBeenCalledTimes(3);
      expect(deleteMessage).toHaveBeenCalledWith('C-CHANNEL', '1000.0001');
      expect(deleteMessage).toHaveBeenCalledWith('C-CHANNEL', '1000.0002');
      expect(deleteMessage).toHaveBeenCalledWith('C-CHANNEL', '1000.0003');

      // After deletion, session should be cleared
      expect(tracker.has('session-1')).toBe(false);
      expect(tracker.count('session-1')).toBe(0);
    });

    // Trace: S7, Section 5 row 1
    it('deleteAll() is a no-op if no tracked messages', async () => {
      const tracker = new CompletionMessageTracker();
      const deleteMessage = vi.fn<(channel: string, ts: string) => Promise<void>>().mockResolvedValue(undefined);

      await tracker.deleteAll('session-empty', deleteMessage, 'C-CHANNEL');

      expect(deleteMessage).not.toHaveBeenCalled();
    });

    // Trace: S7, Section 5 row 2
    it('deleteAll() tolerates individual delete failures', async () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-1', '1000.0001', 'WorkflowComplete');
      tracker.track('session-1', '1000.0002', 'UIUserAskQuestion');

      const deleteMessage = vi.fn<(channel: string, ts: string) => Promise<void>>();
      deleteMessage.mockImplementation(async (_channel: string, ts: string) => {
        if (ts === '1000.0001') {
          throw new Error('message_not_found');
        }
      });

      // Should not throw even though one deletion fails
      await expect(tracker.deleteAll('session-1', deleteMessage, 'C-CHANNEL')).resolves.toBeUndefined();

      // Both deletes were attempted
      expect(deleteMessage).toHaveBeenCalledTimes(2);

      // Session is still cleaned up
      expect(tracker.has('session-1')).toBe(false);
    });
  });

  // S9: Error Messages Persist
  describe('S9 — Error Messages Persist', () => {
    // Trace: S9, Section 3a
    it('Exception category messages are NOT tracked', () => {
      const tracker = new CompletionMessageTracker();

      // Track a mix of categories
      tracker.track('session-1', '1000.0001', 'WorkflowComplete');
      tracker.track('session-1', '1000.0002', 'Exception');
      tracker.track('session-1', '1000.0003', 'UIUserAskQuestion');

      // Only non-Exception messages should be tracked
      expect(tracker.count('session-1')).toBe(2);
    });
  });

  describe('Dedup', () => {
    it('track() does not duplicate the same timestamp', () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-1', '1000.0001', 'WorkflowComplete');
      tracker.track('session-1', '1000.0001', 'WorkflowComplete');
      expect(tracker.count('session-1')).toBe(1);
    });
  });

  describe('Session isolation', () => {
    it('different sessions have independent tracked sets', async () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-A', '1000.0001', 'WorkflowComplete');
      tracker.track('session-B', '2000.0001', 'WorkflowComplete');

      const deleteMessage = vi.fn<(channel: string, ts: string) => Promise<void>>().mockResolvedValue(undefined);

      await tracker.deleteAll('session-A', deleteMessage, 'C-CHANNEL');

      expect(tracker.has('session-A')).toBe(false);
      expect(tracker.has('session-B')).toBe(true);
      expect(tracker.count('session-B')).toBe(1);
    });
  });

  describe('Race condition — track() during deleteAll()', () => {
    it('preserves timestamps added by track() during deleteAll() await', async () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-1', '1000.0001', 'WorkflowComplete');
      tracker.track('session-1', '1000.0002', 'WorkflowComplete');

      // deleteMessage that simulates a concurrent track() during the await
      const deleteMessage = vi.fn<(channel: string, ts: string) => Promise<void>>()
        .mockImplementation(async (_channel: string, ts: string) => {
          // On the first delete call, simulate a concurrent track()
          if (ts === '1000.0001') {
            tracker.track('session-1', '9999.9999', 'WorkflowComplete');
          }
        });

      await tracker.deleteAll('session-1', deleteMessage, 'C-CHANNEL');

      // The newly tracked timestamp should survive
      expect(tracker.has('session-1')).toBe(true);
      expect(tracker.count('session-1')).toBe(1);
    });
  });
});
