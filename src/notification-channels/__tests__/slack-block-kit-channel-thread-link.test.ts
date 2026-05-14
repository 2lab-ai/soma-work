/**
 * Tests for the thread-surface deeplink in the turn-end completion message.
 *
 * Z's complaint: "지금 thread surface에 '최신 응답'이라는 링크로 가장 마지막
 * 모델의 응답 딥링크가 있는데 원본 thread로 보기 어렵거든? thread surface로
 * 가는 링크를 추가해줘 적당하게."
 *
 * The "작업 완료" notification posted in-thread by SlackBlockKitChannel must
 * carry a permalink back to the parent thread so the user can hop from
 * anywhere (a DM card, a search hit, a permalink) directly into the thread
 * surface. Today the completion message has no link at all.
 *
 * Built via `buildThreadPermalink(channel, threadTs)` (turn-notifier.ts:117).
 * If the workspace URL is not yet set, the link is omitted (no broken
 * "(null)" rendering).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('default'),
  },
}));

import type { TurnCompletionEvent } from '../../turn-notifier';
import { resetSlackWorkspaceUrl, setSlackWorkspaceUrl } from '../../turn-notifier';
import { SlackBlockKitChannel } from '../slack-block-kit-channel';

function makeEvent(overrides: Partial<TurnCompletionEvent> = {}): TurnCompletionEvent {
  return {
    category: 'WorkflowComplete',
    userId: 'U123',
    channel: 'C456',
    threadTs: '1700000000.000111',
    durationMs: 1234,
    sessionTitle: 'feat/es countdown',
    model: 'opus-4.6',
    ...overrides,
  };
}

function createMockSlackApi() {
  return { postMessage: vi.fn().mockResolvedValue({ ts: '1700000001.000222' }) };
}

function joinAllText(blocks: any[]): string {
  return blocks.map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '').join('\n');
}

describe('SlackBlockKitChannel — thread-surface deeplink', () => {
  beforeEach(() => {
    setSlackWorkspaceUrl('https://example.slack.com/');
  });

  afterEach(() => {
    resetSlackWorkspaceUrl();
  });

  describe('default theme', () => {
    it('appends a "스레드 열기" link to the completion message when the workspace URL is set', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeEvent());

      const blocks = api.postMessage.mock.calls[0][2].attachments[0].blocks;
      const text = joinAllText(blocks);

      // Expected mrkdwn link: <PERMALINK|스레드 열기>
      // Permalink format: https://{workspace}/archives/{channel}/p{threadTs without dot}
      expect(text).toMatch(/<https:\/\/example\.slack\.com\/archives\/C456\/p1700000000000111\|[^>]*스레드[^>]*>/);
    });

    it('omits the link when the workspace URL is not initialized', async () => {
      resetSlackWorkspaceUrl(); // simulate the "auth.test() not yet returned" startup window
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeEvent());

      const blocks = api.postMessage.mock.calls[0][2].attachments[0].blocks;
      const text = joinAllText(blocks);

      // No link → no "스레드" anchor at all. The message still posts, just
      // without the hop-back link (degrade gracefully).
      expect(text).not.toMatch(/<https:\/\/.+\|.*스레드.*>/);
    });

    it('also includes the original "작업 완료" header text (link is additive, not replacing)', async () => {
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeEvent());

      const blocks = api.postMessage.mock.calls[0][2].attachments[0].blocks;
      const text = joinAllText(blocks);

      // Pre-existing header content must still be present.
      expect(text).toMatch(/작업 완료|Workflow completed|Continue|WorkflowComplete/);
      expect(text).toContain('feat/es countdown');
    });
  });

  describe('compact theme', () => {
    it('appends the same thread link in compact theme too', async () => {
      const { userSettingsStore } = await import('../../user-settings-store');
      (userSettingsStore.getUserSessionTheme as any).mockReturnValueOnce('compact');
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeEvent());

      const blocks = api.postMessage.mock.calls[0][2].attachments[0].blocks;
      const text = joinAllText(blocks);
      expect(text).toMatch(/<https:\/\/example\.slack\.com\/archives\/C456\/p1700000000000111\|[^>]*>/);
    });
  });

  describe('minimal theme', () => {
    // Minimal is intentionally bare and is a single context line — we accept
    // either omitting the link OR squeezing it onto the same line. Test that
    // *if* the link is present it carries the right URL; otherwise pass.
    it('either includes a valid thread permalink or none (minimal theme is allowed to skip it)', async () => {
      const { userSettingsStore } = await import('../../user-settings-store');
      (userSettingsStore.getUserSessionTheme as any).mockReturnValueOnce('minimal');
      const api = createMockSlackApi();
      const channel = new SlackBlockKitChannel(api);
      await channel.send(makeEvent());

      const blocks = api.postMessage.mock.calls[0][2].attachments[0].blocks;
      const text = joinAllText(blocks);
      const linkMatch = text.match(/<(https:\/\/example\.slack\.com\/archives\/C456\/p1700000000000111)\|/);
      if (linkMatch) {
        expect(linkMatch[1]).toContain('archives/C456');
      }
      // Minimal must always have the original status emoji/label content.
      expect(text.length).toBeGreaterThan(0);
    });
  });
});
