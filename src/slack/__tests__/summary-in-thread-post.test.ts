/**
 * Tests for posting the Executive Summary as an in-thread message in
 * addition to the floating thread-surface header.
 *
 * Z's complaint: "이 excutive summary를 thread surface에도 지금처럼
 * 출력해주고 '작업 완료' 메세지 이후에도 thread안에도 메세지로 출력해줘".
 *
 * Today: ES only edits the surface header (chat.update). When the user later
 * scrolls back through history they see nothing — the summary is purely a
 * pinned-style header, not part of the conversation log.
 *
 * After: on every timer fire (NOT on every countdown tick), the same
 * summary blocks are also posted as a fresh in-thread message via
 * slackApi.postMessage. This message is NOT registered with the
 * completion-message tracker, so a subsequent user message does not delete
 * it (only the floating surface is wiped via clearDisplay).
 */

import { describe, expect, it, vi } from 'vitest';
import { SummaryService, type SummarySessionInfo } from '../summary-service.js';

describe('SummaryService — buildSummaryBlocks is publicly callable', () => {
  // Required for the in-thread post: stream-executor needs to call this so
  // both the surface header AND the in-thread post share the same blocks.
  // Without exposing it, the in-thread post path would re-implement
  // chunking + markdown rewrite.
  it('buildSummaryBlocks(text) returns Block Kit blocks usable as postMessage args', () => {
    const service = new SummaryService();
    // Method exists on the public surface.
    expect(typeof (service as any).buildSummaryBlocks).toBe('function');

    const blocks = (service as any).buildSummaryBlocks('Hello summary body');
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]).toEqual({ type: 'divider' });
    expect(blocks[1]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn', text: expect.stringContaining('Hello summary body') },
    });
  });

  it('buildSummaryBlocks chunks long text the same way displayOnThread does', () => {
    const service = new SummaryService();
    const longText = 'B'.repeat(4000);
    const blocks = (service as any).buildSummaryBlocks(longText) as any[];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});

describe('SummaryService.postInThread() — in-thread ES message', () => {
  function makeSession(overrides: Partial<SummarySessionInfo & any> = {}): any {
    return {
      isActive: true,
      actionPanel: {},
      ...overrides,
    };
  }

  it('postInThread posts the same blocks to slackApi.postMessage with threadTs', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: '1.234' });
    const service = new SummaryService(undefined, { postMessage });
    const session = makeSession({ channelId: 'C999', threadTs: '1700000000.000', sessionTitle: 'work' });

    await service.postInThread(session, 'Summary body in thread');

    expect(postMessage).toHaveBeenCalledOnce();
    const [channel, fallback, opts] = postMessage.mock.calls[0];
    expect(channel).toBe('C999');
    expect(fallback).toBeTypeOf('string');
    expect(fallback.length).toBeGreaterThan(0);
    expect(opts).toMatchObject({ threadTs: '1700000000.000' });
    expect(Array.isArray(opts.blocks)).toBe(true);
    expect(opts.blocks[0]).toEqual({ type: 'divider' });
    expect(opts.blocks[1].text.text).toContain('Summary body in thread');
  });

  it('postInThread is a no-op (no throw, no call) when slackApi is missing', async () => {
    const service = new SummaryService(); // no slackApi injected
    const session = makeSession({ channelId: 'C999', threadTs: '1700000000.000' });
    await expect(service.postInThread(session, 'body')).resolves.not.toThrow();
  });

  it('postInThread is a no-op when threadTs is missing (no random channel posts)', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: '1.234' });
    const service = new SummaryService(undefined, { postMessage });
    const session = makeSession({ channelId: 'C999' /* no threadTs */ });

    await service.postInThread(session, 'body');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('postInThread swallows slackApi errors (does not throw — host fork must not crash)', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('slack down'));
    const service = new SummaryService(undefined, { postMessage });
    const session = makeSession({ channelId: 'C999', threadTs: '1700000000.000' });

    await expect(service.postInThread(session, 'body')).resolves.not.toThrow();
  });
});
