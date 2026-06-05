import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildFeedbackContextActions, encodeFeedbackValue } from '@soma/slack/turn-feedback-block-builder';
import { setTurnFeedbackStoreDataDirProvider, TurnFeedbackStore } from '@soma/slack/turn-feedback-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnFeedbackActionHandler } from '../turn-feedback-action-handler';

function makeBody(overrides: { value?: string; userId?: string; blocks?: any[] } = {}) {
  const turnId = 'C1-1.2:1700:abc';
  return {
    user: { id: overrides.userId ?? 'U1' },
    channel: { id: 'C1' },
    container: { channel_id: 'C1', message_ts: '1700.9' },
    message: {
      ts: '1700.9',
      thread_ts: '1700.1',
      blocks: overrides.blocks ?? [
        { type: 'section', text: { type: 'mrkdwn', text: '✅ *작업 완료*' } },
        buildFeedbackContextActions(turnId),
      ],
    },
    actions: [
      {
        action_id: 'turn_feedback_v1',
        value: overrides.value ?? encodeFeedbackValue('positive', turnId),
      },
    ],
  };
}

describe('TurnFeedbackActionHandler', () => {
  let tmpDir: string;
  let store: TurnFeedbackStore;
  let slackApi: { updateMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-handler-'));
    setTurnFeedbackStoreDataDirProvider(() => tmpDir);
    store = new TurnFeedbackStore();
    slackApi = { updateMessage: vi.fn().mockResolvedValue(undefined) };
  });

  function handler() {
    return new TurnFeedbackActionHandler({ slackApi: slackApi as any, store });
  }

  it('persists the feedback and acknowledges by replacing the buttons', async () => {
    await handler().handleFeedback(makeBody(), vi.fn());

    const rec = store.get('C1-1.2:1700:abc', 'U1');
    expect(rec?.sentiment).toBe('positive');
    expect(rec?.messageTs).toBe('1700.9');

    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    const [channel, ts, , blocks] = slackApi.updateMessage.mock.calls[0];
    expect(channel).toBe('C1');
    expect(ts).toBe('1700.9');
    // The interactive context_actions block is replaced by a plain context ack.
    expect(blocks.some((b: any) => b.type === 'context_actions')).toBe(false);
    expect(JSON.stringify(blocks)).toContain('👍');
  });

  it('is idempotent on double-click (one record, sentiment stable)', async () => {
    await handler().handleFeedback(makeBody(), vi.fn());
    await handler().handleFeedback(makeBody(), vi.fn());
    expect(store.listForTurn('C1-1.2:1700:abc')).toHaveLength(1);
  });

  it('records a sentiment flip in place', async () => {
    await handler().handleFeedback(makeBody({ value: encodeFeedbackValue('positive', 'C1-1.2:1700:abc') }), vi.fn());
    await handler().handleFeedback(makeBody({ value: encodeFeedbackValue('negative', 'C1-1.2:1700:abc') }), vi.fn());
    expect(store.get('C1-1.2:1700:abc', 'U1')?.sentiment).toBe('negative');
    expect(store.listForTurn('C1-1.2:1700:abc')).toHaveLength(1);
  });

  it('ignores an unparseable value (no persist, no update)', async () => {
    await handler().handleFeedback(makeBody({ value: 'garbage' }), vi.fn());
    expect(store.list()).toHaveLength(0);
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
  });

  it('still persists when the cosmetic update throws', async () => {
    slackApi.updateMessage.mockRejectedValueOnce(new Error('cant_update_message'));
    await handler().handleFeedback(makeBody(), vi.fn());
    expect(store.get('C1-1.2:1700:abc', 'U1')?.sentiment).toBe('positive');
  });
});
