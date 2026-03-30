import { describe, it, expect, vi } from 'vitest';
import { SummaryService, SUMMARY_PROMPT, type SummarySessionInfo, type ForkExecutor } from './summary-service.js';

// Trace: docs/turn-summary-lifecycle/trace.md

describe('SummaryService', () => {
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
    it('execute() calls forkExecutor with built prompt and returns its response', async () => {
      const mockFork: ForkExecutor = vi.fn().mockResolvedValue('LLM summary response');
      const service = new SummaryService(mockFork);

      const session = makeSession({
        links: {
          issue: { url: 'https://jira.example.com/ISSUE-1', title: 'Test Issue' },
          pr: { url: 'https://github.com/org/repo/pull/1', title: 'Test PR' },
        },
      });

      const result = await service.execute(session);

      expect(result).toBe('LLM summary response');
      expect(mockFork).toHaveBeenCalledOnce();
      const calledPrompt = (mockFork as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledPrompt).toContain('ISSUE-1');
      expect(calledPrompt).toContain('Test Issue');
      expect(calledPrompt).toContain('Test PR');
      expect(calledPrompt).toContain(SUMMARY_PROMPT);
    });

    // Trace: S3, Section 5 row 1
    it('execute() returns null if session is not active', async () => {
      const mockFork: ForkExecutor = vi.fn();
      const service = new SummaryService(mockFork);

      const session = makeSession({ isActive: false });
      const result = await service.execute(session);

      expect(result).toBeNull();
      expect(mockFork).not.toHaveBeenCalled();
    });

    it('execute() returns null if forkExecutor throws', async () => {
      const mockFork: ForkExecutor = vi.fn().mockRejectedValue(new Error('LLM timeout'));
      const service = new SummaryService(mockFork);

      const session = makeSession();
      const result = await service.execute(session);

      expect(result).toBeNull();
    });

    it('execute() passes model to forkExecutor', async () => {
      const mockFork: ForkExecutor = vi.fn().mockResolvedValue('ok');
      const service = new SummaryService(mockFork);

      const session = makeSession({ model: 'claude-sonnet-4-20250514' });
      await service.execute(session);

      expect(mockFork).toHaveBeenCalledWith(expect.any(String), 'claude-sonnet-4-20250514', undefined);
    });

    it('execute() passes sessionId to forkExecutor for context-aware summary', async () => {
      const mockFork: ForkExecutor = vi.fn().mockResolvedValue('context-aware summary');
      const service = new SummaryService(mockFork);

      const session = makeSession({
        model: 'claude-opus-4-6',
        sessionId: 'sdk-session-abc123',
      });
      const result = await service.execute(session);

      expect(result).toBe('context-aware summary');
      expect(mockFork).toHaveBeenCalledWith(expect.any(String), 'claude-opus-4-6', 'sdk-session-abc123');
    });

    // Trace: S3, Section 3c
    it('displayOnThread() sets summaryBlocks on actionPanel', () => {
      const service = new SummaryService();
      const session = makeSession();
      service.displayOnThread(session, 'Test summary text');

      expect(session.actionPanel!.summaryBlocks).toBeDefined();
      expect(Array.isArray(session.actionPanel!.summaryBlocks)).toBe(true);
      expect(session.actionPanel!.summaryBlocks!.length).toBeGreaterThan(0);
    });

    it('displayOnThread() produces valid Block Kit structure with divider + section', () => {
      const service = new SummaryService();
      const session = makeSession();
      service.displayOnThread(session, 'Test summary');

      const blocks = session.actionPanel!.summaryBlocks!;
      expect(blocks[0]).toEqual({ type: 'divider' });
      expect(blocks[1]).toMatchObject({
        type: 'section',
        text: { type: 'mrkdwn', text: expect.stringContaining('Executive Summary') },
      });
      expect(blocks[1].text.text).toContain('Test summary');
    });

    it('displayOnThread() splits long text into multiple blocks (Slack 3000 char limit)', () => {
      const service = new SummaryService();
      const session = makeSession();
      // Generate text that exceeds 3000 chars
      const longText = 'A'.repeat(4000);
      service.displayOnThread(session, longText);

      const blocks = session.actionPanel!.summaryBlocks!;
      // divider + at least 2 section blocks
      expect(blocks.length).toBeGreaterThanOrEqual(3);
      expect(blocks[0]).toEqual({ type: 'divider' });
      // Each section block text should be ≤ 3000 chars
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i].text.text.length).toBeLessThanOrEqual(3000);
      }
    });

    // Trace: S3, Section 3a→3b — Contract
    it('buildPrompt() includes session link context', () => {
      const service = new SummaryService();
      const session = makeSession({
        links: {
          issue: { url: 'https://jira.example.com/BUG-42', title: 'Critical Bug' },
        },
      });

      const prompt = service.buildPrompt(session);

      expect(prompt).toContain('BUG-42');
      expect(prompt).toContain('Critical Bug');
      expect(prompt).toContain(SUMMARY_PROMPT);
    });

    it('buildPrompt() returns base prompt when no links', () => {
      const service = new SummaryService();
      const session = makeSession();

      const prompt = service.buildPrompt(session);

      expect(prompt).toBe(SUMMARY_PROMPT);
    });

    it('default forkExecutor returns prompt text as stub', async () => {
      const service = new SummaryService(); // no forkExecutor → stub
      const session = makeSession();

      const result = await service.execute(session);

      expect(result).toBe(SUMMARY_PROMPT);
    });
  });

  // S5: Summary Clear on New User Input
  describe('S5 — Summary Clear', () => {
    // Trace: S5, Section 3b
    it('clearDisplay() removes summaryBlocks from actionPanel', () => {
      const service = new SummaryService();
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
      const service = new SummaryService();
      const session = makeSession();
      // No summary was ever displayed
      expect(() => service.clearDisplay(session)).not.toThrow();
      expect(session.actionPanel!.summaryBlocks).toBeUndefined();
    });
  });
});
