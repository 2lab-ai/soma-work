/**
 * SlackBlockKitChannel — public `buildCompletionBlocks` (A32).
 *
 * The consolidated turn surface closes the streamed answer with the SAME
 * completion blocks this channel would have posted as a separate card, so the
 * composition must be extractable as a pure function. These tests lock:
 *   1. parity — `send()` posts byte-identical blocks/text to what the pure
 *      builder returns (no second, drifting copy of the composition), and
 *   2. the stream ts never enters the completion tracker as a deletable
 *      message; it is protected instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('default'),
  },
}));

import { SlackBlockKitChannel } from '../notification-channels/slack-block-kit-channel';
import { CompletionMessageTracker } from '../slack/completion-message-tracker';
import type { TurnCompletionEvent } from '../turn-notifier';

function makeEvent(overrides: Partial<TurnCompletionEvent> = {}): TurnCompletionEvent {
  return {
    category: 'WorkflowComplete',
    userId: 'U123',
    channel: 'C456',
    threadTs: '1700000000.000111',
    turnId: 'C456:1700000000.000111:abc',
    sessionTitle: 'PR #77 리뷰',
    durationMs: 1048000,
    model: 'opus-4.6',
    ...overrides,
  } as TurnCompletionEvent;
}

describe('SlackBlockKitChannel.buildCompletionBlocks (A32)', () => {
  let postMessage: ReturnType<typeof vi.fn>;
  let channel: SlackBlockKitChannel;

  beforeEach(() => {
    postMessage = vi.fn().mockResolvedValue({ ts: '1700000000.000222' });
    channel = new SlackBlockKitChannel({ postMessage } as any);
  });

  it('WorkflowComplete with turnId → withFeedback true, blocks parity with send()', async () => {
    const event = makeEvent();
    const built = channel.buildCompletionBlocks(event);

    expect(built.withFeedback).toBe(true);
    expect(built.blocks.length).toBeGreaterThan(0);

    await channel.send(event);
    const [postedChannel, postedText, options] = postMessage.mock.calls[0];
    expect(postedChannel).toBe('C456');
    expect(postedText).toBe(built.fallbackText);
    // The feedback path posts TOP-LEVEL blocks: content blocks + feedback row.
    expect(JSON.stringify(options.blocks.slice(0, built.blocks.length))).toBe(JSON.stringify(built.blocks));
  });

  it('Exception → withFeedback false, blocks parity with the attachment payload', async () => {
    const event = makeEvent({ category: 'Exception', message: 'boom' });
    const built = channel.buildCompletionBlocks(event);

    expect(built.withFeedback).toBe(false);

    await channel.send(event);
    const [, postedText, options] = postMessage.mock.calls[0];
    expect(postedText).toBe(built.fallbackText);
    expect(JSON.stringify(options.attachments[0].blocks)).toBe(JSON.stringify(built.blocks));
  });

  it('WorkflowComplete without a turnId → withFeedback false (no row to key feedback on)', () => {
    expect(channel.buildCompletionBlocks(makeEvent({ turnId: undefined })).withFeedback).toBe(false);
  });

  it('protectMessageTs makes the tracker refuse to track that ts (stream ts is never deletable)', () => {
    const tracker = new CompletionMessageTracker();
    const tracking = new SlackBlockKitChannel({ postMessage } as any, tracker);
    const event = makeEvent();

    tracking.protectMessageTs(event, 'stream-ts-1');

    const sessionKey = `${event.channel}-${event.threadTs}`;
    expect(tracker.isProtected(sessionKey, 'stream-ts-1')).toBe(true);
    tracker.track(sessionKey, 'stream-ts-1', 'WorkflowComplete');
    expect(tracker.count(sessionKey)).toBe(0);
  });
});
