import { describe, expect, it, vi } from 'vitest';
import { type ForkExecutor, SUMMARY_PROMPT, SummaryService, type SummarySessionInfo } from '../summary-service.js';

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

      expect(mockFork).toHaveBeenCalledWith(
        expect.any(String),
        'claude-sonnet-4-20250514',
        undefined,
        undefined,
        undefined,
      );
    });

    it('execute() passes sessionId and workingDirectory to forkExecutor for context-aware summary', async () => {
      const mockFork: ForkExecutor = vi.fn().mockResolvedValue('context-aware summary');
      const service = new SummaryService(mockFork);

      const session = makeSession({
        model: 'claude-opus-4-6',
        sessionId: 'sdk-session-abc123',
        workingDirectory: '/tmp/workdir',
      });
      const result = await service.execute(session);

      expect(result).toBe('context-aware summary');
      expect(mockFork).toHaveBeenCalledWith(
        expect.any(String),
        'claude-opus-4-6',
        'sdk-session-abc123',
        '/tmp/workdir',
        undefined,
      );
    });

    // Regression: #231 fixed sessionId wiring. This test pins the OTHER half of
    // the SDK resume contract: `cwd` must match the cwd under which the SDK
    // conversation was created (= `sessionWorkingDir`), otherwise resume looks
    // in the wrong `~/.claude/projects/<encoded-cwd>` directory and falls back
    // to a context-less summary that does not reflect actual work content.
    // Docs: docs/claude-agent-sdk/sessions.md L234-L235.
    it('execute() prefers sessionWorkingDir over workingDirectory as fork cwd', async () => {
      const mockFork: ForkExecutor = vi.fn().mockResolvedValue('summary');
      const service = new SummaryService(mockFork);

      const session = makeSession({
        model: 'claude-opus-4-6',
        sessionId: 'sdk-session-xyz',
        // workingDirectory is the user's base dir (~/tmp/{userId}) — NOT where
        // the SDK conversation file lives. sessionWorkingDir is.
        workingDirectory: '/tmp/userId',
        sessionWorkingDir: '/tmp/userId/session_1711111111111_repo',
      });
      await service.execute(session);

      expect(mockFork).toHaveBeenCalledWith(
        expect.any(String),
        'claude-opus-4-6',
        'sdk-session-xyz',
        '/tmp/userId/session_1711111111111_repo', // sessionWorkingDir wins
        undefined,
      );
    });

    it('execute() falls back to workingDirectory when sessionWorkingDir is missing', async () => {
      const mockFork: ForkExecutor = vi.fn().mockResolvedValue('summary');
      const service = new SummaryService(mockFork);

      const session = makeSession({
        sessionId: 'sdk-session-xyz',
        workingDirectory: '/tmp/fallback',
        // sessionWorkingDir intentionally undefined
      });
      await service.execute(session);

      expect(mockFork).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        'sdk-session-xyz',
        '/tmp/fallback',
        undefined,
      );
    });

    it('execute() passes abortSignal to forkExecutor', async () => {
      const mockFork: ForkExecutor = vi.fn().mockResolvedValue('summary');
      const service = new SummaryService(mockFork);
      const ac = new AbortController();

      const session = makeSession();
      await service.execute(session, ac.signal);

      expect(mockFork).toHaveBeenCalledWith(expect.any(String), expect.anything(), undefined, undefined, ac.signal);
    });

    it('execute() returns null immediately if abortSignal already aborted', async () => {
      const mockFork: ForkExecutor = vi.fn().mockResolvedValue('should not reach');
      const service = new SummaryService(mockFork);
      const ac = new AbortController();
      ac.abort();

      const session = makeSession();
      const result = await service.execute(session, ac.signal);

      expect(result).toBeNull();
      expect(mockFork).not.toHaveBeenCalled();
    });

    it('execute() discards result if aborted during fork execution', async () => {
      const ac = new AbortController();
      const mockFork: ForkExecutor = vi.fn().mockImplementation(async () => {
        // Simulate abort happening mid-flight
        ac.abort();
        return 'stale summary';
      });
      const service = new SummaryService(mockFork);

      const session = makeSession();
      const result = await service.execute(session, ac.signal);

      expect(result).toBeNull(); // discarded because signal is aborted after await
    });

    it('execute() handles AbortError from forkExecutor gracefully', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      const mockFork: ForkExecutor = vi.fn().mockRejectedValue(abortError);
      const service = new SummaryService(mockFork);

      const session = makeSession();
      const result = await service.execute(session);

      expect(result).toBeNull();
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

    // Regression: the LLM emits github-flavored markdown (`**bold**`, `## H2`,
    // `__italic__`). Slack mrkdwn uses `*bold*`, `_italic_`, and has no native
    // heading syntax. Without conversion, the thread surface renders the raw
    // `##` and `**` characters verbatim. Pinning the conversion here is the
    // smallest signal that prevents that regression from returning.
    describe('displayOnThread() — markdown → Slack mrkdwn conversion', () => {
      it('converts **bold** to *bold*', () => {
        const service = new SummaryService();
        const session = makeSession();
        service.displayOnThread(session, 'a **bold** word and __italic__ word');
        const text = (session.actionPanel!.summaryBlocks![1] as any).text.text as string;
        expect(text).toContain('*bold*');
        expect(text).not.toContain('**bold**');
        expect(text).toContain('_italic_');
        expect(text).not.toContain('__italic__');
      });

      it('converts ## / ### headers to *bold* lines (Slack has no native headings)', () => {
        const service = new SummaryService();
        const session = makeSession();
        const input = '## Executive Summary\n### 1. What was done\n- did stuff';
        service.displayOnThread(session, input);
        const text = (session.actionPanel!.summaryBlocks![1] as any).text.text as string;
        // Raw `##` / `###` must not leak into the rendered text body.
        expect(text).not.toMatch(/^##\s|\n##\s/);
        expect(text).not.toMatch(/^###\s|\n###\s/);
        expect(text).toContain('*Executive Summary*');
        expect(text).toContain('*1. What was done*');
      });

      it('preserves code fences (does not touch ** inside ```code``` blocks)', () => {
        const service = new SummaryService();
        const session = makeSession();
        const input = 'before\n```ts\nconst x = "**not bold**";\n```\nafter';
        service.displayOnThread(session, input);
        const text = (session.actionPanel!.summaryBlocks![1] as any).text.text as string;
        // The triple-fence must still wrap the code, and ** inside the fence
        // must NOT be rewritten to *.
        expect(text).toContain('```');
        expect(text).toContain('**not bold**');
      });

      it('strips the language tag from fenced code blocks (```ts → ```)', () => {
        const service = new SummaryService();
        const session = makeSession();
        const input = '```bash\necho hi\n```';
        service.displayOnThread(session, input);
        const text = (session.actionPanel!.summaryBlocks![1] as any).text.text as string;
        // Slack mrkdwn fenced blocks have no language; the `bash` tag must be
        // stripped so it doesn't appear as plain text on the first fence line.
        expect(text).not.toContain('```bash');
        expect(text).toContain('```');
        expect(text).toContain('echo hi');
      });
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

    it('buildPrompt() includes context header and base prompt when no links', () => {
      const service = new SummaryService();
      const session = makeSession();

      const prompt = service.buildPrompt(session);

      expect(prompt).toContain('## Session Context');
      expect(prompt).toContain('No active issues or PRs linked');
      expect(prompt).toContain(SUMMARY_PROMPT);
    });

    it('default forkExecutor returns prompt text as stub', async () => {
      const service = new SummaryService(); // no forkExecutor → stub
      const session = makeSession();

      const result = await service.execute(session);

      expect(result).toContain(SUMMARY_PROMPT);
    });

    // Pins the user-facing fix: the prompt must demand *concrete* work
    // artifacts (file paths, commands, commit/PR/issue numbers) instead of a
    // 1–2-sentence abstract recap. Without this, even a correctly-forked
    // session produces generic output that does not reflect actual work.
    describe('SUMMARY_PROMPT content shape', () => {
      it('demands concrete work artifacts, not abstract recap', () => {
        // The prompt must explicitly call out artifacts beyond "issue/PR". The
        // pre-fix prompt only mentioned issue/PR, leaving the model to recap
        // abstractly when neither was linked. The post-fix prompt must also
        // demand file paths and either commands or commits — i.e. *what the
        // assistant actually did*, not just *what was linked*.
        const lower = SUMMARY_PROMPT.toLowerCase();
        expect(lower).toMatch(/file/); // file paths
        expect(lower).toMatch(/command|commit/); // commands run or commits made
        // And it must explicitly tell the model to be specific/concrete.
        expect(lower).toMatch(/specific|concrete/);
      });

      it('does NOT cap the work-summary section at 1-2 sentences', () => {
        // The previous prompt said "Status: ... (1-2 sentences)" which forced
        // a generic abstract status. The new prompt must not cap the work
        // recap that tightly.
        expect(SUMMARY_PROMPT).not.toMatch(/1-?2 sentences?/i);
      });

      it('keeps the no-tools / no-external-calls guard', () => {
        // dispatchOneShot runs with tools: [] — the prompt must not invite the
        // model to try fetching git/PR state at runtime.
        expect(SUMMARY_PROMPT.toLowerCase()).toContain('not');
        expect(SUMMARY_PROMPT.toLowerCase()).toMatch(/tool|api|external/);
      });

      it('keeps the conversation-language directive', () => {
        // We never want a Korean session summarized in English or vice versa.
        expect(SUMMARY_PROMPT.toLowerCase()).toMatch(/same language|conversation.+language|language.+conversation/);
      });
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
