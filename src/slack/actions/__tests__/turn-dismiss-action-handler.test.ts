import { encodeDismissValue } from '@soma/slack/turn-feedback-block-builder';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnDismissActionHandler } from '../turn-dismiss-action-handler';

function makeBody(overrides: { value?: string; userId?: string } = {}) {
  const turnId = 'C1-1.2:1700:abc';
  return {
    user: { id: overrides.userId ?? 'Uowner' },
    channel: { id: 'C1' },
    container: { channel_id: 'C1', message_ts: '1700.9' },
    message: { ts: '1700.9', thread_ts: '1700.1' },
    actions: [{ action_id: 'turn_dismiss_v1', value: overrides.value ?? encodeDismissValue(turnId, 'Uowner') }],
  };
}

describe('TurnDismissActionHandler', () => {
  let slackApi: { deleteMessage: ReturnType<typeof vi.fn> };
  let tracker: { untrack: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    slackApi = { deleteMessage: vi.fn().mockResolvedValue(undefined) };
    tracker = { untrack: vi.fn() };
  });

  function handler() {
    return new TurnDismissActionHandler({
      slackApi: slackApi as any,
      completionMessageTracker: tracker as any,
    });
  }

  it('deletes the card and untracks it (sessionKey = channel-threadTs)', async () => {
    await handler().handleDismiss(makeBody(), vi.fn());
    expect(slackApi.deleteMessage).toHaveBeenCalledWith('C1', '1700.9');
    expect(tracker.untrack).toHaveBeenCalledWith('C1-1700.1', '1700.9');
  });

  it('untracks BEFORE deleting (so a racing auto-delete cannot re-add)', async () => {
    const order: string[] = [];
    tracker.untrack.mockImplementation(() => order.push('untrack'));
    slackApi.deleteMessage.mockImplementation(async () => {
      order.push('delete');
    });
    await handler().handleDismiss(makeBody(), vi.fn());
    expect(order).toEqual(['untrack', 'delete']);
  });

  it('ignores a non-owner click (defence in depth on visible_to_user_ids)', async () => {
    await handler().handleDismiss(makeBody({ userId: 'Uintruder' }), vi.fn());
    expect(slackApi.deleteMessage).not.toHaveBeenCalled();
    expect(tracker.untrack).not.toHaveBeenCalled();
  });

  it('treats message_not_found as success (already dismissed)', async () => {
    slackApi.deleteMessage.mockRejectedValueOnce({ data: { error: 'message_not_found' } });
    await expect(handler().handleDismiss(makeBody(), vi.fn())).resolves.toBeUndefined();
  });

  it('ignores an unparseable value', async () => {
    await handler().handleDismiss(makeBody({ value: 'garbage' }), vi.fn());
    expect(slackApi.deleteMessage).not.toHaveBeenCalled();
  });
});
