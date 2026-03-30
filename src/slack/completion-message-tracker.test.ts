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
    it('deleteAll() tolerates individual delete failures and re-tracks them', async () => {
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

      // Failed timestamp is re-tracked for retry; successful one is gone
      expect(tracker.has('session-1')).toBe(true);
      expect(tracker.count('session-1')).toBe(1);
    });
  });

  // Race condition: track() during deleteAll()
  describe('Race safety — track during deleteAll', () => {
    it('track() during deleteAll() is NOT lost', async () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-1', '1000.0001', 'WorkflowComplete');

      // deleteMessage is async — we'll sneak in a track() while it resolves
      const deleteMessage = vi.fn<(channel: string, ts: string) => Promise<void>>(
        async (_ch, _ts) => {
          // Simulate concurrent track() call mid-delete
          tracker.track('session-1', '2000.0001', 'WorkflowComplete');
        }
      );

      await tracker.deleteAll('session-1', deleteMessage, 'C-CHANNEL');

      // The newly tracked timestamp should survive
      expect(tracker.has('session-1')).toBe(true);
      expect(tracker.count('session-1')).toBe(1);
    });
  });

  // Failure re-tracking: failed deletes get re-added
  describe('deleteAll failure re-tracking', () => {
    it('re-tracks timestamps whose deletion failed', async () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-1', '1000.0001', 'WorkflowComplete');
      tracker.track('session-1', '1000.0002', 'WorkflowComplete');
      tracker.track('session-1', '1000.0003', 'WorkflowComplete');

      const deleteMessage = vi.fn<(channel: string, ts: string) => Promise<void>>(
        async (_ch, ts) => {
          if (ts === '1000.0002') throw new Error('message_not_found');
        }
      );

      await tracker.deleteAll('session-1', deleteMessage, 'C-CHANNEL');

      // 0001 and 0003 succeeded — removed. 0002 failed — re-tracked.
      expect(tracker.has('session-1')).toBe(true);
      expect(tracker.count('session-1')).toBe(1);
    });

    it('session is clean when all deletes succeed', async () => {
      const tracker = new CompletionMessageTracker();
      tracker.track('session-1', '1000.0001', 'WorkflowComplete');

      const deleteMessage = vi.fn<(channel: string, ts: string) => Promise<void>>().mockResolvedValue(undefined);
      await tracker.deleteAll('session-1', deleteMessage, 'C-CHANNEL');

      expect(tracker.has('session-1')).toBe(false);
    });
  });

  // Defense-in-depth: Protected timestamps (thread root / header)
  describe('Protected timestamps — thread root defense', () => {
    it('protect() prevents track() from adding the timestamp', () => {
      const tracker = new CompletionMessageTracker();
      tracker.protect('session-1', '1000.ROOT');

      tracker.track('session-1', '1000.ROOT', 'WorkflowComplete');
      tracker.track('session-1', '1000.SAFE', 'WorkflowComplete');

      expect(tracker.count('session-1')).toBe(1); // only SAFE tracked
      expect(tracker.has('session-1')).toBe(true);
    });

    it('deleteAll() skips protected timestamps even if somehow tracked', async () => {
      const tracker = new CompletionMessageTracker();
      // Track first, then protect (simulates race or legacy tracking)
      tracker.track('session-1', '1000.ROOT', 'WorkflowComplete');
      tracker.track('session-1', '1000.SAFE', 'WorkflowComplete');
      tracker.protect('session-1', '1000.ROOT');

      const deleteMessage = vi.fn<(channel: string, ts: string) => Promise<void>>().mockResolvedValue(undefined);
      await tracker.deleteAll('session-1', deleteMessage, 'C-CHANNEL');

      // Only SAFE should be deleted, ROOT is protected
      expect(deleteMessage).toHaveBeenCalledTimes(1);
      expect(deleteMessage).toHaveBeenCalledWith('C-CHANNEL', '1000.SAFE');
    });

    it('isProtected() returns correct state', () => {
      const tracker = new CompletionMessageTracker();
      expect(tracker.isProtected('session-1', '1000.ROOT')).toBe(false);

      tracker.protect('session-1', '1000.ROOT');
      expect(tracker.isProtected('session-1', '1000.ROOT')).toBe(true);
      expect(tracker.isProtected('session-1', '1000.OTHER')).toBe(false);
    });

    it('clearProtection() removes protection for session', () => {
      const tracker = new CompletionMessageTracker();
      tracker.protect('session-1', '1000.ROOT');
      expect(tracker.isProtected('session-1', '1000.ROOT')).toBe(true);

      tracker.clearProtection('session-1');
      expect(tracker.isProtected('session-1', '1000.ROOT')).toBe(false);

      // Can now track the timestamp
      tracker.track('session-1', '1000.ROOT', 'WorkflowComplete');
      expect(tracker.count('session-1')).toBe(1);
    });

    it('protect() is idempotent', () => {
      const tracker = new CompletionMessageTracker();
      tracker.protect('session-1', '1000.ROOT');
      tracker.protect('session-1', '1000.ROOT');
      tracker.protect('session-1', '1000.ROOT');
      expect(tracker.isProtected('session-1', '1000.ROOT')).toBe(true);
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
});
