import { describe, it, expect } from 'vitest';
import { SummaryService, SUMMARY_PROMPT, type SummarySessionInfo } from './summary-service.js';

// Trace: docs/turn-summary-lifecycle/trace.md

describe('SummaryService', () => {
  const service = new SummaryService();

  function makeSession(overrides: Partial<SummarySessionInfo> = {}): SummarySessionInfo {
    return {
      isActive: true,
      model: 'claude-opus-4-6',
      actionPanel: {},
      ...overrides,
    };
  }

  // S3: Timer Fire → Fork Session → Summary Display
  describe('S3 — Fork Session + Summary Display', () => {
    // Trace: S3, Section 3b
    it('execute() returns summary text for active session', async () => {
      const session = makeSession({
        links: {
          issue: { url: 'https://jira.example.com/ISSUE-1', title: 'Test Issue' },
          pr: { url: 'https://github.com/org/repo/pull/1', title: 'Test PR' },
        },
      });

      const result = await service.execute(session);

      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
      expect(result).toContain('as-is');
      expect(result).toContain('executive summary');
    });

    // Trace: S3, Section 5 row 1
    it('execute() returns null if session is not active', async () => {
      const session = makeSession({ isActive: false });
      const result = await service.execute(session);
      expect(result).toBeNull();
    });

    // Trace: S3, Section 3c
    it('displayOnThread() sets summaryBlocks on actionPanel', () => {
      const session = makeSession();
      service.displayOnThread(session, 'Test summary text');

      expect(session.actionPanel!.summaryBlocks).toBeDefined();
      expect(Array.isArray(session.actionPanel!.summaryBlocks)).toBe(true);
      expect(session.actionPanel!.summaryBlocks!.length).toBeGreaterThan(0);
    });

    // Trace: S3, Section 3a→3b — Contract
    it('execute() includes session link context in prompt', async () => {
      const session = makeSession({
        links: {
          issue: { url: 'https://jira.example.com/BUG-42', title: 'Critical Bug' },
        },
      });

      const result = await service.execute(session);

      expect(result).toContain('BUG-42');
      expect(result).toContain('Critical Bug');
    });
  });

  // S5: Summary Clear on New User Input
  describe('S5 — Summary Clear', () => {
    // Trace: S5, Section 3b
    it('clearDisplay() removes summaryBlocks from actionPanel', () => {
      const session = makeSession();
      // First display something
      service.displayOnThread(session, 'Some summary');
      expect(session.actionPanel!.summaryBlocks).toBeDefined();

      // Then clear
      service.clearDisplay(session);
      expect(session.actionPanel!.summaryBlocks).toBeUndefined();
    });

    // Trace: S5, Section 5
    it('clearDisplay() is a no-op if no summary displayed', () => {
      const session = makeSession();
      // No summary was ever displayed
      expect(() => service.clearDisplay(session)).not.toThrow();
      expect(session.actionPanel!.summaryBlocks).toBeUndefined();
    });
  });
});
