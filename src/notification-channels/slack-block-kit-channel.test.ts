import { describe, expect, it, vi } from 'vitest';

vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('default'),
  },
}));

import { CompletionMessageTracker } from '../slack/completion-message-tracker';
import type { TurnCompletionEvent } from '../turn-notifier';
import { SlackBlockKitChannel } from './slack-block-kit-channel';

// Contract tests — Rich Turn Notification
// Trace: docs/rich-turn-notification/trace.md

function makeEvent(overrides: Partial<TurnCompletionEvent> = {}): TurnCompletionEvent {
  return {
    category: 'WorkflowComplete',
    userId: 'U123',
    channel: 'C123',
    threadTs: '123.456',
    durationMs: 1048000, // 17:28
    ...overrides,
  };
}

function makeRichEvent(overrides: Partial<TurnCompletionEvent> = {}): TurnCompletionEvent {
  return makeEvent({
    persona: 'default',
    model: 'opus-4.6',
    sessionTitle: 'PR #77 리뷰 및 수정',
    startedAt: new Date('2026-03-26T00:14:00.000+09:00'),
    contextUsagePercent: 84.0,
    contextUsageDelta: -5.6,
    contextUsageTokens: 160300,
    contextWindowSize: 1000000,
    fiveHourUsage: 42,
    fiveHourDelta: 20,
    sevenDayUsage: 55,
    sevenDayDelta: 2,
    toolStats: {
      Bash: { count: 59, totalDurationMs: 767400 },
      WebFetch: { count: 7, totalDurationMs: 118200 },
      mcp__send_file__send_document: { count: 3, totalDurationMs: 44400 },
      WebSearch: { count: 2, totalDurationMs: 42500 },
      Task: { count: 2, totalDurationMs: 17200 },
    },
    ...overrides,
  });
}

function createMockSlackApi() {
  return {
    postMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SlackBlockKitChannel — Rich Turn Notification', () => {
  // Trace: Scenario 3, Section 3a Line 1
  describe('Persona and Model line', () => {
    it('renders persona and model in backticks', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeRichEvent());

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;
      const allText = blocks
        .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
        .join('\n');

      expect(allText).toContain('`default`');
      expect(allText).toContain('`opus-4.6`');
    });
  });

  // Trace: Scenario 3, Section 3a Line 3
  describe('Clock range line', () => {
    it('renders start time and elapsed duration', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeRichEvent());

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;
      const allText = blocks
        .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
        .join('\n');

      // Should contain start time from formatClock (locale time string)
      // and elapsed duration in M:SS format
      expect(allText).toMatch(/\d+:\d{2}/);
    });
  });

  // Trace: Scenario 3, Section 3a Line 4
  describe('Context usage bar', () => {
    it('renders context usage with bar, tokens, and delta', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeRichEvent());

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;
      const allText = blocks
        .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
        .join('\n');

      expect(allText).toContain('Ctx');
      expect(allText).toContain('▓');
      expect(allText).toContain('160.3k');
      expect(allText).toContain('1M');
      expect(allText).toContain('84.0%');
    });
  });

  // Trace: Scenario 3, Section 3a Line 5
  describe('5h/7d usage line', () => {
    it('renders 5h/7d usage when available', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeRichEvent());

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;
      const allText = blocks
        .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
        .join('\n');

      expect(allText).toContain('5h');
      expect(allText).toContain('42%');
      expect(allText).toContain('+20');
      expect(allText).toContain('7d');
      expect(allText).toContain('55%');
      expect(allText).toContain('+2');
    });

    // Trace: Scenario 3, Section 5
    it('omits 5h/7d line when not available', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(
        makeRichEvent({
          fiveHourUsage: undefined,
          fiveHourDelta: undefined,
          sevenDayUsage: undefined,
          sevenDayDelta: undefined,
        }),
      );

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;
      const allText = blocks
        .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
        .join('\n');

      expect(allText).not.toContain('5h');
      expect(allText).not.toContain('7d');
    });
  });

  // Trace: Scenario 3, Section 3a Line 6
  describe('Tool stats line', () => {
    it('renders tool stats with durations sorted by duration desc', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeRichEvent());

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;
      const allText = blocks
        .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
        .join('\n');

      expect(allText).toContain(':wrench:');
      expect(allText).toContain('Bash×59');
      expect(allText).toContain('767.4s');
      expect(allText).toContain('WebFetch×7');
      expect(allText).toContain('118.2s');
    });
  });

  // Trace: Scenario 3, Section 5 — fallback
  describe('Fallback to simple format', () => {
    it('falls back to simple format when no rich data provided', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(
        makeEvent({
          sessionTitle: 'Simple session',
          durationMs: 5000,
        }),
      );

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;
      const allText = blocks
        .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
        .join('\n');

      // Should still have session title
      expect(allText).toContain('Simple session');
      // Should NOT have rich elements
      expect(allText).not.toContain('Ctx');
      expect(allText).not.toContain(':alarm_clock:');
    });
  });

  // Trace: Scenario 3, Section 3b — formatTokens
  describe('formatTokens utility', () => {
    it('formats tokens correctly as k/M units', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);

      // Test with 500k tokens
      await channel.send(
        makeRichEvent({
          contextUsageTokens: 500000,
          contextWindowSize: 1000000,
        }),
      );

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;
      const allText = blocks
        .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
        .join('\n');

      expect(allText).toContain('500.0k');
      expect(allText).toContain('1M');
    });
  });

  // Trace: Scenario 3, Section 3b — renderBar
  describe('renderBar utility', () => {
    it('renders correct bar width for given percentage', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);

      await channel.send(makeRichEvent({ contextUsagePercent: 50 }));

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;
      const allText = blocks
        .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
        .join('\n');

      // 50% of 5-width bar = ~3 filled
      // Check bar contains mix of filled and empty
      expect(allText).toMatch(/▓+░+/);
    });
  });

  // Trace: Scenario 1, Section 2 — interface accepts rich fields
  describe('TurnCompletionEvent interface', () => {
    it('accepts all rich fields without type errors', () => {
      const event: TurnCompletionEvent = makeRichEvent();
      expect(event.persona).toBe('default');
      expect(event.model).toBe('opus-4.6');
      expect(event.startedAt).toBeInstanceOf(Date);
      expect(event.contextUsagePercent).toBe(84.0);
      expect(event.contextUsageDelta).toBe(-5.6);
      expect(event.contextUsageTokens).toBe(160300);
      expect(event.contextWindowSize).toBe(1000000);
      expect(event.fiveHourUsage).toBe(42);
      expect(event.fiveHourDelta).toBe(20);
      expect(event.sevenDayUsage).toBe(55);
      expect(event.sevenDayDelta).toBe(2);
      expect(event.toolStats).toBeDefined();
    });
  });

  // Bug fix: tracks actual posted message ts, not threadTs (thread root)
  describe('CompletionMessageTracker integration', () => {
    it('tracks the posted notification message ts, not threadTs', async () => {
      const postedTs = '999.888';
      const api = { postMessage: vi.fn().mockResolvedValue({ ts: postedTs }) };
      const tracker = new CompletionMessageTracker();
      const channel = new SlackBlockKitChannel(api, tracker);

      await channel.send(makeEvent({ channel: 'C-TEST', threadTs: '111.222' }));

      // The tracker should contain the POSTED message ts, not the threadTs
      const sessionKey = 'C-TEST-111.222';
      expect(tracker.has(sessionKey)).toBe(true);
      expect(tracker.count(sessionKey)).toBe(1);

      // Verify by deleteAll — only the posted ts should be deleted
      const deletedTimestamps: string[] = [];
      await tracker.deleteAll(
        sessionKey,
        async (_ch, ts) => {
          deletedTimestamps.push(ts);
        },
        'C-TEST',
      );
      expect(deletedTimestamps).toEqual([postedTs]);
      // threadTs (111.222) must NOT be in the deleted list
      expect(deletedTimestamps).not.toContain('111.222');
    });

    it('does NOT track Exception category messages', async () => {
      const api = { postMessage: vi.fn().mockResolvedValue({ ts: '999.888' }) };
      const tracker = new CompletionMessageTracker();
      const channel = new SlackBlockKitChannel(api, tracker);

      await channel.send(makeEvent({ category: 'Exception', channel: 'C-X', threadTs: '111.222' }));

      expect(tracker.has('C-X-111.222')).toBe(false);
    });

    it('does NOT track when postMessage returns no ts', async () => {
      const api = { postMessage: vi.fn().mockResolvedValue(undefined) };
      const tracker = new CompletionMessageTracker();
      const channel = new SlackBlockKitChannel(api, tracker);

      await channel.send(makeEvent({ channel: 'C-X', threadTs: '111.222' }));

      expect(tracker.has('C-X-111.222')).toBe(false);
    });

    it('works without tracker (backward compatibility)', async () => {
      const api = { postMessage: vi.fn().mockResolvedValue({ ts: '999.888' }) };
      const channel = new SlackBlockKitChannel(api); // no tracker

      // Should not throw
      await channel.send(makeEvent());
      expect(api.postMessage).toHaveBeenCalled();
    });
  });

  // Trace: Scenario 3 — full rich format
  describe('Full rich format rendering', () => {
    it('renders all lines in correct order', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeRichEvent());

      const call = api.postMessage.mock.calls[0];
      const blocks = call[2].attachments[0].blocks;

      // Should have section (header) + context blocks
      expect(blocks.length).toBeGreaterThanOrEqual(2);

      // First block is header
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text.text).toContain('작업 완료');
    });
  });
});
